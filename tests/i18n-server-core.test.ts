// The server core in English (DESIGN §27): API errors, the providers' names, choices and reasons, the tutor's and the
// digest's answer language, what is written for the user (DIGEST.md, COURSE.md, session titles, stored notes) and the
// desktop startup messages. Korean stays the default, which every other test pins; these switch to English.
// Run: node --test tests/i18n-server-core.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { LANG_HEADER } from '../shared/i18n.ts';
import type { ProviderInfo, Session } from '../shared/types.ts';
import { DEFAULT_CONTEXT_SETTINGS, buildTurn, initialProviderState } from '../server/context.ts';
import { courseMarkdown } from '../server/courses.ts';
import { desktopLang, desktopPort, startupFailureMessage } from '../server/desktop.ts';
import { DEFAULT_DIGEST_PROMPTS, abortAllDigests, digestMarkdown, recoverInterruptedDigests, startDigest, waitForDigest } from '../server/digest.ts';
import type { DigestDeps } from '../server/digest.ts';
import {
  buildDigestBatchParts,
  buildLectureSummaryParts,
  digestSystemPrompt,
  lectureSummarySystemPrompt,
  parseDigestOutput,
} from '../server/digestPrompt.ts';
import { runInLang, smsg } from '../server/i18n.ts';
import { createApiRouter, mountProductionClient } from '../server/index.ts';
import type { DigestRecord, DocAssets, SessionRecord } from '../server/internal-types.ts';
import { listIds } from '../server/layout.ts';
import { createSession, getSession, recoverInterruptedSessions } from '../server/sessions.ts';
import { docPaths, textFileName } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import { TRUNCATED_MARK, TUTOR_SYSTEM_PROMPT, primeInstruction, tutorSystemPrompt } from '../server/prompts.ts';
import { claudeCodeProvider, claudeEfforts, toolStatus } from '../server/providers/claudeCode.ts';
import { codexModelChoices } from '../server/providers/codexCatalog.ts';
import { clearProviderInfoCache, providerInfos } from '../server/providers/index.ts';
import { effortOption } from '../server/providers/types.ts';
import type { Part, Provider, ProviderRunInput } from '../server/providers/types.ts';

const HANGUL = /[가-힣]/;

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-i18n-core-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A ready document with extracted texts (the fake providers never open the slide images). */
async function makeDoc(docId: string, pages: number, title = 'Deck'): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.textDir, { recursive: true });
  await fs.mkdir(paths.slidesDir, { recursive: true });
  const meta: StoredDocMeta = {
    id: docId,
    title,
    fileName: `${title}.pdf`,
    pageCount: pages,
    aspectRatio: 16 / 9,
    status: 'ready',
    progress: pages,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
  for (let n = 1; n <= pages; n++) await fs.writeFile(path.join(paths.textDir, textFileName(n, pages)), `text of slide ${n}`);
}

async function readRecord(docId: string): Promise<DigestRecord> {
  return JSON.parse(await fs.readFile(docPaths(docId).digestJson, 'utf8')) as DigestRecord;
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A provider answering with `respond`; its calls are kept. */
function fakeProvider(respond: (input: ProviderRunInput) => Promise<string> | string): Provider & { calls: ProviderRunInput[] } {
  const calls: ProviderRunInput[] = [];
  return {
    id: 'claude-code',
    label: 'Fake',
    kind: 'cli',
    models: [],
    defaultModel: '',
    maxImagesPerConversation: 90,
    calls,
    detect: async () => ({ available: true }),
    run: async (input) => {
      calls.push(input);
      return { text: await respond(input), resume: {} };
    },
  };
}

function digestDeps(provider: Provider): DigestDeps {
  return {
    getProvider: (id) => (id === provider.id ? provider : undefined),
    checkProvider: async () => ({ available: true }),
    prompts: DEFAULT_DIGEST_PROMPTS,
    concurrency: () => 1,
    now: () => new Date(),
  };
}

const textsOf = (parts: Part[]) => parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));

// ---------------------------------------------------------------------------

