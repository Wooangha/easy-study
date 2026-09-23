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
