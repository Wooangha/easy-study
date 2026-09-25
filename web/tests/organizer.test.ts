// Organizer store (DESIGN §18): optimistic changes, one request at a time in order, rollback + toast on errors.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { layoutRevision } from '../../shared/layoutRevision.ts';
import type { Course, CourseGroup, LibraryLayout } from '../../shared/types.ts';
import { answerConfirm, cancelAllConfirms, confirmDialog, getConfirmRequest, subscribeConfirm } from '../src/lib/confirm.ts';
import { normalizeLayout } from '../src/lib/libraryLayout.ts';
import { createOrganizer, type OrganizerApi } from '../src/lib/organizer.ts';

const clone = <T>(v: T): T => structuredClone(v);
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const initialCourses = (): Course[] => [
  { id: 'c1', title: 'Compiler', createdAt: '2026-09-01T00:00:00Z', docIds: ['a', 'b', 'c'] },
  { id: 'c2', title: 'OS', createdAt: '2026-09-02T00:00:00Z', docIds: ['d', 'e'] },
  { id: 'c3', title: 'DB', createdAt: '2026-09-03T00:00:00Z', docIds: [] },
];
const initialLayout = (): LibraryLayout => ({
  groups: [{ id: 'g1', title: '2026-2학기', createdAt: '2026-09-04T00:00:00Z', courseIds: ['c2', 'c3'] }],
  order: [
    { type: 'course', id: 'c1' },
    { type: 'group', id: 'g1' },
  ],
});

/** What the app's API throws for HTTP 409. */
const conflict = () => Object.assign(new Error('changed elsewhere'), { status: 409 });
const isConflict = (e: unknown) => (e as { status?: unknown }).status === 409;

/**
 * A tiny in-memory server with the §12/§18 routes, including the 409 preconditions (baseRevision, baseDocIds);
 * `hold()` makes requests wait until released, `edit()` changes it behind the client's back (another tab).
 */
function fakeServer() {
  let courses = initialCourses();
  let layout = initialLayout();
  let layoutMissing = false;
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  let holding = false;
  const failing = new Map<string, Array<() => Error>>();
  let seq = 0;

  async function enter(name: string, line: string) {
    calls.push(line);
    if (holding) await new Promise<void>((resolve) => gates.push(resolve));
    const next = failing.get(name)?.shift();
    if (next) throw next();
  }

  const api: OrganizerApi = {
    async listCourses() {
      await enter('listCourses', 'GET /api/courses');
      return clone(courses);
    },
    async getLayout() {
      await enter('getLayout', 'GET /api/layout');
      if (layoutMissing) throw new Error('API 경로를 찾을 수 없습니다');
      return clone(layout);
    },
    async createCourse(body) {
      await enter('createCourse', `POST /api/courses ${JSON.stringify(body)}`);
      const course: Course = { id: `n${++seq}`, title: body.title, createdAt: `2026-09-1${seq}T00:00:00Z`, docIds: [] };
      courses = [...courses, course];
      if (body.groupId) layout.groups.find((g) => g.id === body.groupId)?.courseIds.push(course.id);
      else layout.order.push({ type: 'course', id: course.id });
      return clone(course);
    },
    async updateCourse(courseId, body) {
      const { baseDocIds, ...rest } = body;
      await enter('updateCourse', `PATCH ${courseId} ${JSON.stringify(rest)}`);
      const current = courses.find((c) => c.id === courseId);
      if (baseDocIds && current && current.docIds.join() !== baseDocIds.join()) {
        calls.push('→ 409');
        throw conflict();
      }
      const docIds = body.docIds;
      courses = courses.map((c) => {
        if (c.id === courseId) return { ...c, ...(body.title ? { title: body.title } : {}), ...(docIds ? { docIds } : {}) };
        return docIds ? { ...c, docIds: c.docIds.filter((id) => !docIds.includes(id)) } : c;
      });
      return clone(courses.find((c) => c.id === courseId) as Course);
    },
    async deleteCourse(courseId) {
      await enter('deleteCourse', `DELETE ${courseId}`);
      courses = courses.filter((c) => c.id !== courseId);
    },
    async putLayout(body) {
      await enter('putLayout', `PUT ${body.order.map((i) => i.id).join(',')} | ${body.groups.map((g) => `${g.id}:${g.courseIds.join(',')}`).join(' ')}`);
      if (body.baseRevision !== undefined && body.baseRevision !== layoutRevision(normalizeLayout(layout, courses))) {
        calls.push('→ 409');
        throw conflict();
      }
      if (body.groups.some((g) => !layout.groups.some((x) => x.id === g.id))) throw new Error('알 수 없는 그룹');
      layout = {
        groups: body.groups.map((g) => ({ ...(layout.groups.find((x) => x.id === g.id) as CourseGroup), courseIds: g.courseIds })),
        order: body.order,
      };
      return clone(layout);
    },
    async createGroup(body) {
      await enter('createGroup', `POST /api/groups ${JSON.stringify(body)}`);
      const group: CourseGroup = { id: `grp${++seq}`, title: body.title, createdAt: '', courseIds: body.courseIds ?? [] };
      layout = {
        groups: [...layout.groups.map((g) => ({ ...g, courseIds: g.courseIds.filter((id) => !group.courseIds.includes(id)) })), group],
        order: [...layout.order.filter((i) => !(i.type === 'course' && group.courseIds.includes(i.id))), { type: 'group', id: group.id }],
      };
      return clone(group);
    },
    async updateGroup(groupId, body) {
      await enter('updateGroup', `PATCH group ${groupId} ${body.title}`);
      const group = layout.groups.find((g) => g.id === groupId) as CourseGroup;
      group.title = body.title;
      return clone(group);
    },
    async deleteGroup(groupId) {
      await enter('deleteGroup', `DELETE group ${groupId}`);
      layout = normalizeLayout(
        {
          groups: layout.groups.filter((g) => g.id !== groupId),
          order: layout.order.flatMap((i) =>
            i.type === 'group' && i.id === groupId
              ? (layout.groups.find((g) => g.id === groupId)?.courseIds ?? []).map((id) => ({ type: 'course' as const, id }))
              : [i],
          ),
        },
        courses,
      );
    },
  };

  return {
    api,
    calls,
    hold: () => {
      holding = true;
    },
    releaseOne: () => gates.shift()?.(),
    releaseAll: () => {
      holding = false;
      for (const release of gates.splice(0)) release();
    },
    /** The next call of `name` fails (`times` calls in a row), with an error or with 409. */
    fail: (name: string, kind: 'error' | 'conflict' = 'error', times = 1) => {
      const queue = failing.get(name) ?? [];
      for (let i = 0; i < times; i++) queue.push(kind === 'conflict' ? conflict : () => new Error(`${name} refused`));
      failing.set(name, queue);
    },
    removeLayoutRoute: () => {
      layoutMissing = true;
    },
    /** Another tab or device changes the server's data. */
    edit(change: (state: { courses: Course[]; layout: LibraryLayout }) => void) {
      const state = { courses, layout };
      change(state);
      courses = state.courses;
      layout = state.layout;
    },
    state: () => ({ courses: clone(courses), layout: clone(layout) }),
  };
}

