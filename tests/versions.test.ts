// A new version of a lecture's PDF over HTTP (DESIGN §28, 「새 버전 올리기」): upload → conversion and matching → the
// plan (with what sits on the removed slides) and the new thumbnails; apply → the render set, doc.json (deckRev,
// lastChange) and every subsystem follow the new slides (필기 and the removed-slide archive, sessions, a region
// attachment, a recording, the digest), the `deck` event ends the annotation stream; undo → everything back. The
// 409s (a digest or an answer running, turns held, a stale plan, nothing to undo, a swap running: the gate on every
// write), drop, and the startup: a half-applied swap is finished, a conversion left 'processing' is marked interrupted.
// Real PDF and image workers; fake providers (no LLM). The server process never loads sharp or PDFium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type {
  AnnotationEvent,
  Attachment,
  ChatMessage,
  DigestSlide,
  DocMeta,
  NextVersionInfo,
  ProviderInfo,
  RemovedSlide,
  Session,
  SlideAnnotations,
  TranscriptSegment,
} from '../shared/types.ts';
import { defaultChatDeps, reserveDocTurns } from '../server/chat.ts';
import type { ChatDeps } from '../server/chat.ts';
import { repoRoot } from '../server/config.ts';
import { isDigestRunning } from '../server/digest.ts';
import { smsg } from '../server/i18n.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import type { DigestRecord, SessionRecord } from '../server/internal-types.ts';
import { runMatchWorker, runPdfWorker } from '../server/imageWorker.ts';
import {
  beginDocSwap,
  createSlots,
  docPaths,
  endDocSwap,
  nextVersionPaths,
  prevVersionPaths,
  textFileName,
  waitForIngest,
  waitForNextVersion,
} from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import type { Provider } from '../server/providers/types.ts';
import type { SwapJournal } from '../server/versions.ts';
import { pagesPdf } from './pdfFixtures.ts';

/** The texts the server answers with (Korean: the tests send no language). */
const M = smsg('ko').library.versions;

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-versions-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Decks: slides with a title, two lines and the slide number in the bottom margin
// ---------------------------------------------------------------------------

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

const SLIDES: Record<string, string[]> = {
  A: ['Lexical analysis', 'Tokens are the smallest units of meaning', 'A scanner groups characters into lexemes'],
  B: ['Regular expressions', 'Patterns describe the shape of every token', 'The Kleene star repeats a pattern zero or more times'],
  C: ['Finite automata', 'A DFA has exactly one transition per symbol', 'Subset construction turns an NFA into a DFA'],
  D: ['Context free grammars', 'Productions rewrite nonterminals into strings', 'Derivations build parse trees from the start symbol'],
  E: ['Top down parsing', 'Recursive descent mirrors the grammar in code', 'FIRST and FOLLOW sets decide which production to use'],
  E2: ['Top down parsing', 'Recursive descent mirrors the grammar in code', 'Predictive tables are filled from the FIRST sets'],
  F: ['Bottom up parsing', 'Shift reduce parsers build the tree from the leaves', 'LR items track how much of a production was seen'],
  X: ['Error recovery', 'Panic mode skips input until a synchronizing token', 'Good messages point at the real cause of an error'],
};

function lecturePdf(keys: string[]): Buffer {
  return pagesPdf(
    keys.map((key, i) => {
      const [title, ...lines] = SLIDES[key];
      const content = [
        `BT /F1 32 Tf 60 440 Td (${title}) Tj ET`,
        ...lines.map((line, k) => `BT /F1 20 Tf 60 ${360 - k * 44} Td (${line}) Tj ET`),
        `BT /F1 14 Tf 900 20 Td (${i + 1}) Tj ET`,
      ].join('\n');
      return { content };
    }),
    [HELVETICA],
  );
}

/** The lecture, and its new version: C dropped, X inserted after D, E edited, every slide after B renumbered. */
const OLD_DECK = ['A', 'B', 'C', 'D', 'E', 'F'];
const NEW_DECK = ['A', 'B', 'D', 'X', 'E2', 'F'];

// ---------------------------------------------------------------------------
// A fake provider whose answers can be held (a turn or a digest that runs until released)
// ---------------------------------------------------------------------------

let hold: Promise<void> | null = null;
let providerCalls = 0;

const provider: Provider = {
  id: 'claude-code',
  label: 'Fake Claude Code',
  kind: 'cli',
  models: [{ id: '', label: 'default' }],
  defaultModel: '',
  maxImagesPerConversation: 48,
  detect: async () => ({ available: true }),
  run: async (input) => {
    providerCalls++;
    if (hold) await hold;
    input.onDelta('answer');
    return { text: 'answer', resume: { cliSessionId: `cli-${providerCalls}` } };
  },
};

function holdProvider(): () => void {
  let release = () => {};
  hold = new Promise((resolve) => (release = resolve));
  return () => {
    hold = null;
    release();
  };
}

