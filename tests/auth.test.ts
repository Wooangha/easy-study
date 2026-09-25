// Remote mode (DESIGN §16): network settings (server/config.ts), the access code, sessions, rate limit and
// request helpers (server/auth.ts), and in-process HTTP tests of the login gate in server/index.ts.
// No real CLI or API is ever called; every server uses its own temporary library and an ephemeral port on
// 127.0.0.1 (remote mode is switched on with auth: 'on', never by binding other interfaces).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import express from 'express';
import {
  AUTH_FILE_NAME,
  AuthStore,
  LoginLimiter,
  MAX_SESSIONS,
  SESSION_TTL_MS,
  clientKey,
  createAuthGate,
  devRequestBlockReason,
  devServerGuard,
  formatAccessBanner,
  generateAccessCode,
  isHttpsRequest,
  normalizeGeneratedCode,
  reachableUrls,
  sessionCookie,
  sessionCookieValues,
} from '../server/auth.ts';
import type { AccessBannerInfo } from '../server/auth.ts';
import {
  ConfigError,
  SERVER_SECRET_ENV,
  childProcessEnv,
  isLoopbackHost,
  isWildcardHost,
  networkSettings,
  repoRoot,
  webDistDir,
} from '../server/config.ts';
import { workerEnv } from '../server/imageWorker.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer, ServerOptions } from '../server/index.ts';
import { LibraryLockedError, SERVER_LOCK_FILE_NAME, toolEnv } from '../server/library.ts';
import { claudeEnv } from '../server/providers/claudeCode.ts';
import { childEnv } from '../server/providers/proc.ts';

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{5}(?:-[0-9a-hjkmnp-tv-z]{5}){3}$/;
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const DOC_ID = 'deck-aaa111';
const SESSION_ID = '20260101-000000-abcd';
const COURSE_ID = 'course-bbb222';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-auth-'));
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

let libraryCount = 0;

/** A fresh library directory, made current (EASY_STUDY_LIBRARY is read lazily). */
async function useLibrary(): Promise<string> {
  const dir = path.join(tmpRoot, `library-${++libraryCount}`);
  await fs.mkdir(dir, { recursive: true });
  process.env.EASY_STUDY_LIBRARY = dir;
  return dir;
}

/** A converted one-slide document (doc.json + slides/001.png). */
async function makeDoc(library: string, docId = DOC_ID): Promise<void> {
  const dir = path.join(library, docId);
  await fs.mkdir(path.join(dir, 'slides'), { recursive: true });
  await fs.mkdir(path.join(dir, 'text'), { recursive: true });
  const meta = {
    id: docId,
    title: 'Deck',
    fileName: 'Deck.pdf',
    pageCount: 1,
    aspectRatio: 4 / 3,
    status: 'ready',
    progress: 1,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, 'doc.json'), JSON.stringify(meta));
  await fs.writeFile(path.join(dir, 'slides', '001.png'), PNG_1X1);
  await fs.writeFile(path.join(dir, 'text', '001.txt'), 'slide one');
}

function start(options: ServerOptions = {}): Promise<RunningServer> {
  return startServer({ port: 0, log: false, resumeIngests: false, providerInfos: async () => [], ...options });
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RawRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** CA certificate for https:// bases. */
  ca?: Buffer;
}

/** A request with full control over the headers (fetch cannot set Host, and follows redirects). */
function request(base: string, target: string, init: RawRequest = {}): Promise<RawResponse> {
  const url = new URL(target, base);
  const secure = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: init.headers,
        // A fresh connection per request: a reused keep-alive socket can be reset after a 401 that left a
        // request body unread (plain Node behaviour), which would make these tests flaky.
        agent: false,
        ...(secure ? { ca: init.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

function setCookies(res: RawResponse): string[] {
  return res.headers['set-cookie'] ?? [];
}

/** `es_session=<id>` from a login response. */
function cookieOf(res: RawResponse): string {
  const cookie = setCookies(res).find((value) => value.startsWith('es_session=') && !value.startsWith('es_session=;'));
  assert.ok(cookie, `no session cookie in ${JSON.stringify(res.headers)}`);
  return cookie.split(';')[0];
}

function jsonLogin(base: string, code: unknown, headers: Record<string, string> = {}, ca?: Buffer): Promise<RawResponse> {
  return request(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ code }),
    ca,
  });
}

function errorOf(res: RawResponse): string {
  assert.match(String(res.headers['content-type']), /application\/json/);
  const body = JSON.parse(res.body) as { error?: unknown };
  assert.equal(typeof body.error, 'string');
  return body.error as string;
}

/** Headers every response carries in both modes (no framing by other sites, no Referer, no sniffing). */
function assertSecurityHeaders(res: RawResponse, what: string): void {
  assert.equal(res.headers['x-frame-options'], 'DENY', what);
  assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'", what);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', what);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
}

/** Every kind of response of a server: the client, static files, the login link, API answers and errors. */
async function assertSecurityHeadersEverywhere(base: string): Promise<void> {
  const targets = ['/', '/index.html', '/some/client/route', '/manifest.webmanifest', '/login?code=x', '/login', '/api/auth/status', '/api/docs', '/api/nope'];
  const assets = await fs.readdir(path.join(webDistDir(), 'assets')).catch(() => [] as string[]);
  if (assets.length > 0) targets.push(`/assets/${assets[0]}`);
  for (const target of targets) assertSecurityHeaders(await request(base, target), target);
  const post = await request(base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assertSecurityHeaders(post, 'POST /api/auth/login (400)');
}

function fakeRequest(remoteAddress: string, headers: Record<string, string> = {}, encrypted = false): IncomingMessage {
  return { socket: { remoteAddress, encrypted }, headers } as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('network settings (EASY_STUDY_HOST / AUTH / PASSWORD / TLS)', () => {
  test('local mode by default', () => {
    assert.deepEqual(networkSettings({}, {}), { host: '127.0.0.1', authRequired: false, password: null, tls: null });
  });

  test('a non-loopback host turns the login on; loopback names stay local', () => {
    for (const host of ['0.0.0.0', '::', '192.168.0.10', '[fe80::1]', 'my-mac.local']) {
      assert.equal(networkSettings({}, { EASY_STUDY_HOST: host }).authRequired, true, host);
    }
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) {
      assert.equal(networkSettings({}, { EASY_STUDY_HOST: host }).authRequired, false, host);
    }
  });

  test('EASY_STUDY_AUTH=on with loopback (reverse proxy) requires the login too', () => {
    const settings = networkSettings({}, { EASY_STUDY_AUTH: 'on' });
    assert.equal(settings.host, '127.0.0.1');
    assert.equal(settings.authRequired, true);
    assert.equal(networkSettings({}, { EASY_STUDY_AUTH: 'true', EASY_STUDY_HOST: 'localhost' }).authRequired, true);
  });

  test('EASY_STUDY_AUTH=off on a non-loopback host is refused', () => {
    for (const [host, auth] of [
      ['0.0.0.0', 'off'],
      ['::', 'false'],
      ['192.168.0.10', '0'],
    ]) {
      assert.throws(() => networkSettings({}, { EASY_STUDY_HOST: host, EASY_STUDY_AUTH: auth }), (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /EASY_STUDY_AUTH=off/);
        return true;
      });
    }
    assert.equal(networkSettings({}, { EASY_STUDY_HOST: '127.0.0.1', EASY_STUDY_AUTH: 'off' }).authRequired, false);
    // Overrides (command line, tests) are checked the same way.
    assert.throws(() => networkSettings({ host: '0.0.0.0', auth: 'off' }, {}), ConfigError);
  });

  test('invalid values are refused with a clear message', () => {
    assert.throws(() => networkSettings({}, { EASY_STUDY_AUTH: 'maybe' }), /EASY_STUDY_AUTH/);
    assert.throws(() => networkSettings({}, { EASY_STUDY_HOST: 'bad host!' }), /EASY_STUDY_HOST/);
    assert.throws(() => networkSettings({}, { EASY_STUDY_PASSWORD: 'short' }), /8자 이상/);
    assert.throws(() => networkSettings({}, { EASY_STUDY_TLS_CERT: 'cert.pem' }), /둘 다/);
    assert.throws(() => networkSettings({}, { EASY_STUDY_TLS_KEY: 'key.pem' }), /둘 다/);
  });

  test('password and TLS files', () => {
    const settings = networkSettings({}, { EASY_STUDY_PASSWORD: '  correct horse  ', EASY_STUDY_TLS_CERT: 'c.pem', EASY_STUDY_TLS_KEY: 'k.pem' });
    assert.equal(settings.password, 'correct horse');
    assert.deepEqual(settings.tls, { certFile: path.resolve('c.pem'), keyFile: path.resolve('k.pem') });
    assert.equal(networkSettings({}, { EASY_STUDY_PASSWORD: '   ' }).password, null);
    assert.equal(networkSettings({ password: null }, { EASY_STUDY_PASSWORD: 'from-the-env' }).password, null);
  });

  test('loopback and wildcard addresses', () => {
    assert.ok(isLoopbackHost('::ffff:127.0.0.1'));
    assert.ok(isLoopbackHost('0:0:0:0:0:0:0:1'));
    assert.ok(!isLoopbackHost('128.0.0.1'));
    assert.ok(!isLoopbackHost('localhost.evil.example'));
    assert.ok(isWildcardHost('0.0.0.0') && isWildcardHost('::') && isWildcardHost('[::]'));
    assert.ok(!isWildcardHost('127.0.0.1'));
  });
});

