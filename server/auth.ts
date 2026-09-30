// Remote mode (DESIGN §16): the access code, login sessions, the login rate limit, and the Express pieces
// that enforce them. Local mode (the default: bound to 127.0.0.1, no login) uses none of this except the
// always-reachable /api/auth/status.
//
// Everything here is about keeping other people out of a server that spawns the owner's logged-in CLIs
// and serves their files, so: the code is never logged (only main()'s startup banner prints it), the
// server keeps only hashes of session ids, and every comparison of a secret is constant-time.
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { isIP, isIPv6 } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthStatusResponse } from '../shared/types.ts';
import { HttpError, isLoopbackHost, isWildcardHost, libraryDir } from './config.ts';
import { smsg } from './i18n.ts';
import { createKeyedQueue, isNotFound, renameWithRetry } from './library.ts';

/** File in the library that holds the generated access code and the session hashes (mode 0600). */
export const AUTH_FILE_NAME = '.auth.json';
export const SESSION_COOKIE = 'es_session';
/** Sessions expire 30 days after they were last used (sliding). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Failed logins allowed per client within LOGIN_WINDOW_MS before 429. */
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/**
 * Failed logins from all clients together within LOGIN_WINDOW_MS after which every client gets a single
 * attempt per window (backstop against guessing from many addresses; see LoginLimiter).
 */
export const GLOBAL_LOGIN_FAILURE_LIMIT = 100;
/** Clients the rate limiter remembers at most (bounded memory). */
export const LOGIN_LIMITER_MAX_CLIENTS = 10_000;
/** Sessions kept at most; the least recently used ones are dropped first. */
export const MAX_SESSIONS = 200;
/** How often a session's sliding expiry is written back to disk while it is being used. */
export const SESSION_TOUCH_PERSIST_MS = 60 * 60 * 1000;
/** Longest access code / password accepted in a login (longer input is refused without hashing it). */
const MAX_CODE_INPUT = 256;

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
/** Crockford's base32 alphabet (no i, l, o, u), lowercase: easy to read aloud and to type. */
const CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CODE_GROUPS = 4;
const CODE_GROUP_LENGTH = 5;
const GENERATED_CODE_RE = /^[0-9a-hjkmnp-tv-z]{5}(?:-[0-9a-hjkmnp-tv-z]{5}){3}$/;
const SCRYPT_PARAMS: ScryptOptions = { N: 16_384, r: 8, p: 1 };

export function authFilePath(): string {
  return path.join(libraryDir(), AUTH_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Access code
// ---------------------------------------------------------------------------

/** A new random access code: 4 groups of 5 base32 characters (100 bits), e.g. `k7qm2-x9fda-3hz8w-p0rtc`. */
export function generateAccessCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < CODE_GROUPS; group++) {
    let text = '';
    for (let i = 0; i < CODE_GROUP_LENGTH; i++) text += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    groups.push(text);
  }
  return groups.join('-');
}

/**
 * What a person typed for a generated code, in canonical form: case, spaces and dashes do not matter,
 * and the letters that look like digits (o, i, l) count as those digits.
 */
export function normalizeGeneratedCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]+/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function sessionHash(token: string): string {
  return sha256(token).toString('hex');
}

function scryptAsync(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, SCRYPT_PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// ---------------------------------------------------------------------------
// .auth.json
// ---------------------------------------------------------------------------

/** A login session as stored: only the SHA-256 of its id, never the id itself. */
interface StoredSession {
  hash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** Content of library/.auth.json. */
interface AuthFile {
  version: 1;
  /** The generated access code (absent while EASY_STUDY_PASSWORD is used and none was ever generated). */
  code?: string;
  codeCreatedAt?: string;
  /**
   * scrypt of the access code the sessions were created with. When the code in effect changes (a new
   * EASY_STUDY_PASSWORD, the password removed, the code edited), every session is revoked at startup.
   */
  secret?: { salt: string; hash: string };
  sessions: StoredSession[];
}

interface SessionState {
  hash: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** lastSeenAt as last written to disk. */
  persistedSeenAt: number;
}

function parseTime(value: unknown): number {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : NaN;
}

function readSessions(value: unknown): SessionState[] {
  if (!Array.isArray(value)) return [];
  const sessions: SessionState[] = [];
  for (const entry of value as Partial<StoredSession>[]) {
    if (typeof entry !== 'object' || entry === null || typeof entry.hash !== 'string' || !HEX_64_RE.test(entry.hash)) continue;
    const createdAt = parseTime(entry.createdAt);
    const lastSeenAt = parseTime(entry.lastSeenAt);
    const expiresAt = parseTime(entry.expiresAt);
    if (![createdAt, lastSeenAt, expiresAt].every(Number.isFinite)) continue;
    sessions.push({ hash: entry.hash, createdAt, lastSeenAt, expiresAt, persistedSeenAt: lastSeenAt });
  }
  return sessions;
}

async function readAuthFile(file: string): Promise<Partial<AuthFile> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Partial<AuthFile>;
  } catch {
    // Falls through: treated like a missing file (a new code, no sessions).
  }
  console.warn(`[auth] ${file} is unreadable: a new access code is generated and every login ends`);
  return null;
}

