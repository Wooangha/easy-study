// The annotations of one open document (DESIGN §25), shared by everything that shows them (the slide viewer's
// layers, the 메모 tab, the composer's 📝 chip) — the feeds.ts pattern: one store per document, reference counted,
// closed a little after the last viewer leaves. It holds the per-lecture summary, the slide documents near the
// focused slide (loaded on demand, dropped far away: nothing for every slide), one write queue per slide and the
// SSE stream that brings other devices' edits.
//
// Writes are optimistic: `mutate` applies the ops locally with the same pure reducer the server uses (applyOps),
// then PATCHes them — one request in flight per slide, ops arriving meanwhile go out in the next one. A 409 (another
// device wrote first) is rebased: the server's document plus our ops, retried once; only a second 409 replaces the
// document and says so. A network failure keeps the local state, retries once, then shows "저장 안 됨" on the slide
// until a later write succeeds; a write that only adds, refused because the slide is full, drops just those items.
// A document from the server keeps the held objects of the items it did not change (the views cache per object).
// Undo/redo is one global stack per document (history.ts).
//
// A `deck` event (DESIGN §28: a new version of the PDF applied, or undone) makes everything held numbered in the old
// deck: the store stops (no more writes, loads or stream) and tells the app (onDeckEvent), which replaces it
// (resetAnnotationStore) once it shows the new deck; the subscribers of useAnnotations move to the new store. Every
// write carries the deck the store was made for (DECK_REV_HEADER); a 409 saying the lecture is at another deck (the
// event was missed) stops the store the same way, without a map of the slides.
import {
  MAX_ANNOTATION_ITEMS,
  MAX_ANNOTATION_OPS,
  type AnnotationEvent,
  type AnnotationOp,
  type AnnotationSummary,
  type SlideAnnotations,
} from '../../../../shared/types.ts';
import {
  annotationErrorMessage,
  annotationEventsUrl,
  checkSessionSoon,
  conflictCurrentOf,
  deckChangedOf,
  deckRevOf,
  getAnnotationSummary,
  getSlideAnnotations,
  listAnnotationTags,
  patchSlideAnnotations,
} from '../../api.ts';
import { msg } from '../../i18n/index.ts';
import { RecordingEventsClient, type ConnectionState, type EventSourceLike, type Timers } from '../recording/events.ts';
import { toast as showToast, type ToastKind } from '../toast.ts';
import { applyOps, canHideMarker, emptySlideAnnotations, fitsSlide, itemsAfter, newClientId, rebaseOps, reuseItems, slideFull, stampRoom } from './geometry.ts';
import { canRedoIn, canUndoIn, dropAdds, emptyHistory, entryItemId, opsApply, popRedo, popUndo, pruneSlide, recordEntry, type History } from './history.ts';
import { dropTextLayouts } from './layoutCache.ts';

export interface AnnotationSnapshot {
  summary: AnnotationSummary | null;
  summaryError: string | null;
  /** The loaded slide documents (optimistic: local ops applied). */
  slides: ReadonlyMap<number, SlideAnnotations>;
  /** Slides whose last write failed (the "저장 안 됨" badge). */
  unsaved: ReadonlySet<number>;
  history: History;
  connection: ConnectionState;
}

export interface QaChange {
  sessionId: string;
  updatedAt: string | null;
}

