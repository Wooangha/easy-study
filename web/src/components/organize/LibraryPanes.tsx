// The library's right column (DESIGN §18, 0.6.15): the chosen course — where it is, its name, COURSE.md, ＋ 강의 추가,
// ＋ 단원 추가 and its ⋯ menu, then its lectures (LectureRow: the first slide, "3. title", slide count and upload date,
// 정리본, ⋯), in its units when it has some (CourseUnits.tsx) — or 미분류. A PDF dropped on it is added there.
import { useDroppable } from '@dnd-kit/core';
import { useState, type DragEvent, type ReactNode } from 'react';
import { FileText, Folder, Inbox, ListPlus, ListTree, NotebookPen, Pencil, Plus, Trash, Upload } from 'lucide-react';
import type { Course, CourseGroup, DocMeta } from '../../../../shared/types.ts';
import { courseSummaryUrl } from '../../api.ts';
import type { UploadItem } from '../../hooks/useDocs.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { formatBytes } from '../../lib/format.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { collapseKey, type LayoutEntry } from '../../lib/libraryLayout.ts';
import { UnitSection } from './CourseUnits.tsx';
import { LectureRow } from './LectureRow.tsx';
import { useDragState } from './LibraryDnd.tsx';
import { CourseSummaryBadges, NewTitleForm, ProgressBar, RenameInput } from './parts.tsx';
import { PopoverMenu } from './PopoverMenu.tsx';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

/** Ready lectures without a finished (or running) 정리본 — their summaries are missing from the course context. */
function lecturesWithoutDigest(lectures: DocMeta[]): DocMeta[] {
  return lectures.filter((d) => d.status === 'ready' && d.digestStatus !== 'ready' && d.digestStatus !== 'running');
}

interface LectureHandlers {
  entries: LayoutEntry[];
  onOpen: (docId: string) => void;
  onMoveLecture: (docId: string, courseId: string | null) => void;
  onRetryDoc: (docId: string) => void;
  onRenameDoc: (docId: string, title: string) => void;
  onDeleteDoc: (doc: DocMeta) => void;
}

/** The units (단원) of the shown course. */
export interface UnitHandlers {
  /** Collapsed keys (collapseKey.unit among them). */
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** A new unit at the end (the first one takes the course's lectures). */
  onCreate: (title: string) => void;
  onRename: (unitId: string, title: string) => void;
  onDelete: (unitId: string) => void;
  /** Move a lecture of the course into a unit (null: out of its unit). */
  onMoveLecture: (docId: string, unitId: string | null) => void;
}

/** A pane that takes PDFs dropped from the file manager (`onFiles`), with a hint while they are over it. */
function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); // handled here: the window-level drop listener ignores it
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
  };
}

function UploadRows({ uploads }: { uploads: UploadItem[] }) {
  return uploads.map((u) => (
    <li key={`up-${u.id}`} className="lecture-row is-uploading">
      <span className="drag-handle-space" aria-hidden />
      <div className="lecture-open">
        <span className="lecture-thumb" />
        <span className="lecture-main">
          <span className="doc-title">{u.name}</span>
          <span className="doc-sub">{msg().shell.library.uploading(Math.round(u.fraction * 100), formatBytes(u.size))}</span>
          <ProgressBar fraction={u.fraction} />
        </span>
      </div>
    </li>
  ));
}

