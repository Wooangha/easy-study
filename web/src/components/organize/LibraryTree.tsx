// The library's left column (DESIGN §18, 0.6.15; the user chose it from mock-ups — "B-2가 좋은데"): the groups and
// courses as a tree, then 미분류. Choosing a course shows its lectures on the right (LibraryView) and makes it where
// new PDFs go. ≡ drags courses and groups as before (into a group by its row); a lecture dragged from the right and
// dropped on a course goes to the end of it, on 미분류 out of its course; a PDF dropped on a course is added to it.
import { useDroppable } from '@dnd-kit/core';
import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { Folder, FolderPlus, Folders, GripVertical, Inbox, Pencil, Trash } from 'lucide-react';
import type { Course, CourseGroup } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { collapseKey, type LayoutRow } from '../../lib/libraryLayout.ts';
import { dropMarkClass, useDragState, useDropMark, useOrgItem } from './LibraryDnd.tsx';
import { Chevron, DragHandle, NewTitleForm, RenameInput, isToggleClick } from './parts.tsx';
import { PopoverMenu } from './PopoverMenu.tsx';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
/** Rows are indented by their depth (`--depth`, CSS). */
const at = (depth: number) => ({ '--depth': depth }) as CSSProperties;

export interface TreeActions {
  /** The chosen course (null: 미분류). */
  selected: string | null;
  onSelect: (courseId: string | null) => void;
  lectureCount: (courseId: string) => number;
  /** "그룹 2개 · 과목 7개" of a group. */
  contentsOf: (groupId: string) => string;
  /** Collapsed groups (collapseKey.group). */
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onExpand: (key: string) => void;
  canDrag: boolean;
  onUploadToCourse: (courseId: string, files: File[]) => void;
  onCreateCourse: (title: string, groupId: string | null) => Promise<Course | null>;
  onCreateGroup: (title: string, parentId: string | null) => Promise<CourseGroup | null>;
  onRenameGroup: (groupId: string, title: string) => void;
  onDeleteGroup: (groupId: string) => void;
}

/** One row of the tree and what it holds, `depth` levels in. */
export function TreeRows({ rows, depth, actions }: { rows: LayoutRow[]; depth: number; actions: TreeActions }) {
  return rows.map((row) =>
    row.type === 'course' ? (
      <TreeCourse key={row.course.id} course={row.course} parentId={row.parentId} depth={depth} actions={actions} />
    ) : (
      <TreeGroup key={row.group.id} row={row} depth={depth} actions={actions} />
    ),
  );
}

