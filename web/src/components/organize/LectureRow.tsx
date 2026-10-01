import { FileUp, Folder, GripVertical, Hourglass, Mic, Pencil, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { DocMeta } from '../../../../shared/types.ts';
import { thumbUrl } from '../../api.ts';
import { msg } from '../../i18n/index.ts';
import { formatDate } from '../../lib/format.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import type { LayoutEntry } from '../../lib/libraryLayout.ts';
import { useNewVersionPicker } from '../NewVersionDialog.tsx';
import { RecordingUploadBadge, useRecordingUploadPicker } from '../recording/RecordingUploads.tsx';
import { SlideImage } from '../SlideImage.tsx';
import { dropMarkClass, useDropMark, useOrgItem } from './LibraryDnd.tsx';
import { DigestBadge, DocProgress, DragHandle, FailedDocActions, RenameInput } from './parts.tsx';
import { PopoverMenu, type MenuSection } from './PopoverMenu.tsx';

interface LectureRowProps {
  doc: DocMeta;
  /** 1-based position in the course. */
  index: number;
  courseId: string;
  /** Every course in layout order (the "과목으로 이동" entries). */
  entries: LayoutEntry[];
  onOpen: (docId: string) => void;
  /** Move the lecture to the end of another course, or out of its course (null). */
  onMove: (courseId: string | null) => void;
  onRetry: (docId: string) => void;
  /** A new title from 이름 바꾸기 (only when it changed). */
  onRename: (title: string) => void;
  onDelete: (doc: DocMeta) => void;
}

/** One lecture of a course: ≡ handle, number, thumbnail + title (opens it; an input while it is renamed), "⋯" menu. */
export function LectureRow({ doc, index, courseId, entries, onOpen, onMove, onRetry, onRename, onDelete }: LectureRowProps) {
  const [renaming, setRenaming] = useState(false);
  const m = msg().shell.lecture;
  const lib = msg().shell.library;
  const data: DropData = { role: 'lecture', docId: doc.id, courseId };
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useOrgItem({
    id: dndId.lecture(doc.id),
    data,
    roleDescription: m.roleDescription,
  });
  const mark = useDropMark(dndId.lecture(doc.id));
  const ready = doc.status === 'ready';
  const pickRecording = useRecordingUploadPicker();
  const pickNewVersion = useNewVersionPicker();

  const sections: MenuSection[] = [
    {
      items: [
        {
          key: 'rename',
          label: msg().common.rename,
          icon: Pencil,
          onSelect: () => setRenaming(true),
        },
        ...(ready && pickRecording
          ? [
              {
                key: 'recording',
                label: m.uploadRecording,
                icon: Mic,
                hint: m.uploadRecordingHint,
                onSelect: () => pickRecording(doc),
              },
            ]
          : []),
        ...(ready && pickNewVersion
          ? [
              {
                key: 'new-version',
                label: msg().versions.menu,
                icon: FileUp,
                hint: msg().versions.menuHint,
                onSelect: () => pickNewVersion(doc),
              },
            ]
          : []),
      ],
    },
    {
      items: [
        {
          key: 'remove',
          label: m.removeFromCourse,
          hint: m.removeFromCourseHint,
          onSelect: () => onMove(null),
        },
      ],
    },
    {
      heading: m.moveToCourse,
      items: entries
        .filter((e) => e.course.id !== courseId)
        .map((e) => ({
          key: e.course.id,
          label: e.course.title,
          icon: Folder,
          hint: e.group?.title,
          onSelect: () => onMove(e.course.id),
        })),
    },
  ];

  return (
    <li
      ref={setNodeRef}
      data-drag-node=""
      data-org-key={dndId.lecture(doc.id)}
      className={`lecture-row status-${doc.status}${isDragging ? ' is-drag-source' : ''}${dropMarkClass(mark)}`}
    >
      <DragHandle label={m.move(doc.title)} setRef={setActivatorNodeRef} listeners={listeners} attributes={attributes} />
      <span className="lecture-index">{index}</span>
      {renaming ? (
        // Not inside the opening button (an input cannot sit in a button): the same look, nothing opens.
        <div className="lecture-open is-renaming">
          <LectureThumb doc={doc} />
          <span className="lecture-main">
            <RenameInput
              initial={doc.title}
              label={m.nameLabel}
              maxLength={200}
              className="course-title-input doc-title-input"
              onDone={(title) => {
                setRenaming(false);
                if (title && title !== doc.title) onRename(title);
              }}
            />
            <span className="doc-sub">{m.renameKeys}</span>
          </span>
        </div>
      ) : (
        <button type="button" className="lecture-open" onClick={() => onOpen(doc.id)} title={m.open}>
          <LectureThumb doc={doc} />
          <span className="lecture-main">
            <span className="doc-title">{doc.title}</span>
            <span className="doc-sub">
              {ready ? lib.slideCount(doc.pageCount) : doc.status === 'error' ? m.failed : m.converting} · {formatDate(doc.createdAt)}
              <DigestBadge status={doc.digestStatus} />
              <RecordingUploadBadge docId={doc.id} />
            </span>
            {doc.status === 'processing' && <DocProgress doc={doc} compact />}
            {doc.status === 'error' && <span className="doc-error">{doc.error ?? lib.processingError}</span>}
          </span>
        </button>
      )}
      <div className="lecture-actions">
        {doc.status === 'error' && <FailedDocActions doc={doc} onRetry={onRetry} onDelete={onDelete} />}
        <PopoverMenu label={m.menu(doc.title)} sections={sections} />
      </div>
    </li>
  );
}

function LectureThumb({ doc }: { doc: DocMeta }) {
  return (
    <span className="lecture-thumb" style={{ aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9 }}>
      {doc.status === 'ready' ? (
        <SlideImage docId={doc.id} slide={1} src={thumbUrl(doc.id, 1)} alt="" draggable={false} />
      ) : doc.status === 'error' ? (
        <TriangleAlert />
      ) : (
        <Hourglass />
      )}
    </span>
  );
}

/** What follows the pointer while a lecture is dragged (from a course or from 미분류). */
export function LectureGhost({ doc }: { doc: DocMeta }) {
  return (
    <div className="drag-ghost lecture-ghost">
      <span className="drag-ghost-handle" aria-hidden>
        <GripVertical />
      </span>
      <LectureThumb doc={doc} />
      <span className="lecture-main">
        <span className="doc-title">{doc.title}</span>
        <span className="doc-sub">{doc.status === 'ready' ? msg().shell.library.slideCount(doc.pageCount) : doc.fileName}</span>
      </span>
    </div>
  );
}
