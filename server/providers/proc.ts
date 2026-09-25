// Shared helpers for provider adapters:
// - finding the CLI executables (on Windows: native .exe on PATH, npm .cmd shims mapped to the real .exe),
// - spawning CLI tools (argument array, never a shell) and parsing their JSONL stdout,
// - abort handling (SIGTERM, then SIGKILL after a grace period; on Windows the whole process tree) and
//   AbortError creation,
// - `<bin> --version` probing for detect(),
// - loading slide images for providers that send them inline (the image worker's pre-encoded JPEGs, see
//   server/assets.ts; sharp is only loaded for images that have none yet).
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { INLINE_MAX_BYTES, INLINE_MAX_EDGE, inlinePathFor } from '../assets.ts';
import { childProcessEnv } from '../config.ts';
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

/** A CLI the providers spawn. */
export interface CliBinSpec {
  /** Command name, e.g. "claude". */
  name: string;
  /** Environment variable that overrides the executable (also used by tests). */
  envVar: 'CLAUDE_BIN' | 'CODEX_BIN';
  /**
   * Windows: the real executables an npm global-install shim `<shimDir>\<name>.cmd` stands for (path.win32
   * paths, most likely first). `arch` is process.arch ('x64', 'arm64').
   */
  npmShimTargets: (shimDir: string, arch: string) => string[];
}

/** Injectable environment of resolveBin (tests use it to resolve Windows paths on any OS). */
export interface BinResolveOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** PATH, PATHEXT and the override variable are read from here. */
  env?: NodeJS.ProcessEnv;
  /** Size of the regular file at `file` (symlinks followed), or null when there is none. */
  fileSize?: (file: string) => Promise<number | null>;
}

/**
 * Anything smaller is not a real CLI executable but a placeholder (npm's @anthropic-ai/claude-code ships a
 * stub bin/claude.exe that its postinstall replaces with the native binary, and treats < 4 KB as the stub).
 */
const MIN_SHIM_TARGET_BYTES = 4_096;

/**
 * The executable to spawn for a CLI. `CLAUDE_BIN` / `CODEX_BIN` override it; otherwise the bare name is
 * spawned and the OS finds it on PATH.
 *
 * Windows: the CLIs are spawned without a shell (a shell would mangle the multi-line --system-prompt and
 * killing it would orphan the CLI), and without one only `.exe` / `.com` files can be started — Node
 * refuses `.cmd` / `.bat` (EINVAL). So a native `<name>.exe` / `.com` anywhere on PATH is preferred (the
 * CLIs' own installers and WinGet provide one); if PATH only has the `<name>.cmd` shim of an npm global
 * install, it is mapped to the executable that shim ends up running (`spec.npmShimTargets`). A `.cmd`
 * override is mapped the same way. When nothing is found the name is returned unchanged, and spawning
 * it reports the CLI as not found.
 */
export async function resolveBin(spec: CliBinSpec, opts: BinResolveOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const override = env[spec.envVar]?.trim();
  if (platform !== 'win32') return override || spec.name;

  const lookup: WindowsLookup = {
    arch: opts.arch ?? process.arch,
    dirs: windowsPathDirs(env),
    pathExt: windowsPathExt(env),
    fileSize: opts.fileSize ?? regularFileSize,
    shimTargets: spec.npmShimTargets,
  };
  if (!override) return (await findWindowsExecutable(spec.name, lookup)) ?? spec.name;
  if (/[\\/]/.test(override)) {
    // A path: only an npm shim needs mapping (an unmappable one fails at spawn with a clear message).
    return isShimFile(override) ? ((await shimTarget(override, lookup)) ?? override) : override;
  }
  return (await findWindowsExecutable(override, lookup)) ?? override;
}

interface WindowsLookup {
  arch: string;
  dirs: string[];
  pathExt: string[];
  fileSize: (file: string) => Promise<number | null>;
  shimTargets: CliBinSpec['npmShimTargets'];
}

const WINDOWS_NATIVE_EXTS = ['.com', '.exe'];
const WINDOWS_SHIM_EXT = '.cmd';

/** PATH directories (absolute ones only: a relative entry would depend on the child's cwd). */
function windowsPathDirs(env: NodeJS.ProcessEnv): string[] {
  // Environment variable names are case-insensitive on Windows ("Path" is the usual spelling).
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const raw = key ? (env[key] ?? '') : '';
  return raw
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && path.win32.isAbsolute(dir));
}

/** PATHEXT, lower-cased (the Windows default when unset). */
function windowsPathExt(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT');
  const raw = (key ? env[key] : undefined) || '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));
}

function isShimFile(file: string): boolean {
  return path.win32.extname(file).toLowerCase() === WINDOWS_SHIM_EXT;
}

/**
 * Searches PATH for a native `<name>.exe` / `.com` (in PATHEXT order), then for an npm `<name>.cmd` shim
 * whose target exists. A name with an extension is looked up as it is.
 */
