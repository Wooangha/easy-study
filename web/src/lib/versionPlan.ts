// 새 버전 올리기 (DESIGN §28) on the client: the 새 버전 확인 dialog's sections from a VersionPlan, the slide numbers of
// the old deck carried into the new one (the remembered position, the pinned slide), the banner's changed slides,
// which swaps of a lecture this tab has caught up with, and the order in which a swap is handled (DeckSwaps: the
// positions, the DocMeta — fetched until it shows the new deck —, the annotation store, what is held of the lecture).
// Pure, no DOM: App passes what each step does.
import type { AnnotationColor, AnnotationItem, DeckChange, DocMeta, VersionPlan } from '../../../shared/types.ts';
import { msg } from '../i18n/index.ts';

export interface PlanView {
  counts: { same: number; changed: number; added: number; removed: number };
  /** No slide changed, was added or dropped (the same PDF again, or only renumbered): "바뀐 장이 없어요". */
  unchanged: boolean;
  /** New slides whose content differs from the old slide they continue (old thumb → new thumb). */
  changed: Array<{ slide: number; from: number; moved: boolean }>;
  /** New slides without an old counterpart. */
  added: number[];
  /** Old slides without a counterpart, ascending. */
  removed: number[];
  /** What the student has on the removed slides; a line is shown for the non-zero ones. */
  keptOnRemoved: { items: number; memos: number } | null;
  questionsMoved: number;
  /** Probably another lecture's PDF: the dialog warns. */
  unrelated: boolean;
}

/** The dialog's sections. */
export function planView(plan: VersionPlan): PlanView {
  const changed: PlanView['changed'] = [];
  const added: number[] = [];
  let same = 0;
  for (const s of plan.slides) {
    if (s.change === 'new' || s.from === null) added.push(s.slide);
    else if (s.change === 'changed') changed.push({ slide: s.slide, from: s.from, moved: s.moved === true });
    else same++;
  }
  const removed = [...plan.removed].sort((a, b) => a - b);
  const { items, memos, questions } = plan.onRemoved;
  return {
    counts: { same, changed: changed.length, added: added.length, removed: removed.length },
    unchanged: changed.length === 0 && added.length === 0 && removed.length === 0,
    changed,
    added,
    removed,
    keptOnRemoved: items > 0 || memos > 0 ? { items, memos } : null,
    questionsMoved: questions,
    unrelated: plan.unrelated,
  };
}

/** oldToNew[old - 1] = the new number of an old slide (null = dropped), from the plan (the apply's DeckMap). */
export function oldToNewOf(plan: VersionPlan): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: Math.max(0, plan.oldPageCount) }, () => null);
  for (const s of plan.slides) if (s.from !== null && s.from >= 1 && s.from <= out.length) out[s.from - 1] = s.slide;
  return out;
}

/**
 * Where an old slide is in the new deck: its new number, or for a dropped slide the nearest kept one (the closest
 * preceding old slide that survived, else the closest following, else 1) — the server's rule for messages and
 * attachments. A slide beyond the old deck counts as its last one.
 */
export function remapSlide(slide: number, oldToNew: readonly (number | null)[]): number {
  const n = oldToNew.length;
  if (n === 0) return 1;
  const at = Math.min(Math.max(1, Math.round(slide)), n);
  const kept = oldToNew[at - 1];
  if (kept != null) return kept;
  for (let k = at - 1; k >= 1; k--) {
    const v = oldToNew[k - 1];
    if (v != null) return v;
  }
  for (let k = at + 1; k <= n; k++) {
    const v = oldToNew[k - 1];
    if (v != null) return v;
  }
  return 1;
}

/** The remembered slide of a lecture (localStorage slide:<docId>) and the deck rev it is numbered in (slideRev:<docId>). */
export interface RememberedSlide {
  slide: number;
  rev: number;
}

/**
 * The remembered slide after a swap to deck `rev`: remapped through oldToNew — once, whichever tab gets there first.
 * Null (leave it) when nothing is remembered or it is already numbered in that deck or a later one (another tab
 * remapped it, or a viewer of the new deck saved it).
 */
export function remapRemembered(
  stored: RememberedSlide | null,
  rev: number,
  oldToNew: readonly (number | null)[],
): RememberedSlide | null {
  if (!stored || stored.rev >= rev) return null;
  return { slide: remapSlide(stored.slide, oldToNew), rev };
}

