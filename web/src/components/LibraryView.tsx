import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { Course, DigestStatus, DocMeta } from '../../../shared/types.ts';
import { courseSummaryUrl, slideUrl } from '../api.ts';
import type { UploadItem } from '../hooks/useDocs.ts';
import { formatBytes, formatDate } from '../lib/format.ts';

interface LibraryViewProps {
  docs: DocMeta[] | null;
  loadError: string | null;
  courses: Course[] | null;
  coursesError: string | null;
  uploads: UploadItem[];
  libraryDir: string | null;
  /** Course that the big drop zone uploads into (null = uncategorized). */
  uploadCourseId: string | null;
  onUploadCourseChange: (courseId: string | null) => void;
  onOpen: (docId: string) => void;
  onPickFiles: () => void;
  onDropFiles: (files: File[]) => void;
  /** Upload into a specific course (course card button / drop). */
  onUploadToCourse: (courseId: string, files: File[]) => void;
  onCreateCourse: (title: string) => Promise<Course | null>;
  onRenameCourse: (courseId: string, title: string) => void;
  onDeleteCourse: (courseId: string) => void;
  /** Replace the ordered lecture list of a course (reorder / remove). */
  onSetLectures: (courseId: string, docIds: string[]) => void;
  /** Move a lecture into a course (appended) or out of its course (null). */
  onMoveLecture: (docId: string, courseId: string | null) => void;
  onRetryLoad: () => void;
  /** Re-run the conversion of a document whose conversion failed. */
  onRetryDoc: (docId: string) => void;
  /** Delete a document (asks for confirmation). */
  onDeleteDoc: (doc: DocMeta) => void;
  /** A provider is available for making 정리본. */
  canDigest: boolean;
  /** Make the 정리본 of these lectures (asks for confirmation). */
  onDigestLectures: (docs: DocMeta[]) => void;
}

