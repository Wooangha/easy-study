// What a press on a slide does (DESIGN §25, lib/annotations/gesture.ts): hit-testing the items under the pointer
// (the smallest wins, slack for thin bands, ellipses by their shape, text highlights by their line rects, memos never,
// replay-hidden items never; with a drawing tool an unselected rect / ellipse on its outline ring only) and the press
// plan — items first with any tool, a text highlight re-dragged under its own tool, handles, markers, drawing only on
// empty area, the region gesture in the default state. Run: node --test web/tests/*.test.ts
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
  outlineOnly,
  pressPlan,
  slopFor,
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
  test('with a drawing tool an unselected shape is ring-only; the selected one, and everything in the default state, is not', () => {
    assert.equal(outlineOnly('highlight', null)(r), true);
    assert.equal(outlineOnly('rect', 'an-other')(r), true);
    assert.equal(outlineOnly('rect', 'an-r')(r), false);
    assert.equal(outlineOnly('select', null)(r), false);
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

  test('a box around a paragraph, 형광펜 in hand: a press inside the box is empty area, on its edge the box, on a band inside it the band', () => {
    const inside = { x: 0.5, y: 0.6 };
    assert.equal(hitTestItems([big, small], inside, slop, { outline: outlineOnly('highlight', null) }), null);
    assert.equal(hitTestItems([big, small], { x: 0.05, y: 0.6 }, slop, { outline: outlineOnly('highlight', null) })?.id, 'an-big');
    assert.equal(hitTestItems([big, small], { x: 0.4, y: 0.41 }, slop, { outline: outlineOnly('highlight', null) })?.id, 'an-small');
    // Selected, the box is grabbed by its body again; in the default state it always is.
    assert.equal(hitTestItems([big, small], inside, slop, { outline: outlineOnly('highlight', 'an-big') })?.id, 'an-big');
    assert.equal(hitTestItems([big, small], inside, slop, { outline: outlineOnly('select', null) })?.id, 'an-big');
  });
});

describe('pressPlan', () => {
  const r = rect('an-r', 0.2, 0.2, 0.3, 0.2);
  const t = textHl('an-t', [{ x: 0.1, y: 0.1, w: 0.5, h: 0.03 }]);
  const m = memo('an-m', 0.5, 0.5);
  const other = { kind: 'other' } as const;

  test('the default state (no tool): empty area is the region (첨부) gesture, an item is selected and moved', () => {
    assert.deepEqual(pressPlan({ tool: 'select', target: other, item: null, selected: false, touch: false }), { kind: 'region' });
    assert.deepEqual(pressPlan({ tool: 'select', target: other, item: r, selected: false, touch: false }), { kind: 'select', item: r, move: true });
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