/** The banner's slides (current numbering): changed and added, ascending. */
export function changeSlides(change: DeckChange): number[] {
  return [...new Set([...change.changed, ...change.added])].sort((a, b) => a - b);
}

/** The 수정 / 새로 badge of each such slide. */
export function changeBadges(change: DeckChange): Map<number, 'changed' | 'added'> {
  const out = new Map<number, 'changed' | 'added'>();
  for (const s of change.changed) out.set(s, 'changed');
  for (const s of change.added) out.set(s, 'added');
  return out;
}

/** The banner shows until it is dismissed for this swap (localStorage deckSeen:<docId> = its rev). */
export function bannerShown(change: DeckChange | undefined, seenRev: number | null): change is DeckChange {
  return change !== undefined && seenRev !== change.rev;
}

/** ‹ › of the banner: the next (or previous) slide of `list` after `focused`, wrapping around; null for none. */
export function stepSlide(list: readonly number[], focused: number, dir: 1 | -1): number | null {
  if (list.length === 0) return null;
  if (dir === 1) return list.find((s) => s > focused) ?? list[0];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] < focused) return list[i];
  return list[list.length - 1];
}

/** What a 필기 of the 빠진 슬라이드 archive says: the text of a memo, a text box or a text highlight; null for the rest. */
export function removedItemText(item: AnnotationItem): string | null {
  if (item.type !== 'memo' && item.type !== 'text' && item.type !== 'textHighlight') return null;
  const line = item.text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ?? null;
}

/**
 * The rows of a removed slide's 필기 in 빠진 슬라이드: one per item (its text, else its kind), and the slide's 펜 strokes
 * as one last row, "손글씨 N획" (DESIGN §29).
 */
export function removedRows(items: readonly AnnotationItem[]): Array<{ key: string; color: AnnotationColor; ink: boolean; text: string }> {
  const kinds = msg().chat.attachments.kinds;
  const strokes = items.filter((it) => it.type === 'ink');
  const rows = items
    .filter((it) => it.type !== 'ink')
    .map((item) => ({ key: item.id, color: item.color, ink: false, text: removedItemText(item) ?? kinds[item.type] }));
  if (strokes.length > 0) rows.push({ key: 'ink', color: strokes[0].color, ink: true, text: msg().versions.removed.inkStrokes(strokes.length) });
  return rows;
}

/**
 * The deck revs a tab has caught up with, per lecture. A swap is handled once, whichever way it arrives first: the
 * `deck` event of the annotation stream, the answer of the apply / undo made here, or a DocMeta that shows a newer rev
 * (a missed event).
 */
export class DeckRevs {
  private readonly revs = new Map<string, number>();

  /** A swap to `rev` arrived (an event, an answer): true the first time — handle it. */
  take(docId: string, rev: number): boolean {
    const known = this.revs.get(docId);
    if (known !== undefined && rev <= known) return false;
    this.revs.set(docId, rev);
    return true;
  }

  /** The lecture is shown at `rev`: true when that is newer than the rev seen before (a swap nobody handled). */
  see(docId: string, rev: number): boolean {
    const known = this.revs.get(docId);
    if (known === undefined || rev > known) this.revs.set(docId, rev);
    return known !== undefined && rev > known;
  }
}

/** After a swap, a failed fetch of the lecture's DocMeta is tried again after 1 s, 2 s, 4 s … at most 15 s. */
export const DECK_REFRESH_FIRST_MS = 1000;
export const DECK_REFRESH_MAX_MS = 15_000;

export function deckRefreshDelay(attempt: number): number {
  return Math.min(DECK_REFRESH_MAX_MS, DECK_REFRESH_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 16)));
}

/**
 * Fetch a swapped lecture until it shows deck `rev` or a later one (`fetchRev`: the deckRev it got, null when the fetch
 * failed), waiting deckRefreshDelay between attempts — the viewer keeps the old deck (and the stopped store) until
 * then. True when it does; false when `stop()` says to give up (the lecture is gone).
 */
export async function refreshUntilRev(
  fetchRev: () => Promise<number | null>,
  rev: number,
  wait: (ms: number) => Promise<void>,
  stop: () => boolean = () => false,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (stop()) return false;
    const got = await fetchRev();
    if (got !== null && got >= rev) return true;
    if (stop()) return false;
    await wait(deckRefreshDelay(attempt));
  }
}

