// Desktop mode of the server (DESIGN §19, server/desktop.ts) and the child process registry (server/children.ts).
// The server runs as a real process (node server/index.ts), the way the desktop shell starts it: its own process
// group, stdin/stdout/stderr piped, EASY_STUDY_DESKTOP=1, a temporary library and PORT=0. The LLM CLI is a fake
// script (CLAUDE_BIN) that starts a grandchild and waits; no real CLI or model is ever called.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DesktopBusyResponse, DocMeta, HealthResponse } from '../shared/types.ts';
import { VIEW_WIDTHS, inlinePathFor, thumbPath, viewPath } from '../server/assets.ts';
import { killRunningChildren, runningChildCount, trackChild } from '../server/children.ts';
import { ConfigError, desktopMode, repoRoot } from '../server/config.ts';
import {
  EXIT_PORT_IN_USE,
  READY_PREFIX,
  desktopPort,
  desktopResetCode,
  desktopServerOptions,
  desktopShare,
  ignoredNetworkSettings,
  interfaceRank,
  readyLine,
  shareUrls,
  shellAlive,
  startupFailureMessage,
  watchShell,
} from '../server/desktop.ts';
import { runPdfWorker } from '../server/imageWorker.ts';
import { LibraryLockedError, SERVER_LOCK_FILE_NAME } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE, slideFileName, textFileName } from '../server/pageNames.ts';
import { pagesPdf } from './pdfFixtures.ts';
import { probeVersion, runJsonlProcess } from '../server/providers/proc.ts';

const POSIX = process.platform !== 'win32';
const SERVER_ENTRY = path.join(repoRoot(), 'server', 'index.ts');
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.mjs');
/** Tests that run the fake CLI (a .mjs script: Windows cannot spawn it without a shell) or use process groups. */
const POSIX_ONLY = { skip: POSIX ? false : 'fake CLI scripts and process groups are POSIX only' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  // kill(pid, 0) also succeeds for zombies, which nobody reaps in a container without an init process.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------------------
// Cleanup: temporary folders and every process a test started, whatever happened
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const processes: ChildProcess[] = [];
const strayPids: number[] = [];

async function tempDir(prefix: string): Promise<string> {
  // realpath: the server reports resolved paths (/private/var/... on macOS).
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
    try {
      if (POSIX) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
});

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// The server as a process
// ---------------------------------------------------------------------------

interface ServerProcess {
  child: ChildProcess;
  library: string;
  stdout(): string;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** The test's environment without anything of easy-study, API keys or Claude Code, plus `env`. */
function serverEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(EASY_STUDY_|ANTHROPIC_|OPENAI_|CLAUDE|CODEX_|FAKE_)/.test(key) || key === 'PORT') continue;
    clean[key] = value;
  }
  // No real CLI is ever started (the fixtures' fakes, or a test's own) and no real Codex configuration is read.
  const merged: NodeJS.ProcessEnv = {
    ...clean,
    PORT: '0',
    EASY_STUDY_AUTO_DIGEST: '0',
    CLAUDE_BIN: FAKE_CLAUDE,
    CODEX_BIN: FAKE_CODEX,
    CODEX_HOME: path.join(os.tmpdir(), 'easy-study-desktop-test-no-codex-home'),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Starts `node server/index.ts` like the desktop shell does (its own process group, piped stdio). */
function startServerProcess(
  library: string,
  env: Record<string, string | undefined> = {},
  options: { stdin?: 'pipe' | 'ignore'; desktop?: boolean } = {},
): ServerProcess {
  const desktop = options.desktop ?? true;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: os.tmpdir(),
    env: serverEnv({ EASY_STUDY_LIBRARY: library, ...(desktop ? { EASY_STUDY_DESKTOP: '1' } : {}), ...env }),
    stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    detached: POSIX,
  });
  processes.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, library, stdout: () => stdout, stderr: () => stderr, exited };
}

const READY_RE = /^EASY_STUDY_READY (.*)$/m;

/** Waits for the ready line and returns its content. */
async function waitForReady(server: ServerProcess): Promise<{ url: string; port: number }> {
  await waitFor('the ready line', () => {
    if (server.child.exitCode !== null) assert.fail(`the server exited:\n${server.stdout()}\n${server.stderr()}`);
    return READY_RE.test(server.stdout());
  });
  return JSON.parse(READY_RE.exec(server.stdout())![1]) as { url: string; port: number };
}

async function exitWithin(server: ServerProcess, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), ms)));
  const result = await Promise.race([server.exited, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') assert.fail(`the server did not exit within ${ms} ms:\n${server.stdout()}\n${server.stderr()}`);
  return result;
}

// ---------------------------------------------------------------------------
// A document to talk about and a fake CLI that hangs
// ---------------------------------------------------------------------------

const PAGES = 3;
const DOC_ID = 'deck';
// A 1x1 PNG: slide and overview images (the claude-code adapter sends them inline).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** Stands in for the pre-encoded inline JPEGs (the fake CLI never decodes them). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * A ready document with every derived file (so no backfill starts an image worker, and the server sends the
 * pre-encoded inline images without loading sharp).
 */
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
  // Written last: not older than their PNGs.
  for (let n = 1; n <= PAGES; n++) await fs.writeFile(inlinePathFor(path.join(dir, 'slides', slideFileName(n, PAGES)))!, JPEG);
  await fs.writeFile(inlinePathFor(path.join(dir, 'sheets', 'sheet-01.png'))!, JPEG);
}

/**
 * A fake `claude`: `--version` answers; a turn starts a grandchild (like Claude Code's rg or a shell), records
 * both pids in $FAKE_RECORD and never answers. FAKE_IGNORE_TERM=1: it also ignores SIGTERM.
 */
