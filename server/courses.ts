// Courses ("과목" folders, DESIGN §12): an ordered list of lecture documents, e.g. "Compiler" →
// Lec 1, Lec 2, … Stored as library/courses/<courseId>/course.json (CourseRecord) plus a generated
// COURSE.md. The course files are the single source of truth for membership: DocMeta.courseId and
// DocAssets.course are derived from them by library.ts, which also owns the read side.
//
// The arrangement of the courses (groups of courses and the top-level order, DESIGN §18) lives in
// library/layout.json, written here too so that it is serialized with the course mutations (creating a course
// inside a group, deleting a course). It never affects lecture membership, COURSE.md or what the LLM sees.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_UNITS, normalizeUnits, sameUnits, unitsByMembership } from '../shared/courseUnits.ts';
import type { Course, CourseGroup, CourseUnit, LibraryLayout } from '../shared/types.ts';
import { COURSE_ID_RE, UNIT_ID_RE } from '../shared/types.ts';
import { HttpError, libraryDir } from './config.ts';
import { slang, smsg } from './i18n.ts';
import type { Lang } from './i18n.ts';
import type { CourseRecord, LayoutRecord } from './internal-types.ts';
import {
  normalizeLayout,
  validateGroupCourseIds,
  validateLayoutRequest,
  withCourseInGroup,
  withGroupAppended,
  withoutGroup,
} from './layout.ts';
import {
  courseIdIndex,
  coursePaths,
  coursesDir,
  createKeyedQueue,
  demoteHeadings,
  isDocId,
  mkdirWithRetry,
  readCourseRecord,
  readCourseRecords,
  readDigestRecord,
  readJsonFile,
  readStoredDoc,
  rmWithRetry,
  slugify,
  writeFileAtomic,
  writeJsonAtomic,
} from './library.ts';

/** Longest course or group title (after trimming); the web inputs use the same limit. */
const MAX_TITLE_CHARS = 120;
const MAX_LECTURES = 500;

/** library/layout.json: groups of courses and the top-level order (DESIGN §18). */
export const LAYOUT_FILE_NAME = 'layout.json';

/**
 * Every mutation runs through one queue: an update can touch several course files at once, and the layout
 * (library/layout.json) is read-modify-written by course and group mutations alike.
 */
const mutationQueue = createKeyedQueue();
const MUTATIONS = 'courses';
/** Serializes COURSE.md regeneration (and the removal of the folder) per course. */
const markdownQueue = createKeyedQueue();

/** Natural, numeric-aware title order: "Lec 2" < "Lec 10", "L7-Parsing" < "L8-Semantics". */
const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareTitles(a: string, b: string): number {
  return naturalOrder.compare(a, b);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A course, group or unit title: one line, trimmed, 1–MAX_TITLE_CHARS characters (400 otherwise). */
function cleanTitle(value: unknown, kind: 'course' | 'group' | 'unit' = 'course'): string {
  const m = smsg().library.courses;
  if (typeof value !== 'string') throw new HttpError(400, m.nameRequired[kind]);
  const title = value
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) throw new HttpError(400, m.nameRequired[kind]);
  if (title.length > MAX_TITLE_CHARS) throw new HttpError(400, m.nameTooLong[kind](MAX_TITLE_CHARS));
  return title;
}

function writeRecord(record: CourseRecord): Promise<void> {
  const { id, title, createdAt, docIds, units } = record;
  // `units` only when there are some: the files of courses without units stay as they were before units.
  const file = { version: 1, id, title, createdAt, docIds, ...(units.length > 0 ? { units } : {}) };
  return writeJsonAtomic(coursePaths(id).courseJson, file);
}

/**
 * The course as the API shows it: lectures whose folder no longer exists are left out, and so are
 * lectures that an older course also lists (a data error; the older course wins, as for DocMeta.courseId).
 */
