// Units (단원) of a course (DESIGN §18): named, collapsible sections of its lecture list. Shared by the server (what
// it stores and checks) and the web client (optimistic changes, drag & drop), so both put lectures in the same place.
//
// A course keeps its full lecture order in Course.docIds; its units list parts of it. In normal form a lecture is in
// at most one unit, units list only lectures of the course, and docIds is the lectures in no unit ("loose", shown
// first without a header), then each unit's lectures in unit order.
import type { CourseUnit } from './types.ts';

/** Most units a course can have. */
export const MAX_UNITS = 100;

export interface UnitsShape {
  docIds: string[];
  units: CourseUnit[];
}

/**
 * The normal form of a lecture list and its units: each unit keeps the lectures of `docIds` it lists, in its own
 * order (a lecture listed by two units stays in the first), and `docIds` becomes the loose lectures (in their
 * order) followed by the units' lectures.
 */
export function normalizeUnits(docIds: readonly string[], units: readonly CourseUnit[]): UnitsShape {
  const inCourse = new Set(docIds);
  const placed = new Set<string>();
  const next = units.map((unit): CourseUnit => {
    const ids: string[] = [];
    for (const id of unit.docIds) {
      if (!inCourse.has(id) || placed.has(id)) continue;
      placed.add(id);
      ids.push(id);
    }
    return { id: unit.id, title: unit.title, docIds: ids };
  });
  const loose = docIds.filter((id) => !placed.has(id));
  return { docIds: [...loose, ...next.flatMap((unit) => unit.docIds)], units: next };
}

/**
 * The units after the lecture list became `docIds` without saying where its lectures go: each unit keeps the
 * lectures it had that are still listed, in the order of `docIds`; lectures new to the course are loose.
 */
export function unitsByMembership(docIds: readonly string[], units: readonly CourseUnit[]): UnitsShape {
  const position = new Map(docIds.map((id, i) => [id, i]));
  const kept = units.map((unit) => ({
    ...unit,
    docIds: unit.docIds.filter((id) => position.has(id)).sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)),
  }));
  return normalizeUnits(docIds, kept);
}

/** The unit a lecture is in (null: in none). */
export function unitOf(units: readonly CourseUnit[], docId: string): CourseUnit | null {
  return units.find((unit) => unit.docIds.includes(docId)) ?? null;
}

/** The lectures in no unit, in order. */
export function looseDocIds(shape: UnitsShape): string[] {
  const inUnits = new Set(shape.units.flatMap((unit) => unit.docIds));
  return shape.docIds.filter((id) => !inUnits.has(id));
}

/** Same units: ids, titles and lectures in the same order. */
export function sameUnits(a: readonly CourseUnit[], b: readonly CourseUnit[]): boolean {
  return (
    a.length === b.length &&
    a.every((unit, i) => {
      const other = b[i];
      return (
        unit.id === other.id &&
        unit.title === other.title &&
        unit.docIds.length === other.docIds.length &&
        unit.docIds.every((id, k) => id === other.docIds[k])
      );
    })
  );
}
