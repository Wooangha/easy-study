// Digest jobs (server/digest.ts, DESIGN §11) with fake providers: batching, concurrency, retries,
// failed placeholders, the lecture summary, abort/resume, persistence, DIGEST.md, the startup sweep
// and the HTTP routes. No real CLI or API is ever called.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { DigestInfo, DigestSlide, DocMeta, ProviderId, ProviderInfo, Session } from '../shared/types.ts';
import { createCliBudget } from '../server/cliBudget.ts';
import { HttpError } from '../server/config.ts';
import { createCourse, updateCourse } from '../server/courses.ts';
import {
  DEFAULT_DIGEST_PROMPTS,
  abortDigest,
  digestCallsInFlight,
  digestMarkdown,
  getDigestInfo,
  isDigestRunning,
  planBatches,
  recoverInterruptedDigests,
  startDigest,
  waitForDigest,
} from '../server/digest.ts';
import type { DigestDeps, DigestPrompts } from '../server/digest.ts';
import { lectureSummarySystemPrompt } from '../server/digestPrompt.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import type { DigestRecord } from '../server/internal-types.ts';
import { coursePaths, docPaths, getDoc, loadDocAssets, slideFileName, textFileName } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import type { Part, Provider, ProviderRunInput } from '../server/providers/types.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-digest-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A ready document with extracted texts (the fake providers never open the slide images). */
async function makeDoc(docId: string, pages: number, title = 'Fake Deck', status: DocMeta['status'] = 'ready'): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.textDir, { recursive: true });
  await fs.mkdir(paths.slidesDir, { recursive: true });
  const meta: StoredDocMeta = {
    id: docId,
    title,
    fileName: `${title}.pdf`,
    pageCount: pages,
    aspectRatio: 16 / 9,
    status,
    progress: status === 'ready' ? pages : 0,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
  for (let n = 1; n <= pages; n++) await fs.writeFile(path.join(paths.textDir, textFileName(n, pages)), `text of slide ${n}`);
}

const DIGEST_SYSTEM = 'STAND-IN DIGEST SYSTEM';
const SUMMARY_SYSTEM = 'STAND-IN SUMMARY SYSTEM';
const PLACEHOLDER = '_(stand-in placeholder)_';

/** Parses the documented output format (simplified stand-in for digestPrompt.parseDigestOutput). */
function parseStandIn(output: string, expected: number[]): DigestSlide[] {
  const blocks = new Map<number, string>();
  const pieces = output.split(/^<<<SLIDE (\d+)>>>\n?/m);
  for (let i = 1; i < pieces.length; i += 2) blocks.set(Number(pieces[i]), pieces[i + 1]);
  return expected.map((slide) => {
    const block = blocks.get(slide)?.trim();
    if (!block) return { slide, title: '', markdown: PLACEHOLDER, failed: true };
    const [first, ...rest] = block.split('\n');
    const hasTitle = first.startsWith('TITLE:');
    return { slide, title: hasTitle ? first.slice('TITLE:'.length).trim() : '', markdown: (hasTitle ? rest : [first, ...rest]).join('\n').trim() };
  });
}

const STAND_IN_PROMPTS: DigestPrompts = {
  batchSize: 4,
  systemPrompt: () => DIGEST_SYSTEM,
  buildBatchParts: (input) => [
    { type: 'text', text: `DIGEST "${input.deckTitle}" course=${input.courseTitle ?? '-'} of ${input.pageCount}` },
    ...input.slides.flatMap((s): Part[] => [
      { type: 'image', path: s.imagePath, detail: 'high', label: `Slide ${s.slide}` },
      { type: 'text', text: s.text },
    ]),
  ],
  parseOutput: parseStandIn,
  summarySystemPrompt: () => SUMMARY_SYSTEM,
  buildSummaryParts: (input) => [
    { type: 'text', text: `SUMMARIZE "${input.deckTitle}" course=${input.courseTitle ?? '-'} slides=${input.digest.map((d) => d.slide).join(',')}` },
  ],
};

/** The documented model output for `slides`. */
function digestOutput(slides: number[]): string {
  return slides.map((n) => `<<<SLIDE ${n}>>>\nTITLE: Title ${n}\n**Body** of slide ${n}\n핵심: takeaway ${n}`).join('\n');
}

interface CallInfo {
  slides: number[];
  summary: boolean;
  input: ProviderRunInput;
  call: number;
}

type Respond = (info: CallInfo) => Promise<string> | string;

interface FakeProvider extends Provider {
  calls: ProviderRunInput[];
  inFlight: number;
  maxInFlight: number;
  respond: Respond;
}

/** Slides a call asked for, read from its image part labels ("Slide N"). */
function slidesOf(input: ProviderRunInput): number[] {
  return input.parts.flatMap((part) => (part.type === 'image' ? [Number(part.label.replace(/^Slide /, ''))] : []));
}

function fakeProvider(respond: Respond, id: ProviderId = 'claude-code'): FakeProvider {
  const provider: FakeProvider = {
    id,
    label: `Fake ${id}`,
    kind: 'cli',
    models: [],
    defaultModel: 'default-model',
    maxImagesPerConversation: 90,
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    respond,
    detect: async () => ({ available: true }),
    run: async (input) => {
      provider.calls.push(input);
      const call = provider.calls.length;
      provider.inFlight++;
      provider.maxInFlight = Math.max(provider.maxInFlight, provider.inFlight);
      try {
        const summary = input.systemPrompt === SUMMARY_SYSTEM || input.systemPrompt === lectureSummarySystemPrompt();
        const text = await provider.respond({ slides: slidesOf(input), summary, input, call });
        return { text, resume: {} };
      } finally {
        provider.inFlight--;
      }
    },
  };
  return provider;
}

/** Answers every batch correctly (after a short delay) and every summary with `SUMMARY of …`. */
const wellBehaved: Respond = async ({ slides, summary, input }) => {
  await delay(5);
  if (summary) return `SUMMARY of ${textOf(input.parts)}`;
  return digestOutput(slides);
};

