// The 메모 tab (DESIGN §25): the lecture's memos from the summary (no per-slide loads), searched and filtered on the
// client. Pure helpers, no DOM.
import type { MemoSummary } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';

export interface MemoListFilter {
  /** Case-insensitive, over the text and the tags; whitespace-separated words must all match. */
  query: string;
  /** Only memos carrying this tag (null = every tag). */
  tag: string | null;
  /** Only memos of this slide (null = every slide). */
  slide: number | null;
}

export const EMPTY_MEMO_FILTER: MemoListFilter = { query: '', tag: null, slide: null };

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);

/** The memos matching the filter, in the summary's order (slide, then createdAt). */
export function filterMemos(memos: readonly MemoSummary[], filter: MemoListFilter): MemoSummary[] {
  const terms = words(filter.query);
  return memos.filter((m) => {
    if (filter.slide !== null && m.slide !== filter.slide) return false;
    if (filter.tag !== null && !m.tags.includes(filter.tag)) return false;
    if (terms.length === 0) return true;
    const haystack = `${m.text}\n${m.tags.join(' ')}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** The memos' tags with counts, most used first, then alphabetical (the filter chips). */
export function memoTagCounts(memos: readonly MemoSummary[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of memos) for (const tag of m.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The first two lines of a memo's summary text (blank → "(빈 메모)"). */
export function memoLines(text: string): [string, string | null] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [msg().viewer.memo.empty, null];
  return [lines[0], lines[1] ?? null];
}
