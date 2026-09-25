// Library organization (DESIGN §18): course groups, the top-level order and moves of lectures, courses and
// groups. Pure functions on the shared contract types, used by the organizer store (optimistic updates), the
// library view (rendering, drag & drop) and the pickers. Lecture membership/order lives in the courses
// (Course.docIds); groups and the order of courses live in the layout.
import type { Course, CourseGroup, LayoutItem, LibraryLayout, PutLayoutRequest } from '../../../shared/types.ts';

export const EMPTY_LAYOUT: LibraryLayout = { groups: [], order: [] };

/**
 * The layout as the server normalises it (DESIGN §18), against the courses the client knows (createdAt order):
 * unknown courses and group items of unknown groups are dropped, a course listed twice keeps its first
 * position in display order, groups missing from `order` are appended, existing courses that are not mentioned
 * are appended to the top level. `groups` follows the top-level order. `null` = every course at the top level.
 */
export function normalizeLayout(layout: LibraryLayout | null | undefined, courses: readonly Course[]): LibraryLayout {
  const existing = new Set(courses.map((c) => c.id));
  const groupsById = new Map<string, CourseGroup>();
  for (const g of layout?.groups ?? []) if (!groupsById.has(g.id)) groupsById.set(g.id, g);

  const items: LayoutItem[] = [];
  const mentioned = new Set<string>();
  for (const item of layout?.order ?? []) {
    if (item.type === 'group') {
      if (!groupsById.has(item.id) || mentioned.has(item.id)) continue;
      mentioned.add(item.id);
    }
    items.push(item);
  }
  for (const id of groupsById.keys()) if (!mentioned.has(id)) items.push({ type: 'group', id });

  const placed = new Set<string>();
  const place = (courseId: string): boolean => {
    if (!existing.has(courseId) || placed.has(courseId)) return false;
    placed.add(courseId);
    return true;
  };
  const groups: CourseGroup[] = [];
  const order: LayoutItem[] = [];
  for (const item of items) {
    if (item.type === 'course') {
      if (place(item.id)) order.push({ type: 'course', id: item.id });
      continue;
    }
    const group = groupsById.get(item.id) as CourseGroup;
    groups.push({ ...group, courseIds: group.courseIds.filter(place) });
    order.push({ type: 'group', id: item.id });
  }
  for (const c of courses) if (place(c.id)) order.push({ type: 'course', id: c.id });
  return { groups, order };
}

const sameItem = (a: LayoutItem | null | undefined, b: LayoutItem | null | undefined): boolean =>
  !!a && !!b && a.type === b.type && a.id === b.id;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Same arrangement and titles (what the library shows). */
export function sameLayout(a: LibraryLayout, b: LibraryLayout): boolean {
  if (a.order.length !== b.order.length || a.groups.length !== b.groups.length) return false;
  if (!a.order.every((item, i) => sameItem(item, b.order[i]))) return false;
  const byId = new Map(b.groups.map((g) => [g.id, g]));
  return a.groups.every((g) => {
    const other = byId.get(g.id);
    return !!other && other.title === g.title && sameList(g.courseIds, other.courseIds);
  });
}

/** PUT /api/layout body for an arrangement. */
export function toPutLayout(layout: LibraryLayout): PutLayoutRequest {
  return {
    groups: layout.groups.map((g) => ({ id: g.id, courseIds: [...g.courseIds] })),
    order: layout.order.map((item) => ({ type: item.type, id: item.id })),
  };
}

export function findGroup(layout: LibraryLayout, groupId: string): CourseGroup | null {
  return layout.groups.find((g) => g.id === groupId) ?? null;
}

/** The group a course is in (null = top level or unknown). */
export function groupOfCourse(layout: LibraryLayout, courseId: string): CourseGroup | null {
  return layout.groups.find((g) => g.courseIds.includes(courseId)) ?? null;
}

export type LayoutRow = { type: 'group'; group: CourseGroup; courses: Course[] } | { type: 'course'; course: Course };

/** Top-level rows to render: groups (with their courses) and ungrouped courses, in layout order. */
export function layoutRows(layout: LibraryLayout, courses: readonly Course[]): LayoutRow[] {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const rows: LayoutRow[] = [];
  for (const item of layout.order) {
    if (item.type === 'course') {
      const course = byId.get(item.id);
      if (course) rows.push({ type: 'course', course });
      continue;
    }
    const group = findGroup(layout, item.id);
    if (!group) continue;
    const inGroup = group.courseIds.map((id) => byId.get(id)).filter((c): c is Course => c !== undefined);
    rows.push({ type: 'group', group, courses: inGroup });
  }
  return rows;
}

export interface LayoutEntry {
  course: Course;
  /** The group the course is in (null = top level). */
  group: CourseGroup | null;
}

