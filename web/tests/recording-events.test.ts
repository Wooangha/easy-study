// Recording events (DESIGN §22): the SSE client's manual reconnect and ping watchdog (the protocol spike found both
// mandatory), segment de-duplication, and the reducer that applies events. Fake EventSource and timers.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RecordingEvent, RecordingInfo, TranscriptSegment } from '../../shared/types.ts';
import {
  PING_INTERVAL_MS,
  RecordingEventsClient,
  WATCHDOG_MS,
  applyRecordingEvent,
  lastSegmentId,
  parseRecordingEvent,
  type EventSourceLike,
  type FeedState,
  type Timers,
} from '../src/lib/recording/events.ts';

class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Runs every timer due within `ms`, in time order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.pending) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }

  get count(): number {
    return this.pending.size;
  }
}

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  readonly url: string;
  private listeners = new Map<string, Array<(ev: MessageEvent) => unknown>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emit(type: string, data: unknown): void {
    const ev = { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent;
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }

  /** A non-200 answer (502, 401): the browser closes the stream for good. */
  failClosed(): void {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }

  /** A network error: the browser retries by itself. */
  failRetrying(): void {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }
}

function seg(id: number, start: number, slide: number | null = 1, text = `s${id}`): TranscriptSegment {
  return { id, start, end: start + 2, text, slide };
}

function info(patch: Partial<RecordingInfo> = {}): RecordingInfo {
  return {
    id: 'rec-1',
    docId: 'doc-1',
    title: '녹음',
    source: 'live',
    status: 'recording',
    language: 'ko',
    model: 'm',
    liveTranscribe: true,
    createdAt: '2026-09-27T00:00:00Z',
    durationSec: 10,
    transcriptStatus: 'running',
    transcribedSec: 4,
    alignment: 'timeline',
    hasManualMarkers: false,
    playback: null,
    ...patch,
  };
}

function setup(since: number | null = null) {
  const timers = new FakeTimers();
  const sources: FakeEventSource[] = [];
  const events: RecordingEvent[] = [];
  const closedByServer: number[] = [];
  const states: string[] = [];
  const client = new RecordingEventsClient({
    url: (s) => `/events${s === null ? '' : `?since=${s}`}`,
    create: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
    onClosedByServer: () => closedByServer.push(timers.now),
    timers,
    random: () => 0.5,
    since,
  });
  const last = () => sources[sources.length - 1];
  return { timers, sources, events, closedByServer, states, client, last };
}

describe('RecordingEventsClient', () => {
  test('delivers events and skips segments it already has', () => {
    const t = setup();
    t.client.start();
    assert.equal(t.last().url, '/events');
    t.last().open();
    t.last().emit('status', { type: 'status', recording: info() });
    t.last().emit('segment', { type: 'segment', segment: seg(1, 0) });
    t.last().emit('segment', { type: 'segment', segment: seg(2, 3) });
    t.last().emit('segment', { type: 'segment', segment: seg(2, 3) }); // replayed after a browser retry
    t.last().emit('ping', { type: 'ping' });
    assert.deepEqual(t.events.map((e) => e.type), ['status', 'segment', 'segment', 'ping']);
    assert.equal(t.client.lastSegmentId, 2);
    assert.equal(t.client.stats.duplicates, 1);
    assert.equal(t.client.connection, 'open');
  });

  test('a stream closed by the server (502/401) is reopened by hand with ?since=, backing off 1 s, 2 s, 4 s…', () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().emit('segment', { type: 'segment', segment: seg(7, 0) });
    t.last().failClosed();
    assert.deepEqual(t.closedByServer, [0]); // e.g. check whether the login ended
    assert.equal(t.sources.length, 1);
    t.timers.advance(999);
    assert.equal(t.sources.length, 1);
    t.timers.advance(1);
    assert.equal(t.sources.length, 2);
    assert.equal(t.last().url, '/events?since=7');
    t.last().failClosed(); // still down
    t.timers.advance(2000);
    assert.equal(t.sources.length, 3);
    t.last().failClosed();
    t.timers.advance(3999);
    assert.equal(t.sources.length, 3);
    t.timers.advance(1);
    assert.equal(t.sources.length, 4);
    // Back: the next failure starts from 1 s again.
    t.last().open();
    t.last().failClosed();
    t.timers.advance(1000);
    assert.equal(t.sources.length, 5);
    assert.equal(t.client.stats.closedByServer, 4);
  });

  test('a network error is left to the browser’s own retry (it sends Last-Event-ID)', () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().failRetrying();
    assert.equal(t.client.connection, 'retrying');
    t.timers.advance(5000);
    assert.equal(t.sources.length, 1);
    assert.deepEqual(t.closedByServer, []);
    t.last().open();
    assert.equal(t.client.connection, 'open');
  });

  test('watchdog: silence for 2.5 pings reopens the stream; pings keep it alive', () => {
    assert.equal(WATCHDOG_MS, 2.5 * PING_INTERVAL_MS);
    const t = setup(3);
    t.client.start();
    assert.equal(t.last().url, '/events?since=3');
    t.last().open();
    for (let i = 0; i < 5; i++) {
      t.timers.advance(PING_INTERVAL_MS);
      t.last().emit('ping', { type: 'ping' });
    }
    assert.equal(t.sources.length, 1);
    t.timers.advance(WATCHDOG_MS - 1);
    assert.equal(t.sources.length, 1);
    t.timers.advance(1); // half-open: nothing arrives any more
    assert.equal(t.sources.length, 2);
    assert.equal(t.sources[0].closed, true);
    assert.equal(t.last().url, '/events?since=3');
    assert.equal(t.client.stats.watchdogFires, 1);
  });

  test('the watchdog also covers a stream that never opens', () => {
    const t = setup();
    t.client.start();
    t.timers.advance(WATCHDOG_MS);
    assert.equal(t.sources.length, 2);
  });

  test('events of a replaced stream are ignored; stop() closes it and cancels every timer', () => {
    const t = setup();
    t.client.start();
    const first = t.last();
    first.open();
    t.timers.advance(WATCHDOG_MS); // reconnect
    first.emit('segment', { type: 'segment', segment: seg(1, 0) });
    assert.equal(t.events.length, 0);
    t.client.stop();
    assert.equal(t.last().closed, true);
    assert.equal(t.timers.count, 0);
    assert.equal(t.client.connection, 'stopped');
    t.timers.advance(60_000);
    assert.equal(t.sources.length, 2);
  });

  test('reconnectNow skips the wait (page visible again / online)', () => {
    const t = setup();
    t.client.start();
    t.last().failClosed();
    t.client.reconnectNow();
    assert.equal(t.sources.length, 2);
    t.timers.advance(20_000);
    // The pending retry was cancelled: only the watchdog of the new stream fired.
    assert.equal(t.sources.length, 2);
  });
});

