import { useDroppable } from '@dnd-kit/core';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Course, DocMeta, LayoutItem, LibraryLayout } from '../../../shared/types.ts';
import type { CoursesState } from '../hooks/useCourses.ts';
import { useCollapsed } from '../hooks/useCollapsed.ts';
import type { UploadItem } from '../hooks/useDocs.ts';
import { dndId, type DragItem, type DropData } from '../lib/libraryDnd.ts';
import {
  allCollapseKeys,
  collapseKey,
  groupOfCourse,
  layoutEntries,
  layoutRows,
  neighbourAfterDelete,
} from '../lib/libraryLayout.ts';
import { CourseCard, CourseGhost } from './organize/CourseCard.tsx';
import { DocCard } from './organize/DocCard.tsx';
import { GroupCard, GroupGhost } from './organize/GroupCard.tsx';
import { LectureGhost } from './organize/LectureRow.tsx';
import { LibraryDnd, TopEndZone, useDragState, useDropMark } from './organize/LibraryDnd.tsx';
import { CourseOptions, DocProgress, NewTitleForm, UploadCard } from './organize/parts.tsx';

export { DigestBadge, DocProgress } from './organize/parts.tsx';

interface LibraryViewProps {
  docs: DocMeta[] | null;
  loadError: string | null;
  /** Courses, groups and their arrangement (useCourses). */
  org: CoursesState;
  uploads: UploadItem[];
  libraryDir: string | null;
  /** Course that the big drop zone uploads into (null = uncategorized). */
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
  /** Delete a document (asks for confirmation). */
  onDeleteDoc: (doc: DocMeta) => void;
  /** A provider is available for making 정리본. */
  canDigest: boolean;
  /** Make the 정리본 of these lectures (asks for confirmation). */
  onDigestLectures: (docs: DocMeta[]) => void;
}

/** The "과목" heading: where focus goes when nothing closer is left. */
const HEADING_KEY = 'heading:courses';

/**
 * Focuses the first of these library items that is shown (`data-org-key`): a lecture's ⋯ menu (in a course)
 * or its "과목으로 이동" select (미분류), a course's or group's collapse toggle, or the heading.
 */
