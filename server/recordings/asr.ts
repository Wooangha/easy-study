// Local speech recognition engine (DESIGN §22 "Engines"): whisper.cpp v1.9.4 `whisper-cli` as a short-lived sidecar
// (spawned with an argument array, never a shell), with the flags the ASR spike chose: beam search default (5),
// `-l ko|en` forced when known (auto otherwise), Silero VAD on (it removed every hallucination on silence and
// noise), no prompt (except the previous chunk's last words for models that need that context, models.ts
// carryContext), output `-ojf` read from the file (never stdout). Also: finding the engine and ffmpeg, their
// versions, and the machine's acceleration: Metal on Apple Silicon; Vulkan on Windows x64 / Linux x64 when the
// build ships its GPU part and the probe finds a GPU, with every run falling back to the CPU when the GPU fails.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trackChild } from '../children.ts';
import { childProcessEnv, desktopMode, repoRoot } from '../config.ts';
import { smsg } from '../i18n.ts';
import { stopProcess } from '../providers/proc.ts';

/** Time between SIGTERM and SIGKILL when a whisper / ffmpeg run is stopped. */
const KILL_GRACE_MS = 3_000;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_CACHE_MS = 60_000;
const STDERR_TAIL = 4_096;
/**
 * The Vulkan probe gives up after this long: no GPU then. The probe is a run with an empty model file: whisper-cli
 * lists ggml-vulkan's devices on stderr when it sets up its backends, then stops at the model ("bad magic", exit 3).
 * `--version` is not enough: a whisper-cli with Vulkan built in (Linux) sets up its backends only for a model
 * (checked in a container with Mesa's lavapipe, 2026-09-30); the Windows module (GGML_BACKEND_PATH) lists them both ways.
 */
const GPU_PROBE_TIMEOUT_MS = 20_000;

export type ToolSource = 'env' | 'bundled' | 'repo' | 'path';

export interface ToolLocation {
  path: string;
  source: ToolSource;
}

