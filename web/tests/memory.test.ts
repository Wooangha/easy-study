// Client-side memory budget helpers (DESIGN §15): image renditions and chat windowing.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as assets from '../../server/assets.ts';
import { slideUrl, thumbUrl, VIEW_WIDTHS, viewSrcSet, viewUrl } from '../src/api.ts';
import type { LlmSwitch } from '../../shared/types.ts';
import { CHAT_WINDOW, chatWindowStart, switchAtWindowStart } from '../src/lib/chatWindow.ts';
import { slideSizes } from '../src/lib/format.ts';

describe('slide image URLs', () => {
  test('the client asks for exactly the renditions the server makes', () => {
    assert.deepEqual([...VIEW_WIDTHS], [...assets.VIEW_WIDTHS]);
  });

  test('view renditions, srcset, thumbnails and the PNG fallback', () => {
    assert.equal(viewUrl('l7-ab', 3, 1000), '/api/docs/l7-ab/view/3.webp?w=1000');
    assert.equal(
      viewSrcSet('l7-ab', 12),
      '/api/docs/l7-ab/view/12.webp?w=1000 1000w, /api/docs/l7-ab/view/12.webp?w=1600 1600w',
    );
    assert.equal(thumbUrl('l7-ab', 3), '/api/docs/l7-ab/thumbs/3.webp');
    assert.equal(slideUrl('l7-ab', 3), '/api/docs/l7-ab/slides/3.png');
    assert.equal(viewUrl('a b', 1, 1600), '/api/docs/a%20b/view/1.webp?w=1600');
  });

  test('sizes follows the rendered width, rounded up to 50 px', () => {
    assert.equal(slideSizes(784), '800px');
    assert.equal(slideSizes(800), '800px');
    assert.equal(slideSizes(392.4), '400px'); // zoomed out to 50%
    assert.equal(slideSizes(2352), '2400px'); // zoomed in to 300%
    assert.equal(slideSizes(0), null);
    assert.equal(slideSizes(Number.NaN), null);
  });
});

describe('chat windowing', () => {
  const pairs = (n: number) =>
    Array.from({ length: n * 2 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const) }));

  test('short sessions render everything', () => {
    assert.equal(chatWindowStart(pairs(3), CHAT_WINDOW), 0);
    assert.equal(chatWindowStart([], CHAT_WINDOW), 0);
    assert.equal(chatWindowStart(pairs(10), CHAT_WINDOW), 0);
  });

  test('long sessions render only the last messages', () => {
    const list = pairs(31); // 62 messages
    assert.equal(chatWindowStart(list, CHAT_WINDOW), 42);
    assert.equal(chatWindowStart(list, CHAT_WINDOW * 2), 22);
    assert.equal(chatWindowStart(list, list.length), 0);
    assert.equal(chatWindowStart(list, 1000), 0);
  });

  test('the newest LLM switch hidden behind "이전 메시지 보기" heads the window', () => {
    const list = pairs(31).map((m, i) => ({ ...m, id: `m${i}` }));
    const sw = (afterMessageId: string | null): LlmSwitch => ({
      at: '2026-09-29T00:00:00.000Z',
      afterMessageId,
      from: { provider: 'claude-code', model: '' },
      to: { provider: 'codex', model: '' },
    });
    const start = chatWindowStart(list, CHAT_WINDOW); // 42: m41 is the last hidden answer
    // A switch always follows an answer, so with enough turns on the new LLM it lands exactly on the boundary.
    assert.equal(switchAtWindowStart([sw('m41')], list, start), 0);
    assert.equal(switchAtWindowStart([sw('m3'), sw('m41')], list, start), 1); // only the newest hidden one
    assert.equal(switchAtWindowStart([sw(null)], list, start), 0); // before the first message: hidden as well
    assert.equal(switchAtWindowStart([sw('m3'), sw('m43')], list, start), 0); // m43 is rendered: that one shows in place
    assert.equal(switchAtWindowStart([sw('m43')], list, start), -1);
    assert.equal(switchAtWindowStart([], list, start), -1);
  });

  test('the window never starts with an answer whose question is hidden', () => {
    const list = pairs(31);
    assert.equal(chatWindowStart(list, 21), 40); // 41 is an answer → include its question
    assert.equal(list[chatWindowStart(list, 21)].role, 'user');
    // A pending question (user message without an answer yet) at the end.
    const pending = [...pairs(15), { role: 'user' as const }];
    assert.equal(chatWindowStart(pending, CHAT_WINDOW), 10);
    // Unusual histories (answers in a row) still end on a question or at the start.
    const odd = [{ role: 'assistant' as const }, { role: 'assistant' as const }, { role: 'assistant' as const }];
    assert.equal(chatWindowStart(odd, 1), 0);
  });
});
