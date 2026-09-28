// Live recording, client side (DESIGN §22): the PCM chunker, the local store and the offset uploader (one request
// in flight, resend from the acknowledged offset, 409 gap healing, backoff, login wait, pause/resume/stop order),
// driven against a fake server that implements the contract. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RecordingInfo, SlideViewEvent } from '../../shared/types.ts';
import {
  BYTES_PER_SECOND,
  CHUNK_BYTES,
  PcmChunker,
  bytesToSeconds,
  concatBytes,
  levelOf,
  meterFraction,
  samplesOf,
  secondsToBytes,
} from '../src/lib/recording/pcm.ts';
import { KEEP_ACKED_BYTES, MemoryRecordingDb, readBlocks, type RecordingStore } from '../src/lib/recording/store.ts';
import {
  LiveUploader,
  jitter,
  nextBackoff,
  offsetOf,
  type HttpResult,
  type UploaderFatal,
  type UploaderHttp,
  type UploaderStatus,
} from '../src/lib/recording/uploader.ts';

/** Deterministic "audio": byte i of the stream is (i * 7 + 3) & 0xff. */
function audio(from: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = ((from + i) * 7 + 3) & 0xff;
  return out;
}

describe('PcmChunker', () => {
  test('collects 100 ms blocks into exact 1 s chunks; flush gives the rest', () => {
    const chunker = new PcmChunker();
    assert.equal(chunker.chunkBytes, CHUNK_BYTES);
    const block = BYTES_PER_SECOND / 10; // 3200 B = 100 ms
    const chunks: Uint8Array[] = [];
    let at = 0;
    for (let i = 0; i < 25; i++) {
      chunks.push(...chunker.push(audio(at, block)));
      at += block;
    }
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((c) => c.byteLength === CHUNK_BYTES));
    assert.equal(chunker.pendingBytes, 5 * block);
    const rest = chunker.flush();
    assert.equal(rest?.byteLength, 5 * block);
    assert.equal(chunker.flush(), null);
    assert.deepEqual(concatBytes([...chunks, rest!]), audio(0, 25 * block));
  });

  test('a block larger than a chunk is split across chunks; the input buffer is copied', () => {
    const chunker = new PcmChunker(8);
    const input = audio(0, 20);
    const chunks = chunker.push(input);
    assert.deepEqual(chunks.map((c) => c.byteLength), [8, 8]);
    input.fill(0); // the caller reuses its buffer
    assert.deepEqual(concatBytes([...chunks, chunker.flush()!]), audio(0, 20));
  });

  test('refuses half samples and odd chunk sizes', () => {
    assert.throws(() => new PcmChunker(7));
    assert.throws(() => new PcmChunker().push(new Uint8Array(3)));
  });

  test('reset drops what is held (like a reload would)', () => {
    const chunker = new PcmChunker(8);
    chunker.push(audio(0, 6));
    chunker.reset();
    assert.equal(chunker.pendingBytes, 0);
    assert.equal(chunker.flush(), null);
  });
});

describe('recording clock and level', () => {
  test('bytes ↔ seconds (s16le mono 16 kHz)', () => {
    assert.equal(BYTES_PER_SECOND, 32000);
    assert.equal(bytesToSeconds(64000), 2);
    assert.equal(secondsToBytes(1.5), 48000);
    assert.equal(secondsToBytes(0.00003), 0); // whole samples only
    assert.equal(secondsToBytes(-1), 0);
  });

  test('level: silence is −100 dB, full scale ≈ 0 dB; the meter maps −60…0 dB to 0…1', () => {
    assert.deepEqual(levelOf(new Int16Array(160)), { rmsDb: -100, peakDb: -100 });
    const square = new Int16Array(160).map((_, i) => (i % 2 ? 32767 : -32768));
    const loud = levelOf(square);
    assert.ok(loud.rmsDb > -0.01 && loud.rmsDb <= 0.0001, String(loud.rmsDb));
    const quiet = levelOf(new Int16Array(160).fill(328)); // ≈ −40 dBFS
    assert.ok(Math.abs(quiet.rmsDb + 40) < 0.1, String(quiet.rmsDb));
    assert.equal(meterFraction(-100), 0);
    assert.equal(meterFraction(0), 1);
    assert.equal(meterFraction(-30), 0.5);
    assert.equal(meterFraction(Number.NaN), 0);
  });

  test('samplesOf reads s16le even from an odd byte offset', () => {
    const buf = new Uint8Array(5);
    buf.set([0x34, 0x12, 0xff, 0x7f], 1);
    const samples = samplesOf(buf.subarray(1));
    assert.deepEqual(Array.from(samples), [0x1234, 0x7fff]);
  });
});