const infos: ProviderInfo[] = [{ id: 'claude-code', label: 'Claude Code', kind: 'cli', available: true, models: [], defaultModel: '' }];
const chatDeps: ChatDeps = {
  ...defaultChatDeps(),
  getProvider: (id) => (id === 'claude-code' ? provider : undefined),
  checkProvider: async () => ({ available: true }),
  cliSlot: undefined,
};

function serverOptions() {
  return { port: 0, log: false, resumeIngests: false, backfillImages: false, sweepAttachments: false, providerInfos: async () => infos, chatDeps };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let server: RunningServer | null = null;
const api = (p: string, init?: RequestInit) => fetch(`${server!.url}/api${p}`, init);
const send = (method: string, p: string, body?: unknown) =>
  api(p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function json<T>(res: Response, status = 200): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  assert.equal(res.status, status, body.error ?? `status ${res.status}`);
  return body;
}

async function expectError(res: Response, status: number, message?: string): Promise<void> {
  const body = (await res.json()) as { error?: string };
  assert.equal(res.status, status, body.error ?? `status ${res.status}`);
  assert.equal(typeof body.error, 'string');
  if (message !== undefined) assert.equal(body.error, message);
}

async function importLecture(keys: string[], name: string): Promise<DocMeta> {
  const res = await api('/docs', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(name) }, body: lecturePdf(keys) });
  const meta = await json<DocMeta>(res, 201);
  await waitForIngest(meta.id);
  return meta;
}

function upload(docId: string, pdf: Buffer, name: string): Promise<Response> {
  return api(`/docs/${docId}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(name) }, body: pdf });
}

/** Polls GET …/versions/next (like the client) until it is no longer 'processing'. */
async function waitForPlan(docId: string): Promise<NextVersionInfo> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await api(`/docs/${docId}/versions/next`);
    const info = await json<NextVersionInfo>(res);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    if (info.status !== 'processing') return info;
    if (Date.now() > deadline) throw new Error('the new version was not converted in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function storedDoc(docId: string): Promise<StoredDocMeta> {
  return readJson<StoredDocMeta>(docPaths(docId).docJson);
}

async function slideText(docId: string, slide: number, pageCount: number): Promise<string> {
  return fs.readFile(path.join(docPaths(docId).textDir, textFileName(slide, pageCount)), 'utf8');
}

/** Reads an annotation SSE stream in the background until it ends. */
function openEvents(docId: string) {
  const events: AnnotationEvent[] = [];
  const controller = new AbortController();
  let ended = false;
  const done = (async () => {
    const res = await fetch(`${server!.url}/api/docs/${docId}/annotations/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const data = /^data: (.+)$/m.exec(buffer.slice(0, cut))?.[1];
        buffer = buffer.slice(cut + 2);
        if (data) events.push(JSON.parse(data) as AnnotationEvent);
      }
    }
  })()
    .catch(() => {})
    .finally(() => (ended = true));
  return {
    events,
    get ended() {
      return ended;
    },
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`${what}: not in time`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// What the student made on the lecture (written before the new version is uploaded)
// ---------------------------------------------------------------------------

let annotationSeq = 0;
const annotationId = () => `an-${(++annotationSeq).toString(16).padStart(12, '0')}`;
const RECT = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
const rectItem = () => ({ id: annotationId(), type: 'rect', color: 'blue', createdAt: '2026-10-01T10:00:00.000Z', rect: RECT });
const memoItem = (text: string) => ({
  id: annotationId(),
  type: 'memo',
  color: 'yellow',
  createdAt: '2026-10-01T10:00:00.000Z',
  at: { x: 0.5, y: 0.5 },
  text,
  tags: [],
  collapsed: false,
  tutor: true,
  links: [],
});

const SESSION_ID = '20261001-100000-abcd';
const RECORDING_ID = 'rec-20261001-100000-aaaa';

function message(id: string, role: 'user' | 'assistant', slide: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: `${role} on ${slide}`, slide, kind: 'question', createdAt: '2026-10-01T10:00:00.000Z', status: 'complete', ...extra };
}

/** Digest entries of the old deck: one per slide, named by the slide's key. */
function digestSlides(keys: string[]): DigestSlide[] {
  return keys.map((key, i) => ({ slide: i + 1, title: SLIDES[key][0], markdown: `About ${SLIDES[key][0]}` }));
}

