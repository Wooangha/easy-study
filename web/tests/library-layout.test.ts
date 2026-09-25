// Library organization (DESIGN §18): layout normalisation, moves and drag & drop resolution.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Course, LibraryLayout } from '../../shared/types.ts';
import { createCollapsedStore, type KeyStorage } from '../src/lib/collapsed.ts';
import {
  describePlace,
  describeTarget,
  keyboardStops,
  nextStop,
  pickDroppable,
  resolveDrop,
  targetAt,
  type DroppableBox,
  type DropData,
  type OrgView,
} from '../src/lib/libraryDnd.ts';
import { withParticle } from '../src/lib/korean.ts';
import {
  allCollapseKeys,
  applyCourseMove,
  applyCourseUpdate,
  applyGroupMove,
  applyLectureMove,
  courseLabel,
  layoutEntries,
  layoutRows,
  lectureMovePatch,
  neighbourAfterDelete,
  normalizeLayout,
  sameLayout,
  toPutLayout,
  withCourseAdded,
  withGroupAppended,
  withoutGroup,
} from '../src/lib/libraryLayout.ts';

const course = (id: string, docIds: string[], createdAt = '2026-09-01T00:00:00Z'): Course => ({
  id,
  title: id.toUpperCase(),
  createdAt,
  docIds,
});

// c1 (a, b, c) at the top level, then group g1 with c2 (d, e) and c3 (empty).
const courses = [
  course('c1', ['a', 'b', 'c'], '2026-09-01T00:00:00Z'),
  course('c2', ['d', 'e'], '2026-09-02T00:00:00Z'),
  course('c3', [], '2026-09-03T00:00:00Z'),
];
const layout: LibraryLayout = {
  groups: [{ id: 'g1', title: '2026-2학기', createdAt: '2026-09-04T00:00:00Z', courseIds: ['c2', 'c3'] }],
  order: [
    { type: 'course', id: 'c1' },
    { type: 'group', id: 'g1' },
  ],
};
const view = (collapsed: string[] = []): OrgView => ({ courses, layout, isCollapsed: (k) => collapsed.includes(k) });

describe('normalizeLayout', () => {
  test('no layout = every course at the top level, oldest first', () => {
    assert.deepEqual(normalizeLayout(null, courses), {
      groups: [],
      order: [
        { type: 'course', id: 'c1' },
        { type: 'course', id: 'c2' },
        { type: 'course', id: 'c3' },
      ],
    });
  });

  test('unknown ids are dropped, duplicates keep their first place, missing courses and groups are appended', () => {
    const messy: LibraryLayout = {
      groups: [
        { id: 'g1', title: 'G1', createdAt: '', courseIds: ['c2', 'gone', 'c1'] },
        { id: 'g2', title: 'G2', createdAt: '', courseIds: [] },
      ],
      order: [
        { type: 'course', id: 'c1' },
        { type: 'group', id: 'nope' },
        { type: 'group', id: 'g1' },
        { type: 'group', id: 'g1' },
        { type: 'course', id: 'c2' },
      ],
    };
    const n = normalizeLayout(messy, courses);
    assert.deepEqual(n.order, [
      { type: 'course', id: 'c1' },
      { type: 'group', id: 'g1' },
      { type: 'group', id: 'g2' },
      { type: 'course', id: 'c3' },
    ]);
    assert.deepEqual(
      n.groups.map((g) => [g.id, g.courseIds]),
      [
        ['g1', ['c2']], // c1 keeps its first (top-level) place, 'gone' does not exist
        ['g2', []],
      ],
    );
  });

  test('rows, entries and picker labels follow the layout', () => {
    const rows = layoutRows(layout, courses);
    assert.deepEqual(
      rows.map((r) => (r.type === 'course' ? r.course.id : `${r.group.id}:${r.courses.map((c) => c.id).join(',')}`)),
      ['c1', 'g1:c2,c3'],
    );
    assert.deepEqual(layoutEntries(layout, courses).map(courseLabel), ['C1', '2026-2학기 › C2', '2026-2학기 › C3']);
    assert.deepEqual(toPutLayout(layout), {
      groups: [{ id: 'g1', courseIds: ['c2', 'c3'] }],
      order: layout.order,
    });
    assert.deepEqual(allCollapseKeys(layout, courses), ['group:g1', 'course:c1', 'course:c2', 'course:c3']);
  });
});