async function findWindowsExecutable(name: string, lookup: WindowsLookup): Promise<string | null> {
  const ext = path.win32.extname(name).toLowerCase();
  let nativeNames: string[];
  let shimName: string | null;
  if (ext === '') {
    const exts = lookup.pathExt.filter((e) => WINDOWS_NATIVE_EXTS.includes(e));
    nativeNames = (exts.length > 0 ? exts : WINDOWS_NATIVE_EXTS).map((e) => name + e);
    shimName = name + WINDOWS_SHIM_EXT;
  } else if (WINDOWS_NATIVE_EXTS.includes(ext)) {
    nativeNames = [name];
    shimName = null;
  } else if (ext === WINDOWS_SHIM_EXT) {
    nativeNames = [];
    shimName = name;
  } else {
    return null;
  }
  for (const dir of lookup.dirs) {
    for (const file of nativeNames) {
      const candidate = path.win32.join(dir, file);
      if ((await lookup.fileSize(candidate)) !== null) return candidate;
    }
  }
  if (shimName === null) return null;
  for (const dir of lookup.dirs) {
    const shim = path.win32.join(dir, shimName);
    if ((await lookup.fileSize(shim)) === null) continue;
    const target = await shimTarget(shim, lookup);
    if (target) return target;
  }
  return null;
}

/** The real executable behind an npm shim, or null. */
async function shimTarget(shim: string, lookup: WindowsLookup): Promise<string | null> {
  for (const candidate of lookup.shimTargets(path.win32.dirname(shim), lookup.arch)) {
    const size = await lookup.fileSize(candidate);
    if (size !== null && size >= MIN_SHIM_TARGET_BYTES) return candidate;
  }
  return null;
}

async function regularFileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Environment for child processes: the server's environment without the server's secrets (the remote
 * access password and the TLS files, config.ts SERVER_SECRET_ENV), without CLAUDECODE (which makes
 * Claude Code believe it runs nested inside another Claude Code session) and without `remove`.
 */
export function childEnv(remove: readonly string[] = []): NodeJS.ProcessEnv {
  const env = childProcessEnv();
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
      stopProcess(child);
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

/** Signature of child_process.execFile as stopProcess uses it (injectable for tests). */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { windowsHide: boolean },
  callback: (err: Error | null) => void,
) => unknown;

const execFileQuiet: ExecFileLike = (file, args, options, callback) =>
  execFile(file, args, options, (err) => callback(err));

/** taskkill.exe of the Windows system directory (not whatever `taskkill` the working directory offers). */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  return root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
}

/**
 * First step of stopping a CLI (abort, or a failing event handler). POSIX: SIGTERM, so the CLI can clean
 * up (runJsonlProcess sends SIGKILL after KILL_GRACE_MS). Windows has no signals: kill() is an immediate
 * TerminateProcess of the child alone, and its children (Claude Code's rg.exe, Codex's shell and sandbox
 * helpers) would keep running, so the whole tree is killed with `taskkill /PID <pid> /T /F`; if taskkill
 * cannot run, the child alone is terminated.
 */
export function stopProcess(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFileLike = execFileQuiet,
): void {
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGTERM');
    return;
  }
  const fallback = () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  };
  try {
    exec(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err) fallback();
    });
  } catch {
    fallback();
  }
}

/** Why a batch file cannot be the CLI ('' for other files): Node only starts .cmd/.bat through a shell. */
function batchFileProblem(bin: string): string {
  if (!/\.(?:cmd|bat)$/i.test(bin)) return '';
  return (
    `${path.basename(bin)} 은(는) 배치 파일이라 직접 실행할 수 없습니다. ` +
    '공식 설치 프로그램으로 설치하거나, 실제 실행 파일(.exe)의 경로를 CLAUDE_BIN / CODEX_BIN 에 지정하세요.'
  );
}

