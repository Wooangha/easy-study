import type { ReactNode } from 'react';
import { BookOpen, NotebookPen, Settings, Trash } from 'lucide-react';
import type { Course, DocMeta, LibraryLayout, ProviderInfo, SessionSummary } from '../../../shared/types.ts';
import { notesMarkdownUrl } from '../api.ts';
import { indexCourses } from '../hooks/useCourses.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../hooks/useProviderChoice.ts';
import { confirmDialog } from '../lib/confirm.ts';
import { formatTime, providerWithModel } from '../lib/format.ts';
import { courseLabel, layoutEntries } from '../lib/libraryLayout.ts';
import { NewSessionLlm } from './NewSessionLlm.tsx';

const UPLOAD = '__upload__';
const NEW_SESSION = '__new__';

interface TopBarProps {
  docs: DocMeta[] | null;
  doc: DocMeta | null;
  /** Courses in creation order (null while loading / unavailable). */
  courses: Course[] | null;
  /** Groups and order of the courses (DESIGN §18). */
  layout: LibraryLayout;
  onSelectDoc: (docId: string | null) => void;
  onUploadClick: () => void;
  /** Course that "＋ PDF 추가" uploads into (null = uncategorized). */
  uploadCourse: Course | null;

  /** Session controls are shown only for a ready doc. */
  sessions: SessionSummary[] | null;
  sessionId: string | null;
  sessionBusy: boolean;
  onSelectSession: (sid: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sid: string) => void;

  providers: ProviderInfo[] | undefined;
  providersLoading: boolean;
  choice: ProviderChoice | null;
  onChoiceChange: (choice: ProviderChoiceUpdate) => void;
  hasNotes: boolean;
  /** Remote mode (the server asks for an access code): "로그아웃" button. */
  onLogout?: () => void;
  /** Record button / the running recording (DESIGN §22). */
  recordControl?: ReactNode;
  /** The gear: 설정 (DESIGN §24). */
  onOpenSettings: () => void;
  /** Inside the desktop app: a new version waits (a dot on the gear). */
  updatePending?: boolean;
}

function docOptionLabel(d: DocMeta, index?: number): string {
  const name = index === undefined ? d.title : `${index}. ${d.title}`;
  if (d.status === 'processing') {
    const pct = d.pageCount > 0 ? Math.round((d.progress / d.pageCount) * 100) : 0;
    return `${name} (처리 중 ${pct}%)`;
  }
  if (d.status === 'error') return `${name} (오류)`;
  const badge = d.digestStatus === 'ready' ? ' · 정리본' : d.digestStatus === 'running' ? ' · 정리 중' : '';
  return `${name} · ${d.pageCount}장${badge}`;
}

/**
 * Document picker options: one <optgroup> per course in library order ("그룹 › 과목" for grouped courses),
 * lectures in order, + "미분류" (only when courses exist).
 */
