import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, Hourglass, RefreshCw, TriangleAlert } from 'lucide-react';
import type { Course, DocMeta, LayoutItem } from '../../../shared/types.ts';
import type { CoursesState } from '../hooks/useCourses.ts';
import { useCollapsed } from '../hooks/useCollapsed.ts';
import type { UploadItem } from '../hooks/useDocs.ts';
import { msg } from '../i18n/index.ts';
import { dndId, type DragItem } from '../lib/libraryDnd.ts';
import { allCollapseKeys, collapseKey, coursesInside, groupPath, layoutEntries, layoutRows, neighbourAfterDelete } from '../lib/libraryLayout.ts';
import { LectureGhost } from './organize/LectureRow.tsx';
import { LibraryDnd, TopEndZone } from './organize/LibraryDnd.tsx';
import { CoursePane, UncategorizedPane } from './organize/LibraryPanes.tsx';
import { CourseGhost, GroupGhost, LibraryTree, type TreeActions } from './organize/LibraryTree.tsx';
import { DocProgress } from './organize/parts.tsx';

export { DigestBadge, DocProgress } from './organize/parts.tsx';

interface LibraryViewProps {
  docs: DocMeta[] | null;
  loadError: string | null;
  /** Courses, groups and their arrangement (useCourses). */
  org: CoursesState;
  uploads: UploadItem[];
  libraryDir: string | null;
  /** The course chosen in the tree: shown on the right, and where new PDFs go (null = 미분류). */
  uploadCourseId: string | null;
  onUploadCourseChange: (courseId: string | null) => void;
  onOpen: (docId: string) => void;
  onPickFiles: () => void;
  onDropFiles: (files: File[]) => void;
  /** Upload into a specific course (course card button / drop). */
  onUploadToCourse: (courseId: string, files: File[]) => void;
  onRetryLoad: () => void;
  /** Re-run the conversion of a document whose conversion failed. */
  onRetryDoc: (docId: string) => void;
  /** Rename a lecture (its ⋯ menu's 이름 바꾸기). */
  onRenameDoc: (docId: string, title: string) => void;
  /** Delete a document (asks for confirmation). */
  onDeleteDoc: (doc: DocMeta) => void;
  /** A provider is available for making 정리본. */
  canDigest: boolean;
  /** Make the 정리본 of these lectures (asks for confirmation). */
  onDigestLectures: (docs: DocMeta[]) => void;
}

/** The "과목" heading of the tree: where focus goes when nothing closer is left. */
const HEADING_KEY = 'heading:courses';

/**
 * Focuses the first of these library items that is shown (`data-org-key`): a lecture's ⋯ menu, a course or group of
 * the tree (its button), or the heading.
 */
function focusOrgItem(keys: readonly string[]): void {
  for (const key of keys) {
    const el = document.querySelector<HTMLElement>(`[data-org-key="${CSS.escape(key)}"]`);
    if (!el) continue;
    const target =
      key === HEADING_KEY
        ? el
        : key.startsWith('lecture:')
          ? (el.querySelector<HTMLElement>('.menu-btn') ?? el.querySelector<HTMLElement>('.drag-handle'))
          : el.querySelector<HTMLElement>(':scope > .tree-row .tree-select, :scope > .tree-row .tree-toggle');
    if (target) {
      target.focus();
      return;
    }
  }
}

const itemKey = (item: LayoutItem) => (item.type === 'group' ? dndId.group(item.id) : dndId.course(item.id));