function exe(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function isRunnableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32' && !/\.(m?js|ts)$/.test(file)) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exe(name));
    if (isRunnableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Where a desktop build ships a sidecar relative to its Node (DESIGN §22): the Linux externalBin `es-<name>` beside
 * es-node (/usr/bin), or `<resources>/<folder>/<exe>` on macOS/Windows (Node lives in resources/node/ or
 * resources/node/bin/). The shell normally passes the path in the environment; this is the fallback.
 */
function bundledCandidates(esName: string, folder: string, program: string, execPath: string = process.execPath): string[] {
  const dir = path.dirname(execPath);
  return [path.join(dir, exe(esName)), path.join(dir, '..', folder, exe(program)), path.join(dir, '..', '..', folder, exe(program))];
}

/** Engine lookup order (DESIGN §22): EASY_STUDY_WHISPER, a bundled sidecar (desktop), <repo>/.cache/whisper/bin, PATH. */
export function findWhisper(env: NodeJS.ProcessEnv = process.env): ToolLocation | null {
  const fromEnv = env.EASY_STUDY_WHISPER?.trim();
  if (fromEnv) return { path: path.resolve(fromEnv), source: 'env' };
  if (desktopMode(env, [])) {
    for (const candidate of bundledCandidates('es-whisper', 'whisper', 'whisper-cli')) if (isRunnableFile(candidate)) return { path: candidate, source: 'bundled' };
  }
  const built = path.join(repoRoot(), '.cache', 'whisper', 'bin', exe('whisper-cli'));
  if (isRunnableFile(built)) return { path: built, source: 'repo' };
  const found = onPath('whisper-cli', env);
  return found ? { path: found, source: 'path' } : null;
}

/** ffmpeg (uploads only): EASY_STUDY_FFMPEG, a bundled sidecar (desktop), else `ffmpeg` on PATH. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): ToolLocation | null {
  const fromEnv = env.EASY_STUDY_FFMPEG?.trim();
  if (fromEnv) return { path: path.resolve(fromEnv), source: 'env' };
  if (desktopMode(env, [])) {
    for (const candidate of bundledCandidates('es-ffmpeg', 'ffmpeg', 'ffmpeg')) if (isRunnableFile(candidate)) return { path: candidate, source: 'bundled' };
  }
  const found = onPath('ffmpeg', env);
  return found ? { path: found, source: 'path' } : null;
}

/** Scripts (.mjs/.js/.ts) run with this Node: test doubles, and EASY_STUDY_WHISPER=wrapper.mjs setups. */
export function commandFor(bin: string, args: string[]): { file: string; args: string[] } {
  return /\.(m?js|ts)$/.test(bin) ? { file: process.execPath, args: [bin, ...args] } : { file: bin, args };
}

/** Metal on Apple Silicon (the builds of DESIGN §22 use Metal there; they have no Vulkan part). */
export function usesMetal(
  platform: NodeJS.Platform = gpuOptions.platform ?? process.platform,
  arch: string = gpuOptions.arch ?? process.arch,
): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

/** `-t`: physical cores, at most 8 (x86 counts two threads per core). */
export function asrThreads(): number {
  const logical = os.availableParallelism();
  const physical = process.arch === 'x64' || process.arch === 'ia32' ? Math.ceil(logical / 2) : logical;
  return Math.max(1, Math.min(8, physical));
}

interface VersionProbe {
  at: number;
  ok: boolean;
  version?: string;
  error?: string;
}

/** A cached probe: a missing file is kept as such (its error is written in the language of each request). */
const versionCache = new Map<string, VersionProbe & { missing?: boolean }>();

function probeResult(bin: string, probe: VersionProbe & { missing?: boolean }): VersionProbe {
  return probe.missing ? { at: probe.at, ok: false, error: smsg().recordings.engine.fileMissing(bin) } : probe;
}

/** `<tool> <flag>` → first line matching `pattern` (cached 60 s per path). */
export function probeVersion(bin: string, flag: string, pattern: RegExp): Promise<VersionProbe> {
  const key = `${bin}\u0000${flag}`;
  const cached = versionCache.get(key);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return Promise.resolve(probeResult(bin, cached));
  if (!existsSync(bin)) {
    const probe = { at: Date.now(), ok: false, missing: true };
    versionCache.set(key, probe);
    return Promise.resolve(probeResult(bin, probe));
  }
  const cmd = commandFor(bin, [flag]);
  return new Promise((resolve) => {
    execFile(
      cmd.file,
      cmd.args,
      { env: childProcessEnv(), windowsHide: true, timeout: VERSION_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`;
        const match = pattern.exec(text);
        const probe: VersionProbe = err
          ? { at: Date.now(), ok: false, error: (err as Error).message.split('\n')[0] }
          : { at: Date.now(), ok: true, version: match?.[1]?.trim() };
        versionCache.set(key, probe);
        resolve(probe);
      },
    );
  });
}

export function clearVersionCache(): void {
  versionCache.clear();
}

// ---------------------------------------------------------------------------------------------------------------
// The GPU (Vulkan, Windows x64 and Linux x64)
// ---------------------------------------------------------------------------------------------------------------
//
// The builds keep the CPU engine as it always was and ship the Vulkan part beside it: on Windows the ggml module
// es-ggml-vulkan.dll (a name ggml never loads by itself; GGML_BACKEND_PATH loads it for a GPU run), on Linux a
// second whisper-cli built with Vulkan (es-whisper-vulkan, linked to the system's libvulkan.so.1). A probe run
// lists the Vulkan devices once; every run then uses the GPU until one fails, and that run and all later ones go
// to the CPU engine (the GPU stays off until the server restarts).

/** How one whisper-cli run is started: the program, variables added to the environment, arguments added. */
export interface WhisperCommand {
  file: string;
  env: Record<string, string>;
  extraArgs: string[];
}

/** A Vulkan device as ggml-vulkan lists it on stderr (`ggml_vulkan: 0 = <name> (<driver>) | uma: 0 | …`). */
export interface VulkanDevice {
  /** Position in ggml-vulkan's list: whisper-cli's `-dev` (only the Vulkan and CPU backends are loaded). */
  index: number;
  name: string;
  driver: string;
  /** `uma: 1`: built-in graphics sharing the system memory. */
  integrated: boolean;
}

/** The GPU a whisper-cli runs on: the command of its runs (`-dev i` included) and the device. */
export interface WhisperGpu {
  command: WhisperCommand;
  device: VulkanDevice;
}

/** Test hooks: another platform and architecture, file check, probe timeout or GPU stall limit. */
export interface GpuOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (file: string) => boolean;
  probeTimeoutMs?: number;
  /** How long a GPU run may print nothing before it counts as hung (GPU_STALL_MS). */
  stallMs?: number;
}

/** EASY_STUDY_WHISPER_GPU=0 (or off / false / no): never the GPU. */
export function gpuDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(0|off|false|no)$/i.test(env.EASY_STUDY_WHISPER_GPU?.trim() ?? '');
}

/**
 * The GPU command for the CPU engine at `whisperPath`, when the build has one (null otherwise):
 * - Windows: es-ggml-vulkan.dll beside it → the same program with GGML_BACKEND_PATH=<that file>;
 * - Linux: a sibling `<name>-vulkan` (es-whisper → es-whisper-vulkan, whisper-cli → whisper-cli-vulkan; a script
 *   keeps its extension, see commandFor: wrapper.mjs → wrapper-vulkan.mjs) → that program;
 * - anywhere else, or with EASY_STUDY_WHISPER_GPU=0: none.
 */
export function gpuCommandFor(
  whisperPath: string,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): Pick<WhisperCommand, 'file' | 'env'> | null {
  if (gpuDisabled(env)) return null;
  const dir = path.dirname(whisperPath);
  if (platform === 'win32') {
    const dll = path.join(dir, 'es-ggml-vulkan.dll');
    return exists(dll) ? { file: whisperPath, env: { GGML_BACKEND_PATH: dll } } : null;
  }
  if (platform === 'linux') {
    const base = path.basename(whisperPath);
    const ext = path.extname(base);
    const sibling = path.join(dir, `${base.slice(0, base.length - ext.length)}-vulkan${/^\.(m?js|ts)$/.test(ext) ? ext : ''}`);
    return exists(sibling) ? { file: sibling, env: {} } : null;
  }
  return null;
}

const DEVICE_LINE = /^ggml_vulkan:\s*(\d+)\s*=\s*(.*?)\s*\(([^()]*)\)\s*\|\s*uma:\s*(\d+)/;

/** The devices ggml-vulkan listed (none for "ggml_vulkan: No devices found." or no Vulkan output at all). */
export function parseVulkanDevices(output: string): VulkanDevice[] {
  const devices: VulkanDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = DEVICE_LINE.exec(line.trim());
    if (m && !devices.some((d) => d.index === Number(m[1]))) {
      devices.push({ index: Number(m[1]), name: m[2].trim(), driver: m[3].trim(), integrated: m[4] !== '0' });
    }
  }
  return devices;
}

/** The first discrete GPU, else the first device (ggml already left out CPU emulations such as llvmpipe). */
export function pickDevice(devices: readonly VulkanDevice[]): VulkanDevice | null {
  return devices.find((d) => !d.integrated) ?? devices[0] ?? null;
}

const ERROR_LINE = /\b(error|fail(ed|ure)?|GGML_ASSERT|assert(ion)?|abort(ed)?|exception|out of memory|ErrorDeviceLost)\b/i;

/** Why a whisper-cli run failed, in one line: the exit, and the first line of stderr that reads like an error. */
export function failureReason(err: unknown): string {
  const e = err as Error & { exitCode?: number | null; signal?: string | null; stderr?: string };
  const message = (e instanceof Error ? e.message : String(err)).split('\n')[0].trim();
  const status = e.signal ? `signal ${e.signal}` : typeof e.exitCode === 'number' ? `exit code ${e.exitCode}` : '';
  const line = (e.stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => ERROR_LINE.test(l) && !/progress\s*=/.test(l));
  const reason = status && line ? `${status}: ${line}` : message;
  return reason.length > 300 ? `${reason.slice(0, 299)}…` : reason;
}

interface GpuEntry {
  probe: Promise<WhisperGpu | null>;
  /** The probe has ended. */
  done: boolean;
  gpu: WhisperGpu | null;
  /** The GPU failed a run (the reason): every later run is on the CPU. */
  broken?: string;
}

let gpuOptions: GpuOptions = {};
let gpuEntries = new Map<string, GpuEntry>();

/** A fresh start of the GPU choice (server start, tests): probes run again, a failed GPU is tried again. */
export function configureWhisperGpu(options: GpuOptions = {}): void {
  gpuOptions = { ...options };
  gpuEntries = new Map();
}

function gpuEntry(whisperPath: string): GpuEntry {
  let entry = gpuEntries.get(whisperPath);
  if (entry) return entry;
  const created: GpuEntry = { probe: Promise.resolve(null), done: false, gpu: null };
  created.probe = findGpu(whisperPath)
    .catch((err: unknown) => {
      console.log(`[recordings] no GPU for transcription (Vulkan: ${(err as Error)?.message ?? err}); transcribing on the CPU`);
      return null;
    })
    .then((gpu) => {
      created.gpu = gpu;
      created.done = true;
      return gpu;
    });
  entry = created;
  gpuEntries.set(whisperPath, entry);
  return entry;
}

/** The GPU of the engine at `whisperPath` (probed once per path until configureWhisperGpu; never rejects). */
export function probeGpu(whisperPath: string): Promise<WhisperGpu | null> {
  return gpuEntry(whisperPath).probe;
}

export interface GpuState {
  /** The probe has not ended (or not started) yet: runs wait for it, the status says 'cpu' until then. */
  pending: boolean;
  /** The GPU runs use (absent without one, and after a failure). */
  device?: VulkanDevice;
  /** Why a GPU that was found is no longer used (its failed run). */
  error?: string;
}

/** What the GPU of the engine at `whisperPath` is now (no probe is started). */
export function gpuState(whisperPath: string): GpuState {
  const entry = gpuEntries.get(whisperPath);
  if (!entry?.done) return { pending: true };
  if (entry.broken) return { pending: false, error: entry.broken };
  return entry.gpu ? { pending: false, device: entry.gpu.device } : { pending: false };
}

async function findGpu(whisperPath: string): Promise<WhisperGpu | null> {
  const base = gpuCommandFor(whisperPath, gpuOptions.platform ?? process.platform, gpuOptions.exists ?? existsSync);
  if (!base) return null;
  let probe: ProbeResult = { output: '', ended: 'error', error: 'not run' };
  let dir: string | undefined;
  try {
    // A folder of its own (random name): two probes never share the file, and nothing else can be linked in its place.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-gpu-'));
    const empty = path.join(dir, 'empty.bin');
    await fs.writeFile(empty, '');
    const cmd = commandFor(base.file, ['-m', empty, '-f', empty]);
    const env = { ...childProcessEnv(), ...base.env };
    probe = await probeOutput(cmd.file, cmd.args, env, gpuOptions.probeTimeoutMs ?? GPU_PROBE_TIMEOUT_MS);
  } catch (err) {
    probe = { output: probe.output, ended: 'error', error: (err as Error).message };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  // The devices count only when the probe ended the way it should: whisper-cli stopping at the empty model (exit code,
  // no signal, the model error printed). A probe that hung, crashed or never started means no GPU, whatever it listed:
  // a driver that lists its devices and then hangs would hang every GPU run the same way.
  const expected = probe.ended === 'exit' && PROBE_END.test(probe.output);
  const device = expected ? pickDevice(parseVulkanDevices(probe.output)) : null;
  if (!device) {
    const why = !expected
      ? (probe.error ?? 'the probe did not end as expected')
      : /ggml_vulkan: No devices found/.test(probe.output)
        ? 'no Vulkan device found'
        : 'no Vulkan device listed';
    console.log(`[recordings] no GPU for transcription (Vulkan: ${why}); transcribing on the CPU`);
    return null;
  }
  const command: WhisperCommand = { file: base.file, env: base.env, extraArgs: device.index !== 0 ? ['-dev', String(device.index)] : [] };
  const detail = `${device.integrated ? ' (integrated)' : ''}${device.index !== 0 ? `, device ${device.index}` : ''}`;
  console.log(`[recordings] transcribing on the GPU (Vulkan): ${device.name}${detail}`);
  return { command, device };
}

/** How whisper-cli stops at the probe's empty model file (whisper.cpp: the model check, then the CLI's error). */
const PROBE_END = /invalid model data \(bad magic\)|failed to initialize whisper context/;

/** The probe's output (stdout and stderr together) and how it ended: an exit (any code), a signal, a timeout, a start error. */
interface ProbeResult {
  output: string;
  ended: 'exit' | 'signal' | 'timeout' | 'error';
  error?: string;
}

function probeOutput(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ended: ProbeResult['ended'], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, ended, error });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = trackChild(spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (err) {
      finish('error', (err as Error).message);
      return;
    }
    // A driver that hangs must not hold the status: the answer does not wait for the process to end after a kill.
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('timeout', `no answer within ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    timer.unref();
    const take = (chunk: string) => {
      if (output.length < 1 << 20) output += chunk;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('error', (err) => finish('error', err.message));
    child.once('close', (code, sig) => {
      const last = output.trim().split(/\r?\n/).at(-1)?.trim();
      if (sig) finish('signal', `signal ${sig}${last ? `: ${last.slice(0, 200)}` : ''}`);
      else finish('exit', code === 0 ? undefined : `exit code ${code}${last ? `: ${last.slice(0, 200)}` : ''}`);
    });
  });
}

/** Resolves like `promise`, or rejects with ProcessStopped as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ProcessStopped());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ProcessStopped());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * A GPU run that prints nothing (no progress, no log line) for this long is taken as a hung driver: it is stopped and
 * the run is done on the CPU. whisper-cli prints its progress every 5 % (-pp) and ggml-vulkan waits on its fences
 * without a limit, so a stuck GPU would otherwise hold the one-at-a-time queue for good.
 */
const GPU_STALL_MS = 5 * 60_000;

/**
 * One whisper-cli run: on the GPU when there is one that has not failed, else on the CPU. A GPU run that ends
 * with an error (an exit code, a signal, a start failure, a stall; not a stop by the app) is done again at once on the
 * CPU, and when that CPU run works the GPU is turned off until the server restarts (a run that fails on the CPU too —
 * a broken file, the system out of memory — was not the GPU's fault: the GPU stays, the error goes to the caller).
 */
async function runEngine(
  bin: string,
  args: string[],
  options: { signal?: AbortSignal; cwd?: string; onStderr?: (chunk: string) => void },
): Promise<{ stderrTail: string; stderrHead: string }> {
  const entry = gpuEntry(bin);
  const gpu = await untilAborted(entry.probe, options.signal);
  if (!gpu || entry.broken) return runTool(bin, args, options);
  let failure: string;
  const watchdog = new AbortController();
  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      watchdog.abort();
    }, gpuOptions.stallMs ?? GPU_STALL_MS);
    timer.unref();
  };
  const onAppAbort = () => watchdog.abort();
  options.signal?.addEventListener('abort', onAppAbort, { once: true });
  try {
    arm();
    return await runTool(gpu.command.file, [...args, ...gpu.command.extraArgs], {
      ...options,
      signal: watchdog.signal,
      env: gpu.command.env,
      onStdout: arm,
      onStderr: (chunk) => {
        arm();
        options.onStderr?.(chunk);
      },
    });
  } catch (err) {
    if (options.signal?.aborted) throw err instanceof ProcessStopped ? err : new ProcessStopped();
    if (err instanceof ProcessStopped && !stalled) throw err;
    failure = stalled ? `no output for ${Math.round((gpuOptions.stallMs ?? GPU_STALL_MS) / 1000)} s (stopped)` : failureReason(err);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAppAbort);
  }
  console.warn(`[recordings] GPU (Vulkan) run failed (${failure}); running it again on the CPU`);
  const result = await runTool(bin, args, options);
  if (!entry.broken) {
    entry.broken = failure;
    console.warn(`[recordings] GPU (Vulkan) turned off until restart: the same run worked on the CPU; transcribing on the CPU`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Running whisper-cli
// ---------------------------------------------------------------------------------------------------------------

export interface WhisperSegment {
  /** Seconds from the start of the input file. */
  start: number;
  end: number;
  text: string;
}

export interface WhisperResult {
  segments: WhisperSegment[];
  /** Language whisper used or detected (result.language). */
  language?: string;
}

export interface WhisperRun {
  bin: string;
  model: string;
  vadModel: string;
  wav: string;
  /** Output path without extension (whisper writes `<outBase>.json`). */
  outBase: string;
  /** 'ko' | 'en' | 'auto' or a detected code. */
  language: string;
  threads?: number;
  /** false for the warm-up run (VAD would skip silent input before the encoder runs). */
  vad?: boolean;
  signal?: AbortSignal;
  /** Progress of the run (0..1, in steps of 5 %) from `-pp`: long upload chunks show how far they are. */
  onProgress?: (fraction: number) => void;
  /** `--prompt`: what was said just before this audio (a chunk of a long upload), or nothing. */
  prompt?: string;
}

/** The whisper-cli arguments of DESIGN §22 (tests check them). `-pp` prints the progress to stderr. */
export function whisperArgs(run: WhisperRun): string[] {
  const args = ['-m', run.model, '-f', run.wav, '-l', run.language || 'auto', '-t', String(run.threads ?? asrThreads())];
  if (run.vad !== false) args.push('--vad', '-vm', run.vadModel);
  const prompt = run.prompt?.replace(/\s+/g, ' ').trim();
  if (prompt && promptFitsArgs(prompt)) args.push('--prompt', prompt);
  args.push('-ojf', '-of', run.outBase, '-pp');
  return args;
}

/**
 * whisper-cli on Windows reads its arguments in the system code page (not UTF-8), so a Korean prompt would arrive
 * garbled: there only an ASCII prompt is passed.
 */
export function promptFitsArgs(prompt: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' || /^[\x20-\x7e]*$/.test(prompt);
}

/** Characters of the previous chunk's text given as the prompt (whisper keeps at most half its 448-token context). */
export const CONTEXT_PROMPT_CHARS = 200;

/** The end of `text` for `--prompt`: at most `max` characters, from a sentence start when there is one. */
export function contextPrompt(text: string, max: number = CONTEXT_PROMPT_CHARS): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  const tail = chars.slice(-max).join('');
  const m = /[.?!。？！]\s+/.exec(tail);
  return m && m.index + m[0].length < tail.length - 20 ? tail.slice(m.index + m[0].length) : tail;
}

/** A progress reader for whisper-cli's stderr ("whisper_print_progress_callback: progress =  45%", maybe split). */
export function progressReader(onProgress: (fraction: number) => void): (chunk: string) => void {
  let carry = '';
  return (chunk) => {
    const text = carry + chunk;
    const lines = text.split('\n');
    carry = (lines.pop() ?? '').slice(-200);
    for (const line of lines) {
      const m = /progress\s*=\s*(\d{1,3})\s*%/.exec(line);
      if (m) onProgress(Math.min(100, Number(m[1])) / 100);
    }
  };
}

export class ProcessStopped extends Error {
  constructor() {
    super('중단되었습니다');
    this.name = 'AbortError';
  }
}

/**
 * Runs a tool to completion; rejects on a non-zero exit (with the stderr tail) or when `signal` aborts
 * (ProcessStopped). `env`: variables added to the server's environment (a GPU run's GGML_BACKEND_PATH).
 */
export function runTool(
  bin: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    cwd?: string;
    env?: Record<string, string>;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {},
): Promise<{ stderrTail: string; stderrHead: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProcessStopped());
      return;
    }
    const cmd = commandFor(bin, args);
    let stderrTail = '';
    let stderrHead = '';
    let child;
    try {
      child = trackChild(
        spawn(cmd.file, cmd.args, {
          cwd: options.cwd,
          env: { ...childProcessEnv(), ...options.env },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (err) {
      reject(err);
      return;
    }
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      stopProcess(child);
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => options.onStdout?.(chunk));
    child.stderr?.on('data', (chunk: string) => {
      if (stderrHead.length < 16_384) stderrHead += chunk.slice(0, 16_384 - stderrHead.length);
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
      options.onStderr?.(chunk);
    });
    child.once('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      reject(err);
    });
    child.once('close', (code, sig) => {
      options.signal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      if (options.signal?.aborted) {
        reject(new ProcessStopped());
        return;
      }
      if (code === 0) resolve({ stderrTail, stderrHead });
      else {
        const err = new Error(`${path.basename(bin)} ${sig ? `signal ${sig}` : `exit code ${code}`}: ${stderrTail.trim().split('\n').slice(-3).join(' / ')}`);
        (err as Error & { exitCode?: number | null; signal?: string | null; stderr?: string }).exitCode = code;
        (err as Error & { signal?: string | null }).signal = sig;
        (err as Error & { stderr?: string }).stderr = `${stderrHead}\n${stderrTail}`;
        reject(err);
      }
    });
  });
}

/** Runs whisper-cli on one WAV file (on the GPU when there is one, see runEngine) and parses its JSON output (removed afterwards). */
export async function runWhisper(run: WhisperRun): Promise<WhisperResult> {
  const json = `${run.outBase}.json`;
  await fs.rm(json, { force: true });
  try {
    await runEngine(run.bin, whisperArgs(run), {
      signal: run.signal,
      cwd: path.dirname(run.wav),
      onStderr: run.onProgress ? progressReader(run.onProgress) : undefined,
    });
    let text: string;
    try {
      text = await fs.readFile(json, 'utf8');
    } catch {
      throw new Error(smsg().recordings.transcription.noOutputFile);
    }
    return parseWhisperJson(text);
  } finally {
    await fs.rm(json, { force: true }).catch(() => {});
  }
}

/** `whisper-cli -dl` on a short clip (GPU or CPU like runWhisper): the detected language code (null when none was printed). */
export async function detectLanguage(run: Omit<WhisperRun, 'outBase' | 'language' | 'vad'>): Promise<string | null> {
  const { stderrHead, stderrTail } = await runEngine(
    run.bin,
    ['-m', run.model, '-f', run.wav, '-l', 'auto', '-dl', '-t', String(run.threads ?? asrThreads())],
    { signal: run.signal, cwd: path.dirname(run.wav) },
  );
  const match = /auto-detected language:\s*([a-z]{2,3})\b/.exec(`${stderrHead}\n${stderrTail}`);
  return match ? match[1] : null;
}

interface RawToken {
  text?: string;
  offsets?: { from?: number; to?: number };
}

interface RawSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: RawToken[];
}