function focusOrgItem(keys: readonly string[]): void {
  for (const key of keys) {
    const el = document.querySelector<HTMLElement>(`[data-org-key="${CSS.escape(key)}"]`);
    if (!el) continue;
    const target =
      key === HEADING_KEY
        ? el
        : key.startsWith('lecture:')
          ? (el.querySelector<HTMLElement>('.menu-btn') ?? el.querySelector<HTMLElement>('select') ?? el.querySelector<HTMLElement>('.drag-handle'))
          : (el.querySelector<HTMLElement>(':scope > header .collapse-toggle') ?? el.querySelector<HTMLElement>(':scope > header .drag-handle'));
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
 * Library: drop zone, then the arrangement of groups and course folders (collapsible, reordered by dragging
 * their ≡ handles), then uncategorized documents (DESIGN §12, §13, §18).
 */
export function LibraryView(props: LibraryViewProps) {
  const { docs, loadError, org, uploads, libraryDir, uploadCourseId } = props;
  const [over, setOver] = useState(false);
  const [creating, setCreating] = useState<'course' | 'group' | null>(null);

  const courseList = useMemo(() => org.courses ?? [], [org.courses]);
  const layout = org.layout;
  const coursesKnown = org.courses !== null && !org.loadError;
  const existingKeys = useMemo(
    () => (coursesKnown && !org.layoutError ? allCollapseKeys(layout, courseList) : null),
    [coursesKnown, org.layoutError, layout, courseList],
  );
  const { collapsed, setOne, toggle, setAll } = useCollapsed(existingKeys);
  const allKeys = useMemo(() => allCollapseKeys(layout, courseList), [layout, courseList]);
  const allCollapsed = allKeys.length > 0 && allKeys.every((k) => collapsed.has(k));
  const anyCollapsed = allKeys.some((k) => collapsed.has(k));
  const saving = useDelayedFlag(org.pending > 0, 400);

  // Moving a lecture with its ⋯ menu or select, or deleting a course or group, removes the control that has the
  // keyboard focus: move it to the same lecture in its new place (or what is nearest) instead of <body>.
  const [focusAfter, setFocusAfter] = useState<string[] | null>(null);
  useEffect(() => {
    if (!focusAfter) return;
    setFocusAfter(null);
    focusOrgItem(focusAfter);
  }, [focusAfter]);
  const moveLecture = (docId: string, courseId: string | null) => {
    const group = courseId ? groupOfCourse(layout, courseId) : null;
    setFocusAfter([
      dndId.lecture(docId),
      ...(courseId ? [dndId.course(courseId)] : []), // a collapsed course
      ...(group ? [dndId.group(group.id)] : []), // …in a collapsed group
      HEADING_KEY,
    ]);
    void org.moveLecture(docId, courseId);
  };
  const focusAfterDelete = (item: LayoutItem) => {
    const near = neighbourAfterDelete(layout, item);
    setFocusAfter(near ? [itemKey(near), HEADING_KEY] : [HEADING_KEY]);
  };

  // A group or course just created goes to the end of its list: bring it into view.
  const [reveal, setReveal] = useState<string | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const el = document.querySelector(`[data-org-key="${CSS.escape(reveal)}"]`);
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    setReveal(null);
  }, [reveal, layout]);

  // One hidden file input shared by every course card's "＋ 강의 추가" button.
  const courseFileInput = useRef<HTMLInputElement>(null);
  const pickForCourse = useRef<string | null>(null);
  const pickFilesFor = (courseId: string) => {
    pickForCourse.current = courseId;
    courseFileInput.current?.click();
  };

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    // preventDefault marks the drop as handled; the window-level listener then only hides its overlay.
    e.preventDefault();
    setOver(false);
    props.onDropFiles(Array.from(e.dataTransfer.files));
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
  const uploadTarget = courseList.find((c) => c.id === uploadCourseId) ?? null;
  const looseUploads = uploads.filter((u) => !u.courseId || !courseList.some((c) => c.id === u.courseId));
  const rows = layoutRows(layout, courseList);
  const entries = layoutEntries(layout, courseList);
  const canDragCourses = !org.layoutError;

  const nameOf = (item: DragItem): string => {
    if (item.kind === 'lecture') return `‘${byId.get(item.docId)?.title ?? '강의'}’ 강의`;
    if (item.kind === 'course') return `‘${courseList.find((c) => c.id === item.courseId)?.title ?? '과목'}’ 과목`;
    return `‘${layout.groups.find((g) => g.id === item.groupId)?.title ?? '그룹'}’ 그룹`;
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
    return group ? <GroupGhost group={group} /> : null;
  };

  const renderCourse = (c: Course, groupId: string | null) => (
    <CourseCard
      key={c.id}
      course={c}
      groupId={groupId}
      lectures={lecturesOf(c)}
      uploads={uploads.filter((u) => u.courseId === c.id)}
      entries={entries}
      collapsed={collapsed.has(collapseKey.course(c.id))}
      onToggle={() => toggle(collapseKey.course(c.id))}
      canDrag={canDragCourses}
      onOpen={props.onOpen}
      onPickFiles={() => pickFilesFor(c.id)}
      onDropFiles={(files) => props.onUploadToCourse(c.id, files)}
      onRename={(title) => void org.rename(c.id, title)}
      onDelete={() => {
        focusAfterDelete({ type: 'course', id: c.id });
        void org.remove(c.id);
      }}
      onMoveLecture={moveLecture}
      onRetryDoc={props.onRetryDoc}
      onDeleteDoc={props.onDeleteDoc}
      canDigest={props.canDigest}
      onDigestLectures={props.onDigestLectures}
    />
  );

  return (
    <div className="library">
      <div className="library-inner">
        <div className="dropzone-wrap">
          <button
            type="button"
            className={over ? 'dropzone is-over' : 'dropzone'}
            onClick={props.onPickFiles}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <span className="dropzone-icon" aria-hidden>
              📄
            </span>
            <span className="dropzone-title">PDF를 끌어다 놓거나 클릭해서 업로드</span>
            <span className="dropzone-sub">
              {uploadTarget ? (
                <>
                  <b>📁 {uploadTarget.title}</b> 과목에 강의로 추가돼요
                </>
              ) : (
                '슬라이드를 이미지로 변환해 두고, 질문할 때 LLM이 그림·도표까지 볼 수 있게 해요'
              )}
            </span>
          </button>
          {courseList.length > 0 && (
            <label className="upload-target">
              <span className="muted">업로드할 곳</span>
              <select
                className="picker"
                value={uploadTarget?.id ?? ''}
                onChange={(e) => props.onUploadCourseChange(e.target.value || null)}
              >
                <option value="">미분류</option>
                <CourseOptions courses={courseList} layout={layout} />
              </select>
            </label>
          )}
        </div>

        {looseUploads.map((u) => (
          <UploadCard key={u.id} upload={u} />
        ))}

        {loadError && (
          <div className="inline-error">
            ⚠️ 문서 목록을 불러오지 못했어요: {loadError}{' '}
            <button type="button" className="ghost-btn small" onClick={props.onRetryLoad}>
              다시 시도
            </button>
          </div>
        )}

        {docs === null && !loadError && <p className="muted center">불러오는 중…</p>}

        {/* ---- Courses (rendered once the documents are known, so lectures don't flash as missing) --- */}
        {docs !== null && (
          <LibraryDnd
            courses={courseList}
            layout={layout}
            collapsed={collapsed}
            nameOf={nameOf}
            renderOverlay={renderOverlay}
            onMove={(move) => void org.move(move)}
            onKeepOpen={(key) => setOne(key, false)}
          >
            <div className="library-section-head">
              <h2 className="library-heading" tabIndex={-1} data-org-key={HEADING_KEY}>
                과목
              </h2>
              {courseList.length > 1 && !saving && (
                <span className="muted small section-tip">≡ 를 끌어서 순서·위치를 바꿔요</span>
              )}
              {saving && (
                <span className="muted small section-tip" role="status">
                  저장 중…
                </span>
              )}
              <span className="spacer" />
              {allKeys.length > 0 && (
                <span className="section-tools">
                  <button type="button" className="ghost-btn small" onClick={() => setAll(allKeys, true)} disabled={allCollapsed}>
                    모두 접기
                  </button>
                  <button type="button" className="ghost-btn small" onClick={() => setAll(allKeys, false)} disabled={!anyCollapsed}>
                    모두 펼치기
                  </button>
                </span>
              )}
              <span className="section-tools">
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => setCreating('group')}
                  disabled={!coursesKnown || !!org.layoutError}
                  title="과목을 묶는 그룹 (예: 학기)"
                >
                  ＋ 새 그룹
                </button>
                <button type="button" className="ghost-btn small" onClick={() => setCreating('course')} disabled={!coursesKnown}>
                  ＋ 새 과목
                </button>
              </span>
            </div>
            {org.loadError && <div className="inline-error">⚠️ 과목 목록을 불러오지 못했어요: {org.loadError}</div>}
            {!org.loadError && org.layoutError && (
              <div className="inline-error">
                ⚠️ 과목 배치(그룹·순서)를 불러오지 못해서 과목을 만든 순서대로 보여 줘요: {org.layoutError}{' '}
                <button type="button" className="ghost-btn small" onClick={() => void org.refresh()}>
                  다시 시도
                </button>
              </div>
            )}
            {creating === 'group' && (
              <NewTitleForm
                icon="🗂"
                placeholder="그룹 이름 (예: 2026-2학기)"
                label="새 그룹 이름"
                onCancel={() => setCreating(null)}
                onCreate={async (title) => {
                  const group = await org.createGroup(title);
                  if (group) {
                    setCreating(null);
                    setReveal(dndId.group(group.id));
                  }
                }}
              />
            )}
            {creating === 'course' && (
              <NewTitleForm
                icon="📁"
                placeholder="과목 이름 (예: Compiler)"
                label="새 과목 이름"
                onCancel={() => setCreating(null)}
                onCreate={async (title) => {
                  const course = await org.create(title);
                  if (course) {
                    setCreating(null);
                    setReveal(dndId.course(course.id));
                  }
                }}
              />
            )}
            {org.courses !== null && courseList.length === 0 && layout.groups.length === 0 && !creating && !org.loadError && (
              <p className="course-hint muted small">
                강의를 과목으로 묶어 두면 LLM이 이전 강의들을 알고 설명해요. 예: ‘Compiler’ 과목에 Lecture 1, 2, 3 … 을
                순서대로 넣어 두면, Lecture 8을 공부할 때 1–7강 중 정리본이 있는 강의의 요약을 함께 받고, Claude Code·Codex는
                필요하면 그 강의 파일도 열어 봐요. 과목이 많아지면 ‘새 그룹’으로 학기별로 묶을 수 있어요.
              </p>
            )}

            {rows.map((row) =>
              row.type === 'group' ? (
                <GroupCard
                  key={row.group.id}
                  group={row.group}
                  courses={row.courses}
                  collapsed={collapsed.has(collapseKey.group(row.group.id))}
                  onToggle={() => toggle(collapseKey.group(row.group.id))}
                  onExpand={() => setOne(collapseKey.group(row.group.id), false)}
                  canDrag={canDragCourses}
                  renderCourse={(c) => renderCourse(c, row.group.id)}
                  onRename={(title) => void org.renameGroup(row.group.id, title)}
                  onDelete={() => {
                    focusAfterDelete({ type: 'group', id: row.group.id });
                    void org.removeGroup(row.group.id);
                  }}
                  onCreateCourse={async (title) => {
                    const course = await org.create(title, row.group.id);
                    if (course) setReveal(dndId.course(course.id));
                    return course;
                  }}
                />
              ) : (
                renderCourse(row.course, null)
              ),
            )}
            <TopEndZone />

            {/* ---- Uncategorized ------------------------------------------------------------------- */}
            <UncategorizedSection
              docs={uncategorized}
              courses={courseList}
              layout={layout}
              onOpen={props.onOpen}
              onMove={moveLecture}
              onRetry={props.onRetryDoc}
              onDelete={props.onDeleteDoc}
            />
          </LibraryDnd>
        )}

        {docs && docs.length === 0 && uploads.length === 0 && !loadError && (
          <p className="muted center">아직 문서가 없어요. 강의 자료 PDF를 올려 보세요.</p>
        )}

        {libraryDir && (
          <p className="library-path muted small">
            저장 위치: <code>{libraryDir}</code>
          </p>
        )}
      </div>

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

/** "미분류": documents in no course. While a lecture is dragged it is also the drop zone for "과목에서 빼기". */
function UncategorizedSection({
  docs,
  courses,
  layout,
  onOpen,
  onMove,
  onRetry,
  onDelete,
}: {
  docs: DocMeta[];
  courses: readonly Course[];
  layout: LibraryLayout;
  onOpen: (docId: string) => void;
  onMove: (docId: string, courseId: string | null) => void;
  onRetry: (docId: string) => void;
  onDelete: (doc: DocMeta) => void;
}) {
  const { active } = useDragState();
  const data: DropData = { role: 'uncategorized' };
  const { setNodeRef } = useDroppable({ id: dndId.uncategorized, data });
  const mark = useDropMark(dndId.uncategorized);
  const hasCourses = courses.length > 0;
  /** A lecture of a course is being dragged (dropping it here takes it out of its course). */
  const draggingFromCourse = active?.kind === 'lecture' && !docs.some((d) => d.id === active.docId);
  if (docs.length === 0 && !(draggingFromCourse && hasCourses)) return null;
  return (
    <section
      ref={setNodeRef}
      className={`uncategorized${mark === 'into' ? ' drop-into' : ''}`}
      aria-label={hasCourses ? '미분류 문서' : '내 문서'}
    >
      <div className="library-section-head">
        <h2 className="library-heading">{hasCourses ? '미분류' : '내 문서'}</h2>
        {hasCourses && (
          <span className="muted small">
            {draggingFromCourse
              ? '여기에 놓으면 과목에서 빠져요'
              : '과목에 넣으려면 ≡ 를 끌어다 과목에 놓거나 ‘과목으로 이동’을 고르세요'}
          </span>
        )}
      </div>
      {docs.length > 0 ? (
        <div className="doc-list">
          {docs.map((d) => (
            <DocCard
              key={d.id}
              doc={d}
              courses={courses}
              layout={layout}
              onOpen={onOpen}
              onMove={onMove}
              onRetry={onRetry}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : (
        <div className="uncategorized-empty">여기에 놓으면 과목에서 빠져요</div>
      )}
    </section>
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
  return (
    <div className="library">
      <div className="library-inner status-view">
        <div className="status-card">
          <div className="status-icon" aria-hidden>
            {doc.status === 'error' ? '⚠️' : '⏳'}
          </div>
          <h2>{doc.title}</h2>
          <p className="muted small">{doc.fileName}</p>
          {doc.status === 'processing' ? (
            <>
              <DocProgress doc={doc} />
              <p className="muted small">
                슬라이드 이미지·텍스트·개요 이미지를 만드는 중이에요. 끝나면 자동으로 열려요.
              </p>
            </>
          ) : (
            <>
              <div className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</div>
              <p className="muted small">
                업로드한 PDF는 남아 있어요. 일시적인 문제였다면 다시 변환해 보세요. 암호가 걸렸거나 손상된 PDF라면 암호를 풀거나
                다시 내보낸 PDF를 새로 올려 주세요.
              </p>
              <div className="status-actions">
                <button type="button" className="primary-btn small" onClick={onRetry}>
                  ↻ 다시 변환
                </button>
                <button type="button" className="ghost-btn danger" onClick={onDelete}>
                  삭제
                </button>
              </div>
            </>
          )}
          <button type="button" className="ghost-btn" onClick={onBack}>
            ← 라이브러리
          </button>
        </div>
      </div>
    </div>
  );
}