// ---------------------------------------------------------------------------
// Access code, store, rate limit, helpers
// ---------------------------------------------------------------------------

describe('access code', () => {
  test('generated codes: 4 groups of 5 base32 characters, all different', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateAccessCode()));
    assert.equal(codes.size, 200);
    for (const code of codes) assert.match(code, CODE_RE);
  });

  test('typing variants of a generated code are equivalent', () => {
    assert.equal(normalizeGeneratedCode('AB0C1-dEf 23\n'), 'ab0c1def23');
    assert.equal(normalizeGeneratedCode('o-I-l'), '011');
  });
});

describe('AuthStore (.auth.json)', () => {
  test('creates the file (mode 0600) with a generated code and reuses it', async () => {
    const library = await useLibrary();
    const file = path.join(library, AUTH_FILE_NAME);
    const store = await AuthStore.open();
    assert.equal(store.file, file);
    assert.equal(store.codeSource, 'generated');
    assert.equal(store.codeIsNew, true);
    assert.match(store.accessCode, CODE_RE);
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    const again = await AuthStore.open();
    assert.equal(again.accessCode, store.accessCode);
    assert.equal(again.codeIsNew, false);
    assert.equal(again.sessionsRevoked, false);
    // No temporary files are left behind.
    assert.deepEqual(await fs.readdir(library), [AUTH_FILE_NAME]);
  });

  test('checks the code in constant time, forgivingly for generated codes', async () => {
    await useLibrary();
    const store = await AuthStore.open();
    const code = store.accessCode;
    assert.ok(store.checkCode(code));
    assert.ok(store.checkCode(` ${code.toUpperCase().replace(/-/g, ' ')} `));
    assert.ok(store.checkCode(code.replace(/-/g, '')));
    assert.ok(!store.checkCode(''));
    assert.ok(!store.checkCode(`${code}x`));
    assert.ok(!store.checkCode('x'.repeat(10_000)));
  });

  test('stores only hashes of session ids; sessions survive reopening', async () => {
    const library = await useLibrary();
    const store = await AuthStore.open();
    const token = await store.createSession();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const raw = await fs.readFile(path.join(library, AUTH_FILE_NAME), 'utf8');
    assert.ok(!raw.includes(token), 'the session id itself is never written');
    assert.ok(raw.includes(createHash('sha256').update(token).digest('hex')));
    assert.ok(store.validateSession(token));
    assert.ok(!store.validateSession(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`));
    assert.ok(!store.validateSession('not-a-token'));

    const reopened = await AuthStore.open();
    assert.ok(reopened.validateSession(token));
    assert.equal(await reopened.revokeSession(token), true);
    assert.ok(!reopened.validateSession(token));
    assert.ok(!(await AuthStore.open()).validateSession(token), 'the revocation is on disk');
  });

  test('reset: a new code, every session revoked', async () => {
    await useLibrary();
    const store = await AuthStore.open();
    const token = await store.createSession();
    const reset = await AuthStore.open({ reset: true });
    assert.notEqual(reset.accessCode, store.accessCode);
    assert.equal(reset.codeIsNew, true);
    assert.equal(reset.sessionsRevoked, true);
    assert.ok(!reset.validateSession(token));
    assert.ok(!reset.checkCode(store.accessCode));
  });

  test('a deleted or unreadable file means a new code and no sessions', async () => {
    const library = await useLibrary();
    const file = path.join(library, AUTH_FILE_NAME);
    const store = await AuthStore.open();
    const token = await store.createSession();
    await fs.rm(file);
    const fresh = await AuthStore.open();
    assert.notEqual(fresh.accessCode, store.accessCode);
    assert.ok(!fresh.validateSession(token));

    await fs.writeFile(file, '{ not json');
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    try {
      const repaired = await AuthStore.open();
      assert.match(repaired.accessCode, CODE_RE);
      assert.equal(repaired.codeIsNew, true);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
  });

  test('a hand-edited file with loose permissions is rewritten with mode 0600', { skip: process.platform === 'win32' }, async () => {
    const library = await useLibrary();
    const file = path.join(library, AUTH_FILE_NAME);
    const store = await AuthStore.open();
    await fs.chmod(file, 0o644);
    const reopened = await AuthStore.open();
    assert.equal(reopened.accessCode, store.accessCode);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });

  test('EASY_STUDY_PASSWORD: used as the code; changing it revokes the sessions', async () => {
    const library = await useLibrary();
    const store = await AuthStore.open({ password: 'correct horse battery' });
    assert.equal(store.codeSource, 'password');
    assert.equal(store.accessCode, 'correct horse battery');
    assert.ok(store.checkCode('correct horse battery'));
    assert.ok(store.checkCode('  correct horse battery '));
    assert.ok(!store.checkCode('Correct horse battery'), 'passwords are case-sensitive');
    const raw = await fs.readFile(path.join(library, AUTH_FILE_NAME), 'utf8');
    assert.ok(!raw.includes('correct horse'), 'the password is never written');
    const token = await store.createSession();

    const same = await AuthStore.open({ password: 'correct horse battery' });
    assert.ok(same.validateSession(token));
    assert.equal(same.sessionsRevoked, false);

    const changed = await AuthStore.open({ password: 'another long password' });
    assert.equal(changed.sessionsRevoked, true);
    assert.ok(!changed.validateSession(token));

    // Back to a generated code: also a different code, so the sessions of the password end too.
    const token2 = await changed.createSession();
    const generated = await AuthStore.open();
    assert.equal(generated.codeSource, 'generated');
    assert.match(generated.accessCode, CODE_RE);
    assert.ok(!generated.validateSession(token2));
  });

  test('sessions expire 30 days after their last use (sliding) and stay bounded', async () => {
    const library = await useLibrary();
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const now = () => clock;
    const store = await AuthStore.open({ now });
    const token = await store.createSession();
    clock += 29 * DAY;
    assert.ok(store.validateSession(token));
    clock += 29 * DAY; // 58 days after the login, 29 after the last use
    assert.ok(store.validateSession(token));
    await store.flush();
    // The sliding expiry is on disk: a restart keeps the session.
    const reopened = await AuthStore.open({ now });
    assert.ok(reopened.validateSession(token));
    clock += SESSION_TTL_MS + 1;
    assert.ok(!reopened.validateSession(token));
    assert.equal(reopened.sessionCount(), 0);
    await reopened.flush();
    const file = JSON.parse(await fs.readFile(path.join(library, AUTH_FILE_NAME), 'utf8')) as { sessions: unknown[] };
    assert.equal(file.sessions.length, 0, 'expired sessions are dropped from the file');

    // At most MAX_SESSIONS: the least recently used one goes first.
    const tokens: string[] = [];
    for (let i = 0; i <= MAX_SESSIONS; i++) {
      clock += 1000;
      tokens.push(await reopened.createSession());
    }
    assert.equal(reopened.sessionCount(), MAX_SESSIONS);
    assert.ok(!reopened.validateSession(tokens[0]));
    assert.ok(reopened.validateSession(tokens[MAX_SESSIONS]));
  });

  test('expired sessions in the file are dropped at startup', async () => {
    const library = await useLibrary();
    let clock = Date.parse('2026-03-01T00:00:00Z');
    const store = await AuthStore.open({ now: () => clock });
    const token = await store.createSession();
    clock += SESSION_TTL_MS + DAY;
    const later = await AuthStore.open({ now: () => clock });
    assert.ok(!later.validateSession(token));
    const file = JSON.parse(await fs.readFile(path.join(library, AUTH_FILE_NAME), 'utf8')) as { sessions: unknown[] };
    assert.deepEqual(file.sessions, []);
  });
});

describe('login rate limit', () => {
  test('10 failures per client in 10 minutes → wait; a success clears the counter', () => {
    let clock = 0;
    const limiter = new LoginLimiter({ now: () => clock });
    for (let i = 0; i < 9; i++) limiter.fail('a');
    assert.equal(limiter.retryAfter('a'), 0);
    limiter.fail('a');
    assert.equal(limiter.retryAfter('a'), 600);
    assert.equal(limiter.retryAfter('b'), 0, 'other clients are not affected');
    clock += 5 * 60 * 1000;
    assert.equal(limiter.retryAfter('a'), 300);
    clock += 5 * 60 * 1000;
    assert.equal(limiter.retryAfter('a'), 0, 'the window is over');

    for (let i = 0; i < 9; i++) limiter.fail('c');
    limiter.succeed('c');
    limiter.fail('c');
    assert.equal(limiter.retryAfter('c'), 0);
  });

  test('many failing clients: one guess per client, but never a lockout of a client with attempts left', () => {
    let clock = 0;
    const limiter = new LoginLimiter({ limit: 10, globalLimit: 5, now: () => clock });
    limiter.fail('typo'); // the owner mistyped once before the flood
    for (let i = 0; i < 4; i++) limiter.fail(`attacker-${i}`);
    assert.equal(limiter.strict(), true, '5 failures from all clients together');
    // Nobody is refused before trying: the owner (from a clean or a mistyped client) can still log in.
    assert.equal(limiter.retryAfter('owner'), 0);
    assert.equal(limiter.retryAfter('typo'), 0);
    assert.equal(limiter.retryAfter('attacker-0'), 0);
    // But now a failure locks its client at once for its window: one guess per address, not ten.
    limiter.fail('attacker-9');
    assert.equal(limiter.retryAfter('attacker-9'), 600);
    limiter.fail('attacker-0');
    assert.equal(limiter.retryAfter('attacker-0'), 600);
    limiter.succeed('typo');
    assert.equal(limiter.retryAfter('typo'), 0);
    // The flood's window ends: back to ten failures per client.
    clock += 10 * 60 * 1000;
    assert.equal(limiter.strict(), false);
    limiter.fail('later');
    assert.equal(limiter.retryAfter('later'), 0);
  });

  test('bounded memory', () => {
    let clock = 0;
    const limiter = new LoginLimiter({ maxClients: 100, globalLimit: Infinity, now: () => clock });
    for (let i = 0; i < 5000; i++) {
      clock += 1;
      limiter.fail(`10.0.${Math.floor(i / 250)}.${i % 250}`);
    }
    assert.ok(limiter.size <= 100);
  });
});

describe('the server’s secrets stay out of child processes', () => {
  test('no CLI, poppler tool or image worker inherits the access password or the TLS files', () => {
    const names = ['EASY_STUDY_PASSWORD', 'EASY_STUDY_TLS_KEY', 'EASY_STUDY_TLS_CERT', 'EASY_STUDY_CLAUDE_USE_API_KEY'];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.EASY_STUDY_PASSWORD = 'super-secret-access-code-123';
      process.env.EASY_STUDY_TLS_KEY = '/etc/keys/server.key';
      process.env.EASY_STUDY_TLS_CERT = '/etc/keys/server.crt';
      assert.deepEqual([...SERVER_SECRET_ENV].sort(), ['EASY_STUDY_PASSWORD', 'EASY_STUDY_TLS_CERT', 'EASY_STUDY_TLS_KEY']);
      for (const useApiKey of [undefined, '1']) {
        if (useApiKey === undefined) delete process.env.EASY_STUDY_CLAUDE_USE_API_KEY;
        else process.env.EASY_STUDY_CLAUDE_USE_API_KEY = useApiKey;
        const envs: [string, NodeJS.ProcessEnv][] = [
          ['childEnv', childEnv()],
          ['childEnv(remove)', childEnv(['ANTHROPIC_API_KEY'])],
          ['claudeEnv', claudeEnv()],
          ['toolEnv', toolEnv()],
          ['workerEnv', workerEnv()],
          ['childProcessEnv', childProcessEnv()],
        ];
        for (const [what, env] of envs) {
          for (const name of SERVER_SECRET_ENV) assert.equal(env[name], undefined, `${what}: ${name}`);
          assert.ok(!JSON.stringify(env).includes('super-secret-access-code-123'), what);
          assert.equal(env.HOME, process.env.HOME, `${what}: the rest of the environment is kept`);
        }
      }
      assert.equal(process.env.EASY_STUDY_PASSWORD, 'super-secret-access-code-123', 'the server itself keeps it');
      // Windows environment names are case-insensitive: any spelling is removed.
      const env = childProcessEnv({ easy_study_password: 'x', Easy_Study_Tls_Key: 'y', EASY_STUDY_LIBRARY: '/lib', PATH: '/bin' });
      assert.deepEqual(env, { EASY_STUDY_LIBRARY: '/lib', PATH: '/bin' });
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});

describe('request helpers', () => {
  test('client keys: IPv4-mapped addresses, IPv6 by /64, X-Forwarded-For only from a local proxy', () => {
    assert.equal(clientKey('::ffff:192.168.0.7'), '192.168.0.7');
    assert.equal(clientKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(clientKey('2001:db8:1:2:ffff::1'), '2001:db8:1:2::/64');
    assert.equal(clientKey('127.0.0.1'), '127.0.0.1');
    assert.equal(clientKey('127.0.0.1', '203.0.113.9, 100.64.0.5'), '100.64.0.5', 'the address the proxy appended');
    assert.equal(clientKey('::1', ['203.0.113.9']), '203.0.113.9');
    assert.equal(clientKey('127.0.0.1', 'garbage'), '127.0.0.1');
    assert.equal(clientKey('192.168.0.7', '203.0.113.9'), '192.168.0.7', 'other peers cannot choose their key');
    assert.equal(clientKey(undefined), 'unknown');
  });

  test('HTTPS: own TLS, or X-Forwarded-Proto from a loopback peer only', () => {
    assert.ok(isHttpsRequest(fakeRequest('192.168.0.5', {}, true)));
    assert.ok(isHttpsRequest(fakeRequest('127.0.0.1', { 'x-forwarded-proto': 'https' })));
    assert.ok(isHttpsRequest(fakeRequest('::1', { 'x-forwarded-proto': 'HTTPS, http' })));
    assert.ok(!isHttpsRequest(fakeRequest('192.168.0.5', { 'x-forwarded-proto': 'https' })));
    assert.ok(!isHttpsRequest(fakeRequest('127.0.0.1', { 'x-forwarded-proto': 'http' })));
    assert.ok(!isHttpsRequest(fakeRequest('127.0.0.1')));
  });

  test('session cookies', () => {
    assert.deepEqual(sessionCookieValues('a=1; es_session=abc; es_session="def"; es_sessionx=no'), ['abc', 'def']);
    assert.deepEqual(sessionCookieValues(undefined), []);
    assert.equal(sessionCookie('tok', false), 'es_session=tok; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict');
    assert.equal(sessionCookie('tok', true), 'es_session=tok; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict; Secure');
  });
});

describe('startup banner', () => {
  const store = { accessCode: 'k7qm2-x9fda-3hz8w-p0rtc', codeSource: 'generated' as const, codeIsNew: true, sessionsRevoked: false };
  const base: AccessBannerInfo = {
    scheme: 'http',
    bindHost: '0.0.0.0',
    urls: ['http://192.168.0.10:5180', 'http://my-mac.local:5180'],
    store,
    dev: false,
    resetCommand: 'npm run serve:remote -- --reset-access-code',
  };

  test('addresses, the code, a one-click login link and the plain-HTTP warning', () => {
    const text = formatAccessBanner(base);
    assert.match(text, /http:\/\/192\.168\.0\.10:5180\n/);
    assert.match(text, /http:\/\/my-mac\.local:5180/);
    assert.match(text, /접속 코드 {3}→ {2}k7qm2-x9fda-3hz8w-p0rtc/);
    assert.ok(text.includes('http://192.168.0.10:5180/login?code=k7qm2-x9fda-3hz8w-p0rtc'));
    assert.match(text, /same Wi-Fi only; use Tailscale\/HTTPS outside/);
    assert.match(text, /--reset-access-code/);
  });

  test('no plain-HTTP warning with HTTPS or behind a local reverse proxy', () => {
    assert.doesNotMatch(formatAccessBanner({ ...base, scheme: 'https', urls: ['https://192.168.0.10:5180'] }), /same Wi-Fi/);
    const proxied = formatAccessBanner({ ...base, bindHost: '127.0.0.1', urls: ['http://127.0.0.1:5180'] });
    assert.doesNotMatch(proxied, /same Wi-Fi/);
    assert.match(proxied, /tailscale serve/);
    assert.ok(proxied.includes('http://127.0.0.1:5180/login?code='));
  });

  test('a password from EASY_STUDY_PASSWORD is never printed', () => {
    const text = formatAccessBanner({ ...base, store: { ...store, accessCode: 'my secret password', codeSource: 'password' } });
    assert.ok(!text.includes('my secret password'));
    assert.doesNotMatch(text, /login\?code=/);
    assert.match(text, /EASY_STUDY_PASSWORD/);
  });

  test('with EASY_STUDY_PASSWORD a reset only ends the logins, and the banner says so', () => {
    const password = { ...store, accessCode: 'my secret password', codeSource: 'password' as const, codeIsNew: false };
    const text = formatAccessBanner({ ...base, store: { ...password, sessionsRevoked: true } });
    assert.doesNotMatch(text, /코드를 바꾸고/, 'a reset does not change a password');
    assert.doesNotMatch(text, /접속 코드가 바뀌었습니다/);
    assert.match(text, /모든 로그인을 끊으려면: npm run serve:remote -- --reset-access-code {3}\(접속 코드를 바꾸려면 EASY_STUDY_PASSWORD 를 바꾸세요\)/);
    assert.match(text, /이전 로그인은 모두 끊었습니다\./);
    // A generated code does change.
    const generated = formatAccessBanner({ ...base, store: { ...store, sessionsRevoked: true } });
    assert.match(generated, /코드를 바꾸고 모든 로그인을 끊으려면: npm run serve:remote -- --reset-access-code$/m);
    assert.match(generated, /이전 로그인은 모두 끊었습니다 \(접속 코드가 바뀌었습니다\)/);
  });

  test('plain HTTP: installing the app on other computers needs HTTPS (Chrome/Edge)', () => {
    const text = formatAccessBanner(base);
    assert.match(text, /다른 컴퓨터에서 Chrome\/Edge로 앱 설치를 하려면 HTTPS가 필요합니다: tailscale serve 또는 EASY_STUDY_TLS_CERT\/KEY/);
    assert.ok(text.includes('이 컴퓨터에서는 http://127.0.0.1:5180 에서 설치할 수 있고'), 'loopback is a secure context');
    assert.match(text, /Safari의 ‘Dock에 추가’는 HTTP에서도 됩니다/);
    // Bound to one LAN address: 127.0.0.1 is not served, so it is not offered.
    const lan = formatAccessBanner({ ...base, bindHost: '192.168.0.10', urls: ['http://192.168.0.10:5180'] });
    assert.match(lan, /HTTPS가 필요합니다/);
    assert.ok(!lan.includes('127.0.0.1'));
    // Nothing to say with HTTPS, or behind a local reverse proxy (which provides the HTTPS).
    assert.doesNotMatch(formatAccessBanner({ ...base, scheme: 'https', urls: ['https://192.168.0.10:5180'] }), /앱 설치/);
    assert.doesNotMatch(formatAccessBanner({ ...base, bindHost: '127.0.0.1', urls: ['http://127.0.0.1:5180'] }), /앱 설치/);
  });

  test('dev mode and revoked sessions are mentioned', () => {
    const text = formatAccessBanner({ ...base, dev: true, store: { ...store, sessionsRevoked: true } });
    assert.match(text, /개발 모드/);
    assert.match(text, /이전 로그인은 모두 끊었습니다/);
  });

  test('reachable addresses: non-internal IPv4 addresses plus the host name for wildcard binds', () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '192.168.0.10', family: 'IPv4', internal: false },
      ],
      utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
      bridge0: [{ address: '169.254.3.4', family: 'IPv4', internal: false }],
    } as unknown as ReturnType<typeof os.networkInterfaces>;
    assert.deepEqual(reachableUrls('http', '0.0.0.0', 5180, interfaces, 'my-mac.local'), [
      'http://192.168.0.10:5180',
      'http://100.101.102.103:5180',
      'http://my-mac.local:5180',
    ]);
    assert.deepEqual(reachableUrls('https', '192.168.0.10', 5180, interfaces, 'my-mac.local'), ['https://192.168.0.10:5180']);
    assert.deepEqual(reachableUrls('http', '127.0.0.1', 5180, interfaces, 'x'), ['http://127.0.0.1:5180']);
    assert.deepEqual(reachableUrls('http', '::1', 5180, interfaces, 'x'), ['http://[::1]:5180']);
  });
});

// ---------------------------------------------------------------------------
// HTTP: remote mode
// ---------------------------------------------------------------------------

describe('remote mode over HTTP', () => {
  let library = '';
  let server: RunningServer;
  let base = '';
  let code = '';
  const logged: string[] = [];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = consoleMethods.map((name) => console[name]);

  before(async () => {
    library = await useLibrary();
    await makeDoc(library);
    // Everything printed while the server runs is checked for the access code at the end.
    for (const name of consoleMethods) console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    server = await start({ auth: 'on', loginLimiter: new LoginLimiter({ limit: 5 }) });
    base = server.url;
    assert.ok(server.access);
    code = server.access.accessCode;
  });

  after(async () => {
    await server?.close();
    consoleMethods.forEach((name, i) => (console[name] = originals[i]));
  });

  test('the server reports remote mode', async () => {
    assert.equal(base.startsWith('http://127.0.0.1:'), true);
    assert.match(code, CODE_RE);
    assert.equal(server.access?.codeSource, 'generated');
    assert.deepEqual(server.access?.urls, [base]);
    const res = await request(base, '/api/auth/status');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { authRequired: true, authenticated: false });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('every API route answers 401 without a session (images, markdown and SSE included)', async () => {
    const d = `/api/docs/${DOC_ID}`;
    const s = `${d}/sessions/${SESSION_ID}`;
    const routes: [string, string][] = [
      ['GET', '/api/health'],
      ['GET', '/api/docs'],
      ['GET', d],
      ['GET', `${d}/slides/1.png`],
      ['GET', `${d}/view/1.webp?w=1000`],
      ['GET', `${d}/thumbs/1.webp`],
      ['GET', `${d}/sessions`],
      ['GET', s],
      ['GET', `${d}/notes`],
      ['GET', `${d}/notes.md`],
      ['GET', `${d}/digest`],
      ['GET', `${d}/digest.md`],
      ['GET', '/api/courses'],
      ['GET', `/api/courses/${COURSE_ID}/summary.md`],
      ['GET', '/api/docs/NOT_VALID'],
      ['GET', '/api/nope'],
      ['POST', '/api/docs'],
      ['POST', `${d}/retry`],
      ['POST', `${d}/sessions`],
      ['POST', `${s}/prime`],
      ['POST', `${s}/messages`],
      ['POST', `${s}/abort`],
      ['POST', `${d}/digest`],
      ['POST', `${d}/digest/abort`],
      ['POST', '/api/courses'],
      ['PATCH', `/api/courses/${COURSE_ID}`],
      ['DELETE', d],
      ['DELETE', s],
      ['DELETE', `/api/courses/${COURSE_ID}`],
    ];
    for (const [method, target] of routes) {
      const body = method === 'POST' && target === '/api/docs' ? Buffer.from('%PDF-1.4 fake') : JSON.stringify({ slide: 1, text: 'hi', provider: 'claude-code' });
      const res = await request(base, target, {
        method,
        headers: { 'Content-Type': target === '/api/docs' ? 'application/pdf' : 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : body,
      });
      assert.equal(res.status, 401, `${method} ${target}`);
      assert.equal(errorOf(res), 'login required', `${method} ${target}`);
      assert.match(String(res.headers['www-authenticate']), /^Bearer/);
      assert.doesNotMatch(String(res.headers['content-type']), /event-stream/);
    }
    // Nothing happened.
    assert.deepEqual((await fs.readdir(library)).sort(), [AUTH_FILE_NAME, SERVER_LOCK_FILE_NAME, DOC_ID].sort());
  });

  test('the web client and the manifest stay public', async () => {
    for (const target of ['/', '/index.html', '/manifest.webmanifest', '/some/client/route']) {
      const res = await request(base, target);
      assert.notEqual(res.status, 401, target);
      assert.notEqual(res.status, 403, target);
    }
  });

  test('no page can be framed by another site (clickjacking), no Referer leaves the app', async () => {
    await assertSecurityHeadersEverywhere(base);
    const cookie = cookieOf(await jsonLogin(base, code));
    for (const target of ['/api/docs', `/api/docs/${DOC_ID}/slides/1.png`, `/api/docs/${DOC_ID}/notes.md`]) {
      const res = await request(base, target, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200, target);
      assertSecurityHeaders(res, target);
    }
  });

  test('login: wrong code 401, bad body 400, right code 204 with a session cookie', async () => {
    const wrong = await jsonLogin(base, 'aaaaa-bbbbb-ccccc-ddddd');
    assert.equal(wrong.status, 401);
    assert.match(errorOf(wrong), /접속 코드가 올바르지 않습니다/);
    assert.deepEqual(setCookies(wrong), []);
    assert.equal((await jsonLogin(base, 42)).status, 400);
    assert.equal((await jsonLogin(base, '')).status, 400);
    assert.equal((await jsonLogin(base, 'x'.repeat(300))).status, 400);
    const broken = await request(base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(broken.status, 400);

    const ok = await jsonLogin(base, code.toUpperCase());
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['cache-control'], 'no-store');
    const [cookie] = setCookies(ok);
    const attributes = cookie.split(';').map((part) => part.trim());
    assert.match(attributes[0], /^es_session=[A-Za-z0-9_-]{43}$/);
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(attributes.includes(attribute), attribute);
    assert.ok(!attributes.includes('Secure'), 'plain HTTP: no Secure flag');
    assert.ok(!attributes.some((attribute) => /^domain=/i.test(attribute)), 'host-only cookie');
  });

  test('the cookie opens the API; slide images are private to the browser', async () => {
    const cookie = cookieOf(await jsonLogin(base, code));
    const status = await request(base, '/api/auth/status', { headers: { Cookie: cookie } });
    assert.deepEqual(JSON.parse(status.body), { authRequired: true, authenticated: true });
    assert.equal(cookieOf(status), cookie, 'the status check renews the cookie');

    const health = await request(base, '/api/health', { headers: { Cookie: `other=1; ${cookie}` } });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    const docs = await request(base, '/api/docs', { headers: { Cookie: cookie } });
    assert.equal(docs.status, 200);
    assert.deepEqual((JSON.parse(docs.body) as { id: string }[]).map((doc) => doc.id), [DOC_ID]);
    const slide = await request(base, `/api/docs/${DOC_ID}/slides/1.png`, { headers: { Cookie: cookie } });
    assert.equal(slide.status, 200);
    assert.equal(slide.headers['content-type'], 'image/png');
    assert.equal(slide.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(slide.headers['set-cookie'], undefined, 'no cookies on cacheable images');
    const notes = await request(base, `/api/docs/${DOC_ID}/notes.md`, { headers: { Cookie: cookie } });
    assert.equal(notes.status, 200);
    // Ids are still validated behind the login.
    assert.equal((await request(base, '/api/docs/NOT_VALID', { headers: { Cookie: cookie } })).status, 404);
    // A forged or unknown cookie is not a session.
    const forged = await request(base, '/api/docs', { headers: { Cookie: `es_session=${'A'.repeat(43)}` } });
    assert.equal(forged.status, 401);
  });

  test('scripts can send the access code as a bearer token', async () => {
    const ok = await request(base, '/api/docs', { headers: { Authorization: `Bearer ${code}` } });
    assert.equal(ok.status, 200);
    const status = await request(base, '/api/auth/status', { headers: { Authorization: `Bearer ${code}` } });
    assert.deepEqual(JSON.parse(status.body), { authRequired: true, authenticated: true });
    const wrong = await request(base, '/api/docs', { headers: { Authorization: 'Bearer nope-nope' } });
    assert.equal(wrong.status, 401);
    assert.match(errorOf(wrong), /접속 코드/);
    // Only the access code: a session id is not a bearer token, and neither is Basic.
    const cookie = cookieOf(await jsonLogin(base, code));
    assert.equal((await request(base, '/api/docs', { headers: { Authorization: `Bearer ${cookie.split('=')[1]}` } })).status, 401);
    assert.equal((await request(base, '/api/docs', { headers: { Authorization: `Basic ${Buffer.from(`x:${code}`).toString('base64')}` } })).status, 401);
  });

  test('GET /login?code= logs in and takes the code out of the address bar', async () => {
    const ok = await request(base, `/login?code=${encodeURIComponent(code)}`);
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/');
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    const cookie = cookieOf(ok);
    assert.equal((await request(base, '/api/docs', { headers: { Cookie: cookie } })).status, 200);

    const wrong = await request(base, '/login?code=wrong-code');
    assert.equal(wrong.status, 303);
    assert.equal(wrong.headers.location, '/?login=failed');
    assert.deepEqual(setCookies(wrong), []);
    const missing = await request(base, '/login');
    assert.equal(missing.status, 303);
    assert.equal(missing.headers.location, '/');
  });

  test('a new login ends the session the browser still had', async () => {
    const first = cookieOf(await jsonLogin(base, code));
    const second = cookieOf(await jsonLogin(base, code, { Cookie: first }));
    assert.notEqual(second, first);
    assert.equal((await request(base, '/api/docs', { headers: { Cookie: first } })).status, 401);
    assert.equal((await request(base, '/api/docs', { headers: { Cookie: second } })).status, 200);
  });

  test('Secure cookies behind a local HTTPS proxy (X-Forwarded-Proto from loopback)', async () => {
    const res = await jsonLogin(base, code, { 'X-Forwarded-Proto': 'https' });
    assert.equal(res.status, 204);
    assert.match(setCookies(res)[0], /; Secure$/);
  });

  test('logout revokes the session and clears the cookie', async () => {
    const cookie = cookieOf(await jsonLogin(base, code));
    const res = await request(base, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: base } });
    assert.equal(res.status, 204);
    assert.match(setCookies(res)[0], /^es_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict/);
    assert.equal((await request(base, '/api/docs', { headers: { Cookie: cookie } })).status, 401);
    const status = await request(base, '/api/auth/status', { headers: { Cookie: cookie } });
    assert.deepEqual(JSON.parse(status.body), { authRequired: true, authenticated: false });
    // Logging out without a session is fine.
    assert.equal((await request(base, '/api/auth/logout', { method: 'POST' })).status, 204);
  });

  test('failed logins are rate limited per client (429 + Retry-After), everywhere the code is checked', async () => {
    // Clients behind a local reverse proxy are told apart by the address it appends to X-Forwarded-For.
    const attacker = { 'X-Forwarded-For': '198.51.100.7' };
    for (let i = 0; i < 5; i++) assert.equal((await jsonLogin(base, `wrong-${i}`, attacker)).status, 401);
    const limited = await jsonLogin(base, code, attacker);
    assert.equal(limited.status, 429, 'even the right code waits');
    assert.match(errorOf(limited), /너무 많습니다/);
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(retryAfter > 500 && retryAfter <= 600, String(retryAfter));
    assert.deepEqual(setCookies(limited), []);
    assert.equal((await request(base, '/api/docs', { headers: { ...attacker, Authorization: `Bearer ${code}` } })).status, 429);
    const link = await request(base, `/login?code=${code}`, { headers: attacker });
    assert.equal(link.status, 303);
    assert.equal(link.headers.location, '/?login=limited');
    assert.deepEqual(setCookies(link), []);

    // Another client is not affected; its success clears only its own counter.
    const other = { 'X-Forwarded-For': '198.51.100.8' };
    for (let i = 0; i < 4; i++) await jsonLogin(base, 'wrong', other);
    assert.equal((await jsonLogin(base, code, other)).status, 204);
    for (let i = 0; i < 4; i++) assert.equal((await jsonLogin(base, 'wrong', other)).status, 401);
    // Wrong bearer tokens count as failed logins too.
    const scripted = { 'X-Forwarded-For': '198.51.100.9' };
    for (let i = 0; i < 5; i++) await request(base, '/api/docs', { headers: { ...scripted, Authorization: 'Bearer guess' } });
    assert.equal((await jsonLogin(base, code, scripted)).status, 429);
  });

  test('with the login on, any Host is accepted (DNS rebinding cannot carry the cookie)', async () => {
    const cookie = cookieOf(await jsonLogin(base, code));
    const port = new URL(base).port;
    for (const hostHeader of [`evil.example:${port}`, `my-mac.local:${port}`, `192.168.0.10:${port}`]) {
      assert.equal((await request(base, '/api/docs', { headers: { Host: hostHeader } })).status, 401, hostHeader);
      assert.equal((await request(base, '/api/docs', { headers: { Host: hostHeader, Cookie: cookie } })).status, 200, hostHeader);
    }
  });

  test('cross-site requests are refused even with a valid session (Origin check)', async () => {
    const cookie = cookieOf(await jsonLogin(base, code));
    const create = (origin: string | undefined, hostHeader?: string) =>
      request(base, '/api/courses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          ...(origin === undefined ? {} : { Origin: origin }),
          ...(hostHeader ? { Host: hostHeader } : {}),
        },
        body: JSON.stringify({ title: 'Compilers' }),
      });
    const port = new URL(base).port;
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${Number(port) + 1}`]) {
      const res = await create(origin);
      assert.equal(res.status, 403, origin);
      assert.match(errorOf(res), /다른 사이트/);
    }
    assert.equal((await create(base)).status, 201);
    assert.equal((await create(`http://my-mac.local:${port}`, `my-mac.local:${port}`)).status, 201, 'a LAN name of this server');
    assert.equal((await create(undefined)).status, 201, 'non-browser clients send no Origin');
    // A login from another site is refused too.
    const login = await jsonLogin(base, code, { Origin: 'https://evil.example' });
    assert.equal(login.status, 403);
    // Behind a local reverse proxy the public host name may arrive as X-Forwarded-Host.
    const proxied = await request(base, '/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://my-mac.tail1234.ts.net', 'X-Forwarded-Host': 'my-mac.tail1234.ts.net' },
      body: JSON.stringify({ title: 'Networks' }),
    });
    assert.equal(proxied.status, 201);
  });

  test('nothing logged the access code', () => {
    for (const line of logged) assert.ok(!line.includes(code), `logged: ${line}`);
    for (const line of logged) assert.ok(!line.includes(code.replace(/-/g, '')), `logged: ${line}`);
  });
});