describe('moves', () => {
  test('lecture: reorder inside a course, between courses and out of every course', () => {
    const inside = applyLectureMove(courses, { kind: 'lecture', docId: 'c', courseId: 'c1', beforeDocId: 'a' });
    assert.deepEqual(inside[0].docIds, ['c', 'a', 'b']);
    const across = applyLectureMove(courses, { kind: 'lecture', docId: 'b', courseId: 'c2', beforeDocId: 'e' });
    assert.deepEqual(across.map((c) => c.docIds), [['a', 'c'], ['d', 'b', 'e'], []]);
    const toEnd = applyLectureMove(courses, { kind: 'lecture', docId: 'a', courseId: 'c3', beforeDocId: null });
    assert.deepEqual(toEnd.map((c) => c.docIds), [['b', 'c'], ['d', 'e'], ['a']]);
    const out = applyLectureMove(courses, { kind: 'lecture', docId: 'd', courseId: null, beforeDocId: null });
    assert.deepEqual(out.map((c) => c.docIds), [['a', 'b', 'c'], ['e'], []]);
    // An anchor that no longer exists (e.g. deleted meanwhile) means "at the end".
    const stale = applyLectureMove(courses, { kind: 'lecture', docId: 'a', courseId: 'c2', beforeDocId: 'zzz' });
    assert.deepEqual(stale[1].docIds, ['d', 'e', 'a']);
  });

  test('lecture: one PATCH — the target course, or the course it leaves; null when nothing changes', () => {
    assert.deepEqual(lectureMovePatch(courses, { kind: 'lecture', docId: 'b', courseId: 'c2', beforeDocId: null }), {
      courseId: 'c2',
      docIds: ['d', 'e', 'b'],
    });
    assert.deepEqual(lectureMovePatch(courses, { kind: 'lecture', docId: 'b', courseId: null, beforeDocId: null }), {
      courseId: 'c1',
      docIds: ['a', 'c'],
    });
    assert.equal(lectureMovePatch(courses, { kind: 'lecture', docId: 'b', courseId: 'c1', beforeDocId: 'c' }), null);
    assert.equal(lectureMovePatch(courses, { kind: 'lecture', docId: 'x', courseId: null, beforeDocId: null }), null);
    assert.equal(lectureMovePatch(courses, { kind: 'lecture', docId: 'b', courseId: 'nope', beforeDocId: null }), null);
    // Uncategorized document into a course.
    assert.deepEqual(lectureMovePatch(courses, { kind: 'lecture', docId: 'x', courseId: 'c3', beforeDocId: null }), {
      courseId: 'c3',
      docIds: ['x'],
    });
  });

  test('applyCourseUpdate drops the course’s lectures from every other course', () => {
    const next = applyCourseUpdate(courses, { ...courses[2], docIds: ['a', 'd'] });
    assert.deepEqual(next.map((c) => c.docIds), [['b', 'c'], ['e'], ['a', 'd']]);
  });

  test('course: into a group, out of a group, between groups', () => {
    const into = applyCourseMove(layout, { kind: 'course', courseId: 'c1', groupId: 'g1', before: { type: 'course', id: 'c3' } });
    assert.deepEqual(into.order, [{ type: 'group', id: 'g1' }]);
    assert.deepEqual(into.groups[0].courseIds, ['c2', 'c1', 'c3']);
    const out = applyCourseMove(layout, { kind: 'course', courseId: 'c3', groupId: null, before: { type: 'course', id: 'c1' } });
    assert.deepEqual(out.order, [
      { type: 'course', id: 'c3' },
      { type: 'course', id: 'c1' },
      { type: 'group', id: 'g1' },
    ]);
    assert.deepEqual(out.groups[0].courseIds, ['c2']);
    const withG2 = withGroupAppended(layout, { id: 'g2', title: 'G2', createdAt: '', courseIds: [] });
    const between = applyCourseMove(withG2, { kind: 'course', courseId: 'c2', groupId: 'g2', before: null });
    assert.deepEqual(
      between.groups.map((g) => g.courseIds),
      [['c3'], ['c2']],
    );
    assert.ok(sameLayout(applyCourseMove(layout, { kind: 'course', courseId: 'c2', groupId: 'g1', before: { type: 'course', id: 'c3' } }), layout));
    assert.equal(applyCourseMove(layout, { kind: 'course', courseId: 'c1', groupId: 'nope', before: null }), layout);
  });

  test('group: reorder at the top level (groups stay in top-level order)', () => {
    const withG2 = withGroupAppended(layout, { id: 'g2', title: 'G2', createdAt: '', courseIds: ['c1'] });
    assert.deepEqual(withG2.order, [
      { type: 'group', id: 'g1' },
      { type: 'group', id: 'g2' },
    ]);
    const moved = applyGroupMove(withG2, { kind: 'group', groupId: 'g2', before: { type: 'group', id: 'g1' } });
    assert.deepEqual(moved.order.map((i) => i.id), ['g2', 'g1']);
    assert.deepEqual(moved.groups.map((g) => g.id), ['g2', 'g1']);
  });

  test('deleting a group puts its courses where it was; new courses go to the end of their group', () => {
    const gone = withoutGroup(layout, 'g1');
    assert.deepEqual(gone, {
      groups: [],
      order: [
        { type: 'course', id: 'c1' },
        { type: 'course', id: 'c2' },
        { type: 'course', id: 'c3' },
      ],
    });
    assert.deepEqual(withCourseAdded(layout, 'c9', 'g1').groups[0].courseIds, ['c2', 'c3', 'c9']);
    assert.deepEqual(withCourseAdded(layout, 'c9', null).order.at(-1), { type: 'course', id: 'c9' });
  });

  test('focus after a delete: the next item of the same list, else the previous one, else the group', () => {
    const three: LibraryLayout = {
      groups: [{ ...layout.groups[0], courseIds: ['c2', 'c3', 'c4'] }],
      order: [{ type: 'course', id: 'c1' }, { type: 'group', id: 'g1' }, { type: 'course', id: 'c5' }],
    };
    const c = (id: string) => ({ type: 'course' as const, id });
    assert.deepEqual(neighbourAfterDelete(three, c('c3')), c('c4'));
    assert.deepEqual(neighbourAfterDelete(three, c('c4')), c('c3'));
    assert.deepEqual(neighbourAfterDelete(layout, c('c1')), { type: 'group', id: 'g1' });
    assert.deepEqual(neighbourAfterDelete(three, c('c5')), { type: 'group', id: 'g1' });
    const alone: LibraryLayout = { groups: [{ ...layout.groups[0], courseIds: ['c2'] }], order: [{ type: 'group', id: 'g1' }] };
    assert.deepEqual(neighbourAfterDelete(alone, c('c2')), { type: 'group', id: 'g1' });
    // A group: its first course stays where it was.
    assert.deepEqual(neighbourAfterDelete(three, { type: 'group', id: 'g1' }), c('c2'));
    const empty: LibraryLayout = { groups: [{ ...layout.groups[0], courseIds: [] }], order: [{ type: 'group', id: 'g1' }] };
    assert.equal(neighbourAfterDelete(empty, { type: 'group', id: 'g1' }), null);
    assert.equal(neighbourAfterDelete(layout, c('nope')), null);
  });
});