/** What the store needs from the outside (the real API, EventSource and timers by default; fakes in tests). */
export interface StoreDeps {
  getSummary: (docId: string) => Promise<AnnotationSummary>;
  getSlide: (docId: string, slide: number) => Promise<SlideAnnotations>;
  /** `deckRev`: the deck the slide numbers belong to (DECK_REV_HEADER). */
  patch: (docId: string, slide: number, body: { baseRev: number; ops: AnnotationOp[] }, client: string, deckRev: number) => Promise<SlideAnnotations>;
  /** The deck rev the client holds for a lecture (the api's map); 0 when absent. */
  deckRev?: (docId: string) => number;
  eventsUrl: (docId: string, client: string) => string;
  createEventSource: (url: string) => EventSourceLike;
  timers: Timers;
  toast: (message: string, kind?: ToastKind, timeoutMs?: number) => void;
  now: () => number;
  /** The stream was closed by the server (a 401 after the login ended, for one). */
  onClosedByServer?: () => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

const defaultDeps: StoreDeps = {
  getSummary: getAnnotationSummary,
  getSlide: getSlideAnnotations,
  patch: patchSlideAnnotations,
  deckRev: deckRevOf,
  eventsUrl: annotationEventsUrl,
  createEventSource: (url) => new EventSource(url),
  timers: realTimers,
  toast: showToast,
  now: () => Date.now(),
  onClosedByServer: () => checkSessionSoon(),
};

/** How long a store stays after its last subscriber left (switching tabs back and forth). */
export const LINGER_MS = 5000;
/** A failed write is sent again after this long, once. */
export const NETWORK_RETRY_MS = 2000;
/** A failed slide load is not asked for again before this long (scrolling must not storm the server). */
export const LOAD_RETRY_MS = 30_000;
/** Summary refetches after `summary` events are coalesced this long. */
export const SUMMARY_DEBOUNCE_MS = 500;
/** Slide documents farther than this from the focused slide are dropped. */
export const KEEP_RADIUS = 24;
/** Slides within ±ceil(LOAD_RADIUS / zoom) of the focused one are loaded. */
export const LOAD_RADIUS = 3;
export const MAX_LOAD_RADIUS = 12;

/** The store's toasts, in the current language. */
export const conflictReloaded = (): string => msg().viewer.store.conflictReloaded;
export const tooManyItems = (): string => msg().viewer.store.tooManyItems(MAX_ANNOTATION_ITEMS);
export const tooManyHidden = (): string => msg().viewer.store.tooManyHidden;
export const tooMuchOnSlide = (): string => msg().viewer.store.tooMuchOnSlide;

const EVENT_NAMES = ['slide', 'slide-reset', 'summary', 'qa', 'deck', 'ping', 'message'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

function isSlideDoc(v: unknown): v is SlideAnnotations {
  return isObject(v) && typeof v.slide === 'number' && typeof v.rev === 'number' && Array.isArray(v.items) && Array.isArray(v.hiddenMarkers);
}

const isOp = (v: unknown): v is AnnotationOp => isObject(v) && typeof v.op === 'string';

/** A frame of GET …/annotations/events as an AnnotationEvent (null when malformed). */
export function parseAnnotationEvent(eventName: string, data: string): AnnotationEvent | null {
  let v: unknown;
  try {
    v = data === '' ? {} : JSON.parse(data);
  } catch {
    return null;
  }
  const type = isObject(v) && typeof v.type === 'string' ? v.type : eventName;
  switch (type) {
    case 'ping':
      return { type: 'ping' };
    case 'summary':
      return { type: 'summary' };
    case 'slide': {
      if (!isObject(v) || typeof v.slide !== 'number' || typeof v.rev !== 'number' || !Array.isArray(v.ops)) return null;
      return {
        type: 'slide',
        slide: v.slide,
        rev: v.rev,
        updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date().toISOString(),
        ops: v.ops.filter(isOp),
      };
    }
    case 'slide-reset': {
      const doc = isObject(v) && 'annotations' in v ? v.annotations : v;
      return isSlideDoc(doc) ? { type: 'slide-reset', annotations: doc } : null;
    }
    case 'qa': {
      if (!isObject(v) || typeof v.sessionId !== 'string') return null;
      return { type: 'qa', sessionId: v.sessionId, updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null };
    }
    case 'deck': {
      if (!isObject(v) || typeof v.rev !== 'number' || (v.kind !== 'apply' && v.kind !== 'undo') || !Array.isArray(v.oldToNew)) return null;
      const oldToNew = v.oldToNew.map((n) => (typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null));
      return { type: 'deck', rev: v.rev, kind: v.kind, oldToNew };
    }
    default:
      return null;
  }
}

/** The `deck` event (DESIGN §28). */
export type DeckEvent = Extract<AnnotationEvent, { type: 'deck' }>;

/**
 * A swap of a lecture's deck as a store tells the app (onDeckEvent): the `deck` event itself, or a write refused
 * because the lecture is at another deck (rev = the lecture's; no map of the slides).
 */
export interface DeckSwap {
  rev: number;
  oldToNew: readonly (number | null)[] | null;
}

interface WriteState {
  /** Ops applied locally, not sent yet. */
  pending: AnnotationOp[];
  /** The request on its way. */
  inflight: { ops: AnnotationOp[]; baseRev: number } | null;
  /** The request in flight is the retry after a 409 rebase. */
  rebased: boolean;
  /** The request in flight is the retry after a network error. */
  networkRetried: boolean;
  retryTimer: unknown;
  /** An event with a newer rev arrived during the flight: refetch afterwards. */
  stale: boolean;
}

const EMPTY_WRITE = (): WriteState => ({ pending: [], inflight: null, rebased: false, networkRetried: false, retryTimer: null, stale: false });

type Listener = () => void;

export class DocAnnotations {
  readonly docId: string;
  /** This tab's id: sent with writes and on the stream, so the server does not echo our own writes to us. */
  readonly clientId: string;
  /** The deck rev the store was made for: every write says so (a store never outlives its deck). */
  readonly deckRev: number;
  snapshot: AnnotationSnapshot;
  private readonly deps: StoreDeps;
  private listeners = new Set<Listener>();
  private qaListeners = new Set<(change: QaChange) => void>();
  private client: RecordingEventsClient<AnnotationEvent> | null = null;
  private writes = new Map<number, WriteState>();
  private loads = new Map<number, Promise<SlideAnnotations | null>>();
  private loadFailedAt = new Map<number, number>();
  private summaryLoad: Promise<void> | null = null;
  private summaryTimer: unknown = null;
  private lingerTimer: unknown = null;
  private wasOpen = false;
  private disposed = false;
  /** A `deck` event arrived: what is held is numbered in the old deck; nothing is written, loaded or streamed. */
  private swapped = false;
  private focus = 1;

  constructor(docId: string, deps: StoreDeps) {
    this.docId = docId;
    this.deps = deps;
    this.clientId = newClientId();
    this.deckRev = deps.deckRev?.(docId) ?? 0;
    this.snapshot = { summary: null, summaryError: null, slides: new Map(), unsaved: new Set(), history: emptyHistory(), connection: 'stopped' };
  }

  // ---- subscriptions ------------------------------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.lingerTimer !== null) this.deps.timers.clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    this.ensureSummary();
    this.syncStream();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && !this.disposed) {
        if (this.lingerTimer !== null) this.deps.timers.clearTimeout(this.lingerTimer);
        this.lingerTimer = this.deps.timers.setTimeout(() => this.dispose(), LINGER_MS);
      }
    };
  }

  /** A `deck` event stopped this store: the app replaces it with resetAnnotationStore. */
  get isSwapped(): boolean {
    return this.swapped;
  }

  /** A session of this document finished a turn or was deleted elsewhere (the `qa` event): refresh the notes. */
  onQa(listener: (change: QaChange) => void): () => void {
    this.qaListeners.add(listener);
    return () => {
      this.qaListeners.delete(listener);
    };
  }

  private set(patch: Partial<AnnotationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private setSlide(slide: number, doc: SlideAnnotations): void {
    const slides = new Map(this.snapshot.slides);
    slides.set(slide, doc);
    this.set({ slides });
  }

  /**
   * Holds a document that came from the server (with the local ops on top): the items equal to those held stay the
   * same objects (geometry.ts reuseItems), so a write's answer does not make the views decode and outline every 펜
   * stroke of the slide again.
   */
  private adopt(slide: number, doc: SlideAnnotations): SlideAnnotations {
    const kept = reuseItems(this.snapshot.slides.get(slide), doc);
    this.setSlide(slide, kept);
    return kept;
  }

  private setUnsaved(slide: number, failed: boolean): void {
    if (this.snapshot.unsaved.has(slide) === failed) return;
    const unsaved = new Set(this.snapshot.unsaved);
    if (failed) unsaved.add(slide);
    else unsaved.delete(slide);
    this.set({ unsaved });
  }

  // ---- loading --------------------------------------------------------------------------------------------------

  /** Load the summary once (again with `force`, e.g. after a `summary` event or a reconnect). */
  ensureSummary(force = false): Promise<void> {
    if (this.swapped) return Promise.resolve();
    if (this.summaryLoad) return this.summaryLoad;
    if (this.snapshot.summary && !force) return Promise.resolve();
    this.summaryLoad = this.deps
      .getSummary(this.docId)
      .then((summary) => {
        if (this.disposed || this.swapped) return;
        this.set({ summary, summaryError: null });
      })
      .catch((e: unknown) => {
        if (!this.disposed) this.set({ summaryError: annotationErrorMessage(e) });
      })
      .finally(() => {
        this.summaryLoad = null;
      });
    return this.summaryLoad;
  }

  private scheduleSummaryRefetch(): void {
    if (this.summaryTimer !== null) return;
    this.summaryTimer = this.deps.timers.setTimeout(() => {
      this.summaryTimer = null;
      void this.ensureSummary(true);
    }, SUMMARY_DEBOUNCE_MS);
  }

  /** The document of a slide: held, or fetched (one request per slide at a time). Null when it cannot be loaded. */
  ensureSlide(slide: number): Promise<SlideAnnotations | null> {
    const held = this.snapshot.slides.get(slide);
    if (held) return Promise.resolve(held);
    return this.fetchSlide(slide);
  }

  private fetchSlide(slide: number): Promise<SlideAnnotations | null> {
    if (this.swapped) return Promise.resolve(null);
    const running = this.loads.get(slide);
    if (running) return running;
    const failedAt = this.loadFailedAt.get(slide);
    if (failedAt !== undefined && this.deps.now() - failedAt < LOAD_RETRY_MS) return Promise.resolve(null);
    const promise = this.deps
      .getSlide(this.docId, slide)
      .then((fetched) => {
        if (this.disposed || this.swapped) return null;
        this.loadFailedAt.delete(slide);
        return this.reconcile(slide, fetched);
      })
      .catch(() => {
        this.loadFailedAt.set(slide, this.deps.now());
        return null;
      })
      .finally(() => this.loads.delete(slide));
    this.loads.set(slide, promise);
    return promise;
  }

  /** A document from the server (a fetch, a 409's `current`) with the ops not acknowledged yet on top of it. */
  private reconcile(slide: number, fetched: SlideAnnotations): SlideAnnotations {
    const held = this.snapshot.slides.get(slide);
    if (held && fetched.rev < held.rev) return held; // a stale answer (an event applied meanwhile)
    const w = this.writes.get(slide);
    const local = [...(w?.inflight?.ops ?? []), ...(w?.pending ?? [])];
    return this.adopt(slide, local.length > 0 ? applyOps(fetched, local) : fetched);
  }

  /**
   * The viewer's focus moved (or the zoom changed): load the slides in view — within ±ceil(LOAD_RADIUS / zoom) of
   * the focused one (at a small zoom more slides are visible) — and drop those farther than KEEP_RADIUS.
   */
  setWindow(focus: number, zoom: number, pageCount: number): void {
    this.focus = focus;
    const radius = Math.min(MAX_LOAD_RADIUS, Math.ceil(LOAD_RADIUS / Math.max(0.1, zoom)));
    for (let s = Math.max(1, focus - radius); s <= Math.min(pageCount, focus + radius); s++) {
      if (!this.snapshot.slides.has(s)) void this.fetchSlide(s);
    }
    let slides: Map<number, SlideAnnotations> | null = null;
    for (const s of this.snapshot.slides.keys()) {
      if (Math.abs(s - focus) <= KEEP_RADIUS || this.busy(s)) continue;
      slides ??= new Map(this.snapshot.slides);
      slides.delete(s);
    }
    if (slides) this.set({ slides });
  }

  private busy(slide: number): boolean {
    const w = this.writes.get(slide);
    return !!w && (w.inflight !== null || w.pending.length > 0);
  }

  // ---- writes ---------------------------------------------------------------------------------------------------

  private write(slide: number): WriteState {
    let w = this.writes.get(slide);
    if (!w) {
      w = EMPTY_WRITE();
      this.writes.set(slide, w);
    }
    return w;
  }

  /**
   * Apply ops to a slide (optimistically) and send them. False when they change nothing or would pass a cap (a toast
   * says so): MAX_ANNOTATION_ITEMS items other than 펜 strokes, and — for what adds or changes items — the strokes and
   * the document's size (DESIGN §29: refused here, before the pending strokes would be lost to the server's 400),
   * leaving room for the recording stamp the server may add to every add not acknowledged yet (stampRoom). A slide
   * not loaded yet starts from an empty document: the write's 409 (when a file exists) rebases onto the server's
   * document.
   */
  mutate(slide: number, ops: readonly AnnotationOp[], options: { undoable?: boolean } = {}): boolean {
    if (this.disposed || this.swapped || ops.length === 0) return false;
    const doc = this.snapshot.slides.get(slide) ?? emptySlideAnnotations(slide);
    if (itemsAfter(doc, ops) > MAX_ANNOTATION_ITEMS) {
      this.deps.toast(tooManyItems(), 'error');
      return false;
    }
    if (ops.some((op) => op.op === 'hideMarker') && !canHideMarker(doc)) {
      this.deps.toast(tooManyHidden(), 'error');
      return false;
    }
    const next = applyOps(doc, ops);
    if (next === doc) return false;
    if (ops.some((op) => op.op === 'add' || op.op === 'update')) {
      const w = this.writes.get(slide);
      const room = stampRoom(next, [...(w?.inflight?.ops ?? []), ...(w?.pending ?? []), ...ops]);
      if (!fitsSlide(next, room)) {
        this.deps.toast(tooMuchOnSlide(), 'error');
        return false;
      }
    }
    const history = options.undoable === false ? this.snapshot.history : recordEntry(this.snapshot.history, slide, doc, ops, this.deps.now());
    const slides = new Map(this.snapshot.slides);
    slides.set(slide, next);
    this.set({ slides, history });
    const w = this.write(slide);
    w.pending.push(...ops);
    this.flush(slide);
    return true;
  }

  private flush(slide: number): void {
    const w = this.write(slide);
    if (w.inflight || w.pending.length === 0 || this.disposed || this.swapped) return;
    if (w.retryTimer !== null) {
      this.deps.timers.clearTimeout(w.retryTimer);
      w.retryTimer = null;
    }
    // At most MAX_ANNOTATION_OPS per PATCH (the server's cap); the rest goes out in the next one, in order, so a group
    // action on more items than that (one mutation, one undo entry) is written in several requests.
    const ops = w.pending.slice(0, MAX_ANNOTATION_OPS);
    w.pending = w.pending.slice(MAX_ANNOTATION_OPS);
    const baseRev = this.snapshot.slides.get(slide)?.rev ?? 0;
    w.inflight = { ops, baseRev };
    this.deps
      .patch(this.docId, slide, { baseRev, ops }, this.clientId, this.deckRev)
      .then((result) => {
        w.inflight = null;
        w.rebased = false;
        w.networkRetried = false;
        if (this.disposed || this.swapped) return;
        this.setUnsaved(slide, false);
        this.reconcile(slide, result);
        if (w.stale) {
          w.stale = false;
          void this.fetchSlide(slide);
        }
        this.flush(slide);
      })
      .catch((e: unknown) => this.onWriteFailed(slide, ops, e));
  }

  private onWriteFailed(slide: number, ops: AnnotationOp[], e: unknown): void {
    const w = this.write(slide);
    w.inflight = null;
    if (this.disposed || this.swapped) return;
    const deckRev = deckChangedOf(e);
    if (deckRev !== null) {
      // The lecture is at another deck (a new version applied elsewhere, its `deck` event missed): nothing here can be
      // rebased — every slide number may mean another slide. Stop like for the event; the app loads the lecture again.
      this.deps.toast(annotationErrorMessage(e), 'info');
      this.stopForDeck({ rev: deckRev, oldToNew: null });
      return;
    }
    const current = conflictCurrentOf(e);
    if (current) {
      if (!w.rebased) {
        // Another device wrote first: their document, our ops on top (those that still apply), sent again.
        w.rebased = true;
        const rebased = rebaseOps(current, ops);
        const base = applyOps(current, rebased);
        w.pending = [...rebased, ...rebaseOps(base, w.pending)];
        this.adopt(slide, applyOps(current, w.pending));
        this.flush(slide);
        return;
      }
      // Twice in a row: take theirs and say so.
      w.rebased = false;
      w.pending = [];
      w.stale = false;
      this.adopt(slide, current);
      this.set({ history: pruneSlide(this.snapshot.history, slide) });
      this.deps.toast(conflictReloaded(), 'info');
      return;
    }
    const status = (e as { status?: unknown }).status;
    if (status === 0) {
      // Offline or the server is down: keep the local state, try once more soon, then show it on the slide.
      w.pending = [...ops, ...w.pending];
      if (!w.networkRetried) {
        w.networkRetried = true;
        w.retryTimer = this.deps.timers.setTimeout(() => {
          w.retryTimer = null;
          this.flush(slide);
        }, NETWORK_RETRY_MS);
      } else {
        this.setUnsaved(slide, true);
      }
      return;
    }
    const held = this.snapshot.slides.get(slide);
    if (status === 400 && ops.every((op) => op.op === 'add') && held && slideFull(held, stampRoom(held, [...ops, ...w.pending]))) {
      // A write that only adds was refused because the slide is full (its size with the server's recording stamps, or
      // what another device added meanwhile): only these items go — the ops after them and the undo history stay.
      this.dropRefusedAdds(slide, ops);
      return;
    }
    // Refused (400: an item the server does not take, a cap; 404: the slide is gone): drop the ops, show the truth.
    w.rebased = false;
    w.pending = [];
    this.set({ history: pruneSlide(this.snapshot.history, slide) });
    this.deps.toast(msg().viewer.store.saveFailed(annotationErrorMessage(e)), 'error');
    void this.fetchSlide(slide);
  }

  /**
   * The adds of a refused write leave the slide (and the ops waiting that touch those items, and the undo entries that
   * only made them); a toast says the slide is full; what waits behind them is sent.
   */
  private dropRefusedAdds(slide: number, ops: readonly AnnotationOp[]): void {
    const w = this.write(slide);
    w.rebased = false;
    const ids = new Set<string>();
    for (const op of ops) if (op.op === 'add') ids.add(op.item.id);
    const touches = (op: AnnotationOp) => (op.op === 'add' ? ids.has(op.item.id) : (op.op === 'update' || op.op === 'remove') && ids.has(op.id));
    w.pending = w.pending.filter((op) => !touches(op));
    const held = this.snapshot.slides.get(slide);
    const slides = new Map(this.snapshot.slides);
    if (held) slides.set(slide, applyOps(held, [...ids].map((id) => ({ op: 'remove' as const, id }))));
    this.set({ slides, history: dropAdds(this.snapshot.history, slide, ids) });
    this.deps.toast(tooMuchOnSlide(), 'error');
    if (w.stale) {
      w.stale = false;
      void this.fetchSlide(slide);
    }
    this.flush(slide);
  }

  /** Send every slide's unsent ops (after a network failure: the page is online again, the stream reconnected). */
  flushAll(): void {
    for (const [slide, w] of this.writes) {
      if (w.pending.length > 0 && !w.inflight) {
        w.networkRetried = false;
        this.flush(slide);
      }
    }
  }

  // ---- undo / redo ------------------------------------------------------------------------------------------------

  /** Undo the most recent edit of this document (wherever it is); the slide and item it touched, or null. */
  undo(): { slide: number; itemId: string | null } | null {
    return this.step('undo');
  }

  redo(): { slide: number; itemId: string | null } | null {
    return this.step('redo');
  }

  private step(direction: 'undo' | 'redo'): { slide: number; itemId: string | null } | null {
    let history = this.snapshot.history;
    for (;;) {
      const popped = direction === 'undo' ? popUndo(history) : popRedo(history);
      if (!popped) {
        if (history !== this.snapshot.history) this.set({ history });
        return null;
      }
      const { entry } = popped;
      const ops = direction === 'undo' ? entry.undo : entry.redo;
      const doc = this.snapshot.slides.get(entry.slide);
      if (doc && opsApply(doc, ops)) {
        this.set({ history: popped.history });
        this.mutate(entry.slide, ops, { undoable: false });
        return { slide: entry.slide, itemId: entryItemId(entry) };
      }
      // Its items vanished (another device deleted them) or the slide is no longer held: drop the entry.
      history =
        direction === 'undo'
          ? { undo: popped.history.undo, redo: popped.history.redo.slice(0, -1) }
          : { undo: popped.history.undo.slice(0, -1), redo: popped.history.redo };
    }
  }

  /** Something to undo / redo (the snapshot's `history` changes with it, so subscribers are told). */
  get canUndo(): boolean {
    return canUndoIn(this.snapshot.history);
  }

  get canRedo(): boolean {
    return canRedoIn(this.snapshot.history);
  }

  // ---- the stream -----------------------------------------------------------------------------------------------

  private syncStream(): void {
    if (this.client || this.listeners.size === 0 || this.swapped || this.disposed) return;
    this.client = new RecordingEventsClient<AnnotationEvent>({
      url: () => this.deps.eventsUrl(this.docId, this.clientId),
      create: this.deps.createEventSource,
      parse: parseAnnotationEvent,
      eventNames: EVENT_NAMES,
      timers: this.deps.timers,
      onEvent: (event) => this.onEvent(event),
      onState: (connection) => {
        if (connection === 'open') {
          if (this.wasOpen) this.resync();
          this.wasOpen = true;
        }
        if (connection !== this.snapshot.connection) this.set({ connection });
      },
      onClosedByServer: this.deps.onClosedByServer,
    });
    this.client.start();
  }

  private onEvent(event: AnnotationEvent): void {
    switch (event.type) {
      case 'ping':
        return;
      case 'summary':
        this.scheduleSummaryRefetch();
        return;
      case 'qa':
        for (const l of this.qaListeners) l({ sessionId: event.sessionId, updatedAt: event.updatedAt });
        return;
      case 'deck':
        this.stopForDeck(event);
        return;
      case 'slide': {
        const held = this.snapshot.slides.get(event.slide);
        if (!held || event.rev <= held.rev) return;
        const w = this.writes.get(event.slide);
        if (w?.inflight) {
          w.stale = true;
          return;
        }
        if (event.rev === held.rev + 1) {
          const next = applyOps(held, event.ops);
          this.setSlide(event.slide, { ...next, rev: event.rev, updatedAt: event.updatedAt });
        } else {
          void this.fetchSlide(event.slide); // a gap: something was missed
        }
        return;
      }
      case 'slide-reset': {
        const doc = event.annotations;
        const held = this.snapshot.slides.get(doc.slide);
        if (!held || doc.rev <= held.rev) return;
        const w = this.writes.get(doc.slide);
        if (w?.inflight) {
          w.stale = true;
          return;
        }
        this.reconcile(doc.slide, doc);
        return;
      }
    }
  }

  /** After a reconnect: the summary again, and every held slide whose rev it says differs. */
  private resync(): void {
    void this.ensureSummary(true).then(() => {
      const summary = this.snapshot.summary;
      if (!summary || this.disposed) return;
      const revs = new Map(summary.slides.map((s) => [s.slide, s.rev]));
      for (const [slide, held] of this.snapshot.slides) {
        const rev = revs.get(slide);
        const stale = rev === undefined ? held.items.length > 0 : rev !== held.rev;
        if (stale && !this.busy(slide)) void this.fetchSlide(slide);
      }
    });
    this.flushAll();
  }

  /**
   * The deck was swapped (DESIGN §28: its `deck` event, or a write refused for another deck): stop — the stream (the
   * server ends it anyway), the writes not sent yet (they are numbered in the old deck; the server refuses them), any
   * load — and tell the app. Without anyone listening, the store is replaced right away.
   */
  private stopForDeck(swap: DeckSwap): void {
    if (this.swapped) return;
    this.swapped = true;
    this.client?.stop();
    this.client = null;
    if (this.summaryTimer !== null) this.deps.timers.clearTimeout(this.summaryTimer);
    this.summaryTimer = null;
    for (const w of this.writes.values()) {
      if (w.retryTimer !== null) this.deps.timers.clearTimeout(w.retryTimer);
      w.retryTimer = null;
      w.pending = [];
    }
    for (const l of [...deckListeners]) l(this.docId, swap);
    if (deckListeners.size === 0 && stores.get(this.docId) === this) resetAnnotationStore(this.docId);
  }

  reconnectNow(): void {
    if (this.swapped) return;
    this.client?.reconnectNow();
    this.flushAll();
  }

  dispose(): void {
    if (this.listeners.size > 0) return;
    this.close();
  }

  /** Stop for good: the stream, the timers; forgotten (with its text layouts) while it is the document's store. */
  close(): void {
    this.disposed = true;
    this.client?.stop();
    this.client = null;
    if (this.lingerTimer !== null) this.deps.timers.clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    if (this.summaryTimer !== null) this.deps.timers.clearTimeout(this.summaryTimer);
    this.summaryTimer = null;
    for (const w of this.writes.values()) if (w.retryTimer !== null) this.deps.timers.clearTimeout(w.retryTimer);
    if (stores.get(this.docId) === this) {
      stores.delete(this.docId);
      dropTextLayouts(this.docId);
    }
  }

  /** A fresh store of the same document with the same API (resetAnnotationStore). */
  successor(): DocAnnotations {
    return new DocAnnotations(this.docId, this.deps);
  }
}

