// Provider registry + availability report for GET /api/health.
//
// Every text of the report is in the request's language (DESIGN §27), from one availability cache that every language
// shares: each provider's checks (its CLI's --version, the Codex model catalog, an API key) run once per
// AVAILABILITY_TTL_MS through probe(), and the reasons, model and effort labels are worded for the request when it is
// answered; the providers' labels and static choices are getters.
import type { ModelOption, ProviderId, ProviderInfo } from '../../shared/types.ts';
import { smsg } from '../i18n.ts';
import type { Provider, ProviderAvailability } from './types.ts';
import { anthropicApiProvider } from './anthropicApi.ts';
import { claudeCodeProvider } from './claudeCode.ts';
import { codexProvider } from './codex.ts';
import { openaiApiProvider } from './openaiApi.ts';
import { errorMessage } from './proc.ts';

/** How long the results of the availability checks are reused (by every language). */
export const AVAILABILITY_TTL_MS = 60_000;

const PROVIDERS: readonly Provider[] = [claudeCodeProvider, codexProvider, anthropicApiProvider, openaiApiProvider];

export function getProvider(id: ProviderId): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function listProviders(): Provider[] {
  return [...PROVIDERS];
}

/** What each provider's checks found, worded in the current language when called (never throws). */
type Localized = () => ProviderAvailability;

let cache: { at: number; availability: Map<ProviderId, Localized> } | null = null;
let pending: Promise<Map<ProviderId, Localized>> | null = null;

/** Forget cached availability (e.g. after the user installed a CLI). */
export function clearProviderInfoCache(): void {
  cache = null;
}

/**
 * Info about every provider, including availability and the models / effort levels detection found (else the
 * provider's static ones), in the request's language. The checks run in parallel for all providers, their results are
 * cached for AVAILABILITY_TTL_MS whatever the language, and failures become `available: false` (never throws).
 */
export async function providerInfos(): Promise<ProviderInfo[]> {
  const availability = await cachedAvailability();
  return PROVIDERS.map((p) => {
    const a = availability.get(p.id)?.() ?? { available: false, reason: smsg().chat.providers.cannotCheck };
    const info: ProviderInfo = {
      id: p.id,
      label: p.label,
      kind: p.kind,
      available: a.available,
      models: (a.models ?? p.models).map(copyModel),
      defaultModel: p.defaultModel,
    };
    const efforts = a.efforts ?? p.efforts;
    if (efforts && efforts.length > 0) info.efforts = efforts.map((e) => ({ ...e }));
    if (a.reason) info.reason = a.reason;
    if (a.version) info.version = a.version;
    return info;
  });
}

function copyModel(model: ModelOption): ModelOption {
  return model.efforts ? { ...model, efforts: [...model.efforts] } : { ...model };
}

async function cachedAvailability(): Promise<Map<ProviderId, Localized>> {
  if (cache && Date.now() - cache.at < AVAILABILITY_TTL_MS) return cache.availability;
  // Concurrent callers (in any language) share one round of checks.
  pending ??= probeAll()
    .then((availability) => {
      cache = { at: Date.now(), availability };
      return availability;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

async function probeAll(): Promise<Map<ProviderId, Localized>> {
  const results = await Promise.all(PROVIDERS.map((p) => safeProbe(p)));
  return new Map(PROVIDERS.map((p, i) => [p.id, results[i]]));
}

async function safeProbe(provider: Provider): Promise<Localized> {
  let localize: Localized;
  try {
    if (provider.probe) {
      localize = await provider.probe();
    } else {
      const detected = await provider.detect(); // worded once, in the language of this first request
      localize = () => detected;
    }
  } catch (err) {
    const reason = errorMessage(err);
    return () => ({ available: false, reason });
  }
  return () => {
    try {
      const result = localize();
      return result && typeof result.available === 'boolean' ? result : { available: false, reason: smsg().chat.providers.unknownState };
    } catch (err) {
      return { available: false, reason: errorMessage(err) };
    }
  };
}