async function toCourse(record: CourseRecord, owners: Map<string, string>): Promise<Course> {
  const present = await Promise.all(
    record.docIds.map(async (docId) => owners.get(docId) === record.id && (await readStoredDoc(docId)) !== null),
  );
  const shown = new Set(record.docIds.filter((_, i) => present[i]));
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    docIds: record.docIds.filter((docId) => shown.has(docId)),
    units: record.units.map((unit) => ({ ...unit, docIds: unit.docIds.filter((docId) => shown.has(docId)) })),
  };
}

/** Validates UpdateCourseRequest.docIds: an array of distinct ids of existing documents. */
async function validateDocIds(value: unknown): Promise<string[]> {
  const m = smsg().library.courses;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, m.docIdsInvalid);
  }
  const docIds = value as string[];
  if (docIds.length > MAX_LECTURES) throw new HttpError(400, m.tooManyLectures(MAX_LECTURES));
  const seen = new Set<string>();
  for (const docId of docIds) {
    if (seen.has(docId)) throw new HttpError(400, m.duplicateDoc(docId));
    seen.add(docId);
  }
  const exists = await Promise.all(docIds.map(async (docId) => isDocId(docId) && (await readStoredDoc(docId)) !== null));
  const unknown = docIds.filter((_, i) => !exists[i]);
  if (unknown.length > 0) throw new HttpError(400, m.unknownDocs(unknown));
  return docIds;
}

/**
 * Validates UpdateCourseRequest.units against the course's lectures `docIds`: at most MAX_UNITS units with distinct
 * ids (UNIT_ID_RE) and titles, listing lectures of the course, each at most once. Returns them in normal form with
 * the lecture list (shared/courseUnits.ts).
 */
function validateUnits(value: unknown, docIds: readonly string[]): { docIds: string[]; units: CourseUnit[] } {
  const m = smsg().library.courses;
  if (!Array.isArray(value)) throw new HttpError(400, m.unitsInvalid);
  if (value.length > MAX_UNITS) throw new HttpError(400, m.tooManyUnits(MAX_UNITS));
  const inCourse = new Set(docIds);
  const ids = new Set<string>();
  const listed = new Set<string>();
  const units = value.map((item: unknown): CourseUnit => {
    if (typeof item !== 'object' || item === null) throw new HttpError(400, m.unitsInvalid);
    const raw = item as Partial<Record<keyof CourseUnit, unknown>>;
    if (typeof raw.id !== 'string' || !UNIT_ID_RE.test(raw.id)) throw new HttpError(400, m.unitsInvalid);
    if (ids.has(raw.id)) throw new HttpError(400, m.duplicateUnit(raw.id));
    ids.add(raw.id);
    const title = cleanTitle(raw.title, 'unit');
    if (!Array.isArray(raw.docIds) || raw.docIds.some((id) => typeof id !== 'string')) throw new HttpError(400, m.unitsInvalid);
    for (const docId of raw.docIds as string[]) {
      if (!inCourse.has(docId)) throw new HttpError(400, m.unitDocNotInCourse(docId));
      if (listed.has(docId)) throw new HttpError(400, m.duplicateDoc(docId));
      listed.add(docId);
    }
    return { id: raw.id, title, docIds: raw.docIds as string[] };
  });
  return normalizeUnits(docIds, units);
}

/** Removes `docIds` from every course except `keepId` (and from its units). Returns the ids of the courses that changed. */
async function removeFromOtherCourses(docIds: Iterable<string>, keepId: string): Promise<string[]> {
  const moving = new Set(docIds);
  const changed: string[] = [];
  for (const other of await readCourseRecords()) {
    if (other.id === keepId) continue;
    const kept = other.docIds.filter((docId) => !moving.has(docId));
    if (kept.length === other.docIds.length) continue;
    await writeRecord({ ...other, ...unitsByMembership(kept, other.units) });
    changed.push(other.id);
  }
  return changed;
}

