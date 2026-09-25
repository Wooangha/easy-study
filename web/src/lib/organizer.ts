// Courses, course groups and their arrangement (DESIGN §12, §18) as a small external store.
//
// Every change goes through one queue: requests reach the server one after another, in the order the user
// made them (a drop made while the previous one is still being saved waits for it). Moves, renames and
// deletions show at once (optimistic): what the library shows is the last state the server confirmed with
// the waiting changes applied on top. A change is turned into its request only when its turn comes, from the
// confirmed state at that moment, so a failed change never drags the ones behind it along: it just drops out
// of the list (= rolled back), a toast says so, and the lists are loaded again.
//
// Other tabs and devices (remote mode) change the same library. A move's request says what it was made from
// (PutLayoutRequest.baseRevision, UpdateCourseRequest.baseDocIds); when the server has something else (409),
// the lists are loaded again and the same move — anchored, so it still means the same place — is made once
// more on top of them, instead of silently undoing the other change.
//
// No DOM or React here (unit-tested with a fake API).
import { layoutRevision } from '../../../shared/layoutRevision.ts';
import type {
  Course,
  CourseGroup,
  CreateCourseRequest,
  CreateGroupRequest,
  LayoutItem,
  LibraryLayout,
  PutLayoutRequest,
  UpdateCourseRequest,
  UpdateGroupRequest,
} from '../../../shared/types.ts';
import {
  applyCourseMove,
  applyCourseUpdate,
  applyGroupMove,
  applyLectureMove,
  EMPTY_LAYOUT,
  findGroup,
  lectureMovePatch,
  normalizeLayout,
  sameLayout,
  toPutLayout,
  withCourseAdded,
  withGroupAppended,
  withGroupTitle,
  withoutCourses,
  withoutGroup,
  type Move,
} from './libraryLayout.ts';

export interface OrganizerApi {
  listCourses(): Promise<Course[]>;
  getLayout(): Promise<LibraryLayout>;
  createCourse(body: CreateCourseRequest): Promise<Course>;
  updateCourse(courseId: string, body: UpdateCourseRequest): Promise<Course>;
  deleteCourse(courseId: string): Promise<void>;
  putLayout(body: PutLayoutRequest): Promise<LibraryLayout>;
  createGroup(body: CreateGroupRequest): Promise<CourseGroup>;
  updateGroup(groupId: string, body: UpdateGroupRequest): Promise<CourseGroup>;
  deleteGroup(groupId: string): Promise<void>;
}

export interface OrganizerDeps {
  api: OrganizerApi;
  /** Shows an error (a toast in the app). */
  notifyError: (message: string) => void;
  /** User-facing text for a thrown value. */
  errorMessage: (e: unknown) => string;
  /** The server refused a change because its data changed in the meantime (HTTP 409). */
  isConflict: (e: unknown) => boolean;
}

/** Shown when a change still conflicts after the lists were loaded again. */
const CONFLICT_MESSAGE = '다른 탭이나 기기에서 먼저 바뀌었어요. 새로 불러왔으니 다시 해 주세요';

export interface OrganizerSnapshot {
  /** Courses as shown (waiting changes applied), createdAt order. null until the first load. */
  courses: Course[] | null;
  /** Arrangement as shown, normalised against `courses`. */
  layout: LibraryLayout;
  coursesError: string | null;
  /** GET /api/layout failed (e.g. a server from before §18): courses are shown ungrouped, oldest first. */
  layoutError: string | null;
  /** Changes waiting for or being saved to the server. */
  pending: number;
}

type Op =
  | { type: 'move'; move: Move }
  | { type: 'renameCourse'; courseId: string; title: string }
  | { type: 'renameGroup'; groupId: string; title: string }
  | { type: 'deleteCourse'; courseId: string }
  | { type: 'deleteGroup'; groupId: string }
  | { type: 'createCourse'; title: string; groupId: string | null }
  | { type: 'createGroup'; title: string; courseIds: string[] }
  | { type: 'refresh' };

