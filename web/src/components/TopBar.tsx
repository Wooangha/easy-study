import type { ReactNode } from 'react';
import { BookOpen, NotebookPen, Settings, Trash } from 'lucide-react';
import type { Course, DocMeta, LibraryLayout, ProviderInfo, SessionSummary } from '../../../shared/types.ts';
import { notesMarkdownUrl } from '../api.ts';
import { msg } from '../i18n/index.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../hooks/useProviderChoice.ts';
import { confirmDialog } from '../lib/confirm.ts';
import { formatTime, providerWithModel } from '../lib/format.ts';
import { LecturePicker } from './LecturePicker.tsx';
import { NewSessionLlm } from './NewSessionLlm.tsx';

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

export function TopBar(props: TopBarProps) {
  const { docs, doc, sessions, sessionId, providers } = props;
  const ready = doc?.status === 'ready';
  const m = msg().shell.topBar;
  const settings = msg().common.settings;

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => props.onSelectDoc(null)} title={m.toLibrary}>
        <BookOpen /> easy-study
      </button>

      <LecturePicker
        docs={docs}
        doc={doc}
        courses={props.courses}
        layout={props.layout}
        onSelectDoc={props.onSelectDoc}
        onUploadClick={props.onUploadClick}
        uploadCourse={props.uploadCourse}
      />

      {ready && (
        <div className="session-controls">
          <select
            className="picker session-picker"
            aria-label={m.sessionPicker}
            value={sessionId ?? ''}
            disabled={sessions === null}
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW_SESSION) props.onNewSession();
              else if (v) props.onSelectSession(v);
            }}
          >
            {!sessionId && <option value="">{sessions === null ? m.sessionsLoading : m.noSessions}</option>}
            {(sessions ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} · {providerWithModel(providers, s.provider, s.model, s.effort)} · {m.messageCount(s.messageCount)} ·{' '}
                {formatTime(s.updatedAt)}
              </option>
            ))}
            <option value={NEW_SESSION} disabled={props.sessionBusy || !props.choice}>
              {m.newSession}
            </option>
          </select>
          {sessionId && (
            <button
              type="button"
              className="icon-btn"
              title={m.deleteSession}
              aria-label={m.deleteSession}
              disabled={props.sessionBusy}
              onClick={() => {
                void confirmDialog({ ...m.deleteSessionConfirm, danger: true }).then((ok) => {
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
          title={props.hasNotes ? m.openNotes : m.noNotesYet}
        >
          <NotebookPen /> {m.notesFile}
        </a>
      )}

      {props.onLogout && (
        <button type="button" className="ghost-btn logout-btn" onClick={props.onLogout} title={m.logoutTitle}>
          {m.logout}
        </button>
      )}

      <button
        type="button"
        className="icon-btn settings-btn"
        aria-label={props.updatePending ? m.settingsUpdateLabel : settings}
        title={props.updatePending ? m.settingsUpdateTitle : settings}
        onClick={props.onOpenSettings}
      >
        <Settings />
        {props.updatePending && <span className="settings-dot" aria-hidden />}
      </button>
    </header>
  );
}
