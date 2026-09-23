import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isTypingTarget } from './SlideViewer.tsx';

export const QUICK_PROMPTS = ['이 슬라이드 설명해줘', '핵심만 요약', '예시로 설명', '시험 문제 내줘'] as const;

interface ComposerProps {
  /** Slide the question will be about. */
  targetSlide: number;
  pageCount: number;
  /** Neighbor slides (±N) sent along with the target slide. */
  neighbors: number;
  pinned: boolean;
  /** A turn (or session creation / priming) is running — sending is disabled. */
  running: boolean;
  /** Stop is possible (a live turn exists and stop was not requested yet). */
  canStop: boolean;
  /** When set, sending is impossible and this explains why. */
  disabledReason: string | null;
  /** Resolves false when the question was not accepted (the text is then restored). */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onGoToSlide: (slide: number) => void;
}

const MAX_TEXTAREA_PX = 220;

export function Composer({
  targetSlide,
  pageCount,
  neighbors,
  pinned,
  running,
  canStop,
  disabledReason,
  onSend,
  onStop,
  onGoToSlide,
}: ComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const blocked = running || disabledReason !== null;

  // Auto-grow the textarea up to a max height.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text]);

  // "/" focuses the composer (when not already typing somewhere).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      textareaRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = async (value: string, fromComposer: boolean) => {
    const question = value.trim();
    if (!question || blocked) return;
    if (fromComposer) setText('');
    const accepted = await onSend(question);
    // Put the question back if it never reached the server (keeps anything typed meanwhile).
    if (!accepted && fromComposer) setText((current) => current || value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // IME (Korean) composition: the Enter that commits a syllable must not send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send(text, true);
  };

  const from = Math.max(1, targetSlide - neighbors);
  const to = Math.min(pageCount, targetSlide + neighbors);
  const withNeighbors = to > from ? ` (p.${from}–${to}도 함께 전달)` : '';

  const placeholder = disabledReason
    ? disabledReason
    : running
      ? '답변을 기다리는 중… (다음 질문을 미리 써 둘 수 있어요)'
      : `p.${targetSlide}에 대해 질문하세요 · Enter 전송 · Shift+Enter 줄바꿈`;

  return (
    <div className="composer">
      <div className="quick-prompts" role="group" aria-label="빠른 질문">
        {QUICK_PROMPTS.map((q) => (
          <button key={q} type="button" className="quick-prompt" disabled={blocked} onClick={() => void send(q, false)}>
            {q}
          </button>
        ))}
      </div>
      <div className={blocked ? 'composer-box is-blocked' : 'composer-box'}>
        <button
          type="button"
          className={pinned ? 'target-chip is-pinned' : 'target-chip'}
          onClick={() => onGoToSlide(targetSlide)}
          title={
            (pinned ? '고정된 슬라이드에 대해 질문해요 (클릭하면 이동)' : '보고 있는 슬라이드에 대해 질문해요') +
            withNeighbors
          }
        >
          {pinned ? '📌' : '📄'} p.{targetSlide}
          {to > from && <span className="target-neighbors">±{neighbors}</span>}
        </button>
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="질문 입력"
          disabled={disabledReason !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <button type="button" className="send-btn stop" onClick={onStop} disabled={!canStop} title="답변 중지">
            ■ 중지
          </button>
        ) : (
          <button
            type="button"
            className="send-btn"
            onClick={() => void send(text, true)}
            disabled={blocked || text.trim() === ''}
            title="전송 (Enter)"
          >
            전송
          </button>
        )}
      </div>
    </div>
  );
}