/** What DeckSwaps does at each step of a swap (App's state and the API). */
export interface DeckSwapDeps {
  /** The remembered, pinned and filtered slides follow their slides (no map: kept, or cleared). */
  remapPositions: (docId: string, rev: number, oldToNew: readonly (number | null)[] | null) => void;
  /** The deckRev of the lecture in the list (null when it is not there). */
  listedRev: (docId: string) => number | null;
  /** Fetch the lecture's DocMeta again into the list (its annotation store is replaced with it): its deckRev, null when that failed. */
  fetchRev: (docId: string) => Promise<number | null>;
  /** The lecture was deleted: stop fetching it. */
  gone: (docId: string) => boolean;
  /** Put the DocMeta an apply or undo made here answered into the list (the store is replaced with it). */
  replaceDoc: (meta: DocMeta) => void;
  /** Replace the lecture's annotation store when a swap stopped it and it is still the lecture's; true when it did. */
  replaceStoppedStore: (docId: string) => boolean;
  /** Load again what is held of the lecture (notes, sessions, recordings, 정리본: renumbered by the server). */
  reload: (docId: string) => void;
  wait: (ms: number) => Promise<void>;
}

/**
 * The swaps of the lectures' decks, each handled once (DeckRevs) whichever way it arrives:
 * - fromServer: the `deck` event of the annotation stream (with the map of the slides), or a slide-numbered write
 *   refused for another deck (409 { deckRev }, no map). The positions, then the DocMeta (fetched again until it shows
 *   the new deck: the viewer keeps the old deck and the stopped store until then), then the store and the rest.
 * - fromAnswer: the DocMeta an apply or undo made here answered.
 * - shown: the open lecture's DocMeta shows a newer deck (the event was missed, or has not come yet).
 * A DocMeta can show the new deck before its event comes (fetched while the swap ran): the store then replaced is
 * the one the event stops, and what was loaded meanwhile was loaded mid-swap. The event that follows replaces that
 * store again and loads the lecture again — else it would stay stopped for good (no slide loads, every edit refused).
 */
export class DeckSwaps {
  private readonly revs = new DeckRevs();
  /** Lectures whose DocMeta is being fetched after a swap (how many such fetches run). */
  private readonly refetching = new Map<string, number>();
  private readonly deps: () => DeckSwapDeps;

  constructor(deps: () => DeckSwapDeps) {
    this.deps = deps;
  }

  async fromServer(docId: string, rev: number, oldToNew: readonly (number | null)[] | null): Promise<void> {
    const d = this.deps();
    if (!this.revs.take(docId, rev)) {
      // Handled already (a DocMeta, an answer): a store the event stopped is replaced — unless a fetch still runs,
      // which does it when the DocMeta is there.
      if (!this.refetching.has(docId) && d.replaceStoppedStore(docId)) d.reload(docId);
      return;
    }
    // The positions first: the viewer mounted for the new deck reads the remembered slide.
    d.remapPositions(docId, rev, oldToNew);
    this.refetching.set(docId, (this.refetching.get(docId) ?? 0) + 1);
    let shown: boolean;
    try {
      shown = await refreshUntilRev(
        async () => {
          const deps = this.deps();
          const listed = deps.listedRev(docId);
          if (listed !== null && listed >= rev) return listed; // another refresh got it meanwhile
          return deps.fetchRev(docId);
        },
        rev,
        (ms) => this.deps().wait(ms),
        () => this.deps().gone(docId),
      );
    } finally {
      const left = (this.refetching.get(docId) ?? 1) - 1;
      if (left > 0) this.refetching.set(docId, left);
      else this.refetching.delete(docId);
    }
    if (!shown) return;
    const after = this.deps();
    after.replaceStoppedStore(docId);
    after.reload(docId);
  }

  fromAnswer(meta: DocMeta, oldToNew: readonly (number | null)[] | null): void {
    const d = this.deps();
    const rev = meta.deckRev ?? 0;
    const first = this.revs.take(meta.id, rev);
    if (first) d.remapPositions(meta.id, rev, oldToNew);
    d.replaceDoc(meta);
    if (!first) return;
    d.replaceStoppedStore(meta.id);
    d.reload(meta.id);
  }

  shown(docId: string, rev: number): void {
    if (!this.revs.see(docId, rev)) return;
    const d = this.deps();
    d.remapPositions(docId, rev, null);
    d.reload(docId);
  }
}