/** Every course in display order with its group (pickers, "과목으로 이동"). */
export function layoutEntries(layout: LibraryLayout, courses: readonly Course[]): LayoutEntry[] {
  return layoutRows(layout, courses).flatMap((row): LayoutEntry[] =>
    row.type === 'course' ? [{ course: row.course, group: null }] : row.courses.map((course) => ({ course, group: row.group })),
  );
}

/** "그룹 › 과목" for a grouped course, else the course title. */
export function courseLabel(entry: LayoutEntry): string {
  return entry.group ? `${entry.group.title} › ${entry.course.title}` : entry.course.title;
}

// ---------------------------------------------------------------------------------------------------------
// Moves. The destination is given by an anchor ("before this item", null = at the end) rather than an index,
// so that a move queued behind another one still means the same place when it is sent.
// ---------------------------------------------------------------------------------------------------------

/** Move a lecture into a course before `beforeDocId` (null = at the end), or out of every course (courseId null). */
export interface LectureMove {
  kind: 'lecture';
  docId: string;
  courseId: string | null;
  beforeDocId: string | null;
}

/** Move a course into a group (before one of its courses) or to the top level (before a top-level item). */
export interface CourseMove {
  kind: 'course';
  courseId: string;
  groupId: string | null;
  before: LayoutItem | null;
}

/** Move a group within the top level. */
export interface GroupMove {
  kind: 'group';
  groupId: string;
  before: LayoutItem | null;
}

export type Move = LectureMove | CourseMove | GroupMove;

function insertBefore<T>(list: readonly T[], value: T, isAnchor: (x: T) => boolean): T[] {
  const at = list.findIndex(isAnchor);
  const next = list.slice();
  if (at === -1) next.push(value);
  else next.splice(at, 0, value);
  return next;
}

/** Replace one course and drop its lectures from every other course (a lecture is in at most one course). */
export function applyCourseUpdate(courses: readonly Course[], updated: Course): Course[] {
  const taken = new Set(updated.docIds);
  let known = false;
  const next = courses.map((c) => {
    if (c.id === updated.id) {
      known = true;
      return updated;
    }
    return c.docIds.some((id) => taken.has(id)) ? { ...c, docIds: c.docIds.filter((id) => !taken.has(id)) } : c;
  });
  return known ? next : [...next, updated];
}

/** The courses after a lecture move (unchanged when the target course does not exist). */
export function applyLectureMove(courses: readonly Course[], move: LectureMove): Course[] {
  if (move.beforeDocId === move.docId) return courses.slice();
  if (move.courseId === null) {
    return courses.map((c) => (c.docIds.includes(move.docId) ? { ...c, docIds: c.docIds.filter((id) => id !== move.docId) } : c));
  }
  const target = courses.find((c) => c.id === move.courseId);
  if (!target) return courses.slice();
  const rest = target.docIds.filter((id) => id !== move.docId);
  const docIds = insertBefore(rest, move.docId, (id) => id === move.beforeDocId);
  return applyCourseUpdate(courses, { ...target, docIds });
}

/**
 * The single PATCH that performs a lecture move (DESIGN §18): the target course with its new lecture list (the
 * server removes the lecture from its old course), or — for "미분류" — the course the lecture leaves.
 * null when nothing changes.
 */
export function lectureMovePatch(courses: readonly Course[], move: LectureMove): { courseId: string; docIds: string[] } | null {
  const next = applyLectureMove(courses, move);
  if (move.courseId === null) {
    // The course the lecture belongs to (the oldest one if it is listed twice, like on the server).
    const from = courses.find((c) => c.docIds.includes(move.docId));
    if (!from) return null;
    return { courseId: from.id, docIds: from.docIds.filter((id) => id !== move.docId) };
  }
  const before = courses.find((c) => c.id === move.courseId);
  const after = next.find((c) => c.id === move.courseId);
  if (!before || !after) return null;
  const elsewhere = courses.some((c) => c.id !== move.courseId && c.docIds.includes(move.docId));
  if (!elsewhere && sameList(before.docIds, after.docIds)) return null;
  return { courseId: after.id, docIds: after.docIds };
}

/** The layout without these courses (wherever they are). */
export function withoutCourses(layout: LibraryLayout, courseIds: Iterable<string>): LibraryLayout {
  const removed = new Set(courseIds);
  return {
    groups: layout.groups.map((g) => ({ ...g, courseIds: g.courseIds.filter((id) => !removed.has(id)) })),
    order: layout.order.filter((item) => item.type === 'group' || !removed.has(item.id)),
  };
}

