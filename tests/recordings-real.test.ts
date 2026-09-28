// Real engines (DESIGN §22), opt-in: whisper-cli (EASY_STUDY_WHISPER, or `npm run setup:whisper`'s build), real models
// and real audio. Skipped unless EASY_STUDY_REAL_ASR=1; nothing here is needed for `npm test`.
//
//   EASY_STUDY_REAL_ASR=1 EASY_STUDY_MODELS_DIR=<dir with ggml-small-q5_1.bin + ggml-silero-v6.2.0.bin …> \
//   EASY_STUDY_REAL_ASR_WAV=<16 kHz mono s16 WAV of speech>          (live path: streamed like the recorder)
//   [EASY_STUDY_REAL_ASR_UPLOAD=<m4a/mp4/webm/… file>]                  (upload path: needs ffmpeg)
//   [EASY_STUDY_REAL_ASR_MODEL=small-q5_1] [EASY_STUDY_REAL_ASR_LANG=ko] [EASY_STUDY_REAL_ASR_EXPECT=<regex>]
//   node --test tests/recordings-real.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AsrStatus, RecordingInfo, RecordingTranscript } from '../shared/types.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import { readWavInfo } from '../server/recordings/wav.ts';

const enabled = process.env.EASY_STUDY_REAL_ASR === '1';
const DOC = 'real-asr-abc123';

describe('real whisper-cli / ffmpeg (EASY_STUDY_REAL_ASR=1)', { skip: !enabled && 'set EASY_STUDY_REAL_ASR=1 to run' }, () => {
  let tmp = '';
  let server: RunningServer;
  const model = process.env.EASY_STUDY_REAL_ASR_MODEL ?? 'small-q5_1';
  const language = process.env.EASY_STUDY_REAL_ASR_LANG ?? 'ko';
  const api = (target: string, init: RequestInit = {}) => fetch(`${server.url}/api${target}`, init);
  const info = async (rid: string) => (await (await api(`/docs/${DOC}/recordings/${rid}`)).json()) as RecordingInfo;

  async function waitReady(rid: string, timeoutMs: number): Promise<RecordingTranscript> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = await info(rid);
      if (i.transcriptStatus === 'ready' && i.alignment !== 'none') break;
      assert.notEqual(i.transcriptStatus, 'error', i.error ?? '');
      assert.ok(Date.now() < deadline, `not transcribed in time: ${JSON.stringify(i)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return (await (await api(`/docs/${DOC}/recordings/${rid}/transcript`)).json()) as RecordingTranscript;
  }

  function check(transcript: RecordingTranscript, durationSec: number): void {
    assert.ok(transcript.segments.length > 0, 'some speech was transcribed');
    for (let i = 1; i < transcript.segments.length; i++) assert.ok(transcript.segments[i].start >= transcript.segments[i - 1].start);
    for (const s of transcript.segments) assert.ok(s.start >= 0 && s.end <= durationSec + 1 && s.text.trim(), JSON.stringify(s));
    const text = transcript.segments.map((s) => s.text).join(' ');
    console.log(`  ${transcript.segments.length} segments: ${text.slice(0, 300)}…`);
    if (process.env.EASY_STUDY_REAL_ASR_EXPECT) assert.match(text, new RegExp(process.env.EASY_STUDY_REAL_ASR_EXPECT));
  }

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-real-asr-'));
    process.env.EASY_STUDY_LIBRARY = tmp;
    process.env.EASY_STUDY_AUTO_DIGEST = '0';
    await fs.mkdir(path.join(tmp, DOC, 'text'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, DOC, 'doc.json'),
      JSON.stringify({ id: DOC, title: 'Real', fileName: 'real.pdf', pageCount: 3, aspectRatio: 4 / 3, status: 'ready', progress: 3, createdAt: new Date().toISOString() }),
    );
    for (let i = 1; i <= 3; i++) await fs.writeFile(path.join(tmp, DOC, 'text', `00${i}.txt`), `slide ${i}`);
    server = await startServer({ port: 0, log: false, resumeIngests: false, providerInfos: async () => [] });
  });

  after(async () => {
    await server?.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test('the engine and the model are there', async () => {
    const status = (await (await api('/asr')).json()) as AsrStatus;
    console.log(`  whisper ${status.engineVersion} (${status.acceleration}), ffmpeg ${status.ffmpegAvailable}`);
    assert.equal(status.engineAvailable, true, status.reason ?? '');
    assert.equal(status.models.find((m) => m.id === model)?.installed, true, `${model} is not in EASY_STUDY_MODELS_DIR`);
  });

  test('live: PCM streamed in 1 s chunks, windows transcribed, stopped, aligned', { skip: !process.env.EASY_STUDY_REAL_ASR_WAV && 'EASY_STUDY_REAL_ASR_WAV not set' }, async () => {
    const wav = process.env.EASY_STUDY_REAL_ASR_WAV as string;
    const wavInfo = await readWavInfo(wav);
    assert.equal(wavInfo.sampleRate, 16000);
    assert.equal(wavInfo.channels, 1);
    const data = (await fs.readFile(wav)).subarray(wavInfo.dataOffset, wavInfo.dataOffset + wavInfo.dataBytes);
    const created = (await (
      await api(`/docs/${DOC}/recordings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language, model }) })
    ).json()) as RecordingInfo;
    const t0 = Date.now();
    for (let offset = 0; offset < data.length; offset += 32000) {
      const res = await api(`/docs/${DOC}/recordings/${created.id}/audio?offset=${offset}`, { method: 'POST', body: data.subarray(offset, offset + 32000) });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
    await api(`/docs/${DOC}/recordings/${created.id}/stop`, { method: 'POST' });
    const durationSec = data.length / 32000;
    const transcript = await waitReady(created.id, Math.max(120_000, durationSec * 2000));
    console.log(`  live: ${durationSec.toFixed(0)} s of audio transcribed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check(transcript, durationSec);
  });

  test('upload: converted by ffmpeg, transcribed, playable', { skip: !process.env.EASY_STUDY_REAL_ASR_UPLOAD && 'EASY_STUDY_REAL_ASR_UPLOAD not set' }, async () => {
    const file = process.env.EASY_STUDY_REAL_ASR_UPLOAD as string;
    const t0 = Date.now();
    const res = await api(`/docs/${DOC}/recordings/upload`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(path.basename(file)) }, body: await fs.readFile(file) });
    const created = (await res.json()) as RecordingInfo;
    assert.equal(res.status, 201, JSON.stringify(created));
    const transcript = await waitReady(created.id, 600_000);
    const done = await info(created.id);
    console.log(`  upload: ${done.durationSec.toFixed(0)} s transcribed in ${((Date.now() - t0) / 1000).toFixed(1)} s (language ${done.language})`);
    check(transcript, done.durationSec);
    const play = await fetch(`${server.url}${done.playback?.url}`, { headers: { Range: 'bytes=0-15' } });
    assert.equal(play.status, 206);
    assert.equal(Buffer.from(await play.arrayBuffer()).toString('latin1', 4, 8), 'ftyp');
  });
});