function spawnError(bin: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const name = path.basename(bin);
  if (code === 'ENOENT') return new Error(`${name} 실행 파일을 찾을 수 없습니다 (PATH를 확인하세요).`);
  if (code === 'EACCES') return new Error(`${name} 실행 권한이 없습니다 (${bin}).`);
  if (code === 'EINVAL' && batchFileProblem(bin)) return new Error(batchFileProblem(bin));
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
            } else if (e.code === 'EINVAL' && batchFileProblem(opts.bin)) {
              resolve({ available: false, reason: `${batchFileProblem(opts.bin)} ${opts.installHint}`.trim() });
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
      // spawn throws synchronously for a .cmd/.bat without a shell (EINVAL).
      const problem = (err as NodeJS.ErrnoException).code === 'EINVAL' ? batchFileProblem(opts.bin) : '';
      resolve({
        available: false,
        reason: problem ? `${problem} ${opts.installHint}`.trim() : `${opts.displayName} 실행 실패: ${errorMessage(err)}`,
      });
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

export interface InlineImage {
  mediaType: ImageMediaType;
  /** Base64 of the image bytes. */
  data: string;
}

/**
 * Long edge of images sent inline to a model API (server/assets.ts INLINE_MAX_EDGE). Claude's standard
 * vision limit (larger images are downscaled server-side anyway, and slides are rendered at 1600 px), and
 * more than OpenAI's high-detail processing keeps.
 */
export const INLINE_IMAGE_MAX_EDGE = INLINE_MAX_EDGE;
/**
 * Per-image size target (server/assets.ts INLINE_MAX_BYTES). Stateless conversations resend every image
 * each turn (anthropic-api, and Claude Code under the hood); anthropic-api measures each request against
 * the Messages API's 32 MB limit before sending it and continues in a new conversation when it would not fit.
 */
export const INLINE_IMAGE_MAX_BYTES = INLINE_MAX_BYTES;
/** JPEG qualities tried in order until the image fits INLINE_IMAGE_MAX_BYTES. */
const INLINE_IMAGE_QUALITIES = [85, 72, 60];
/**
 * In-process encodings kept in memory (base64 characters), for images the image worker has not pre-encoded
 * yet: the history of a stateless provider is resent every turn, and re-encoding it each time would be slow.
 * Pre-encoded images are never cached (reading one is cheap). Measured: the old 64 M cap let this cache
 * become the largest retainer of the server heap (12.6 MB after a chat plus a digest).
 */
const INLINE_IMAGE_CACHE_CHARS = 8 * 1024 * 1024;

const inlineCache = new Map<string, InlineImage>();
let inlineCacheChars = 0;

/**
 * Loads a slide or overview image for embedding in a request, as a compact JPEG (long edge ≤
 * INLINE_IMAGE_MAX_EDGE, ≤ INLINE_IMAGE_MAX_BYTES) — a slide PNG of 100–400 KB becomes ~50–150 KB, which
 * keeps long conversations under request size limits.
 *
 * Normally that JPEG was produced by the image worker (`inlinePathFor(file)`, see server/assets.ts) and is
 * read as it is. When there is none, or it is older than the PNG (a re-render), the image is encoded here
 * with sharp (loaded on first use) and cached per file version; an image the encoder cannot read is sent
 * unchanged, so the model API reports the problem.
 */
export async function loadInlineImage(file: string): Promise<InlineImage> {
  let info: { size: number; mtimeMs: number };
  try {
    info = await stat(file);
  } catch (err) {
    throw unreadableImage(file, err);
  }

  const preEncoded = await readPreEncoded(file, info.mtimeMs);
  if (preEncoded) return { mediaType: 'image/jpeg', data: preEncoded.toString('base64') };

  const key = `${file}\0${info.size}\0${info.mtimeMs}`;
  const cached = inlineCache.get(key);
  if (cached) {
    // Most recently used last.
    inlineCache.delete(key);
    inlineCache.set(key, cached);
    return cached;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    throw unreadableImage(file, err);
  }
  let image: InlineImage;
  try {
    image = { mediaType: 'image/jpeg', data: (await encodeInlineJpeg(bytes)).toString('base64') };
  } catch {
    // Not decodable here: send it as it is.
    image = { mediaType: imageMediaType(file), data: bytes.toString('base64') };
  }

  inlineCache.set(key, image);
  inlineCacheChars += image.data.length;
  for (const [oldKey, old] of inlineCache) {
    if (inlineCacheChars <= INLINE_IMAGE_CACHE_CHARS || oldKey === key) break;
    inlineCache.delete(oldKey);
    inlineCacheChars -= old.data.length;
  }
  return image;
}

/** Forgets every encoded image (tests). */
export function clearInlineImageCache(): void {
  inlineCache.clear();
  inlineCacheChars = 0;
}

function unreadableImage(file: string, err: unknown): Error {
  return new Error(`슬라이드 이미지를 읽을 수 없습니다: ${file} (${errorMessage(err)})`);
}

/** The image worker's JPEG of `file` when it exists, is not empty and is not older than `file`; else null. */
async function readPreEncoded(file: string, sourceMtimeMs: number): Promise<Buffer | null> {
  const jpeg = inlinePathFor(file);
  if (!jpeg) return null;
  try {
    const info = await stat(jpeg);
    if (!info.isFile() || info.size === 0 || info.mtimeMs < sourceMtimeMs) return null;
    return await readFile(jpeg);
  } catch {
    return null;
  }
}

/**
 * Encodes an image as a JPEG within INLINE_IMAGE_MAX_EDGE / INLINE_IMAGE_MAX_BYTES (white background for
 * transparency). Imports sharp on first use, so a server whose images are all pre-encoded never loads it.
 */
async function encodeInlineJpeg(bytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const resized = () =>
    sharp(bytes)
      .resize({ width: INLINE_IMAGE_MAX_EDGE, height: INLINE_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' });
  let out = Buffer.alloc(0);
  for (const quality of INLINE_IMAGE_QUALITIES) {
    out = await resized().jpeg({ quality }).toBuffer();
    if (out.length <= INLINE_IMAGE_MAX_BYTES) return out;
  }
  // Still too large (a photo or noise-like picture): make it smaller as well, down to a legible minimum.
  for (const edge of [1200, 960, 768, 640, 512]) {
    out = await sharp(bytes)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 60 })
      .toBuffer();
    if (out.length <= INLINE_IMAGE_MAX_BYTES) break;
  }
  return out;
}
