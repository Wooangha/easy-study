// Jump to a Q&A from a question marker (DESIGN §25): the chat window widened so the message is rendered, never
// starting on an answer. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHAT_WINDOW, chatWindowStart, windowStartFor } from '../src/lib/chatWindow.ts';

const pairs = (n: number) => Array.from({ length: n * 2 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const) }));

describe('windowStartFor', () => {
  test('a question: the window starts at it; an answer: at its question', () => {
    const list = pairs(31);
    assert.equal(windowStartFor(list, 10), 10);
    assert.equal(windowStartFor(list, 11), 10);
    assert.equal(windowStartFor(list, 0), 0);
    assert.equal(windowStartFor(list, 1), 0);
  });

  test('out-of-range indexes are clamped', () => {
    const list = pairs(3);
    assert.equal(windowStartFor(list, -4), 0);
    assert.equal(windowStartFor(list, 99), 4);
    assert.equal(windowStartFor([], 3), 0);
  });

  test('the limit derived from it makes chatWindowStart render the message', () => {
    const list = pairs(40);
    for (const index of [0, 7, 8, 33, 79]) {
      const limit = list.length - windowStartFor(list, index);
      const start = chatWindowStart(list, limit);
      assert.ok(start <= index, `index ${index} rendered`);
      assert.equal(list[start].role, 'user');
    }
    // A message already inside the default window needs no widening.
    assert.ok(chatWindowStart(list, CHAT_WINDOW) <= 79 - CHAT_WINDOW + 1);
  });
});
