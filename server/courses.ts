// Courses ("과목" folders, DESIGN §12): an ordered list of lecture documents, e.g. "Compiler" →
// Lec 1, Lec 2, … Stored as library/courses/<courseId>/course.json (CourseRecord) plus a generated
// COURSE.md. The course files are the single source of truth for membership: DocMeta.courseId and
// DocAssets.course are derived from them by library.ts, which also owns the read side.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Course } from '../shared/types.ts';
import { HttpError } from './config.ts';
import type { CourseRecord } from './internal-types.ts';
import {
  courseIdIndex,
  coursePaths,
  coursesDir,
  createKeyedQueue,
  demoteHeadings,
  isDocId,
  readCourseRecord,
  readCourseRecords,
  readDigestRecord,
  readStoredDoc,
  slugify,
  writeFileAtomic,
  writeJsonAtomic,
} from './library.ts';

const MAX_TITLE_CHARS = 100;
const MAX_LECTURES = 500;

/** Every mutation runs through one queue: an update can touch several course files at once. */
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

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, '과목 이름을 입력해 주세요');
  const title = value
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) throw new HttpError(400, '과목 이름을 입력해 주세요');
  if (title.length > MAX_TITLE_CHARS) throw new HttpError(400, `과목 이름이 너무 깁니다 (최대 ${MAX_TITLE_CHARS}자)`);
  return title;
}

function writeRecord(record: CourseRecord): Promise<void> {
  const { id, title, createdAt, docIds } = record;
  return writeJsonAtomic(coursePaths(id).courseJson, { version: 1, id, title, createdAt, docIds } satisfies CourseRecord);
}

/**
 * The course as the API shows it: lectures whose folder no longer exists are left out, and so are
 * lectures that an older course also lists (a data error; the older course wins, as for DocMeta.courseId).
 */
async function toCourse(record: CourseRecord, owners: Map<string, string>): Promise<Course> {
  const present = await Promise.all(
    record.docIds.map(async (docId) => owners.get(docId) === record.id && (await readStoredDoc(docId)) !== null),
  );
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    docIds: record.docIds.filter((_, i) => present[i]),
  };
}

/** Validates UpdateCourseRequest.docIds: an array of distinct ids of existing documents. */
async function validateDocIds(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, 'docIds는 문서 id 목록이어야 합니다');
  }
  const docIds = value as string[];
  if (docIds.length > MAX_LECTURES) throw new HttpError(400, `강의가 너무 많습니다 (최대 ${MAX_LECTURES}개)`);
  const seen = new Set<string>();
  for (const docId of docIds) {
    if (seen.has(docId)) throw new HttpError(400, `같은 문서가 두 번 들어 있습니다: ${docId}`);
    seen.add(docId);
  }
  const exists = await Promise.all(docIds.map(async (docId) => isDocId(docId) && (await readStoredDoc(docId)) !== null));
  const unknown = docIds.filter((_, i) => !exists[i]);
  if (unknown.length > 0) throw new HttpError(400, `알 수 없는 문서입니다: ${unknown.join(', ')}`);
  return docIds;
}

