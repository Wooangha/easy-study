// The top bar's "새 세션" LLM (0.6.4): one small button — "Codex · GPT-6-Luna" — instead of the three selects, which made
// the bar wrap. It opens a panel with the full ProviderPicker (provider, model, reasoning effort) stacked. The open
// session's LLM is still changed from the chat header (ChatPanel.tsx / LlmSwitchDialog.tsx).
import { Bot, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../../shared/types.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../hooks/useProviderChoice.ts';
import { msg } from '../i18n/index.ts';
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

  const m = msg().shell.llm;
  if (!providers) return <span className="muted small">{loading ? m.checking : m.noInfo}</span>;

  const current = providers.find((p) => p.id === choice?.provider);
  const model = current?.models.find((x) => x.id === (choice?.model ?? ''));
  const modelText = model?.label ?? choice?.model ?? '';
  const full = choice ? providerWithModel(providers, choice.provider, choice.model, choice.effort) : m.noneAvailable;

  return (
    <>
      <button
        ref={setButton}
        type="button"
        className={open ? 'llm-chip is-open' : 'llm-chip'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={m.newSessionLlmIs(full)}
        title={m.newSessionLlmIs(full)}
        onClick={() => setOpen((o) => !o)}
      >
        <Bot className="llm-chip-icon" />
        <span className="llm-chip-text">
          {current ? shortProviderLabel(current.label) : m.noLlm}
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
          label={m.newSessionLlm}
          onScrollAway={close}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close();
            button?.focus({ preventScroll: true });
          }}
        >
          <div className="llm-pop-head">{m.newSessionLlm}</div>
          <ProviderPicker providers={providers} loading={loading} choice={choice} onChange={onChange} className="is-stacked" />
          <p className="llm-pop-hint">{m.popHint}</p>
        </Floating>
      )}
    </>
  );
}