/** Atomic write (temporary file + rename) with owner-only permissions: the file holds the access code. */
async function writeAuthFile(file: string, content: AuthFile): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(tmp, 0o600); // in case the file existed (mode applies to new files only)
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Serializes writes of each auth file within this process. */
const authFileQueue = createKeyedQueue();

// ---------------------------------------------------------------------------
// AuthStore: the access code and the sessions of one library
// ---------------------------------------------------------------------------

export interface AuthStoreOptions {
  /** Default: <library>/.auth.json. */
  file?: string;
  /** EASY_STUDY_PASSWORD: used as the access code instead of the generated one. */
  password?: string | null;
  /** --reset-access-code: a new generated code, every session revoked. */
  reset?: boolean;
  /** Clock (tests). */
  now?: () => number;
}

/**
 * The access code and login sessions of the library, backed by <library>/.auth.json. Open it only while
 * holding the library lock (library/.server.lock): one server process writes the file.
 */
export class AuthStore {
  readonly file: string;
  /** Where the access code comes from. */
  readonly codeSource: 'password' | 'generated';
  /** The access code people type (EASY_STUDY_PASSWORD when set). */
  readonly accessCode: string;
  /** A code was generated at this start (first start, deleted/unreadable file, --reset-access-code). */
  readonly codeIsNew: boolean;
  /** Sessions existed and were revoked at this start (reset, or the code in effect changed). */
  readonly sessionsRevoked: boolean;

  private readonly now: () => number;
  private readonly expectedDigest: Buffer;
  private readonly sessions = new Map<string, SessionState>();
  private generatedCode: string | undefined;
  private codeCreatedAt: string | undefined;
  private secret: { salt: string; hash: string };
  private dirty = false;
  private writing: Promise<void> | null = null;

  private constructor(init: {
    file: string;
    codeSource: 'password' | 'generated';
    accessCode: string;
    codeIsNew: boolean;
    sessionsRevoked: boolean;
    generatedCode: string | undefined;
    codeCreatedAt: string | undefined;
    secret: { salt: string; hash: string };
    sessions: SessionState[];
    now: () => number;
  }) {
    this.file = init.file;
    this.codeSource = init.codeSource;
    this.accessCode = init.accessCode;
    this.codeIsNew = init.codeIsNew;
    this.sessionsRevoked = init.sessionsRevoked;
    this.generatedCode = init.generatedCode;
    this.codeCreatedAt = init.codeCreatedAt;
    this.secret = init.secret;
    this.now = init.now;
    this.expectedDigest = sha256(this.canonical(init.accessCode));
    for (const session of init.sessions) this.sessions.set(session.hash, session);
  }

