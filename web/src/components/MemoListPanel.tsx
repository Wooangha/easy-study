// The 메모 tab (DESIGN §25): every memo of the lecture from the annotation summary (no per-slide loads), searched
// over text and tags, filtered by tag or to the focused slide. A row opens the memo on its slide; its ⋯ deletes it.
// Below them, collapsed, 빠진 슬라이드 (DESIGN §28): the 필기 of slides a new version of the PDF dropped, read-only (a
// slide's 펜 strokes as one row, "손글씨 N획", DESIGN §29).
import { useEffect, useMemo, useState } from 'react';
import { Mic, RefreshCw, StickyNote, TriangleAlert } from 'lucide-react';
import type { MemoSummary, RemovedSlide } from '../../../shared/types.ts';
import { ApiError, getRemovedSlides, removedThumbUrl, versionErrorMessage } from '../api.ts';
import { useAnnotations } from '../hooks/useAnnotations.ts';
import { msg } from '../i18n/index.ts';
import { EMPTY_MEMO_FILTER, filterMemos, memoLines, memoTagCounts } from '../lib/annotations/memoList.ts';
import { confirmDialog } from '../lib/confirm.ts';
import { formatTime } from '../lib/format.ts';
import { formatClock } from '../lib/recording/timeline.ts';
import { toast } from '../lib/toast.ts';
import { removedRows } from '../lib/versionPlan.ts';
import { EyeIcon } from './annotations/icons.tsx';
import { PopoverMenu } from './organize/PopoverMenu.tsx';

interface MemoListPanelProps {
  docId: string;
  focusedSlide: number;
  /** A row was clicked: show the memo on its slide (selected and expanded). */
  onOpenMemo: (slide: number, id: string) => void;
  onGoToSlide: (slide: number) => void;
  /** A memo's recording chip (mic icon): play that moment in the 녹음 tab. */
  onPlayRecording: (rid: string, t: number) => void;
}

