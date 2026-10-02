// The pure parts of the split pane (web/src/lib/splitPane.ts) and what styles.css must agree on.
// Run: node --test web/tests/split-pane.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clampRatio,
  grabOffset,
  isDoubleTap,
  ratioFromKey,
  ratioFromPointer,
  SPLIT_RANGE,
  STACKED_QUERY,
  tapSlop,
} from '../src/lib/splitPane.ts';
import { storageKeys } from '../src/lib/storage.ts';

const near = (actual: number | null, expected: number) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
};

/** A 1000 × 600 container at (100, 50). */
const container = { left: 100, top: 50, width: 1000, height: 600 };
const at = (clientX: number, clientY: number) => ({ clientX, clientY });

describe('clampRatio', () => {
  test('each layout has its own default and limits', () => {
    assert.deepEqual(SPLIT_RANGE.row, { def: 0.58, min: 0.25, max: 0.8 });
    assert.deepEqual(SPLIT_RANGE.stacked, { def: 0.46, min: 0.2, max: 0.8 });
    assert.equal(clampRatio('row', 0.5), 0.5);
    assert.equal(clampRatio('row', 0.1), 0.25);
    assert.equal(clampRatio('row', 2), 0.8);
    assert.equal(clampRatio('stacked', 0.22), 0.22);
    assert.equal(clampRatio('stacked', -1), 0.2);
    assert.equal(clampRatio('stacked', 0.95), 0.8);
  });

  test('a value that is not a number becomes the default', () => {
    assert.equal(clampRatio('row', Number.NaN), 0.58);
    assert.equal(clampRatio('stacked', Number.POSITIVE_INFINITY), 0.46);
  });
});

describe('ratioFromPointer', () => {
  test('side by side: the x of the pointer within the container (y does not matter)', () => {
    near(ratioFromPointer('row', at(600, 0), container), 0.5);
    near(ratioFromPointer('row', at(600, 9999), container), 0.5);
    near(ratioFromPointer('row', at(800, 300), container), 0.7);
  });

  test('stacked: the y of the pointer within the container (x does not matter)', () => {
    near(ratioFromPointer('stacked', at(0, 350), container), 0.5);
    near(ratioFromPointer('stacked', at(9999, 350), container), 0.5);
    near(ratioFromPointer('stacked', at(600, 230), container), 0.3);
  });

  test('clamped to the limits of the layout, also outside the container', () => {
    assert.equal(ratioFromPointer('row', at(-500, 0), container), 0.25);
    assert.equal(ratioFromPointer('row', at(5000, 0), container), 0.8);
    assert.equal(ratioFromPointer('stacked', at(0, 60), container), 0.2);
    assert.equal(ratioFromPointer('stacked', at(0, 5000), container), 0.8);
  });

  test('the divider stays where it was grabbed: no jump at the first move', () => {
    // The divider of a 0.58 split is around x = 680 (7 px wide); a finger grabs it 10 px to the right.
    const divider = { left: 677, top: 50, width: 7, height: 600 };
    const grab = grabOffset('row', at(690.5, 300), divider);
    assert.equal(grab, 10);
    near(ratioFromPointer('row', at(690.5, 300), container, grab), 0.5805);
    near(ratioFromPointer('row', at(590.5, 300), container, grab), 0.4805);

    const bar = { left: 100, top: 323, width: 1000, height: 7 };
    const up = grabOffset('stacked', at(400, 318.5), bar);
    assert.equal(up, -8);
    near(ratioFromPointer('stacked', at(400, 318.5), container, up), 0.46083333333333);
    near(ratioFromPointer('stacked', at(400, 378.5), container, up), 0.56083333333333);
  });

  test('an empty container gives nothing', () => {
    assert.equal(ratioFromPointer('row', at(10, 10), { left: 0, top: 0, width: 0, height: 600 }), null);
    assert.equal(ratioFromPointer('stacked', at(10, 10), { left: 0, top: 0, width: 800, height: 0 }), null);
  });
});