  /** Loads (or creates) the auth file, applies a reset or a changed code, and writes it back (mode 0600). */
  static async open(options: AuthStoreOptions = {}): Promise<AuthStore> {
    const file = options.file ?? authFilePath();
    const now = options.now ?? Date.now;
    const password = options.password?.trim() || null;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const stored = options.reset ? null : await readAuthFile(file);
    const existed = options.reset ? await fs.stat(file).then(() => true, () => false) : stored !== null;

    let generatedCode = typeof stored?.code === 'string' && GENERATED_CODE_RE.test(stored.code) ? stored.code : undefined;
    let codeCreatedAt = generatedCode ? stored?.codeCreatedAt : undefined;
    let codeIsNew = false;
    if (!generatedCode && password === null) {
      generatedCode = generateAccessCode();
      codeCreatedAt = new Date(now()).toISOString();
      codeIsNew = true;
    }
    const accessCode = password ?? (generatedCode as string);
    const codeSource = password !== null ? 'password' : 'generated';

    // The sessions stay valid only if they were created with the code that is in effect now.
    let sessions = readSessions(stored?.sessions);
    let secret: { salt: string; hash: string } | undefined;
    const storedSecret = stored?.secret;
    if (storedSecret && typeof storedSecret.salt === 'string' && typeof storedSecret.hash === 'string' && HEX_64_RE.test(storedSecret.hash)) {
      const derived = await scryptAsync(accessCode, Buffer.from(storedSecret.salt, 'hex'));
      if (timingSafeEqual(derived, Buffer.from(storedSecret.hash, 'hex'))) secret = { salt: storedSecret.salt, hash: storedSecret.hash };
    }
    let sessionsRevoked = options.reset === true && existed;
    if (!secret) {
      if (sessions.length > 0) sessionsRevoked = true;
      sessions = [];
      const salt = randomBytes(16);
      secret = { salt: salt.toString('hex'), hash: (await scryptAsync(accessCode, salt)).toString('hex') };
    }
    const time = now();
    sessions = sessions.filter((session) => session.expiresAt > time);

    const store = new AuthStore({
      file,
      codeSource,
      accessCode,
      codeIsNew,
      sessionsRevoked,
      generatedCode,
      codeCreatedAt,
      secret,
      sessions,
      now,
    });
    store.pruneSessions();
    // Always written: normalizes the content and the permissions of a file edited or copied by hand.
    await store.persist();
    return store;
  }

  private canonical(code: string): string {
    return this.codeSource === 'generated' ? normalizeGeneratedCode(code) : code.trim();
  }

  /** Whether `candidate` is the access code (constant-time; generated codes ignore case, spaces and dashes). */
  checkCode(candidate: string): boolean {
    if (candidate.length > MAX_CODE_INPUT) return false;
    return timingSafeEqual(sha256(this.canonical(candidate)), this.expectedDigest);
  }

  /** A new session; resolves with its id (the cookie value) once it is on disk. */
  async createSession(): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const time = this.now();
    const hash = sessionHash(token);
    this.sessions.set(hash, { hash, createdAt: time, lastSeenAt: time, expiresAt: time + SESSION_TTL_MS, persistedSeenAt: time });
    this.pruneSessions();
    await this.persist();
    return token;
  }

  /**
   * Whether `token` is a live session. A valid one slides its expiry (written back at most every
   * SESSION_TOUCH_PERSIST_MS); an expired one is removed.
   */
  validateSession(token: string): boolean {
    if (!SESSION_TOKEN_RE.test(token)) return false;
    const presented = sha256(token);
    const session = this.sessions.get(presented.toString('hex'));
    if (!session || !timingSafeEqual(presented, Buffer.from(session.hash, 'hex'))) return false;
    const time = this.now();
    if (session.expiresAt <= time) {
      this.sessions.delete(session.hash);
      this.persistInBackground();
      return false;
    }
    session.lastSeenAt = time;
    session.expiresAt = time + SESSION_TTL_MS;
    if (time - session.persistedSeenAt >= SESSION_TOUCH_PERSIST_MS) {
      session.persistedSeenAt = time;
      this.persistInBackground();
    }
    return true;
  }

  /** Ends a session (logout). Resolves with whether it existed. */
  async revokeSession(token: string): Promise<boolean> {
    if (!SESSION_TOKEN_RE.test(token)) return false;
    if (!this.sessions.delete(sessionHash(token))) return false;
    await this.persist();
    return true;
  }

  /** Live sessions (expired ones are dropped). */
  sessionCount(): number {
    const time = this.now();
    for (const session of this.sessions.values()) if (session.expiresAt <= time) this.sessions.delete(session.hash);
    return this.sessions.size;
  }

  /** Waits for pending writes (shutdown). */
  async flush(): Promise<void> {
    while (this.writing) await this.writing.catch(() => {});
  }

  /** Drops expired sessions and, beyond MAX_SESSIONS, the least recently used ones. */
  private pruneSessions(): void {
    const time = this.now();
    for (const session of this.sessions.values()) if (session.expiresAt <= time) this.sessions.delete(session.hash);
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldestFirst = [...this.sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const session of oldestFirst.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(session.hash);
  }

  private snapshot(): AuthFile {
    const iso = (time: number) => new Date(time).toISOString();
    return {
      version: 1,
      ...(this.generatedCode ? { code: this.generatedCode, codeCreatedAt: this.codeCreatedAt } : {}),
      secret: this.secret,
      sessions: [...this.sessions.values()].map((session) => ({
        hash: session.hash,
        createdAt: iso(session.createdAt),
        lastSeenAt: iso(session.lastSeenAt),
        expiresAt: iso(session.expiresAt),
      })),
    };
  }

  /** Writes the current state (coalesced: changes made while a write runs are written right after it). */
  private persist(): Promise<void> {
    this.dirty = true;
    this.writing ??= authFileQueue(this.file, async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          await writeAuthFile(this.file, this.snapshot());
        }
      } finally {
        this.writing = null;
      }
    });
    return this.writing;
  }

  private persistInBackground(): void {
    this.persist().catch((err: unknown) => console.warn(`[auth] could not write ${this.file}: ${(err as Error).message}`));
  }
}

