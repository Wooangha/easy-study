// Library organization (DESIGN §18): course groups, the top-level order and moves of lectures, courses and
// groups. Pure functions on the shared contract types, used by the organizer store (optimistic updates), the
// library view (rendering, drag & drop) and the pickers. Lecture membership/order lives in the courses
// (Course.docIds); groups and the order of courses live in the layout.
import type { Course, CourseGroup, LayoutItem, LibraryLayout, PutLayoutRequest } from '../../../shared/types.ts';

export const EMPTY_LAYOUT: LibraryLayout = { groups: [], order: [] };

/**
 * The layout as the server normalises it (DESIGN §18), against the courses the client knows (createdAt order),
 * read from the top level down: unknown courses and items of unknown groups are dropped, a course or group listed
 * twice keeps its first place (so no group is inside itself), groups that are nowhere are appended to the top
 * level (with what they hold), existing courses that are not mentioned too. `groups` lists every group in display
 * order (a group before what it holds). `null` = every course at the top level.
 */
export function normalizeLayout(layout: LibraryLayout | null | undefined, courses: readonly Course[]): LibraryLayout {
  const existing = new Set(courses.map((c) => c.id));
  const groupsById = new Map<string, CourseGroup>();
  for (const g of layout?.groups ?? []) if (!groupsById.has(g.id)) groupsById.set(g.id, g);

  const placedCourses = new Set<string>();
  const placedGroups = new Set<string>();
  const groups: CourseGroup[] = [];
  const place = (items: readonly LayoutItem[]): LayoutItem[] => {
    const shown: LayoutItem[] = [];
    for (const item of items) {
      if (item.type === 'course') {
        if (!existing.has(item.id) || placedCourses.has(item.id)) continue;
        placedCourses.add(item.id);
        shown.push({ type: 'course', id: item.id });
        continue;
      }
      const group = groupsById.get(item.id);
      if (!group || placedGroups.has(item.id)) continue;
      placedGroups.add(item.id);
      const entry: CourseGroup = { ...group, items: [] };
      groups.push(entry);
      entry.items = place(group.items ?? []);
      shown.push({ type: 'group', id: item.id });
    }
    return shown;
  };
  const order = place(layout?.order ?? []);
  for (const id of groupsById.keys()) if (!placedGroups.has(id)) order.push(...place([{ type: 'group', id }]));
  for (const c of courses) if (!placedCourses.has(c.id)) order.push(...place([{ type: 'course', id: c.id }]));
  return { groups, order };
}

export const sameItem = (a: LayoutItem | null | undefined, b: LayoutItem | null | undefined): boolean =>
  !!a && !!b && a.type === b.type && a.id === b.id;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const sameItems = (a: readonly LayoutItem[], b: readonly LayoutItem[]): boolean =>
  a.length === b.length && a.every((x, i) => sameItem(x, b[i]));

/** Same arrangement and titles (what the library shows). */
export function sameLayout(a: LibraryLayout, b: LibraryLayout): boolean {
  if (!sameItems(a.order, b.order) || a.groups.length !== b.groups.length) return false;
  const byId = new Map(b.groups.map((g) => [g.id, g]));
  return a.groups.every((g) => {
    const other = byId.get(g.id);
    return !!other && other.title === g.title && sameItems(g.items, other.items);
  });
}

/** PUT /api/layout body for an arrangement. */
export function toPutLayout(layout: LibraryLayout): PutLayoutRequest {
  return {
    groups: layout.groups.map((g) => ({ id: g.id, items: g.items.map((item) => ({ type: item.type, id: item.id })) })),
    order: layout.order.map((item) => ({ type: item.type, id: item.id })),
  };
}

export function findGroup(layout: LibraryLayout, groupId: string): CourseGroup | null {
  return layout.groups.find((g) => g.id === groupId) ?? null;
}

/** The items of a group, or of the top level (null). */
export function childrenOf(layout: LibraryLayout, parentId: string | null): LayoutItem[] {
  return parentId === null ? layout.order : (findGroup(layout, parentId)?.items ?? []);
}

/** The group an item is in: its id, null for the top level, undefined when the item is nowhere. */
export function parentOf(layout: LibraryLayout, item: LayoutItem): string | null | undefined {
  if (layout.order.some((x) => sameItem(x, item))) return null;
  return layout.groups.find((g) => g.items.some((x) => sameItem(x, item)))?.id;
}

