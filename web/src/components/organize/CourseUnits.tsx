// Units (단원) of a course in the library's course pane (DESIGN §18): a header — grip (on hover), chevron, name,
// lecture count, a rule, ⋯ — over the unit's lectures, or a dashed "drag lectures here" box when it has none. The
// header collapses the unit (per device). A unit is dragged by its header; lectures drop into it.
import { useDroppable } from '@dnd-kit/core';
import { GripVertical, Pencil, Trash } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { CourseUnit } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { dropMarkClass, rowGrab, useDropMark, useOrgItem } from './LibraryDnd.tsx';
import { Chevron, DragHandle, RenameInput, isToggleClick } from './parts.tsx';
import { PopoverMenu } from './PopoverMenu.tsx';

export interface UnitSectionProps {
  courseId: string;
  unit: CourseUnit;
  /** The unit above it (where its lectures go when it is deleted; null: it is the first). */
  above: CourseUnit | null;
  /** How many of its lectures are shown (the ones that exist). */
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** Its lecture rows (when it has any). */
  children: ReactNode;
}

export function UnitSection({ courseId, unit, above, count, collapsed, onToggle, onRename, onDelete, children }: UnitSectionProps) {
  const [editing, setEditing] = useState(false);
  const m = msg().shell.unit;
  const data: DropData = { role: 'unit', courseId, unitId: unit.id };
  const item = useOrgItem({ id: dndId.unit(courseId, unit.id), data, roleDescription: m.roleDescription });
  const head = useDroppable({
    id: dndId.unitHead(courseId, unit.id),
    data: { role: 'unit-head', courseId, unitId: unit.id } satisfies DropData,
  });
  const mark = useDropMark(dndId.unit(courseId, unit.id));

  const confirmDelete = async () => {
    if (count > 0) {
      const c = m.deleteConfirm;
      const ok = await confirmDialog({
        title: c.title(unit.title),
        message: c.lecturesKept(count, above?.title ?? null),
        confirmLabel: c.confirmLabel,
        danger: true,
      });
      if (!ok) return;
    }
    onDelete();
  };

  return (
    <li
      ref={item.setNodeRef}
      data-drag-node=""
      data-org-key={dndId.unit(courseId, unit.id)}
      className={`unit${collapsed ? ' is-collapsed' : ''}${item.isDragging ? ' is-drag-source' : ''}${dropMarkClass(mark)}`}
    >
      <div ref={head.setNodeRef} className="unit-head" {...rowGrab(item.listeners)}>
        <div className="unit-row">
          <DragHandle label={m.move(unit.title)} setRef={item.setActivatorNodeRef} listeners={item.listeners} attributes={item.attributes} />
          {editing ? (
            <RenameInput
              initial={unit.title}
              label={m.nameLabel}
              className="course-title-input unit-title-input"
              onDone={(title) => {
                setEditing(false);
                if (title && title !== unit.title) onRename(title);
              }}
            />
          ) : (
            <button
              type="button"
              className="unit-toggle"
              aria-expanded={!collapsed}
              title={`${unit.title} · ${m.lectureCount(count)}`}
              onClick={(e) => {
                if (isToggleClick(e)) onToggle();
              }}
            >
              <Chevron className="unit-chevron" />
              <span className="unit-name">{unit.title}</span>
              <span className="unit-count">{count}</span>
            </button>
          )}
          <span className="unit-rule" aria-hidden />
          <PopoverMenu
            label={m.menu(unit.title)}
            sections={[
              { items: [{ key: 'rename', label: msg().common.rename, icon: Pencil, onSelect: () => setEditing(true) }] },
              { items: [{ key: 'delete', label: m.deleteItem, icon: Trash, danger: true, onSelect: () => void confirmDelete() }] },
            ]}
          />
        </div>
      </div>
      {!collapsed && (count > 0 ? <ol className="lecture-list">{children}</ol> : <div className="unit-empty">{m.empty}</div>)}
    </li>
  );
}

/** What follows the pointer while a unit is dragged. */
export function UnitGhost({ unit, count }: { unit: CourseUnit; count: number }) {
  return (
    <div className="drag-ghost unit-ghost">
      <span className="drag-ghost-handle" aria-hidden>
        <GripVertical />
      </span>
      <span className="unit-name">{unit.title}</span>
      <span className="unit-count">{count}</span>
    </div>
  );
}
