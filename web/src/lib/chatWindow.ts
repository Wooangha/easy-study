// Chat windowing (DESIGN §15): a long session renders only its last messages. Every rendered answer
// with KaTeX costs megabytes of DOM and layout, so older messages stay behind a "이전 메시지 보기" button.
import type { ChatMessage } from '../../../shared/types.ts';

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
