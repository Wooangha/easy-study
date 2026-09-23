// Ingest pipeline end-to-end on samples/sample-lecture.pdf (needs poppler), plus import validation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { DOC_ID_RE } from '../shared/types.ts';
import type { DocMeta } from '../shared/types.ts';
import { HttpError, libraryDir, repoRoot } from '../server/config.ts';
import {
  POPPLER_MISSING_MESSAGE,
  docPaths,
  getDoc,
  importPdf,
  listDocs,
  loadDocAssets,
  resumePendingIngests,
  runPoppler,
  slideFileName,
  slugify,
  waitForIngest,
} from '../server/library.ts';

const SAMPLE_PDF = path.join(repoRoot(), 'samples', 'sample-lecture.pdf');
let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-library-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

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
});

describe('slugify / file names', () => {
  test('ascii slug, max 40 chars, fallback doc', () => {
    assert.equal(slugify('OS 101 — Lecture 5: CPU Scheduling!'), 'os-101-lecture-5-cpu-scheduling');
    assert.equal(slugify('운영체제'), 'doc');
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

  test('doc.json is ready with page count, progress and aspect ratio', () => {
    assert.equal(meta.status, 'ready', meta.error ?? '');
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

  test('9 text files, split per page and trimmed', async () => {
    const paths = docPaths(meta.id);
    const files = (await fs.readdir(paths.textDir)).sort();
    assert.equal(files.length, 9);
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

  test('loadDocAssets exposes texts, slide paths and sheets', async () => {
    const assets = await loadDocAssets(meta.id);
    assert.equal(assets.meta.id, meta.id);
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

  test('a missing poppler binary produces the install hint', async () => {
    await assert.rejects(runPoppler('pdftoppm-definitely-not-installed', []), { message: POPPLER_MISSING_MESSAGE });
  });

  test('loadDocAssets of an unknown doc is a 404', async () => {
    await assert.rejects(loadDocAssets('unknown-doc-123456'), (err: unknown) => err instanceof HttpError && err.status === 404);
  });
});
