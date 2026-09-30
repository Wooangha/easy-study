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

/** A stored group, or null when the entry is unusable (bad id, no title). Invalid course ids are dropped. */
function parseStoredGroup(value: unknown): CourseGroup | null {
  if (!isObject(value)) return null;
  const { id, title, createdAt, courseIds } = value;
  if (typeof id !== 'string' || !COURSE_ID_RE.test(id) || typeof title !== 'string') return null;
  return {
    id,
    title,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    courseIds: Array.isArray(courseIds) ? courseIds.filter((courseId): courseId is string => typeof courseId === 'string') : [],
  };
}

function parseItem(value: unknown): LayoutItem | null {
  if (!isObject(value) || typeof value.id !== 'string') return null;
  if (value.type === 'group') return { type: 'group', id: value.id };
  if (value.type === 'course') return { type: 'course', id: value.id };
  return null;
}

/**
 * The layout as the API shows it, from whatever library/layout.json holds (`null` when it is missing or
 * unreadable) and the ids of the existing courses, oldest first:
 * - unknown/deleted course ids and group items of unknown groups are dropped (so are malformed entries;
 *   of two groups with the same id the first one counts);
 * - groups missing from `order` are appended to the top level;
 * - a course listed twice keeps its first position in display order (the top-level order, a group's courses
 *   in the group's place);
 * - existing courses that are not mentioned are appended to the top level in createdAt order.
 * A missing file therefore gives every course at the top level, oldest first. `groups` follows the top-level
 * order, so every existing course appears exactly once and every group exactly once.
 */
export function normalizeLayout(stored: unknown, courseIds: readonly string[]): LibraryLayout {
  const existing = new Set(courseIds);
  const source = isObject(stored) ? stored : {};

  const groupsById = new Map<string, CourseGroup>();
  for (const value of Array.isArray(source.groups) ? source.groups : []) {
    const group = parseStoredGroup(value);
    if (group && !groupsById.has(group.id)) groupsById.set(group.id, group);
  }

  const items: LayoutItem[] = [];
  const mentionedGroups = new Set<string>();
  for (const value of Array.isArray(source.order) ? source.order : []) {
    const item = parseItem(value);
    if (!item) continue;
    if (item.type === 'group') {
      if (!groupsById.has(item.id) || mentionedGroups.has(item.id)) continue;
      mentionedGroups.add(item.id);
    }
    items.push(item);
  }
  for (const id of groupsById.keys()) {
    if (!mentionedGroups.has(id)) items.push({ type: 'group', id });
  }

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
      if (place(item.id)) order.push(item);
      continue;
    }
    const group = groupsById.get(item.id) as CourseGroup;
    groups.push({ ...group, courseIds: group.courseIds.filter(place) });
    order.push(item);
  }
  for (const courseId of courseIds) {
    if (place(courseId)) order.push({ type: 'course', id: courseId });
  }
  return { groups, order };
}

/**
 * Validates PUT /api/layout (PutLayoutRequest) against the current normalised layout and returns the new one.
 * With `baseRevision`, the request must have been made from the current arrangement (409 otherwise: it was
 * changed in another tab or on another device, and this request would silently undo that). The request is the
 * full arrangement: every existing group and course exactly once, nothing unknown (400 otherwise, e.g. when a
 * course was created or deleted elsewhere since the client loaded the layout). Titles and creation times are
 * kept; `groups` of the result follows the new top-level order.
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

  const placedCourses = new Set<string>();
  const placeCourse = (courseId: string): void => {
    if (!knownCourses.has(courseId)) unknownCourses.push(courseId);
    else if (placedCourses.has(courseId)) duplicateCourses.push(courseId);
    else placedCourses.add(courseId);
  };

  const listed = new Map<string, string[]>();
  for (const value of body.groups) {
    if (!isObject(value) || typeof value.id !== 'string' || !Array.isArray(value.courseIds)) throw malformed();
    if (value.courseIds.some((courseId) => typeof courseId !== 'string')) throw malformed();
    const id = value.id;
    if (!knownGroups.has(id)) unknownGroups.push(id);
    else if (listed.has(id)) duplicateGroups.push(id);
    else listed.set(id, value.courseIds as string[]);
  }

  const order: LayoutItem[] = [];
  const orderedGroups = new Set<string>();
  for (const value of body.order) {
    const item = parseItem(value);
    if (!item) throw malformed();
    if (item.type === 'course') {
      order.push(item);
      continue;
    }
    if (!knownGroups.has(item.id)) unknownGroups.push(item.id);
    else if (orderedGroups.has(item.id)) duplicateGroups.push(item.id);
    else {
      orderedGroups.add(item.id);
      order.push(item);
    }
  }

  // Courses in display order, so that "listed twice" names the later place.
  const groups: CourseGroup[] = [];
  for (const item of order) {
    if (item.type === 'course') {
      placeCourse(item.id);
      continue;
    }
    const courseIdsOfGroup = listed.get(item.id) ?? [];
    courseIdsOfGroup.forEach(placeCourse);
    groups.push({ ...(knownGroups.get(item.id) as CourseGroup), courseIds: [...courseIdsOfGroup] });
  }
  // Groups listed in `groups` but left out of `order`: their courses still count as placed (so the error
  // names the missing group, not courses that are merely inside it).
  for (const [id, courseIdsOfGroup] of listed) {
    if (!orderedGroups.has(id)) courseIdsOfGroup.forEach(placeCourse);
  }

  if (unknownGroups.length > 0) throw new HttpError(400, m.unknownGroups(listIds(unknownGroups)));
  if (unknownCourses.length > 0) throw new HttpError(400, m.unknownCourses(listIds(unknownCourses)));
  if (duplicateGroups.length > 0) throw new HttpError(400, m.duplicateGroups(listIds(duplicateGroups)));
  if (duplicateCourses.length > 0) throw new HttpError(400, m.duplicateCourses(listIds(duplicateCourses)));
  const missingGroups = current.groups.map((group) => group.id).filter((id) => !listed.has(id) || !orderedGroups.has(id));
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
  return {
    groups: layout.groups.map((group) => ({ ...group, courseIds: group.courseIds.filter((id) => !removed.has(id)) })),
    order: layout.order.filter((item) => item.type === 'group' || !removed.has(item.id)),
  };
}

/** Appends a new group at the end of the top level; `group.courseIds` are moved into it from wherever they were. */
export function withGroupAppended(layout: LibraryLayout, group: CourseGroup): LibraryLayout {
  const rest = withoutCourses(layout, group.courseIds);
  return { groups: [...rest.groups, { ...group }], order: [...rest.order, { type: 'group', id: group.id }] };
}

/** Moves a course to the end of a group (which must exist). */
export function withCourseInGroup(layout: LibraryLayout, courseId: string, groupId: string): LibraryLayout {
  const rest = withoutCourses(layout, [courseId]);
  return {
    ...rest,
    groups: rest.groups.map((group) => (group.id === groupId ? { ...group, courseIds: [...group.courseIds, courseId] } : group)),
  };
}

/** Removes a group; its courses move to the top level at the group's position, in the group's order. */
export function withoutGroup(layout: LibraryLayout, groupId: string): LibraryLayout {
  const group = layout.groups.find((candidate) => candidate.id === groupId);
  const courses: LayoutItem[] = (group?.courseIds ?? []).map((id) => ({ type: 'course', id }));
  return {
    groups: layout.groups.filter((candidate) => candidate.id !== groupId),
    order: layout.order.flatMap((item) => (item.type === 'group' && item.id === groupId ? courses : [item])),
  };
}
