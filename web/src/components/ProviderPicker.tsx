// The LLM picker: provider, model (listed ones and 직접 입력…) and reasoning effort selects, with the compatibility
// rules of web/src/lib/providerChoice.ts. Shared by the top bar's "새 세션" choice (TopBar.tsx) and the LLM switch of
// the open session (LlmSwitchDialog.tsx).
import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import type { ProviderId, ProviderInfo } from '../../../shared/types.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../hooks/useProviderChoice.ts';
import { msg } from '../i18n/index.ts';
import { effortOptions, withModel } from '../lib/providerChoice.ts';

const CUSTOM_MODEL = '__custom__';

interface ProviderPickerProps {
  providers: ProviderInfo[] | undefined;
  /** Health is still being loaded (shown while `providers` is undefined). */
  loading?: boolean;
  choice: ProviderChoice | null;
  onChange: (choice: ProviderChoiceUpdate) => void;
  /** Text before the selects (the top bar's "새 세션"); none by default. */
  label?: string;
  /** Tooltip of the whole picker. */
  title?: string;
  /** Extra class of the wrapper (the dialog stacks the selects). */
  className?: string;
}

export function ProviderPicker({ providers, loading = false, choice, onChange, label, title, className }: ProviderPickerProps) {
  const m = msg().shell.llm;
  const current = providers?.find((p) => p.id === choice?.provider);
  const currentModel = current?.models.find((x) => x.id === (choice?.model ?? ''));
  const [customMode, setCustomMode] = useState(false);
  const showCustom = !!choice && (customMode || !currentModel);
  const efforts = effortOptions(current, choice?.model ?? '');
  const effort = efforts.find((e) => e.id === choice?.effort);
  const unavailable = (providers ?? []).filter((p) => !p.available);
  const unavailableTitle = unavailable.map((p) => `${p.label}: ${p.reason ?? m.unavailable}`).join('\n');
  // Two pickers may show at once (the top bar's and the dialog's): each has its own model list.
  const modelListId = `${useId()}-models`;
  const cls = ['provider-picker', className].filter(Boolean).join(' ');

  if (!providers) {
    return <span className={`${cls} muted small`}>{loading ? m.checking : m.noInfo}</span>;
  }

  return (
    <div className={cls} title={title}>
      {label && <span className="provider-picker-label">{label}</span>}
      <select
        className="picker"
        aria-label={m.choose}
        value={choice?.provider ?? ''}
        onChange={(e) => {
          const p = providers.find((x) => x.id === (e.target.value as ProviderId));
          if (!p) return;
          setCustomMode(false);
          onChange({ provider: p.id, model: p.defaultModel, effort: '' });
        }}
      >
        {!choice && <option value="">{m.noneAvailable}</option>}
        {providers.map((p) => (
          <option
            key={p.id}
            value={p.id}
            disabled={!p.available}
            title={p.available ? (p.version ? m.version(p.version) : undefined) : p.reason}
          >
            {p.label}
            {p.available ? '' : m.unavailableSuffix}
          </option>
        ))}
      </select>
      {current && choice && (
        <>
          <select
            className="picker model-picker"
            aria-label={m.chooseModel}
            title={showCustom ? undefined : currentModel?.description}
            value={showCustom ? CUSTOM_MODEL : choice.model}
            onChange={(e) => {
              if (e.target.value === CUSTOM_MODEL) {
                setCustomMode(true);
                return;
              }
              setCustomMode(false);
              onChange(withModel(current, choice, e.target.value));
            }}
          >
            {current.models.map((x) => (
              <option key={x.id || '__default'} value={x.id} title={x.description}>
                {x.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>{m.customModel}</option>
          </select>
          {showCustom && (
            <>
              <input
                className="model-input"
                list={modelListId}
                placeholder={m.modelName}
                aria-label={m.modelNameInput}
                value={choice.model}
                onChange={(e) => onChange({ provider: current.id, model: e.target.value.trim() })}
              />
              <datalist id={modelListId}>
                {current.models
                  .filter((x) => x.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
              </datalist>
            </>
          )}
          {/* Reasoning effort (CLI providers): "기본값" passes nothing, so the CLI's own setting applies. */}
          {current.efforts && current.efforts.length > 0 && (
            <select
              className="picker effort-picker"
              aria-label={m.effort}
              title={efforts.length === 0 ? m.effortNotSupported : (effort?.description ?? m.effortDefaultHint)}
              value={effort ? effort.id : ''}
              disabled={efforts.length === 0}
              onChange={(e) => onChange({ ...choice, effort: e.target.value })}
            >
              <option value="">{m.effortDefault}</option>
              {efforts.map((e) => (
                <option key={e.id} value={e.id} title={e.description}>
                  {m.effortOption(e.label)}
                </option>
              ))}
            </select>
          )}
        </>
      )}
      {unavailable.length > 0 &&
        (className?.includes('is-stacked') ? (
          // Stacked (a panel or dialog): room for words — which LLMs cannot be used; why is in the tooltip.
          <span className="provider-warn is-text" title={unavailableTitle}>
            <Info /> {m.unavailableList(unavailable.map((p) => p.label).join(', '))}
          </span>
        ) : (
          <span className="provider-warn" role="img" title={unavailableTitle} aria-label={m.unavailableLabel(unavailableTitle)}>
            <Info />
          </span>
        ))}
    </div>
  );
}