/** Removes `docIds` from every course except `keepId`. Returns the ids of the courses that changed. */
async function removeFromOtherCourses(docIds: Iterable<string>, keepId: string): Promise<string[]> {
  const moving = new Set(docIds);
  const changed: string[] = [];
  for (const other of await readCourseRecords()) {
    if (other.id === keepId) continue;
    const kept = other.docIds.filter((docId) => !moving.has(docId));
    if (kept.length === other.docIds.length) continue;
    await writeRecord({ ...other, docIds: kept });
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

/** Creates an empty course. Id = slug(title) + '-' + 6 hex; unicode titles are kept as they are. */
export async function createCourse(title: unknown, now: Date = new Date()): Promise<Course> {
  const cleaned = cleanTitle(title);
  const record = await mutationQueue(MUTATIONS, async () => {
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
    const created: CourseRecord = { version: 1, id: courseId, title: cleaned, createdAt: now.toISOString(), docIds: [] };
    await writeRecord(created);
    return created;
  });
  await refreshMarkdown([record.id]);
  return { id: record.id, title: record.title, createdAt: record.createdAt, docIds: [] };
}

export interface CoursePatch {
  title?: unknown;
  docIds?: unknown;
}

/**
 * Renames a course and/or replaces its ordered lecture list (UpdateCourseRequest). Documents
 * newly listed are removed from any other course; documents left out become uncategorized.
 * Throws 404 for an unknown course, 400 for invalid titles, unknown doc ids or duplicates.
 */
export async function updateCourse(courseId: string, patch: CoursePatch): Promise<Course> {
  const title = patch.title === undefined ? undefined : cleanTitle(patch.title);
  const touched = await mutationQueue(MUTATIONS, async () => {
    const record = await readCourseRecord(courseId);
    if (!record) throw new HttpError(404, '과목을 찾을 수 없습니다');
    const next: CourseRecord = { ...record };
    if (title !== undefined) next.title = title;
    let others: string[] = [];
    if (patch.docIds !== undefined) {
      next.docIds = await validateDocIds(patch.docIds);
      others = await removeFromOtherCourses(next.docIds, courseId);
    }
    await writeRecord(next);
    return [courseId, ...others];
  });
  await refreshMarkdown(touched);
  const course = await getCourse(courseId);
  if (!course) throw new HttpError(404, '과목을 찾을 수 없습니다'); // deleted in the meantime
  return course;
}

/** Deletes a course folder (course.json + COURSE.md). Its lectures are kept. False when missing. */
export async function deleteCourse(courseId: string): Promise<boolean> {
  return mutationQueue(MUTATIONS, async () => {
    if (!(await readCourseRecord(courseId))) return false;
    // Through the markdown queue so a pending COURSE.md write cannot recreate files in the folder.
    await markdownQueue(courseId, () => fs.rm(coursePaths(courseId).dir, { recursive: true, force: true }));
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
    if (!record) throw new HttpError(400, '과목을 찾을 수 없습니다');
    const doc = await readStoredDoc(docId);
    if (!doc) throw new HttpError(404, '문서를 찾을 수 없습니다');
    const others = await removeFromOtherCourses([docId], courseId);
    if (record.docIds.includes(docId)) return [courseId, ...others];

    // Lectures whose folder is gone are dropped here; they cannot be ordered by title.
    const lectures = (await Promise.all(record.docIds.map(async (id) => ({ id, meta: await readStoredDoc(id) })))).filter(
      (lecture) => lecture.meta !== null,
    );
    const docIds = lectures.map((lecture) => lecture.id);
    docIds.splice(
      insertionIndex(
        lectures.map((lecture) => lecture.meta?.title ?? ''),
        doc.title,
      ),
      0,
      docId,
    );
    await writeRecord({ ...record, docIds });
    return [courseId, ...others];
  });
  await refreshMarkdown(touched);
  const course = await getCourse(courseId);
  if (!course) throw new HttpError(400, '과목을 찾을 수 없습니다');
  return course;
}

// ---------------------------------------------------------------------------
// COURSE.md
// ---------------------------------------------------------------------------

export interface CourseMarkdownLecture {
  docId: string;
  title: string;
  summary: string | null;
}

/** `# <course title> — 과목 정리`, then per lecture `## k. <title>`, its summary and links (DESIGN §12). */
export function courseMarkdown(title: string, lectures: CourseMarkdownLecture[]): string {
  const lines: string[] = [`# ${title} — 과목 정리`, ''];
  if (lectures.length === 0) lines.push('_(아직 강의가 없습니다)_', '');
  lectures.forEach((lecture, i) => {
    lines.push(
      `## ${i + 1}. ${lecture.title}`,
      '',
      lecture.summary?.trim() ? demoteHeadings(lecture.summary.trim(), 2) : '_(정리본 없음)_',
      '',
      `[DIGEST.md](../../${lecture.docId}/DIGEST.md) · [STUDY_NOTES.md](../../${lecture.docId}/STUDY_NOTES.md)`,
      '',
    );
  });
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
    await writeFileAtomic(coursePaths(courseId).courseMd, courseMarkdown(course.title, lectures));
  });
}
