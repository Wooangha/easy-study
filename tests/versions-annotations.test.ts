// A new version of a lecture PDF (DESIGN §28) in the annotation store and the attachments: the slide files follow
// their slides (new numbers and padding, revs above every old one, memo links, 텍스트 형광 on changed slides), the
// 빠진 슬라이드 archive with its thumbnails (and its routes), the undo that restores it, idempotency and the resume of a
// half-done remap, memo links of other lectures, the swapping gate, the drain, the `deck` event, the counts of the
// plan, and region attachments moved to their slide (removedFrom, nearest kept slide, undo, the sweep leaving the
// deck mark alone). No HTTP server but a bare router; the image worker runs only for the region crop.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import sharp from 'sharp';
import type { AnnotationEvent, AnnotationItem, Attachment, MarkerKey, MemoItem, MemoLink, RemovedSlide, SlideAnnotations } from '../shared/types.ts';
import {
  annotationSubscribers,
  closeAnnotationStreams,
  configureAnnotations,
  drainAnnotations,
  flushAnnotationIndex,
  listRemovedSlides,
  patchSlideAnnotations,
  putSlideAnnotations,
  readSlideAnnotations,
  readSummary,
  remapAnnotationLinks,
  remapDocAnnotations,
  removedSlideCounts,
  sendDeckEvent,
  subscribeAnnotations,
} from '../server/annotations.ts';
import { createAnnotationsRouter } from '../server/annotationsRoutes.ts';
import { attachmentsDir, createRegionAttachment, readAttachment, remapRegionAttachments, sweepAttachments } from '../server/attachments.ts';
import { HttpError } from '../server/config.ts';
import { smsg } from '../server/i18n.ts';
import type { DeckMap } from '../server/internal-types.ts';
import { beginDocSwap, docPaths, endDocSwap, slideFileName } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import type { SseTarget } from '../server/recordings/events.ts';

/** 409 of every write while the deck is swapped (Korean: no request language here). */
const SWAPPING = smsg('ko').library.versions.swapping;

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-versions-annot-'));
  process.env.EASY_STUDY_LIBRARY = path.join(tmpRoot, 'library');
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
  await fs.mkdir(process.env.EASY_STUDY_LIBRARY);
});

after(async () => {
  await closeAnnotationStreams();
  configureAnnotations();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

afterEach(() => configureAnnotations());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function writeMeta(docId: string, pageCount: number, deckRev?: number): Promise<void> {
  const meta: StoredDocMeta = {
    id: docId,
    title: `Deck ${docId}`,
    fileName: `${docId}.pdf`,
    pageCount,
    aspectRatio: 16 / 9,
    status: 'ready',
    progress: pageCount,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...(deckRev ? { deckRev } : {}),
  };
  await fs.writeFile(docPaths(docId).docJson, JSON.stringify(meta));
}

async function makeDoc(docId: string, pageCount = 5): Promise<void> {
  await fs.mkdir(docPaths(docId).textDir, { recursive: true });
  await writeMeta(docId, pageCount);
}

/** A DeckMap like server/versions.ts builds it: `added` = the new slides nothing maps to. */
function deckMap(fromRev: number, oldToNew: (number | null)[], newPageCount: number, changed: number[] = [], restoreRev?: number): DeckMap {
  const kept = new Set(oldToNew.filter((n): n is number => n !== null));
  const added = new Set<number>();
  for (let n = 1; n <= newPageCount; n++) if (!kept.has(n)) added.add(n);
  return { fromRev, toRev: fromRev + 1, oldPageCount: oldToNew.length, newPageCount, oldToNew, changed: new Set(changed), added, ...(restoreRev !== undefined ? { restoreRev } : {}) };
}

let counter = 0;
const id = () => `an-${(++counter).toString(16).padStart(12, '0')}`;
const RECT = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
const CREATED = '2026-10-01T10:00:00.000Z';
const rectItem = (): Record<string, unknown> => ({ id: id(), type: 'rect', color: 'blue', createdAt: CREATED, rect: RECT });
const memoItem = (text: string, links: MemoLink[] = []): Record<string, unknown> => ({
  id: id(),
  type: 'memo',
  color: 'yellow',
  createdAt: CREATED,
  at: { x: 0.5, y: 0.5 },
  text,
  tags: [],
  collapsed: false,
  tutor: true,
  links,
});
const textHighlight = (): Record<string, unknown> => ({ id: id(), type: 'textHighlight', color: 'green', createdAt: CREATED, rects: [RECT], chars: [0, 5], engine: 'pdfium-3', text: 'hello' });
const key = (n: number): MarkerKey => ({ sessionId: `20261001-1000${String(n).padStart(2, '0')}-abcd`, messageId: `msg-${n}`, attachmentId: `att-${String(n).padStart(16, '0')}` });

async function put(docId: string, slide: number, items: Record<string, unknown>[], hiddenMarkers: MarkerKey[] = []): Promise<SlideAnnotations> {
  const current = await readSlideAnnotations(docId, slide);
  return putSlideAnnotations(docId, slide, { baseRev: current.rev, items, hiddenMarkers });
}

async function expectHttp(promise: Promise<unknown>, status: number, message?: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HttpError, `HttpError expected, got ${String(err)}`);
    assert.equal(err.status, status, err.message);
    if (message !== undefined) assert.equal(err.message, message);
    return;
  }
  throw new Error(`expected HttpError ${status}`);
}

