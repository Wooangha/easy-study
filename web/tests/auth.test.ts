// Remote mode on the client (DESIGN §16): access code input, rate-limit waits, the login state, and API
// requests that wait for a login after a 401. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError, getAuthStatus, listDocs, login, postStream } from '../src/api.ts';
import { normalizeGeneratedCode } from '../../server/auth.ts';
import {
  applyAuthStatus,
  formatWait,
  getAuthSnapshot,
  hasHangul,
  isLoopbackHost,
  markLoggedIn,
  markLoggedOut,
  markStatusUnknown,
  markUnauthorized,
  normalizeAccessCode,
  parseRetryAfter,
  resetAuthForTests,
  takeLoginLinkParam,
  waitForLogin,
} from '../src/lib/auth.ts';

describe('access code input', () => {
  const code = 'k7qm2-x9fda-p3hzt-w8cne';

  test('a generated code is accepted however it was typed or pasted (the server ignores case, spaces, dashes)', () => {
    for (const typed of [
      code,
      'k7qm2x9fdap3hztw8cne',
      'k7qm2 x9fda p3hzt w8cne',
      '  k7qm2-x9fda-p3hzt-w8cne\n',
      'K7QM2-X9FDA-P3HZT-W8CNE',
      'k7qm2 - x9fda - p3hzt - w8cne',
      'k7qm2\u2013x9fda\u2014p3hzt\u2212w8cne', // en dash, em dash, minus sign (word processors, chat apps)
      '\u200bk7qm2-x9fda-p3hzt-w8cne\ufeff', // zero-width characters picked up when copying
      'k7qm2-x9fda-\np3hzt-w8cne',
    ]) {
      const sent = normalizeAccessCode(typed);
      assert.equal(normalizeGeneratedCode(sent), normalizeGeneratedCode(code), JSON.stringify(typed));
    }
    assert.equal(normalizeAccessCode('k7qm2\u2013x9fda\u2014p3hzt\u2212w8cne'), code);
    assert.equal(normalizeAccessCode('\u200b k7qm2-x9fda-p3hzt-w8cne \n'), code);
  });

  test('a password (EASY_STUDY_PASSWORD) is sent exactly as typed, without the whitespace around it', () => {
    assert.equal(normalizeAccessCode('  correct horse battery staple  '), 'correct horse battery staple');
    assert.equal(normalizeAccessCode('Pa55\u2013word!'), 'Pa55\u2013word!');
    // Shaped like a generated code, but case-sensitive: not lower-cased or regrouped.
    assert.equal(normalizeAccessCode('MyPassword1234567890'), 'MyPassword1234567890');
    assert.equal(normalizeAccessCode('k7qm2-x9fda-p3hzt-w8cne-extra'), 'k7qm2-x9fda-p3hzt-w8cne-extra');
    assert.equal(normalizeAccessCode('   '), '');
  });

  test('Hangul typed with the Korean input method on is noticed', () => {
    assert.equal(hasHangul('ㅏ7ㅂㅡ2'), true);
    assert.equal(hasHangul('가나다'), true);
    assert.equal(hasHangul(code), false);
  });
});

describe('rate limit wait', () => {
  test('Retry-After as seconds or as an HTTP date', () => {
    assert.equal(parseRetryAfter('120'), 120);
    assert.equal(parseRetryAfter(' 0 '), 0);
    const now = Date.parse('2026-09-26T10:00:00Z');
    assert.equal(parseRetryAfter('Sat, 26 Sep 2026 10:01:30 GMT', now), 90);
    assert.equal(parseRetryAfter('Sat, 26 Sep 2026 09:59:00 GMT', now), 0);
    assert.equal(parseRetryAfter('soon'), null);
    assert.equal(parseRetryAfter(''), null);
    assert.equal(parseRetryAfter(null), null);
  });

  test('waits are written in Korean units', () => {
    assert.equal(formatWait(45), '45초');
    assert.equal(formatWait(0.2), '1초');
    assert.equal(formatWait(60), '1분');
    assert.equal(formatWait(552), '9분 12초');
    assert.equal(formatWait(600), '10분');
    assert.equal(formatWait(3900), '1시간 5분');
    assert.equal(formatWait(7200), '2시간');
  });
});

