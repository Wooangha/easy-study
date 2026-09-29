// Slide annotations (DESIGN §25), the pure geometry: the ops reducer, rebasing, bounds, drag → item, 형광펜
// snapping on 'h' and 'v' lines, resizing, tags, the recording stamp and the replay predicate.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ANNOTATION_ID_RE,
  HIGHLIGHT_BAND_H,
  MAX_ANNOTATION_ITEMS,
  MAX_MEMO_LINKS,
  MAX_MEMO_TAGS,
  type AnnotationOp,
  type MemoItem,
  type RectItem,
  type SlideAnnotations,
  type SlideTextLayout,
} from '../../shared/types.ts';
import {
  applyOps,
  bandHandles,
  canAddItems,
  emptySlideAnnotations,
  itemBounds,
  lineAt,
  memoAt,
  memoPreview,
  moveRect,
  newAnnotationId,
  newMemo,
  newShape,
  normalizeTag,
  normalizeTags,
  rebaseOps,
  recordedAtFor,
  rectFromPoints,
  replayVisible,
  resizeRect,
  snapBand,
  suggestTags,
  textBoxFromDrag,
  unionRects,
  withLink,
} from '../src/lib/annotations/geometry.ts';

const NOW = '2026-09-29T10:00:00.000Z';

const rect = (id: string, x = 0.1, y = 0.1, w = 0.2, h = 0.1): RectItem => ({
  id,
  type: 'rect',
  color: 'yellow',
  createdAt: NOW,
  updatedAt: NOW,
  rect: { x, y, w, h },
});

const memo = (id: string, patch: Partial<MemoItem> = {}): MemoItem => ({
  id,
  type: 'memo',
  color: 'pink',
  createdAt: NOW,
  updatedAt: NOW,
  at: { x: 0.5, y: 0.5 },
  text: '',
  tags: [],
  collapsed: false,
  tutor: true,
  links: [],
  ...patch,
});

const doc = (items: SlideAnnotations['items'] = [], rev = 3): SlideAnnotations => ({ ...emptySlideAnnotations(7), rev, items });

const key = (n: number) => ({ sessionId: 's1', messageId: `m${n}`, attachmentId: `a${n}` });

describe('applyOps (the same semantics as the server)', () => {
  test('add, update (only the fields of the type), remove, hide / unhide markers; the rev is not touched', () => {
    let d = doc();
    d = applyOps(d, [{ op: 'add', item: rect('an-000000000001') }]);
    assert.equal(d.items.length, 1);
    assert.equal(d.rev, 3);
    d = applyOps(d, [{ op: 'update', id: 'an-000000000001', patch: { color: 'blue', rect: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } } }]);
    assert.equal(d.items[0].color, 'blue');
    assert.deepEqual((d.items[0] as RectItem).rect, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 });
    // A memo field on a rect is not applied; nothing else in the patch → the same object.
    const same = applyOps(d, [{ op: 'update', id: 'an-000000000001', patch: { tags: ['x'] } as never }]);
    assert.equal(same, d);
    d = applyOps(d, [{ op: 'hideMarker', key: key(1) }, { op: 'hideMarker', key: key(1) }, { op: 'hideMarker', key: key(2) }]);
    assert.equal(d.hiddenMarkers.length, 2);
    d = applyOps(d, [{ op: 'unhideMarker', key: key(1) }, { op: 'unhideMarker', key: key(9) }]);
    assert.deepEqual(d.hiddenMarkers, [key(2)]);
    d = applyOps(d, [{ op: 'remove', id: 'an-000000000001' }]);
    assert.equal(d.items.length, 0);
    assert.equal(applyOps(d, [{ op: 'remove', id: 'an-000000000001' }]), d, 'remove is idempotent');
  });

  test('an add of an existing id, an update / remove of a missing id and an identical patch change nothing', () => {
    const d = doc([rect('an-000000000001')]);
    assert.equal(applyOps(d, [{ op: 'add', item: rect('an-000000000001', 0.5) }]), d);
    assert.equal(applyOps(d, [{ op: 'update', id: 'an-000000000009', patch: { color: 'blue' } }]), d);
    assert.equal(applyOps(d, [{ op: 'update', id: 'an-000000000001', patch: { color: 'yellow' } }]), d);
    assert.equal(applyOps(d, [{ op: 'remove', id: 'an-000000000009' }]), d);
    assert.equal(applyOps(d, []), d);
  });

  test('id / type / createdAt / recordedAt are never patched', () => {
    const d = doc([rect('an-000000000001')]);
    const next = applyOps(d, [
      { op: 'update', id: 'an-000000000001', patch: { id: 'an-000000000002', type: 'memo', createdAt: 'x', recordedAt: { rid: 'r', t: 1 }, color: 'green' } as never },
    ]);
    assert.equal(next.items[0].id, 'an-000000000001');
    assert.equal(next.items[0].type, 'rect');
    assert.equal(next.items[0].createdAt, NOW);
    assert.equal(next.items[0].recordedAt, undefined);
    assert.equal(next.items[0].color, 'green');
  });

  test('the item cap counts the ops', () => {
    const many = Array.from({ length: MAX_ANNOTATION_ITEMS }, (_, i) => rect(`an-${String(i).padStart(12, '0')}`));
    const full = doc(many);
    assert.equal(canAddItems(full, [{ op: 'add', item: rect('an-ffffffffffff') }]), false);
    assert.equal(canAddItems(full, [{ op: 'remove', id: many[0].id }, { op: 'add', item: rect('an-ffffffffffff') }]), true);
    assert.equal(canAddItems(doc(), [{ op: 'add', item: rect('an-ffffffffffff') }]), true);
  });
});