/** Every file under a folder (relative path → content), for "nothing changed" checks. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = (await fs.readFile(file)).toString('base64');
  }
  return out;
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const memoOf = (doc: SlideAnnotations, memoId: unknown): MemoItem => doc.items.find((item): item is MemoItem => item.id === memoId && item.type === 'memo') as MemoItem;
const idsOf = (doc: SlideAnnotations) => doc.items.map((item) => item.id);

/** An SSE target that keeps what it was written. */
function fakeTarget() {
  const chunks: string[] = [];
  const target: SseTarget & { events: () => AnnotationEvent[]; ended: boolean } = {
    ended: false,
    writableEnded: false,
    destroyed: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      target.ended = true;
      (target as { writableEnded: boolean }).writableEnded = true;
    },
    events: () =>
      chunks
        .join('')
        .split('\n\n')
        .filter((frame) => frame.startsWith('event:'))
        .map((frame) => JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? 'null') as AnnotationEvent),
  };
  return target;
}

// ---------------------------------------------------------------------------

describe('remapDocAnnotations: apply, then undo', () => {
  const DOC = 'swap-deck-aaa111';
  const OTHER = 'other-deck-bbb222';
  const THUMB = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 old slide 2');
  let thumbFile = '';
  const items: Record<number, Record<string, unknown>[]> = {};
  // Old deck (5 slides) → new deck: 1→1, 2 dropped, 3→2 (changed), 4→4, 5→3 (moved up); new slide 5 added.
  const APPLY = deckMap(0, [1, null, 2, 4, 3], 5, [2]);
  // The undo: the inverse map from the plan (new slide 5 had no old counterpart), restoring rev 0's archive.
  const UNDO = deckMap(1, [1, 3, 5, 4, null], 5, [3], 0);

  before(async () => {
    await makeDoc(DOC);
    thumbFile = path.join(tmpRoot, 'old-thumb-002.webp');
    await fs.writeFile(thumbFile, THUMB);
    items[1] = [
      memoItem('여러 장을 잇는 메모', [
        { kind: 'slide', slide: 2 },
        { kind: 'slide', slide: 3 },
        { kind: 'doc', docId: DOC, slide: 2 },
        { kind: 'doc', docId: DOC, slide: 5 },
        { kind: 'doc', docId: OTHER, slide: 2 },
        { kind: 'recording', rid: 'rec-1', t: 3 },
      ]),
      textHighlight(),
    ];
    items[2] = [rectItem(), memoItem('빠지는 장의 메모')];
    items[3] = [textHighlight()];
    items[4] = [rectItem()];
    items[5] = [memoItem('위로 올라가는 장')];
    for (const slide of [1, 2, 3, 4, 5]) await put(DOC, slide, items[slide], slide === 3 ? [key(1)] : []);
    // Slide 4 is written three times: the highest old rev is 3.
    await put(DOC, 4, items[4]);
    await put(DOC, 4, items[4]);
    await flushAnnotationIndex(DOC);
  });

  test('the plan counts what sits on dropped slides (필기 other than memos, memos)', async () => {
    assert.deepEqual(await removedSlideCounts(DOC, [2]), { items: 1, memos: 1 });
    assert.deepEqual(await removedSlideCounts(DOC, [1, 2, 2, 9, 0]), { items: 2, memos: 2 });
    assert.deepEqual(await removedSlideCounts('nope-deck-000000', [1]), { items: 0, memos: 0 });
  });

  test('apply: files follow their slides, links follow, the dropped slide is archived with its thumbnail', async () => {
    const memoUpdatedAt = memoOf(await readSlideAnnotations(DOC, 5), items[5][0].id).updatedAt;
    await writeMeta(DOC, 5, 1); // the orchestrator writes doc.json first
    await remapDocAnnotations(DOC, APPLY, { oldThumb: (slide) => (slide === 2 ? thumbFile : path.join(tmpRoot, 'missing.webp')) });
    const dir = docPaths(DOC).annotationsDir;
    const names = (await fs.readdir(dir)).sort();
    assert.deepEqual(names, ['001.json', '002.json', '003.json', '004.json', 'deck.json', 'index.json', 'removed']);
    assert.deepEqual(await readJson(path.join(dir, 'deck.json')), { rev: 1 });

    const s1 = await readSlideAnnotations(DOC, 1);
    const s2 = await readSlideAnnotations(DOC, 2);
    const s3 = await readSlideAnnotations(DOC, 3);
    const s4 = await readSlideAnnotations(DOC, 4);
    for (const doc of [s1, s2, s3, s4]) assert.equal(doc.rev, 4, `slide ${doc.slide}: every rewritten file gets the highest old rev + 1`);
    assert.equal((await readSlideAnnotations(DOC, 5)).rev, 0);
    assert.deepEqual(idsOf(s1), items[1].map((item) => item.id));
    assert.deepEqual(idsOf(s2), items[3].map((item) => item.id));
    assert.deepEqual(idsOf(s3), items[5].map((item) => item.id));
    assert.deepEqual(idsOf(s4), items[4].map((item) => item.id));
    assert.deepEqual(s2.hiddenMarkers, [key(1)]);

    assert.deepEqual(memoOf(s1, items[1][0].id).links, [
      { kind: 'slide', slide: 2 },
      { kind: 'doc', docId: DOC },
      { kind: 'doc', docId: DOC, slide: 3 },
      { kind: 'doc', docId: OTHER, slide: 2 },
      { kind: 'recording', rid: 'rec-1', t: 3 },
    ]);
    const engineOf = (doc: SlideAnnotations) => (doc.items.find((item) => item.type === 'textHighlight') as Extract<AnnotationItem, { type: 'textHighlight' }>).engine;
    assert.equal(engineOf(s1), 'pdfium-3', 'an unchanged slide keeps its anchors');
    assert.equal(engineOf(s2), 'moved', 'a changed slide re-anchors by the text');
    assert.equal(memoOf(s3, items[5][0].id).updatedAt, memoUpdatedAt, 'moving a memo is not an edit of the student');

    const archive = path.join(dir, 'removed', 'r0');
    assert.deepEqual((await fs.readdir(archive)).sort(), ['002.json', '002.webp']);
    assert.deepEqual(await fs.readFile(path.join(archive, '002.webp')), THUMB);
    const archived = await readJson<SlideAnnotations & { removedAt: string }>(path.join(archive, '002.json'));
    assert.equal(archived.slide, 2);
    assert.deepEqual(idsOf(archived), items[2].map((item) => item.id));
    assert.ok(Number.isFinite(Date.parse(archived.removedAt)));

    const summary = await readSummary(DOC);
    assert.deepEqual(summary.slides.map((entry) => entry.slide), [1, 2, 3, 4]);
    assert.deepEqual(summary.memos.map((memo) => [memo.slide, memo.id]), [[1, items[1][0].id], [3, items[5][0].id]]);

    const removed = await listRemovedSlides(DOC);
    assert.equal(removed.length, 1);
    assert.deepEqual({ ...removed[0], items: removed[0].items.map((item) => item.id), removedAt: '' }, { rev: 0, slide: 2, removedAt: '', thumb: true, items: items[2].map((item) => item.id) });
    assert.equal(removed[0].removedAt, archived.removedAt);
  });

  test('a second run of the same remap changes nothing', async () => {
    const dir = docPaths(DOC).annotationsDir;
    const before = await snapshot(dir);
    await remapDocAnnotations(DOC, APPLY, { oldThumb: () => thumbFile });
    assert.deepEqual(await snapshot(dir), before);
  });

  test('undo: the archive goes back to its slides, links map back, what sat on the added slide is archived', async () => {
    const onAdded = memoItem('새 장에 쓴 메모');
    await put(DOC, 5, [onAdded]);
    await writeMeta(DOC, 5, 2);
    await remapDocAnnotations(DOC, UNDO);
    const dir = docPaths(DOC).annotationsDir;
    assert.deepEqual(await readJson(path.join(dir, 'deck.json')), { rev: 2 });
    assert.deepEqual((await fs.readdir(path.join(dir, 'removed'))).sort(), ['r1'], 'the restored archive is gone');

    const docs = await Promise.all([1, 2, 3, 4, 5].map((slide) => readSlideAnnotations(DOC, slide)));
    for (const slide of [1, 2, 3, 4, 5]) assert.deepEqual(idsOf(docs[slide - 1]), items[slide].map((item) => item.id), `slide ${slide}`);
    for (const doc of docs) assert.equal(doc.rev, 5, 'above every rev of the undone deck (4) and of the archive');
    assert.deepEqual(docs[2].hiddenMarkers, [key(1)]);
    assert.deepEqual(memoOf(docs[0], items[1][0].id).links, [
      { kind: 'slide', slide: 3 },
      { kind: 'doc', docId: DOC },
      { kind: 'doc', docId: DOC, slide: 5 },
      { kind: 'doc', docId: OTHER, slide: 2 },
      { kind: 'recording', rid: 'rec-1', t: 3 },
    ]);
    const restoredMemo = memoOf(docs[1], items[2][1].id);
    assert.equal(restoredMemo.text, '빠지는 장의 메모');
    assert.equal('removedAt' in docs[1], false);

    const removed: RemovedSlide[] = await listRemovedSlides(DOC);
    assert.deepEqual(removed.map((slide) => [slide.rev, slide.slide, slide.thumb, slide.items.map((item) => item.id)]), [[1, 5, false, [onAdded.id]]]);
    assert.deepEqual((await readSummary(DOC)).slides.map((entry) => entry.slide), [1, 2, 3, 4, 5]);
  });

  test('a lecture without annotations: nothing is made', async () => {
    const EMPTY = 'empty-deck-ccc333';
    await makeDoc(EMPTY);
    await remapDocAnnotations(EMPTY, APPLY);
    await assert.rejects(fs.access(docPaths(EMPTY).annotationsDir));
    assert.deepEqual(await listRemovedSlides(EMPTY), []);
    await assert.rejects(listRemovedSlides('nope-deck-000000'), (err: unknown) => err instanceof HttpError && err.status === 404);
  });
});