describe('address bar', () => {
  test('/?login=failed and /?login=limited are noticed and removed; other parameters and the hash stay', () => {
    assert.deepEqual(takeLoginLinkParam('http://192.168.0.5:5180/?login=failed'), { result: 'failed', cleanUrl: '/' });
    assert.deepEqual(takeLoginLinkParam('http://h:1/?login=limited'), { result: 'limited', cleanUrl: '/' });
    assert.deepEqual(takeLoginLinkParam('http://h:1/?a=1&login=failed#x'), { result: 'failed', cleanUrl: '/?a=1#x' });
    assert.deepEqual(takeLoginLinkParam('http://h:1/?login=whatever'), { result: null, cleanUrl: '/' });
    assert.deepEqual(takeLoginLinkParam('http://h:1/'), { result: null, cleanUrl: null });
    assert.deepEqual(takeLoginLinkParam('not a url'), { result: null, cleanUrl: null });
  });

  test('loopback host names', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'app.localhost']) assert.ok(isLoopbackHost(h), h);
    for (const h of ['192.168.0.5', 'my-mac.local', 'box.tail1234.ts.net', '10.0.0.1']) assert.ok(!isLoopbackHost(h), h);
  });
});

describe('login state', () => {
  beforeEach(() => resetAuthForTests());

  test('startup status', () => {
    applyAuthStatus({ authRequired: true, authenticated: false });
    assert.equal(getAuthSnapshot().phase, 'login');
    assert.equal(getAuthSnapshot().reason, 'required');
    resetAuthForTests();
    applyAuthStatus({ authRequired: true, authenticated: false }, 'failed');
    assert.equal(getAuthSnapshot().reason, 'link-failed');
    resetAuthForTests();
    applyAuthStatus({ authRequired: true, authenticated: false }, 'limited');
    assert.equal(getAuthSnapshot().reason, 'link-limited');
    resetAuthForTests();
    applyAuthStatus({ authRequired: true, authenticated: true });
    assert.deepEqual([getAuthSnapshot().phase, getAuthSnapshot().authRequired], ['ok', true]);
    resetAuthForTests();
    applyAuthStatus({ authRequired: false, authenticated: true });
    assert.deepEqual([getAuthSnapshot().phase, getAuthSnapshot().authRequired], ['ok', false]);
  });

  const state = () => {
    const { phase, reason, overApp } = getAuthSnapshot();
    return { phase, reason, overApp };
  };

  test('a 401 while the app is in use: the session expired, the login screen comes over the app', () => {
    applyAuthStatus({ authRequired: true, authenticated: true });
    markUnauthorized();
    assert.deepEqual(state(), { phase: 'login', reason: 'expired', overApp: true });
    markUnauthorized();
    assert.deepEqual(state(), { phase: 'login', reason: 'expired', overApp: true });
    markLoggedIn();
    assert.deepEqual(state(), { phase: 'ok', reason: null, overApp: false });
  });

  test('requests still running when the user logged out do not bring the app back under the login screen', () => {
    applyAuthStatus({ authRequired: true, authenticated: true });
    markLoggedOut();
    markUnauthorized();
    assert.deepEqual(state(), { phase: 'login', reason: 'logout', overApp: false });
  });

  test('status unknown (server unreachable) lets the app start; a later 401 asks for a first login over it', () => {
    markStatusUnknown();
    assert.equal(getAuthSnapshot().phase, 'ok');
    markUnauthorized();
    assert.deepEqual(state(), { phase: 'login', reason: 'required', overApp: true });
  });

  test('a local-mode app whose server now asks for a login (restarted in remote mode)', () => {
    applyAuthStatus({ authRequired: false, authenticated: true });
    markUnauthorized();
    assert.deepEqual(state(), { phase: 'login', reason: 'required', overApp: true });
    assert.equal(getAuthSnapshot().authRequired, true);
  });

  test('waiters resume on the next login; a login since the given epoch resolves at once; abort rejects', async () => {
    applyAuthStatus({ authRequired: true, authenticated: false });
    const epoch = getAuthSnapshot().epoch;
    let resumed = false;
    const waiting = waitForLogin(epoch).then(() => (resumed = true));
    const controller = new AbortController();
    const aborted = waitForLogin(epoch, controller.signal);
    controller.abort();
    await assert.rejects(aborted, { name: 'AbortError' });
    await Promise.resolve();
    assert.equal(resumed, false);
    markLoggedIn();
    await waiting;
    assert.equal(resumed, true);
    assert.equal(getAuthSnapshot().epoch, epoch + 1);
    assert.deepEqual([getAuthSnapshot().phase, getAuthSnapshot().reason], ['ok', null]);
    await waitForLogin(epoch); // resolves immediately: a login happened since
  });
});

// ---------------------------------------------------------------------------
// api.ts against a scripted fetch
// ---------------------------------------------------------------------------