/** True once `value` has been true for `ms` (a "saving…" note that does not flash on every quick save). */
function useDelayedFlag(value: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

/**
 * Library (DESIGN §12, §13, §18; two columns since 0.6.15): on the left the groups and courses as a tree (≡ drags
 * them) and 미분류, on the right the chosen course's lectures — or 미분류's. The chosen course is the upload course
 * (App: it follows the lecture that was open), so the library opens where one was studying. On a phone the tree is
 * folded above the list behind a button with the course's name.
 */
export function LibraryView(props: LibraryViewProps) {
  const { docs, loadError, org, uploads, libraryDir, uploadCourseId } = props;
  const [treeOpen, setTreeOpen] = useState(false);

  const courseList = useMemo(() => org.courses ?? [], [org.courses]);
  const layout = org.layout;
  const coursesKnown = org.courses !== null && !org.loadError;
  const existingKeys = useMemo(
    () => (coursesKnown && !org.layoutError ? allCollapseKeys(layout, courseList) : null),
    [coursesKnown, org.layoutError, layout, courseList],
  );
  const { collapsed, setOne, toggle } = useCollapsed(existingKeys);
  const saving = useDelayedFlag(org.pending > 0, 400);
  const selected = courseList.find((c) => c.id === uploadCourseId) ?? null;
  const select = (courseId: string | null) => {
    props.onUploadCourseChange(courseId);
    setTreeOpen(false);
  };

  // Moving a lecture with its ⋯ menu, or deleting a course or group, removes the control that has the keyboard
  // focus: move it to the same lecture in its new place (or what is nearest) instead of <body>.
  const [focusAfter, setFocusAfter] = useState<string[] | null>(null);
  useEffect(() => {
    if (!focusAfter) return;
    setFocusAfter(null);
    focusOrgItem(focusAfter);
  }, [focusAfter]);
  const moveLecture = (docId: string, courseId: string | null) => {
    const groups = courseId ? groupPath(layout, { type: 'course', id: courseId }) : [];
    setFocusAfter([
      dndId.lecture(docId),
      ...(courseId ? [dndId.course(courseId)] : [dndId.uncategorized]), // its new place in the tree
      ...groups.reverse().map((g) => dndId.group(g.id)), // …in a collapsed group (in a collapsed group…)
      HEADING_KEY,
    ]);
    void org.moveLecture(docId, courseId);
  };
  const focusAfterDelete = (item: LayoutItem) => {
    const near = neighbourAfterDelete(layout, item);
    setFocusAfter(near ? [itemKey(near), HEADING_KEY] : [HEADING_KEY]);
  };

  // A course or group just created: bring it into view; a course is chosen too.
  const [reveal, setReveal] = useState<string | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const el = document.querySelector(`[data-org-key="${CSS.escape(reveal)}"]`);
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    setReveal(null);
  }, [reveal, layout]);

  // One hidden file input for the course pane's "＋ 강의 추가".
  const courseFileInput = useRef<HTMLInputElement>(null);
  const pickForCourse = useRef<string | null>(null);
  const pickFilesFor = (courseId: string) => {
    pickForCourse.current = courseId;
    courseFileInput.current?.click();
  };

  const byId = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs]);
  const membership = org.membership;
  /** Lectures of a course that exist and belong to it (a document listed twice shows in its oldest course). */
  const lecturesOf = useCallback(
    (c: Course) =>
      c.docIds
        .filter((id) => membership.get(id)?.course.id === c.id)
        .map((id) => byId.get(id))
        .filter((d): d is DocMeta => d !== undefined),
    [byId, membership],
  );
  const uncategorized = (docs ?? []).filter((d) => !membership.has(d.id));
  const looseUploads = uploads.filter((u) => !u.courseId || !courseList.some((c) => c.id === u.courseId));
  const rows = layoutRows(layout, courseList);
  const entries = layoutEntries(layout, courseList);
  const canDragCourses = !org.layoutError;
  const m = msg().shell.library;

  /** "그룹 2개 · 과목 7개": the groups in a group and the courses in it at any depth. */
  const contentsOf = (groupId: string) =>
    msg().shell.group.contents(
      layout.groups.find((g) => g.id === groupId)?.items.filter((item) => item.type === 'group').length ?? 0,
      coursesInside(layout, groupId).length,
    );

  const nameOf = (item: DragItem): string => {
    const d = msg().shell.dnd;
    if (item.kind === 'lecture') return d.lectureName(byId.get(item.docId)?.title ?? d.lectureFallback);
    if (item.kind === 'course') return d.courseName(courseList.find((c) => c.id === item.courseId)?.title ?? d.courseFallback);
    return d.groupName(layout.groups.find((g) => g.id === item.groupId)?.title ?? d.groupFallback);
  };

  const renderOverlay = (item: DragItem) => {
    if (item.kind === 'lecture') {
      const doc = byId.get(item.docId);
      return doc ? <LectureGhost doc={doc} /> : null;
    }
    if (item.kind === 'course') {
      const course = courseList.find((c) => c.id === item.courseId);
      return course ? <CourseGhost course={course} lectures={lecturesOf(course).length} /> : null;
    }
    const group = layout.groups.find((g) => g.id === item.groupId);
    return group ? <GroupGhost group={group} contents={contentsOf(group.id)} /> : null;
  };

  // For dragging: the tree shows no lectures, so every course but the chosen one is "collapsed" there (a lecture
  // dropped on it goes to its end), and hovering opens groups only.
  const dndCollapsed = useMemo(() => {
    const keys = new Set(collapsed);
    for (const c of courseList) if (c.id !== selected?.id) keys.add(collapseKey.course(c.id));
    for (const c of courseList) if (c.id === selected?.id) keys.delete(collapseKey.course(c.id));
    return keys;
  }, [collapsed, courseList, selected]);

  const treeActions: TreeActions = {
    selected: selected?.id ?? null,
    onSelect: select,
    lectureCount: (courseId) => {
      const c = courseList.find((x) => x.id === courseId);
      return c ? lecturesOf(c).length : 0;
    },
    contentsOf,
    collapsed,
    onToggle: toggle,
    onExpand: (key) => setOne(key, false),
    canDrag: canDragCourses,
    onUploadToCourse: props.onUploadToCourse,
    onCreateCourse: async (title, groupId) => {
      const course = await org.create(title, groupId);
      if (course) {
        select(course.id);
        setReveal(dndId.course(course.id));
      }
      return course;
    },
    onCreateGroup: async (title, parentId) => {
      const group = await org.createGroup(title, [], parentId);
      if (group) setReveal(dndId.group(group.id));
      return group;
    },
    onRenameGroup: (groupId, title) => void org.renameGroup(groupId, title),
    onDeleteGroup: (groupId) => {
      focusAfterDelete({ type: 'group', id: groupId });
      void org.removeGroup(groupId);
    },
  };

  const handlers = {
    entries,
    onOpen: props.onOpen,
    onMoveLecture: moveLecture,
    onRetryDoc: props.onRetryDoc,
    onRenameDoc: props.onRenameDoc,
    onDeleteDoc: props.onDeleteDoc,
  };

  const treeToggle = (
    <button type="button" className="lib-tree-toggle" aria-expanded={treeOpen} onClick={() => setTreeOpen((o) => !o)}>
      {selected ? selected.title : courseList.length > 0 ? m.uncategorized : m.myDocs}
      <ChevronDown />
    </button>
  );

  const notices = (
    <>
      {org.loadError && (
        <div className="inline-error small">
          <TriangleAlert /> {m.coursesLoadFailed(org.loadError)}
        </div>
      )}
      {!org.loadError && org.layoutError && (
        <div className="inline-error small">
          <TriangleAlert /> {m.layoutLoadFailed(org.layoutError)}{' '}
          <button type="button" className="ghost-btn small" onClick={() => void org.refresh()}>
            {msg().common.retry}
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className={`library lib2${treeOpen ? ' is-tree-open' : ''}`}>
      <LibraryDnd
        courses={courseList}
        layout={layout}
        collapsed={dndCollapsed}
        nameOf={nameOf}
        renderOverlay={renderOverlay}
        onMove={(move) => void org.move(move)}
        onKeepOpen={(key) => setOne(key, false)}
        canSpringOpen={(key) => key.startsWith('group:')}
      >
        <LibraryTree
          rows={rows}
          actions={treeActions}
          uncategorizedCount={uncategorized.length}
          hasCourses={courseList.length > 0}
          canCreate={coursesKnown}
          canCreateGroup={coursesKnown && !org.layoutError}
          saving={saving}
          headingRef={HEADING_KEY}
          uploadTitle={selected ? m.uploadTo(selected.title) : m.uploadToUncategorized}
          onPickFiles={props.onPickFiles}
          notices={notices}
          footer={<TopEndZone />}
        />
        <div className="lib-main">
          {loadError && (
            <div className="inline-error">
              <TriangleAlert /> {m.docsLoadFailed(loadError)}{' '}
              <button type="button" className="ghost-btn small" onClick={props.onRetryLoad}>
                {msg().common.retry}
              </button>
            </div>
          )}
          {docs === null && !loadError ? (
            <p className="muted center">{msg().common.loading}</p>
          ) : selected ? (
            <CoursePane
              key={selected.id}
              course={selected}
              path={groupPath(layout, { type: 'course', id: selected.id })}
              lectures={lecturesOf(selected)}
              uploads={uploads.filter((u) => u.courseId === selected.id)}
              handlers={handlers}
              onPickFiles={() => pickFilesFor(selected.id)}
              onDropFiles={(files) => props.onUploadToCourse(selected.id, files)}
              onRename={(title) => void org.rename(selected.id, title)}
              onDelete={() => {
                focusAfterDelete({ type: 'course', id: selected.id });
                void org.remove(selected.id);
              }}
              canDigest={props.canDigest}
              onDigestLectures={props.onDigestLectures}
              treeToggle={treeToggle}
            />
          ) : (
            <UncategorizedPane
              docs={uncategorized}
              uploads={looseUploads}
              hasCourses={courseList.length > 0}
              handlers={handlers}
              onPickFiles={props.onPickFiles}
              onDropFiles={props.onDropFiles}
              treeToggle={treeToggle}
              libraryEmpty={(docs ?? []).length === 0 && uploads.length === 0}
            />
          )}
          {libraryDir && <p className="library-path muted small">{m.storedAt(<code>{libraryDir}</code>)}</p>}
        </div>
      </LibraryDnd>

      <input
        ref={courseFileInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // allow picking the same file again
          const courseId = pickForCourse.current;
          pickForCourse.current = null;
          if (courseId && files.length > 0) props.onUploadToCourse(courseId, files);
        }}
      />
    </div>
  );
}

