// Runtime configuration. Every value is read lazily (functions, not top-level constants) so that
// tests and tools can set environment variables such as EASY_STUDY_LIBRARY before calling in.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 5180;

let cachedRepoRoot: string | undefined;

/**
 * The nearest directory at or above `start` that holds a package.json (null when there is none). The
 * server runs from server/ (TypeScript, development) or from dist-server/server/ (compiled build).
 */
export function findPackageRoot(start: string): string | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Absolute path of the repository root (the directory that contains package.json, server/, web/, shared/). */
export function repoRoot(): string {
  cachedRepoRoot ??=
    findPackageRoot(path.dirname(fileURLToPath(import.meta.url))) ?? path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  return cachedRepoRoot;
}

/** Absolute path of the library directory (EASY_STUDY_LIBRARY, default <repo>/library). */
export function libraryDir(): string {
  const fromEnv = process.env.EASY_STUDY_LIBRARY?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(repoRoot(), 'library');
}

/**
 * What is wrong with EASY_STUDY_PDF_FALLBACK_FONT (the CJK fallback font of server/pdf.ts), for a warning at
 * startup: a path that is not a readable file. null when it is unset or fine. PDFium reads the font only when a PDF
 * needs it, and a mistyped path would otherwise just leave such text off the slide images.
 */
export function fallbackFontProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.EASY_STUDY_PDF_FALLBACK_FONT?.trim();
  if (!file) return null;
  let reason: string | null = null;
  try {
    if (!statSync(file).isFile()) reason = '파일이 아닙니다';
    else accessSync(file, constants.R_OK);
  } catch (err) {
    reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  }
  return reason
    ? `EASY_STUDY_PDF_FALLBACK_FONT 글꼴 파일을 읽을 수 없습니다: ${file} (${reason}). ` +
        '글꼴을 내장하지 않은 한글·일본어·중국어 PDF는 그 글자가 슬라이드 이미지에서 빠져요 (텍스트는 괜찮아요).'
    : null;
}

/** HTTP port (PORT, default 5180). */
export function port(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

const DEFAULT_HOST = '127.0.0.1';

/**
 * Address the server binds to (EASY_STUDY_HOST, default 127.0.0.1). Anything that is not a loopback
 * address (e.g. 0.0.0.0 or a LAN IP) turns remote mode on: every API request then needs a login
 * (DESIGN §16, networkSettings()).
 */
export function host(): string {
  return process.env.EASY_STUDY_HOST?.trim() || DEFAULT_HOST;
}

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');
const WILDCARD_ADDRESSES = new BlockList();
WILDCARD_ADDRESSES.addAddress('0.0.0.0', 'ipv4');
WILDCARD_ADDRESSES.addAddress('::', 'ipv6');

function addressCheck(list: BlockList, value: string): boolean {
  let hostname = value.trim().toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (isIPv4(hostname)) return list.check(hostname, 'ipv4');
  // IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) are checked against the IPv4 rules.
  if (isIPv6(hostname)) return list.check(hostname, 'ipv6');
  return false;
}

/** Whether `value` (an address or host name, IPv6 optionally in brackets) always means this computer. */
export function isLoopbackHost(value: string): boolean {
  return value.trim().toLowerCase() === 'localhost' || addressCheck(LOOPBACK_ADDRESSES, value);
}

/** Wildcard bind addresses (0.0.0.0, ::): every interface of the computer. */
export function isWildcardHost(value: string): boolean {
  return addressCheck(WILDCARD_ADDRESSES, value);
}

/** Minimum length of EASY_STUDY_PASSWORD (DESIGN §16). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Environment variables only the server itself may see: the access password and the HTTPS key and
 * certificate. Child processes (the claude/codex CLIs that read untrusted lecture PDFs, the PDF and image
 * worker) never need them, and a prompt injection or a tool the CLI runs could read its environment.
 */
export const SERVER_SECRET_ENV: readonly string[] = ['EASY_STUDY_PASSWORD', 'EASY_STUDY_TLS_KEY', 'EASY_STUDY_TLS_CERT'];

/**
 * A copy of `env` for a child process: without SERVER_SECRET_ENV (whatever the letter case of the names:
 * Windows environment names are case-insensitive).
 */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(copy)) {
    if (SERVER_SECRET_ENV.includes(key.toUpperCase())) delete copy[key];
  }
  return copy;
}

/** A setting that must not start the server (unsafe or contradictory); the message says what to do. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** PEM files of the HTTPS server. */
export interface TlsFiles {
  certFile: string;
  keyFile: string;
}

/** How the server is reached (DESIGN §16): bind address, login requirement, HTTPS. */
export interface NetworkSettings {
  /** Address to bind (EASY_STUDY_HOST). */
  host: string;
  /** Remote mode: every /api request needs a session or the access code (except /api/auth/*). */
  authRequired: boolean;
  /** EASY_STUDY_PASSWORD (trimmed), used as the access code instead of a generated one; null = generated. */
  password: string | null;
  /** EASY_STUDY_TLS_CERT + EASY_STUDY_TLS_KEY, resolved to absolute paths; null = plain HTTP. */
  tls: TlsFiles | null;
}

/** Values that take precedence over the environment (tests, command line flags). */
export interface NetworkOverrides {
  host?: string;
  /** 'on' | 'off' | 'auto' (auto = on exactly when the host is not a loopback address). */
  auth?: string;
  password?: string | null;
  tls?: TlsFiles | null;
}