interface State {
  courses: Course[];
  layout: LibraryLayout;
}

/** A change as it shows before the server confirmed it (creations only show once they exist). */
function applyOp(state: State, op: Op): State {
  switch (op.type) {
    case 'move': {
      const m = op.move;
      if (m.kind === 'lecture') return { ...state, courses: applyLectureMove(state.courses, m) };
      if (m.kind === 'course') return { ...state, layout: applyCourseMove(state.layout, m) };
      return { ...state, layout: applyGroupMove(state.layout, m) };
    }
    case 'renameCourse':
      return { ...state, courses: state.courses.map((c) => (c.id === op.courseId ? { ...c, title: op.title } : c)) };
    case 'renameGroup':
      return { ...state, layout: withGroupTitle(state.layout, op.groupId, op.title) };
    case 'deleteCourse':
      return {
        courses: state.courses.filter((c) => c.id !== op.courseId),
        layout: withoutCourses(state.layout, [op.courseId]),
      };
    case 'deleteGroup':
      return { ...state, layout: withoutGroup(state.layout, op.groupId) };
    default:
      return state;
  }
}

function failMessage(op: Op): string {
  switch (op.type) {
    case 'move':
      if (op.move.kind === 'lecture') {
        return op.move.courseId === null ? '강의를 과목에서 빼지 못해 원래대로 되돌렸어요' : '강의를 옮기지 못해 원래대로 되돌렸어요';
      }
      return op.move.kind === 'course' ? '과목을 옮기지 못해 원래대로 되돌렸어요' : '그룹을 옮기지 못해 원래대로 되돌렸어요';
    case 'renameCourse':
      return '과목 이름을 바꾸지 못했어요';
    case 'renameGroup':
      return '그룹 이름을 바꾸지 못했어요';
    case 'deleteCourse':
      return '과목을 삭제하지 못했어요';
    case 'deleteGroup':
      return '그룹을 삭제하지 못했어요';
    case 'createCourse':
      return '과목을 만들지 못했어요';
    case 'createGroup':
      return '그룹을 만들지 못했어요';
    case 'refresh':
      return '과목 목록을 불러오지 못했어요';
  }
}

export type Organizer = ReturnType<typeof createOrganizer>;

