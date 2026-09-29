// The desktop app's loopback proxy for plain-http remotes (DESIGN §16, §19): `node dist-server/server/proxy.js
// --to http://192.168.0.10:5180`, started by the shell when the user connects the app to another computer over
// plain http. A page at http://192.168.0.10:5180 is not a secure context, so the WebView hides the microphone from
// it (no navigator.mediaDevices, no AudioWorklet); a page at http://127.0.0.1:<port> is one. So the shell shows
// http://127.0.0.1:<port> instead and this process relays every request to the remote: SSE streams and uploads
// as they flow (nothing buffered), HTTP Range, the session cookie, and the Host / Origin / Referer headers
// rewritten to the remote's origin so that its CSRF and origin checks pass. https:// remotes are shown directly
// (already secure).
//
// - Binds 127.0.0.1 only (PORT, 0 = any), relays exactly the one origin of `--to`, adds no credentials and no
//   X-Forwarded-* (incoming ones are dropped: the remote trusts them from loopback peers), refuses any Host but its
//   own (421: a DNS-rebinding page never gets relayed) and every Upgrade. The remote's hostname is resolved per
//   request and only private addresses are connected (loopback, RFC 1918, link-local, 100.64/10, IPv6 ULA/link-local):
//   a name that starts pointing at the internet gets 502, never the session cookie over plain http.
// - The remote's session cookie is kept apart from every other server's on 127.0.0.1. Cookies are host-scoped, not
//   port-scoped: the WebView holds ONE cookie jar for 127.0.0.1, shared by the shell's own (shared) server, this
//   relay and any relay for another remote. So `Set-Cookie: es_session=…` from the remote is stored as
//   `es_session_<hash of the remote origin>` and only that cookie goes back to the remote as `es_session`; a bare
//   `es_session` (the shell's own server's login) or another remote's `es_session_<other>` is dropped from the
//   Cookie header and never reaches the remote (scopedSessionCookieName, upstreamCookie, downstreamSetCookie).
// - The same ready line as the server (`EASY_STUDY_READY {"url":"http://127.0.0.1:<port>","port":<port>}`), the
//   same watch on the shell (stdin EOF, parent gone, signals → exit 0). Exit 1 when it cannot listen, 2 for a bad
//   `--to`. stderr is Korean (the shell's proxy.log); no request URL or header is ever logged: `/login?code=` carries
//   the code, Cookie headers the session.
// - Imports nothing of the server (no library, no lock, no auth store): only node:http/net/dns/url and shellWatch.ts.
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { Socket } from 'node:net';
import { readyLine, stopSignals, watchShell } from './shellWatch.ts';

/** How long the graceful stop may take before the process exits anyway. */
export const PROXY_SHUTDOWN_TIMEOUT_MS = 2_000;
/** Before ending an early answer (413 while the client still sends): read at most this much of the rest off. */
const DRAIN_MAX_BYTES = 16 * 1024 * 1024;
const DRAIN_MAX_MS = 5_000;

/** The server's session cookie (server/auth.ts SESSION_COOKIE; the proxy imports nothing of the server). */
const SESSION_COOKIE = 'es_session';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface ProxyTarget {
  /** e.g. `http://192.168.0.10:5180` (no trailing slash). */
  origin: string;
  /** The Host header to send: `url.host` (IPv6 keeps its brackets). */
  host: string;
  /** For the TCP connection: the host name or address without brackets. */
  hostname: string;
  port: number;
}

/**
 * The `--to` argument: an http origin — scheme `http:`, a host, no user info, no path (or `/`), no query or fragment.
 * Throws with a Korean message otherwise.
 */
export function parseTarget(raw: string): ProxyTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`중계할 주소가 올바르지 않습니다: ${raw}`);
  }
  if (url.protocol !== 'http:') throw new Error(`중계할 주소가 올바르지 않습니다 (http:// 주소만 중계합니다): ${raw}`);
  if (url.hostname === '' || url.username !== '' || url.password !== '') throw new Error(`중계할 주소가 올바르지 않습니다: ${raw}`);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '' || /[?#]/.test(raw)) {
    throw new Error(`중계할 주소가 올바르지 않습니다 (주소는 http://호스트:포트 형태여야 합니다): ${raw}`);
  }
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return { origin: url.origin, host: url.host, hostname, port: url.port === '' ? 80 : Number(url.port) };
}

