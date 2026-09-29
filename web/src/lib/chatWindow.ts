// Chat windowing (DESIGN §15): a long session renders only its last messages. Every rendered answer
// with KaTeX costs megabytes of DOM and layout, so older messages stay behind a "이전 메시지 보기" button.
import type { ChatMessage, LlmSwitch } from '../../../shared/types.ts';

/** Messages rendered when a session opens, and how many more each "이전 메시지 보기" click shows. */
export const CHAT_WINDOW = 20;

/**
 * Index of the first message to render when showing (at least) the last `limit` messages. The window
 * never starts with an answer whose question is hidden: it moves back to that question.
 */
export function chatWindowStart(messages: readonly Pick<ChatMessage, 'role'>[], limit: number): number {
  let start = Math.max(0, messages.length - Math.max(0, Math.floor(limit)));
  while (start > 0 && messages[start]?.role === 'assistant') start--;
  return start;
}

/**
 * Index of the first message to render so that the message at `index` is shown (a jump to a Q&A from a question
 * marker, DESIGN §25): `index` itself, moved back to its question when it is an answer — the window never starts
 * with an answer whose question is hidden. The window's limit is then `messages.length - windowStartFor(...)`.
 */
export function windowStartFor(messages: readonly Pick<ChatMessage, 'role'>[], index: number): number {
  let start = Math.min(Math.max(0, Math.floor(index)), Math.max(0, messages.length - 1));
  while (start > 0 && messages[start]?.role === 'assistant') start--;
  return start;
}

/**
 * Index (in `switches`) of the LLM switch to show at the top of a window starting at `start` > 0: the newest one
 * that happened before the first rendered message (before the first message at all, or after a hidden one), so
 * the window says which LLM its first messages came from; -1 when there is none. Older hidden switches appear in
 * place once the window grows.
 */
export function switchAtWindowStart(switches: readonly LlmSwitch[], messages: readonly Pick<ChatMessage, 'id'>[], start: number): number {
  const hidden = new Set(messages.slice(0, start).map((m) => m.id));
  for (let i = switches.length - 1; i >= 0; i--) {
    const after = switches[i].afterMessageId;
    if (after === null || hidden.has(after)) return i;
  }
  return -1;
}