const stores = new Map<string, DocAnnotations>();
/** subscribeAnnotations: per document, what moves each subscription to the store that replaced the old one. */
const followers = new Map<string, Set<() => void>>();
const deckListeners = new Set<(docId: string, swap: DeckSwap) => void>();

/**
 * Every swap of an open lecture's deck a store learned of — its `deck` event, or a write refused for another deck —
 * after the store stopped (the app updates the lecture, its positions and what it holds of it, then replaces the
 * store: resetAnnotationStore).
 */
export function onDeckEvent(listener: (docId: string, swap: DeckSwap) => void): () => void {
  deckListeners.add(listener);
  return () => {
    deckListeners.delete(listener);
  };
}

/**
 * Forget everything held for a document — its store (closed: no more writes or stream) and its text layouts — after
 * its deck was swapped (DESIGN §28). The subscribers of subscribeAnnotations move to a fresh store, which loads the
 * new deck's annotations.
 */
export function resetAnnotationStore(docId: string): void {
  const old = stores.get(docId);
  dropTextLayouts(docId);
  if (!old) return;
  stores.delete(docId);
  old.close();
  const follow = followers.get(docId);
  if (!follow || follow.size === 0) return;
  stores.set(docId, old.successor());
  for (const move of [...follow]) move();
}

