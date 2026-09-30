import { memo, useCallback, useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react';
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  Hourglass,
  MessageCircle,
  NotebookPen,
  Pause,
  Play,
  RefreshCw,
  Search,
  Square,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type { DigestSlide, DocMeta, ProviderInfo } from '../../../shared/types.ts';
import { totalTokens } from '../../../shared/usage.ts';
import { digestMarkdownUrl } from '../api.ts';
import { useAuth } from '../hooks/useAuth.ts';
import type { DigestState } from '../hooks/useDigest.ts';
import type { ProviderChoice } from '../hooks/useProviderChoice.ts';
import { msg, useLang } from '../i18n/index.ts';
import { copyText } from '../lib/clipboard.ts';
import { confirmDialog } from '../lib/confirm.ts';
import { digestContinueLabel, digestNote, digestStatusLabel, digestView, type DigestIcon, type DigestLabel } from '../lib/digestState.ts';
import { formatTime, providerWithModel } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { formatTokens, usageTitle } from '../lib/usage.ts';
import { Markdown } from './Markdown.tsx';

/** 'current' = the focused slide's entry (follows scrolling), 'all' = summary + every entry. */
export type DigestMode = 'current' | 'all';

interface DigestPanelProps {
  doc: DocMeta;
  digest: DigestState;
  providers: ProviderInfo[] | undefined;
  /** Provider/model chosen for new sessions — also used to (re)start the digest. */
  choice: ProviderChoice | null;
  /** Why no provider can be used, or null. */
  providerProblem: string | null;
  focusedSlide: number;
  /**
   * The tab is visible (auto-scrolling only happens then). ChatPanel mounts the panel only while its tab
   * is shown, so on every return it lands on the focused slide's entry again.
   */
  active: boolean;
  mode: DigestMode;
  onModeChange: (mode: DigestMode) => void;
  onGoToSlide: (slide: number) => void;
}

/** The icon before a digest label (lib/digestState.ts gives the kind, the text is plain). */
function DigestLabelIcon({ icon }: { icon: DigestIcon }) {
  switch (icon) {
    case 'continue':
      return <Play fill="currentColor" />;
    case 'retry':
      return <RefreshCw />;
    case 'summary':
      return <BookOpen />;
    case 'running':
      return <Hourglass />;
    case 'ready':
      return <Check />;
    case 'paused':
      return <Pause fill="currentColor" />;
    case 'error':
      return <TriangleAlert />;
  }
}

function DigestLabelText({ label }: { label: DigestLabel }) {
  return label.icon ? (
    <>
      <DigestLabelIcon icon={label.icon} /> {label.text}
    </>
  ) : (
    label.text
  );
}

export function DigestPanel({
  doc,
  digest,
  providers,
  choice,
  providerProblem,
  focusedSlide,
  active,
  mode,
  onModeChange,
  onGoToSlide,
}: DigestPanelProps) {
  const { info, error, loading, pending } = digest;
  // Remote mode: the path is on the server computer, not on the one this page is opened on.
  const remote = useAuth().authRequired;
  // What the digest looks like right now, derived once for the toolbar, status block and content.
  const s = info ? digestView(info, doc.pageCount) : null;
  const bySlide = new Map((info?.slides ?? []).map((e) => [e.slide, e]));

  const m = msg().chat.digest;
  const shared = msg().chat.shared;
  const start = async (force: boolean) => {
    if (force && !(await confirmDialog(msg().chat.digest.redoConfirm))) return;
    void digest.start(choice, force);
  };

  const copyPath = () => {
    if (!info?.markdownPath) return;
    const t = msg().chat.shared;
    void copyText(info.markdownPath)
      .then(() => toast(remote ? t.pathCopiedRemote : t.pathCopied, 'success', 2000))
      .catch(() => toast(t.copyFailed, 'error'));
  };

  const chosen = choice ? providerWithModel(providers, choice.provider, choice.model, choice.effort) : null;
  const startDisabled = !choice || pending !== null;
  const startTitle = chosen ? m.startTitle(chosen) : (providerProblem ?? shared.noLlm);

  // ---- Auto-scroll (mode 'all'): keep the focused slide's entry in view ------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryEls = useRef(new Map<number, HTMLElement>());
  const registerEntry = useCallback((slide: number, el: HTMLElement | null) => {
    if (el) entryEls.current.set(slide, el);
    else entryEls.current.delete(slide);
  }, []);
  /** Slide the user clicked in the list: don't chase the intermediate slides while the viewer scrolls there. */
  const clickTarget = useRef<{ slide: number; at: number } | null>(null);
  const wasActive = useRef(false);
  const entriesReady = s?.hasAny ?? false;
  /**
   * Entries that were never on screen have an estimated height (content-visibility, styles.css). After a
   * jump, the ones around the target get rendered at their real size; browsers without scroll anchoring
   * then leave the target off by that difference, so re-align on the next few frames.
   */
  const settleFrame = useRef(0);
  const settleOn = useCallback((scroller: HTMLElement, el: HTMLElement) => {
    cancelAnimationFrame(settleFrame.current);
    let frames = 0;
    const step = () => {
      const off = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
      if (Math.abs(off) > 1) scroller.scrollTop += off;
      if (++frames < 3) settleFrame.current = requestAnimationFrame(step);
    };
    settleFrame.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(settleFrame.current), []);

  useLayoutEffect(() => {
    const becameVisible = active && !wasActive.current;
    wasActive.current = active;
    if (!active) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (mode === 'current') {
      scroller.scrollTop = 0;
      return;
    }
    const pendingClick = clickTarget.current;
    if (pendingClick && performance.now() - pendingClick.at < 1500 && pendingClick.slide !== focusedSlide) return;
    clickTarget.current = null;
    const el = entryEls.current.get(focusedSlide);
    if (!el) return;
    const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
    const far = Math.abs(top - scroller.scrollTop) > scroller.clientHeight * 3;
    const instant = becameVisible || far;
    scroller.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' });
    if (instant) settleOn(scroller, el);
  }, [focusedSlide, mode, active, entriesReady, settleOn]);

  const goTo = useCallback(
    (slide: number) => {
      clickTarget.current = { slide, at: performance.now() };
      onGoToSlide(slide);
    },
    [onGoToSlide],
  );

  // ---- Render --------------------------------------------------------------------------------------
  const continueLabel = info && s ? digestContinueLabel(info, s) : null;
  const note = info && s ? digestNote(info, s) : null;
  const outdatedNote = s?.summaryOutdated ? (
    <p className="muted small">
      <TriangleAlert /> {m.outdated}
    </p>
  ) : null;
  let content;
  if (!info || !s) {
    content = error ? (
      <div className="inline-error">
        <TriangleAlert /> {m.loadFailed(error)}{' '}
        <button type="button" className="ghost-btn small" onClick={() => void digest.refresh()}>
          {msg().common.retry}
        </button>
      </div>
    ) : (
      <div className="notes-empty muted">{msg().common.loading}</div>
    );
  } else if (!s.hasAny && !s.running) {
    content = (
      <div className="digest-intro">
        <div className="chat-empty-icon" aria-hidden>
          <NotebookPen strokeWidth={1.5} />
        </div>
        <h3>{m.introTitle}</h3>
        <p>{m.intro(<b>{m.slides(s.total)}</b>)}</p>
        <ul className="tips">
          <li>
            <Zap /> {m.tipFaster}
          </li>
          <li>
            <Search /> {m.tipFormulas}
          </li>
          <li>
            <Folder /> {m.tipCourse}
          </li>
          <li>
            <MessageCircle /> {m.tipAuto}
          </li>
        </ul>
        <button type="button" className="primary-btn" onClick={() => void start(false)} disabled={startDisabled} title={startTitle}>
          <NotebookPen /> {m.make}
        </button>
        <p className="muted small">{chosen ? m.madeWith(chosen) : startTitle}</p>
      </div>
    );
  } else if (mode === 'current') {
    const entry = bySlide.get(focusedSlide);
    content = (
      <>
        {entry ? (
          <DigestEntry entry={entry} focused={false} onGoToSlide={goTo} register={null} standalone />
        ) : (
          <div className="digest-missing">
            <span className="slide-chip">p.{focusedSlide}</span>
            {s.running ? m.stillRunning(s.done, s.total) : m.notYet}
          </div>
        )}
        <div className="digest-nav">
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => onGoToSlide(focusedSlide - 1)}
            disabled={focusedSlide <= 1}
          >
            <ChevronLeft /> p.{Math.max(1, focusedSlide - 1)}
          </button>
          <span className="muted small">
            p.{focusedSlide} / {s.total}
          </span>
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => onGoToSlide(focusedSlide + 1)}
            disabled={focusedSlide >= s.total}
          >
            p.{Math.min(s.total, focusedSlide + 1)} <ChevronRight />
          </button>
        </div>
        {info.summary && (
          <details className="digest-summary compact">
            <summary>
              <BookOpen /> {m.wholeSummary(s.summaryOutdated)}
            </summary>
            {outdatedNote}
            <Markdown text={info.summary} />
          </details>
        )}
      </>
    );
  } else {
    const rows = [];
    for (let n = 1; n <= s.total; n++) {
      const entry = bySlide.get(n);
      rows.push(
        entry ? (
          <DigestEntry key={n} entry={entry} focused={n === focusedSlide} onGoToSlide={goTo} register={registerEntry} />
        ) : (
          <MissingRow
            key={n}
            slide={n}
            running={s.running}
            focused={n === focusedSlide}
            onGoToSlide={goTo}
            register={registerEntry}
          />
        ),
      );
    }
    content = (
      <>
        {info.summary ? (
          <section className="digest-summary">
            <h3>
              <BookOpen /> {m.summary}
            </h3>
            {outdatedNote}
            <Markdown text={info.summary} />
          </section>
        ) : (
          s.complete && <div className="digest-missing muted small">{m.noSummary}</div>
        )}
        {rows}
      </>
    );
  }

  return (
    <div className="digest-panel">
      <div className="notes-toolbar">
        <div className="segmented" role="group" aria-label={m.mode}>
          <button type="button" aria-pressed={mode === 'current'} onClick={() => onModeChange('current')}>
            {m.modeCurrent}
          </button>
          <button type="button" aria-pressed={mode === 'all'} onClick={() => onModeChange('all')}>
            {m.modeAll}
          </button>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => void digest.refresh()}
          disabled={loading}
          title={shared.refresh}
          aria-label={shared.refresh}
        >
          <RefreshCw />
        </button>
      </div>

      {info && s && (s.hasAny || s.running) && (
        <div className={`digest-status status-${info.status}`}>
          <div className="digest-status-line">
            <span className="digest-status-label">
              <DigestLabelText label={digestStatusLabel(info, s)} />
            </span>
            {info.provider && (
              <span className="muted small">
                {providerWithModel(providers, info.provider, info.model, info.effort)}
                {info.updatedAt && ` · ${formatTime(info.updatedAt)}`}
              </span>
            )}
            {info.usage && (
              <span className="muted small digest-usage" title={usageTitle(info.usage, m.tokensTitle)}>
                {m.tokens(formatTokens(totalTokens(info.usage)))}
              </span>
            )}
            <span className="spacer" />
            {s.running ? (
              <button
                type="button"
                className="ghost-btn small danger"
                onClick={() => void digest.abort()}
                disabled={pending !== null}
              >
                <Square fill="currentColor" /> {shared.stop}
              </button>
            ) : (
              <>
                {continueLabel && (
                  <button
                    type="button"
                    className="ghost-btn small accent"
                    onClick={() => void start(false)}
                    disabled={startDisabled}
                    title={startTitle}
                  >
                    <DigestLabelText label={continueLabel} />
                  </button>
                )}
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => void start(true)}
                  disabled={startDisabled}
                  title={startTitle}
                >
                  {m.redo}
                </button>
              </>
            )}
          </div>
          {!s.complete && (
            <div className="digest-progress">
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.done}>
                <div className="progress-fill" style={{ width: `${s.total > 0 ? Math.round((s.done / s.total) * 100) : 0}%` }} />
              </div>
              <span className="doc-progress-text">
                {s.done} / {s.total}
              </span>
            </div>
          )}
          {note && (
            <div className={info.status === 'error' ? 'msg-error' : 'msg-note'}>
              <TriangleAlert /> {note.message}
              {note.hint && <div className="digest-note-hint">{note.hint}</div>}
            </div>
          )}
          <div className="digest-file">
            {s.hasAny ? (
              <a className="notes-file-link" href={digestMarkdownUrl(doc.id)} target="_blank" rel="noreferrer">
                <FileText /> {m.openFile}
              </a>
            ) : (
              <span className="muted">
                <FileText /> DIGEST.md
              </span>
            )}
            {info.markdownPath && (
              <button
                type="button"
                className="path"
                onClick={copyPath}
                title={remote ? shared.pathTitleRemote : shared.pathTitle}
              >
                {info.markdownPath}
              </button>
            )}
          </div>
          <div className="digest-hint">
            <Zap /> {m.hint}
          </div>
        </div>
      )}

      <div className="digest-scroll" ref={scrollRef}>
        {info && error && (
          <div className="inline-error">
            <TriangleAlert /> {m.refreshFailed(error)}
          </div>
        )}
        {content}
      </div>
    </div>
  );
}

