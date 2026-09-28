import { memo, useCallback, useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react';
import type { DigestSlide, DocMeta, ProviderInfo } from '../../../shared/types.ts';
import { totalTokens } from '../../../shared/usage.ts';
import { digestMarkdownUrl } from '../api.ts';
import { useAuth } from '../hooks/useAuth.ts';
import type { DigestState } from '../hooks/useDigest.ts';
import type { ProviderChoice } from '../hooks/useProviderChoice.ts';
import { copyText } from '../lib/clipboard.ts';
import { confirmDialog } from '../lib/confirm.ts';
import { digestContinueLabel, digestNote, digestStatusLabel, digestView } from '../lib/digestState.ts';
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

  const start = async (force: boolean) => {
    if (
      force &&
      !(await confirmDialog({
        title: '정리본을 처음부터 다시 만들까요?',
        message: '모든 슬라이드를 다시 LLM에게 보여 주고 정리해요 (시간과 사용량이 들어요).',
        confirmLabel: '다시 만들기',
      }))
    ) {
      return;
    }
    void digest.start(choice, force);
  };

  const copyPath = () => {
    if (!info?.markdownPath) return;
    void copyText(info.markdownPath)
      .then(() => toast(remote ? '서버 컴퓨터의 경로를 복사했어요' : '경로를 복사했어요', 'success', 2000))
      .catch(() => toast('복사하지 못했어요', 'error'));
  };

  const chosen = choice ? providerWithModel(providers, choice.provider, choice.model, choice.effort) : null;
  const startDisabled = !choice || pending !== null;
  const startTitle = chosen
    ? `${chosen}(으)로 만들어요 — 상단 ‘새 세션’에서 LLM을 바꿀 수 있어요`
    : (providerProblem ?? '사용 가능한 LLM이 없어요');

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
    <p className="muted small">⚠️ 슬라이드 정리가 바뀌기 전에 만든 요약이에요. 위의 ‘📘 강의 요약 다시 만들기’로 새로 만들 수 있어요.</p>
  ) : null;
  let content;
  if (!info || !s) {
    content = error ? (
      <div className="inline-error">
        ⚠️ 정리본 정보를 불러오지 못했어요: {error}{' '}
        <button type="button" className="ghost-btn small" onClick={() => void digest.refresh()}>
          다시 시도
        </button>
      </div>
    ) : (
      <div className="notes-empty muted">불러오는 중…</div>
    );
  } else if (!s.hasAny && !s.running) {
    content = (
      <div className="digest-intro">
        <div className="chat-empty-icon" aria-hidden>
          📝
        </div>
        <h3>아직 정리본이 없어요</h3>
        <p>
          LLM이 슬라이드 <b>{s.total}장</b>의 이미지를 직접 읽고, 내용을 그대로 옮겨 적은 뒤(수식·표·코드 포함) 설명과
          핵심을 붙여 정리해요. 한 번 만들어 두면 계속 재사용돼요.
        </p>
        <ul className="tips">
          <li>⚡ 새 세션을 시작할 때 이미지 대신 이 텍스트를 전달해서 더 빠르고 저렴해요</li>
          <li>🔎 텍스트 추출로는 흐트러지는 수식·표·기호(α, ε, ∪, ∈ …)도 이미지에서 정확히 읽어 와요</li>
          <li>📁 과목에 넣어 두면 다음 강의를 공부할 때 이 강의의 요약이 함께 전달돼요</li>
          <li>💬 새 세션을 처음 만들면 자동으로 만들기 시작해요</li>
        </ul>
        <button type="button" className="primary-btn" onClick={() => void start(false)} disabled={startDisabled} title={startTitle}>
          📝 정리본 만들기
        </button>
        <p className="muted small">{chosen ? `${chosen}(으)로 만들어요 · 몇 분 걸릴 수 있어요` : startTitle}</p>
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
            {s.running
              ? ` 아직 정리하는 중이에요 (${s.done} / ${s.total} 완료)`
              : ' 이 슬라이드는 아직 정리되지 않았어요. ‘이어서 만들기’로 채울 수 있어요.'}
          </div>
        )}
        <div className="digest-nav">
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => onGoToSlide(focusedSlide - 1)}
            disabled={focusedSlide <= 1}
          >
            ◀ p.{Math.max(1, focusedSlide - 1)}
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
            p.{Math.min(s.total, focusedSlide + 1)} ▶
          </button>
        </div>
        {info.summary && (
          <details className="digest-summary compact">
            <summary>📘 강의 전체 요약{s.summaryOutdated ? ' (이전 요약)' : ''}</summary>
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
            <h3>📘 강의 요약</h3>
            {outdatedNote}
            <Markdown text={info.summary} />
          </section>
        ) : (
          s.complete && <div className="digest-missing muted small">강의 요약이 아직 없어요.</div>
        )}
        {rows}
      </>
    );
  }

  return (
    <div className="digest-panel">
      <div className="notes-toolbar">
        <div className="segmented" role="group" aria-label="정리본 보기 방식">
          <button type="button" aria-pressed={mode === 'current'} onClick={() => onModeChange('current')}>
            현재 슬라이드
          </button>
          <button type="button" aria-pressed={mode === 'all'} onClick={() => onModeChange('all')}>
            전체
          </button>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => void digest.refresh()}
          disabled={loading}
          title="새로고침"
        >
          ↻
        </button>
      </div>

      {info && s && (s.hasAny || s.running) && (
        <div className={`digest-status status-${info.status}`}>
          <div className="digest-status-line">
            <span className="digest-status-label">{digestStatusLabel(info, s)}</span>
            {info.provider && (
              <span className="muted small">
                {providerWithModel(providers, info.provider, info.model, info.effort)}
                {info.updatedAt && ` · ${formatTime(info.updatedAt)}`}
              </span>
            )}
            {info.usage && (
              <span className="muted small digest-usage" title={usageTitle(info.usage, '이번 정리본 만들기에 쓴 토큰 (실패한 호출 포함)')}>
                토큰 {formatTokens(totalTokens(info.usage))}
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
                ■ 중지
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
                    {continueLabel}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => void start(true)}
                  disabled={startDisabled}
                  title={startTitle}
                >
                  다시 만들기
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
              {note.message}
              {note.hint && <div className="digest-note-hint">{note.hint}</div>}
            </div>
          )}
          <div className="digest-file">
            {s.hasAny ? (
              <a className="notes-file-link" href={digestMarkdownUrl(doc.id)} target="_blank" rel="noreferrer">
                📄 DIGEST.md 열기
              </a>
            ) : (
              <span className="muted">📄 DIGEST.md</span>
            )}
            {info.markdownPath && (
              <button
                type="button"
                className="path"
                onClick={copyPath}
                title={remote ? '서버 컴퓨터의 경로예요. 클릭해서 복사' : '클릭해서 경로 복사'}
              >
                {info.markdownPath}
              </button>
            )}
          </div>
          <div className="digest-hint">
            ⚡ 정리본은 새 세션을 시작할 때 슬라이드 이미지 대신 재사용돼서 더 빠르고 저렴해요.
          </div>
        </div>
      )}

      <div className="digest-scroll" ref={scrollRef}>
        {info && error && <div className="inline-error">⚠️ 새로고침 실패: {error}</div>}
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
        <button type="button" className="slide-chip" onClick={() => onGoToSlide(slide)} title="이 슬라이드로 이동">
          p.{slide}
        </button>
        <span className="digest-entry-title">{entry.title || <span className="muted">(제목 없음)</span>}</span>
      </header>
      {entry.failed && (
        <div className="msg-error">⚠️ 이 슬라이드는 정리하지 못했어요 — ‘이어서 만들기’로 다시 시도할 수 있어요</div>
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
      <span className="muted small">{running ? '정리 대기 중…' : '아직 정리되지 않았어요'}</span>
    </div>
  );
}