describe('ratioFromKey', () => {
  test('side by side: ← / → move the divider, more with Shift', () => {
    near(ratioFromKey('row', 'ArrowLeft', false, 0.5), 0.48);
    near(ratioFromKey('row', 'ArrowRight', false, 0.5), 0.52);
    near(ratioFromKey('row', 'ArrowLeft', true, 0.5), 0.42);
    near(ratioFromKey('row', 'ArrowRight', true, 0.5), 0.58);
    assert.equal(ratioFromKey('row', 'ArrowUp', false, 0.5), null);
    assert.equal(ratioFromKey('row', 'ArrowDown', false, 0.5), null);
  });

  test('stacked: ↑ / ↓ move the divider, more with Shift', () => {
    near(ratioFromKey('stacked', 'ArrowUp', false, 0.5), 0.48);
    near(ratioFromKey('stacked', 'ArrowDown', false, 0.5), 0.52);
    near(ratioFromKey('stacked', 'ArrowUp', true, 0.5), 0.42);
    near(ratioFromKey('stacked', 'ArrowDown', true, 0.5), 0.58);
    assert.equal(ratioFromKey('stacked', 'ArrowLeft', false, 0.5), null);
    assert.equal(ratioFromKey('stacked', 'ArrowRight', false, 0.5), null);
  });

  test('the steps stop at the limits', () => {
    assert.equal(ratioFromKey('row', 'ArrowLeft', true, 0.26), 0.25);
    assert.equal(ratioFromKey('row', 'ArrowRight', false, 0.8), 0.8);
    assert.equal(ratioFromKey('stacked', 'ArrowUp', false, 0.2), 0.2);
    assert.equal(ratioFromKey('stacked', 'ArrowDown', true, 0.79), 0.8);
  });

  test('Home and Enter reset to the default of the layout; other keys are not handled', () => {
    for (const key of ['Home', 'Enter']) {
      assert.equal(ratioFromKey('row', key, false, 0.3), 0.58);
      assert.equal(ratioFromKey('stacked', key, false, 0.3), 0.46);
    }
    for (const key of ['End', 'Tab', ' ', 'a', 'Escape']) {
      assert.equal(ratioFromKey('row', key, false, 0.3), null);
      assert.equal(ratioFromKey('stacked', key, false, 0.3), null);
    }
  });
});

describe('taps', () => {
  test('a finger or a pencil may slip more than a mouse before a press is a drag', () => {
    assert.ok(tapSlop('mouse') > 0);
    assert.ok(tapSlop('touch') > tapSlop('mouse'));
    assert.equal(tapSlop('pen'), tapSlop('touch'));
  });

  test('two taps soon after each other, about the same place, are a double tap', () => {
    const first = { time: 1000, clientX: 300, clientY: 200 };
    assert.equal(isDoubleTap(null, first), false);
    assert.equal(isDoubleTap(first, { time: 1250, clientX: 306, clientY: 195 }), true);
    assert.equal(isDoubleTap(first, { time: 1450, clientX: 300, clientY: 200 }), true);
  });

  test('not when too late, too far away or out of order', () => {
    const first = { time: 1000, clientX: 300, clientY: 200 };
    assert.equal(isDoubleTap(first, { time: 1451, clientX: 300, clientY: 200 }), false);
    assert.equal(isDoubleTap(first, { time: 1200, clientX: 300, clientY: 240 }), false);
    assert.equal(isDoubleTap(first, { time: 900, clientX: 300, clientY: 200 }), false);
  });
});

describe('the stacked layout: SplitPane.tsx and styles.css agree', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

  test('the split pane stacks at the width of the responsive block of styles.css', () => {
    assert.equal(STACKED_QUERY, '(max-width: 800px)');
    assert.ok(css.includes(`@media ${STACKED_QUERY} {`));
  });

  test('the layout comes from the class of SplitPane.tsx; the divider is there in both layouts', () => {
    assert.match(css, /\.split\.is-stacked \{\s*flex-direction: column;/);
    assert.match(css, /\.split\.is-stacked \.split-divider \{[^}]*cursor: row-resize;/);
    assert.doesNotMatch(css, /\.split-divider \{\s*display: none;/);
  });

  test('a touch screen gets a wide grab area and a grip; the divider never scrolls or zooms the page', () => {
    assert.match(css, /\.split-divider \{[^}]*touch-action: none;/);
    const coarse = /@media \(pointer: coarse\) \{([^{}]|\{[^{}]*\})*\}/g;
    const block = css.match(coarse)?.find((b) => b.includes('.split-divider::before'));
    assert.ok(block, 'the coarse pointer block of the split pane');
    assert.match(block, /\.split-grip \{\s*display: block;/);
    // 7 px of the divider itself plus the area on both sides.
    const row = /\.split-divider::before \{[^}]*inset: 0 -(\d+)px;/.exec(block);
    const stacked = /\.split\.is-stacked \.split-divider::before \{[^}]*inset: -(\d+)px 0 -(\d+)px;/.exec(block);
    assert.ok(row && 7 + 2 * Number(row[1]) >= 24);
    assert.ok(stacked && 7 + Number(stacked[1]) + Number(stacked[2]) >= 24);
  });

  test('each layout stores its ratio under its own key', () => {
    assert.equal(storageKeys.split, 'split');
    assert.equal(storageKeys.splitStacked, 'splitStacked');
  });
});
