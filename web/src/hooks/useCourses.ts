// Courses ("과목" folders): ordered lists of lecture documents (DESIGN.md §12).
//
// Membership is derived on the client from the course list (the course files are the source of
// truth; a document listed in several courses belongs to the oldest one, like on the server), so
// moving/reordering lectures never needs a documents refresh.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Course } from '../../../shared/types.ts';
import * as api from '../api.ts';
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

/** Replace one course and drop its lectures from every other course (a lecture is in at most one). */
function applyCourse(list: Course[], updated: Course): Course[] {
  const taken = new Set(updated.docIds);
  const known = list.some((c) => c.id === updated.id);
  const next = list.map((c) =>
    c.id === updated.id ? updated : { ...c, docIds: c.docIds.filter((id) => !taken.has(id)) },
  );
  return known ? next : [...next, updated];
}

export function useCourses() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCourses(await api.listCourses());
      setLoadError(null);
    } catch (e) {
      setLoadError(api.errorMessage(e));
      setCourses((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const membership = useMemo(() => indexCourses(courses), [courses]);

  const create = useCallback(async (title: string): Promise<Course | null> => {
    try {
      const course = await api.createCourse({ title });
      setCourses((prev) => applyCourse(prev ?? [], course));
      return course;
    } catch (e) {
      toast(`과목을 만들지 못했어요: ${api.errorMessage(e)}`, 'error');
      return null;
    }
  }, []);

  // PATCHes of one course are sent one after another (rapid ▲▼ clicks must reach the server in
  // order), and only the response to the latest one is applied (older ones would undo newer clicks).
  const queues = useRef(new Map<string, Promise<unknown>>());
  const latest = useRef(new Map<string, number>());
  const seq = useRef(0);

  /** PATCH with an optimistic local update; on failure the list is reloaded from the server. */
  const update = useCallback(
    (courseId: string, patch: { title?: string; docIds?: string[] }, failMessage: string): Promise<boolean> => {
      setCourses((prev) => {
        const current = prev?.find((c) => c.id === courseId);
        return prev && current ? applyCourse(prev, { ...current, ...patch }) : prev;
      });
      const mine = ++seq.current;
      latest.current.set(courseId, mine);
      const run = async (): Promise<boolean> => {
        try {
          const saved = await api.updateCourse(courseId, patch);
          if (latest.current.get(courseId) === mine) setCourses((prev) => applyCourse(prev ?? [], saved));
          return true;
        } catch (e) {
          toast(`${failMessage}: ${api.errorMessage(e)}`, 'error');
          void refresh();
          return false;
        }
      };
      const result = (queues.current.get(courseId) ?? Promise.resolve()).then(run);
      queues.current.set(courseId, result);
      return result;
    },
    [refresh],
  );

  const rename = useCallback(
    (courseId: string, title: string) => update(courseId, { title }, '과목 이름을 바꾸지 못했어요'),
    [update],
  );

  const setLectures = useCallback(
    (courseId: string, docIds: string[]) => update(courseId, { docIds }, '강의 목록을 바꾸지 못했어요'),
    [update],
  );

  /** Move a lecture into a course (appended; removed from its previous course) or out of every course (null). */
  const moveLecture = useCallback(
    (docId: string, courseId: string | null): Promise<boolean> => {
      const list = courses ?? [];
      if (courseId === null) {
        const from = list.find((c) => c.docIds.includes(docId));
        if (!from) return Promise.resolve(true);
        return update(from.id, { docIds: from.docIds.filter((id) => id !== docId) }, '과목에서 빼지 못했어요');
      }
      const to = list.find((c) => c.id === courseId);
      if (!to || to.docIds.includes(docId)) return Promise.resolve(!!to);
      return update(to.id, { docIds: [...to.docIds, docId] }, '과목으로 옮기지 못했어요');
    },
    [courses, update],
  );

  const remove = useCallback(
    async (courseId: string): Promise<boolean> => {
      try {
        await api.deleteCourse(courseId);
        setCourses((prev) => (prev ?? []).filter((c) => c.id !== courseId));
        return true;
      } catch (e) {
        toast(`과목을 삭제하지 못했어요: ${api.errorMessage(e)}`, 'error');
        void refresh();
        return false;
      }
    },
    [refresh],
  );

  /** Show a lecture that the server just added to a course (upload with X-Course-Id) until the next refresh. */
  const addLocally = useCallback((courseId: string, docId: string) => {
    setCourses((prev) => {
      const course = prev?.find((c) => c.id === courseId);
      if (!prev || !course || course.docIds.includes(docId)) return prev;
      return applyCourse(prev, { ...course, docIds: [...course.docIds, docId] });
    });
  }, []);

  return { courses, loadError, membership, refresh, create, rename, setLectures, moveLecture, remove, addLocally };
}

export type CoursesState = ReturnType<typeof useCourses>;
