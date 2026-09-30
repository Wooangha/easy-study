#!/usr/bin/env node
// Stand-in for whisper.cpp's whisper-cli in the recording tests (DESIGN §22): same command line and `-ojf` JSON
// output file, no model. It reads the 16 kHz mono WAV it is given, finds "utterances" (runs of frames above an
// energy threshold) and names each one by its dominant frequency: `tone-<Hz>` (rounded to 10 Hz), so a test that
// generates tone bursts at known times can check that every burst is transcribed exactly once at the right time.
//
// Environment:
//   FAKE_WHISPER_LOG=<file>   append one JSON line per run: {args, wavBytes}
//   FAKE_WHISPER_FAIL=<n>     fail (exit 3) the first n runs (counted in FAKE_WHISPER_LOG's directory)
//   FAKE_WHISPER_LANG=<code>  result.language for -l auto (default "ko")
//   FAKE_WHISPER_DELAY_MS=<n> sleep before writing the output (`-pp`: "progress =  50%" before it, 100% after)
//
// The GPU build (Vulkan, asr.ts gpuCommandFor): run as a copy whose name ends in `-vulkan` (Linux: whisper-cli-vulkan.mjs
// beside whisper-cli.mjs) or with GGML_BACKEND_PATH set (Windows: es-ggml-vulkan.dll loaded), it acts as one with a GPU:
// a run with an empty model file (the probe) lists ggml-vulkan's devices on stderr and fails on the model (exit 3), runs
// print "using Vulkan<dev> backend" and log {gpu: true}.
//   FAKE_WHISPER_VULKAN_DEVICES='NVIDIA GeForce RTX 4060|0;Intel UHD|1'  the devices (name|uma), default one
//                             discrete 'Fake Vulkan GPU'; '' = "ggml_vulkan: No devices found."
//   FAKE_WHISPER_GPU_PROBE=fail|hang  the probe of the GPU build exits 1 without devices / never answers
//   FAKE_WHISPER_GPU_PROBE=hang-after-list|crash-after-list  the probe lists the devices, then hangs / dies (SIGABRT)
//   FAKE_WHISPER_GPU_RUN=stall  a GPU run prints its backend line, then nothing, forever
//   FAKE_WHISPER_GPU_FAIL=1   every GPU run fails like a GPU out of memory (GGML_ASSERT, exit 134)
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const gpu = /-vulkan(\.m?js)?$/.test(path.basename(process.argv[1] ?? '')) || Boolean(process.env.GGML_BACKEND_PATH);

/** Writes `text` to stderr, then exits with `code` (exiting at once could cut what a pipe has not taken yet). */
async function exitAfter(code, text) {
  process.stderr.write(text, () => process.exit(code));
  await new Promise(() => {});
}

// The GPU probe (asr.ts findGpu): a run with an empty model file lists the devices (the GPU build), then fails on the model.
const modelArg = args.indexOf('-m') >= 0 ? args[args.indexOf('-m') + 1] : undefined;
let probeRun = false;
try {
  probeRun = Boolean(modelArg) && fs.statSync(modelArg).size === 0;
} catch {}