describe('rebaseOps (after a 409: the server’s document + our ops)', () => {
  test('drops an add whose id exists there, and an update / remove whose id is gone', () => {
    const current = doc([rect('an-000000000001'), rect('an-000000000003')]);
    const ops: AnnotationOp[] = [
      { op: 'add', item: rect('an-000000000001') }, // they made it first (a replayed add)
      { op: 'add', item: rect('an-000000000002') },
      { op: 'update', id: 'an-000000000002', patch: { color: 'blue' } }, // on our own new item: kept
      { op: 'update', id: 'an-000000000004', patch: { color: 'blue' } }, // theirs, deleted meanwhile
      { op: 'remove', id: 'an-000000000003' },
      { op: 'remove', id: 'an-000000000003' }, // already removed by the op before
      { op: 'hideMarker', key: key(1) },
    ];
    assert.deepEqual(
      rebaseOps(current, ops).map((o) => `${o.op}:${'id' in o ? o.id : 'item' in o ? o.item.id : 'key'}`),
      ['add:an-000000000002', 'update:an-000000000002', 'remove:an-000000000003', 'hideMarker:key'],
    );
  });
});

describe('bounds and drags', () => {
  test('itemBounds: the rect, the union of a text highlight’s rects, a small box around a memo (clamped)', () => {
    assert.deepEqual(itemBounds(rect('an-000000000001', 0.1, 0.2, 0.3, 0.4)), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.deepEqual(
      unionRects([
        { x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
        { x: 0.1, y: 0.14, w: 0.3, h: 0.03 },
      ]),
      { x: 0.1, y: 0.1, w: 0.5, h: 0.07 },
    );
    assert.deepEqual(itemBounds(memo('an-000000000001', { at: { x: 0.5, y: 0.5 } })), { x: 0.5, y: 0.5, w: 0.12, h: 0.08 });
    const corner = itemBounds(memo('an-000000000001', { at: { x: 0.97, y: 0.98 } }));
    assert.ok(corner.x + corner.w <= 1 && corner.y + corner.h <= 1);
  });

  test('rectFromPoints: any direction, a minimum size; a text box click gives the default box; memoAt clamps', () => {
    assert.deepEqual(rectFromPoints({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 }), { x: 0.2, y: 0.3, w: 0.4, h: 0.4 });
    const tiny = rectFromPoints({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 });
    assert.ok(tiny.w >= 0.01 && tiny.h >= 0.01);
    assert.deepEqual(textBoxFromDrag({ x: 0.3, y: 0.3 }, { x: 0.305, y: 0.3 }), { x: 0.3, y: 0.3, w: 0.18, h: 0.06 });
    const edge = textBoxFromDrag({ x: 0.95, y: 0.99 }, { x: 0.95, y: 0.99 });
    assert.ok(edge.x + edge.w <= 1 && edge.y + edge.h <= 1);
    assert.deepEqual(textBoxFromDrag({ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.4 }), { x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
    assert.deepEqual(memoAt({ x: 0.99999, y: 0.3 }), { x: 0.98, y: 0.3 });
  });

  test('moveRect and resizeRect stay inside the image and keep a minimum size', () => {
    assert.deepEqual(moveRect({ x: 0.8, y: 0.8, w: 0.3, h: 0.3 }, 0.5, -1), { x: 0.7, y: 0, w: 0.3, h: 0.3 });
    const r = { x: 0.2, y: 0.2, w: 0.2, h: 0.2 };
    assert.deepEqual(resizeRect(r, 'se', 0.1, 0.1), { x: 0.2, y: 0.2, w: 0.3, h: 0.3 });
    assert.deepEqual(resizeRect(r, 'nw', 0.1, 0.1), { x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    const collapsed = resizeRect(r, 'e', -0.5, 0);
    assert.ok(collapsed.w >= 0.005 && collapsed.x === 0.2);
    assert.deepEqual(resizeRect(r, 'n', 0, -1), { x: 0.2, y: 0, w: 0.2, h: 0.4 });
    assert.deepEqual(bandHandles({ x: 0, y: 0, w: 0.5, h: 0.03 }), ['w', 'e']);
    assert.deepEqual(bandHandles({ x: 0, y: 0, w: 0.03, h: 0.5 }), ['n', 's']);
  });
});

/** Two horizontal lines and, on a rotated page, one vertical line. */
const layout: SlideTextLayout = {
  version: 1,
  engine: 'pdfium-3',
  lines: [
    { r: [0.1, 0.2, 0.6, 0.04], dir: 'h', words: [{ r: [0.1, 0.2, 0.2, 0.04], t: 'Hello', c: [0, 5] }, { r: [0.32, 0.2, 0.38, 0.04], t: 'world', c: [6, 11] }] },
    { r: [0.1, 0.26, 0.3, 0.04], dir: 'h', words: [{ r: [0.1, 0.26, 0.3, 0.04], t: 'second', c: [12, 18] }] },
    { r: [0.8, 0.1, 0.03, 0.5], dir: 'v', words: [{ r: [0.8, 0.1, 0.03, 0.5], t: 'Rotated', c: [19, 26] }] },
  ],
};

describe('형광펜 snapping (snapBand)', () => {
  test('a drag on a horizontal line takes the line’s y/h and the drag’s x extent, padded at most 0.5 % past the line', () => {
    assert.equal(lineAt(layout, { x: 0.3, y: 0.22 })?.words[0].t, 'Hello');
    assert.deepEqual(snapBand({ x: 0.3, y: 0.22 }, { x: 0.5, y: 0.5 }, layout), { x: 0.3, y: 0.2, w: 0.2, h: 0.04 });
    // Dragged past both ends: clamped to the line (padded).
    assert.deepEqual(snapBand({ x: 0.2, y: 0.21 }, { x: 0.95, y: 0.21 }, layout), { x: 0.2, y: 0.2, w: 0.505, h: 0.04 });
    // A press just under the line (within half a line height) still snaps to it.
    assert.equal(lineAt(layout, { x: 0.3, y: 0.245 })?.words[0].t, 'Hello');
    // The second line is nearer when the press is in between but closer to it.
    assert.equal(lineAt(layout, { x: 0.2, y: 0.258 })?.words[0].t, 'second');
    // Beside every line: none.
    assert.equal(lineAt(layout, { x: 0.75, y: 0.22 }), null);
  });

  test('a drag on a vertical line takes the line’s x/w and the drag’s y extent', () => {
    assert.deepEqual(snapBand({ x: 0.81, y: 0.2 }, { x: 0.5, y: 0.4 }, layout), { x: 0.8, y: 0.2, w: 0.03, h: 0.2 });
  });

  test('no line under the press: a band of HIGHLIGHT_BAND_H centred on it, at least 1 % long', () => {
    const band = snapBand({ x: 0.3, y: 0.7 }, { x: 0.6, y: 0.75 }, layout);
    assert.deepEqual(band, { x: 0.3, y: 0.686, w: 0.3, h: HIGHLIGHT_BAND_H });
    const click = snapBand({ x: 0.3, y: 0.7 }, { x: 0.3, y: 0.7 }, null);
    assert.ok(click.w >= 0.01);
    const bottom = snapBand({ x: 0.3, y: 0.999 }, { x: 0.6, y: 0.999 }, null);
    assert.ok(bottom.y + bottom.h <= 1);
  });
});

describe('items, tags, links', () => {
  test('ids match ANNOTATION_ID_RE', () => {
    assert.match(newAnnotationId(), ANNOTATION_ID_RE);
    assert.equal(newAnnotationId((b) => b.fill(0xab)), 'an-abababababab');
  });

  test('a memo made during a live recording links to that moment; other items just carry the stamp', () => {
    const seed = { id: 'an-000000000001', color: 'green' as const, createdAt: NOW, recordedAt: { rid: 'rec-1', t: 754.25 } };
    const m = newMemo(seed, { x: 0.3, y: 0.4 });
    assert.deepEqual(m.links, [{ kind: 'recording', rid: 'rec-1', t: 754.25 }]);
    assert.equal(m.tutor, true);
    assert.deepEqual(newMemo({ ...seed, recordedAt: undefined }, { x: 0.3, y: 0.4 }).links, []);
    const e = newShape(seed, 'ellipse', { x: 0, y: 0, w: 0.1, h: 0.1 });
    assert.equal(e.type, 'ellipse');
    assert.deepEqual(e.recordedAt, seed.recordedAt);
  });

  test('tags are trimmed, squeezed, without a leading #, unique, capped', () => {
    assert.equal(normalizeTag('  #시험   범위 '), '시험 범위');
    assert.equal(normalizeTag('##'), null);
    assert.equal(normalizeTag('#a\u0001b\u007f\u202ec\u200f'), 'abc', 'control and bidi characters are dropped (as on the server)');
    assert.equal(normalizeTag('a'.repeat(40))?.length, 30);
    assert.deepEqual(normalizeTags(['예제', '#예제', ' 시험', '']), ['예제', '시험']);
    assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, MAX_MEMO_TAGS);
  });

  test('withLink adds once and refuses past the cap', () => {
    const links = withLink([], { kind: 'slide', slide: 3 })!;
    assert.deepEqual(withLink(links, { kind: 'slide', slide: 3 }), links);
    const full = Array.from({ length: MAX_MEMO_LINKS }, (_, i) => ({ kind: 'slide' as const, slide: i + 1 }));
    assert.equal(withLink(full, { kind: 'recording', rid: 'r', t: 1 }), null);
  });

  test('suggestTags: prefix matches first (most used), then substrings; taken tags left out', () => {
    const candidates = [
      { tag: '시험', count: 5 },
      { tag: '시험범위', count: 2 },
      { tag: '중간시험', count: 9 },
      { tag: '예제', count: 4 },
    ];
    assert.deepEqual(suggestTags('시', candidates, []), ['시험', '시험범위', '중간시험']);
    assert.deepEqual(suggestTags('', candidates, ['시험']), ['중간시험', '예제', '시험범위']);
    assert.deepEqual(suggestTags('zzz', candidates, []), []);
  });

  test('memoPreview: the first line, shortened', () => {
    assert.equal(memoPreview('  첫 줄\n둘째 줄'), '첫 줄');
    assert.equal(memoPreview('가'.repeat(30)), `${'가'.repeat(23)}…`);
    assert.equal(memoPreview('  \n'), '');
  });
});

describe('the recording clock', () => {
  test('recordedAtFor: only while this device records (or paused) this lecture, rounded to 3 decimals', () => {
    const live = { phase: 'recording', docId: 'doc-1', recordingId: 'rec-1' };
    assert.deepEqual(recordedAtFor(live, 12.3456, 'doc-1'), { rid: 'rec-1', t: 12.346 });
    assert.deepEqual(recordedAtFor({ ...live, phase: 'paused' }, 5, 'doc-1'), { rid: 'rec-1', t: 5 });
    assert.equal(recordedAtFor(live, 12, 'doc-2'), undefined);
    assert.equal(recordedAtFor({ ...live, phase: 'idle', recordingId: null }, 12, 'doc-1'), undefined);
    assert.equal(recordedAtFor({ ...live, phase: 'starting' }, 12, 'doc-1'), undefined);
    assert.equal(recordedAtFor(live, Number.NaN, 'doc-1'), undefined);
  });

  test('replayVisible: without replay everything; while replaying only items of that recording made by then (+0.5 s)', () => {
    const stamped = { recordedAt: { rid: 'rec-1', t: 100 } };
    assert.equal(replayVisible(stamped, null), true);
    assert.equal(replayVisible({}, null), true);
    assert.equal(replayVisible(stamped, { rid: 'rec-1', t: 99.6 }), true);
    assert.equal(replayVisible(stamped, { rid: 'rec-1', t: 99.4 }), false);
    assert.equal(replayVisible(stamped, { rid: 'rec-2', t: 500 }), false);
    assert.equal(replayVisible({}, { rid: 'rec-1', t: 500 }), false);
  });
});
