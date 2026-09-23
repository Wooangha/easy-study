import { useState } from 'react';
import type { NoteEntry, NotesResponse, ProviderInfo } from '../../../shared/types.ts';
import { notesMarkdownUrl, slideUrl } from '../api.ts';
import { firstLine, formatTime, providerLabel } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { Markdown } from './Markdown.tsx';

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
  // Bumping this remounts the <details> elements with the new default open state.
  const [expand, setExpand] = useState<{ open: boolean; gen: number }>({ open: false, gen: 0 });

  const filterSlide = filter === 'current' ? focusedSlide : filter === 'all' ? null : filter;
  const allSlides = notes?.slides ?? [];
  const shown = filterSlide === null ? allSlides : allSlides.filter((s) => s.slide === filterSlide);
  const totalEntries = allSlides.reduce((n, s) => n + s.entries.length, 0);
  const hasNotes = totalEntries > 0;

  const copyPath = () => {
    if (!notes) return;
    navigator.clipboard
      .writeText(notes.markdownPath)
      .then(() => toast('경로를 복사했어요', 'success', 2000))
      .catch(() => toast('복사하지 못했어요', 'error'));
  };

  return (
    <div className="notes-panel">
      <div className="notes-toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filter === 'current'}
            onChange={(e) => onFilterChange(e.target.checked ? 'current' : 'all')}
          />
          현재 슬라이드만
        </label>
        {typeof filter === 'number' && (
          <button type="button" className="filter-chip" onClick={() => onFilterChange('all')} title="필터 해제">
            p.{filter}만 보는 중 ✕
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => setExpand((e) => ({ open: !e.open, gen: e.gen + 1 }))}
          disabled={!hasNotes}
        >
          {expand.open ? '모두 접기' : '모두 펼치기'}
        </button>
        <button type="button" className="ghost-btn small" onClick={onRefresh} disabled={loading} title="새로고침">
          ↻
        </button>
      </div>

      <div className="notes-file">
        {hasNotes ? (
          <a className="notes-file-link" href={notesMarkdownUrl(docId)} target="_blank" rel="noreferrer">
            📄 STUDY_NOTES.md 열기
          </a>
        ) : (
          <span className="muted">📄 STUDY_NOTES.md</span>
        )}
        {notes?.markdownPath && (
          <button type="button" className="path" onClick={copyPath} title="클릭해서 경로 복사">
            {notes.markdownPath}
          </button>
        )}
      </div>

      <div className="notes-scroll">
        {error && <div className="inline-error">⚠️ 노트를 불러오지 못했어요: {error}</div>}
        {!notes && !error && <div className="notes-empty muted">불러오는 중…</div>}
        {notes && !hasNotes && (
          <div className="notes-empty">
            <div className="chat-empty-icon" aria-hidden>
              📝
            </div>
            <p>아직 저장된 Q&amp;A가 없어요.</p>
            <p className="muted small">채팅에서 질문하면 슬라이드별로 자동으로 기록돼요.</p>
          </div>
        )}
        {notes && hasNotes && shown.length === 0 && (
          <div className="notes-empty muted">p.{filterSlide}에 대한 Q&amp;A가 아직 없어요.</div>
        )}
        {shown.map((group) => (
          <section key={group.slide} className="note-group">
            <header className="note-group-head">
              <button
                type="button"
                className="note-thumb"
                onClick={() => onGoToSlide(group.slide)}
                title={`슬라이드 ${group.slide}로 이동`}
              >
                <img src={slideUrl(docId, group.slide)} alt={`슬라이드 ${group.slide}`} loading="lazy" decoding="async" />
              </button>
              <div className="note-group-title">
                <button type="button" className="slide-chip" onClick={() => onGoToSlide(group.slide)}>
                  p.{group.slide}
                </button>
                <span className="muted">Q&amp;A {group.entries.length}개</span>
              </div>
            </header>
            <div className="note-entries">
              {group.entries.map((entry) => (
                <NoteCard
                  key={`${entry.question.id}:${expand.gen}`}
                  entry={entry}
                  providers={providers}
                  defaultOpen={expand.gen === 0 ? group.entries.length === 1 : expand.open}
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
  return (
    <details className="note-card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="note-q">Q. {firstLine(question.text)}</span>
        <span className="note-meta">
          {entry.sessionTitle} · {providerLabel(providers, entry.provider)} · {formatTime(question.createdAt)}
        </span>
      </summary>
      {/* Render the body only when open: many cards with KaTeX are expensive. */}
      {open && (
        <div className="note-body">
          {multiLine && <div className="note-question">{question.text}</div>}
          {!answer ? (
            <div className="msg-note">(답변 없음)</div>
          ) : answer.status === 'complete' ? (
            <Markdown text={answer.text} />
          ) : (
            <>
              {answer.text && <Markdown text={answer.text} />}
              <div className={answer.status === 'error' ? 'msg-error' : 'msg-note'}>
                {answer.status === 'error'
                  ? `⚠️ 답변 실패${answer.error ? `: ${answer.error}` : ''}`
                  : answer.status === 'aborted'
                    ? '⏹ 중단된 답변이에요'
                    : '⏳ 답변이 아직 완료되지 않았어요'}
              </div>
            </>
          )}
        </div>
      )}
    </details>
  );
}
