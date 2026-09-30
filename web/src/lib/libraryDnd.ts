// Drag & drop in the library (DESIGN §18), the pure part: what can be dropped where, which droppable a point is
// on, where the dragged item would land (the move, an insertion indicator, a description for screen readers in
// the page's language) and the stops of keyboard dragging. The React side (web/src/components/organize/LibraryDnd.tsx)
// feeds it with @dnd-kit's droppable rects and pointer coordinates.
import type { Course, LayoutItem, LibraryLayout } from '../../../shared/types.ts';
import { msg } from '../i18n/index.ts';
import {
  applyCourseMove,
  applyGroupMove,
  applyLectureMove,
  collapseKey,
  findGroup,
  lectureMovePatch,
  sameLayout,
  type CourseMove,
  type LectureMove,
  type Move,
} from './libraryLayout.ts';

export type DragItem =
  | { kind: 'lecture'; docId: string }
  | { kind: 'course'; courseId: string }
  | { kind: 'group'; groupId: string };

export type DragKind = DragItem['kind'];

/** What a droppable is (its @dnd-kit `data`). Items (lecture/course/group) are also the draggables. */
export type DropData =
  | { role: 'lecture'; docId: string; courseId: string | null }
  | { role: 'course'; courseId: string; groupId: string | null }
  | { role: 'group'; groupId: string }
  /** Header of a course card: a lecture dropped here goes to the start (or, collapsed, the end) of the course. */
  | { role: 'course-head'; courseId: string }
  /** Lecture list of an expanded course (its free space = the end of the course). */
  | { role: 'course-body'; courseId: string }
  /**
   * Header of a group. Courses: its top third = before the group, the rest = into the group. Lectures: only
   * while the group is collapsed, and only to open it (hovering) — releasing there puts the lecture back.
   */
  | { role: 'group-head'; groupId: string }
  /** Course list of an expanded group (its free space = the end of the group). */
  | { role: 'group-body'; groupId: string }
  /** The "미분류" section: lectures dropped here leave their course. */
  | { role: 'uncategorized' }
  /** Below the last top-level item (shown while a course or group is dragged). */
  | { role: 'top-end' };

/** @dnd-kit ids. Item ids double as the keys of insertion indicators. */
export const dndId = {
  lecture: (docId: string) => `lecture:${docId}`,
  course: (courseId: string) => `course:${courseId}`,
  group: (groupId: string) => `group:${groupId}`,
  courseHead: (courseId: string) => `course-head:${courseId}`,
  courseBody: (courseId: string) => `course-body:${courseId}`,
  groupHead: (groupId: string) => `group-head:${groupId}`,
  groupBody: (groupId: string) => `group-body:${groupId}`,
  uncategorized: 'uncategorized',
  topEnd: 'top-end',
};

const layoutItemKey = (item: LayoutItem): string => (item.type === 'group' ? dndId.group(item.id) : dndId.course(item.id));

export function dragItemKey(item: DragItem): string {
  if (item.kind === 'lecture') return dndId.lecture(item.docId);
  return item.kind === 'course' ? dndId.course(item.courseId) : dndId.group(item.groupId);
}

/** The course or group of a collapse key / indicator key ("course:<id>", "group:<id>"), else null. */
export function containerOfKey(key: string): DragItem | null {
  if (key.startsWith('course:')) return { kind: 'course', courseId: key.slice('course:'.length) };
  if (key.startsWith('group:')) return { kind: 'group', groupId: key.slice('group:'.length) };
  return null;
}

/** The draggable item described by an item's data (null for pure drop zones). */
export function dragItemOf(data: DropData | null | undefined): DragItem | null {
  switch (data?.role) {
    case 'lecture':
      return { kind: 'lecture', docId: data.docId };
    case 'course':
      return { kind: 'course', courseId: data.courseId };
    case 'group':
      return { kind: 'group', groupId: data.groupId };
    default:
      return null;
  }
}

