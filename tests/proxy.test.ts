// The desktop app's loopback proxy for plain-http remotes (DESIGN §16/§19, server/proxy.ts). The remote is an
// in-process server in remote mode (auth on, a fixed password) with the fake CLIs and tools of tests/fixtures; the
// proxy runs as a real process (node server/proxy.ts --to <remote>), the way the shell starts it: PORT=0, stdin,
// stdout and stderr piped. No real CLI, model or microphone is ever involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { DocMeta, RecordingInfo } from '../shared/types.ts';
import { VIEW_WIDTHS, inlinePathFor, thumbPath, viewPath } from '../server/assets.ts';
import { runningTurnCount } from '../server/chat.ts';
import { repoRoot } from '../server/config.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import type { StoredDocMeta } from '../server/library.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE, slideFileName, textFileName } from '../server/pageNames.ts';
import { SESSION_COOKIE } from '../server/auth.ts';
import { downstreamHeaders, downstreamSetCookie, isPrivateAddress, parseTarget, proxyPort, scopedSessionCookieName, upstreamCookie, upstreamHeaders } from '../server/proxy.ts';
import { READY_PREFIX } from '../server/shellWatch.ts';
import { pagesPdf } from './pdfFixtures.ts';

const POSIX = process.platform !== 'win32';
const PROXY_ENTRY = path.join(repoRoot(), 'server', 'proxy.ts');
const FIXTURES = path.join(repoRoot(), 'tests', 'fixtures');
const PASSWORD = 'proxy-test-pass';
const DOC_ID = 'deck';
const PAGES = 3;
/** The fake CLI is a .mjs script: Windows cannot spawn it without a shell. */
const POSIX_ONLY = { skip: POSIX ? false : 'the fake CLI script is POSIX only' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('proxy helpers', () => {
  test('parseTarget: an http origin only', () => {
    assert.deepEqual(parseTarget('http://192.168.0.10:5180'), { origin: 'http://192.168.0.10:5180', host: '192.168.0.10:5180', hostname: '192.168.0.10', port: 5180 });
    assert.deepEqual(parseTarget('http://study-pc.local:5180/'), { origin: 'http://study-pc.local:5180', host: 'study-pc.local:5180', hostname: 'study-pc.local', port: 5180 });
    assert.deepEqual(parseTarget('http://[fd00::1]:5180'), { origin: 'http://[fd00::1]:5180', host: '[fd00::1]:5180', hostname: 'fd00::1', port: 5180 });
    assert.equal(parseTarget('http://10.0.0.2').port, 80);
    for (const bad of ['https://x:5180', 'http://x:5180/p', 'http://x:5180/?a=1', 'http://x:5180/#f', 'http://u:p@x:5180', 'ftp://x', 'x:5180', '', 'http://']) {
      assert.throws(() => parseTarget(bad), /중계할 주소가 올바르지 않습니다/, bad);
    }
  });

  test('isPrivateAddress: this computer and private networks only (the shell’s rules)', () => {
    for (const ok of ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.1.1', '100.64.0.1', '100.127.255.255', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.10']) {
      assert.equal(isPrivateAddress(ok), true, ok);
    }
    for (const no of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'example.com', '']) {
      assert.equal(isPrivateAddress(no), false, no);
    }
  });

  test('upstreamHeaders: Host/Origin/Referer rewritten, hop-by-hop and X-Forwarded-* dropped, the rest untouched', () => {
    const target = { origin: 'http://192.168.0.10:5180', host: '192.168.0.10:5180' };
    const headers = upstreamHeaders(
      {
        host: '127.0.0.1:5379',
        origin: 'http://127.0.0.1:5379',
        referer: 'http://127.0.0.1:5379/docs/deck/slide/2',
        cookie: `${scopedSessionCookieName(target.origin)}=abc`,
        authorization: 'Bearer x',
        'content-length': '12',
        'content-type': 'audio/wav',
        'x-filename': 'a%20b.wav',
        range: 'bytes=0-1',
        'last-event-id': '7',
        connection: 'keep-alive, X-Custom',
        'x-custom': 'hop',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        te: 'trailers',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
        forwarded: 'for=1.2.3.4',
      },
      'http://127.0.0.1:5379',
      target,
    );
    assert.deepEqual(headers, {
      host: '192.168.0.10:5180',
      origin: 'http://192.168.0.10:5180',
      referer: 'http://192.168.0.10:5180/docs/deck/slide/2',
      cookie: 'es_session=abc',
      authorization: 'Bearer x',
      'content-length': '12',
      'content-type': 'audio/wav',
      'x-filename': 'a%20b.wav',
      range: 'bytes=0-1',
      'last-event-id': '7',
    });
    // Another site's Origin passes as it is (the remote refuses it); a foreign Referer is dropped.
    const foreign = upstreamHeaders({ host: '127.0.0.1:5379', origin: 'https://evil.example', referer: 'https://evil.example/' }, 'http://127.0.0.1:5379', target);
    assert.equal(foreign.origin, 'https://evil.example');
    assert.equal('referer' in foreign, false);
    assert.equal(upstreamHeaders({ host: 'x' }, 'http://127.0.0.1:5379', target).origin, undefined);
  });

  test('the session cookie is scoped per remote: only this remote’s goes back, the shell’s own server’s and other remotes’ never', () => {
    const a = 'http://192.168.0.10:5180';
    const b = 'http://192.168.0.11:5180';
    const [nameA, nameB] = [scopedSessionCookieName(a), scopedSessionCookieName(b)];
    assert.match(nameA, /^es_session_[0-9a-f]{12}$/);
    assert.notEqual(nameA, nameB);
    assert.equal(scopedSessionCookieName(a), nameA, 'stable: the WebView keeps the cookie across app sessions');
    assert.equal(SESSION_COOKIE, 'es_session', 'the proxy’s copy of the server’s cookie name');
    // The WebView's one jar for 127.0.0.1: the shell's shared server's login, remote A's, remote B's, and something else.
    const jar = `es_session=LOCAL; ${nameA}=TOKEN_A; ${nameB}=TOKEN_B; es_session_000000000000=OLD; theme=dark`;
    assert.equal(upstreamCookie(jar, a), 'es_session=TOKEN_A; theme=dark');
    assert.equal(upstreamCookie(jar, b), 'es_session=TOKEN_B; theme=dark');
    assert.equal(upstreamCookie('es_session=LOCAL', a), undefined, 'the shell’s own server’s login never reaches a remote');
    assert.equal(upstreamCookie(`${nameB}=TOKEN_B`, a), undefined, 'another remote’s never does either');
    assert.equal(upstreamCookie(undefined, a), undefined);
    assert.equal(upstreamCookie(' ; ;', a), undefined);
    assert.equal(upstreamCookie(`${nameA}`, a), 'es_session=', 'a nameless value stays a cookie of that name');
    const sent = upstreamHeaders({ host: '127.0.0.1:5379', cookie: 'es_session=LOCAL; x=1' }, 'http://127.0.0.1:5379', { origin: a, host: '192.168.0.10:5180' });
    assert.equal(sent.cookie, 'x=1');
    assert.equal('cookie' in upstreamHeaders({ host: '127.0.0.1:5379', cookie: 'es_session=LOCAL' }, 'http://127.0.0.1:5379', { origin: a, host: '192.168.0.10:5180' }), false);
    // What the remote sets is stored under the scoped name: a login, the sliding refresh, the cleared cookie of a logout.
    assert.deepEqual(downstreamSetCookie('es_session=abc; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict', a), [`${nameA}=abc; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`]);
    assert.deepEqual(downstreamSetCookie(['es_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict', 'other=1; Path=/'], a), [`${nameA}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`, 'other=1; Path=/']);
    assert.deepEqual(downstreamSetCookie('es_sessionx=1', a), ['es_sessionx=1'], 'only the exact name');
    assert.equal(downstreamSetCookie(undefined, a), undefined);
  });

  test('downstreamHeaders: Set-Cookie under the scoped name, Location on the remote origin rewritten, hop-by-hop dropped', () => {
    const headers = downstreamHeaders(
      {
        'set-cookie': ['es_session=abc; Path=/; HttpOnly; SameSite=Strict'],
        location: 'http://192.168.0.10:5180/?login=failed',
        'content-type': 'text/html',
        connection: 'close',
        'transfer-encoding': 'chunked',
        'keep-alive': 'timeout=5',
      },
      'http://127.0.0.1:5379',
      'http://192.168.0.10:5180',
    );
    assert.deepEqual(headers, {
      'set-cookie': [`${scopedSessionCookieName('http://192.168.0.10:5180')}=abc; Path=/; HttpOnly; SameSite=Strict`],
      location: 'http://127.0.0.1:5379/?login=failed',
      'content-type': 'text/html',
    });
    assert.equal(downstreamHeaders({ location: '/' }, 'http://127.0.0.1:5379', 'http://192.168.0.10:5180').location, '/');
    assert.equal(downstreamHeaders({ location: 'https://example.com/x' }, 'http://127.0.0.1:5379', 'http://192.168.0.10:5180').location, 'https://example.com/x');
  });

  test('proxyPort: unset = any, otherwise 0-65535', () => {
    assert.equal(proxyPort({}), 0);
    assert.equal(proxyPort({ PORT: ' ' }), 0);
    assert.equal(proxyPort({ PORT: '5379' }), 5379);
    for (const bad of ['abc', '-1', '65536']) assert.throws(() => proxyPort({ PORT: bad }), /PORT/, bad);
  });
});