/** The layout after a course move (unchanged when the target group does not exist). */
export function applyCourseMove(layout: LibraryLayout, move: CourseMove): LibraryLayout {
  const self: LayoutItem = { type: 'course', id: move.courseId };
  if (sameItem(move.before, self)) return layout;
  if (move.groupId !== null && !findGroup(layout, move.groupId)) return layout;
  const rest = withoutCourses(layout, [move.courseId]);
  if (move.groupId === null) {
    return { ...rest, order: insertBefore(rest.order, self, (item) => sameItem(item, move.before)) };
  }
  const anchor = move.before?.type === 'course' ? move.before.id : null;
  return {
    ...rest,
    groups: rest.groups.map((g) =>
      g.id === move.groupId ? { ...g, courseIds: insertBefore(g.courseIds, move.courseId, (id) => id === anchor) } : g,
    ),
  };
}

/** Keep `groups` in top-level order (like the server does). */
function sortGroups(layout: LibraryLayout): LibraryLayout {
  const position = new Map(layout.order.filter((i) => i.type === 'group').map((item, i) => [item.id, i]));
  const groups = layout.groups.slice().sort((a, b) => (position.get(a.id) ?? 1e9) - (position.get(b.id) ?? 1e9));
  return { ...layout, groups };
}

/** The layout after a group move. */
export function applyGroupMove(layout: LibraryLayout, move: GroupMove): LibraryLayout {
  const self: LayoutItem = { type: 'group', id: move.groupId };
  if (sameItem(move.before, self) || !findGroup(layout, move.groupId)) return layout;
  const rest = layout.order.filter((item) => !sameItem(item, self));
  return sortGroups({ ...layout, order: insertBefore(rest, self, (item) => sameItem(item, move.before)) });
}

/** A new course at the end of a group (or of the top level), as POST /api/courses places it. */
export function withCourseAdded(layout: LibraryLayout, courseId: string, groupId: string | null): LibraryLayout {
  const rest = withoutCourses(layout, [courseId]);
  if (groupId !== null && findGroup(rest, groupId)) {
    return { ...rest, groups: rest.groups.map((g) => (g.id === groupId ? { ...g, courseIds: [...g.courseIds, courseId] } : g)) };
  }
  return { ...rest, order: [...rest.order, { type: 'course', id: courseId }] };
}

/** A new group appended to the top level; its courses move into it from wherever they were (POST /api/groups). */
export function withGroupAppended(layout: LibraryLayout, group: CourseGroup): LibraryLayout {
  const rest = withoutCourses(layout, group.courseIds);
  const groups = rest.groups.filter((g) => g.id !== group.id);
  const order = rest.order.filter((item) => !(item.type === 'group' && item.id === group.id));
  return { groups: [...groups, { ...group, courseIds: [...group.courseIds] }], order: [...order, { type: 'group', id: group.id }] };
}

/** Deleting a group moves its courses to the top level at the group's position (DELETE /api/groups/:id). */
export function withoutGroup(layout: LibraryLayout, groupId: string): LibraryLayout {
  const group = findGroup(layout, groupId);
  if (!group) return layout;
  const courses: LayoutItem[] = group.courseIds.map((id) => ({ type: 'course', id }));
  return {
    groups: layout.groups.filter((g) => g.id !== groupId),
    order: layout.order.flatMap((item) => (item.type === 'group' && item.id === groupId ? courses : [item])),
  };
}

/**
 * Where keyboard focus goes when `item` is deleted and its card disappears: for a group, its first course (it
 * stays where the group was); otherwise the next item of the same list, else the previous one, else — for the
 * last course of a group — the group. null when nothing is left nearby.
 */
export function neighbourAfterDelete(layout: LibraryLayout, item: LayoutItem): LayoutItem | null {
  if (item.type === 'group') {
    const first = findGroup(layout, item.id)?.courseIds[0];
    if (first !== undefined) return { type: 'course', id: first };
  } else {
    const group = groupOfCourse(layout, item.id);
    if (group) {
      const i = group.courseIds.indexOf(item.id);
      const near = group.courseIds[i + 1] ?? group.courseIds[i - 1];
      return near !== undefined ? { type: 'course', id: near } : { type: 'group', id: group.id };
    }
  }
  const i = layout.order.findIndex((x) => sameItem(x, item));
  if (i === -1) return null;
  return layout.order[i + 1] ?? layout.order[i - 1] ?? null;
}

export function withGroupTitle(layout: LibraryLayout, groupId: string, title: string): LibraryLayout {
  return { ...layout, groups: layout.groups.map((g) => (g.id === groupId ? { ...g, title } : g)) };
}

// ---------------------------------------------------------------------------------------------------------
// Collapse state (per device, localStorage `easy-study:collapsed`): keys of collapsed courses and groups.
// ---------------------------------------------------------------------------------------------------------

export const collapseKey = {
  course: (courseId: string) => `course:${courseId}`,
  group: (groupId: string) => `group:${groupId}`,
};

export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Every collapsible key of the library (courses and groups). */
export function allCollapseKeys(layout: LibraryLayout, courses: readonly Course[]): string[] {
  return [...layout.groups.map((g) => collapseKey.group(g.id)), ...courses.map((c) => collapseKey.course(c.id))];
}