/** Whether a droppable takes part while `item` is dragged. */
export function accepts(item: DragItem, data: DropData, view: OrgView): boolean {
  switch (item.kind) {
    case 'lecture':
      return (
        data.role === 'lecture' ||
        data.role === 'course-head' ||
        data.role === 'course-body' ||
        data.role === 'uncategorized' ||
        // A collapsed group hides its courses: hovering over its header opens it.
        (data.role === 'group-head' && view.isCollapsed(collapseKey.group(data.groupId)))
      );
    case 'course':
      return (
        data.role === 'course' || data.role === 'group-head' || data.role === 'group-body' || data.role === 'top-end'
      );
    case 'group':
      return (data.role === 'course' && data.groupId === null) || data.role === 'group' || data.role === 'top-end';
  }
}

export interface OrgView {
  /** Courses in createdAt order (membership/order of lectures). */
  courses: readonly Course[];
  /** Normalised layout. */
  layout: LibraryLayout;
  /** Collapse state as rendered (a container opened by hovering counts as open). */
  isCollapsed: (key: string) => boolean;
}

/** Where the dragged item would land: a line before/after an item, or "into" a container. */
export type Indicator = { type: 'line'; key: string; side: 'before' | 'after' } | { type: 'into'; key: string };

export interface DropTarget {
  /** Identifies the resulting position ('noop' = where the item already is). */
  key: string;
  move: Move | null;
  indicator: Indicator | null;
  /** Hovering here only opens this collapsed group (a lecture over its header); releasing moves nothing. */
  opens?: string;
}

export const NOOP_TARGET: DropTarget = { key: 'noop', move: null, indicator: null };

/** Top third of a group header = before the group (top level); the rest = into the group. */
export const GROUP_HEAD_BEFORE = 1 / 3;

const docIdsOf = (view: OrgView, courseId: string): string[] => view.courses.find((c) => c.id === courseId)?.docIds ?? [];

/** The first element after position `index` that is not `self`. */
function nextOther<T>(list: readonly T[], index: number, isSelf: (x: T) => boolean): T | null {
  for (let i = index + 1; i < list.length; i++) if (!isSelf(list[i])) return list[i];
  return null;
}

function lastOther<T>(list: readonly T[], isSelf: (x: T) => boolean): T | null {
  for (let i = list.length - 1; i >= 0; i--) if (!isSelf(list[i])) return list[i];
  return null;
}

/**
 * Where `item` lands when dropped on `over`; `relY` is the position of the pointer (or, for the keyboard, the
 * dragged item's center) in the droppable, 0 = top edge, 1 = bottom edge. null = `over` does not take `item`.
 */
