// Ingest pipeline end-to-end on samples/sample-lecture.pdf (needs poppler), plus import validation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { DOC_ID_RE } from '../shared/types.ts';
import type { DigestSlide, DocMeta } from '../shared/types.ts';
import { HttpError, autoDigestEnabled, digestConcurrency, libraryDir, repoRoot } from '../server/config.ts';
import type { CourseRecord, DigestRecord } from '../server/internal-types.ts';
import {
  POPPLER_MISSING_MESSAGE,
  coursePaths,
  demoteHeadings,
  docPaths,
  getDoc,
  importPdf,
  isDigestComplete,
  listDocs,
  loadDocAssets,
  readStoredDoc,
  resumePendingIngests,
  runPoppler,
  slideFileName,
  slugify,
  textFileName,
  waitForIngest,
} from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';

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

  test('digest concurrency and auto digest come from the environment', () => {
    const saved = { c: process.env.EASY_STUDY_DIGEST_CONCURRENCY, a: process.env.EASY_STUDY_AUTO_DIGEST };
    try {
      delete process.env.EASY_STUDY_DIGEST_CONCURRENCY;
      assert.equal(digestConcurrency(), 2);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = '3';
      assert.equal(digestConcurrency(), 3);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = '0';
      assert.equal(digestConcurrency(), 1);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = '99';
      assert.equal(digestConcurrency(), 8);
      process.env.EASY_STUDY_DIGEST_CONCURRENCY = 'lots';
      assert.equal(digestConcurrency(), 2);

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
