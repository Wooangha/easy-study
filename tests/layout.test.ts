// Library organization (DESIGN §18): the normalisation of library/layout.json, PUT /api/layout validation,
// course groups, the cleanup when courses or groups are deleted, serialization with the course mutations, and
// the HTTP routes (in-process server on an ephemeral port). No LLM is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { layoutRevision } from '../shared/layoutRevision.ts';
import { COURSE_ID_RE } from '../shared/types.ts';
import type { Course, CourseGroup, LayoutItem, LibraryLayout, PutLayoutRequest } from '../shared/types.ts';
import { HttpError } from '../server/config.ts';
import {
  LAYOUT_FILE_NAME,
  createCourse,
  createGroup,
  deleteCourse,
  deleteGroup,
  getLayout,
  layoutFile,
  listCourses,
  putLayout,
  updateCourse,
  updateGroup,
} from '../server/courses.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import type { LayoutRecord } from '../server/internal-types.ts';
import { listIds, normalizeLayout, validateGroupCourseIds, validateLayoutRequest } from '../server/layout.ts';
import { coursePaths, docPaths, getDoc } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';

let tmpRoot = '';
let libraryCount = 0;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-layout-'));
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A fresh, empty library, made current (EASY_STUDY_LIBRARY is read lazily), so each test sees only its courses. */
async function useLibrary(): Promise<string> {
  const dir = path.join(tmpRoot, `library-${++libraryCount}`);
  await fs.mkdir(dir, { recursive: true });
  process.env.EASY_STUDY_LIBRARY = dir;
  return dir;
}

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

let clock = Date.UTC(2026, 5, 1);
/** Strictly increasing creation times, so createdAt order is deterministic. */
const tick = () => new Date((clock += 1000));

function isHttpError(status: number, message?: RegExp) {
  return (err: unknown) => err instanceof HttpError && err.status === status && (message === undefined || message.test(err.message));
}

const course = (id: string): LayoutItem => ({ type: 'course', id });
const group = (id: string): LayoutItem => ({ type: 'group', id });

/** Several courses, oldest first. */
async function makeCourses(...titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) ids.push((await createCourse(title, tick())).id);
  return ids;
}

async function readLayoutFile(): Promise<LayoutRecord> {
  return JSON.parse(await fs.readFile(layoutFile(), 'utf8')) as LayoutRecord;
}

async function layoutFileExists(): Promise<boolean> {
  return fs.access(layoutFile()).then(
    () => true,
    () => false,
  );
}

/** The request that reproduces a layout (what a client sends after a drag). */
function asRequest(layout: LibraryLayout): PutLayoutRequest {
  return { groups: layout.groups.map(({ id, courseIds }) => ({ id, courseIds })), order: layout.order };
}

// ---------------------------------------------------------------------------
// Normalisation (pure)
// ---------------------------------------------------------------------------

describe('normalizeLayout', () => {
  const A = 'a-aaaaaa';
  const B = 'b-bbbbbb';
  const C = 'c-cccccc';
  const D = 'd-dddddd';
  const courses = [A, B, C, D]; // oldest first
  const g = (id: string, courseIds: string[], title = `Group ${id}`): CourseGroup => ({ id, title, createdAt: '2026-06-01T00:00:00.000Z', courseIds });

  test('no layout.json (or garbage): every course at the top level, oldest first', () => {
    const expected: LibraryLayout = { groups: [], order: courses.map(course) };
    for (const stored of [null, undefined, 42, 'x', [], {}, { groups: 'x', order: {} }]) {
      assert.deepEqual(normalizeLayout(stored, courses), expected, JSON.stringify(stored));
    }
    assert.deepEqual(normalizeLayout(null, []), { groups: [], order: [] });
  });

  test('a normalised layout stays as it is', () => {
    const layout: LibraryLayout = { groups: [g('sem-111111', [C, A]), g('empty-222222', [])], order: [course(D), group('sem-111111'), course(B), group('empty-222222')] };
    assert.deepEqual(normalizeLayout({ version: 1, ...layout }, courses), layout);
  });

  test('unknown or deleted ids and malformed entries are dropped', () => {
    const stored = {
      version: 1,
      groups: [
        g('sem-111111', [A, 'gone-000000', 7 as unknown as string, B]),
        { id: '../evil', title: 'x', courseIds: [C] },
        { id: 'untitled-333333', courseIds: [C] },
        'not a group',
        { ...g('sem-111111', [D]), title: 'second definition of the same id' },
      ],
      order: [
        course('gone-000000'),
        group('missing-444444'),
        group('sem-111111'),
        { type: 'folder', id: C },
        { type: 'course' },
        null,
        course(C),
      ],
    };
    assert.deepEqual(normalizeLayout(stored, courses), {
      groups: [g('sem-111111', [A, B])],
      order: [group('sem-111111'), course(C), course(D)],
    });
  });

  test('a course listed twice keeps its first position in display order', () => {
    const stored = {
      groups: [g('g1-111111', [A, B, A]), g('g2-222222', [B, C])],
      order: [course(C), group('g2-222222'), group('g1-111111'), course(B), course(C)],
    };
    assert.deepEqual(normalizeLayout(stored, courses), {
      groups: [g('g2-222222', [B]), g('g1-111111', [A])],
      order: [course(C), group('g2-222222'), group('g1-111111'), course(D)],
    });
  });

  test('a group listed twice keeps its first position', () => {
    const stored = { groups: [g('g1-111111', [A])], order: [group('g1-111111'), course(B), group('g1-111111')] };
    assert.deepEqual(normalizeLayout(stored, courses), {
      groups: [g('g1-111111', [A])],
      order: [group('g1-111111'), course(B), course(C), course(D)],
    });
  });

  test('groups missing from order are appended, then unmentioned courses in createdAt order', () => {
    const stored = { groups: [g('g1-111111', [C]), g('g2-222222', [])], order: [course(B)] };
    assert.deepEqual(normalizeLayout(stored, courses), {
      groups: [g('g1-111111', [C]), g('g2-222222', [])],
      order: [course(B), group('g1-111111'), group('g2-222222'), course(A), course(D)],
    });
  });

  test('missing createdAt / courseIds of a stored group are tolerated', () => {
    assert.deepEqual(normalizeLayout({ groups: [{ id: 'g1-111111', title: 'T' }], order: [] }, [A]), {
      groups: [{ id: 'g1-111111', title: 'T', createdAt: '', courseIds: [] }],
      order: [group('g1-111111'), course(A)],
    });
  });
});

