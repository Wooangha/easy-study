// Library organization (DESIGN §18): the arrangement of courses into groups and the top-level order.
// Pure functions only: normalising what library/layout.json holds, validating PUT /api/layout and the small
// moves the group/course mutations make. Reading and writing the file (serialized with the course
// mutations) is done by courses.ts.
import { layoutRevision } from '../shared/layoutRevision.ts';
import { COURSE_ID_RE } from '../shared/types.ts';
import type { CourseGroup, LayoutItem, LibraryLayout } from '../shared/types.ts';
import { HttpError } from './config.ts';
import { smsg } from './i18n.ts';

/** How many ids an error message lists before "…". */
const MAX_IDS_IN_MESSAGE = 5;
/** Longest id an error message repeats (unknown ids come from the client). */
const MAX_ID_CHARS_IN_MESSAGE = 90;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** "a, b, c 외 2개" ("a, b, c and 2 more"): each id once (an id can be found wrong in several places, e.g. `groups` and `order`). */
export function listIds(ids: readonly string[]): string {
  const unique = [...new Set(ids)];
  const shown = unique
    .slice(0, MAX_IDS_IN_MESSAGE)
    .map((id) => (id.length > MAX_ID_CHARS_IN_MESSAGE ? `${id.slice(0, MAX_ID_CHARS_IN_MESSAGE)}…` : id));
  return unique.length > MAX_IDS_IN_MESSAGE
    ? smsg().library.layout.moreIds(shown.join(', '), unique.length - MAX_IDS_IN_MESSAGE)
    : shown.join(', ');
}

function parseItem(value: unknown): LayoutItem | null {
  if (!isObject(value) || typeof value.id !== 'string') return null;
  if (value.type === 'group') return { type: 'group', id: value.id };
  if (value.type === 'course') return { type: 'course', id: value.id };
  return null;
}

/**
 * A stored group, or null when the entry is unusable (bad id, no title). Malformed items are dropped; a group
 * saved before 0.6.15 lists its courses as `courseIds`.
 */
function parseStoredGroup(value: unknown): CourseGroup | null {
  if (!isObject(value)) return null;
  const { id, title, createdAt, items, courseIds } = value;
  if (typeof id !== 'string' || !COURSE_ID_RE.test(id) || typeof title !== 'string') return null;
  const parsed = Array.isArray(items)
    ? items.map(parseItem).filter((item): item is LayoutItem => item !== null)
    : Array.isArray(courseIds)
      ? courseIds.filter((courseId): courseId is string => typeof courseId === 'string').map((courseId): LayoutItem => ({ type: 'course', id: courseId }))
      : [];
  return { id, title, createdAt: typeof createdAt === 'string' ? createdAt : '', items: parsed };
}

/**
 * The layout as the API shows it, from whatever library/layout.json holds (`null` when it is missing or
 * unreadable) and the ids of the existing courses, oldest first. Read from the top level down, in display order:
 * - unknown/deleted course ids and items of unknown groups are dropped (so are malformed entries; of two groups
 *   with the same id the first one counts);
 * - a course or group listed twice keeps its first place (so a group can never end up inside itself);
 * - groups that are nowhere (not in `order`, not in a group that is) are appended to the top level;
 * - existing courses that are not mentioned are appended to the top level in createdAt order.
 * A missing file therefore gives every course at the top level, oldest first. `groups` lists every group in display
 * order (a group before what it holds), so every existing course appears exactly once and every group exactly once.
 */
export function normalizeLayout(stored: unknown, courseIds: readonly string[]): LibraryLayout {
  const existing = new Set(courseIds);
  const source = isObject(stored) ? stored : {};

  const groupsById = new Map<string, CourseGroup>();
  for (const value of Array.isArray(source.groups) ? source.groups : []) {
    const group = parseStoredGroup(value);
    if (group && !groupsById.has(group.id)) groupsById.set(group.id, group);
  }

  const placedCourses = new Set<string>();
  const placedGroups = new Set<string>();
  const groups: CourseGroup[] = [];
  /** The items as shown: each course and group once, groups read with what they hold. */
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
      entry.items = place(group.items);
      shown.push({ type: 'group', id: item.id });
    }
    return shown;
  };

  const storedOrder = (Array.isArray(source.order) ? source.order : []).map(parseItem).filter((item): item is LayoutItem => item !== null);
  const order = place(storedOrder);
  for (const id of groupsById.keys()) {
    if (!placedGroups.has(id)) order.push(...place([{ type: 'group', id }]));
  }
  for (const courseId of courseIds) {
    if (!placedCourses.has(courseId)) order.push(...place([{ type: 'course', id: courseId }]));
  }
  return { groups, order };
}

