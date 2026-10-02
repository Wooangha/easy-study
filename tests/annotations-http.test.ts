// Slide annotations over HTTP (DESIGN §25): the routes and their headers, the 409 body with `current`, the 400 table
// over HTTP, a slide of 펜 strokes up to the byte cap through the JSON body limit (§29), the SSE stream (ops-carrying `slide` frames, `slide-reset` after a PUT, the writer's own client id not
// echoed, pings, `qa` once after a turn and on a session's deletion, the stream's end when the document is deleted),
// `memos` on POST …/messages, and GET …/text-layout/:slide (200 with ETag, 404 pending true / false, 409 while the
// document is not ready; a pending layout is written by the backfill). Fake providers; the PDF worker is the real one.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ANNOTATION_CLIENT_HEADER, MAX_INK_POINTS, MAX_SLIDE_ANNOTATION_BYTES } from '../shared/types.ts';
import type {
  AnnotationEvent,
  AnnotationItem,
  AnnotationSummary,
  AnnotationTagsResponse,
  ProviderInfo,
  Session,
  SlideAnnotations,
  SlideTextLayout,
  StreamEvent,
} from '../shared/types.ts';
import { configureAnnotations } from '../server/annotations.ts';
import { defaultChatDeps } from '../server/chat.ts';
import type { ChatDeps } from '../server/chat.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import { docPaths, waitForBackfill } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE, layoutFileName, textFileName } from '../server/pageNames.ts';
import type { Part, Provider, ProviderRunInput } from '../server/providers/types.ts';
import { deckPdf } from './pdfFixtures.ts';
import { smsg } from '../server/i18n.ts';

/** The 404 bodies of GET …/text-layout/:slide (Korean: the tests send no language). */
const { layoutPending: LAYOUT_PENDING, layoutNever: LAYOUT_NEVER } = smsg('ko').library.annotations;

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-annot-http-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  configureAnnotations();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGES = 3;

/** A ready document with extracted texts (enough for turns; images are never opened by the fake provider). */
async function makeDoc(docId: string, options: { status?: StoredDocMeta['status']; pageCount?: number; marker?: string | null; pdf?: Buffer } = {}): Promise<void> {
  const paths = docPaths(docId);
  const pageCount = options.pageCount ?? PAGES;
  await fs.mkdir(paths.textDir, { recursive: true });
  await fs.mkdir(paths.slidesDir, { recursive: true });
  const meta: StoredDocMeta = {
    id: docId,
    title: `Deck ${docId}`,
    fileName: `${docId}.pdf`,
    pageCount: options.status === 'processing' ? 0 : pageCount,
    aspectRatio: 16 / 9,
    status: options.status ?? 'ready',
    progress: pageCount,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
  for (let n = 1; n <= pageCount; n++) await fs.writeFile(path.join(paths.textDir, textFileName(n, pageCount)), `Slide ${n} text`);
  if (options.marker !== null) await fs.writeFile(path.join(paths.textDir, TEXT_ENGINE_FILE), `${options.marker ?? TEXT_ENGINE}\n`);
  if (options.pdf) await fs.writeFile(paths.sourcePdf, options.pdf);
}

function textOf(parts: Part[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : `<image ${part.label}>`)).join('\n');
}

function fakeProvider() {
  const calls: ProviderRunInput[] = [];
  const provider: Provider = {
    id: 'claude-code',
    label: 'Fake Claude Code',
    kind: 'cli',
    models: [{ id: '', label: 'default' }],
    defaultModel: '',
    maxImagesPerConversation: 48,
    detect: async () => ({ available: true }),
    run: async (input) => {
      calls.push(input);
      const text = `answer ${calls.length}`;
      input.onDelta(text);
      return { text, resume: { cliSessionId: `cli-${calls.length}` } };
    },
  };
  return { provider, calls };
}

interface SseFrame {
  event: string;
  data: AnnotationEvent;
}

