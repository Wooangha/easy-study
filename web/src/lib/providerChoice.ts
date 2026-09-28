// The LLM choice for new sessions and digests (top bar "새 세션"): provider, model and reasoning effort. Pure
// helpers of useProviderChoice and the top bar's pickers.
import type { EffortOption, ProviderId, ProviderInfo } from '../../../shared/types.ts';

/** Provider + model + reasoning effort used when creating new sessions (and digests). */
export interface ProviderChoice {
  provider: ProviderId;
  /** '' = provider default. */
  model: string;
  /** '' = the CLI's default (nothing is passed). */
  effort: string;
}

/** A new choice from the pickers; without `effort` (a model being typed by hand) the stored one stays. */
export type ProviderChoiceUpdate = Omit<ProviderChoice, 'effort'> & { effort?: string };

type ModelsAndEfforts = Pick<ProviderInfo, 'models' | 'efforts'>;

/**
 * The effort levels one can pick for `model` (besides 기본값): those it supports per ProviderInfo.models, all of the
 * provider's for a model typed in by hand. [] = no choice (API providers, a model without effort levels).
 */
export function effortOptions(info: ModelsAndEfforts | undefined, model: string): EffortOption[] {
  const all = info?.efforts ?? [];
  const supported = info?.models.find((m) => m.id === model)?.efforts;
  return supported ? all.filter((e) => supported.includes(e.id)) : all;
}

/** `effort` when `model` supports it, else '' (기본값). */
export function supportedEffort(info: ModelsAndEfforts | undefined, model: string, effort: string): string {
  return effort && effortOptions(info, model).some((e) => e.id === effort) ? effort : '';
}

/** A stored choice (versions before the effort choice stored none: 기본값); null when the value is not a choice. */
export function parseStoredChoice(value: unknown): ProviderChoice | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== 'string' || typeof v.model !== 'string') return null;
  return { provider: v.provider as ProviderId, model: v.model, effort: typeof v.effort === 'string' ? v.effort : '' };
}

/**
 * The choice in effect: the stored one when its provider is available (with 기본값 effort when its model no longer
 * supports the stored one), otherwise the first available provider with its default model. null while health is
 * unknown or when no provider is available.
 */
export function effectiveChoice(providers: ProviderInfo[] | undefined, stored: ProviderChoice | null): ProviderChoice | null {
  if (!providers) return null;
  const available = providers.filter((p) => p.available);
  const info = stored ? available.find((p) => p.id === stored.provider) : undefined;
  if (stored && info) {
    const effort = supportedEffort(info, stored.model, stored.effort);
    return effort === stored.effort ? stored : { ...stored, effort };
  }
  const first = available[0];
  return first ? { provider: first.id, model: first.defaultModel, effort: '' } : null;
}

/** The choice after picking another model: the effort stays when the new model supports it, else 기본값. */
export function withModel(info: ModelsAndEfforts, choice: ProviderChoice, model: string): ProviderChoice {
  return { ...choice, model, effort: supportedEffort(info, model, choice.effort) };
}

/**
 * The choice to store for `next`. Without an effort (the model text box, on every keystroke) the level the user
 * picked stays, taken from the stored choice rather than the effective one: a partly typed name can be a listed
 * model without that level, and effectiveChoice already shows and sends 기본값 while the model lacks it.
 */
export function storedChoice(stored: ProviderChoice | null, next: ProviderChoiceUpdate): ProviderChoice {
  const effort = next.effort ?? (stored?.provider === next.provider ? stored.effort : '');
  return { provider: next.provider, model: next.model, effort };
}