describe('collapse state (per device, shared by its tabs)', () => {
  /** One localStorage shared by several tabs (stores). */
  function sharedStorage() {
    let value: string[] | null = null;
    let available = true;
    const storage: KeyStorage = {
      read: () => (available ? (value ? [...value] : null) : undefined),
      write: (keys) => {
        if (available) value = keys.length > 0 ? [...keys] : null;
      },
    };
    return {
      storage,
      stored: () => value,
      setAvailable: (on: boolean) => {
        available = on;
      },
    };
  }
  const shown = (store: ReturnType<typeof createCollapsedStore>) => [...store.getSnapshot()].sort();

  test('two tabs: a change is made to what is stored now, never overwriting the other tab’s', () => {
    const { storage, stored } = sharedStorage();
    const tab1 = createCollapsedStore(storage);
    const tab2 = createCollapsedStore(storage);
    tab2.setOne('course:os', true);
    tab1.setOne('course:algo', true); // tab 1 has not heard of tab 2's change yet
    assert.deepEqual([...(stored() ?? [])].sort(), ['course:algo', 'course:os']);
    let heard = 0;
    tab2.subscribe(() => heard++);
    tab2.reload(); // the `storage` event
    assert.deepEqual(shown(tab2), ['course:algo', 'course:os']);
    assert.equal(heard, 1);
    tab2.reload();
    assert.equal(heard, 1, 'no change, no update');
    // Toggling and "모두 펼치기" work on the stored state too, and only on the given keys.
    tab1.toggle('course:os');
    assert.deepEqual(stored(), ['course:algo']);
    tab2.setOne('group:g', true);
    tab1.setAll(['course:algo'], false);
    assert.deepEqual(stored(), ['group:g']);
    tab1.setAll(['course:a', 'course:b'], true);
    assert.deepEqual([...(stored() ?? [])].sort(), ['course:a', 'course:b', 'group:g']);
  });

  test('deleted courses are forgotten, courses another tab just created are not', () => {
    const { storage, stored } = sharedStorage();
    storage.write(['course:gone', 'course:c1']);
    const tab = createCollapsedStore(storage);
    tab.sync(allCollapseKeys(layout, courses)); // the first, complete list
    assert.deepEqual(stored(), ['course:c1']);
    // Another tab creates c9 and collapses it; this tab's list does not have c9 yet.
    storage.write(['course:c1', 'course:c9']);
    tab.reload();
    tab.sync(allCollapseKeys(layout, courses));
    assert.deepEqual(stored(), ['course:c1', 'course:c9']);
    // c1 is deleted: it was seen here, so it goes.
    tab.sync(allCollapseKeys(layout, courses).filter((key) => key !== 'course:c1'));
    assert.deepEqual(stored(), ['course:c9']);
  });

  test('without storage (private mode) the state is kept in the tab', () => {
    const { storage, setAvailable } = sharedStorage();
    setAvailable(false);
    const tab = createCollapsedStore(storage);
    tab.setOne('course:c1', true);
    tab.setOne('course:c2', true);
    tab.reload();
    assert.deepEqual(shown(tab), ['course:c1', 'course:c2']);
  });
});