function DocOptions({ docs, courses, layout }: { docs: DocMeta[]; courses: Course[]; layout: LibraryLayout }) {
  if (courses.length === 0) {
    return docs.map((d) => (
      <option key={d.id} value={d.id}>
        {docOptionLabel(d)}
      </option>
    ));
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  // A document listed in two courses (data error) shows under the one it belongs to (the oldest).
  const owner = indexCourses(courses);
  const placed = new Set<string>();
  const groups = layoutEntries(layout, courses).map((entry) => {
    const c = entry.course;
    const lectures = c.docIds
      .filter((id) => owner.get(id)?.course.id === c.id)
      .map((id) => byId.get(id))
      .filter((d): d is DocMeta => d !== undefined);
    for (const d of lectures) placed.add(d.id);
    return (
      <optgroup key={c.id} label={courseLabel(entry)}>
        {lectures.length === 0 ? (
          <option disabled value={`__empty:${c.id}`}>
            (강의 없음)
          </option>
        ) : (
          lectures.map((d, i) => (
            <option key={d.id} value={d.id}>
              {docOptionLabel(d, i + 1)}
            </option>
          ))
        )}
      </optgroup>
    );
  });
  const rest = docs.filter((d) => !placed.has(d.id));
  return (
    <>
      {groups}
      {rest.length > 0 && (
        <optgroup label="미분류">
          {rest.map((d) => (
            <option key={d.id} value={d.id}>
              {docOptionLabel(d)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

export function TopBar(props: TopBarProps) {
  const { docs, doc, sessions, sessionId, providers } = props;
  const ready = doc?.status === 'ready';

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => props.onSelectDoc(null)} title="라이브러리로">
        <BookOpen /> easy-study
      </button>

      <select
        className="picker doc-picker"
        aria-label="문서 선택"
        value={doc?.id ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === UPLOAD) props.onUploadClick();
          else props.onSelectDoc(v || null);
        }}
      >
        <option value="">{docs && docs.length > 0 ? '문서 선택…' : '문서 없음'}</option>
        <DocOptions docs={docs ?? []} courses={props.courses ?? []} layout={props.layout} />
        <option value={UPLOAD}>{props.uploadCourse ? `＋ PDF 추가 (${props.uploadCourse.title})` : '＋ PDF 추가'}</option>
      </select>

      {ready && (
        <div className="session-controls">
          <select
            className="picker session-picker"
            aria-label="세션 선택"
            value={sessionId ?? ''}
            disabled={sessions === null}
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW_SESSION) props.onNewSession();
              else if (v) props.onSelectSession(v);
            }}
          >
            {!sessionId && <option value="">{sessions === null ? '세션 불러오는 중…' : '세션 없음'}</option>}
            {(sessions ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} · {providerWithModel(providers, s.provider, s.model, s.effort)} · 메시지 {s.messageCount}개 ·{' '}
                {formatTime(s.updatedAt)}
              </option>
            ))}
            <option value={NEW_SESSION} disabled={props.sessionBusy || !props.choice}>
              ＋ 새 세션
            </option>
          </select>
          {sessionId && (
            <button
              type="button"
              className="icon-btn"
              title="이 세션 삭제"
              aria-label="이 세션 삭제"
              disabled={props.sessionBusy}
              onClick={() => {
                void confirmDialog({
                  title: '이 세션을 삭제할까요?',
                  message: '세션과 대화 기록(노트 포함)이 지워지고 되돌릴 수 없어요.',
                  confirmLabel: '세션 삭제',
                  danger: true,
                }).then((ok) => {
                  if (ok) props.onDeleteSession(sessionId);
                });
              }}
            >
              <Trash />
            </button>
          )}
        </div>
      )}

      {props.recordControl}

      <span className="spacer" />

      {/* The LLM of new sessions, folded into one button; the open session's is changed from the chat header. */}
      <NewSessionLlm providers={providers} loading={props.providersLoading} choice={props.choice} onChange={props.onChoiceChange} />

      {ready && doc && (
        <a
          className={props.hasNotes ? 'ghost-btn' : 'ghost-btn is-disabled'}
          href={notesMarkdownUrl(doc.id)}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!props.hasNotes}
          onClick={(e) => {
            if (!props.hasNotes) e.preventDefault();
          }}
          title={props.hasNotes ? 'STUDY_NOTES.md 열기' : '아직 저장된 Q&A가 없어요'}
        >
          <NotebookPen /> 노트 파일
        </a>
      )}

      {props.onLogout && (
        <button type="button" className="ghost-btn logout-btn" onClick={props.onLogout} title="이 브라우저에서 로그아웃">
          로그아웃
        </button>
      )}

      <button
        type="button"
        className="icon-btn settings-btn"
        aria-label={props.updatePending ? '설정 (새 버전 있음)' : '설정'}
        title={props.updatePending ? '설정 · 새 버전 있음' : '설정'}
        onClick={props.onOpenSettings}
      >
        <Settings />
        {props.updatePending && <span className="settings-dot" aria-hidden />}
      </button>
    </header>
  );
}
