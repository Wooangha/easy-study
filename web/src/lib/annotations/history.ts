// Undo / redo of slide annotations (DESIGN §25), pure: one stack per document in edit order (⌘Z undoes the most
// recent edit wherever it is — the focused slide is "the one crossing the centre line" while the last edit is often
// on a neighbour). Each entry holds the inverse ops of a mutation, computed from the document before it (the
// inverse of add = remove, of update = update with the previous fields, of remove = add of the removed item, of
// hideMarker = unhideMarker), and the ops to redo it. Consecutive text edits of one item within a short time are one
// entry (a debounced flush is not an undo step each). At most MAX_HISTORY entries.
import type { AnnotationItem, AnnotationOp, Patchable, SlideAnnotations } from '../../../../shared/types.ts';
import { applyOps, sameMarkerKey } from './geometry.ts';

export const MAX_HISTORY = 50;
/** Text edits of the same item closer than this are coalesced. */
export const TEXT_COALESCE_MS = 2000;

export interface HistoryEntry {
  slide: number;
  undo: AnnotationOp[];
  redo: AnnotationOp[];
  /** When it was recorded (coalescing). */
  at: number;
  /** The item whose text this entry edits (coalescing), if it is only that. */
  textOf?: string;
}

export interface History {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export const emptyHistory = (): History => ({ undo: [], redo: [] });

/** The inverse of one op on `doc` (null when the op changes nothing there). */
function inverseOf(doc: SlideAnnotations, op: AnnotationOp): AnnotationOp | null {
  switch (op.op) {
    case 'add':
      return doc.items.some((it) => it.id === op.item.id) ? null : { op: 'remove', id: op.item.id };
    case 'update': {
      const item = doc.items.find((it) => it.id === op.id);
      if (!item) return null;
      const previous: Record<string, unknown> = {};
      const record = item as unknown as Record<string, unknown>;
      for (const key of Object.keys(op.patch)) {
        if (key === 'updatedAt' || !(key in record)) continue;
        previous[key] = record[key];
      }
      if (Object.keys(previous).length === 0) return null;
      return { op: 'update', id: op.id, patch: previous as Patchable<AnnotationItem> };
    }
    case 'remove': {
      const item = doc.items.find((it) => it.id === op.id);
      return item ? { op: 'add', item } : null;
    }
    case 'hideMarker':
      return doc.hiddenMarkers.some((k) => sameMarkerKey(k, op.key)) ? null : { op: 'unhideMarker', key: op.key };
    case 'unhideMarker':
      return doc.hiddenMarkers.some((k) => sameMarkerKey(k, op.key)) ? { op: 'hideMarker', key: op.key } : null;
  }
}

/** The ops that undo `ops` applied on `doc`, in the order to apply them (the last op is undone first). */
export function inverseOps(doc: SlideAnnotations, ops: readonly AnnotationOp[]): AnnotationOp[] {
  const out: AnnotationOp[] = [];
  let current = doc;
  for (const op of ops) {
    const inverse = inverseOf(current, op);
    if (inverse) out.unshift(inverse);
    current = applyOps(current, [op]);
  }
  return out;
}

/** The id whose text (only) these ops change, or null. */
function textEditOf(ops: readonly AnnotationOp[]): string | null {
  if (ops.length !== 1 || ops[0].op !== 'update') return null;
  const keys = Object.keys(ops[0].patch).filter((k) => k !== 'updatedAt');
  return keys.length === 1 && keys[0] === 'text' ? ops[0].id : null;
}

/**
 * Records a mutation (`ops` about to be applied on `doc`, the document before it) at `now`; clears the redo stack.
 * Nothing is recorded when the ops change nothing. A text edit of the item the previous entry edited (within
 * TEXT_COALESCE_MS) merges into it: the undo keeps the older text, the redo takes the newer.
 */
export function recordEntry(history: History, slide: number, doc: SlideAnnotations, ops: readonly AnnotationOp[], now: number): History {
  const undo = inverseOps(doc, ops);
  if (undo.length === 0) return history;
  const textOf = textEditOf(ops) ?? undefined;
  const last = history.undo[history.undo.length - 1];
  if (textOf && last && last.slide === slide && last.textOf === textOf && now - last.at <= TEXT_COALESCE_MS) {
    const merged: HistoryEntry = { ...last, redo: [...ops], at: now };
    return { undo: [...history.undo.slice(0, -1), merged], redo: [] };
  }
  const entry: HistoryEntry = { slide, undo, redo: [...ops], at: now, ...(textOf ? { textOf } : {}) };
  const stack = [...history.undo, entry];
  return { undo: stack.length > MAX_HISTORY ? stack.slice(stack.length - MAX_HISTORY) : stack, redo: [] };
}

/** Takes the most recent entry off the undo stack (onto the redo stack); null when there is none. */
export function popUndo(history: History): { history: History; entry: HistoryEntry } | null {
  const entry = history.undo[history.undo.length - 1];
  if (!entry) return null;
  return { history: { undo: history.undo.slice(0, -1), redo: [...history.redo, entry] }, entry };
}

/** Takes the most recent entry off the redo stack (back onto the undo stack); null when there is none. */
export function popRedo(history: History): { history: History; entry: HistoryEntry } | null {
  const entry = history.redo[history.redo.length - 1];
  if (!entry) return null;
  return { history: { undo: [...history.undo, entry], redo: history.redo.slice(0, -1) }, entry };
}

/** Without the entries of `slide` (its document was replaced by another device's). */
export function pruneSlide(history: History, slide: number): History {
  const keep = (e: HistoryEntry) => e.slide !== slide;
  const undo = history.undo.filter(keep);
  const redo = history.redo.filter(keep);
  return undo.length === history.undo.length && redo.length === history.redo.length ? history : { undo, redo };
}

/** Whether applying `ops` to `doc` changes it (an entry whose items vanished is skipped by the caller). */
export function opsApply(doc: SlideAnnotations, ops: readonly AnnotationOp[]): boolean {
  return applyOps(doc, ops) !== doc;
}

/** The item an entry is about (to flash it after an undo), if one. */
export function entryItemId(entry: HistoryEntry): string | null {
  for (const op of entry.undo) {
    if (op.op === 'add') return op.item.id;
    if (op.op === 'update' || op.op === 'remove') return op.id;
  }
  return null;
}
