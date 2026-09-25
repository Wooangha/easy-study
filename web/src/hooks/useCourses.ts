// Courses ("과목" folders, DESIGN §12), course groups and their arrangement (DESIGN §18).
//
// Membership is derived on the client from the course list (the course files are the source of truth; a
// document listed in several courses belongs to the oldest one, like on the server), so moving/reordering
// lectures never needs a documents refresh. Changes are queued and shown optimistically (lib/organizer.ts).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Course } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { createOrganizer } from '../lib/organizer.ts';
import { toast } from '../lib/toast.ts';

export interface CourseMembership {
  course: Course;
  /** 1-based position of the lecture in the course. */
  index: number;
  /** Number of lectures in the course. */
  total: number;
}

/** docId → its course and position. Courses must be in creation order (the API's order). */
export function indexCourses(courses: Course[] | null): Map<string, CourseMembership> {
  const map = new Map<string, CourseMembership>();
  for (const course of courses ?? []) {
    course.docIds.forEach((docId, i) => {
      if (!map.has(docId)) map.set(docId, { course, index: i + 1, total: course.docIds.length });
    });
  }
  return map;
}

/** Focus and visibilitychange usually come together: one reload for both. */
const REFRESH_ON_RETURN_MS = 2000;

export function useCourses() {
  const [store] = useState(() =>
    createOrganizer({
      api: {
        listCourses: api.listCourses,
        getLayout: api.getLayout,
        createCourse: api.createCourse,
        updateCourse: api.updateCourse,
        deleteCourse: api.deleteCourse,
        putLayout: api.putLayout,
        createGroup: api.createGroup,
        updateGroup: api.updateGroup,
        deleteGroup: api.deleteGroup,
      },
      notifyError: (message) => toast(message, 'error'),
      errorMessage: api.errorMessage,
      isConflict: (e) => e instanceof api.ApiError && e.status === 409,
    }),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    void store.refresh();
  }, [store]);

  // Another tab or device (remote mode) may have rearranged the library meanwhile: load it again when this tab
  // comes back, so that what is shown — and what the next drag is computed from — is current.
  useEffect(() => {
    let last = Date.now();
    const onBack = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < REFRESH_ON_RETURN_MS) return;
      last = Date.now();
      void store.refresh();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    };
  }, [store]);

  const membership = useMemo(() => indexCourses(snapshot.courses), [snapshot.courses]);

  return {
    courses: snapshot.courses,
    layout: snapshot.layout,
    loadError: snapshot.coursesError,
    layoutError: snapshot.layoutError,
    /** Changes still being saved. */
    pending: snapshot.pending,
    membership,
    refresh: store.refresh,
    create: store.createCourse,
    rename: store.renameCourse,
    remove: store.deleteCourse,
    moveLecture: store.moveLecture,
    moveCourse: store.moveCourse,
    moveGroup: store.moveGroup,
    move: store.move,
    createGroup: store.createGroup,
    renameGroup: store.renameGroup,
    removeGroup: store.deleteGroup,
    addLocally: store.addLectureLocally,
  };
}

export type CoursesState = ReturnType<typeof useCourses>;
