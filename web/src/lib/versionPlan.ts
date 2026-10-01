// 새 버전 올리기 (DESIGN §28) on the client: the 새 버전 확인 dialog's sections from a VersionPlan, the slide numbers of
// the old deck carried into the new one (the remembered position, the pinned slide), the banner's changed slides, and
// which swaps of a lecture this tab has caught up with. Pure, no DOM.
import type { AnnotationItem, DeckChange, VersionPlan } from '../../../shared/types.ts';

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
