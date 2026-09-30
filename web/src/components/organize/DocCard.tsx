import { Hourglass, Mic, Pencil, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { Course, DocMeta, LibraryLayout } from '../../../../shared/types.ts';
import { viewUrl } from '../../api.ts';
import { formatDate } from '../../lib/format.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { RecordingUploadBadge, useRecordingUploadPicker } from '../recording/RecordingUploads.tsx';
import { SlideImage } from '../SlideImage.tsx';
import { PopoverMenu } from './PopoverMenu.tsx';
import { useOrgItem } from './LibraryDnd.tsx';
import { CourseOptions, DigestBadge, DocProgress, DragHandle, FailedDocActions, RenameInput } from './parts.tsx';

interface DocCardProps {
  doc: DocMeta;
  courses: readonly Course[];
  layout: LibraryLayout;
  onOpen: (id: string) => void;
  onMove: (docId: string, courseId: string | null) => void;
  onRetry: (docId: string) => void;
  onRename: (docId: string, title: string) => void;
  onDelete: (doc: DocMeta) => void;
}

/** An uncategorized document ("미분류"): opens on click; ≡ drags it into a course, the select moves it there (both on
 * top, with the menu). */
export function DocCard({ doc, courses, layout, onOpen, onMove, onRetry, onRename, onDelete }: DocCardProps) {
  const [renaming, setRenaming] = useState(false);
  const ready = doc.status === 'ready';
  const hasCourses = courses.length > 0;
  const pickRecording = useRecordingUploadPicker();
  const canUploadRecording = ready && pickRecording !== null;
  const data: DropData = { role: 'lecture', docId: doc.id, courseId: null };
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useOrgItem({
    id: dndId.lecture(doc.id),
    data,
    roleDescription: '옮길 수 있는 강의',
    canDrag: hasCourses,
  });
  return (
    <div
      ref={setNodeRef}
      data-drag-node=""
      data-org-key={dndId.lecture(doc.id)}
      className={`doc-card status-${doc.status}${isDragging ? ' is-drag-source' : ''}`}
    >
      {/* Moving and the menu first, in one row above the slide: a new lecture is usually filed right away. */}
      <div className="doc-card-head">
        {hasCourses && (
          <div className="doc-card-move">
            <DragHandle
              label={`‘${doc.title}’ 강의를 과목으로 옮기기`}
              setRef={setActivatorNodeRef}
              listeners={listeners}
              attributes={attributes}
            />
            <select
              className="picker"
              aria-label={`${doc.title}을(를) 과목으로 이동`}
              value=""
              onChange={(e) => {
                if (e.target.value) onMove(doc.id, e.target.value);
              }}
            >
              <option value="">과목으로 이동…</option>
              <CourseOptions courses={courses} layout={layout} />
            </select>
          </div>
        )}
        <PopoverMenu
          label={`‘${doc.title}’ 강의 메뉴`}
          sections={[
            {
              items: [
                {
                  key: 'rename',
                  label: '이름 바꾸기',
                  icon: Pencil,
                  onSelect: () => setRenaming(true),
                },
                ...(canUploadRecording
                  ? [
                      {
                        key: 'recording',
                        label: '녹음 파일 올리기',
                        icon: Mic,
                        hint: '음성·동영상',
                        onSelect: () => pickRecording?.(doc),
                      },
                    ]
                  : []),
              ],
            },
          ]}
        />
      </div>
      {renaming && (
        // Above the opening button (an input cannot sit in a button); the title inside it hides meanwhile.
        <div className="doc-card-rename">
          <RenameInput
            initial={doc.title}
            label="강의 이름"
            maxLength={200}
            className="course-title-input doc-title-input"
            onDone={(title) => {
              setRenaming(false);
              if (title && title !== doc.title) onRename(doc.id, title);
            }}
          />
        </div>
      )}
      <button type="button" className="doc-card-main" onClick={() => onOpen(doc.id)}>
        <div
          className="doc-thumb"
          style={{
            aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9,
          }}
        >
          {ready ? (
            // Cards are 250–500 CSS px wide: the 1000 px rendition, not the thumbnail.
            <SlideImage docId={doc.id} slide={1} src={viewUrl(doc.id, 1, 1000)} alt="" draggable={false} />
          ) : doc.status === 'error' ? (
            <TriangleAlert />
          ) : (
            <Hourglass />
          )}
        </div>
        <div className="doc-card-body">
          {renaming ? null : <div className="doc-title">{doc.title}</div>}
          <div className="doc-sub">
            {doc.fileName} · {formatDate(doc.createdAt)}
            {ready && ` · ${doc.pageCount}장`}
          </div>
          <div className="doc-badges">
            {doc.digestStatus !== 'none' && <DigestBadge status={doc.digestStatus} />}
            <RecordingUploadBadge docId={doc.id} />
          </div>
          {doc.status === 'processing' && <DocProgress doc={doc} compact />}
          {doc.status === 'error' && <div className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</div>}
        </div>
      </button>
      {doc.status === 'error' && (
        <div className="doc-card-foot">
          <FailedDocActions doc={doc} onRetry={onRetry} onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}