const PRIVATE_V4 = new BlockList();
PRIVATE_V4.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_V4.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_V4.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_V4.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_V4.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_V4.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT, and Tailscale's 100.x addresses
const PRIVATE_V6 = new BlockList();
PRIVATE_V6.addAddress('::1', 'ipv6');
PRIVATE_V6.addSubnet('fc00::', 7, 'ipv6'); // unique local
PRIVATE_V6.addSubnet('fe80::', 10, 'ipv6'); // link local

/** This computer or a private network (the same rules as the shell's remote.rs `is_private`). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE_V4.check(mapped[1], 'ipv4');
  return PRIVATE_V6.check(address, 'ipv6');
}

/**
 * The name the WebView stores the remote's session cookie under at the relay origin: `es_session_<12 hex of
 * sha256(remote origin)>`. One cookie per remote, next to the shell's own server's `es_session`, in the one jar
 * the WebView keeps for 127.0.0.1.
 */
export function scopedSessionCookieName(targetOrigin: string): string {
  return `${SESSION_COOKIE}_${createHash('sha256').update(targetOrigin).digest('hex').slice(0, 12)}`;
}

/**
 * The Cookie header for the remote: its own scoped session cookie goes as `es_session`; a bare `es_session` (the
 * shell's own server's login) and any other `es_session_*` (another remote's) are dropped, everything else passes.
 * Undefined when nothing is left.
 */
export function upstreamCookie(header: string | undefined, targetOrigin: string): string | undefined {
  if (header === undefined) return undefined;
  const scoped = scopedSessionCookieName(targetOrigin);
  const kept: string[] = [];
  for (const part of header.split(';')) {
    const pair = part.trim();
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const name = (eq < 0 ? pair : pair.slice(0, eq)).trim();
    if (name === scoped) kept.push(`${SESSION_COOKIE}=${eq < 0 ? '' : pair.slice(eq + 1).trim()}`);
    else if (name === SESSION_COOKIE || name.startsWith(`${SESSION_COOKIE}_`)) continue;
    else kept.push(pair);
  }
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/**
 * The remote's Set-Cookie headers for the WebView: `es_session=…` (a login, a refresh, the cleared cookie of a
 * logout) is renamed to this remote's scoped name, attributes untouched; any other cookie passes as it is.
 */
export function downstreamSetCookie(value: string | string[] | undefined, targetOrigin: string): string[] | undefined {
  if (value === undefined) return undefined;
  const scoped = scopedSessionCookieName(targetOrigin);
  const prefix = `${SESSION_COOKIE}=`;
  return (Array.isArray(value) ? value : [value]).map((cookie) => (cookie.startsWith(prefix) ? `${scoped}=${cookie.slice(prefix.length)}` : cookie));
}

/**
 * The headers of a request to the remote: everything the client sent minus the hop-by-hop ones and every
 * `Forwarded` / `X-Forwarded-*` (the remote trusts those from loopback peers: a spoofed `https` would make it set a
 * `Secure` cookie the WebView then drops over http), `Host` = the remote's, `Origin` and `Referer` of the proxy
 * origin rewritten to the remote's (any other Origin passes as it is: the remote refuses it), `Cookie` reduced to
 * this remote's own session (upstreamCookie). Authorization, Content-Length, Content-Type, X-Filename, Range, If-*,
 * Last-Event-ID and the rest pass through untouched.
 */
export function upstreamHeaders(incoming: http.IncomingHttpHeaders, proxyOrigin: string, target: Pick<ProxyTarget, 'origin' | 'host'>): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const dropped = new Set(HOP_BY_HOP);
  for (const token of String(incoming.connection ?? '').split(',')) {
    const name = token.trim().toLowerCase();
    if (name) dropped.add(name);
  }
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || dropped.has(name) || name === 'forwarded' || name.startsWith('x-forwarded-')) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  if (typeof incoming.origin === 'string') headers.origin = incoming.origin === proxyOrigin ? target.origin : incoming.origin;
  const referer = incoming.referer;
  if (typeof referer === 'string') {
    if (referer === proxyOrigin || referer.startsWith(`${proxyOrigin}/`)) headers.referer = target.origin + referer.slice(proxyOrigin.length);
    else delete headers.referer;
  }
  const cookie = upstreamCookie(incoming.cookie, target.origin);
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  return headers;
}

