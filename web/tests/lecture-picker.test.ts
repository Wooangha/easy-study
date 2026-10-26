// The top bar's lecture picker (web/src/lib/lecturePicker.ts): the courses in library order, the course neighbours,
// the search over lecture and course names, the recent lectures.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Course, DocMeta, LibraryLayout } from '../../shared/types.ts';
import { highlightParts, MAX_RECENT_DOCS, neighbours, pickerModel, pushRecent, recentLectures, searchLectures, titleHasNumber } from '../src/lib/lecturePicker.ts';
import { normalizeLayout } from '../src/lib/libraryLayout.ts';

const doc = (id: string, title: string): DocMeta => ({
  id,
  title,
  fileName: `${id}.pdf`,
  pageCount: 10,
  aspectRatio: 16 / 9,
  status: 'ready',
  progress: 10,
  createdAt: '2026-10-01T00:00:00.000Z',
  courseId: null,
  digestStatus: 'none',
});
const course = (id: string, title: string, docIds: string[]): Course => ({ id, title, createdAt: '2026-10-01T00:00:00.000Z', docIds });

const DOCS = [doc('db1', 'POSTECH_DBLAB_Introduction'), doc('db2', 'Relational Model'), doc('os1', '01-Introduction'), doc('p5', 'L5-Parsing-1'), doc('p6', 'L6-Parsing-2'), doc('loose', '그냥 PDF')];
const COURSES = [course('c-os', '운영체제', ['os1']), course('c-db', '데이터베이스', ['db1', 'db2']), course('c-cc', '컴파일러', ['p5', 'p6'])];
/** The app normalizes the layout before the pickers see it (every course placed, creation order for the unplaced). */
const flat = (courses: Course[]): LibraryLayout => normalizeLayout(null, courses);
const LAYOUT: LibraryLayout = normalizeLayout(
  { groups: [{ id: 'g1', title: '2학기', createdAt: '2026-10-01T00:00:00.000Z', courseIds: ['c-db', 'c-cc'] }], order: [{ type: 'group', id: 'g1' }, { type: 'course', id: 'c-os' }] },
  COURSES,
);

describe('lecture picker', () => {
  test('courses in library order with their lectures in course order, then the lectures in no course', () => {
    const model = pickerModel(DOCS, COURSES, flat(COURSES));
    assert.deepEqual(
      model.courses.map((c) => [c.label, c.lectures.map((d) => d.id)]),
      [
        ['운영체제', ['os1']],
        ['데이터베이스', ['db1', 'db2']],
        ['컴파일러', ['p5', 'p6']],
      ],
    );
    assert.deepEqual(model.uncategorized.map((d) => d.id), ['loose']);
    assert.equal(model.place.get('db2')?.index, 2);
    assert.equal(model.place.has('loose'), false);
  });

  test('a lecture listed by two courses shows under the first one created; a missing lecture is skipped', () => {
    const two = [course('a', 'A', ['db1', 'gone']), course('b', 'B', ['db1', 'db2'])];
    const model = pickerModel(DOCS, two, flat(two));
    assert.deepEqual(
      model.courses.map((c) => c.lectures.map((d) => d.id)),
      [['db1'], ['db2']],
    );
  });

  test('neighbours: the place in the course and the lectures before and after; none outside a course', () => {
    const model = pickerModel(DOCS, COURSES, flat(COURSES));
    const first = neighbours(model, 'db1');
    assert.deepEqual([first?.index, first?.total, first?.prev?.id ?? null, first?.next?.id ?? null], [1, 2, null, 'db2']);
    const last = neighbours(model, 'db2');
    assert.deepEqual([last?.prev?.id, last?.next ?? null], ['db1', null]);
    assert.equal(neighbours(model, 'loose'), null);
  });

  test('search: every word in the title or the course name, case-insensitive; title starts first; ranges mark the title', () => {
    const model = pickerModel(DOCS, COURSES, flat(COURSES));
    assert.deepEqual(searchLectures(model, 'PARS').map((h) => h.doc.id), ['p5', 'p6']);
    // The course name alone finds its lectures (no range in their titles).
    const byCourse = searchLectures(model, '데이터');
    assert.deepEqual(byCourse.map((h) => [h.doc.id, h.ranges.length]), [['db1', 0], ['db2', 0]]);
    // Two words: one in the course, one in the title.
    assert.deepEqual(searchLectures(model, '컴파일 2').map((h) => h.doc.id), ['p6']);
    // Library order among equals; a title that starts with the query comes first.
    assert.deepEqual(searchLectures(model, 'intro').map((h) => h.doc.id), ['os1', 'db1']);
    assert.deepEqual(searchLectures(model, 'postech intro').map((h) => h.doc.id), ['db1']);
    assert.deepEqual(searchLectures(model, '0').map((h) => h.doc.id), ['os1']);
    assert.deepEqual(searchLectures(model, 'l').map((h) => h.doc.id).slice(0, 2), ['p5', 'p6']);
    assert.deepEqual(searchLectures(model, '   '), []);
    assert.deepEqual(searchLectures(model, 'zzz'), []);
    const [p5] = searchLectures(model, 'parsing 1');
    assert.deepEqual(highlightParts(p5.doc.title, p5.ranges), [
      { text: 'L5-', hit: false },
      { text: 'Parsing', hit: true },
      { text: '-', hit: false },
      { text: '1', hit: true },
    ]);
  });

  test('a grouped course is labelled "그룹 › 과목" and searched by it', () => {
    const model = pickerModel(DOCS, COURSES, LAYOUT);
    assert.deepEqual(model.courses.map((c) => c.label), ['2학기 › 데이터베이스', '2학기 › 컴파일러', '운영체제']);
    assert.deepEqual(searchLectures(model, '2학기').map((h) => h.doc.id), ['db1', 'db2', 'p5', 'p6']);
  });

  test('titles that carry their own number get no course number before them', () => {
    for (const t of ['01-Introduction', 'L5-Parsing-1', '1. Intro', '12 Graphs', 'Week3']) assert.equal(titleHasNumber(t), t !== 'Week3', t);
    for (const t of ['POSTECH_DBLAB_Introduction', 'Relational Model', '그냥 PDF']) assert.equal(titleHasNumber(t), false, t);
  });

  test('recent: newest first, once, capped; only lectures that still exist', () => {
    let recent: string[] = [];
    for (const id of ['a', 'b', 'a', 'c']) recent = pushRecent(recent, id);
    assert.deepEqual(recent, ['c', 'a', 'b']);
    for (let i = 0; i < 20; i++) recent = pushRecent(recent, `x${i}`);
    assert.equal(recent.length, MAX_RECENT_DOCS);
    assert.deepEqual(recentLectures(['gone', 'db2', 'os1', 'p5'], DOCS, 2).map((d) => d.id), ['db2', 'os1']);
  });
});