export function resolveDrop(item: DragItem, over: DropData, relY: number, view: OrgView): DropTarget | null {
  if (!accepts(item, over, view)) return null;
  const upper = relY < 0.5;
  switch (item.kind) {
    case 'lecture': {
      const docId = item.docId;
      const isSelf = (id: string) => id === docId;
      let move: LectureMove;
      if (over.role === 'group-head') {
        const key = dndId.group(over.groupId);
        return { key: `open>${over.groupId}`, move: null, indicator: { type: 'into', key }, opens: over.groupId };
      }
      if (over.role === 'lecture') {
        if (over.courseId === null) move = { kind: 'lecture', docId, courseId: null, beforeDocId: null };
        else {
          if (over.docId === docId) return NOOP_TARGET;
          const list = docIdsOf(view, over.courseId);
          const before = upper ? over.docId : nextOther(list, list.indexOf(over.docId), isSelf);
          move = { kind: 'lecture', docId, courseId: over.courseId, beforeDocId: before };
        }
      } else if (over.role === 'course-head') {
        const collapsed = view.isCollapsed(collapseKey.course(over.courseId));
        const first = docIdsOf(view, over.courseId).find((id) => !isSelf(id)) ?? null;
        move = { kind: 'lecture', docId, courseId: over.courseId, beforeDocId: collapsed ? null : first };
      } else if (over.role === 'course-body') {
        move = { kind: 'lecture', docId, courseId: over.courseId, beforeDocId: null };
      } else {
        move = { kind: 'lecture', docId, courseId: null, beforeDocId: null };
      }
      return finish(move, view);
    }
    case 'course': {
      const courseId = item.courseId;
      const isSelf = (x: LayoutItem) => x.type === 'course' && x.id === courseId;
      let move: CourseMove;
      if (over.role === 'course') {
        if (over.courseId === courseId) return NOOP_TARGET;
        const self: LayoutItem = { type: 'course', id: over.courseId };
        if (over.groupId !== null) {
          const list: LayoutItem[] = (findGroup(view.layout, over.groupId)?.courseIds ?? []).map((id) => ({ type: 'course', id }));
          const i = list.findIndex((x) => x.id === over.courseId);
          move = { kind: 'course', courseId, groupId: over.groupId, before: upper ? self : nextOther(list, i, isSelf) };
        } else {
          const list = view.layout.order;
          const i = list.findIndex((x) => x.type === 'course' && x.id === over.courseId);
          move = { kind: 'course', courseId, groupId: null, before: upper ? self : nextOther(list, i, isSelf) };
        }
      } else if (over.role === 'group-head') {
        if (relY < GROUP_HEAD_BEFORE) {
          move = { kind: 'course', courseId, groupId: null, before: { type: 'group', id: over.groupId } };
        } else {
          const collapsed = view.isCollapsed(collapseKey.group(over.groupId));
          const first = (findGroup(view.layout, over.groupId)?.courseIds ?? []).find((id) => id !== courseId) ?? null;
          const before: LayoutItem | null = !collapsed && first !== null ? { type: 'course', id: first } : null;
          move = { kind: 'course', courseId, groupId: over.groupId, before };
        }
      } else if (over.role === 'group-body') {
        move = { kind: 'course', courseId, groupId: over.groupId, before: null };
      } else {
        move = { kind: 'course', courseId, groupId: null, before: null };
      }
      return finish(move, view);
    }
    case 'group': {
      const groupId = item.groupId;
      const isSelf = (x: LayoutItem) => x.type === 'group' && x.id === groupId;
      let before: LayoutItem | null = null;
      if (over.role === 'course' || over.role === 'group') {
        const self: LayoutItem =
          over.role === 'course' ? { type: 'course', id: over.courseId } : { type: 'group', id: over.groupId };
        if (isSelf(self)) return NOOP_TARGET;
        const list = view.layout.order;
        const i = list.findIndex((x) => x.type === self.type && x.id === self.id);
        before = upper ? self : nextOther(list, i, isSelf);
      }
      return finish({ kind: 'group', groupId, before }, view);
    }
  }
}

/** The target of a move: NOOP_TARGET when it changes nothing. */
function finish(move: Move, view: OrgView): DropTarget {
  switch (move.kind) {
    case 'lecture': {
      if (lectureMovePatch(view.courses, move) === null) return NOOP_TARGET;
      if (move.courseId === null) return { key: 'lecture>-', move, indicator: { type: 'into', key: dndId.uncategorized } };
      const list = applyLectureMove(view.courses, move).find((c) => c.id === move.courseId)?.docIds ?? [];
      const key = `lecture>${move.courseId}>${list.indexOf(move.docId)}`;
      return { key, move, indicator: lectureIndicator(move, move.courseId, view) };
    }
    case 'course': {
      const next = applyCourseMove(view.layout, move);
      if (sameLayout(next, view.layout)) return NOOP_TARGET;
      const self = (x: LayoutItem) => x.type === 'course' && x.id === move.courseId;
      const position =
        move.groupId === null
          ? next.order.findIndex(self)
          : (findGroup(next, move.groupId)?.courseIds.indexOf(move.courseId) ?? -1);
      return { key: `course>${move.groupId ?? '-'}>${position}`, move, indicator: courseIndicator(move, view) };
    }
    case 'group': {
      const next = applyGroupMove(view.layout, move);
      if (sameLayout(next, view.layout)) return NOOP_TARGET;
      const position = next.order.findIndex((x) => x.type === 'group' && x.id === move.groupId);
      const isSelf = (x: LayoutItem) => x.type === 'group' && x.id === move.groupId;
      return { key: `group>${position}`, move, indicator: topIndicator(move.before, view.layout.order, isSelf) };
    }
  }
}

function lectureIndicator(move: LectureMove, courseId: string, view: OrgView): Indicator {
  const into: Indicator = { type: 'into', key: dndId.course(courseId) };
  if (view.isCollapsed(collapseKey.course(courseId))) return into;
  if (move.beforeDocId !== null) return { type: 'line', key: dndId.lecture(move.beforeDocId), side: 'before' };
  const last = lastOther(docIdsOf(view, courseId), (id) => id === move.docId);
  return last === null ? into : { type: 'line', key: dndId.lecture(last), side: 'after' };
}

