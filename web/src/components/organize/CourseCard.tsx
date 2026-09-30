import { useDroppable } from '@dnd-kit/core';
import { useId, useState, type DragEvent, type MouseEvent } from 'react';
import { FileText, Folder, GripVertical, NotebookPen, Pencil, Trash } from 'lucide-react';
import type { Course, DocMeta } from '../../../../shared/types.ts';
import { courseSummaryUrl } from '../../api.ts';
import type { UploadItem } from '../../hooks/useDocs.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { formatBytes } from '../../lib/format.ts';
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
  onRenameDoc: (docId: string, title: string) => void;
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
  const m = msg().shell.course;
  const drag = useDragState();
  const key = collapseKey.course(course.id);
  // While a course is dragged every course shows only its header, so that the list is short.
  const compact = drag.active?.kind === 'course';
  const shownCollapsed = compact || (collapsed && !drag.springOpen.has(key));

  const data: DropData = { role: 'course', courseId: course.id, groupId };
  const item = useOrgItem({ id: dndId.course(course.id), data, roleDescription: m.roleDescription, canDrag: props.canDrag });
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
    const c = msg().shell.course.deleteConfirm;
    const ok = await confirmDialog({
      title: c.title(course.title),
      message: lectures.length > 0 ? c.lecturesKept(lectures.length) : c.empty,
      confirmLabel: c.confirmLabel,
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
      aria-label={m.label(course.title)}
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
          label={m.move(course.title)}
          setRef={item.setActivatorNodeRef}
          listeners={item.listeners}
          attributes={item.attributes}
          disabled={!props.canDrag}
        />
        {editing ? (
          <>
            <Chevron className="collapse-chevron is-static" />
            <Folder className="course-icon" />
            <RenameInput
              initial={course.title}
              label={m.nameLabel}
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
              <Folder className="course-icon" />
              <span className="course-title-text">{course.title}</span>
            </button>
            {!compact && (
              <button
                type="button"
                className="icon-btn tiny rename-btn"
                onClick={() => setEditing(true)}
                title={m.rename}
                aria-label={m.renameLabel(course.title)}
              >
                <Pencil />
              </button>
            )}
          </>
        )}
        <span className="course-count">{m.lectureCount(lectures.length)}</span>
        {shownCollapsed && !compact && <CourseSummaryBadges lectures={lectures} uploads={uploads.length} />}
        {mark === 'into' && shownCollapsed && (
          <span className="drop-into-label" aria-hidden>
            {m.dropAtEnd}
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
                title={props.canDigest ? m.makeDigestsTitle : m.noLlm}
              >
                <NotebookPen />{' '}
                {m.makeDigests(<span className="hide-narrow">{m.makeDigestsWide}</span>, withoutDigest.length)}
              </button>
            )}
            <a
              className="ghost-btn small"
              href={courseSummaryUrl(course.id)}
              target="_blank"
              rel="noreferrer"
              title={m.summaryTitle}
            >
              <FileText /> COURSE.md
            </a>
            <button type="button" className="ghost-btn small" onClick={props.onPickFiles} title={m.addLectureTitle}>
              {m.addLecture}
            </button>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => void confirmDelete()}
              title={m.deleteTitle}
              aria-label={m.deleteLabel(course.title)}
            >
              <Trash />
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
                  onRename={(title) => props.onRenameDoc(d.id, title)}
                  onDelete={props.onDeleteDoc}
                />
              ))}
              {uploads.map((u) => (
                <li key={`up-${u.id}`} className="lecture-row is-uploading">
                  <span className="lecture-index">…</span>
                  <div className="lecture-main">
                    <div className="doc-title">{u.name}</div>
                    <div className="doc-sub">{msg().shell.library.uploading(Math.round(u.fraction * 100), formatBytes(u.size))}</div>
                    <ProgressBar fraction={u.fraction} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <button type="button" className="course-empty" onClick={props.onPickFiles}>
              {drag.active?.kind === 'lecture' ? m.dropToJoin : m.empty}
            </button>
          )}
        </div>
      )}

      {over && (
        <div className="course-drop-hint" aria-hidden>
          <span>
            <FileText /> {m.dropPdf(course.title)}
          </span>
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
        <GripVertical />
      </span>
      <Folder className="course-icon" />
      <span className="drag-ghost-title">{course.title}</span>
      <span className="course-count">{msg().shell.course.lectureCount(lectures)}</span>
    </div>
  );
}