describe('local recording store', () => {
  test('keeps the audio past the acknowledged offset plus a 60 s tail; reads stop at a hole', async () => {
    const db = new MemoryRecordingDb(() => 0);
    const store = await db.create({ id: 'rec-1', docId: 'd', title: 'x', liveTranscribe: true });
    const second = BYTES_PER_SECOND;
    for (let i = 0; i < 70; i++) await store.appendAudio(audio(i * second, second));
    assert.equal((await store.load())?.captured, 70 * second);
    await store.setAcked(70 * second);
    const entry = db.entries.get('rec-1')!;
    // 10 s dropped, the last 60 s kept.
    assert.equal(entry.blocks[0].offset, 10 * second);
    assert.equal(KEEP_ACKED_BYTES, 60 * second);
    assert.equal((await store.read(0, 10)).byteLength, 0);
    assert.deepEqual(await store.read(10 * second + 5, 100), audio(10 * second + 5, 100));
    assert.equal((await store.read(69 * second, 10 * second)).byteLength, second); // only what exists
    assert.equal(readBlocks([{ offset: 0, bytes: audio(0, 4) }, { offset: 8, bytes: audio(8, 4) }], 0, 100).byteLength, 4);
  });

  test('events get increasing seq numbers; dropped ones are gone', async () => {
    const db = new MemoryRecordingDb();
    const store = await db.create({ id: 'r', docId: 'd', title: 'x', liveTranscribe: true });
    await store.addEvent({ t: 0, slide: 1 });
    await store.addEvent({ t: 5, slide: 2 });
    await store.addEvent({ t: 9, slide: 3 });
    assert.deepEqual((await store.pendingEvents(2)).map((e) => e.seq), [1, 2]);
    await store.dropEvents(2);
    assert.deepEqual(await store.pendingEvents(10), [{ seq: 3, t: 9, slide: 3 }]);
    await store.destroy();
    assert.equal(await store.load(), null);
    assert.deepEqual(await db.list(), []);
  });
});