/**
 * The headers of the answer to the client: the remote's minus the hop-by-hop ones; `Set-Cookie` with the session
 * cookie under this remote's scoped name (downstreamSetCookie; host-only cookies: the WebView stores them for
 * 127.0.0.1); a `Location` on the remote's origin becomes one on the proxy's (the server's own redirects are
 * relative and pass as they are).
 */
export function downstreamHeaders(upstream: http.IncomingHttpHeaders, proxyOrigin: string, targetOrigin: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined || HOP_BY_HOP.includes(name)) continue;
    headers[name] = value;
  }
  const setCookie = downstreamSetCookie(upstream['set-cookie'], targetOrigin);
  if (setCookie !== undefined) headers['set-cookie'] = setCookie;
  const location = upstream.location;
  if (typeof location === 'string' && (location === targetOrigin || location.startsWith(`${targetOrigin}/`))) {
    headers.location = proxyOrigin + location.slice(targetOrigin.length);
  }
  return headers;
}

/** PORT: unset or empty = 0 (any free port), otherwise 0-65535. */
export function proxyPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT?.trim() ?? '';
  if (raw === '') return 0;
  if (!/^\d+$/.test(raw) || Number(raw) > 65_535) throw new Error(`PORT 값이 올바르지 않습니다: "${raw}" (0~65535)`);
  return Number(raw);
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * dns.lookup that answers only private addresses (an IP literal is "resolved" to itself by dns.lookup, so the same
 * check covers `--to http://192.168.0.10:5180` and `--to http://study-pc.local:5180` alike).
 */
function privateLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = (Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: isIP(String(addresses)) }]).filter((a) =>
      isPrivateAddress(a.address),
    );
    if (list.length === 0) {
      return callback(Object.assign(new Error(`${hostname} resolves to a public address only`), { code: 'EPUBLIC' }), []);
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/** Reads a bounded rest of a request body off, so that the client gets to read an early answer instead of a reset. */
function drainRest(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (req.complete || req.destroyed) return resolve();
    let discarded = 0;
    const done = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      resolve();
    };
    const onData = (chunk: Buffer) => {
      discarded += chunk.length;
      if (discarded > DRAIN_MAX_BYTES) done();
    };
    const timer = setTimeout(done, DRAIN_MAX_MS);
    req.on('data', onData);
    req.once('end', done);
    req.once('close', done);
    req.resume();
  });
}

function unreachableText(target: ProxyTarget): string {
  return `연결한 컴퓨터(${target.origin})에 닿지 않아요. 그 컴퓨터의 easy-study가 켜져 있는지, 같은 네트워크인지 확인하세요.\n`;
}

function plain(res: ServerResponse, status: number, text: string, close = false): void {
  const headers: OutgoingHttpHeaders = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (close) headers.connection = 'close';
  res.writeHead(status, headers);
  res.end(text);
}

export interface ProxyServer {
  server: http.Server;
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  close(): Promise<void>;
}