/** Ignore clicks that select text or hit a link / control inside the entry. */
function isPlainClick(e: MouseEvent<HTMLElement>): boolean {
  if (window.getSelection()?.toString()) return false;
  return !(e.target instanceof Element && e.target.closest('a, button, summary, input, select, textarea'));
}

interface DigestEntryProps {
  entry: DigestSlide;
  focused: boolean;
  onGoToSlide: (slide: number) => void;
  /** Registers the element for auto-scrolling (list mode); null in single-entry mode. */
  register: ((slide: number, el: HTMLElement | null) => void) | null;
  /** Single entry shown in "현재 슬라이드" mode (not clickable as a whole). */
  standalone?: boolean;
}

const DigestEntry = memo(function DigestEntry({ entry, focused, onGoToSlide, register, standalone }: DigestEntryProps) {
  useLang(); // memo(): re-render on a change of the language
  const m = msg().chat;
  const { slide } = entry;
  const setRef = useCallback((el: HTMLElement | null) => register?.(slide, el), [register, slide]);
  const cls = ['digest-entry', focused && 'is-focused', entry.failed && 'is-failed', !standalone && 'is-clickable']
    .filter(Boolean)
    .join(' ');
  return (
    <article
      ref={setRef}
      className={cls}
      onClick={standalone ? undefined : (e) => isPlainClick(e) && onGoToSlide(slide)}
    >
      <header className="digest-entry-head">
        <button type="button" className="slide-chip" onClick={() => onGoToSlide(slide)} title={m.shared.goToThisSlide}>
          p.{slide}
        </button>
        <span className="digest-entry-title">{entry.title || <span className="muted">{m.digest.untitled}</span>}</span>
      </header>
      {entry.failed && (
        <div className="msg-error">
          <TriangleAlert /> {m.digest.slideFailed}
        </div>
      )}
      {entry.markdown && (
        <div className="digest-body">
          <Markdown text={entry.markdown} />
        </div>
      )}
    </article>
  );
});

function MissingRow({
  slide,
  running,
  focused,
  onGoToSlide,
  register,
}: {
  slide: number;
  running: boolean;
  focused: boolean;
  onGoToSlide: (slide: number) => void;
  register: (slide: number, el: HTMLElement | null) => void;
}) {
  const setRef = useCallback((el: HTMLElement | null) => register(slide, el), [register, slide]);
  return (
    <div ref={setRef} className={focused ? 'digest-missing is-focused' : 'digest-missing'}>
      <button type="button" className="slide-chip" onClick={() => onGoToSlide(slide)}>
        p.{slide}
      </button>
      <span className="muted small">{running ? msg().chat.digest.waiting : msg().chat.digest.notDigested}</span>
    </div>
  );
}