async function writeStudentWork(docId: string, attachment: Attachment): Promise<void> {
  const paths = docPaths(docId);
  // A session: a question on the slide that goes away (with the region attachment), one on a slide that moves.
  const record: SessionRecord = {
    version: 1,
    id: SESSION_ID,
    docId,
    title: 'Questions',
    provider: 'claude-code',
    model: '',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:05:00.000Z',
    providerState: { resume: { cliSessionId: 'cli-old' }, primed: true, imagesSent: 4, recentSlides: [3, 4], generation: 1, history: [] },
    messages: [
      message('m1', 'user', 3, { attachments: [attachment], context: { primed: true, rollover: false, attachedSlides: [3], reusedSlides: [], overviewImages: 2 } }),
      message('m2', 'assistant', 3),
      message('m3', 'user', 4, { context: { primed: false, rollover: false, attachedSlides: [4], reusedSlides: [3], overviewImages: 0 } }),
      message('m4', 'assistant', 4),
      message('m5', 'user', 6),
      message('m6', 'assistant', 6),
    ],
  };
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.writeFile(path.join(paths.sessionsDir, `${SESSION_ID}.json`), JSON.stringify(record));

  // The digest of the old deck.
  const digest: DigestRecord = { version: 1, status: 'ready', slides: digestSlides(OLD_DECK), summary: 'The front end of a compiler.', lang: 'ko' };
  await fs.mkdir(paths.digestDir, { recursive: true });
  await fs.writeFile(paths.digestJson, JSON.stringify(digest));

  // A finished recording: one segment per slide, the timeline and a manual marker.
  const dir = path.join(paths.dir, 'recordings', RECORDING_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      id: RECORDING_ID,
      docId,
      title: 'Lecture',
      source: 'upload',
      status: 'ready',
      language: 'ko',
      model: 'small-q5_1',
      liveTranscribe: false,
      createdAt: '2026-10-01T10:00:00.000Z',
      durationSec: 12,
      transcriptStatus: 'ready',
      transcribedSec: 12,
      alignment: 'lexical',
      hasManualMarkers: true,
    }),
  );
  const segments: TranscriptSegment[] = OLD_DECK.map((_, k) => ({ id: k + 1, start: k * 2, end: k * 2 + 1.5, text: `sentence ${k + 1}`, slide: k + 1 }));
  await fs.writeFile(path.join(dir, 'transcript.json'), JSON.stringify({ recordingId: RECORDING_ID, segments, doneWindows: [], failedWindows: {}, nextId: 7 }));
  await fs.writeFile(path.join(dir, 'timeline.json'), JSON.stringify([{ t: 0, slide: 1 }, { t: 4, slide: 3 }, { t: 6, slide: 4 }]));
  await fs.writeFile(path.join(dir, 'markers.json'), JSON.stringify([{ t: 4, slide: 3 }, { t: 6, slide: 4 }]));
}

// ---------------------------------------------------------------------------