describe('parseRecordingEvent', () => {
  test('the event object with its type, or the bare payload', () => {
    assert.deepEqual(parseRecordingEvent('segment', JSON.stringify({ type: 'segment', segment: seg(1, 0) })), {
      type: 'segment',
      segment: seg(1, 0),
    });
    assert.deepEqual(parseRecordingEvent('segment', JSON.stringify(seg(2, 1, null))), { type: 'segment', segment: seg(2, 1, null) });
    assert.equal(parseRecordingEvent('status', JSON.stringify(info()))?.type, 'status');
    assert.deepEqual(parseRecordingEvent('realigned', JSON.stringify([{ id: 1, slide: 4 }, { bad: true }])), {
      type: 'realigned',
      segments: [{ id: 1, slide: 4 }],
    });
    assert.deepEqual(parseRecordingEvent('ping', ''), { type: 'ping' });
    assert.deepEqual(parseRecordingEvent('message', JSON.stringify({ type: 'ping' })), { type: 'ping' });
  });

  test('malformed data is dropped', () => {
    assert.equal(parseRecordingEvent('segment', '{not json'), null);
    assert.equal(parseRecordingEvent('segment', JSON.stringify({ id: 'x' })), null);
    assert.equal(parseRecordingEvent('status', JSON.stringify({})), null);
    assert.equal(parseRecordingEvent('whatever', JSON.stringify({})), null);
  });
});

describe('applyRecordingEvent', () => {
  const empty: FeedState = { info: null, segments: [] };

  test('segments are kept in time order with unique ids', () => {
    let s = empty;
    s = applyRecordingEvent(s, { type: 'segment', segment: seg(1, 0) });
    s = applyRecordingEvent(s, { type: 'segment', segment: seg(3, 10) });
    s = applyRecordingEvent(s, { type: 'segment', segment: seg(2, 5) }); // late
    s = applyRecordingEvent(s, { type: 'segment', segment: seg(3, 10, 2, 'fixed') }); // replaced
    assert.deepEqual(s.segments.map((x) => x.id), [1, 2, 3]);
    assert.equal(s.segments[2].text, 'fixed');
    assert.equal(lastSegmentId(s.segments), 3);
    assert.equal(lastSegmentId([]), null);
  });

  test('realigned changes only the slides it names; unchanged → the same state object', () => {
    let s: FeedState = { info: null, segments: [seg(1, 0, 1), seg(2, 5, 1), seg(3, 9, 2)] };
    const same = applyRecordingEvent(s, { type: 'realigned', segments: [{ id: 1, slide: 1 }, { id: 99, slide: 3 }] });
    assert.equal(same, s);
    s = applyRecordingEvent(s, { type: 'realigned', segments: [{ id: 2, slide: 2 }, { id: 3, slide: null }] });
    assert.deepEqual(s.segments.map((x) => x.slide), [1, 2, null]);
    assert.equal(applyRecordingEvent(s, { type: 'ping' }), s);
  });

  test('status replaces the info', () => {
    const s = applyRecordingEvent(empty, { type: 'status', recording: info({ status: 'paused' }) });
    assert.equal(s.info?.status, 'paused');
  });
});
