// The image worker (server/imageWorker.ts, DESIGN §15): contact sheets and derived images in a short-lived
// child process, and a server that never loads sharp itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { INLINE_MAX_BYTES, INLINE_MAX_EDGE, THUMB_WIDTH, VIEW_WIDTHS, inlinePathFor, thumbPath, viewPath } from '../server/assets.ts';
import { repoRoot } from '../server/config.ts';
import { imageWorkerPath, isImageWorkerStopped, runImageWorker } from '../server/imageWorker.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-worker-'));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A document directory with `count` rendered slides (1600x900 PNGs), like pdftoppm leaves them. */
async function makeDocDir(name: string, count: number): Promise<{ docDir: string; slides: string[] }> {
  const docDir = path.join(tmpRoot, name);
  await fs.mkdir(path.join(docDir, 'slides'), { recursive: true });
  const slides: string[] = [];
  for (let n = 1; n <= count; n++) {
    const file = `${String(n).padStart(3, '0')}.png`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#fff"/><text x="80" y="200" font-size="120">Slide ${n}</text><rect x="80" y="400" width="${200 * n}" height="200" fill="#36c"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(docDir, 'slides', file));
    slides.push(file);
  }
  return { docDir, slides };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

describe('image worker', () => {
  test('builds the contact sheets first, then every derived image; a second run writes nothing', async () => {
    const { docDir, slides } = await makeDocDir('deck', 5);
    const run = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
    const sheets = await run.sheets;
    assert.deepEqual(sheets, [
      { file: 'sheet-01.png', fromSlide: 1, toSlide: 4 },
      { file: 'sheet-02.png', fromSlide: 5, toSlide: 5 },
    ]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(docDir, 'sheets', 'sheets.json'), 'utf8')), sheets);
    const result = await run.done;
    assert.deepEqual(result.failed, []);
    assert.equal(result.written, 5 * (VIEW_WIDTHS.length + 2) + 2);
    assert.deepEqual(result.sheets, sheets);

    const full = await sharp(path.join(docDir, 'sheets', 'sheet-01.png')).metadata();
    assert.equal(full.width, 1600);
    for (const slide of slides) {
      for (const width of VIEW_WIDTHS) assert.equal((await sharp(viewPath(docDir, slide, width)).metadata()).width, width);
      assert.equal((await sharp(thumbPath(docDir, slide)).metadata()).width, THUMB_WIDTH);
      const inline = inlinePathFor(path.join(docDir, 'slides', slide));
      assert.ok(inline && (await exists(inline)));
    }
    for (const sheet of sheets) {
      const inline = inlinePathFor(path.join(docDir, 'sheets', sheet.file));
      assert.equal(inline, path.join(docDir, 'inline', `sheets-${sheet.file.replace('.png', '.jpg')}`));
      assert.ok(await exists(inline));
    }

    const again = await runImageWorker({ docDir, slides, derived: true }).done;
    assert.deepEqual(again, { sheets: null, written: 0, failed: [] });

    // Only what is missing is written again (sheet files come from sheets.json).
    await fs.rm(thumbPath(docDir, slides[2]));
    await fs.rm(inlinePathFor(path.join(docDir, 'sheets', 'sheet-02.png'))!);
    assert.equal((await runImageWorker({ docDir, slides, derived: true }).done).written, 2);
  });

  test('inline JPEGs step the quality (then the size) down until they fit INLINE_MAX_BYTES', async () => {
    const docDir = path.join(tmpRoot, 'noisy');
    await fs.mkdir(path.join(docDir, 'slides'), { recursive: true });
    // Noise does not compress: the first qualities are far too large.
    await sharp({ create: { width: 1600, height: 1600, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 90 } } })
      .png()
      .toFile(path.join(docDir, 'slides', '001.png'));
    const result = await runImageWorker({ docDir, slides: ['001.png'], derived: true }).done;
    assert.deepEqual(result.failed, []);
    const bytes = await fs.readFile(inlinePathFor(path.join(docDir, 'slides', '001.png'))!);
    assert.ok(bytes.length <= INLINE_MAX_BYTES, `${bytes.length} bytes`);
    const info = await sharp(bytes).metadata();
    assert.equal(info.format, 'jpeg');
    assert.ok(Math.max(info.width ?? 0, info.height ?? 0) < INLINE_MAX_EDGE, 'made smaller as well');
  });

  test('an unreadable slide fails only its own files; unreadable slides fail the contact sheets', async () => {
    const { docDir, slides } = await makeDocDir('broken', 2);
    await fs.writeFile(path.join(docDir, 'slides', slides[1]), 'not a png');
    const result = await runImageWorker({ docDir, slides, derived: true }).done;
    assert.equal(result.written, VIEW_WIDTHS.length + 2);
    assert.equal(result.failed.length, VIEW_WIDTHS.length + 2);
    assert.ok(result.failed.every((failure) => failure.file.includes('002')));
    assert.equal(await exists(viewPath(docDir, slides[1], 1000)), false);

    const run = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
    await assert.rejects(run.sheets);
    await assert.rejects(run.done, (err: unknown) => err instanceof Error && !isImageWorkerStopped(err));
  });

  test('kill() stops the worker; partial files never exist; invalid jobs are refused', async () => {
    const { docDir, slides } = await makeDocDir('killed', 12);
    // kill() right away lands before the child's 'spawn' event, so the job is never sent. That is a stop
    // too, never 'could not be started' (EPIPE/ENOTCONN); repeated because the timing varies per run.
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
      run.kill();
      await assert.rejects(run.done, (err: unknown) => isImageWorkerStopped(err));
      await assert.rejects(run.sheets);
    }
    // kill() while the worker is busy with the derived images (the job was sent and the sheets are done).
    const busy = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
    await busy.sheets;
    busy.kill();
    await assert.rejects(busy.done, (err: unknown) => isImageWorkerStopped(err));
    for (const dir of ['view', 'thumbs', 'inline']) {
      const names = await fs.readdir(path.join(docDir, dir)).catch(() => [] as string[]);
      assert.ok(!names.some((name) => name.endsWith('.tmp')), `${dir}: ${names.join(', ')}`);
    }

    await assert.rejects(runImageWorker({ docDir, slides: ['../../etc/passwd.png'], derived: true }).done, /invalid image job/);
    await assert.rejects(runImageWorker({ docDir: 'relative/dir', slides, derived: true }).done, /invalid image job/);
  });

  test('the worker is this very module, run by the same Node executable', () => {
    assert.equal(imageWorkerPath(), path.join(repoRoot(), 'server', 'imageWorker.ts'));
  });
});

