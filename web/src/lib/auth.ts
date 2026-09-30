// Login state of the remote mode (DESIGN §16), shared by api.ts (which parks requests answered 401 until
// the next login) and the UI (login screen, logout button). Plus the pure helpers of the login screen.
//
// Phases:
//   checking — GET /api/auth/status has not answered yet (nothing else is requested)
//   ok       — the API can be used (logged in, or the server needs no login)
//   login    — a login is needed; API requests wait for it (see api.ts)
//   local    — the server only accepts loopback addresses and this page was opened from another one
import { msg } from '../i18n/index.ts';

export type AuthPhase = 'checking' | 'ok' | 'login' | 'local';

/** Why the login screen is shown. */
export type LoginReason =
  /** Opened without a (valid) session. */
  | 'required'
  /** The session ended while the app was in use (expired, revoked, new access code). */
  | 'expired'
  /** The user logged out. */
  | 'logout'
  /** The one-click login link (/login?code=…) carried a wrong code (the server redirected to /?login=failed). */
  | 'link-failed'
  /** The one-click login link came while too many logins had failed (/?login=limited). */
  | 'link-limited';

export interface AuthSnapshot {
  phase: AuthPhase;
  /** The server asks for an access code (remote mode). */
  authRequired: boolean;
  reason: LoginReason | null;
  /**
   * The login screen came up while the app was in use: the app stays mounted underneath (open document,
   * slide, session, drafts) and continues after the login.
   */
  overApp: boolean;
  /** Server message for the `local` phase. */
  message: string | null;
  /** Increments on every successful login; requests parked at an older epoch are sent again. */
  epoch: number;
}

type Listener = () => void;

const initial: AuthSnapshot = {
  phase: 'checking',
  authRequired: false,
  reason: null,
  overApp: false,
  message: null,
  epoch: 0,
};
let snapshot: AuthSnapshot = initial;
const listeners = new Set<Listener>();
const loginWaiters = new Set<() => void>();

function update(patch: Partial<AuthSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

export function getAuthSnapshot(): AuthSnapshot {
  return snapshot;
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the one-click login link reported in the address (/?login=failed or /?login=limited). */
export type LoginLinkResult = 'failed' | 'limited' | null;

/** Result of GET /api/auth/status at startup; `link`: the page was opened by a login link that did not work. */
export function applyAuthStatus(status: { authRequired: boolean; authenticated: boolean }, link: LoginLinkResult = null): void {
  if (status.authRequired && !status.authenticated) {
    update({
      phase: 'login',
      authRequired: true,
      reason: link === 'failed' ? 'link-failed' : link === 'limited' ? 'link-limited' : 'required',
      overApp: false,
      message: null,
    });
  } else {
    update({ phase: 'ok', authRequired: status.authRequired, reason: null, overApp: false, message: null });
  }
}

/** The server refuses this address (local mode, opened through a LAN address or host name). */
export function markLocalOnly(message: string): void {
  update({ phase: 'local', message });
}

/** The server could not be asked: let the app start (it shows its own "cannot connect" banner). */
export function markStatusUnknown(): void {
  if (snapshot.phase === 'checking') update({ phase: 'ok' });
}

/**
 * The API answered 401. Shows the login screen — over the app when it was in use (`expired` when it had
 * been logged in). Once the login screen is up it stays as it is (e.g. requests that were still running
 * when the user logged out must not turn "logged out" into "expired").
 */
export function markUnauthorized(): void {
  if (snapshot.phase === 'login') return;
  const inUse = snapshot.phase === 'ok';
  update({
    phase: 'login',
    reason: inUse && snapshot.authRequired ? 'expired' : 'required',
    authRequired: true,
    overApp: inUse,
  });
}

export function markLoggedIn(): void {
  update({ phase: 'ok', authRequired: true, reason: null, overApp: false, message: null, epoch: snapshot.epoch + 1 });
  const waiters = [...loginWaiters];
  loginWaiters.clear();
  for (const resolve of waiters) resolve();
}

/** Logged out: the login screen replaces the app (its data leaves the page). */
export function markLoggedOut(): void {
  update({ phase: 'login', authRequired: true, reason: 'logout', overApp: false });
}

/** A login is needed before the API can be used. */
export function loginPending(): boolean {
  return snapshot.phase === 'login';
}

/**
 * Resolves after the next login — immediately when a login already happened since `sinceEpoch` (the
 * request was sent before it and answered 401 after it). Rejects with an AbortError when `signal` aborts.
 */
export function waitForLogin(sinceEpoch: number, signal?: AbortSignal | null): Promise<void> {
  if (snapshot.epoch !== sinceEpoch) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      loginWaiters.delete(done);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    loginWaiters.add(done);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Test helper: back to the startup state (waiters are dropped). */
export function resetAuthForTests(): void {
  snapshot = initial;
  loginWaiters.clear();
  for (const l of listeners) l();
}

// ---------------------------------------------------------------------------
// Access code input
// ---------------------------------------------------------------------------

/** Dashes other than "-" that word processors and chat apps put between the groups of a code. */
const UNICODE_DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
/** A generated access code, without its separators: 4 groups of 5 letters/digits (DESIGN §16). */
const GENERATED_CODE = /^[0-9a-z]{20}$/i;

/**
 * What to send for the text in the access code field. The server compares a generated code ignoring case,
 * spaces, line breaks and "-" (server/auth.ts), so it may be typed or pasted any way; here only what the
 * server does not undo is fixed: characters copied along invisibly, the whitespace around it, and — only in
 * something shaped like a generated code — typographic dashes. A password set with EASY_STUDY_PASSWORD is
 * otherwise sent exactly as typed.
 */
export function normalizeAccessCode(input: string): string {
  const trimmed = input.replace(INVISIBLE, '').trim();
  const compact = trimmed.replace(/\s+/g, '').replace(/-/g, '').replace(UNICODE_DASHES, '');
  return GENERATED_CODE.test(compact) ? trimmed.replace(UNICODE_DASHES, '-') : trimmed;
}

/** Hangul in the field: the Korean input method was on while typing the (Latin) code. */
export function hasHangul(text: string): boolean {
  return /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/.test(text);
}

// ---------------------------------------------------------------------------
// Rate limit (429 + Retry-After)
// ---------------------------------------------------------------------------

/** Seconds to wait from a Retry-After header (delta-seconds or an HTTP date); null when absent/invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "45초", "3분", "9분 12초", "1시간 5분" (in the page's language). */
export function formatWait(totalSeconds: number): string {
  const m = msg().shell.auth.wait;
  const s = Math.max(0, Math.ceil(totalSeconds));
  if (s < 60) return m.seconds(s);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) return minutes > 0 ? m.hoursMinutes(hours, minutes) : m.hours(hours);
  return seconds > 0 ? m.minutesSeconds(minutes, seconds) : m.minutes(minutes);
}

// ---------------------------------------------------------------------------
// Address bar
// ---------------------------------------------------------------------------

/**
 * What a login link reported (the server redirects to /?login=failed or /?login=limited), and the URL to
 * show instead, without that parameter (null: nothing to clean up).
 */
export function takeLoginLinkParam(href: string): { result: LoginLinkResult; cleanUrl: string | null } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { result: null, cleanUrl: null };
  }
  if (!url.searchParams.has('login')) return { result: null, cleanUrl: null };
  const value = url.searchParams.get('login');
  url.searchParams.delete('login');
  return {
    result: value === 'failed' || value === 'limited' ? value : null,
    cleanUrl: `${url.pathname}${url.search}${url.hash}`,
  };
}

/** Loopback host names: this computer (no network in between). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}
