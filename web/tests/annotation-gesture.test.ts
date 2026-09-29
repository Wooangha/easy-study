// What a press on a slide does (DESIGN §25, lib/annotations/gesture.ts): hit-testing the items under the pointer
// (the smallest wins, slack for thin bands, ellipses by their shape, text highlights by their line rects, memos never,
// replay-hidden items never; an unselected rect / ellipse on its outline ring only, in every state), the marquee of
// 범위 선택 and Shift toggling, and the press plan — items first with any tool, a text highlight re-dragged under its
// own tool, handles, markers, drawing only on empty area, the region gesture in the default state.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AnnotationItem, EllipseItem, HighlightItem, MemoItem, RectItem, TextHighlightItem, TextItem } from '../../shared/types.ts';
import {
  HIT_SLOP_PX,
  SHAPE_STROKE_PX,
  TOUCH_HIT_SLOP_PX,
  canResize,
  hitTestItems,
  itemArea,
  itemHit,
  itemIntersects,
  marqueeSelect,
  outlineOnly,
  pressPlan,
  rectsIntersect,
  slopFor,
  toggleId,
  unionIds,
} from '../src/lib/annotations/gesture.ts';

const NOW = '2026-09-29T10:00:00.000Z';
const base = (id: string) => ({ id, color: 'yellow' as const, createdAt: NOW, updatedAt: NOW });

const rect = (id: string, x: number, y: number, w: number, h: number): RectItem => ({ ...base(id), type: 'rect', rect: { x, y, w, h } });
const ellipse = (id: string, x: number, y: number, w: number, h: number): EllipseItem => ({ ...base(id), type: 'ellipse', rect: { x, y, w, h } });
const band = (id: string, x: number, y: number, w: number, h: number): HighlightItem => ({ ...base(id), type: 'highlight', rect: { x, y, w, h } });
const textBox = (id: string, x: number, y: number, w: number, h: number): TextItem => ({ ...base(id), type: 'text', rect: { x, y, w, h }, text: 'hi' });
const textHl = (id: string, rects: TextHighlightItem['rects']): TextHighlightItem => ({
  ...base(id),
  type: 'textHighlight',
  rects,
  chars: [0, 10],
  engine: 'pdfium-3',
  text: 'words',
});
const memo = (id: string, x: number, y: number): MemoItem => ({
  ...base(id),
  type: 'memo',
  at: { x, y },
  text: '',
  tags: [],
  collapsed: false,
  tutor: true,
  links: [],
});

/** A 1000 × 600 px slide: 4 px of mouse slack = 0.004 across, 0.0067 down; the outline ring is 5.5 px either side. */
const SIZE = { width: 1000, height: 600 };
const slop = slopFor(SIZE, false);
const none = { x: 0, y: 0, ring: { x: 0, y: 0 } };

describe('slopFor', () => {
  test('a few pixels of the rendered slide per axis, the ring half the stroke wider; more for a finger; nothing for a zero-size box', () => {
    const ring = HIT_SLOP_PX + SHAPE_STROKE_PX / 2;
    assert.deepEqual(slop, { x: HIT_SLOP_PX / 1000, y: HIT_SLOP_PX / 600, ring: { x: ring / 1000, y: ring / 600 } });
    const touchRing = TOUCH_HIT_SLOP_PX + SHAPE_STROKE_PX / 2;
    assert.deepEqual(slopFor(SIZE, true), { x: TOUCH_HIT_SLOP_PX / 1000, y: TOUCH_HIT_SLOP_PX / 600, ring: { x: touchRing / 1000, y: touchRing / 600 } });
    assert.deepEqual(slopFor({ width: 0, height: 0 }, false), none);
  });
});

