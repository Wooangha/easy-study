// Small building blocks of the library view.
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, ChevronRight, GripVertical, Hourglass, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Course, DigestStatus, DocMeta, LibraryLayout } from '../../../../shared/types.ts';
import type { UploadItem } from '../../hooks/useDocs.ts';
import { msg } from '../../i18n/index.ts';
import { formatBytes } from '../../lib/format.ts';
import { layoutRows } from '../../lib/libraryLayout.ts';

/** Drag handle, a grip icon (mouse: drag; touch: press and hold, then drag; keyboard: Space/Enter, arrows, Space/Enter). */
export function DragHandle({
  label,
  setRef,
  listeners,
  attributes,
  disabled = false,
}: {
  label: string;
  setRef: (el: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
  attributes: DraggableAttributes;
  disabled?: boolean;
}) {
  if (disabled) return null;
  return (
    <button
      type="button"
      ref={setRef}
      className="drag-handle"
      {...attributes}
      {...listeners}
      aria-label={label}
      title={msg().shell.library.dragHandleTitle(label)}
    >
      <GripVertical />
    </button>
  );
}

/** Collapse chevron (points right; the toggle rotates it down when expanded). */
export function Chevron({ className = 'collapse-chevron' }: { className?: string }) {
  // 14 px with the old hand-drawn chevron's 1.75 px line (3 of Lucide's 24 units).
  return <ChevronRight className={className} size={14} strokeWidth={3} focusable="false" />;
}

/** "정리본" (a check) / "정리 중" (an hourglass) / "정리본 일부" badge (nothing when there is no digest). */
export function DigestBadge({ status }: { status: DigestStatus | undefined }) {
  const m = msg().shell.library.digestBadge;
  switch (status) {
    case 'ready':
      return (
        <span className="digest-badge is-ready">
          <Check strokeWidth={2.5} /> {m.ready}
        </span>
      );
    case 'running':
      return (
        <span className="digest-badge is-running">
          <Hourglass strokeWidth={2.5} /> {m.running}
        </span>
      );
    case 'aborted':
    case 'error':
      return (
        <span className="digest-badge is-partial" title={m.partialTitle}>
          {m.partial}
        </span>
      );
    default:
      return null;
  }
}

/** Summary badges of a collapsed course: 정리본 k/n, running digests, conversions, failures. */
export function CourseSummaryBadges({ lectures, uploads }: { lectures: DocMeta[]; uploads: number }) {
  if (lectures.length === 0 && uploads === 0) return null;
  const ready = lectures.filter((d) => d.digestStatus === 'ready').length;
  const running = lectures.filter((d) => d.digestStatus === 'running').length;
  const processing = lectures.filter((d) => d.status === 'processing').length;
  const failed = lectures.filter((d) => d.status === 'error').length;
  const m = msg().shell.library.summary;
  return (
    <span className="course-badges">
      {lectures.length > 0 && (
        <span
          className={ready === lectures.length ? 'digest-badge is-ready' : 'digest-badge is-muted'}
          title={m.digestsTitle(ready, lectures.length)}
        >
          {ready === lectures.length && (
            <>
              <Check strokeWidth={2.5} />{' '}
            </>
          )}
          {m.digests(ready, lectures.length)}
        </span>
      )}
      {running > 0 && (
        <span className="digest-badge is-running">
          <Hourglass strokeWidth={2.5} /> {m.running(running)}
        </span>
      )}
      {processing > 0 && <span className="digest-badge is-running">{m.converting(processing)}</span>}
      {failed > 0 && (
        <span className="digest-badge is-partial">
          <TriangleAlert strokeWidth={2.5} /> {m.failed(failed)}
        </span>
      )}
      {uploads > 0 && <span className="digest-badge is-running">{m.uploading(uploads)}</span>}
    </span>
  );
}

export function ProgressBar({ fraction }: { fraction: number | null }) {
  return (
    <div className={fraction === null ? 'progress is-indeterminate' : 'progress'} role="progressbar">
      <div className="progress-fill" style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }} />
    </div>
  );
}