// ---------------------------------------------------------------------------
// A remote server, a proxy process, a document
// ---------------------------------------------------------------------------

// A 1x1 PNG and a stand-in for the pre-encoded inline JPEGs (the fake CLI never decodes them).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** A ready document with every derived file, so that a chat turn starts no image worker. */
async function writeReadyDoc(library: string): Promise<void> {
  const dir = path.join(library, DOC_ID);
  for (const sub of ['text', 'sheets', 'slides', 'view', 'thumbs', 'inline']) await fs.mkdir(path.join(dir, sub), { recursive: true });
  const meta: StoredDocMeta = {
    id: DOC_ID,
    title: 'Deck',
    fileName: 'Deck.pdf',
    pageCount: PAGES,
    aspectRatio: 16 / 9,
    status: 'ready' satisfies DocMeta['status'],
    progress: PAGES,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, 'doc.json'), JSON.stringify(meta));
  for (let n = 1; n <= PAGES; n++) {
    const slide = slideFileName(n, PAGES);
    await fs.writeFile(path.join(dir, 'text', textFileName(n, PAGES)), `Slide ${n} text`);
    await fs.writeFile(path.join(dir, 'slides', slide), PNG);
    for (const width of VIEW_WIDTHS) await fs.writeFile(viewPath(dir, slide, width), 'webp');
    await fs.writeFile(thumbPath(dir, slide), 'webp');
  }
  await fs.writeFile(path.join(dir, 'text', TEXT_ENGINE_FILE), TEXT_ENGINE);
  await fs.writeFile(path.join(dir, 'sheets', 'sheet-01.png'), PNG);
  await fs.writeFile(path.join(dir, 'sheets', 'sheets.json'), JSON.stringify([{ file: 'sheet-01.png', fromSlide: 1, toSlide: PAGES }]));
  for (let n = 1; n <= PAGES; n++) await fs.writeFile(inlinePathFor(path.join(dir, 'slides', slideFileName(n, PAGES)))!, JPEG);
  await fs.writeFile(inlinePathFor(path.join(dir, 'sheets', 'sheet-01.png'))!, JPEG);
}

function riffHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

interface ProxyProcess {
  child: ChildProcess;
  origin: string;
  port: number;
  stdout(): string;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const processes: ChildProcess[] = [];

/** Starts `node server/proxy.ts --to <target>` like the shell does (PORT=0, piped stdio) and returns it, ready or not. */
function spawnProxy(args: string[], env: Record<string, string> = {}): Omit<ProxyProcess, 'origin' | 'port'> {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^EASY_STUDY_/.test(key) && key !== 'PORT') clean[key] = value;
  const child = spawn(process.execPath, [PROXY_ENTRY, ...args], { cwd: os.tmpdir(), env: { ...clean, PORT: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  processes.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

const READY_RE = /^EASY_STUDY_READY (.*)$/m;

async function startProxy(target: string): Promise<ProxyProcess> {
  const proxy = spawnProxy(['--to', target]);
  await waitFor('the proxy ready line', () => {
    if (proxy.child.exitCode !== null) assert.fail(`the proxy exited:\n${proxy.stdout()}\n${proxy.stderr()}`);
    return READY_RE.test(proxy.stdout());
  });
  const ready = JSON.parse(READY_RE.exec(proxy.stdout())![1]) as { url: string; port: number };
  return { ...proxy, origin: ready.url, port: ready.port };
}

async function exitWithin(p: { exited: ProxyProcess['exited']; stdout(): string; stderr(): string }, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), ms)));
  const result = await Promise.race([p.exited, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') assert.fail(`the proxy did not exit within ${ms} ms:\n${p.stdout()}\n${p.stderr()}`);
  return result;
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request with full control over the headers (fetch rewrites Host and Origin). */
function raw(origin: string, target: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<RawResponse> {
  const url = new URL(target, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Streams a WAV upload of `total` bytes (1 MiB pieces, with backpressure) and returns the answer whenever it comes. */
function rawUpload(origin: string, target: string, total: number, headers: Record<string, string>): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(target, origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'audio/wav', ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    let answered = false;
    req.on('response', () => (answered = true));
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    const piece = Buffer.alloc(1024 * 1024, 1);
    let sent = 0;
    const header = riffHeader(total - 44);
    const write = () => {
      while (sent < total) {
        let chunk = piece.subarray(0, Math.min(piece.length, total - sent));
        if (sent === 0) chunk = Buffer.concat([header, chunk.subarray(44)]);
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', write);
          return;
        }
      }
      req.end();
    };
    req.on('socket', () => write());
  });
}

/** Reads an SSE stream through `fetch`, resolving the first frame and a way to abort. */
async function openStream(url: string, init: RequestInit): Promise<{ status: number; first: Promise<string>; abort: () => void; ended: Promise<void> }> {
  const controller = new AbortController();
  const res = await fetch(url, { ...init, signal: controller.signal });
  let resolveFirst!: (frame: string) => void;
  const first = new Promise<string>((resolve) => (resolveFirst = resolve));
  const ended = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let seen = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (!seen && buffer.includes('\n\n')) {
        seen = true;
        resolveFirst(buffer.slice(0, buffer.indexOf('\n\n')));
      }
    }
  })().catch(() => {});
  return { status: res.status, first, abort: () => controller.abort(), ended };
}