// ---------------------------------------------------------------------------
// Login rate limit
// ---------------------------------------------------------------------------

export interface LoginLimiterOptions {
  limit?: number;
  windowMs?: number;
  globalLimit?: number;
  maxClients?: number;
  now?: () => number;
}

interface FailureWindow {
  count: number;
  resetAt: number;
}

/**
 * Failed logins per client (DESIGN §16: 10 failures / 10 minutes → 429 with Retry-After, checked before
 * the code is; a successful login clears the client's counter), plus a backstop for all clients together
 * so that many addresses do not multiply the guesses: once `globalLimit` logins failed within the window,
 * a failure locks its client at once for the rest of its window (one guess per address instead of ten).
 * The backstop never refuses a client that has not used up its own attempts: the owner can still log in
 * with the right code while someone floods the login with wrong ones (anyone who reaches the port could
 * otherwise lock everyone out). Remembers at most `maxClients` clients (oldest forgotten first).
 */
export class LoginLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly globalLimit: number;
  private readonly maxClients: number;
  private readonly now: () => number;
  private readonly clients = new Map<string, FailureWindow>();
  private global: FailureWindow = { count: 0, resetAt: 0 };

  constructor(options: LoginLimiterOptions = {}) {
    this.limit = options.limit ?? LOGIN_FAILURE_LIMIT;
    this.windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
    this.globalLimit = options.globalLimit ?? GLOBAL_LOGIN_FAILURE_LIMIT;
    this.maxClients = options.maxClients ?? LOGIN_LIMITER_MAX_CLIENTS;
    this.now = options.now ?? Date.now;
  }

  /** Seconds the client has to wait before the next attempt (0 = it may try now). */
  retryAfter(client: string): number {
    const time = this.now();
    const entry = this.clients.get(client);
    if (!entry) return 0;
    if (entry.resetAt <= time) {
      this.clients.delete(client);
      return 0;
    }
    return entry.count >= this.limit ? Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) : 0;
  }

  /** Whether the backstop for all clients together is on (every failure locks its client). */
  strict(): boolean {
    return this.global.resetAt > this.now() && this.global.count >= this.globalLimit;
  }

  /** Records a failed attempt of `client`. */
  fail(client: string): void {
    const time = this.now();
    const strict = this.strict();
    if (this.global.resetAt <= time) this.global = { count: 0, resetAt: time + this.windowMs };
    this.global.count++;
    let entry = this.clients.get(client);
    if (!entry || entry.resetAt <= time) {
      this.clients.delete(client);
      entry = { count: 0, resetAt: time + this.windowMs };
      this.clients.set(client, entry);
      if (this.clients.size > this.maxClients) this.evict(time);
    }
    entry.count = strict ? Math.max(entry.count + 1, this.limit) : entry.count + 1;
  }

  /** A successful login: the client's failures are forgotten. */
  succeed(client: string): void {
    this.clients.delete(client);
  }

  /** Clients currently remembered (tests). */
  get size(): number {
    return this.clients.size;
  }

  private evict(time: number): void {
    for (const [client, entry] of this.clients) if (entry.resetAt <= time) this.clients.delete(client);
    // Still full: forget the oldest windows (insertion order).
    for (const client of this.clients.keys()) {
      if (this.clients.size <= this.maxClients) break;
      this.clients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** `::ffff:1.2.3.4` → `1.2.3.4`; brackets, ports and zone ids removed; '' when it is not an IP address. */
export function normalizeAddress(value: string): string {
  let address = value.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) address = address.replace(/:\d+$/, '');
  address = address.replace(/%.*$/, '');
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  return isIP(address) ? address : '';
}

/** The 8 groups of an IPv6 address (null when it is not one). */
function ipv6Groups(address: string): string[] | null {
  if (!isIPv6(address)) return null;
  let text = address;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = halves.length > 1 ? [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right] : left;
  return groups.length === 8 ? groups.map((group) => parseInt(group, 16).toString(16)) : null;
}

/** The TCP peer is this computer (e.g. a reverse proxy such as tailscale serve). */
export function isLoopbackPeer(req: IncomingMessage): boolean {
  const peer = normalizeAddress(req.socket.remoteAddress ?? '');
  return peer !== '' && isLoopbackHost(peer);
}

function firstHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/**
 * Who a login attempt is counted against: the peer address; behind a reverse proxy on this computer
 * (e.g. `tailscale serve`, peer = loopback) the address the proxy appended to X-Forwarded-For. IPv6
 * clients are grouped by /64 (one home network or device usually has a whole /64).
 */
export function clientKey(remoteAddress: string | undefined, forwardedFor?: string | string[]): string {
  let address = normalizeAddress(remoteAddress ?? '');
  if (address !== '' && isLoopbackHost(address) && forwardedFor !== undefined) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const proxied = normalizeAddress(header.split(',').at(-1) ?? '');
    if (proxied) address = proxied;
  }
  const groups = ipv6Groups(address);
  if (groups) return `${groups.slice(0, 4).join(':')}::/64`;
  return address || 'unknown';
}

