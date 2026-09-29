// The LLM picker: provider, model (listed ones and 직접 입력…) and reasoning effort selects, with the compatibility
// rules of web/src/lib/providerChoice.ts. Shared by the top bar's "새 세션" choice (TopBar.tsx) and the LLM switch of
// the open session (LlmSwitchDialog.tsx).
import { useId, useState } from 'react';
import type { ProviderId, ProviderInfo } from '../../../shared/types.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../hooks/useProviderChoice.ts';
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
  const current = providers?.find((p) => p.id === choice?.provider);
  const currentModel = current?.models.find((m) => m.id === (choice?.model ?? ''));
  const [customMode, setCustomMode] = useState(false);
  const showCustom = !!choice && (customMode || !currentModel);
  const efforts = effortOptions(current, choice?.model ?? '');
  const effort = efforts.find((e) => e.id === choice?.effort);
  const unavailable = (providers ?? []).filter((p) => !p.available);
  const unavailableTitle = unavailable.map((p) => `${p.label}: ${p.reason ?? '사용 불가'}`).join('\n');
  // Two pickers may show at once (the top bar's and the dialog's): each has its own model list.
  const modelListId = `${useId()}-models`;
  const cls = ['provider-picker', className].filter(Boolean).join(' ');

  if (!providers) {
    return <span className={`${cls} muted small`}>{loading ? 'LLM 확인 중…' : 'LLM 정보 없음'}</span>;
  }

  return (
    <div className={cls} title={title}>
      {label && <span className="provider-picker-label">{label}</span>}
      <select
        className="picker"
        aria-label="LLM 선택"
        value={choice?.provider ?? ''}
        onChange={(e) => {
          const p = providers.find((x) => x.id === (e.target.value as ProviderId));
          if (!p) return;
          setCustomMode(false);
          onChange({ provider: p.id, model: p.defaultModel, effort: '' });
        }}
      >
        {!choice && <option value="">사용 가능한 LLM 없음</option>}
        {providers.map((p) => (
          <option
            key={p.id}
            value={p.id}
            disabled={!p.available}
            title={p.available ? (p.version ? `버전 ${p.version}` : undefined) : p.reason}
          >
            {p.label}
            {p.available ? '' : ' — 사용 불가'}
          </option>
        ))}
      </select>
      {current && choice && (
        <>
          <select
            className="picker model-picker"
            aria-label="모델 선택"
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
            {current.models.map((m) => (
              <option key={m.id || '__default'} value={m.id} title={m.description}>
                {m.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>직접 입력…</option>
          </select>
          {showCustom && (
            <>
              <input
                className="model-input"
                list={modelListId}
                placeholder="모델 이름"
                aria-label="모델 이름 직접 입력"
                value={choice.model}
                onChange={(e) => onChange({ provider: current.id, model: e.target.value.trim() })}
              />
              <datalist id={modelListId}>
                {current.models
                  .filter((m) => m.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </datalist>
            </>
          )}
          {/* Reasoning effort (CLI providers): "기본값" passes nothing, so the CLI's own setting applies. */}
          {current.efforts && current.efforts.length > 0 && (
            <select
              className="picker effort-picker"
              aria-label="추론 수준"
              title={
                efforts.length === 0
                  ? '이 모델은 추론 수준을 고를 수 없어요'
                  : (effort?.description ?? '추론 수준: 기본값은 CLI 설정(또는 모델 기본값)을 따라요')
              }
              value={effort ? effort.id : ''}
              disabled={efforts.length === 0}
              onChange={(e) => onChange({ ...choice, effort: e.target.value })}
            >
              <option value="">추론 기본값</option>
              {efforts.map((e) => (
                <option key={e.id} value={e.id} title={e.description}>
                  추론 {e.label}
                </option>
              ))}
            </select>
          )}
        </>
      )}
      {unavailable.length > 0 && (
        <span className="provider-warn" title={unavailableTitle} aria-label={`사용 불가 LLM: ${unavailableTitle}`}>
          ⓘ
        </span>
      )}
    </div>
  );
}