describe('providers: names, choices and availability in the request language', () => {
  test('labels, the default model and the effort levels are texts of the language', () => {
    assert.equal(claudeCodeProvider.label, 'Claude Code (구독)');
    assert.equal(
      runInLang('en', () => claudeCodeProvider.label),
      'Claude Code (subscription)',
    );
    const en = runInLang('en', () => ({ models: claudeCodeProvider.models, efforts: claudeCodeProvider.efforts ?? [] }));
    assert.equal(en.models[0].label, 'CLI default');
    assert.deepEqual(
      en.efforts.map((e) => [e.id, e.label]),
      [
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'very high'],
        ['max', 'max'],
      ],
    );
    assert.ok(en.efforts.every((e) => e.description && !HANGUL.test(e.description)));
    assert.equal(claudeEfforts('en'), en.efforts, 'built once per language');
    assert.equal(claudeCodeProvider.efforts?.[2].label, '높음', 'Korean outside a request');

    assert.equal(effortOption('ultra', undefined, 'en').label, 'ultra');
    assert.equal(effortOption('turbo', undefined, 'en').label, 'turbo', 'an unknown level keeps its id');
    assert.equal(effortOption('constructor', undefined, 'en').label, 'constructor', 'never a key of Object.prototype');
    assert.deepEqual(
      runInLang('en', () => codexModelChoices(null, 'gpt-x')),
      { models: [{ id: '', label: 'Codex config default (gpt-x)' }], efforts: [] },
    );
    assert.equal(
      runInLang('en', () => toolStatus('Glob', { pattern: '*.md' }, '/library/d')),
      'Finding files: *.md',
    );
  });

  test('providerInfos: one detection for every language, reasons and labels worded per request', async () => {
    const keys = ['CLAUDE_BIN', 'CODEX_BIN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.CLAUDE_BIN = path.join(tmpRoot, 'no-claude-here');
    process.env.CODEX_BIN = path.join(tmpRoot, 'no-codex-here');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    clearProviderInfoCache();
    try {
      const [en, ko] = await Promise.all([runInLang('en', providerInfos), providerInfos()]);
      const byId = (infos: ProviderInfo[]) => Object.fromEntries(infos.map((info) => [info.id, info]));
      const e = byId(en);
      const k = byId(ko);
      assert.deepEqual(
        en.map((info) => info.label),
        ['Claude Code (subscription)', 'Codex (ChatGPT subscription)', 'Claude API (API key)', 'OpenAI API (API key)'],
      );
      assert.equal(k['claude-code'].label, 'Claude Code (구독)');
      assert.match(e['claude-code'].reason ?? '', /^claude CLI not found \(PATH\)\. Install Claude Code/);
      assert.match(k['claude-code'].reason ?? '', /찾을 수 없습니다/);
      assert.equal(e['anthropic-api'].reason, "The ANTHROPIC_API_KEY environment variable isn't set.");
      assert.deepEqual(e['codex'].models, [{ id: '', label: 'Codex config default' }]);
      assert.deepEqual(e['claude-code'].efforts?.map((level) => level.label), ['low', 'medium', 'high', 'very high', 'max']);
      assert.ok(!HANGUL.test(JSON.stringify(en)), 'nothing Korean in the English report');
      assert.equal((await providerInfos())[0].label, 'Claude Code (구독)');
      // One cache for both languages: a key set now is not seen by either within the TTL, each worded in its language.
      process.env.ANTHROPIC_API_KEY = 'k';
      const [enAgain, koAgain] = await Promise.all([runInLang('en', providerInfos), providerInfos()]);
      assert.equal(byId(enAgain)['anthropic-api'].reason, "The ANTHROPIC_API_KEY environment variable isn't set.");
      assert.equal(byId(koAgain)['anthropic-api'].available, false);
      assert.match(byId(koAgain)['anthropic-api'].reason ?? '', /ANTHROPIC_API_KEY/);
      assert.ok(HANGUL.test(byId(koAgain)['anthropic-api'].reason ?? ''));
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      clearProviderInfoCache();
    }
  });
});

