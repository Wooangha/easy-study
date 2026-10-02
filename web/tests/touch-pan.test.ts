// Fingers on the slides under 펜 / 지우개 (DESIGN §29; web/src/lib/touchPan.ts): which finger is the palm (it landed
// during a stroke or right after the pen last touched the slides — a hovering pen stops no finger —, was down when the
// pen landed, or is a large contact that has not scrolled yet), the velocity of a pan's release and the glide after it; the debug overlay's switch and lines (web/src/lib/inkDebug.ts);
// and what styles.css must agree on (no native touch behaviour over the slides in that mode, no pointer targets in the
// annotation layer, no image drag or callout).
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INK_DEBUG_LINES, INK_DEBUG_MOVE_MS, InkDebugLines, inkDebugSwitch } from '../src/lib/inkDebug.ts';
import {
  glideOver,
  INERTIA_DECAY_MS,
  INERTIA_MAX_SPEED,
  INERTIA_MIN_SPEED,
  inertiaDone,
  inertiaTravel,
  PALM_RADIUS_PX,
  PALM_UNDO_MS,
  PalmGuard,
  PAN_REST_PX,
  PAN_SLOP_PX,
  PAN_VELOCITY_MS,
  panVelocity,
  PEN_DOWN_STALE_MS,
  PEN_QUIET_MS,
  startsInertia,
  undoneByPen,
  type PanSample,
} from '../src/lib/touchPan.ts';

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≈ ${expected}`);

describe('PalmGuard: which finger is the palm', () => {
  test('a finger on its own scrolls', () => {
    const guard = new PalmGuard();
    assert.equal(guard.start(1, 1000, 20), 'pan');
    assert.equal(guard.role(1), 'pan');
    assert.equal(guard.role(2), undefined, 'not a finger on the slides (a stylus, a touch on a control)');
    guard.end(1);
    assert.equal(guard.role(1), undefined);
  });

  test('a finger that lands while the pen is down is ignored for its whole life', () => {
    const guard = new PalmGuard();
    assert.equal(guard.pen(1000, true), true, 'the pen landed');
    assert.equal(guard.penIsDown(1100), true);
    assert.equal(guard.start(1, 1100, 15), 'palm');
    guard.pen(1500, false);
    // The pen is up and long gone: the finger that was down with it stays the palm until it lifts.
    assert.equal(guard.move(1, 15), 'palm');
    assert.equal(guard.role(1), 'palm');
    guard.end(1);
    assert.equal(guard.start(1, 5000, 15), 'pan', 'a new touch');
  });

  test('a finger that was down when the pen landed turns into the palm, for good', () => {
    const guard = new PalmGuard();
    assert.equal(guard.start(1, 1000, 18), 'pan');
    assert.equal(guard.start(2, 1010, 18), 'pan');
    assert.equal(guard.pen(1300, true), true, 'landed: what those fingers scrolled is undone by the viewer');
    assert.equal(guard.role(1), 'palm');
    assert.equal(guard.role(2), 'palm');
    assert.equal(guard.pen(1316, true), false, 'a move of the stroke: nothing new lands');
    guard.pen(1800, false);
    assert.equal(guard.role(1), 'palm', 'not back when the pen lifts');
  });

  test('a finger that lands within 400 ms after the pen last touched the slides or lifted is the hand that holds it', () => {
    const guard = new PalmGuard();
    assert.equal(PEN_QUIET_MS, 400);
    guard.pen(1000, true);
    guard.pen(1200, false);
    assert.equal(guard.start(1, 1200 + PEN_QUIET_MS - 1, 15), 'palm');
    assert.equal(guard.start(2, 1200 + PEN_QUIET_MS, 15), 'pan');
  });

  test('a pen that hovers stops no finger: the other hand scrolls while the pen is held over the slide', () => {
    const guard = new PalmGuard();
    guard.pen(1000, true);
    guard.pen(1200, false);
    // The viewer reports a hover as "off the glass" at most (penLifted), every frame: the quiet time does not start anew.
    for (let t = 1216; t < 5000; t += 16) guard.penLifted();
    assert.equal(guard.penIsDown(5000), false);
    assert.equal(guard.start(1, 5000, 15), 'pan');
    // Right after the release the quiet time still holds, hover or not.
    guard.pen(6000, true);
    guard.pen(6100, false);
    guard.penLifted();
    assert.equal(guard.start(2, 6200, 15), 'palm');
  });

  test('a large contact is a palm, when it lands or once it grows; a finger pad is not', () => {
    const guard = new PalmGuard();
    assert.equal(PALM_RADIUS_PX, 40);
    assert.equal(guard.start(1, 1000, PALM_RADIUS_PX), 'palm');
    assert.equal(guard.start(2, 1000, 31), 'pan', 'the flat pad of a finger still scrolls');
    assert.equal(guard.start(3, 1000), 'pan', 'no radius reported');
    assert.equal(guard.move(2, 33), 'pan');
    assert.equal(guard.move(2, 52), 'palm', 'the hand settled down');
    assert.equal(guard.move(2, 10), 'palm', 'never back');
    assert.equal(guard.move(9, 60), undefined);
  });

  test('a finger that scrolls or pinches already is not a palm because its pad flattens on the way', () => {
    const guard = new PalmGuard();
    assert.equal(guard.start(1, 1000, 30), 'pan');
    guard.began(1);
    assert.equal(guard.move(1, 52), 'pan', 'its scroll goes on (and is not undone)');
    assert.equal(guard.role(1), 'pan');
    // Only the pen landing makes it the palm.
    assert.equal(guard.pen(2000, true), true);
    assert.equal(guard.role(1), 'palm');
    guard.pen(2100, false);
    guard.end(1);
    // A new touch with the same identifier starts over; a palm does not become a finger by "beginning".
    assert.equal(guard.start(1, 5000, 20), 'pan');
    assert.equal(guard.move(1, 52), 'palm');
    guard.began(1);
    assert.equal(guard.role(1), 'palm');
    // Forgotten with the touch (a touchend that never arrived).
    assert.equal(guard.start(2, 6000, 20), 'pan');
    guard.began(2);
    guard.keep(new Set());
    assert.equal(guard.start(2, 7000, 20), 'pan');
    assert.equal(guard.move(2, 60), 'palm');
  });

  test('a pen whose release never arrives does not keep fingers ignored for good', () => {
    const guard = new PalmGuard();
    guard.pen(1000, true);
    assert.equal(guard.penIsDown(1000 + PEN_DOWN_STALE_MS - 1), true);
    assert.equal(guard.penIsDown(1000 + PEN_DOWN_STALE_MS), false);
    assert.equal(guard.start(1, 1000 + PEN_DOWN_STALE_MS, 15), 'pan');
    // The pen was down all along (held still): its next move says so, and the finger was the palm.
    assert.equal(guard.pen(6000, true), true);
    assert.equal(guard.role(1), 'palm');
  });

  test('the touches on the glass show no stylus: the pen is up, without touching the quiet time', () => {
    const guard = new PalmGuard();
    guard.pen(1000, true);
    guard.penLifted();
    assert.equal(guard.penIsDown(1100), false);
    assert.equal(guard.start(1, 1100, 15), 'palm', 'still within the quiet time of the pen’s last event');
    assert.equal(guard.start(2, 1000 + PEN_QUIET_MS, 15), 'pan');
  });

  test('the pen lands: what fingers scrolled as the hand settled down is undone, not what a resting finger scrolled before', () => {
    assert.equal(undoneByPen(5000, 5200), true, 'the palm slid 200 ms ago');
    assert.equal(undoneByPen(5000, 5000 + PALM_UNDO_MS), true);
    assert.equal(undoneByPen(5000, 5001 + PALM_UNDO_MS), false, 'that finger scrolled on purpose and rests since');
    assert.equal(undoneByPen(Number.NEGATIVE_INFINITY, 100), false, 'nothing moved');
    // The moves a resting finger still sends are smaller than what counts as moving, far below the slop of a pan.
    assert.equal(PAN_REST_PX, 3);
    assert.ok(PAN_REST_PX < PAN_SLOP_PX);
  });

  test('fingers whose touchend never arrived are forgotten', () => {
    const guard = new PalmGuard();
    guard.start(1, 1000, 15);
    guard.start(2, 1000, 60);
    guard.keep(new Set([2]));
    assert.equal(guard.role(1), undefined);
    assert.equal(guard.role(2), 'palm');
  });
});

describe('one finger pans: the release and the glide', () => {
  const line = (from: number, to: number, step: number, speed: number): PanSample[] => {
    const out: PanSample[] = [];
    for (let t = from; t <= to; t += step) out.push({ t, x: 100, y: 500 - (t - from) * speed });
    return out;
  };

  test('the slop of a pan', () => {
    assert.equal(PAN_SLOP_PX, 8);
  });

  test('the velocity is taken over the last 100 ms before the release', () => {
    assert.equal(PAN_VELOCITY_MS, 100);
    // 1 px/ms upwards for 300 ms, lifted with the last sample.
    const v = panVelocity(line(0, 300, 10, 1), 300);
    near(v.x, 0);
    near(v.y, -1);
    // The earlier, slower part does not count.
    const fast = [...line(0, 200, 10, 0.1), ...line(210, 300, 10, 2).map((s) => ({ ...s, y: 480 - (s.t - 210) * 2 }))];
    const vf = panVelocity(fast, 300);
    assert.ok(vf.y < -1.5, `${vf.y}`);
  });

  test('a finger that stopped before lifting leaves no velocity', () => {
    const samples = line(0, 200, 10, 1);
    assert.deepEqual(panVelocity(samples, 200 + PAN_VELOCITY_MS + 1), { x: 0, y: 0 });
    // A pause shorter than the window slows the release down (the time up to the release counts).
    const paused = panVelocity(samples, 280);
    assert.ok(Math.abs(paused.y) < 0.3, `${paused.y}`);
    assert.deepEqual(panVelocity([], 100), { x: 0, y: 0 });
    assert.deepEqual(panVelocity([{ t: 90, x: 0, y: 0 }], 100), { x: 0, y: 0 });
    assert.deepEqual(panVelocity([{ t: 100, x: 0, y: 0 }, { t: 100, x: 50, y: 0 }], 100), { x: 0, y: 0 }, 'no time passed');
  });

  test('a release is never faster than the cap, in its own direction', () => {
    const v = panVelocity([{ t: 0, x: 0, y: 0 }, { t: 10, x: 300, y: 400 }], 10);
    near(Math.hypot(v.x, v.y), INERTIA_MAX_SPEED);
    near(v.x / v.y, 0.75);
  });

  test('a slow release just stops; a flick glides on', () => {
    assert.equal(startsInertia({ x: 0, y: INERTIA_MIN_SPEED - 0.01 }), false);
    assert.equal(startsInertia({ x: 0, y: -INERTIA_MIN_SPEED }), true);
    assert.equal(startsInertia({ x: 0.2, y: 0.2 }), true);
    assert.equal(startsInertia({ x: 0, y: 0 }), false);
  });

  test('the glide decays exponentially: it starts at the release velocity and travels speed × decay time in all', () => {
    const v = { x: 0.5, y: -2 };
    near(inertiaTravel(v, 0).x, 0);
    near(inertiaTravel(v, 0).y, 0);
    // Right after the release it moves at the release velocity.
    near(inertiaTravel(v, 1).y, -2, 0.01);
    // Monotonic, and bounded by v × τ.
    let last = 0;
    for (const t of [16, 100, 400, 1000, 3000, 20000]) {
      const d = Math.abs(inertiaTravel(v, t).y);
      assert.ok(d > last, `${t}`);
      assert.ok(d <= 2 * INERTIA_DECAY_MS + 1e-9);
      last = d;
    }
    near(inertiaTravel(v, 1e6).y, -2 * INERTIA_DECAY_MS, 1e-6);
    near(inertiaTravel(v, 1e6).x, 0.5 * INERTIA_DECAY_MS, 1e-6);
    // After one decay time 63 % of the way is done.
    near(inertiaTravel(v, INERTIA_DECAY_MS).y / (-2 * INERTIA_DECAY_MS), 1 - 1 / Math.E, 1e-9);
    near(inertiaTravel(v, -5).y, 0);
  });

  test('the glide ends once it is slow', () => {
    const v = { x: 0, y: 2 };
    assert.equal(inertiaDone(v, 0), false);
    assert.equal(inertiaDone(v, 500), false);
    assert.equal(inertiaDone(v, 2000), true);
    assert.equal(inertiaDone({ x: 0, y: 0 }, 0), true);
  });

  test('the glide ends per axis: at an end of the scroll, or with nothing left to go that way', () => {
    const free = { x: false, y: false };
    const down = { x: 0, y: 2 };
    assert.equal(glideOver(down, 100, free), false);
    // A vertical fling that hit the bottom is over, though the slides are not "blocked" sideways (nothing moves there).
    assert.equal(glideOver(down, 100, { x: false, y: true }), true);
    assert.equal(glideOver(down, 100, { x: true, y: false }), false, 'the other axis still glides');
    // A little sideways speed (under a pixel left to go) does not keep it alive at the bottom…
    assert.equal(glideOver({ x: 0.002, y: 2 }, 100, { x: false, y: true }), true);
    // …a real diagonal glide goes on sideways until that axis is done too.
    assert.equal(glideOver({ x: 1, y: 2 }, 100, { x: false, y: true }), false);
    assert.equal(glideOver({ x: 1, y: 2 }, 100, { x: true, y: true }), true);
    // Slow is over, whatever the axes say.
    assert.equal(glideOver(down, 2000, free), true);
    assert.equal(glideOver({ x: 0, y: 0 }, 0, free), true);
  });
});

describe('the debug overlay (?inkdebug=1)', () => {
  test('the URL switches it on and off; anything else leaves what was remembered', () => {
    assert.equal(inkDebugSwitch('?inkdebug=1'), true);
    assert.equal(inkDebugSwitch('?a=b&inkdebug=1'), true);
    assert.equal(inkDebugSwitch('?inkdebug=0'), false);
    assert.equal(inkDebugSwitch(''), null);
    assert.equal(inkDebugSwitch('?inkdebug'), null);
    assert.equal(inkDebugSwitch('?inkdebug=yes'), null);
    assert.equal(inkDebugSwitch('?debug=1'), null);
  });

  test('one short line per event, stamped with the seconds since it opened; the last 16 stay', () => {
    const lines = new InkDebugLines(1000);
    lines.add('pd pen id5 prim0 btn1 → ink', 13_340);
    assert.deepEqual(lines.lines, [' 12.3 pd pen id5 prim0 btn1 → ink']);
    for (let i = 0; i < 40; i++) lines.add(`line ${i}`, 14_000 + i);
    assert.equal(lines.lines.length, INK_DEBUG_LINES);
    assert.match(lines.lines[INK_DEBUG_LINES - 1], /line 39$/);
    assert.match(lines.lines[0], /line 24$/);
  });

  test('moves are counted: one line per 250 ms, and before the next other line', () => {
    const lines = new InkDebugLines(0);
    lines.add('pd pen id5 prim0 btn1 → ink', 0);
    for (let i = 0; i < 12; i++) assert.equal(lines.move('pm', 10 + i * 16, i === 0 ? 3 : 2, i < 2 ? 1 : 0), false);
    assert.equal(lines.lines.length, 1, 'nothing written yet');
    assert.equal(lines.due(100), false);
    assert.equal(lines.due(10 + INK_DEBUG_MOVE_MS), true);
    // The move after the window writes the line of those before it.
    assert.equal(lines.move('pm', 10 + INK_DEBUG_MOVE_MS, 4, 0), true);
    assert.match(lines.lines[1], /pm×12 \(coalesced 25, predicted 2\)$/);
    // The release comes after the moves it followed.
    lines.add('pu pen id5 → ink', 300);
    assert.match(lines.lines[2], /pm×1 \(coalesced 4, predicted 0\)$/);
    assert.match(lines.lines[3], /pu pen id5 → ink$/);
    // Another kind of move starts its own line; without samples none are listed.
    lines.move('tm', 400);
    lines.move('tm', 410);
    assert.equal(lines.move('pm', 420, 1, 0), true);
    assert.match(lines.lines[4], /tm×2$/);
    assert.equal(lines.flush(), true);
    assert.equal(lines.flush(), false);
  });
});

describe('styles.css and the touch handling agree', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

  test('under 펜 / 지우개 the browser does nothing with a touch over the slides: no native pan can take the pen’s touches', () => {
    assert.match(css, /\.viewer\.is-ink-tool \.slide-box \{[^}]*touch-action: none;/);
    assert.match(css, /\.viewer\.is-ink-tool:not\(\.is-finger-ink\) \.viewer-scroll \{[^}]*touch-action: none;/);
    assert.doesNotMatch(css, /\.is-ink-tool[^{]*\{[^}]*touch-action: pan/);
    // Elsewhere fingers scroll natively and the viewer pinches.
    assert.match(css, /\.viewer-scroll \{[^}]*touch-action: pan-x pan-y;/);
  });

  test('under 펜 / 지우개 nothing of the annotation layer is a pointer target: a press lands on the slide box, a node that stays', () => {
    const rule = /((?:\.viewer\.is-ink-tool [^,{]+,\s*)+\.viewer\.is-ink-tool [^,{]+) \{\s*pointer-events: none;\s*\}/.exec(css);
    assert.ok(rule, 'the rule exists');
    for (const selector of ['.annot-layer svg', '.annot-shape', '.annot-text:not(.is-editing)', '.annot-handle', '.slide-box img']) {
      assert.ok(rule[1].includes(`.viewer.is-ink-tool ${selector}`), selector);
    }
  });

  test('a long press neither drags the slide image nor opens its callout', () => {
    const img = /\.slide-box img \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(img, /-webkit-user-drag: none;/);
    assert.match(img, /-webkit-touch-callout: none;/);
    assert.match(img, /user-select: none;/);
  });

  test('the debug overlay takes no input', () => {
    assert.match(css, /\.ink-debug \{[^}]*pointer-events: none;/);
  });
});
