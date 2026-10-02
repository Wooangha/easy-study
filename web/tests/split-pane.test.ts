// The pure parts of the split pane (web/src/lib/splitPane.ts) and what styles.css must agree on.
// Run: node --test web/tests/split-pane.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { en } from '../src/i18n/en/index.ts';
import { ko } from '../src/i18n/ko/index.ts';
import {
  clampRatio,
  dividerPhase,
  dividerPress,
  grabOffset,
  isDoubleTap,
  isToggleTap,
  onOpenChatPane,
  openChatPane,
  ratioFromKey,
  ratioFromPointer,
  SPLIT_RANGE,
  STACKED_QUERY,
  tapSlop,
  type DividerEvent,
  type DividerPress,
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

describe('the press on the divider', () => {
  const down = (pointerId: number, pointerType: string, clientX = 680, clientY = 300): DividerEvent => ({
    type: 'down',
    pointerId,
    pointerType,
    clientX,
    clientY,
    grab: 2,
  });
  const move = (pointerId: number, clientX: number, clientY = 300, buttons = 1): DividerEvent => ({ type: 'move', pointerId, clientX, clientY, buttons });
  const run = (events: DividerEvent[], from: DividerPress | null = null) => events.reduce(dividerPress, from);
  /** A press that drags: pointer 7 of `pointerType`, moved 40 px. */
  const dragged = (pointerType: string) => run([down(7, pointerType), move(7, 720)]);

  test('a press is not a drag: the panes are let alone until the pointer really moves', () => {
    const pressed = run([down(7, 'pen')]);
    assert.deepEqual(pressed, { pointerId: 7, pointerType: 'pen', grab: 2, clientX: 680, clientY: 300, dragged: false });
    assert.equal(dividerPhase(null), 'idle');
    assert.equal(dividerPhase(pressed), 'pressed');
    // A palm resting on the divider, slipping a little: still no drag, however long it stays.
    const resting = run([move(7, 684), move(7, 686, 304), move(7, 680)], pressed);
    assert.equal(resting, pressed);
    assert.equal(dividerPhase(resting), 'pressed');
  });

  test('past the slop of its pointer it drags, and goes on dragging back near the start', () => {
    assert.equal(dividerPhase(run([down(7, 'touch'), move(7, 689)])), 'pressed');
    assert.equal(dividerPhase(run([down(7, 'touch'), move(7, 690)])), 'dragging');
    assert.equal(dividerPhase(run([down(7, 'touch'), move(7, 680, 311)])), 'dragging');
    assert.equal(dividerPhase(run([down(1, 'mouse'), move(1, 682)])), 'pressed');
    assert.equal(dividerPhase(run([down(1, 'mouse'), move(1, 683)])), 'dragging');
    const press = run([down(7, 'pen'), move(7, 720), move(7, 681)]);
    assert.equal(dividerPhase(press), 'dragging');
    // Where it was grabbed stays: the ratio is measured from there.
    assert.deepEqual(press, { pointerId: 7, pointerType: 'pen', grab: 2, clientX: 680, clientY: 300, dragged: true });
  });

  test('the moves of another pointer do nothing', () => {
    const pressed = run([down(7, 'pen')]);
    assert.equal(run([move(8, 900)], pressed), pressed);
    assert.equal(run([move(8, 900)]), null);
  });

  test('pointerup, pointercancel and lostpointercapture of its pointer end it, dragging or not', () => {
    for (const type of ['up', 'cancel', 'lost'] as const) {
      for (const press of [run([down(7, 'pen')]), dragged('pen'), dragged('touch'), dragged('mouse')]) {
        assert.equal(dividerPress(press, { type, pointerId: 7 }), null, type);
        // Not those of another pointer (the palm that was there first).
        assert.equal(dividerPress(press, { type, pointerId: 8 }), press, type);
      }
      assert.equal(dividerPress(null, { type, pointerId: 7 }), null);
    }
  });

  test('a touchend / touchcancel without touches left on the divider ends it, also without a pointerup', () => {
    for (const press of [run([down(7, 'touch')]), dragged('touch'), dragged('pen')]) {
      assert.equal(dividerPress(press, { type: 'touchend', remaining: 0 }), null);
      // The palm left, the pencil is still on the divider.
      assert.equal(dividerPress(press, { type: 'touchend', remaining: 1 }), press);
    }
    // A touch is not the mouse that holds the divider.
    const mouse = dragged('mouse');
    assert.equal(dividerPress(mouse, { type: 'touchend', remaining: 0 }), mouse);
    assert.equal(dividerPress(null, { type: 'touchend', remaining: 0 }), null);
  });

  test('a press anywhere else, a window without the focus, a hidden page and another layout end it', () => {
    for (const type of ['outside', 'blur', 'hidden', 'layout'] as const) {
      for (const press of [run([down(7, 'pen')]), dragged('pen'), dragged('touch'), dragged('mouse'), null]) {
        assert.equal(dividerPhase(dividerPress(press, { type })), 'idle', type);
      }
    }
  });

  test('a mouse that let its button go where no pointerup came from ends it with its next move', () => {
    assert.equal(run([move(7, 700, 300, 0)], dragged('mouse')), null);
    assert.equal(run([move(7, 681, 300, 0)], run([down(7, 'mouse')])), null);
    // Only the main button counts.
    assert.equal(run([move(7, 700, 300, 2)], dragged('mouse')), null);
    assert.equal(dividerPhase(run([move(7, 700, 300, 3)], dragged('mouse'))), 'dragging');
    // A touch screen is not asked for its buttons.
    assert.equal(dividerPhase(run([move(7, 700, 300, 0)], dragged('touch'))), 'dragging');
  });

  test('a new press takes the divider over: the palm that rested on it does not keep it from the pencil', () => {
    const palm = run([down(3, 'touch', 690, 500)]);
    const pencil = run([down(7, 'pen', 681, 200)], palm);
    assert.deepEqual(pencil, { pointerId: 7, pointerType: 'pen', grab: 2, clientX: 681, clientY: 200, dragged: false });
    // The palm leaves: the pencil goes on.
    assert.equal(run([{ type: 'up', pointerId: 3 }], pencil), pencil);
    assert.equal(dividerPhase(run([move(3, 900), move(7, 700, 200)], pencil)), 'dragging');
  });

  test('no order of events leaves a drag behind once the pointers are gone', () => {
    const ends: DividerEvent[] = [
      { type: 'up', pointerId: 7 },
      { type: 'cancel', pointerId: 7 },
      { type: 'lost', pointerId: 7 },
      { type: 'touchend', remaining: 0 },
      { type: 'outside' },
      { type: 'blur' },
      { type: 'hidden' },
      { type: 'layout' },
    ];
    for (const end of ends) {
      // Whatever comes after the end, short of a new press on the divider, keeps it idle.
      const after = run([down(7, 'pen'), move(7, 720), end, move(7, 760), { type: 'lost', pointerId: 7 }, { type: 'touchend', remaining: 0 }]);
      assert.equal(dividerPhase(after), 'idle', end.type);
    }
  });
});

describe('folding the chat pane', () => {
  test('a tap of a finger or a pencil on the button toggles it; a palm resting on it does not', () => {
    assert.equal(isToggleTap('touch', 90), true);
    assert.equal(isToggleTap('pen', 300), true);
    assert.equal(isToggleTap('touch', 800), true);
    assert.equal(isToggleTap('touch', 801), false);
    assert.equal(isToggleTap('pen', 4000), false);
    assert.equal(isToggleTap('mouse', 4000), true);
  });

  test('openChatPane reaches the split pane while it listens', () => {
    let opened = 0;
    openChatPane();
    const stop = onOpenChatPane(() => opened++);
    openChatPane();
    openChatPane();
    assert.equal(opened, 2);
    stop();
    openChatPane();
    assert.equal(opened, 2);
  });

  test('its state has a storage key of its own; the button is named in both languages', () => {
    assert.equal(storageKeys.chatCollapsed, 'chatCollapsed');
    assert.equal(ko.shell.splitPane.collapse, '채팅 접기');
    assert.equal(ko.shell.splitPane.expand, '채팅 펼치기');
    assert.equal(en.shell.splitPane.collapse, 'Collapse chat');
    assert.equal(en.shell.splitPane.expand, 'Expand chat');
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
    assert.match(css, /\.split\.is-stacked \.split-handle \{[^}]*cursor: row-resize;/);
    assert.doesNotMatch(css, /\.split-divider \{\s*display: none;/);
  });

  /** The `@media (pointer: coarse)` block of the split pane. */
  const coarseBlock = () => {
    const block = css.match(/@media \(pointer: coarse\) \{([^{}]|\{[^{}]*\})*\}/g)?.find((b) => b.includes('.split-handle::before'));
    assert.ok(block, 'the coarse pointer block of the split pane');
    return block;
  };
  /** px the 7 px divider lies over each pane by itself (its negative margins). */
  const OVER = 3;

  test('a touch screen gets a wide grab area and a grip; the divider never scrolls or zooms the page', () => {
    assert.match(css, /\.split-handle \{[^}]*touch-action: none;/);
    assert.match(css, /\.split-divider \{[^}]*width: 7px;\s*margin: 0 -3px;/);
    assert.match(css, /\.split\.is-stacked \.split-divider \{[^}]*height: 7px;\s*margin: -3px 0;/);
    const block = coarseBlock();
    assert.match(block, /\.split-grip \{\s*display: block;/);
    // 7 px of the divider itself plus the area on both sides: top right bottom left, the slides are left / above.
    const row = /\.split-handle::before \{[^}]*inset: 0 -(\d+)px 0 -(\d+)px;/.exec(block);
    const stacked = /\.split\.is-stacked \.split-handle::before \{[^}]*inset: -(\d+)px 0 -(\d+)px;/.exec(block);
    assert.ok(row && 7 + Number(row[1]) + Number(row[2]) >= 24);
    assert.ok(stacked && 7 + Number(stacked[1]) + Number(stacked[2]) >= 18);
    // It grows over the chat pane: a palm or a stroke at the edge of the slides does not grab the divider.
    assert.ok(row && OVER + Number(row[2]) <= 6 && Number(row[1]) > Number(row[2]));
    assert.ok(stacked && OVER + Number(stacked[1]) <= 6 && Number(stacked[2]) > Number(stacked[1]));
  });

  test('the panes ignore the pointer during a real drag of a mouse only, never on a touch screen', () => {
    const rules = [...css.matchAll(/^( *\.split[^{}]*)\{[^{}]*pointer-events: none;[^{}]*\}/gm)].map((r) => r[1].trim());
    assert.deepEqual(rules, ['.split.is-dragging .split-pane']);
    assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.split\.is-dragging \.split-pane \{\s*pointer-events: none;\s*\}\s*\}/);
    assert.doesNotMatch(css, /\.is-pressed[^{}]*\.split-pane/);
  });

  test('the collapse button: always there for a finger, big enough, and quiet for a mouse', () => {
    const block = coarseBlock();
    const size = /\.split-toggle \{[^}]*width: (\d+)px;\s*height: (\d+)px;/.exec(block);
    const around = /\.split-toggle::before \{[^}]*inset: -(\d+)px -(\d+)px -(\d+)px -(\d+)px;/.exec(block);
    assert.ok(size && around);
    const [top, right, bottom, left] = around.slice(1).map(Number);
    assert.ok(Number(size[1]) + left + right >= 32 && Number(size[2]) + top + bottom >= 32);
    // Hidden for a mouse that is elsewhere only — never where nothing hovers, never when collapsed.
    const hidden = [...css.matchAll(/@media ([^{]*)\{\s*([^{}]*)\{\s*opacity: 0;/g)].filter((r) => r[2].includes('.split-toggle'));
    assert.deepEqual(
      hidden.map((r) => [r[1].trim(), r[2].trim()]),
      [['(hover: hover) and (pointer: fine)', '.split:not(.is-collapsed) .split-toggle']],
    );
    assert.doesNotMatch(css, /^ *\.split-toggle \{[^}]*(opacity: 0|display: none)/m);
  });

  test('collapsed: the slides take everything, the chat pane stays laid out but hidden, nothing is dragged', () => {
    assert.match(css, /\.split\.is-collapsed \.split-left \{\s*flex: 1 1 0;/);
    const pane = /\.split\.is-collapsed \.split-right \{([^}]*)\}/.exec(css)?.[1];
    assert.ok(pane);
    assert.match(pane, /position: absolute;/);
    assert.match(pane, /visibility: hidden;/);
    // Not display: none — that would drop the scroll positions of the pane.
    assert.doesNotMatch(pane, /display: none/);
    assert.match(css, /\.split\.is-collapsed \.split-handle \{\s*display: none;/);
    // The parked pane is positioned in the split pane.
    assert.match(css, /\.split \{[^}]*position: relative;/);
  });

  test('each layout stores its ratio under its own key', () => {
    assert.equal(storageKeys.split, 'split');
    assert.equal(storageKeys.splitStacked, 'splitStacked');
  });
});
