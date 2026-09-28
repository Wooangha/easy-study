// Upload side of a live recording (DESIGN §22; the protocol spike's LiveUploader, adapted to the contract).
//
// The recording is ONE append-only byte stream (PCM s16le 16 kHz mono). Everything past the server's acknowledged
// offset lives in the RecordingStore (IndexedDB); each POST says where its bytes go (`?offset=N`), so a retry is
// always safe: the server skips bytes it already has, answers 409 `{offset}` for a gap and never appends twice.
// One request in flight; after an outage the backlog goes in batches of up to 512 KiB. Slide-view events, pause /
// resume and the final stop travel through the same loop, in order. Pure logic: the HTTP call, the waits and the
// login wait are injected (tests drive it with a fake server).
import type { RecordingInfo } from '../../../../shared/types.ts';
import { BYTES_PER_SECOND } from './pcm.ts';
import type { LocalRecording, RecordingStore } from './store.ts';

export interface HttpResult {
  status: number;
  /** Parsed JSON body, or null. */
  json: unknown;
  /** Retry-After in seconds (0 when absent). */
  retryAfter: number;
}

/**
 * Sends one request. Throws on network errors and timeouts (the loop backs off and retries); a 401 is returned
 * (the loop then waits for the login).
 */
export type UploaderHttp = (
  method: 'GET' | 'POST',
  path: string,
  body: Uint8Array | string | null,
  contentType: string | null,
  timeoutMs: number,
) => Promise<HttpResult>;

/** Why the uploader gave up for good. */
export type UploaderFatal =
  /** The recording no longer exists on the server (deleted). */
  | 'gone'
  /** The server lost audio it had acknowledged and this device no longer has it. */
  | 'data-lost'
  /** The server has more audio than this device ever captured (another device records into it?). */
  | 'server-ahead'
  /** The recording was stopped elsewhere (another tab / device, or the server finished it). */
  | 'not-live'
  /** The local state disappeared (storage cleared). */
  | 'local-missing';

export interface UploaderStatus {
  acked: number;
  captured: number;
  /** The last request reached the server. */
  online: boolean;
  /** Last failure (network, HTTP) while retrying, else null. */
  error: string | null;
  /** Milliseconds until the next retry while backing off, else null. */
  retryInMs: number | null;
  /** Waiting for a login (remote mode, session ended). */
  authRequired: boolean;
}

export interface UploaderOptions {
  docId: string;
  recordingId: string;
  store: RecordingStore;
  http: UploaderHttp;
  /** Resolves once requests can be sent again after a 401 (the login screen was answered). */
  waitForAuth: () => Promise<void>;
  /** Wakeable wait (default: setTimeout); resolves early when `wake` resolves. */
  wait?: (ms: number, wake: Promise<void>) => Promise<void>;
  random?: () => number;
  /** Audio is sent once this much is waiting (1 s), or at once when flushing / pausing / stopping. */
  minBatchBytes?: number;
  maxBatchBytes?: number;
  /** Base timeout per request; +1 s per 64 KB of body. */
  timeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Idle poll when there is nothing to send (new audio also wakes the loop). */
  idleMs?: number;
  onStatus?: (status: UploaderStatus) => void;
  /** The server answered with the recording (pause / resume / stop). */
  onInfo?: (info: RecordingInfo) => void;
  onFatal?: (reason: UploaderFatal, detail: string) => void;
  /** The stop was acknowledged: everything is on the server. */
  onDone?: (info: RecordingInfo | null) => void;
  /** The server refused slide-view events for good (a 4xx): they were dropped. */
  onEventsRefused?: (count: number, detail: string) => void;
}

export const DEFAULT_MAX_BATCH_BYTES = 512 * 1024;
const MIN_BATCH_FLOOR = 32 * 1024;
/** Slide-view events per request. */
export const EVENTS_PER_REQUEST = 200;

/**
 * A wake-up for the one loop that waits on it, never lost: fire() while nobody waits is remembered, and the next
 * take() returns null ("already woken, do not wait"); otherwise take() gives a promise the next fire() resolves.
 * release() after a wait that ended on its own, so a later fire() is remembered again.
 */
class Signal {
  private fired = false;
  private resolve: (() => void) | null = null;
  private promise: Promise<void> | null = null;

  fire(): void {
    const resolve = this.resolve;
    if (resolve) {
      this.release();
      resolve();
    } else {
      this.fired = true;
    }
  }

  take(): Promise<void> | null {
    if (this.fired) {
      this.fired = false;
      return null;
    }
    this.promise ??= new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
    return this.promise;
  }

  release(): void {
    this.resolve = null;
    this.promise = null;
  }