/** The group a course is in (null = top level or unknown). */
export function groupOfCourse(layout: LibraryLayout, courseId: string): CourseGroup | null {
  return layout.groups.find((g) => g.items.some((item) => item.type === 'course' && item.id === courseId)) ?? null;
}

/** The groups an item is in, outermost first ([] at the top level). */
export function groupPath(layout: LibraryLayout, item: LayoutItem): CourseGroup[] {
  const path: CourseGroup[] = [];
  const seen = new Set<string>();
  for (let parent = parentOf(layout, item); parent; parent = parentOf(layout, { type: 'group', id: parent })) {
    const group = findGroup(layout, parent);
    if (!group || seen.has(parent)) break;
    seen.add(parent);
    path.unshift(group);
  }
  return path;
}

/** Whether `groupId` is `ancestorId` or inside it (at any depth): it cannot be moved into it. */
export function isWithin(layout: LibraryLayout, groupId: string, ancestorId: string): boolean {
  return groupId === ancestorId || groupPath(layout, { type: 'group', id: groupId }).some((g) => g.id === ancestorId);
}

/** The courses inside a group, at any depth. */
export function coursesInside(layout: LibraryLayout, groupId: string): string[] {
  const seen = new Set<string>();
  const walk = (id: string): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    return (findGroup(layout, id)?.items ?? []).flatMap((item) => (item.type === 'course' ? [item.id] : walk(item.id)));
  };
  return walk(groupId);
}

export type LayoutRow =
  | { type: 'group'; group: CourseGroup; children: LayoutRow[]; parentId: string | null }
  | { type: 'course'; course: Course; parentId: string | null };

/** The rows to render, in layout order: groups (with what they hold, nested) and the courses outside groups. */
export function layoutRows(layout: LibraryLayout, courses: readonly Course[]): LayoutRow[] {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const rows = (items: readonly LayoutItem[], parentId: string | null): LayoutRow[] =>
    items.flatMap((item): LayoutRow[] => {
      if (item.type === 'course') {
        const course = byId.get(item.id);
        return course ? [{ type: 'course', course, parentId }] : [];
      }
      const group = findGroup(layout, item.id);
      if (!group || seen.has(group.id)) return [];
      seen.add(group.id);
      return [{ type: 'group', group, children: rows(group.items, group.id), parentId }];
    });
  return rows(layout.order, null);
}

export interface LayoutEntry {
  course: Course;
  /** The group the course is in (null = top level). */
  group: CourseGroup | null;
  /** The groups it is in, outermost first (the last one is `group`). */
  path: CourseGroup[];
}

/** Every course in display order with its groups (pickers, "과목으로 이동"). */
export function layoutEntries(layout: LibraryLayout, courses: readonly Course[]): LayoutEntry[] {
  const walk = (rows: readonly LayoutRow[], path: CourseGroup[]): LayoutEntry[] =>
    rows.flatMap((row): LayoutEntry[] =>
      row.type === 'course'
        ? [{ course: row.course, group: path.at(-1) ?? null, path }]
        : walk(row.children, [...path, row.group]),
    );
  return walk(layoutRows(layout, courses), []);
}

