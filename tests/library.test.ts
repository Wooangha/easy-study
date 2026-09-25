// Ingest pipeline end-to-end on samples/sample-lecture.pdf (PDFium-wasm, no external tools), plus import validation,
// deleting / retrying documents and the single-instance library lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { DOC_ID_RE } from '../shared/types.ts';
import type { DigestSlide, DocMeta } from '../shared/types.ts';
import { INLINE_MAX_BYTES, INLINE_MAX_EDGE, THUMB_WIDTH, VIEW_WIDTHS, inlinePathFor, thumbPath, viewPath } from '../server/assets.ts';
import { HttpError, autoDigestEnabled, digestConcurrency, fallbackFontProblem, findPackageRoot, libraryDir, repoRoot } from '../server/config.ts';
import { envCommand, startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import type { CourseRecord, DigestRecord, SessionRecord } from '../server/internal-types.ts';
import {
  LibraryLockedError,
  MAX_INGEST_WORKERS,
  acquireServerLock,
  coursePaths,
  createSlots,
  deleteDoc,
  demoteHeadings,
  docPaths,
  getDoc,
  importPdf,
  ingestLoad,
  isDigestComplete,
  isIngestRunning,
  listDocs,
  loadDocAssets,
  pngAspectRatio,
  progressThrottle,
  readDigestRecord,
  readStoredDoc,
  removeDeletedLeftovers,
  resumePendingIngests,
  retryIngest,
  serverLockPath,
  slideFileName,
  slugify,
  startBackfill,
  stopImageWork,
  textFileName,
  waitForBackfill,
  waitForIngest,
  withFsRetry,
  writeFileAtomic,
} from '../server/library.ts';
import type { ServerLockInfo, StoredDocMeta } from '../server/library.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE } from '../server/pageNames.ts';
import { GARBAGE_PDF, baselinePdf, cjkPdf, deckPdf, encryptedPdf, symbolFontPdf } from './pdfFixtures.ts';

const SAMPLE_PDF = path.join(repoRoot(), 'samples', 'sample-lecture.pdf');
let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-library-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Every derived image a converted document should have (server/assets.ts). */
function expectedDerivedFiles(docId: string, pageCount: number, sheetFiles: string[]): string[] {
  const paths = docPaths(docId);
  const files: string[] = [];
  for (let n = 1; n <= pageCount; n++) {
    const slide = slideFileName(n, pageCount);
    for (const width of VIEW_WIDTHS) files.push(viewPath(paths.dir, slide, width));
    files.push(thumbPath(paths.dir, slide), inlinePathFor(path.join(paths.slidesDir, slide)) ?? '');
  }
  for (const sheet of sheetFiles) files.push(inlinePathFor(path.join(paths.sheetsDir, sheet)) ?? '');
  return files;
}

async function waitUntilSettled(docId: string, timeoutMs = 60_000): Promise<DocMeta> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = await getDoc(docId);
    assert.ok(meta, 'doc.json must exist');
    if (meta.status !== 'processing') return meta;
    if (Date.now() > deadline) throw new Error(`ingest of ${docId} did not finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('config', () => {
  test('libraryDir follows EASY_STUDY_LIBRARY (read lazily)', () => {
    assert.equal(libraryDir(), path.resolve(tmpRoot));
  });

  test('digest concurrency and auto digest come from the environment', () => {
    const saved = { c: process.env.EASY_STUDY_DIGEST_CONCURRENCY, a: process.env.EASY_STUDY_AUTO_DIGEST };
    try {
      delete process.env.EASY_STUDY_DIGEST_CONCURRENCY;
      assert.equal(digestConcurrency(), 1);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = '3';
      assert.equal(digestConcurrency(), 3);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = '0';
      assert.equal(digestConcurrency(), 1);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = '99';
      assert.equal(digestConcurrency(), 8);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = 'lots';
      assert.equal(digestConcurrency(), 1);

      delete process.env.EASY_STUDY_AUTO_DIGEST;
      assert.equal(autoDigestEnabled(), true);
      process.env.EASY_STUDY_AUTO_DIGEST = '0';
      assert.equal(autoDigestEnabled(), false);
      process.env.EASY_STUDY_AUTO_DIGEST = 'off';
      assert.equal(autoDigestEnabled(), false);
      process.env.EASY_STUDY_AUTO_DIGEST = '1';
      assert.equal(autoDigestEnabled(), true);
    } finally {
      if (saved.c === undefined) delete process.env.EASY_STUDY_DIGEST_CONCURRENCY;
      else process.env.EASY_STUDY_DIGEST_CONCURRENCY = saved.c;
      if (saved.a === undefined) delete process.env.EASY_STUDY_AUTO_DIGEST;
      else process.env.EASY_STUDY_AUTO_DIGEST = saved.a;
    }
  });
});

test('fallbackFontProblem: EASY_STUDY_PDF_FALLBACK_FONT must name a readable file (checked at startup)', async () => {
  const font = path.join(tmpRoot, 'font-check.ttf');
  await fs.writeFile(font, 'not really a font, but a readable file');
  assert.equal(fallbackFontProblem({}), null);
  assert.equal(fallbackFontProblem({ EASY_STUDY_PDF_FALLBACK_FONT: '  ' }), null);
  assert.equal(fallbackFontProblem({ EASY_STUDY_PDF_FALLBACK_FONT: font }), null);
  const missing = path.join(tmpRoot, 'no-such-font.ttf');
  const problem = fallbackFontProblem({ EASY_STUDY_PDF_FALLBACK_FONT: missing }) ?? '';
  assert.ok(problem.includes(`${missing} (ENOENT)`), problem);
  assert.match(fallbackFontProblem({ EASY_STUDY_PDF_FALLBACK_FONT: tmpRoot }) ?? '', /파일이 아닙니다/);
});

test('repoRoot is the directory with package.json, from server/ and from the compiled dist-server/server/', async () => {
  await fs.access(path.join(repoRoot(), 'package.json'));
  await fs.access(path.join(repoRoot(), 'server', 'index.ts'));
  assert.equal(findPackageRoot(path.join(repoRoot(), 'server')), repoRoot());
  assert.equal(findPackageRoot(path.join(repoRoot(), 'dist-server', 'server')), repoRoot());
  assert.equal(findPackageRoot(path.parse(repoRoot()).root), null);
});

describe('slugify / file names', () => {
  test('ascii slug, max 40 chars, fallback doc', () => {
    assert.equal(slugify('OS 101 — Lecture 5: CPU Scheduling!'), 'os-101-lecture-5-cpu-scheduling');
    assert.equal(slugify('운영체제'), 'doc');
    assert.equal(slugify('컴파일러', 'course'), 'course');
    assert.equal(slugify('Café Théorie'), 'cafe-theorie');
    const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    assert.ok(long.length <= 40 && !long.endsWith('-'), long);
  });

  test('slide file names are zero padded to 3 digits (more for > 999 pages)', () => {
    assert.equal(slideFileName(7, 42), '007.png');
    assert.equal(slideFileName(12, 1200), '0012.png');
  });
});

describe('ingest of the sample deck', () => {
  let meta: DocMeta;

  before(async () => {
    const bytes = await fs.readFile(SAMPLE_PDF);
    // macOS hands out NFD file names; the title must come back NFC with its Hangul intact.
    const initial = await importPdf(bytes, '운영체제 5강 CPU Scheduling.pdf'.normalize('NFD'));
    assert.equal(initial.status, 'processing');
    assert.equal(initial.progress, 0);
    await waitForIngest(initial.id);
    meta = await waitUntilSettled(initial.id);
  });

  test('doc.json is ready with page count, progress and aspect ratio', async () => {
    assert.equal(meta.status, 'ready', meta.error ?? '');
    assert.equal(meta.courseId, null);
    assert.equal(meta.digestStatus, 'none');
    // Derived fields are never stored.
    const onDisk = JSON.parse(await fs.readFile(docPaths(meta.id).docJson, 'utf8'));
    assert.equal('courseId' in onDisk, false);
    assert.equal('digestStatus' in onDisk, false);
    assert.equal(meta.error, undefined);
    assert.equal(meta.pageCount, 9);
    assert.equal(meta.progress, 9);
    assert.ok(Math.abs(meta.aspectRatio - 16 / 9) < 0.01, `aspectRatio ${meta.aspectRatio}`);
    assert.equal(meta.title, '운영체제 5강 CPU Scheduling');
    assert.equal(meta.fileName, '운영체제 5강 CPU Scheduling.pdf');
    assert.match(meta.id, DOC_ID_RE);
    assert.match(meta.id, /^5-cpu-scheduling-[0-9a-f]{6}$/);
    assert.ok(!Number.isNaN(Date.parse(meta.createdAt)));
  });

  test('9 slides rendered at 1600px long edge as 001.png..009.png', async () => {
    const paths = docPaths(meta.id);
    const files = (await fs.readdir(paths.slidesDir)).sort();
    assert.deepEqual(files, Array.from({ length: 9 }, (_, i) => slideFileName(i + 1, 9)));
    const { width, height } = await sharp(path.join(paths.slidesDir, '001.png')).metadata();
    assert.equal(Math.max(width ?? 0, height ?? 0), 1600);
  });

  test('9 text files, split per page and trimmed, then the marker of the text engine', async () => {
    const paths = docPaths(meta.id);
    const files = (await fs.readdir(paths.textDir)).sort();
    assert.deepEqual(files, [TEXT_ENGINE_FILE, ...Array.from({ length: 9 }, (_, i) => textFileName(i + 1, 9))]);
    assert.equal(await fs.readFile(path.join(paths.textDir, TEXT_ENGINE_FILE), 'utf8'), `${TEXT_ENGINE}\n`);
    const first = await fs.readFile(path.join(paths.textDir, '001.txt'), 'utf8');
    assert.match(first, /^Lecture 5: CPU Scheduling/);
    const fourth = await fs.readFile(path.join(paths.textDir, '004.txt'), 'utf8');
    assert.match(fourth, /Scheduling Criteria/);
    assert.equal(fourth, fourth.trim());
    assert.ok(!fourth.includes('\f'));
  });

  test('3 contact sheets with sheets.json ranges, long edge <= 1600', async () => {
    const paths = docPaths(meta.id);
    const sheets = JSON.parse(await fs.readFile(paths.sheetsJson, 'utf8'));
    assert.deepEqual(sheets, [
      { file: 'sheet-01.png', fromSlide: 1, toSlide: 4 },
      { file: 'sheet-02.png', fromSlide: 5, toSlide: 8 },
      { file: 'sheet-03.png', fromSlide: 9, toSlide: 9 },
    ]);
    for (const sheet of sheets as Array<{ file: string }>) {
      const { width = 0, height = 0 } = await sharp(path.join(paths.sheetsDir, sheet.file)).metadata();
      assert.ok(Math.max(width, height) <= 1600, `${sheet.file}: ${width}x${height}`);
    }
    // 2x2 sheet: wider than tall for a 16:9 deck; the single-slide sheet is one column.
    const full = await sharp(path.join(paths.sheetsDir, 'sheet-01.png')).metadata();
    assert.equal(full.width, 1600);
    const single = await sharp(path.join(paths.sheetsDir, 'sheet-03.png')).metadata();
    assert.ok((single.width ?? 0) < 1000);
  });

  test('derived images: WebP view renditions and thumbnails per slide, inline JPEGs per slide and sheet', async () => {
    const paths = docPaths(meta.id);
    for (let n = 1; n <= 9; n++) {
      const slide = slideFileName(n, 9);
      for (const width of VIEW_WIDTHS) {
        const view = await sharp(viewPath(paths.dir, slide, width)).metadata();
        assert.equal(view.format, 'webp');
        assert.equal(view.width, width);
      }
      const thumb = await sharp(thumbPath(paths.dir, slide)).metadata();
      assert.equal(thumb.format, 'webp');
      assert.equal(thumb.width, THUMB_WIDTH);
    }
    const sheets = ['sheet-01.png', 'sheet-02.png', 'sheet-03.png'];
    for (const png of [...Array.from({ length: 9 }, (_, i) => path.join(paths.slidesDir, slideFileName(i + 1, 9))), ...sheets.map((sheet) => path.join(paths.sheetsDir, sheet))]) {
      const jpeg = inlinePathFor(png);
      assert.ok(jpeg);
      const bytes = await fs.readFile(jpeg);
      assert.ok(bytes.length <= INLINE_MAX_BYTES, `${jpeg}: ${bytes.length} bytes`);
      const info = await sharp(bytes).metadata();
      assert.equal(info.format, 'jpeg');
      assert.ok(Math.max(info.width ?? 0, info.height ?? 0) <= INLINE_MAX_EDGE);
    }
    assert.equal((await fs.readdir(paths.inlineDir)).filter((name) => name.startsWith('sheets-')).length, 3);
    const all = [...(await fs.readdir(paths.viewDir)), ...(await fs.readdir(paths.thumbsDir)), ...(await fs.readdir(paths.inlineDir))];
    assert.equal(all.length, expectedDerivedFiles(meta.id, 9, sheets).length);
    assert.ok(!all.some((name) => name.endsWith('.tmp')));
  });

  test('loadDocAssets exposes texts, slide paths and sheets', async () => {
    const assets = await loadDocAssets(meta.id);
    assert.equal(assets.meta.id, meta.id);
    assert.equal(assets.digest, null);
    assert.equal(assets.digestComplete, false);
    assert.equal(assets.course, null);
    assert.equal(assets.dir, docPaths(meta.id).dir);
    assert.equal(assets.texts.length, 9);
    assert.match(assets.texts[4], /First-Come, First-Served/);
    assert.equal(assets.slidePath(3), path.join(docPaths(meta.id).slidesDir, '003.png'));
    await fs.access(assets.slidePath(9));
    assert.equal(assets.sheets.length, 3);
    for (const sheet of assets.sheets) {
      assert.ok(path.isAbsolute(sheet.path));
      await fs.access(sheet.path);
    }
    assert.deepEqual(
      assets.sheets.map((s) => [s.fromSlide, s.toSlide]),
      [
        [1, 4],
        [5, 8],
        [9, 9],
      ],
    );
  });

  test('listDocs is newest first; getDoc rejects invalid ids', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await importPdf(await fs.readFile(SAMPLE_PDF), 'Second Deck.pdf');
    await waitForIngest(second.id);
    const docs = await listDocs();
    assert.deepEqual(
      docs.slice(0, 2).map((d) => d.id),
      [second.id, meta.id],
    );
    assert.equal(await getDoc('../etc'), null);
    assert.equal(await getDoc('Nope'), null);
    assert.equal(await getDoc('missing-000000'), null);
  });

  test('resumePendingIngests re-processes a doc left in processing', async () => {
    const source = docPaths(meta.id);
    const docId = 'crashed-abc123';
    const target = docPaths(docId);
    await fs.mkdir(target.slidesDir, { recursive: true });
    await fs.copyFile(source.sourcePdf, target.sourcePdf);
    await fs.writeFile(path.join(target.slidesDir, 'p-1.png'), 'partial garbage');
    const stale: DocMeta = { ...meta, id: docId, status: 'processing', progress: 3, createdAt: new Date().toISOString() };
    await fs.writeFile(target.docJson, JSON.stringify(stale));

    await resumePendingIngests();
    const resumed = await getDoc(docId);
    assert.equal(resumed?.status, 'ready', resumed?.error ?? '');
    assert.equal(resumed?.progress, 9);
    assert.equal((await fs.readdir(target.slidesDir)).length, 9);
  });

  test('resumed documents waiting for their turn show progress 0, not the progress of the interrupted run', async () => {
    const source = docPaths(meta.id);
    const ids = ['stalled-aaa111', 'stalled-bbb222', 'stalled-ccc333'];
    for (const [i, docId] of ids.entries()) {
      const target = docPaths(docId);
      await fs.mkdir(target.dir, { recursive: true });
      await fs.copyFile(source.sourcePdf, target.sourcePdf);
      const stale: DocMeta = { ...meta, id: docId, status: 'processing', progress: 5 + i, createdAt: new Date().toISOString() };
      await fs.writeFile(target.docJson, JSON.stringify(stale));
    }
    const run = resumePendingIngests();
    // One converts at a time; the others wait.
    await waitFor(() => ids.some((id) => isIngestRunning(id)));
    const waiting = ids.filter((id) => !isIngestRunning(id));
    assert.equal(waiting.length, 2);
    for (const id of waiting) {
      const doc = await readStoredDoc(id);
      if (doc?.status === 'processing') assert.equal(doc.progress, 0, `${id} waits at 0`);
    }
    await run;
    for (const id of ids) assert.equal((await readStoredDoc(id))?.status, 'ready');
  });
});

describe('ingest progress (PDF worker → doc.json)', () => {
  test('progressThrottle: the first report at once, then one per interval, and always the last page', () => {
    let now = 1_000;
    const shouldWrite = progressThrottle(400, () => now);
    const written: number[] = [];
    for (const [rendered, time] of [
      [1, 1_000],
      [2, 1_100],
      [3, 1_399],
      [4, 1_400],
      [5, 1_500],
      [6, 1_900],
      [7, 1_901],
      [8, 1_950],
    ]) {
      now = time;
      if (shouldWrite(rendered, 8)) written.push(rendered);
    }
    assert.deepEqual(written, [1, 4, 6, 8]);
  });

  test('doc.json gets the page count before the slides, then their progress; nothing is looked up on PATH', async () => {
    // 20 slides with some drawing each, so the rendering takes a while; nothing (no poppler) on PATH.
    const draw = (n: number) =>
      Array.from({ length: 60 }, (_, k) => `${(k % 7) / 7} ${(n % 5) / 5} 0.6 rg ${20 + ((k * 37) % 900)} ${20 + ((k * 53) % 380)} 40 30 re f`).join('\n');
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(tmpRoot, 'empty-bin');
    const states: string[] = [];
    let docId = '';
    try {
      const initial = await importPdf(deckPdf(20, { draw }), 'Progress Deck.pdf');
      docId = initial.id;
      for (;;) {
        const stored = await readStoredDoc(docId);
        assert.ok(stored);
        const state = `${stored.status} ${stored.pageCount} ${stored.progress}`;
        if (states.at(-1) !== state) states.push(state);
        if (stored.status !== 'processing') break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await waitForIngest(docId);
    } finally {
      process.env.PATH = savedPath;
    }
    assert.equal(states.at(-1), 'ready 20 20', states.join(' | '));
    const processing = states.filter((state) => state.startsWith('processing ')).map((state) => state.split(' ').map(Number).slice(1));
    // The page count is known while the slides are still being rendered.
    assert.ok(processing.some(([pageCount, progress]) => pageCount === 20 && progress < 20), states.join(' | '));
    // At least one intermediate count of rendered slides, never more than the page count, never going back.
    assert.ok(processing.some(([, progress]) => progress > 0 && progress < 20), states.join(' | '));
    for (const [pageCount, progress] of processing) assert.ok(progress <= Math.max(pageCount, 0), states.join(' | '));
    const progresses = processing.map(([, progress]) => progress);
    assert.deepEqual(progresses, [...progresses].sort((a, b) => a - b), states.join(' | '));
    assert.equal(await fs.readFile(path.join(docPaths(docId).textDir, '020.txt'), 'utf8'), 'Slide 20');
  });

  test('createSlots: at most `limit` holders, first come first served; release is idempotent; waiters can be turned away', async () => {
    const slots = createSlots(2);
    const order: string[] = [];
    const a = await slots.acquire();
    const b = await slots.acquire();
    assert.ok(a && b);
    const c = slots.acquire().then((release) => (order.push('c'), release));
    const d = slots.acquire().then((release) => (order.push('d'), release));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(slots.load(), { running: 2, waiting: 2 });
    assert.deepEqual(order, []);
    a();
    a(); // a second release gives nothing back
    const releaseC = await c;
    assert.ok(releaseC);
    assert.deepEqual(slots.load(), { running: 2, waiting: 1 });
    assert.deepEqual(order, ['c']);
    const e = slots.acquire();
    slots.cancelWaiting();
    assert.equal(await d, null);
    assert.equal(await e, null);
    assert.deepEqual(slots.load(), { running: 2, waiting: 0 });
    b();
    releaseC();
    assert.deepEqual(slots.load(), { running: 0, waiting: 0 });
    // Free slots are taken at once again.
    const f = await slots.acquire();
    assert.ok(f);
    f();
  });

  test('a multi-file upload runs at most MAX_INGEST_WORKERS worker processes at a time; the others wait, then convert', async () => {
    const draw = (n: number) => Array.from({ length: 30 }, (_, k) => `0.2 0.4 ${(n % 5) / 5} rg ${20 + k * 30} ${40 + ((k * n) % 300)} 20 60 re f`).join('\n');
    await waitForBackfill(); // its one worker would count too
    const docs: DocMeta[] = [];
    for (let i = 0; i < MAX_INGEST_WORKERS + 2; i++) docs.push(await importPdf(deckPdf(8, { draw }), `Upload ${i}.pdf`));
    const peak = { running: 0, waiting: 0, workers: 0 };
    const sample = () => {
      const load = ingestLoad();
      for (const key of ['running', 'waiting', 'workers'] as const) peak[key] = Math.max(peak[key], load[key]);
    };
    sample();
    const sampler = setInterval(sample, 2);
    try {
      await Promise.all(docs.map((doc) => waitForIngest(doc.id)));
    } finally {
      clearInterval(sampler);
    }
    assert.equal(peak.running, MAX_INGEST_WORKERS);
    assert.ok(peak.waiting >= 2, `the last uploads waited for a slot (${JSON.stringify(peak)})`);
    // Worker processes (PDF, then image with the derived files) of all ingests together, not per stage.
    assert.ok(peak.workers <= MAX_INGEST_WORKERS, JSON.stringify(peak));
    assert.deepEqual(ingestLoad(), { running: 0, waiting: 0, workers: 0 });
    for (const doc of docs) {
      assert.equal((await readStoredDoc(doc.id))?.status, 'ready');
      assert.equal((await fs.readdir(docPaths(doc.id).thumbsDir)).length, 8, 'derived images written too');
    }
  });

  test('at shutdown, ingests waiting for a slot never start: they stay processing and resume on the next start', async () => {
    const docs: DocMeta[] = [];
    for (let i = 0; i < MAX_INGEST_WORKERS + 2; i++) docs.push(await importPdf(deckPdf(3), `Queued ${i}.pdf`));
    for (const deadline = Date.now() + 10_000; ingestLoad().waiting < 2; ) {
      assert.ok(Date.now() < deadline, `two ingests wait for a slot: ${JSON.stringify(ingestLoad())}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await stopImageWork();
    await Promise.all(docs.map((doc) => waitForIngest(doc.id)));
    const statuses = await Promise.all(docs.map(async (doc) => (await readStoredDoc(doc.id))?.status));
    const waited = docs.filter((_, i) => statuses[i] === 'processing');
    assert.equal(waited.length, 2, statuses.join(', '));
    for (const doc of waited) assert.equal(await exists(docPaths(doc.id).slidesDir), false, 'never touched');
    await resumePendingIngests();
    for (const doc of docs) assert.equal((await readStoredDoc(doc.id))?.status, 'ready');
  });
});

