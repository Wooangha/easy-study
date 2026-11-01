import { useDroppable } from '@dnd-kit/core';
import { useId, useState, type ReactNode } from 'react';
import { Folder, Folders, GripVertical, Pencil, Trash } from 'lucide-react';
import type { Course, CourseGroup } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { collapseKey, type LayoutRow } from '../../lib/libraryLayout.ts';
import { isHeaderToggleClick, isToggleClick } from './CourseCard.tsx';
import { dropMarkClass, useDragState, useDropMark, useOrgItem } from './LibraryDnd.tsx';
import { Chevron, DragHandle, NewTitleForm, RenameInput } from './parts.tsx';

interface GroupCardProps {
  group: CourseGroup;
  /** The group it is in (null = top level). */
  parentId: string | null;
  /** What it holds (courses and groups), in order. */
  rows: LayoutRow[];
  /** "그룹 2개 · 과목 7개": its groups and the courses in it at any depth. */
  contents: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Open (expand) the group, e.g. to show the new-course form. */
  onExpand: () => void;
  canDrag: boolean;
  renderRow: (row: LayoutRow) => ReactNode;
  onRename: (title: string) => void;
  onDelete: () => void;
  onCreateCourse: (title: string) => Promise<Course | null>;
  onCreateGroup: (title: string) => Promise<CourseGroup | null>;
}

/**
 * A group (e.g. a semester): header (≡, chevron + title, rename, contents, ＋ 과목, ＋ 그룹, delete) and what it holds —
 * courses and groups (0.6.15), rendered by `renderRow` (a group inside is a GroupCard again).
 */
export function GroupCard({ group, parentId, rows, contents, collapsed, onToggle, onExpand, canDrag, renderRow, ...props }: GroupCardProps) {
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState<'course' | 'group' | null>(null);
  const bodyId = useId();
  const drag = useDragState();
  const key = collapseKey.group(group.id);
  const m = msg().shell.group;
  // The dragged group shows only its header (nothing can go inside itself).
  const compact = drag.active?.kind === 'group' && drag.active.groupId === group.id;
  const shownCollapsed = compact || (collapsed && !drag.springOpen.has(key));
  const placing = drag.active?.kind === 'course' || drag.active?.kind === 'group';

  const data: DropData = { role: 'group', groupId: group.id, parentId };
  const item = useOrgItem({ id: dndId.group(group.id), data, roleDescription: m.roleDescription, canDrag });
  const headData: DropData = { role: 'group-head', groupId: group.id };
  const head = useDroppable({ id: dndId.groupHead(group.id), data: headData });
  const bodyData: DropData = { role: 'group-body', groupId: group.id };
  const body = useDroppable({ id: dndId.groupBody(group.id), data: bodyData, disabled: shownCollapsed });
  const mark = useDropMark(dndId.group(group.id));

  const confirmDelete = async () => {
    const c = msg().shell.group.deleteConfirm;
    const groups = rows.filter((row) => row.type === 'group').length;
    const courses = rows.length - groups;
    const ok = await confirmDialog({
      title: c.title(group.title),
      message: groups > 0 ? c.itemsKept(groups, courses) : courses > 0 ? c.coursesKept(courses) : c.empty,
      confirmLabel: c.confirmLabel,
      danger: true,
    });
    if (ok) props.onDelete();
  };

  const className =
    'group-card' +
    (shownCollapsed ? ' is-collapsed' : '') +
    (item.isDragging ? ' is-drag-source' : '') +
    dropMarkClass(mark);

  return (
    <section
      ref={item.setNodeRef}
      data-drag-node=""
      data-org-key={dndId.group(group.id)}
      className={className}
      aria-label={m.label(group.title)}
    >
      <header
        ref={head.setNodeRef}
        className="group-head"
        onClick={(e) => {
          if (!compact && isHeaderToggleClick(e)) onToggle();
        }}
      >
        <DragHandle
          label={m.move(group.title)}
          setRef={item.setActivatorNodeRef}
          listeners={item.listeners}
          attributes={item.attributes}
          disabled={!canDrag}
        />
        {editing ? (
          <>
            <Chevron className="collapse-chevron is-static" />
            <Folders className="course-icon" />
            <RenameInput
              initial={group.title}
              label={m.nameLabel}
              onDone={(title) => {
                setEditing(false);
                if (title && title !== group.title) props.onRename(title);
              }}
            />
          </>
        ) : (
          <>
            <button
              type="button"
              className="collapse-toggle group-toggle"
              aria-expanded={!shownCollapsed}
              aria-controls={shownCollapsed ? undefined : bodyId}
              disabled={compact}
              onClick={(e) => {
                if (isToggleClick(e)) onToggle();
              }}
            >
              <Chevron />
              <Folders className="course-icon" />
              <span className="course-title-text">{group.title}</span>
            </button>
            {!compact && (
              <button
                type="button"
                className="icon-btn tiny rename-btn"
                onClick={() => setEditing(true)}
                title={m.rename}
                aria-label={m.renameLabel(group.title)}
              >
                <Pencil />
              </button>
            )}
          </>
        )}
        <span className="course-count">{contents}</span>
        {mark === 'into' && shownCollapsed && (
          <span className="drop-into-label" aria-hidden>
            {/* A lecture only opens the group (its courses are the places); a course goes to its end. */}
            {drag.active?.kind === 'lecture' ? m.opensSoon : m.dropAtEnd}
          </span>
        )}
        <span className="spacer" />
        {!compact && (
          <div className="course-actions">
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => {
                onExpand();
                setCreating('course');
              }}
              title={m.newCourseTitle}
            >
              {m.newCourse}
            </button>
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => {
                onExpand();
                setCreating('group');
              }}
              title={m.newGroupTitle}
            >
              {m.newGroup}
            </button>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => void confirmDelete()}
              title={m.deleteTitle}
              aria-label={m.deleteLabel(group.title)}
            >
              <Trash />
            </button>
          </div>
        )}
      </header>

      {!shownCollapsed && (
        <div id={bodyId} ref={body.setNodeRef} className="group-body">
          {rows.map((row) => renderRow(row))}
          {creating === 'course' && (
            <NewTitleForm
              icon={Folder}
              placeholder={msg().shell.library.coursePlaceholder}
              label={m.newCourseName(group.title)}
              onCancel={() => setCreating(null)}
              onCreate={async (title) => {
                if (await props.onCreateCourse(title)) setCreating(null);
              }}
            />
          )}
          {creating === 'group' && (
            <NewTitleForm
              icon={Folders}
              placeholder={msg().shell.library.groupPlaceholder}
              label={m.newGroupName(group.title)}
              onCancel={() => setCreating(null)}
              onCreate={async (title) => {
                if (await props.onCreateGroup(title)) setCreating(null);
              }}
            />
          )}
          {rows.length === 0 && !creating && (
            <p className={`group-empty${placing ? ' is-target' : ''}`}>{placing ? m.dropToJoin : m.empty(<GripVertical />)}</p>
          )}
        </div>
      )}
    </section>
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