/** "그룹 › 과목" ("학기 › 전공 › 과목") for a grouped course, else the course title. */
export function courseLabel(entry: LayoutEntry): string {
  return [...entry.path.map((g) => g.title), entry.course.title].join(' › ');
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

/** Move a course into a group or to the top level (groupId null), before an item there (null = at the end). */
export interface CourseMove {
  kind: 'course';
  courseId: string;
  groupId: string | null;
  before: LayoutItem | null;
}

/** Move a group into another group or to the top level (parentId null), before an item there (null = at the end). */
export interface GroupMove {
  kind: 'group';
  groupId: string;
  parentId: string | null;
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
  const keep = (item: LayoutItem) => item.type === 'group' || !removed.has(item.id);
  return {
    groups: layout.groups.map((g) => ({ ...g, items: g.items.filter(keep) })),
    order: layout.order.filter(keep),
  };
}

/** Keep `groups` in display order (a group before what it holds), like the server does. */
function inDisplayOrder(layout: LibraryLayout): LibraryLayout {
  const byId = new Map(layout.groups.map((g) => [g.id, g]));
  const groups: CourseGroup[] = [];
  const walk = (items: readonly LayoutItem[]): void => {
    for (const item of items) {
      const group = item.type === 'group' ? byId.get(item.id) : undefined;
      if (!group) continue;
      byId.delete(item.id);
      groups.push(group);
      walk(group.items);
    }
  };
  walk(layout.order);
  return { groups, order: layout.order };
}

/** `item` taken out of wherever it is and put into `parentId`'s items (null: the top level) before `before`. */
function withItemAt(layout: LibraryLayout, item: LayoutItem, parentId: string | null, before: LayoutItem | null): LibraryLayout {
  const keep = (x: LayoutItem) => !sameItem(x, item);
  const groups = layout.groups.map((g) => ({ ...g, items: g.items.filter(keep) }));
  const order = layout.order.filter(keep);
  const put = (items: LayoutItem[]) => insertBefore(items, item, (x) => sameItem(x, before));
  return inDisplayOrder({
    groups: parentId === null ? groups : groups.map((g) => (g.id === parentId ? { ...g, items: put(g.items) } : g)),
    order: parentId === null ? put(order) : order,
  });
}

/** The layout after a course move (unchanged when the target group does not exist). */
export function applyCourseMove(layout: LibraryLayout, move: CourseMove): LibraryLayout {
  const self: LayoutItem = { type: 'course', id: move.courseId };
  if (sameItem(move.before, self)) return layout;
  if (move.groupId !== null && !findGroup(layout, move.groupId)) return layout;
  return withItemAt(layout, self, move.groupId, move.before);
}

/** The layout after a group move (unchanged when the group or the target is gone, or the target is inside it). */
export function applyGroupMove(layout: LibraryLayout, move: GroupMove): LibraryLayout {
  const self: LayoutItem = { type: 'group', id: move.groupId };
  if (sameItem(move.before, self) || !findGroup(layout, move.groupId)) return layout;
  if (move.parentId !== null && (!findGroup(layout, move.parentId) || isWithin(layout, move.parentId, move.groupId))) return layout;
  return withItemAt(layout, self, move.parentId, move.before);
}

/** A new course at the end of a group (or of the top level), as POST /api/courses places it. */
export function withCourseAdded(layout: LibraryLayout, courseId: string, groupId: string | null): LibraryLayout {
  const parent = groupId !== null && findGroup(layout, groupId) ? groupId : null;
  return withItemAt(layout, { type: 'course', id: courseId }, parent, null);
}

/**
 * A new group at the end of `parentId` (null: of the top level); its courses move into it from wherever they were
 * (POST /api/groups).
 */
export function withGroupAppended(layout: LibraryLayout, group: CourseGroup, parentId: string | null = null): LibraryLayout {
  const moving = group.items.filter((item) => item.type === 'course').map((item) => item.id);
  const rest = withoutCourses(layout, moving);
  const others = { groups: rest.groups.filter((g) => g.id !== group.id), order: rest.order };
  const parent = parentId !== null && findGroup(others, parentId) ? parentId : null;
  const added = { ...others, groups: [...others.groups, { ...group, items: [...group.items] }] };
  return withItemAt(added, { type: 'group', id: group.id }, parent, null);
}

/** Deleting a group moves what it held (courses and groups) to its place (DELETE /api/groups/:id). */
export function withoutGroup(layout: LibraryLayout, groupId: string): LibraryLayout {
  const group = findGroup(layout, groupId);
  if (!group) return layout;
  const replace = (items: readonly LayoutItem[]): LayoutItem[] =>
    items.flatMap((item) => (item.type === 'group' && item.id === groupId ? group.items : [item]));
  return inDisplayOrder({
    groups: layout.groups.filter((g) => g.id !== groupId).map((g) => ({ ...g, items: replace(g.items) })),
    order: replace(layout.order),
  });
}

/**
 * Where keyboard focus goes when `item` is deleted and its card disappears: for a group, the first thing it held
 * (it stays where the group was); otherwise the next item of the same list, else the previous one, else — the
 * last item of a group — the group. null when nothing is left nearby.
 */
export function neighbourAfterDelete(layout: LibraryLayout, item: LayoutItem): LayoutItem | null {
  if (item.type === 'group') {
    const first = findGroup(layout, item.id)?.items[0];
    if (first !== undefined) return first;
  }
  const parent = parentOf(layout, item);
  if (parent === undefined) return null;
  const list = childrenOf(layout, parent);
  const i = list.findIndex((x) => sameItem(x, item));
  const near = list[i + 1] ?? list[i - 1];
  if (near !== undefined) return near;
  return parent === null ? null : { type: 'group', id: parent };
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