describe('import validation and failures', () => {
  test('rejects bodies without a %PDF header (400)', async () => {
    await assert.rejects(importPdf(Buffer.from('hello, not a pdf'), 'x.pdf'), (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      return true;
    });
  });

  test('a corrupt PDF ends in status error with a message', async () => {
    const meta = await importPdf(Buffer.from('%PDF-1.4\nthis is not really a pdf\n%%EOF\n'), 'broken.pdf');
    assert.equal(meta.title, 'broken');
    await waitForIngest(meta.id);
    const settled = await waitUntilSettled(meta.id);
    assert.equal(settled.status, 'error');
    assert.ok(settled.error && settled.error.length > 0);
    await assert.rejects(loadDocAssets(meta.id), (err: unknown) => err instanceof HttpError && err.status === 409);
  });

  test('CJK text that could not be drawn for want of a fallback font is logged with the document (the ingest goes on)', async () => {
    const saved = process.env.EASY_STUDY_PDF_FALLBACK_FONT;
    process.env.EASY_STUDY_PDF_FALLBACK_FONT = path.join(tmpRoot, 'mistyped.ttf');
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '));
    let meta: DocMeta;
    try {
      meta = await importPdf(cjkPdf(2), 'Korean without fonts.pdf');
      await waitForIngest(meta.id);
    } finally {
      console.warn = warn;
      if (saved === undefined) delete process.env.EASY_STUDY_PDF_FALLBACK_FONT;
      else process.env.EASY_STUDY_PDF_FALLBACK_FONT = saved;
    }
    assert.equal((await readStoredDoc(meta.id))?.status, 'ready');
    const lines = warned.filter((line) => line.startsWith(`[library] ${meta.id}: `));
    assert.equal(lines.length, 1, warned.join('\n'));
    assert.match(lines[0], /CJK font it does not embed.*mistyped\.ttf.*EASY_STUDY_PDF_FALLBACK_FONT/);
  });

  test('a damaged or password-protected PDF fails with a readable message (no external tool involved)', async () => {
    for (const [bytes, error] of [
      [GARBAGE_PDF, 'could not read the PDF: the file is damaged or is not a PDF'],
      [encryptedPdf('secret'), 'the PDF is password protected'],
    ] as const) {
      const meta = await importPdf(bytes, 'unreadable.pdf');
      await waitForIngest(meta.id);
      const settled = await waitUntilSettled(meta.id);
      assert.equal(settled.status, 'error');
      assert.equal(settled.error, error);
      assert.equal(settled.pageCount, 0);
    }
  });

  test('loadDocAssets of an unknown doc is a 404', async () => {
    await assert.rejects(loadDocAssets('unknown-doc-123456'), (err: unknown) => err instanceof HttpError && err.status === 404);
  });
});

