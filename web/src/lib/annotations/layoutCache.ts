// Text layouts of slides (DESIGN §25): word boxes for 텍스트 형광 and 형광펜 snapping, fetched only for the slide
// under an active highlight tool (on pointerdown) and kept in a small LRU per document (dropped with the
// document's annotation store). A slide the server says will never have one (404 `pending: false`) is remembered,
// so it is not asked for again and no toast repeats; a `pending: true` answer is asked again next time.
import type { SlideTextLayout } from '../../../../shared/types.ts';
import { getTextLayout, layoutPendingOf } from '../../api.ts';

export const LAYOUT_CACHE_SIZE = 4;

export type LayoutResult = { layout: SlideTextLayout; pending?: undefined } | { layout: null; pending: boolean };

type Entry = { layout: SlideTextLayout } | { layout: null; pending: false };

const caches = new Map<string, Map<number, Entry>>();
const inflight = new Map<string, Promise<LayoutResult>>();
/** Bumped by dropTextLayouts: an answer to a request made before is not kept (a swapped deck, DESIGN §28). */
const generations = new Map<string, number>();

export type LayoutFetcher = (docId: string, slide: number) => Promise<SlideTextLayout>;

function cacheOf(docId: string): Map<number, Entry> {
  let cache = caches.get(docId);
  if (!cache) {
    cache = new Map();
    caches.set(docId, cache);
  }
  return cache;
}

function remember(docId: string, slide: number, entry: Entry): void {
  const cache = cacheOf(docId);
  cache.delete(slide);
  cache.set(slide, entry);
  // Map insertion order = use order: the oldest entry is the first one.
  while (cache.size > LAYOUT_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** The cached layout of a slide (a fresh use: it becomes the most recent), or null when not held. */
export function peekTextLayout(docId: string, slide: number): SlideTextLayout | null {
  const cache = caches.get(docId);
  const entry = cache?.get(slide);
  if (!cache || !entry) return null;
  cache.delete(slide);
  cache.set(slide, entry);
  return entry.layout;
}

/** Whether the server said this slide will never have a layout. */
export function layoutKnownMissing(docId: string, slide: number): boolean {
  const entry = caches.get(docId)?.get(slide);
  return entry !== undefined && entry.layout === null;
}

/**
 * The layout of a slide: from the cache, else fetched (one request per slide at a time). `{ layout: null, pending }`
 * when the server does not have it: `pending` true = it is being made (fall back to a plain band and say so), false =
 * it never will be (remembered; no toast).
 */
export function loadTextLayout(docId: string, slide: number, fetcher: LayoutFetcher = getTextLayout): Promise<LayoutResult> {
  const entry = caches.get(docId)?.get(slide);
  if (entry) {
    peekTextLayout(docId, slide);
    return Promise.resolve(entry.layout ? { layout: entry.layout } : { layout: null, pending: false });
  }
  const key = `${docId}/${slide}`;
  const running = inflight.get(key);
  if (running) return running;
  const generation = generations.get(docId) ?? 0;
  const current = () => (generations.get(docId) ?? 0) === generation;
  const promise = fetcher(docId, slide)
    .then((layout): LayoutResult => {
      if (current()) remember(docId, slide, { layout });
      return { layout };
    })
    .catch((e: unknown): LayoutResult => {
      const pending = layoutPendingOf(e);
      if (!pending && current()) remember(docId, slide, { layout: null, pending: false });
      return { layout: null, pending };
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Forget a document's layouts (its annotation store was disposed, or its deck swapped). */
export function dropTextLayouts(docId: string): void {
  caches.delete(docId);
  generations.set(docId, (generations.get(docId) ?? 0) + 1);
  for (const key of [...inflight.keys()]) if (key.startsWith(`${docId}/`)) inflight.delete(key);
}

/** Held slides of a document, oldest first (tests). */
export function cachedLayoutSlides(docId: string): number[] {
  return [...(caches.get(docId)?.keys() ?? [])];
}
