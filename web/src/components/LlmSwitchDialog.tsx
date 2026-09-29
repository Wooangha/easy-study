// "LLM 바꾸기" (DESIGN §5 "LLM switch"): a small modal over the chat that changes the LLM of the open session, with
// the same picker as the top bar's "새 세션". The next question then starts a new provider conversation on the new
// LLM (the slides and a recap of the latest Q&A are sent again). Mounted only while open, so it starts from the
// session's LLM every time.
import { useLayoutEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../../shared/types.ts';
import type { ProviderChoice } from '../hooks/useProviderChoice.ts';
import { providerWithModel } from '../lib/format.ts';
import { effectiveChoice, sameChoice, storedChoice } from '../lib/providerChoice.ts';
import { ProviderPicker } from './ProviderPicker.tsx';

interface LlmSwitchDialogProps {
  onClose: () => void;
  providers: ProviderInfo[] | undefined;
  /** The LLM the session runs on now. */
  current: ProviderChoice;
  /** Applies the change; resolves true once it is applied (the dialog closes then). */
  onApply: (choice: ProviderChoice) => Promise<boolean>;
}

export function LlmSwitchDialog({ onClose, providers, current, onApply }: LlmSwitchDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [stored, setStored] = useState<ProviderChoice>(current);
  const [applying, setApplying] = useState(false);
  // The picker's rules: a level the model lacks reads as 기본값; an unavailable provider gives way to the first
  // available one (so a session on a provider that went away can be moved to another).
  const choice = effectiveChoice(providers, stored);
  const changed = choice !== null && !sameChoice(choice, current);

  // Like SettingsDialog: a modal <dialog> (the rest of the page is inert), Esc or the backdrop closes, focus returns.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (dialog.open) dialog.close();
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected) target.focus();
    };
  }, []);

  const apply = async () => {
    if (!choice || !changed || applying) return;
    setApplying(true);
    try {
      if (await onApply(choice)) onClose();
    } finally {
      setApplying(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="llm-switch-dialog"
      aria-labelledby="llm-switch-title"
      onCancel={(e) => {
        e.preventDefault(); // closed by unmounting
        if (!applying) onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (outside the card) closes.
        if (e.target === e.currentTarget && !applying) onClose();
      }}
    >
      <div className="llm-switch-card">
        <h2 id="llm-switch-title" className="confirm-title">
          이 세션의 LLM 바꾸기
        </h2>
        <p className="llm-switch-current">
          지금: {providerWithModel(providers, current.provider, current.model, current.effort)}
        </p>
        <ProviderPicker
          className="is-stacked"
          providers={providers}
          choice={choice}
          onChange={(next) => setStored((prev) => storedChoice(prev, next))}
        />
        <p className="muted small">
          다음 질문부터 새 LLM이 답해요. 슬라이드와 최근 대화 요약을 다시 보내서 처음 질문은 토큰이 더 들어요. 지금까지의
          대화는 그대로 남아요.
        </p>
        <div className="confirm-actions">
          <button type="button" className="ghost-btn" onClick={onClose} disabled={applying}>
            취소
          </button>
          <button type="button" className="primary-btn" onClick={() => void apply()} disabled={!changed || applying}>
            {applying ? '바꾸는 중…' : 'LLM 바꾸기'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
