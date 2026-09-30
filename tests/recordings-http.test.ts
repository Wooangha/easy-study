// Lecture recordings over HTTP (DESIGN §22) with a fake whisper-cli and a fake ffmpeg (tests/fixtures): live
// recording (offset uploads, pause/resume/stop, windows transcribed while recording, no text lost or duplicated at
// hard cuts, timestamps on the recording clock), SSE replay, live WAV playback with Range, uploads streamed to disk
// (a large generated body, size limits, sniffing, conversion errors), markers, AI alignment through a fake
// provider, the tutor context, deletion, restart recovery, GET /api/asr and remote-mode 401s.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type {
  AsrStatus,
  RecordingEvent,
  RecordingInfo,
  RecordingTranscript,
  Session,
  StreamEvent,
  ProviderInfo,
} from '../shared/types.ts';
import { defaultChatDeps } from '../server/chat.ts';
import type { ChatDeps } from '../server/chat.ts';
import type { GpuOptions } from '../server/recordings/asr.ts';
import { repoRoot } from '../server/config.ts';
import { requestBodyDeadline, startServer } from '../server/index.ts';
import type { RunningServer, ServerOptions } from '../server/index.ts';
import { LECTURE_RECORDINGS_NOTE } from '../server/prompts.ts';
import type { Part, Provider, ProviderRunInput } from '../server/providers/types.ts';
import { FOLLOW_LAG_SEC } from '../server/recordings/align/align.ts';
import { ModelStore } from '../server/recordings/models.ts';
import type { ModelCatalog } from '../server/recordings/models.ts';
import { WINDOW_PRESETS } from '../server/recordings/segmenter.ts';
import type { AsrWindow } from '../server/recordings/segmenter.ts';
import { loadedRecordings, queueState, waitForTranscriptionIdle } from '../server/recordings/service.ts';
import { tonesPcm } from './recordingFixtures.ts';

const FAKE_WHISPER = path.join(repoRoot(), 'tests', 'fixtures', 'fake-whisper.mjs');
const FAKE_FFMPEG = path.join(repoRoot(), 'tests', 'fixtures', 'fake-ffmpeg.mjs');
const DOC = 'lecture-abc123';
const OTHER_DOC = 'other-def456';

let tmp = '';
let library = '';
let modelsDir = '';
let whisperLog = '';

const catalog = (): ModelCatalog => ({
  models: [
    { id: 'large-v3-turbo-q5_0', label: 'turbo', file: 'turbo.bin', url: 'http://127.0.0.1:9/turbo', sizeBytes: 16, sha256: '0' },
    { id: 'small-q5_1', label: 'small', file: 'small.bin', url: 'http://127.0.0.1:9/small', sizeBytes: 8, sha256: '0', carryContext: true },
  ],
  vad: { file: 'vad.bin', url: 'http://127.0.0.1:9/vad', sizeBytes: 4, sha256: '0' },
});

async function makeDoc(docId: string, pageCount = 3): Promise<void> {
  const dir = path.join(library, docId);
  await fs.mkdir(path.join(dir, 'text'), { recursive: true });
  await fs.mkdir(path.join(dir, 'slides'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'doc.json'),
    JSON.stringify({ id: docId, title: 'Parsing', fileName: 'Parsing.pdf', pageCount, aspectRatio: 4 / 3, status: 'ready', progress: pageCount, createdAt: new Date().toISOString() }),
  );
  const texts = ['Lexical analysis tokens', 'FIRST sets', 'FOLLOW sets', 'LL(1) table', 'Error recovery'];
  for (let i = 1; i <= pageCount; i++) await fs.writeFile(path.join(dir, 'text', `${String(i).padStart(3, '0')}.txt`), texts[i - 1] ?? `slide ${i}`);
}

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-rec-http-')));
  library = path.join(tmp, 'library');
  modelsDir = path.join(tmp, 'models');
  whisperLog = path.join(tmp, 'whisper.log');
  await fs.mkdir(library, { recursive: true });
  await fs.mkdir(modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelsDir, 'turbo.bin'), Buffer.alloc(16));
  await fs.writeFile(path.join(modelsDir, 'small.bin'), Buffer.alloc(8));
  await fs.writeFile(path.join(modelsDir, 'vad.bin'), Buffer.alloc(4));
  process.env.EASY_STUDY_LIBRARY = library;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
  process.env.EASY_STUDY_WHISPER = FAKE_WHISPER;
  process.env.EASY_STUDY_FFMPEG = FAKE_FFMPEG;
  process.env.FAKE_WHISPER_LOG = whisperLog;
  await makeDoc(DOC);
  await makeDoc(OTHER_DOC);
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

function fakeProvider() {
  const calls: ProviderRunInput[] = [];
  let reply: (input: ProviderRunInput) => string = () => 'ok';
  const provider: Provider = {
    id: 'claude-code',
    label: 'Fake Claude Code',
    kind: 'cli',
    models: [
      { id: '', label: 'default' },
      { id: 'haiku', label: 'Haiku' },
    ],
    defaultModel: '',
    maxImagesPerConversation: 48,
    detect: async () => ({ available: true }),
    run: async (input) => {
      calls.push(input);
      const text = reply(input);
      input.onDelta(text);
      return { text, resume: { cliSessionId: `cli-${calls.length}` } };
    },
  };
  return {
    provider,
    calls,
    setReply: (fn: (input: ProviderRunInput) => string) => {
      reply = fn;
    },
  };
}

const infos: ProviderInfo[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'cli',
    available: true,
    models: [
      { id: '', label: 'default' },
      { id: 'haiku', label: 'Haiku' },
    ],
    defaultModel: '',
  },
];

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class Client {
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  api(target: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}/api${target}`, init);
  }
  async json<T>(target: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.api(target, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
  async audio(docId: string, rid: string, offset: number, chunk: Buffer): Promise<{ status: number; body: { offset: number; error?: string } }> {
    const res = await this.api(`/docs/${docId}/recordings/${rid}/audio?offset=${offset}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    return { status: res.status, body: (await res.json()) as { offset: number; error?: string } };
  }
  recording(docId: string, rid: string): Promise<RecordingInfo> {
    return this.json<RecordingInfo>(`/docs/${docId}/recordings/${rid}`).then((r) => r.body);
  }
  transcript(docId: string, rid: string): Promise<RecordingTranscript> {
    return this.json<RecordingTranscript>(`/docs/${docId}/recordings/${rid}/transcript`).then((r) => r.body);
  }
}

interface SseFrame {
  id?: number;
  event: string;
  data: RecordingEvent;
}