function requestClientKey(req: IncomingMessage): string {
  return clientKey(req.socket.remoteAddress, req.headers['x-forwarded-for']);
}

/** HTTPS: our own TLS, or `X-Forwarded-Proto: https` set by a reverse proxy on this computer. */
export function isHttpsRequest(req: IncomingMessage): boolean {
  if ((req.socket as Partial<TLSSocket>).encrypted === true) return true;
  const proto = firstHeader(req.headers['x-forwarded-proto']).split(',')[0]?.trim().toLowerCase();
  return proto === 'https' && isLoopbackPeer(req);
}

/** Values of the session cookie in a Cookie header (a browser may send several with the same name). */
export function sessionCookieValues(header: string | undefined): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    values.push(part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1'));
  }
  return values;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** `Authorization: Bearer <access code>` (null without one). */
function bearerCode(req: IncomingMessage): string | null {
  const match = /^Bearer[ \t]+(.+)$/i.exec(firstHeader(req.headers.authorization).trim());
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Express: /api/auth/*, the API gate, GET /login
// ---------------------------------------------------------------------------

type AuthResult =
  | { kind: 'ok'; via: 'bearer' | 'local' }
  | { kind: 'ok'; via: 'cookie'; token: string }
  | { kind: 'none' }
  | { kind: 'invalid-code' }
  | { kind: 'limited'; retryAfter: number };

export interface AuthGate {
  /** Remote mode: /api needs a session or the access code. */
  readonly required: boolean;
  /** GET /status, POST /login, POST /logout: mount at /api/auth, before `requireAuth`. */
  readonly routes: express.Router;
  /** 401 without a valid session cookie or `Authorization: Bearer <access code>` (remote mode). */
  readonly requireAuth: RequestHandler;
  /** GET /login?code=… — the one-click login link of the startup banner. */
  readonly loginLink: RequestHandler;
  /** Whether a request carries a valid session cookie (no side effects on the rate limit). */
  hasSession(req: IncomingMessage): boolean;
}

function tooManyAttempts(res: Response, retryAfter: number): void {
  res.set('Retry-After', String(retryAfter));
  res.set('Cache-Control', 'no-store');
  res.status(429).json({ error: smsg().auth.tooManyAttempts(Math.ceil(retryAfter / 60)) });
}

/** Body of a login that could not be checked (not a string, empty or absurdly long): 400. */
function loginCodeOf(body: unknown): string {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || code.trim() === '') throw new HttpError(400, smsg().auth.codeRequired);
  if (code.length > MAX_CODE_INPUT) throw new HttpError(400, smsg().auth.codeTooLong);
  return code;
}