/** Ready lectures without a finished (or running) 정리본 — their summaries are missing from the course context. */
function lecturesWithoutDigest(lectures: DocMeta[]): DocMeta[] {
  return lectures.filter((d) => d.status === 'ready' && d.digestStatus !== 'ready' && d.digestStatus !== 'running');
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

/** Library: drop zone, course folders with their ordered lectures, and uncategorized documents. */
export function LibraryView(props: LibraryViewProps) {
  const { docs, loadError, courses, coursesError, uploads, libraryDir, uploadCourseId } = props;
  const [over, setOver] = useState(false);
  const [creating, setCreating] = useState(false);

  // One hidden file input shared by every course card's "＋ 강의 추가" button.
  const courseFileInput = useRef<HTMLInputElement>(null);
  const pickForCourse = useRef<string | null>(null);
  const pickFilesFor = (courseId: string) => {
    pickForCourse.current = courseId;
    courseFileInput.current?.click();
  };

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    // preventDefault marks the drop as handled; the window-level listener then only hides its overlay.
    e.preventDefault();
    setOver(false);
    props.onDropFiles(Array.from(e.dataTransfer.files));
  };

  const courseList = courses ?? [];
  const byId = new Map((docs ?? []).map((d) => [d.id, d]));
  const inCourse = new Set(courseList.flatMap((c) => c.docIds));
  const uncategorized = (docs ?? []).filter((d) => !inCourse.has(d.id));
  const uploadTarget = courseList.find((c) => c.id === uploadCourseId) ?? null;
  const looseUploads = uploads.filter((u) => !u.courseId || !courseList.some((c) => c.id === u.courseId));

  return (
    <div className="library">
      <div className="library-inner">
        <div className="dropzone-wrap">
          <button
            type="button"
            className={over ? 'dropzone is-over' : 'dropzone'}
            onClick={props.onPickFiles}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <span className="dropzone-icon" aria-hidden>
              📄
            </span>
            <span className="dropzone-title">PDF를 끌어다 놓거나 클릭해서 업로드</span>
            <span className="dropzone-sub">
              {uploadTarget ? (
                <>
                  <b>📁 {uploadTarget.title}</b> 과목에 강의로 추가돼요
                </>
              ) : (
                '슬라이드를 이미지로 변환해 두고, 질문할 때 LLM이 그림·도표까지 볼 수 있게 해요'
              )}
            </span>
          </button>
          {courseList.length > 0 && (
            <label className="upload-target">
              <span className="muted">업로드할 곳</span>
              <select
                className="picker"
                value={uploadTarget?.id ?? ''}
                onChange={(e) => props.onUploadCourseChange(e.target.value || null)}
              >
                <option value="">미분류</option>
                {courseList.map((c) => (
                  <option key={c.id} value={c.id}>
                    📁 {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {looseUploads.map((u) => (
          <UploadCard key={u.id} upload={u} />
        ))}

        {loadError && (
          <div className="inline-error">
            ⚠️ 문서 목록을 불러오지 못했어요: {loadError}{' '}
            <button type="button" className="ghost-btn small" onClick={props.onRetryLoad}>
              다시 시도
            </button>
          </div>
        )}

        {docs === null && !loadError && <p className="muted center">불러오는 중…</p>}

        {/* ---- Courses (rendered once the documents are known, so lectures don't flash as missing) --- */}
        {docs !== null && (
          <>
            <div className="library-section-head">
              <h2 className="library-heading">과목</h2>
              <span className="spacer" />
              {!creating && (
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => setCreating(true)}
                  disabled={!!coursesError}
                >
                  ＋ 새 과목
                </button>
              )}
            </div>
            {coursesError && <div className="inline-error">⚠️ 과목 목록을 불러오지 못했어요: {coursesError}</div>}
            {creating && (
              <NewCourseForm
                onCancel={() => setCreating(false)}
                onCreate={async (title) => {
                  const course = await props.onCreateCourse(title);
                  if (course) setCreating(false);
                }}
              />
            )}
            {courses !== null && courseList.length === 0 && !creating && !coursesError && (
              <p className="course-hint muted small">
                강의를 과목으로 묶어 두면 LLM이 이전 강의들을 알고 설명해요. 예: ‘Compiler’ 과목에 Lecture 1, 2, 3 … 을
                순서대로 넣어 두면, Lecture 8을 공부할 때 1–7강 중 정리본이 있는 강의의 요약을 함께 받고, Claude Code·Codex는
                필요하면 그 강의 파일도 열어 봐요.
              </p>
            )}
            {courseList.map((c) => (
              <CourseCard
                key={c.id}
                course={c}
                lectures={c.docIds.map((id) => byId.get(id)).filter((d): d is DocMeta => d !== undefined)}
                uploads={uploads.filter((u) => u.courseId === c.id)}
                onOpen={props.onOpen}
                onPickFiles={() => pickFilesFor(c.id)}
                onDropFiles={(files) => props.onUploadToCourse(c.id, files)}
                onRename={(title) => props.onRenameCourse(c.id, title)}
                onDelete={() => props.onDeleteCourse(c.id)}
                onSetLectures={(ids) => props.onSetLectures(c.id, ids)}
                onRetryDoc={props.onRetryDoc}
                onDeleteDoc={props.onDeleteDoc}
                canDigest={props.canDigest}
                onDigestLectures={props.onDigestLectures}
              />
            ))}
          </>
        )}

        {/* ---- Uncategorized ---------------------------------------------------------------------- */}
        {docs && uncategorized.length > 0 && (
          <>
            <div className="library-section-head">
              <h2 className="library-heading">{courseList.length > 0 ? '미분류' : '내 문서'}</h2>
              {courseList.length > 0 && <span className="muted small">과목에 넣으려면 ‘과목으로 이동’을 고르세요</span>}
            </div>
            <div className="doc-list">
              {uncategorized.map((d) => (
                <DocCard
                  key={d.id}
                  doc={d}
                  courses={courseList}
                  onOpen={props.onOpen}
                  onMove={props.onMoveLecture}
                  onRetry={props.onRetryDoc}
                  onDelete={props.onDeleteDoc}
                />
              ))}
            </div>
          </>
        )}

        {docs && docs.length === 0 && uploads.length === 0 && !loadError && (
          <p className="muted center">아직 문서가 없어요. 강의 자료 PDF를 올려 보세요.</p>
        )}

        {libraryDir && (
          <p className="library-path muted small">
            저장 위치: <code>{libraryDir}</code>
          </p>
        )}
      </div>

      <input
        ref={courseFileInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // allow picking the same file again
          const courseId = pickForCourse.current;
          pickForCourse.current = null;
          if (courseId && files.length > 0) props.onUploadToCourse(courseId, files);
        }}
      />
    </div>
  );
}

function NewCourseForm({ onCreate, onCancel }: { onCreate: (title: string) => Promise<void>; onCancel: () => void }) {
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
        📁
      </span>
      <input
        className="course-title-input"
        autoFocus
        placeholder="과목 이름 (예: Compiler)"
        aria-label="새 과목 이름"
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

interface CourseCardProps {
  course: Course;
  /** Lectures in course order (documents that exist). */
  lectures: DocMeta[];
  uploads: UploadItem[];
  onOpen: (docId: string) => void;
  onPickFiles: () => void;
  onDropFiles: (files: File[]) => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onSetLectures: (docIds: string[]) => void;
  onRetryDoc: (docId: string) => void;
  onDeleteDoc: (doc: DocMeta) => void;
  canDigest: boolean;
  onDigestLectures: (docs: DocMeta[]) => void;
}

function CourseCard({
  course,
  lectures,
  uploads,
  onOpen,
  onPickFiles,
  onDropFiles,
  onRename,
  onDelete,
  onSetLectures,
  onRetryDoc,
  onDeleteDoc,
  canDigest,
  onDigestLectures,
}: CourseCardProps) {
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const ids = lectures.map((d) => d.id);
  const withoutDigest = lecturesWithoutDigest(lectures);

  const move = (index: number, dir: -1 | 1) => {
    const next = ids.slice();
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    onSetLectures(next);
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // handled here: the window-level drop listener ignores it
    setOver(false);
    onDropFiles(Array.from(e.dataTransfer.files));
  };

  const confirmDelete = () => {
    const msg =
      lectures.length > 0
        ? `과목 ‘${course.title}’을(를) 삭제할까요?\n강의 ${lectures.length}개는 지워지지 않고 ‘미분류’로 옮겨져요.`
        : `과목 ‘${course.title}’을(를) 삭제할까요?`;
    if (window.confirm(msg)) onDelete();
  };

  return (
    <section
      className={over ? 'course-card is-over' : 'course-card'}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <header className="course-head">
        <span className="course-icon" aria-hidden>
          📁
        </span>
        {editing ? (
          <RenameInput
            initial={course.title}
            onDone={(title) => {
              setEditing(false);
              if (title && title !== course.title) onRename(title);
            }}
          />
        ) : (
          <button type="button" className="course-title" onClick={() => setEditing(true)} title="클릭해서 이름 바꾸기">
            {course.title}
            <span className="course-title-edit" aria-hidden>
              ✎
            </span>
          </button>
        )}
        <span className="course-count">강의 {lectures.length}개</span>
        <span className="spacer" />
        <div className="course-actions">
          {withoutDigest.length > 0 && lectures.length > 1 && (
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => onDigestLectures(withoutDigest)}
              disabled={!canDigest}
              title={
                canDigest
                  ? '정리본이 있는 강의만 요약이 다음 강의를 공부할 때 LLM에게 전달돼요 — 없는 강의의 정리본을 한 번에 만들어요'
                  : '사용할 수 있는 LLM이 없어요'
              }
            >
              📝 정리본 없는 강의 {withoutDigest.length}개 만들기
            </button>
          )}
          <a
            className="ghost-btn small"
            href={courseSummaryUrl(course.id)}
            target="_blank"
            rel="noreferrer"
            title="과목 정리 파일(COURSE.md) 열기 — 강의별 요약과 정리본 링크"
          >
            📄 COURSE.md
          </a>
          <button type="button" className="ghost-btn small" onClick={onPickFiles} title="이 과목에 강의 PDF 추가">
            ＋ 강의 추가
          </button>
          <button type="button" className="icon-btn small" onClick={confirmDelete} title="과목 삭제 (강의는 남아요)">
            🗑
          </button>
        </div>
      </header>

      {lectures.length > 0 || uploads.length > 0 ? (
        <ol className="lecture-list">
          {lectures.map((d, i) => (
            <LectureRow
              key={d.id}
              doc={d}
              index={i + 1}
              first={i === 0}
              last={i === lectures.length - 1}
              onOpen={onOpen}
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
              onRemove={() => onSetLectures(ids.filter((id) => id !== d.id))}
              onRetry={onRetryDoc}
              onDelete={onDeleteDoc}
            />
          ))}
          {uploads.map((u) => (
            <li key={`up-${u.id}`} className="lecture-row is-uploading">
              <span className="lecture-index">…</span>
              <div className="lecture-main">
                <div className="doc-title">{u.name}</div>
                <div className="doc-sub">
                  업로드 중 {Math.round(u.fraction * 100)}% · {formatBytes(u.size)}
                </div>
                <ProgressBar fraction={u.fraction} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <button type="button" className="course-empty" onClick={onPickFiles}>
          아직 강의가 없어요 — PDF를 이 카드에 끌어다 놓거나 클릭해서 추가하세요
        </button>
      )}

      {over && (
        <div className="course-drop-hint" aria-hidden>
          📄 놓으면 ‘{course.title}’에 강의로 추가해요
        </div>
      )}
    </section>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
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
      finish(null);
    }
  };
  return (
    <input
      className="course-title-input"
      autoFocus
      aria-label="과목 이름"
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value.trim() || null)}
    />
  );
}

interface LectureRowProps {
  doc: DocMeta;
  index: number;
  first: boolean;
  last: boolean;
  onOpen: (docId: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onRetry: (docId: string) => void;
  onDelete: (doc: DocMeta) => void;
}

function LectureRow({
  doc,
  index,
  first,
  last,
  onOpen,
  onMoveUp,
  onMoveDown,
  onRemove,
  onRetry,
  onDelete,
}: LectureRowProps) {
  const ready = doc.status === 'ready';
  return (
    <li className={`lecture-row status-${doc.status}`}>
      <span className="lecture-index">{index}</span>
      <button type="button" className="lecture-open" onClick={() => onOpen(doc.id)} title="이 강의 열기">
        <span className="lecture-thumb" style={{ aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9 }}>
          {ready ? (
            <img src={slideUrl(doc.id, 1)} alt="" loading="lazy" decoding="async" />
          ) : (
            <span aria-hidden>{doc.status === 'error' ? '⚠️' : '⏳'}</span>
          )}
        </span>
        <span className="lecture-main">
          <span className="doc-title">{doc.title}</span>
          <span className="doc-sub">
            {ready ? `${doc.pageCount}장` : doc.status === 'error' ? '처리 실패' : '변환 중'} · {formatDate(doc.createdAt)}
            <DigestBadge status={doc.digestStatus} />
          </span>
          {doc.status === 'processing' && <DocProgress doc={doc} compact />}
          {doc.status === 'error' && <span className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</span>}
        </span>
      </button>
      <div className="lecture-actions">
        {doc.status === 'error' && <FailedDocActions doc={doc} onRetry={onRetry} onDelete={onDelete} />}
        <button type="button" className="icon-btn small" onClick={onMoveUp} disabled={first} title="위로" aria-label="위로">
          ▲
        </button>
        <button
          type="button"
          className="icon-btn small"
          onClick={onMoveDown}
          disabled={last}
          title="아래로"
          aria-label="아래로"
        >
          ▼
        </button>
        <button type="button" className="ghost-btn small" onClick={onRemove} title="강의는 남기고 과목에서만 빼요">
          과목에서 빼기
        </button>
      </div>
    </li>
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

function UploadCard({ upload: u }: { upload: UploadItem }) {
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
function FailedDocActions({
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
        title="업로드한 PDF로 변환을 다시 해요 (예: poppler를 설치한 뒤)"
      >
        ↻ 다시 변환
      </button>
      <button type="button" className="ghost-btn small danger" onClick={() => onDelete(doc)} title="이 문서를 삭제해요">
        삭제
      </button>
    </>
  );
}

function DocCard({
  doc,
  courses,
  onOpen,
  onMove,
  onRetry,
  onDelete,
}: {
  doc: DocMeta;
  courses: Course[];
  onOpen: (id: string) => void;
  onMove: (docId: string, courseId: string | null) => void;
  onRetry: (docId: string) => void;
  onDelete: (doc: DocMeta) => void;
}) {
  const ready = doc.status === 'ready';
  return (
    <div className={`doc-card status-${doc.status}`}>
      <button type="button" className="doc-card-main" onClick={() => onOpen(doc.id)}>
        <div className="doc-thumb" style={{ aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9 }}>
          {ready ? (
            <img src={slideUrl(doc.id, 1)} alt="" loading="lazy" decoding="async" />
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
      {(courses.length > 0 || doc.status === 'error') && (
        <div className="doc-card-foot">
          {doc.status === 'error' && <FailedDocActions doc={doc} onRetry={onRetry} onDelete={onDelete} />}
          {courses.length > 0 && (
            <select
              className="picker"
              aria-label={`${doc.title}을(를) 과목으로 이동`}
              value=""
              onChange={(e) => {
                if (e.target.value) onMove(doc.id, e.target.value);
              }}
            >
              <option value="">📁 과목으로 이동…</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ fraction }: { fraction: number | null }) {
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

/** Shown in place of the split view while the selected doc is processing or failed. */
export function DocStatusView({
  doc,
  onBack,
  onRetry,
  onDelete,
}: {
  doc: DocMeta;
  onBack: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="library">
      <div className="library-inner status-view">
        <div className="status-card">
          <div className="status-icon" aria-hidden>
            {doc.status === 'error' ? '⚠️' : '⏳'}
          </div>
          <h2>{doc.title}</h2>
          <p className="muted small">{doc.fileName}</p>
          {doc.status === 'processing' ? (
            <>
              <DocProgress doc={doc} />
              <p className="muted small">
                슬라이드 이미지·텍스트·개요 이미지를 만드는 중이에요. 끝나면 자동으로 열려요.
              </p>
            </>
          ) : (
            <>
              <div className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</div>
              <p className="muted small">
                업로드한 PDF는 남아 있어요. 원인을 해결했다면(예: <code>brew install poppler</code>) 다시 변환할 수 있어요.
              </p>
              <div className="status-actions">
                <button type="button" className="primary-btn small" onClick={onRetry}>
                  ↻ 다시 변환
                </button>
                <button type="button" className="ghost-btn danger" onClick={onDelete}>
                  삭제
                </button>
              </div>
            </>
          )}
          <button type="button" className="ghost-btn" onClick={onBack}>
            ← 라이브러리
          </button>
        </div>
      </div>
    </div>
  );
}
