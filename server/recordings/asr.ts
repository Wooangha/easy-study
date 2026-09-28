// Local speech recognition engine (DESIGN §22 "Engines"): whisper.cpp v1.9.4 `whisper-cli` as a short-lived sidecar
// (spawned with an argument array, never a shell), with the flags the ASR spike chose: beam search default (5),
// `-l ko|en` forced when known (auto otherwise), Silero VAD on (it removed every hallucination on silence and
// noise), no prompt, output `-ojf` read from the file (never stdout). Also: finding the engine and ffmpeg, their
// versions, and the machine's acceleration.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trackChild } from '../children.ts';
import { childProcessEnv, desktopMode, repoRoot } from '../config.ts';
import { stopProcess } from '../providers/proc.ts';

/** Time between SIGTERM and SIGKILL when a whisper / ffmpeg run is stopped. */
const KILL_GRACE_MS = 3_000;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_CACHE_MS = 60_000;
const STDERR_TAIL = 4_096;

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

/** 'metal' on Apple Silicon (the builds of DESIGN §22 use Metal there), otherwise 'cpu'. */
export function acceleration(platform: NodeJS.Platform = process.platform, arch: string = process.arch): 'metal' | 'cpu' {
  return platform === 'darwin' && arch === 'arm64' ? 'metal' : 'cpu';
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

const versionCache = new Map<string, VersionProbe>();

/** `<tool> <flag>` → first line matching `pattern` (cached 60 s per path). */
export function probeVersion(bin: string, flag: string, pattern: RegExp): Promise<VersionProbe> {
  const key = `${bin}\u0000${flag}`;
  const cached = versionCache.get(key);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return Promise.resolve(cached);
  if (!existsSync(bin)) {
    const probe = { at: Date.now(), ok: false, error: `파일이 없습니다: ${bin}` };
    versionCache.set(key, probe);
    return Promise.resolve(probe);
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
}

/** The whisper-cli arguments of DESIGN §22 (tests check them). `-pp` prints the progress to stderr. */
export function whisperArgs(run: WhisperRun): string[] {
  const args = ['-m', run.model, '-f', run.wav, '-l', run.language || 'auto', '-t', String(run.threads ?? asrThreads())];
  if (run.vad !== false) args.push('--vad', '-vm', run.vadModel);
  args.push('-ojf', '-of', run.outBase, '-pp');
  return args;
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

/** Runs a tool to completion; rejects on a non-zero exit (with the stderr tail) or when `signal` aborts. */
export function runTool(
  bin: string,
  args: string[],
  options: { signal?: AbortSignal; cwd?: string; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = {},
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
        spawn(cmd.file, cmd.args, { cwd: options.cwd, env: childProcessEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
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
        (err as Error & { exitCode?: number | null; stderr?: string }).exitCode = code;
        (err as Error & { stderr?: string }).stderr = `${stderrHead}\n${stderrTail}`;
        reject(err);
      }
    });
  });
}

/** Runs whisper-cli on one WAV file and parses its JSON output (removed afterwards). */
export async function runWhisper(run: WhisperRun): Promise<WhisperResult> {
  const json = `${run.outBase}.json`;
  await fs.rm(json, { force: true });
  try {
    await runTool(run.bin, whisperArgs(run), {
      signal: run.signal,
      cwd: path.dirname(run.wav),
      onStderr: run.onProgress ? progressReader(run.onProgress) : undefined,
    });
    let text: string;
    try {
      text = await fs.readFile(json, 'utf8');
    } catch {
      throw new Error('whisper-cli가 결과 파일을 만들지 않았습니다');
    }
    return parseWhisperJson(text);
  } finally {
    await fs.rm(json, { force: true }).catch(() => {});
  }
}

/** `whisper-cli -dl` on a short clip: the detected language code (null when none was printed). */
export async function detectLanguage(run: Omit<WhisperRun, 'outBase' | 'language' | 'vad'>): Promise<string | null> {
  const { stderrHead, stderrTail } = await runTool(
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
    throw new Error('whisper-cli 결과를 읽을 수 없습니다');
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