export function createOrganizer(deps: OrganizerDeps) {
  const { api } = deps;

  // Last state the server confirmed (null = not loaded; a null layout = unknown, every course top level).
  let courses: Course[] | null = null;
  let rawLayout: LibraryLayout | null = null;
  let coursesError: string | null = null;
  let layoutError: string | null = null;

  interface Entry {
    id: number;
    op: Op;
  }
  let pending: Entry[] = [];
  let nextId = 1;
  let chain: Promise<unknown> = Promise.resolve();

  const listeners = new Set<() => void>();
  let snapshot: OrganizerSnapshot | null = null;

  const confirmed = (): State => {
    const list = courses ?? [];
    return { courses: list, layout: normalizeLayout(rawLayout, list) };
  };

  function emit() {
    snapshot = null;
    for (const l of listeners) l();
  }

  function getSnapshot(): OrganizerSnapshot {
    if (!snapshot) {
      const shown = pending.reduce((state, entry) => applyOp(state, entry.op), confirmed());
      snapshot = {
        courses: courses === null ? null : shown.courses,
        layout: courses === null ? EMPTY_LAYOUT : normalizeLayout(shown.layout, shown.courses),
        coursesError,
        layoutError,
        pending: pending.filter((e) => e.op.type !== 'refresh').length,
      };
    }
    return snapshot;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Sends one change, computed from the confirmed state now, and records what the server answered. */
  async function execute(op: Op): Promise<unknown> {
    const state = confirmed();
    switch (op.type) {
      case 'refresh': {
        const [c, l] = await Promise.allSettled([api.listCourses(), api.getLayout()]);
        if (c.status === 'fulfilled') {
          courses = c.value;
          coursesError = null;
        } else {
          coursesError = deps.errorMessage(c.reason);
          courses = courses ?? [];
        }
        if (l.status === 'fulfilled') {
          rawLayout = l.value;
          layoutError = null;
        } else {
          layoutError = deps.errorMessage(l.reason);
        }
        return null;
      }
      case 'move': {
        const move = op.move;
        checkStillThere(move, state);
        if (move.kind === 'lecture') {
          const patch = lectureMovePatch(state.courses, move);
          if (!patch) return null;
          const baseDocIds = state.courses.find((c) => c.id === patch.courseId)?.docIds ?? [];
          const saved = await api.updateCourse(patch.courseId, { docIds: patch.docIds, baseDocIds: [...baseDocIds] });
          courses = applyCourseUpdate(courses ?? [], saved);
          return null;
        }
        const next = move.kind === 'course' ? applyCourseMove(state.layout, move) : applyGroupMove(state.layout, move);
        if (sameLayout(next, state.layout)) return null;
        rawLayout = await api.putLayout({ ...toPutLayout(next), baseRevision: layoutRevision(state.layout) });
        return null;
      }
      case 'renameCourse': {
        const saved = await api.updateCourse(op.courseId, { title: op.title });
        courses = applyCourseUpdate(courses ?? [], saved);
        return null;
      }
      case 'renameGroup': {
        const saved = await api.updateGroup(op.groupId, { title: op.title });
        rawLayout = withGroupTitle(state.layout, op.groupId, saved.title);
        return null;
      }
      case 'deleteCourse': {
        await api.deleteCourse(op.courseId);
        courses = (courses ?? []).filter((c) => c.id !== op.courseId);
        rawLayout = withoutCourses(state.layout, [op.courseId]);
        return null;
      }
      case 'deleteGroup': {
        await api.deleteGroup(op.groupId);
        rawLayout = withoutGroup(state.layout, op.groupId);
        return null;
      }
      case 'createCourse': {
        const body: CreateCourseRequest = op.groupId ? { title: op.title, groupId: op.groupId } : { title: op.title };
        const course = await api.createCourse(body);
        courses = applyCourseUpdate(courses ?? [], course);
        rawLayout = withCourseAdded(state.layout, course.id, op.groupId);
        return course;
      }
      case 'createGroup': {
        const body: CreateGroupRequest = op.courseIds.length > 0 ? { title: op.title, courseIds: op.courseIds } : { title: op.title };
        const group = await api.createGroup(body);
        rawLayout = withGroupAppended(state.layout, group);
        return group;
      }
    }
  }

  /** A move into (or of) a course or group that is gone cannot be made: say so instead of doing nothing. */
  function checkStillThere(move: Move, state: State): void {
    const hasCourse = (id: string) => state.courses.some((c) => c.id === id);
    if (move.kind === 'lecture') {
      if (move.courseId !== null && !hasCourse(move.courseId)) throw new Error('옮길 과목이 다른 곳에서 삭제됐어요');
    } else if (move.kind === 'course') {
      if (!hasCourse(move.courseId)) throw new Error('이 과목은 다른 곳에서 삭제됐어요');
      if (move.groupId !== null && !findGroup(state.layout, move.groupId)) throw new Error('옮길 그룹이 다른 곳에서 삭제됐어요');
    } else if (!findGroup(state.layout, move.groupId)) {
      throw new Error('이 그룹은 다른 곳에서 삭제됐어요');
    }
  }

  /**
   * execute(), and for a move the server refused because it was made from stale data (409): load the lists
   * again and make the same move on top of them, once.
   */
  async function executeFresh(op: Op): Promise<unknown> {
    try {
      return await execute(op);
    } catch (e) {
      if (op.type !== 'move' || !deps.isConflict(e)) throw e;
    }
    await execute({ type: 'refresh' });
    emit();
    return execute(op);
  }

  function reason(e: unknown): string {
    return deps.isConflict(e) ? CONFLICT_MESSAGE : deps.errorMessage(e);
  }

  /** Queues a change; resolves with the server's answer (a created course/group) or null when it failed. */
  function enqueue<T>(op: Op): Promise<{ ok: boolean; value: T | null }> {
    const entry: Entry = { id: nextId++, op };
    pending = [...pending, entry];
    emit();
    const result = chain.then(async () => {
      try {
        const value = (await executeFresh(op)) as T | null;
        return { ok: true, value };
      } catch (e) {
        if (op.type !== 'refresh') deps.notifyError(`${failMessage(op)}: ${reason(e)}`);
        return { ok: false, value: null };
      } finally {
        pending = pending.filter((x) => x.id !== entry.id);
        emit();
      }
    });
    chain = result;
    return result.then((r) => {
      // The server refused: show what it really has (another tab may have changed it).
      if (!r.ok && op.type !== 'refresh') void refresh();
      return r;
    });
  }

  /** Loads courses and the layout again (after the changes already queued). */
  function refresh(): Promise<void> {
    return enqueue({ type: 'refresh' }).then(() => undefined);
  }

  /** Applies a move (optimistic). Resolves false when the server refused it (it was rolled back). */
  function move(m: Move): Promise<boolean> {
    const shown = getSnapshot();
    if (shown.courses === null) return Promise.resolve(false);
    const state: State = { courses: shown.courses, layout: shown.layout };
    if (m.kind === 'lecture' && lectureMovePatch(state.courses, m) === null) return Promise.resolve(true);
    if (m.kind !== 'lecture') {
      const next = m.kind === 'course' ? applyCourseMove(state.layout, m) : applyGroupMove(state.layout, m);
      if (sameLayout(next, state.layout)) return Promise.resolve(true);
    }
    return enqueue({ type: 'move', move: m }).then((r) => r.ok);
  }

  return {
    getSnapshot,
    subscribe,
    refresh,
    move,
    /** Move a lecture into a course before `beforeDocId` (null = at the end), or out of its course (courseId null). */
    moveLecture: (docId: string, courseId: string | null, beforeDocId: string | null = null) =>
      move({ kind: 'lecture', docId, courseId, beforeDocId }),
    /** Move a course into a group (or the top level, groupId null) before `before` (null = at the end). */
    moveCourse: (courseId: string, groupId: string | null, before: LayoutItem | null = null) =>
      move({ kind: 'course', courseId, groupId, before }),
    moveGroup: (groupId: string, before: LayoutItem | null = null) => move({ kind: 'group', groupId, before }),
    renameCourse: (courseId: string, title: string) => enqueue({ type: 'renameCourse', courseId, title }).then((r) => r.ok),
    renameGroup: (groupId: string, title: string) => enqueue({ type: 'renameGroup', groupId, title }).then((r) => r.ok),
    /** Delete a course (its lectures become uncategorized). */
    deleteCourse: (courseId: string) => enqueue({ type: 'deleteCourse', courseId }).then((r) => r.ok),
    /** Delete a group (its courses move to the top level where the group was). */
    deleteGroup: (groupId: string) => enqueue({ type: 'deleteGroup', groupId }).then((r) => r.ok),
    createCourse: (title: string, groupId: string | null = null) =>
      enqueue<Course>({ type: 'createCourse', title, groupId }).then((r) => r.value),
    createGroup: (title: string, courseIds: string[] = []) =>
      enqueue<CourseGroup>({ type: 'createGroup', title, courseIds }).then((r) => r.value),
    /** Show a lecture the server just added to a course (upload with X-Course-Id) until the next refresh. */
    addLectureLocally(courseId: string, docId: string) {
      const course = courses?.find((c) => c.id === courseId);
      if (!courses || !course || course.docIds.includes(docId)) return;
      courses = applyCourseUpdate(courses, { ...course, docIds: [...course.docIds, docId] });
      emit();
    },
  };
}