describe('remapDocAnnotations: padding, resume', () => {
  test('file names take the new deck padding', async () => {
    const DOC = 'pad-deck-ddd444';
    await makeDoc(DOC, 3);
    const ids = [];
    for (const slide of [1, 2, 3]) ids.push((await put(DOC, slide, [rectItem()])).items[0].id);
    await flushAnnotationIndex(DOC);
    await writeMeta(DOC, 1000, 1);
    await remapDocAnnotations(DOC, deckMap(0, [1, 2, 1000], 1000));
    const names = (await fs.readdir(docPaths(DOC).annotationsDir)).filter((name) => /^\d+\.json$/.test(name)).sort();
    assert.deepEqual(names, ['0001.json', '0002.json', '1000.json']);
    assert.deepEqual(idsOf(await readSlideAnnotations(DOC, 1000)), [ids[2]]);
    assert.deepEqual((await readSummary(DOC)).slides.map((entry) => entry.slide), [1, 2, 1000]);
  });

  test('a remap that stopped half-way resumes from its journal (the files are not renumbered twice)', async () => {
    const DOC = 'resume-deck-eee555';
    await makeDoc(DOC, 3);
    const ids = [];
    for (const slide of [1, 2, 3]) ids.push((await put(DOC, slide, [rectItem()])).items[0].id);
    await flushAnnotationIndex(DOC);
    const dir = docPaths(DOC).annotationsDir;
    // index.json as a folder: the remap fails after the slide files changed, before its mark.
    await fs.rm(path.join(dir, 'index.json'));
    await fs.mkdir(path.join(dir, 'index.json'));
    await fs.writeFile(path.join(dir, 'index.json', 'x'), '');
    const map = deckMap(0, [2, 3, 1], 3);
    await writeMeta(DOC, 3, 1);
    await assert.rejects(remapDocAnnotations(DOC, map));
    assert.ok((await fs.readdir(dir)).includes('deck-r1.json'), 'the journal stays');
    await assert.rejects(fs.access(path.join(dir, 'deck.json')));

    await fs.rm(path.join(dir, 'index.json'), { recursive: true });
    await remapDocAnnotations(DOC, map);
    assert.deepEqual(idsOf(await readSlideAnnotations(DOC, 1)), [ids[2]]);
    assert.deepEqual(idsOf(await readSlideAnnotations(DOC, 2)), [ids[0]]);
    assert.deepEqual(idsOf(await readSlideAnnotations(DOC, 3)), [ids[1]]);
    const names = await fs.readdir(dir);
    assert.ok(!names.includes('deck-r1.json'), 'the journal is removed');
    assert.deepEqual(await readJson(path.join(dir, 'deck.json')), { rev: 1 });
  });
});

