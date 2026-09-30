#!/usr/bin/env node
// Speech-recognition plumbing check of the recording tools the app ships (DESIGN §22), for CI and local checks:
//   node desktop/scripts/asr-smoke.mjs --whisper <whisper-cli> --ffmpeg <ffmpeg> [--models <dir>] [--speech auto|none]
//                                      [--expect-backend vulkan]
// 1. ffmpeg turns an input recording into the ASR WAV (16 kHz mono s16) and the AAC playback copy in one pass, as the
//    server does with an upload, and decodes the copy again;
// 2. whisper-cli transcribes the WAV with a small model and Silero VAD (the server's flags) and writes its JSON.
// The input is speech from the OS's text-to-speech when there is one (macOS `say`, Windows SAPI, Linux `espeak-ng`),
// and then the transcript must contain one of its words; otherwise (or with --speech none) a generated tone with
// noise, and only the plumbing is checked. Nothing comes from a microphone and nothing is committed: the models
// (ggml-base-q5_1 60 MB, Silero VAD 0.9 MB; pinned revisions, SHA-256 checked) are downloaded into --models
// (default <repo>/.cache/asr-smoke). --expect-backend vulkan: whisper-cli must also have transcribed on the GPU
// device Vulkan0 (its "using Vulkan0 backend" line; CI forces Mesa's software device with GGML_VK_VISIBLE_DEVICES=0).
// The tools get this process's environment (GGML_BACKEND_PATH, GGML_VK_*). Exit code 0 = fine.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE_DIR, arg, download } from './targets.mjs';

export const SMOKE_MODELS = {
  whisper: {
    file: 'ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin',
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  },
  vad: {
    file: 'ggml-silero-v6.2.0.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  },
};

const SENTENCE = 'The quick brown fox jumps over the lazy dog. Every lecture is transcribed on this computer.';
const WORDS = ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog', 'lecture', 'computer'];

/** A 16-bit PCM WAV of `seconds`: silence, a 440 Hz tone with some noise, silence (44.1 kHz stereo: ffmpeg resamples). */
export function toneWav(seconds = 3, rate = 44100, channels = 2) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const on = t > 0.5 && t < seconds - 0.5;
    const v = (on ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : 0) + 0.01 * noise();
    for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(v * 32767), (i * channels + c) * 2);
  }
  return Buffer.concat([wavHeader(data.length, rate, channels), data]);
}

function wavHeader(bytes, rate, channels) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(bytes, 40);
  return h;
}

/** The format and length of a PCM WAV (chunks walked, so ffmpeg's LIST chunk is fine). */
export function readWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      const bytes = Math.min(size, buf.length - at - 8);
      return { ...fmt, seconds: bytes / (fmt.rate * fmt.channels * (fmt.bits / 8)) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('WAV without data');
}

/** The top-level boxes of an MP4 file, in order. */
export function mp4Boxes(buf) {
  const boxes = [];
  for (let at = 0; at + 8 <= buf.length; ) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(at + 8));
    if (size === 0) size = buf.length - at;
    if (size < 8) throw new Error(`broken MP4 box at ${at}`);
    boxes.push(type);
    at += size;
  }
  return boxes;
}

/** Speech from the OS's text-to-speech into `dir`, or null (no engine, or it failed). */
function speech(dir) {
  const tries = {
    darwin: () => {
      const f = path.join(dir, 'speech.aiff');
      // An English voice: the default one follows the system language (a Korean voice reads English poorly).
      // Samantha comes with macOS; without it, the default voice.
      try {
        execFileSync('say', ['-v', 'Samantha', '-o', f, SENTENCE], { stdio: 'ignore', timeout: 60_000 });
      } catch {
        execFileSync('say', ['-o', f, SENTENCE], { stdio: 'ignore', timeout: 60_000 });
      }
      return f;
    },
    win32: () => {
      const f = path.join(dir, 'speech.wav');
      const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.SetOutputToWaveFile('${f.replaceAll("'", "''")}'); $s.Speak('${SENTENCE}'); $s.Dispose()`;
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 60_000 });
      return f;
    },
    linux: () => {
      const f = path.join(dir, 'speech.wav');
      execFileSync('espeak-ng', ['-s', '150', '-w', f, SENTENCE], { stdio: 'ignore', timeout: 60_000 });
      return f;
    },
  };
  try {
    const f = tries[process.platform]?.();
    return f && fs.statSync(f).size > 10_000 ? f : null;
  } catch {
    return null;
  }
}

function tool(file, args, { timeout = 300_000 } = {}) {
  const t = Date.now();
  const r = spawnSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 64 << 20, windowsHide: true });
  const ms = Date.now() - t;
  // A timeout still returns what the tool wrote so far: its last lines show where it stopped.
  const tail = () => (r.stderr || '').split('\n').slice(-15).join('\n');
  if (r.error) throw new Error(`${path.basename(file)}: ${r.error.message} after ${ms} ms:\n${tail()}`);
  if (r.status !== 0) {
    throw new Error(`${path.basename(file)} ${args.slice(0, 3).join(' ')}… exited with ${r.status ?? r.signal}:\n${tail()}`);
  }
  return { ...r, ms };
}

/** What whisper-cli prints on stderr when its model runs on a backend (--expect-backend). */
export const BACKEND_LINES = { vulkan: 'using Vulkan0 backend' };