/**
 * Where a new lecture titled `title` goes among lectures titled `titles` (in course order):
 * its natural-sort position when the course is in natural order (so "L8…" lands after "L7…"),
 * the end otherwise (a hand-made order is left alone).
 */
export function insertionIndex(titles: string[], title: string): number {
  for (let i = 1; i < titles.length; i++) {
    if (compareTitles(titles[i - 1], titles[i]) > 0) return titles.length;
  }
  const index = titles.findIndex((existing) => compareTitles(title, existing) < 0);
  return index === -1 ? titles.length : index;
}

/** Regenerates COURSE.md of several courses; failures are logged, never thrown. */
async function refreshMarkdown(courseIds: Iterable<string>): Promise<void> {
  for (const courseId of new Set(courseIds)) {
    await writeCourseMarkdown(courseId).catch((err: unknown) => {
      console.error(`[courses] could not write COURSE.md of ${courseId}:`, err);
    });
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** All courses, oldest first. */
export async function listCourses(): Promise<Course[]> {
  const records = await readCourseRecords();
  const owners = courseIdIndex(records);
  return Promise.all(records.map((record) => toCourse(record, owners)));
}

/** A course, or null when the id is invalid or the course does not exist. */
export async function getCourse(courseId: string): Promise<Course | null> {
  const records = await readCourseRecords();
  const record = records.find((candidate) => candidate.id === courseId);
  return record ? toCourse(record, courseIdIndex(records)) : null;
}

/** The course a document belongs to (the oldest one if several list it), or null. */
export async function courseOf(docId: string): Promise<Course | null> {
  const records = await readCourseRecords();
  const owners = courseIdIndex(records);
  const record = records.find((candidate) => candidate.id === owners.get(docId));
  return record ? toCourse(record, owners) : null;
}

// ---------------------------------------------------------------------------
// Mutations (serialized)
// ---------------------------------------------------------------------------

/**
 * Creates an empty course. Id = slug(title) + '-' + 6 hex; unicode titles are kept as they are. With a
 * `groupId` (CreateCourseRequest.groupId) the course goes to the end of that group (400 when there is no such
 * group), otherwise it shows at the end of the top level.
 */
export async function createCourse(title: unknown, now: Date = new Date(), groupId: unknown = undefined): Promise<Course> {
  const cleaned = cleanTitle(title);
  const targetGroup = cleanGroupId(groupId);
  const record = await mutationQueue(MUTATIONS, async () => {
    // The group is checked before anything is written. Without one, nothing is written to the layout: a course
    // that the layout does not mention is shown at the end of the top level.
    const layout = targetGroup === null ? null : await currentLayout();
    if (layout && !layout.groups.some((group) => group.id === targetGroup)) {
      throw new HttpError(400, smsg().library.courses.groupNotFoundId(String(targetGroup)));
    }
    await fs.mkdir(coursesDir(), { recursive: true });
    const slug = slugify(cleaned, 'course');
    let courseId = '';
    for (let attempt = 0; !courseId; attempt++) {
      const candidate = `${slug}-${randomBytes(3).toString('hex')}`;
      try {
        await fs.mkdir(coursePaths(candidate).dir);
        courseId = candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 10) throw err;
      }
    }
    const created: CourseRecord = { version: 1, id: courseId, title: cleaned, createdAt: now.toISOString(), docIds: [], units: [] };
    try {
      await writeRecord(created);
      if (layout && targetGroup !== null) await writeLayout(withCourseInGroup(layout, courseId, targetGroup));
    } catch (err) {
      // No half-made course (e.g. one that should be in a group but shows at the top level).
      await rmWithRetry(coursePaths(courseId).dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return created;
  });
  await refreshMarkdown([record.id]);
  return { id: record.id, title: record.title, createdAt: record.createdAt, docIds: [], units: [] };
}

export interface CoursePatch {
  title?: unknown;
  docIds?: unknown;
  baseDocIds?: unknown;
  units?: unknown;
  baseUnits?: unknown;
}

/** UpdateCourseRequest.baseDocIds: absent (undefined) = no precondition, otherwise a list of ids (400 else). */
function cleanBaseDocIds(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, smsg().library.courses.baseDocIdsInvalid);
  }
  return value as string[];
}

/** UpdateCourseRequest.baseUnits: absent = no precondition, otherwise units (400 when malformed). */
function cleanBaseUnits(value: unknown): CourseUnit[] | null {
  if (value === undefined) return null;
  const bad = () => new HttpError(400, smsg().library.courses.baseUnitsInvalid);
  if (!Array.isArray(value)) throw bad();
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw bad();
    const raw = item as Partial<Record<keyof CourseUnit, unknown>>;
    if (typeof raw.id !== 'string' || typeof raw.title !== 'string') throw bad();
    if (!Array.isArray(raw.docIds) || raw.docIds.some((id) => typeof id !== 'string')) throw bad();
    return { id: raw.id, title: raw.title, docIds: raw.docIds as string[] };
  });
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Renames a course and/or replaces its ordered lecture list and/or its units (UpdateCourseRequest). Documents
 * newly listed are removed from any other course; documents left out become uncategorized.
 * With `baseDocIds` (`baseUnits`) the course's lecture list (units) as the API shows it must still be that: 409
 * otherwise (it was changed in another tab or on another device, and this request would silently undo that).
 * Throws 404 for an unknown course, 400 for invalid titles, unknown doc ids, duplicates or invalid units.
 */