describe('the swapping gate, the drain and the deck event', () => {
  const DOC = 'gate-deck-fff666';
  before(() => makeDoc(DOC, 3));

  test('writes are refused with 409 while the deck is swapped, also the ones queued before', async () => {
    const first = putSlideAnnotations(DOC, 1, { baseRev: 0, items: [rectItem()], hiddenMarkers: [] });
    const second = patchSlideAnnotations(DOC, 1, { baseRev: 1, ops: [{ op: 'add', item: rectItem() }] });
    beginDocSwap(DOC);
    try {
      await expectHttp(first, 409, SWAPPING);
      await expectHttp(second, 409, SWAPPING);
      await expectHttp(putSlideAnnotations(DOC, 2, { baseRev: 0, items: [], hiddenMarkers: [] }), 409, SWAPPING);
      await expectHttp(createRegionAttachment(DOC, { slide: 1, rect: RECT }), 409, SWAPPING);
      await drainAnnotations(DOC);
    } finally {
      endDocSwap(DOC);
    }
    assert.equal((await put(DOC, 2, [rectItem()])).rev, 1);
  });

  test('drainAnnotations waits for running writes and flushes the debounced index', async () => {
    configureAnnotations({ indexDebounceMs: 60_000 });
    let done = false;
    const write = putSlideAnnotations(DOC, 3, { baseRev: 0, items: [memoItem('드레인')], hiddenMarkers: [] }).then(() => {
      done = true;
    });
    await drainAnnotations(DOC);
    assert.equal(done, true);
    await write;
    const index = await readJson<{ slides: Array<{ slide: number }> }>(path.join(docPaths(DOC).annotationsDir, 'index.json'));
    assert.ok(index.slides.some((entry) => entry.slide === 3));
  });

  test('sendDeckEvent: the deck event, then the streams end; a new stream works', async () => {
    const first = fakeTarget();
    await subscribeAnnotations(DOC, first);
    assert.equal(annotationSubscribers(DOC), 1);
    sendDeckEvent(DOC, { rev: 1, kind: 'apply', oldToNew: [2, null, 1] });
    assert.deepEqual(first.events(), [{ type: 'deck', rev: 1, kind: 'apply', oldToNew: [2, null, 1] }]);
    assert.equal(first.ended, true);
    assert.equal(annotationSubscribers(DOC), 0);
    sendDeckEvent(DOC, { rev: 2, kind: 'undo', oldToNew: [] }); // nobody listens: nothing happens

    const second = fakeTarget();
    await subscribeAnnotations(DOC, second);
    await put(DOC, 1, [rectItem()]);
    assert.deepEqual(second.events().map((event) => event.type), ['slide-reset', 'summary']);
    assert.equal(second.ended, false);
  });
});

