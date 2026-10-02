// Do-nothing listeners at the window for every kind of input (lib/inputListeners.ts, DESIGN §29): held once however
// many viewers ask, released with the last one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdInputListeners, INPUT_LISTENER_EVENTS } from '../src/lib/inputListeners.ts';

test('the listeners are added once, passive and in the capture phase, and removed with the last holder', () => {
  const added: string[] = [];
  const removed: string[] = [];
  const target = {
    addEventListener: (type: string, _l: unknown, options: unknown) => {
      assert.deepEqual(options, { capture: true, passive: true });
      added.push(type);
    },
    removeEventListener: (type: string) => void removed.push(type),
  } as unknown as Window;
  const a = holdInputListeners(target);
  const b = holdInputListeners(target);
  assert.deepEqual(added, [...INPUT_LISTENER_EVENTS]);
  for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'touchend']) assert.ok(added.includes(type), type);
  a();
  a(); // letting go twice counts once
  assert.deepEqual(removed, []);
  b();
  assert.deepEqual(removed, [...INPUT_LISTENER_EVENTS]);
});