export async function updateCourse(courseId: string, patch: CoursePatch): Promise<Course> {
  const title = patch.title === undefined ? undefined : cleanTitle(patch.title);
  const base = cleanBaseDocIds(patch.baseDocIds);
  const baseUnits = cleanBaseUnits(patch.baseUnits);
  const touched = await mutationQueue(MUTATIONS, async () => {
    const records = await readCourseRecords();
    const record = records.find((candidate) => candidate.id === courseId);
    if (!record) throw new HttpError(404, smsg().common.notFound.course);
    if (base || baseUnits) {
      const shown = await toCourse(record, courseIdIndex(records));
      if ((base && !sameIds(shown.docIds, base)) || (baseUnits && !sameUnits(shown.units, baseUnits))) {
        throw new HttpError(409, smsg().library.courses.lecturesChanged);
      }
    }
    const next: CourseRecord = { ...record };
    if (title !== undefined) next.title = title;
    let others: string[] = [];
    if (patch.docIds !== undefined) next.docIds = await validateDocIds(patch.docIds);
    if (patch.units !== undefined) Object.assign(next, validateUnits(patch.units, next.docIds));
    else if (patch.docIds !== undefined) Object.assign(next, unitsByMembership(next.docIds, record.units));
    if (patch.docIds !== undefined) others = await removeFromOtherCourses(next.docIds, courseId);
    await writeRecord(next);
    return [courseId, ...others];
  });
  await refreshMarkdown(touched);
  const course = await getCourse(courseId);
  if (!course) throw new HttpError(404, smsg().common.notFound.course); // deleted in the meantime
  return course;
}

/**
 * Deletes a course folder (course.json + COURSE.md) and takes the course out of the layout. Its lectures are
 * kept. False when missing.
 */
export async function deleteCourse(courseId: string): Promise<boolean> {
  return mutationQueue(MUTATIONS, async () => {
    if (!(await readCourseRecord(courseId))) return false;
    // Through the markdown queue so a pending COURSE.md write cannot recreate files in the folder.
    await markdownQueue(courseId, () => rmWithRetry(coursePaths(courseId).dir, { recursive: true, force: true }));
    // Rewritten without the course (the normalisation drops it); no layout.json yet = nothing to clean up.
    // The course is gone either way: reads drop unknown ids, so a failure here is only logged.
    try {
      const stored = await readStoredLayout();
      if (stored !== null) await writeLayout(normalizeLayout(stored, await courseIdsOldestFirst()));
    } catch (err) {
      console.error(`[courses] could not remove ${courseId} from ${LAYOUT_FILE_NAME}:`, err);
    }
    return true;
  });
}

