// Version of a library arrangement (DESIGN §18), for PutLayoutRequest.baseRevision: the server refuses a PUT
// (409) that was computed from another arrangement than the current one, so a tab or device with stale data
// cannot silently undo a change made elsewhere. Computed from the normalised layout by the server and the web
// client alike (so no response has to carry it): the top-level order and the courses of every group. Titles are
// left out — a PUT never changes them.
import type { LibraryLayout } from './types.ts';

/** cyrb53: a small, fast 53-bit string hash (not cryptographic; only has to tell arrangements apart). */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The revision of a (normalised) arrangement: equal arrangements have equal revisions. */
export function layoutRevision(layout: Pick<LibraryLayout, 'groups' | 'order'>): string {
  const courseIdsOf = new Map(layout.groups.map((group) => [group.id, group.courseIds]));
  const canonical = layout.order
    .map((item) => (item.type === 'course' ? `c:${item.id}` : `g:${item.id}(${(courseIdsOf.get(item.id) ?? []).join(',')})`))
    .join('|');
  return `r${hash53(canonical)}`;
}