if (args.includes('--version') || probeRun) {
  let text = '';
  if (gpu && probeRun) {
    if (process.env.FAKE_WHISPER_GPU_PROBE === 'hang') {
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    if (process.env.FAKE_WHISPER_GPU_PROBE === 'fail') await exitAfter(1, 'ggml_vulkan: vkCreateInstance failed (fake)\n');
    const devices = (process.env.FAKE_WHISPER_VULKAN_DEVICES ?? 'Fake Vulkan GPU|0')
      .split(';')
      .filter(Boolean)
      .map((d) => d.split('|'));
    if (devices.length === 0) text += 'ggml_vulkan: No devices found.\n';
    else {
      text += `ggml_vulkan: Found ${devices.length} Vulkan devices:\n`;
      devices.forEach(([name, uma], i) => {
        text += `ggml_vulkan: ${i} = ${name} (Fake Driver) | uma: ${uma === '1' ? 1 : 0} | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: none\n`;
      });
    }
    text += 'load_backend: loaded Vulkan backend from fake\n';
    // A driver that lists its devices, then hangs or crashes before whisper-cli stops at the model.
    if (process.env.FAKE_WHISPER_GPU_PROBE === 'hang-after-list') {
      process.stderr.write(text);
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    if (process.env.FAKE_WHISPER_GPU_PROBE === 'crash-after-list') {
      process.stderr.write(text, () => process.kill(process.pid, 'SIGABRT'));
      await new Promise(() => {});
    }
  }
  if (probeRun) await exitAfter(3, `${text}whisper_model_load: invalid model data (bad magic)\nerror: failed to initialize whisper context\n`);
  process.stdout.write('whisper.cpp version: 1.9.4-fake\n');
  await exitAfter(0, text);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const wavPath = opt('-f');
const outBase = opt('-of');
const language = opt('-l') ?? 'en';
if (!wavPath || !opt('-m')) {
  process.stderr.write('error: missing -m or -f\n');
  process.exit(2);
}
if (!fs.existsSync(opt('-m'))) {
  process.stderr.write(`error: failed to load model '${opt('-m')}'\n`);
  process.exit(2);
}
if (args.includes('--vad') && !fs.existsSync(opt('-vm') ?? '')) {
  process.stderr.write('error: VAD model not found\n');
  process.exit(2);
}

const log = process.env.FAKE_WHISPER_LOG;
const wav = fs.readFileSync(wavPath);
if (log) fs.appendFileSync(log, `${JSON.stringify(gpu ? { args, wavBytes: wav.length, gpu: true } : { args, wavBytes: wav.length })}\n`);
if (gpu) {
  process.stderr.write(`whisper_backend_init_gpu: using Vulkan${opt('-dev') ?? 0} backend\n`);
  // A GPU run that stops printing (a hung driver waiting on a fence).
  if (process.env.FAKE_WHISPER_GPU_RUN === 'stall') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (process.env.FAKE_WHISPER_GPU_FAIL === '1') {
    await exitAfter(
      134,
      'ggml_vulkan: Device memory allocation of size 1073741824 failed.\n' +
        'ggml/src/ggml-backend.cpp:1234: GGML_ASSERT(buf != NULL && "failed to allocate buffer") failed\n',
    );
  }
}
const failRuns = Number(process.env.FAKE_WHISPER_FAIL ?? 0);
if (failRuns > 0 && log) {
  const counter = path.join(path.dirname(log), 'fake-whisper-failures');
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  if (n < failRuns) {
    fs.writeFileSync(counter, String(n + 1));
    process.stderr.write('whisper_full: failed to process audio (fake failure)\n');
    process.exit(3);
  }
}

// WAV: find the data chunk.
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
  process.stderr.write('error: failed to read audio data\n');
  process.exit(4);
}
let pos = 12;
let data = null;
while (pos + 8 <= wav.length) {
  const id = wav.toString('ascii', pos, pos + 4);
  const len = wav.readUInt32LE(pos + 4);
  if (id === 'data') {
    data = wav.subarray(pos + 8, Math.min(wav.length, pos + 8 + len));
    break;
  }
  pos += 8 + len + (len % 2);
}
if (!data) {
  process.stderr.write('error: no data chunk\n');
  process.exit(4);
}

if (args.includes('-dl')) {
  process.stderr.write(`whisper_full_with_state: auto-detected language: ${process.env.FAKE_WHISPER_LANG ?? 'ko'} (p = 0.99)\n`);
  process.exit(0);
}

const FRAME = 320; // 20 ms of samples
const frames = Math.floor(data.length / 2 / FRAME);
const energy = [];
for (let f = 0; f < frames; f++) {
  let sum = 0;
  for (let i = 0; i < FRAME; i++) {
    const s = data.readInt16LE((f * FRAME + i) * 2);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / FRAME) / 32768;
  energy.push(rms > 0 ? 20 * Math.log10(rms) : -120);
}
const THRESHOLD = -35;
const utterances = [];
let start = -1;
for (let f = 0; f <= frames; f++) {
  const loud = f < frames && energy[f] >= THRESHOLD;
  if (loud && start < 0) start = f;
  if (!loud && start >= 0) {
    if (f - start >= 10) utterances.push([start, f]); // at least 200 ms
    start = -1;
  }
}

function dominantHz(fromFrame, toFrame) {
  let crossings = 0;
  let prev = 0;
  const from = fromFrame * FRAME;
  const to = toFrame * FRAME;
  for (let i = from; i < to; i++) {
    const s = data.readInt16LE(i * 2);
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    prev = s;
  }
  const seconds = (to - from) / 16000;
  return Math.round(crossings / 2 / seconds / 10) * 10;
}

const transcription = utterances.map(([a, b]) => ({
  timestamps: { from: '', to: '' },
  offsets: { from: a * 20, to: b * 20 },
  text: ` tone-${dominantHz(a, b)}`,
  tokens: [
    { text: '[_BEG_]', offsets: { from: 0, to: 0 }, id: 50364, p: 1, t_dtw: -1 },
    { text: ` tone-${dominantHz(a, b)}`, offsets: { from: 0, to: (b - a) * 20 }, id: 1, p: 1, t_dtw: -1 },
  ],
}));

const out = {
  systeminfo: 'FAKE',
  model: { type: 'fake' },
  params: { model: opt('-m'), language, translate: false },
  result: { language: language === 'auto' ? (process.env.FAKE_WHISPER_LANG ?? 'ko') : language },
  transcription,
};
const delay = Number(process.env.FAKE_WHISPER_DELAY_MS ?? 0);
// `-pp`: progress on stderr like whisper-cli (half before the delay, the rest when done).
const progress = (pct) => {
  if (args.includes('-pp')) process.stderr.write(`whisper_print_progress_callback: progress = ${String(pct).padStart(3)}%\n`);
};
progress(50);
setTimeout(() => {
  progress(100);
  if (outBase) fs.writeFileSync(`${outBase}.json`, JSON.stringify(out, null, '\t'));
  for (const t of transcription) process.stdout.write(`[${t.offsets.from} --> ${t.offsets.to}] ${t.text}\n`);
}, delay);