describe('remapAnnotationLinks: memos of other lectures', () => {
  const SWAPPED = 'linked-deck-aaa777';
  const OTHER = 'linking-deck-bbb888';
  const THIRD = 'third-deck-ccc999';
  const MAP = deckMap(0, [1, null, 2, 4, 3], 5);
  let linking: Record<string, unknown>;
  let far: Record<string, unknown>;

  before(async () => {
    await makeDoc(SWAPPED);
    await makeDoc(OTHER, 3);
    linking = memoItem('다른 강의를 가리킴', [
      { kind: 'doc', docId: SWAPPED, slide: 3 },
      { kind: 'doc', docId: SWAPPED, slide: 2 },
      { kind: 'doc', docId: SWAPPED },
      { kind: 'doc', docId: THIRD, slide: 2 },
      { kind: 'slide', slide: 3 },
    ]);
    far = memoItem('끝 장', [{ kind: 'doc', docId: SWAPPED, slide: 4 }]);
    await put(OTHER, 1, [linking, rectItem()]);
    await put(OTHER, 2, [far]);
    await flushAnnotationIndex(OTHER);
  });

  test('links into the swapped lecture follow (slide dropped with a dropped slide), as writes with events', async () => {
    const target = fakeTarget();
    await subscribeAnnotations(OTHER, target);
    const before1 = await readSlideAnnotations(OTHER, 1);
    await remapAnnotationLinks(SWAPPED, MAP);
    const after1 = await readSlideAnnotations(OTHER, 1);
    assert.equal(after1.rev, before1.rev + 1);
    const memo = memoOf(after1, linking.id);
    assert.deepEqual(memo.links, [
      { kind: 'doc', docId: SWAPPED, slide: 2 },
      { kind: 'doc', docId: SWAPPED },
      { kind: 'doc', docId: SWAPPED },
      { kind: 'doc', docId: THIRD, slide: 2 },
      { kind: 'slide', slide: 3 },
    ]);
    assert.equal(memo.updatedAt, memoOf(before1, linking.id).updatedAt, 'not an edit of the student');
    const after2 = await readSlideAnnotations(OTHER, 2);
    assert.equal(after2.rev, 1, 'slide 4 stays slide 4: nothing written');
    const events = target.events();
    assert.deepEqual(events.map((event) => event.type), ['slide', 'summary']);
    const event = events[0] as Extract<AnnotationEvent, { type: 'slide' }>;
    assert.equal(event.slide, 1);
    assert.equal(event.rev, after1.rev);
    assert.deepEqual(event.ops, [{ op: 'update', id: linking.id, patch: { links: memo.links } }]);
    const summary = await readSummary(OTHER);
    assert.deepEqual(summary.memos.find((entry) => entry.id === linking.id)?.links, memo.links);
    assert.deepEqual(await readJson(path.join(docPaths(SWAPPED).annotationsDir, 'links.json')), { rev: 1, done: true, docs: {} });
  });

  test('idempotent: a second run, and a resumed journal whose changes were applied, change nothing', async () => {
    const before = await readSlideAnnotations(OTHER, 1);
    await remapAnnotationLinks(SWAPPED, MAP);
    assert.equal((await readSlideAnnotations(OTHER, 1)).rev, before.rev);
    // As if the server stopped after applying, before marking the journal done.
    const memo = memoOf(before, linking.id);
    await fs.writeFile(
      path.join(docPaths(SWAPPED).annotationsDir, 'links.json'),
      JSON.stringify({ rev: 1, done: false, docs: { [OTHER]: { [String(linking.id)]: { from: linking.links, to: memo.links } } } }),
    );
    await remapAnnotationLinks(SWAPPED, MAP);
    const after = await readSlideAnnotations(OTHER, 1);
    assert.equal(after.rev, before.rev);
    assert.deepEqual(memoOf(after, linking.id).links, memo.links);
  });

  test('a later swap maps them again (another rev)', async () => {
    await remapAnnotationLinks(SWAPPED, deckMap(1, [2, 1, 3, 4, 5], 5));
    assert.deepEqual(memoOf(await readSlideAnnotations(OTHER, 1), linking.id).links[0], { kind: 'doc', docId: SWAPPED, slide: 1 });
  });
});