// ---------------------------------------------------------------------------
// PUT validation (pure)
// ---------------------------------------------------------------------------

describe('validateLayoutRequest', () => {
  const A = 'a-aaaaaa';
  const B = 'b-bbbbbb';
  const C = 'c-cccccc';
  const D = 'd-dddddd';
  const courses = [A, B, C, D];
  const G1 = 'g1-111111';
  const G2 = 'g2-222222';
  const current: LibraryLayout = {
    groups: [
      { id: G1, title: '2026-1학기', createdAt: '2026-03-01T00:00:00.000Z', courseIds: [A, B] },
      { id: G2, title: '2026-2학기', createdAt: '2026-09-01T00:00:00.000Z', courseIds: [] },
    ],
    order: [group(G1), course(C), group(G2), course(D)],
  };
  const valid = (): PutLayoutRequest => ({
    groups: [
      { id: G2, courseIds: [C, A] },
      { id: G1, courseIds: [] },
    ],
    order: [course(D), group(G2), course(B), group(G1)],
  });
  const reject = (body: unknown, message: RegExp) =>
    assert.throws(() => validateLayoutRequest(body, current, courses), isHttpError(400, message), JSON.stringify(body));

  test('a full arrangement is accepted; titles and creation times are kept, groups follow the new order', () => {
    assert.deepEqual(validateLayoutRequest(valid(), current, courses), {
      groups: [
        { ...current.groups[1], courseIds: [C, A] },
        { ...current.groups[0], courseIds: [] },
      ],
      order: [course(D), group(G2), course(B), group(G1)],
    });
    // Extra fields (a title in the request) change nothing.
    const withTitle = { ...valid(), groups: valid().groups.map((entry) => ({ ...entry, title: 'hacked' })) };
    assert.equal(validateLayoutRequest(withTitle, current, courses).groups[0].title, '2026-2학기');
    // Re-sending the current layout is a no-op.
    assert.deepEqual(validateLayoutRequest(asRequest(current), current, courses), current);
  });

  test('malformed bodies', () => {
    const malformed = /배치 정보가 올바르지 않습니다/;
    for (const body of [
      null,
      [],
      'x',
      {},
      { groups: [] },
      { order: [] },
      { groups: {}, order: [] },
      { groups: [], order: 'x' },
      { ...valid(), groups: [{ id: G1 }, { id: G2, courseIds: [] }] },
      { ...valid(), groups: [{ id: G1, courseIds: [5] }, { id: G2, courseIds: [] }] },
      { ...valid(), groups: [{ courseIds: [] }, { id: G2, courseIds: [] }] },
      { ...valid(), order: [...valid().order, { type: 'folder', id: A }] },
      { ...valid(), order: [...valid().order, { type: 'course', id: 5 }] },
      { ...valid(), order: [...valid().order, null] },
    ]) {
      reject(body, malformed);
    }
  });

  test('unknown ids', () => {
    reject({ ...valid(), groups: [...valid().groups, { id: 'nope-000000', courseIds: [] }] }, /알 수 없는 그룹.*nope-000000/);
    reject({ ...valid(), order: [...valid().order, group('nope-000000')] }, /알 수 없는 그룹.*nope-000000/);
    reject({ ...valid(), order: [...valid().order, course('nope-000000')] }, /알 수 없는 과목.*nope-000000/);
    reject({ ...valid(), groups: [{ id: G2, courseIds: [C, A, '../etc'] }, { id: G1, courseIds: [] }] }, /알 수 없는 과목/);
    // A very long unknown id is not echoed back whole.
    const long = 'x'.repeat(5000);
    assert.throws(
      () => validateLayoutRequest({ ...valid(), order: [...valid().order, course(long)] }, current, courses),
      (err: unknown) => err instanceof HttpError && err.status === 400 && err.message.length < 300,
    );
  });

  test('duplicated ids', () => {
    // Twice in one group, in a group and at the top level, in two groups, twice at the top level.
    reject({ ...valid(), groups: [{ id: G2, courseIds: [C, A, C] }, { id: G1, courseIds: [] }] }, /같은 과목이 두 번.*c-cccccc/);
    reject({ ...valid(), groups: [{ id: G2, courseIds: [C, A, B] }, { id: G1, courseIds: [] }] }, /같은 과목이 두 번.*b-bbbbbb/);
    reject({ ...valid(), groups: [{ id: G2, courseIds: [C, A] }, { id: G1, courseIds: [A] }] }, /같은 과목이 두 번.*a-aaaaaa/);
    reject({ ...valid(), order: [...valid().order, course(D)] }, /같은 과목이 두 번.*d-dddddd/);
    // A group twice in `groups` or in `order`.
    reject({ ...valid(), groups: [...valid().groups, { id: G1, courseIds: [] }] }, /같은 그룹이 두 번.*g1-111111/);
    reject({ ...valid(), order: [...valid().order, group(G2)] }, /같은 그룹이 두 번.*g2-222222/);
  });

  test('an unknown group found in both `groups` and `order` is named once', () => {
    const stale = { groups: [...valid().groups, { id: 'gone-000000', courseIds: [] }], order: [...valid().order, group('gone-000000')] };
    assert.throws(
      () => validateLayoutRequest(stale, current, courses),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 400 &&
        /다른 곳에서 삭제/.test(err.message) &&
        err.message.split('gone-000000').length === 2,
    );
    assert.equal(listIds(['x', 'y', 'x', 'y', 'z']), 'x, y, z');
    assert.equal(listIds(['a', 'b', 'c', 'd', 'e', 'f', 'f', 'g']), 'a, b, c, d, e 외 2개');
  });

  test('baseRevision: made from the current arrangement or 409 (changed elsewhere); malformed = 400', () => {
    const revision = layoutRevision(current);
    assert.equal(revision, layoutRevision(structuredClone(current)));
    assert.deepEqual(validateLayoutRequest({ ...valid(), baseRevision: revision }, current, courses).order, valid().order);
    // Titles are not part of it (a PUT never changes them) …
    assert.equal(layoutRevision({ ...current, groups: current.groups.map((g) => ({ ...g, title: 'x' })) }), revision);
    // … the order and the courses of a group are.
    const moved: LibraryLayout = { ...current, order: [course(C), group(G1), group(G2), course(D)] };
    const regrouped: LibraryLayout = { ...current, groups: [{ ...current.groups[0], courseIds: [B, A] }, current.groups[1]] };
    for (const other of [moved, regrouped]) {
      assert.notEqual(layoutRevision(other), revision);
      assert.throws(
        () => validateLayoutRequest({ ...valid(), baseRevision: layoutRevision(other) }, current, courses),
        isHttpError(409, /다른 곳에서 과목 배치가 바뀌었습니다/),
      );
    }
    reject({ ...valid(), baseRevision: 5 }, /배치 정보가 올바르지 않습니다/);
  });

  test('missing courses or groups (e.g. created elsewhere in the meantime)', () => {
    reject({ ...valid(), order: [group(G2), course(B), group(G1)] }, /빠진 과목.*d-dddddd/);
    reject({ ...valid(), groups: [{ id: G2, courseIds: [C] }, { id: G1, courseIds: [] }] }, /빠진 과목.*a-aaaaaa/);
    // A group left out of `groups` (but in `order`), or out of `order` (but in `groups`).
    reject({ groups: [{ id: G2, courseIds: [C, A] }], order: valid().order }, /빠진 그룹.*g1-111111/);
    reject({ groups: valid().groups, order: [course(D), group(G2), course(B)] }, /빠진 그룹.*g1-111111/);
    // Everything gone: both kinds are missing, the groups are reported first.
    reject({ groups: [], order: [] }, /빠진 그룹/);
  });

  test('validateGroupCourseIds', () => {
    assert.deepEqual(validateGroupCourseIds(undefined, courses), []);
    assert.deepEqual(validateGroupCourseIds(null, courses), []);
    assert.deepEqual(validateGroupCourseIds([C, A], courses), [C, A]);
    for (const [value, message] of [
      ['x', /목록/],
      [[A, 3], /목록/],
      [[A, 'nope-000000'], /알 수 없는 과목/],
      [[A, A], /두 번/],
    ] as const) {
      assert.throws(() => validateGroupCourseIds(value, courses), isHttpError(400, message), JSON.stringify(value));
    }
  });
});

