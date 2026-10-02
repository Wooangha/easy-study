// Undo / redo of slide annotations (DESIGN §25), pure: one stack per document in edit order (⌘Z undoes the most
// recent edit wherever it is — the focused slide is "the one crossing the centre line" while the last edit is often
// on a neighbour). Each entry holds the inverse ops of a mutation, computed from the document before it (the
// inverse of add = remove, of update = update with the previous fields, of remove = add of the removed item, of
// hideMarker = unhideMarker), and the ops to redo it. A group action (moving, recoloring or deleting several selected
// items) is one mutation of several ops, so one entry: ⌘Z undoes it whole. Consecutive edits of one item's text (or
// its size, from the slider) within a short time are one entry (a debounced flush or a slider step is not an undo
// step each). At most MAX_HISTORY entries.
import type { AnnotationItem, AnnotationOp, Patchable, SlideAnnotations } from '../../../../shared/types.ts';
import { applyOps, sameMarkerKey } from './geometry.ts';

export const MAX_HISTORY = 50;
/** Text (or size) edits of the same item closer than this are coalesced. */
export const TEXT_COALESCE_MS = 2000;
/** The fields whose consecutive edits of one item coalesce: typed text, and the size slider / number field. */
export const COALESCED_FIELDS: ReadonlySet<string> = new Set(['text', 'size']);

export interface HistoryEntry {
  slide: number;
  undo: AnnotationOp[];
  redo: AnnotationOp[];
  /** When it was recorded (coalescing). */
  at: number;
  /** `${id}/${field}` when the entry edits only that one field of that one item (coalescing). */
  fieldOf?: string;
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
      for (const [key, value] of Object.entries(op.patch as Record<string, unknown>)) {
        if (key === 'updatedAt' || value === undefined) continue;
        // A field the item did not have (a text box's first size): the inverse removes it again (null).
        previous[key] = key in record ? record[key] : null;
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

/**
 * The ops that undo `ops` applied on `doc`, in the order to apply them (the last op is undone first) — except that a
 * run of re-adds keeps the items' original order: undoing a group delete puts them back in their z-order.
 */
export function inverseOps(doc: SlideAnnotations, ops: readonly AnnotationOp[]): AnnotationOp[] {
  const out: AnnotationOp[] = [];
  let current = doc;
  for (const op of ops) {
    const inverse = inverseOf(current, op);
    if (inverse) out.unshift(inverse);
    current = applyOps(current, [op]);
  }
  for (let i = 0; i < out.length; ) {
    if (out[i].op !== 'add') {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j].op === 'add') j++;
    out.splice(i, j - i, ...out.slice(i, j).reverse());
    i = j;
  }
  return out;
}

/** `${id}/${field}` when these ops change only one coalescing field of one item, else null. */
function fieldEditOf(ops: readonly AnnotationOp[]): string | null {
  if (ops.length !== 1 || ops[0].op !== 'update') return null;
  const keys = Object.keys(ops[0].patch).filter((k) => k !== 'updatedAt');
  return keys.length === 1 && COALESCED_FIELDS.has(keys[0]) ? `${ops[0].id}/${keys[0]}` : null;
}

/**
 * Records a mutation (`ops` about to be applied on `doc`, the document before it) at `now`; clears the redo stack.
 * Nothing is recorded when the ops change nothing. A text (or size) edit of the item and field the previous entry
 * edited (within TEXT_COALESCE_MS) merges into it: the undo keeps the older value, the redo takes the newer.
 */
export function recordEntry(history: History, slide: number, doc: SlideAnnotations, ops: readonly AnnotationOp[], now: number): History {
  const undo = inverseOps(doc, ops);
  if (undo.length === 0) return history;
  const fieldOf = fieldEditOf(ops) ?? undefined;
  const last = history.undo[history.undo.length - 1];
  if (fieldOf && last && last.slide === slide && last.fieldOf === fieldOf && now - last.at <= TEXT_COALESCE_MS) {
    const merged: HistoryEntry = { ...last, redo: [...ops], at: now };
    return { undo: [...history.undo.slice(0, -1), merged], redo: [] };
  }
  const entry: HistoryEntry = { slide, undo, redo: [...ops], at: now, ...(fieldOf ? { fieldOf } : {}) };
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

/** Whether there is something to undo / redo (the toolbar's 되돌리기 / 다시 실행; the snapshot's history notifies). */
export const canUndoIn = (history: History): boolean => history.undo.length > 0;
export const canRedoIn = (history: History): boolean => history.redo.length > 0;

/**
 * Without the entries of `slide` that only added some of `ids` (the server refused those adds: the items are gone, so
 * the entries would undo nothing); every other entry of the slide stays.
 */
export function dropAdds(history: History, slide: number, ids: ReadonlySet<string>): History {
  const keep = (e: HistoryEntry) => e.slide !== slide || !e.redo.every((op) => op.op === 'add' && ids.has(op.item.id));
  const undo = history.undo.filter(keep);
  const redo = history.redo.filter(keep);
  return undo.length === history.undo.length && redo.length === history.redo.length ? history : { undo, redo };
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