/** Segments longer than this are split at sentence ends (by token time) so slide changes can fall between them. */
const SPLIT_LONGER_THAN = 12;
const MIN_PIECE = 3;

function cleanText(text: string): string {
  return text.replace(/�/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * whisper-cli `-ojf` output → segments in seconds. Text is decoded with replacement (invalid UTF-8 inside a split
 * Korean syllable) and U+FFFD removed; special tokens ([_BEG_] …) are skipped. With VAD, token offsets are in
 * VAD-compressed time (only segment offsets are mapped back), so tokens are remapped linearly into their
 * segment's [from, to] before long segments are split at sentence ends.
 */
export function parseWhisperJson(text: string): WhisperResult {
  let data: { result?: { language?: string }; transcription?: RawSegment[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(smsg().recordings.transcription.unreadableOutput);
  }
  const segments: WhisperSegment[] = [];
  let previous = '';
  let repeats = 0;
  for (const raw of Array.isArray(data.transcription) ? data.transcription : []) {
    const start = (raw.offsets?.from ?? 0) / 1000;
    const end = Math.max(start, (raw.offsets?.to ?? 0) / 1000);
    const body = cleanText(raw.text ?? '');
    if (!body) continue;
    // Repetition loops ("감사합니다." again and again): keep at most two in a row.
    repeats = body === previous ? repeats + 1 : 0;
    previous = body;
    if (repeats >= 2) continue;
    segments.push(...splitSegment(start, end, body, raw.tokens ?? []));
  }
  return { segments, language: typeof data.result?.language === 'string' ? data.result.language : undefined };
}

function splitSegment(start: number, end: number, body: string, rawTokens: RawToken[]): WhisperSegment[] {
  if (end - start <= SPLIT_LONGER_THAN) return [{ start, end, text: body }];
  const tokens = rawTokens
    .filter((t) => typeof t.text === 'string' && !/^\[_/.test(t.text) && t.offsets)
    .map((t) => ({ text: t.text as string, start: (t.offsets?.from ?? 0) / 1000, end: (t.offsets?.to ?? 0) / 1000 }));
  if (tokens.length < 2) return [{ start, end, text: body }];
  const lo = Math.min(...tokens.map((t) => t.start));
  const hi = Math.max(...tokens.map((t) => t.end));
  const k = hi > lo ? (end - start) / (hi - lo) : 0;
  const timed = tokens.map((t) => ({ text: t.text, end: start + (t.end - lo) * k }));
  const pieces: WhisperSegment[] = [];
  let pieceStart = start;
  let buffer = '';
  for (let i = 0; i < timed.length; i++) {
    buffer += timed[i].text;
    const sentenceEnd = /[.?!。？！]\s*$/.test(timed[i].text);
    const t = Math.min(end, Math.max(pieceStart, timed[i].end));
    if (sentenceEnd && t - pieceStart >= MIN_PIECE && end - t >= MIN_PIECE) {
      const pieceText = cleanText(buffer);
      if (pieceText) pieces.push({ start: pieceStart, end: t, text: pieceText });
      pieceStart = t;
      buffer = '';
    }
  }
  const rest = cleanText(buffer);
  if (rest) pieces.push({ start: pieceStart, end, text: rest });
  return pieces.length > 0 ? pieces : [{ start, end, text: body }];
}