// ---------------------------------------------------------------------------
// Course membership and digests as seen by the library (read side)
// ---------------------------------------------------------------------------

describe('derived DocMeta fields and DocAssets course/digest', () => {
  const PAGES = 3;

  async function makeDoc(docId: string, title: string, createdAt: string, status: DocMeta['status'] = 'ready'): Promise<void> {
    const paths = docPaths(docId);
    await fs.mkdir(paths.textDir, { recursive: true });
    const meta: StoredDocMeta = {
      id: docId,
      title,
      fileName: `${title}.pdf`,
      pageCount: PAGES,
      aspectRatio: 16 / 9,
      status,
      progress: PAGES,
      createdAt,
    };
    await fs.writeFile(paths.docJson, JSON.stringify(meta));
    for (let n = 1; n <= PAGES; n++) await fs.writeFile(path.join(paths.textDir, textFileName(n, PAGES)), `${title} slide ${n}`);
  }

  async function writeCourse(record: CourseRecord): Promise<void> {
    const paths = coursePaths(record.id);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.courseJson, JSON.stringify(record));
  }

  async function writeDigest(docId: string, record: Omit<DigestRecord, 'version'>): Promise<void> {
    const paths = docPaths(docId);
    await fs.mkdir(paths.digestDir, { recursive: true });
    await fs.writeFile(paths.digestJson, JSON.stringify({ version: 1, ...record }));
  }

  const entry = (slide: number, failed = false): DigestSlide => ({
    slide,
    title: `T${slide}`,
    markdown: failed ? '_(failed)_' : `body ${slide}`,
    ...(failed ? { failed: true } : {}),
  });

  before(async () => {
    await makeDoc('lec-1-aaa001', 'Lec 1', '2026-01-01T00:00:00.000Z');
    await makeDoc('lec-2-aaa002', 'Lec 2', '2026-01-02T00:00:00.000Z');
    await makeDoc('lec-3-aaa003', 'Lec 3', '2026-01-03T00:00:00.000Z');
    await makeDoc('loose-aaa004', 'Loose', '2026-01-04T00:00:00.000Z');
    await writeCourse({
      version: 1,
      id: 'compiler-c00001',
      title: 'Compiler',
      createdAt: '2026-02-01T00:00:00.000Z',
      // 'gone-aaa999' was deleted by hand; it must be skipped, not break anything.
      docIds: ['lec-1-aaa001', 'gone-aaa999', 'lec-2-aaa002', 'lec-3-aaa003'],
    });
    // A newer course listing a lecture again (data error): the older course wins.
    await writeCourse({ version: 1, id: 'later-c00002', title: 'Later', createdAt: '2026-03-01T00:00:00.000Z', docIds: ['lec-2-aaa002'] });
    await writeDigest('lec-1-aaa001', {
      status: 'ready',
      provider: 'codex',
      model: '',
      slides: [entry(3), entry(1), entry(2)],
      summary: 'Lecture 1 summary',
    });
    await writeDigest('lec-2-aaa002', { status: 'running', slides: [entry(1), entry(2, true)], summary: null });
  });

  test('digestStatus is cached by the identity of digest.json and follows every change', async () => {
    const docId = 'loose-aaa004';
    const file = docPaths(docId).digestJson;
    assert.equal((await getDoc(docId))?.digestStatus, 'none');
    await writeDigest(docId, { status: 'running', slides: [], summary: null });
    assert.equal((await getDoc(docId))?.digestStatus, 'running');
    // Replaced atomically like digest.ts does: same size ('running' → 'aborted'), but a new file.
    await writeFileAtomic(file, JSON.stringify({ version: 1, status: 'aborted', slides: [], summary: null }));
    assert.equal((await getDoc(docId))?.digestStatus, 'aborted');
    assert.equal((await listDocs()).find((doc) => doc.id === docId)?.digestStatus, 'aborted');

    // An unchanged file (same inode, size and mtime) is not parsed again: garbage written in place with the
    // old size and mtime still reads as the cached status...
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    await fs.utimes(file, stamp, stamp);
    assert.equal((await getDoc(docId))?.digestStatus, 'aborted');
    const size = (await fs.stat(file)).size;
    await fs.writeFile(file, 'x'.repeat(size));
    await fs.utimes(file, stamp, stamp);
    assert.equal((await getDoc(docId))?.digestStatus, 'aborted');
    // ...and any change of the file is seen.
    const later = new Date('2026-01-01T00:00:01.000Z');
    await fs.utimes(file, later, later);
    assert.equal((await getDoc(docId))?.digestStatus, 'none', 'unreadable digest.json');
    await writeDigest(docId, { status: 'ready', slides: [], summary: null });
    assert.equal((await getDoc(docId))?.digestStatus, 'ready');
    await fs.rm(file);
    assert.equal((await getDoc(docId))?.digestStatus, 'none');
  });

  test('courseId comes from the course files; digestStatus from digest.json', async () => {
    const byId = new Map((await listDocs()).map((doc) => [doc.id, doc]));
    assert.equal(byId.get('lec-1-aaa001')?.courseId, 'compiler-c00001');
    assert.equal(byId.get('lec-2-aaa002')?.courseId, 'compiler-c00001', 'the oldest course wins');
    assert.equal(byId.get('loose-aaa004')?.courseId, null);
    assert.equal(byId.get('lec-1-aaa001')?.digestStatus, 'ready');
    assert.equal(byId.get('lec-2-aaa002')?.digestStatus, 'running');
    assert.equal(byId.get('lec-3-aaa003')?.digestStatus, 'none');
    assert.equal((await getDoc('lec-3-aaa003'))?.courseId, 'compiler-c00001');
    assert.deepEqual(await readStoredDoc('lec-3-aaa003').then((doc) => doc && Object.keys(doc).includes('courseId')), false);
  });

  test('listDocs and getDoc ignore library/courses', async () => {
    assert.ok(!(await listDocs()).some((doc) => doc.id === 'courses'));
    // Even a stray doc.json in there is not a document.
    await fs.writeFile(path.join(tmpRoot, 'courses', 'doc.json'), '{"title":"nope"}');
    assert.ok(!(await listDocs()).some((doc) => doc.id === 'courses'));
    assert.equal(await getDoc('courses'), null);
    assert.throws(() => docPaths('courses'), (err: unknown) => err instanceof HttpError && err.status === 404);
  });

  test('loadDocAssets: digest entries (ascending) and completeness', async () => {
    const lec1 = await loadDocAssets('lec-1-aaa001');
    assert.deepEqual(
      lec1.digest?.map((e) => e.slide),
      [1, 2, 3],
    );
    assert.equal(lec1.digestComplete, true);
    assert.equal(lec1.meta.digestStatus, 'ready');

    const lec2 = await loadDocAssets('lec-2-aaa002');
    assert.deepEqual(lec2.digest, [entry(1), entry(2, true)]);
    assert.equal(lec2.digestComplete, false, 'a failed entry does not count');

    const lec3 = await loadDocAssets('lec-3-aaa003');
    assert.equal(lec3.digest, null);
    assert.equal(lec3.digestComplete, false);
  });

  test('loadDocAssets: course context lists every lecture with summaries', async () => {
    const assets = await loadDocAssets('lec-2-aaa002');
    assert.deepEqual(assets.course, {
      id: 'compiler-c00001',
      title: 'Compiler',
      currentIndex: 2,
      lectures: [
        {
          docId: 'lec-1-aaa001',
          title: 'Lec 1',
          index: 1,
          pageCount: PAGES,
          dir: docPaths('lec-1-aaa001').dir,
          summary: 'Lecture 1 summary',
          hasDigest: true,
        },
        {
          docId: 'lec-2-aaa002',
          title: 'Lec 2',
          index: 2,
          pageCount: PAGES,
          dir: docPaths('lec-2-aaa002').dir,
          summary: null,
          hasDigest: false,
        },
        {
          docId: 'lec-3-aaa003',
          title: 'Lec 3',
          index: 3,
          pageCount: PAGES,
          dir: docPaths('lec-3-aaa003').dir,
          summary: null,
          hasDigest: false,
        },
      ],
    });
    for (const lecture of assets.course?.lectures ?? []) assert.ok(path.isAbsolute(lecture.dir));
    assert.equal((await loadDocAssets('loose-aaa004')).course, null);
  });

  test('isDigestComplete and demoteHeadings', () => {
    assert.equal(isDigestComplete([entry(1), entry(2)], 2), true);
    assert.equal(isDigestComplete([entry(1)], 2), false);
    assert.equal(isDigestComplete([entry(1), entry(2, true)], 2), false);
    assert.equal(isDigestComplete([], 0), false);
    assert.equal(demoteHeadings('# A\n```\n# code\n```\n###### deep', 2), '### A\n```\n# code\n```\n###### deep');
  });
});