describe('the tutor answers in the request language', () => {
  function doc(digestMarkdownOfSlide1?: string): DocAssets {
    const dir = '/library/sample-abc123';
    return {
      meta: {
        id: 'sample-abc123',
        title: 'Sample',
        fileName: 'sample.pdf',
        pageCount: 2,
        aspectRatio: 16 / 9,
        status: 'ready',
        progress: 2,
        createdAt: '2026-09-30T00:00:00.000Z',
        courseId: null,
        digestStatus: 'none',
      },
      dir,
      texts: ['Text of slide 1', 'Text of slide 2'],
      slidePath: (n: number) => `${dir}/slides/${n}.png`,
      sheets: [{ path: `${dir}/sheets/sheet-01.png`, fromSlide: 1, toSlide: 2 }],
      digest: digestMarkdownOfSlide1 ? [{ slide: 1, title: 'T', markdown: digestMarkdownOfSlide1 }] : null,
      digestComplete: false,
      course: null,
    };
  }
  const session = (): SessionRecord => ({
    version: 1,
    id: '20260930-120000-abcd',
    docId: 'sample-abc123',
    title: 'Session',
    provider: 'claude-code',
    model: '',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    providerState: initialProviderState(),
    messages: [],
  });

  test('the system prompt and the deck overview: English when the language is unclear', () => {
    const en = tutorSystemPrompt('en');
    assert.match(en, /Answer in the language of the student's question\. If the language is unclear, answer in English\./);
    assert.doesNotMatch(en, /answer in Korean|Korean explanation|첨부 1|슬라이드 밖 보충|Parsing II의/);
    assert.match(en, /\(e\.g\. "Attachment 1"\)/);
    assert.equal(tutorSystemPrompt('ko'), TUTOR_SYSTEM_PROMPT);
    assert.equal(tutorSystemPrompt(), TUTOR_SYSTEM_PROMPT, 'Korean outside a request');
    assert.match(primeInstruction(false, 'en'), /Write in English unless the deck is clearly meant for another language/);

    const out = runInLang('en', () =>
      buildTurn({ doc: doc(), session: session(), kind: 'prime', question: '', slide: 1, neighbors: 0, settings: DEFAULT_CONTEXT_SETTINGS, maxImagesPerConversation: 90 }),
    );
    assert.equal(out.systemPrompt, en);
    assert.match(textsOf(out.parts).join('\n'), /Write in English unless/);
  });

  test('a cut digest entry keeps its English takeaway line', () => {
    const markdown = `${'A'.repeat(1000)}\n\n**Key point:** the main idea`;
    const out = buildTurn({
      doc: doc(markdown),
      session: session(),
      kind: 'question',
      question: 'What is this?',
      slide: 2,
      neighbors: 0,
      settings: { ...DEFAULT_CONTEXT_SETTINGS, maxSlideTextChars: 300 },
      maxImagesPerConversation: 90,
    });
    const text = textsOf(out.parts).join('\n');
    const section = /### Slide 1 · T\n([\s\S]*?)\n\n### Slide 2/.exec(text)?.[1] ?? '';
    assert.ok(section.endsWith(`${TRUNCATED_MARK}\n**Key point:** the main idea`), section.slice(-80));
  });
});

describe('the digest is made and written in the language it was started in', () => {
  test('prompts: figures, takeaways and the summary in English; the transcription in the original language', () => {
    const system = digestSystemPrompt('en');
    assert.doesNotMatch(system, HANGUL);
    assert.match(system, /explicitly, in English:/);
    assert.match(system, /Start such a paragraph with "\*\*Figure:\*\*"/);
    assert.match(system, /A final line starting with "Key point:" — a 1–2 sentence takeaway in English/);
    assert.match(system, /ORIGINAL language \(never translate/);
    const batch = textsOf(buildDigestBatchParts({ deckTitle: 'D', pageCount: 1, slides: [{ slide: 1, imagePath: '/x/1.png', text: '' }] }, 'en'));
    assert.ok(batch.at(-1)?.endsWith('describe figures in English, and end every block with a "Key point:" line in English.'));

    const summary = lectureSummarySystemPrompt('en');
    assert.doesNotMatch(summary, HANGUL);
    assert.match(summary, /Write in English, at most about 2500 characters/);
    assert.match(summary, /\*\*Topic\*\*.*\n.*\*\*Key concepts and definitions\*\*.*\n.*\*\*Algorithms and procedures\*\*.*\n.*\*\*Connections\*\*/);
    const request = textsOf(buildLectureSummaryParts({ deckTitle: 'D', digest: [] }, 'en'))[0];
    assert.ok(request.endsWith('covering Topic, Key concepts and definitions, Algorithms and procedures, and Connections.'));
    assert.equal(lectureSummarySystemPrompt(), lectureSummarySystemPrompt('ko'));

    assert.deepEqual(
      runInLang('en', () => parseDigestOutput('nothing usable', [3])),
      [{ slide: 3, title: '', markdown: "_(Couldn't make the digest of this slide. Try making it again.)_", failed: true }],
    );
  });

  test('a run stores its language: prompts, notes, entries and DIGEST.md follow it', async () => {
    await makeDoc('deck-en-aaa111', 2);
    const provider = fakeProvider((input) => {
      if (input.systemPrompt === lectureSummarySystemPrompt('en')) return 'A short summary.';
      const slides = input.parts.flatMap((part) => (part.type === 'image' ? [part.label] : []));
      // Slide 2 never gets a usable block.
      return slides.includes('Slide 1') ? '<<<SLIDE 1>>>\nTITLE: One\nBody of one\n\nKey point: one' : 'nothing';
    });
    const started = await runInLang('en', () => startDigest('deck-en-aaa111', { provider: 'claude-code' }, digestDeps(provider)));
    assert.equal(started.status, 'running');
    assert.ok(await waitForDigest('deck-en-aaa111'));

    assert.equal(provider.calls[0].systemPrompt, digestSystemPrompt('en'));
    assert.ok(provider.calls.some((call) => call.systemPrompt === lectureSummarySystemPrompt('en')), 'the summary in English');
    const record = await readRecord('deck-en-aaa111');
    assert.equal(record.lang, 'en');
    assert.equal(record.status, 'ready');
    assert.equal(record.error, "Couldn't make the digest of slide 2 (continue the digest to try again)");
    assert.equal(record.slides[1].markdown, "_(Couldn't make the digest of this slide. Try making it again.)_");
    const md = await fs.readFile(docPaths('deck-en-aaa111').digestMd, 'utf8');
    assert.ok(md.startsWith('# Deck — digest\n\n## Lecture summary\n\nA short summary.\n'), md.slice(0, 120));
    assert.ok(md.includes('> The automatic digest failed for this slide.'));
  });

  test("continuing a digest keeps the language of its entries; only a redo takes the request's", async () => {
    await makeDoc('deck-cont-ddd444', 2);
    const reply = (input: ProviderRunInput): string => {
      if (input.systemPrompt === lectureSummarySystemPrompt('en') || input.systemPrompt === lectureSummarySystemPrompt('ko')) return 'Summary.';
      const slides = input.parts.flatMap((part) => (part.type === 'image' ? [part.label] : []));
      return slides.map((label) => `<<<SLIDE ${label.replace(/\D/g, '')}>>>\nTITLE: T\nBody`).join('\n\n');
    };
    // Made in English with slide 2 failing.
    const first = fakeProvider((input) => (input.parts.some((p) => p.type === 'image' && p.label === 'Slide 2') ? 'nothing' : reply(input)));
    await runInLang('en', () => startDigest('deck-cont-ddd444', { provider: 'claude-code' }, digestDeps(first)));
    assert.ok(await waitForDigest('deck-cont-ddd444'));
    assert.equal((await readRecord('deck-cont-ddd444')).lang, 'en');

    // Continued from a Korean page: slide 2 is made in English too.
    const next = fakeProvider(reply);
    await startDigest('deck-cont-ddd444', { provider: 'claude-code' }, digestDeps(next));
    assert.ok(await waitForDigest('deck-cont-ddd444'));
    assert.equal(next.calls[0].systemPrompt, digestSystemPrompt('en'));
    assert.equal((await readRecord('deck-cont-ddd444')).lang, 'en');

    // A redo from the Korean page makes it again in Korean.
    const redo = fakeProvider(reply);
    await startDigest('deck-cont-ddd444', { provider: 'claude-code', force: true }, digestDeps(redo));
    assert.ok(await waitForDigest('deck-cont-ddd444'));
    assert.equal(redo.calls[0].systemPrompt, digestSystemPrompt('ko'));
    assert.equal((await readRecord('deck-cont-ddd444')).lang, 'ko');
  });

  test('a shutdown stops a run in its own language; the startup sweep uses the stored one', async () => {
    await makeDoc('deck-stop-bbb222', 1);
    const provider = fakeProvider(
      (input) =>
        new Promise<string>((_resolve, reject) => {
          const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (input.signal.aborted) stop();
          input.signal.addEventListener('abort', stop, { once: true });
        }),
    );
    await runInLang('en', () => startDigest('deck-stop-bbb222', { provider: 'claude-code' }, digestDeps(provider)));
    await waitFor(() => provider.calls.length > 0);
    assert.equal(abortAllDigests(), 1); // outside any request, like the real shutdown
    assert.ok(await waitForDigest('deck-stop-bbb222'));
    const stopped = await readRecord('deck-stop-bbb222');
    assert.equal(stopped.status, 'aborted');
    assert.equal(stopped.error, 'Making the digest was stopped because the server shut down');

    for (const [docId, lang] of [
      ['deck-crash-ccc333', 'en'],
      ['deck-crash-ddd444', undefined],
    ] as const) {
      await makeDoc(docId, 1);
      const running: DigestRecord = { version: 1, status: 'running', slides: [], summary: null, ...(lang ? { lang } : {}) };
      await fs.mkdir(docPaths(docId).digestDir, { recursive: true });
      await fs.writeFile(docPaths(docId).digestJson, JSON.stringify(running));
    }
    assert.equal(await recoverInterruptedDigests(), 2);
    assert.equal((await readRecord('deck-crash-ccc333')).error, 'Making the digest was interrupted because the server stopped. You can continue it');
    assert.equal((await readRecord('deck-crash-ddd444')).error, '서버가 중단되어 정리본 만들기가 멈췄습니다. 이어서 만들 수 있습니다');
  });

  test('DIGEST.md of an English record', () => {
    const record: DigestRecord = {
      version: 1,
      status: 'aborted',
      lang: 'en',
      slides: [{ slide: 2, title: '', markdown: 'x', failed: true }],
      summary: null,
    };
    assert.equal(
      digestMarkdown('L1', 3, record),
      '# L1 — digest\n\n_(Incomplete digest: 1/3 slides)_\n\n## Slide 2\n\n![slide 2](slides/002.png)\n\n> The automatic digest failed for this slide.\n\nx\n',
    );
  });
});

describe('files, titles and API errors in the request language', () => {
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';

  before(async () => {
    await makeDoc('deck-api-eee555', 1);
    const infos: ProviderInfo[] = [
      {
        id: 'claude-code',
        label: 'Claude Code',
        kind: 'cli',
        available: true,
        models: [
          { id: '', label: 'default' },
          { id: 'haiku', label: 'Haiku', efforts: [] },
        ],
        defaultModel: '',
        efforts: [{ id: 'high', label: 'high' }],
      },
    ];
    const app = express();
    app.use('/api', createApiRouter({ providerInfos: async () => infos }));
    const noDist = express();
    mountProductionClient(noDist, false, path.join(tmpRoot, 'no-web-dist'));
    app.use(noDist);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  const call = async (method: string, p: string, body?: unknown, lang?: 'en') => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(lang ? { [LANG_HEADER]: lang } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { error?: string } & Partial<Session> };
  };

  test('errors of the API', async () => {
    assert.deepEqual(await call('GET', '/api/docs/NOT_A_DOC', undefined, 'en'), { status: 404, body: { error: 'Document not found' } });
    assert.deepEqual(await call('GET', '/api/docs/NOT_A_DOC'), { status: 404, body: { error: '문서를 찾을 수 없습니다' } });
    assert.deepEqual(await call('GET', '/api/nowhere', undefined, 'en'), { status: 404, body: { error: 'API route not found' } });
    assert.deepEqual(await call('POST', '/api/docs/deck-api-eee555/sessions', { provider: 'nope' }, 'en'), {
      status: 400,
      body: { error: 'Unknown provider: nope' },
    });
    assert.deepEqual(await call('POST', '/api/docs/deck-api-eee555/sessions', { provider: 'claude-code', model: 'haiku', effort: 'high' }, 'en'), {
      status: 400,
      body: { error: "This model doesn't support the reasoning effort ‘high’" },
    });
    assert.deepEqual(await call('POST', '/api/docs/deck-api-eee555/sessions', { provider: 'claude-code', model: 'haiku', effort: 'high' }), {
      status: 400,
      body: { error: "이 모델은 추론 수준 '높음'을(를) 지원하지 않습니다" },
    });
    assert.deepEqual(await call('POST', '/api/docs/deck-api-eee555/sessions/20260930-120000-abcd/messages', {}, 'en'), {
      status: 400,
      body: { error: 'A slide number is required' },
    });
    assert.deepEqual(await call('PUT', '/api/layout', {}, 'en'), { status: 400, body: { error: 'The layout is invalid' } });
    const badJson = await fetch(`${base}/api/courses`, { method: 'POST', headers: { 'Content-Type': 'application/json', [LANG_HEADER]: 'en' }, body: '{' });
    assert.deepEqual(await badJson.json(), { error: "The request body isn't valid JSON" });
  });

  test('?lang= carries the language of a plain link (notes.md, digest.md, summary.md) and of an EventSource', async () => {
    const error = async (p: string, headers: Record<string, string>) => ((await (await fetch(`${base}${p}`, { headers })).json()) as { error?: string }).error;
    assert.equal(await error('/api/docs/NOT_A_DOC/notes.md?lang=en', { 'Accept-Language': 'ko-KR' }), 'Document not found');
    assert.equal(await error('/api/docs/deck-api-eee555/digest.md?lang=en', { 'Accept-Language': 'ko-KR' }), 'There is no digest yet');
    assert.equal(await error('/api/docs/NOT_A_DOC/notes.md?lang=en', { [LANG_HEADER]: 'ko' }), '문서를 찾을 수 없습니다');
    assert.equal(await error('/api/docs/NOT_A_DOC/notes.md?lang=xx', { 'Accept-Language': 'en' }), 'Document not found');
  });

  test('a new session is titled in the language of the request that made it', async () => {
    const en = await call('POST', '/api/docs/deck-api-eee555/sessions', { provider: 'claude-code' }, 'en');
    assert.equal(en.status, 201);
    assert.match(en.body.title ?? '', /^Session [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M$/);
    const ko = await call('POST', '/api/docs/deck-api-eee555/sessions', { provider: 'claude-code' });
    assert.match(ko.body.title ?? '', /^세션 \d\d\/\d\d \d\d:\d\d$/);
  });

  test('an answer the server stopped is marked in the language of its turn', async () => {
    const session = await runInLang('en', () => createSession('deck-api-eee555', { provider: 'claude-code', model: '' }));
    const file = path.join(docPaths('deck-api-eee555').sessionsDir, `${session.id}.json`);
    const at = new Date().toISOString();
    const stuck: SessionRecord = {
      ...session,
      lang: 'en',
      messages: [
        { id: 'q1', role: 'user', text: 'Why?', slide: 1, kind: 'question', createdAt: at, status: 'complete' },
        { id: 'a1', role: 'assistant', text: 'Because', slide: 1, kind: 'question', createdAt: at, status: 'streaming' },
      ],
    };
    await fs.writeFile(file, JSON.stringify(stuck));
    assert.ok((await recoverInterruptedSessions()) >= 1);
    const repaired = await getSession('deck-api-eee555', session.id);
    assert.equal(repaired?.messages[1].status, 'aborted');
    assert.equal(repaired?.messages[1].error, "The server stopped, so the answer wasn't completed");
  });

  test('pages outside the API follow Accept-Language', async () => {
    const en = await fetch(`${base}/`, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    assert.equal(en.status, 503);
    assert.equal(await en.text(), "The web client isn't built (no web/dist).\nRun it with `npm start` or `npm run dev`.\n");
    assert.match(await (await fetch(`${base}/`)).text(), /^웹 클라이언트가 빌드되지 않았습니다/);
  });

  test('COURSE.md and id lists', () => {
    assert.equal(courseMarkdown('Compilers', [], 'en'), '# Compilers — course summary\n\n_(no lectures yet)_\n');
    assert.match(runInLang('en', () => courseMarkdown('C', [{ docId: 'd-1', title: 'L1', summary: null }])), /## 1\. L1\n\n_\(no digest\)_/);
    assert.equal(courseMarkdown('C', []), '# C — 과목 정리\n\n_(아직 강의가 없습니다)_\n');
    assert.equal(
      runInLang('en', () => listIds(['a', 'b', 'c', 'd', 'e', 'f', 'g'])),
      'a, b, c, d, e and 2 more',
    );
  });

  test('the login texts', () => {
    const m = smsg('en').auth;
    assert.equal(m.tooManyAttempts(1), 'Too many login attempts. Try again in 1 minute');
    assert.equal(m.tooManyAttempts(5), 'Too many login attempts. Try again in 5 minutes');
  });
});

describe('desktop startup messages follow EASY_STUDY_LANG', () => {
  test('the language: Korean when unset, English for any language the app does not have', () => {
    assert.equal(desktopLang({}), 'ko');
    assert.equal(desktopLang({ EASY_STUDY_LANG: 'ko-KR' }), 'ko');
    assert.equal(desktopLang({ EASY_STUDY_LANG: 'en_US.UTF-8' }), 'en');
    assert.equal(desktopLang({ EASY_STUDY_LANG: 'ja-JP' }), 'en');
  });

  test('the messages', () => {
    const taken = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    assert.deepEqual(startupFailureMessage(taken, 5180, 'en'), {
      known: true,
      exitCode: 3,
      message: "Couldn't start the server because another program is using port 5180. Try opening the app again.",
    });
    assert.match(startupFailureMessage(taken, 5180).message, /^포트 5180을\(를\) 다른 프로그램이/);
    assert.throws(() => desktopPort({ PORT: 'abc', EASY_STUDY_LANG: 'en' }), { message: 'Invalid PORT value: "abc" (0–65535)' });
  });
});