describe('remapRegionAttachments', () => {
  const DOC = 'region-deck-ddd000';
  const att = (n: number) => `att-${String(n).padStart(16, '0')}`;

  async function writeAttachment(docId: string, attachment: Attachment): Promise<void> {
    await fs.mkdir(attachmentsDir(docId), { recursive: true });
    await fs.writeFile(path.join(attachmentsDir(docId), `${attachment.id}.json`), JSON.stringify(attachment));
    await fs.writeFile(path.join(attachmentsDir(docId), `${attachment.id}.jpg`), 'jpeg');
  }
  const region = (n: number, slide: number): Attachment => ({ id: att(n), kind: 'region', slide, rect: RECT, width: 10, height: 10, text: '', createdAt: CREATED });

  before(async () => {
    await makeDoc(DOC);
    for (const [n, slide] of [[1, 1], [2, 2], [3, 3], [4, 5]]) await writeAttachment(DOC, region(n, slide));
    await writeAttachment(DOC, { id: att(9), kind: 'image', name: 'photo.png', width: 10, height: 10, createdAt: CREATED });
  });

  const slideOf = async (n: number) => {
    const attachment = await readAttachment(DOC, att(n));
    return { slide: attachment?.slide, removedFrom: attachment?.removedFrom };
  };

  test('apply: slides follow; a dropped slide → the nearest kept one with removedFrom; idempotent', async () => {
    const map = deckMap(0, [1, null, 2, 4, 3], 5);
    await remapRegionAttachments(DOC, map);
    assert.deepEqual(await slideOf(1), { slide: 1, removedFrom: undefined });
    assert.deepEqual(await slideOf(2), { slide: 1, removedFrom: { rev: 0, slide: 2 } });
    assert.deepEqual(await slideOf(3), { slide: 2, removedFrom: undefined });
    assert.deepEqual(await slideOf(4), { slide: 3, removedFrom: undefined });
    assert.equal((await readAttachment(DOC, att(9)))?.name, 'photo.png');
    assert.deepEqual(await readJson(path.join(attachmentsDir(DOC), 'deck.json')), { rev: 1 });
    const before = await snapshot(attachmentsDir(DOC));
    await remapRegionAttachments(DOC, map);
    assert.deepEqual(await snapshot(attachmentsDir(DOC)), before);
  });

  test('undo: what the apply moved off its dropped slide goes back, the flag removed', async () => {
    await remapRegionAttachments(DOC, deckMap(1, [1, 3, 5, 4, null], 5, [], 0));
    assert.deepEqual(await slideOf(1), { slide: 1, removedFrom: undefined });
    assert.deepEqual(await slideOf(2), { slide: 2, removedFrom: undefined });
    assert.deepEqual(await slideOf(3), { slide: 3, removedFrom: undefined });
    assert.deepEqual(await slideOf(4), { slide: 5, removedFrom: undefined });
    assert.deepEqual(await readJson(path.join(attachmentsDir(DOC), 'deck.json')), { rev: 2 });
  });

  test('no kept slide before → the closest following; none at all → 1', async () => {
    const EDGE = 'edge-deck-eee000';
    await makeDoc(EDGE, 4);
    await writeAttachment(EDGE, { ...region(1, 1) });
    await writeAttachment(EDGE, { ...region(2, 4) });
    await remapRegionAttachments(EDGE, deckMap(0, [null, 2, 1, null], 2));
    assert.deepEqual((await readAttachment(EDGE, att(1)))?.slide, 2);
    assert.deepEqual((await readAttachment(EDGE, att(1)))?.removedFrom, { rev: 0, slide: 1 });
    assert.deepEqual((await readAttachment(EDGE, att(2)))?.slide, 1);
    await remapRegionAttachments(EDGE, deckMap(1, [null, null], 1));
    assert.deepEqual(await readAttachment(EDGE, att(1)).then((a) => [a?.slide, a?.removedFrom]), [1, { rev: 1, slide: 2 }]);
  });

  test('the 24 h sweep leaves the deck mark alone', async () => {
    const ids = new Set([1, 2, 3, 4, 9].map(att));
    await sweepAttachments(async () => ids, { now: Date.now() + 48 * 60 * 60 * 1000 });
    await fs.access(path.join(attachmentsDir(DOC), 'deck.json'));
    assert.equal((await readAttachment(DOC, att(2)))?.slide, 2);
  });

  test('a region cropped while the swap began is not saved (409, nothing left)', async () => {
    const CROP = 'crop-deck-fff000';
    await makeDoc(CROP, 2);
    await fs.mkdir(docPaths(CROP).slidesDir, { recursive: true });
    const png = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#ffffff' } }).png().toBuffer();
    for (const slide of [1, 2]) await fs.writeFile(path.join(docPaths(CROP).slidesDir, slideFileName(slide, 2)), png);
    const pending = createRegionAttachment(CROP, { slide: 1, rect: RECT });
    beginDocSwap(CROP);
    try {
      await expectHttp(pending, 409, SWAPPING);
    } finally {
      endDocSwap(CROP);
    }
    assert.deepEqual(await fs.readdir(attachmentsDir(CROP)), []);
  });
});