  /** Forget a remembered fire (the loop is about to run anyway). */
  clear(): void {
    this.fired = false;
  }
}

/** A request that failed in a retryable way (network, timeout, 5xx, 429). */
class RetryableError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'RetryableError';
    this.retryAfterMs = retryAfterMs;
  }
}

class FatalError extends Error {
  readonly reason: UploaderFatal;
  constructor(reason: UploaderFatal, message: string) {
    super(message);
    this.name = 'FatalError';
    this.reason = reason;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/** `{offset}` of an audio answer (200, or 409 gap), or null. */
export function offsetOf(json: unknown): number | null {
  if (!isObject(json)) return null;
  const n = json.offset;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

function errorText(json: unknown, status: number): string {
  const msg = isObject(json) && typeof json.error === 'string' ? json.error : '';
  return msg ? `HTTP ${status}: ${msg}` : `HTTP ${status}`;
}

function isRecordingInfo(v: unknown): v is RecordingInfo {
  return isObject(v) && typeof v.id === 'string' && typeof v.status === 'string';
}

/** Exponential backoff with ±25 % jitter: 250 ms, 500, 1 s, 2 s, 4 s, 4 s, … */
export function nextBackoff(previous: number, min: number, max: number): number {
  return previous <= 0 ? min : Math.min(previous * 2, max);
}

export function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (0.75 + random() * 0.5));
}

function defaultWait(ms: number, wake: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void wake.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class LiveUploader {
  private readonly o: Required<
    Pick<UploaderOptions, 'minBatchBytes' | 'timeoutMs' | 'backoffMinMs' | 'backoffMaxMs' | 'idleMs'>
  > &
    UploaderOptions;
  private maxBatch: number;
  private backoff = 0;
  private closed = false;
  private running: Promise<void> | null = null;
  /** Wakes an idle wait: new local work. */
  private work = new Signal();
  /** Wakes any wait, a backoff too: "try again now" (online again, page visible, closing). */
  private kickSignal = new Signal();
  private flushAll = false;
  private preferEvents = false;
  /** 409s without an offset in a row (a disagreement that asking the server did not settle backs off). */
  private conflicts = 0;
  private status: UploaderStatus = {
    acked: 0,
    captured: 0,
    online: true,
    error: null,
    retryInMs: null,
    authRequired: false,
  };
  /** Requests sent (tests: one in flight). */
  requests = 0;

  constructor(options: UploaderOptions) {
    this.o = {
      minBatchBytes: BYTES_PER_SECOND,
      timeoutMs: 10_000,
      backoffMinMs: 250,
      backoffMaxMs: 4000,
      idleMs: 1000,
      ...options,
    };
    this.maxBatch = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  }

  private base(): string {
    return `/api/docs/${encodeURIComponent(this.o.docId)}/recordings/${encodeURIComponent(this.o.recordingId)}`;
  }

  /**
   * New local work (audio, an event, pause/stop): run the loop now instead of after its idle wait. A backoff
   * after a failure is not cut short (audio arrives every second; that would defeat it) — see kick().
   */
  notify(): void {
    this.work.fire();
  }

  /** Try again now, even while backing off (the browser is online again, the page became visible). */
  kick(): void {
    this.kickSignal.fire();
    this.work.fire();
  }

  /** Send a partial batch now (pause, stop, page hide). */
  flush(): void {
    this.flushAll = true;
    this.notify();
  }

  /** Stops the loop after the current request (the local state stays; a later uploader continues). */
  close(): void {
    this.closed = true;
    this.kick();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getStatus(): UploaderStatus {
    return this.status;
  }

  /** Starts the loop (once); resolves when it ends: done, closed or fatal. */
  start(): Promise<void> {
    this.running ??= this.loop();
    return this.running;
  }

  private setStatus(patch: Partial<UploaderStatus>): void {
    this.status = { ...this.status, ...patch };
    this.o.onStatus?.(this.status);
  }

  /** Waits `ms`, or less when woken: idle waits by new work or a kick, backoffs only by a kick. */
  private async wait(ms: number, backoff: boolean): Promise<void> {
    const kick = this.kickSignal.take();
    if (kick === null) {
      this.work.clear();
      return;
    }
    let wake: Promise<void> = kick;
    if (!backoff) {
      const work = this.work.take();
      if (work === null) {
        this.kickSignal.release();
        return;
      }
      wake = Promise.race([kick, work]);
    }
    try {
      await (this.o.wait ?? defaultWait)(ms, wake);
    } finally {
      this.kickSignal.release();
      this.work.release();
    }
  }

  private async loop(): Promise<void> {
    const random = this.o.random ?? Math.random;
    while (!this.closed) {
      let result: 'work' | 'idle' | 'done';
      try {
        result = await this.step();
        if (this.backoff !== 0 || this.status.error !== null || !this.status.online) {
          this.backoff = 0;
          this.setStatus({ online: true, error: null, retryInMs: null });
        }
      } catch (e) {
        if (e instanceof FatalError) {
          this.closed = true;
          this.setStatus({ error: e.message, retryInMs: null });
          this.o.onFatal?.(e.reason, e.message);
          return;
        }
        this.backoff = nextBackoff(this.backoff, this.o.backoffMinMs, this.o.backoffMaxMs);
        const retryAfter = e instanceof RetryableError ? e.retryAfterMs : null;
        const ms = retryAfter ?? jitter(this.backoff, random);
        const message = e instanceof Error ? e.message : String(e);
        this.setStatus({ online: false, error: message, retryInMs: ms });
        await this.wait(ms, true);
        continue;
      }
      if (result === 'done') return;
      if (result === 'idle') {
        this.conflicts = 0;
        await this.wait(this.o.idleMs, false);
      }
    }
  }

  private async send(
    path: string,
    body: Uint8Array | string | null,
    contentType: string | null,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<HttpResult> {
    const bytes = body === null ? 0 : typeof body === 'string' ? body.length : body.byteLength;
    const timeout = this.o.timeoutMs + Math.ceil(bytes / 64); // +1 s per 64 KB (≥ 512 kbit/s uplink)
    this.requests++;
    let res: HttpResult;
    try {
      res = await this.o.http(method, `${this.base()}${path}`, body, contentType, timeout);
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      throw new RetryableError(
        name === 'TimeoutError' || name === 'AbortError' ? '서버 응답이 없어요 (시간 초과)' : '서버에 연결할 수 없어요',
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(errorText(res.json, res.status), res.retryAfter > 0 ? res.retryAfter * 1000 : null);
    }
    return res;
  }

  /** 401: wait for the login, then go on (capture keeps running meanwhile). */
  private async auth(): Promise<'work'> {
    this.setStatus({ authRequired: true });
    await this.o.waitForAuth();
    this.setStatus({ authRequired: false });
    return 'work';
  }

  /** One unit of work; 'idle' when there is nothing to send right now. */
  private async step(): Promise<'work' | 'idle' | 'done'> {
    const st = await this.o.store.load();
    if (!st) throw new FatalError('local-missing', '이 기기에 저장된 녹음 정보가 없어요');
    if (this.status.acked !== st.acked || this.status.captured !== st.captured) {
      this.setStatus({ acked: st.acked, captured: st.captured });
    }
    if (st.stopAcked) return 'done';

    // 1. Resume before any new audio (the server segments at pauses). A stop while paused needs no resume.
    if (!st.wantPaused && st.serverPaused) return this.control('resume');

    // 2. Slide-view events, alternating with audio during a backlog.
    const backlog = st.captured - st.acked;
    const urgent = this.flushAll || st.wantPaused || st.stopBytes !== null;
    const sendAudio = backlog > 0 && (backlog >= this.o.minBatchBytes || urgent);
    const events = await this.o.store.pendingEvents(EVENTS_PER_REQUEST);
    if (events.length > 0 && (this.preferEvents || !sendAudio)) {
      this.preferEvents = false;
      const body = JSON.stringify(events.map((e) => ({ t: e.t, slide: e.slide })));
      const r = await this.send('/slides', body, 'application/json');
      if (r.status === 401) return this.auth();
      if (r.status === 404) throw new FatalError('gone', '녹음이 서버에서 지워졌어요');
      if (r.status === 409) return this.checkLive();
      if (r.status >= 400 && r.status < 500) {
        // Refused for good (400: malformed or out of range). The events are only a hint for the alignment: drop
        // them instead of retrying forever, which would hold back the pause and the stop queued behind them.
        await this.o.store.dropEvents(events[events.length - 1].seq);
        this.o.onEventsRefused?.(events.length, errorText(r.json, r.status));
        return 'work';
      }
      if (r.status < 200 || r.status >= 300) throw new RetryableError(errorText(r.json, r.status));
      await this.o.store.dropEvents(events[events.length - 1].seq);
      return 'work';
    }

    // 3. Audio from the acknowledged offset.
    if (sendAudio) {
      this.preferEvents = events.length > 0;
      const body = await this.o.store.read(st.acked, Math.min(backlog, this.maxBatch));
      if (body.byteLength === 0) {
        throw new FatalError('data-lost', `이 기기에 ${st.acked}바이트 이후의 녹음이 남아 있지 않아요`);
      }
      const r = await this.send(`/audio?offset=${st.acked}`, body, 'application/octet-stream');
      if (r.status === 401) return this.auth();
      if (r.status === 404) throw new FatalError('gone', '녹음이 서버에서 지워졌어요');
      if (r.status === 413) {
        this.maxBatch = Math.max(MIN_BATCH_FLOOR, Math.floor(this.maxBatch / 2));
        return 'work';
      }
      const offset = offsetOf(r.json);
      // A 409 with an offset other than ours is a gap (or a conflict): continue from the server's offset. With our
      // own offset it is a refusal (the recording was stopped): ask the server what the recording is now.
      if (r.status === 409 && offset !== null && offset !== st.acked) {
        await this.reconcile(offset, st);
        return 'work';
      }
      if (r.status === 409) return this.checkLive();
      if (r.status < 200 || r.status >= 300 || offset === null) throw new RetryableError(errorText(r.json, r.status));
      await this.reconcile(offset, st);
      if (offset >= st.captured) this.flushAll = false;
      return 'work';
    }

    // 4. Pause once everything before it is on the server.
    if (st.wantPaused && !st.serverPaused && st.stopBytes === null && backlog === 0) return this.control('pause');

    // 5. Stop once all audio is there.
    if (st.stopBytes !== null && st.acked >= st.stopBytes) {
      // `bytes`: everything captured (the server finishes once that much is stored).
      const r = await this.send('/stop', JSON.stringify({ bytes: st.stopBytes }), 'application/json');
      if (r.status === 401) return this.auth();
      if (r.status === 404) throw new FatalError('gone', '녹음이 서버에서 지워졌어요');
      if (r.status === 409) {
        // Already stopped (a lost answer, or another tab): nothing left to do.
        await this.o.store.update({ stopAcked: true });
        this.o.onDone?.(null);
        return 'done';
      }
      if (r.status < 200 || r.status >= 300) throw new RetryableError(errorText(r.json, r.status));
      await this.o.store.update({ stopAcked: true });
      const info = isRecordingInfo(r.json) ? r.json : null;
      if (info) this.o.onInfo?.(info);
      this.o.onDone?.(info);
      return 'done';
    }
    return 'idle';
  }

  private async control(action: 'pause' | 'resume'): Promise<'work'> {
    const r = await this.send(`/${action}`, null, null);
    if (r.status === 401) return this.auth();
    if (r.status === 404) throw new FatalError('gone', '녹음이 서버에서 지워졌어요');
    if (r.status === 409) return this.checkLive();
    if (r.status < 200 || r.status >= 300) throw new RetryableError(errorText(r.json, r.status));
    const info = isRecordingInfo(r.json) ? r.json : null;
    await this.o.store.update({ serverPaused: info ? info.status === 'paused' : action === 'pause' });
    if (info) this.o.onInfo?.(info);
    return 'work';
  }

  /**
   * A 409 without an offset: the recording may no longer be live (stopped from another tab or device), or the
   * server was told something twice (pause while paused). Ask the server which one it is.
   */
  private async checkLive(): Promise<'work'> {
    if (++this.conflicts > 2) {
      this.conflicts = 0;
      throw new RetryableError('서버와 녹음 상태가 맞지 않아요. 잠시 후 다시 시도해요');
    }
    const r = await this.send('', null, null, 'GET');
    if (r.status === 401) return this.auth();
    if (r.status === 404) throw new FatalError('gone', '녹음이 서버에서 지워졌어요');
    if (r.status < 200 || r.status >= 300 || !isRecordingInfo(r.json)) {
      throw new RetryableError(errorText(r.json, r.status));
    }
    const info = r.json;
    this.o.onInfo?.(info);
    if (info.status !== 'recording' && info.status !== 'paused') {
      throw new FatalError('not-live', '이 녹음은 이미 끝났어요 (다른 곳에서 멈췄을 수 있어요)');
    }
    await this.o.store.update({ serverPaused: info.status === 'paused' });
    return 'work';
  }

  /** The server's offset differs from ours: continue from its offset if the bytes are still here. */
  private async reconcile(serverOffset: number, st: LocalRecording): Promise<void> {
    if (serverOffset > st.captured) {
      throw new FatalError('server-ahead', `서버의 녹음(${serverOffset}바이트)이 이 기기에서 녹음한 것보다 길어요`);
    }
    if (serverOffset < st.acked) {
      // The server lost acknowledged audio (torn write, restored library): heal it from the kept tail.
      const have = await this.o.store.read(serverOffset, 1);
      if (have.byteLength === 0) {
        throw new FatalError('data-lost', '서버가 받은 녹음 일부를 잃었고, 이 기기에도 더 이상 남아 있지 않아요');
      }
    }
    await this.o.store.setAcked(serverOffset);
    this.setStatus({ acked: serverOffset, captured: st.captured });
  }
}
