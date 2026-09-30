import { useState } from 'react';
import { ChevronRight, FileText, Hourglass, NotebookPen, Paperclip, RefreshCw, Square, TriangleAlert, X } from 'lucide-react';
import type { NoteEntry, NotesResponse, ProviderInfo } from '../../../shared/types.ts';
import { notesMarkdownUrl, thumbUrl } from '../api.ts';
import { useAuth } from '../hooks/useAuth.ts';
import { msg } from '../i18n/index.ts';
import { copyText } from '../lib/clipboard.ts';
import { firstLine, formatTime, providerLabel } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { AttachmentThumbs } from './Attachments.tsx';
import { Markdown } from './Markdown.tsx';
import { SlideImage } from './SlideImage.tsx';

/** 'all' | 'current' (follows the focused slide) | a fixed slide number (opened from a viewer badge). */
export type NotesFilter = 'all' | 'current' | number;

interface NotesPanelProps {
  docId: string;
  notes: NotesResponse | null;
  loading: boolean;
  error: string | null;
  providers: ProviderInfo[] | undefined;
  focusedSlide: number;
  filter: NotesFilter;
  onFilterChange: (filter: NotesFilter) => void;
  onGoToSlide: (slide: number) => void;
  onRefresh: () => void;
}

export function NotesPanel({
  docId,
  notes,
  loading,
  error,
  providers,
  focusedSlide,
  filter,
  onFilterChange,
  onGoToSlide,
  onRefresh,
}: NotesPanelProps) {
  // Bumping this remounts the <details> elements with the new default open state. Cards start collapsed
  // (an open card renders its Markdown/KaTeX answer); only a lone Q&A of a single-slide view opens.
  const [expand, setExpand] = useState<{ open: boolean; gen: number }>({ open: false, gen: 0 });
  // Remote mode: the path is on the server computer, not on the one this page is opened on.
  const remote = useAuth().authRequired;

  const filterSlide = filter === 'current' ? focusedSlide : filter === 'all' ? null : filter;
  const allSlides = notes?.slides ?? [];
  const shown = filterSlide === null ? allSlides : allSlides.filter((s) => s.slide === filterSlide);
  const totalEntries = allSlides.reduce((n, s) => n + s.entries.length, 0);
  const hasNotes = totalEntries > 0;

  const copyPath = () => {
    if (!notes) return;
    const t = msg().chat.shared;
    void copyText(notes.markdownPath)
      .then(() => toast(remote ? t.pathCopiedRemote : t.pathCopied, 'success', 2000))
      .catch(() => toast(t.copyFailed, 'error'));
  };

  const m = msg().chat.notes;
  const shared = msg().chat.shared;
  return (
    <div className="notes-panel">
      <div className="notes-toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filter === 'current'}
            onChange={(e) => onFilterChange(e.target.checked ? 'current' : 'all')}
          />
          {shared.currentSlideOnly}
        </label>
        {typeof filter === 'number' && (
          <button type="button" className="filter-chip" onClick={() => onFilterChange('all')} title={m.clearFilter}>
            {m.onlySlide(filter)} <X size="1em" />
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => setExpand((e) => ({ open: !e.open, gen: e.gen + 1 }))}
          disabled={!hasNotes}
        >
          {expand.open ? m.collapseAll : m.expandAll}
        </button>
        <button type="button" className="ghost-btn small" onClick={onRefresh} disabled={loading} title={shared.refresh} aria-label={shared.refresh}>
          <RefreshCw />
        </button>
      </div>

      <div className="notes-file">
        {hasNotes ? (
          <a className="notes-file-link" href={notesMarkdownUrl(docId)} target="_blank" rel="noreferrer">
            <FileText /> {m.openFile}
          </a>
        ) : (
          <span className="muted">
            <FileText /> STUDY_NOTES.md
          </span>
        )}
        {notes?.markdownPath && (
          <button
            type="button"
            className="path"
            onClick={copyPath}
            title={remote ? shared.pathTitleRemote : shared.pathTitle}
          >
            {notes.markdownPath}
          </button>
        )}
      </div>

      <div className="notes-scroll">
        {error && (
          <div className="inline-error">
            <TriangleAlert /> {m.loadFailed(error)}
          </div>
        )}
        {!notes && !error && <div className="notes-empty muted">{msg().common.loading}</div>}
        {notes && !hasNotes && (
          <div className="notes-empty">
            <div className="chat-empty-icon" aria-hidden>
              <NotebookPen strokeWidth={1.5} />
            </div>
            <p>{m.empty}</p>
            <p className="muted small">{m.emptyHint}</p>
          </div>
        )}
        {notes && hasNotes && shown.length === 0 && (
          <div className="notes-empty muted">{m.noneForSlide(filterSlide ?? 0)}</div>
        )}
        {shown.map((group) => (
          <section key={group.slide} className="note-group">
            <header className="note-group-head">
              <button
                type="button"
                className="note-thumb"
                onClick={() => onGoToSlide(group.slide)}
                title={shared.goToSlide(group.slide)}
              >
                <SlideImage
                  docId={docId}
                  slide={group.slide}
                  src={thumbUrl(docId, group.slide)}
                  alt={m.slideAlt(group.slide)}
                />
              </button>
              <div className="note-group-title">
                <button type="button" className="slide-chip" onClick={() => onGoToSlide(group.slide)}>
                  p.{group.slide}
                </button>
                <span className="muted">{m.count(group.entries.length)}</span>
              </div>
            </header>
            <div className="note-entries">
              {group.entries.map((entry) => (
                <NoteCard
                  key={`${entry.question.id}:${expand.gen}:${filterSlide === null ? 'all' : 'one'}`}
                  entry={entry}
                  providers={providers}
                  defaultOpen={expand.gen === 0 ? filterSlide !== null && group.entries.length === 1 : expand.open}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function NoteCard({
  entry,
  providers,
  defaultOpen,
}: {
  entry: NoteEntry;
  providers: ProviderInfo[] | undefined;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { question, answer } = entry;
  const multiLine = question.text.trim().includes('\n');
  const attachmentCount = question.attachments?.length ?? 0;
  const m = msg().chat.notes;
  const shared = msg().chat.shared;
  return (
    <details className="note-card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="note-q">
          <ChevronRight className="note-q-caret" size={14} />
          Q. {firstLine(question.text)}
          {attachmentCount > 0 && (
            <span className="note-att-count" title={m.attachmentsTitle(attachmentCount)}>
              <Paperclip />
              {attachmentCount}
            </span>
          )}
        </span>
        <span className="note-meta">
          {entry.sessionTitle} · {providerLabel(providers, entry.provider)} · {formatTime(question.createdAt)}
        </span>
      </summary>
      {/* Render the body only when open: many cards with KaTeX are expensive. */}
      {open && (
        <div className="note-body">
          {multiLine && <div className="note-question">{question.text}</div>}
          <AttachmentThumbs attachments={question.attachments} className="in-notes" />
          {!answer ? (
            <div className="msg-note">{m.noAnswer}</div>
          ) : answer.status === 'complete' ? (
            <Markdown text={answer.text} />
          ) : (
            <>
              {answer.text && <Markdown text={answer.text} />}
              <div className={answer.status === 'error' ? 'msg-error' : 'msg-note'}>
                {answer.status === 'error' ? (
                  <>
                    <TriangleAlert /> {shared.answerFailed(answer.error ?? '')}
                  </>
                ) : answer.status === 'aborted' ? (
                  <>
                    <Square fill="currentColor" /> {shared.answerAborted}
                  </>
                ) : (
                  <>
                    <Hourglass /> {shared.answerUnfinished}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </details>
  );
}
