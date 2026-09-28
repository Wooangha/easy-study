// 녹음 tab playback speed (DESIGN §22): how the tick marks draw a dragged thumb onto them, the rate it sets,
// arrow-key steps that never get stuck on a mark, the typed rate, and the stored value.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAGNET_HOLD,
  MAGNET_REACH,
  MAX_RATE,
  MIN_RATE,
  SNAP_RATES,
  clampRate,
  dragRate,
  formatRate,
  isPlaybackRate,
  nextSnapRate,
  parseRate,
  pullToMark,
  rateAt,
  rateFraction,
  stepRate,
} from '../src/lib/recording/rate.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** A slow drag across a rail `travel` px long, `step` px at a time: where the thumb is drawn and the rate it sets. */
function sweep(travel: number, step: number): { x: number; pos: number; rate: number }[] {
  const out = [];
  for (let x = 0; x <= travel + 1e-9; x += step) {
    const pos = pullToMark(rateAt(x / travel));
    out.push({ x, pos, rate: dragRate(pos) });
  }
  return out;
}

describe('playback speed slider', () => {
  test('a dragged thumb is held on a tick mark close to it, drawn in a little further out, free in between', () => {
    assert.equal(pullToMark(1.5), 1.5);
    assert.equal(pullToMark(1.47), 1.5, 'held');
    assert.equal(pullToMark(1.5 + MAGNET_HOLD), 1.5, 'held up to MAGNET_HOLD');
    assert.equal(pullToMark(0.88), 0.88, 'free past MAGNET_REACH');
    assert.ok(near(pullToMark(0.93), 0.95), 'drawn in: 0.07 from 1 → 0.05');
    assert.equal(pullToMark(1.5 + MAGNET_REACH), 1.5 + MAGNET_REACH, 'caught up with the pointer at the reach');
    assert.ok(near(pullToMark(1.5 + (MAGNET_HOLD + MAGNET_REACH) / 2), 1.5 + MAGNET_REACH / 2), 'drawn in: halfway');
    assert.ok(near(pullToMark(1.5 - (MAGNET_HOLD + MAGNET_REACH) / 2), 1.5 - MAGNET_REACH / 2), 'on either side');
    assert.equal(pullToMark(1.125), 1.125, 'halfway between two marks');
    assert.equal(pullToMark(2.25), 2.25);
    assert.equal(pullToMark(0.52), 0.5, 'the ends are marks too');
    assert.equal(pullToMark(0.1), 0.5);
    assert.equal(pullToMark(7), 3);
    assert.equal(pullToMark(Number.NaN), 1);
    assert.ok(MAGNET_REACH < 0.125, 'the pulls of two marks 0.25 apart do not meet');
  });

  test('the rate follows the thumb in 0.05 steps; a held mark is its own rate', () => {
    assert.equal(dragRate(1.5), 1.5);
    assert.equal(dragRate(1.23), 1.25);
    assert.equal(dragRate(1.274), 1.25);
    assert.equal(dragRate(1.276), 1.3);
    assert.equal(dragRate(1.1249), 1.1);
    assert.equal(dragRate(2.2), 2.2);
    assert.equal(dragRate(0.5), 0.5);
    assert.equal(dragRate(3.2), 3);
    assert.equal(dragRate(Number.NaN), 1);
    for (let c = 50; c <= 300; c += 5) assert.equal(dragRate(c / 100), c / 100, `${c / 100} stays`);
  });

  test('a place on the rail → the rate there (the inverse of rateFraction)', () => {
    assert.equal(rateAt(0), MIN_RATE);
    assert.equal(rateAt(1), MAX_RATE);
    assert.equal(rateAt(0.2), 1);
    for (const mark of SNAP_RATES) assert.ok(near(rateAt(rateFraction(mark)), mark));
  });

  test('a slow drag: the thumb never jumps, every mark catches it, every 0.05 step is reachable', () => {
    // The bubble's slider has 222px of travel (264 − 2 border − 24 padding − 16 thumb); narrower windows shrink it,
    // and a wider one would not hurt.
    for (const travel of [140, 180, 222, 260, 400]) {
      const px = (MAX_RATE - MIN_RATE) / travel;
      // Sub-pixel steps (a trackpad, a high-density screen) and whole pixels (a mouse on a 1x screen).
      for (const step of [0.25, 1]) {
        const drag = sweep(travel, step);
        const slope = MAGNET_REACH / (MAGNET_REACH - MAGNET_HOLD);
        for (let i = 1; i < drag.length; i++) {
          const moved = drag[i].pos - drag[i - 1].pos;
          assert.ok(moved >= -1e-9, `${travel}px: the thumb goes one way (${drag[i].x}px)`);
          assert.ok(moved <= slope * step * px + 1e-9, `${travel}px: no jump at ${drag[i].x}px (${moved}×)`);
        }
        const rates = new Set(drag.map((d) => d.rate));
        for (let c = 50; c <= 300; c += 5) assert.ok(rates.has(c / 100), `${c / 100} on a ${travel}px rail, ${step}px steps`);
        for (const mark of SNAP_RATES) {
          const held = drag.filter((d) => d.pos === mark).length * step;
          const ends = mark === MIN_RATE || mark === MAX_RATE ? 1 : 2;
          assert.ok(held >= (ends * MAGNET_HOLD) / px - 2 * step, `${mark} holds the thumb for ${held}px of ${travel}`);
        }
      }
    }
  });

  test('arrow keys move by 0.05 through the marks (no snapping), from a typed rate to the step next to it', () => {
    assert.equal(stepRate(1, 1), 1.05);
    assert.equal(stepRate(1.05, -1), 1);
    assert.equal(stepRate(1, -1), 0.95);
    assert.equal(stepRate(1.25, 1), 1.3, 'leaves a mark');
    assert.equal(stepRate(1.33, 1), 1.35);
    assert.equal(stepRate(1.33, -1), 1.3);
    assert.equal(stepRate(3, 1), 3);
    assert.equal(stepRate(0.5, -1), 0.5);
    let r = 0.5;
    for (let i = 0; i < 50; i++) r = stepRate(r, 1);
    assert.equal(r, 3, 'fifty steps cover the range exactly');
  });

  test('PageUp / PageDown jump to the next tick mark', () => {
    assert.equal(nextSnapRate(1, 1), 1.25);
    assert.equal(nextSnapRate(1.33, 1), 1.5);
    assert.equal(nextSnapRate(1.33, -1), 1.25);
    assert.equal(nextSnapRate(2, 1), 2.5);
    assert.equal(nextSnapRate(3, 1), 3);
    assert.equal(nextSnapRate(0.5, -1), 0.5);
  });

  test('tick marks: where they sit on the track', () => {
    assert.deepEqual([...SNAP_RATES], [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
    assert.equal(rateFraction(0.5), 0);
    assert.equal(rateFraction(1), 0.2);
    assert.equal(rateFraction(3), 1);
    assert.equal(rateFraction(9), 1);
  });
});

describe('typed playback speed', () => {
  test('plain numbers, with a × / x / 배 suffix or a decimal comma; more than 2 decimals are rounded', () => {
    assert.equal(parseRate('1.33'), 1.33);
    assert.equal(parseRate(' 1.25× '), 1.25);
    assert.equal(parseRate('2x'), 2);
    assert.equal(parseRate('1.5 배속'), 1.5);
    assert.equal(parseRate('1,5'), 1.5);
    assert.equal(parseRate('.75'), 0.75);
    assert.equal(parseRate('2.'), 2);
    assert.equal(parseRate('1.333'), 1.33);
    assert.equal(parseRate('1.337'), 1.34);
    assert.equal(parseRate('1.005'), 1.01, 'half a hundredth rounds up, not down by float error');
    assert.equal(parseRate('1.255'), 1.26);
    assert.equal(parseRate('0.285'), 0.29);
    assert.equal(parseRate('2.675'), 2.68);
  });

  test('not a number → null (the rate stays); out of range is left to clampRate', () => {
    for (const bad of ['', ' ', 'abc', '-1', '1.2.3', '1e1', '0x2', '.', '1..5', 'x']) assert.equal(parseRate(bad), null, bad);
    assert.equal(parseRate('9'), 9);
    assert.equal(clampRate(9), 3);
    assert.equal(clampRate(0), 0.5);
    assert.equal(clampRate(1.33), 1.33);
  });

  test('shown without trailing zeros', () => {
    assert.equal(formatRate(1), '1');
    assert.equal(formatRate(1.5), '1.5');
    assert.equal(formatRate(1.25), '1.25');
    assert.equal(formatRate(0.75), '0.75');
    assert.equal(formatRate(1.1 + 0.2), '1.3');
  });

  test('any rate in range is stored and restored, not only the tick marks', () => {
    assert.ok(isPlaybackRate(1.33));
    assert.ok(isPlaybackRate(0.5));
    assert.ok(isPlaybackRate(3));
    assert.ok(isPlaybackRate(0.75), 'a rate stored by the old menu');
    assert.ok(!isPlaybackRate(3.5));
    assert.ok(!isPlaybackRate(0.25));
    assert.ok(!isPlaybackRate('1.5'));
    assert.ok(!isPlaybackRate(Number.NaN));
    assert.ok(!isPlaybackRate(null));
  });
});