function textOf(parts: Part[]): string {
  return parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  const err = new Error('요청이 중단되었습니다.');
  err.name = 'AbortError';
  return err;
}

/** Rejects like a real provider once the call is aborted. */
function untilAborted(input: ProviderRunInput): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (input.signal.aborted) reject(abortError());
    input.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let clock = Date.UTC(2026, 8, 23, 6, 0, 0);

function depsFor(provider: FakeProvider, overrides: Partial<DigestDeps> = {}): DigestDeps {
  return {
    getProvider: (id) => (id === provider.id ? provider : undefined),
    checkProvider: async () => ({ available: true }),
    prompts: STAND_IN_PROMPTS,
    concurrency: () => 2,
    now: () => new Date((clock += 1000)),
    ...overrides,
  };
}

async function readRecord(docId: string): Promise<DigestRecord> {
  return JSON.parse(await fs.readFile(docPaths(docId).digestJson, 'utf8')) as DigestRecord;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(5);
  }
}

async function finish(docId: string): Promise<DigestInfo> {
  assert.equal(await waitForDigest(docId, 10_000), true, 'job finished');
  return getDigestInfo(docId);
}

function isHttpError(status: number) {
  return (err: unknown) => err instanceof HttpError && err.status === status;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

describe('planBatches', () => {
  test('runs of consecutive slides cut into batches', () => {
    assert.deepEqual(planBatches(range(1, 9), 4), [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9],
    ]);
    assert.deepEqual(planBatches([3, 7, 8, 9, 10, 11, 20], 4), [[3], [7, 8, 9, 10], [11], [20]]);
    assert.deepEqual(planBatches([], 4), []);
    assert.deepEqual(planBatches([2, 1, 2], 0), [[1], [2]]);
  });
});