/**
 * The login machinery of one server. `store` null = local mode: nothing is required, the routes answer
 * as if everyone were logged in, and /login just goes to the app.
 */
export function createAuthGate(store: AuthStore | null, limiter: LoginLimiter = new LoginLimiter()): AuthGate {
  const required = store !== null;

  /** The request's valid session id (null without one). */
  const sessionToken = (req: IncomingMessage): string | null => {
    if (!store) return null;
    return sessionCookieValues(req.headers.cookie).find((token) => store.validateSession(token)) ?? null;
  };
  const hasSession = (req: IncomingMessage): boolean => !store || sessionToken(req) !== null;

  /** A request's credentials: the access code as a bearer token (a wrong one counts as a failed login), or the cookie. */
  const authenticate = (req: IncomingMessage): AuthResult => {
    if (!store) return { kind: 'ok', via: 'local' };
    const code = bearerCode(req);
    if (code !== null) {
      const key = requestClientKey(req);
      const retryAfter = limiter.retryAfter(key);
      if (retryAfter > 0) return { kind: 'limited', retryAfter };
      if (store.checkCode(code)) {
        limiter.succeed(key);
        return { kind: 'ok', via: 'bearer' };
      }
      limiter.fail(key);
      return { kind: 'invalid-code' };
    }
    const token = sessionToken(req);
    return token !== null ? { kind: 'ok', via: 'cookie', token } : { kind: 'none' };
  };

  /** Logs the browser in: a new session (any session it still carried ends: no session fixation). */
  const startSession = async (req: Request, res: Response): Promise<void> => {
    for (const previous of sessionCookieValues(req.headers.cookie)) await (store as AuthStore).revokeSession(previous);
    const token = await (store as AuthStore).createSession();
    res.append('Set-Cookie', sessionCookie(token, isHttpsRequest(req)));
  };

  const routes = express.Router();

  routes.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = authenticate(req);
    if (result.kind === 'limited') return tooManyAttempts(res, result.retryAfter);
    // The client asks at every start: renew the cookie so that it lasts as long as the sliding session.
    if (result.kind === 'ok' && result.via === 'cookie') res.append('Set-Cookie', sessionCookie(result.token, isHttpsRequest(req)));
    const body: AuthStatusResponse = { authRequired: required, authenticated: result.kind === 'ok' };
    res.json(body);
  });

  routes.post('/login', express.json({ limit: '4kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!store) {
      res.status(204).end();
      return;
    }
    const key = requestClientKey(req);
    const retryAfter = limiter.retryAfter(key);
    if (retryAfter > 0) return tooManyAttempts(res, retryAfter);
    const code = loginCodeOf(req.body);
    if (!store.checkCode(code)) {
      limiter.fail(key);
      throw new HttpError(401, smsg().auth.codeInvalid);
    }
    limiter.succeed(key);
    await startSession(req, res);
    res.status(204).end();
  });

  routes.post('/logout', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (store) {
      for (const token of sessionCookieValues(req.headers.cookie)) await store.revokeSession(token);
      res.append('Set-Cookie', clearedSessionCookie(isHttpsRequest(req)));
    }
    res.status(204).end();
  });

  const requireAuth: RequestHandler = (req, res, next) => {
    if (!store) return next();
    // Responses behind the login must not be kept by shared caches (index.ts: slide images).
    res.locals.authRequired = true;
    const result = authenticate(req);
    if (result.kind === 'ok') return next();
    res.set('Cache-Control', 'no-store');
    if (result.kind === 'limited') return tooManyAttempts(res, result.retryAfter);
    res.set('WWW-Authenticate', 'Bearer realm="easy-study"');
    res.status(401).json({ error: result.kind === 'invalid-code' ? smsg().auth.codeInvalid : 'login required' });
  };

  const loginLink: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // The code is in the address: keep it out of caches and Referer headers, and out of the address bar
      // (303 to the app). Nothing logs this request.
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!store || code === '') return res.redirect(303, '/');
      const key = requestClientKey(req);
      if (limiter.retryAfter(key) > 0) return res.redirect(303, '/?login=limited');
      if (!store.checkCode(code)) {
        limiter.fail(key);
        return res.redirect(303, '/?login=failed');
      }
      limiter.succeed(key);
      await startSession(req, res);
      res.redirect(303, '/');
    } catch (err) {
      next(err);
    }
  };

  return { required, routes, requireAuth, loginLink, hasSession };
}