interface Call {
  path: string;
  method: string;
  body: string | null;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let answer: (call: Call) => Response = () => new Response(null, { status: 500 });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('API requests and the login', () => {
  beforeEach(() => {
    resetAuthForTests();
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        path: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      return answer(call);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a 401 shows the login screen, waits, and sends the request again after the login', async () => {
    applyAuthStatus({ authRequired: true, authenticated: true });
    let loggedIn = false;
    answer = () => (loggedIn ? json([]) : json({ error: 'login required' }, 401));
    let result: unknown = 'pending';
    const docs = listDocs().then((r) => (result = r));
    await tick();
    assert.deepEqual([getAuthSnapshot().phase, getAuthSnapshot().reason], ['login', 'expired']);
    assert.equal(result, 'pending');
    assert.equal(calls.length, 1);
    loggedIn = true;
    markLoggedIn();
    await docs;
    assert.deepEqual(result, []);
    assert.equal(calls.length, 2);
  });

  test('while logged out, requests wait before being sent and identical GETs share one request', async () => {
    applyAuthStatus({ authRequired: true, authenticated: false });
    answer = () => json([]);
    const a = listDocs();
    const b = listDocs();
    await tick();
    assert.equal(calls.length, 0);
    markLoggedIn();
    assert.deepEqual(await Promise.all([a, b]), [[], []]);
    assert.equal(calls.length, 1);
  });

  test('a question (SSE POST) refused with 401 is sent again, with the same body, after the login', async () => {
    applyAuthStatus({ authRequired: true, authenticated: true });
    let loggedIn = false;
    answer = () =>
      loggedIn
        ? new Response('event: status\ndata: {"type":"status","text":"hi"}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        : json({ error: 'login required' }, 401);
    const events: unknown[] = [];
    const stream = postStream('/api/docs/d/sessions/s/messages', { text: 'q', slide: 3 }, (e) => events.push(e));
    await tick();
    assert.equal(getAuthSnapshot().phase, 'login');
    loggedIn = true;
    markLoggedIn();
    await stream;
    assert.deepEqual(events, [{ type: 'status', text: 'hi' }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].body, calls[0].body);
  });

  test('a waiting stream can still be cancelled', async () => {
    applyAuthStatus({ authRequired: true, authenticated: true });
    answer = () => json({ error: 'login required' }, 401);
    const controller = new AbortController();
    const stream = postStream('/api/x', {}, () => {}, controller.signal);
    await tick();
    controller.abort();
    await assert.rejects(stream, { name: 'AbortError' });
  });

  test('a 401 for a request sent before a login that finished meanwhile is simply sent again', async () => {
    applyAuthStatus({ authRequired: true, authenticated: false });
    markLoggedIn(); // epoch 1
    let first = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push({ path: String(input), method: 'GET', body: null });
      if (first) {
        first = false;
        await gate; // answered only after the next login
        return json({ error: 'login required' }, 401);
      }
      return json([]);
    }) as typeof fetch;
    const docs = listDocs();
    await tick();
    markUnauthorized();
    markLoggedIn(); // epoch 2 (another request brought up the login screen and the user logged in)
    release();
    assert.deepEqual(await docs, []);
    assert.equal(getAuthSnapshot().phase, 'ok');
    assert.equal(calls.length, 2);
  });

  test('other errors are not affected', async () => {
    applyAuthStatus({ authRequired: true, authenticated: true });
    answer = () => json({ error: '문서를 찾을 수 없습니다' }, 404);
    await assert.rejects(listDocs(), (e: unknown) => e instanceof ApiError && e.status === 404);
    assert.equal(getAuthSnapshot().phase, 'ok');
  });

  test('auth status: normal answer, a server from before the remote mode (404), local mode (403)', async () => {
    answer = () => json({ authRequired: true, authenticated: false });
    assert.deepEqual(await getAuthStatus(), { authRequired: true, authenticated: false });
    answer = () => json({ error: 'not found' }, 404);
    assert.deepEqual(await getAuthStatus(), { authRequired: false, authenticated: true });
    answer = () => json({ error: '로컬 주소(127.0.0.1)로만 접속할 수 있습니다' }, 403);
    await assert.rejects(getAuthStatus(), (e: unknown) => e instanceof ApiError && e.status === 403);
    assert.equal(getAuthSnapshot().phase, 'local');
    assert.equal(getAuthSnapshot().message, '로컬 주소(127.0.0.1)로만 접속할 수 있습니다');
  });

  test('login: 204, wrong code (401, no login screen loop), rate limited (429 with Retry-After)', async () => {
    applyAuthStatus({ authRequired: true, authenticated: false });
    answer = () => new Response(null, { status: 204 });
    await login('k7qm2-x9fda-p3hzt-w8cne');
    assert.deepEqual(calls[0], { path: '/api/auth/login', method: 'POST', body: '{"code":"k7qm2-x9fda-p3hzt-w8cne"}' });

    answer = () => json({ error: 'wrong code' }, 401);
    await assert.rejects(login('nope'), (e: unknown) => e instanceof ApiError && e.status === 401);

    answer = () => json({ error: 'too many attempts' }, 429, { 'Retry-After': '540' });
    await assert.rejects(
      login('nope'),
      (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryAfter === 540,
    );
  });
});
