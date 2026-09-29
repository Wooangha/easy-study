// The slide annotation store (server/annotations.ts, DESIGN §25): the validation table (whitelists per item type,
// caps, the byte cap), the rev / 409 with `current`, every PATCH op, `recordedAt` (format, round3, the live-recording
// fallback), the index (update, coalescing, rebuild, the failed-rebuild cache), the library-wide tags, the SSE hub
// (ops of a PATCH, the document after a PUT, summary / qa, the writer's own client id) and memosForTutor. No HTTP here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { MAX_ANNOTATION_ITEMS, MAX_HIDDEN_MARKERS, MAX_MEMO_TAGS, MAX_SLIDE_ANNOTATION_BYTES, MAX_TEXT_SIZE_PT, MIN_TEXT_SIZE_PT, SLIDE_PT_HEIGHT } from '../shared/types.ts';
import type { AnnotationEvent, AnnotationItem, AnnotationOp, MarkerKey, MemoItem, SlideAnnotations } from '../shared/types.ts';
import {
  ANNOTATIONS_TOO_LARGE,
  ANNOTATION_CONFLICT,
  annotationBytes,
  annotationSubscribers,
  closeAnnotationStreams,
  configureAnnotations,
  flushAnnotationIndex,
  forgetDocAnnotations,
  listAnnotationTags,
  memoSummaryText,
  memosForTutor,
  normalizeTag,
  patchSlideAnnotations,
  putSlideAnnotations,
  readSlideAnnotations,
  readSummary,
  rebuildIndex,
  subscribeAnnotations,
} from '../server/annotations.ts';
import { HttpError } from '../server/config.ts';
import { docPaths } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import type { SseTarget } from '../server/recordings/events.ts';
import { notifySessionsChanged } from '../server/sessions.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-annot-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
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

async function makeDoc(docId: string, pageCount = 5): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.textDir, { recursive: true });
  const meta: StoredDocMeta = { id: docId, title: `Deck ${docId}`, fileName: `${docId}.pdf`, pageCount, aspectRatio: 16 / 9, status: 'ready', progress: pageCount, createdAt: new Date().toISOString() };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
}

let counter = 0;
const id = () => `an-${(++counter).toString(16).padStart(12, '0')}`;
const RECT = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
const rectItem = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: id(), type: 'rect', color: 'blue', createdAt: '2026-09-29T10:00:00.000Z', rect: RECT, ...extra });
const memoItem = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(),
  type: 'memo',
  color: 'yellow',
  createdAt: '2026-09-29T10:00:00.000Z',
  at: { x: 0.5, y: 0.5 },
  text: '메모',
  tags: ['시험'],
  collapsed: false,
  tutor: true,
  links: [],
  ...extra,
});
const key = (n: number): MarkerKey => ({ sessionId: `20260929-1000${String(n).padStart(2, '0')}-abcd`, messageId: `msg-${n}`, attachmentId: `att-${String(n).padStart(16, '0')}` });

const add = (item: unknown): AnnotationOp => ({ op: 'add', item: item as AnnotationItem });
const patch = (docId: string, slide: number, baseRev: number, ops: unknown[], client?: string) =>
  patchSlideAnnotations(docId, slide, { baseRev, ops }, client);

async function expectHttp(promise: Promise<unknown>, status: number, pattern?: RegExp): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HttpError, `HttpError expected, got ${String(err)}`);
    assert.equal(err.status, status, err.message);
    if (pattern) assert.match(err.message, pattern);
    return err;
  }
  throw new Error(`expected HttpError ${status}`);
}