describe('a flood of wrong logins from many addresses', () => {
  test('cannot lock the owner out: the right code still works, every flooding address gets a single guess', async () => {
    await useLibrary();
    const server = await start({ auth: 'on', loginLimiter: new LoginLimiter({ limit: 5, globalLimit: 6 }) });
    try {
      const base = server.url;
      const code = server.access!.accessCode;
      // Behind a local reverse proxy (requests from 127.0.0.1) clients are told apart by X-Forwarded-For.
      const from = (address: string) => ({ 'X-Forwarded-For': address });
      const before = cookieOf(await jsonLogin(base, code, from('192.0.2.1')));
      const typo = from('192.0.2.2');
      assert.equal((await jsonLogin(base, 'typo', typo)).status, 401); // the owner mistyped once

      for (let i = 0; i < 6; i++) assert.equal((await jsonLogin(base, `guess-${i}`, from(`198.51.100.${i + 10}`))).status, 401);

      // The owner, from any address that has attempts left: a login, the access code as a bearer token,
      // the one-click link, and a browser that was already logged in.
      const login = await jsonLogin(base, code, from('203.0.113.1'));
      assert.equal(login.status, 204);
      assert.equal((await request(base, '/api/docs', { headers: { Cookie: cookieOf(login) } })).status, 200);
      assert.equal((await jsonLogin(base, code, typo)).status, 204, 'one earlier typo does not lock the owner out');
      assert.equal((await request(base, '/api/docs', { headers: { ...from('203.0.113.2'), Authorization: `Bearer ${code}` } })).status, 200);
      const link = await request(base, `/login?code=${code}`, { headers: from('203.0.113.3') });
      assert.equal(link.status, 303);
      assert.equal(link.headers.location, '/');
      cookieOf(link);
      assert.equal((await request(base, '/api/docs', { headers: { Cookie: before } })).status, 200);

      // Each flooding address gets one more guess, then waits for the rest of its window (10 minutes).
      for (const attacker of [from('203.0.113.9'), from('198.51.100.10')]) {
        assert.equal((await jsonLogin(base, 'another-guess', attacker)).status, 401);
        const limited = await jsonLogin(base, code, attacker);
        assert.equal(limited.status, 429, 'locked after a single guess, even with the right code');
        const retryAfter = Number(limited.headers['retry-after']);
        assert.ok(retryAfter > 500 && retryAfter <= 600, String(retryAfter));
      }
      const scripted = from('203.0.113.10');
      assert.equal((await request(base, '/api/docs', { headers: { ...scripted, Authorization: 'Bearer guess' } })).status, 401);
      assert.equal((await request(base, '/api/docs', { headers: { ...scripted, Authorization: `Bearer ${code}` } })).status, 429);
      const linkGuess = from('203.0.113.11');
      assert.equal((await request(base, '/login?code=guess', { headers: linkGuess })).headers.location, '/?login=failed');
      assert.equal((await request(base, `/login?code=${code}`, { headers: linkGuess })).headers.location, '/?login=limited');
    } finally {
      await server.close();
    }
  });
});