describe('resolveDrop', () => {
  const lecture = (docId: string) => ({ kind: 'lecture' as const, docId });
  const row = (docId: string, courseId: string | null): DropData => ({ role: 'lecture', docId, courseId });

  test('lecture over a row: upper half = before it, lower half = after it (skipping itself)', () => {
    const before = resolveDrop(lecture('c'), row('b', 'c1'), 0.2, view());
    assert.deepEqual(before?.move, { kind: 'lecture', docId: 'c', courseId: 'c1', beforeDocId: 'b' });
    assert.deepEqual(before?.indicator, { type: 'line', key: 'lecture:b', side: 'before' });
    // a over the lower half of b → before c.
    const after = resolveDrop(lecture('a'), row('b', 'c1'), 0.8, view());
    assert.deepEqual(after?.move, { kind: 'lecture', docId: 'a', courseId: 'c1', beforeDocId: 'c' });
    // The lower half of the last row = the end: the line is drawn after it.
    const end = resolveDrop(lecture('a'), row('c', 'c1'), 0.9, view());
    assert.deepEqual(end?.indicator, { type: 'line', key: 'lecture:c', side: 'after' });
    assert.equal(end?.move?.kind === 'lecture' && end.move.beforeDocId, null);
  });

  test('dropping where the lecture already is changes nothing', () => {
    assert.equal(resolveDrop(lecture('b'), row('b', 'c1'), 0.3, view())?.key, 'noop');
    assert.equal(resolveDrop(lecture('b'), row('c', 'c1'), 0.2, view())?.key, 'noop'); // before c = where b is
    assert.equal(resolveDrop(lecture('b'), row('a', 'c1'), 0.8, view())?.key, 'noop'); // after a
    assert.equal(resolveDrop(lecture('b'), row('a', 'c1'), 0.8, view())?.move, null);
  });

  test('lecture over another course: header = start (collapsed: end), body = end, empty course = into', () => {
    const head: DropData = { role: 'course-head', courseId: 'c2' };
    assert.deepEqual(resolveDrop(lecture('a'), head, 0.5, view())?.move, {
      kind: 'lecture',
      docId: 'a',
      courseId: 'c2',
      beforeDocId: 'd',
    });
    const collapsed = resolveDrop(lecture('a'), head, 0.5, view(['course:c2']));
    assert.equal(collapsed?.move?.kind === 'lecture' && collapsed.move.beforeDocId, null);
    assert.deepEqual(collapsed?.indicator, { type: 'into', key: 'course:c2' });
    const body = resolveDrop(lecture('a'), { role: 'course-body', courseId: 'c2' }, 0.99, view());
    assert.deepEqual(body?.indicator, { type: 'line', key: 'lecture:e', side: 'after' });
    const empty = resolveDrop(lecture('a'), { role: 'course-body', courseId: 'c3' }, 0.5, view());
    assert.deepEqual(empty?.indicator, { type: 'into', key: 'course:c3' });
  });

  test('lecture to 미분류 (a section or any uncategorized card); an uncategorized one stays put', () => {
    const t = resolveDrop(lecture('a'), { role: 'uncategorized' }, 0.5, view());
    assert.deepEqual(t?.move, { kind: 'lecture', docId: 'a', courseId: null, beforeDocId: null });
    assert.deepEqual(t?.indicator, { type: 'into', key: 'uncategorized' });
    assert.equal(resolveDrop(lecture('a'), row('x', null), 0.1, view())?.key, t?.key);
    assert.equal(resolveDrop(lecture('x'), { role: 'uncategorized' }, 0.5, view())?.key, 'noop');
  });

  test('lecture over a collapsed group header: it only opens the group — no move, no line elsewhere', () => {
    const head: DropData = { role: 'group-head', groupId: 'g1' };
    const t = resolveDrop(lecture('a'), head, 0.5, view(['group:g1']));
    assert.equal(t?.move, null);
    assert.deepEqual(t?.indicator, { type: 'into', key: 'group:g1' }); // LibraryDnd opens a collapsed 'into' after 600 ms
    assert.equal(t?.opens, 'g1');
    assert.notEqual(t?.key, 'noop');
    assert.equal(describePlace(t!, view(['group:g1'])), '접힌 ‘2026-2학기’ 그룹 위 — 잠시 기다리면 열려요');
    // An open group's header is not a place for lectures (its courses are).
    assert.equal(resolveDrop(lecture('a'), head, 0.5, view()), null);
  });

  test('drop zones only take their kind', () => {
    assert.equal(resolveDrop(lecture('a'), { role: 'group-head', groupId: 'g1' }, 0.5, view()), null);
    assert.equal(resolveDrop({ kind: 'course', courseId: 'c1' }, row('a', 'c1'), 0.5, view()), null);
    // Groups only move among top-level items.
    assert.equal(resolveDrop({ kind: 'group', groupId: 'g1' }, { role: 'course', courseId: 'c2', groupId: 'g1' }, 0.5, view()), null);
  });

  test('course over a group header: top third = before the group, the rest = into it', () => {
    const c1 = { kind: 'course' as const, courseId: 'c1' };
    const head: DropData = { role: 'group-head', groupId: 'g1' };
    // c1 is already right before g1.
    assert.equal(resolveDrop(c1, head, 0.1, view())?.key, 'noop');
    const into = resolveDrop(c1, head, 0.6, view());
    assert.deepEqual(into?.move, { kind: 'course', courseId: 'c1', groupId: 'g1', before: { type: 'course', id: 'c2' } });
    assert.deepEqual(into?.indicator, { type: 'line', key: 'course:c2', side: 'before' });
    const collapsed = resolveDrop(c1, head, 0.6, view(['group:g1']));
    assert.deepEqual(collapsed?.move, { kind: 'course', courseId: 'c1', groupId: 'g1', before: null });
    assert.deepEqual(collapsed?.indicator, { type: 'into', key: 'group:g1' });
    // c3 leaves the group: before g1 at the top level.
    const out = resolveDrop({ kind: 'course', courseId: 'c3' }, head, 0.1, view());
    assert.deepEqual(out?.move, { kind: 'course', courseId: 'c3', groupId: null, before: { type: 'group', id: 'g1' } });
    assert.equal(describePlace(out!, view()), '그룹 밖 목록의 2번째 자리 (3개 중)');
  });

  test('course and group to the end of the top level', () => {
    const t = resolveDrop({ kind: 'course', courseId: 'c2' }, { role: 'top-end' }, 0.5, view());
    assert.deepEqual(t?.indicator, { type: 'line', key: 'group:g1', side: 'after' });
    const g = resolveDrop({ kind: 'group', groupId: 'g1' }, { role: 'course', courseId: 'c1', groupId: null }, 0.2, view());
    assert.deepEqual(g?.move, { kind: 'group', groupId: 'g1', before: { type: 'course', id: 'c1' } });
    assert.equal(describePlace(g!, view()), '전체 목록의 1번째 자리 (2개 중)');
  });

  test('announcements say where the item lands (1-based, with the total) with the right particles', () => {
    const t = resolveDrop(lecture('a'), { role: 'course-body', courseId: 'c2' }, 0.9, view());
    assert.deepEqual(describeTarget(t!, view()), { place: '‘C2’ 과목의 3번째 자리', total: 3 });
    assert.equal(describePlace(t!, view()), '‘C2’ 과목의 3번째 자리 (3개 중)');
    const inGroup = resolveDrop({ kind: 'course', courseId: 'c1' }, { role: 'group-body', groupId: 'g1' }, 0.9, view());
    assert.equal(describePlace(inGroup!, view()), '‘2026-2학기’ 그룹의 3번째 자리 (3개 중)');
    const out = resolveDrop(lecture('a'), { role: 'uncategorized' }, 0.5, view());
    assert.deepEqual(describeTarget(out!, view()), { place: '미분류', total: null });
    assert.equal(describePlace({ key: 'noop', move: null, indicator: null }, view()), '원래 자리');
    assert.equal(withParticle('‘L3’ 강의', '을', '를'), '‘L3’ 강의를');
    assert.equal(withParticle('‘OS’ 과목', '을', '를'), '‘OS’ 과목을');
    assert.equal(withParticle('‘2학기’ 그룹', '은', '는'), '‘2학기’ 그룹은');
    assert.equal(withParticle('PDF', '을', '를'), 'PDF을(를)');
    assert.equal(withParticle('‘Lecture 7’', '을', '를'), '‘Lecture 7’을');
    assert.equal(withParticle('‘2026-2학기’', '을', '를'), '‘2026-2학기’를');
  });
});