/**
 * Validates PUT /api/layout (PutLayoutRequest) against the current normalised layout and returns the new one.
 * With `baseRevision`, the request must have been made from the current arrangement (409 otherwise: it was
 * changed in another tab or on another device, and this request would silently undo that). The request is the
 * full arrangement: every existing group and course exactly once, reachable from the top level, nothing unknown
 * (400 otherwise, e.g. when a course was created or deleted elsewhere since the client loaded the layout); a
 * group inside itself (or inside a group it holds) is refused too. Titles and creation times are kept; `groups`
 * of the result follows the new display order.
 */
export function validateLayoutRequest(body: unknown, current: LibraryLayout, courseIds: readonly string[]): LibraryLayout {
  const m = smsg().library.layout;
  const malformed = () => new HttpError(400, m.malformed);
  if (!isObject(body) || !Array.isArray(body.groups) || !Array.isArray(body.order)) throw malformed();
  if (body.baseRevision !== undefined) {
    if (typeof body.baseRevision !== 'string') throw malformed();
    if (body.baseRevision !== layoutRevision(current)) {
      throw new HttpError(409, m.changedElsewhere);
    }
  }

  const knownGroups = new Map(current.groups.map((group) => [group.id, group]));
  const knownCourses = new Set(courseIds);
  const unknownGroups: string[] = [];
  const unknownCourses: string[] = [];
  const duplicateGroups: string[] = [];
  const duplicateCourses: string[] = [];

  const parseItems = (value: unknown): LayoutItem[] => {
    if (!Array.isArray(value)) throw malformed();
    return value.map((entry) => {
      const item = parseItem(entry);
      if (!item) throw malformed();
      return item;
    });
  };

  const listed = new Map<string, LayoutItem[]>();
  for (const value of body.groups) {
    if (!isObject(value) || typeof value.id !== 'string') throw malformed();
    // A client from before 0.6.15 sends the courses of a group as `courseIds`.
    let items: LayoutItem[];
    if (value.items !== undefined) items = parseItems(value.items);
    else if (Array.isArray(value.courseIds) && value.courseIds.every((courseId) => typeof courseId === 'string')) {
      items = (value.courseIds as string[]).map((courseId) => ({ type: 'course', id: courseId }));
    } else throw malformed();
    const id = value.id;
    if (!knownGroups.has(id)) unknownGroups.push(id);
    else if (listed.has(id)) duplicateGroups.push(id);
    else listed.set(id, items);
  }
  const order = parseItems(body.order);

  // From the top level down, in display order, so that "listed twice" names the later place.
  const placedCourses = new Set<string>();
  const placeCourse = (courseId: string): void => {
    if (!knownCourses.has(courseId)) unknownCourses.push(courseId);
    else if (placedCourses.has(courseId)) duplicateCourses.push(courseId);
    else placedCourses.add(courseId);
  };
  const reached = new Set<string>();
  const groups: CourseGroup[] = [];
  const walk = (items: readonly LayoutItem[]): void => {
    for (const item of items) {
      if (item.type === 'course') {
        placeCourse(item.id);
        continue;
      }
      if (!knownGroups.has(item.id)) unknownGroups.push(item.id);
      else if (reached.has(item.id)) duplicateGroups.push(item.id);
      else {
        reached.add(item.id);
        const children = listed.get(item.id) ?? [];
        groups.push({ ...(knownGroups.get(item.id) as CourseGroup), items: [...children] });
        walk(children);
      }
    }
  };
  walk(order);
  // Groups listed in `groups` but not reached from the top level: in a loop (a group inside itself, or inside a group
  // it holds) or simply left out, with what they hold. What they hold still counts as placed (so the error names
  // those groups, not the courses and groups that are merely inside them).
  const unreached = [...listed.keys()].filter((id) => !reached.has(id));
  const parentOf = new Map<string, string>();
  for (const [id, items] of listed) {
    for (const item of items) if (item.type === 'group' && !parentOf.has(item.id)) parentOf.set(item.id, id);
  }
  const inLoop = unreached.filter((id) => {
    const seen = new Set<string>();
    for (let at = parentOf.get(id); at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      if (at === id) return true;
      seen.add(at);
    }
    return false;
  });
  /** Left out: the outermost of the unreached groups (those inside them are not named). */
  const leftOut = unreached.filter((id) => !inLoop.includes(id) && !unreached.includes(parentOf.get(id) ?? ''));
  for (const id of unreached) {
    for (const item of listed.get(id) ?? []) if (item.type === 'course') placeCourse(item.id);
  }

  if (unknownGroups.length > 0) throw new HttpError(400, m.unknownGroups(listIds(unknownGroups)));
  if (unknownCourses.length > 0) throw new HttpError(400, m.unknownCourses(listIds(unknownCourses)));
  if (duplicateGroups.length > 0) throw new HttpError(400, m.duplicateGroups(listIds(duplicateGroups)));
  if (duplicateCourses.length > 0) throw new HttpError(400, m.duplicateCourses(listIds(duplicateCourses)));
  if (inLoop.length > 0) throw new HttpError(400, m.groupInsideItself(listIds(inLoop)));
  const missingGroups = current.groups.map((group) => group.id).filter((id) => !listed.has(id) || leftOut.includes(id));
  if (missingGroups.length > 0) throw new HttpError(400, m.missingGroups(listIds(missingGroups)));
  const missingCourses = courseIds.filter((id) => !placedCourses.has(id));
  if (missingCourses.length > 0) throw new HttpError(400, m.missingCourses(listIds(missingCourses)));
  return { groups, order };
}