/**
 * Subscribe to the store of a document (created on first use), following it when resetAnnotationStore replaces it:
 * the listener is then subscribed to the new store and called once.
 */
export function subscribeAnnotations(docId: string, listener: Listener): () => void {
  let unsubscribe = annotationStore(docId).subscribe(listener);
  const move = () => {
    unsubscribe();
    unsubscribe = annotationStore(docId).subscribe(listener);
    listener();
  };
  let set = followers.get(docId);
  if (!set) {
    set = new Set();
    followers.set(docId, set);
  }
  set.add(move);
  return () => {
    const current = followers.get(docId);
    current?.delete(move);
    if (current?.size === 0) followers.delete(docId);
    unsubscribe();
  };
}

/** The store of a document (created on first use, with the real API unless `deps` are given). */
export function annotationStore(docId: string, deps: StoreDeps = defaultDeps): DocAnnotations {
  let store = stores.get(docId);
  if (!store) {
    store = new DocAnnotations(docId, deps);
    stores.set(docId, store);
  }
  return store;
}

/** The store of a document if one exists (no side effects: for render). */
export function peekAnnotationStore(docId: string): DocAnnotations | null {
  return stores.get(docId) ?? null;
}

export const EMPTY_SNAPSHOT: AnnotationSnapshot = {
  summary: null,
  summaryError: null,
  slides: new Map(),
  unsaved: new Set(),
  history: emptyHistory(),
  connection: 'stopped',
};

// ---- library-wide tags (memo tag autocomplete) ------------------------------------------------------------------

/** GET /api/annotations/tags is asked at most this often while a tag input is focused. */
export const TAGS_TTL_MS = 60_000;
let tagsCache: { at: number; tags: Array<{ tag: string; count: number }> } | null = null;
let tagsLoad: Promise<Array<{ tag: string; count: number }>> | null = null;

/** Every tag of the library with its count (cached for a minute). Empty when the request fails. */
export function fetchLibraryTags(): Promise<Array<{ tag: string; count: number }>> {
  if (tagsCache && Date.now() - tagsCache.at < TAGS_TTL_MS) return Promise.resolve(tagsCache.tags);
  if (tagsLoad) return tagsLoad;
  tagsLoad = listAnnotationTags()
    .then((res) => {
      tagsCache = { at: Date.now(), tags: res.tags };
      return res.tags;
    })
    .catch(() => tagsCache?.tags ?? [])
    .finally(() => {
      tagsLoad = null;
    });
  return tagsLoad;
}

// The page is visible or online again: reopen streams that are waiting, send what could not be sent.
if (typeof window !== 'undefined') {
  const kick = () => {
    for (const s of stores.values()) s.reconnectNow();
  };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
}