describe('itemHit / itemArea', () => {
  test('rects and bands by their rect (with the slack), ellipses by their shape, memos never', () => {
    const r = rect('an-r', 0.2, 0.2, 0.3, 0.2);
    assert.equal(itemHit(r, { x: 0.35, y: 0.3 }, none), true);
    assert.equal(itemHit(r, { x: 0.51, y: 0.3 }, none), false);
    assert.equal(itemHit(r, { x: 0.503, y: 0.3 }, slop), true); // 3 px past the edge
    assert.equal(itemHit(r, { x: 0.506, y: 0.3 }, slop), false); // 6 px past
    const e = ellipse('an-e', 0.2, 0.2, 0.4, 0.4);
    assert.equal(itemHit(e, { x: 0.4, y: 0.4 }, none), true); // the centre
    assert.equal(itemHit(e, { x: 0.21, y: 0.21 }, none), false); // the bounding box's corner is outside the ellipse
    assert.equal(itemHit(e, { x: 0.4, y: 0.202 }, slop), true); // the top of the arc, within the slack
    assert.equal(itemHit(memo('an-m', 0.5, 0.5), { x: 0.5, y: 0.5 }, slop), false);
  });

  test('outline: a rect or an ellipse counts on its ring only (5.5 px either side of the edge), its inside is empty', () => {
    const r = rect('an-r', 0.2, 0.2, 0.3, 0.2);
    assert.equal(itemHit(r, { x: 0.35, y: 0.3 }, slop, true), false); // the middle of the box
    assert.equal(itemHit(r, { x: 0.35, y: 0.3 }, slop), true); // ... which counts without `outline`
    assert.equal(itemHit(r, { x: 0.2, y: 0.3 }, slop, true), true); // on the left edge
    assert.equal(itemHit(r, { x: 0.204, y: 0.3 }, slop, true), true); // 4 px inside the edge
    assert.equal(itemHit(r, { x: 0.196, y: 0.3 }, slop, true), true); // 4 px outside
    assert.equal(itemHit(r, { x: 0.207, y: 0.3 }, slop, true), false); // 7 px inside: past the ring
    assert.equal(itemHit(r, { x: 0.35, y: 0.4 }, slop, true), true); // the bottom edge (ring.y = 9.2 px of 600)
    assert.equal(itemHit(r, { x: 0.35, y: 0.38 }, slop, true), false); // 12 px above it
    const e = ellipse('an-e', 0.2, 0.2, 0.4, 0.4);
    assert.equal(itemHit(e, { x: 0.4, y: 0.4 }, slop, true), false); // the centre
    assert.equal(itemHit(e, { x: 0.4, y: 0.2 }, slop, true), true); // the top of the arc
    assert.equal(itemHit(e, { x: 0.4, y: 0.203 }, slop, true), true); // just inside it
    assert.equal(itemHit(e, { x: 0.4, y: 0.23 }, slop, true), false); // 18 px inside
    // A shape thinner than its ring is all ring.
    assert.equal(itemHit(rect('an-thin', 0.2, 0.2, 0.005, 0.005), { x: 0.2025, y: 0.2025 }, slop, true), true);
    // Bands, text boxes and text highlights are hit inside whatever the flag says.
    assert.equal(itemHit(band('an-b', 0.2, 0.2, 0.3, 0.03), { x: 0.35, y: 0.215 }, slop, true), true);
    assert.equal(itemHit(textBox('an-x', 0.2, 0.2, 0.3, 0.1), { x: 0.35, y: 0.25 }, slop, true), true);
    assert.equal(itemHit(textHl('an-t', [{ x: 0.1, y: 0.1, w: 0.5, h: 0.03 }]), { x: 0.3, y: 0.115 }, slop, true), true);
  });

  test('a text highlight is hit only on one of its line rects (not in the gap between lines)', () => {
    const t = textHl('an-t', [
      { x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
      { x: 0.1, y: 0.2, w: 0.3, h: 0.03 },
    ]);
    assert.equal(itemHit(t, { x: 0.3, y: 0.115 }, none), true);
    assert.equal(itemHit(t, { x: 0.3, y: 0.215 }, none), true);
    assert.equal(itemHit(t, { x: 0.3, y: 0.16 }, none), false);
    assert.equal(itemHit(t, { x: 0.45, y: 0.215 }, none), false); // past the shorter second line
    assert.ok(Math.abs(itemArea(t) - (0.5 * 0.03 + 0.3 * 0.03)) < 1e-9);
  });

  test('areas: a rect, an ellipse (π/4 of its box), a memo counts nothing', () => {
    assert.ok(Math.abs(itemArea(rect('a', 0, 0, 0.5, 0.2)) - 0.1) < 1e-9);
    assert.ok(Math.abs(itemArea(ellipse('b', 0, 0, 0.5, 0.2)) - (Math.PI / 4) * 0.1) < 1e-9);
    assert.equal(itemArea(memo('c', 0.1, 0.1)), 0);
  });
});

describe('outlineOnly', () => {
  const r = rect('an-r', 0.2, 0.2, 0.3, 0.2);
  test('an unselected shape is ring-only in every state (no tool, 범위 선택, a drawing tool); only a selected one is not', () => {
    assert.equal(outlineOnly(null)(r), true);
    assert.equal(outlineOnly([])(r), true);
    assert.equal(outlineOnly(['an-other'])(r), true);
    assert.equal(outlineOnly(['an-r'])(r), false);
    assert.equal(outlineOnly(['an-other', 'an-r'])(r), false);
    // The rule is the same whatever the tool: the function takes only the selection.
    assert.equal(outlineOnly.length, 1);
  });
});

describe('hitTestItems', () => {
  const big = rect('an-big', 0.05, 0.05, 0.9, 0.9);
  const small = band('an-small', 0.3, 0.4, 0.2, 0.028);
  const tiny = rect('an-tiny', 0.35, 0.4, 0.05, 0.028);

  test('the smallest item under the press wins, whatever the z-order; empty area gives null', () => {
    // The big rect is drawn last (on top in the SVG) and would take the DOM event: the band inside it still wins.
    assert.equal(hitTestItems([small, big], { x: 0.4, y: 0.41 }, none)?.id, 'an-small');
    assert.equal(hitTestItems([big, small], { x: 0.4, y: 0.41 }, none)?.id, 'an-small');
    assert.equal(hitTestItems([big, small, tiny], { x: 0.37, y: 0.41 }, none)?.id, 'an-tiny');
    assert.equal(hitTestItems([big, small], { x: 0.4, y: 0.6 }, none)?.id, 'an-big');
    assert.equal(hitTestItems([big, small], { x: 0.02, y: 0.02 }, none), null);
    assert.equal(hitTestItems([], { x: 0.5, y: 0.5 }, slop), null);
  });

  test('equal areas: the topmost (later) item wins', () => {
    const a = rect('an-a', 0.1, 0.1, 0.2, 0.2);
    const b = rect('an-b', 0.15, 0.15, 0.2, 0.2);
    assert.equal(hitTestItems([a, b], { x: 0.2, y: 0.2 }, none)?.id, 'an-b');
    assert.equal(hitTestItems([b, a], { x: 0.2, y: 0.2 }, none)?.id, 'an-a');
  });

  test('a thin band is hit just outside its edge (the slack), a text box by its rect; memos are skipped', () => {
    assert.equal(hitTestItems([small], { x: 0.4, y: 0.4 - 0.005 }, slop)?.id, 'an-small'); // 3 px above (slop.y = 6.7 px)
    assert.equal(hitTestItems([small], { x: 0.4, y: 0.4 - 0.02 }, slop), null); // 12 px above
    const t = textBox('an-text', 0.6, 0.6, 0.18, 0.06);
    assert.equal(hitTestItems([t, memo('an-memo', 0.65, 0.62)], { x: 0.65, y: 0.62 }, none)?.id, 'an-text');
    assert.equal(hitTestItems([memo('an-memo', 0.65, 0.62)], { x: 0.65, y: 0.62 }, slop), null);
  });

  test('items not drawn right now (그때 필기 재생) are not hit', () => {
    const visible = (it: AnnotationItem) => it.id !== 'an-small';
    assert.equal(hitTestItems([big, small], { x: 0.4, y: 0.41 }, none, { visible })?.id, 'an-big');
  });

  test('a box around a paragraph, in every state: a press inside the box is empty area (it passes through), on its edge the box, on a band inside it the band', () => {
    const inside = { x: 0.5, y: 0.6 };
    for (const selected of [null, [], ['an-small']]) {
      assert.equal(hitTestItems([big, small], inside, slop, { outline: outlineOnly(selected) }), null);
      assert.equal(hitTestItems([big, small], { x: 0.05, y: 0.6 }, slop, { outline: outlineOnly(selected) })?.id, 'an-big');
      assert.equal(hitTestItems([big, small], { x: 0.4, y: 0.41 }, slop, { outline: outlineOnly(selected) })?.id, 'an-small');
    }
    // Selected (alone or in a group), the box is grabbed by its body again.
    assert.equal(hitTestItems([big, small], inside, slop, { outline: outlineOnly(['an-big']) })?.id, 'an-big');
    assert.equal(hitTestItems([big, small], inside, slop, { outline: outlineOnly(['an-small', 'an-big']) })?.id, 'an-big');
    // An ellipse the same way: its centre is empty, its arc is the item.
    const ring = ellipse('an-ring', 0.2, 0.2, 0.4, 0.4);
    assert.equal(hitTestItems([ring], { x: 0.4, y: 0.4 }, slop, { outline: outlineOnly(null) }), null);
    assert.equal(hitTestItems([ring], { x: 0.4, y: 0.2 }, slop, { outline: outlineOnly(null) })?.id, 'an-ring');
  });
});

describe('marquee (범위 선택)', () => {
  const big = rect('an-big', 0.05, 0.05, 0.9, 0.9);
  const small = band('an-small', 0.3, 0.4, 0.2, 0.028);
  const e = ellipse('an-e', 0.6, 0.6, 0.2, 0.2);
  const t = textHl('an-t', [
    { x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
    { x: 0.1, y: 0.2, w: 0.3, h: 0.03 },
  ]);
  const m = memo('an-m', 0.8, 0.1);

  test('rects intersect when they overlap; touching edges do not count', () => {
    assert.equal(rectsIntersect({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), true);
    assert.equal(rectsIntersect({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.2, h: 0.2 }), false);
    assert.equal(rectsIntersect({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }), false);
  });

  test('an item is crossed by its rect (a text highlight by any line rect, a memo by the box around its anchor)', () => {
    assert.equal(itemIntersects(small, { x: 0.45, y: 0.3, w: 0.1, h: 0.2 }), true);
    assert.equal(itemIntersects(small, { x: 0.45, y: 0.5, w: 0.1, h: 0.2 }), false);
    assert.equal(itemIntersects(e, { x: 0.75, y: 0.75, w: 0.1, h: 0.1 }), true); // the bounding box counts
    assert.equal(itemIntersects(t, { x: 0.2, y: 0.15, w: 0.05, h: 0.03 }), false); // the gap between the lines
    assert.equal(itemIntersects(t, { x: 0.2, y: 0.2, w: 0.05, h: 0.02 }), true);
    assert.equal(itemIntersects(m, { x: 0.85, y: 0.12, w: 0.05, h: 0.05 }), true); // inside the 12 % × 8 % anchor box
    assert.equal(itemIntersects(m, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }), false);
  });

  test('marqueeSelect: every item the rectangle crosses, in z-order; replay-hidden items skipped; empty for none', () => {
    const items = [big, small, e, t, m];
    assert.deepEqual(marqueeSelect(items, { x: 0.25, y: 0.35, w: 0.5, h: 0.4 }), ['an-big', 'an-small', 'an-e']);
    assert.deepEqual(marqueeSelect(items, { x: 0.25, y: 0.35, w: 0.5, h: 0.4 }, { visible: (it) => it.id !== 'an-small' }), ['an-big', 'an-e']);
    assert.deepEqual(marqueeSelect([small, e], { x: 0, y: 0, w: 0.01, h: 0.01 }), []);
    // A rectangle drawn over the whole slide takes everything, the memo included.
    assert.deepEqual(marqueeSelect(items, { x: 0, y: 0, w: 1, h: 1 }), ['an-big', 'an-small', 'an-e', 'an-t', 'an-m']);
  });

  test('a memo is crossed by its card as drawn when the viewer measured it (clamped inside the slide, far bigger than the anchor box), else by the anchor box', () => {
    // A memo anchored at (0.8, 0.9): CSS draws its 24 % × ~30 % card clamped to the slide's bottom-right corner.
    const corner = memo('an-c', 0.8, 0.9);
    const card = { x: 0.76, y: 0.7, w: 0.24, h: 0.3 };
    const lowerHalf = { x: 0.78, y: 0.88, w: 0.1, h: 0.1 };
    assert.equal(itemIntersects(corner, lowerHalf, card), true);
    assert.equal(itemIntersects(corner, lowerHalf), true, 'the anchor box happens to be there too');
    const upperHalf = { x: 0.78, y: 0.72, w: 0.1, h: 0.05 }; // over the drawn card, above the anchor box (0.8–0.92 × 0.9–0.98 clamped)
    assert.equal(itemIntersects(corner, upperHalf, card), true);
    assert.equal(itemIntersects(corner, upperHalf), false);
    assert.deepEqual(marqueeSelect([big, corner], upperHalf, { boxOf: (it) => (it.id === 'an-c' ? card : null) }), ['an-big', 'an-c']);
    assert.deepEqual(marqueeSelect([big, corner], upperHalf), ['an-big']);
    // A measurement that is missing (null / undefined) falls back to the anchor box; other items ignore boxOf.
    assert.deepEqual(marqueeSelect([small, corner], { x: 0.85, y: 0.92, w: 0.05, h: 0.05 }, { boxOf: () => undefined }), ['an-c']);
    assert.deepEqual(marqueeSelect([small], { x: 0.45, y: 0.3, w: 0.1, h: 0.2 }, { boxOf: () => ({ x: 0, y: 0, w: 0.01, h: 0.01 }) }), [], 'a text highlight / shape is still hit by its own geometry — boxOf is for memos; a box given is used as given');
  });

  test('Shift+click toggles one id; Shift+drag adds without duplicates, keeping the order first seen', () => {
    assert.deepEqual(toggleId([], 'a'), ['a']);
    assert.deepEqual(toggleId(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(toggleId(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(unionIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
    assert.deepEqual(unionIds([], ['x']), ['x']);
  });
});

describe('pressPlan', () => {
  const r = rect('an-r', 0.2, 0.2, 0.3, 0.2);
  const t = textHl('an-t', [{ x: 0.1, y: 0.1, w: 0.5, h: 0.03 }]);
  const m = memo('an-m', 0.5, 0.5);
  const other = { kind: 'other' } as const;

  test('the default state (no tool): empty area is the region (첨부) gesture (Shift or not), an item is selected and moved', () => {
    assert.deepEqual(pressPlan({ tool: 'select', target: other, item: null, selected: false, touch: false }), { kind: 'region' });
    assert.deepEqual(pressPlan({ tool: 'select', target: other, item: null, selected: false, touch: false, shift: true }), { kind: 'region' });
    assert.deepEqual(pressPlan({ tool: 'select', target: other, item: r, selected: false, touch: false }), { kind: 'select', item: r, move: true });
    // Part of a selection already: selected again (the viewer then moves the whole group from here).
    assert.deepEqual(pressPlan({ tool: 'select', target: other, item: r, selected: true, touch: false }), { kind: 'select', item: r, move: true });
  });

  test('범위 선택: empty area drags a marquee (Shift adds to the selection; live at once on touch), an item is selected like with any tool', () => {
    assert.deepEqual(pressPlan({ tool: 'marquee', target: other, item: null, selected: false, touch: false }), { kind: 'marquee', add: false, immediate: false });
    assert.deepEqual(pressPlan({ tool: 'marquee', target: other, item: null, selected: false, touch: false, shift: true }), { kind: 'marquee', add: true, immediate: false });
    assert.deepEqual(pressPlan({ tool: 'marquee', target: other, item: null, selected: false, touch: true }), { kind: 'marquee', add: false, immediate: true });
    assert.deepEqual(pressPlan({ tool: 'marquee', target: other, item: r, selected: false, touch: false }), { kind: 'select', item: r, move: true });
  });

  test('Shift+click on an item toggles it in and out of the selection, in every state, and never moves it', () => {
    for (const tool of ['select', 'marquee', 'highlight', 'textHighlight', 'rect', 'memo'] as const) {
      assert.deepEqual(pressPlan({ tool, target: other, item: r, selected: false, touch: false, shift: true }), { kind: 'toggle', item: r });
      assert.deepEqual(pressPlan({ tool, target: other, item: r, selected: true, touch: false, shift: true }), { kind: 'toggle', item: r });
    }
    // A text highlight too (Shift beats the re-drag of 텍스트 형광), and on touch.
    assert.deepEqual(pressPlan({ tool: 'textHighlight', target: other, item: t, selected: false, touch: false, shift: true }), { kind: 'toggle', item: t });
    assert.deepEqual(pressPlan({ tool: 'rect', target: other, item: r, selected: false, touch: true, shift: true }), { kind: 'toggle', item: r });
    // Shift on empty area with a drawing tool still draws.
    assert.deepEqual(pressPlan({ tool: 'rect', target: other, item: null, selected: false, touch: false, shift: true }), { kind: 'draw', tool: 'rect', immediate: false });
  });

  test('with ANY drawing tool an item under the press is selected (and movable), never drawn over', () => {
    for (const tool of ['highlight', 'textHighlight', 'rect', 'ellipse', 'text', 'memo'] as const) {
      assert.deepEqual(pressPlan({ tool, target: other, item: r, selected: false, touch: false }), { kind: 'select', item: r, move: true });
      assert.deepEqual(pressPlan({ tool, target: other, item: r, selected: true, touch: false }), { kind: 'select', item: r, move: true });
    }
  });

  test('empty area with a tool draws: drag tools wait for the drag threshold, click tools and touch are live at once', () => {
    assert.deepEqual(pressPlan({ tool: 'rect', target: other, item: null, selected: false, touch: false }), { kind: 'draw', tool: 'rect', immediate: false });
    assert.deepEqual(pressPlan({ tool: 'highlight', target: other, item: null, selected: false, touch: false }), { kind: 'draw', tool: 'highlight', immediate: false });
    assert.deepEqual(pressPlan({ tool: 'text', target: other, item: null, selected: false, touch: false }), { kind: 'draw', tool: 'text', immediate: true });
    assert.deepEqual(pressPlan({ tool: 'memo', target: other, item: null, selected: false, touch: false }), { kind: 'draw', tool: 'memo', immediate: true });
    assert.deepEqual(pressPlan({ tool: 'ellipse', target: other, item: null, selected: false, touch: true }), { kind: 'draw', tool: 'ellipse', immediate: true });
  });

  test('a text highlight is selected but never moved; under 텍스트 형광 it is re-dragged (live at once on touch)', () => {
    assert.deepEqual(pressPlan({ tool: 'select', target: other, item: t, selected: false, touch: false }), { kind: 'select', item: t, move: false });
    assert.deepEqual(pressPlan({ tool: 'highlight', target: other, item: t, selected: true, touch: false }), { kind: 'select', item: t, move: false });
    assert.deepEqual(pressPlan({ tool: 'textHighlight', target: other, item: t, selected: false, touch: false }), { kind: 'redraw', item: t, immediate: false });
    assert.deepEqual(pressPlan({ tool: 'textHighlight', target: other, item: t, selected: true, touch: true }), { kind: 'redraw', item: t, immediate: true });
    // Only a text highlight: 텍스트 형광 on a band or a box selects it like any tool.
    assert.deepEqual(pressPlan({ tool: 'textHighlight', target: other, item: r, selected: false, touch: false }), { kind: 'select', item: r, move: true });
  });

  test('on touch an unselected item is only selected first (a finger can still scroll)', () => {
    assert.deepEqual(pressPlan({ tool: 'rect', target: other, item: r, selected: false, touch: true }), { kind: 'select', item: r, move: false });
    assert.deepEqual(pressPlan({ tool: 'rect', target: other, item: r, selected: true, touch: true }), { kind: 'select', item: r, move: true });
  });

  test('handles resize their item (not a memo or a text highlight); markers are left to their own button', () => {
    assert.deepEqual(pressPlan({ tool: 'memo', target: { kind: 'handle', handle: 'se' }, item: r, selected: true, touch: false }), { kind: 'resize', item: r, handle: 'se' });
    assert.deepEqual(pressPlan({ tool: 'select', target: { kind: 'handle', handle: 'e' }, item: t, selected: true, touch: false }), { kind: 'ignore' });
    assert.deepEqual(pressPlan({ tool: 'select', target: { kind: 'handle', handle: 'e' }, item: m, selected: true, touch: false }), { kind: 'ignore' });
    assert.deepEqual(pressPlan({ tool: 'select', target: { kind: 'handle', handle: 'e' }, item: null, selected: false, touch: false }), { kind: 'ignore' });
    assert.deepEqual(pressPlan({ tool: 'rect', target: { kind: 'marker' }, item: r, selected: false, touch: false }), { kind: 'ignore' });
    assert.equal(canResize(r), true);
    assert.equal(canResize(t), false);
    assert.equal(canResize(m), false);
  });
});