/** Shown in place of the split view while the selected doc is processing or failed. */
export function DocStatusView({
  doc,
  onBack,
  onRetry,
  onDelete,
}: {
  doc: DocMeta;
  onBack: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const m = msg().shell.library;
  return (
    <div className="library">
      <div className="library-inner status-view">
        <div className="status-card">
          <div className={`status-icon${doc.status === 'error' ? ' is-error' : ''}`} aria-hidden>
            {doc.status === 'error' ? <TriangleAlert strokeWidth={1.5} /> : <Hourglass strokeWidth={1.5} />}
          </div>
          <h2>{doc.title}</h2>
          <p className="muted small">{doc.fileName}</p>
          {doc.status === 'processing' ? (
            <>
              <DocProgress doc={doc} />
              <p className="muted small">{m.processing}</p>
            </>
          ) : (
            <>
              <div className="doc-error">{doc.error ?? m.processingError}</div>
              <p className="muted small">{m.failedHelp}</p>
              <div className="status-actions">
                <button type="button" className="primary-btn small" onClick={onRetry}>
                  <RefreshCw /> {m.convertAgain}
                </button>
                <button type="button" className="ghost-btn danger" onClick={onDelete}>
                  {msg().common.delete}
                </button>
              </div>
            </>
          )}
          <button type="button" className="ghost-btn" onClick={onBack}>
            <ArrowLeft /> {m.backToLibrary}
          </button>
        </div>
      </div>
    </div>
  );
}