export function MemoListPanel({ docId, focusedSlide, onOpenMemo, onGoToSlide, onPlayRecording }: MemoListPanelProps) {
  const { store, snapshot } = useAnnotations(docId);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [currentOnly, setCurrentOnly] = useState(false);
  const summary = snapshot.summary;
  const memos = summary?.memos ?? [];
  const tags = useMemo(() => memoTagCounts(memos), [memos]);
  const shown = useMemo(
    () => filterMemos(memos, { ...EMPTY_MEMO_FILTER, query, tag, slide: currentOnly ? focusedSlide : null }),
    [memos, query, tag, currentOnly, focusedSlide],
  );
  const filtering = query.trim() !== '' || tag !== null || currentOnly;

  const remove = async (m: MemoSummary) => {
    if (!store) return;
    if (m.text.trim() !== '') {
      const ok = await confirmDialog({
        title: msg().chat.memos.deleteTitle,
        message: memoLines(m.text)[0],
        confirmLabel: msg().common.delete,
        danger: true,
      });
      if (!ok) return;
    }
    const doc = await store.ensureSlide(m.slide);
    if (!doc || !doc.items.some((it) => it.id === m.id)) {
      toast(msg().chat.memos.alreadyDeleted, 'info');
      return;
    }
    store.mutate(m.slide, [{ op: 'remove', id: m.id }]);
  };

  const words = msg().chat.memos;
  const shared = msg().chat.shared;
  return (
    <div className="notes-panel memo-panel">
      <div className="notes-toolbar">
        <input
          className="memo-search"
          type="search"
          value={query}
          placeholder={words.search}
          aria-label={words.search}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="checkbox">
          <input type="checkbox" checked={currentOnly} onChange={(e) => setCurrentOnly(e.target.checked)} />
          {shared.currentSlideOnly}
        </label>
        <span className="spacer" />
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => void store?.ensureSummary(true)}
          title={shared.refresh}
          aria-label={shared.refresh}
        >
          <RefreshCw />
        </button>
      </div>
      {tags.length > 0 && (
        <div className="memo-tag-bar" role="group" aria-label={words.tagFilter}>
          {tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              className={t.tag === tag ? 'filter-chip is-active' : 'filter-chip is-quiet'}
              aria-pressed={t.tag === tag}
              onClick={() => setTag((current) => (current === t.tag ? null : t.tag))}
              title={t.tag === tag ? words.clearTag : words.onlyTag(t.tag)}
            >
              #{t.tag} <span className="memo-tag-count">{t.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="notes-scroll">
        {snapshot.summaryError && !summary && (
          <div className="inline-error">
            <TriangleAlert /> {words.loadFailed(snapshot.summaryError)}
          </div>
        )}
        {!summary && !snapshot.summaryError && <div className="notes-empty muted">{msg().common.loading}</div>}
        {summary && memos.length === 0 && (
          <div className="notes-empty">
            <div className="chat-empty-icon" aria-hidden>
              <StickyNote strokeWidth={1.5} />
            </div>
            <p>{words.empty}</p>
            <p className="muted small">{words.emptyHint}</p>
          </div>
        )}
        {summary && memos.length > 0 && shown.length === 0 && (
          <div className="notes-empty muted">{filtering ? words.noMatch : words.none}</div>
        )}
        {shown.map((m) => {
          const [first, second] = memoLines(m.text);
          const recording = m.links.find((l) => l.kind === 'recording');
          return (
            <div
              key={m.id}
              className={`memo-row is-${m.color}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpenMemo(m.slide, m.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenMemo(m.slide, m.id);
                }
              }}
              title={words.openTitle}
            >
              <span className="memo-row-bar" aria-hidden />
              <div className="memo-row-main">
                <div className="memo-row-head">
                  <button
                    type="button"
                    className="slide-chip"
                    onClick={(e) => {
                      e.stopPropagation();
                      onGoToSlide(m.slide);
                    }}
                    title={shared.goToSlide(m.slide)}
                  >
                    p.{m.slide}
                  </button>
                  <span className="muted small">{formatTime(m.updatedAt)}</span>
                  {!m.tutor && (
                    <span className="memo-row-hidden" role="img" title={words.hiddenFromTutor} aria-label={words.hiddenFromTutor}>
                      <EyeIcon off />
                    </span>
                  )}
                </div>
                <div className="memo-row-line">{first}</div>
                {second && <div className="memo-row-line is-second">{second}</div>}
                {(m.tags.length > 0 || recording) && (
                  <div className="memo-row-tags">
                    {m.tags.map((t) => (
                      <span key={t} className="memo-tag">
                        #{t}
                      </span>
                    ))}
                    {recording && recording.kind === 'recording' && (
                      <button
                        type="button"
                        className="memo-link-go"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlayRecording(recording.rid, recording.t);
                        }}
                        title={words.playTitle}
                      >
                        <Mic /> {formatClock(recording.t)}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <PopoverMenu
                  label={words.menu}
                  sections={[
                    {
                      items: [
                        { key: 'open', label: words.openOnSlide, onSelect: () => onOpenMemo(m.slide, m.id) },
                        { key: 'delete', label: words.delete, danger: true, onSelect: () => void remove(m) },
                      ],
                    },
                  ]}
                />
              </span>
            </div>
          );
        })}
        <RemovedSlides docId={docId} />
      </div>
    </div>
  );
}

/** 빠진 슬라이드: what sat on the slides new versions dropped, with the old thumbnail and "예전 p.N". Loaded once (the panel is keyed by the deck's rev). */
function RemovedSlides({ docId }: { docId: string }) {
  const [state, setState] = useState<{ slides: RemovedSlide[] } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getRemovedSlides(docId)
      .then((slides) => {
        if (!cancelled) setState({ slides });
      })
      .catch((e: unknown) => {
        // A server without the archive (404) has nothing to show.
        if (!cancelled) setState(e instanceof ApiError && e.status === 404 ? { slides: [] } : { error: versionErrorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);
  if (!state) return null;
  const m = msg().versions.removed;
  if ('error' in state) {
    return (
      <div className="inline-error">
        <TriangleAlert /> {m.loadFailed(state.error)}
      </div>
    );
  }
  const slides = state.slides.filter((s) => s.items.length > 0);
  if (slides.length === 0) return null;
  const rows = slides.map((s) => ({ slide: s, rows: removedRows(s.items) }));
  const count = rows.reduce((n, r) => n + r.rows.length, 0);
  return (
    <details className="removed-slides">
      <summary title={m.title}>
        {m.heading} <span className="memo-tag-count">{count}</span>
      </summary>
      {rows.map(({ slide: s, rows: items }) => (
        <section key={`${s.rev}:${s.slide}`} className="removed-slide">
          <div className="removed-slide-head">
            {s.thumb && (
              <span className="removed-thumb">
                <img src={removedThumbUrl(docId, s.rev, s.slide)} alt={m.thumbAlt(s.slide)} loading="lazy" decoding="async" />
              </span>
            )}
            <span className="slide-chip is-static">{m.oldPage(s.slide)}</span>
          </div>
          <ul className="removed-items">
            {items.map((row) => (
              <li key={row.key} className={`removed-item${row.ink ? ' kind-ink' : ''} is-${row.color}`}>
                <span className="memo-row-bar" aria-hidden />
                <span className="removed-item-text">{row.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </details>
  );
}
