import { useDroppable } from '@dnd-kit/core';
import { useId, useState, type DragEvent, type MouseEvent } from 'react';
import type { Course, DocMeta } from '../../../../shared/types.ts';
import { courseSummaryUrl } from '../../api.ts';
import type { UploadItem } from '../../hooks/useDocs.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { formatBytes } from '../../lib/format.ts';
import { withParticle } from '../../lib/korean.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { collapseKey, type LayoutEntry } from '../../lib/libraryLayout.ts';
import { LectureRow } from './LectureRow.tsx';
import { dropMarkClass, useDragState, useDropMark, useOrgItem, wasJustDragging } from './LibraryDnd.tsx';
import { Chevron, CourseSummaryBadges, DragHandle, ProgressBar, RenameInput } from './parts.tsx';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

/** Ready lectures without a finished (or running) 정리본 — their summaries are missing from the course context. */
function lecturesWithoutDigest(lectures: DocMeta[]): DocMeta[] {
  return lectures.filter((d) => d.status === 'ready' && d.digestStatus !== 'ready' && d.digestStatus !== 'running');
}

/**
 * A click that toggles a course or group: not right after a drag, and a double-click counts once (its second
 * click would fold the card back, and a card folding under the pointer moves what the second click hits).
 */
export function isToggleClick(e: MouseEvent<HTMLElement>): boolean {
  return !wasJustDragging() && e.detail <= 1;
}

/** A click on the free space of a header toggles it; clicks on its buttons, links and fields do their own thing. */
export function isHeaderToggleClick(e: MouseEvent<HTMLElement>): boolean {
  if (!isToggleClick(e)) return false;
  const target = e.target as HTMLElement;
  return !target.closest('button, a, input, select, textarea, label');
}

export interface CourseCardProps {
  course: Course;
  /** The group the course is in (null = top level). */
  groupId: string | null;
  /** Lectures in course order (documents that exist). */
  lectures: DocMeta[];
  uploads: UploadItem[];
  entries: LayoutEntry[];
  /** Collapsed by the user (per device). */
  collapsed: boolean;
  onToggle: () => void;
  /** Courses can be dragged (the layout is known). */
  canDrag: boolean;
  onOpen: (docId: string) => void;
  onPickFiles: () => void;
  onDropFiles: (files: File[]) => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onMoveLecture: (docId: string, courseId: string | null) => void;
  onRetryDoc: (docId: string) => void;
  onDeleteDoc: (doc: DocMeta) => void;
  canDigest: boolean;
  onDigestLectures: (docs: DocMeta[]) => void;
}

/**
 * Course folder: header (≡ handle, chevron + title, rename, lecture count, actions) and its ordered lectures.
 * Collapsed, only the title, the count and summary badges show. PDFs dropped from the file manager onto the
 * card are uploaded into the course.
 */
