// The top bar's "새 세션" LLM (0.6.4): one small button — "Codex · GPT-6-Luna" — instead of the three selects, which made
// the bar wrap. It opens a panel with the full ProviderPicker (provider, model, reasoning effort) stacked. The open
// session's LLM is still changed from the chat header (ChatPanel.tsx / LlmSwitchDialog.tsx).
import { Bot, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../../shared/types.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../hooks/useProviderChoice.ts';
import { providerWithModel } from '../lib/format.ts';
import { Floating } from './annotations/Floating.tsx';
import { ProviderPicker } from './ProviderPicker.tsx';

interface NewSessionLlmProps {
  providers: ProviderInfo[] | undefined;
  loading: boolean;
  choice: ProviderChoice | null;
  onChange: (choice: ProviderChoiceUpdate) => void;
}

/** "Claude Code (구독)" → "Claude Code": the button keeps the product name; the panel shows the whole label. */
export const shortProviderLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '') || label;

export function NewSessionLlm({ providers, loading, choice, onChange }: NewSessionLlmProps) {
  const [open, setOpen] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (button?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, button]);

  if (!providers) return <span className="muted small">{loading ? 'LLM 확인 중…' : 'LLM 정보 없음'}</span>;

  const current = providers.find((p) => p.id === choice?.provider);
  const model = current?.models.find((m) => m.id === (choice?.model ?? ''));
  const modelText = model?.label ?? choice?.model ?? '';
  const full = choice ? providerWithModel(providers, choice.provider, choice.model, choice.effort) : '사용 가능한 LLM 없음';

  return (
    <>
      <button
        ref={setButton}
        type="button"
        className={open ? 'llm-chip is-open' : 'llm-chip'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`새 세션에 쓸 LLM: ${full}`}
        title={`새 세션에 쓸 LLM: ${full}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Bot className="llm-chip-icon" />
        <span className="llm-chip-text">
          {current ? shortProviderLabel(current.label) : 'LLM 없음'}
          {modelText && <span className="llm-chip-model"> · {modelText}</span>}
        </span>
        <ChevronDown className="llm-chip-caret" />
      </button>
      {open && (
        <Floating
          ref={panelRef}
          anchor={button}
          width={300}
          height={230}
          className="llm-pop"
          role="dialog"
          label="새 세션에 쓸 LLM"
          onScrollAway={close}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close();
            button?.focus({ preventScroll: true });
          }}
        >
          <div className="llm-pop-head">새 세션에 쓸 LLM</div>
          <ProviderPicker providers={providers} loading={loading} choice={choice} onChange={onChange} className="is-stacked" />
          <p className="llm-pop-hint">지금 세션의 LLM은 채팅 위의 LLM 이름을 눌러 바꿔요.</p>
        </Floating>
      )}
    </>
  );
}