describe('backoff', () => {
  test('250 ms doubling to 4 s, ±25 % jitter', () => {
    const seq: number[] = [];
    let b = 0;
    for (let i = 0; i < 7; i++) seq.push((b = nextBackoff(b, 250, 4000)));
    assert.deepEqual(seq, [250, 500, 1000, 2000, 4000, 4000, 4000]);
    assert.equal(jitter(1000, () => 0), 750);
    assert.equal(jitter(1000, () => 1), 1250);
    assert.equal(offsetOf({ offset: 12 }), 12);
    assert.equal(offsetOf({ offset: -1 }), null);
    assert.equal(offsetOf(null), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A fake server implementing the contract (POST audio?offset, slides, pause, resume, stop; GET recording)
// ---------------------------------------------------------------------------------------------------------------

type Fault =
  | 'network' // the request never arrives
  | 'lost' // the server handles it, the answer is lost
  | '502'
  | '429'
  | '401';

class FakeServer {
  data = new Uint8Array(0);
  status: RecordingInfo['status'] = 'recording';
  slides: SlideViewEvent[] = [];
  log: string[] = [];
  faults: Fault[] = [];
  inFlight = 0;
  maxInFlight = 0;
  deleted = false;
  retryAfter = 0;
  /** Largest body accepted (413 above). */
  maxBody = Infinity;

  info(): RecordingInfo {
    return {
      id: 'rec-1',
      docId: 'doc-1',
      title: '녹음',
      source: 'live',
      status: this.status,
      language: 'ko',
      model: 'm',
      liveTranscribe: true,
      createdAt: '2026-09-27T00:00:00Z',
      durationSec: bytesToSeconds(this.data.byteLength),
      transcriptStatus: 'running',
      transcribedSec: 0,
      alignment: 'timeline',
      hasManualMarkers: false,
      playback: null,
    };
  }

  http: UploaderHttp = async (method, path, body) => {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const fault = this.faults.shift();
      if (fault === 'network') throw new TypeError('Failed to fetch');
      if (fault === '502') return { status: 502, json: null, retryAfter: 0 };
      if (fault === '429') return { status: 429, json: { error: 'busy' }, retryAfter: this.retryAfter };
      if (fault === '401') return { status: 401, json: { error: 'login required' }, retryAfter: 0 };
      const res = this.handle(method, path, body);
      if (fault === 'lost') throw new DOMException('The operation timed out.', 'TimeoutError');
      return res;
    } finally {
      this.inFlight--;
    }
  };

  private handle(method: string, path: string, body: Uint8Array | string | null): HttpResult {
    const m = /^\/api\/docs\/doc-1\/recordings\/rec-1(\/[a-z]+)?(?:\?offset=(\d+))?$/.exec(path);
    assert.ok(m, `unexpected path ${path}`);
    const route = `${method} ${m[1] ?? ''}`;
    this.log.push(route.trim() + (m[2] !== undefined ? ` ${m[2]}` : ''));
    if (this.deleted) return { status: 404, json: { error: 'not found' }, retryAfter: 0 };
    const live = this.status === 'recording' || this.status === 'paused';
    switch (route) {
      case 'GET ':
        return { status: 200, json: this.info(), retryAfter: 0 };
      case 'POST /audio': {
        assert.ok(body instanceof Uint8Array);
        if (body.byteLength > this.maxBody) return { status: 413, json: { error: 'too large' }, retryAfter: 0 };
        // Stopped: like the server, 409 with its offset (the bytes already stored would be acknowledged again).
        if (!live) return { status: 409, json: { error: '녹음이 이미 끝났습니다', offset: this.data.byteLength }, retryAfter: 0 };
        const offset = Number(m[2]);
        const have = this.data.byteLength;
        if (offset > have) return { status: 409, json: { error: 'gap', offset: have }, retryAfter: 0 };
        // The overlap must match what is stored (a retry of the same bytes); only the tail is appended.
        const overlap = Math.min(have - offset, body.byteLength);
        assert.deepEqual(body.subarray(0, overlap), this.data.subarray(offset, offset + overlap));
        this.data = concatBytes([this.data, body.subarray(overlap)]);
        return { status: 200, json: { offset: this.data.byteLength }, retryAfter: 0 };
      }
      case 'POST /slides':
        assert.equal(typeof body, 'string');
        this.slides.push(...(JSON.parse(body as string) as SlideViewEvent[]));
        return { status: 204, json: null, retryAfter: 0 };
      case 'POST /pause':
      case 'POST /resume':
        if (!live) return { status: 409, json: { error: 'not live' }, retryAfter: 0 };
        this.status = route === 'POST /pause' ? 'paused' : 'recording';
        return { status: 200, json: this.info(), retryAfter: 0 };
      case 'POST /stop':
        assert.deepEqual(JSON.parse(body as string), { bytes: this.data.byteLength });
        if (!live) return { status: 409, json: { error: 'already stopped' }, retryAfter: 0 };
        this.status = 'ready';
        return { status: 200, json: this.info(), retryAfter: 0 };
      default:
        assert.fail(`unexpected route ${route}`);
    }
  }
}

interface Harness {
  server: FakeServer;
  store: RecordingStore;
  uploader: LiveUploader;
  waits: Array<{ ms: number }>;
  fatal: Array<{ reason: UploaderFatal; detail: string }>;
  done: Array<RecordingInfo | null>;
  auth: { calls: number; release: () => void };
}

async function harness(
  options: { authGate?: boolean; maxBatchBytes?: number; onStatus?: (s: UploaderStatus) => void } = {},
): Promise<Harness> {
  const server = new FakeServer();
  const db = new MemoryRecordingDb(() => 0);
  const store = await db.create({ id: 'rec-1', docId: 'doc-1', title: '녹음', liveTranscribe: true });
  const waits: Array<{ ms: number }> = [];
  const fatal: Harness['fatal'] = [];
  const done: Harness['done'] = [];
  let release = () => {};
  const auth = {
    calls: 0,
    release: () => release(),
  };
  const uploader = new LiveUploader({
    docId: 'doc-1',
    recordingId: 'rec-1',
    store,
    http: server.http,
    waitForAuth: () => {
      auth.calls++;
      if (!options.authGate) return Promise.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    // Every wait is recorded and takes at most 2 ms of real time.
    wait: (ms, wake) => {
      waits.push({ ms });
      return Promise.race([wake, new Promise<void>((r) => setTimeout(r, Math.min(ms, 2)))]);
    },
    random: () => 0.5, // jitter factor exactly 1
    maxBatchBytes: options.maxBatchBytes,
    onStatus: options.onStatus,
    onFatal: (reason, detail) => fatal.push({ reason, detail }),
    onDone: (info) => done.push(info),
  });
  return { server, store, uploader, waits, fatal, done, auth };
}

async function capture(store: RecordingStore, seconds: number): Promise<void> {
  const st = (await store.load())!;
  for (let i = 0; i < seconds; i++) {
    const from = st.captured + i * BYTES_PER_SECOND;
    await store.appendAudio(audio(from, BYTES_PER_SECOND));
  }
}

async function stopAt(store: RecordingStore): Promise<void> {
  const st = (await store.load())!;
  await store.update({ stopBytes: st.captured });
}

describe('LiveUploader against the contract', () => {
  test('sends the audio from the acknowledged offset, one request in flight, then stops', async () => {
    const h = await harness();
    await capture(h.store, 5);
    await stopAt(h.store);
    await h.uploader.start();
    assert.deepEqual(h.server.data, audio(0, 5 * BYTES_PER_SECOND));
    assert.equal(h.server.maxInFlight, 1);
    assert.deepEqual(h.server.log, ['POST /audio 0', 'POST /stop']); // the backlog goes in one batch
    assert.equal(h.done.length, 1);
    assert.equal(h.done[0]?.status, 'ready');
    const st = (await h.store.load())!;
    assert.equal(st.acked, 5 * BYTES_PER_SECOND);
    assert.equal(st.stopAcked, true);
    assert.deepEqual(h.fatal, []);
  });

  test('audio arriving while it runs is sent as it comes (≥ 1 s per request), in order', async () => {
    const h = await harness();
    const run = h.uploader.start();
    for (let i = 0; i < 4; i++) {
      await capture(h.store, 1);
      h.uploader.notify();
      await new Promise((r) => setTimeout(r, 5));
    }
    await stopAt(h.store);
    h.uploader.notify();
    await run;
    assert.deepEqual(h.server.data, audio(0, 4 * BYTES_PER_SECOND));
    assert.equal(h.server.maxInFlight, 1);
    const offsets = h.server.log.filter((l) => l.startsWith('POST /audio')).map((l) => Number(l.split(' ')[2]));
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
    assert.ok(offsets.every((o) => o % BYTES_PER_SECOND === 0));
    assert.equal(h.server.log.at(-1), 'POST /stop');
  });

  test('a lost answer is resent from the same offset and absorbed as a duplicate', async () => {
    const h = await harness();
    await capture(h.store, 3);
    await stopAt(h.store);
    h.server.faults = ['lost'];
    await h.uploader.start();
    assert.deepEqual(h.server.data, audio(0, 3 * BYTES_PER_SECOND)); // byte-exact, nothing appended twice
    assert.deepEqual(h.server.log, ['POST /audio 0', 'POST /audio 0', 'POST /stop']);
    assert.equal(h.waits[0].ms, 250); // backed off once
  });

  test('a 409 gap moves the offset back to the server’s and resends the bytes kept here', async () => {
    const h = await harness();
    await capture(h.store, 3);
    h.uploader.flush();
    const run = h.uploader.start();
    // Wait for the first commit, then the server loses its last second (torn write after a crash).
    while ((await h.store.load())!.acked < 3 * BYTES_PER_SECOND) await new Promise((r) => setTimeout(r, 1));
    h.server.data = h.server.data.slice(0, 2 * BYTES_PER_SECOND);
    await capture(h.store, 1);
    await stopAt(h.store);
    h.uploader.notify();
    await run;
    assert.deepEqual(h.server.data, audio(0, 4 * BYTES_PER_SECOND));
    const audioPosts = h.server.log.filter((l) => l.startsWith('POST /audio'));
    assert.deepEqual(audioPosts, ['POST /audio 0', `POST /audio ${3 * BYTES_PER_SECOND}`, `POST /audio ${2 * BYTES_PER_SECOND}`]);
  });

  test('acknowledged audio the server lost and this device no longer keeps is reported, not skipped', async () => {
    const h = await harness();
    await capture(h.store, 62); // more than the 60 s kept after the ack
    h.uploader.flush();
    const run = h.uploader.start();
    while ((await h.store.load())!.acked < 62 * BYTES_PER_SECOND) await new Promise((r) => setTimeout(r, 1));
    h.server.data = new Uint8Array(0); // restored from an old backup
    await capture(h.store, 1);
    h.uploader.flush();
    await run;
    assert.deepEqual(h.fatal.map((f) => f.reason), ['data-lost']);
  });

  test('5xx and network errors back off 250 ms → 4 s; Retry-After is honoured; success resets it', async () => {
    const statuses: string[] = [];
    const h = await harness({ onStatus: (s) => statuses.push(s.online ? 'online' : `offline:${s.retryInMs}`) });
    await capture(h.store, 1);
    await stopAt(h.store);
    h.server.retryAfter = 3;
    h.server.faults = ['502', 'network', '502', '429'];
    await h.uploader.start();
    assert.deepEqual(h.waits.map((w) => w.ms).slice(0, 4), [250, 500, 1000, 3000]);
    assert.deepEqual(h.server.data, audio(0, BYTES_PER_SECOND));
    assert.ok(statuses.includes('offline:3000'));
    assert.equal(statuses.at(-1), 'online');
  });

  test('a 401 waits for the login, then continues where it was', async () => {
    const h = await harness({ authGate: true });
    await capture(h.store, 2);
    await stopAt(h.store);
    h.server.faults = ['401'];
    const run = h.uploader.start();
    while (h.auth.calls === 0) await new Promise((r) => setTimeout(r, 1));
    assert.equal(h.uploader.getStatus().authRequired, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.server.data.byteLength, 0); // nothing sent meanwhile
    h.auth.release();
    await run;
    assert.equal(h.uploader.getStatus().authRequired, false);
    assert.deepEqual(h.server.data, audio(0, 2 * BYTES_PER_SECOND));
  });

  test('pause goes after the audio before it; resume goes before the audio after it', async () => {
    const h = await harness();
    await capture(h.store, 2);
    await h.store.update({ wantPaused: true });
    const run = h.uploader.start();
    while (h.server.status !== 'paused') await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(h.server.log, ['POST /audio 0', 'POST /pause']);
    assert.equal((await h.store.load())!.serverPaused, true);
    await h.store.update({ wantPaused: false });
    await capture(h.store, 1);
    await stopAt(h.store);
    h.uploader.notify();
    await run;
    assert.deepEqual(h.server.log, [
      'POST /audio 0',
      'POST /pause',
      'POST /resume',
      `POST /audio ${2 * BYTES_PER_SECOND}`,
      'POST /stop',
    ]);
  });

  test('slide-view events go in batches of ≤ 200, alternating with a long audio backlog, each exactly once', async () => {
    const h = await harness({ maxBatchBytes: 4 * BYTES_PER_SECOND });
    await capture(h.store, 12);
    for (let i = 0; i < 450; i++) await h.store.addEvent({ t: i / 10, slide: 1 + (i % 7) });
    await stopAt(h.store);
    await h.uploader.start();
    assert.equal(h.server.slides.length, 450);
    assert.deepEqual(h.server.slides[449], { t: 44.9, slide: 1 + (449 % 7) });
    const kinds = h.server.log.map((l) => (l.startsWith('POST /slides') ? 'S' : l.startsWith('POST /audio') ? 'A' : l));
    assert.deepEqual(kinds, ['A', 'S', 'A', 'S', 'A', 'S', 'POST /stop']);
    assert.deepEqual(h.server.data, audio(0, 12 * BYTES_PER_SECOND));
  });

  test('a recording deleted on the server stops the uploader (gone)', async () => {
    const h = await harness();
    await capture(h.store, 2);
    h.server.deleted = true;
    h.uploader.flush();
    await h.uploader.start();
    assert.deepEqual(h.fatal.map((f) => f.reason), ['gone']);
  });

  test('a recording stopped elsewhere: 409 with our own offset → GET says it is not live → not-live', async () => {
    const h = await harness();
    await capture(h.store, 2);
    h.server.status = 'ready';
    h.uploader.flush();
    await h.uploader.start();
    assert.deepEqual(h.server.log, ['POST /audio 0', 'GET']);
    assert.deepEqual(h.fatal.map((f) => f.reason), ['not-live']);
  });

  test('a pause refused (409 without an offset) while the server still records: asks, then backs off, no tight loop', async () => {
    const h = await harness();
    await h.store.update({ wantPaused: true });
    // A server that keeps refusing the pause although it records.
    const http = h.server.http;
    let pauses = 0;
    const stubborn: UploaderHttp = async (method, path, body, ct, timeout) => {
      if (path.endsWith('/pause')) {
        pauses++;
        return { status: 409, json: { error: '녹음 중이 아닙니다' }, retryAfter: 0 };
      }
      return http(method, path, body, ct, timeout);
    };
    const uploader = new LiveUploader({
      docId: 'doc-1',
      recordingId: 'rec-1',
      store: h.store,
      http: stubborn,
      waitForAuth: async () => {},
      wait: (ms, wake) => {
        h.waits.push({ ms });
        return Promise.race([wake, new Promise<void>((r) => setTimeout(r, 1))]);
      },
      random: () => 0.5,
    });
    const run = uploader.start();
    while (pauses < 6) await new Promise((r) => setTimeout(r, 1));
    uploader.close();
    await run;
    assert.ok(h.waits.some((w) => w.ms >= 250), 'backed off');
    assert.ok(h.server.log.filter((l) => l === 'GET').length <= pauses);
  });

  test('a stop answered 409 (already stopped by a lost answer) still finishes', async () => {
    const h = await harness();
    await capture(h.store, 1);
    await stopAt(h.store);
    await h.uploader.start();
    // Second uploader for the same local state after a reload before stopAcked was stored: nothing left.
    await h.store.update({ stopAcked: false });
    let doneCalls = 0;
    const again = new LiveUploader({
      docId: 'doc-1',
      recordingId: 'rec-1',
      store: h.store,
      http: h.server.http,
      waitForAuth: async () => {},
      wait: async () => {},
      onDone: () => doneCalls++,
    });
    await again.start();
    assert.equal(doneCalls, 1);
    assert.equal((await h.store.load())!.stopAcked, true);
  });

  test('413 halves the batch size and goes on', async () => {
    const h = await harness();
    await capture(h.store, 8);
    await stopAt(h.store);
    h.server.maxBody = 3 * BYTES_PER_SECOND;
    await h.uploader.start();
    assert.deepEqual(h.server.data, audio(0, 8 * BYTES_PER_SECOND));
    assert.equal(h.server.maxInFlight, 1);
  });

  test('slide-view events refused for good (400) are dropped and reported; the stop behind them still goes out', async () => {
    const h = await harness();
    const refused: Array<{ count: number; detail: string }> = [];
    const http = h.server.http;
    const strict: UploaderHttp = async (method, path, body, ct, timeout) => {
      if (path.endsWith('/slides')) {
        h.server.log.push('POST /slides 400');
        return { status: 400, json: { error: '잘못된 슬라이드 이벤트입니다' }, retryAfter: 0 };
      }
      return http(method, path, body, ct, timeout);
    };
    const uploader = new LiveUploader({
      docId: 'doc-1',
      recordingId: 'rec-1',
      store: h.store,
      http: strict,
      waitForAuth: async () => {},
      wait: (ms, wake) => {
        h.waits.push({ ms });
        return Promise.race([wake, new Promise<void>((r) => setTimeout(r, 1))]);
      },
      random: () => 0.5,
      onEventsRefused: (count, detail) => refused.push({ count, detail }),
      onDone: (info) => h.done.push(info),
    });
    await capture(h.store, 2);
    await h.store.addEvent({ t: 0, slide: 999 });
    await h.store.addEvent({ t: 1, slide: 998 });
    await stopAt(h.store);
    await uploader.start();
    assert.deepEqual(refused, [{ count: 2, detail: 'HTTP 400: 잘못된 슬라이드 이벤트입니다' }]);
    assert.equal(h.server.log.filter((l) => l.startsWith('POST /slides')).length, 1, 'not retried');
    assert.equal(h.server.status, 'ready');
    assert.equal(h.done.length, 1);
    assert.deepEqual(await h.store.pendingEvents(10), []);
    assert.ok(!h.waits.some((w) => w.ms >= 250), 'no backoff');
  });

  test('close() ends the loop and keeps the local state for a later uploader', async () => {
    const h = await harness();
    await capture(h.store, 1);
    const run = h.uploader.start();
    await new Promise((r) => setTimeout(r, 10));
    h.uploader.close();
    await run;
    const st = (await h.store.load())!;
    assert.equal(st.stopAcked, false);
    assert.equal(h.uploader.isClosed, true);
  });
});
