// Shared helpers for provider adapters:
// - spawning CLI tools (argument array, never a shell) and parsing their JSONL stdout,
// - abort handling (SIGTERM, then SIGKILL after a grace period) and AbortError creation,
// - `<bin> --version` probing for detect(),
// - loading slide images for providers that send them inline.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderAvailability } from './types.ts';

/** Time between SIGTERM and SIGKILL when a turn is aborted. */
export const KILL_GRACE_MS = 3_000;
/** Amount of stderr kept for error messages. */
export const STDERR_TAIL_CHARS = 4_096;
/** Timeout of `<bin> --version`. */
export const VERSION_TIMEOUT_MS = 5_000;
/** If stdio stays open this long after the process exited (e.g. a grandchild holds it), stop waiting. */
const STDIO_CLOSE_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The error every provider rejects with when its AbortSignal fires. */
export function abortError(message = '요청이 중단되었습니다.'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** Formats a stderr tail for inclusion in a user-facing error message ('' when empty). */
export function stderrSuffix(stderrTail: string, maxChars = 1_500): string {
  const tail = stderrTail.trim();
  if (!tail) return '';
  const cut = tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
  return `\n\n[stderr]\n${cut}`;
}

/** "exit code 1" / "signal SIGKILL" */
export function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  return `exit code ${code ?? 'unknown'}`;
}

// ---------------------------------------------------------------------------
// Binary resolution & environment
// ---------------------------------------------------------------------------

/** `CLAUDE_BIN` / `CODEX_BIN` override the binary (used by tests); otherwise it is looked up in PATH. */
export function resolveBin(envVar: 'CLAUDE_BIN' | 'CODEX_BIN', fallback: string): string {
  const override = process.env[envVar]?.trim();
  return override ? override : fallback;
}

/**
 * Environment for child processes: the server's environment without CLAUDECODE (which makes
 * Claude Code believe it runs nested inside another Claude Code session) and without `remove`.
 */
export function childEnv(remove: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;
  for (const key of remove) delete env[key];
  return env;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

export type JsonObject = Record<string, unknown>;

/**
 * Incremental JSONL parser: feed it arbitrary chunks, it calls `onObject` for every complete line
 * that is a JSON object. Partial lines are buffered; blank and non-JSON lines are ignored.
 */
export class JsonlParser {
  private buffer = '';
  private readonly onObject: (obj: JsonObject) => void;

  constructor(onObject: (obj: JsonObject) => void) {
    this.onObject = onObject;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let start = 0;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n', start)) !== -1) {
      this.line(this.buffer.slice(start, newline));
      start = newline + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  /** Processes a trailing line without newline (call once the stream ended). */
  flush(): void {
    const rest = this.buffer;
    this.buffer = '';
    if (rest) this.line(rest);
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith('{')) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      this.onObject(value as JsonObject);
    }
  }
}

/** Keeps only the last `max` characters written to it. */
class TailBuffer {
  private value = '';
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: string): void {
    this.value += chunk;
    if (this.value.length > this.max * 2) this.value = this.value.slice(-this.max);
  }

  toString(): string {
    return this.value.length > this.max ? this.value.slice(-this.max) : this.value;
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export interface JsonlProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  signal: AbortSignal;
  /** Defaults to childEnv(). */
  env?: NodeJS.ProcessEnv;
  /**
   * Called for every JSON object printed on stdout. If it throws, the child is terminated and
   * runJsonlProcess rejects with that error.
   */
  onEvent: (event: JsonObject) => void;
}

export interface JsonlProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last STDERR_TAIL_CHARS characters of stderr. */
  stderrTail: string;
}

/**
 * Runs a CLI and streams its JSONL stdout to `onEvent`. Resolves with the exit status (a non-zero
 * exit is NOT an error here — the caller decides). Rejects with an AbortError when `signal` fires
 * (after the child has exited), or with a descriptive Error when the binary cannot be started.
 */