/** Reads an SSE stream in the background until close(). */
function openSse(url: string, headers: Record<string, string> = {}) {
  const frames: SseFrame[] = [];
  const controller = new AbortController();
  let status = 0;
  const done = (async () => {
    const res = await fetch(url, { headers, signal: controller.signal });
    status = res.status;
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        const id = /^id: (\d+)$/m.exec(raw)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data) as RecordingEvent, id: id ? Number(id) : undefined });
      }
    }
  })().catch(() => {});
  return {
    frames,
    get status() {
      return status;
    },
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

async function readWindows(docId: string, rid: string): Promise<AsrWindow[]> {
  const text = await fs.readFile(path.join(library, docId, 'recordings', rid, 'windows.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AsrWindow);
}

function assertTiling(windows: AsrWindow[], totalMs: number): void {
  assert.equal(windows[0].ownStartMs, 0);
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i].ownStartMs, windows[i - 1].ownEndMs);
  assert.equal(windows.at(-1)?.ownEndMs, totalMs);
}

/** Tone k (1.2 s at 300 + 20k Hz) every 2 s from 0.3 s: silences of 0.8 s between. */
function spacedTones(count: number) {
  return Array.from({ length: count }, (_, k) => ({ start: k * 2 + 0.3, end: k * 2 + 1.5, hz: 300 + 20 * k }));
}

function assertEachToneOnce(transcript: RecordingTranscript, tones: Array<{ start: number; end: number; hz: number }>): void {
  const texts = transcript.segments.map((s) => s.text);
  for (const tone of tones) {
    const found = transcript.segments.filter((s) => s.text === `tone-${tone.hz}`);
    assert.equal(found.length, 1, `tone-${tone.hz} found ${found.length} times in ${JSON.stringify(texts)}`);
    assert.ok(Math.abs(found[0].start - tone.start) <= 0.04, `tone-${tone.hz} starts at ${found[0].start}, expected ${tone.start}`);
    assert.ok(Math.abs(found[0].end - tone.end) <= 0.04, `tone-${tone.hz} ends at ${found[0].end}, expected ${tone.end}`);
  }
  assert.equal(transcript.segments.length, tones.length, JSON.stringify(texts));
  const ids = transcript.segments.map((s) => s.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids increase with time');
  assert.equal(new Set(ids).size, ids.length);
}

// ---------------------------------------------------------------------------------------------------------------

describe('lecture recordings over HTTP (fake whisper-cli / ffmpeg)', () => {
  let server: RunningServer;
  let client: Client;
  const fake = fakeProvider();
  const deps: ChatDeps = {
    ...defaultChatDeps(),
    getProvider: (id) => (id === 'claude-code' ? fake.provider : undefined),
    checkProvider: async () => ({ available: true }),
    cliSlot: undefined,
  };
  const options = (): ServerOptions => ({
    port: 0,
    log: false,
    resumeIngests: false,
    providerInfos: async () => infos,
    chatDeps: deps,
    recordings: {
      models: new ModelStore({ dir: () => modelsDir, catalog: catalog() }),
      maxUploadBytes: 512 * 1024 * 1024,
      livePreset: WINDOW_PRESETS.live,
      pingMs: 150,
      statusThrottleMs: 20,
      liveRealignMs: 0,
    },
  });

  before(async () => {
    server = await startServer(options());
    client = new Client(server.url);
  });

  after(async () => {
    await server?.close();
  });

  test('GET /api/asr: engine, ffmpeg, acceleration and the models (installed, recommended)', async () => {
    const { status, body } = await client.json<AsrStatus>('/asr');
    assert.equal(status, 200);
    assert.equal(body.engineAvailable, true);
    assert.equal(body.engineVersion, '1.9.4-fake');
    assert.equal(body.ffmpegAvailable, true);
    assert.equal(body.acceleration, process.platform === 'darwin' && process.arch === 'arm64' ? 'metal' : 'cpu');
    assert.equal(body.gpu, undefined, 'the test engine has no Vulkan part');
    assert.equal(body.gpuError, undefined);
    assert.deepEqual(
      body.models.map((m) => [m.id, m.installed]),
      [
        ['large-v3-turbo-q5_0', true],
        ['small-q5_1', true],
      ],
    );
    assert.equal(body.models.filter((m) => m.recommended).length, 1);
    assert.equal((await client.json('/asr/models/nope/download', 'POST')).status, 404);
    assert.equal((await client.json('/asr/models/BAD ID/download', 'POST')).status, 404);
  });

  test('live recording: offsets, retries, pause/resume/stop; windows transcribed while recording; every tone once, on the recording clock', async () => {
    await fs.rm(whisperLog, { force: true });
    // Unknown recording: a JSON 404 before any stream opens.
    const missing = await fetch(`${server.url}/api/docs/${DOC}/recordings/rec-20260101-000000-0000/events`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
    await missing.arrayBuffer();

    const created = await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', { title: '7강 녹음', language: 'ko' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rec = created.body;
    assert.match(rec.id, /^rec-\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.equal(rec.status, 'recording');
    assert.equal(rec.source, 'live');
    assert.equal(rec.title, '7강 녹음');
    assert.equal(rec.language, 'ko');
    assert.equal(rec.liveTranscribe, true);
    assert.equal(rec.playback, null);
    // One live recording per server; the refusal says which one runs (and in which lecture).
    const second = await client.json<{ error: string; recording: RecordingInfo }>(`/docs/${OTHER_DOC}/recordings`, 'POST', {});
    assert.equal(second.status, 409);
    assert.equal(second.body.recording.id, rec.id);
    assert.match(second.body.error, /‘Parsing’의 ‘7강 녹음’/);

    const sse = openSse(`${server.url}/api/docs/${DOC}/recordings/${rec.id}/events`);
    const tones = spacedTones(47);
    const pcm = tonesPcm(95, tones);
    const chunk = 32_000;
    await client.json(`/docs/${DOC}/recordings/${rec.id}/slides`, 'POST', [
      { t: 0, slide: 1 },
      { t: 40, slide: 2 },
      { t: 70, slide: 3 },
    ]);
    let offset = 0;
    let requests = 0;
    while (offset < pcm.length) {
      const piece = pcm.subarray(offset, Math.min(pcm.length, offset + chunk));
      requests++;
      if (requests === 5) {
        // A gap: the server answers with its offset.
        const gap = await client.audio(DOC, rec.id, offset + chunk, piece);
        assert.equal(gap.status, 409);
        assert.equal(gap.body.offset, offset);
      }
      if (requests === 8) {
        // A lost answer: the client resends the previous chunk too (overlap), only the tail is appended.
        const again = await client.audio(DOC, rec.id, offset - chunk, pcm.subarray(offset - chunk, offset + piece.length));
        assert.equal(again.status, 200);
        assert.equal(again.body.offset, offset + piece.length);
        offset = again.body.offset;
        continue;
      }
      const res = await client.audio(DOC, rec.id, offset, piece);
      assert.equal(res.status, 200, res.body.error ?? "");
      assert.equal(res.body.offset, offset + piece.length);
      if (requests === 12) {
        const dup = await client.audio(DOC, rec.id, offset, piece);
        assert.equal(dup.status, 200);
        assert.equal(dup.body.offset, offset + piece.length);
      }
      offset = res.body.offset;
      if (offset === chunk * 50) {
        const paused = await client.json<RecordingInfo>(`/docs/${DOC}/recordings/${rec.id}/pause`, 'POST');
        assert.equal(paused.body.status, 'paused');
        assert.equal((await client.json<RecordingInfo>(`/docs/${DOC}/recordings/${rec.id}/resume`, 'POST')).body.status, 'recording');
      }
    }
    // Odd byte counts are not PCM samples.
    assert.equal((await client.audio(DOC, rec.id, offset, Buffer.alloc(3))).status, 400);
    const live = await client.recording(DOC, rec.id);
    assert.equal(live.durationSec, 95);
    assert.deepEqual(live.playback, { url: `/api/docs/${DOC}/recordings/${rec.id}/audio`, mime: 'audio/wav' });
    // Windows were transcribed while recording.
    await waitFor(async () => (await client.recording(DOC, rec.id)).transcribedSec >= 50, 20_000, 'live transcription');

    const stopped = await client.json<RecordingInfo>(`/docs/${DOC}/recordings/${rec.id}/stop`, 'POST', { bytes: pcm.length });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.status, 'ready');
    await waitFor(async () => {
      const info = await client.recording(DOC, rec.id);
      return info.transcriptStatus === 'ready' && info.alignment === 'lexical';
    }, 30_000, 'transcription + alignment');
    // Audio after the stop is refused; a retry of stored bytes is still acknowledged.
    assert.equal((await client.audio(DOC, rec.id, pcm.length, Buffer.alloc(2000))).status, 409);
    assert.equal((await client.audio(DOC, rec.id, 0, pcm.subarray(0, 2000))).status, 200);

    const stored = await fs.readFile(path.join(library, DOC, 'recordings', rec.id, 'audio.pcm'));
    assert.equal(createHash('sha256').update(stored).digest('hex'), createHash('sha256').update(pcm).digest('hex'), 'byte-exact audio');
    const windows = await readWindows(DOC, rec.id);
    assertTiling(windows, 95_000);
    assert.ok(windows.some((w) => w.cut === 'break' && w.ownEndMs === 50_000), 'the pause cut a window');
    for (const w of windows.filter((x) => x.cut === 'silence')) {
      assert.ok(w.ownEndMs - w.ownStartMs >= 20_000 && w.ownEndMs - w.ownStartMs <= 30_000, JSON.stringify(w));
    }
    const transcript = await client.transcript(DOC, rec.id);
    assertEachToneOnce(transcript, tones);
    // Slides from the viewing timeline (no lexical evidence in "tone-…"), read FOLLOW_LAG_SEC late.
    for (const s of transcript.segments) {
      const at = (s.start + s.end) / 2 + FOLLOW_LAG_SEC;
      assert.equal(s.slide, at < 40 ? 1 : at < 70 ? 2 : 3, `${s.text} at ${at}`);
    }
    // whisper-cli got the forced language, VAD and JSON output; one run per window with speech, never two at once.
    const runs = (await fs.readFile(whisperLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[] });
    assert.equal(runs.length, windows.filter((w) => w.speechMs >= 300).length);
    for (const run of runs) {
      assert.equal(run.args[run.args.indexOf('-l') + 1], 'ko');
      assert.ok(run.args.includes('--vad') && run.args.includes('-ojf'));
    }
    // Every segment reached the SSE subscriber exactly once, with its id.
    await waitFor(() => sse.frames.filter((f) => f.event === 'segment').length >= tones.length, 5_000, 'sse segments');
    const seen = sse.frames.filter((f) => f.event === 'segment').map((f) => f.id);
    assert.deepEqual(seen, transcript.segments.map((s) => s.id));
    assert.ok(sse.frames.some((f) => f.event === 'status'));
    assert.ok(sse.frames.some((f) => f.event === 'ping'));
    await sse.close();
    // Not live any more: another recording may start.
    const next = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings`, 'POST', { liveTranscribe: false });
    assert.equal(next.status, 201);
    assert.equal(next.body.transcriptStatus, 'none');
    assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings/${next.body.id}`, 'DELETE')).status, 204);
  });

  test('SSE replay: ?since and Last-Event-ID send only newer segments, then the slides of the older ones', async () => {
    const list = (await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body;
    const rec = list.find((r) => r.source === 'live' && r.transcriptStatus === 'ready');
    assert.ok(rec);
    const transcript = await client.transcript(DOC, rec.id);
    const since = transcript.segments[9].id;
    const a = openSse(`${server.url}/api/docs/${DOC}/recordings/${rec.id}/events?since=${since}`);
    await waitFor(() => a.frames.some((f) => f.event === 'realigned'), 5_000, 'replay');
    await a.close();
    assert.equal(a.frames[0].event, 'status');
    const replayed = a.frames.filter((f) => f.event === 'segment').map((f) => f.id);
    assert.deepEqual(replayed, transcript.segments.slice(10).map((s) => s.id));
    const realigned = a.frames.find((f) => f.event === 'realigned')?.data;
    assert.equal(realigned?.type === 'realigned' ? realigned.segments.length : 0, 10);
    // Last-Event-ID wins over ?since (EventSource sends it on its own reconnects).
    const b = openSse(`${server.url}/api/docs/${DOC}/recordings/${rec.id}/events?since=0`, { 'Last-Event-ID': String(transcript.segments.at(-2)?.id) });
    await waitFor(() => b.frames.some((f) => f.event === 'realigned'), 5_000, 'replay b');
    await b.close();
    assert.deepEqual(
      b.frames.filter((f) => f.event === 'segment').map((f) => f.id),
      [transcript.segments.at(-1)?.id],
    );
  });

  test('live playback: WAV header + stored PCM, Range requests (206, suffix, 416), HEAD', async () => {
    const rec = (await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body.find((r) => r.source === 'live');
    assert.ok(rec);
    const url = `${server.url}${rec.playback?.url}`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'audio/wav');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const body = Buffer.from(await full.arrayBuffer());
    assert.equal(body.length, 44 + 95 * 32000);
    assert.equal(body.toString('ascii', 0, 4), 'RIFF');
    assert.equal(body.readUInt32LE(40), 95 * 32000);
    const part = await fetch(url, { headers: { Range: 'bytes=40-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 40-99/${body.length}`);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(body.subarray(40, 100)));
    const tail = await fetch(url, { headers: { Range: 'bytes=-10' } });
    assert.ok(Buffer.from(await tail.arrayBuffer()).equals(body.subarray(body.length - 10)));
    const bad = await fetch(url, { headers: { Range: `bytes=${body.length}-` } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${body.length}`);
    await bad.arrayBuffer();
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(body.length));
  });

  test('hard cuts (no pause for 30 s): overlapping windows, still every tone exactly once', async () => {
    const created = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings`, 'POST', { language: 'en' });
    const rid = created.body.id;
    // 1.3 s tones with 100 ms gaps: no 200 ms silence anywhere.
    const tones = Array.from({ length: 50 }, (_, k) => ({ start: k * 1.4, end: k * 1.4 + 1.3, hz: 300 + 20 * k }));
    const pcm = tonesPcm(70, tones);
    for (let offset = 0; offset < pcm.length; offset += 64_000) {
      const res = await client.audio(OTHER_DOC, rid, offset, pcm.subarray(offset, offset + 64_000));
      assert.equal(res.status, 200, res.body.error ?? "");
    }
    await client.json(`/docs/${OTHER_DOC}/recordings/${rid}/stop`, 'POST');
    await waitFor(async () => (await client.recording(OTHER_DOC, rid)).transcriptStatus === 'ready', 30_000, 'transcription');
    const windows = await readWindows(OTHER_DOC, rid);
    assertTiling(windows, 70_000);
    assert.equal(windows[0].cut, 'max');
    assert.equal(windows[1].startMs, windows[1].ownStartMs - 1000, 'overlap after a hard cut');
    const transcript = await client.transcript(OTHER_DOC, rid);
    // Tones are 1.3 s with 100 ms gaps: the fake names each by frequency; the fades make ±1 frame acceptable.
    const texts = transcript.segments.map((s) => s.text);
    for (const tone of tones) assert.equal(texts.filter((t) => t === `tone-${tone.hz}`).length, 1, `tone-${tone.hz} in ${JSON.stringify(texts)}`);
    assert.equal(transcript.segments.length, tones.length);
  });

  test('SSE subscribers joining while windows are transcribed get every segment exactly once', async () => {
    const created = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings`, 'POST', { language: 'ko' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rid = created.body.id;
    const url = `${server.url}/api/docs/${OTHER_DOC}/recordings/${rid}/events`;
    const tones = spacedTones(40);
    const pcm = tonesPcm(80, tones);
    const streams: Array<ReturnType<typeof openSse>> = [];
    for (let offset = 0, k = 0; offset < pcm.length; offset += 32_000, k++) {
      const res = await client.audio(OTHER_DOC, rid, offset, pcm.subarray(offset, offset + 32_000));
      assert.equal(res.status, 200, res.body.error ?? '');
      streams.push(openSse(url));
      if (k % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await client.json(`/docs/${OTHER_DOC}/recordings/${rid}/stop`, 'POST');
    await waitFor(async () => (await client.recording(OTHER_DOC, rid)).transcriptStatus === 'ready', 30_000, 'transcription');
    const ids = (await client.transcript(OTHER_DOC, rid)).segments.map((s) => s.id);
    assert.equal(ids.length, tones.length);
    for (const [n, sse] of streams.entries()) {
      await waitFor(() => sse.frames.filter((f) => f.event === 'segment').length >= ids.length, 5_000, `subscriber ${n}`);
    }
    for (const [n, sse] of streams.entries()) {
      await sse.close();
      const seen = sse.frames.filter((f) => f.event === 'segment').map((f) => f.id);
      assert.deepEqual([...seen].sort((a, b) => (a ?? 0) - (b ?? 0)), ids, `subscriber ${n}: each segment once`);
    }
    assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings/${rid}`, 'DELETE')).status, 204);
  });

  test('markers: re-aligned with markers as hard constraints; hasManualMarkers', async () => {
    const rec = (await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body.find((r) => r.source === 'live' && r.transcriptStatus === 'ready');
    assert.ok(rec);
    const put = await client.json<RecordingTranscript>(`/docs/${DOC}/recordings/${rec.id}/markers`, 'PUT', [
      { t: 10, slide: 3 },
      { t: 60, slide: null },
      { t: 80, slide: 2 },
    ]);
    assert.equal(put.status, 200);
    const first = put.body.segments.find((s) => (s.start + s.end) / 2 >= 10);
    assert.equal(first?.slide, 3);
    for (const s of put.body.segments) {
      const mid = (s.start + s.end) / 2;
      if (mid >= 60 && mid < 80) assert.equal(s.slide, null, `${s.text} at ${mid}`);
    }
    assert.equal(put.body.segments.find((s) => (s.start + s.end) / 2 >= 80)?.slide, 2);
    assert.equal((await client.recording(DOC, rec.id)).hasManualMarkers, true);
    assert.equal((await client.json(`/docs/${DOC}/recordings/${rec.id}/markers`, 'PUT', [{ t: -1, slide: 1 }])).status, 400);
    assert.equal((await client.json(`/docs/${DOC}/recordings/${rec.id}/markers`, 'PUT', [{ t: 1, slide: 99 }])).status, 400);
    // Clearing the markers restores the timeline-based slides.
    const cleared = await client.json<RecordingTranscript>(`/docs/${DOC}/recordings/${rec.id}/markers`, 'PUT', []);
    assert.equal(cleared.body.segments[0].slide, 1);
    assert.equal((await client.recording(DOC, rec.id)).hasManualMarkers, false);
  });

  test('AI alignment: an ephemeral, tool-less call per ≤150 segments (haiku), fused into the DP', async () => {
    const rec = (await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body.find((r) => r.source === 'live' && r.transcriptStatus === 'ready');
    assert.ok(rec);
    const transcript = await client.transcript(DOC, rec.id);
    const before = fake.calls.length;
    fake.setReply(() => JSON.stringify([{ from: 0, to: transcript.segments.length - 1, slide: 2 }]));
    const res = await client.json(`/docs/${DOC}/recordings/${rec.id}/align-ai`, 'POST', { provider: 'claude-code' });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await waitFor(async () => (await client.recording(DOC, rec.id)).alignment === 'llm', 10_000, 'llm alignment');
    const call = fake.calls[before];
    assert.equal(call.ephemeral, true);
    assert.equal(call.allowTools, false);
    assert.equal(call.resume, null);
    assert.equal(call.model, 'haiku');
    assert.match(call.systemPrompt, /align a lecture's speech transcript/);
    const prompt = (call.parts[0] as Extract<Part, { type: 'text' }>).text;
    assert.match(prompt, /S2 \| \(title slide\) \|  \| slide text: FIRST sets/);
    assert.doesNotMatch(prompt, /draft/i);
    await waitFor(async () => (await client.transcript(DOC, rec.id)).segments.every((s) => s.slide !== null), 10_000, 'fused');
    // Where the timeline said 1 or 3 and the LLM says 2, the soft vote alone does not always win; where the text is
    // silent and the timeline has nothing better, the fused labels change.
    const fused = await client.transcript(DOC, rec.id);
    assert.ok(fused.segments.some((s) => s.slide === 2));
    assert.equal((await client.json(`/docs/${DOC}/recordings/${rec.id}/align-ai`, 'POST', { provider: 'nope' })).status, 400);
  });

  test('tutor context: what was said on the focused slides, and the last minutes while recording', async () => {
    const created = await client.json<Session>(`/docs/${DOC}/sessions`, 'POST', { provider: 'claude-code' });
    assert.equal(created.status, 201);
    fake.setReply(() => 'answer');
    const ask = async (slide: number) => {
      const res = await client.api(`/docs/${DOC}/sessions/${created.body.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '교수님이 뭐라고 했어?', slide, neighbors: 0 }),
      });
      const raw = await res.text();
      assert.equal(res.status, 200, raw);
      assert.ok(raw.includes('"type":"done"'), raw.slice(-300));
      const call = fake.calls.at(-1) as ProviderRunInput;
      return call.parts.map((p) => (p.type === 'text' ? p.text : '<image>')).join('\n');
    };
    const first = await ask(2);
    assert.ok(first.includes(LECTURE_RECORDINGS_NOTE), 'priming says recordings exist');
    assert.match(first, /What the professor said on slide 2 \(lecture recording, may contain transcription errors; English terms may be written in Hangul\):\ntone-/);
    assert.doesNotMatch(first, /The last \d+ minutes? of the lecture/);
    assert.ok(first.indexOf('What the professor said') < first.indexOf("Student's question"));

    // While a live recording of this document runs, its latest speech is included too.
    const live = await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', { language: 'ko' });
    const pcm = tonesPcm(24, spacedTones(12));
    await client.audio(DOC, live.body.id, 0, pcm);
    await client.json(`/docs/${DOC}/recordings/${live.body.id}/pause`, 'POST');
    await waitFor(async () => (await client.recording(DOC, live.body.id)).transcribedSec >= 24, 20_000, 'live window');
    const second = await ask(1);
    assert.match(second, /The last 1 minute of the lecture:\ntone-300 tone-320/);
    await client.json(`/docs/${DOC}/recordings/${live.body.id}`, 'DELETE');

    // A question while recording: the audio not in a window yet (live windows are 20–30 s) is cut at its last pause
    // and transcribed before the turn is built, so the speech right before the question is there.
    const running = await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', { language: 'ko' });
    await client.audio(DOC, running.body.id, 0, tonesPcm(12, spacedTones(6)));
    assert.equal((await client.recording(DOC, running.body.id)).transcribedSec, 0, 'no window due yet');
    const third = await ask(1);
    assert.match(third, /The last 1 minute of the lecture:\ntone-300 tone-320 tone-340 tone-360 tone-380 tone-400\n/);
    await client.json(`/docs/${DOC}/recordings/${running.body.id}`, 'DELETE');
  });

  test('uploads: streamed to disk, sniffed, converted (asr.wav + playback.m4a), transcribed; errors are readable', async () => {
    const tones = spacedTones(10);
    const pcm = tonesPcm(20, tones);
    const wav = Buffer.concat([Buffer.from(riffHeader(pcm.length)), pcm]);
    const res = await client.api(`/docs/${DOC}/recordings/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-Filename': encodeURIComponent('7강 녹음.wav') },
      body: wav,
    });
    const created = (await res.json()) as RecordingInfo;
    assert.equal(res.status, 201, JSON.stringify(created));
    assert.equal(created.source, 'upload');
    assert.equal(created.title, '7강 녹음');
    assert.ok(created.status === 'converting' || created.status === 'ready');
    await waitFor(async () => (await client.recording(DOC, created.id)).transcriptStatus === 'ready', 20_000, 'upload transcription');
    const info = await client.recording(DOC, created.id);
    assert.equal(info.status, 'ready');
    assert.equal(info.durationSec, 20);
    assert.equal(info.transcribedSec, 20);
    assert.deepEqual(info.playback, { url: `/api/docs/${DOC}/recordings/${created.id}/audio`, mime: 'audio/mp4' });
    const dir = path.join(library, DOC, 'recordings', created.id);
    assert.deepEqual(
      (await fs.readdir(dir)).filter((f) => !f.startsWith('.')).sort(),
      ['asr.wav', 'meta.json', 'playback.m4a', 'source.wav', 'transcript.json', 'windows.jsonl'],
    );
    assertEachToneOnce(await client.transcript(DOC, created.id), tones);
    // Language 'auto': detected on a clip from the middle, then forced.
    const runs = (await fs.readFile(whisperLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[] });
    const lastTwo = runs.slice(-2);
    assert.ok(lastTwo[0].args.includes('-dl'));
    assert.equal(lastTwo[1].args[lastTwo[1].args.indexOf('-l') + 1], 'ko');
    // The detected language reaches the client (the list shows "자동 감지 (한국어)"), the setting stays 'auto'.
    assert.equal(info.language, 'auto');
    assert.equal(info.detectedLanguage, 'ko');
    assert.equal((await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body.find((r) => r.id === created.id)?.detectedLanguage, 'ko');
    const play = await fetch(`${server.url}${info.playback?.url}`, { headers: { Range: 'bytes=4-11' } });
    assert.equal(play.status, 206);
    assert.equal(play.headers.get('content-type'), 'audio/mp4');
    assert.equal(Buffer.from(await play.arrayBuffer()).toString('latin1'), 'ftypM4A ');
    // Unsatisfiable ranges are 416 with the size (like live playback), not "no audio yet".
    const size = (await fs.stat(path.join(dir, 'playback.m4a'))).size;
    for (const range of ['bytes=99999999-', `bytes=${size}-`]) {
      const bad = await fetch(`${server.url}${info.playback?.url}`, { headers: { Range: range } });
      assert.equal(bad.status, 416, range);
      assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
      await bad.arrayBuffer();
    }

    // Not media: 415, nothing left behind.
    const before = await fs.readdir(path.join(library, DOC, 'recordings'));
    const pdf = await client.api(`/docs/${DOC}/recordings/upload`, { method: 'POST', body: Buffer.from('%PDF-1.7 not audio') });
    assert.equal(pdf.status, 415);
    assert.match(((await pdf.json()) as { error: string }).error, /오디오·동영상 파일이 아닙니다/);
    assert.equal((await client.api(`/docs/${DOC}/recordings/upload`, { method: 'POST', body: Buffer.alloc(0) })).status, 400);
    assert.deepEqual(await fs.readdir(path.join(library, DOC, 'recordings')), before);

    // ffmpeg fails like on a truncated m4a: status 'error' with a Korean reason.
    process.env.FAKE_FFMPEG_EXIT = '183';
    try {
      const broken = (await (await client.api(`/docs/${DOC}/recordings/upload`, { method: 'POST', body: wav })).json()) as RecordingInfo;
      await waitFor(async () => (await client.recording(DOC, broken.id)).status === 'error', 10_000, 'conversion error');
      assert.equal((await client.recording(DOC, broken.id)).error, '파일이 손상되었거나 업로드가 끝나지 않았습니다');
      assert.equal((await fetch(`${server.url}/api/docs/${DOC}/recordings/${broken.id}/audio`)).status, 404);
      await client.json(`/docs/${DOC}/recordings/${broken.id}`, 'DELETE');
    } finally {
      delete process.env.FAKE_FFMPEG_EXIT;
    }
  });

  test('uploads: X-Language / X-Model carry the recording settings; whisper progress shows in transcribedSec', async () => {
    const tones = spacedTones(10);
    const pcm = tonesPcm(20, tones);
    const wav = Buffer.concat([Buffer.from(riffHeader(pcm.length)), pcm]);
    const upload = (headers: Record<string, string>) => client.api(`/docs/${DOC}/recordings/upload`, { method: 'POST', headers, body: wav });
    const before = await fs.readdir(path.join(library, DOC, 'recordings'));
    const refused: Array<Record<string, string>> = [{ 'X-Language': 'fr' }, { 'X-Model': 'huge' }];
    for (const headers of refused) {
      const bad = await upload(headers);
      assert.equal(bad.status, 400, JSON.stringify(headers));
      await bad.arrayBuffer();
    }
    assert.deepEqual(await fs.readdir(path.join(library, DOC, 'recordings')), before, 'refused before anything was stored');

    await fs.rm(whisperLog, { force: true });
    process.env.FAKE_WHISPER_DELAY_MS = '1500';
    let created: RecordingInfo;
    try {
      const res = await upload({ 'X-Filename': encodeURIComponent('English.wav'), 'X-Language': 'en', 'X-Model': 'small-q5_1' });
      created = (await res.json()) as RecordingInfo;
      assert.equal(res.status, 201, JSON.stringify(created));
      assert.equal(created.language, 'en');
      assert.equal(created.model, 'small-q5_1');
      assert.equal(created.detectedLanguage, undefined, 'only for language auto');
      // One window (the whole 20 s): whisper reports 50 %, then waits.
      await waitFor(async () => {
        const info = await client.recording(DOC, created.id);
        return info.transcriptStatus === 'running' && info.transcribedSec === 10;
      }, 10_000, 'progress half way');
      await waitFor(async () => (await client.recording(DOC, created.id)).transcriptStatus === 'ready', 20_000, 'transcription');
    } finally {
      delete process.env.FAKE_WHISPER_DELAY_MS;
    }
    assert.equal((await client.recording(DOC, created.id)).transcribedSec, 20);
    assertEachToneOnce(await client.transcript(DOC, created.id), tones);
    const runs = (await fs.readFile(whisperLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[] });
    assert.equal(runs.length, 1, 'no language detection when the language is given');
    assert.equal(runs[0].args[runs[0].args.indexOf('-l') + 1], 'en');
    assert.equal(path.basename(runs[0].args[runs[0].args.indexOf('-m') + 1]), 'small.bin');
    assert.equal((await client.json(`/docs/${DOC}/recordings/${created.id}`, 'DELETE')).status, 204);
  });

  test('uploads longer than one window: cut at pauses; small-q5_1 gets the previous chunk’s last words as its prompt', async () => {
    await server.close();
    const uploadPreset = { minMs: 4_000, targetMs: 6_000, maxMs: 8_000, pick: 'best' as const };
    server = await startServer({ ...options(), recordings: { ...options().recordings, uploadPreset } });
    client = new Client(server.url);
    const tones = spacedTones(10);
    const pcm = tonesPcm(20, tones);
    const wav = Buffer.concat([Buffer.from(riffHeader(pcm.length)), pcm]);
    for (const model of ['small-q5_1', 'large-v3-turbo-q5_0']) {
      await fs.rm(whisperLog, { force: true });
      const res = await client.api(`/docs/${DOC}/recordings/upload`, { method: 'POST', headers: { 'X-Language': 'ko', 'X-Model': model }, body: wav });
      const created = (await res.json()) as RecordingInfo;
      assert.equal(res.status, 201, JSON.stringify(created));
      await waitFor(async () => (await client.recording(DOC, created.id)).transcriptStatus === 'ready', 20_000, 'transcription');
      assertEachToneOnce(await client.transcript(DOC, created.id), tones);
      const runs = (await fs.readFile(whisperLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[] });
      assert.ok(runs.length >= 3, `${runs.length} chunks`);
      const prompts = runs.map((r) => (r.args.includes('--prompt') ? r.args[r.args.indexOf('--prompt') + 1] : null));
      assert.equal(prompts[0], null, 'nothing before the first chunk');
      if (model === 'small-q5_1') {
        for (const [k, p] of prompts.slice(1).entries()) {
          // Chunks are transcribed in order: each one hears how the one before it ended.
          assert.match(p ?? '', /^tone-300( tone-\d+)* tone-\d+$/, `chunk ${k + 1}: ${p}`);
        }
        assert.ok((prompts.at(-1) ?? '').length > (prompts[1] ?? '').length);
      } else {
        assert.deepEqual(prompts, runs.map(() => null), 'turbo keeps no prompt (its timestamps got worse with one)');
      }
      await client.json(`/docs/${DOC}/recordings/${created.id}`, 'DELETE');
    }
  });

  test('a large upload is streamed to disk, never buffered in memory', async () => {
    const total = 256 * 1024 * 1024;
    process.env.FAKE_FFMPEG_MAX_BYTES = String(32000 * 4);
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 5);
    const baseline = process.memoryUsage().arrayBuffers;
    try {
      const { status, body } = await rawUpload(server.url, `/api/docs/${DOC}/recordings/upload`, total, { 'Content-Length': String(total) });
      assert.equal(status, 201, body);
      const rec = JSON.parse(body) as RecordingInfo;
      const source = path.join(library, DOC, 'recordings', rec.id, 'source.wav');
      assert.equal((await fs.stat(source)).size, total);
      await waitFor(async () => (await client.recording(DOC, rec.id)).status === 'ready', 20_000, 'conversion');
      await client.json(`/docs/${DOC}/recordings/${rec.id}`, 'DELETE');
    } finally {
      clearInterval(sampler);
      delete process.env.FAKE_FFMPEG_MAX_BYTES;
    }
    assert.ok(peak - baseline < 64 * 1024 * 1024, `array buffers grew by ${((peak - baseline) / 1024 / 1024).toFixed(0)} MB`);
  });

  test('upload limit: 413 from Content-Length and while streaming (chunked); nothing left behind', async () => {
    await server.close();
    server = await startServer({ ...options(), recordings: { ...options().recordings, maxUploadBytes: 1024 * 1024 } });
    client = new Client(server.url);
    const before = await fs.readdir(path.join(library, DOC, 'recordings'));
    const declared = await rawUpload(server.url, `/api/docs/${DOC}/recordings/upload`, 2 * 1024 * 1024, { 'Content-Length': String(2 * 1024 * 1024) });
    assert.equal(declared.status, 413);
    assert.match(JSON.parse(declared.body).error, /너무 큽니다 \(최대 1 MB\)/);
    const chunked = await rawUpload(server.url, `/api/docs/${DOC}/recordings/upload`, 2 * 1024 * 1024, {});
    assert.equal(chunked.status, 413);
    await waitFor(async () => (await fs.readdir(path.join(library, DOC, 'recordings'))).length === before.length, 5_000, 'cleanup');
  });

  test('slow uploads: no 5-minute whole-request limit, but a sender that stalls gets 408 and nothing is left behind', async () => {
    await server.close();
    server = await startServer({ ...options(), recordings: { ...options().recordings, uploadIdleMs: 200 } });
    client = new Client(server.url);
    // Node's default requestTimeout (300 s for the whole request, body included) would cut every long upload off.
    assert.equal(server.server.requestTimeout, 0);
    const before = await fs.readdir(path.join(library, DOC, 'recordings'));
    const stalled = await stalledUpload(server.url, `/api/docs/${DOC}/recordings/upload`, 64 * 1024);
    assert.equal(stalled.status, 408, stalled.body);
    assert.match(JSON.parse(stalled.body).error, /업로드가 1초 넘게 멈춰 있어서 중단했습니다/);
    await waitFor(async () => (await fs.readdir(path.join(library, DOC, 'recordings'))).length === before.length, 5_000, 'cleanup');
    // A sender that keeps sending, slower than the idle time in total, is fine.
    const tones = spacedTones(3);
    const pcm = tonesPcm(6, tones);
    const wav = Buffer.concat([Buffer.from(riffHeader(pcm.length)), pcm]);
    const slow = await trickleUpload(server.url, `/api/docs/${DOC}/recordings/upload`, wav, 8, 100);
    assert.equal(slow.status, 201, slow.body);
    await client.json(`/docs/${DOC}/recordings/${(JSON.parse(slow.body) as RecordingInfo).id}`, 'DELETE');
  });

  test('delete: a running live recording stops, its folder is gone; deleting the document stops its recordings', async () => {
    const created = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings`, 'POST', {});
    const rid = created.body.id;
    await client.audio(OTHER_DOC, rid, 0, tonesPcm(3, [{ start: 0.5, end: 2, hz: 440 }]));
    const sse = openSse(`${server.url}/api/docs/${OTHER_DOC}/recordings/${rid}/events`);
    await waitFor(() => sse.frames.length > 0, 5_000, 'sse open');
    assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings/${rid}`, 'DELETE')).status, 204);
    await sse.close();
    assert.equal(existsSync(path.join(library, OTHER_DOC, 'recordings', rid)), false);
    assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings/${rid}`)).status, 404);
    assert.equal((await client.audio(OTHER_DOC, rid, 0, Buffer.alloc(2))).status, 404);
    // A new live recording may start now.
    const next = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings`, 'POST', {});
    assert.equal(next.status, 201);
    assert.equal((await client.json(`/docs/${OTHER_DOC}`, 'DELETE')).status, 204);
    assert.equal(existsSync(path.join(library, OTHER_DOC)), false);
    const again = await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', {});
    assert.equal(again.status, 201, 'the deleted document no longer holds the live slot');
    await client.json(`/docs/${DOC}/recordings/${again.body.id}`, 'DELETE');
    await makeDoc(OTHER_DOC);
  });

  test('a stop waiting for audio that never comes ends with what is stored when a new recording is asked for', async () => {
    await server.close();
    server = await startServer({ ...options(), recordings: { ...options().recordings, staleStopMs: 300 } });
    client = new Client(server.url);
    const created = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings`, 'POST', { liveTranscribe: false });
    const rid = created.body.id;
    const pcm = tonesPcm(4, [{ start: 0.5, end: 3, hz: 500 }]);
    assert.equal((await client.audio(OTHER_DOC, rid, 0, pcm.subarray(0, 64_000))).status, 200);
    // The recorder says it captured 4 s but only 2 s arrive.
    const stopping = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings/${rid}/stop`, 'POST', { bytes: pcm.length });
    assert.equal(stopping.body.status, 'recording', 'waits for the rest');
    assert.equal((await client.json(`/docs/${DOC}/recordings`, 'POST', {})).status, 409, 'still waiting');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const next = await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', {});
    assert.equal(next.status, 201, JSON.stringify(next.body));
    const ended = await client.recording(OTHER_DOC, rid);
    assert.equal(ended.status, 'ready');
    assert.equal(ended.durationSec, 2);
    await client.json(`/docs/${DOC}/recordings/${next.body.id}`, 'DELETE');
    await client.json(`/docs/${OTHER_DOC}/recordings/${rid}`, 'DELETE');
  });

  test('a live recording whose device is gone: its speech stops being "recent", and another client can end it', async () => {
    await server.close();
    server = await startServer({ ...options(), recordings: { ...options().recordings, liveSpeechIdleMs: 1_500 } });
    client = new Client(server.url);
    const session = await client.json<Session>(`/docs/${DOC}/sessions`, 'POST', { provider: 'claude-code' });
    fake.setReply(() => 'answer');
    const ask = async () => {
      const res = await client.api(`/docs/${DOC}/sessions/${session.body.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '방금 뭐라고 했어?', slide: 1, neighbors: 0 }),
      });
      const raw = await res.text();
      assert.equal(res.status, 200, raw);
      const call = fake.calls.at(-1) as ProviderRunInput;
      return call.parts.map((p) => (p.type === 'text' ? p.text : '<image>')).join('\n');
    };
    const live = await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', { language: 'ko' });
    const rid = live.body.id;
    await client.audio(DOC, rid, 0, tonesPcm(24, spacedTones(12)));
    await client.json(`/docs/${DOC}/recordings/${rid}/pause`, 'POST');
    await waitFor(async () => (await client.recording(DOC, rid)).transcribedSec >= 24, 20_000, 'live window');
    await client.json(`/docs/${DOC}/recordings/${rid}/resume`, 'POST');
    assert.match(await ask(), /The last 1 minute of the lecture:\ntone-300/, 'audio (or a pause/resume) just arrived');
    // Nothing arrives any more (the laptop died, the browser was cleared): no longer "the last minutes of the lecture".
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    assert.doesNotMatch(await ask(), /The last \d+ minutes? of the lecture/);
    // It still holds the live slot: a new recording is refused with the recording that blocks it…
    const refused = await client.json<{ error: string; recording?: RecordingInfo }>(`/docs/${OTHER_DOC}/recordings`, 'POST', {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.recording?.id, rid);
    assert.equal(refused.body.recording?.docId, DOC);
    // …which any client can end with the audio the server has ("녹음 끝내기" of the web: a stop without a size).
    const ended = await client.json<RecordingInfo>(`/docs/${DOC}/recordings/${rid}/stop`, 'POST', {});
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.status, 'ready');
    assert.equal(ended.body.durationSec, 24);
    const next = await client.json<RecordingInfo>(`/docs/${OTHER_DOC}/recordings`, 'POST', {});
    assert.equal(next.status, 201, JSON.stringify(next.body));
    // The device that was recording, if it comes back: its audio is refused (the uploader then says it ended elsewhere).
    assert.equal((await client.audio(DOC, rid, 24 * 32_000, Buffer.alloc(3_200))).status, 409);
    await client.json(`/docs/${OTHER_DOC}/recordings/${next.body.id}`, 'DELETE');
    await client.json(`/docs/${DOC}/recordings/${rid}`, 'DELETE');
  });

  test('recordings nobody uses are dropped from memory (and load again); a subscriber or a job keeps one loaded', async () => {
    await server.close();
    server = await startServer({ ...options(), recordings: { ...options().recordings, idleUnloadMs: 100 } });
    client = new Client(server.url);
    assert.equal(loadedRecordings(), 0, 'nothing unfinished to resume');
    const rec = (await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body.find((r) => r.transcriptStatus === 'ready');
    assert.ok(rec);
    const before = await client.transcript(DOC, rec.id);
    assert.equal(loadedRecordings(), 1);
    const sse = openSse(`${server.url}/api/docs/${DOC}/recordings/${rec.id}/events`);
    await waitFor(() => sse.frames.length > 0, 5_000, 'sse open');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(loadedRecordings(), 1, 'kept while a subscriber listens');
    await sse.close();
    await waitFor(() => loadedRecordings() === 0, 5_000, 'unloaded');
    assert.deepEqual(await client.transcript(DOC, rec.id), before, 'loaded again from its files');
    assert.equal((await client.recording(DOC, rec.id)).id, rec.id);
  });

  test('validation: ids, bodies and states', async () => {
    assert.equal((await client.json(`/docs/${DOC}/recordings/NOT_AN_ID`)).status, 404);
    assert.equal((await client.json(`/docs/no-such-doc/recordings`)).status, 404);
    assert.equal((await client.json(`/docs/${DOC}/recordings`, 'POST', { language: 'fr' })).status, 400);
    assert.equal((await client.json(`/docs/${DOC}/recordings`, 'POST', { model: 'huge' })).status, 400);
    const up = (await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body.find((r) => r.source === 'upload');
    assert.ok(up);
    assert.equal((await client.json(`/docs/${DOC}/recordings/${up.id}/pause`, 'POST')).status, 409);
    assert.equal((await client.audio(DOC, up.id, 0, Buffer.alloc(2))).status, 409);
    assert.equal((await client.json(`/docs/${DOC}/recordings/${up.id}/slides`, 'POST', [{ t: 1, slide: 1 }])).status, 409);
    const renamed = await client.json<RecordingInfo>(`/docs/${DOC}/recordings/${up.id}`, 'PATCH', { title: '  새 제목  ' });
    assert.equal(renamed.body.title, '새 제목');
    assert.equal((await client.json(`/docs/${DOC}/recordings/${up.id}`, 'PATCH', { title: '   ' })).status, 400);
    const list = (await client.json<RecordingInfo[]>(`/docs/${DOC}/recordings`)).body;
    assert.deepEqual(
      list.map((r) => r.createdAt),
      [...list.map((r) => r.createdAt)].sort().reverse(),
      'newest first',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The GPU (Vulkan) with the fake engine: a Linux x64 build (whisper-cli-vulkan beside whisper-cli) on any machine
// ---------------------------------------------------------------------------------------------------------------

describe('transcription on the GPU (Vulkan) and its CPU fallback', () => {
  const GPU_ENV = ['FAKE_WHISPER_VULKAN_DEVICES', 'FAKE_WHISPER_GPU_FAIL', 'FAKE_WHISPER_DELAY_MS', 'EASY_STUDY_WHISPER_GPU'];
  let engineDir = '';
  let server: RunningServer | undefined;

  before(async () => {
    engineDir = path.join(tmp, 'gpu-engine');
    await fs.mkdir(engineDir, { recursive: true });
    await fs.copyFile(FAKE_WHISPER, path.join(engineDir, 'whisper-cli.mjs'));
    await fs.copyFile(FAKE_WHISPER, path.join(engineDir, 'whisper-cli-vulkan.mjs'));
    process.env.EASY_STUDY_WHISPER = path.join(engineDir, 'whisper-cli.mjs');
  });

  after(async () => {
    await server?.close();
    for (const name of GPU_ENV) delete process.env[name];
    process.env.EASY_STUDY_WHISPER = FAKE_WHISPER;
  });

  /** A server (a fresh GPU probe) as on `gpu`'s platform, with `env` set for its fake engine. */
  async function start(env: Record<string, string>, gpu: GpuOptions = { platform: 'linux', arch: 'x64' }): Promise<Client> {
    await server?.close();
    for (const name of GPU_ENV) delete process.env[name];
    Object.assign(process.env, env);
    server = await startServer({
      port: 0,
      log: false,
      resumeIngests: false,
      resumeRecordings: false,
      providerInfos: async () => infos,
      recordings: { models: new ModelStore({ dir: () => modelsDir, catalog: catalog() }), statusThrottleMs: 20, liveRealignMs: 0, pingMs: 1000, gpu },
    });
    return new Client(server.url);
  }

  async function transcribedUpload(client: Client, tones: Array<{ start: number; end: number; hz: number }>): Promise<RecordingInfo> {
    const pcm = tonesPcm(12, tones);
    const res = await client.api(`/docs/${OTHER_DOC}/recordings/upload`, { method: 'POST', body: Buffer.concat([Buffer.from(riffHeader(pcm.length)), pcm]) });
    const created = (await res.json()) as RecordingInfo;
    assert.equal(res.status, 201, JSON.stringify(created));
    await waitFor(async () => (await client.recording(OTHER_DOC, created.id)).transcriptStatus === 'ready', 20_000, 'transcription');
    return client.recording(OTHER_DOC, created.id);
  }

  async function whisperRuns(): Promise<Array<{ args: string[]; gpu?: boolean }>> {
    return (await fs.readFile(whisperLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; gpu?: boolean });
  }

  test('a discrete GPU: status vulkan with its name, turbo recommended; language detection and transcription on it', async () => {
    const client = await start({ FAKE_WHISPER_VULKAN_DEVICES: 'Intel UHD Graphics|1;NVIDIA GeForce RTX 4060 Laptop GPU|0' });
    const asr = (await client.json<AsrStatus>('/asr')).body;
    assert.equal(asr.engineAvailable, true);
    assert.equal(asr.acceleration, 'vulkan');
    assert.deepEqual(asr.gpu, { name: 'NVIDIA GeForce RTX 4060 Laptop GPU', integrated: false });
    assert.equal(asr.gpuError, undefined);
    assert.deepEqual(asr.models.filter((m) => m.recommended).map((m) => m.id), ['large-v3-turbo-q5_0']);
    await fs.rm(whisperLog, { force: true });
    const tones = spacedTones(5);
    const info = await transcribedUpload(client, tones);
    assert.equal(info.error, undefined);
    assertEachToneOnce(await client.transcript(OTHER_DOC, info.id), tones);
    const runs = await whisperRuns();
    assert.deepEqual(runs.map((r) => [r.args.includes('-dl'), r.gpu ?? false]), [[true, true], [false, true]]);
    for (const run of runs) assert.deepEqual(run.args.slice(-2), ['-dev', '1'], 'the discrete GPU is Vulkan device 1');
    assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings/${info.id}`, 'DELETE')).status, 204);
  });

  test('built-in graphics only: vulkan, integrated, small recommended', async () => {
    const client = await start({ FAKE_WHISPER_VULKAN_DEVICES: 'Intel(R) UHD Graphics 770|1' });
    const asr = (await client.json<AsrStatus>('/asr')).body;
    assert.equal(asr.acceleration, 'vulkan');
    assert.deepEqual(asr.gpu, { name: 'Intel(R) UHD Graphics 770', integrated: true });
    assert.deepEqual(asr.models.filter((m) => m.recommended).map((m) => m.id), ['small-q5_1']);
  });

  test('the GPU fails: that run is done again on the CPU (no window attempt lost), later ones stay there; the status says why', async () => {
    const client = await start({ FAKE_WHISPER_GPU_FAIL: '1' });
    assert.equal((await client.json<AsrStatus>('/asr')).body.acceleration, 'vulkan');
    await fs.rm(whisperLog, { force: true });
    const tones = spacedTones(5);
    const info = await transcribedUpload(client, tones);
    assert.equal(info.error, undefined);
    assert.equal(info.detectedLanguage, 'ko');
    assertEachToneOnce(await client.transcript(OTHER_DOC, info.id), tones);
    // Language detection failed on the GPU and was done again on the CPU; the transcription never tried the GPU.
    assert.deepEqual((await whisperRuns()).map((r) => [r.args.includes('-dl'), r.gpu ?? false]), [[true, true], [true, false], [false, false]]);
    const asr = (await client.json<AsrStatus>('/asr')).body;
    assert.equal(asr.acceleration, 'cpu');
    assert.equal(asr.gpu, undefined);
    assert.match(asr.gpuError ?? '', /^exit code 134: ggml_vulkan: Device memory allocation of size \d+ failed\.$/);
    assert.deepEqual(asr.models.filter((m) => m.recommended).map((m) => m.id), ['small-q5_1']);
    assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings/${info.id}`, 'DELETE')).status, 204);
  });

  test('a GPU run stopped by the app (the recording deleted) leaves the GPU on', async () => {
    const client = await start({ FAKE_WHISPER_DELAY_MS: '3000' });
    await fs.rm(whisperLog, { force: true });
    const pcm = tonesPcm(12, spacedTones(5));
    const res = await client.api(`/docs/${OTHER_DOC}/recordings/upload`, {
      method: 'POST',
      headers: { 'X-Language': 'en' },
      body: Buffer.concat([Buffer.from(riffHeader(pcm.length)), pcm]),
    });
    const created = (await res.json()) as RecordingInfo;
    assert.equal(res.status, 201, JSON.stringify(created));
    await waitFor(async () => (await client.recording(OTHER_DOC, created.id)).transcriptStatus === 'running' && existsSync(whisperLog), 10_000, 'GPU run started');
    assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings/${created.id}`, 'DELETE')).status, 204);
    const asr = (await client.json<AsrStatus>('/asr')).body;
    assert.equal(asr.acceleration, 'vulkan');
    assert.equal(asr.gpuError, undefined);
    assert.deepEqual((await whisperRuns()).map((r) => r.gpu ?? false), [true], 'not done again on the CPU');
  });

  test('Apple Silicon stays Metal; EASY_STUDY_WHISPER_GPU=0 and other platforms stay on the CPU', async () => {
    let client = await start({}, { platform: 'darwin', arch: 'arm64' });
    let asr = (await client.json<AsrStatus>('/asr')).body;
    assert.equal(asr.acceleration, 'metal');
    assert.equal(asr.gpu, undefined);
    assert.deepEqual(asr.models.filter((m) => m.recommended).map((m) => m.id), ['large-v3-turbo-q5_0']);
    for (const [env, gpu] of [
      [{ EASY_STUDY_WHISPER_GPU: '0' }, { platform: 'linux', arch: 'x64' }],
      [{}, { platform: 'darwin', arch: 'x64' }],
      [{}, { platform: 'win32', arch: 'x64' }],
    ] as Array<[Record<string, string>, GpuOptions]>) {
      client = await start(env, gpu);
      asr = (await client.json<AsrStatus>('/asr')).body;
      assert.equal(asr.acceleration, 'cpu', JSON.stringify([env, gpu]));
      assert.equal(asr.gpu, undefined);
      assert.equal(asr.gpuError, undefined);
      assert.deepEqual(asr.models.filter((m) => m.recommended).map((m) => m.id), ['small-q5_1']);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------------------------------------------

describe('restart recovery', () => {
  test('a live recording stays resumable; unfinished conversions and transcriptions continue', async () => {
    const opts = (): ServerOptions => ({
      port: 0,
      log: false,
      resumeIngests: false,
      resumeRecordings: true,
      providerInfos: async () => infos,
      recordings: { models: new ModelStore({ dir: () => modelsDir, catalog: catalog() }), statusThrottleMs: 20, liveRealignMs: 0, pingMs: 1000 },
    });
    // First run: no engine (transcription waits), a live recording with 40 s of audio.
    process.env.EASY_STUDY_WHISPER = path.join(tmp, 'no-whisper-here');
    let server = await startServer(opts());
    let client = new Client(server.url);
    const tones = spacedTones(30);
    const pcm = tonesPcm(60, tones);
    const rid = (await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', { language: 'en' })).body.id;
    for (let offset = 0; offset < 32000 * 40; offset += 32000) await client.audio(DOC, rid, offset, pcm.subarray(offset, offset + 32000));
    const asr = (await client.json<AsrStatus>('/asr')).body;
    assert.equal(asr.engineAvailable, false);
    assert.match(asr.reason ?? '', /EASY_STUDY_WHISPER에 지정한 받아쓰기 엔진\(whisper-cli\)이 없습니다/);
    assert.equal((await client.recording(DOC, rid)).transcriptStatus, 'queued');
    assert.ok(queueState().queued >= 1);
    // An upload whose conversion was interrupted: its meta says 'converting'.
    const upRes = await client.api(`/docs/${DOC}/recordings/upload`, { method: 'POST', body: Buffer.concat([Buffer.from(riffHeader(pcm.length)), pcm]) });
    const up = (await upRes.json()) as RecordingInfo;
    assert.equal(upRes.status, 201, JSON.stringify(up));
    await waitFor(async () => (await client.recording(DOC, up.id)).status === 'ready', 10_000, `first conversion ${JSON.stringify(await client.recording(DOC, up.id))}`);
    await server.close();
    const upDir = path.join(library, DOC, 'recordings', up.id);
    const meta = JSON.parse(await fs.readFile(path.join(upDir, 'meta.json'), 'utf8'));
    await fs.writeFile(path.join(upDir, 'meta.json'), JSON.stringify({ ...meta, status: 'converting', transcriptStatus: 'queued' }));
    await fs.rm(path.join(upDir, 'windows.jsonl'), { force: true });
    await fs.rm(path.join(upDir, 'asr.wav'), { force: true });
    // Power loss: bytes after the last acknowledged commit, and a folder of an upload that never finished.
    await fs.appendFile(path.join(library, DOC, 'recordings', rid, 'audio.pcm'), Buffer.alloc(5000, 7));
    await fs.mkdir(path.join(library, DOC, 'recordings', 'rec-20260101-000000-dead'), { recursive: true });
    await fs.writeFile(path.join(library, DOC, 'recordings', 'rec-20260101-000000-dead', 'source.part'), 'partial');

    // Second run with the engine.
    process.env.EASY_STUDY_WHISPER = FAKE_WHISPER;
    server = await startServer(opts());
    client = new Client(server.url);
    try {
      assert.equal(existsSync(path.join(library, DOC, 'recordings', 'rec-20260101-000000-dead')), false);
      const resumed = await client.recording(DOC, rid);
      assert.equal(resumed.status, 'recording');
      assert.equal(resumed.durationSec, 40, 'the unacknowledged tail was dropped');
      // Still the live recording of the server.
      assert.equal((await client.json(`/docs/${OTHER_DOC}/recordings`, 'POST', {})).status, 409);
      // The client resends from its acknowledged offset; a stale offset is answered with the server's.
      const stale = await client.audio(DOC, rid, 32000 * 41, pcm.subarray(32000 * 41, 32000 * 42));
      assert.equal(stale.status, 409);
      assert.equal(stale.body.offset, 32000 * 40);
      for (let offset = 32000 * 40; offset < pcm.length; offset += 32000) {
        assert.equal((await client.audio(DOC, rid, offset, pcm.subarray(offset, offset + 32000))).status, 200);
      }
      await client.json(`/docs/${DOC}/recordings/${rid}/stop`, 'POST');
      await waitFor(async () => (await client.recording(DOC, rid)).transcriptStatus === 'ready', 30_000, 'resumed transcription');
      assertEachToneOnce(await client.transcript(DOC, rid), tones);
      const stored = await fs.readFile(path.join(library, DOC, 'recordings', rid, 'audio.pcm'));
      assert.ok(stored.equals(pcm), 'byte-exact after the restart');
      // The interrupted conversion ran again and was transcribed.
      await waitFor(async () => (await client.recording(DOC, up.id)).transcriptStatus === 'ready', 30_000, 'resumed conversion');
      assert.equal((await client.recording(DOC, up.id)).durationSec, 60);
      assert.ok(await waitForTranscriptionIdle(5_000));
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Live relabelling
// ---------------------------------------------------------------------------------------------------------------

describe('live relabelling (liveRealignMs = 60 s)', () => {
  test("a look back that becomes the lecture's after its segments were shown relabels them at once", async () => {
    const server = await startServer({
      port: 0,
      log: false,
      resumeIngests: false,
      providerInfos: async () => infos,
      recordings: { models: new ModelStore({ dir: () => modelsDir, catalog: catalog() }), statusThrottleMs: 20, liveRealignMs: 60_000, pingMs: 1000 },
    });
    const client = new Client(server.url);
    try {
      const rid = (await client.json<RecordingInfo>(`/docs/${DOC}/recordings`, 'POST', { language: 'ko' })).body.id;
      const sse = openSse(`${server.url}/api/docs/${DOC}/recordings/${rid}/events`);
      const pcm = tonesPcm(60, spacedTones(30));
      const send = async (from: number, to: number) => {
        for (let offset = from; offset < to; offset += 32_000) {
          assert.equal((await client.audio(DOC, rid, offset, pcm.subarray(offset, Math.min(to, offset + 32_000)))).status, 200);
        }
      };
      await client.json(`/docs/${DOC}/recordings/${rid}/slides`, 'POST', [
        { t: 0, slide: 1 },
        { t: 4, slide: 2 },
      ]);
      // The first window: its segments are shown on p.2 (and its windowDone realigns: none ran yet).
      await send(0, 32_000 * 32);
      // The stored transcript, not transcribedSec: that already moves with whisper's progress on the window.
      await waitFor(async () => (await client.transcript(DOC, rid)).segments.length > 0 && (await client.recording(DOC, rid)).transcribedSec > 0, 20_000, 'first window');
      const shownUntil = (await client.recording(DOC, rid)).transcribedSec;
      const shown = (await client.transcript(DOC, rid)).segments;
      const look = shown.filter((s) => (s.start + s.end) / 2 + FOLLOW_LAG_SEC >= shownUntil - 8);
      assert.ok(look.length >= 2 && look.every((s) => s.slide === 2), JSON.stringify(shown));
      // The student had followed the professor back to p.1 for 12 s around the end of that window (the events arrive
      // late). The next window decides the look is the lecture's and relabels the shown segments at once: no need
      // to wait 60 s for the periodic realign.
      await client.json(`/docs/${DOC}/recordings/${rid}/slides`, 'POST', [
        { t: shownUntil - 8, slide: 1 },
        { t: shownUntil + 4, slide: 2 },
      ]);
      const seen = sse.frames.length;
      const t0 = Date.now();
      await send(32_000 * 32, pcm.length);
      await waitFor(
        () => sse.frames.slice(seen).some((f) => f.data.type === 'realigned' && f.data.segments.some((c) => c.id === look[0].id && c.slide === 1)),
        20_000,
        'relabelled look back',
      );
      assert.ok(Date.now() - t0 < 60_000);
      assert.equal((await client.recording(DOC, rid)).status, 'recording');
      await sse.close();
      await client.json(`/docs/${DOC}/recordings/${rid}/stop`, 'POST');
      await waitFor(async () => (await client.recording(DOC, rid)).transcriptStatus === 'ready', 30_000, 'transcription');
      assert.equal((await client.json(`/docs/${DOC}/recordings/${rid}`, 'DELETE')).status, 204);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Remote mode
// ---------------------------------------------------------------------------------------------------------------

describe('remote mode', () => {
  test('every recording and ASR route answers 401 without a session (audio, SSE and playback included)', async () => {
    const server = await startServer({ port: 0, log: false, resumeIngests: false, providerInfos: async () => [], host: '127.0.0.1', auth: 'on', password: 'recording-test-code' });
    try {
      const d = `/api/docs/${DOC}/recordings`;
      const r = `${d}/rec-20260101-000000-abcd`;
      const routes: Array<[string, string]> = [
        ['GET', '/api/asr'],
        ['POST', '/api/asr/models/small-q5_1/download'],
        ['DELETE', '/api/asr/models/small-q5_1'],
        ['GET', d],
        ['POST', d],
        ['POST', `${d}/upload`],
        ['GET', r],
        ['GET', `${r}/transcript`],
        ['GET', `${r}/events`],
        ['GET', `${r}/audio`],
        ['POST', `${r}/audio?offset=0`],
        ['POST', `${r}/slides`],
        ['POST', `${r}/pause`],
        ['POST', `${r}/resume`],
        ['POST', `${r}/stop`],
        ['PUT', `${r}/markers`],
        ['POST', `${r}/align-ai`],
        ['PATCH', r],
        ['DELETE', r],
      ];
      const before = await fs.readdir(path.join(library, DOC, 'recordings')).catch(() => [] as string[]);
      for (const [method, target] of routes) {
        const res = await fetch(`${server.url}${target}`, {
          method,
          headers: { 'Content-Type': 'application/octet-stream' },
          body: method === 'GET' || method === 'DELETE' ? undefined : Buffer.alloc(64),
        });
        assert.equal(res.status, 401, `${method} ${target}`);
        assert.doesNotMatch(res.headers.get('content-type') ?? '', /event-stream/);
        await res.arrayBuffer();
      }
      assert.deepEqual(await fs.readdir(path.join(library, DOC, 'recordings')).catch(() => [] as string[]), before, 'nothing was created');
      // With the access code the same API works.
      const ok = await fetch(`${server.url}/api/asr`, { headers: { Authorization: 'Bearer recording-test-code' } });
      assert.equal(ok.status, 200);
      await ok.arrayBuffer();
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

function riffHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** Streams a generated WAV body of `total` bytes (1 MiB pieces, with backpressure) and returns the answer. */
function rawUpload(base: string, target: string, total: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = new URL(target, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'audio/wav', ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    let answered = false;
    req.on('response', () => (answered = true));
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    const piece = Buffer.alloc(1024 * 1024, 1);
    let sent = 0;
    const header = riffHeader(total - 44);
    const write = () => {
      while (sent < total) {
        let chunk = piece.subarray(0, Math.min(piece.length, total - sent));
        if (sent === 0) chunk = Buffer.concat([header, chunk.subarray(44)]);
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', write);
          return;
        }
      }
      req.end();
    };
    req.on('socket', () => write());
  });
}

/** Sends `sendBytes` of a WAV upload (chunked, never ended) and resolves with the answer. */
function stalledUpload(base: string, target: string, sendBytes: number): Promise<{ status: number; body: string }> {
  const url = new URL(target, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'audio/wav' }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        req.destroy();
      });
    });
    req.on('error', reject);
    req.write(Buffer.concat([riffHeader(sendBytes), Buffer.alloc(sendBytes, 1)]));
  });
}

/** Sends `body` in `pieces` parts with `gapMs` between them. */
function trickleUpload(base: string, target: string, body: Buffer, pieces: number, gapMs: number): Promise<{ status: number; body: string }> {
  const url = new URL(target, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'audio/wav' }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    const size = Math.ceil(body.length / pieces);
    let at = 0;
    const next = () => {
      req.write(body.subarray(at, at + size));
      at += size;
      if (at >= body.length) req.end();
      else setTimeout(next, gapMs);
    };
    next();
  });
}

describe('request body deadline (Node requestTimeout replacement)', () => {
  test('a body still incomplete after the deadline is 408; recording uploads are exempt', async () => {
    const app = express();
    app.use(requestBodyDeadline(150));
    app.post('/api/x', express.json(), (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/api/docs/d-1/recordings/upload', (req, res) => {
      req.resume();
      req.on('end', () => res.json({ ok: true }));
    });
    const srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as { port: number };
    const send = (target: string, first: string, rest: string | null, delayMs: number) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: target, method: 'POST', headers: { 'Content-Type': 'application/json' }, agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.write(first);
        if (rest !== null) setTimeout(() => req.end(rest), delayMs);
      });
    try {
      const slow = await send('/api/x', '{"a":', null, 0);
      assert.equal(slow.status, 408);
      assert.match(JSON.parse(slow.body).error, /너무 오래/);
      assert.equal((await send('/api/x', '{"a":', '1}', 20)).status, 200);
      assert.equal((await send('/api/docs/d-1/recordings/upload', 'RIFF', 'rest', 400)).status, 200);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

void ({} as StreamEvent);
