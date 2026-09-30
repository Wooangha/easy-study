import { useDroppable } from '@dnd-kit/core';
import { useId, useState, type ReactNode } from 'react';
import { Folder, Folders, GripVertical, Pencil, Trash } from 'lucide-react';
import type { Course, CourseGroup } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { collapseKey } from '../../lib/libraryLayout.ts';
import { isHeaderToggleClick, isToggleClick } from './CourseCard.tsx';
import { dropMarkClass, useDragState, useDropMark, useOrgItem } from './LibraryDnd.tsx';
import { Chevron, DragHandle, NewTitleForm, RenameInput } from './parts.tsx';

interface GroupCardProps {
  group: CourseGroup;
  /** Its courses in order. */
  courses: Course[];
  collapsed: boolean;
  onToggle: () => void;
  /** Open (expand) the group, e.g. to show the new-course form. */
  onExpand: () => void;
  canDrag: boolean;
  renderCourse: (course: Course) => ReactNode;
  onRename: (title: string) => void;
  onDelete: () => void;
  onCreateCourse: (title: string) => Promise<Course | null>;
}

/** A group of courses (e.g. a semester): header (≡, chevron + title, rename, count, ＋ 과목, delete) and its courses. */
export function GroupCard({ group, courses, collapsed, onToggle, onExpand, canDrag, renderCourse, ...props }: GroupCardProps) {
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const bodyId = useId();
  const drag = useDragState();
  const key = collapseKey.group(group.id);
  const m = msg().shell.group;
  // While a group is dragged every group shows only its header.
  const compact = drag.active?.kind === 'group';
  const shownCollapsed = compact || (collapsed && !drag.springOpen.has(key));

  const data: DropData = { role: 'group', groupId: group.id };
  const item = useOrgItem({ id: dndId.group(group.id), data, roleDescription: m.roleDescription, canDrag });
  const headData: DropData = { role: 'group-head', groupId: group.id };
  const head = useDroppable({ id: dndId.groupHead(group.id), data: headData });
  const bodyData: DropData = { role: 'group-body', groupId: group.id };
  const body = useDroppable({ id: dndId.groupBody(group.id), data: bodyData, disabled: shownCollapsed });
  const mark = useDropMark(dndId.group(group.id));

  const confirmDelete = async () => {
    const c = msg().shell.group.deleteConfirm;
    const ok = await confirmDialog({
      title: c.title(group.title),
      message: courses.length > 0 ? c.coursesKept(courses.length) : c.empty,
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
        <span className="course-count">{m.courseCount(courses.length)}</span>
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
                setCreating(true);
              }}
              title={m.newCourseTitle}
            >
              {m.newCourse}
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
          {courses.map((c) => renderCourse(c))}
          {creating && (
            <NewTitleForm
              icon={Folder}
              placeholder={msg().shell.library.coursePlaceholder}
              label={m.newCourseName(group.title)}
              onCancel={() => setCreating(false)}
              onCreate={async (title) => {
                if (await props.onCreateCourse(title)) setCreating(false);
              }}
            />
          )}
          {courses.length === 0 && !creating && (
            <p className={`group-empty${drag.active?.kind === 'course' ? ' is-target' : ''}`}>
              {drag.active?.kind === 'course' ? m.dropToJoin : m.empty(<GripVertical />)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** What follows the pointer while a group is dragged. */
export function GroupGhost({ group }: { group: CourseGroup }) {
  return (
    <div className="drag-ghost group-ghost">
      <span className="drag-ghost-handle" aria-hidden>
        <GripVertical />
      </span>
      <Folders className="course-icon" />
      <span className="drag-ghost-title">{group.title}</span>
      <span className="course-count">{msg().shell.group.courseCount(group.courseIds.length)}</span>
    </div>
  );
}
