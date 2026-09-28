import type { DocMeta } from '../../../../shared/types.ts';
import { thumbUrl } from '../../api.ts';
import { formatDate } from '../../lib/format.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import type { LayoutEntry } from '../../lib/libraryLayout.ts';
import { RecordingUploadBadge, useRecordingUploadPicker } from '../recording/RecordingUploads.tsx';
import { SlideImage } from '../SlideImage.tsx';
import { dropMarkClass, useDropMark, useOrgItem } from './LibraryDnd.tsx';
import { DigestBadge, DocProgress, DragHandle, FailedDocActions } from './parts.tsx';
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
  onDelete: (doc: DocMeta) => void;
}

/** One lecture of a course: ≡ handle, number, thumbnail + title (opens it), "⋯" menu. */
export function LectureRow({ doc, index, courseId, entries, onOpen, onMove, onRetry, onDelete }: LectureRowProps) {
  const data: DropData = { role: 'lecture', docId: doc.id, courseId };
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useOrgItem({
    id: dndId.lecture(doc.id),
    data,
    roleDescription: '옮길 수 있는 강의',
  });
  const mark = useDropMark(dndId.lecture(doc.id));
  const ready = doc.status === 'ready';
  const pickRecording = useRecordingUploadPicker();

  const sections: MenuSection[] = [
    ...(ready && pickRecording
      ? [{ items: [{ key: 'recording', label: '🎙 녹음 파일 올리기', hint: '음성·동영상', onSelect: () => pickRecording(doc) }] }]
      : []),
    {
      items: [
        { key: 'remove', label: '과목에서 빼기', hint: '미분류로', onSelect: () => onMove(null) },
      ],
    },
    {
      heading: '과목으로 이동',
      items: entries
        .filter((e) => e.course.id !== courseId)
        .map((e) => ({
          key: e.course.id,
          label: `📁 ${e.course.title}`,
          hint: e.group ? `🗂 ${e.group.title}` : undefined,
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
      <DragHandle
        label={`‘${doc.title}’ 강의 옮기기`}
        setRef={setActivatorNodeRef}
        listeners={listeners}
        attributes={attributes}
      />
      <span className="lecture-index">{index}</span>
      <button type="button" className="lecture-open" onClick={() => onOpen(doc.id)} title="이 강의 열기">
        <LectureThumb doc={doc} />
        <span className="lecture-main">
          <span className="doc-title">{doc.title}</span>
          <span className="doc-sub">
            {ready ? `${doc.pageCount}장` : doc.status === 'error' ? '처리 실패' : '변환 중'} · {formatDate(doc.createdAt)}
            <DigestBadge status={doc.digestStatus} />
            <RecordingUploadBadge docId={doc.id} />
          </span>
          {doc.status === 'processing' && <DocProgress doc={doc} compact />}
          {doc.status === 'error' && <span className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</span>}
        </span>
      </button>
      <div className="lecture-actions">
        {doc.status === 'error' && <FailedDocActions doc={doc} onRetry={onRetry} onDelete={onDelete} />}
        <PopoverMenu label={`‘${doc.title}’ 강의 메뉴`} sections={sections} />
      </div>
    </li>
  );
}

function LectureThumb({ doc }: { doc: DocMeta }) {
  return (
    <span className="lecture-thumb" style={{ aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9 }}>
      {doc.status === 'ready' ? (
        <SlideImage docId={doc.id} slide={1} src={thumbUrl(doc.id, 1)} alt="" draggable={false} />
      ) : (
        <span aria-hidden>{doc.status === 'error' ? '⚠️' : '⏳'}</span>
      )}
    </span>
  );
}

/** What follows the pointer while a lecture is dragged (from a course or from 미분류). */
export function LectureGhost({ doc }: { doc: DocMeta }) {
  return (
    <div className="drag-ghost lecture-ghost">
      <span className="drag-ghost-handle" aria-hidden>
        ≡
      </span>
      <LectureThumb doc={doc} />
      <span className="lecture-main">
        <span className="doc-title">{doc.title}</span>
        <span className="doc-sub">{doc.status === 'ready' ? `${doc.pageCount}장` : doc.fileName}</span>
      </span>
    </div>
  );
}