/**
 * Adds a (typically freshly uploaded) document to a course at its natural-sort position (see
 * insertionIndex) and removes it from any other course. Throws 400 when the course does not exist.
 */
export async function addDocToCourse(courseId: string, docId: string): Promise<Course> {
  const touched = await mutationQueue(MUTATIONS, async () => {
    const record = await readCourseRecord(courseId);
    if (!record) throw new HttpError(400, smsg().common.notFound.course);
    const doc = await readStoredDoc(docId);
    if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
    const others = await removeFromOtherCourses([docId], courseId);
    if (record.docIds.includes(docId)) return [courseId, ...others];

    // Lectures whose folder is gone are dropped here; they cannot be ordered by title.
    const lectures = (await Promise.all(record.docIds.map(async (id) => ({ id, meta: await readStoredDoc(id) })))).filter(
      (lecture) => lecture.meta !== null,
    );
    const docIds = lectures.map((lecture) => lecture.id);
    const at = insertionIndex(
      lectures.map((lecture) => lecture.meta?.title ?? ''),
      doc.title,
    );
    docIds.splice(at, 0, docId);
    await writeRecord({ ...record, ...withLectureInUnit(docIds, unitsByMembership(docIds, record.units).units, at) });
    return [courseId, ...others];
  });
  await refreshMarkdown(touched);
  const course = await getCourse(courseId);
  if (!course) throw new HttpError(400, smsg().common.notFound.course);
  return course;
}

/**
 * The units after a lecture was inserted at `docIds[at]`: it joins the unit of the lecture before it (none: loose), at
 * the end of the list the last unit (an empty one too: "the end of the course"), at the start the unit of the lecture
 * after it.
 */
export function withLectureInUnit(docIds: readonly string[], units: readonly CourseUnit[], at: number): { docIds: string[]; units: CourseUnit[] } {
  const docId = docIds[at];
  const unitOfDoc = (id: string | undefined) => (id === undefined ? undefined : units.find((unit) => unit.docIds.includes(id)));
  const target = at === docIds.length - 1 ? units.at(-1) : at > 0 ? unitOfDoc(docIds[at - 1]) : unitOfDoc(docIds[at + 1]);
  if (!target) return normalizeUnits(docIds, units);
  const position = new Map(docIds.map((id, i) => [id, i]));
  const placed = units.map((unit) =>
    unit.id === target.id
      ? { ...unit, docIds: [...unit.docIds, docId].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)) }
      : unit,
  );
  return normalizeUnits(docIds, placed);
}

/**
 * Takes a (deleted) document out of every course that lists it and regenerates their COURSE.md.
 * Returns the ids of the courses that changed.
 */
export async function removeDocFromCourses(docId: string): Promise<string[]> {
  const touched = await mutationQueue(MUTATIONS, () => removeFromOtherCourses([docId], ''));
  await refreshMarkdown(touched);
  return touched;
}

// ---------------------------------------------------------------------------
// Layout: groups of courses and the top-level order (DESIGN §18)
// ---------------------------------------------------------------------------

export function layoutFile(): string {
  return path.join(libraryDir(), LAYOUT_FILE_NAME);
}

/** What library/layout.json holds, or null when it is missing or unreadable (normalizeLayout decides the rest). */
function readStoredLayout(): Promise<unknown> {
  return readJsonFile<unknown>(layoutFile());
}

async function courseIdsOldestFirst(): Promise<string[]> {
  return (await readCourseRecords()).map((record) => record.id);
}