// ---------------------------------------------------------------------------
// Dev mode (Vite middleware) behind the login
// ---------------------------------------------------------------------------

export interface DevGuardOptions {
  /** Directories the dev server may serve through /@fs/ and /@id/ (the web client, shared/, node_modules). */
  allowRoots: string[];
  /** Directories never served, whatever the URL looks like (the library). */
  denyRoots: string[];
  /** File names never served (.auth.json, .server.lock). */
  denyNames: string[];
}

function comparable(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function isInside(root: string, target: string): boolean {
  const base = comparable(path.resolve(root)).replace(/\/+$/, '');
  const candidate = comparable(path.resolve(target));
  return candidate === base || candidate.startsWith(`${base}/`);
}

/** The file system path an /@fs/ or absolute /@id/ URL path names (null for other URLs). */
function devFilePath(pathname: string): string | null {
  let rest: string;
  if (pathname.startsWith('/@fs/')) rest = pathname.slice('/@fs'.length);
  else if (pathname.startsWith('/@id/')) rest = pathname.slice('/@id/'.length).replace(/^__x00__/, '');
  else return null;
  if (/^\/[a-z]:[\\/]/i.test(rest)) rest = rest.slice(1); // /C:/… on Windows
  return path.isAbsolute(rest) || /^[a-z]:[\\/]/i.test(rest) ? rest : null;
}

/**
 * Why the Vite dev server must not answer this URL in remote mode (null = fine). Vite's own file
 * restrictions allow the whole repository (web/vite.config.ts), which holds the default library with
 * the access code and every document; this check runs in front of Vite and does not depend on how Vite
 * decodes or normalizes URLs: any spelling that mentions the library, the auth/lock files or a `..`
 * segment is refused, and /@fs/ paths must lie inside the allowed roots.
 */
export function devRequestBlockReason(url: string, options: DevGuardOptions): string | null {
  const forms = [url];
  let current = url;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return 'malformed URL';
    }
    if (decoded === current) break;
    forms.push(decoded);
    current = decoded;
  }
  const denyRoots = options.denyRoots.map((root) => comparable(path.resolve(root)).replace(/\/+$/, ''));
  const denyNames = options.denyNames.map(comparable);
  for (const form of forms) {
    const text = comparable(form);
    if (/(^|\/)\.\.(\/|$|\?|#)/.test(text)) return 'parent directory segment';
    if (denyRoots.some((root) => text.includes(root))) return 'library path';
    if (denyNames.some((name) => text.includes(name))) return 'protected file';
  }
  const pathname = current.split(/[?#]/)[0];
  const file = devFilePath(pathname);
  if (file !== null && !options.allowRoots.some((root) => isInside(root, file))) return 'outside the allowed directories';
  return null;
}

/** Express middleware in front of Vite (dev mode with remote access). */
export function devServerGuard(options: DevGuardOptions, gate: AuthGate): RequestHandler {
  return (req, res, next) => {
    const reason = devRequestBlockReason(req.url, options);
    // "Open in editor" (error overlay links) runs a program on this computer: logged-in users only.
    const editor = req.path.startsWith('/__open-in-editor') && !gate.hasSession(req);
    if (reason === null && !editor) return next();
    res.status(403).type('text/plain; charset=utf-8').send('Forbidden\n');
  };
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

function urlHost(hostname: string): string {
  return isIPv6(hostname) ? `[${hostname}]` : hostname;
}

/**
 * Addresses other computers can use: every non-internal IPv4 address plus the host name when bound to
 * all interfaces, the bound address otherwise (loopback = only this computer, e.g. behind tailscale serve).
 */
export function reachableUrls(
  scheme: 'http' | 'https',
  bindHost: string,
  port: number,
  interfaces: NetworkInterfaces = os.networkInterfaces(),
  hostname: string = os.hostname(),
): string[] {
  const bare = bindHost.replace(/^\[(.*)\]$/, '$1');
  if (!isWildcardHost(bare)) return [`${scheme}://${urlHost(bare)}:${port}`];
  const urls: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== 'IPv4' && family !== 4) || entry.address.startsWith('169.254.')) continue;
      const url = `${scheme}://${entry.address}:${port}`;
      if (!urls.includes(url)) urls.push(url);
    }
  }
  if (/^[a-z0-9][a-z0-9.-]*$/i.test(hostname)) urls.push(`${scheme}://${hostname}:${port}`);
  return urls;
}

