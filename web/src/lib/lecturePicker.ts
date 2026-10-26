// The top bar's lecture picker (DESIGN §13, 0.6.14): the lectures grouped by course in library order, a search over the
// lecture and course names, the course neighbours of the open lecture (‹ ›), and the lectures opened last on this
// device. Pure: the component (components/LecturePicker.tsx) renders it.
import type { Course, DocMeta, LibraryLayout } from '../../../shared/types.ts';
import { courseLabel, layoutEntries } from './libraryLayout.ts';

export interface PickerCourse {
  id: string;
  /** "그룹 › 과목" for a grouped course. */
  label: string;
  lectures: DocMeta[];
}

export interface PickerModel {
  courses: PickerCourse[];
  /** Lectures in no course (all of them when there are no courses). */
  uncategorized: DocMeta[];
  /** Where a lecture sits: its course and its 1-based place in it (absent: uncategorized). */
  place: Map<string, { course: PickerCourse; index: number }>;
}

/**
 * The courses in library order with their lectures in course order (a lecture listed by two courses — a data error —
 * shows under the first one created), then the lectures in no course.
 */
export function pickerModel(docs: readonly DocMeta[], courses: readonly Course[], layout: LibraryLayout): PickerModel {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const owner = new Map<string, string>();
  for (const course of courses) for (const id of course.docIds) if (!owner.has(id)) owner.set(id, course.id);
  const place = new Map<string, { course: PickerCourse; index: number }>();
  const shown: PickerCourse[] = layoutEntries(layout, courses).map((entry) => {
    const lectures = entry.course.docIds
      .filter((id) => owner.get(id) === entry.course.id)
      .map((id) => byId.get(id))
      .filter((d): d is DocMeta => d !== undefined);
    const course: PickerCourse = { id: entry.course.id, label: courseLabel(entry), lectures };
    lectures.forEach((d, i) => place.set(d.id, { course, index: i + 1 }));
    return course;
  });
  return { courses: shown, uncategorized: docs.filter((d) => !place.has(d.id)), place };
}

export interface Neighbours {
  course: PickerCourse;
  /** 1-based place of the lecture in its course. */
  index: number;
  total: number;
  prev: DocMeta | null;
  next: DocMeta | null;
}

/** The lecture's course and the lectures before and after it there (null: in no course). */
export function neighbours(model: PickerModel, docId: string): Neighbours | null {
  const at = model.place.get(docId);
  if (!at) return null;
  const { lectures } = at.course;
  return {
    course: at.course,
    index: at.index,
    total: lectures.length,
    prev: lectures[at.index - 2] ?? null,
    next: lectures[at.index] ?? null,
  };
}

/** A lecture title often starts with its own number ("1. Introduction", "L5-Parsing"): no course number before it. */
export const titleHasNumber = (title: string): boolean => /^\s*[A-Za-z]{0,3}\d+(?:[.\-_):\s]|$)/.test(title);

/** For matching: case and width folded, spaces collapsed. */
const fold = (s: string): string => s.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');

export interface LectureMatch {
  doc: DocMeta;
  course: PickerCourse | null;
  /** [start, end) ranges of the title to highlight. */
  ranges: Array<[number, number]>;
}

/**
 * The lectures whose title or course name contains every word of the query (any order, case-insensitive): those
 * whose title starts with the query first, then the title matches, then the course-only matches; library order within.
 */
export function searchLectures(model: PickerModel, query: string): LectureMatch[] {
  const words = fold(query).trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const all: Array<{ doc: DocMeta; course: PickerCourse | null }> = [
    ...model.courses.flatMap((course) => course.lectures.map((doc) => ({ doc, course }))),
    ...model.uncategorized.map((doc) => ({ doc, course: null })),
  ];
  const whole = fold(query).trim();
  const ranked: Array<LectureMatch & { rank: number; order: number }> = [];
  all.forEach(({ doc, course }, order) => {
    const title = fold(doc.title);
    const where = fold(course?.label ?? '');
    if (!words.every((w) => title.includes(w) || where.includes(w))) return;
    const ranges = mergeRanges(words.flatMap((w) => occurrences(title, w)));
    const rank = title.startsWith(whole) ? 0 : ranges.length > 0 ? 1 : 2;
    ranked.push({ doc, course, ranges, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.map(({ doc, course, ranges }) => ({ doc, course, ranges }));
}

/** Every [start, end) of `word` in `text` (folded text keeps the title's length for Latin and Hangul). */
function occurrences(text: string, word: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) out.push([i, i + word.length]);
  return out;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The title cut into plain and highlighted parts (ranges from searchLectures). */
export function highlightParts(title: string, ranges: ReadonlyArray<[number, number]>): Array<{ text: string; hit: boolean }> {
  // Folding can change the length (e.g. a compatibility character): then nothing is highlighted rather than the wrong part.
  if (fold(title).length !== title.length) return [{ text: title, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: title.slice(at, start), hit: false });
    parts.push({ text: title.slice(start, end), hit: true });
    at = end;
  }
  if (at < title.length) parts.push({ text: title.slice(at), hit: false });
  return parts;
}

/** The lectures opened last on this device, newest first. */
export const MAX_RECENT_DOCS = 8;

/** `id` opened: to the front, once, at most MAX_RECENT_DOCS. */
export function pushRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, MAX_RECENT_DOCS);
}

/** The recent lectures that still exist, at most `n`. */
export function recentLectures(recent: readonly string[], docs: readonly DocMeta[], n = 3): DocMeta[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  return recent
    .map((id) => byId.get(id))
    .filter((d): d is DocMeta => d !== undefined)
    .slice(0, n);
}
