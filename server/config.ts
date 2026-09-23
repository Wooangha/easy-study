// Runtime configuration. Every value is read lazily (functions, not top-level constants) so that
// tests and tools can set environment variables such as EASY_STUDY_LIBRARY before calling in.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 5180;

/** Absolute path of the repository root (the directory that contains server/, web/, shared/). */
export function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
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

const DEFAULT_DIGEST_CONCURRENCY = 2;
const MAX_DIGEST_CONCURRENCY = 8;

/**
 * Provider calls a digest job runs at the same time (EASY_STUDY_DIGEST_CONCURRENCY, default 2,
 * clamped to 1..8). Each call carries a few full-resolution slide images, so keep it small.
 */
export function digestConcurrency(): number {
  const raw = process.env.EASY_STUDY_DIGEST_CONCURRENCY?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isInteger(parsed)) return DEFAULT_DIGEST_CONCURRENCY;
  return Math.min(MAX_DIGEST_CONCURRENCY, Math.max(1, parsed));
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