export function CourseCard(props: CourseCardProps) {
  const { course, groupId, lectures, uploads, collapsed } = props;
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const bodyId = useId();
  const drag = useDragState();
  const key = collapseKey.course(course.id);
  // While a course is dragged every course shows only its header, so that the list is short.
  const compact = drag.active?.kind === 'course';
  const shownCollapsed = compact || (collapsed && !drag.springOpen.has(key));

  const data: DropData = { role: 'course', courseId: course.id, groupId };
  const item = useOrgItem({ id: dndId.course(course.id), data, roleDescription: '옮길 수 있는 과목', canDrag: props.canDrag });
  const headData: DropData = { role: 'course-head', courseId: course.id };
  const head = useDroppable({ id: dndId.courseHead(course.id), data: headData });
  const bodyData: DropData = { role: 'course-body', courseId: course.id };
  const body = useDroppable({ id: dndId.courseBody(course.id), data: bodyData, disabled: shownCollapsed });
  const mark = useDropMark(dndId.course(course.id));
  const withoutDigest = lecturesWithoutDigest(lectures);

  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // handled here: the window-level drop listener ignores it
    setOver(false);
    props.onDropFiles(Array.from(e.dataTransfer.files));
  };

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `과목 ${withParticle(`‘${course.title}’`, '을', '를')} 삭제할까요?`,
      message:
        lectures.length > 0 ? `강의 ${lectures.length}개는 지워지지 않고 ‘미분류’로 옮겨져요.` : '비어 있는 과목이에요.',
      confirmLabel: '과목 삭제',
      danger: true,
    });
    if (ok) props.onDelete();
  };

  const className =
    'course-card' +
    (over ? ' is-over' : '') +
    (shownCollapsed ? ' is-collapsed' : '') +
    (item.isDragging ? ' is-drag-source' : '') +
    dropMarkClass(mark);

  return (
    <section
      ref={item.setNodeRef}
      data-drag-node=""
      data-org-key={dndId.course(course.id)}
      className={className}
      aria-label={`과목 ${course.title}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <header
        ref={head.setNodeRef}
        className="course-head"
        onClick={(e) => {
          if (!compact && isHeaderToggleClick(e)) props.onToggle();
        }}
      >
        <DragHandle
          label={`‘${course.title}’ 과목 옮기기`}
          setRef={item.setActivatorNodeRef}
          listeners={item.listeners}
          attributes={item.attributes}
          disabled={!props.canDrag}
        />
        {editing ? (
          <>
            <Chevron className="collapse-chevron is-static" />
            <span className="course-icon" aria-hidden>
              📁
            </span>
            <RenameInput
              initial={course.title}
              label="과목 이름"
              onDone={(title) => {
                setEditing(false);
                if (title && title !== course.title) props.onRename(title);
              }}
            />
          </>
        ) : (
          <>
            <button
              type="button"
              className="collapse-toggle"
              aria-expanded={!shownCollapsed}
              aria-controls={shownCollapsed ? undefined : bodyId}
              disabled={compact}
              onClick={(e) => {
                if (isToggleClick(e)) props.onToggle();
              }}
            >
              <Chevron />
              <span className="course-icon" aria-hidden>
                📁
              </span>
              <span className="course-title-text">{course.title}</span>
            </button>
            {!compact && (
              <button
                type="button"
                className="icon-btn tiny rename-btn"
                onClick={() => setEditing(true)}
                title="과목 이름 바꾸기"
                aria-label={`‘${course.title}’ 과목 이름 바꾸기`}
              >
                ✎
              </button>
            )}
          </>
        )}
        <span className="course-count">강의 {lectures.length}개</span>
        {shownCollapsed && !compact && <CourseSummaryBadges lectures={lectures} uploads={uploads.length} />}
        {mark === 'into' && shownCollapsed && (
          <span className="drop-into-label" aria-hidden>
            놓으면 이 과목 끝에 추가
          </span>
        )}
        <span className="spacer" />
        {!shownCollapsed && (
          <div className="course-actions">
            {withoutDigest.length > 0 && lectures.length > 1 && (
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => props.onDigestLectures(withoutDigest)}
                disabled={!props.canDigest}
                title={
                  props.canDigest
                    ? '정리본이 있는 강의만 요약이 다음 강의를 공부할 때 LLM에게 전달돼요 — 없는 강의의 정리본을 한 번에 만들어요'
                    : '사용할 수 있는 LLM이 없어요'
                }
              >
                📝 정리본 <span className="hide-narrow">없는 강의 </span>
                {withoutDigest.length}개 만들기
              </button>
            )}
            <a
              className="ghost-btn small"
              href={courseSummaryUrl(course.id)}
              target="_blank"
              rel="noreferrer"
              title="과목 정리 파일(COURSE.md) 열기 — 강의별 요약과 정리본 링크"
            >
              📄 COURSE.md
            </a>
            <button type="button" className="ghost-btn small" onClick={props.onPickFiles} title="이 과목에 강의 PDF 추가">
              ＋ 강의 추가
            </button>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => void confirmDelete()}
              title="과목 삭제 (강의는 남아요)"
              aria-label={`‘${course.title}’ 과목 삭제`}
            >
              🗑
            </button>
          </div>
        )}
      </header>

      {!shownCollapsed && (
        <div id={bodyId} ref={body.setNodeRef} className="course-body">
          {lectures.length > 0 || uploads.length > 0 ? (
            <ol className="lecture-list">
              {lectures.map((d, i) => (
                <LectureRow
                  key={d.id}
                  doc={d}
                  index={i + 1}
                  courseId={course.id}
                  entries={props.entries}
                  onOpen={props.onOpen}
                  onMove={(to) => props.onMoveLecture(d.id, to)}
                  onRetry={props.onRetryDoc}
                  onDelete={props.onDeleteDoc}
                />
              ))}
              {uploads.map((u) => (
                <li key={`up-${u.id}`} className="lecture-row is-uploading">
                  <span className="lecture-index">…</span>
                  <div className="lecture-main">
                    <div className="doc-title">{u.name}</div>
                    <div className="doc-sub">
                      업로드 중 {Math.round(u.fraction * 100)}% · {formatBytes(u.size)}
                    </div>
                    <ProgressBar fraction={u.fraction} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <button type="button" className="course-empty" onClick={props.onPickFiles}>
              {drag.active?.kind === 'lecture'
                ? '여기에 놓으면 이 과목의 강의가 돼요'
                : '아직 강의가 없어요 — PDF를 이 카드에 끌어다 놓거나 클릭해서 추가하세요'}
            </button>
          )}
        </div>
      )}

      {over && (
        <div className="course-drop-hint" aria-hidden>
          📄 놓으면 ‘{course.title}’에 강의로 추가해요
        </div>
      )}
    </section>
  );
}

/** What follows the pointer while a course is dragged. */
export function CourseGhost({ course, lectures }: { course: Course; lectures: number }) {
  return (
    <div className="drag-ghost course-ghost">
      <span className="drag-ghost-handle" aria-hidden>
        ≡
      </span>
      <span className="course-icon" aria-hidden>
        📁
      </span>
      <span className="drag-ghost-title">{course.title}</span>
      <span className="course-count">강의 {lectures}개</span>
    </div>
  );
}