function courseIndicator(move: CourseMove, view: OrgView): Indicator {
  const isSelf = (x: LayoutItem) => x.type === 'course' && x.id === move.courseId;
  if (move.groupId === null) return topIndicator(move.before, view.layout.order, isSelf);
  const into: Indicator = { type: 'into', key: dndId.group(move.groupId) };
  if (view.isCollapsed(collapseKey.group(move.groupId))) return into;
  if (move.before) return { type: 'line', key: layoutItemKey(move.before), side: 'before' };
  const list: LayoutItem[] = (findGroup(view.layout, move.groupId)?.courseIds ?? []).map((id) => ({ type: 'course', id }));
  const last = lastOther(list, isSelf);
  return last === null ? into : { type: 'line', key: layoutItemKey(last), side: 'after' };
}

function topIndicator(before: LayoutItem | null, order: readonly LayoutItem[], isSelf: (x: LayoutItem) => boolean): Indicator {
  if (before) return { type: 'line', key: layoutItemKey(before), side: 'before' };
  const last = lastOther(order, isSelf);
  return last === null ? { type: 'into', key: dndId.topEnd } : { type: 'line', key: layoutItemKey(last), side: 'after' };
}

/**
 * Where a target puts the item, for screen-reader announcements: "‘Compiler’ 과목의 3번째 자리" and how many
 * items that list then has (null for 미분류 / the original place). Every place ends in a vowel ("…로 옮겼어요").
 */
export function describeTarget(target: DropTarget, view: OrgView): { place: string; total: number | null } {
  const m = msg().shell.dnd.place;
  const move = target.move;
  if (!move && target.opens) {
    const title = findGroup(view.layout, target.opens)?.title ?? m.groupFallback;
    return { place: m.overCollapsedGroup(title), total: null };
  }
  if (!move) return { place: m.original, total: null };
  switch (move.kind) {
    case 'lecture': {
      if (move.courseId === null) return { place: m.uncategorized, total: null };
      const course = applyLectureMove(view.courses, move).find((c) => c.id === move.courseId);
      if (!course) return { place: m.course, total: null };
      return { place: m.inCourse(course.title, course.docIds.indexOf(move.docId) + 1), total: course.docIds.length };
    }
    case 'course': {
      const next = applyCourseMove(view.layout, move);
      if (move.groupId !== null) {
        const group = findGroup(next, move.groupId);
        if (!group) return { place: m.group, total: null };
        return { place: m.inGroup(group.title, group.courseIds.indexOf(move.courseId) + 1), total: group.courseIds.length };
      }
      const i = next.order.findIndex((x) => x.type === 'course' && x.id === move.courseId);
      return { place: m.outsideGroups(i + 1), total: next.order.length };
    }
    case 'group': {
      const next = applyGroupMove(view.layout, move);
      const i = next.order.findIndex((x) => x.type === 'group' && x.id === move.groupId);
      return { place: m.topLevel(i + 1), total: next.order.length };
    }
  }
}

/** "‘Compiler’ 과목의 3번째 자리 (5개 중)". */
export function describePlace(target: DropTarget, view: OrgView): string {
  const { place, total } = describeTarget(target, view);
  return total === null ? place : msg().shell.dnd.place.withTotal(place, total);
}

// ---------------------------------------------------------------------------------------------------------
// Geometry: which droppable a point is on, and the stops of keyboard dragging.
// ---------------------------------------------------------------------------------------------------------

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface DroppableBox {
  id: string;
  data: DropData;
  rect: Box;
}

export interface Point {
  x: number;
  y: number;
}

const contains = (r: Box, p: Point) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

/**
 * The droppable a point is on while `item` is dragged: the innermost accepting droppable that contains it
 * (e.g. a lecture row rather than the course around it); when the point is beside the list, the same at the
 * list's horizontal center; otherwise the vertically nearest one (above/below everything,
 * or in a gap between cards). `relY` is the point's position in it (0 = top, 1 = bottom; outside = <0 / >1).
 */