const HOST_NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function parseAuthSetting(raw: string | undefined): 'on' | 'off' | 'auto' {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'auto') return 'auto';
  if (['on', '1', 'true', 'yes'].includes(value)) return 'on';
  if (['off', '0', 'false', 'no'].includes(value)) return 'off';
  throw new ConfigError(`EASY_STUDY_AUTH 값이 올바르지 않습니다: "${raw}" (on 또는 off)`);
}

/**
 * Resolves and checks the network settings (DESIGN §16). Throws ConfigError for unsafe or incomplete
 * combinations: EASY_STUDY_AUTH=off with a non-loopback host, a password shorter than 8 characters,
 * only one of the two TLS files, an invalid host.
 */
export function networkSettings(overrides: NetworkOverrides = {}, env: NodeJS.ProcessEnv = process.env): NetworkSettings {
  const hostValue = (overrides.host ?? env.EASY_STUDY_HOST ?? '').trim() || DEFAULT_HOST;
  const bare = hostValue.replace(/^\[(.*)\]$/, '$1');
  if (!isIP(bare) && !HOST_NAME_RE.test(bare)) {
    throw new ConfigError(`EASY_STUDY_HOST 값이 올바르지 않습니다: "${hostValue}" (예: 127.0.0.1, 0.0.0.0, 192.168.0.10)`);
  }
  const loopback = isLoopbackHost(bare);

  const auth = parseAuthSetting(overrides.auth ?? env.EASY_STUDY_AUTH);
  if (auth === 'off' && !loopback) {
    throw new ConfigError(
      `EASY_STUDY_AUTH=off 와 EASY_STUDY_HOST=${hostValue} 는 함께 쓸 수 없습니다: 다른 컴퓨터에서 로그인 없이 ` +
        '이 컴퓨터의 Claude/Codex 계정과 파일을 쓸 수 있게 됩니다. EASY_STUDY_AUTH=off 를 지우세요 ' +
        '(원격 모드에서는 접속 코드가 필요합니다).',
    );
  }
  const authRequired = auth === 'on' || (auth === 'auto' && !loopback);

  const rawPassword = overrides.password !== undefined ? overrides.password : env.EASY_STUDY_PASSWORD;
  const password = rawPassword?.trim() || null;
  if (password !== null && [...password].length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(`EASY_STUDY_PASSWORD는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다 (비워 두면 접속 코드가 자동으로 만들어집니다).`);
  }

  let tls: TlsFiles | null;
  if (overrides.tls !== undefined) {
    tls = overrides.tls && { certFile: path.resolve(overrides.tls.certFile), keyFile: path.resolve(overrides.tls.keyFile) };
  } else {
    const certFile = env.EASY_STUDY_TLS_CERT?.trim() ?? '';
    const keyFile = env.EASY_STUDY_TLS_KEY?.trim() ?? '';
    if (Boolean(certFile) !== Boolean(keyFile)) {
      throw new ConfigError('HTTPS를 쓰려면 EASY_STUDY_TLS_CERT 와 EASY_STUDY_TLS_KEY 를 둘 다 지정해야 합니다 (PEM 파일 경로).');
    }
    tls = certFile ? { certFile: path.resolve(certFile), keyFile: path.resolve(keyFile) } : null;
  }

  return { host: hostValue, authRequired, password, tls };
}

const DEFAULT_DIGEST_CONCURRENCY = 1;
const MAX_DIGEST_CONCURRENCY = 8;
const DEFAULT_MAX_CLI_PROCS = 2;
const MAX_MAX_CLI_PROCS = 16;

function intFromEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

/**
 * Digest provider calls that run at the same time, across ALL digest jobs of the process
 * (EASY_STUDY_DIGEST_CONCURRENCY, default 1, clamped to 1..8): opening several lectures queues their
 * digests instead of multiplying the load. Each call carries a few full-resolution slide images, and
 * with a CLI provider each call is a CLI process of ~150-250 MB, so keep it small.
 */
export function digestConcurrency(): number {
  return intFromEnv('EASY_STUDY_DIGEST_CONCURRENCY', DEFAULT_DIGEST_CONCURRENCY, MAX_DIGEST_CONCURRENCY);
}

/**
 * LLM CLI processes (claude / codex) the whole server runs at a time, chat turns and digest batches
 * together (EASY_STUDY_MAX_CLI_PROCS, default 2, clamped to 1..16; DESIGN §15, server/cliBudget.ts).
 */
export function maxCliProcs(): number {
  return intFromEnv('EASY_STUDY_MAX_CLI_PROCS', DEFAULT_MAX_CLI_PROCS, MAX_MAX_CLI_PROCS);
}

/**
 * Whether creating a session starts a digest of a document that has none yet
 * (EASY_STUDY_AUTO_DIGEST=0 / false / off disables it; default on).
 */
export function autoDigestEnabled(): boolean {
  const raw = process.env.EASY_STUDY_AUTO_DIGEST?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** Absolute path of the web client sources (Vite root). */
export function webDir(): string {
  return path.join(repoRoot(), 'web');
}

/** Absolute path of the production build of the web client. */
export function webDistDir(): string {
  return path.join(webDir(), 'dist');
}

/**
 * Error carrying an HTTP status. Thrown by library/sessions/chat when a request is invalid;
 * server/index.ts turns it into `{ "error": message }` with that status.
 */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
