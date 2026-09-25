// Courses ("과목" folders, DESIGN §12): storage, membership moves, natural-sort insertion of new
// lectures, COURSE.md, and the HTTP routes (in-process server). No LLM is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { COURSE_ID_RE } from '../shared/types.ts';
import type { Course, DocMeta, ProviderInfo } from '../shared/types.ts';
import { HttpError, repoRoot } from '../server/config.ts';
import {
  addDocToCourse,
  compareTitles,
  courseMarkdown,
  courseOf,
  createCourse,
  deleteCourse,
  getCourse,
  insertionIndex,
  listCourses,
  removeDocFromCourses,
  updateCourse,
  writeCourseMarkdown,
} from '../server/courses.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import type { DigestRecord } from '../server/internal-types.ts';
import { coursePaths, docPaths, getDoc, listDocs, waitForIngest } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-courses-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

let docSeq = 0;

/** A minimal ready document (courses only need doc.json). */
async function makeDoc(title: string): Promise<string> {
  const docId = `doc-${String(++docSeq).padStart(3, '0')}-abcdef`;
  const paths = docPaths(docId);
  await fs.mkdir(paths.dir, { recursive: true });
  const meta: StoredDocMeta = {
    id: docId,
    title,
    fileName: `${title}.pdf`,
    pageCount: 3,
    aspectRatio: 4 / 3,
    status: 'ready',
    progress: 3,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, docSeq)).toISOString(),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
  return docId;
}

async function writeSummary(docId: string, summary: string | null): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.digestDir, { recursive: true });
  const record: DigestRecord = { version: 1, status: 'ready', slides: [], summary };
  await fs.writeFile(paths.digestJson, JSON.stringify(record));
}

function isHttpError(status: number) {
  return (err: unknown) => err instanceof HttpError && err.status === status;
}

let clock = Date.UTC(2026, 5, 1);
/** Strictly increasing creation times, so list order is deterministic. */
const tick = () => new Date((clock += 1000));

// ---------------------------------------------------------------------------
// Natural sort
// ---------------------------------------------------------------------------

describe('natural title order', () => {
  test('numbers compare by value, case and accents are ignored', () => {
    assert.ok(compareTitles('Lec 2', 'Lec 10') < 0);
    assert.ok(compareTitles('L7-Parsing-3 Top-down', 'L8-Semantic Analysis') < 0);
    assert.ok(compareTitles('lecture 9', 'Lecture 10') < 0);
    assert.equal(compareTitles('Lec 1', 'lec 1'), 0);
  });

  test('insertionIndex: sorted position in a naturally ordered course, else the end', () => {
    assert.equal(insertionIndex([], 'L1'), 0);
    assert.equal(insertionIndex(['L7', 'L9'], 'L8'), 1);
    assert.equal(insertionIndex(['L7', 'L9'], 'L10'), 2);
    assert.equal(insertionIndex(['Lec 2', 'Lec 10'], 'Lec 1'), 0);
    assert.equal(insertionIndex(['Lec 2', 'Lec 10'], 'Lec 3'), 1);
    // Equal titles go after the existing one.
    assert.equal(insertionIndex(['A', 'B'], 'A'), 1);
    // A hand-made order (not sorted) is left alone.
    assert.equal(insertionIndex(['L9', 'L7'], 'L8'), 2);
  });
});

// ---------------------------------------------------------------------------
// Storage and membership
// ---------------------------------------------------------------------------