describe('sessions over HTTP: expiry, restart, reset', () => {
  test('a session ends 30 days after its last use and slides while used', async () => {
    await useLibrary();
    let clock = Date.now();
    const server = await start({ auth: 'on', authClock: () => clock });
    try {
      const base = server.url;
      const cookie = cookieOf(await jsonLogin(base, server.access!.accessCode));
      clock += 20 * DAY;
      assert.equal((await request(base, '/api/docs', { headers: { Cookie: cookie } })).status, 200);
      clock += 20 * DAY; // 40 days after the login
      assert.equal((await request(base, '/api/docs', { headers: { Cookie: cookie } })).status, 200);
      clock += 30 * DAY + 1000;
      assert.equal((await request(base, '/api/docs', { headers: { Cookie: cookie } })).status, 401);
    } finally {
      await server.close();
    }
  });

  test('the code and the sessions survive a restart; --reset-access-code ends them', async () => {
    const library = await useLibrary();
    let server = await start({ auth: 'on' });
    try {
      const code = server.access!.accessCode;
      assert.equal(server.access!.codeIsNew, true);
      const cookie = cookieOf(await jsonLogin(server.url, code));
      await server.close();

      server = await start({ auth: 'on' });
      assert.equal(server.access!.accessCode, code);
      assert.equal(server.access!.codeIsNew, false);
      assert.equal((await request(server.url, '/api/docs', { headers: { Cookie: cookie } })).status, 200);
      if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(library, AUTH_FILE_NAME))).mode & 0o777, 0o600);
      await server.close();

      server = await start({ auth: 'on', resetAccessCode: true });
      assert.notEqual(server.access!.accessCode, code);
      assert.equal(server.access!.codeIsNew, true);
      assert.equal(server.access!.sessionsRevoked, true);
      assert.equal((await request(server.url, '/api/docs', { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await jsonLogin(server.url, code)).status, 401);
      await server.close();

      // Changing the password ends the sessions too.
      server = await start({ auth: 'on', password: 'a long enough password' });
      assert.equal(server.access!.codeSource, 'password');
      const passwordCookie = cookieOf(await jsonLogin(server.url, 'a long enough password'));
      await server.close();
      server = await start({ auth: 'on', password: 'a different password' });
      assert.equal(server.access!.sessionsRevoked, true);
      assert.equal((await request(server.url, '/api/docs', { headers: { Cookie: passwordCookie } })).status, 401);
    } finally {
      await server.close();
    }
  });

  test('a library locked by another server: .auth.json is not touched, not even by --reset-access-code', async () => {
    const library = await useLibrary();
    const first = await start({ auth: 'on' });
    await first.close();
    const file = path.join(library, AUTH_FILE_NAME);
    const before = await fs.readFile(file, 'utf8');
    // A live process of someone else (our parent) holds the lock.
    await fs.writeFile(path.join(library, SERVER_LOCK_FILE_NAME), JSON.stringify({ pid: process.ppid, port: 5180, startedAt: new Date().toISOString() }));
    try {
      await assert.rejects(start({ auth: 'on', resetAccessCode: true }), LibraryLockedError);
      await assert.rejects(start({ resetAccessCode: true }), LibraryLockedError);
      assert.equal(await fs.readFile(file, 'utf8'), before);
    } finally {
      await fs.rm(path.join(library, SERVER_LOCK_FILE_NAME), { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP: local mode, refusals, TLS, command line
// ---------------------------------------------------------------------------

describe('local mode (default)', () => {
  let library = '';
  let server: RunningServer;

  before(async () => {
    library = await useLibrary();
    await makeDoc(library);
    server = await start();
  });

  after(async () => {
    await server?.close();
  });

  test('no login, loopback Host names only, no .auth.json', async () => {
    const base = server.url;
    assert.equal(server.access, null);
    const status = await request(base, '/api/auth/status');
    assert.deepEqual(JSON.parse(status.body), { authRequired: false, authenticated: true });
    const docs = await request(base, '/api/docs');
    assert.equal(docs.status, 200);
    const slide = await request(base, `/api/docs/${DOC_ID}/slides/1.png`);
    assert.equal(slide.headers['cache-control'], 'public, max-age=31536000, immutable');
    // DNS rebinding: refused without a login — auth routes included (the web client shows "local only").
    const port = new URL(base).port;
    for (const target of ['/api/docs', '/api/auth/status']) {
      const res = await request(base, target, { headers: { Host: `evil.example:${port}` } });
      assert.equal(res.status, 403, target);
    }
    assert.equal((await request(base, '/api/docs', { headers: { Host: `localhost:${port}` } })).status, 200);
    // Login routes do nothing.
    const login = await jsonLogin(base, 'whatever');
    assert.equal(login.status, 204);
    assert.deepEqual(setCookies(login), []);
    const link = await request(base, '/login?code=whatever');
    assert.equal(link.status, 303);
    assert.equal(link.headers.location, '/');
    // CSRF check as before.
    const csrf = await request(base, '/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{"title":"x"}',
    });
    assert.equal(csrf.status, 403);
    await assert.rejects(fs.access(path.join(library, AUTH_FILE_NAME)));
  });

  test('X-Forwarded-Host is not trusted without the login (no reverse proxy in local mode)', async () => {
    const base = server.url;
    const create = (headers: Record<string, string>) =>
      request(base, '/api/courses', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"title":"x"}' });
    for (const origin of ['http://evil.example', `http://evil.example:${new URL(base).port}`]) {
      const res = await create({ Origin: origin, 'X-Forwarded-Host': new URL(origin).host });
      assert.equal(res.status, 403, origin);
      assert.match(errorOf(res), /다른 사이트/);
    }
    assert.equal((await create({ Origin: base })).status, 201, 'the app itself');
    assert.deepEqual(
      (JSON.parse((await request(base, '/api/courses')).body) as { title: string }[]).map((course) => course.title),
      ['x'],
      'only the same-origin request created a course',
    );
  });

  test('no page can be framed by another site (clickjacking), no Referer leaves the app', async () => {
    await assertSecurityHeadersEverywhere(server.url);
    const slide = await request(server.url, `/api/docs/${DOC_ID}/slides/1.png`);
    assert.equal(slide.status, 200);
    assertSecurityHeaders(slide, 'slide image');
  });

  test('--reset-access-code in local mode removes the stored code for the next remote start', async () => {
    const other = await useLibrary();
    const remote = await start({ auth: 'on' });
    const code = remote.access!.accessCode;
    await remote.close();
    const local = await start({ resetAccessCode: true });
    await local.close();
    await assert.rejects(fs.access(path.join(other, AUTH_FILE_NAME)));
    const again = await start({ auth: 'on' });
    try {
      assert.notEqual(again.access!.accessCode, code);
    } finally {
      await again.close();
    }
  });
});

describe('startup refusals', () => {
  test('EASY_STUDY_AUTH=off on 0.0.0.0 never starts (nothing is bound, the library is not touched)', async () => {
    const library = await useLibrary();
    await assert.rejects(start({ host: '0.0.0.0', auth: 'off' }), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /EASY_STUDY_AUTH=off/);
      return true;
    });
    assert.deepEqual(await fs.readdir(library), []);
  });

  test('the environment is read too', async () => {
    const library = await useLibrary();
    const saved = { host: process.env.EASY_STUDY_HOST, auth: process.env.EASY_STUDY_AUTH };
    process.env.EASY_STUDY_HOST = '0.0.0.0';
    process.env.EASY_STUDY_AUTH = 'off';
    try {
      await assert.rejects(start(), ConfigError);
    } finally {
      if (saved.host === undefined) delete process.env.EASY_STUDY_HOST;
      else process.env.EASY_STUDY_HOST = saved.host;
      if (saved.auth === undefined) delete process.env.EASY_STUDY_AUTH;
      else process.env.EASY_STUDY_AUTH = saved.auth;
    }
    assert.deepEqual(await fs.readdir(library), []);
  });

  test('bad passwords and TLS files are refused before the library is touched', async () => {
    const library = await useLibrary();
    await assert.rejects(start({ auth: 'on', password: 'short' }), ConfigError);
    const missing = path.join(tmpRoot, 'missing.pem');
    await assert.rejects(start({ auth: 'on', tls: { certFile: missing, keyFile: missing } }), /EASY_STUDY_TLS_CERT/);
    const garbage = path.join(tmpRoot, 'garbage.pem');
    await fs.writeFile(garbage, 'not a certificate');
    await assert.rejects(start({ auth: 'on', tls: { certFile: garbage, keyFile: garbage } }), ConfigError);
    assert.deepEqual(await fs.readdir(library), []);
  });
});

const openssl = await run('openssl', ['version']).then(
  () => true,
  () => false,
);

describe('HTTPS (EASY_STUDY_TLS_CERT / KEY)', () => {
  test('serves HTTPS and marks the session cookie Secure', { skip: openssl ? false : 'openssl is not installed' }, async (t) => {
    await useLibrary();
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'tls-'));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    try {
      await run('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ]);
    } catch (err) {
      t.skip(`openssl could not make a self-signed certificate: ${(err as Error).message}`);
      return;
    }
    const ca = await fs.readFile(certFile);
    const server = await start({ auth: 'on', tls: { certFile, keyFile } });
    try {
      assert.match(server.url, /^https:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(server.access?.scheme, 'https');
      const status = await request(server.url, '/api/auth/status', { ca });
      assert.deepEqual(JSON.parse(status.body), { authRequired: true, authenticated: false });
      const login = await jsonLogin(server.url, server.access!.accessCode, {}, ca);
      assert.equal(login.status, 204);
      assert.match(setCookies(login)[0], /; Secure$/);
      const docs = await request(server.url, '/api/docs', { headers: { Cookie: cookieOf(login) }, ca });
      assert.equal(docs.status, 200);
      const link = await request(server.url, `/login?code=${server.access!.accessCode}`, { ca });
      assert.match(setCookies(link)[0], /; Secure$/);
      // Plain HTTP on the TLS port gets nowhere.
      const { port } = server.server.address() as AddressInfo;
      await assert.rejects(request(`http://127.0.0.1:${port}`, '/api/auth/status'));
    } finally {
      await server.close();
    }
  });
});

describe('dev server guard (npm run dev in remote mode)', () => {
  const repo = path.resolve('/repo');
  const options = {
    allowRoots: [path.join(repo, 'web'), path.join(repo, 'shared'), path.join(repo, 'node_modules')],
    denyRoots: [path.join(repo, 'library')],
    denyNames: [AUTH_FILE_NAME, SERVER_LOCK_FILE_NAME],
  };
  const fsUrl = (file: string) => `/@fs${file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`;

  test('the client sources are served; the library, auth files and other paths are not', () => {
    for (const url of [
      '/',
      '/src/main.tsx',
      '/@vite/client',
      '/@id/react',
      fsUrl(path.join(repo, 'web', 'src', 'main.tsx')),
      `${fsUrl(path.join(repo, 'node_modules', 'katex', 'dist', 'katex.min.css'))}?direct`,
      fsUrl(path.join(repo, 'shared', 'types.ts')),
    ]) {
      assert.equal(devRequestBlockReason(url, options), null, url);
    }
    const library = fsUrl(path.join(repo, 'library'));
    for (const url of [
      `${library}/deck/source.pdf`,
      `${library}/.auth.json`,
      library.replace('library', '%6cibrary') + '/x.json',
      library.replace('library', '%256cibrary') + '/x.json',
      library.replace('library', 'LIBRARY') + '/x.json',
      `${fsUrl(path.join(repo, 'web'))}/../library/x`,
      `${fsUrl(path.join(repo, 'web'))}/%2e%2e/%2e%2e/etc/passwd`,
      fsUrl(path.join(repo, 'package.json')),
      fsUrl(path.resolve('/etc/passwd')),
      `/@id/${path.join(repo, 'library', 'x.json')}`,
      `/@id/__x00__${path.resolve('/etc/passwd')}`,
      '/.auth.json',
      '/src/.server.lock',
      '/%E0%A4%A',
    ]) {
      assert.notEqual(devRequestBlockReason(url, options), null, url);
    }
  });

  test('in front of Vite: blocked paths get 403, "open in editor" needs a login', async () => {
    const library = await useLibrary();
    const store = await AuthStore.open();
    const gate = createAuthGate(store);
    const app = express();
    app.use(devServerGuard({ ...options, denyRoots: [library] }, gate));
    app.use((_req, res) => void res.send('served'));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const cookie = `es_session=${await store.createSession()}`;
      assert.equal((await request(base, '/src/main.tsx')).body, 'served');
      assert.equal((await request(base, `${fsUrl(library)}/${AUTH_FILE_NAME}`, { headers: { Cookie: cookie } })).status, 403);
      assert.equal((await request(base, '/__open-in-editor?file=src/App.tsx')).status, 403);
      assert.equal((await request(base, '/__open-in-editor?file=src/App.tsx', { headers: { Cookie: cookie } })).body, 'served');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('command line', () => {
  /** Runs `node server/index.ts <args>` until `until` matches its output (or it exits). */
  async function runServerProcess(args: string[], env: Record<string, string>, until: RegExp) {
    const library = await useLibrary();
    const child = spawn(process.execPath, [path.join(repoRoot(), 'server', 'index.ts'), ...args], {
      cwd: os.tmpdir(),
      env: { ...process.env, EASY_STUDY_LIBRARY: library, PORT: '0', EASY_STUDY_AUTO_DIGEST: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const deadline = Date.now() + 20_000;
    while (!until.test(stdout + stderr) && child.exitCode === null) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        assert.fail(`no match for ${until}:\n${stdout}\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { child, library, exited, output: () => ({ stdout, stderr }) };
  }

  test('--remote prints the addresses, the access code and a login link', async () => {
    // EASY_STUDY_HOST=127.0.0.1 keeps the test off the network; --remote still turns the login on.
    const { child, library, exited, output } = await runServerProcess(
      ['--remote', '--reset-access-code'],
      { EASY_STUDY_AUTH: '', EASY_STUDY_HOST: '127.0.0.1' },
      /library {5}→/,
    );
    try {
      const { stdout } = output();
      const base = /→\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
      assert.ok(base, stdout);
      const stored = JSON.parse(await fs.readFile(path.join(library, AUTH_FILE_NAME), 'utf8')) as { code: string };
      assert.ok(stdout.includes(`접속 코드   →  ${stored.code}`), stdout);
      assert.ok(stdout.includes(`${base}/login?code=${stored.code}`), stdout);
      assert.match(stdout, /tailscale serve/);
      assert.match(stdout, /npm run serve:remote -- --reset-access-code/);
      const status = await request(base, '/api/auth/status');
      assert.deepEqual(JSON.parse(status.body), { authRequired: true, authenticated: false });
      const link = await request(base, `/login?code=${stored.code}`);
      assert.equal(link.status, 303);
      // The one-click link was not logged by the request.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(output().stdout.split(stored.code).length - 1, 2, 'the code appears only in the banner');
      assert.equal(output().stderr.includes(stored.code), false);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  });

  test('an unsafe combination exits with a clear message', async () => {
    const { exited, library, output } = await runServerProcess([], { EASY_STUDY_HOST: '0.0.0.0', EASY_STUDY_AUTH: 'off' }, /설정 오류/);
    assert.equal(await exited, 1);
    assert.match(output().stderr, /EASY_STUDY_AUTH=off/);
    assert.deepEqual(await fs.readdir(library), []);
  });
});