describe('geometry and keyboard stops', () => {
  const box = (id: string, data: DropData, top: number, height: number, left = 0, width = 600): DroppableBox => ({
    id,
    data,
    rect: { top, bottom: top + height, left, right: left + width, width, height },
  });
  // Course c1 card: header 0–40, lecture rows a/b/c 40–100–160–220 inside its body 40–224; group g1 below.
  const boxes: DroppableBox[] = [
    box('course:c1', { role: 'course', courseId: 'c1', groupId: null }, 0, 224),
    box('course-head:c1', { role: 'course-head', courseId: 'c1' }, 0, 40),
    box('course-body:c1', { role: 'course-body', courseId: 'c1' }, 40, 184),
    box('lecture:a', { role: 'lecture', docId: 'a', courseId: 'c1' }, 40, 60, 10, 580),
    box('lecture:b', { role: 'lecture', docId: 'b', courseId: 'c1' }, 100, 60, 10, 580),
    box('lecture:c', { role: 'lecture', docId: 'c', courseId: 'c1' }, 160, 60, 10, 580),
    box('group:g1', { role: 'group', groupId: 'g1' }, 240, 120),
    box('group-head:g1', { role: 'group-head', groupId: 'g1' }, 240, 40),
    box('course:c2', { role: 'course', courseId: 'c2', groupId: 'g1' }, 290, 30, 10, 580),
    box('course-head:c2', { role: 'course-head', courseId: 'c2' }, 290, 30, 10, 580),
  ];
  const lecture = { kind: 'lecture' as const, docId: 'a' };

  test('the innermost droppable that takes the item wins', () => {
    assert.equal(pickDroppable(lecture, { x: 100, y: 120 }, boxes, view())?.box.id, 'lecture:b');
    assert.equal(pickDroppable(lecture, { x: 100, y: 20 }, boxes, view())?.box.id, 'course-head:c1');
    assert.equal(pickDroppable({ kind: 'course', courseId: 'c1' }, { x: 100, y: 120 }, boxes, view())?.box.id, 'course:c1');
    assert.equal(pickDroppable({ kind: 'course', courseId: 'c1' }, { x: 100, y: 300 }, boxes, view())?.box.id, 'course:c2');
  });

  test('beside the list: as if the pointer were inside it; in a gap or outside: the nearest one', () => {
    assert.equal(pickDroppable(lecture, { x: 900, y: 120 }, boxes, view())?.box.id, 'lecture:b');
    assert.equal(pickDroppable(lecture, { x: -40, y: 120 }, boxes, view())?.box.id, 'lecture:b');
    assert.equal(pickDroppable(lecture, { x: 5, y: 120 }, boxes, view())?.box.id, 'course-body:c1'); // the row starts at x=10
    // Between c1 (ends 224) and c2's header (starts 290; the group header does not take lectures): the nearer one.
    assert.equal(pickDroppable(lecture, { x: 100, y: 240 }, boxes, view())?.box.id, 'course-body:c1');
    assert.equal(pickDroppable(lecture, { x: 100, y: 270 }, boxes, view())?.box.id, 'course-head:c2');
    const above = pickDroppable({ kind: 'course', courseId: 'c2' }, { x: 100, y: -50 }, boxes, view());
    assert.equal(above?.box.id, 'course:c1');
    assert.ok(above && above.relY < 0);
    assert.deepEqual(targetAt({ kind: 'course', courseId: 'c2' }, { x: 100, y: -50 }, boxes, view())?.move, {
      kind: 'course',
      courseId: 'c2',
      groupId: null,
      before: { type: 'course', id: 'c1' },
    });
  });

  test('keyboard stops: every distinct place once, top to bottom', () => {
    const stops = keyboardStops(lecture, 300, boxes, view());
    const keys = stops.map((s) => s.target.key);
    for (let i = 1; i < keys.length; i++) assert.notEqual(keys[i], keys[i - 1]);
    // a: noop (its own place), after b, after c (end of c1), start of c2 (via its header).
    assert.deepEqual(keys, ['noop', 'lecture>c1>1', 'lecture>c1>2', 'lecture>c2>0']);
    const ys = stops.map((s) => s.y);
    assert.deepEqual(ys, [...ys].sort((p, q) => p - q));
  });

  test('a collapsed group: its header is where a dragged lecture waits for it to open', () => {
    // g1 collapsed: its courses are not shown (no boxes).
    const shownBoxes = boxes.filter((b) => !b.id.endsWith(':c2'));
    const collapsedView = view(['group:g1']);
    const onHead = pickDroppable(lecture, { x: 100, y: 250 }, shownBoxes, collapsedView);
    assert.equal(onHead?.box.id, 'group-head:g1');
    assert.equal(targetAt(lecture, { x: 100, y: 250 }, shownBoxes, collapsedView)?.key, 'open>g1');
    // Were the header no target (as before), the nearest course would take it: a drop would move the lecture there.
    assert.equal(targetAt(lecture, { x: 100, y: 250 }, shownBoxes, view())?.key, 'lecture>c1>2');
    const keys = keyboardStops(lecture, 300, shownBoxes, collapsedView).map((s) => s.target.key);
    assert.deepEqual(keys, ['noop', 'lecture>c1>1', 'lecture>c1>2', 'open>g1']);
    // Once open, the same spot (the lower header) is next to the group's first course: its first place.
    const stop = keyboardStops(lecture, 300, shownBoxes, collapsedView).at(-1)!;
    assert.equal(targetAt(lecture, { x: 300, y: stop.y }, boxes, view())?.key, 'lecture>c2>0');
  });

  test('keyboard: after a collapsed course opens under the item, it is at the course’s first place, ↓ = the second', () => {
    // c2 (d, e) collapsed: the item waits on its header = its end.
    const collapsed = keyboardStops(lecture, 300, boxes, view(['course:c2']));
    const onHead = collapsed.at(-1)!;
    assert.equal(onHead.target.key, 'lecture>c2>2');
    assert.equal(describePlace(onHead.target, view(['course:c2'])), '‘C2’ 과목의 3번째 자리 (3개 중)');
    // Opened (its rows d, e now below the header): the same spot is the first place, and that is what is said.
    const opened = [
      ...boxes,
      box('course-body:c2', { role: 'course-body', courseId: 'c2' }, 320, 124, 10, 580),
      box('lecture:d', { role: 'lecture', docId: 'd', courseId: 'c2' }, 320, 60, 20, 560),
      box('lecture:e', { role: 'lecture', docId: 'e', courseId: 'c2' }, 380, 60, 20, 560),
    ];
    const now = targetAt(lecture, { x: 300, y: onHead.y }, opened, view());
    assert.equal(now?.key, 'lecture>c2>0');
    assert.equal(describePlace(now!, view()), '‘C2’ 과목의 1번째 자리 (3개 중)');
    const down = nextStop(keyboardStops(lecture, 300, opened, view()), onHead.y, now!.key, 1);
    assert.equal(down?.target.key, 'lecture>c2>1');
  });

  test('nextStop moves to the next different place in the pressed direction', () => {
    const stops = keyboardStops(lecture, 300, boxes, view());
    const first = stops[0];
    const down = nextStop(stops, first.y, 'noop', 1);
    assert.equal(down?.target.key, 'lecture>c1>1');
    assert.equal(nextStop(stops, down!.y, down!.target.key, -1)?.target.key, 'noop');
    const last = stops[stops.length - 1];
    assert.equal(nextStop(stops, last.y, last.target.key, 1), null);
    assert.equal(nextStop(stops, first.y, 'noop', -1), null);
  });
});