/** Starts the relay on 127.0.0.1:`port` (0 = any) for `target`. Rejects when it cannot listen (EADDRINUSE and the like). */
export function startProxy(target: ProxyTarget, port: number): Promise<ProxyServer> {
  const agent = new http.Agent({ keepAlive: true });
  const server = http.createServer();
  // Uploads may take hours (DESIGN §22): no whole-request limit; the headers must still arrive within 60 s (default).
  server.requestTimeout = 0;
  let proxyOrigin = '';
  let proxyHost = '';

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== proxyHost) return plain(res, 421, '이 주소로는 열 수 없습니다\n', true);
    const path = req.url ?? '';
    if (!path.startsWith('/')) return plain(res, 400, '요청 주소가 올바르지 않습니다\n', true);

    // net.connect resolves nothing for an IP literal (the lookup below never runs): checked here instead.
    if (isIP(target.hostname) && !isPrivateAddress(target.hostname)) {
      console.error(`[proxy] ${target.origin} 이(가) 사설 네트워크 주소가 아니어서 중계하지 않았습니다`);
      return plain(res, 502, unreachableText(target), true);
    }

    let answered = false;
    const up = http.request({
      host: target.hostname,
      port: target.port,
      method: req.method,
      path,
      headers: upstreamHeaders(req.headers, proxyOrigin, target),
      setHost: false,
      agent,
      lookup: privateLookup as unknown as http.RequestOptions['lookup'],
    });
    up.on('response', (r) => {
      answered = true;
      // The remote answered before the body arrived (413 for a too-large upload, 408): it closes its side; so do we,
      // after reading a bounded rest of the body off, so that the client gets to read the answer.
      const early = !req.complete;
      const headers = downstreamHeaders(r.headers, proxyOrigin, target.origin);
      if (early) headers.connection = 'close';
      res.writeHead(r.statusCode ?? 502, r.statusMessage, headers);
      res.flushHeaders();
      res.socket?.setNoDelay(true); // SSE: every event out as it arrives
      r.pipe(res, { end: false });
      r.on('end', () => {
        if (!early || req.complete || req.destroyed) {
          res.end();
          return;
        }
        req.unpipe(up);
        up.destroy();
        drainRest(req).then(() => res.end());
      });
      r.on('error', () => res.destroy());
    });
    up.on('error', (err: NodeJS.ErrnoException) => {
      if (answered) return; // a late write error after the answer (the remote closed after its 413): nothing to do
      answered = true;
      if (res.headersSent) return res.destroy();
      if (err.code === 'EPUBLIC') console.error(`[proxy] ${target.origin} 이(가) 사설 네트워크 주소가 아니어서 중계하지 않았습니다`);
      plain(res, 502, unreachableText(target));
    });
    // The client left (page closed, navigation, an aborted upload): the remote sees the close and aborts its turn.
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    req.on('close', () => {
      if (!req.complete && !answered) up.destroy();
    });
    req.on('error', () => up.destroy());
    req.pipe(up);
  });
  server.on('upgrade', (_req, socket: Socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const actual = (server.address() as { port: number }).port;
      proxyHost = `127.0.0.1:${actual}`;
      proxyOrigin = `http://${proxyHost}`;
      resolve({
        server,
        origin: proxyOrigin,
        port: actual,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
            agent.destroy();
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function argValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<void> {
  // The output goes to pipes of the shell: once the shell is gone, a write must not crash the proxy (EPIPE).
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  let target: ProxyTarget;
  let port: number;
  try {
    const raw = argValue(process.argv.slice(2), '--to');
    if (raw === undefined || raw === '') throw new Error('중계할 주소가 올바르지 않습니다: --to http://호스트:포트 가 필요합니다');
    target = parseTarget(raw);
    port = proxyPort();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  let proxy: ProxyServer;
  try {
    proxy = await startProxy(target, port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(code === 'EADDRINUSE' ? `포트 ${port}를 다른 프로그램이 쓰고 있습니다` : `연결 통로를 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[proxy] ${reason}: 종료하는 중…`);
    setTimeout(() => process.exit(0), PROXY_SHUTDOWN_TIMEOUT_MS).unref();
    proxy.close().finally(() => process.exit(0));
  };
  for (const signal of stopSignals()) process.on(signal, () => stop(signal));
  watchShell(stop);

  console.log(`[proxy] ${proxy.origin} → ${target.origin}`);
  console.log(readyLine(proxy.origin, proxy.port));
}

if (import.meta.main) {
  await main();
}