describe('the server process never loads sharp', () => {
  test('import, ingest, derived images and every image route run without sharp in the server', async () => {
    const library = await fs.mkdtemp(path.join(tmpRoot, 'library-'));
    const script = path.join(tmpRoot, 'no-sharp.mjs');
    await fs.writeFile(
      script,
      `import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({
  resolve(specifier, context, next) {
    if (/^(sharp|@img\\/)/.test(specifier)) loaded.push(specifier);
    return next(specifier, context);
  },
});
const { startServer } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot(), 'server', 'index.ts')).href)});
const library = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot(), 'server', 'library.ts')).href)});
const fs = await import('node:fs/promises');
const server = await startServer({ port: 0, log: false, resumeIngests: false });
const pdf = await fs.readFile(${JSON.stringify(path.join(repoRoot(), 'samples', 'sample-lecture.pdf'))});
const created = await (await fetch(server.url + '/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf })).json();
await library.waitForIngest(created.id);
const meta = await (await fetch(server.url + '/api/docs/' + created.id)).json();
const types = [];
for (const p of ['/slides/1.png', '/view/1.webp?w=1000', '/view/2.webp', '/thumbs/3.webp']) {
  const res = await fetch(server.url + '/api/docs/' + created.id + p);
  types.push(res.status + ' ' + res.headers.get('content-type'));
  await res.arrayBuffer();
}
await server.close();
console.log(JSON.stringify({ status: meta.status, types, loaded }));
`,
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, EASY_STUDY_LIBRARY: library, EASY_STUDY_AUTO_DIGEST: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, stderr);
    const report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { status: string; types: string[]; loaded: string[] };
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.types, ['200 image/png', '200 image/webp', '200 image/webp', '200 image/webp']);
    assert.deepEqual(report.loaded, [], 'sharp was resolved in the server process');
  });
});
