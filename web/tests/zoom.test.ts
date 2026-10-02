// The slide viewer's zoom (lib/zoom.ts): any value in the range (stored, clamped, snapped to 맞춤), the − / ＋ buttons
// stepping from a zoom between two levels, a pinch's factor (its slop, no jump), the Ctrl+wheel factor, and the scroll
// that keeps the point of a slide under the fingers / the pointer.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PINCH_SLOP_PX,
  ZOOM_LEVELS,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_SNAP,
  anchorIn,
  anchorScroll,
  boxIndexAt,
  clampZoom,
  pinchBegan,
  pinchScale,
  snapZoom,
  stepZoom,
  storedZoom,
  touchDistance,
  touchMidpoint,
  wheelZoom,
  wheelZoomFactor,
  zoomPercent,
  type ZoomBox,
} from '../src/lib/zoom.ts';

const near = (actual: number, expected: number, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≈ ${expected}`);

describe('the zoom range', () => {
  test('the levels go from 50 % to 400 %, in order, with 맞춤 among them', () => {
    assert.equal(ZOOM_MIN, 0.5);
    assert.equal(ZOOM_MAX, 4);
    assert.ok(ZOOM_LEVELS.includes(1));
    assert.deepEqual([...ZOOM_LEVELS].sort((a, b) => a - b), [...ZOOM_LEVELS]);
  });

  test('clampZoom keeps any value in the range, with three decimals; not a number is 맞춤', () => {
    assert.equal(clampZoom(1.37), 1.37);
    assert.equal(clampZoom(1.23456), 1.235);
    assert.equal(clampZoom(0.1), 0.5);
    assert.equal(clampZoom(9), 4);
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
  });

  test('snapZoom makes a zoom next to 맞춤 맞춤, and nothing else', () => {
    assert.equal(snapZoom(1 + ZOOM_SNAP * 0.9), 1);
    assert.equal(snapZoom(1 - ZOOM_SNAP * 0.9), 1);
    assert.equal(snapZoom(0.98), 1);
    assert.equal(snapZoom(1.05), 1.05);
    assert.equal(snapZoom(0.95), 0.95);
    assert.equal(snapZoom(2.01), 2.01, 'the other levels do not snap');
    assert.equal(snapZoom(7), 4);
  });

  test('storedZoom accepts any number in the range (what a pinch ended on), else 맞춤', () => {
    assert.equal(storedZoom(1.37), 1.37);
    assert.equal(storedZoom(0.5), 0.5);
    assert.equal(storedZoom(4), 4);
    assert.equal(storedZoom(3), 3, 'a level stored by an older version');
    assert.equal(storedZoom(4.5), 1);
    assert.equal(storedZoom(0.2), 1);
    assert.equal(storedZoom('2'), 1);
    assert.equal(storedZoom(null), 1);
    assert.equal(storedZoom(Number.NaN), 1);
  });

  test('zoomPercent', () => {
    assert.equal(zoomPercent(1.25), '125%');
    assert.equal(zoomPercent(0.667), '67%');
    assert.equal(zoomPercent(4), '400%');
  });
});

describe('stepZoom: the − / ＋ buttons', () => {
  test('from a level: the next level', () => {
    assert.equal(stepZoom(1, 1), 1.25);
    assert.equal(stepZoom(1, -1), 0.8);
    assert.equal(stepZoom(3, 1), 4);
    assert.equal(stepZoom(0.67, -1), 0.5);
    // Every level, both ways.
    for (let i = 0; i < ZOOM_LEVELS.length - 1; i++) {
      assert.equal(stepZoom(ZOOM_LEVELS[i], 1), ZOOM_LEVELS[i + 1]);
      assert.equal(stepZoom(ZOOM_LEVELS[i + 1], -1), ZOOM_LEVELS[i]);
    }
  });

  test('from a zoom between two levels (after a pinch): the level above / below it', () => {
    assert.equal(stepZoom(1.37, 1), 1.5);
    assert.equal(stepZoom(1.37, -1), 1.25);
    assert.equal(stepZoom(0.6, 1), 0.67);
    assert.equal(stepZoom(0.6, -1), 0.5);
    assert.equal(stepZoom(3.4, 1), 4);
    assert.equal(stepZoom(3.4, -1), 3);
  });

  test('a zoom a hair off a level steps past it, not onto it', () => {
    assert.equal(stepZoom(1.249, 1), 1.5);
    assert.equal(stepZoom(1.251, -1), 1);
  });

  test('at the ends of the range the zoom stays (the button is disabled); just short of an end it reaches it', () => {
    assert.equal(stepZoom(4, 1), 4);
    assert.equal(stepZoom(0.5, -1), 0.5);
    assert.equal(stepZoom(3.995, 1), 4);
    assert.equal(stepZoom(0.505, -1), 0.5);
    assert.equal(stepZoom(99, 1), 4);
    assert.equal(stepZoom(0, -1), 0.5);
  });
});

describe('a pinch', () => {
  test('distance and midpoint of two fingers', () => {
    assert.equal(touchDistance({ x: 0, y: 0 }, { x: 30, y: 40 }), 50);
    assert.deepEqual(touchMidpoint({ x: 100, y: 200 }, { x: 300, y: 100 }), { x: 200, y: 150 });
  });

  test('pinchBegan: nothing moves until the distance or the midpoint moved past the slop (a resting hand)', () => {
    const a = { x: 100, y: 300 };
    const b = { x: 200, y: 300 };
    assert.equal(pinchBegan(a, b, a, b), false);
    assert.equal(pinchBegan(a, b, { x: 97, y: 302 }, { x: 203, y: 299 }), false, 'a few px of jitter');
    assert.equal(pinchBegan(a, b, { x: 90, y: 300 }, { x: 210, y: 300 }), true, 'apart: the distance grew by 20');
    assert.equal(pinchBegan(a, b, { x: 108, y: 300 }, { x: 192, y: 300 }), true, 'together');
    assert.equal(pinchBegan(a, b, { x: 100, y: 315 }, { x: 200, y: 315 }), true, 'both down by 15: a pan');
    assert.equal(pinchBegan(a, b, { x: 100, y: 300 + PINCH_SLOP_PX }, { x: 200, y: 300 + PINCH_SLOP_PX }), false, 'exactly the slop');
  });

  test('within the slop the zoom does not change: two fingers that scroll, a resting hand', () => {
    assert.equal(pinchScale(200, 200), 1);
    assert.equal(pinchScale(200, 200 + PINCH_SLOP_PX), 1);
    assert.equal(pinchScale(200, 200 - PINCH_SLOP_PX), 1);
  });

  test('past the slop it grows from 1 without a jump, by the change of the distance', () => {
    near(pinchScale(200, 200 + PINCH_SLOP_PX + 0.001), 1, 1e-4);
    near(pinchScale(200, 200 - PINCH_SLOP_PX - 0.001), 1, 1e-4);
    near(pinchScale(200, 410), 2);
    near(pinchScale(200, 90), 0.5);
    assert.ok(pinchScale(200, 300) > pinchScale(200, 250));
    assert.ok(pinchScale(200, 100) < pinchScale(200, 150));
  });

  test('fingers that start almost together do not make a huge factor, and it is never negative', () => {
    assert.ok(pinchScale(2, 60) < 4);
    assert.equal(pinchScale(200, 0, 0), 0);
    assert.ok(pinchScale(300, 0) >= 0);
  });
});

describe('Ctrl+wheel', () => {
  test('up zooms in, down zooms out, by the same factor back', () => {
    assert.ok(wheelZoomFactor(-5) > 1);
    assert.ok(wheelZoomFactor(5) < 1);
    near(wheelZoomFactor(-5) * wheelZoomFactor(5), 1);
    assert.equal(wheelZoomFactor(0), 1);
    assert.equal(wheelZoomFactor(Number.NaN), 1);
  });

  test("a trackpad pinch's small deltas add up like the browser's own pinch (exp(-Δ/100))", () => {
    near(wheelZoomFactor(-2) ** 10, Math.exp(0.2));
  });

  test("a mouse wheel's notch is one step, in pixels, lines or pages", () => {
    const notch = wheelZoomFactor(-100);
    assert.ok(notch > 1.2 && notch < 1.35);
    assert.equal(wheelZoomFactor(-3, 1), notch);
    assert.equal(wheelZoomFactor(-1, 2), notch);
    near(wheelZoomFactor(100), 1 / notch);
  });

  test('wheelZoom carries the unrounded zoom on, inside the range: small steps leave the snap of 맞춤', () => {
    let z = 1;
    for (let i = 0; i < 10; i++) {
      z = wheelZoom(z, -1);
      assert.ok(z > 1);
    }
    assert.equal(snapZoom(wheelZoom(1, -1)), 1, 'one small step still shows 맞춤');
    assert.ok(snapZoom(z) > 1, 'ten of them do not');
    assert.equal(wheelZoom(4, -100), 4);
    assert.equal(wheelZoom(0.5, 100), 0.5);
  });
});

describe('keeping a point of a slide in place', () => {
  const slide: ZoomBox = { left: 100, top: 300, width: 800, height: 450 };

  test('anchorIn: where a point lies in the slide, as fractions (outside it too)', () => {
    assert.deepEqual(anchorIn(slide, { x: 300, y: 525 }), { x: 0.25, y: 0.5 });
    assert.deepEqual(anchorIn(slide, { x: 100, y: 300 }), { x: 0, y: 0 });
    // In the gap above the slide: a little below 0.
    assert.ok(anchorIn(slide, { x: 500, y: 291 }).y < 0);
    assert.deepEqual(anchorIn({ left: 0, top: 0, width: 0, height: 0 }, { x: 5, y: 5 }), { x: 0, y: 0 });
  });

  test('anchorScroll: nothing to scroll while the slide has not changed', () => {
    const at = { x: 300, y: 525 };
    assert.deepEqual(anchorScroll(slide, anchorIn(slide, at), at), { x: 0, y: 0 });
  });

  test('anchorScroll: after a zoom the same point comes back under the fingers', () => {
    const at = { x: 300, y: 525 };
    const anchor = anchorIn(slide, at);
    // Zoomed ×2: the track grew to the right and down, and the slides above pushed this one down.
    const zoomed: ZoomBox = { left: 100, top: 900, width: 1600, height: 900 };
    const by = anchorScroll(zoomed, anchor, at);
    assert.deepEqual(by, { x: 200, y: 825 });
    // Scrolling by it moves the box the other way: the anchored point is under `at` again.
    const scrolled: ZoomBox = { ...zoomed, left: zoomed.left - by.x, top: zoomed.top - by.y };
    assert.deepEqual(anchorScroll(scrolled, anchor, at), { x: 0, y: 0 });
    assert.deepEqual(anchorIn(scrolled, at), anchor);
  });

  test('anchorScroll: the midpoint moved (two fingers together): the slide pans with it', () => {
    const anchor = anchorIn(slide, { x: 300, y: 525 });
    assert.deepEqual(anchorScroll(slide, anchor, { x: 340, y: 500 }), { x: -40, y: 25 });
  });

  test('boxIndexAt: the slide under a y, the next one below a gap, the last one past the end', () => {
    // Three slides 100 px tall with 18 px gaps, the first at y 50.
    const bottoms = [150, 268, 386];
    const bottomOf = (i: number) => bottoms[i] ?? null;
    assert.equal(boxIndexAt(3, bottomOf, 0), 0);
    assert.equal(boxIndexAt(3, bottomOf, 100), 0);
    assert.equal(boxIndexAt(3, bottomOf, 150), 0);
    assert.equal(boxIndexAt(3, bottomOf, 160), 1, 'in the gap: the slide below it');
    assert.equal(boxIndexAt(3, bottomOf, 300), 2);
    assert.equal(boxIndexAt(3, bottomOf, 999), 2);
    assert.equal(boxIndexAt(0, bottomOf, 10), -1);
    assert.equal(boxIndexAt(3, () => null, 10), -1, 'a slide that is not mounted yet');
  });
});