// ---------------------------------------------------------------------------

describe('the loopback proxy in front of a remote-mode server', () => {
  let tmp = '';
  let remote: RunningServer;
  let proxy: ProxyProcess;
  let cookie = '';
  const savedEnv = { ...process.env };

  before(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-proxy-')));
    const library = path.join(tmp, 'library');
    await fs.mkdir(library, { recursive: true });
    await fs.mkdir(path.join(tmp, 'models'), { recursive: true });
    await writeReadyDoc(library);
    process.env.EASY_STUDY_LIBRARY = library;
    process.env.EASY_STUDY_AUTO_DIGEST = '0';
    process.env.EASY_STUDY_MODELS_DIR = path.join(tmp, 'models');
    process.env.EASY_STUDY_WHISPER = path.join(FIXTURES, 'fake-whisper.mjs');
    process.env.EASY_STUDY_FFMPEG = path.join(FIXTURES, 'fake-ffmpeg.mjs');
    process.env.CLAUDE_BIN = path.join(FIXTURES, 'fake-claude.mjs');
    process.env.CODEX_BIN = path.join(FIXTURES, 'fake-codex.mjs');
    process.env.CODEX_HOME = path.join(tmp, 'no-codex-home');
    process.env.FAKE_CLI_MODE = 'hang'; // a turn's first event arrives, then nothing until it is aborted
    delete process.env.EASY_STUDY_HOST;
    delete process.env.EASY_STUDY_AUTH;
    delete process.env.EASY_STUDY_PASSWORD;
    remote = await startServer({
      port: 0,
      host: '127.0.0.1',
      auth: 'on',
      password: PASSWORD,
      tls: null,
      log: false,
      resumeIngests: false,
      sweepAttachments: false,
      desktop: true,
      recordings: { maxUploadBytes: 256 * 1024 },
    });
    proxy = await startProxy(remote.url);
  });

  after(async () => {
    for (const child of processes.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await remote?.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    // The proxy never logs a request: the login link carries the code, Cookie headers the session.
    assert.doesNotMatch(proxy.stdout() + proxy.stderr(), /login\?code|es_session|proxy-test-pass|\/api\//);
  });

  test('ready line: the same shape as the server’s, on 127.0.0.1', () => {
    const line = proxy.stdout().split(/\r?\n/).find((l) => l.startsWith(READY_PREFIX));
    assert.match(line!, /^EASY_STUDY_READY \{"url":"http:\/\/127\.0\.0\.1:(\d+)","port":\1\}$/);
    assert.equal(proxy.origin, `http://127.0.0.1:${proxy.port}`);
    assert.notEqual(proxy.origin, remote.url);
    assert.match(proxy.stdout(), new RegExp(`\\[proxy\\] ${proxy.origin.replace(/[.]/g, '\\.')} → ${remote.url.replace(/[.]/g, '\\.')}`));
  });

  test('GET / answers as the remote does; a foreign Host is 421; a bad request target is 400', async () => {
    const direct = await fetch(`${remote.url}/`);
    const relayed = await fetch(`${proxy.origin}/`);
    assert.equal(relayed.status, direct.status);
    assert.equal(relayed.headers.get('content-type'), direct.headers.get('content-type'));
    assert.equal(await relayed.text(), await direct.text());
    // The remote's security headers pass through untouched.
    assert.equal(relayed.headers.get('x-frame-options'), 'DENY');
    assert.equal(relayed.headers.get('referrer-policy'), 'no-referrer');

    const rebinding = await raw(proxy.origin, '/api/auth/status', { headers: { host: 'evil.example' } });
    assert.equal(rebinding.status, 421);
    assert.match(rebinding.body, /이 주소로는 열 수 없습니다/);
    const otherPort = await raw(proxy.origin, '/api/auth/status', { headers: { host: `127.0.0.1:${proxy.port + 1}` } });
    assert.equal(otherPort.status, 421);

    const absolute = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1', () => {
        socket.write(`GET http://evil.example/api/auth/status HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (c: Buffer) => (data += c.toString()));
      socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
      socket.on('error', reject);
    });
    assert.equal(absolute, 400);
  });

  test('login through the proxy: the cookie is set for 127.0.0.1 under the remote’s scoped name, without Secure even with a spoofed X-Forwarded-Proto', async () => {
    const login = await raw(proxy.origin, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: proxy.origin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.5' },
      body: JSON.stringify({ code: PASSWORD }),
    });
    assert.equal(login.status, 204, login.body);
    const setCookie = login.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1, JSON.stringify(setCookie));
    const scoped = scopedSessionCookieName(remote.url);
    assert.match(setCookie[0], new RegExp(`^${scoped}=[A-Za-z0-9_-]+; Max-Age=\\d+; Path=/; HttpOnly; SameSite=Strict$`));
    assert.doesNotMatch(setCookie[0], /Secure|Domain/);
    cookie = setCookie[0].split(';')[0];

    // Cookie round trip: the page at the proxy origin is logged in.
    const status = await fetch(`${proxy.origin}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.deepEqual(await status.json(), { authRequired: true, authenticated: true });
    const anonymous = await fetch(`${proxy.origin}/api/auth/status`);
    assert.deepEqual(await anonymous.json(), { authRequired: true, authenticated: false });
    // The same token under any other name — the shell's own shared server's `es_session`, another remote's scoped
    // cookie — is dropped by the relay: the remote never sees it (nor could it replay it against that server).
    const token = cookie.split('=')[1];
    for (const foreign of [`es_session=${token}`, `es_session_000000000000=${token}`, `es_session=${token}; es_session_000000000000=${token}`]) {
      const leaked = await fetch(`${proxy.origin}/api/auth/status`, { headers: { Cookie: foreign } });
      assert.deepEqual(await leaked.json(), { authRequired: true, authenticated: false }, foreign);
    }
    const mixed = await fetch(`${proxy.origin}/api/auth/status`, { headers: { Cookie: `es_session=${token}; ${cookie}; es_session_000000000000=x` } });
    assert.deepEqual(await mixed.json(), { authRequired: true, authenticated: true });
    // A logout clears the scoped cookie (the WebView drops it; the shell's own server's login stays untouched).
    const logout = await raw(proxy.origin, '/api/auth/logout', { method: 'POST', headers: { Origin: proxy.origin, Cookie: cookie } });
    assert.equal(logout.status, 204);
    assert.match(String(logout.headers['set-cookie']), new RegExp(`^${scoped}=; Max-Age=0; `));
    const again = await raw(proxy.origin, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: proxy.origin }, body: JSON.stringify({ code: PASSWORD }) });
    assert.equal(again.status, 204, again.body);
    cookie = String(again.headers['set-cookie']).split(';')[0];
    assert.ok(cookie.startsWith(`${scoped}=`));
    // The access code as a bearer token passes through too.
    const bearer = await fetch(`${proxy.origin}/api/health`, { headers: { Authorization: `Bearer ${PASSWORD}` } });
    assert.equal(bearer.status, 200);
    await bearer.arrayBuffer();
    const nothing = await fetch(`${proxy.origin}/api/health`);
    assert.equal(nothing.status, 401);
    await nothing.arrayBuffer();
  });

  test('CSRF: another site’s Origin reaches the remote unchanged and is refused', async () => {
    const evil = await raw(proxy.origin, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookie },
      body: JSON.stringify({ code: PASSWORD }),
    });
    assert.equal(evil.status, 403);
    assert.match(evil.body, /다른 사이트에서 보낸 요청/);
  });

  test('GET /login?code= logs in with a relative redirect (303 Location: /)', async () => {
    const res = await fetch(`${proxy.origin}/login?code=${encodeURIComponent(PASSWORD)}`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`^${scopedSessionCookieName(remote.url)}=`));
    await res.arrayBuffer();
    const failed = await fetch(`${proxy.origin}/login?code=wrong-code-xx`, { redirect: 'manual' });
    assert.equal(failed.status, 303);
    assert.equal(failed.headers.get('location'), '/?login=failed');
    await failed.arrayBuffer();
  });

  test('a PDF upload of ~300 KB with Content-Length is converted; the slides come back through the proxy', async () => {
    const fill = Array.from({ length: 6000 }, (_, i) => `${20 + (i % 50)} ${20 + (i % 30)} 300 200 re f`).join(' ');
    const pdf = pagesPdf([{ content: `0 0 1 rg ${fill}` }, { content: `1 0 0 rg ${fill}` }, { content: `0 1 0 rg ${fill}` }]);
    assert.ok(pdf.length > 250_000, `pdf of ${pdf.length} bytes`);
    const created = await raw(proxy.origin, '/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length), 'X-Filename': encodeURIComponent('강의.pdf'), Origin: proxy.origin, Cookie: cookie },
      body: pdf,
    });
    assert.equal(created.status, 201, created.body);
    const { id } = JSON.parse(created.body) as { id: string };
    await waitFor(
      'the conversion',
      async () => ((await (await fetch(`${proxy.origin}/api/docs/${id}`, { headers: { Cookie: cookie } })).json()) as DocMeta).status === 'ready',
      60_000,
    );
    const slide = await fetch(`${proxy.origin}/api/docs/${id}/slides/1.png`, { headers: { Cookie: cookie } });
    assert.equal(slide.status, 200);
    assert.equal(slide.headers.get('content-type'), 'image/png');
    assert.ok((await slide.arrayBuffer()).byteLength > 100);
    const gone = await fetch(`${proxy.origin}/api/docs/${id}`, { method: 'DELETE', headers: { Origin: proxy.origin, Cookie: cookie } });
    assert.equal(gone.status, 204);
    await gone.arrayBuffer();
  });

  test('a chat turn streams unbuffered; closing the client aborts the turn on the remote', POSIX_ONLY, async () => {
    const created = await fetch(`${proxy.origin}/api/docs/${DOC_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: proxy.origin, Cookie: cookie },
      body: JSON.stringify({ provider: 'claude-code' }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const session = (await created.json()) as { id: string };
    const stream = await openStream(`${proxy.origin}/api/docs/${DOC_ID}/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Origin: proxy.origin, Cookie: cookie },
      body: JSON.stringify({ text: '이게 뭐야?', slide: 1 }),
    });
    assert.equal(stream.status, 200);
    // The fake CLI answers a delta and then hangs: the first frame arrives while the turn still runs.
    const first = await Promise.race([stream.first, sleep(20_000).then(() => 'timeout')]);
    assert.notEqual(first, 'timeout', 'the first event was not relayed while the turn runs (buffered?)');
    assert.match(first, /^event: /);
    assert.equal(runningTurnCount(), 1);
    stream.abort();
    await stream.ended;
    await waitFor('the turn to be aborted', () => runningTurnCount() === 0, 2_000);
  });

  test('a recording upload refused before its body ends (413 from Content-Length, 401 without a login) reaches the client', async () => {
    // 413: the remote reads the body off (≤ 16 MB) before answering; 8 MB stays inside that bound, so its answer is
    // deterministic (beyond the bound a direct client can be reset too: the remote closes with data still arriving).
    const total = 8 * 1024 * 1024;
    const res = await rawUpload(proxy.origin, `/api/docs/${DOC_ID}/recordings/upload`, total, {
      'Content-Length': String(total),
      'X-Filename': 'big.wav',
      Origin: proxy.origin,
      Cookie: cookie,
    });
    assert.equal(res.status, 413, res.body);
    assert.match(res.body, /녹음 파일이 너무 큽니다/);
    // 401: answered at once, while the proxy is still receiving the body. The proxy reads the rest off and ends the
    // answer with a FIN (not a reset), on a connection it closes.
    const early = await rawUpload(proxy.origin, `/api/docs/${DOC_ID}/recordings/upload`, 4 * 1024 * 1024, {
      'Content-Length': String(4 * 1024 * 1024),
      'X-Filename': 'anonymous.wav',
      Origin: proxy.origin,
    });
    assert.equal(early.status, 401, early.body);
    assert.match(early.body, /login required/);
    assert.equal(early.headers.connection, 'close');
    // A small one that fits is stored (the fake ffmpeg converts it).
    const small = await rawUpload(proxy.origin, `/api/docs/${DOC_ID}/recordings/upload`, 64 * 1024, {
      'Content-Length': String(64 * 1024),
      'X-Filename': 'small.wav',
      Origin: proxy.origin,
      Cookie: cookie,
    });
    assert.equal(small.status, 201, small.body);
  });

  test('a live recording’s WAV with Range: 206 + Content-Range; HEAD has the length and no body', async () => {
    const created = await fetch(`${proxy.origin}/api/docs/${DOC_ID}/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: proxy.origin, Cookie: cookie },
      body: JSON.stringify({ title: '녹음', liveTranscribe: false }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const rec = (await created.json()) as RecordingInfo;
    const pcm = Buffer.alloc(32_000, 3);
    const audio = await fetch(`${proxy.origin}/api/docs/${DOC_ID}/recordings/${rec.id}/audio?offset=0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Origin: proxy.origin, Cookie: cookie },
      body: pcm,
    });
    assert.equal(audio.status, 200, await audio.clone().text());
    assert.equal(((await audio.json()) as { offset: number }).offset, pcm.length);
    const info = (await (await fetch(`${proxy.origin}/api/docs/${DOC_ID}/recordings/${rec.id}`, { headers: { Cookie: cookie } })).json()) as RecordingInfo;
    assert.ok(info.playback?.url, JSON.stringify(info));
    const url = `${proxy.origin}${info.playback.url}`;
    const part = await fetch(url, { headers: { Range: 'bytes=0-1', Cookie: cookie } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-1/${44 + pcm.length}`);
    assert.equal(part.headers.get('accept-ranges'), 'bytes');
    assert.equal(Buffer.from(await part.arrayBuffer()).toString('ascii'), 'RI');
    const head = await raw(proxy.origin, info.playback.url, { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(44 + pcm.length));
    assert.equal(head.body, '');
    const stopped = await fetch(`${proxy.origin}/api/docs/${DOC_ID}/recordings/${rec.id}/stop`, { method: 'POST', headers: { Origin: proxy.origin, Cookie: cookie } });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    await stopped.arrayBuffer();
  });

  test('Upgrade requests are refused (the socket is closed without an answer)', async () => {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1', () => {
        socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (c: Buffer) => (data += c.toString()));
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error('the socket stayed open'));
      }, 3_000).unref();
    });
    assert.doesNotMatch(answer, /101/);
  });

  test('the remote unreachable: 502 with a Korean text; a public address is never relayed', async () => {
    const dead = await startProxy(`http://127.0.0.1:${await freePort()}`);
    const res = await fetch(`${dead.origin}/api/health`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /연결한 컴퓨터\(http:\/\/127\.0\.0\.1:\d+\)에 닿지 않아요/);
    dead.child.stdin!.end();
    assert.deepEqual(await exitWithin(dead, 3_000), { code: 0, signal: null });

    // A `--to` whose address is not private (a public IP literal): the lookup refuses, 502 too, nothing connected.
    const publicProxy = await startProxy('http://192.0.2.10:5180');
    const refused = await fetch(`${publicProxy.origin}/api/health`);
    assert.equal(refused.status, 502);
    await refused.arrayBuffer();
    assert.match(publicProxy.stderr(), /사설 네트워크 주소가 아니어서/);
    publicProxy.child.stdin!.end();
    assert.equal((await exitWithin(publicProxy, 3_000)).code, 0);
  });

  test('a bad --to exits 2 with a Korean message; stdin EOF stops the proxy with exit 0', async () => {
    for (const bad of ['https://x:5180', 'http://x:5180/p']) {
      const p = spawnProxy(['--to', bad]);
      assert.deepEqual(await exitWithin(p, 5_000), { code: 2, signal: null });
      assert.match(p.stderr(), /중계할 주소가 올바르지 않습니다/);
      assert.doesNotMatch(p.stdout(), /EASY_STUDY_READY/);
    }
    const missing = spawnProxy([]);
    assert.equal((await exitWithin(missing, 5_000)).code, 2);

    const taken = spawnProxy(['--to', remote.url], { PORT: String(proxy.port) });
    assert.deepEqual(await exitWithin(taken, 5_000), { code: 1, signal: null });
    assert.match(taken.stderr(), new RegExp(`포트 ${proxy.port}를 다른 프로그램이 쓰고 있습니다`));

    const started = Date.now();
    proxy.child.stdin!.end();
    assert.deepEqual(await exitWithin(proxy, 3_000), { code: 0, signal: null });
    assert.ok(Date.now() - started <= 3_000);
    assert.match(proxy.stdout(), /stdin EOF: 종료하는 중/);
  });
});