async function writeFakeCli(dir: string): Promise<string> {
  const file = path.join(dir, 'fake-claude.mjs');
  const interpreter = /\s/.test(process.execPath) ? '/usr/bin/env node' : process.execPath;
  await fs.writeFile(
    file,
    `#!${interpreter}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
if (process.argv[2] === '--version') {
  console.log('9.9.9 (desktop test fake)');
  process.exit(0);
}
if (process.env.FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
  );
  await fs.chmod(file, 0o755);
  return file;
}

interface HangingTurn {
  pid: number;
  grandchild: number;
}

/** A library with a document and a fake CLI; returns the env for the server. */
async function turnSetup(ignoreTerm = false): Promise<{ library: string; record: string; env: Record<string, string> }> {
  const library = await tempDir('easy-study-desktop-lib-');
  const bin = await tempDir('easy-study-desktop-bin-');
  await writeReadyDoc(library);
  const record = path.join(bin, 'record.json');
  const env: Record<string, string> = { CLAUDE_BIN: await writeFakeCli(bin), FAKE_RECORD: record };
  if (ignoreTerm) env.FAKE_IGNORE_TERM = '1';
  return { library, record, env };
}

/** Starts a chat turn with the fake CLI and waits until the CLI and its grandchild run. */
async function startHangingTurn(server: ServerProcess, url: string, record: string): Promise<HangingTurn> {
  const created = await fetch(`${url}/api/docs/${DOC_ID}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude-code' }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const session = (await created.json()) as { id: string };
  // The answer never comes: the stream ends when the server stops. What arrives meanwhile (an early error) is kept.
  let answer = '';
  let failure = '';
  fetch(`${url}/api/docs/${DOC_ID}/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '이게 뭐야?', slide: 1 }),
  }).then(
    async (res) => {
      if (!res.ok) failure = `HTTP ${res.status}`;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body ?? []) {
          answer += decoder.decode(chunk as Uint8Array, { stream: true });
          if (answer.includes('"type":"error"')) failure = 'error event';
        }
      } catch {
        // The server stopped: the stream ends with it.
      }
    },
    () => {},
  );
  const details = () => `answer: ${answer}\nserver stdout:\n${server.stdout()}\nserver stderr:\n${server.stderr()}`;
  await waitFor('the fake CLI', async () => {
    if (failure) assert.fail(`the turn failed (${failure})\n${details()}`);
    return exists(record);
  }, 20_000).catch((err: Error) => {
    throw new Error(`${err.message}\n${details()}`);
  });
  let turn: HangingTurn | null = null;
  await waitFor('the fake CLI record', async () => {
    try {
      turn = JSON.parse(await fs.readFile(record, 'utf8')) as HangingTurn;
      return true;
    } catch {
      return false; // being written
    }
  });
  const { pid, grandchild } = turn!;
  strayPids.push(pid, grandchild);
  assert.ok(isAlive(pid) && isAlive(grandchild), 'the CLI and its child run');
  return { pid, grandchild };
}

async function assertGone(turn: HangingTurn): Promise<void> {
  await waitFor('the CLI and its child to be gone', () => !isAlive(turn.pid) && !isAlive(turn.grandchild), 3_000);
}

/** Pids of the processes in process group `group`, as `ps` lists them (POSIX). */
function processGroupMembers(group: number): Promise<number[]> {
  return new Promise((resolve, reject) =>
    execFile('ps', ['-A', '-o', 'pid=,pgid='], (error, stdout) => {
      if (error) return reject(error);
      const members = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, pgid]) => pgid === group && Number.isInteger(pid))
        .map(([pid]) => pid);
      resolve(members);
    }),
  );
}

// ---------------------------------------------------------------------------
// Desktop mode, end to end
// ---------------------------------------------------------------------------

describe('desktop mode (EASY_STUDY_DESKTOP=1)', () => {
  test('prints exactly one ready line once it listens, and stops on stdin EOF (exit 0, lock removed)', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const server = startServerProcess(library);
    const ready = await waitForReady(server);

    const line = server.stdout().split(/\r?\n/).find((l) => l.startsWith(READY_PREFIX));
    assert.match(line!, /^EASY_STUDY_READY \{"url":"http:\/\/127\.0\.0\.1:(\d+)","port":\1\}$/);
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    assert.equal(ready.url, `http://127.0.0.1:${ready.port}`);
    // It listens by the time the line is out, on the library it was given.
    const health = (await (await fetch(`${ready.url}/api/health`)).json()) as { ok: boolean; libraryDir: string };
    assert.equal(health.ok, true);
    assert.equal(health.libraryDir, library);
    const lock = JSON.parse(await fs.readFile(path.join(library, SERVER_LOCK_FILE_NAME), 'utf8')) as { pid: number; port: number };
    assert.deepEqual([lock.pid, lock.port], [server.child.pid, ready.port]);

    server.child.stdin!.end();
    assert.deepEqual(await exitWithin(server, 8_000), { code: 0, signal: null });
    assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false, 'the lock is released');
    assert.match(server.stdout(), /stdin EOF: 종료하는 중/);
    assert.equal(server.stdout().split(READY_PREFIX).length - 1, 1, 'one ready line');
    // Nothing unexpected on stderr. The "[web] … dist is missing" hint is allowed: the tests may run
    // before `npm run build` (as in CI), and the packaged desktop app always ships web/dist.
    const unexpected = server.stderr().split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('[web] '));
    assert.deepEqual(unexpected, []);
  });

  test('stdin EOF during a chat turn: exit 0, the CLI, its own child and every other process of the group are gone', POSIX_ONLY, async () => {
    const { library, record, env } = await turnSetup();
    const server = startServerProcess(library, env);
    const { url } = await waitForReady(server);
    const turn = await startHangingTurn(server, url, record);
    const group = server.child.pid!;
    assert.ok((await processGroupMembers(group)).length >= 3, 'server, CLI and its child');
    // The shell's busy check before an update sees the answer being made (DESIGN §24).
    const busy = (await (await fetch(`${url}/api/desktop/busy`)).json()) as DesktopBusyResponse;
    assert.equal(busy.chatTurns, 1);

    server.child.stdin!.end();
    assert.deepEqual(await exitWithin(server, 8_000), { code: 0, signal: null });
    await assertGone(turn);
    // Whatever else the server had started (version probes of the CLIs) is gone too.
    await waitFor('the process group to be empty', async () => (await processGroupMembers(group)).length === 0, 3_000);
    assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false);
  });

  test('stdin EOF while a PDF is being converted: exit 0, the PDF worker is gone', POSIX_ONLY, async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const server = startServerProcess(library);
    const { url } = await waitForReady(server);
    const group = server.child.pid!;
    // Enough simple pages that the conversion is still running when the app goes away.
    const pdf = pagesPdf(Array.from({ length: 200 }, (_, i) => ({ content: `0 0 1 rg ${20 + (i % 50)} 20 300 200 re f` })));
    const created = await fetch(`${url}/api/docs`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    assert.equal(created.status, 201, await created.clone().text());
    const { id } = (await created.json()) as { id: string };
    let workers: number[] = [];
    await waitFor('a worker process', async () => {
      workers = (await processGroupMembers(group)).filter((pid) => pid !== group);
      return workers.length > 0;
    });
    strayPids.push(...workers);

    server.child.stdin!.end();
    assert.deepEqual(await exitWithin(server, 8_000), { code: 0, signal: null });
    await waitFor('the worker to be gone', () => workers.every((pid) => !isAlive(pid)), 3_000);
    await waitFor('the process group to be empty', async () => (await processGroupMembers(group)).length === 0, 3_000);
    assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false);
    // Interrupted, not finished: the next start converts it again (resumePendingIngests).
    const meta = JSON.parse(await fs.readFile(path.join(library, id, 'doc.json'), 'utf8')) as { status: string };
    assert.equal(meta.status, 'processing');
  });

  test('SIGTERM stops gracefully; repeated SIGTERM/SIGHUP (PR_SET_PDEATHSIG) do not cut it short', POSIX_ONLY, async () => {
    // The CLI ignores SIGTERM, so the stop takes the kill grace period (3 s) and the repeats arrive meanwhile.
    const { library, record, env } = await turnSetup(true);
    const server = startServerProcess(library, env);
    const { url } = await waitForReady(server);
    const turn = await startHangingTurn(server, url, record);

    const started = Date.now();
    server.child.kill('SIGTERM');
    await sleep(300);
    for (const signal of ['SIGTERM', 'SIGTERM', 'SIGHUP', 'SIGTERM'] as const) server.child.kill(signal);
    assert.deepEqual(await exitWithin(server, 10_000), { code: 0, signal: null });
    assert.ok(Date.now() - started >= 2_000, 'the graceful stop ran to its end');
    await assertGone(turn);
    assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false);
    assert.equal(server.stdout().split('종료하는 중').length - 1, 1, 'one stop');
  });

  test('a second SIGINT exits at once, and the exit hook still ends the CLI and its child', POSIX_ONLY, async () => {
    const { library, record, env } = await turnSetup(true);
    const server = startServerProcess(library, env);
    const { url } = await waitForReady(server);
    const turn = await startHangingTurn(server, url, record);

    server.child.kill('SIGINT');
    await sleep(300);
    const forced = Date.now();
    server.child.kill('SIGINT');
    // Exit code 1 (not "killed by SIGTERM": the process-group signal of the exit hook spares the server's code).
    assert.deepEqual(await exitWithin(server, 5_000), { code: 1, signal: null });
    assert.ok(Date.now() - forced < 2_000, 'forced, not graceful');
    await assertGone(turn);
    assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false, 'the lock is removed on a forced exit too');
  });

  test('a library locked by another server: Korean message on stderr, exit 1, no ready line', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const lockFile = path.join(library, SERVER_LOCK_FILE_NAME);
    // This test process plays the running `npm start` (alive, so the lock is not stale).
    const lock = `${JSON.stringify({ pid: process.pid, port: 5999, startedAt: new Date().toISOString() })}\n`;
    await fs.writeFile(lockFile, lock);
    const server = startServerProcess(library);

    assert.deepEqual(await exitWithin(server, 10_000), { code: 1, signal: null });
    assert.doesNotMatch(server.stdout(), /EASY_STUDY_READY/);
    const stderr = server.stderr();
    assert.match(stderr, new RegExp(`다른 easy-study가 이미 쓰고 있습니다 \\(pid ${process.pid}, 포트 5999\\)`));
    assert.ok(stderr.includes(library), stderr);
    assert.ok(stderr.includes(lockFile), stderr);
    assert.match(stderr, /다른 라이브러리 폴더를 고르세요/);
    assert.doesNotMatch(stderr, /npm run serve|PORT=/, 'no terminal instructions in the app');
    assert.equal(await fs.readFile(lockFile, 'utf8'), lock, 'the other server keeps its lock');
    assert.deepEqual(await fs.readdir(library), [SERVER_LOCK_FILE_NAME], 'nothing else touched');
  });

  test('a port in use: Korean message, exit 3 (the shell may try another port), the lock is not left behind', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as net.AddressInfo;
    try {
      const server = startServerProcess(library, { PORT: String(port) });
      assert.equal(EXIT_PORT_IN_USE, 3);
      assert.deepEqual(await exitWithin(server, 10_000), { code: EXIT_PORT_IN_USE, signal: null });
      assert.match(server.stderr(), new RegExp(`포트 ${port}을\\(를\\) 다른 프로그램이 이미 쓰고 있어서`));
      assert.doesNotMatch(server.stdout(), /EASY_STUDY_READY/);
      assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test('configuration errors: Korean message as the last stderr line, exit 1', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const badPort = startServerProcess(library, { PORT: 'abc' });
    assert.deepEqual(await exitWithin(badPort, 10_000), { code: 1, signal: null });
    assert.equal(badPort.stderr().trim().split('\n').at(-1), '설정 오류: PORT 값이 올바르지 않습니다: "abc" (0~65535)');
    assert.deepEqual(await fs.readdir(library), []);

    const file = path.join(library, 'not-a-folder');
    await fs.writeFile(file, 'x');
    const notAFolder = startServerProcess(file);
    assert.deepEqual(await exitWithin(notAFolder, 10_000), { code: 1, signal: null });
    assert.match(notAFolder.stderr(), /^라이브러리 폴더 (자리|경로)에 폴더가 아닌 파일이 있습니다 \((EEXIST|ENOTDIR)\): /m);
    assert.ok(notAFolder.stderr().includes(file));
    assert.doesNotMatch(notAFolder.stderr(), /\n\s+at /, 'no stack trace for a known problem');
  });

  test('stdin closed from the start (the shell is already gone): stops at once with exit 0', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const server = startServerProcess(library, {}, { stdin: 'ignore' });
    assert.deepEqual(await exitWithin(server, 8_000), { code: 0, signal: null });
    assert.match(server.stdout(), /stdin EOF: 종료하는 중/);
    assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false);
  });

  test('local mode only: remote settings in the environment are ignored with a warning', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const server = startServerProcess(library, { EASY_STUDY_HOST: '0.0.0.0', EASY_STUDY_AUTH: 'on' });
    const { url } = await waitForReady(server);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const status = (await (await fetch(`${url}/api/auth/status`)).json()) as { authRequired: boolean };
    assert.equal(status.authRequired, false, 'the app opens without an access code');
    assert.match(server.stderr(), /EASY_STUDY_HOST, EASY_STUDY_AUTH 설정은 데스크톱 앱에서 쓰지 않습니다/);
    assert.doesNotMatch(server.stdout(), /접속 코드/);
    server.child.stdin!.end();
    assert.equal((await exitWithin(server, 8_000)).code, 0);
  });

  // The one test of `npm test` that binds 0.0.0.0 (tests/auth.test.ts keeps EASY_STUDY_HOST=127.0.0.1 on purpose): a
  // macOS application firewall asks whether `node` may accept incoming connections each run. EASY_STUDY_TEST_NO_LAN=1
  // skips it (the desktopServerOptions test below keeps the contract; CI runs it).
  const NO_LAN = { skip: process.env.EASY_STUDY_TEST_NO_LAN === '1' ? 'EASY_STUDY_TEST_NO_LAN=1: the LAN-side bind is skipped' : false };

  test('EASY_STUDY_DESKTOP_SHARE=1: remote mode on every interface, the code only in .auth.json, the ready line lists the addresses', NO_LAN, async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const server = startServerProcess(library, { EASY_STUDY_DESKTOP_SHARE: '1' });
    const ready = (await waitForReady(server)) as { url: string; port: number; share?: { urls: string[] } };
    assert.equal(ready.url, `http://127.0.0.1:${ready.port}`, 'the shell still reaches it through loopback');
    assert.ok(Array.isArray(ready.share?.urls), 'share.urls');
    for (const url of ready.share!.urls) {
      assert.match(url, new RegExp(`^http://[^/]+:${ready.port}$`), url);
      assert.doesNotMatch(url, /127\.0\.0\.1|localhost|169\.254\./, url);
    }
    const line = server.stdout().split(/\r?\n/).find((l) => l.startsWith(READY_PREFIX))!;
    assert.deepEqual(Object.keys(JSON.parse(line.slice(READY_PREFIX.length + 1)) as object), ['url', 'port', 'share']);

    // Login required, from this computer too (loopback is never authentication, DESIGN §16).
    const status = (await (await fetch(`${ready.url}/api/auth/status`)).json()) as { authRequired: boolean; authenticated: boolean };
    assert.deepEqual(status, { authRequired: true, authenticated: false });
    const busyAnonymous = await fetch(`${ready.url}/api/desktop/busy`);
    assert.equal(busyAnonymous.status, 401);
    await busyAnonymous.arrayBuffer();

    // The code lives in the library's .auth.json, never on stdout (the shell copies stdout into server.log).
    const auth = JSON.parse(await fs.readFile(path.join(library, '.auth.json'), 'utf8')) as { code: string };
    assert.match(auth.code, /^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){3}$/);
    assert.doesNotMatch(server.stdout(), /접속 코드|login\?code/);
    assert.ok(!server.stdout().includes(auth.code) && !server.stderr().includes(auth.code), 'the code is never printed');
    assert.match(server.stdout(), /다른 기기에서\s+→/);

    // The shell logs its own window in with the code (303 + cookie) and probes the busy route as a bearer.
    const login = await fetch(`${ready.url}/login?code=${encodeURIComponent(auth.code)}`, { redirect: 'manual' });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/');
    assert.match(login.headers.get('set-cookie') ?? '', /^es_session=/);
    await login.arrayBuffer();
    const busy = await fetch(`${ready.url}/api/desktop/busy`, { headers: { Authorization: `Bearer ${auth.code}` } });
    assert.equal(busy.status, 200);
    assert.deepEqual(await busy.json(), { recording: null, transcriptions: 0, digests: 0, chatTurns: 0, modelDownloads: 0 });
    const wrong = await fetch(`${ready.url}/api/desktop/busy`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    await wrong.arrayBuffer();

    server.child.stdin!.end();
    assert.deepEqual(await exitWithin(server, 8_000), { code: 0, signal: null });

    // EASY_STUDY_DESKTOP_RESET_CODE=1 ("접속 코드 새로 만들기"): a new code at that start, the logins ended, said on stdout.
    const again = startServerProcess(library, { EASY_STUDY_DESKTOP_SHARE: '1', EASY_STUDY_DESKTOP_RESET_CODE: '1' });
    const readyAgain = await waitForReady(again);
    const renewed = JSON.parse(await fs.readFile(path.join(library, '.auth.json'), 'utf8')) as { code: string };
    assert.notEqual(renewed.code, auth.code);
    assert.match(again.stdout(), /이전 로그인은 모두 끊었습니다/);
    assert.ok(!again.stdout().includes(renewed.code));
    const old = await fetch(`${readyAgain.url}/api/desktop/busy`, { headers: { Authorization: `Bearer ${auth.code}` } });
    assert.equal(old.status, 401);
    await old.arrayBuffer();
    again.child.stdin!.end();
    assert.equal((await exitWithin(again, 8_000)).code, 0);
  });
});

