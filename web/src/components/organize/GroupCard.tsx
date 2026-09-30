import { useDroppable } from '@dnd-kit/core';
import { useId, useState, type ReactNode } from 'react';
import { Folder, Folders, GripVertical, Pencil, Trash } from 'lucide-react';
import type { Course, CourseGroup } from '../../../../shared/types.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { withParticle } from '../../lib/korean.ts';
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
  // While a group is dragged every group shows only its header.
  const compact = drag.active?.kind === 'group';
  const shownCollapsed = compact || (collapsed && !drag.springOpen.has(key));

  const data: DropData = { role: 'group', groupId: group.id };
  const item = useOrgItem({ id: dndId.group(group.id), data, roleDescription: '옮길 수 있는 그룹', canDrag });
  const headData: DropData = { role: 'group-head', groupId: group.id };
  const head = useDroppable({ id: dndId.groupHead(group.id), data: headData });
  const bodyData: DropData = { role: 'group-body', groupId: group.id };
  const body = useDroppable({ id: dndId.groupBody(group.id), data: bodyData, disabled: shownCollapsed });
  const mark = useDropMark(dndId.group(group.id));

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `그룹 ${withParticle(`‘${group.title}’`, '을', '를')} 삭제할까요?`,
      message:
        courses.length > 0
          ? `안에 있는 과목 ${courses.length}개와 강의는 지워지지 않고, 그룹이 있던 자리에 그대로 남아요.`
          : '비어 있는 그룹이에요.',
      confirmLabel: '그룹 삭제',
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
      aria-label={`그룹 ${group.title}`}
    >
      <header
        ref={head.setNodeRef}
        className="group-head"
        onClick={(e) => {
          if (!compact && isHeaderToggleClick(e)) onToggle();
        }}
      >
        <DragHandle
          label={`‘${group.title}’ 그룹 옮기기`}
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
              label="그룹 이름"
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
                title="그룹 이름 바꾸기"
                aria-label={`‘${group.title}’ 그룹 이름 바꾸기`}
              >
                <Pencil />
              </button>
            )}
          </>
        )}
        <span className="course-count">과목 {courses.length}개</span>
        {mark === 'into' && shownCollapsed && (
          <span className="drop-into-label" aria-hidden>
            {/* A lecture only opens the group (its courses are the places); a course goes to its end. */}
            {drag.active?.kind === 'lecture' ? '잠시 기다리면 열려요' : '놓으면 이 그룹 끝에 추가'}
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
              title="이 그룹 안에 새 과목 만들기"
            >
              ＋ 과목
            </button>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => void confirmDelete()}
              title="그룹 삭제 (과목과 강의는 남아요)"
              aria-label={`‘${group.title}’ 그룹 삭제`}
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
              placeholder="과목 이름 (예: Compiler)"
              label={`‘${group.title}’ 그룹에 만들 과목 이름`}
              onCancel={() => setCreating(false)}
              onCreate={async (title) => {
                if (await props.onCreateCourse(title)) setCreating(false);
              }}
            />
          )}
          {courses.length === 0 && !creating && (
            <p className={`group-empty${drag.active?.kind === 'course' ? ' is-target' : ''}`}>
              {drag.active?.kind === 'course' ? (
                '여기에 놓으면 이 그룹에 들어가요'
              ) : (
                <>
                  비어 있는 그룹이에요 — 과목의 <GripVertical /> 손잡이를 끌어다 놓거나 ‘＋ 과목’으로 만드세요
                </>
              )}
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
      <span className="course-count">과목 {group.courseIds.length}개</span>
    </div>
  );
}