export function runJsonlProcess(opts: JsonlProcessOptions): Promise<JsonlProcessResult> {
  return new Promise<JsonlProcessResult>((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(abortError());
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(spawnError(opts.bin, err));
      return;
    }

    const stderr = new TailBuffer(STDERR_TAIL_CHARS);
    let settled = false;
    let aborted = false;
    let callbackError: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const running = () => child.exitCode === null && child.signalCode === null;

    const terminate = () => {
      if (!running() || killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (running()) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      opts.signal.removeEventListener('abort', onAbort);
      action();
    };

    const parser = new JsonlParser((event) => {
      if (callbackError || aborted) return;
      try {
        opts.onEvent(event);
      } catch (err) {
        callbackError = err instanceof Error ? err : new Error(errorMessage(err));
        terminate();
      }
    });

    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => parser.push(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => stderr.push(chunk));

    // EPIPE (the child exited or closed stdin before reading everything) is not an error by
    // itself: the exit status / stderr tell what happened.
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.stdin ?? '');

    child.on('error', (err) => {
      // Only spawn failures (ENOENT, EACCES, ...) matter here: the child never got a pid.
      // Errors of a running child (e.g. a failed kill) are followed by the usual exit/close.
      if (child.pid !== undefined) return;
      finish(() => reject(spawnError(opts.bin, err)));
    });

    child.on('exit', () => {
      clearTimeout(killTimer);
      if (aborted) {
        finish(() => reject(abortError()));
        return;
      }
      if (callbackError) {
        const err = callbackError;
        finish(() => reject(err));
        return;
      }
      // Normally 'close' follows right away; don't hang if a grandchild keeps stdio open.
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, STDIO_CLOSE_GRACE_MS);
    });

    child.on('close', (code, signal) => {
      parser.flush();
      finish(() => {
        if (aborted) reject(abortError());
        else if (callbackError) reject(callbackError);
        else resolve({ code, signal, stderrTail: stderr.toString() });
      });
    });
  });
}

function spawnError(bin: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const name = path.basename(bin);
  if (code === 'ENOENT') return new Error(`${name} 실행 파일을 찾을 수 없습니다 (PATH를 확인하세요).`);
  if (code === 'EACCES') return new Error(`${name} 실행 권한이 없습니다 (${bin}).`);
  return new Error(`${name} 실행에 실패했습니다: ${errorMessage(err)}`);
}

// ---------------------------------------------------------------------------
// Version probe (detect)
// ---------------------------------------------------------------------------

export interface VersionProbeOptions {
  bin: string;
  /** Shown in reasons, e.g. "claude". */
  displayName: string;
  /** Appended to the "not found" reason, e.g. install instructions. */
  installHint: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs `<bin> --version`. Never throws: failures become `available: false` with a reason. */
export function probeVersion(opts: VersionProbeOptions): Promise<ProviderAvailability> {
  return new Promise<ProviderAvailability>((resolve) => {
    try {
      execFile(
        opts.bin,
        ['--version'],
        {
          timeout: opts.timeoutMs ?? VERSION_TIMEOUT_MS,
          env: opts.env ?? childEnv(),
          windowsHide: true,
          maxBuffer: 256 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
            if (e.code === 'ENOENT') {
              resolve({
                available: false,
                reason: `${opts.displayName} CLI를 찾을 수 없습니다 (PATH). ${opts.installHint}`.trim(),
              });
            } else if (e.killed || e.signal) {
              resolve({ available: false, reason: `${opts.displayName} --version 이 응답하지 않습니다.` });
            } else {
              const detail = String(stderr || stdout || e.message).trim().split('\n')[0] ?? '';
              resolve({ available: false, reason: `${opts.displayName} --version 실패: ${detail}`.trim() });
            }
            return;
          }
          const version = firstLine(String(stdout)) || firstLine(String(stderr));
          resolve(version ? { available: true, version } : { available: true });
        },
      );
    } catch (err) {
      resolve({ available: false, reason: `${opts.displayName} 실행 실패: ${errorMessage(err)}` });
    }
  });
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function imageMediaType(file: string): ImageMediaType {
  switch (path.extname(file).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/** Reads an image as base64 (for providers that embed images in the request). */
export async function loadImageBase64(file: string): Promise<{ mediaType: ImageMediaType; data: string }> {
  try {
    const bytes = await readFile(file);
    return { mediaType: imageMediaType(file), data: bytes.toString('base64') };
  } catch (err) {
    throw new Error(`슬라이드 이미지를 읽을 수 없습니다: ${file} (${errorMessage(err)})`);
  }
}