export function pickDroppable(
  item: DragItem,
  point: Point,
  boxes: readonly DroppableBox[],
  view: OrgView,
): { box: DroppableBox; relY: number } | null {
  const candidates = boxes.filter((b) => b.rect.width > 0 && b.rect.height > 0 && accepts(item, b.data, view));
  if (candidates.length === 0) return null;
  const innermost = (p: Point): DroppableBox | null => {
    let best: DroppableBox | null = null;
    for (const b of candidates) {
      if (contains(b.rect, p) && (!best || b.rect.width * b.rect.height < best.rect.width * best.rect.height)) best = b;
    }
    return best;
  };
  let box = innermost(point);
  if (!box) {
    const left = Math.min(...candidates.map((b) => b.rect.left));
    const right = Math.max(...candidates.map((b) => b.rect.right));
    if (point.x < left || point.x > right) box = innermost({ x: (left + right) / 2, y: point.y });
  }
  if (!box) {
    const area = (b: DroppableBox) => b.rect.width * b.rect.height;
    let bestGap = Infinity;
    for (const b of candidates) {
      const gap = point.y < b.rect.top ? b.rect.top - point.y : point.y > b.rect.bottom ? point.y - b.rect.bottom : 0;
      if (!box || gap < bestGap - 0.5) {
        box = b;
        bestGap = gap;
      } else if (Math.abs(gap - bestGap) <= 0.5 && area(b) < area(box)) {
        box = b;
        bestGap = Math.min(bestGap, gap);
      }
    }
  }
  if (!box) return null;
  return { box, relY: (point.y - box.rect.top) / box.rect.height };
}

/** The drop target at a point (null = nothing takes the item there). */
export function targetAt(item: DragItem, point: Point, boxes: readonly DroppableBox[], view: OrgView): DropTarget | null {
  const picked = pickDroppable(item, point, boxes, view);
  return picked ? resolveDrop(item, picked.box.data, picked.relY, view) : null;
}

/** Heights (viewport y) inside a droppable where keyboard dragging may stop. */
function samplePoints(item: DragItem, data: DropData, rect: Box): number[] {
  switch (data.role) {
    case 'lecture':
    case 'course':
    case 'group':
      return [rect.top + rect.height * 0.25, rect.top + rect.height * 0.75];
    case 'group-head':
      // A lecture waits low in the header: once the group opens, the nearest place is its first course.
      if (item.kind === 'lecture') return [rect.top + rect.height * 0.7];
      return [rect.top + rect.height * (GROUP_HEAD_BEFORE / 2), rect.top + rect.height * 0.7];
    case 'course-body':
    case 'group-body':
      return [rect.bottom - Math.min(3, rect.height / 2)];
    case 'uncategorized':
      return [rect.top + Math.min(12, rect.height / 2)];
    default:
      return [rect.top + rect.height / 2];
  }
}

export interface KeyboardStop {
  /** Where the dragged item's center goes (viewport y). */
  y: number;
  target: DropTarget;
}

/**
 * Every distinct place keyboard dragging can move `item` to, top to bottom: sample points of the accepting
 * droppables resolved like a pointer at (x, y), consecutive points with the same result merged.
 */
export function keyboardStops(item: DragItem, x: number, boxes: readonly DroppableBox[], view: OrgView): KeyboardStop[] {
  const ys = boxes
    .filter((b) => b.rect.height > 0 && accepts(item, b.data, view))
    .flatMap((b) => samplePoints(item, b.data, b.rect))
    .sort((a, b) => a - b);
  const stops: KeyboardStop[] = [];
  for (const y of ys) {
    const target = targetAt(item, { x, y }, boxes, view);
    if (!target) continue;
    if (stops.length > 0 && stops[stops.length - 1].target.key === target.key) continue;
    stops.push({ y, target });
  }
  return stops;
}

/** The next stop below (dir 1) or above (dir -1) the current position that lands somewhere else. */
export function nextStop(stops: readonly KeyboardStop[], currentY: number, currentKey: string, dir: 1 | -1): KeyboardStop | null {
  if (dir === 1) return stops.find((s) => s.y > currentY + 0.5 && s.target.key !== currentKey) ?? null;
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i].y < currentY - 0.5 && stops[i].target.key !== currentKey) return stops[i];
  }
  return null;
}