/** Reads an SSE stream in the background until close(). */
function openSse(url: string) {
  const frames: SseFrame[] = [];
  const controller = new AbortController();
  let status = 0;
  let ended = false;
  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    status = res.status;
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data) as AnnotationEvent });
      }
    }
    ended = true;
  })().catch(() => {
    ended = true;
  });
  return {
    frames,
    get status() {
      return status;
    },
    get ended() {
      return ended;
    },
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

function parseSse(raw: string): Array<{ event: string; data: StreamEvent }> {
  return raw
    .split('\n\n')
    .filter((frame) => frame.trim() && !frame.startsWith(':'))
    .map((frame) => ({
      event: /^event: (.+)$/m.exec(frame)?.[1] ?? '',
      data: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? 'null') as StreamEvent,
    }));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

let counter = 0;
const id = () => `an-${(++counter).toString(16).padStart(12, '0')}`;
const RECT = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
const rectItem = (extra: Record<string, unknown> = {}) => ({ id: id(), type: 'rect', color: 'blue', createdAt: '2026-09-29T10:00:00.000Z', rect: RECT, ...extra });
/** A 펜 stroke of MAX_INK_POINTS points (10 KB of `pts`). */
const longStroke = () => ({ id: id(), type: 'ink', color: 'blue', createdAt: '2026-09-29T10:00:00.000Z', rect: RECT, width: 0.005, pts: 'AAAAg'.repeat(MAX_INK_POINTS) });
const memoItem = (extra: Record<string, unknown> = {}) => ({
  id: id(),
  type: 'memo',
  color: 'yellow',
  createdAt: '2026-09-29T10:00:00.000Z',
  at: { x: 0.5, y: 0.5 },
  text: '이게 왜 이렇게 되지?',
  tags: ['시험'],
  collapsed: false,
  tutor: true,
  links: [],
  ...extra,
});

// ---------------------------------------------------------------------------

describe('annotations over HTTP', () => {
  let server: RunningServer;
  let base = '';
  const DOC = 'annot-deck-aaa111';
  const PROCESSING = 'busy-deck-bbb222';
  const NO_PDF = 'nopdf-deck-ccc333';
  const OLD_TEXT = 'oldtext-deck-ddd444';
  const PENDING = 'pending-deck-eee555';
  const GONE = 'gone-deck-fff666';
  const fake = fakeProvider();
  const infos: ProviderInfo[] = [{ id: 'claude-code', label: 'Claude Code', kind: 'cli', available: true, models: [], defaultModel: '' }];
  const deps: ChatDeps = {
    ...defaultChatDeps(),
    getProvider: (provider) => (provider === 'claude-code' ? fake.provider : undefined),
    checkProvider: async () => ({ available: true }),
    cliSlot: undefined,
  };

  const api = (p: string, init?: RequestInit) => fetch(`${base}/api${p}`, init);
  const send = (method: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
    api(p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  async function expectError(res: Response, status: number, pattern?: RegExp): Promise<Record<string, unknown>> {
    const body = await json<{ error: string }>(res);
    assert.equal(res.status, status, body.error);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(typeof body.error, 'string');
    if (pattern) assert.match(body.error, pattern);
    return body as unknown as Record<string, unknown>;
  }

  before(async () => {
    configureAnnotations({ pingMs: 60 });
    await makeDoc(DOC);
    await makeDoc(PROCESSING, { status: 'processing' });
    await makeDoc(NO_PDF);
    await makeDoc(OLD_TEXT, { marker: null });
    await makeDoc(PENDING, { marker: 'pdfium-2', pdf: deckPdf(PAGES) });
    await makeDoc(GONE);
    server = await startServer({ port: 0, log: false, resumeIngests: false, backfillImages: false, sweepAttachments: false, providerInfos: async () => infos, chatDeps: deps });
    base = server.url;
  });

  after(async () => {
    await server?.close();
  });

  test('summary, slide documents, PUT / PATCH with revs, 409 with the current document, 400s; ids that are not slides', async () => {
    const summary = await api(`/docs/${DOC}/annotations`);
    assert.equal(summary.status, 200);
    assert.equal(summary.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(await json<AnnotationSummary>(summary), { version: 1, slides: [], memos: [], tags: [] });

    const empty = await api(`/docs/${DOC}/annotations/2`);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('cache-control'), 'no-cache');
    assert.equal((await json<SlideAnnotations>(empty)).rev, 0);

    const memo = memoItem();
    const put = await send('PUT', `/docs/${DOC}/annotations/2`, { baseRev: 0, items: [memo], hiddenMarkers: [] });
    assert.equal(put.status, 200);
    const stored = await json<SlideAnnotations>(put);
    assert.deepEqual([stored.rev, stored.slide, stored.items.length], [1, 2, 1]);

    const stale = await send('PATCH', `/docs/${DOC}/annotations/2`, { baseRev: 0, ops: [{ op: 'add', item: rectItem() }] });
    const conflict = await expectError(stale, 409, /다른 곳에서/);
    assert.deepEqual(conflict.current, stored);

    const patched = await send('PATCH', `/docs/${DOC}/annotations/2`, { baseRev: 1, ops: [{ op: 'add', item: rectItem() }, { op: 'update', id: memo.id, patch: { text: '고침' } }] });
    assert.equal(patched.status, 200);
    const next = await json<SlideAnnotations>(patched);
    assert.equal(next.rev, 2);
    assert.equal((next.items[0] as { text: string }).text, '고침');
    assert.deepEqual(await json<SlideAnnotations>(await api(`/docs/${DOC}/annotations/2`)), next);

    await expectError(await send('PATCH', `/docs/${DOC}/annotations/2`, { baseRev: 2, ops: [{ op: 'add', item: { ...rectItem(), color: 'red' } }] }), 400, /필기 색/);
    await expectError(await send('PATCH', `/docs/${DOC}/annotations/2`, { baseRev: 2, ops: [] }), 400, /ops/);
    await expectError(await send('PUT', `/docs/${DOC}/annotations/2`, { items: [] }), 400, /baseRev/);
    await expectError(await api(`/docs/${DOC}/annotations/2`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{bad' }), 400, /JSON/);

    const withSummary = await json<AnnotationSummary>(await api(`/docs/${DOC}/annotations`));
    assert.deepEqual(withSummary.slides, [{ slide: 2, rev: 2, items: 2, memos: 1, tags: ['시험'] }]);
    assert.deepEqual(withSummary.memos.map((entry) => [entry.id, entry.text]), [[memo.id, '고침']]);
    assert.deepEqual(withSummary.tags, [{ tag: '시험', count: 1 }]);

    const tags = await api('/annotations/tags');
    assert.equal(tags.status, 200);
    assert.deepEqual(await json<AnnotationTagsResponse>(tags), { tags: [{ tag: '시험', count: 1 }] });

    for (const bad of ['abc', '0', '-1', '1.5', '4', '1000000']) await expectError(await api(`/docs/${DOC}/annotations/${bad}`), 404, /슬라이드/);
    await expectError(await api(`/docs/no-such-deck-000000/annotations`), 404, /문서/);
    await expectError(await api(`/docs/no-such-deck-000000/annotations/1`), 404, /문서/);
    await expectError(await api(`/docs/no-such-deck-000000/annotations/events`), 404, /문서/);
    await expectError(await api(`/docs/${PROCESSING}/annotations/1`), 404, /슬라이드/);
  });

  test('펜 strokes up to the byte cap go through PUT and PATCH (the 2 MB JSON body limit is ample); past it is 400, not 413', async () => {
    // 100 long strokes: ~1.02 MB, just under MAX_SLIDE_ANNOTATION_BYTES.
    const strokes = Array.from({ length: 100 }, longStroke);
    const put = await send('PUT', `/docs/${DOC}/annotations/3`, { baseRev: 0, items: strokes, hiddenMarkers: [] });
    assert.equal(put.status, 200);
    const stored = await json<SlideAnnotations>(put);
    assert.equal(stored.items.length, 100);
    const bytes = Buffer.byteLength(JSON.stringify(stored));
    assert.ok(bytes > 1_000_000 && bytes <= MAX_SLIDE_ANNOTATION_BYTES, String(bytes));
    assert.deepEqual(await json<SlideAnnotations>(await api(`/docs/${DOC}/annotations/3`)), stored);

    await expectError(await send('PATCH', `/docs/${DOC}/annotations/3`, { baseRev: 1, ops: Array.from({ length: 5 }, () => ({ op: 'add', item: longStroke() })) }), 400, /너무 많아요/);
    await expectError(await send('PUT', `/docs/${DOC}/annotations/3`, { baseRev: 1, items: [...strokes, ...Array.from({ length: 5 }, longStroke)], hiddenMarkers: [] }), 400, /너무 많아요/);
    const removed = await send('PATCH', `/docs/${DOC}/annotations/3`, { baseRev: 1, ops: [{ op: 'remove', id: strokes[0].id }, { op: 'add', item: longStroke() }] });
    assert.equal(removed.status, 200);
    const cleared = await send('PUT', `/docs/${DOC}/annotations/3`, { baseRev: 2, items: [], hiddenMarkers: [] });
    assert.equal(cleared.status, 200);
  });

  test('SSE: ops of a PATCH, the document after a PUT, nothing back to the writer, pings, summary nudges', async () => {
    const mine = openSse(`${base}/api/docs/${DOC}/annotations/events?client=client-aaaaaaaa`);
    const other = openSse(`${base}/api/docs/${DOC}/annotations/events?client=client-bbbbbbbb`);
    await waitFor(() => mine.status === 200 && other.status === 200, 5_000, 'streams open');
    const rect = rectItem();
    const res = await send('PATCH', `/docs/${DOC}/annotations/1`, { baseRev: 0, ops: [{ op: 'add', item: rect }] }, { [ANNOTATION_CLIENT_HEADER]: 'client-aaaaaaaa' });
    const doc = await json<SlideAnnotations>(res);
    await waitFor(() => other.frames.some((frame) => frame.event === 'slide'), 5_000, 'the other client gets the ops');
    const slide = other.frames.find((frame) => frame.event === 'slide')?.data;
    assert.ok(slide?.type === 'slide');
    assert.deepEqual([slide.slide, slide.rev, slide.updatedAt], [1, 1, doc.updatedAt]);
    assert.deepEqual(slide.ops, [{ op: 'add', item: doc.items[0] }]);
    assert.ok(other.frames.some((frame) => frame.event === 'summary'));
    assert.ok(!mine.frames.some((frame) => frame.event === 'slide'), 'the writer is not echoed');

    const put = await json<SlideAnnotations>(await send('PUT', `/docs/${DOC}/annotations/1`, { baseRev: 1, items: [], hiddenMarkers: [] }, { [ANNOTATION_CLIENT_HEADER]: 'client-bbbbbbbb' }));
    await waitFor(() => mine.frames.some((frame) => frame.event === 'slide-reset'), 5_000, 'the reset reaches the other client');
    assert.deepEqual(mine.frames.find((frame) => frame.event === 'slide-reset')?.data, { type: 'slide-reset', annotations: put });
    assert.ok(!other.frames.some((frame) => frame.event === 'slide-reset'));

    // An invalid client id is ignored: that subscriber gets its own writes back.
    const anon = openSse(`${base}/api/docs/${DOC}/annotations/events?client=x`);
    await waitFor(() => anon.status === 200);
    await send('PATCH', `/docs/${DOC}/annotations/1`, { baseRev: 2, ops: [{ op: 'hideMarker', key: { sessionId: '20260929-100000-abcd', messageId: 'm1', attachmentId: `att-${'0'.repeat(16)}` } }] }, { [ANNOTATION_CLIENT_HEADER]: 'x' });
    await waitFor(() => anon.frames.some((frame) => frame.event === 'slide'));

    await waitFor(() => mine.frames.filter((frame) => frame.event === 'ping').length >= 2, 5_000, 'pings');
    await mine.close();
    await other.close();
    await anon.close();
  });

  test('turns: memos of the window reach the tutor unless `memos: false`; `qa` once per finished turn and once on a session deletion', async () => {
    const stream = openSse(`${base}/api/docs/${DOC}/annotations/events`);
    await waitFor(() => stream.status === 200);
    const session = await json<Session>(await send('POST', `/docs/${DOC}/sessions`, { provider: 'claude-code' }));
    const ask = async (body: Record<string, unknown>) => {
      const res = await send('POST', `/docs/${DOC}/sessions/${session.id}/messages`, { text: '질문', slide: 2, ...body });
      assert.equal(res.status, 200, await res.clone().text());
      const frames = parseSse(await res.text());
      assert.equal(frames.at(-1)?.event, 'done');
      return frames.at(-1)?.data as Extract<StreamEvent, { type: 'done' }>;
    };
    const lastCall = () => textOf(fake.calls.at(-1)?.parts ?? []);

    await expectError(await send('POST', `/docs/${DOC}/sessions/${session.id}/messages`, { text: '질문', slide: 2, memos: 'yes' }), 400, /memos는 true\/false/);

    const done = await ask({});
    assert.ok(lastCall().includes("The student's own notes on slide 2"), lastCall());
    assert.ok(lastCall().includes('- [tags: 시험] 고침'));
    // `done` carries the whole session (chat.ts), typed as its summary.
    const user = (done.session as Session).messages.at(-2);
    assert.equal(user?.context?.memos, 1);
    await waitFor(() => stream.frames.some((frame) => frame.event === 'qa'), 5_000, 'qa after the turn');
    assert.deepEqual(
      stream.frames.filter((frame) => frame.event === 'qa').map((frame) => frame.data),
      [{ type: 'qa', sessionId: session.id, updatedAt: done.session.updatedAt }],
      'exactly one qa per turn',
    );

    const off = await ask({ memos: false });
    assert.ok(!lastCall().includes("The student's own notes"));
    assert.equal((off.session as Session).messages.at(-2)?.context?.memos, undefined);

    // A memo the student hid from the tutor (👁 off) never reaches it.
    const doc = await json<SlideAnnotations>(await api(`/docs/${DOC}/annotations/2`));
    const memo = doc.items.find((item): item is Extract<AnnotationItem, { type: 'memo' }> => item.type === 'memo')!;
    await send('PATCH', `/docs/${DOC}/annotations/2`, { baseRev: doc.rev, ops: [{ op: 'update', id: memo.id, patch: { tutor: false } }] });
    await ask({});
    assert.ok(!lastCall().includes("The student's own notes"));

    // A prime turn ignores memos (and the `memos` field).
    const prime = await send('POST', `/docs/${DOC}/sessions/${session.id}/prime`, { slide: 2, memos: 'ignored' });
    assert.equal(prime.status, 200);
    await waitFor(() => stream.frames.filter((frame) => frame.event === 'qa').length >= 4, 5_000, 'a qa per turn');
    assert.equal(stream.frames.filter((frame) => frame.event === 'qa').length, 4);

    const deleted = await api(`/docs/${DOC}/sessions/${session.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    await waitFor(() => stream.frames.some((frame) => frame.data.type === 'qa' && frame.data.updatedAt === null), 5_000, 'qa on deletion');
    assert.deepEqual(stream.frames.filter((frame) => frame.event === 'qa').at(-1)?.data, { type: 'qa', sessionId: session.id, updatedAt: null });
    await stream.close();
  });

  test('text layout: pending until the backfill wrote it, then 200 with an ETag; never for documents the backfill cannot serve; 409 while processing', async () => {
    const pending = await api(`/docs/${PENDING}/text-layout/1`);
    const body = await expectError(pending, 404);
    assert.deepEqual([body.error, body.pending], [LAYOUT_PENDING, true]);
    await waitForBackfill();
    await fs.access(path.join(docPaths(PENDING).textDir, layoutFileName(1, PAGES)));
    const ready = await api(`/docs/${PENDING}/text-layout/1`);
    assert.equal(ready.status, 200);
    assert.match(ready.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(ready.headers.get('cache-control'), 'no-cache');
    assert.ok(ready.headers.get('etag'));
    const layout = await json<SlideTextLayout>(ready);
    assert.deepEqual([layout.version, layout.engine], [1, TEXT_ENGINE]);
    assert.deepEqual(layout.lines.map((line) => [line.dir, line.words.map((word) => word.t)]), [['h', ['Slide', '1']]]);
    // undici's fetch turns a conditional request into cache mode no-store and adds `Cache-Control: no-cache`, which
    // makes the server's freshness check refuse a 304 (as a browser's no-cache would): send an explicit max-age=0.
    const cached = await api(`/docs/${PENDING}/text-layout/1`, { headers: { 'If-None-Match': ready.headers.get('etag') ?? '', 'Cache-Control': 'max-age=0' } });
    assert.equal(cached.status, 304);

    const never = await expectError(await api(`/docs/${NO_PDF}/text-layout/1`), 404);
    assert.deepEqual([never.error, never.pending], [LAYOUT_NEVER, false]);
    const noPdf = await expectError(await api(`/docs/${OLD_TEXT}/text-layout/1`), 404);
    assert.deepEqual([noPdf.error, noPdf.pending], [LAYOUT_NEVER, false]);
    await expectError(await api(`/docs/${PROCESSING}/text-layout/1`), 409, /처리하는 중/);
    await expectError(await api(`/docs/${DOC}/text-layout/9`), 404, /슬라이드/);
    await expectError(await api(`/docs/${DOC}/text-layout/x`), 404, /슬라이드/);
    await expectError(await api(`/docs/no-such-deck-000000/text-layout/1`), 404, /문서/);
  });

  test('remote mode: every annotation route answers 401 without a session (the SSE stream included); the access code opens them', async () => {
    const remote = await startServer({ port: 0, log: false, resumeIngests: false, sweepAttachments: false, providerInfos: async () => [], host: '127.0.0.1', auth: 'on', password: 'annotation-test-code' });
    try {
      const d = `/api/docs/${DOC}`;
      const routes: Array<[string, string]> = [
        ['GET', '/api/annotations/tags'],
        ['GET', `${d}/annotations`],
        ['GET', `${d}/annotations/events`],
        ['GET', `${d}/annotations/1`],
        ['PUT', `${d}/annotations/1`],
        ['PATCH', `${d}/annotations/1`],
        ['GET', `${d}/text-layout/1`],
      ];
      for (const [method, target] of routes) {
        const res = await fetch(`${remote.url}${target}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'GET' ? undefined : JSON.stringify({ baseRev: 0, items: [], hiddenMarkers: [], ops: [] }),
        });
        assert.equal(res.status, 401, `${method} ${target}`);
        assert.doesNotMatch(res.headers.get('content-type') ?? '', /event-stream/);
        await res.arrayBuffer();
      }
      const ok = await fetch(`${remote.url}${d}/annotations`, { headers: { Authorization: 'Bearer annotation-test-code' } });
      assert.equal(ok.status, 200);
      await ok.arrayBuffer();
    } finally {
      await remote.close();
    }
  });

  test('deleting the document ends its stream', async () => {
    const stream = openSse(`${base}/api/docs/${GONE}/annotations/events`);
    await waitFor(() => stream.status === 200);
    await send('PATCH', `/docs/${GONE}/annotations/1`, { baseRev: 0, ops: [{ op: 'add', item: rectItem() }] });
    await waitFor(() => stream.frames.some((frame) => frame.event === 'slide'));
    const res = await api(`/docs/${GONE}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    await waitFor(() => stream.ended, 5_000, 'the stream ended');
    await expectError(await api(`/docs/${GONE}/annotations`), 404);
    await stream.close();
  });
});
