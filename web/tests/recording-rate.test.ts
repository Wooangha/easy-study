// 녹음 tab playback speed (DESIGN §22): the 0.5×–3× slider's tick marks a dragged value sticks to, arrow-key
// steps that never get stuck on a mark, the typed rate, and the stored value.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_RATE,
  MAX_SNAP,
  MIN_RATE,
  SNAP_PX,
  SNAP_RATES,
  SNAP_THRESHOLD,
  clampRate,
  formatRate,
  isPlaybackRate,
  nextSnapRate,
  parseRate,
  rateFraction,
  snapDraggedRate,
  snapThreshold,
  stepRate,
} from '../src/lib/recording/rate.ts';

describe('playback speed slider', () => {
  test('a dragged value near a tick mark sticks to it; elsewhere it lands on a 0.05 step', () => {
    assert.equal(snapDraggedRate(1.47, 0.08), 1.5);
    assert.equal(snapDraggedRate(1.58, 0.08), 1.5);
    assert.equal(snapDraggedRate(1.17, 0.08), 1.25);
    assert.equal(snapDraggedRate(0.93, 0.08), 1);
    assert.equal(snapDraggedRate(2.42, 0.08), 2.5);
    assert.equal(snapDraggedRate(1.3, 0.08), 1.25, 'the step next to a mark is typed');
    assert.equal(snapDraggedRate(1.12, 0.08), 1.1, 'halfway between two marks');
    assert.equal(snapDraggedRate(1.13, 0.08), 1.15);
    assert.equal(snapDraggedRate(2.2, 0.08), 2.2);
    assert.equal(snapDraggedRate(1.3, 0), 1.3, 'no pull: plain steps');
    assert.equal(snapDraggedRate(1.28), 1.25, 'SNAP_THRESHOLD before the slider is measured');
    assert.equal(snapDraggedRate(0.1), 0.5);
    assert.equal(snapDraggedRate(7), 3);
    assert.equal(snapDraggedRate(Number.NaN), 1);
  });

  test('a mark pulls SNAP_PX of track on either side, at most MAX_SNAP', () => {
    assert.equal(snapThreshold(127), MAX_SNAP, 'the usual player slider (141px, the thumb 14px)');
    assert.equal(snapThreshold(167), 0.07, 'the widest one (181px)');
    assert.equal(snapThreshold(400), 0.03);
    assert.equal(snapThreshold(0), SNAP_THRESHOLD, 'not measured');
  });

  test('dragged pixel by pixel: every mark catches the thumb, and every gap between marks keeps a step to drag to', () => {
    // The input's value at a pointer position: the fraction of the thumb's travel, in the slider's hundredths.
    const range = Math.round((MAX_RATE - MIN_RATE) * 100);
    for (let travel = 100; travel <= 400; travel++) {
      const threshold = snapThreshold(travel);
      const hits = new Map<number, number>();
      for (let x = 0; x <= travel; x++) {
        const rate = snapDraggedRate(MIN_RATE + Math.round((x / travel) * range) / 100, threshold);
        hits.set(rate, (hits.get(rate) ?? 0) + 1);
      }
      const pull = Math.min(SNAP_PX, (MAX_SNAP * travel) / (MAX_RATE - MIN_RATE));
      for (const mark of SNAP_RATES.slice(1, -1)) {
        assert.ok((hits.get(mark) ?? 0) >= 2 * pull - 2, `${mark} on a ${travel}px track: ${hits.get(mark)}px`);
      }
      for (let i = 1; i < SNAP_RATES.length; i++) {
        const between = [...hits.keys()].filter((r) => r > SNAP_RATES[i - 1] && r < SNAP_RATES[i]);
        assert.ok(between.length > 0, `a step between ${SNAP_RATES[i - 1]} and ${SNAP_RATES[i]} on a ${travel}px track`);
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