export function DocProgress({ doc, compact = false }: { doc: DocMeta; compact?: boolean }) {
  const fraction = doc.pageCount > 0 ? Math.min(1, doc.progress / doc.pageCount) : null;
  return (
    <div className={compact ? 'doc-progress compact' : 'doc-progress'}>
      <ProgressBar fraction={fraction} />
      <span className="doc-progress-text">
        {doc.pageCount > 0 ? msg().shell.library.convertingSlides(doc.progress, doc.pageCount) : msg().shell.library.analyzingPdf}
      </span>
    </div>
  );
}

export function UploadCard({ upload: u }: { upload: UploadItem }) {
  return (
    <div className="doc-card is-uploading">
      <div className="doc-card-body">
        <div className="doc-title">{u.name}</div>
        <div className="doc-sub">{msg().shell.library.uploading(Math.round(u.fraction * 100), formatBytes(u.size))}</div>
        <ProgressBar fraction={u.fraction} />
      </div>
    </div>
  );
}

/** "다시 변환" / "삭제" for a document whose conversion failed (the PDF is kept, so it can be re-run). */
export function FailedDocActions({
  doc,
  onRetry,
  onDelete,
}: {
  doc: DocMeta;
  onRetry: (docId: string) => void;
  onDelete: (doc: DocMeta) => void;
}) {
  const m = msg().shell.library;
  return (
    <>
      <button type="button" className="ghost-btn small" onClick={() => onRetry(doc.id)} title={m.convertAgainTitle}>
        <RefreshCw /> {m.convertAgain}
      </button>
      <button type="button" className="ghost-btn small danger" onClick={() => onDelete(doc)} title={m.deleteDocTitle}>
        {msg().common.delete}
      </button>
    </>
  );
}

/** Inline title editor: Enter/blur saves, Esc cancels (null). */
export function RenameInput({
  initial,
  label,
  onDone,
  maxLength = 120,
  className = 'course-title-input',
}: {
  initial: string;
  label: string;
  onDone: (title: string | null) => void;
  /** 120 for courses and groups; lectures allow 200. */
  maxLength?: number;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return; // Enter → blur would finish twice
    done.current = true;
    onDone(title);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(value.trim() || null);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      finish(null);
    }
  };
  return (
    <input
      className={className}
      autoFocus
      aria-label={label}
      value={value}
      maxLength={maxLength}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value.trim() || null)}
    />
  );
}

/** "새 과목" / "새 그룹" form. */
export function NewTitleForm({
  icon: Icon,
  placeholder,
  label,
  onCreate,
  onCancel,
}: {
  icon: LucideIcon;
  placeholder: string;
  label: string;
  onCreate: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await onCreate(t);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="course-create" onSubmit={(e) => void submit(e)}>
      <Icon className="course-icon" />
      <input
        className="course-title-input"
        autoFocus
        placeholder={placeholder}
        aria-label={label}
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="submit" className="primary-btn small" disabled={!title.trim() || busy}>
        {msg().shell.library.create}
      </button>
      <button type="button" className="ghost-btn small" onClick={onCancel}>
        {msg().common.cancel}
      </button>
    </form>
  );
}

/**
 * <option>s of every course in layout order: grouped courses inside an <optgroup> per group, courses outside
 * groups as plain options. `exclude` leaves one course out (the lecture's own).
 */
export function CourseOptions({
  courses,
  layout,
  exclude,
}: {
  courses: readonly Course[];
  layout: LibraryLayout;
  exclude?: string | null;
}) {
  return layoutRows(layout, courses).map((row) => {
    if (row.type === 'course') {
      if (row.course.id === exclude) return null;
      return (
        <option key={row.course.id} value={row.course.id}>
          {row.course.title}
        </option>
      );
    }
    const inGroup = row.courses.filter((c) => c.id !== exclude);
    if (inGroup.length === 0) return null;
    return (
      <optgroup key={row.group.id} label={row.group.title}>
        {inGroup.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </optgroup>
    );
  });
}