// ---------------------------------------------------------------------------
// Deleting and retrying documents (DESIGN §14)
// ---------------------------------------------------------------------------

describe('retrying a failed conversion and deleting documents', () => {
  function isHttpError(status: number) {
    return (err: unknown) => err instanceof HttpError && err.status === status;
  }

  test('retryIngest converts a failed document again; only status error may be retried', async () => {
    // The conversion fails (a damaged upload); then the PDF becomes readable (the file was replaced).
    const failed = await importPdf(Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF\n'), 'L8 Semantic Analysis.pdf');
    await waitForIngest(failed.id);
    const broken = await waitUntilSettled(failed.id);
    assert.equal(broken.status, 'error');
    await fs.copyFile(SAMPLE_PDF, docPaths(failed.id).sourcePdf);

    const retried = await retryIngest(failed.id);
    assert.equal(retried.status, 'processing');
    assert.equal(retried.error, undefined);
    assert.equal(retried.progress, 0);
    assert.equal(isIngestRunning(failed.id), true);
    await assert.rejects(retryIngest(failed.id), isHttpError(409), 'already converting');

    await waitForIngest(failed.id);
    const ready = await waitUntilSettled(failed.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.error, undefined);
    assert.equal(ready.pageCount, 9);
    await assert.rejects(retryIngest(failed.id), isHttpError(409), 'a ready document is not converted again');
    await assert.rejects(retryIngest('unknown-doc-123456'), isHttpError(404));
    await assert.rejects(retryIngest('courses'), isHttpError(404));
  });

  test('deleteDoc removes the folder at once; busy documents are refused with 409', async () => {
    const meta = await importPdf(await fs.readFile(SAMPLE_PDF), 'To Delete.pdf');
    // While the PDF is being converted it cannot be deleted.
    await assert.rejects(deleteDoc(meta.id), isHttpError(409));
    await waitForIngest(meta.id);
    await waitUntilSettled(meta.id);

    // Something else (a digest job, a running answer) keeps it busy.
    await assert.rejects(
      deleteDoc(meta.id, () => '정리본을 만드는 중'),
      (err: unknown) => err instanceof HttpError && err.status === 409 && err.message === '정리본을 만드는 중',
    );
    assert.ok(await readStoredDoc(meta.id), 'nothing was deleted');

    await deleteDoc(meta.id);
    assert.equal(await readStoredDoc(meta.id), null);
    assert.equal(await getDoc(meta.id), null);
    assert.ok(!(await listDocs()).some((doc) => doc.id === meta.id));
    await assert.rejects(fs.access(docPaths(meta.id).dir));
    assert.deepEqual(
      (await fs.readdir(libraryDir())).filter((name) => name.startsWith('.deleted-')),
      [],
      'the renamed folder was removed too',
    );
    await assert.rejects(deleteDoc(meta.id), isHttpError(404));
    await assert.rejects(deleteDoc('courses'), isHttpError(404));
  });

  test('a ready document can be deleted while its derived images are written (the worker is stopped)', async () => {
    const meta = await importPdf(await fs.readFile(SAMPLE_PDF), 'Delete While Deriving.pdf');
    await waitFor(async () => (await readStoredDoc(meta.id))?.status === 'ready');
    assert.equal(isIngestRunning(meta.id), false, 'converted: only derived images may still be written');
    await deleteDoc(meta.id);
    await waitForIngest(meta.id);
    await assert.rejects(fs.access(docPaths(meta.id).dir));
    // Nothing is written into the folder after the deletion.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(fs.access(docPaths(meta.id).dir));
    assert.deepEqual(
      (await fs.readdir(libraryDir())).filter((name) => name.startsWith('.deleted-')),
      [],
    );
  });

  test('leftover folders of deleted documents are swept and never listed', async () => {
    const leftover = path.join(libraryDir(), '.deleted-old-doc-abc123-ffffff');
    await fs.mkdir(path.join(leftover, 'slides'), { recursive: true });
    await fs.writeFile(path.join(leftover, 'doc.json'), '{}');
    assert.ok(!(await listDocs()).some((doc) => doc.id.includes('old-doc')));
    assert.equal(await removeDeletedLeftovers(), 1);
    await assert.rejects(fs.access(leftover));
    assert.equal(await removeDeletedLeftovers(), 0);
  });
});

// ---------------------------------------------------------------------------
// Derived images over HTTP, and the backfill (DESIGN §15)
// ---------------------------------------------------------------------------

describe('derived image routes and the backfill', () => {
  let server: RunningServer;
  let base = '';
  let docId = '';
  const api = (p: string) => fetch(`${base}/api${p}`);

  before(async () => {
    server = await startServer({ port: 0, log: false, resumeIngests: false });
    base = server.url;
    const meta = await importPdf(await fs.readFile(SAMPLE_PDF), 'Routes Deck.pdf');
    await waitForIngest(meta.id);
    docId = meta.id;
  });

  after(async () => {
    await server?.close();
  });

  async function expectStatus(res: Response, status: number): Promise<void> {
    assert.equal(res.status, status);
    await res.arrayBuffer();
  }

  test('view renditions (?w=1000|1600) and thumbnails are immutable WebP files', async () => {
    for (const [query, width] of [
      ['?w=1000', 1000],
      ['?w=1600', 1600],
      ['', 1600],
    ] as const) {
      const res = await api(`/docs/${docId}/view/3.webp${query}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width, width);
    }
    const thumb = await api(`/docs/${docId}/thumbs/9.webp`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    assert.equal((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width, THUMB_WIDTH);
    assert.equal((await api(`/docs/${docId}/view/003.webp?w=1000`)).status, 200);

    await expectStatus(await api(`/docs/${docId}/view/3.webp?w=1200`), 400);
    await expectStatus(await api(`/docs/${docId}/view/10.webp`), 404);
    await expectStatus(await api(`/docs/${docId}/view/0.webp`), 404);
    await expectStatus(await api(`/docs/${docId}/view/3.png`), 404);
    await expectStatus(await api(`/docs/${docId}/thumbs/3.png`), 404);
    await expectStatus(await api(`/docs/${docId}/thumbs/..%2Fdoc.json`), 404);
    await expectStatus(await api('/docs/missing-000000/view/1.webp'), 404);
    await expectStatus(await api('/docs/NOT_VALID/thumbs/1.webp'), 404);
  });

  test('a missing derived file is answered with the PNG (no-store) and written by the backfill', async () => {
    const paths = docPaths(docId);
    const view = viewPath(paths.dir, slideFileName(2, 9), 1000);
    const thumb = thumbPath(paths.dir, slideFileName(5, 9));
    await fs.rm(view);
    await fs.rm(thumb);

    const res = await api(`/docs/${docId}/view/2.webp?w=1000`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width, 1600);
    const fallback = await api(`/docs/${docId}/thumbs/5.webp`);
    assert.equal(fallback.headers.get('content-type'), 'image/png');
    await fallback.arrayBuffer();

    await waitFor(async () => (await exists(view)) && (await exists(thumb)));
    await waitForBackfill();
    const again = await api(`/docs/${docId}/view/2.webp?w=1000`);
    assert.equal(again.headers.get('content-type'), 'image/webp');
    assert.equal(again.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    await again.arrayBuffer();

    // A document is backfilled at most once a minute (files that cannot be written are not retried on
    // every request): the PNG keeps being served meanwhile.
    await fs.rm(view);
    const soon = await api(`/docs/${docId}/view/2.webp?w=1000`);
    assert.equal(soon.headers.get('content-type'), 'image/png');
    await soon.arrayBuffer();
    await waitForBackfill();
    assert.equal(await exists(view), false);
  });

  test('the startup backfill writes the derived images of documents converted before they existed', async () => {
    // A lecture converted by an older version: slides, sheets and texts, but no derived images.
    const source = docPaths(docId);
    const legacyId = 'legacy-deck-abc123';
    const legacy = docPaths(legacyId);
    await fs.mkdir(legacy.dir, { recursive: true });
    for (const dir of ['slides', 'sheets', 'text']) {
      await fs.cp(path.join(source.dir, dir), path.join(legacy.dir, dir), { recursive: true });
    }
    const stored = JSON.parse(await fs.readFile(source.docJson, 'utf8')) as StoredDocMeta;
    await fs.writeFile(legacy.docJson, JSON.stringify({ ...stored, id: legacyId, title: 'Legacy' }));
    const expected = expectedDerivedFiles(legacyId, 9, ['sheet-01.png', 'sheet-02.png', 'sheet-03.png']);
    for (const file of expected) assert.equal(await exists(file), false);

    const second = await startServer({ port: 0, log: false, resumeIngests: false, backfillImages: true });
    try {
      await waitFor(async () => (await Promise.all(expected.map(exists))).every(Boolean));
      await waitForBackfill();
      const res = await fetch(`${second.url}/api/docs/${legacyId}/view/1.webp`);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      await res.arrayBuffer();
    } finally {
      await second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Text of documents converted by poppler, extracted again by the backfill (DESIGN §17)
// ---------------------------------------------------------------------------

describe('text backfill of documents converted before PDFium', () => {
  /** mtimes of every file of a document except its text (slides, sheets, derived images, digest, doc.json). */
  async function otherFiles(docId: string): Promise<Map<string, number>> {
    const dir = docPaths(docId).dir;
    const files = new Map<string, number>();
    for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (path.dirname(file) === docPaths(docId).textDir) continue;
      files.set(path.relative(dir, file), (await fs.stat(file)).mtimeMs);
    }
    return files;
  }

  /** Turns a converted document into one poppler converted: pdftotext's text (PUA symbols), no text/.engine. */
  async function asPopplerDoc(docId: string, pages: string[]): Promise<void> {
    const paths = docPaths(docId);
    await fs.rm(path.join(paths.textDir, TEXT_ENGINE_FILE));
    for (const [i, text] of pages.entries()) await fs.writeFile(path.join(paths.textDir, textFileName(i + 1, pages.length)), text);
  }

  test('only the text is extracted again: slides, derived images and the digest stay as they are', async () => {
    const symbols = await importPdf(symbolFontPdf(), 'Poppler Symbols.pdf');
    const deck = await importPdf(await fs.readFile(SAMPLE_PDF), 'Poppler Deck.pdf');
    await Promise.all([waitForIngest(symbols.id), waitForIngest(deck.id)]);
    await waitForBackfill();
    await asPopplerDoc(symbols.id, ['   Sets:  \uf061 \uf062 \uf0c8 \uf0ce \uf0c6 \uf0ae\n\n   \uf0a7 done']);
    await asPopplerDoc(deck.id, Array.from({ length: 9 }, (_, i) => `pdftotext page ${i + 1}`));
    // A digest made from the old text is kept (not made again).
    const digest: DigestRecord = { version: 1, status: 'ready', slides: [{ slide: 1, title: 'Sets', markdown: 'α β' }], summary: 'old' };
    await fs.mkdir(docPaths(symbols.id).digestDir, { recursive: true });
    await fs.writeFile(docPaths(symbols.id).digestJson, JSON.stringify(digest));
    const before = new Map([
      [symbols.id, await otherFiles(symbols.id)],
      [deck.id, await otherFiles(deck.id)],
    ]);

    await startBackfill();
    await waitForBackfill();

    const symbolText = await fs.readFile(path.join(docPaths(symbols.id).textDir, '001.txt'), 'utf8');
    assert.equal(symbolText, 'Sets: α β ∪ ∈ ∅ →\n\uf0a7 done');
    const deckTexts = await loadDocAssets(deck.id).then((assets) => assets.texts);
    assert.match(deckTexts[0], /^Lecture 5: CPU Scheduling/);
    assert.ok(deckTexts.every((text) => !text.startsWith('pdftotext page')), 'every page was extracted again');
    for (const docId of [symbols.id, deck.id]) {
      assert.equal(await fs.readFile(path.join(docPaths(docId).textDir, TEXT_ENGINE_FILE), 'utf8'), `${TEXT_ENGINE}\n`);
      assert.deepEqual(await otherFiles(docId), before.get(docId), `${docId}: nothing but the text changed`);
    }
    assert.deepEqual(await readDigestRecord(symbols.id), digest);

    // Once is enough: the marker keeps the next backfill away from the text.
    const stamp = (await fs.stat(path.join(docPaths(deck.id).textDir, '001.txt'))).mtimeMs;
    await startBackfill();
    await waitForBackfill();
    assert.equal((await fs.stat(path.join(docPaths(deck.id).textDir, '001.txt'))).mtimeMs, stamp);
  });

  test('text of an older PDFium extraction (text/.engine pdfium-1) is extracted again as well', async () => {
    const doc = await importPdf(baselinePdf(), 'Baselines.pdf');
    await waitForIngest(doc.id);
    await waitForBackfill();
    const textFile = path.join(docPaths(doc.id).textDir, textFileName(1, 1));
    const current = await fs.readFile(textFile, 'utf8');
    assert.match(current, /^Rank 1st and 2nd\nx2 \+ Ai done\nif E2 then\n/);
    // What pdfium-1 wrote: a line break at every baseline shift.
    await fs.writeFile(textFile, 'Rank 1st and 2nd\nx\n2\n+ Ai\ndone');
    await fs.writeFile(path.join(docPaths(doc.id).textDir, TEXT_ENGINE_FILE), 'pdfium-1\n');
    const before = await otherFiles(doc.id);
    await startBackfill();
    await waitForBackfill();
    assert.equal(await fs.readFile(textFile, 'utf8'), current);
    assert.equal(await fs.readFile(path.join(docPaths(doc.id).textDir, TEXT_ENGINE_FILE), 'utf8'), `${TEXT_ENGINE}\n`);
    assert.deepEqual(await otherFiles(doc.id), before, 'nothing but the text changed');
  });

  test('documents without source.pdf or not ready keep their text; a deletion during the backfill wins', async () => {
    // lec-1-aaa001 (above) has text files, no marker and no source.pdf.
    const lecture = path.join(docPaths('lec-1-aaa001').textDir, textFileName(1, 3));
    assert.equal(await fs.readFile(lecture, 'utf8'), 'Lec 1 slide 1');
    // A document still being converted (by another process, say): its ingest writes the text itself.
    const converting = docPaths('converting-abc123');
    await fs.mkdir(converting.textDir, { recursive: true });
    await fs.copyFile(SAMPLE_PDF, converting.sourcePdf);
    await fs.writeFile(path.join(converting.textDir, '001.txt'), 'old');
    const stored: StoredDocMeta = {
      id: 'converting-abc123',
      title: 'Converting',
      fileName: 'Converting.pdf',
      pageCount: 9,
      aspectRatio: 16 / 9,
      status: 'processing',
      progress: 2,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(converting.docJson, JSON.stringify(stored));

    const deleted = await importPdf(await fs.readFile(SAMPLE_PDF), 'Deleted While Backfilled.pdf');
    await waitForIngest(deleted.id);
    await waitForBackfill();
    await asPopplerDoc(deleted.id, Array.from({ length: 9 }, () => 'old'));
    const backfill = startBackfill();
    // Whether the text run has started or not, the deletion wins: nothing is written into the folder later.
    await deleteDoc(deleted.id);
    await backfill;
    await waitForBackfill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(fs.access(docPaths(deleted.id).dir));
    assert.equal(await fs.readFile(lecture, 'utf8'), 'Lec 1 slide 1');
    assert.ok(!(await exists(path.join(docPaths('lec-1-aaa001').textDir, TEXT_ENGINE_FILE))));
    assert.equal(await fs.readFile(path.join(converting.textDir, '001.txt'), 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(converting.textDir), ['001.txt']);
    await fs.rm(converting.dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Portability helpers (DESIGN §15)
// ---------------------------------------------------------------------------

describe('portability helpers', () => {
  const locked = (code: string) => Object.assign(new Error(`${code}: resource busy or locked`), { code });

  test('withFsRetry retries EPERM/EBUSY/EACCES on Windows only', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw locked(calls === 1 ? 'EBUSY' : 'EPERM');
      return 'done';
    };
    assert.equal(await withFsRetry(flaky, 'win32'), 'done');
    assert.equal(calls, 3);

    calls = 0;
    await assert.rejects(withFsRetry(flaky, 'darwin'), { code: 'EBUSY' });
    assert.equal(calls, 1, 'a real permission error elsewhere');

    calls = 0;
    await assert.rejects(
      withFsRetry(async () => {
        calls++;
        throw locked('ENOENT');
      }, 'win32'),
      { code: 'ENOENT' },
    );
    assert.equal(calls, 1);
  });

  test('pngAspectRatio reads the PNG header; anything else gives the fallback', async () => {
    const [doc] = (await listDocs()).filter((candidate) => candidate.status === 'ready' && candidate.pageCount === 9);
    assert.ok(doc);
    const ratio = await pngAspectRatio(path.join(docPaths(doc.id).slidesDir, '001.png'), 1);
    assert.ok(Math.abs(ratio - 16 / 9) < 0.01, String(ratio));
    assert.equal(await pngAspectRatio(path.join(docPaths(doc.id).textDir, '001.txt'), 1.25), 1.25);
    assert.equal(await pngAspectRatio(path.join(tmpRoot, 'missing.png'), 0.75), 0.75);
  });

  test('command lines with environment variables use the platform shell syntax', () => {
    assert.equal(envCommand({ PORT: '5181' }, 'npm run dev', 'linux'), 'PORT=5181 npm run dev');
    assert.equal(
      envCommand({ EASY_STUDY_LIBRARY: '<다른 폴더>', PORT: '5181' }, 'npm run serve', 'darwin'),
      "EASY_STUDY_LIBRARY='<다른 폴더>' PORT=5181 npm run serve",
    );
    assert.equal(
      envCommand({ EASY_STUDY_LIBRARY: '<다른 폴더>', PORT: '5181' }, 'npm run dev', 'win32'),
      '$env:EASY_STUDY_LIBRARY="<다른 폴더>"; $env:PORT="5181"; npm run dev  (PowerShell)',
    );
  });
});

// ---------------------------------------------------------------------------
// Single-instance lock (library/.server.lock)
// ---------------------------------------------------------------------------

describe('single-instance library lock', () => {
  /** The pid of a process that has exited. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.ok(child.pid);
    return child.pid;
  }

  async function readLock(): Promise<ServerLockInfo> {
    return JSON.parse(await fs.readFile(serverLockPath(), 'utf8')) as ServerLockInfo;
  }

  test('acquire writes { pid, port, startedAt }; setPort updates it; release removes it', async () => {
    assert.equal(serverLockPath(), path.join(libraryDir(), '.server.lock'));
    const lock = await acquireServerLock(0);
    const info = await readLock();
    assert.equal(info.pid, process.pid);
    assert.equal(info.port, 0);
    assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
    await lock.setPort(5199);
    assert.equal((await readLock()).port, 5199);
    assert.equal((await readLock()).startedAt, info.startedAt);
    assert.ok(!(await listDocs()).some((doc) => doc.id.includes('lock')), 'the lock is not a document');
    await lock.release();
    await assert.rejects(fs.access(serverLockPath()));
    await lock.release(); // idempotent
  });

  test('a lock held by another live process refuses; the lock file is left alone', async () => {
    const holder: ServerLockInfo = { pid: process.ppid, port: 5180, startedAt: '2026-09-23T08:00:00.000Z' };
    await fs.writeFile(serverLockPath(), JSON.stringify(holder));
    try {
      await assert.rejects(acquireServerLock(5181), (err: unknown) => {
        assert.ok(err instanceof LibraryLockedError);
        assert.deepEqual(err.holder, holder);
        assert.equal(err.lockFile, serverLockPath());
        assert.match(err.message, /이미 이 라이브러리로 실행 중/);
        return true;
      });
      assert.deepEqual(await readLock(), holder);
    } finally {
      await fs.rm(serverLockPath(), { force: true });
    }
  });

  test('a stale lock (process gone, or unreadable) is replaced', async () => {
    await fs.writeFile(serverLockPath(), JSON.stringify({ pid: await deadPid(), port: 5180, startedAt: '2026-01-01T00:00:00.000Z' }));
    const first = await acquireServerLock(5180);
    assert.equal((await readLock()).pid, process.pid);
    await first.release();

    await fs.writeFile(serverLockPath(), '');
    const second = await acquireServerLock(5180);
    assert.equal((await readLock()).pid, process.pid);
    await second.release();
    await assert.rejects(fs.access(serverLockPath()));
  });

  test('servers of one process share the lock; the last release removes it', async () => {
    const [a, b] = await Promise.all([acquireServerLock(1), acquireServerLock(2)]);
    await a.release();
    assert.equal((await readLock()).pid, process.pid, 'still held by the second server');
    await b.release();
    await assert.rejects(fs.access(serverLockPath()));
  });

  test('startServer refuses a locked library before touching it; takes it over when free', async () => {
    // Interrupted work that the startup sweeps would rewrite.
    const docId = 'locked-doc-abc123';
    const paths = docPaths(docId);
    await fs.mkdir(paths.sessionsDir, { recursive: true });
    await fs.mkdir(paths.digestDir, { recursive: true });
    const stored: StoredDocMeta = {
      id: docId,
      title: 'Locked',
      fileName: 'Locked.pdf',
      pageCount: 1,
      aspectRatio: 1,
      status: 'ready',
      progress: 1,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(paths.docJson, JSON.stringify(stored));
    const now = new Date().toISOString();
    const session: SessionRecord = {
      version: 1,
      id: '20260923-100000-abcd',
      docId,
      title: 's',
      provider: 'claude-code',
      model: '',
      createdAt: now,
      updatedAt: now,
      providerState: { resume: null, primed: false, imagesSent: 0, recentSlides: [], generation: 0, history: [] },
      messages: [{ id: 'a', role: 'assistant', text: 'half', slide: 1, kind: 'question', createdAt: now, status: 'streaming' }],
    };
    const sessionFile = path.join(paths.sessionsDir, `${session.id}.json`);
    await fs.writeFile(sessionFile, JSON.stringify(session));
    const digest: DigestRecord = { version: 1, status: 'running', slides: [], summary: null };
    await fs.writeFile(paths.digestJson, JSON.stringify(digest));

    await fs.writeFile(serverLockPath(), JSON.stringify({ pid: process.ppid, port: 5180, startedAt: now }));
    await assert.rejects(startServer({ port: 0, log: false, resumeIngests: false }), LibraryLockedError);
    const untouched = JSON.parse(await fs.readFile(sessionFile, 'utf8')) as SessionRecord;
    assert.equal(untouched.messages[0].status, 'streaming', 'no startup sweep ran');
    assert.equal((await readDigestRecord(docId))?.status, 'running');

    // The holder is gone: the next start replaces the lock and sweeps.
    await fs.writeFile(serverLockPath(), JSON.stringify({ pid: await deadPid(), port: 5180, startedAt: now }));
    const server = await startServer({ port: 0, log: false, resumeIngests: false });
    try {
      const lock = await readLock();
      assert.equal(lock.pid, process.pid);
      assert.equal(lock.port, Number(new URL(server.url).port), 'the actual port is recorded');
      const swept = JSON.parse(await fs.readFile(sessionFile, 'utf8')) as SessionRecord;
      assert.equal(swept.messages[0].status, 'aborted');
      assert.equal((await readDigestRecord(docId))?.status, 'aborted');
    } finally {
      await server.close();
    }
    await assert.rejects(fs.access(serverLockPath()), 'close() removes the lock');
    await server.close(); // idempotent
  });

  test('a start that fails after taking the lock gives it back', async () => {
    const blocker = await startServer({ port: 0, log: false, resumeIngests: false });
    try {
      const { port } = new URL(blocker.url);
      // Same process, same library: the lock is shared, but the port is taken.
      await assert.rejects(startServer({ port: Number(port), log: false, resumeIngests: false }), { code: 'EADDRINUSE' });
      assert.equal((await readLock()).pid, process.pid, 'still held by the running server');
    } finally {
      await blocker.close();
    }
    await assert.rejects(fs.access(serverLockPath()));
  });
});