function TreeGroup({ row, depth, actions }: { row: Extract<LayoutRow, { type: 'group' }>; depth: number; actions: TreeActions }) {
  const { group, children, parentId } = row;
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState<'course' | 'group' | null>(null);
  const drag = useDragState();
  const m = msg().shell.group;
  const key = collapseKey.group(group.id);
  // The dragged group shows only its row (nothing can go inside itself).
  const dragged = drag.active?.kind === 'group' && drag.active.groupId === group.id;
  const shownCollapsed = dragged || (actions.collapsed.has(key) && !drag.springOpen.has(key));

  const data: DropData = { role: 'group', groupId: group.id, parentId };
  const item = useOrgItem({ id: dndId.group(group.id), data, roleDescription: m.roleDescription, canDrag: actions.canDrag });
  const head = useDroppable({ id: dndId.groupHead(group.id), data: { role: 'group-head', groupId: group.id } satisfies DropData });
  const body = useDroppable({
    id: dndId.groupBody(group.id),
    data: { role: 'group-body', groupId: group.id } satisfies DropData,
    disabled: shownCollapsed,
  });
  const mark = useDropMark(dndId.group(group.id));

  const confirmDelete = async () => {
    const c = m.deleteConfirm;
    const groups = children.filter((r) => r.type === 'group').length;
    const courses = children.length - groups;
    const ok = await confirmDialog({
      title: c.title(group.title),
      message: groups > 0 ? c.itemsKept(groups, courses) : courses > 0 ? c.coursesKept(courses) : c.empty,
      confirmLabel: c.confirmLabel,
      danger: true,
    });
    if (ok) actions.onDeleteGroup(group.id);
  };
  const create = (what: 'course' | 'group') => {
    actions.onExpand(key);
    setCreating(what);
  };

  return (
    <li
      ref={item.setNodeRef}
      data-drag-node=""
      data-org-key={dndId.group(group.id)}
      className={`tree-item tree-group${item.isDragging ? ' is-drag-source' : ''}${dropMarkClass(mark)}`}
    >
      <div ref={head.setNodeRef} className="tree-row is-group" style={at(depth)}>
        <DragHandle
          label={m.move(group.title)}
          setRef={item.setActivatorNodeRef}
          listeners={item.listeners}
          attributes={item.attributes}
          disabled={!actions.canDrag}
        />
        {editing ? (
          <>
            <Folders className="tree-icon" />
            <RenameInput
              initial={group.title}
              label={m.nameLabel}
              className="tree-title-input"
              onDone={(title) => {
                setEditing(false);
                if (title && title !== group.title) actions.onRenameGroup(group.id, title);
              }}
            />
          </>
        ) : (
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={!shownCollapsed}
            title={`${group.title} · ${actions.contentsOf(group.id)}`}
            disabled={dragged}
            onClick={(e) => {
              if (isToggleClick(e)) actions.onToggle(key);
            }}
          >
            <Chevron className="tree-chevron" />
            <Folders className="tree-icon" />
            <span className="tree-name">{group.title}</span>
          </button>
        )}
        <PopoverMenu
          label={m.menu(group.title)}
          sections={[
            {
              items: [
                { key: 'course', label: m.addCourse, icon: Folder, onSelect: () => create('course') },
                { key: 'group', label: m.addGroup, icon: FolderPlus, onSelect: () => create('group') },
                { key: 'rename', label: msg().common.rename, icon: Pencil, onSelect: () => setEditing(true) },
              ],
            },
            { items: [{ key: 'delete', label: m.deleteItem, icon: Trash, danger: true, onSelect: () => void confirmDelete() }] },
          ]}
        />
      </div>
      {!shownCollapsed && (
        <ul ref={body.setNodeRef} className="tree-children">
          <TreeRows rows={children} depth={depth + 1} actions={actions} />
          {creating && (
            <li className="tree-create" style={at(depth + 1)}>
              <NewTitleForm
                icon={creating === 'course' ? Folder : Folders}
                placeholder={creating === 'course' ? msg().shell.library.coursePlaceholder : msg().shell.library.groupPlaceholder}
                label={creating === 'course' ? m.newCourseName(group.title) : m.newGroupName(group.title)}
                onCancel={() => setCreating(null)}
                onCreate={async (title) => {
                  const made =
                    creating === 'course' ? await actions.onCreateCourse(title, group.id) : await actions.onCreateGroup(title, group.id);
                  if (made) setCreating(null);
                }}
              />
            </li>
          )}
          {children.length === 0 && !creating && (
            <li className="tree-empty" style={at(depth + 1)}>
              {drag.active && drag.active.kind !== 'lecture' ? m.dropToJoin : m.emptyShort}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function TreeCourse({ course, parentId, depth, actions }: { course: Course; parentId: string | null; depth: number; actions: TreeActions }) {
  const [filesOver, setFilesOver] = useState(false);
  const m = msg().shell.course;
  const selected = actions.selected === course.id;
  const data: DropData = { role: 'course', courseId: course.id, groupId: parentId };
  const item = useOrgItem({ id: dndId.course(course.id), data, roleDescription: m.roleDescription, canDrag: actions.canDrag });
  // A lecture dropped on the row goes to the end of the course.
  const head = useDroppable({ id: dndId.courseHead(course.id), data: { role: 'course-head', courseId: course.id } satisfies DropData });
  const mark = useDropMark(dndId.course(course.id));
  const count = actions.lectureCount(course.id);

  return (
    <li
      ref={item.setNodeRef}
      data-drag-node=""
      data-org-key={dndId.course(course.id)}
      className={`tree-item tree-course${item.isDragging ? ' is-drag-source' : ''}${dropMarkClass(mark)}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setFilesOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFilesOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); // handled here: the window-level drop listener ignores it
        setFilesOver(false);
        actions.onUploadToCourse(course.id, Array.from(e.dataTransfer.files));
      }}
    >
      <div
        ref={head.setNodeRef}
        className={`tree-row is-course${selected ? ' is-selected' : ''}${filesOver ? ' is-files-over' : ''}`}
        style={at(depth)}
      >
        <DragHandle
          label={m.move(course.title)}
          setRef={item.setActivatorNodeRef}
          listeners={item.listeners}
          attributes={item.attributes}
          disabled={!actions.canDrag}
        />
        <button
          type="button"
          className="tree-select"
          aria-current={selected ? 'true' : undefined}
          title={filesOver ? m.dropPdf(course.title) : course.title}
          onClick={() => actions.onSelect(course.id)}
        >
          <span className="tree-chevron-space" aria-hidden />
          <Folder className="tree-icon" />
          <span className="tree-name">{course.title}</span>
          <span className="tree-count" aria-label={m.lectureCount(count)}>
            {count}
          </span>
        </button>
      </div>
    </li>
  );
}

/** 미분류: the lectures in no course. A lecture dropped here leaves its course. */
export function TreeUncategorized({ count, actions, label }: { count: number; actions: TreeActions; label: string }) {
  const { setNodeRef } = useDroppable({ id: dndId.uncategorized, data: { role: 'uncategorized' } satisfies DropData });
  const mark = useDropMark(dndId.uncategorized);
  const selected = actions.selected === null;
  return (
    <div ref={setNodeRef} className={`tree-item tree-uncategorized${mark === 'into' ? ' drop-into' : ''}`} data-org-key={dndId.uncategorized}>
      <div className={`tree-row is-course${selected ? ' is-selected' : ''}`} style={at(0)}>
        <span className="drag-handle-space" aria-hidden />
        <button type="button" className="tree-select" aria-current={selected ? 'true' : undefined} onClick={() => actions.onSelect(null)}>
          <span className="tree-chevron-space" aria-hidden />
          <Inbox className="tree-icon" />
          <span className="tree-name">{label}</span>
          <span className="tree-count">{count}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * The column: the heading, the tree, 미분류, ＋ 과목 / ＋ 그룹 at the top level. (No upload button: the pane's "＋ 강의 추가" /
 * "PDF 올리기" uploads into the same place, and a PDF dropped anywhere goes there too.)
 */
export function LibraryTree({
  rows,
  actions,
  uncategorizedCount,
  hasCourses,
  canCreate,
  canCreateGroup,
  saving,
  headingRef,
  notices,
  footer,
}: {
  rows: LayoutRow[];
  actions: TreeActions;
  uncategorizedCount: number;
  hasCourses: boolean;
  canCreate: boolean;
  canCreateGroup: boolean;
  saving: boolean;
  headingRef: string;
  /** Load errors of the courses or of the layout. */
  notices?: ReactNode;
  /** Below the tree (the bottom drop zone while a course or a group is dragged). */
  footer?: ReactNode;
}) {
  const [creating, setCreating] = useState<'course' | 'group' | null>(null);
  const m = msg().shell.library;
  return (
    <nav className="lib-side" aria-label={m.treeLabel}>
      <div className="lib-side-head">
        <h2 className="lib-side-heading" tabIndex={-1} data-org-key={headingRef}>
          {m.courses}
        </h2>
        {saving && (
          <span className="muted small" role="status">
            {m.saving}
          </span>
        )}
      </div>
      {notices}
      <ul className="tree">
        <TreeRows rows={rows} depth={0} actions={actions} />
        {creating && (
          <li className="tree-create" style={at(0)}>
            <NewTitleForm
              icon={creating === 'course' ? Folder : Folders}
              placeholder={creating === 'course' ? m.coursePlaceholder : m.groupPlaceholder}
              label={creating === 'course' ? m.newCourseName : m.newGroupName}
              onCancel={() => setCreating(null)}
              onCreate={async (title) => {
                const made = creating === 'course' ? await actions.onCreateCourse(title, null) : await actions.onCreateGroup(title, null);
                if (made) setCreating(null);
              }}
            />
          </li>
        )}
      </ul>
      {footer}
      {!hasCourses && !creating && <p className="lib-side-hint muted small">{m.courseHintShort}</p>}
      <TreeUncategorized count={uncategorizedCount} actions={actions} label={hasCourses ? m.uncategorized : m.myDocs} />
      <div className="lib-side-foot">
        <button type="button" className="ghost-btn small" onClick={() => setCreating('course')} disabled={!canCreate}>
          {m.newCourse}
        </button>
        <button type="button" className="ghost-btn small" onClick={() => setCreating('group')} disabled={!canCreateGroup} title={m.newGroupTitle}>
          {m.newGroup}
        </button>
      </div>
    </nav>
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

/** What follows the pointer while a group is dragged. */
export function GroupGhost({ group, contents }: { group: CourseGroup; contents: string }) {
  return (
    <div className="drag-ghost group-ghost">
      <span className="drag-ghost-handle" aria-hidden>
        <GripVertical />
      </span>
      <Folders className="course-icon" />
      <span className="drag-ghost-title">{group.title}</span>
      <span className="course-count">{contents}</span>
    </div>
  );
}