/** An SSE target that keeps what it was written. */
function fakeTarget() {
  const chunks: string[] = [];
  const target: SseTarget & { chunks: string[]; events: () => AnnotationEvent[]; ended: boolean } = {
    chunks,
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

describe('reading', () => {
  const DOC = 'read-deck-aaa111';
  before(() => makeDoc(DOC));

  test('a slide without a file is the empty document (rev 0); unknown documents and slides are 404', async () => {
    const doc = await readSlideAnnotations(DOC, 3);
    assert.deepEqual({ ...doc, updatedAt: '' }, { version: 1, slide: 3, rev: 0, updatedAt: '', items: [], hiddenMarkers: [] });
    assert.ok(Number.isFinite(Date.parse(doc.updatedAt)));
    await expectHttp(readSlideAnnotations('nope-deck-000000', 1), 404, /문서/);
    await expectHttp(readSlideAnnotations(DOC, 0), 404, /슬라이드/);
    await expectHttp(readSlideAnnotations(DOC, 6), 404, /슬라이드/);
    await expectHttp(readSlideAnnotations(DOC, 1.5), 404);
  });

  test('a document that never had annotations (an older library): empty summary and tags, nothing written', async () => {
    assert.deepEqual(await readSummary(DOC), { version: 1, slides: [], memos: [], tags: [] });
    assert.deepEqual(await memosForTutor(DOC, [1, 2, 3]), []);
    await assert.rejects(fs.access(docPaths(DOC).annotationsDir), 'no annotations folder is made by reads');
  });

  test('a malformed file counts as empty; a file with one bad entry keeps the others', async () => {
    const dir = docPaths(DOC).annotationsDir;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '001.json'), '{"version": 2}');
    assert.equal((await readSlideAnnotations(DOC, 1)).rev, 0);
    const good = rectItem();
    await fs.writeFile(path.join(dir, '002.json'), JSON.stringify({ version: 1, slide: 2, rev: 4, updatedAt: 'x', items: [good, { id: 'bad' }, { ...rectItem(), rect: { x: 2, y: 2, w: 1, h: 1 } }], hiddenMarkers: [key(1), { sessionId: 'x' }] }));
    const doc = await readSlideAnnotations(DOC, 2);
    assert.equal(doc.rev, 4);
    assert.deepEqual(doc.items.map((item) => item.id), [good.id]);
    assert.deepEqual(doc.hiddenMarkers, [key(1)]);
    // The file of another padding (a re-ingest that crossed 999 pages) is found too.
    await fs.writeFile(path.join(dir, '3.json'), JSON.stringify({ version: 1, slide: 3, rev: 1, updatedAt: 'x', items: [rectItem()], hiddenMarkers: [] }));
    assert.equal((await readSlideAnnotations(DOC, 3)).items.length, 1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('validation (400 with a snippet)', () => {
  const DOC = 'valid-deck-bbb222';
  before(() => makeDoc(DOC));

  const cases: Array<[string, unknown, RegExp]> = [
    ['unknown type', { ...rectItem(), type: 'star' }, /알 수 없는 필기 종류/],
    ['bad id', rectItem({ id: 'an-xyz' }), /필기 id/],
    ['bad color', rectItem({ color: 'red' }), /필기 색/],
    ['rect without size', rectItem({ rect: { x: 0.1, y: 0.1, w: 0, h: 0.1 } }), /넓이/],
    ['rect outside the image', rectItem({ rect: { x: 1.2, y: 0.1, w: 0.1, h: 0.1 } }), /넓이/],
    ['rect with NaN', rectItem({ rect: { x: 0.1, y: 0.1, w: Number.NaN, h: 0.1 } }), /rect/],
    ['text box without text', { ...rectItem(), type: 'text' }, /text/],
    ['text too long', { ...rectItem(), type: 'text', text: 'a'.repeat(2001) }, /너무 깁니다/],
    ['text box with a size that is not a number', { ...rectItem(), type: 'text', text: 'a', size: 'big' }, /글자 크기/],
    ['text box with an infinite size', { ...rectItem(), type: 'text', text: 'a', size: Number.POSITIVE_INFINITY }, /글자 크기/],
    ['text box with an unknown font', { ...rectItem(), type: 'text', text: 'a', font: 'comic' }, /글꼴/],
    ['text box with a bold that is not a boolean', { ...rectItem(), type: 'text', text: 'a', bold: 'yes' }, /bold/],
    ['memo with a size that is not a number', memoItem({ size: '12pt' }), /글자 크기/],
    ['memo without a position', memoItem({ at: { x: 'a' } }), /at/],
    ['memo with too many tags', memoItem({ tags: Array.from({ length: MAX_MEMO_TAGS + 1 }, (_, i) => `t${i}`) }), /태그는 메모마다/],
    ['memo with a long tag', memoItem({ tags: ['a'.repeat(31)] }), /태그가 너무/],
    ['memo with tags that are not strings', memoItem({ tags: [1] }), /tags/],
    ['memo with too many links', memoItem({ links: Array.from({ length: 9 }, () => ({ kind: 'slide', slide: 1 })) }), /연결은 메모마다/],
    ['memo linking a slide past the deck', memoItem({ links: [{ kind: 'slide', slide: 6 }] }), /슬라이드 번호/],
    ['memo linking a bad document id', memoItem({ links: [{ kind: 'doc', docId: 'Bad Id!' }] }), /강의 id/],
    ['memo linking a bad recording', memoItem({ links: [{ kind: 'recording', rid: 'Not An Id!', t: 1 }] }), /녹음 시점/],
    ['memo linking a negative time', memoItem({ links: [{ kind: 'recording', rid: '20260929-100000-abcd', t: -1 }] }), /녹음 시점/],
    ['memo with a bad tutor flag', memoItem({ tutor: 'yes' }), /tutor/],
    ['recordedAt with a bad rid', rectItem({ recordedAt: { rid: 'Not An Id!', t: 1 } }), /recordedAt/],
    ['recordedAt with a negative time', rectItem({ recordedAt: { rid: '20260929-100000-abcd', t: -0.5 } }), /recordedAt/],
    ['text highlight without rects', { ...rectItem(), type: 'textHighlight', rects: [], chars: [0, 3], engine: 'pdfium-3', text: 'abc' }, /rects/],
    ['text highlight with too many rects', { ...rectItem(), type: 'textHighlight', rects: Array.from({ length: 201 }, () => RECT), chars: [0, 3], engine: 'pdfium-3', text: 'abc' }, /최대 200줄/],
    ['text highlight with a reversed char range', { ...rectItem(), type: 'textHighlight', rects: [RECT], chars: [3, 3], engine: 'pdfium-3', text: 'abc' }, /chars/],
    ['text highlight without an engine', { ...rectItem(), type: 'textHighlight', rects: [RECT], chars: [0, 3], engine: '', text: 'abc' }, /engine/],
    ['not an object', 'rect', /필기 항목/],
  ];
  for (const [name, item, pattern] of cases) {
    test(`add: ${name}`, async () => {
      const err = await expectHttp(patch(DOC, 1, 0, [add(item)]), 400, pattern);
      assert.ok(err.message.length <= 200, 'the snippet is short');
    });
  }

  test('bad ops and bad requests', async () => {
    await expectHttp(patch(DOC, 1, 0, [{ op: 'explode' }]), 400, /알 수 없는 필기 작업/);
    await expectHttp(patch(DOC, 1, 0, [{ op: 'update', id: 5, patch: {} }]), 400, /id/);
    await expectHttp(patch(DOC, 1, 0, [{ op: 'remove', id: 'nope' }]), 400, /id/);
    await expectHttp(patch(DOC, 1, 0, [{ op: 'hideMarker', key: { sessionId: 'x' } }]), 400, /질문 표시 키/);
    await expectHttp(patch(DOC, 1, 0, ['add']), 400, /필기 작업/);
    await expectHttp(patch(DOC, 1, 0, []), 400, /ops/);
    await expectHttp(patch(DOC, 1, 0, Array.from({ length: 101 }, () => add(rectItem()))), 400, /최대 100개/);
    await expectHttp(patchSlideAnnotations(DOC, 1, { ops: [add(rectItem())] }), 400, /baseRev/);
    await expectHttp(patchSlideAnnotations(DOC, 1, 'nope'), 400, /요청 본문/);
    await expectHttp(putSlideAnnotations(DOC, 1, { baseRev: 0, items: 'x', hiddenMarkers: [] }), 400, /items/);
    await expectHttp(putSlideAnnotations(DOC, 1, { baseRev: 0, items: [rectItem(), rectItem({ id: 'an-000000000001' }), rectItem({ id: 'an-000000000001' })], hiddenMarkers: [] }), 400, /겹칩니다/);
    await expectHttp(putSlideAnnotations(DOC, 1, { baseRev: 0, items: [], hiddenMarkers: 'x' }), 400, /hiddenMarkers/);
    await expectHttp(putSlideAnnotations(DOC, 1, { baseRev: 0, items: [], hiddenMarkers: Array.from({ length: MAX_HIDDEN_MARKERS + 1 }, (_, i) => key(i)) }), 400, /최대 500개/);
    await expectHttp(putSlideAnnotations(DOC, 1, { baseRev: 0, items: Array.from({ length: MAX_ANNOTATION_ITEMS + 1 }, () => rectItem()), hiddenMarkers: [] }), 400, /최대 200개/);
    assert.equal((await readSlideAnnotations(DOC, 1)).rev, 0, 'nothing was written');
  });

  test('the byte cap: a document whose JSON would exceed 256 KB is refused', async () => {
    const items = Array.from({ length: 150 }, () => memoItem({ text: '가'.repeat(2000) }));
    const err = await expectHttp(putSlideAnnotations(DOC, 2, { baseRev: 0, items, hiddenMarkers: [] }), 400);
    assert.equal(err.message, ANNOTATIONS_TOO_LARGE);
    const ok = await putSlideAnnotations(DOC, 2, { baseRev: 0, items: items.slice(0, 20), hiddenMarkers: [] });
    assert.ok(annotationBytes(ok) < MAX_SLIDE_ANNOTATION_BYTES);
    await expectHttp(patch(DOC, 2, 1, items.slice(20, 150).map(add).slice(0, 100)), 400, /너무 많아요/);
  });

  test('normalisation: coordinates clamped and rounded, tags cleaned, defaults, client stamps replaced, unknown fields dropped', async () => {
    const doc = await patch(DOC, 3, 0, [
      add(rectItem({ rect: { x: -0.00004, y: 0.123456, w: 0.5, h: 1.5 }, updatedAt: '2000-01-01T00:00:00.000Z', createdAt: 'not a date', extra: 1 })),
      add(memoItem({ at: { x: 1.7, y: 0.00005 }, tags: [' #시험 ', '시험', '두  단어', '#', '', 'a', '\u0001제\t어\u202e'], collapsed: undefined, tutor: undefined, links: undefined, recordedAt: { rid: '20260929-100000-abcd', t: 12.34567 } })),
    ]);
    const [rect, memo] = doc.items as [AnnotationItem, MemoItem];
    assert.equal(rect.type, 'rect');
    if (rect.type === 'rect') assert.deepEqual(rect.rect, { x: 0, y: 0.1235, w: 0.5, h: 0.8765 });
    assert.ok(!('extra' in rect));
    assert.equal(rect.updatedAt, doc.updatedAt, 'the server stamps updatedAt');
    assert.equal(rect.createdAt, doc.updatedAt, 'an invalid createdAt becomes now');
    assert.deepEqual(memo.at, { x: 1, y: 0.0001 });
    assert.deepEqual(memo.tags, ['시험', '두 단어', 'a', '제 어'], 'control and bidi characters leave a tag; a tab becomes a space');
    assert.deepEqual([memo.collapsed, memo.tutor, memo.links], [false, true, []]);
    assert.deepEqual(memo.recordedAt, { rid: '20260929-100000-abcd', t: 12.346 });
    assert.equal(memo.createdAt, '2026-09-29T10:00:00.000Z', 'a valid createdAt is kept');
    assert.equal(normalizeTag('  # 태그  이름 '), '태그 이름');
    assert.equal(normalizeTag('##'), '');
    assert.equal(normalizeTag('#a\u0001b\u007f\u202ec\u200f'), 'abc');
    assert.equal(normalizeTag('\u0000\u202a'), '');
  });

  test('text size / font / bold (0.6.2): absent stays absent, a size is capped to 8–72 pt of a 540 pt slide and rounded, a rect never carries them', async () => {
    const min = MIN_TEXT_SIZE_PT / SLIDE_PT_HEIGHT;
    const max = MAX_TEXT_SIZE_PT / SLIDE_PT_HEIGHT;
    const doc = await patch(DOC, 4, 0, [
      add({ ...rectItem(), type: 'text', text: '기본' }),
      add({ ...rectItem(), type: 'text', text: '큰', size: 5, font: 'serif', bold: true }),
      add({ ...rectItem(), type: 'text', text: '작은', size: 0.0001, font: 'mono', bold: false }),
      add({ ...rectItem(), type: 'text', text: '24pt', size: 24 / SLIDE_PT_HEIGHT, font: 'sans', bold: null }),
      add(memoItem({ size: 1 })),
      add(memoItem({ size: 12.345678 / SLIDE_PT_HEIGHT })),
      add(rectItem({ size: 0.05, font: 'serif', bold: true })),
    ]);
    const [plain, big, small, mid, memoBig, memoMid, rect] = doc.items as [AnnotationItem, AnnotationItem, AnnotationItem, AnnotationItem, MemoItem, MemoItem, AnnotationItem];
    assert.ok(plain.type === 'text' && !('size' in plain) && !('font' in plain) && !('bold' in plain), 'nothing is added to an item without the fields');
    assert.ok(big.type === 'text');
    if (big.type === 'text') assert.deepEqual([big.size, big.font, big.bold], [Math.round(max * 1e4) / 1e4, 'serif', true]);
    if (small.type === 'text') assert.deepEqual([small.size, small.font, small.bold], [Math.round(min * 1e4) / 1e4, 'mono', false]);
    if (mid.type === 'text') assert.deepEqual([mid.size, mid.font, 'bold' in mid], [Math.round((24 / SLIDE_PT_HEIGHT) * 1e4) / 1e4, 'sans', false]);
    assert.equal(memoBig.size, Math.round(max * 1e4) / 1e4);
    assert.equal(memoMid.size, Math.round((12.345678 / SLIDE_PT_HEIGHT) * 1e4) / 1e4);
    assert.ok(!('size' in rect) && !('font' in rect) && !('bold' in rect), 'a rect keeps its whitelist');
    // An update takes the fields for a text box and a memo only.
    const updated = await patch(DOC, 4, doc.rev, [
      { op: 'update', id: plain.id, patch: { size: 0.05, font: 'mono', bold: true } },
      { op: 'update', id: memoMid.id, patch: { size: 0.04 } },
    ]);
    const after = updated.items.find((it) => it.id === plain.id);
    if (after?.type === 'text') assert.deepEqual([after.size, after.font, after.bold], [0.05, 'mono', true]);
    assert.equal((updated.items.find((it) => it.id === memoMid.id) as MemoItem).size, 0.04);
    await expectHttp(patch(DOC, 4, updated.rev, [{ op: 'update', id: rect.id, patch: { size: 0.05 } }]), 400, /이 필기에 없는 항목입니다: size/);
    await expectHttp(patch(DOC, 4, updated.rev, [{ op: 'update', id: memoMid.id, patch: { font: 'serif' } }]), 400, /이 필기에 없는 항목입니다: font/);
    await expectHttp(patch(DOC, 4, updated.rev, [{ op: 'update', id: plain.id, patch: { font: 'wingdings' } }]), 400, /글꼴/);
    // null removes an optional field (the undo of setting it), and the applied op echoes null to the other clients.
    const target = fakeTarget();
    const unsubscribe = await subscribeAnnotations(DOC, target, 'other-client-1');
    const removed = await patch(DOC, 4, updated.rev, [{ op: 'update', id: plain.id, patch: { size: null, bold: null } }], 'writer-client-1');
    const cleared = removed.items.find((it) => it.id === plain.id);
    assert.ok(cleared?.type === 'text' && !('size' in cleared) && !('bold' in cleared) && cleared.font === 'mono');
    const event = target.events().find((e) => e.type === 'slide');
    assert.ok(event && event.type === 'slide');
    if (event && event.type === 'slide') {
      const op = event.ops[0];
      assert.ok(op.op === 'update');
      if (op.op === 'update') assert.deepEqual({ ...op.patch, updatedAt: undefined }, { size: null, bold: null, updatedAt: undefined });
    }
    unsubscribe();
    await expectHttp(patch(DOC, 4, removed.rev, [{ op: 'update', id: plain.id, patch: { color: null } }]), 400, /필기 색/);
    // An old file (no fields) reads back unchanged: the stored document is what was written.
    const stored = await readSlideAnnotations(DOC, 4);
    assert.equal(stored.rev, removed.rev);
    assert.ok(stored.items.some((it) => it.type === 'text' && !('size' in it)));
  });
});

describe('revisions and the PATCH ops', () => {
  const DOC = 'ops-deck-ccc333';
  before(() => makeDoc(DOC));

  test('a stale baseRev is 409 with the current document; the rev grows by one per accepted write', async () => {
    const first = await patch(DOC, 1, 0, [add(rectItem())]);
    assert.equal(first.rev, 1);
    const err = await expectHttp(patch(DOC, 1, 0, [add(rectItem())]), 409);
    assert.equal(err.message, ANNOTATION_CONFLICT);
    assert.deepEqual(err.fields?.current, first);
    const second = await patch(DOC, 1, 1, [add(rectItem())]);
    assert.equal(second.rev, 2);
    assert.equal(second.items.length, 2);
    assert.deepEqual(await readSlideAnnotations(DOC, 1), second);
    // The file is the padded name.
    assert.ok((await fs.readdir(docPaths(DOC).annotationsDir)).includes('001.json'));
  });

  test('add refuses a duplicate id (409 + current); update a missing id (409); remove is idempotent', async () => {
    const item = rectItem();
    const doc = await patch(DOC, 2, 0, [add(item)]);
    const dup = await expectHttp(patch(DOC, 2, 1, [add({ ...item, color: 'pink' })]), 409);
    assert.deepEqual(dup.fields?.current, doc);
    const missing = await expectHttp(patch(DOC, 2, 1, [{ op: 'update', id: 'an-ffffffffffff', patch: { color: 'pink' } }]), 409);
    assert.deepEqual(missing.fields?.current, doc);
    const removed = await patch(DOC, 2, 1, [{ op: 'remove', id: 'an-ffffffffffff' }, { op: 'remove', id: item.id }, { op: 'remove', id: item.id }]);
    assert.deepEqual([removed.rev, removed.items], [2, []]);
  });

  test('update: only the fields of the type, normalised; id / type / createdAt / recordedAt never change; updatedAt is stamped', async () => {
    const created = memoItem({ text: 'before', recordedAt: { rid: '20260929-100000-abcd', t: 3 } });
    const doc = await patch(DOC, 3, 0, [add(created)]);
    const memo = doc.items[0] as MemoItem;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await patch(DOC, 3, 1, [
      { op: 'update', id: memo.id, patch: { text: 'after', tags: ['#새', '새'], at: { x: 0.25, y: 0.75 }, collapsed: true, tutor: false, updatedAt: '1999-01-01T00:00:00.000Z' } },
    ]);
    const next = updated.items[0] as MemoItem;
    assert.deepEqual([next.text, next.tags, next.at, next.collapsed, next.tutor], ['after', ['새'], { x: 0.25, y: 0.75 }, true, false]);
    assert.deepEqual([next.id, next.type, next.createdAt, next.recordedAt], [memo.id, 'memo', memo.createdAt, memo.recordedAt]);
    assert.equal(next.updatedAt, updated.updatedAt);
    assert.notEqual(next.updatedAt, memo.updatedAt);
    // Keys of another type, or creation-only ones, are refused.
    await expectHttp(patch(DOC, 3, 2, [{ op: 'update', id: memo.id, patch: { rect: RECT } }]), 400, /없는 항목입니다: rect/);
    await expectHttp(patch(DOC, 3, 2, [{ op: 'update', id: memo.id, patch: { createdAt: '2000-01-01T00:00:00.000Z' } }]), 400, /createdAt/);
    await expectHttp(patch(DOC, 3, 2, [{ op: 'update', id: memo.id, patch: { recordedAt: { rid: '20260929-100000-abcd', t: 9 } } }]), 400, /recordedAt/);
    await expectHttp(patch(DOC, 3, 2, [{ op: 'update', id: memo.id, patch: { type: 'rect' } }]), 400, /type/);
    await expectHttp(patch(DOC, 3, 2, [{ op: 'update', id: memo.id, patch: { text: 'a'.repeat(2001) } }]), 400, /너무 깁니다/);
    await expectHttp(patch(DOC, 3, 2, [{ op: 'update', id: memo.id, patch: 'x' }]), 400, /patch/);
    assert.equal((await readSlideAnnotations(DOC, 3)).rev, 2);
  });

  test('hideMarker de-duplicates, unhideMarker of an unknown key is a no-op; every op counts as a write', async () => {
    const doc = await patch(DOC, 4, 0, [{ op: 'hideMarker', key: key(1) }, { op: 'hideMarker', key: key(1) }, { op: 'hideMarker', key: key(2) }, { op: 'unhideMarker', key: key(9) }]);
    assert.deepEqual([doc.rev, doc.hiddenMarkers], [1, [key(1), key(2)]]);
    const next = await patch(DOC, 4, 1, [{ op: 'unhideMarker', key: key(1) }]);
    assert.deepEqual([next.rev, next.hiddenMarkers], [2, [key(2)]]);
  });

  test('PUT replaces items and markers; untouched items keep their updatedAt, changed ones are stamped, new ones are added', async () => {
    const a = rectItem();
    const b = memoItem();
    const first = await putSlideAnnotations(DOC, 5, { baseRev: 0, items: [a, b], hiddenMarkers: [key(1)] });
    assert.equal(first.rev, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const c = rectItem();
    const second = await putSlideAnnotations(DOC, 5, { baseRev: 1, items: [{ ...b, text: 'changed' }, { ...first.items[0], updatedAt: '2000-01-01T00:00:00.000Z' }, c], hiddenMarkers: [] });
    assert.equal(second.rev, 2);
    assert.deepEqual(second.items.map((item) => item.id), [b.id, a.id, c.id], 'z-order = array order');
    assert.equal(second.items[1].updatedAt, first.items[0].updatedAt, 'the untouched rect keeps its stamp');
    assert.equal(second.items[0].updatedAt, second.updatedAt, 'the changed memo is stamped');
    assert.equal(second.items[2].updatedAt, second.updatedAt);
    assert.deepEqual(second.hiddenMarkers, []);
    await expectHttp(putSlideAnnotations(DOC, 5, { baseRev: 1, items: [], hiddenMarkers: [] }), 409);
  });

  test('writes of one slide are serialized: concurrent writes with the same baseRev end with exactly one accepted', async () => {
    const results = await Promise.allSettled([patch(DOC, 1, 2, [add(rectItem())]), patch(DOC, 1, 2, [add(rectItem())]), patch(DOC, 1, 2, [add(rectItem())])]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && (r.reason as HttpError).status === 409).length, 2);
    assert.equal((await readSlideAnnotations(DOC, 1)).rev, 3);
  });
});

describe('recordedAt and the live recording of the document', () => {
  const DOC = 'live-deck-ddd444';
  before(() => makeDoc(DOC));

  test('an add without a stamp is stamped with the live recording (round3); a memo gets the 🎙 link; a client stamp wins; edits keep it', async () => {
    const asked: string[] = [];
    configureAnnotations({
      liveRecording: async (docId) => {
        asked.push(docId);
        return { rid: '20260929-110000-beef', t: 61.23456 };
      },
    });
    const own = { rid: '20260929-100000-abcd', t: 1 };
    const doc = await patch(DOC, 1, 0, [
      add(rectItem()),
      add(memoItem({ links: [{ kind: 'slide', slide: 2 }] })),
      add(rectItem({ recordedAt: own })),
      add(memoItem({ links: [{ kind: 'recording', rid: '20260929-110000-beef', t: 5 }] })),
    ]);
    assert.deepEqual(asked, [DOC]);
    const [rect, memo, stamped, linked] = doc.items as [AnnotationItem, MemoItem, AnnotationItem, MemoItem];
    assert.deepEqual(rect.recordedAt, { rid: '20260929-110000-beef', t: 61.235 });
    assert.deepEqual(memo.recordedAt, { rid: '20260929-110000-beef', t: 61.235 });
    assert.deepEqual(memo.links, [
      { kind: 'slide', slide: 2 },
      { kind: 'recording', rid: '20260929-110000-beef', t: 61.235 },
    ]);
    assert.deepEqual(stamped.recordedAt, own, 'the client stamp wins');
    assert.deepEqual(linked.links, [{ kind: 'recording', rid: '20260929-110000-beef', t: 5 }], 'an existing link to that recording is kept');
    // Ops that add nothing without a stamp never ask for the recording.
    await patch(DOC, 1, 1, [{ op: 'update', id: rect.id, patch: { color: 'green' } }]);
    assert.deepEqual(asked, [DOC]);
    const after = await readSlideAnnotations(DOC, 1);
    assert.deepEqual(after.items[0].recordedAt, { rid: '20260929-110000-beef', t: 61.235 }, 'an update keeps the stamp');
    // No live recording: nothing is stamped.
    configureAnnotations({ liveRecording: async () => null });
    const plain = await patch(DOC, 2, 0, [add(memoItem())]);
    assert.equal(plain.items[0].recordedAt, undefined);
    assert.deepEqual((plain.items[0] as MemoItem).links, []);
    // A failing lookup never fails the write.
    configureAnnotations({
      liveRecording: async () => {
        throw new Error('boom');
      },
    });
    assert.equal((await patch(DOC, 2, 1, [add(rectItem())])).rev, 2);
  });

  test('PUT stamps its new items and leaves the stamps of existing ones alone', async () => {
    configureAnnotations({ liveRecording: async () => ({ rid: '20260929-110000-beef', t: 2 }) });
    const kept = rectItem({ recordedAt: { rid: '20260929-100000-abcd', t: 1 } });
    const first = await putSlideAnnotations(DOC, 3, { baseRev: 0, items: [kept], hiddenMarkers: [] });
    const second = await putSlideAnnotations(DOC, 3, { baseRev: 1, items: [{ ...first.items[0], recordedAt: { rid: '20260929-110000-beef', t: 9 } }, memoItem()], hiddenMarkers: [] });
    assert.deepEqual(second.items[0].recordedAt, { rid: '20260929-100000-abcd', t: 1 });
    assert.deepEqual(second.items[1].recordedAt, { rid: '20260929-110000-beef', t: 2 });
  });
});

describe('the index (annotations/index.json) and the tags', () => {
  const DOC = 'index-deck-eee555';
  const OTHER = 'index-other-fff666';
  before(async () => {
    await makeDoc(DOC);
    await makeDoc(OTHER);
  });

  test('the summary lists slides with items (ascending, with revs), every memo (slide, then createdAt) and tag counts', async () => {
    await patch(DOC, 4, 0, [add(memoItem({ createdAt: '2026-09-29T10:00:02.000Z', text: '넷째', tags: ['시험', '예제'] }))]);
    await patch(DOC, 2, 0, [
      add(rectItem()),
      add(memoItem({ createdAt: '2026-09-29T10:00:01.000Z', text: '둘째 b\n\n  둘째  줄\n셋째 줄', tags: ['시험'], tutor: false })),
      add(memoItem({ createdAt: '2026-09-29T10:00:00.000Z', text: '둘째 a', tags: [] })),
    ]);
    await patch(DOC, 2, 1, [add(rectItem())]);
    await patch(DOC, 5, 0, [{ op: 'hideMarker', key: key(1) }]);
    const summary = await readSummary(DOC);
    assert.deepEqual(summary.slides, [
      { slide: 2, rev: 2, items: 4, memos: 2, tags: ['시험'] },
      { slide: 4, rev: 1, items: 1, memos: 1, tags: ['시험', '예제'] },
    ]);
    assert.deepEqual(
      summary.memos.map((memo) => [memo.slide, memo.text, memo.tags, memo.tutor]),
      [
        [2, '둘째 a', [], true],
        [2, '둘째 b\n둘째 줄…', ['시험'], false],
        [4, '넷째', ['시험', '예제'], true],
      ],
    );
    assert.deepEqual(summary.tags, [
      { tag: '시험', count: 2 },
      { tag: '예제', count: 1 },
    ]);
    const stored = JSON.parse(await fs.readFile(path.join(docPaths(DOC).annotationsDir, 'index.json'), 'utf8'));
    assert.deepEqual(stored, summary);
    // Removing the items of a slide drops its entry and memos.
    const doc = await readSlideAnnotations(DOC, 4);
    await patch(DOC, 4, doc.rev, [{ op: 'remove', id: doc.items[0].id }]);
    const next = await readSummary(DOC);
    assert.deepEqual(next.slides.map((entry) => entry.slide), [2]);
    assert.deepEqual(next.tags, [{ tag: '시험', count: 1 }]);
  });

  test('memo summaries: whitespace squeezed, two lines, 400 characters', () => {
    assert.equal(memoSummaryText('  a   b \n\n c \n d '), 'a b\nc…');
    assert.equal(memoSummaryText('x'.repeat(500)), `${'x'.repeat(400)}…`);
    assert.equal(memoSummaryText('one\ntwo'), 'one\ntwo');
    assert.equal(memoSummaryText(''), '');
  });

  test('index writes are coalesced; readSummary waits for them; a missing index is rebuilt from the slide files (any digits.json)', async () => {
    const index = path.join(docPaths(DOC).annotationsDir, 'index.json');
    await fs.rm(index);
    await patch(DOC, 1, 0, [add(memoItem({ tags: ['index-a'] }))]);
    await patch(DOC, 3, 0, [add(memoItem({ tags: ['index-b'] }))]);
    await assert.rejects(fs.access(index), 'not written yet (debounced)');
    await flushAnnotationIndex(DOC);
    const written = JSON.parse(await fs.readFile(index, 'utf8')) as { slides: Array<{ slide: number }> };
    assert.deepEqual(written.slides.map((entry) => entry.slide), [1, 2, 3]);

    await fs.rm(index);
    await fs.writeFile(path.join(docPaths(DOC).annotationsDir, '5.json'), JSON.stringify({ version: 1, slide: 5, rev: 7, updatedAt: 'x', items: [rectItem()], hiddenMarkers: [] }));
    await fs.writeFile(path.join(docPaths(DOC).annotationsDir, '9.json'), JSON.stringify({ version: 1, slide: 9, rev: 1, updatedAt: 'x', items: [rectItem()], hiddenMarkers: [] }));
    await fs.writeFile(path.join(docPaths(DOC).annotationsDir, 'notes.json'), '{}');
    const rebuilt = await readSummary(DOC);
    assert.deepEqual(rebuilt.slides.map((entry) => [entry.slide, entry.rev]), [[1, 1], [2, 2], [3, 1], [5, 7]], 'slide 9 is past the page count');
    assert.deepEqual(rebuilt.tags, [
      { tag: 'index-a', count: 1 },
      { tag: 'index-b', count: 1 },
      { tag: '시험', count: 1 },
    ]);
    await fs.access(index);
    // An unreadable index is rebuilt as well.
    await fs.writeFile(index, 'not json');
    assert.deepEqual(await readSummary(DOC), rebuilt);
  });

  test('a rebuild (missing index) and the index update of a slide written meanwhile are serialized: the write’s entry stays', async () => {
    const RACE = 'index-race-abc777';
    await makeDoc(RACE);
    const index = path.join(docPaths(RACE).annotationsDir, 'index.json');
    const first = await patch(RACE, 1, 0, [add(memoItem({ text: '처음' }))]);
    await flushAnnotationIndex(RACE);
    await fs.rm(index);
    // GET starts a rebuild (it reads 1.json at rev 1) while a PATCH bumps the slide to rev 2 and its index update runs.
    const rebuilding = readSummary(RACE);
    const second = await patch(RACE, 1, first.rev, [add(memoItem({ text: '나중', tags: ['race'] }))]);
    await Promise.all([rebuilding, flushAnnotationIndex(RACE)]);
    const stored = JSON.parse(await fs.readFile(index, 'utf8')) as { slides: Array<{ slide: number; rev: number }>; memos: Array<{ text: string }> };
    assert.deepEqual(stored.slides.map((entry) => [entry.slide, entry.rev]), [[1, second.rev]]);
    assert.deepEqual(stored.memos.map((memo) => memo.text).sort(), ['나중', '처음']);
    assert.deepEqual((await readSummary(RACE)).slides.map((entry) => entry.rev), [second.rev]);
  });

  test('a failed rebuild is remembered for a while', async () => {
    configureAnnotations({ rebuildFailureTtlMs: 300 });
    const dir = docPaths(OTHER).annotationsDir;
    await fs.writeFile(dir, 'a file where the folder should be');
    await expectHttp(rebuildIndex(OTHER), 500, /필기 목록/);
    await fs.rm(dir);
    await expectHttp(readSummary(OTHER), 500, /필기 목록/);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(await readSummary(OTHER), { version: 1, slides: [], memos: [], tags: [] });
  });

  test('the library-wide tags merge every lecture (documents without annotations cost nothing)', async () => {
    await patch(OTHER, 1, 0, [add(memoItem({ tags: ['시험', 'index-other'] }))]);
    const { tags } = await listAnnotationTags();
    const of = (tag: string) => tags.find((entry) => entry.tag === tag)?.count ?? 0;
    // '시험' is the default tag of the memo fixture: every suite of this file added some (the library is shared).
    assert.deepEqual([of('index-other'), of('index-a'), of('index-b')], [1, 1, 1]);
    assert.ok(of('시험') >= 2, 'both documents of this suite count');
    assert.deepEqual(tags.map((entry) => entry.tag).slice(0, 1), ['시험'], 'most used first');
    for (let i = 1; i < tags.length; i++) assert.ok(tags[i - 1].count > tags[i].count || (tags[i - 1].count === tags[i].count && tags[i - 1].tag < tags[i].tag));
    // The cache follows the file: a new memo changes the counts.
    await patch(OTHER, 2, 0, [add(memoItem({ tags: ['index-other'] }))]);
    assert.equal((await listAnnotationTags()).tags.find((entry) => entry.tag === 'index-other')?.count, 2);
  });
});

describe('the SSE hub', () => {
  const DOC = 'sse-deck-abc777';
  before(async () => {
    await makeDoc(DOC);
    configureAnnotations({ pingMs: 40 });
  });

  test('a PATCH sends its ops (not the document) to every subscriber but the writer; a PUT sends the document; summary changes nudge', async () => {
    configureAnnotations({ pingMs: 40 });
    const a = fakeTarget();
    const b = fakeTarget();
    const plain = fakeTarget();
    const offA = await subscribeAnnotations(DOC, a, 'client-aaaaaaaa');
    const offB = await subscribeAnnotations(DOC, b, 'client-bbbbbbbb');
    const offPlain = await subscribeAnnotations(DOC, plain);
    assert.equal(annotationSubscribers(DOC), 3);
    assert.ok(a.chunks[0].startsWith('retry: 2000'));

    const memo = memoItem();
    const doc = await patch(DOC, 1, 0, [add(memo), { op: 'hideMarker', key: key(1) }], 'client-aaaaaaaa');
    const slideEvents = (t: ReturnType<typeof fakeTarget>) => t.events().filter((e) => e.type !== 'ping');
    assert.deepEqual(slideEvents(a), [{ type: 'summary' }], "the writer's own client gets the summary nudge but not its ops");
    const [slide, summary] = slideEvents(b);
    assert.equal(slide.type, 'slide');
    if (slide.type === 'slide') {
      assert.deepEqual([slide.slide, slide.rev, slide.updatedAt], [1, 1, doc.updatedAt]);
      assert.deepEqual(slide.ops, [{ op: 'add', item: doc.items[0] }, { op: 'hideMarker', key: key(1) }]);
    }
    assert.deepEqual(summary, { type: 'summary' });
    assert.deepEqual(slideEvents(plain), slideEvents(b), 'a subscriber without a client id gets everything');

    // A geometry change of a rect changes no summary: no nudge.
    const rect = rectItem();
    await patch(DOC, 1, 1, [add(rect)]);
    const withRect = await patch(DOC, 1, 2, [{ op: 'update', id: rect.id, patch: { rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } } }], 'client-bbbbbbbb');
    const last = slideEvents(a).at(-1);
    assert.equal(last?.type, 'slide');
    if (last?.type === 'slide') {
      assert.equal(last.rev, 3);
      assert.deepEqual(last.ops, [{ op: 'update', id: rect.id, patch: { updatedAt: withRect.updatedAt, rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } } }]);
    }
    assert.equal(slideEvents(b).filter((e) => e.type === 'summary').length, 2, 'only the add of the rect changed the counts');
    assert.equal(slideEvents(b).at(-1)?.type, 'summary', 'the writer of the update got nothing for it');
    assert.equal(slideEvents(a).filter((e) => e.type === 'summary').length, 2);

    const put = await putSlideAnnotations(DOC, 1, { baseRev: 3, items: [], hiddenMarkers: [] }, 'client-aaaaaaaa');
    assert.deepEqual(slideEvents(b).at(-2), { type: 'slide-reset', annotations: put });
    assert.deepEqual(slideEvents(b).at(-1), { type: 'summary' });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(a.events().some((e) => e.type === 'ping'), 'pings keep the stream alive');
    offA();
    offB();
    offPlain();
    assert.equal(annotationSubscribers(DOC), 0);
  });

  test('session changes reach the subscribers as qa; forgetting the document ends its streams', async () => {
    const t = fakeTarget();
    await subscribeAnnotations(DOC, t);
    notifySessionsChanged({ docId: DOC, sessionId: '20260929-120000-abcd', updatedAt: '2026-09-29T12:00:00.000Z' });
    notifySessionsChanged({ docId: 'other-deck-000000', sessionId: '20260929-120000-abcd', updatedAt: null });
    notifySessionsChanged({ docId: DOC, sessionId: '20260929-120000-abcd', updatedAt: null });
    assert.deepEqual(
      t.events().filter((e) => e.type === 'qa'),
      [
        { type: 'qa', sessionId: '20260929-120000-abcd', updatedAt: '2026-09-29T12:00:00.000Z' },
        { type: 'qa', sessionId: '20260929-120000-abcd', updatedAt: null },
      ],
    );
    forgetDocAnnotations(DOC);
    assert.ok(t.ended);
    assert.equal(annotationSubscribers(DOC), 0);
    await expectHttp(subscribeAnnotations('nope-deck-000000', fakeTarget()), 404);
  });
});

describe('memosForTutor', () => {
  const DOC = 'tutor-deck-abc888';
  before(() => makeDoc(DOC, 20));

  test('memos of the window with tutor on and text, squeezed and capped, at most 12; never throws', async () => {
    await patch(DOC, 2, 0, [
      add(memoItem({ text: '  여러   줄\n메모  ', tags: ['시험'] })),
      add(memoItem({ text: '숨긴 메모', tutor: false })),
      add(memoItem({ text: '   ' })),
      add(memoItem({ text: 'x'.repeat(700), tags: [] })),
      add(rectItem()),
    ]);
    await patch(DOC, 3, 0, [add(memoItem({ text: '셋째', tags: [] }))]);
    await patch(DOC, 9, 0, [add(memoItem({ text: '멀리' }))]);
    const memos = await memosForTutor(DOC, [3, 2, 2, 4, 99, 0]);
    assert.deepEqual(
      memos.map((memo) => [memo.slide, memo.text.length > 40 ? memo.text.slice(0, 3) : memo.text, memo.tags]),
      [
        [2, '여러 줄 메모', ['시험']],
        [2, 'xxx', undefined],
        [3, '셋째', undefined],
      ],
    );
    assert.ok(memos[1].text.endsWith('…[truncated]') && memos[1].text.length <= 600 + 12);
    await patch(DOC, 5, 0, Array.from({ length: 15 }, (_, i) => add(memoItem({ text: `m${i}` }))));
    assert.equal((await memosForTutor(DOC, [5, 3])).length, 12);
    assert.deepEqual(await memosForTutor('nope-deck-000000', [1]), []);
    assert.deepEqual(await memosForTutor(DOC, []), []);
  });

  test('the focused slide’s memos come first, then the nearest neighbours (ties ascending): a full neighbour never crowds them out', async () => {
    await patch(DOC, 6, 0, [add(memoItem({ text: '여섯째' }))]);
    // Slide 5 (15 memos) alone fills the cap; asked on slide 6, its memo still leads and slide 7 (nothing) is walked last.
    const focused = await memosForTutor(DOC, [5, 6, 7], 6);
    assert.equal(focused.length, 12);
    assert.deepEqual([focused[0].slide, focused[0].text], [6, '여섯째']);
    assert.ok(focused.slice(1).every((memo) => memo.slide === 5));
    assert.deepEqual((await memosForTutor(DOC, [2, 3, 4], 3)).map((memo) => memo.slide), [3, 2, 2]);
    // Without a focused slide: ascending (the older callers).
    assert.deepEqual((await memosForTutor(DOC, [3, 2])).map((memo) => memo.slide), [2, 2, 3]);
  });
});

describe('shutdown', () => {
  test('closeAnnotationStreams ends every stream and flushes the pending index writes', async () => {
    const DOC = 'close-deck-abc999';
    await makeDoc(DOC);
    const t = fakeTarget();
    await subscribeAnnotations(DOC, t);
    await patch(DOC, 1, 0, [add(memoItem())]);
    await closeAnnotationStreams();
    assert.ok(t.ended);
    const index = JSON.parse(await fs.readFile(path.join(docPaths(DOC).annotationsDir, 'index.json'), 'utf8')) as { memos: unknown[] };
    assert.equal(index.memos.length, 1);
    const doc: SlideAnnotations = await readSlideAnnotations(DOC, 1);
    assert.equal(doc.rev, 1);
  });
});
