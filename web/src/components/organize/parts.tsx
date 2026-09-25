// Small building blocks of the library view.
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Course, DigestStatus, DocMeta, LibraryLayout } from '../../../../shared/types.ts';
import type { UploadItem } from '../../hooks/useDocs.ts';
import { formatBytes } from '../../lib/format.ts';
import { layoutRows } from '../../lib/libraryLayout.ts';

/** "≡" drag handle (mouse: drag; touch: press and hold, then drag; keyboard: Space/Enter, arrows, Space/Enter). */
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
      title={`${label} — 끌어서 옮기기 (터치: 길게 누른 채 끌기, 키보드: 스페이스 후 화살표)`}
    >
      <span aria-hidden>≡</span>
    </button>
  );
}

/** Collapse chevron (points right; the toggle rotates it down when expanded). */
export function Chevron({ className = 'collapse-chevron' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden focusable="false">
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "✓ 정리본" / "⏳ 정리 중" / "정리본 일부" badge (nothing when there is no digest). */
export function DigestBadge({ status }: { status: DigestStatus | undefined }) {
  switch (status) {
    case 'ready':
      return <span className="digest-badge is-ready">✓ 정리본</span>;
    case 'running':
      return <span className="digest-badge is-running">⏳ 정리 중</span>;
    case 'aborted':
    case 'error':
      return (
        <span className="digest-badge is-partial" title="정리본을 만들다 멈췄어요 — 정리본 탭에서 이어서 만들 수 있어요">
          정리본 일부
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
  return (
    <span className="course-badges">
      {lectures.length > 0 && (
        <span
          className={ready === lectures.length ? 'digest-badge is-ready' : 'digest-badge is-muted'}
          title={`정리본이 있는 강의 ${ready}개 / 전체 ${lectures.length}개`}
        >
          {ready === lectures.length ? '✓ ' : ''}정리본 {ready}/{lectures.length}
        </span>
      )}
      {running > 0 && <span className="digest-badge is-running">⏳ 정리 중 {running}</span>}
      {processing > 0 && <span className="digest-badge is-running">변환 중 {processing}</span>}
      {failed > 0 && <span className="digest-badge is-partial">⚠️ 실패 {failed}</span>}
      {uploads > 0 && <span className="digest-badge is-running">업로드 중 {uploads}</span>}
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
        {doc.pageCount > 0 ? `슬라이드 변환 중 ${doc.progress} / ${doc.pageCount}` : 'PDF 분석 중…'}
      </span>
    </div>
  );
}

export function UploadCard({ upload: u }: { upload: UploadItem }) {
  return (
    <div className="doc-card is-uploading">
      <div className="doc-card-body">
        <div className="doc-title">{u.name}</div>
        <div className="doc-sub">
          업로드 중 {Math.round(u.fraction * 100)}% · {formatBytes(u.size)}
        </div>
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
  return (
    <>
      <button
        type="button"
        className="ghost-btn small"
        onClick={() => onRetry(doc.id)}
        title="업로드한 PDF로 변환을 다시 해요"
      >
        ↻ 다시 변환
      </button>
      <button type="button" className="ghost-btn small danger" onClick={() => onDelete(doc)} title="이 문서를 삭제해요">
        삭제
      </button>
    </>
  );
}

/** Inline title editor: Enter/blur saves, Esc cancels (null). */
export function RenameInput({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone: (title: string | null) => void;
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
      className="course-title-input"
      autoFocus
      aria-label={label}
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value.trim() || null)}
    />
  );
}

/** "새 과목" / "새 그룹" form. */
export function NewTitleForm({
  icon,
  placeholder,
  label,
  onCreate,
  onCancel,
}: {
  icon: string;
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
      <span className="course-icon" aria-hidden>
        {icon}
      </span>
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
        만들기
      </button>
      <button type="button" className="ghost-btn small" onClick={onCancel}>
        취소
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
          📁 {row.course.title}
        </option>
      );
    }
    const inGroup = row.courses.filter((c) => c.id !== exclude);
    if (inGroup.length === 0) return null;
    return (
      <optgroup key={row.group.id} label={`🗂 ${row.group.title}`}>
        {inGroup.map((c) => (
          <option key={c.id} value={c.id}>
            📁 {c.title}
          </option>
        ))}
      </optgroup>
    );
  });
}
