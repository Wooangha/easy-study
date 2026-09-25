import type { Course, DocMeta, LibraryLayout } from '../../../../shared/types.ts';
import { viewUrl } from '../../api.ts';
import { formatDate } from '../../lib/format.ts';
import { dndId, type DropData } from '../../lib/libraryDnd.ts';
import { SlideImage } from '../SlideImage.tsx';
import { useOrgItem } from './LibraryDnd.tsx';
import { CourseOptions, DigestBadge, DocProgress, DragHandle, FailedDocActions } from './parts.tsx';

interface DocCardProps {
  doc: DocMeta;
  courses: readonly Course[];
  layout: LibraryLayout;
  onOpen: (id: string) => void;
  onMove: (docId: string, courseId: string | null) => void;
  onRetry: (docId: string) => void;
  onDelete: (doc: DocMeta) => void;
}

/** An uncategorized document ("미분류"): opens on click; ≡ drags it into a course, the select moves it there. */
export function DocCard({ doc, courses, layout, onOpen, onMove, onRetry, onDelete }: DocCardProps) {
  const ready = doc.status === 'ready';
  const hasCourses = courses.length > 0;
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
      <button type="button" className="doc-card-main" onClick={() => onOpen(doc.id)}>
        <div className="doc-thumb" style={{ aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9 }}>
          {ready ? (
            // Cards are 250–500 CSS px wide: the 1000 px rendition, not the thumbnail.
            <SlideImage docId={doc.id} slide={1} src={viewUrl(doc.id, 1, 1000)} alt="" draggable={false} />
          ) : (
            <span aria-hidden>{doc.status === 'error' ? '⚠️' : '⏳'}</span>
          )}
        </div>
        <div className="doc-card-body">
          <div className="doc-title">{doc.title}</div>
          <div className="doc-sub">
            {doc.fileName} · {formatDate(doc.createdAt)}
            {ready && ` · ${doc.pageCount}장`}
          </div>
          {doc.digestStatus !== 'none' && (
            <div className="doc-badges">
              <DigestBadge status={doc.digestStatus} />
            </div>
          )}
          {doc.status === 'processing' && <DocProgress doc={doc} compact />}
          {doc.status === 'error' && <div className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</div>}
        </div>
      </button>
      {(hasCourses || doc.status === 'error') && (
        <div className="doc-card-foot">
          {doc.status === 'error' && <FailedDocActions doc={doc} onRetry={onRetry} onDelete={onDelete} />}
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
                <option value="">📁 과목으로 이동…</option>
                <CourseOptions courses={courses} layout={layout} />
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