function setup() {
  const server = fakeServer();
  const errors: string[] = [];
  const org = createOrganizer({
    api: server.api,
    notifyError: (m) => errors.push(m),
    errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
    isConflict,
  });
  const docsOf = () => Object.fromEntries((org.getSnapshot().courses ?? []).map((c) => [c.id, c.docIds.join('')]));
  const orderOf = () => {
    const { layout } = org.getSnapshot();
    return layout.order
      .map((i) => (i.type === 'course' ? i.id : `${i.id}[${layout.groups.find((g) => g.id === i.id)?.courseIds.join(',')}]`))
      .join(' ');
  };
  return { server, errors, org, docsOf, orderOf };
}

describe('organizer store', () => {
  test('loads courses and the layout', async () => {
    const { org, orderOf } = setup();
    assert.equal(org.getSnapshot().courses, null);
    await org.refresh();
    assert.equal(org.getSnapshot().courses?.length, 3);
    assert.equal(orderOf(), 'c1 g1[c2,c3]');
    assert.equal(org.getSnapshot().pending, 0);
  });

  test('a move shows at once, is one PATCH, and a second drop waits for the first (sent from the confirmed state)', async () => {
    const { server, org, docsOf } = setup();
    await org.refresh();
    server.hold();
    let notified = 0;
    org.subscribe(() => notified++);
    const first = org.moveLecture('a', 'c2', null);
    assert.deepEqual(docsOf(), { c1: 'bc', c2: 'dea', c3: '' });
    assert.ok(notified > 0);
    const second = org.moveLecture('d', 'c1', 'b');
    assert.deepEqual(docsOf(), { c1: 'dbc', c2: 'ea', c3: '' });
    assert.equal(org.getSnapshot().pending, 2);
    await settle();
    assert.deepEqual(server.calls.slice(2), ['PATCH c2 {"docIds":["d","e","a"]}']);

    server.releaseOne();
    assert.equal(await first, true);
    await settle();
    assert.deepEqual(server.calls.slice(2), ['PATCH c2 {"docIds":["d","e","a"]}', 'PATCH c1 {"docIds":["d","b","c"]}']);
    server.releaseAll();
    assert.equal(await second, true);
    assert.deepEqual(docsOf(), { c1: 'dbc', c2: 'ea', c3: '' });
    assert.equal(org.getSnapshot().pending, 0);
  });

  test('a refused change is rolled back with a toast; the changes behind it still go through', async () => {
    const { server, org, errors, docsOf, orderOf } = setup();
    await org.refresh();
    server.hold();
    server.fail('putLayout');
    const course = org.moveCourse('c1', 'g1', null);
    const lecture = org.moveLecture('a', 'c3', null);
    assert.equal(orderOf(), 'g1[c2,c3,c1]');
    assert.deepEqual(docsOf(), { c1: 'bc', c2: 'de', c3: 'a' });
    server.releaseAll();
    assert.equal(await course, false);
    assert.equal(await lecture, true);
    await settle();
    await settle();
    assert.equal(orderOf(), 'c1 g1[c2,c3]');
    assert.deepEqual(docsOf(), { c1: 'bc', c2: 'de', c3: 'a' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^과목을 옮기지 못해 원래대로 되돌렸어요: putLayout refused$/);
    // …and the lists were loaded again after the failure.
    assert.equal(server.calls.filter((c) => c === 'GET /api/courses').length, 2);
  });

  test('moving a course sends the whole arrangement; no request when nothing changes', async () => {
    const { server, org, orderOf } = setup();
    await org.refresh();
    const before = server.calls.length;
    assert.equal(await org.moveCourse('c1', null, { type: 'group', id: 'g1' }), true); // already there
    assert.equal(await org.moveLecture('b', 'c1', 'c'), true); // already there
    assert.equal(server.calls.length, before);
    assert.equal(await org.moveCourse('c3', null, { type: 'course', id: 'c1' }), true);
    assert.equal(server.calls.at(-1), 'PUT c3,c1,g1 | g1:c2');
    assert.equal(orderOf(), 'c3 c1 g1[c2]');
    assert.equal(await org.moveGroup('g1', { type: 'course', id: 'c3' }), true);
    assert.equal(orderOf(), 'g1[c2] c3 c1');
  });

  test('groups: create (taking courses), rename, a course inside it, delete (its courses stay in place)', async () => {
    const { org, orderOf } = setup();
    await org.refresh();
    const group = await org.createGroup('3학년', ['c1']);
    assert.ok(group);
    assert.equal(orderOf(), `g1[c2,c3] ${group.id}[c1]`);
    assert.equal(await org.renameGroup(group.id, '4학년'), true);
    assert.equal(org.getSnapshot().layout.groups.find((g) => g.id === group.id)?.title, '4학년');
    const created = await org.createCourse('Compiler 2', group.id);
    assert.ok(created);
    assert.equal(orderOf(), `g1[c2,c3] ${group.id}[c1,${created.id}]`);
    const deleting = org.deleteGroup('g1');
    assert.equal(orderOf(), `c2 c3 ${group.id}[c1,${created.id}]`); // shown at once
    assert.equal(await deleting, true);
    assert.equal(orderOf(), `c2 c3 ${group.id}[c1,${created.id}]`);
  });

  test('deleting a course: its lectures become uncategorized; a failure brings it back', async () => {
    const { server, org, errors, docsOf, orderOf } = setup();
    await org.refresh();
    server.fail('deleteCourse');
    const failed = org.deleteCourse('c2');
    assert.equal(orderOf(), 'c1 g1[c3]');
    assert.equal(await failed, false);
    await settle();
    assert.equal(orderOf(), 'c1 g1[c2,c3]');
    assert.match(errors[0], /과목을 삭제하지 못했어요/);
    assert.equal(await org.deleteCourse('c2'), true);
    assert.deepEqual(docsOf(), { c1: 'abc', c3: '' });
  });

  test('a server without GET /api/layout: courses ungrouped in creation order, with the error', async () => {
    const { server, org, orderOf } = setup();
    server.removeLayoutRoute();
    await org.refresh();
    assert.equal(orderOf(), 'c1 c2 c3');
    assert.match(org.getSnapshot().layoutError ?? '', /찾을 수 없습니다/);
    assert.equal(org.getSnapshot().coursesError, null);
  });

  test('a course move made from stale data (another tab) is made again on top of what the server has', async () => {
    const { server, org, errors, orderOf } = setup();
    await org.refresh();
    // Another tab puts c1 into g1; this tab still shows c1 at the top level.
    server.edit((st) => {
      st.layout = { groups: [{ ...st.layout.groups[0], courseIds: ['c2', 'c3', 'c1'] }], order: [{ type: 'group', id: 'g1' }] };
    });
    // Here: c3 out of the group, before it.
    assert.equal(await org.moveCourse('c3', null, { type: 'group', id: 'g1' }), true);
    assert.deepEqual(server.calls.slice(2), [
      'PUT c1,c3,g1 | g1:c2', // made from the stale arrangement…
      '→ 409', // …refused
      'GET /api/courses',
      'GET /api/layout',
      'PUT c3,g1 | g1:c2,c1', // the same move on top of the other tab's
    ]);
    assert.equal(orderOf(), 'c3 g1[c2,c1]');
    assert.deepEqual(server.state().layout.groups[0].courseIds, ['c2', 'c1']);
    assert.deepEqual(errors, []);
  });

  test('a lecture reorder made from a stale list keeps the lecture another tab added', async () => {
    const { server, org, errors, docsOf } = setup();
    await org.refresh();
    // Another tab moves e from c2 to the end of c1.
    server.edit((st) => {
      st.courses = st.courses.map((c) =>
        c.id === 'c1' ? { ...c, docIds: [...c.docIds, 'e'] } : c.id === 'c2' ? { ...c, docIds: ['d'] } : c,
      );
    });
    assert.equal(await org.moveLecture('c', 'c1', 'a'), true);
    assert.deepEqual(server.calls.slice(2), [
      'PATCH c1 {"docIds":["c","a","b"]}',
      '→ 409',
      'GET /api/courses',
      'GET /api/layout',
      'PATCH c1 {"docIds":["c","a","b","e"]}',
    ]);
    assert.deepEqual(docsOf(), { c1: 'cabe', c2: 'd', c3: '' });
    assert.deepEqual(errors, []);
  });

  test('when the target was deleted elsewhere the move is rolled back with a clear message', async () => {
    const { server, org, errors, orderOf } = setup();
    await org.refresh();
    server.edit((st) => {
      st.layout = { groups: [], order: ['c1', 'c2', 'c3'].map((id) => ({ type: 'course' as const, id })) };
    });
    assert.equal(orderOf(), 'c1 g1[c2,c3]'); // not known here yet
    assert.equal(await org.moveCourse('c1', 'g1', null), false);
    await settle();
    await settle();
    assert.deepEqual(errors, ['과목을 옮기지 못해 원래대로 되돌렸어요: 옮길 그룹이 다른 곳에서 삭제됐어요']);
    assert.equal(orderOf(), 'c1 c2 c3');
    assert.equal(server.calls.filter((c) => c.startsWith('PUT')).length, 1, 'no second PUT into a group that is gone');
  });

  test('a move that conflicts again after reloading fails with a toast (no endless retries)', async () => {
    const { server, org, errors, docsOf } = setup();
    await org.refresh();
    server.fail('updateCourse', 'conflict', 2);
    assert.equal(await org.moveLecture('a', 'c3', null), false);
    await settle();
    await settle();
    assert.equal(server.calls.filter((c) => c.startsWith('PATCH')).length, 2);
    assert.deepEqual(errors, ['강의를 옮기지 못해 원래대로 되돌렸어요: 다른 탭이나 기기에서 먼저 바뀌었어요. 새로 불러왔으니 다시 해 주세요']);
    assert.deepEqual(docsOf(), { c1: 'abc', c2: 'de', c3: '' });
    // Renames and other changes are not retried.
    server.fail('updateGroup', 'conflict');
    assert.equal(await org.renameGroup('g1', 'x'), false);
    assert.equal(server.calls.filter((c) => c.startsWith('PATCH group')).length, 1);
  });

  test('a lecture uploaded into a course shows until the next load', async () => {
    const { org, docsOf } = setup();
    await org.refresh();
    org.addLectureLocally('c3', 'x');
    org.addLectureLocally('nope', 'y');
    assert.deepEqual(docsOf(), { c1: 'abc', c2: 'de', c3: 'x' });
  });
});

describe('in-page confirmation', () => {
  beforeEach(() => cancelAllConfirms());

  test('without a dialog host the answer is no', async () => {
    assert.equal(await confirmDialog({ title: '삭제할까요?' }), false);
  });

  test('requests are shown one at a time, in order', async () => {
    const unsubscribe = subscribeConfirm(() => {});
    try {
      const first = confirmDialog({ title: '첫 번째', danger: true });
      const second = confirmDialog({ title: '두 번째' });
      const shown = getConfirmRequest();
      assert.equal(shown?.title, '첫 번째');
      answerConfirm(shown!.id, true);
      assert.equal(await first, true);
      assert.equal(getConfirmRequest()?.title, '두 번째');
      cancelAllConfirms();
      assert.equal(await second, false);
      assert.equal(getConfirmRequest(), null);
    } finally {
      unsubscribe();
    }
  });
});
