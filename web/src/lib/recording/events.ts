// Downstream of a recording (DESIGN §22): GET …/recordings/:rid/events is SSE with `status`, `segment` (id: =
// segment id), `realigned` and `ping` (a real event every 10 s). Two things the protocol spike found mandatory:
// - manual reconnect: EventSource never retries after a non-200 answer (502 while a proxy's server restarts, 401
//   after the login ended); it only retries network errors by itself;
// - a watchdog: a half-open stream (sleep, NAT, dead backend behind a proxy) stays silent forever; no event for
//   2.5 pings → close and reconnect with ?since=<last segment id>.
// Plus the reducer that applies events to what the client holds. Pure: EventSource and timers are injected.
import type { RecordingEvent, RecordingInfo, TranscriptSegment } from '../../../../shared/types.ts';

/** The server's ping interval (DESIGN §22) and the watchdog: 2.5 pings without any event. */
export const PING_INTERVAL_MS = 10_000;
export const WATCHDOG_MS = 25_000;
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;

/** The part of EventSource the client uses. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => unknown): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** EventSource.CLOSED */
const CLOSED = 2;

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

export type ConnectionState = 'connecting' | 'open' | 'retrying' | 'stopped';

export interface EventsClientOptions {
  /** URL of the stream, resuming after `since` (the last segment id received), or from the start (null). */
  url: (since: number | null) => string;
  create: EventSourceFactory;
  onEvent: (event: RecordingEvent) => void;
  onState?: (state: ConnectionState) => void;
  /** The server closed the stream (non-200 answer): e.g. check whether the login ended. */
  onClosedByServer?: () => void;
  timers?: Timers;
  random?: () => number;
  watchdogMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Segment id to resume after (segments already held). */
  since?: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

function isSegment(v: unknown): v is TranscriptSegment {
  return (
    isObject(v) &&
    typeof v.id === 'number' &&
    typeof v.start === 'number' &&
    typeof v.end === 'number' &&
    typeof v.text === 'string' &&
    (v.slide === null || typeof v.slide === 'number')
  );
}

function isInfo(v: unknown): v is RecordingInfo {
  return isObject(v) && typeof v.id === 'string' && typeof v.status === 'string' && typeof v.docId === 'string';
}

function isSlideUpdate(v: unknown): v is { id: number; slide: number | null } {
  return isObject(v) && typeof v.id === 'number' && (v.slide === null || typeof v.slide === 'number');
}

/**
 * A frame of the stream as a RecordingEvent. The data is the event object with its `type` (the repo's SSE
 * convention); the bare payload (a segment, a RecordingInfo, the realigned list) is accepted too. Null when
 * malformed.
 */
export function parseRecordingEvent(eventName: string, data: string): RecordingEvent | null {
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
    case 'segment': {
      const seg = isObject(v) && 'segment' in v ? v.segment : v;
      return isSegment(seg) ? { type: 'segment', segment: seg } : null;
    }
    case 'status': {
      const rec = isObject(v) && 'recording' in v ? v.recording : v;
      return isInfo(rec) ? { type: 'status', recording: rec } : null;
    }
    case 'realigned': {
      const list = Array.isArray(v) ? v : isObject(v) ? v.segments : null;
      return Array.isArray(list) ? { type: 'realigned', segments: list.filter(isSlideUpdate) } : null;
    }
    default:
      return null;
  }
}

/** One SSE subscription with manual reconnect, a watchdog and de-duplicated segments. */
export class RecordingEventsClient {
  private readonly o: EventsClientOptions;
  private readonly timers: Timers;
  private es: EventSourceLike | null = null;
  private watchdog: unknown = null;
  private retryTimer: unknown = null;
  private backoff = 0;
  private stopped = true;
  private state: ConnectionState = 'stopped';
  /** Id of the last segment received (resume point). */
  lastSegmentId: number | null;
  /** Diagnostics (tests). */
  readonly stats = { opens: 0, closedByServer: 0, watchdogFires: 0, reconnects: 0, duplicates: 0 };

  constructor(options: EventsClientOptions) {
    this.o = options;
    this.timers = options.timers ?? realTimers;
    this.lastSegmentId = options.since ?? null;
  }

  get connection(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearWatchdog();
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.es?.close();
    this.es = null;
    this.setState('stopped');
  }