describe('digest job', () => {
  test('no digest yet: status none', async () => {
    await makeDoc('fresh-000001', 9);
    const info = await getDigestInfo('fresh-000001');
    assert.deepEqual(info, {
      docId: 'fresh-000001',
      status: 'none',
      done: 0,
      total: 9,
      slides: [],
      summary: null,
      markdownPath: docPaths('fresh-000001').digestMd,
    });
    assert.equal((await getDoc('fresh-000001'))?.digestStatus, 'none');
    await assert.rejects(getDigestInfo('missing-000000'), isHttpError(404));
  });

  test('digests every slide in batches of 4 with concurrency 2, then summarizes', async () => {
    const docId = 'batches-000001';
    await makeDoc(docId, 9, 'Parsing');
    const provider = fakeProvider(wellBehaved);
    const started = await startDigest(docId, { provider: 'claude-code', model: 'sonnet' }, depsFor(provider));
    assert.equal(started.status, 'running');
    assert.equal(started.provider, 'claude-code');
    assert.equal(started.model, 'sonnet');
    assert.equal(started.total, 9);
    assert.equal(isDigestRunning(docId), true);

    const info = await finish(docId);
    assert.equal(isDigestRunning(docId), false);
    assert.equal(info.status, 'ready', info.error ?? '');
    assert.equal(info.error, undefined);
    assert.equal(info.done, 9);
    assert.deepEqual(
      info.slides.map((s) => [s.slide, s.title, s.failed ?? false]),
      range(1, 9).map((n) => [n, `Title ${n}`, false]),
    );
    assert.equal(info.slides[0].markdown, '**Body** of slide 1\n핵심: takeaway 1');
    assert.equal(info.summary, 'SUMMARY of SUMMARIZE "Parsing" course=- slides=1,2,3,4,5,6,7,8,9');
    assert.ok(info.startedAt && info.updatedAt && info.updatedAt > info.startedAt);

    const batchCalls = provider.calls.filter((c) => c.systemPrompt === DIGEST_SYSTEM);
    assert.deepEqual(
      batchCalls.map(slidesOf).sort((a, b) => a[0] - b[0]),
      [[1, 2, 3, 4], [5, 6, 7, 8], [9]],
    );
    assert.equal(provider.maxInFlight, 2);
    assert.equal(provider.calls.length, 4, '3 batches + 1 summary');
    assert.equal(provider.calls.at(-1)?.systemPrompt, SUMMARY_SYSTEM);
    for (const call of provider.calls) {
      assert.equal(call.resume, null);
      assert.deepEqual(call.history, []);
      assert.equal(call.ephemeral, true);
      assert.equal(call.cwd, docPaths(docId).dir);
      assert.equal(call.model, 'sonnet');
    }
    const firstBatch = batchCalls.find((c) => slidesOf(c)[0] === 1);
    assert.deepEqual(
      firstBatch?.parts.flatMap((p) => (p.type === 'image' ? [p.path] : [])),
      range(1, 4).map((n) => path.join(docPaths(docId).slidesDir, slideFileName(n, 9))),
    );
    assert.match(textOf(firstBatch?.parts ?? []), /text of slide 3/);

    // Persisted record, derived fields and assets.
    const record = await readRecord(docId);
    assert.equal(record.version, 1);
    assert.equal(record.status, 'ready');
    assert.equal(record.slides.length, 9);
    assert.equal((await getDoc(docId))?.digestStatus, 'ready');
    const assets = await loadDocAssets(docId);
    assert.equal(assets.digestComplete, true);
    assert.equal(assets.digest?.length, 9);
  });

  test('the provider default model is used when none is given', async () => {
    const docId = 'model-000001';
    await makeDoc(docId, 2);
    const provider = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);
    assert.equal(info.model, 'default-model');
    assert.ok(provider.calls.every((c) => c.model === 'default-model'));
  });

  test('the reasoning effort reaches every call (slides and summary) and is kept in digest.json', async () => {
    const docId = 'effort-000001';
    await makeDoc(docId, 5);
    const provider = fakeProvider(wellBehaved);
    const started = await startDigest(docId, { provider: 'claude-code', model: 'opus', effort: 'high' }, depsFor(provider));
    assert.equal(started.effort, 'high');
    const info = await finish(docId);
    assert.equal(info.effort, 'high');
    assert.ok(provider.calls.length >= 3);
    assert.ok(provider.calls.every((c) => c.effort === 'high' && c.model === 'opus'));
    const stored = JSON.parse(await fs.readFile(path.join(docPaths(docId).digestDir, 'digest.json'), 'utf8')) as DigestRecord;
    assert.equal(stored.effort, 'high');

    // A redo without one uses the CLI default (and no longer reports the old one).
    const redo = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code', force: true }, depsFor(redo));
    const again = await finish(docId);
    assert.equal(again.effort, undefined);
    assert.ok(redo.calls.every((c) => c.effort === ''));
  });

  test('persists after every batch (digest.json and DIGEST.md)', async () => {
    const docId = 'persist-000001';
    await makeDoc(docId, 9, 'Persisted');
    const release = gate();
    const provider = fakeProvider(async ({ slides, summary, call }) => {
      if (call === 2) await release.promise;
      return summary ? 'sum' : digestOutput(slides);
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider, { concurrency: () => 1 }));

    await waitFor(async () => (await readRecord(docId)).slides.length === 4);
    const partial = await readRecord(docId);
    assert.equal(partial.status, 'running');
    assert.deepEqual(
      partial.slides.map((s) => s.slide),
      [1, 2, 3, 4],
    );
    const md = await fs.readFile(docPaths(docId).digestMd, 'utf8');
    assert.match(md, /^# Persisted — 정리본\n\n_\(미완성 정리본: 4\/9 슬라이드\)_\n/);
    assert.match(md, /## Slide 4 · Title 4/);
    const info = await getDigestInfo(docId);
    assert.equal(info.status, 'running');
    assert.equal(info.done, 4);
    assert.equal((await getDoc(docId))?.digestStatus, 'running');

    release.open();
    assert.equal((await finish(docId)).status, 'ready');
    assert.doesNotMatch(await fs.readFile(docPaths(docId).digestMd, 'utf8'), /미완성/);
  });

  test('slides missing from the output are retried alone once, then stored as failed', async () => {
    const docId = 'retry-000001';
    await makeDoc(docId, 4);
    const provider = fakeProvider(({ slides, summary }) => {
      if (summary) return 'summary';
      if (slides.length === 4) return digestOutput([1, 4]); // 2 and 3 missing
      if (slides[0] === 3) return `noise before\n${digestOutput([3])}`; // the retry of 3 works
      return 'I cannot read this slide.'; // the retry of 2 does not
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);

    assert.deepEqual(provider.calls.filter((c) => !c.systemPrompt.includes('SUMMARY')).map(slidesOf), [[1, 2, 3, 4], [2], [3]]);
    assert.equal(info.status, 'ready');
    assert.deepEqual(
      info.slides.map((s) => [s.slide, s.failed ?? false]),
      [
        [1, false],
        [2, true],
        [3, false],
        [4, false],
      ],
    );
    assert.equal(info.slides[1].markdown, PLACEHOLDER, "the parser's placeholder is kept");
    assert.match(info.error ?? '', /슬라이드 2의 정리본을 만들지 못했습니다/);
    // Every slide has an entry, so the summary was made — from the usable entries only.
    assert.equal(info.summary, 'summary');
    assert.match(textOf(provider.calls.at(-1)?.parts ?? []), /slides=1,3,4$/);
    assert.equal((await loadDocAssets(docId)).digestComplete, false);
  });

  test('a batch whose call throws is retried slide by slide', async () => {
    const docId = 'throws-000001';
    await makeDoc(docId, 8);
    const provider = fakeProvider(({ slides, summary }) => {
      if (summary) return 'summary';
      if (slides.length > 1 && slides[0] === 5) throw new Error('request too large');
      return digestOutput(slides);
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);
    assert.equal(info.status, 'ready', info.error ?? '');
    assert.equal(info.error, undefined);
    assert.equal(info.done, 8);
    assert.ok(info.slides.every((s) => !s.failed));
    assert.deepEqual(
      provider.calls
        .map(slidesOf)
        .filter((s) => s.length === 1)
        .map((s) => s[0])
        .sort(),
      [5, 6, 7, 8],
    );
  });

  test('when every call fails the job ends in error with the first message (and gives up early)', async () => {
    const docId = 'allfail-000001';
    await makeDoc(docId, 40);
    const provider = fakeProvider(async ({ call }) => {
      await delay(2);
      throw new Error(call === 1 ? 'claude exited with code 1: not logged in' : `failure ${call}`);
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);
    assert.equal(info.status, 'error');
    assert.equal(info.error, 'claude exited with code 1: not logged in');
    assert.equal(info.summary, null);
    assert.ok(provider.calls.length <= 6, `stopped after ${provider.calls.length} calls`);
    assert.ok(!provider.calls.some((c) => c.systemPrompt === SUMMARY_SYSTEM));
    assert.equal((await getDoc(docId))?.digestStatus, 'error');
  });

  test('a model that never follows the format also ends in error', async () => {
    const docId = 'garbage-000001';
    await makeDoc(docId, 2);
    const provider = fakeProvider(() => 'Sorry, I can only see text.');
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);
    assert.equal(info.status, 'error');
    assert.match(info.error ?? '', /정리를 찾지 못했습니다/);
  });

  test('abort keeps finished slides; resuming only does the missing ones', async () => {
    const docId = 'abort-000001';
    await makeDoc(docId, 9, 'Abortable');
    const first = fakeProvider(async ({ slides, input, call }) => {
      if (call === 1) return digestOutput(slides);
      return untilAborted(input);
    });
    await startDigest(docId, { provider: 'claude-code', model: 'm1' }, depsFor(first, { concurrency: () => 1 }));
    await waitFor(() => first.calls.length === 2);
    assert.equal(abortDigest(docId), true);
    const aborted = await finish(docId);
    assert.equal(aborted.status, 'aborted');
    assert.equal(aborted.error, '사용자가 정리본 만들기를 중단했습니다');
    assert.deepEqual(
      aborted.slides.map((s) => s.slide),
      [1, 2, 3, 4],
    );
    assert.equal(first.calls.length, 2, 'no retries after an abort');
    assert.equal(abortDigest(docId), false, 'nothing is running any more');
    assert.equal((await readRecord(docId)).status, 'aborted');

    const second = fakeProvider(wellBehaved, 'codex');
    const resumed = await startDigest(docId, { provider: 'codex', model: '' }, depsFor(second));
    assert.equal(resumed.done, 4, 'finished slides are kept while resuming');
    const info = await finish(docId);
    assert.equal(info.status, 'ready');
    assert.equal(info.provider, 'codex');
    assert.equal(info.done, 9);
    assert.deepEqual(
      second.calls
        .filter((c) => c.systemPrompt === DIGEST_SYSTEM)
        .map(slidesOf)
        .sort((a, b) => a[0] - b[0]),
      [[5, 6, 7, 8], [9]],
    );
    assert.match(info.summary ?? '', /slides=1,2,3,4,5,6,7,8,9/);
  });

  test('force redoes every slide; a finished digest is not redone otherwise', async () => {
    const docId = 'force-000001';
    await makeDoc(docId, 5);
    const provider = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const first = await finish(docId);
    assert.equal(provider.calls.length, 3); // [1-4], [5], summary

    // Complete with a summary: nothing to do.
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    assert.equal((await finish(docId)).status, 'ready');
    assert.equal(provider.calls.length, 3);

    const forced = await startDigest(docId, { provider: 'claude-code', force: true }, depsFor(provider));
    assert.equal(forced.done, 0, 'the progress of a redo counts the redone slides');
    assert.equal(forced.slides.length, 5, 'the old entries stay until they are replaced');
    assert.equal(forced.summary, first.summary, 'the old summary stays until a new one is written');
    const info = await finish(docId);
    assert.equal(info.status, 'ready');
    assert.equal(info.done, 5);
    assert.equal(provider.calls.length, 6);
    assert.equal(provider.calls.at(-1)?.systemPrompt, SUMMARY_SYSTEM, 'the redone slides get a new summary');
    assert.equal((await readRecord(docId)).summaryStale, undefined);
  });

  test('an aborted redo keeps the previous digest (entries, summary, DIGEST.md, COURSE.md)', async () => {
    const docId = 'force-abort-000001';
    await makeDoc(docId, 12, 'Redo');
    const course = await createCourse('Redo course');
    await updateCourse(course.id, { docIds: [docId] });
    const original = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(original));
    const before = await finish(docId);
    assert.equal(before.status, 'ready');
    assert.match(before.summary ?? '', /^SUMMARY of/);

    // The redo writes new text for its first batch, then hangs until it is aborted.
    const redo = fakeProvider(async ({ slides, input, call }) => {
      if (call === 1) return digestOutput(slides).replaceAll('**Body**', '**New body**');
      return untilAborted(input);
    });
    await startDigest(docId, { provider: 'claude-code', force: true }, depsFor(redo, { concurrency: () => 1 }));
    await waitFor(() => redo.calls.length === 2);

    // While the redo runs, everything that reads the digest still sees a complete one.
    const running = await getDigestInfo(docId);
    assert.equal(running.status, 'running');
    assert.equal(running.done, 4, 'the first batch was redone');
    assert.equal(running.total, 12);
    assert.equal(running.slides.length, 12);
    assert.equal(running.summary, before.summary);
    const assets = await loadDocAssets(docId);
    assert.equal(assets.digestComplete, true);
    assert.equal(assets.digest?.length, 12);
    assert.match(await fs.readFile(docPaths(docId).digestMd, 'utf8'), /## 강의 요약[\s\S]*\*\*Body\*\* of slide 12/);
    assert.match(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /SUMMARY of/);

    assert.equal(abortDigest(docId), true);
    const aborted = await finish(docId);
    assert.equal(aborted.status, 'aborted');
    assert.equal(aborted.done, 12, 'every slide still has an entry');
    assert.deepEqual(
      aborted.slides.map((s) => s.markdown.startsWith('**New body**')),
      range(1, 12).map((n) => n <= 4),
      'redone slides are new, the others are the old entries',
    );
    assert.equal(aborted.summary, before.summary, 'the old summary is kept');
    const record = await readRecord(docId);
    assert.equal(record.summaryStale, true, 'the summary no longer matches the entries');
    assert.match(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /SUMMARY of/);

    // "이어서 만들기": no slide is missing, but the stale summary is made again.
    const resume = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(resume));
    const resumed = await finish(docId);
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.error, undefined);
    assert.deepEqual(
      resume.calls.map((c) => c.systemPrompt),
      [SUMMARY_SYSTEM],
    );
    assert.equal((await readRecord(docId)).summaryStale, undefined);
  });

  test('a redo whose calls fail keeps the old entries instead of failed placeholders', async () => {
    const docId = 'force-fail-000001';
    await makeDoc(docId, 4);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(fakeProvider(wellBehaved)));
    const before = await finish(docId);

    const failing = fakeProvider(({ slides, summary }) => {
      if (summary) return 'new summary';
      if (slides.includes(3)) throw new Error('usage limit reached');
      return digestOutput(slides).replaceAll('**Body**', '**New body**');
    });
    await startDigest(docId, { provider: 'claude-code', force: true }, depsFor(failing));
    const info = await finish(docId);
    assert.equal(info.status, 'ready');
    assert.deepEqual(
      info.slides.map((s) => [s.slide, s.failed ?? false, s.markdown.startsWith('**New body**')]),
      [
        [1, false, true],
        [2, false, true],
        [3, false, false],
        [4, false, true],
      ],
    );
    assert.equal(info.slides[2].markdown, before.slides[2].markdown);
    assert.equal(info.summary, 'new summary');
  });

  test('a summary interrupted after new slides is made by the next run (summaryStale)', async () => {
    const docId = 'stale-summary-000001';
    await makeDoc(docId, 4);
    // Run 1: slide 4 cannot be digested; the summary is made from slides 1–3.
    const first = fakeProvider(({ slides, summary, input }) => {
      if (summary) return `SUMMARY of ${textOf(input.parts)}`;
      return digestOutput(slides.filter((n) => n !== 4));
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(first));
    const run1 = await finish(docId);
    assert.equal(run1.status, 'ready');
    assert.match(run1.summary ?? '', /slides=1,2,3$/);
    assert.equal((await readRecord(docId)).summaryStale, undefined);

    // Run 2: slide 4 works now, but the summary call is aborted.
    const second = fakeProvider(async ({ slides, summary, input }) => {
      if (summary) return untilAborted(input);
      return digestOutput(slides);
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(second));
    await waitFor(() => second.calls.some((c) => c.systemPrompt === SUMMARY_SYSTEM));
    abortDigest(docId);
    const run2 = await finish(docId);
    assert.equal(run2.status, 'aborted');
    assert.match(run2.summary ?? '', /slides=1,2,3$/, 'the old summary is kept meanwhile');
    assert.equal((await readRecord(docId)).summaryStale, true);

    // Run 3: nothing is missing, yet the summary is regenerated from every slide.
    const third = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(third));
    const run3 = await finish(docId);
    assert.equal(third.calls.length, 1);
    assert.equal(run3.status, 'ready');
    assert.match(run3.summary ?? '', /slides=1,2,3,4$/);
    assert.equal(run3.error, undefined);
    assert.equal((await readRecord(docId)).summaryStale, undefined);
  });

  test('a failed summary keeps its note and the stale flag until it is made', async () => {
    const docId = 'stale-fail-000001';
    await makeDoc(docId, 2);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(fakeProvider(wellBehaved)));
    const original = (await finish(docId)).summary;

    const paths = docPaths(docId);
    const record = await readRecord(docId);
    record.slides[1] = { slide: 2, title: '', markdown: 'x', failed: true };
    await fs.writeFile(paths.digestJson, JSON.stringify(record));

    const flaky = fakeProvider(({ slides, summary }) => {
      if (summary) throw new Error('rate limited');
      return digestOutput(slides);
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(flaky));
    const failed = await finish(docId);
    assert.equal(failed.status, 'ready');
    assert.equal(failed.summary, original);
    assert.equal(failed.error, '강의 요약을 만들지 못했습니다: rate limited');
    assert.equal((await readRecord(docId)).summaryStale, true);

    const retry = fakeProvider(({ summary }) => (summary ? 'fixed summary' : 'unused'));
    await startDigest(docId, { provider: 'claude-code' }, depsFor(retry));
    const fixed = await finish(docId);
    assert.equal(retry.calls.length, 1, 'only the summary');
    assert.equal(fixed.error, undefined);
    assert.equal(fixed.summary, 'fixed summary');
    assert.equal((await readRecord(docId)).summaryStale, undefined);
  });

  test('a summary failure recorded before summaryStale existed is also redone by a plain run', async () => {
    // What the UI offers "📘 강의 요약 다시 만들기" for: ready, no failed slide, an old summary and its failure note.
    const docId = 'legacy-stale-000001';
    await makeDoc(docId, 2);
    const paths = docPaths(docId);
    await fs.mkdir(paths.digestDir, { recursive: true });
    const legacy: DigestRecord = {
      version: 1,
      status: 'ready',
      slides: [
        { slide: 1, title: 'A', markdown: 'a' },
        { slide: 2, title: 'B', markdown: 'b' },
      ],
      summary: 'OLD summary from slide 1 only',
      error: '강의 요약을 만들지 못했습니다: rate limited',
    };
    await fs.writeFile(paths.digestJson, JSON.stringify(legacy));
    const provider = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].systemPrompt, SUMMARY_SYSTEM);
    assert.equal(info.status, 'ready');
    assert.equal(info.error, undefined);
    assert.match(info.summary ?? '', /slides=1,2$/);
    assert.equal((await readRecord(docId)).summaryStale, undefined);

    // A ready digest without a note is left alone (nothing to do, no call).
    const idle = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(idle));
    assert.equal((await finish(docId)).summary, info.summary);
    assert.equal(idle.calls.length, 0);
  });

  test('digest calls run without tools', async () => {
    const docId = 'no-tools-000001';
    await makeDoc(docId, 3);
    const provider = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    await finish(docId);
    assert.equal(provider.calls.length, 2);
    for (const call of provider.calls) assert.equal(call.allowTools, false);
  });

  test('the concurrency limit holds across all jobs; a queued job can be aborted at once', async () => {
    const release = gate();
    let inFlight = 0;
    let maxInFlight = 0;
    const shared = fakeProvider(async ({ slides, summary, input }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.race([release.promise, untilAborted(input)]);
        return summary ? 'sum' : digestOutput(slides);
      } finally {
        inFlight--;
      }
    });
    const deps = depsFor(shared, { concurrency: () => 2 });
    const docs = ['global-a-000001', 'global-b-000001', 'global-c-000001'];
    for (const docId of docs) await makeDoc(docId, 8);
    for (const docId of docs) await startDigest(docId, { provider: 'claude-code' }, deps);
    await waitFor(() => inFlight === 2);
    await delay(30);
    assert.equal(inFlight, 2, 'three jobs, but only two calls at a time');
    assert.equal(shared.calls.length, 2);

    // The last job only waits for a slot: aborting it ends it right away, without any call.
    const callsBefore = shared.calls.length;
    assert.equal(abortDigest('global-c-000001'), true);
    assert.equal(await waitForDigest('global-c-000001', 1_000), true);
    assert.equal((await getDigestInfo('global-c-000001')).status, 'aborted');
    assert.equal(shared.calls.length, callsBefore);

    release.open();
    for (const docId of docs.slice(0, 2)) assert.equal((await finish(docId)).status, 'ready');
    assert.equal(maxInFlight, 2);
    assert.equal(digestCallsInFlight(), 0);
  });

  test('with a CLI provider every call also needs a slot of the CLI process budget, where chat turns go first', async () => {
    const docId = 'cli-budget-000001';
    await makeDoc(docId, 8);
    const budget = createCliBudget(() => 1);
    const provider = fakeProvider(wellBehaved);
    const chat = await budget.acquire('chat', new AbortController().signal);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider, { concurrency: () => 2, cliSlot: budget.acquire }));
    await waitFor(() => budget.usage().waitingDigest === 2);
    await delay(20);
    assert.equal(provider.calls.length, 0, 'a chat turn holds the only CLI slot');
    chat();
    assert.equal((await finish(docId)).status, 'ready');
    assert.equal(provider.maxInFlight, 1, 'one CLI process at a time although the digest concurrency is 2');
    assert.deepEqual(budget.usage(), { chat: 0, digest: 0, waitingChat: 0, waitingDigest: 0 });

    // Aborting a job that waits for a CLI slot gives its digest slot back at once.
    const waiting = 'cli-budget-000002';
    await makeDoc(waiting, 4);
    const held = await budget.acquire('chat', new AbortController().signal);
    await startDigest(waiting, { provider: 'claude-code' }, depsFor(provider, { concurrency: () => 1, cliSlot: budget.acquire }));
    await waitFor(() => budget.usage().waitingDigest === 1);
    assert.equal(abortDigest(waiting), true);
    assert.equal((await finish(waiting)).status, 'aborted');
    assert.equal(digestCallsInFlight(), 0);
    assert.equal(budget.usage().waitingDigest, 0);
    held();
  });

  test('all slides done but no summary: only the summary is made', async () => {
    const docId = 'summary-only-000001';
    await makeDoc(docId, 2);
    const paths = docPaths(docId);
    await fs.mkdir(paths.digestDir, { recursive: true });
    const record: DigestRecord = {
      version: 1,
      status: 'ready',
      slides: [
        { slide: 1, title: 'A', markdown: 'a' },
        { slide: 2, title: 'B', markdown: 'b' },
      ],
      summary: null,
      error: '강의 요약을 만들지 못했습니다: timeout',
    };
    await fs.writeFile(paths.digestJson, JSON.stringify(record));
    const provider = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].systemPrompt, SUMMARY_SYSTEM);
    assert.equal(info.status, 'ready');
    assert.equal(info.error, undefined, 'the old note is cleared');
    assert.match(info.summary ?? '', /slides=1,2/);
  });

  test('a failing summary keeps the digest ready with an explanation', async () => {
    const docId = 'summary-fail-000001';
    await makeDoc(docId, 3);
    const provider = fakeProvider(({ slides, summary }) => {
      if (summary) throw new Error('rate limited');
      return digestOutput(slides);
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    const info = await finish(docId);
    assert.equal(info.status, 'ready');
    assert.equal(info.summary, null);
    assert.equal(info.error, '강의 요약을 만들지 못했습니다: rate limited');
    assert.equal(info.done, 3);
  });

  test('one job per document; validation errors', async () => {
    const docId = 'busy-000001';
    await makeDoc(docId, 4);
    const release = gate();
    const provider = fakeProvider(async ({ slides, summary }) => {
      await release.promise;
      return summary ? 's' : digestOutput(slides);
    });
    const deps = depsFor(provider);
    await startDigest(docId, { provider: 'claude-code' }, deps);
    await assert.rejects(startDigest(docId, { provider: 'claude-code' }, deps), isHttpError(409));
    await assert.rejects(startDigest(docId, { provider: 'claude-code', force: true }, deps), isHttpError(409));
    release.open();
    assert.equal((await finish(docId)).status, 'ready');

    await assert.rejects(startDigest('missing-000000', { provider: 'claude-code' }, deps), isHttpError(404));
    await makeDoc('processing-000001', 4, 'Pending', 'processing');
    await assert.rejects(startDigest('processing-000001', { provider: 'claude-code' }, deps), isHttpError(409));
    await assert.rejects(startDigest(docId, { provider: 'openai-api' }, deps), isHttpError(400));
    await assert.rejects(
      startDigest(docId, { provider: 'claude-code' }, { ...deps, checkProvider: async () => ({ available: false, reason: 'not logged in' }) }),
      isHttpError(400),
    );
    assert.equal(isDigestRunning(docId), false, 'failed starts leave nothing reserved');
  });

  test('startup sweep: a record left running becomes aborted', async () => {
    const docId = 'crashed-000001';
    await makeDoc(docId, 3);
    const paths = docPaths(docId);
    await fs.mkdir(paths.digestDir, { recursive: true });
    const record: DigestRecord = { version: 1, status: 'running', slides: [{ slide: 1, title: 'A', markdown: 'a' }], summary: null };
    await fs.writeFile(paths.digestJson, JSON.stringify(record));

    // Even before the sweep, a 'running' record without a job is reported as aborted.
    assert.equal((await getDigestInfo(docId)).status, 'aborted');
    assert.ok((await recoverInterruptedDigests()) >= 1);
    const swept = await readRecord(docId);
    assert.equal(swept.status, 'aborted');
    assert.match(swept.error ?? '', /이어서 만들 수 있습니다/);
    assert.equal(swept.slides.length, 1);
    assert.equal(await recoverInterruptedDigests(), 0);

    // Resuming does the rest.
    const provider = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    assert.equal((await finish(docId)).done, 3);
    assert.deepEqual(provider.calls.filter((c) => c.systemPrompt === DIGEST_SYSTEM).map(slidesOf), [[2, 3]]);
  });

  test('the course title reaches the prompts and COURSE.md gets the summary', async () => {
    const docId = 'in-course-000001';
    await makeDoc(docId, 2, 'L7 Parsing');
    const course = await createCourse('Compiler');
    await updateCourse(course.id, { docIds: [docId] });
    const provider = fakeProvider(wellBehaved);
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    await finish(docId);
    assert.match(textOf(provider.calls[0].parts), /course=Compiler/);
    assert.match(textOf(provider.calls.at(-1)?.parts ?? []), /course=Compiler/);
    const md = await fs.readFile(coursePaths(course.id).courseMd, 'utf8');
    assert.match(md, /## 1\. L7 Parsing\n\nSUMMARY of SUMMARIZE "L7 Parsing" course=Compiler slides=1,2\n/);
    // The summary now reaches the context of the course's lectures.
    assert.match((await loadDocAssets(docId)).course?.lectures[0].summary ?? '', /^SUMMARY of/);
  });

  test('works with the real digestPrompt.ts (documented output format)', async () => {
    const docId = 'real-prompts-000001';
    await makeDoc(docId, 5, 'Top-down Parsing');
    const provider = fakeProvider(({ slides, summary }) => {
      if (summary) return '**주제**: 하향식 파싱';
      // Decorations the parser must tolerate: a code fence around the output, bold markers.
      const body = slides
        .map((n) => `**<<<SLIDE ${n}>>>**\nTITLE: Predictive Parsing ${n}\n$A \\rightarrow \\alpha$\n핵심: 슬라이드 ${n} 요점`)
        .join('\n\n');
      return `\`\`\`markdown\n${body}\n\`\`\``;
    });
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider, { prompts: DEFAULT_DIGEST_PROMPTS }));
    const info = await finish(docId);
    assert.equal(info.status, 'ready', info.error ?? '');
    assert.deepEqual(
      info.slides.map((s) => s.title),
      range(1, 5).map((n) => `Predictive Parsing ${n}`),
    );
    assert.ok(info.slides.every((s) => !s.failed && s.markdown.includes('핵심:')));
    assert.equal(info.summary, '**주제**: 하향식 파싱');
    assert.equal(provider.calls.length, 3);
  });
});