export interface AccessBannerInfo {
  scheme: 'http' | 'https';
  bindHost: string;
  /** reachableUrls(). */
  urls: string[];
  store: Pick<AuthStore, 'accessCode' | 'codeSource' | 'codeIsNew' | 'sessionsRevoked'>;
  dev: boolean;
  /** How to start the server again with --reset-access-code. */
  resetCommand: string;
}

/**
 * The remote-mode part of the startup log (DESIGN §16): where to connect, the access code and a
 * one-click login link. This is the only place the generated code is ever printed; a password from
 * EASY_STUDY_PASSWORD is never printed.
 */
export function formatAccessBanner(info: AccessBannerInfo): string {
  const { store, urls } = info;
  const behindProxy = isLoopbackHost(info.bindHost.replace(/^\[(.*)\]$/, '$1'));
  const lines: string[] = [];
  lines.push(
    behindProxy
      ? '  원격 모드 (로그인 필요) — 이 컴퓨터에서만 열려 있습니다: 리버스 프록시(예: tailscale serve)로 공개하세요.'
      : '  원격 모드 (로그인 필요) — 다른 컴퓨터/태블릿에서 아래 주소로 접속하세요:',
  );
  for (const url of urls) lines.push(`    ${url}`);
  if (urls.length === 0) lines.push('    (네트워크 주소를 찾지 못했습니다: Wi-Fi/이더넷 연결을 확인하세요)');
  if (store.codeSource === 'password') {
    lines.push('  접속 코드   →  EASY_STUDY_PASSWORD 에 지정한 비밀번호');
  } else {
    lines.push(`  접속 코드   →  ${store.accessCode}${store.codeIsNew ? '   (새로 만들었습니다)' : ''}`);
    const loginBase = urls[0] ?? `${info.scheme}://127.0.0.1`;
    lines.push(`  바로 로그인 →  ${loginBase}/login?code=${encodeURIComponent(store.accessCode)}`);
  }
  if (store.sessionsRevoked) {
    // With EASY_STUDY_PASSWORD a reset ends the logins without changing the code.
    lines.push(store.codeSource === 'password' ? '  이전 로그인은 모두 끊었습니다.' : '  이전 로그인은 모두 끊었습니다 (접속 코드가 바뀌었습니다).');
  }
  if (info.scheme === 'http' && !behindProxy) {
    lines.push(
      '  ⚠ 암호화되지 않은 HTTP입니다: 같은 Wi-Fi(믿을 수 있는 네트워크)에서만 쓰세요. ' +
        '밖에서는 Tailscale/HTTPS를 쓰세요 (same Wi-Fi only; use Tailscale/HTTPS outside).',
    );
    // Chrome/Edge install a web app only from a secure context: HTTPS or this computer's loopback address.
    const port = urls.map((url) => new URL(url).port).find(Boolean);
    const wildcard = isWildcardHost(info.bindHost.replace(/^\[(.*)\]$/, '$1'));
    const here = wildcard && port ? ` 이 컴퓨터에서는 http://127.0.0.1:${port} 에서 설치할 수 있고,` : '';
    lines.push(
      '  ⓘ 다른 컴퓨터에서 Chrome/Edge로 앱 설치를 하려면 HTTPS가 필요합니다: tailscale serve 또는 ' +
        `EASY_STUDY_TLS_CERT/KEY (README ‘앱으로 설치하기’).${here} Safari의 ‘Dock에 추가’는 HTTP에서도 됩니다.`,
    );
  }
  if (info.dev) {
    lines.push('  ⚠ 개발 모드(npm run dev)는 원격 접속용이 아닙니다: 다른 기기에서 쓸 때는 npm start 로 실행하세요.');
  }
  if (store.codeSource === 'password') {
    // A reset ends the logins but cannot change a password that comes from the environment.
    lines.push(`  모든 로그인을 끊으려면: ${info.resetCommand}   (접속 코드를 바꾸려면 EASY_STUDY_PASSWORD 를 바꾸세요)`);
  } else {
    lines.push(`  코드를 바꾸고 모든 로그인을 끊으려면: ${info.resetCommand}`);
  }
  return lines.join('\n');
}