export function CoursePane({
  course,
  path,
  lectures,
  uploads,
  handlers,
  units,
  onPickFiles,
  onDropFiles,
  onRename,
  onDelete,
  canDigest,
  onDigestLectures,
  treeToggle,
}: {
  course: Course;
  /** The groups it is in, outermost first. */
  path: CourseGroup[];
  /** Its lectures that exist, in course order. */
  lectures: DocMeta[];
  uploads: UploadItem[];
  handlers: LectureHandlers;
  units: UnitHandlers;
  onPickFiles: () => void;
  onDropFiles: (files: File[]) => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  canDigest: boolean;
  onDigestLectures: (docs: DocMeta[]) => void;
  /** Phones: the button that shows the tree. */
  treeToggle: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [addingUnit, setAddingUnit] = useState(false);
  const m = msg().shell.course;
  const u = msg().shell.unit;
  const drag = useDragState();
  const files = useFileDrop(onDropFiles);
  const body = useDroppable({ id: dndId.courseBody(course.id), data: { role: 'course-body', courseId: course.id } satisfies DropData });
  const withoutDigest = lecturesWithoutDigest(lectures);

  const confirmDelete = async () => {
    const c = m.deleteConfirm;
    const ok = await confirmDialog({
      title: c.title(course.title),
      message: lectures.length > 0 ? c.lecturesKept(lectures.length) : c.empty,
      confirmLabel: c.confirmLabel,
      danger: true,
    });
    if (ok) onDelete();
  };

  return (
    <section className={`lib-pane${files.over ? ' is-files-over' : ''}`} aria-label={m.label(course.title)} {...files.props}>
      <div className="pane-crumb">
        {treeToggle}
        {path.length > 0 && <span>{path.map((g) => g.title).join(' › ')}</span>}
      </div>
      <div className="pane-head">
        <Folder className="pane-icon" />
        {editing ? (
          <RenameInput
            initial={course.title}
            label={m.nameLabel}
            className="pane-title-input"
            onDone={(title) => {
              setEditing(false);
              if (title && title !== course.title) onRename(title);
            }}
          />
        ) : (
          <h1 className="pane-title">{course.title}</h1>
        )}
        <span className="spacer" />
        <div className="pane-actions">
          <a className="ghost-btn" href={courseSummaryUrl(course.id)} target="_blank" rel="noreferrer" title={m.summaryTitle}>
            <FileText /> <span className="hide-narrow">COURSE.md</span>
          </a>
          <button type="button" className="ghost-btn" onClick={onPickFiles} title={m.addLectureTitle}>
            <Plus /> <span className="hide-narrow">{m.addLectureShort}</span>
          </button>
          <button type="button" className="ghost-btn" onClick={() => setAddingUnit(true)} title={u.addTitle}>
            <ListPlus /> <span className="hide-narrow">{u.add}</span>
          </button>
          <PopoverMenu
            label={m.menu(course.title)}
            sections={[
              {
                items: [
                  { key: 'rename', label: msg().common.rename, icon: Pencil, onSelect: () => setEditing(true) },
                  ...(withoutDigest.length > 0 && canDigest
                    ? [
                        {
                          key: 'digests',
                          label: m.makeDigestsItem(withoutDigest.length),
                          icon: NotebookPen,
                          hint: m.makeDigestsHint,
                          onSelect: () => onDigestLectures(withoutDigest),
                        },
                      ]
                    : []),
                ],
              },
              { items: [{ key: 'delete', label: m.deleteItem, icon: Trash, danger: true, onSelect: () => void confirmDelete() }] },
            ]}
          />
        </div>
      </div>
      <div className="pane-sub">
        <span>{m.lectureCount(lectures.length)}</span>
        <CourseSummaryBadges lectures={lectures} uploads={uploads.length} />
      </div>
      {course.units.length > 0 || addingUnit ? (
        <UnitList
          course={course}
          lectures={lectures}
          uploads={uploads}
          handlers={handlers}
          units={units}
          setBodyRef={body.setNodeRef}
          newUnit={
            addingUnit && (
              <li className="unit-create">
                <NewTitleForm
                  icon={ListTree}
                  placeholder={u.newName}
                  label={u.newName}
                  onCancel={() => setAddingUnit(false)}
                  onCreate={async (title) => {
                    setAddingUnit(false);
                    units.onCreate(title);
                  }}
                />
              </li>
            )
          }
        />
      ) : lectures.length > 0 || uploads.length > 0 ? (
        <ol ref={body.setNodeRef} className="lecture-list">
          {lectures.map((d, i) => (
            <LectureRow
              key={d.id}
              doc={d}
              index={i + 1}
              courseId={course.id}
              entries={handlers.entries}
              onOpen={handlers.onOpen}
              onMove={(to) => handlers.onMoveLecture(d.id, to)}
              onRetry={handlers.onRetryDoc}
              onRename={(title) => handlers.onRenameDoc(d.id, title)}
              onDelete={handlers.onDeleteDoc}
            />
          ))}
          <UploadRows uploads={uploads} />
        </ol>
      ) : (
        <button ref={body.setNodeRef} type="button" className="pane-empty" onClick={onPickFiles}>
          <Upload /> {drag.active?.kind === 'lecture' ? m.dropToJoin : m.empty}
        </button>
      )}
      {files.over && (
        <div className="pane-drop-hint" aria-hidden>
          <span>
            <FileText /> {m.dropPdf(course.title)}
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * The lectures of a course with units: those in no unit first (no header), then each unit (UnitSection), uploads at
 * the end. `newUnit` (the name form of a unit being added) shows where the unit will be: at the top when it is the
 * course's first (it takes the lectures), else at the end.
 */
function UnitList({
  course,
  lectures,
  uploads,
  handlers,
  units,
  setBodyRef,
  newUnit,
}: {
  course: Course;
  lectures: DocMeta[];
  uploads: UploadItem[];
  handlers: LectureHandlers;
  units: UnitHandlers;
  setBodyRef: (el: HTMLElement | null) => void;
  newUnit: ReactNode;
}) {
  const byId = new Map(lectures.map((d) => [d.id, d]));
  const numberOf = new Map(lectures.map((d, i) => [d.id, i + 1]));
  const inUnits = new Set(course.units.flatMap((unit) => unit.docIds));
  const loose = lectures.filter((d) => !inUnits.has(d.id));
  const first = course.units.length === 0;
  const row = (d: DocMeta, unitId: string | null) => (
    <LectureRow
      key={d.id}
      doc={d}
      index={numberOf.get(d.id)}
      courseId={course.id}
      unitId={unitId}
      units={course.units}
      onMoveToUnit={(to) => units.onMoveLecture(d.id, to)}
      entries={handlers.entries}
      onOpen={handlers.onOpen}
      onMove={(to) => handlers.onMoveLecture(d.id, to)}
      onRetry={handlers.onRetryDoc}
      onRename={(title) => handlers.onRenameDoc(d.id, title)}
      onDelete={handlers.onDeleteDoc}
    />
  );
  return (
    <ol ref={setBodyRef} className="unit-list">
      {first && newUnit}
      {loose.length > 0 && (
        <li className="unit-loose">
          <ol className="lecture-list">{loose.map((d) => row(d, null))}</ol>
        </li>
      )}
      {course.units.map((unit, i) => {
        const own = unit.docIds.map((id) => byId.get(id)).filter((d): d is DocMeta => d !== undefined);
        const key = collapseKey.unit(course.id, unit.id);
        return (
          <UnitSection
            key={unit.id}
            courseId={course.id}
            unit={unit}
            above={course.units[i - 1] ?? null}
            count={own.length}
            collapsed={units.collapsed.has(key)}
            onToggle={() => units.onToggle(key)}
            onRename={(title) => units.onRename(unit.id, title)}
            onDelete={() => units.onDelete(unit.id)}
          >
            {own.map((d) => row(d, unit.id))}
          </UnitSection>
        );
      })}
      {!first && newUnit}
      {uploads.length > 0 && (
        <li className="unit-loose">
          <ol className="lecture-list">
            <UploadRows uploads={uploads} />
          </ol>
        </li>
      )}
    </ol>
  );
}

/** 미분류 (with no course at all: 내 강의): the lectures in no course; with none, the first-run drop zone. */
export function UncategorizedPane({
  docs,
  uploads,
  hasCourses,
  handlers,
  onPickFiles,
  onDropFiles,
  treeToggle,
  libraryEmpty,
}: {
  docs: DocMeta[];
  uploads: UploadItem[];
  hasCourses: boolean;
  handlers: LectureHandlers;
  onPickFiles: () => void;
  onDropFiles: (files: File[]) => void;
  treeToggle: ReactNode;
  /** No lecture anywhere yet. */
  libraryEmpty: boolean;
}) {
  const m = msg().shell.library;
  const files = useFileDrop(onDropFiles);
  const title = hasCourses ? m.uncategorized : m.myDocs;
  return (
    <section className={`lib-pane${files.over ? ' is-files-over' : ''}`} aria-label={hasCourses ? m.uncategorizedLabel : m.myDocs} {...files.props}>
      <div className="pane-crumb">{treeToggle}</div>
      <div className="pane-head">
        <Inbox className="pane-icon" />
        <h1 className="pane-title">{title}</h1>
        <span className="spacer" />
        <div className="pane-actions">
          <button type="button" className="ghost-btn" onClick={onPickFiles}>
            <Upload /> <span className="hide-narrow">{m.uploadPdf}</span>
          </button>
        </div>
      </div>
      {docs.length > 0 && hasCourses && <div className="pane-sub">{m.uncategorizedTipShort}</div>}
      {docs.length > 0 || uploads.length > 0 ? (
        <ol className="lecture-list">
          {docs.map((d) => (
            <LectureRow
              key={d.id}
              doc={d}
              courseId={null}
              unitId={null}
              entries={handlers.entries}
              onOpen={handlers.onOpen}
              onMove={(to) => handlers.onMoveLecture(d.id, to)}
              onRetry={handlers.onRetryDoc}
              onRename={(title) => handlers.onRenameDoc(d.id, title)}
              onDelete={handlers.onDeleteDoc}
            />
          ))}
          <UploadRows uploads={uploads} />
        </ol>
      ) : (
        <button type="button" className={libraryEmpty ? 'dropzone' : 'pane-empty'} onClick={onPickFiles}>
          {libraryEmpty ? (
            <>
              <FileText className="dropzone-icon" strokeWidth={1.5} />
              <span className="dropzone-title">{m.dropzoneTitle}</span>
              <span className="dropzone-sub">{m.dropzoneSub}</span>
            </>
          ) : (
            <>
              <Upload /> {m.uncategorizedEmpty}
            </>
          )}
        </button>
      )}
      {files.over && (
        <div className="pane-drop-hint" aria-hidden>
          <span>
            <FileText /> {m.dropHere(title)}
          </span>
        </div>
      )}
    </section>
  );
}