describe('DIGEST.md', () => {
  test('title, summary, then every slide with its image; headings demoted; failures marked', () => {
    const record: DigestRecord = {
      version: 1,
      status: 'ready',
      summary: '## 주제\nLL(1)',
      slides: [
        { slide: 1, title: 'Intro', markdown: '# Big heading\ntext\n\n```\n# not a heading\n```' },
        { slide: 2, title: '', markdown: '_(placeholder)_', failed: true },
      ],
    };
    assert.equal(
      digestMarkdown('L7 Parsing', 2, record),
      [
        '# L7 Parsing — 정리본',
        '',
        '## 강의 요약',
        '',
        '#### 주제',
        'LL(1)',
        '',
        '## Slide 1 · Intro',
        '',
        '![slide 1](slides/001.png)',
        '',
        '### Big heading',
        'text',
        '',
        '```',
        '# not a heading',
        '```',
        '',
        '## Slide 2',
        '',
        '![slide 2](slides/002.png)',
        '',
        '> 이 슬라이드는 자동 정리에 실패했습니다.',
        '',
        '_(placeholder)_',
        '',
      ].join('\n'),
    );
  });

  test('an incomplete digest says so', () => {
    const record: DigestRecord = { version: 1, status: 'aborted', summary: null, slides: [{ slide: 3, title: 'T', markdown: 'm' }] };
    assert.equal(
      digestMarkdown('Deck', 12, record),
      '# Deck — 정리본\n\n_(미완성 정리본: 1/12 슬라이드)_\n\n## Slide 3 · T\n\n![slide 3](slides/003.png)\n\nm\n',
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('HTTP routes', () => {
  let server: RunningServer;
  let base = '';
  const release = { current: gate() };
  const provider = fakeProvider(async ({ slides, summary, input }) => {
    if (textOf(input.parts).includes('"Blocking"')) {
      await Promise.race([release.current.promise, untilAborted(input)]);
    }
    return summary ? 'http summary' : digestOutput(slides);
  });
  const infos: ProviderInfo[] = [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'cli',
      available: true,
      models: [],
      defaultModel: '',
      efforts: [
        { id: 'low', label: '낮음' },
        { id: 'max', label: '최대' },
      ],
    },
    { id: 'codex', label: 'Codex', kind: 'cli', available: false, reason: 'codex CLI not found', models: [], defaultModel: '' },
  ];

  before(async () => {
    delete process.env.EASY_STUDY_AUTO_DIGEST;
    server = await startServer({
      port: 0,
      log: false,
      resumeIngests: false,
      providerInfos: async () => infos,
      digestDeps: depsFor(provider),
    });
    base = server.url;
  });

  after(async () => {
    await server?.close();
  });

  const api = (p: string, init?: RequestInit) => fetch(`${base}/api${p}`, init);
  const postJson = (p: string, body?: unknown) =>
    api(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function expectError(res: Response, status: number): Promise<string> {
    assert.equal(res.status, status);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, 'string');
    return body.error;
  }

  test('GET/POST digest, 409 while running, abort, digest.md', async () => {
    const docId = 'http-block-000001';
    await makeDoc(docId, 6, 'Blocking');

    const none = (await (await api(`/docs/${docId}/digest`)).json()) as DigestInfo;
    assert.equal(none.status, 'none');
    await expectError(await api(`/docs/${docId}/digest.md`), 404);
    await expectError(await api('/docs/missing-000000/digest'), 404);
    await expectError(await api('/docs/BAD%20ID/digest'), 404);

    await expectError(await postJson(`/docs/${docId}/digest`, { provider: 'nope' }), 400);
    await expectError(await postJson(`/docs/${docId}/digest`, { provider: 'codex' }), 400);
    await expectError(await postJson(`/docs/${docId}/digest`, { provider: 'claude-code', model: '--evil' }), 400);
    await expectError(await postJson(`/docs/${docId}/digest`, { provider: 'claude-code', force: 'yes' }), 400);
    await expectError(await postJson(`/docs/${docId}/digest`, { provider: 'claude-code', effort: 'ultra' }), 400);
    await expectError(await postJson('/docs/missing-000000/digest', { provider: 'claude-code' }), 404);

    const started = await postJson(`/docs/${docId}/digest`, { provider: 'claude-code', model: 'opus' });
    assert.equal(started.status, 202);
    const info = (await started.json()) as DigestInfo;
    assert.equal(info.status, 'running');
    assert.equal(info.model, 'opus');
    assert.equal(info.total, 6);
    await expectError(await postJson(`/docs/${docId}/digest`, { provider: 'claude-code' }), 409);
    assert.equal(((await (await api(`/docs/${docId}`)).json()) as DocMeta).digestStatus, 'running');

    assert.equal((await postJson(`/docs/${docId}/digest/abort`)).status, 204);
    await finish(docId);
    const aborted = (await (await api(`/docs/${docId}/digest`)).json()) as DigestInfo;
    assert.equal(aborted.status, 'aborted');
    // Aborting when nothing runs is fine too.
    assert.equal((await postJson(`/docs/${docId}/digest/abort`)).status, 204);
    await expectError(await postJson('/docs/missing-000000/digest/abort'), 404);

    const md = await api(`/docs/${docId}/digest.md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type') ?? '', /^text\/markdown; charset=utf-8/);
    assert.match(await md.text(), /^# Blocking — 정리본\n/);

    // DIGEST.md deleted by hand is rebuilt from digest.json.
    await fs.rm(docPaths(docId).digestMd);
    assert.match(await (await api(`/docs/${docId}/digest.md`)).text(), /^# Blocking — 정리본\n/);
  });

  test('creating a session starts the digest once (EASY_STUDY_AUTO_DIGEST=0 disables it)', async () => {
    const docId = 'http-auto-000001';
    await makeDoc(docId, 3, 'Auto');
    const before = provider.calls.length;
    const res = await postJson(`/docs/${docId}/sessions`, { provider: 'claude-code', model: 'haiku' });
    assert.equal(res.status, 201);
    const session = (await res.json()) as Session;
    assert.equal(session.model, 'haiku');
    const info = await finish(docId);
    assert.equal(info.status, 'ready');
    assert.equal(info.provider, 'claude-code');
    assert.equal(info.model, 'haiku');
    const used = provider.calls.length - before;
    assert.equal(used, 2, 'one batch + the summary');

    // A second session does not start another digest.
    await postJson(`/docs/${docId}/sessions`, { provider: 'claude-code' });
    await finish(docId);
    assert.equal(provider.calls.length - before, used);

    // The digest is made with the effort of the session that started it.
    const withEffort = 'http-effort-000001';
    await makeDoc(withEffort, 3, 'Effort');
    const effortBefore = provider.calls.length;
    const created = (await (await postJson(`/docs/${withEffort}/sessions`, { provider: 'claude-code', effort: 'max' })).json()) as Session;
    assert.equal(created.effort, 'max');
    assert.equal((await finish(withEffort)).effort, 'max');
    assert.ok(provider.calls.slice(effortBefore).every((c) => c.effort === 'max'));
    const manual = await postJson(`/docs/${withEffort}/digest`, { provider: 'claude-code', effort: 'low', force: true });
    assert.equal(((await manual.json()) as DigestInfo).effort, 'low');
    await finish(withEffort);

    process.env.EASY_STUDY_AUTO_DIGEST = '0';
    try {
      const other = 'http-noauto-000001';
      await makeDoc(other, 3, 'No auto');
      assert.equal((await postJson(`/docs/${other}/sessions`, { provider: 'claude-code' })).status, 201);
      assert.equal(isDigestRunning(other), false);
      assert.equal(((await (await api(`/docs/${other}/digest`)).json()) as DigestInfo).status, 'none');
    } finally {
      delete process.env.EASY_STUDY_AUTO_DIGEST;
    }

    // A document that is still processing gets its session, but no digest (and no error).
    await makeDoc('http-pending-000001', 3, 'Pending', 'processing');
    assert.equal((await postJson('/docs/http-pending-000001/sessions', { provider: 'claude-code' })).status, 201);
    assert.equal(isDigestRunning('http-pending-000001'), false);
  });

  test('a document cannot be deleted while its digest is being made', async () => {
    const docId = 'http-delete-000001';
    await makeDoc(docId, 4, 'Blocking');
    release.current = gate();
    assert.equal((await postJson(`/docs/${docId}/digest`, { provider: 'claude-code' })).status, 202);
    const refused = await expectError(await api(`/docs/${docId}`, { method: 'DELETE' }), 409);
    assert.match(refused, /정리본을 만드는 중/);
    assert.equal((await postJson(`/docs/${docId}/digest/abort`)).status, 204);
    await finish(docId);
    assert.equal((await api(`/docs/${docId}`, { method: 'DELETE' })).status, 204);
    await expectError(await api(`/docs/${docId}/digest`), 404);
    // A ready document has nothing to retry.
    await makeDoc('http-ready-000001', 2);
    await expectError(await postJson('/docs/http-ready-000001/retry'), 409);
    await expectError(await postJson('/docs/missing-000000/retry'), 404);
  });

  test('server shutdown aborts running digest jobs (resumable)', async () => {
    const docId = 'http-shutdown-000001';
    await makeDoc(docId, 4, 'Blocking');
    release.current = gate();
    assert.equal((await postJson(`/docs/${docId}/digest`, { provider: 'claude-code' })).status, 202);
    await waitFor(() => provider.inFlight > 0);
    await server.close();
    const record = await readRecord(docId);
    assert.equal(record.status, 'aborted');
    assert.equal(record.error, '서버가 종료되어 정리본 만들기가 중단되었습니다');
  });
});