/** The normalised layout of the courses that exist now. Callers hold the mutation queue. */
async function currentLayout(): Promise<LibraryLayout> {
  const [stored, courseIds] = await Promise.all([readStoredLayout(), courseIdsOldestFirst()]);
  return normalizeLayout(stored, courseIds);
}

async function writeLayout(layout: LibraryLayout): Promise<void> {
  await mkdirWithRetry(libraryDir());
  await writeJsonAtomic(layoutFile(), { version: 2, groups: layout.groups, order: layout.order } satisfies LayoutRecord);
}

/**
 * CreateCourseRequest.groupId / CreateGroupRequest.parentId: absent (undefined, null, '') = top level; otherwise a
 * group id (400 when malformed).
 */
function cleanGroupId(value: unknown, field: 'groupId' | 'parentId' = 'groupId'): string | null {
  if (value === undefined || value === null || value === '') return null;
  const m = smsg().library.courses;
  if (typeof value !== 'string') throw new HttpError(400, field === 'groupId' ? m.groupIdInvalid : m.parentIdInvalid);
  if (!COURSE_ID_RE.test(value)) throw new HttpError(400, smsg().common.notFound.group);
  return value;
}

/**
 * GET /api/layout: every existing course exactly once (in a group or at the top level), every group once.
 * Read through the mutation queue so that it never shows half of a mutation. Never writes.
 */
export function getLayout(): Promise<LibraryLayout> {
  return mutationQueue(MUTATIONS, currentLayout);
}

/**
 * PUT /api/layout (PutLayoutRequest): replaces the whole arrangement. 400 when an id is unknown or listed twice,
 * or when an existing course or group is missing (see validateLayoutRequest); nothing is written then.
 */
export function putLayout(body: unknown): Promise<LibraryLayout> {
  return mutationQueue(MUTATIONS, async () => {
    const [stored, courseIds] = await Promise.all([readStoredLayout(), courseIdsOldestFirst()]);
    const next = validateLayoutRequest(body, normalizeLayout(stored, courseIds), courseIds);
    await writeLayout(next);
    return next;
  });
}

/**
 * Creates a group (CreateGroupRequest) at the end of the top level, or with `parentId` at the end of that group.
 * Listed courses move into it, in the given order, from wherever they were. Id = slug(title) + '-' + 6 hex
 * (COURSE_ID_RE), never the id of another group or of a course. 400 for a bad title, unknown or duplicated course
 * ids, or an unknown parent group.
 */
export async function createGroup(
  title: unknown,
  courseIds: unknown = undefined,
  now: Date = new Date(),
  parentId: unknown = undefined,
): Promise<CourseGroup> {
  const cleaned = cleanTitle(title, 'group');
  const parent = cleanGroupId(parentId, 'parentId');
  return mutationQueue(MUTATIONS, async () => {
    const [stored, existing] = await Promise.all([readStoredLayout(), courseIdsOldestFirst()]);
    const moving = validateGroupCourseIds(courseIds, existing);
    const layout = normalizeLayout(stored, existing);
    if (parent !== null && !layout.groups.some((group) => group.id === parent)) {
      throw new HttpError(400, smsg().library.courses.groupNotFoundId(parent));
    }
    const taken = new Set([...existing, ...layout.groups.map((group) => group.id)]);
    const slug = slugify(cleaned, 'group');
    let id = '';
    for (let attempt = 0; !id; attempt++) {
      const candidate = `${slug}-${randomBytes(3).toString('hex')}`;
      if (!taken.has(candidate)) id = candidate;
      else if (attempt >= 10) throw new Error('could not find a free group id');
    }
    const group: CourseGroup = { id, title: cleaned, createdAt: now.toISOString(), items: moving.map((courseId) => ({ type: 'course', id: courseId })) };
    await writeLayout(withGroupAppended(layout, group, parent));
    return group;
  });
}

export interface GroupPatch {
  title?: unknown;
}

