import type { ReactNode } from 'react';
import { BookOpen, NotebookPen, Settings } from 'lucide-react';
import type { Course, DocMeta, LibraryLayout } from '../../../shared/types.ts';
import { notesMarkdownUrl } from '../api.ts';
import { msg } from '../i18n/index.ts';
import { LecturePicker } from './LecturePicker.tsx';

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
  const { docs, doc } = props;
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

      {props.recordControl}

      <span className="spacer" />

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