// ---------------------------------------------------------------------------
// Storage (library/layout.json) and mutations
// ---------------------------------------------------------------------------

describe('layout storage', () => {
  test('without layout.json every course is at the top level by createdAt, and reading writes nothing', async () => {
    await useLibrary();
    assert.deepEqual(await getLayout(), { groups: [], order: [] });
    const [a, b, c] = await makeCourses('A', 'B', 'C');
    assert.deepEqual(await getLayout(), { groups: [], order: [course(a), course(b), course(c)] });
    // Courses created without a group need no layout.json either (a course it does not mention goes last).
    assert.equal(await layoutFileExists(), false, 'no layout.json until something is arranged');
    assert.equal(layoutFile(), path.join(process.env.EASY_STUDY_LIBRARY ?? '', LAYOUT_FILE_NAME));
  });

  test('createGroup: id, title, appended to the top level; listed courses move into it', async () => {
    await useLibrary();
    const [os1, db, net, pl] = await makeCourses('OS', 'DB', 'Network', 'PL');
    const spring = await createGroup('  2026-1학기\n', [db], tick());
    assert.match(spring.id, /^2026-1-[0-9a-f]{6}$/);
    assert.match(spring.id, COURSE_ID_RE);
    assert.equal(spring.title, '2026-1학기');
    assert.deepEqual(spring.courseIds, [db]);
    assert.deepEqual(await getLayout(), { groups: [spring], order: [course(os1), course(net), course(pl), group(spring.id)] });

    // Moving from another group and from the top level, in the given order.
    const fall = await createGroup('가을 학기', [pl, db], tick());
    assert.match(fall.id, /^group-[0-9a-f]{6}$/, 'unicode titles get the fallback slug');
    const layout = await getLayout();
    assert.deepEqual(layout, {
      groups: [{ ...spring, courseIds: [] }, fall],
      order: [course(os1), course(net), group(spring.id), group(fall.id)],
    });

    // On disk: pretty JSON with a version, the same arrangement, no temp files.
    const raw = await fs.readFile(layoutFile(), 'utf8');
    assert.ok(raw.endsWith('\n') && raw.includes('\n  "groups"'));
    assert.deepEqual(await readLayoutFile(), { version: 1, ...layout });
    const leftovers = (await fs.readdir(path.dirname(layoutFile()))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);

    // An empty group is fine.
    const empty = await createGroup('Empty', undefined, tick());
    assert.deepEqual(empty.courseIds, []);
    assert.deepEqual((await getLayout()).order.at(-1), group(empty.id));
  });

  test('createGroup validation writes nothing', async () => {
    await useLibrary();
    const [a] = await makeCourses('A');
    for (const title of ['', '   ', 42, null, undefined, 'x'.repeat(121)]) {
      await assert.rejects(createGroup(title, [a]), isHttpError(400, /그룹 이름/), String(title));
    }
    await assert.rejects(createGroup('G', [a, 'nope-000000']), isHttpError(400, /알 수 없는 과목/));
    await assert.rejects(createGroup('G', [a, a]), isHttpError(400, /두 번/));
    await assert.rejects(createGroup('G', 'x'), isHttpError(400));
    assert.equal(await layoutFileExists(), false);
    // 120 characters is the limit, for groups and courses alike.
    assert.equal((await createGroup('g'.repeat(120), [], tick())).title.length, 120);
    assert.equal((await createCourse('c'.repeat(120), tick())).title.length, 120);
  });

  test('createCourse with groupId goes to the end of that group; an unknown group creates nothing', async () => {
    await useLibrary();
    const [a, b] = await makeCourses('A', 'B');
    const sem = await createGroup('Semester', [b], tick());
    const created = await createCourse('Compiler', tick(), sem.id);
    assert.deepEqual(created.docIds, []);
    assert.deepEqual(await getLayout(), { groups: [{ ...sem, courseIds: [b, created.id] }], order: [course(a), group(sem.id)] });
    // COURSE.md is written as for any course.
    assert.match(await fs.readFile(coursePaths(created.id).courseMd, 'utf8'), /^# Compiler — 과목 정리/);

    const before = (await listCourses()).map((c) => c.id);
    await assert.rejects(createCourse('Orphan', tick(), 'missing-000000'), isHttpError(400, /그룹을 찾을 수 없습니다/));
    await assert.rejects(createCourse('Orphan', tick(), '../evil'), isHttpError(400));
    await assert.rejects(createCourse('Orphan', tick(), 42), isHttpError(400));
    assert.deepEqual((await listCourses()).map((c) => c.id), before, 'no course was created');
    assert.deepEqual((await fs.readdir(path.join(path.dirname(layoutFile()), 'courses'))).sort(), [...before].sort());

    // Absent group ids mean the top level.
    for (const none of [undefined, null, '']) {
      const top = await createCourse(`Top ${String(none)}`, tick(), none);
      assert.deepEqual((await getLayout()).order.at(-1), course(top.id));
    }
  });

  test('updateGroup renames; unknown group 404, bad title 400', async () => {
    await useLibrary();
    const [a] = await makeCourses('A');
    const sem = await createGroup('Old', [a], tick());
    const renamed = await updateGroup(sem.id, { title: ' 새 이름 ' });
    assert.deepEqual(renamed, { ...sem, title: '새 이름' });
    assert.deepEqual((await getLayout()).groups, [renamed]);
    await assert.rejects(updateGroup('missing-000000', { title: 'x' }), isHttpError(404));
    await assert.rejects(updateGroup(sem.id, { title: '  ' }), isHttpError(400));
    await assert.rejects(updateGroup(sem.id, {}), isHttpError(400));
    assert.equal((await getLayout()).groups[0].title, '새 이름');
  });

  test('deleteGroup moves its courses to the top level at its position; courses and lectures are kept', async () => {
    await useLibrary();
    const lecture = await makeDoc('Lec 1');
    const [a, b, c, d] = await makeCourses('A', 'B', 'C', 'D');
    await updateCourse(b, { docIds: [lecture] });
    const sem = await createGroup('Semester', [c, b], tick());
    const other = await createGroup('Other', [d], tick());
    await putLayout({
      groups: [
        { id: sem.id, courseIds: [c, b] },
        { id: other.id, courseIds: [d] },
      ],
      order: [group(other.id), group(sem.id), course(a)],
    });
    assert.equal(await deleteGroup(sem.id), true);
    assert.deepEqual(await getLayout(), { groups: [other], order: [group(other.id), course(c), course(b), course(a)] });
    assert.deepEqual((await listCourses()).map((x) => x.id), [a, b, c, d], 'every course is kept');
    assert.equal((await getDoc(lecture))?.courseId, b, 'the lecture stays in its course');
    assert.equal(await deleteGroup(sem.id), false);
    await assert.rejects(updateGroup(sem.id, { title: 'x' }), isHttpError(404));
  });

  test('deleting a course removes it from layout.json (not just hidden)', async () => {
    await useLibrary();
    const [a, b, c] = await makeCourses('A', 'B', 'C');
    const sem = await createGroup('Semester', [a, b], tick());
    assert.equal(await deleteCourse(b), true);
    const expected: LibraryLayout = { groups: [{ ...sem, courseIds: [a] }], order: [course(c), group(sem.id)] };
    assert.deepEqual(await getLayout(), expected);
    assert.deepEqual(await readLayoutFile(), { version: 1, ...expected });
    assert.doesNotMatch(await fs.readFile(layoutFile(), 'utf8'), new RegExp(b));

    // A top-level course too.
    await deleteCourse(c);
    assert.deepEqual((await readLayoutFile()).order, [group(sem.id)]);
  });

  test('deleting a course without layout.json does not create one', async () => {
    await useLibrary();
    const [a] = await makeCourses('A');
    assert.equal(await deleteCourse(a), true);
    assert.equal(await layoutFileExists(), false);
  });

  test('a course folder removed by hand disappears from the layout; a corrupt layout.json reads as the default', async () => {
    await useLibrary();
    const [a, b] = await makeCourses('A', 'B');
    const sem = await createGroup('Semester', [a], tick());
    await fs.rm(coursePaths(a).dir, { recursive: true });
    assert.deepEqual(await getLayout(), { groups: [{ ...sem, courseIds: [] }], order: [course(b), group(sem.id)] });

    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    try {
      await fs.writeFile(layoutFile(), '{ not json');
      assert.deepEqual(await getLayout(), { groups: [], order: [course(b)] });
      assert.match(warnings.join('\n'), /layout\.json/);
      // The next arrangement replaces it.
      const fresh = await createGroup('Fresh', [b], tick());
      assert.deepEqual(await readLayoutFile(), { version: 1, groups: [fresh], order: [group(fresh.id)] });
    } finally {
      console.warn = warn;
    }
  });

  test('putLayout applies the arrangement; a rejected request writes nothing', async () => {
    await useLibrary();
    const [a, b, c] = await makeCourses('A', 'B', 'C');
    const g1 = await createGroup('G1', [], tick());
    const g2 = await createGroup('G2', [], tick());
    const request: PutLayoutRequest = {
      groups: [
        { id: g1.id, courseIds: [c] },
        { id: g2.id, courseIds: [a, b] },
      ],
      order: [group(g2.id), group(g1.id)],
    };
    const expected: LibraryLayout = { groups: [{ ...g2, courseIds: [a, b] }, { ...g1, courseIds: [c] }], order: [group(g2.id), group(g1.id)] };
    assert.deepEqual(await putLayout(request), expected);
    assert.deepEqual(await getLayout(), expected);
    const onDisk = await fs.readFile(layoutFile(), 'utf8');

    await assert.rejects(putLayout({ ...request, order: [group(g2.id)] }), isHttpError(400, /빠진 그룹/));
    await assert.rejects(putLayout({ ...request, order: [...request.order, course(a)] }), isHttpError(400, /두 번/));
    await assert.rejects(putLayout({ ...request, order: [...request.order, course('nope-000000')] }), isHttpError(400, /알 수 없는/));
    await assert.rejects(putLayout(undefined), isHttpError(400));
    assert.equal(await fs.readFile(layoutFile(), 'utf8'), onDisk, 'nothing was written');
  });

  test('a PUT or a lecture PATCH made from stale data is refused (409) and writes nothing', async () => {
    await useLibrary();
    const [l1, l2, l3] = [await makeDoc('L1'), await makeDoc('L2'), await makeDoc('L3')];
    const [a, b] = await makeCourses('A', 'B');
    await updateCourse(a, { docIds: [l1, l2] });
    const seen = await getLayout(); // what a tab loaded
    const sem = await createGroup('Sem', [b], tick()); // …then another tab made a group
    const onDisk = await fs.readFile(layoutFile(), 'utf8');
    await assert.rejects(
      putLayout({ ...asRequest(await getLayout()), baseRevision: layoutRevision(seen) }),
      isHttpError(409, /다른 곳에서 과목 배치가 바뀌었습니다/),
    );
    assert.equal(await fs.readFile(layoutFile(), 'utf8'), onDisk, 'nothing was written');
    const now = await getLayout();
    const next: PutLayoutRequest = { groups: [{ id: sem.id, courseIds: [a, b] }], order: [group(sem.id)], baseRevision: layoutRevision(now) };
    assert.deepEqual((await putLayout(next)).groups[0].courseIds, [a, b]);

    // Lectures: another tab moved L3 into A; a PATCH made from the old list [L1, L2] would drop it.
    await updateCourse(a, { docIds: [l1, l2, l3], baseDocIds: [l1, l2] });
    const courseJson = await fs.readFile(coursePaths(a).courseJson, 'utf8');
    await assert.rejects(updateCourse(a, { docIds: [l2, l1], baseDocIds: [l1, l2] }), isHttpError(409, /강의 목록이 바뀌었습니다/));
    await assert.rejects(updateCourse(a, { docIds: [l2, l1], baseDocIds: 'x' }), isHttpError(400, /baseDocIds/));
    assert.equal(await fs.readFile(coursePaths(a).courseJson, 'utf8'), courseJson, 'nothing was written');
    assert.deepEqual((await updateCourse(a, { docIds: [l2, l1, l3], baseDocIds: [l1, l2, l3] })).docIds, [l2, l1, l3]);
    // A rename needs no base.
    assert.equal((await updateCourse(a, { title: 'A2' })).title, 'A2');
  });

  test('arranging leaves course.json and COURSE.md alone', async () => {
    await useLibrary();
    const lecture = await makeDoc('Lecture 1');
    const [a, b] = await makeCourses('A', 'B');
    await updateCourse(a, { docIds: [lecture] });
    const snapshot = async () =>
      Promise.all([a, b].flatMap((id) => [fs.readFile(coursePaths(id).courseJson, 'utf8'), fs.readFile(coursePaths(id).courseMd, 'utf8')]));
    const before = await snapshot();

    const sem = await createGroup('Semester', [b, a], tick());
    await updateGroup(sem.id, { title: 'Renamed' });
    await putLayout({ groups: [{ id: sem.id, courseIds: [a] }], order: [course(b), group(sem.id)] });
    await deleteGroup(sem.id);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await getDoc(lecture))?.courseId, a);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: every layout change goes through the course mutation queue
// ---------------------------------------------------------------------------

describe('serialized with the course mutations', () => {
  test('parallel group creations, renames and course creations lose nothing', async () => {
    await useLibrary();
    const [a, b, c, d, e, f] = await makeCourses('A', 'B', 'C', 'D', 'E', 'F');
    const groups = await Promise.all(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'].map((title) => createGroup(title)));
    let layout = await getLayout();
    assert.equal(layout.groups.length, 8);
    assert.deepEqual(new Set(layout.groups.map((g) => g.id)), new Set(groups.map((g) => g.id)));
    assert.deepEqual(layout.order.slice(0, 6), [a, b, c, d, e, f].map(course));
    // Same call order = same queue order.
    assert.deepEqual(layout.order.slice(6), groups.map((g) => group(g.id)));

    // Every group renamed and given a new course, all at once, while courses move into groups.
    const created = await Promise.all([
      ...groups.map((g, i) => updateGroup(g.id, { title: `Renamed ${i}` })),
      ...groups.map((g, i) => createCourse(`New ${i}`, tick(), g.id)),
      createGroup('Mover', [a, b, c]),
    ]);
    const newCourses = created.slice(8, 16) as Course[];
    const mover = created[16] as CourseGroup;
    layout = await getLayout();
    groups.forEach((g, i) => {
      const stored = layout.groups.find((candidate) => candidate.id === g.id);
      assert.equal(stored?.title, `Renamed ${i}`);
      assert.deepEqual(stored?.courseIds, [newCourses[i].id]);
    });
    assert.deepEqual(layout.groups.find((g) => g.id === mover.id)?.courseIds, [a, b, c]);
    assert.deepEqual(layout.order.slice(0, 3), [d, e, f].map(course));
    assert.deepEqual(await readLayoutFile(), { version: 1, ...layout });
  });

  test('parallel PUTs apply one after another: the last one wins whole, never a mix', async () => {
    await useLibrary();
    const [a, b, c] = await makeCourses('A', 'B', 'C');
    const g1 = await createGroup('G1', [], tick());
    const g2 = await createGroup('G2', [], tick());
    const x: PutLayoutRequest = { groups: [{ id: g1.id, courseIds: [a, b] }, { id: g2.id, courseIds: [c] }], order: [group(g1.id), group(g2.id)] };
    const y: PutLayoutRequest = { groups: [{ id: g2.id, courseIds: [b] }, { id: g1.id, courseIds: [] }], order: [course(c), group(g2.id), course(a), group(g1.id)] };
    const requests = [x, y, x, y, x, y, x, y];
    const results = await Promise.all(requests.map((request) => putLayout(request)));
    const membership = (groups: Array<{ id: string; courseIds: string[] }>) => Object.fromEntries(groups.map((g) => [g.id, g.courseIds]));
    results.forEach((result, i) => {
      // Each answer is exactly its own request (applied on top of the previous one, not merged with it).
      assert.deepEqual(result.order, requests[i].order);
      assert.deepEqual(membership(result.groups), membership(requests[i].groups));
    });
    const final = await getLayout();
    assert.deepEqual(final.order, y.order);
    assert.deepEqual(final.groups.map(({ id, courseIds }) => ({ id, courseIds })), [
      { id: g2.id, courseIds: [b] },
      { id: g1.id, courseIds: [] },
    ]);
    assert.deepEqual(final.groups.map((g) => g.title), ['G2', 'G1']);
  });

  test('a PUT queued after a course creation sees it (and is refused as incomplete); queued before, both apply', async () => {
    await useLibrary();
    const [a, b] = await makeCourses('A', 'B');
    const sem = await createGroup('Sem', [], tick());
    const arrangement: PutLayoutRequest = { groups: [{ id: sem.id, courseIds: [b, a] }], order: [group(sem.id)] };

    const [created, refused] = await Promise.allSettled([createCourse('Late', tick()), putLayout(arrangement)]);
    assert.equal(created.status, 'fulfilled');
    assert.equal(refused.status, 'rejected');
    assert.ok(isHttpError(400, /빠진 과목/)((refused as PromiseRejectedResult).reason));
    const late = (created as PromiseFulfilledResult<Course>).value;

    const [applied, second] = await Promise.all([
      putLayout({ groups: [{ id: sem.id, courseIds: [b, a] }], order: [group(sem.id), course(late.id)] }),
      createCourse('Later', tick(), sem.id),
    ]);
    assert.deepEqual(applied.order, [group(sem.id), course(late.id)]);
    assert.deepEqual(await getLayout(), { groups: [{ ...sem, courseIds: [b, a, second.id] }], order: [group(sem.id), course(late.id)] });
  });

  test('course PATCHes, group changes and PUTs at the same time', async () => {
    await useLibrary();
    const docs = await Promise.all(['L1', 'L2', 'L3', 'L4'].map((title) => makeDoc(title)));
    const [a, b] = await makeCourses('A', 'B');
    const sem = await createGroup('Sem', [a], tick());
    await Promise.all([
      updateCourse(a, { docIds: [docs[0], docs[1]] }),
      putLayout({ groups: [{ id: sem.id, courseIds: [b, a] }], order: [group(sem.id)] }),
      updateCourse(b, { title: 'B2', docIds: [docs[2]] }),
      updateGroup(sem.id, { title: 'Sem 2' }),
      updateCourse(a, { docIds: [docs[1], docs[0], docs[3]] }),
    ]);
    const courses = await listCourses();
    assert.deepEqual(courses.find((x) => x.id === a)?.docIds, [docs[1], docs[0], docs[3]]);
    assert.deepEqual(courses.find((x) => x.id === b), { id: b, title: 'B2', createdAt: courses[1].createdAt, docIds: [docs[2]] });
    assert.deepEqual(await getLayout(), { groups: [{ ...sem, title: 'Sem 2', courseIds: [b, a] }], order: [group(sem.id)] });
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('HTTP routes', () => {
  let server: RunningServer;
  let base = '';

  before(async () => {
    await useLibrary();
    server = await startServer({ port: 0, log: false, resumeIngests: false, providerInfos: async () => [] });
    base = server.url;
  });

  after(async () => {
    await server?.close();
  });

  const api = (p: string, init?: RequestInit) => fetch(`${base}/api${p}`, init);
  const sendJson = (method: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
    api(p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  async function expectError(res: Response, status: number, message?: RegExp): Promise<void> {
    assert.equal(res.status, status);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, 'string');
    if (message) assert.match(body.error, message);
  }

  async function postCourse(title: string, groupId?: string): Promise<Course> {
    const res = await sendJson('POST', '/courses', groupId === undefined ? { title } : { title, groupId });
    assert.equal(res.status, 201);
    return (await res.json()) as Course;
  }

  const layout = async () => {
    const res = await api('/layout');
    assert.equal(res.status, 200);
    return (await res.json()) as LibraryLayout;
  };

  test('groups, layout and courses in groups', async () => {
    assert.deepEqual(await layout(), { groups: [], order: [] });
    const os1 = await postCourse('운영체제');
    const db = await postCourse('DB');

    await expectError(await sendJson('POST', '/groups', {}), 400, /그룹 이름/);
    await expectError(await sendJson('POST', '/groups', { title: 'G', courseIds: ['nope-000000'] }), 400, /알 수 없는 과목/);
    const created = await sendJson('POST', '/groups', { title: '2026-2학기', courseIds: [db.id] });
    assert.equal(created.status, 201);
    const sem = (await created.json()) as CourseGroup;
    assert.equal(sem.title, '2026-2학기');
    assert.deepEqual(sem.courseIds, [db.id]);
    assert.deepEqual(await layout(), { groups: [sem], order: [course(os1.id), group(sem.id)] });

    // A course created inside the group lands at its end.
    const compiler = await postCourse('Compiler', sem.id);
    await expectError(await sendJson('POST', '/courses', { title: 'X', groupId: 'missing-000000' }), 400, /그룹을 찾을 수 없습니다/);
    let current = await layout();
    assert.deepEqual(current.groups[0].courseIds, [db.id, compiler.id]);
    // GET /api/courses keeps the createdAt order.
    assert.deepEqual(((await (await api('/courses')).json()) as Course[]).map((c) => c.id), [os1.id, db.id, compiler.id]);

    // Rename.
    const patched = await sendJson('PATCH', `/groups/${sem.id}`, { title: '2026 가을' });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as CourseGroup).title, '2026 가을');
    await expectError(await sendJson('PATCH', `/groups/${sem.id}`, { title: ' ' }), 400);
    await expectError(await sendJson('PATCH', '/groups/missing-000000', { title: 'x' }), 404);
    await expectError(await sendJson('PATCH', '/groups/BAD%20ID', { title: 'x' }), 404);

    // Rearrange: the OS course into the group, first.
    const put = await sendJson('PUT', '/layout', { groups: [{ id: sem.id, courseIds: [os1.id, compiler.id, db.id] }], order: [group(sem.id)] });
    assert.equal(put.status, 200);
    current = (await put.json()) as LibraryLayout;
    assert.deepEqual(current, { groups: [{ ...sem, title: '2026 가을', courseIds: [os1.id, compiler.id, db.id] }], order: [group(sem.id)] });
    assert.deepEqual(await layout(), current);

    // Deleting a course takes it out of the layout.
    assert.equal((await api(`/courses/${compiler.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual((await layout()).groups[0].courseIds, [os1.id, db.id]);

    // Deleting the group keeps its courses at its place.
    assert.equal((await api(`/groups/${sem.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await layout(), { groups: [], order: [course(os1.id), course(db.id)] });
    await expectError(await api(`/groups/${sem.id}`, { method: 'DELETE' }), 404);
    await expectError(await api('/groups/BAD%20ID', { method: 'DELETE' }), 404);
  });

  test('PUT /api/layout validation: unknown, duplicated and missing ids, malformed bodies', async () => {
    const a = await postCourse('PUT A');
    const g = (await (await sendJson('POST', '/groups', { title: 'PUT G', courseIds: [a.id] })).json()) as CourseGroup;
    const current = await layout();
    const full = asRequest(current);
    const snapshot = await fs.readFile(layoutFile(), 'utf8');

    await expectError(await sendJson('PUT', '/layout', { ...full, order: [...full.order, course('nope-000000')] }), 400, /알 수 없는 과목/);
    await expectError(await sendJson('PUT', '/layout', { ...full, order: [...full.order, group('nope-000000')] }), 400, /알 수 없는 그룹/);
    await expectError(await sendJson('PUT', '/layout', { ...full, order: [...full.order, course(a.id)] }), 400, /같은 과목이 두 번/);
    await expectError(await sendJson('PUT', '/layout', { ...full, order: [...full.order, group(g.id)] }), 400, /같은 그룹이 두 번/);
    await expectError(await sendJson('PUT', '/layout', { ...full, order: full.order.filter((item) => item.id !== g.id) }), 400, /빠진 그룹/);
    await expectError(
      await sendJson('PUT', '/layout', { ...full, groups: full.groups.map((entry) => ({ ...entry, courseIds: [] })) }),
      400,
      /빠진 과목/,
    );
    await expectError(await sendJson('PUT', '/layout', []), 400, /배치 정보/);
    await expectError(await sendJson('PUT', '/layout', 'x'), 400);
    await expectError(await api('/layout', { method: 'PUT', body: JSON.stringify(full) }), 400, /배치 정보/); // not sent as JSON
    await expectError(await api('/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' }), 400);
    assert.equal(await fs.readFile(layoutFile(), 'utf8'), snapshot, 'nothing was written');

    // Made from an older arrangement: 409, and still nothing written.
    const stale = layoutRevision({ ...current, order: [...current.order].reverse() });
    await expectError(await sendJson('PUT', '/layout', { ...full, baseRevision: stale }), 409, /다른 곳에서/);
    assert.equal(await fs.readFile(layoutFile(), 'utf8'), snapshot, 'nothing was written');
    assert.equal((await sendJson('PUT', '/layout', { ...full, baseRevision: layoutRevision(current) })).status, 200);
    await expectError(await sendJson('PATCH', `/courses/${a.id}`, { docIds: [], baseDocIds: ['doc-999-abcdef'] }), 409, /강의 목록/);
    assert.equal((await sendJson('PATCH', `/courses/${a.id}`, { docIds: [], baseDocIds: [] })).status, 200);

    // Another site's page cannot rearrange the library.
    await expectError(await sendJson('PUT', '/layout', full, { Origin: 'https://evil.example' }), 403);
    await expectError(await sendJson('POST', '/groups', { title: 'x' }, { Origin: 'https://evil.example' }), 403);
  });

  test('parallel requests are serialized without lost updates', async () => {
    const titles = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const groups = (await Promise.all(titles.map((title) => sendJson('POST', '/groups', { title })))).map((res) => {
      assert.equal(res.status, 201);
      return res;
    });
    const created = (await Promise.all(groups.map((res) => res.json()))) as CourseGroup[];
    const results = await Promise.all([
      ...created.map((g, i) => sendJson('PATCH', `/groups/${g.id}`, { title: `P${i} renamed` })),
      ...created.map((g, i) => sendJson('POST', '/courses', { title: `In P${i}`, groupId: g.id })),
    ]);
    for (const res of results) assert.ok(res.status === 200 || res.status === 201, String(res.status));
    const courses = (await Promise.all(results.slice(created.length).map((res) => res.json()))) as Course[];
    const current = await layout();
    created.forEach((g, i) => {
      const stored = current.groups.find((candidate) => candidate.id === g.id);
      assert.equal(stored?.title, `P${i} renamed`);
      assert.deepEqual(stored?.courseIds, [courses[i].id]);
    });

    // Parallel PUTs: each one answers with its own arrangement, the last one stays.
    const full = asRequest(current);
    const reversed: PutLayoutRequest = { groups: full.groups, order: [...full.order].reverse() };
    const answers = await Promise.all([full, reversed, full, reversed].map((body) => sendJson('PUT', '/layout', body)));
    for (const res of answers) assert.equal(res.status, 200);
    const bodies = (await Promise.all(answers.map((res) => res.json()))) as LibraryLayout[];
    assert.deepEqual(bodies[0].order, full.order);
    assert.deepEqual(bodies[1].order, reversed.order);
    assert.deepEqual((await layout()).order, reversed.order);
  });
});