describe('a new version of a lecture over HTTP', () => {
  let docId = '';
  let other = '';
  let attachmentId = '';
  /** The annotation items written on slides 3 (dropped by the new version), 4 (→ 3) and 6. */
  const onC = [memoItem('왜 DFA가 하나뿐이지?'), rectItem()];
  const onD = [rectItem()];
  const onF = [memoItem('LR items')];
  let oldSlide3Text = '';
  let oldSlide4Text = '';

  before(async () => {
    server = await startServer(serverOptions());
    docId = (await importLecture(OLD_DECK, 'Compilers L2.pdf')).id;
    other = (await importLecture(['A', 'B', 'D'], 'Compilers L3.pdf')).id;

    for (const [slide, items] of [[3, onC], [4, onD], [6, onF]] as const) {
      await json<SlideAnnotations>(await send('PUT', `/docs/${docId}/annotations/${slide}`, { baseRev: 0, items, hiddenMarkers: [] }));
    }
    const attachment = await json<Attachment>(await send('POST', `/docs/${docId}/regions`, { slide: 3, rect: { x: 0, y: 0.1, w: 1, h: 0.3 } }), 201);
    attachmentId = attachment.id;
    await writeStudentWork(docId, attachment);
    oldSlide3Text = await slideText(docId, 3, 6);
    oldSlide4Text = await slideText(docId, 4, 6);
    assert.match(oldSlide3Text, /Finite automata/);
  });

  after(async () => {
    await server?.close();
    server = null;
  });

  test('upload: 400 not a PDF, 404 unknown lecture, 404 no new version yet', async () => {
    await expectError(await upload(docId, Buffer.from('not a pdf at all'), 'notes.txt'), 400, M.notPdf);
    await expectError(await upload(docId, Buffer.alloc(0), 'empty.pdf'), 400);
    await expectError(await upload('missing-000000', lecturePdf(['A']), 'x.pdf'), 404);
    await expectError(await api(`/docs/${docId}/versions/next`), 404, M.noNext);
    await expectError(await send('POST', `/docs/${docId}/versions/next/apply`), 404, M.noNext);
    await expectError(await send('POST', `/docs/${docId}/versions/undo`), 409, M.nothingToUndo);
  });

  test('upload → converted next to the lecture and matched: the plan, onRemoved, the new thumbnails', async () => {
    const res = await upload(docId, lecturePdf(NEW_DECK), 'Compilers L2 (v2).pdf');
    const accepted = await json<NextVersionInfo>(res, 202);
    assert.equal(accepted.status, 'processing');
    assert.equal(accepted.fileName, 'Compilers L2 (v2).pdf');

    const info = await waitForPlan(docId);
    assert.equal(info.status, 'ready', info.error ?? '');
    assert.equal(info.pageCount, 6);
    const plan = info.plan!;
    assert.equal(plan.fromRev, 0);
    assert.equal(plan.oldPageCount, 6);
    assert.equal(plan.newPageCount, 6);
    assert.deepEqual(
      plan.slides.map((s) => [s.slide, s.from, s.change]),
      [
        [1, 1, 'same'],
        [2, 2, 'same'],
        [3, 4, 'same'],
        [4, null, 'new'],
        [5, 5, 'changed'],
        [6, 6, 'same'],
      ],
    );
    assert.deepEqual(plan.removed, [3]);
    assert.equal(plan.unrelated, false);
    assert.deepEqual(plan.onRemoved, { items: 1, memos: 1, questions: 1 });

    // Staged outside the lecture's folder; the lecture itself is untouched.
    assert.ok(await exists(path.join(nextVersionPaths(docId).dir, 'slides', '004.png')));
    assert.equal(await slideText(docId, 4, 6), oldSlide4Text);
    assert.equal((await storedDoc(docId)).deckRev, undefined);

    const thumb = await api(`/docs/${docId}/versions/next/thumbs/4.webp`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    assert.equal(thumb.headers.get('cache-control'), 'no-store');
    await thumb.arrayBuffer();
    await expectError(await api(`/docs/${docId}/versions/next/thumbs/7.webp`), 404);
    await expectError(await api(`/docs/${docId}/versions/next/thumbs/1.png`), 404);
  });

  test('apply: the deck, doc.json and everything the student made follow the new slides', async () => {
    const stream = openEvents(docId);
    await waitFor(async () => (await api(`/docs/${docId}/annotations`)).ok, 'the stream');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const doc = await json<DocMeta>(await send('POST', `/docs/${docId}/versions/next/apply`));
    assert.equal(doc.deckRev, 1);
    assert.equal(doc.pageCount, 6);
    assert.equal(doc.fileName, 'Compilers L2 (v2).pdf');
    assert.equal(doc.title, 'Compilers L2');
    assert.deepEqual(doc.lastChange && { ...doc.lastChange, at: '' }, {
      rev: 1,
      at: '',
      kind: 'apply',
      fromFileName: 'Compilers L2.pdf',
      changed: [5],
      added: [4],
      removed: [3],
      undoable: true,
    });
    const listed = (await json<DocMeta[]>(await api('/docs'))).find((d) => d.id === docId);
    assert.equal(listed?.deckRev, 1);
    assert.equal(listed?.lastChange?.kind, 'apply');

    // The `deck` event, then the stream ends (every client reconnects and loads the lecture again).
    await waitFor(() => stream.ended, 'the end of the annotation stream');
    assert.deepEqual(stream.events.find((e) => e.type === 'deck'), { type: 'deck', rev: 1, kind: 'apply', oldToNew: [1, 2, null, 3, 5, 6] });
    await stream.close();

    // The render sets: the new deck is live, the replaced one is kept with the journal; the staging folder is gone.
    assert.match(await slideText(docId, 3, 6), /^Context free grammars\n[^]*\n3$/);
    assert.match(await slideText(docId, 4, 6), /^Error recovery/);
    const prev = prevVersionPaths(docId);
    assert.match(await fs.readFile(path.join(prev.textDir, '003.txt'), 'utf8'), /Finite automata/);
    const journal = await readJson<SwapJournal>(prev.journal);
    assert.equal(journal.complete, true);
    assert.equal(journal.fromRev, 0);
    assert.equal(journal.toRev, 1);
    assert.equal(journal.failed, undefined);
    assert.equal(await exists(nextVersionPaths(docId).dir), false);
    await expectError(await api(`/docs/${docId}/versions/next`), 404);

    // Slide images under the versioned URLs.
    for (const p of ['/thumbs/3.webp?v=1', '/slides/6.png?v=1', '/view/4.webp?v=1']) {
      const res = await api(`/docs/${docId}${p}`);
      assert.equal(res.status, 200, p);
      await res.arrayBuffer();
    }

    // 필기: old 4 → 3, old 6 stays, old 3 in the 빠진 슬라이드 archive with its thumbnail.
    const slide3 = await json<SlideAnnotations>(await api(`/docs/${docId}/annotations/3`));
    assert.deepEqual(slide3.items.map((item) => item.id), onD.map((item) => item.id));
    const slide6 = await json<SlideAnnotations>(await api(`/docs/${docId}/annotations/6`));
    assert.deepEqual(slide6.items.map((item) => item.id), onF.map((item) => item.id));
    assert.deepEqual((await json<SlideAnnotations>(await api(`/docs/${docId}/annotations/4`))).items, []);
    const removed = await json<RemovedSlide[]>(await api(`/docs/${docId}/annotations/removed`));
    assert.deepEqual(
      removed.map((r) => [r.rev, r.slide, r.thumb, r.items.map((item) => item.id)]),
      [[0, 3, true, onC.map((item) => item.id)]],
    );
    const archived = await api(`/docs/${docId}/annotations/removed/0/3.webp`);
    assert.equal(archived.status, 200);
    await archived.arrayBuffer();

    // The session: messages on their new slides, the dropped slide's question on the nearest kept one.
    const session = await json<Session>(await api(`/docs/${docId}/sessions/${SESSION_ID}`));
    const bySlide = Object.fromEntries(session.messages.map((m) => [m.id, [m.slide, m.removedFrom ?? null]]));
    assert.deepEqual(bySlide, {
      m1: [2, { rev: 0, slide: 3 }],
      m2: [2, { rev: 0, slide: 3 }],
      m3: [3, null],
      m4: [3, null],
      m5: [6, null],
      m6: [6, null],
    });
    assert.deepEqual(session.messages[0].attachments?.map((a) => [a.slide, a.removedFrom]), [[2, { rev: 0, slide: 3 }]]);
    const record = await readJson<SessionRecord>(path.join(docPaths(docId).sessionsDir, `${SESSION_ID}.json`));
    assert.equal(record.providerState.deckUpdated, true);
    assert.equal(record.providerState.resume, null);
    assert.equal(record.updatedAt, '2026-10-01T10:05:00.000Z');

    // The region attachment.
    const attachment = await readJson<Attachment>(path.join(docPaths(docId).dir, 'attachments', `${attachmentId}.json`));
    assert.equal(attachment.slide, 2);
    assert.deepEqual(attachment.removedFrom, { rev: 0, slide: 3 });

    // The recording: segments, timeline and markers renumbered; what was on the dropped slide cleared.
    const recDir = path.join(docPaths(docId).dir, 'recordings', RECORDING_ID);
    const transcript = await readJson<{ segments: TranscriptSegment[] }>(path.join(recDir, 'transcript.json'));
    assert.deepEqual(transcript.segments.map((s) => s.slide), [1, 2, null, 3, 5, 6]);
    assert.deepEqual(await readJson(path.join(recDir, 'timeline.json')), [{ t: 0, slide: 1 }, { t: 6, slide: 3 }]);
    assert.deepEqual(await readJson(path.join(recDir, 'markers.json')), [{ t: 6, slide: 3 }]);

    // The digest: unchanged slides renumbered, the changed and dropped ones to be made again.
    const digest = await readJson<DigestRecord>(docPaths(docId).digestJson);
    assert.deepEqual(
      digest.slides.map((s) => [s.slide, s.markdown]),
      [
        [1, 'About Lexical analysis'],
        [2, 'About Regular expressions'],
        [3, 'About Context free grammars'],
        [6, 'About Bottom up parsing'],
      ],
    );
    assert.equal(digest.summaryStale, true);
    assert.ok(await exists(path.join(docPaths(docId).digestDir, 'digest-r0.json')));
  });

  test('undo: the replaced deck and everything on it come back', async () => {
    const doc = await json<DocMeta>(await send('POST', `/docs/${docId}/versions/undo`));
    assert.equal(doc.deckRev, 2);
    assert.equal(doc.fileName, 'Compilers L2.pdf');
    assert.deepEqual(doc.lastChange && { ...doc.lastChange, at: '' }, {
      rev: 2,
      at: '',
      kind: 'undo',
      fromFileName: 'Compilers L2 (v2).pdf',
      changed: [5],
      added: [3],
      removed: [4],
      undoable: false,
    });
    assert.equal(await slideText(docId, 3, 6), oldSlide3Text);
    assert.equal(await slideText(docId, 4, 6), oldSlide4Text);
    assert.equal(await exists(prevVersionPaths(docId).dir), false);
    await expectError(await send('POST', `/docs/${docId}/versions/undo`), 409, M.nothingToUndo);

    for (const [slide, items] of [[3, onC], [4, onD], [6, onF]] as const) {
      const stored = await json<SlideAnnotations>(await api(`/docs/${docId}/annotations/${slide}`));
      assert.deepEqual(stored.items.map((item) => item.id), items.map((item) => item.id), `slide ${slide}`);
    }
    assert.deepEqual(await json<RemovedSlide[]>(await api(`/docs/${docId}/annotations/removed`)), []);

    const session = await json<Session>(await api(`/docs/${docId}/sessions/${SESSION_ID}`));
    assert.deepEqual(
      session.messages.map((m) => [m.slide, m.removedFrom ?? null]),
      [
        [3, null],
        [3, null],
        [4, null],
        [4, null],
        [6, null],
        [6, null],
      ],
    );
    const attachment = await readJson<Attachment>(path.join(docPaths(docId).dir, 'attachments', `${attachmentId}.json`));
    assert.equal(attachment.slide, 3);
    assert.equal(attachment.removedFrom, undefined);

    const recDir = path.join(docPaths(docId).dir, 'recordings', RECORDING_ID);
    const transcript = await readJson<{ segments: TranscriptSegment[] }>(path.join(recDir, 'transcript.json'));
    assert.deepEqual(transcript.segments.map((s) => s.slide), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await readJson(path.join(recDir, 'markers.json')), [{ t: 4, slide: 3 }, { t: 6, slide: 4 }]);

    const digest = await readJson<DigestRecord>(docPaths(docId).digestJson);
    assert.deepEqual(digest.slides.map((s) => [s.slide, s.markdown]), digestSlides(OLD_DECK).map((s) => [s.slide, s.markdown]));
  });

  test('busy: a digest being made, an answer being written, turns held → 409, nothing swapped', async () => {
    assert.equal((await json<NextVersionInfo>(await upload(other, lecturePdf(['A', 'B', 'D']), 'Compilers L3.pdf'), 202)).status, 'processing');
    const info = await waitForPlan(other);
    assert.equal(info.status, 'ready', info.error ?? '');
    // The same PDF again: nothing changed (the file name may have).
    assert.deepEqual(info.plan!.slides.map((s) => s.change), ['same', 'same', 'same']);

    // A digest job running (its provider call held).
    let release = holdProvider();
    try {
      const calls = providerCalls;
      await json(await send('POST', `/docs/${other}/digest`, { provider: 'claude-code' }), 202);
      await waitFor(() => providerCalls > calls, 'the digest call');
      await expectError(await send('POST', `/docs/${other}/versions/next/apply`), 409, M.busyDigest);
      await send('POST', `/docs/${other}/digest/abort`);
    } finally {
      release();
    }
    await waitFor(() => !isDigestRunning(other), 'the digest to stop');

    // An answer being written.
    const session = await json<Session>(await send('POST', `/docs/${other}/sessions`, { provider: 'claude-code' }), 201);
    release = holdProvider();
    let turn: Promise<string> | null = null;
    try {
      const calls = providerCalls;
      turn = send('POST', `/docs/${other}/sessions/${session.id}/messages`, { slide: 1, text: 'What is a token?' }).then((res) => res.text());
      await waitFor(() => providerCalls > calls, 'the turn');
      await expectError(await send('POST', `/docs/${other}/versions/next/apply`), 409, M.busyAnswering);
    } finally {
      release();
      await turn;
    }

    // Turns held (as by a swap running): refused too.
    const releaseTurns = reserveDocTurns(other);
    try {
      await expectError(await send('POST', `/docs/${other}/versions/next/apply`), 409, M.swapping);
    } finally {
      releaseTurns();
    }
    assert.equal((await storedDoc(other)).deckRev, undefined);
    assert.equal((await json<NextVersionInfo>(await api(`/docs/${other}/versions/next`))).status, 'ready');
  });

  test('a stale plan is refused; drop is idempotent', async () => {
    assert.equal((await json<DocMeta>(await send('POST', `/docs/${other}/versions/next/apply`))).deckRev, 1);
    await json(await upload(other, lecturePdf(['A', 'B', 'D', 'X']), 'Compilers L3 v3.pdf'), 202);
    const info = await waitForPlan(other);
    assert.equal(info.plan?.fromRev, 1);
    assert.deepEqual(info.plan?.slides.map((s) => s.change), ['same', 'same', 'same', 'new']);
    // The deck changes under the plan.
    assert.equal((await json<DocMeta>(await send('POST', `/docs/${other}/versions/undo`))).deckRev, 2);
    await expectError(await send('POST', `/docs/${other}/versions/next/apply`), 409, M.stalePlan);

    assert.equal((await send('DELETE', `/docs/${other}/versions/next`)).status, 204);
    await expectError(await api(`/docs/${other}/versions/next`), 404);
    assert.equal(await exists(nextVersionPaths(other).dir), false);
    assert.equal((await send('DELETE', `/docs/${other}/versions/next`)).status, 204);

    // Dropped while it is converted: the conversion stops and nothing comes back.
    assert.equal((await json<NextVersionInfo>(await upload(other, lecturePdf(OLD_DECK), 'dropped.pdf'), 202)).status, 'processing');
    assert.equal((await send('DELETE', `/docs/${other}/versions/next`)).status, 204);
    await waitForNextVersion(other);
    await expectError(await api(`/docs/${other}/versions/next`), 404);
    assert.equal(await exists(nextVersionPaths(other).dir), false);
  });

  test('a new upload replaces a pending one; a swap in progress refuses every write of the lecture', async () => {
    await json(await upload(other, lecturePdf(['A', 'B']), 'first.pdf'), 202);
    await json(await upload(other, lecturePdf(['A', 'B', 'D', 'F']), 'second.pdf'), 202);
    const info = await waitForPlan(other);
    assert.equal(info.fileName, 'second.pdf');
    assert.equal(info.pageCount, 4);

    beginDocSwap(other);
    try {
      await expectError(await send('PATCH', `/docs/${other}`, { title: 'Renamed' }), 409, M.swapping);
      await expectError(await send('DELETE', `/docs/${other}`), 409, M.swapping);
      await expectError(await send('PUT', `/docs/${other}/annotations/1`, { baseRev: 0, items: [], hiddenMarkers: [] }), 409, M.swapping);
      await expectError(await send('POST', `/docs/${other}/regions`, { slide: 1, rect: RECT }), 409, M.swapping);
      await expectError(await upload(other, lecturePdf(['A']), 'third.pdf'), 409, M.swapping);
      await expectError(await send('POST', `/docs/${other}/versions/next/apply`), 409, M.swapping);
      assert.equal((await api(`/docs/${other}`)).status, 200);
      assert.equal((await api(`/docs/${other}/versions/next`)).status, 200);
      // Another lecture is not affected.
      assert.equal((await send('PUT', `/docs/${docId}/annotations/1`, { baseRev: 0, items: [], hiddenMarkers: [] })).status, 200);
    } finally {
      endDocSwap(other);
    }
    await send('DELETE', `/docs/${other}/versions/next`);
  });

  test('startup: a half-applied swap is finished from its journal; a conversion left processing is marked interrupted', async () => {
    await json(await upload(docId, lecturePdf(NEW_DECK), 'Compilers L2 (v3).pdf'), 202);
    const info = await waitForPlan(docId);
    assert.equal(info.plan?.fromRev, 2);
    await waitForNextVersion(docId);
    await server!.close();
    server = null;

    // The server stopped right after it wrote the journal of an apply (nothing moved yet).
    const doc = await storedDoc(docId);
    const next = await readJson<{ aspectRatio: number }>(nextVersionPaths(docId).meta);
    const journal: SwapJournal = {
      fromRev: 2,
      toRev: 3,
      oldMeta: { pageCount: doc.pageCount, aspectRatio: doc.aspectRatio, fileName: doc.fileName },
      newFileName: 'Compilers L2 (v3).pdf',
      newAspectRatio: next.aspectRatio,
      plan: info.plan!,
      appliedAt: '2026-10-02T09:00:00.000Z',
      steps: [],
      complete: false,
    };
    const prev = prevVersionPaths(docId);
    await fs.mkdir(prev.dir, { recursive: true });
    await fs.writeFile(prev.journal, JSON.stringify(journal));
    // And while it converted a new version of the other lecture, uploaded in English.
    const staged = nextVersionPaths(other);
    await fs.mkdir(path.join(staged.dir, 'slides'), { recursive: true });
    await fs.writeFile(staged.sourcePdf, lecturePdf(['A']));
    await fs.writeFile(staged.meta, JSON.stringify({ status: 'processing', fileName: 'x.pdf', progress: 1, pageCount: 1, aspectRatio: 16 / 9, createdAt: new Date().toISOString(), lang: 'en' }));

    server = await startServer(serverOptions());
    const swapped = await storedDoc(docId);
    assert.equal(swapped.deckRev, 3);
    assert.equal(swapped.fileName, 'Compilers L2 (v3).pdf');
    assert.equal(swapped.lastChange?.kind, 'apply');
    assert.match(await slideText(docId, 3, 6), /^Context free grammars/);
    assert.equal((await readJson<SwapJournal>(prev.journal)).complete, true);
    assert.equal(await exists(nextVersionPaths(docId).dir), false);
    const slide3 = await json<SlideAnnotations>(await api(`/docs/${docId}/annotations/3`));
    assert.deepEqual(slide3.items.map((item) => item.id), onD.map((item) => item.id));
    const session = await json<Session>(await api(`/docs/${docId}/sessions/${SESSION_ID}`));
    assert.deepEqual(session.messages.map((m) => m.slide), [2, 2, 3, 3, 6, 6]);

    const interrupted = await json<NextVersionInfo>(await api(`/docs/${other}/versions/next`));
    assert.equal(interrupted.status, 'error');
    assert.equal(interrupted.error, smsg('en').library.versions.interrupted);
    assert.equal(await exists(staged.sourcePdf), false);

    // Deleting the lecture removes the replaced deck with it.
    assert.equal((await send('DELETE', `/docs/${docId}`)).status, 204);
    assert.equal(await exists(prev.dir), false);
  });
});

describe('the match worker and the ingest slots', () => {
  test('matches a deck read from its source.pdf, or from its slides and text files when it has none', async () => {
    const oldDir = await fs.mkdtemp(path.join(tmpRoot, 'old-deck-'));
    const newDir = await fs.mkdtemp(path.join(tmpRoot, 'new-deck-'));
    await fs.writeFile(path.join(oldDir, 'source.pdf'), lecturePdf(OLD_DECK));
    await fs.writeFile(path.join(newDir, 'source.pdf'), lecturePdf(NEW_DECK));
    await runPdfWorker({ kind: 'pdf', docDir: oldDir, longEdge: 1600 }).done;

    const expected = [1, 2, 4, null, 5, 6];
    const fromPdf = await runMatchWorker({ kind: 'match', oldDir, oldPageCount: 6, newDir }).done;
    assert.deepEqual(fromPdf.slides.map((s) => s.from), expected);
    assert.deepEqual(fromPdf.slides.map((s) => s.change), ['same', 'same', 'same', 'new', 'changed', 'same']);
    assert.deepEqual(fromPdf.removed, [3]);
    assert.deepEqual(fromPdf.oldToNew, [1, 2, null, 3, 5, 6]);

    // A deck converted before (or whose PDF is gone): its rendered slides and text files.
    await fs.rm(path.join(oldDir, 'source.pdf'));
    const fromFiles = await runMatchWorker({ kind: 'match', oldDir, oldPageCount: 6, newDir }).done;
    assert.deepEqual(fromFiles.slides.map((s) => s.from), expected);
    assert.deepEqual(fromFiles.removed, [3]);

    // The new version's PDF must be readable.
    await fs.writeFile(path.join(newDir, 'source.pdf'), 'not a pdf');
    await assert.rejects(runMatchWorker({ kind: 'match', oldDir, oldPageCount: 6, newDir }).done);
  });

  test('a caller waiting for a slot can give up (a new version dropped while it waits)', async () => {
    const slots = createSlots(1);
    const first = await slots.acquire();
    assert.ok(first);
    const controller = new AbortController();
    const waiting = slots.acquire(controller.signal);
    const next = slots.acquire();
    assert.deepEqual(slots.load(), { running: 1, waiting: 2 });
    controller.abort();
    assert.equal(await waiting, null);
    assert.deepEqual(slots.load(), { running: 1, waiting: 1 });
    first();
    const second = await next;
    assert.ok(second);
    assert.deepEqual(slots.load(), { running: 1, waiting: 0 });
    second();
    assert.equal(await slots.acquire(AbortSignal.abort()), null);
    assert.deepEqual(slots.load(), { running: 0, waiting: 0 });
  });
});

describe('the server process never loads sharp or PDFium', () => {
  test('upload, conversion, matching, apply and undo of a new version run in workers', async () => {
    const library = await fs.mkdtemp(path.join(tmpRoot, 'library-'));
    const script = path.join(tmpRoot, 'no-sharp.mjs');
    const oldPdf = path.join(tmpRoot, 'old.pdf');
    const newPdf = path.join(tmpRoot, 'new.pdf');
    await fs.writeFile(oldPdf, lecturePdf(OLD_DECK));
    await fs.writeFile(newPdf, lecturePdf(NEW_DECK));
    const href = (file: string) => JSON.stringify(pathToFileURL(path.join(repoRoot(), 'server', file)).href);
    await fs.writeFile(
      script,
      `import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({
  resolve(specifier, context, next) {
    if (/^(sharp|@img\\/|@embedpdf\\/)/.test(specifier)) loaded.push(specifier);
    return next(specifier, context);
  },
});
const { startServer } = await import(${href('index.ts')});
const library = await import(${href('library.ts')});
const fs = await import('node:fs/promises');
const server = await startServer({ port: 0, log: false, resumeIngests: false, backfillImages: false, sweepAttachments: false });
const post = (p, body) => fetch(server.url + '/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body });
const created = await (await post('/docs', await fs.readFile(${JSON.stringify(oldPdf)}))).json();
await library.waitForIngest(created.id);
await post('/docs/' + created.id + '/versions', await fs.readFile(${JSON.stringify(newPdf)}));
await library.waitForNextVersion(created.id);
const plan = (await (await fetch(server.url + '/api/docs/' + created.id + '/versions/next')).json()).plan;
const applied = await (await post('/docs/' + created.id + '/versions/next/apply')).json();
const undone = await (await post('/docs/' + created.id + '/versions/undo')).json();
await server.close();
console.log(JSON.stringify({ removed: plan.removed, applied: applied.deckRev, undone: undone.deckRev, loaded }));
`,
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, EASY_STUDY_LIBRARY: library, EASY_STUDY_AUTO_DIGEST: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, stderr);
    const report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { removed: number[]; applied: number; undone: number; loaded: string[] };
    assert.deepEqual(report, { removed: [3], applied: 1, undone: 2, loaded: [] });
  });
});