describe('the 빠진 슬라이드 routes', () => {
  const DOC = 'route-deck-aaa000';
  const THUMB = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 route thumb');
  let base = '';
  let close: () => Promise<void> = async () => {};
  let memoId = '';

  before(async () => {
    await makeDoc(DOC, 3);
    memoId = String((await put(DOC, 2, [memoItem('빠진 장')])).items[0].id);
    await put(DOC, 3, [rectItem()]);
    await flushAnnotationIndex(DOC);
    const thumb = path.join(tmpRoot, 'route-thumb.webp');
    await fs.writeFile(thumb, THUMB);
    await writeMeta(DOC, 2, 1);
    await remapDocAnnotations(DOC, deckMap(0, [1, null, 2], 2), { oldThumb: () => thumb });

    const app = express();
    app.use(express.json());
    app.use('/api', createAnnotationsRouter());
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err instanceof HttpError ? err.status : 500).json({ error: err instanceof Error ? err.message : String(err) });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/docs/${DOC}/annotations`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  after(() => close());

  test('GET …/removed lists the archive (no-cache JSON); unknown lectures are 404', async () => {
    const res = await fetch(`${base}/removed`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const body = (await res.json()) as RemovedSlide[];
    assert.deepEqual(body.map((slide) => [slide.rev, slide.slide, slide.thumb, slide.items.map((item) => item.id)]), [[0, 2, true, [memoId]]]);
    assert.equal((await fetch(base.replace(DOC, 'nope-deck-000000') + '/removed')).status, 404);
    // The slide route is not shadowed.
    assert.equal(((await (await fetch(`${base}/2`)).json()) as SlideAnnotations).items.length, 1);
  });

  test('GET …/removed/:rev/:file serves the thumbnail; any other name is 404', async () => {
    for (const file of ['2.webp', '002.webp']) {
      const res = await fetch(`${base}/removed/0/${file}`);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), THUMB);
    }
    for (const suffix of ['0/3.webp', '1/2.webp', 'r0/2.webp', '0/2.json', '0/002.json', '0/..%2F..%2F001.json', '0/2.webp.json']) {
      const res = await fetch(`${base}/removed/${suffix}`);
      assert.equal(res.status, 404, suffix);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    }
  });
});
