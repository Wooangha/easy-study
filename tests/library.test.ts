// Ingest pipeline end-to-end on samples/sample-lecture.pdf (needs poppler), plus import validation,
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
import { HttpError, autoDigestEnabled, digestConcurrency, findPackageRoot, libraryDir, repoRoot } from '../server/config.ts';
import { envCommand, startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import type { CourseRecord, DigestRecord, SessionRecord } from '../server/internal-types.ts';
import {
  LibraryLockedError,
  POPPLER_MISSING_MESSAGE,
  acquireServerLock,
  coursePaths,
  deleteDoc,
  demoteHeadings,
  docPaths,
  getDoc,
  importPdf,
  isDigestComplete,
  isIngestRunning,
  listDocs,
  loadDocAssets,
  pngAspectRatio,
  popplerMissingMessage,
  readDigestRecord,
  readStoredDoc,
  removeDeletedLeftovers,
  resumePendingIngests,
  retryIngest,
  runPoppler,
  serverLockPath,
  slideFileName,
  slugify,
  textFileName,
  waitForBackfill,
  waitForIngest,
  withFsRetry,
  writeFileAtomic,
} from '../server/library.ts';
import type { ServerLockInfo, StoredDocMeta } from '../server/library.ts';

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

  test('the poppler install hint fits the platform', () => {
    assert.equal(POPPLER_MISSING_MESSAGE, popplerMissingMessage(process.platform));
    assert.equal(popplerMissingMessage('darwin'), 'poppler is not installed (brew install poppler)');
    assert.match(popplerMissingMessage('linux'), /sudo apt install poppler-utils.*sudo dnf install poppler-utils.*pacman -S poppler/);
    assert.match(popplerMissingMessage('win32'), /winget install oschwartz10612\.Poppler.*scoop install poppler/);
    assert.doesNotMatch(popplerMissingMessage('win32'), /brew|apt/);
    assert.match(popplerMissingMessage('freebsd'), /^poppler is not installed/);
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
    // The conversion fails (as without poppler); then the PDF becomes readable (poppler installed).
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