describe('course storage', () => {
  test('create: slug + 6 hex id, unicode titles, course.json and COURSE.md', async () => {
    const course = await createCourse('  Compiler\n Design ', tick());
    assert.match(course.id, /^compiler-design-[0-9a-f]{6}$/);
    assert.match(course.id, COURSE_ID_RE);
    assert.equal(course.title, 'Compiler Design');
    assert.deepEqual(course.docIds, []);

    const onDisk = JSON.parse(await fs.readFile(coursePaths(course.id).courseJson, 'utf8'));
    assert.deepEqual(onDisk, { version: 1, ...course });
    assert.equal(
      await fs.readFile(coursePaths(course.id).courseMd, 'utf8'),
      '# Compiler Design — 과목 정리\n\n_(아직 강의가 없습니다)_\n',
    );

    const korean = await createCourse('컴파일러', tick());
    assert.match(korean.id, /^course-[0-9a-f]{6}$/);
    assert.equal(korean.title, '컴파일러');
    assert.deepEqual(await getCourse(korean.id), korean);
  });

  test('create validates the title', async () => {
    for (const title of ['', '   ', 42, null, undefined, 'x'.repeat(121)]) {
      await assert.rejects(createCourse(title), isHttpError(400), String(title));
    }
  });

  test('list is oldest first; getCourse of unknown / invalid ids is null', async () => {
    const a = await createCourse('Order A', tick());
    const b = await createCourse('Order B', tick());
    const ids = (await listCourses()).map((course) => course.id);
    assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id));
    assert.equal(await getCourse('missing-000000'), null);
    assert.equal(await getCourse('../etc'), null);
  });

  test('update: rename and set lectures; DocMeta.courseId follows', async () => {
    const lec1 = await makeDoc('Lec 1');
    const lec2 = await makeDoc('Lec 2');
    const course = await createCourse('OS', tick());

    const renamed = await updateCourse(course.id, { title: '운영체제' });
    assert.equal(renamed.title, '운영체제');
    assert.deepEqual(renamed.docIds, []);

    const filled = await updateCourse(course.id, { docIds: [lec2, lec1] });
    assert.deepEqual(filled.docIds, [lec2, lec1], 'the given order is kept');
    assert.equal(filled.title, '운영체제');
    assert.equal((await getDoc(lec1))?.courseId, course.id);
    assert.deepEqual(await courseOf(lec1), filled);

    // Omitted lectures become uncategorized.
    await updateCourse(course.id, { docIds: [lec1] });
    assert.equal((await getDoc(lec2))?.courseId, null);
    assert.equal(await courseOf(lec2), null);
  });

  test('update validation: unknown course 404; bad title, unknown ids, duplicates, wrong types 400', async () => {
    const doc = await makeDoc('Valid');
    const course = await createCourse('Validation', tick());
    await assert.rejects(updateCourse('missing-000000', { title: 'x' }), isHttpError(404));
    await assert.rejects(updateCourse(course.id, { title: '  ' }), isHttpError(400));
    await assert.rejects(updateCourse(course.id, { docIds: [doc, 'nope-000000'] }), isHttpError(400));
    await assert.rejects(updateCourse(course.id, { docIds: [doc, doc] }), isHttpError(400));
    await assert.rejects(updateCourse(course.id, { docIds: ['../etc'] }), isHttpError(400));
    await assert.rejects(updateCourse(course.id, { docIds: 'x' }), isHttpError(400));
    await assert.rejects(updateCourse(course.id, { docIds: [1] }), isHttpError(400));
    assert.deepEqual((await getCourse(course.id))?.docIds, [], 'nothing was written');
  });

  test('listing a lecture in another course moves it', async () => {
    const shared = await makeDoc('Shared');
    const stays = await makeDoc('Stays');
    const from = await createCourse('From', tick());
    const to = await createCourse('To', tick());
    await updateCourse(from.id, { docIds: [shared, stays] });
    await updateCourse(to.id, { docIds: [shared] });
    assert.deepEqual((await getCourse(from.id))?.docIds, [stays]);
    assert.deepEqual((await getCourse(to.id))?.docIds, [shared]);
    assert.equal((await getDoc(shared))?.courseId, to.id);
    // The file of the other course was rewritten too (not just hidden).
    const fromFile = JSON.parse(await fs.readFile(coursePaths(from.id).courseJson, 'utf8'));
    assert.deepEqual(fromFile.docIds, [stays]);
  });

  test('delete keeps the lectures (they become uncategorized)', async () => {
    const doc = await makeDoc('Kept');
    const course = await createCourse('Doomed', tick());
    await updateCourse(course.id, { docIds: [doc] });
    assert.equal(await deleteCourse(course.id), true);
    await assert.rejects(fs.access(coursePaths(course.id).dir));
    assert.equal(await getCourse(course.id), null);
    const meta = await getDoc(doc);
    assert.equal(meta?.status, 'ready');
    assert.equal(meta?.courseId, null);
    assert.equal(await deleteCourse(course.id), false);
    await assert.rejects(updateCourse(course.id, { title: 'x' }), isHttpError(404));
  });

  test('lectures whose folder was removed by hand are hidden', async () => {
    const kept = await makeDoc('Present');
    const gone = await makeDoc('Gone');
    const course = await createCourse('Pruned', tick());
    await updateCourse(course.id, { docIds: [kept, gone] });
    await fs.rm(docPaths(gone).dir, { recursive: true });
    assert.deepEqual((await getCourse(course.id))?.docIds, [kept]);
    assert.deepEqual((await listCourses()).find((c) => c.id === course.id)?.docIds, [kept]);
  });

  test('removeDocFromCourses takes a lecture out of the course files and rewrites COURSE.md', async () => {
    const stays = await makeDoc('Stays');
    const leaves = await makeDoc('Leaves');
    const course = await createCourse('Shrinking', tick());
    const other = await createCourse('Untouched', tick());
    await updateCourse(course.id, { docIds: [stays, leaves] });
    await updateCourse(other.id, { docIds: [] });
    assert.match(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /Leaves/);

    assert.deepEqual(await removeDocFromCourses(leaves), [course.id]);
    const record = JSON.parse(await fs.readFile(coursePaths(course.id).courseJson, 'utf8')) as { docIds: string[] };
    assert.deepEqual(record.docIds, [stays]);
    assert.doesNotMatch(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /Leaves/);
    assert.equal((await getDoc(leaves))?.courseId, null);
    assert.deepEqual(await removeDocFromCourses(leaves), [], 'nothing left to remove');
  });

  test('concurrent updates are serialized (no lost writes)', async () => {
    const course = await createCourse('Busy', tick());
    const docs = await Promise.all(['B1', 'B2', 'B3', 'B4', 'B5'].map((title) => makeDoc(title)));
    await Promise.all(docs.map((doc) => addDocToCourse(course.id, doc)));
    assert.deepEqual((await getCourse(course.id))?.docIds, docs, 'natural order B1..B5');
    const leftovers = (await fs.readdir(coursePaths(course.id).dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

describe('adding a new lecture', () => {
  test('lands at its natural-sort position; removed from its previous course', async () => {
    const l7 = await makeDoc('L7-Parsing-3 Top-down (updated)');
    const l9 = await makeDoc('L9-Code Generation');
    const l8 = await makeDoc('L8-Semantic Analysis');
    const l10 = await makeDoc('L10-Optimization');
    const course = await createCourse('Compiler', tick());
    const other = await createCourse('Elsewhere', tick());
    await updateCourse(course.id, { docIds: [l7, l9] });
    await updateCourse(other.id, { docIds: [l8] });

    let updated = await addDocToCourse(course.id, l8);
    assert.deepEqual(updated.docIds, [l7, l8, l9]);
    assert.deepEqual((await getCourse(other.id))?.docIds, []);
    updated = await addDocToCourse(course.id, l10);
    assert.deepEqual(updated.docIds, [l7, l8, l9, l10]);
    // Adding again is a no-op.
    assert.deepEqual((await addDocToCourse(course.id, l8)).docIds, [l7, l8, l9, l10]);
  });

  test('a hand-ordered course gets the new lecture appended', async () => {
    const b = await makeDoc('Part B');
    const a = await makeDoc('Part A');
    const c = await makeDoc('Part C');
    const course = await createCourse('Custom order', tick());
    await updateCourse(course.id, { docIds: [b, a] });
    assert.deepEqual((await addDocToCourse(course.id, c)).docIds, [b, a, c]);
  });

  test('unknown course is a 400', async () => {
    const doc = await makeDoc('Orphan');
    await assert.rejects(addDocToCourse('missing-000000', doc), isHttpError(400));
  });
});

// ---------------------------------------------------------------------------
// COURSE.md
// ---------------------------------------------------------------------------

describe('COURSE.md', () => {
  test('lectures in order with their summary or _(정리본 없음)_ and relative links', async () => {
    const first = await makeDoc('Lecture 1: Intro');
    const second = await makeDoc('Lecture 2: Lexing');
    await writeSummary(first, '## 주제\n컴파일러 개요 $\\alpha$\n\n```\n# code stays\n```');
    await writeSummary(second, null);
    const course = await createCourse('Compilers', tick());
    await updateCourse(course.id, { docIds: [first, second] });

    const expected = [
      '# Compilers — 과목 정리',
      '',
      '## 1. Lecture 1: Intro',
      '',
      '#### 주제',
      '컴파일러 개요 $\\alpha$',
      '',
      '```',
      '# code stays',
      '```',
      '',
      `[DIGEST.md](../../${first}/DIGEST.md) · [STUDY_NOTES.md](../../${first}/STUDY_NOTES.md)`,
      '',
      '## 2. Lecture 2: Lexing',
      '',
      '_(정리본 없음)_',
      '',
      `[DIGEST.md](../../${second}/DIGEST.md) · [STUDY_NOTES.md](../../${second}/STUDY_NOTES.md)`,
      '',
    ].join('\n');
    assert.equal(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), expected);

    // Relative links resolve from library/courses/<id>/ to library/<docId>/.
    assert.equal(
      path.resolve(coursePaths(course.id).dir, `../../${first}/DIGEST.md`),
      docPaths(first).digestMd,
    );

    // A summary arriving later shows up on regeneration.
    await writeSummary(second, 'Lexing 요약');
    await writeCourseMarkdown(course.id);
    assert.match(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /## 2\. Lecture 2: Lexing\n\nLexing 요약\n/);
  });

  test('courseMarkdown is pure', () => {
    assert.equal(courseMarkdown('Empty', []), '# Empty — 과목 정리\n\n_(아직 강의가 없습니다)_\n');
    assert.equal(
      courseMarkdown('C', [{ docId: 'd-000001', title: 'T', summary: '  ' }]),
      '# C — 과목 정리\n\n## 1. T\n\n_(정리본 없음)_\n\n[DIGEST.md](../../d-000001/DIGEST.md) · [STUDY_NOTES.md](../../d-000001/STUDY_NOTES.md)\n',
    );
  });

  test('writeCourseMarkdown of a deleted course is a no-op', async () => {
    const course = await createCourse('Gone soon', tick());
    await deleteCourse(course.id);
    await writeCourseMarkdown(course.id);
    await assert.rejects(fs.access(coursePaths(course.id).dir));
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('HTTP routes', () => {
  let server: RunningServer;
  let base = '';
  const infos: ProviderInfo[] = [{ id: 'claude-code', label: 'Claude Code', kind: 'cli', available: true, models: [], defaultModel: '' }];
  const uploaded: string[] = [];

  before(async () => {
    server = await startServer({ port: 0, log: false, resumeIngests: false, providerInfos: async () => infos });
    base = server.url;
  });

  after(async () => {
    await Promise.all(uploaded.map((docId) => waitForIngest(docId)));
    await server?.close();
  });

  const api = (p: string, init?: RequestInit) => fetch(`${base}/api${p}`, init);
  const sendJson = (method: string, p: string, body: unknown) =>
    api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function expectError(res: Response, status: number): Promise<string> {
    assert.equal(res.status, status);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, 'string');
    return body.error;
  }

  test('CRUD with validation', async () => {
    await expectError(await sendJson('POST', '/courses', {}), 400);
    await expectError(await sendJson('POST', '/courses', { title: '   ' }), 400);

    const created = await sendJson('POST', '/courses', { title: '컴파일러' });
    assert.equal(created.status, 201);
    const course = (await created.json()) as Course;
    assert.equal(course.title, '컴파일러');
    assert.deepEqual(course.docIds, []);

    const list = (await (await api('/courses')).json()) as Course[];
    assert.equal(list.at(-1)?.id, course.id, 'oldest first, the new course last');

    const lecture = await makeDoc('HTTP Lecture');
    const patched = await sendJson('PATCH', `/courses/${course.id}`, { title: 'Compiler', docIds: [lecture] });
    assert.equal(patched.status, 200);
    assert.deepEqual((await patched.json()) as Course, { ...course, title: 'Compiler', docIds: [lecture] });
    const doc = (await (await api(`/docs/${lecture}`)).json()) as DocMeta;
    assert.equal(doc.courseId, course.id);
    assert.equal(doc.digestStatus, 'none');

    await expectError(await sendJson('PATCH', `/courses/${course.id}`, { docIds: ['nope-000000'] }), 400);
    await expectError(await sendJson('PATCH', `/courses/${course.id}`, { docIds: [lecture, lecture] }), 400);
    await expectError(await sendJson('PATCH', '/courses/missing-000000', { title: 'x' }), 404);
    await expectError(await sendJson('PATCH', '/courses/BAD%20ID', { title: 'x' }), 404);

    const md = await api(`/courses/${course.id}/summary.md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type') ?? '', /^text\/markdown; charset=utf-8/);
    assert.match(await md.text(), /^# Compiler — 과목 정리\n\n## 1\. HTTP Lecture\n\n_\(정리본 없음\)_/);
    await expectError(await api('/courses/missing-000000/summary.md'), 404);

    assert.equal((await api(`/courses/${course.id}`, { method: 'DELETE' })).status, 204);
    await expectError(await api(`/courses/${course.id}`, { method: 'DELETE' }), 404);
    assert.equal(((await (await api(`/docs/${lecture}`)).json()) as DocMeta).courseId, null);
  });

  test('upload with X-Course-Id inserts the lecture by natural order', async () => {
    const pdf = await fs.readFile(path.join(repoRoot(), 'samples', 'sample-lecture.pdf'));
    const upload = (fileName: string, courseId?: string) =>
      api('/docs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-Filename': encodeURIComponent(fileName),
          ...(courseId === undefined ? {} : { 'X-Course-Id': courseId }),
        },
        body: pdf,
      });

    await expectError(await upload('L8.pdf', 'missing-000000'), 400);
    await expectError(await upload('L8.pdf', '../evil'), 400);

    const l7 = await makeDoc('L7-Parsing-3 Top-down (updated)');
    const l9 = await makeDoc('L9-Code Generation');
    const course = (await (await sendJson('POST', '/courses', { title: 'Compiler' })).json()) as Course;
    await sendJson('PATCH', `/courses/${course.id}`, { docIds: [l7, l9] });

    const res = await upload('L8-Semantic Analysis.pdf', course.id);
    assert.equal(res.status, 201);
    const meta = (await res.json()) as DocMeta;
    uploaded.push(meta.id);
    assert.equal(meta.courseId, course.id);
    assert.equal(meta.digestStatus, 'none');
    assert.equal(meta.status, 'processing');

    const stored = (await (await api('/courses')).json()) as Course[];
    assert.deepEqual(stored.find((c) => c.id === course.id)?.docIds, [l7, meta.id, l9]);
    const docs = (await (await api('/docs')).json()) as DocMeta[];
    assert.equal(docs.find((d) => d.id === meta.id)?.courseId, course.id);
    assert.ok(!docs.some((d) => d.id === 'courses'), 'library/courses is not a document');

    // Without the header the upload stays uncategorized.
    const plain = await upload('Loose.pdf');
    const plainMeta = (await plain.json()) as DocMeta;
    uploaded.push(plainMeta.id);
    assert.equal(plainMeta.courseId, null);
    assert.equal((await listDocs()).find((d) => d.id === plainMeta.id)?.courseId, null);
  });

  test('DELETE /docs/:docId removes the lecture from its course and rewrites COURSE.md', async () => {
    const l1 = await makeDoc('Del L1');
    const l2 = await makeDoc('Del L2');
    const l3 = await makeDoc('Del L3');
    await writeSummary(l2, 'SUMMARY OF L2');
    const course = (await (await sendJson('POST', '/courses', { title: 'Deleting' })).json()) as Course;
    await sendJson('PATCH', `/courses/${course.id}`, { docIds: [l1, l2, l3] });
    assert.match(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /## 2\. Del L2\n\nSUMMARY OF L2/);

    assert.equal((await api(`/docs/${l2}`, { method: 'DELETE' })).status, 204);
    await expectError(await api(`/docs/${l2}`), 404);
    await assert.rejects(fs.access(docPaths(l2).dir));
    const record = JSON.parse(await fs.readFile(coursePaths(course.id).courseJson, 'utf8')) as { docIds: string[] };
    assert.deepEqual(record.docIds, [l1, l3], 'course.json no longer lists it');
    assert.deepEqual((await getCourse(course.id))?.docIds, [l1, l3]);
    const md = await fs.readFile(coursePaths(course.id).courseMd, 'utf8');
    assert.doesNotMatch(md, /Del L2|SUMMARY OF L2/);
    assert.match(md, /## 1\. Del L1[\s\S]*## 2\. Del L3/);

    await expectError(await api(`/docs/${l2}`, { method: 'DELETE' }), 404);
    await expectError(await api('/docs/courses', { method: 'DELETE' }), 404);
    assert.ok(await getCourse(course.id), 'the course itself stays');
  });

  test('POST /docs/:docId/retry converts a failed lecture again', async () => {
    const docId = await makeDoc('Broken L8');
    const paths = docPaths(docId);
    const broken = JSON.parse(await fs.readFile(paths.docJson, 'utf8')) as StoredDocMeta;
    await fs.writeFile(paths.docJson, JSON.stringify({ ...broken, status: 'error', error: 'could not read the PDF: the file is damaged or is not a PDF' }));
    await fs.copyFile(path.join(repoRoot(), 'samples', 'sample-lecture.pdf'), paths.sourcePdf);

    const res = await api(`/docs/${docId}/retry`, { method: 'POST' });
    assert.equal(res.status, 202);
    const meta = (await res.json()) as DocMeta;
    assert.equal(meta.status, 'processing');
    assert.equal(meta.error, undefined);
    await expectError(await api(`/docs/${docId}/retry`, { method: 'POST' }), 409);
    await waitForIngest(docId);
    const ready = (await (await api(`/docs/${docId}`)).json()) as DocMeta;
    assert.equal(ready.status, 'ready');
    assert.equal(ready.pageCount, 9);
    assert.equal(ready.error, undefined);
    await expectError(await api(`/docs/${docId}/retry`, { method: 'POST' }), 409);
    await expectError(await api('/docs/missing-000000/retry', { method: 'POST' }), 404);
  });
});