// ---------------------------------------------------------------------------
// The routes of the app's updates and settings (DESIGN §24)
// ---------------------------------------------------------------------------

const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { version: string }).version;

/** The page actions the shell intercepts; one that gets through is 204 with no body, whatever its query. */
async function assertPageActionsAre204(url: string): Promise<void> {
  for (const p of ['/__easy-study-desktop/choose', '/__easy-study-desktop/theme/dark?from=test', '/__easy-study-desktop/unknown']) {
    const res = await fetch(url + p);
    assert.equal(res.status, 204, p);
    assert.equal(await res.text(), '', p);
    assert.equal(res.headers.get('cache-control'), 'no-store', p);
  }
  const post = await fetch(`${url}/__easy-study-desktop/choose`, { method: 'POST' });
  assert.notEqual(post.status, 204, 'only GET/HEAD');
  await post.arrayBuffer();
}

describe('desktop routes: busy check, page actions, version (DESIGN §24)', () => {
  test('desktop mode: GET /api/desktop/busy has counts and the live recording only; actions 204; health has the version', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    await writeReadyDoc(library);
    const server = startServerProcess(library, { EASY_STUDY_MODELS_DIR: await tempDir('easy-study-desktop-models-') });
    const { url } = await waitForReady(server);

    const health = (await (await fetch(`${url}/api/health`)).json()) as HealthResponse;
    assert.equal(health.version, PACKAGE_VERSION);

    const idle = await fetch(`${url}/api/desktop/busy`);
    assert.equal(idle.status, 200);
    assert.equal(idle.headers.get('cache-control'), 'no-store');
    assert.equal(idle.headers.get('access-control-allow-origin'), null, 'no CORS: other sites cannot read it');
    assert.deepEqual(await idle.json(), { recording: null, transcriptions: 0, digests: 0, chatTurns: 0, modelDownloads: 0 });

    // A live recording: its ids, status and titles (for the shell's warning), nothing else — no paths, no audio.
    const created = await fetch(`${url}/api/docs/${DOC_ID}/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '3주차 강의', liveTranscribe: false }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const recording = (await created.json()) as { id: string };
    const busy = await fetch(`${url}/api/desktop/busy`);
    const body = (await busy.json()) as DesktopBusyResponse;
    assert.deepEqual(body.recording, { id: recording.id, docId: DOC_ID, status: 'recording', title: '3주차 강의', docTitle: 'Deck' });
    assert.deepEqual(Object.keys(body).sort(), ['chatTurns', 'digests', 'modelDownloads', 'recording', 'transcriptions']);
    assert.ok(!JSON.stringify(body).includes(library), 'no library path');
    const paused = await fetch(`${url}/api/docs/${DOC_ID}/recordings/${recording.id}/pause`, { method: 'POST' });
    assert.equal(paused.status, 200, await paused.clone().text());
    assert.equal(((await (await fetch(`${url}/api/desktop/busy`)).json()) as DesktopBusyResponse).recording?.status, 'paused');

    await assertPageActionsAre204(url);
    server.child.stdin!.end();
    assert.equal((await exitWithin(server, 8_000)).code, 0);
  });

  test('outside desktop mode: no busy route (404, JSON), page actions still 204, health has the version', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const server = startServerProcess(library, {}, { desktop: false, stdin: 'ignore' });
    await waitFor('the banner', () => {
      if (server.child.exitCode !== null) assert.fail(`the server exited:\n${server.stdout()}\n${server.stderr()}`);
      return /library {5}→/.test(server.stdout());
    });
    const url = /→\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(server.stdout())![1];

    const busy = await fetch(`${url}/api/desktop/busy`);
    assert.equal(busy.status, 404);
    assert.match(busy.headers.get('content-type') ?? '', /application\/json/);
    await busy.arrayBuffer();
    assert.equal(((await (await fetch(`${url}/api/health`)).json()) as HealthResponse).version, PACKAGE_VERSION);
    await assertPageActionsAre204(url);
  });
});

// ---------------------------------------------------------------------------
// Dot folders: the Linux app's library is under ~/.local/share, the AppImage runs from /tmp/.mount_…
// ---------------------------------------------------------------------------

describe('files under a folder whose name starts with a dot', () => {
  test('slide images of a library under ~/.local/share-like folders are served (200); missing slides and ../ still 404', async () => {
    const library = path.join(await tempDir('easy-study-dot-'), '.local', 'share', 'dev.easystudy.desktop', 'library');
    await fs.mkdir(library, { recursive: true });
    await writeReadyDoc(library);
    const server = startServerProcess(library);
    const { url } = await waitForReady(server);
    const base = `${url}/api/docs/${DOC_ID}`;
    const got: string[] = [];
    for (const p of ['/slides/1.png', `/view/1.webp?w=${VIEW_WIDTHS[0]}`, '/view/2.webp', '/thumbs/3.webp']) {
      const res = await fetch(base + p);
      got.push(`${p} ${res.status} ${res.headers.get('content-type')}`);
      await res.arrayBuffer();
    }
    assert.deepEqual(got, [
      '/slides/1.png 200 image/png',
      `/view/1.webp?w=${VIEW_WIDTHS[0]} 200 image/webp`,
      '/view/2.webp 200 image/webp',
      '/thumbs/3.webp 200 image/webp',
    ]);
    for (const p of ['/slides/9.png', '/slides/..%2fdoc.json', '/slides/..%2F..%2Fdoc.json', '/thumbs/0.webp']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 404, p);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/, p);
      await res.arrayBuffer();
    }
    server.child.stdin!.end();
    assert.equal((await exitWithin(server, 8_000)).code, 0);
  });

  test('the web client installed under a dot folder (AppImage /tmp/.mount_…): pages 200, errors as plain text without paths', async () => {
    const { mountProductionClient } = await import('../server/index.ts');
    const express = (await import('express')).default;
    const dist = path.join(await tempDir('easy-study-dot-'), '.mount_easy-abc123', 'usr', 'lib', 'easy-study', 'web', 'dist');
    await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    await fs.writeFile(path.join(dist, 'assets', 'app-1234.js'), 'console.log(1)');
    await fs.writeFile(path.join(dist, '.secret'), 'no');
    const app = express();
    mountProductionClient(app, false, dist);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      for (const p of ['/', '/index.html', '/docs/some-doc/slide/3', '/.secret']) {
        const res = await fetch(url + p);
        assert.equal(res.status, 200, p);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/, p);
        assert.match(await res.text(), /<div id="root">/, p);
      }
      const asset = await fetch(`${url}/assets/app-1234.js`);
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), 'console.log(1)');

      // index.html gone (a broken install): 404 as plain text, not Express's page with the stack and the paths.
      await fs.rm(path.join(dist, 'index.html'));
      const missing = await fetch(`${url}/docs/x`);
      const body = await missing.text();
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get('content-type') ?? '', /text\/plain/);
      assert.doesNotMatch(body, /NotFoundError|\bat \w|\.mount_|index\.html/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('without EASY_STUDY_DESKTOP nothing changes', () => {
  for (const value of [undefined, '0']) {
    test(`EASY_STUDY_DESKTOP=${value ?? '(unset)'}: no ready line, stdin EOF is ignored, SIGTERM stops as before`, async () => {
      const library = await tempDir('easy-study-desktop-lib-');
      const server = startServerProcess(library, { EASY_STUDY_DESKTOP: value }, { desktop: false });
      await waitFor('the banner', () => {
        if (server.child.exitCode !== null) assert.fail(`the server exited:\n${server.stdout()}\n${server.stderr()}`);
        return /library {5}→/.test(server.stdout());
      });
      const url = /→\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(server.stdout())![1];
      assert.doesNotMatch(server.stdout(), /EASY_STUDY_READY|\(desktop\)/);

      server.child.stdin!.end(); // `npm start` with a closed stdin keeps running
      await sleep(400);
      assert.equal(server.child.exitCode, null, 'still running');
      assert.equal(((await (await fetch(`${url}/api/health`)).json()) as { ok: boolean }).ok, true);

      if (!POSIX) return; // Windows has no SIGTERM to send (kill() terminates at once); afterEach cleans up
      server.child.kill('SIGTERM');
      assert.deepEqual(await exitWithin(server, 8_000), { code: 0, signal: null });
      assert.match(server.stdout(), /SIGTERM: 종료하는 중/);
      assert.equal(await exists(path.join(library, SERVER_LOCK_FILE_NAME)), false);
    });
  }

  test('a locked library still gets the terminal instructions', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    await fs.writeFile(
      path.join(library, SERVER_LOCK_FILE_NAME),
      JSON.stringify({ pid: process.pid, port: 5999, startedAt: new Date().toISOString() }),
    );
    const server = startServerProcess(library, {}, { desktop: false, stdin: 'ignore' });
    assert.deepEqual(await exitWithin(server, 10_000), { code: 1, signal: null });
    assert.match(server.stderr(), /easy-study가 이미 이 라이브러리로 실행 중입니다/);
    assert.match(server.stderr(), /npm run serve/);
  });
});

// ---------------------------------------------------------------------------
// server/desktop.ts helpers
// ---------------------------------------------------------------------------

describe('desktop helpers', () => {
  test('desktopMode: EASY_STUDY_DESKTOP=1/true/on/yes or --desktop', () => {
    for (const value of ['1', 'true', 'ON', ' yes ']) assert.equal(desktopMode({ EASY_STUDY_DESKTOP: value }, []), true, value);
    for (const value of [undefined, '', '0', 'false', 'off', 'desktop']) {
      assert.equal(desktopMode({ EASY_STUDY_DESKTOP: value }, []), false, String(value));
    }
    assert.equal(desktopMode({}, ['--desktop']), true);
  });

  test('readyLine is one line of JSON after the prefix; shared servers add their addresses', () => {
    const line = readyLine('http://127.0.0.1:5351', 5351);
    assert.equal(line, 'EASY_STUDY_READY {"url":"http://127.0.0.1:5351","port":5351}');
    assert.deepEqual(JSON.parse(line.slice(READY_PREFIX.length + 1)), { url: 'http://127.0.0.1:5351', port: 5351 });
    assert.equal(
      readyLine('http://127.0.0.1:5351', 5351, { urls: ['http://192.168.0.10:5351', 'http://my-mac.local:5351'] }),
      'EASY_STUDY_READY {"url":"http://127.0.0.1:5351","port":5351,"share":{"urls":["http://192.168.0.10:5351","http://my-mac.local:5351"]}}',
    );
  });

  test('shareUrls: non-internal IPv4 addresses, physical adapters first, the host name last (not a bare Windows name)', () => {
    const iface = (address: string, internal = false, family: 'IPv4' | 'IPv6' = 'IPv4') => ({ address, netmask: '', family, mac: '', internal, cidr: null });
    const interfaces = {
      lo0: [iface('127.0.0.1', true)],
      utun3: [iface('100.101.102.103')],
      en0: [iface('192.168.0.10'), iface('fe80::1', false, 'IPv6')],
      bridge100: [iface('192.168.64.1')],
      en5: [iface('169.254.10.10')],
      en1: [iface('192.168.0.11'), iface('192.168.0.11')],
    } as unknown as ReturnType<typeof os.networkInterfaces>;
    assert.deepEqual(shareUrls(5350, interfaces, 'My-Mac.local', 'darwin'), [
      'http://192.168.0.10:5350',
      'http://192.168.0.11:5350',
      'http://100.101.102.103:5350',
      'http://192.168.64.1:5350',
      'http://my-mac.local:5350',
    ]);
    const windows = { 'vEthernet (WSL)': [iface('172.29.0.1')], 'Wi-Fi': [iface('192.168.0.20')], Tailscale: [iface('100.100.1.2')] } as unknown as ReturnType<typeof os.networkInterfaces>;
    assert.deepEqual(shareUrls(5350, windows, 'DESKTOP-ABC', 'win32'), ['http://192.168.0.20:5350', 'http://172.29.0.1:5350', 'http://100.100.1.2:5350']);
    assert.deepEqual(shareUrls(5350, windows, 'desktop-abc.home.arpa', 'win32').at(-1), 'http://desktop-abc.home.arpa:5350');
    assert.deepEqual(shareUrls(5350, {}, '192.168.0.10', 'linux'), [], 'a host name that is an address adds nothing');
    assert.deepEqual(shareUrls(5350, {}, 'bad host', 'linux'), []);
    assert.deepEqual([interfaceRank('en0'), interfaceRank('wlp2s0'), interfaceRank('Ethernet 2'), interfaceRank('utun4'), interfaceRank('docker0'), interfaceRank('vEthernet (Default Switch)'), interfaceRank('awdl0'), interfaceRank('foo0')], [0, 0, 0, 2, 2, 2, 2, 1]);
  });

  test('desktopShare / desktopResetCode: 1/true/on/yes (set only by the shell)', () => {
    for (const value of ['1', 'true', 'ON', ' yes ']) {
      assert.equal(desktopShare({ EASY_STUDY_DESKTOP_SHARE: value }), true, value);
      assert.equal(desktopResetCode({ EASY_STUDY_DESKTOP_RESET_CODE: value }), true, value);
    }
    for (const value of [undefined, '', '0', 'false', 'off', 'share']) {
      assert.equal(desktopShare({ EASY_STUDY_DESKTOP_SHARE: value }), false, String(value));
      assert.equal(desktopResetCode({ EASY_STUDY_DESKTOP_RESET_CODE: value }), false, String(value));
    }
  });

  test('desktopPort: unset = any free port, otherwise 0-65535', () => {
    assert.equal(desktopPort({}), 0);
    assert.equal(desktopPort({ PORT: ' ' }), 0);
    assert.equal(desktopPort({ PORT: '5351' }), 5351);
    assert.equal(desktopPort({ PORT: '0' }), 0);
    for (const bad of ['abc', '-1', '65536', '53.5', '0x10']) assert.throws(() => desktopPort({ PORT: bad }), ConfigError, bad);
  });

  test('desktopServerOptions: local mode on 127.0.0.1; the library folder is required', () => {
    assert.deepEqual(desktopServerOptions({ EASY_STUDY_LIBRARY: '/x/library', PORT: '5351', EASY_STUDY_HOST: '0.0.0.0' }), {
      port: 5351,
      host: '127.0.0.1',
      auth: 'off',
      password: null,
      tls: null,
      desktop: true,
    });
    assert.throws(() => desktopServerOptions({ PORT: '5351' }), (err: Error) => err instanceof ConfigError && /EASY_STUDY_LIBRARY/.test(err.message));
    assert.throws(() => desktopServerOptions({ EASY_STUDY_LIBRARY: '  ' }), ConfigError);
    // Sharing: every interface with the login on and a generated code (never EASY_STUDY_PASSWORD, never the user's auth setting).
    assert.deepEqual(desktopServerOptions({ EASY_STUDY_LIBRARY: '/x/library', PORT: '5351', EASY_STUDY_DESKTOP_SHARE: '1', EASY_STUDY_AUTH: 'off', EASY_STUDY_PASSWORD: 'secret-password' }), {
      port: 5351,
      host: '0.0.0.0',
      auth: 'on',
      password: null,
      tls: null,
      desktop: true,
    });
    assert.equal(desktopServerOptions({ EASY_STUDY_LIBRARY: '/x/library', EASY_STUDY_DESKTOP_SHARE: '1', EASY_STUDY_DESKTOP_RESET_CODE: '1' }).resetAccessCode, true);
    assert.equal('resetAccessCode' in desktopServerOptions({ EASY_STUDY_LIBRARY: '/x/library', EASY_STUDY_DESKTOP_RESET_CODE: '0' }), false);
  });

  test('ignoredNetworkSettings names only settings that would have changed something', () => {
    assert.deepEqual(ignoredNetworkSettings({ EASY_STUDY_HOST: '127.0.0.1', EASY_STUDY_AUTH: 'off' }), []);
    assert.deepEqual(
      ignoredNetworkSettings({ EASY_STUDY_HOST: '0.0.0.0', EASY_STUDY_AUTH: 'on', EASY_STUDY_TLS_CERT: 'c.pem', EASY_STUDY_TLS_KEY: 'k.pem' }),
      ['EASY_STUDY_HOST', 'EASY_STUDY_AUTH', 'EASY_STUDY_TLS_CERT', 'EASY_STUDY_TLS_KEY'],
    );
  });

  test('startupFailureMessage: Korean, what to do in the app, stack traces only for the unexpected', async () => {
    const library = await tempDir('easy-study-desktop-lib-');
    const saved = process.env.EASY_STUDY_LIBRARY;
    process.env.EASY_STUDY_LIBRARY = library;
    try {
      assert.deepEqual(startupFailureMessage(new ConfigError('PORT 값이 올바르지 않습니다'), 0), {
        known: true,
        exitCode: 1,
        message: '설정 오류: PORT 값이 올바르지 않습니다',
      });
      const locked = startupFailureMessage(new LibraryLockedError(path.join(library, '.server.lock'), { pid: 42, port: 5180, startedAt: '' }), 0);
      assert.equal(locked.known, true);
      assert.match(locked.message, /^이 라이브러리 폴더는 다른 easy-study가 이미 쓰고 있습니다 \(pid 42, 포트 5180\)\./);
      const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      assert.match(startupFailureMessage(inUse, 5351).message, /^포트 5351을\(를\) 다른 프로그램이/);
      assert.equal(startupFailureMessage(inUse, 5351).exitCode, EXIT_PORT_IN_USE);
      const denied = Object.assign(new Error('EACCES'), { code: 'EACCES', path: path.join(library, '.server.lock.1.tmp') });
      assert.equal(startupFailureMessage(denied, 0).message.split('\n')[0], `라이브러리 폴더에 쓸 권한이 없습니다 (EACCES): ${library}`);
      // Elsewhere than the library: not a library problem.
      const elsewhere = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/somewhere/else' });
      assert.deepEqual(startupFailureMessage(elsewhere, 0), { known: false, exitCode: 1, message: '서버를 시작하지 못했습니다: EACCES: permission denied' });
      assert.equal(startupFailureMessage('boom', 0).known, false);
    } finally {
      if (saved === undefined) delete process.env.EASY_STUDY_LIBRARY;
      else process.env.EASY_STUDY_LIBRARY = saved;
    }
  });

  test('watchShell: EOF, a stdin error or a gone parent report once; what is written is ignored', async () => {
    const reasons: string[] = [];
    const eof = new PassThrough();
    watchShell((reason) => reasons.push(reason), { stdin: eof, parentAlive: () => true });
    eof.write('anything the shell writes\n');
    await sleep(10);
    assert.equal(reasons.length, 0);
    eof.end();
    await sleep(10);
    eof.destroy();
    await sleep(10);
    assert.deepEqual(reasons, ['stdin EOF']);

    const failing = new PassThrough();
    const stopFailing = watchShell((reason) => reasons.push(reason), { stdin: failing, parentAlive: () => true });
    failing.destroy(new Error('EPIPE'));
    await sleep(10);
    assert.deepEqual(reasons.slice(1), ['stdin error']);
    stopFailing();

    let alive = true;
    const open = new PassThrough();
    const stop = watchShell((reason) => reasons.push(reason), { stdin: open, parentAlive: () => alive, intervalMs: 10 });
    await sleep(40);
    assert.equal(reasons.length, 2);
    alive = false;
    await waitFor('the watchdog', () => reasons.length === 3, 1_000);
    assert.match(reasons[2], /^parent \d+ is gone$/);
    await sleep(40);
    assert.equal(reasons.length, 3, 'once');
    stop();
    open.destroy();
  });

  test('shellAlive: POSIX compares the parent pid, Windows asks whether it still runs', () => {
    assert.equal(shellAlive(process.ppid, 'darwin'), true);
    assert.equal(shellAlive(process.ppid + 1_000_000, 'linux'), false);
    assert.equal(shellAlive(1, 'linux'), true, 'nothing to watch under init');
    assert.equal(shellAlive(process.pid, 'win32'), true);
    assert.equal(shellAlive(2 ** 30, 'win32'), false);
  });
});

// ---------------------------------------------------------------------------
// server/children.ts
// ---------------------------------------------------------------------------

function hangingNode(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  processes.push(child);
  return child;
}

const exitOf = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once('exit', () => resolve()));

describe('child process registry', () => {
  test('killRunningChildren kills what is still running and forgets it', async () => {
    const before = runningChildCount();
    const running = trackChild(hangingNode());
    const finished = trackChild(spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }));
    await exitOf(finished);
    assert.equal(runningChildCount(), before + 1);
    assert.equal(killRunningChildren(), before + 1);
    await exitOf(running);
    assert.ok(running.signalCode === 'SIGKILL' || running.exitCode !== null);
    assert.equal(runningChildCount(), 0);
    assert.equal(killRunningChildren(), 0);
  });

  test('a child that could not be started is not registered', async () => {
    const before = runningChildCount();
    const child = spawn(path.join(os.tmpdir(), 'easy-study-no-such-binary'), [], { stdio: 'ignore' });
    const failed = new Promise((resolve) => child.once('error', resolve));
    trackChild(child);
    assert.equal(runningChildCount(), before);
    await failed;
  });

  test('Windows: a CLI is killed with its whole tree (taskkill /T /F), a worker alone', async () => {
    const cli = trackChild(hangingNode(), { tree: true });
    const worker = trackChild(hangingNode());
    const calls: [string, string[]][] = [];
    assert.equal(
      killRunningChildren('win32', (file, args) => calls.push([file, args])),
      2,
    );
    assert.deepEqual(calls, [[calls[0][0], ['/PID', String(cli.pid), '/T', '/F']]]);
    assert.match(calls[0][0], /taskkill(\.exe)?$/i);
    await Promise.all([exitOf(cli), exitOf(worker)]);
  });

  test('CLI turns, version probes and PDF/image workers are registered while they run', async () => {
    const before = runningChildCount();
    const controller = new AbortController();
    const turn = runJsonlProcess({
      bin: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: os.tmpdir(),
      signal: controller.signal,
      onEvent: () => {},
    });
    assert.equal(runningChildCount(), before + 1, 'CLI');
    controller.abort();
    await assert.rejects(turn, { name: 'AbortError' });

    const probe = probeVersion({ bin: process.execPath, displayName: 'node', installHint: '' });
    assert.equal(runningChildCount(), before + 1, 'version probe');
    assert.equal((await probe).available, true);

    const docDir = await tempDir('easy-study-desktop-doc-');
    const worker = runPdfWorker({ kind: 'pdf', docDir, longEdge: 100 });
    assert.equal(runningChildCount(), before + 1, 'PDF worker');
    await assert.rejects(worker.done); // no source.pdf
    await waitFor('the registry to empty', () => runningChildCount() === before, 2_000);
  });

  test('at exit every child is killed, with the process group, and the exit code stays the one chosen', POSIX_ONLY, async () => {
    // A process that registers a child, which itself starts a grandchild, then exits with code 3.
    const script = `
      import { spawn } from 'node:child_process';
      import { signalProcessGroupOnExit, trackChild } from ${JSON.stringify(pathToFileURL(path.join(repoRoot(), 'server', 'children.ts')).href)};
      signalProcessGroupOnExit();
      const child = trackChild(spawn(process.execPath, ['-e', \`
        const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log(JSON.stringify({ child: process.pid, grandchild: g.pid }));
        setInterval(() => {}, 1000);
      \`], { stdio: ['ignore', 'pipe', 'ignore'] }), { tree: true });
      child.stdout.once('data', (line) => {
        process.stdout.write(line);
        setTimeout(() => process.exit(3), 50);
      });
    `;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    processes.push(parent);
    let out = '';
    let err = '';
    parent.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
    parent.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      parent.once('exit', (c, s) => resolve([c, s])),
    );
    assert.deepEqual([code, signal], [3, null], err);
    const pids = JSON.parse(out.trim()) as { child: number; grandchild: number };
    strayPids.push(pids.child, pids.grandchild);
    await waitFor('the child and grandchild to be gone', () => !isAlive(pids.child) && !isAlive(pids.grandchild), 3_000);
  });
});