/**
 * Validates CreateGroupRequest.courseIds: absent (undefined/null) = none, otherwise distinct ids of existing
 * courses (400 for anything else).
 */
export function validateGroupCourseIds(value: unknown, courseIds: readonly string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, smsg().library.layout.courseIdsInvalid);
  }
  const known = new Set(courseIds);
  const unknown = (value as string[]).filter((id) => !known.has(id));
  if (unknown.length > 0) throw new HttpError(400, smsg().library.layout.unknownCourses(listIds(unknown)));
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of value as string[]) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  if (duplicates.length > 0) throw new HttpError(400, smsg().library.layout.duplicateCourses(listIds(duplicates)));
  return [...(value as string[])];
}

/** The layout without these courses (wherever they were). */
export function withoutCourses(layout: LibraryLayout, courseIds: Iterable<string>): LibraryLayout {
  const removed = new Set(courseIds);
  const keep = (item: LayoutItem) => item.type === 'group' || !removed.has(item.id);
  return {
    groups: layout.groups.map((group) => ({ ...group, items: group.items.filter(keep) })),
    order: layout.order.filter(keep),
  };
}

/** `groups` in display order (a group before what it holds), as normalizeLayout and validateLayoutRequest give it. */
function inDisplayOrder(layout: LibraryLayout): LibraryLayout {
  const byId = new Map(layout.groups.map((group) => [group.id, group]));
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

/**
 * Appends a new group at the end of `parentId`'s items (null: of the top level); `group.items` (courses) are moved
 * into it from wherever they were. The parent must exist.
 */
export function withGroupAppended(layout: LibraryLayout, group: CourseGroup, parentId: string | null = null): LibraryLayout {
  const moving = group.items.filter((item) => item.type === 'course').map((item) => item.id);
  const rest = withoutCourses(layout, moving);
  const self: LayoutItem = { type: 'group', id: group.id };
  const groups = rest.groups.map((candidate) => (candidate.id === parentId ? { ...candidate, items: [...candidate.items, self] } : candidate));
  return inDisplayOrder({ groups: [...groups, { ...group }], order: parentId === null ? [...rest.order, self] : rest.order });
}

/** Moves a course to the end of a group (which must exist). */
export function withCourseInGroup(layout: LibraryLayout, courseId: string, groupId: string): LibraryLayout {
  const rest = withoutCourses(layout, [courseId]);
  return {
    ...rest,
    groups: rest.groups.map((group) => (group.id === groupId ? { ...group, items: [...group.items, { type: 'course', id: courseId }] } : group)),
  };
}

/** Removes a group; what it held (courses and groups) moves to the group's place, in the group's order. */
export function withoutGroup(layout: LibraryLayout, groupId: string): LibraryLayout {
  const group = layout.groups.find((candidate) => candidate.id === groupId);
  const held = group?.items ?? [];
  const replace = (items: readonly LayoutItem[]): LayoutItem[] =>
    items.flatMap((item) => (item.type === 'group' && item.id === groupId ? held : [item]));
  return inDisplayOrder({
    groups: layout.groups.filter((candidate) => candidate.id !== groupId).map((candidate) => ({ ...candidate, items: replace(candidate.items) })),
    order: replace(layout.order),
  });
}
