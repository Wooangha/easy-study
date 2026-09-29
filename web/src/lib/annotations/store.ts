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
// until a later write succeeds. Undo/redo is one global stack per document (history.ts).
import {
  MAX_ANNOTATION_ITEMS,
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
  getAnnotationSummary,
  getSlideAnnotations,
  listAnnotationTags,
  patchSlideAnnotations,
} from '../../api.ts';
import { RecordingEventsClient, type ConnectionState, type EventSourceLike, type Timers } from '../recording/events.ts';
import { toast as showToast, type ToastKind } from '../toast.ts';
import { applyOps, canHideMarker, emptySlideAnnotations, itemsAfter, newClientId, rebaseOps } from './geometry.ts';
import { emptyHistory, entryItemId, opsApply, popRedo, popUndo, pruneSlide, recordEntry, type History } from './history.ts';
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
  patch: (docId: string, slide: number, body: { baseRev: number; ops: AnnotationOp[] }, client: string) => Promise<SlideAnnotations>;
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

export const CONFLICT_RELOADED = '다른 곳에서 필기가 바뀌어서 다시 불러왔어요';
export const TOO_MANY_ITEMS = `이 슬라이드에는 필기를 더 넣을 수 없어요 (최대 ${MAX_ANNOTATION_ITEMS}개)`;
export const TOO_MANY_HIDDEN = '숨긴 질문 표시가 너무 많아요';

const EVENT_NAMES = ['slide', 'slide-reset', 'summary', 'qa', 'ping', 'message'] as const;

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
    default:
      return null;
  }
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
  private focus = 1;

  constructor(docId: string, deps: StoreDeps) {
    this.docId = docId;
    this.deps = deps;
    this.clientId = newClientId();
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
      if (this.listeners.size === 0) {
        if (this.lingerTimer !== null) this.deps.timers.clearTimeout(this.lingerTimer);
        this.lingerTimer = this.deps.timers.setTimeout(() => this.dispose(), LINGER_MS);
      }
    };
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
    if (this.summaryLoad) return this.summaryLoad;
    if (this.snapshot.summary && !force) return Promise.resolve();
    this.summaryLoad = this.deps
      .getSummary(this.docId)
      .then((summary) => {
        if (this.disposed) return;
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
    const running = this.loads.get(slide);
    if (running) return running;
    const failedAt = this.loadFailedAt.get(slide);
    if (failedAt !== undefined && this.deps.now() - failedAt < LOAD_RETRY_MS) return Promise.resolve(null);
    const promise = this.deps
      .getSlide(this.docId, slide)
      .then((fetched) => {
        if (this.disposed) return null;
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
    const doc = local.length > 0 ? applyOps(fetched, local) : fetched;
    this.setSlide(slide, doc);
    return doc;
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
   * says so). A slide not loaded yet starts from an empty document: the write's 409 (when a file exists) rebases onto
   * the server's document.
   */
  mutate(slide: number, ops: readonly AnnotationOp[], options: { undoable?: boolean } = {}): boolean {
    if (this.disposed || ops.length === 0) return false;
    const doc = this.snapshot.slides.get(slide) ?? emptySlideAnnotations(slide);
    if (itemsAfter(doc, ops) > MAX_ANNOTATION_ITEMS) {
      this.deps.toast(TOO_MANY_ITEMS, 'error');
      return false;
    }
    if (ops.some((op) => op.op === 'hideMarker') && !canHideMarker(doc)) {
      this.deps.toast(TOO_MANY_HIDDEN, 'error');
      return false;
    }
    const next = applyOps(doc, ops);
    if (next === doc) return false;
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
    if (w.inflight || w.pending.length === 0 || this.disposed) return;
    if (w.retryTimer !== null) {
      this.deps.timers.clearTimeout(w.retryTimer);
      w.retryTimer = null;
    }
    const ops = w.pending;
    w.pending = [];
    const baseRev = this.snapshot.slides.get(slide)?.rev ?? 0;
    w.inflight = { ops, baseRev };
    this.deps
      .patch(this.docId, slide, { baseRev, ops }, this.clientId)
      .then((result) => {
        w.inflight = null;
        w.rebased = false;
        w.networkRetried = false;
        if (this.disposed) return;
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
    if (this.disposed) return;
    const current = conflictCurrentOf(e);
    if (current) {
      if (!w.rebased) {
        // Another device wrote first: their document, our ops on top (those that still apply), sent again.
        w.rebased = true;
        const rebased = rebaseOps(current, ops);
        const base = applyOps(current, rebased);
        w.pending = [...rebased, ...rebaseOps(base, w.pending)];
        this.setSlide(slide, applyOps(current, w.pending));
        this.flush(slide);
        return;
      }
      // Twice in a row: take theirs and say so.
      w.rebased = false;
      w.pending = [];
      w.stale = false;
      this.setSlide(slide, current);
      this.set({ history: pruneSlide(this.snapshot.history, slide) });
      this.deps.toast(CONFLICT_RELOADED, 'info');
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
    // Refused (400: an item the server does not take, a cap; 404: the slide is gone): drop the ops, show the truth.
    w.rebased = false;
    w.pending = [];
    this.set({ history: pruneSlide(this.snapshot.history, slide) });
    this.deps.toast(`필기를 저장하지 못했어요: ${annotationErrorMessage(e)}`, 'error');
    void this.fetchSlide(slide);
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

  get canUndo(): boolean {
    return this.snapshot.history.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.snapshot.history.redo.length > 0;
  }

  // ---- the stream -----------------------------------------------------------------------------------------------

  private syncStream(): void {
    if (this.client || this.listeners.size === 0) return;
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

  reconnectNow(): void {
    this.client?.reconnectNow();
    this.flushAll();
  }

  dispose(): void {
    if (this.listeners.size > 0) return;
    this.disposed = true;
    this.client?.stop();
    this.client = null;
    if (this.summaryTimer !== null) this.deps.timers.clearTimeout(this.summaryTimer);
    this.summaryTimer = null;
    for (const w of this.writes.values()) if (w.retryTimer !== null) this.deps.timers.clearTimeout(w.retryTimer);
    dropTextLayouts(this.docId);
    if (stores.get(this.docId) === this) stores.delete(this.docId);
  }
}

const stores = new Map<string, DocAnnotations>();

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