/**
 * Runs the check. `model` / `vad` (files) skip the download from `models` (a test with a fake whisper-cli).
 * `expectBackend` (a BACKEND_LINES key): the transcription must have run there. Returns {spoken, text, segments};
 * throws on a failure.
 */
export async function asrSmoke({ whisper, ffmpeg, models = path.join(CACHE_DIR, 'asr-smoke'), model, vad, speechMode = 'auto', expectBackend }) {
  if (expectBackend !== undefined && !BACKEND_LINES[expectBackend]) throw new Error(`--expect-backend: one of ${Object.keys(BACKEND_LINES).join(', ')}`);
  for (const [name, file] of [['--whisper', whisper], ['--ffmpeg', ffmpeg]]) {
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${name}: no such file: ${file}`);
  }
  model ??= await download(SMOKE_MODELS.whisper.url, path.join(models, SMOKE_MODELS.whisper.file), SMOKE_MODELS.whisper.sha256);
  vad ??= await download(SMOKE_MODELS.vad.url, path.join(models, SMOKE_MODELS.vad.file), SMOKE_MODELS.vad.sha256);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-asr-smoke-'));
  try {
    let input = speechMode === 'none' ? null : speech(dir);
    const spoken = input !== null;
    if (!spoken) {
      input = path.join(dir, 'tone.wav');
      fs.writeFileSync(input, toneWav());
    }
    console.log(`input: ${spoken ? `text-to-speech (${path.basename(input)})` : 'generated tone with noise (no text-to-speech here)'}`);

    // 1. The upload recipe: one pass → ASR WAV + AAC playback copy (+faststart), progress on stdout.
    const asrWav = path.join(dir, 'asr.wav');
    const m4a = path.join(dir, 'playback.m4a');
    const conv = tool(ffmpeg, [
      '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', input,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', asrWav,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'ipod', m4a,
      '-progress', 'pipe:1', '-nostats',
    ]);
    if (!/progress=end/.test(conv.stdout)) throw new Error('ffmpeg: no "progress=end" on stdout');
    const wav = readWav(fs.readFileSync(asrWav));
    if (wav.format !== 1 || wav.channels !== 1 || wav.rate !== 16000 || wav.bits !== 16) throw new Error(`ASR WAV is ${JSON.stringify(wav)}`);
    const boxes = mp4Boxes(fs.readFileSync(m4a));
    if (boxes[0] !== 'ftyp' || !(boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'))) {
      throw new Error(`playback.m4a boxes ${boxes.join(',')}: expected ftyp first and moov before mdat (+faststart)`);
    }
    // 2. The playback copy decodes again (AAC decoder, mov demuxer), to about the same length.
    const back = path.join(dir, 'back.wav');
    tool(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', m4a, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', back]);
    const again = readWav(fs.readFileSync(back));
    if (Math.abs(again.seconds - wav.seconds) > 0.2) throw new Error(`playback copy is ${again.seconds.toFixed(2)} s, the WAV ${wav.seconds.toFixed(2)} s`);
    console.log(`ffmpeg ok: ${wav.seconds.toFixed(2)} s → asr.wav 16 kHz mono s16, playback.m4a (${boxes.join(' ')}) → ${again.seconds.toFixed(2)} s (${conv.ms} ms)`);

    // 3. whisper-cli with the server's flags (language forced, VAD, JSON) and a small quantized model (q5_1, like
    //    the app's models).
    const outBase = path.join(dir, 'transcript');
    const threads = String(Math.max(1, Math.min(4, os.availableParallelism())));
    // (A software GPU compiles every shader it uses first: more time.)
    const w = tool(whisper, ['-m', model, '-f', asrWav, '-l', 'en', '--vad', '-vm', vad, '-t', threads, '-ojf', '-of', outBase], { timeout: expectBackend ? 600_000 : 300_000 });
    const backend = w.stderr.split('\n').filter((l) => /Metal|Vulkan|GPU|using .* backend|CPU :|system_info/i.test(l)).slice(0, 8);
    for (const l of backend) console.log(`   ${l.trim()}`);
    if (expectBackend && !w.stderr.includes(BACKEND_LINES[expectBackend])) {
      throw new Error(`whisper-cli did not run on ${expectBackend}: no "${BACKEND_LINES[expectBackend]}" on stderr`);
    }
    const json = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
    if (!Array.isArray(json.transcription)) throw new Error('whisper JSON has no transcription array');
    const text = json.transcription.map((s) => s.text).join(' ').trim();
    console.log(`whisper ok (${w.ms} ms, ${json.transcription.length} segments, language ${json.result?.language ?? '?'}): ${JSON.stringify(text)}`);
    if (spoken) {
      const found = WORDS.filter((word) => text.toLowerCase().includes(word));
      if (found.length === 0) throw new Error(`the transcript has none of the spoken words (${WORDS.join(', ')})`);
      console.log(`   heard: ${found.join(', ')}`);
    }
    return { spoken, text, segments: json.transcription.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const str = (name) => (typeof arg(name) === 'string' ? arg(name) : undefined);
  try {
    await asrSmoke({
      whisper: str('whisper'),
      ffmpeg: str('ffmpeg'),
      models: str('models') ?? path.join(CACHE_DIR, 'asr-smoke'),
      speechMode: str('speech') ?? 'auto',
      expectBackend: arg('expect-backend') === true ? '' : str('expect-backend'),
    });
    console.log('ASR smoke: ok');
  } catch (e) {
    console.error(`ASR smoke: FAIL ${e.message}`);
    process.exit(1);
  }
}