  /** Reconnect now (e.g. the page became visible again, or the browser is online again). */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.state === 'open') return;
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = 0;
    this.connect();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.o.onState?.(state);
  }

  private connect(): void {
    this.es?.close();
    this.setState(this.stats.opens === 0 && this.stats.reconnects === 0 ? 'connecting' : 'retrying');
    const es = this.o.create(this.o.url(this.lastSegmentId));
    this.es = es;
    const onFrame = (name: string) => (ev: MessageEvent) => {
      if (this.es !== es) return;
      this.pet();
      const event = parseRecordingEvent(name, typeof ev.data === 'string' ? ev.data : '');
      if (!event) return;
      if (event.type === 'segment') {
        if (this.lastSegmentId !== null && event.segment.id <= this.lastSegmentId) {
          this.stats.duplicates++;
          return;
        }
        this.lastSegmentId = event.segment.id;
      }
      this.o.onEvent(event);
    };
    for (const name of ['status', 'segment', 'realigned', 'ping', 'message']) es.addEventListener(name, onFrame(name));
    es.onopen = () => {
      if (this.es !== es) return;
      this.stats.opens++;
      this.backoff = 0;
      this.setState('open');
      this.pet();
    };
    es.onerror = () => {
      if (this.es !== es) return;
      if (es.readyState === CLOSED) {
        // A non-200 answer (or the server ended the stream): the browser will not retry by itself.
        this.stats.closedByServer++;
        es.close();
        this.es = null;
        this.clearWatchdog();
        this.o.onClosedByServer?.();
        this.scheduleReconnect();
      } else {
        // The browser retries a network error itself (sending Last-Event-ID); the watchdog still runs.
        this.setState('retrying');
      }
    };
    this.pet();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setState('retrying');
    const min = this.o.reconnectMinMs ?? RECONNECT_MIN_MS;
    const max = this.o.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.backoff = this.backoff <= 0 ? min : Math.min(this.backoff * 2, max);
    const random = this.o.random ?? Math.random;
    const ms = Math.round(this.backoff * (0.75 + random() * 0.5));
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.stats.reconnects++;
      this.connect();
    }, ms);
  }

  /** Any event (a ping included) proves the stream alive. */
  private pet(): void {
    this.clearWatchdog();
    if (this.stopped) return;
    this.watchdog = this.timers.setTimeout(() => {
      this.watchdog = null;
      if (this.stopped) return;
      // Half-open: nothing for 2.5 pings. Reconnect at once (resuming after the last segment).
      this.stats.watchdogFires++;
      this.stats.reconnects++;
      this.connect();
    }, this.o.watchdogMs ?? WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) this.timers.clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// What the client holds about one recording, and how events change it
// ---------------------------------------------------------------------------------------------------------------

export interface FeedState {
  info: RecordingInfo | null;
  /** Time order, unique ids. */
  segments: TranscriptSegment[];
}

function insertSegment(segments: readonly TranscriptSegment[], seg: TranscriptSegment): TranscriptSegment[] {
  const at = segments.findIndex((s) => s.id === seg.id);
  if (at >= 0) {
    const copy = segments.slice();
    copy[at] = seg;
    return copy;
  }
  const last = segments[segments.length - 1];
  if (!last || last.start < seg.start || (last.start === seg.start && last.id < seg.id)) return [...segments, seg];
  const copy = [...segments, seg];
  copy.sort((a, b) => a.start - b.start || a.id - b.id);
  return copy;
}

/** Applies one event; returns the same object when nothing changed (cheap re-render checks). */
export function applyRecordingEvent(state: FeedState, event: RecordingEvent): FeedState {
  switch (event.type) {
    case 'ping':
      return state;
    case 'status':
      return { ...state, info: event.recording };
    case 'segment':
      return { ...state, segments: insertSegment(state.segments, event.segment) };
    case 'realigned': {
      if (event.segments.length === 0) return state;
      const bySlide = new Map(event.segments.map((u) => [u.id, u.slide]));
      let changed = false;
      const segments = state.segments.map((s) => {
        if (!bySlide.has(s.id)) return s;
        const slide = bySlide.get(s.id) ?? null;
        if (slide === s.slide) return s;
        changed = true;
        return { ...s, slide };
      });
      return changed ? { ...state, segments } : state;
    }
  }
}

/** The last segment id held (the SSE resume point), or null. */
export function lastSegmentId(segments: readonly TranscriptSegment[]): number | null {
  let max: number | null = null;
  for (const s of segments) if (max === null || s.id > max) max = s.id;
  return max;
}
