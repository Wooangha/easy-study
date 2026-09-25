// Runtime configuration. Every value is read lazily (functions, not top-level constants) so that
// tests and tools can set environment variables such as EASY_STUDY_LIBRARY before calling in.
import { existsSync } from 'node:fs';
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

/** HTTP port (PORT, default 5180). */
export function port(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

/** The server only ever binds to loopback: the app has no authentication. */
export function host(): string {
  return '127.0.0.1';
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
