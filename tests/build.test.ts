// The production build (npm run build → scripts/build-server.mjs, DESIGN §15): the server compiled to plain
// JavaScript runs on its own — imports resolve, the repository paths are right, and the image worker is
// found as compiled JavaScript too.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { repoRoot } from '../server/config.ts';

const run = promisify(execFile);
const FIXTURES = path.join(repoRoot(), 'tests', 'fixtures');

/**
 * The compiled server's environment: health detects the LLM CLIs, so they are the fixtures' fakes (no real CLI is
 * started, e.g. `codex debug models` reading the account's catalog) and no real Codex configuration is read.
 */
function serverEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_BIN: path.join(FIXTURES, 'fake-claude.mjs'),
    CODEX_BIN: path.join(FIXTURES, 'fake-codex.mjs'),
    CODEX_HOME: path.join(os.tmpdir(), 'easy-study-build-test-no-codex-home'),
    PORT: '0',
    EASY_STUDY_AUTO_DIGEST: '0',
    ...env,
  };
}

describe('compiled server (dist-server)', () => {
  // Inside the repository like dist-server/ (the compiled server finds package.json upwards) but ignored by git.
  const outDir = path.join(repoRoot(), 'node_modules', '.cache', `easy-study-build-test-${process.pid}`);
  let library = '';

  before(async () => {
    library = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-build-'));
  });

  after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(library, { recursive: true, force: true });
  });

  test('builds, starts with a small young generation, converts a PDF and serves the derived images', async () => {
    await run(process.execPath, [path.join(repoRoot(), 'scripts', 'build-server.mjs'), '--out', outDir], { cwd: repoRoot() });
    const entry = path.join(outDir, 'server', 'index.js');
    const source = await fs.readFile(entry, 'utf8');
    assert.doesNotMatch(source, /from '\.[^']*\.ts'/, 'relative imports point at .js files');
    await fs.access(path.join(outDir, 'server', 'imageWorker.js'));
    // The PDF engine is compiled too, and the worker imports it as JavaScript (DESIGN §17).
    await fs.access(path.join(outDir, 'server', 'pdf.js'));
    assert.match(await fs.readFile(path.join(outDir, 'server', 'imageWorker.js'), 'utf8'), /import\('\.\/pdf\.js'\)/);
    await fs.access(path.join(outDir, 'shared', 'types.js'));
    // The slide aligner of lecture recordings runs its compiled file as a worker thread (DESIGN §22).
    const aligner = (await import(pathToFileURL(path.join(outDir, 'server', 'recordings', 'align', 'worker.js')).href)) as typeof import('../server/recordings/align/worker.ts');
    assert.deepEqual(
      await aligner.alignInWorker({
        slideTexts: ['FIRST sets 퍼스트', 'FOLLOW sets 팔로우'],
        segments: [
          { start: 0, end: 4, text: '퍼스트 셋을 계산합니다' },
          { start: 4, end: 8, text: '팔로우 셋은 다음에 오는 터미널' },
        ],
      }),
      [1, 2],
    );

    const child = spawn(process.execPath, ['--max-semi-space-size=2', entry], {
      cwd: os.tmpdir(), // nothing may depend on the working directory
      env: serverEnv({ EASY_STUDY_LIBRARY: library }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      const deadline = Date.now() + 20_000;
      let base = '';
      while (!base) {
        base = /→\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1] ?? '';
        if (!base && (Date.now() > deadline || child.exitCode !== null)) assert.fail(`server did not start:\n${stdout}\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; libraryDir: string };
      assert.equal(health.ok, true);
      assert.equal(health.libraryDir, path.resolve(library));

      const pdf = await fs.readFile(path.join(repoRoot(), 'samples', 'sample-lecture.pdf'));
      const created = (await (
        await fetch(`${base}/api/docs`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf })
      ).json()) as { id: string };
      const docDir = path.join(library, created.id);
      // Ready, and the last derived file (the inline JPEG of the last contact sheet) written by the compiled worker.
      const lastDerived = path.join(docDir, 'inline', 'sheets-sheet-03.jpg');
      while (
        (await fs.access(lastDerived).then(
          () => false,
          () => true,
        )) ||
        ((await (await fetch(`${base}/api/docs/${created.id}`)).json()) as { status: string }).status !== 'ready'
      ) {
        if (Date.now() > deadline + 40_000) assert.fail(`ingest did not finish:\n${stdout}\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (const [p, type] of [
        ['/slides/1.png', 'image/png'],
        ['/view/1.webp?w=1000', 'image/webp'],
        ['/thumbs/9.webp', 'image/webp'],
      ]) {
        const res = await fetch(`${base}/api/docs/${created.id}${p}`);
        assert.equal(res.status, 200, p);
        assert.equal(res.headers.get('content-type'), type, p);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', p);
        await res.arrayBuffer();
      }
      assert.equal((await fs.readdir(path.join(docDir, 'view'))).length, 18);

      // Attachments (DESIGN §21) are made by the compiled worker too: a region (crop + PDF text) and an upload.
      const regionRes = await fetch(`${base}/api/docs/${created.id}/regions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slide: 5, rect: { x: 0, y: 0, w: 1, h: 0.2 } }),
      });
      const region = (await regionRes.json()) as { id: string; text: string; error?: string };
      assert.equal(regionRes.status, 201, region.error ?? '');
      assert.equal(region.text, 'First-Come, First-Served (FCFS)');
      const slide = await fs.readFile(path.join(docDir, 'slides', '001.png'));
      const uploadRes = await fetch(`${base}/api/docs/${created.id}/attachments`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: slide });
      const uploaded = (await uploadRes.json()) as { id: string; width: number; error?: string };
      assert.equal(uploadRes.status, 201, uploaded.error ?? '');
      assert.equal(uploaded.width, 1568);
      for (const id of [region.id, uploaded.id]) {
        const res = await fetch(`${base}/api/docs/${created.id}/attachments/${id}`);
        assert.equal(res.status, 200, id);
        assert.match(res.headers.get('content-type') ?? '', /^image\/(jpeg|png)$/);
        await res.arrayBuffer();
      }
    } finally {
      child.kill('SIGTERM');
    }
    assert.equal(await exited, 0, stderr);
    await assert.rejects(fs.access(path.join(library, '.server.lock')), 'the lock is released on SIGTERM');

    // The desktop app runs this compiled server in desktop mode (DESIGN §19): one ready line, stop on stdin EOF.
    const desktop = spawn(process.execPath, ['--max-semi-space-size=2', entry], {
      cwd: os.tmpdir(),
      env: serverEnv({ EASY_STUDY_DESKTOP: '1', EASY_STUDY_LIBRARY: library }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let desktopOut = '';
    let desktopErr = '';
    desktop.stdout.on('data', (chunk: Buffer) => (desktopOut += chunk.toString()));
    desktop.stderr.on('data', (chunk: Buffer) => (desktopErr += chunk.toString()));
    const desktopExited = new Promise<number | null>((resolve) => desktop.once('exit', resolve));
    try {
      const deadline = Date.now() + 20_000;
      let ready: { url: string; port: number } | null = null;
      while (!ready) {
        const line = /^EASY_STUDY_READY (\{.*\})$/m.exec(desktopOut)?.[1];
        if (line) ready = JSON.parse(line) as { url: string; port: number };
        else if (Date.now() > deadline || desktop.exitCode !== null) assert.fail(`no ready line:\n${desktopOut}\n${desktopErr}`);
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(ready.url, `http://127.0.0.1:${ready.port}`);
      assert.equal(((await (await fetch(`${ready.url}/api/health`)).json()) as { ok: boolean }).ok, true);
    } finally {
      desktop.stdin.end();
    }
    assert.equal(await desktopExited, 0, desktopErr);
    await assert.rejects(fs.access(path.join(library, '.server.lock')), 'the lock is released on stdin EOF');
  });
});