/** Renames a group (UpdateGroupRequest). 404 for an unknown group, 400 for a bad title. */
export async function updateGroup(groupId: string, patch: GroupPatch): Promise<CourseGroup> {
  const title = cleanTitle(patch.title, 'group');
  return mutationQueue(MUTATIONS, async () => {
    const layout = await currentLayout();
    const group = layout.groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new HttpError(404, smsg().common.notFound.group);
    const renamed: CourseGroup = { ...group, title };
    await writeLayout({ ...layout, groups: layout.groups.map((candidate) => (candidate.id === groupId ? renamed : candidate)) });
    return renamed;
  });
}

/**
 * Deletes a group: its courses move to the top level at the group's position (courses and lectures are never
 * deleted with it). False when there is no such group.
 */
export async function deleteGroup(groupId: string): Promise<boolean> {
  return mutationQueue(MUTATIONS, async () => {
    const layout = await currentLayout();
    if (!layout.groups.some((group) => group.id === groupId)) return false;
    await writeLayout(withoutGroup(layout, groupId));
    return true;
  });
}

// ---------------------------------------------------------------------------
// COURSE.md
// ---------------------------------------------------------------------------

export interface CourseMarkdownLecture {
  docId: string;
  title: string;
  summary: string | null;
}

/**
 * `# <course title> — 과목 정리`, then per lecture `## k. <title>`, its summary and links (DESIGN §12). With units
 * (in normal form with `lectures`), each unit is a `## <unit title>` before its lectures, which become `### k. …`
 * (numbered through the course). The headings are in `lang`: the language of the request that changed the course
 * (DESIGN §27).
 */
export function courseMarkdown(
  title: string,
  lectures: CourseMarkdownLecture[],
  lang: Lang = slang(),
  units: readonly Pick<CourseUnit, 'title' | 'docIds'>[] = [],
): string {
  const m = smsg(lang).library.courseMd;
  const lines: string[] = [`# ${m.title(title)}`, ''];
  if (lectures.length === 0 && units.length === 0) lines.push(`_(${m.noLectures})_`, '');
  const level = units.length > 0 ? 3 : 2;
  const write = (lecture: CourseMarkdownLecture) => {
    lines.push(
      `${'#'.repeat(level)} ${lectures.indexOf(lecture) + 1}. ${lecture.title}`,
      '',
      lecture.summary?.trim() ? demoteHeadings(lecture.summary.trim(), level) : `_(${m.noDigest})_`,
      '',
      `[DIGEST.md](../../${lecture.docId}/DIGEST.md) · [STUDY_NOTES.md](../../${lecture.docId}/STUDY_NOTES.md)`,
      '',
    );
  };
  const inUnits = new Set(units.flatMap((unit) => unit.docIds));
  lectures.filter((lecture) => !inUnits.has(lecture.docId)).forEach(write);
  for (const unit of units) {
    lines.push(`## ${unit.title}`, '');
    const own = lectures.filter((lecture) => unit.docIds.includes(lecture.docId));
    if (own.length === 0) lines.push(`_(${m.noLectures})_`, '');
    own.forEach(write);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Regenerates library/courses/<courseId>/COURSE.md (no-op when the course does not exist). */
export function writeCourseMarkdown(courseId: string): Promise<void> {
  return markdownQueue(courseId, async () => {
    const records = await readCourseRecords();
    const record = records.find((candidate) => candidate.id === courseId);
    if (!record) return;
    const course = await toCourse(record, courseIdIndex(records));
    const lectures = await Promise.all(
      course.docIds.map(async (docId): Promise<CourseMarkdownLecture> => {
        const [doc, digest] = await Promise.all([readStoredDoc(docId), readDigestRecord(docId)]);
        return { docId, title: doc?.title ?? docId, summary: digest?.summary ?? null };
      }),
    );
    await writeFileAtomic(coursePaths(courseId).courseMd, courseMarkdown(course.title, lectures, slang(), course.units));
  });
}
