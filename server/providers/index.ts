// Provider registry + availability report for GET /api/health.
import type { ModelOption, ProviderId, ProviderInfo } from '../../shared/types.ts';
import type { Provider, ProviderAvailability } from './types.ts';
import { anthropicApiProvider } from './anthropicApi.ts';
import { claudeCodeProvider } from './claudeCode.ts';
import { codexProvider } from './codex.ts';
import { openaiApiProvider } from './openaiApi.ts';
import { errorMessage } from './proc.ts';

/** How long detect() results are reused. */
export const AVAILABILITY_TTL_MS = 60_000;

const PROVIDERS: readonly Provider[] = [claudeCodeProvider, codexProvider, anthropicApiProvider, openaiApiProvider];

export function getProvider(id: ProviderId): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function listProviders(): Provider[] {
  return [...PROVIDERS];
}

let cache: { at: number; availability: Map<ProviderId, ProviderAvailability> } | null = null;
let pending: Promise<Map<ProviderId, ProviderAvailability>> | null = null;

/** Forget cached availability (e.g. after the user installed a CLI). */
export function clearProviderInfoCache(): void {
  cache = null;
}

/**
 * Info about every provider, including availability and the models / effort levels detect() found (else the
 * provider's static ones). detect() runs in parallel for all providers, results are cached for AVAILABILITY_TTL_MS,
 * and failures become `available: false` (never throws).
 */
export async function providerInfos(): Promise<ProviderInfo[]> {
  const availability = await cachedAvailability();
  return PROVIDERS.map((p) => {
    const a = availability.get(p.id) ?? { available: false, reason: '확인할 수 없습니다.' };
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

async function cachedAvailability(): Promise<Map<ProviderId, ProviderAvailability>> {
  if (cache && Date.now() - cache.at < AVAILABILITY_TTL_MS) return cache.availability;
  // Concurrent callers share one round of detect() calls.
  if (!pending) {
    pending = detectAll()
      .then((availability) => {
        cache = { at: Date.now(), availability };
        return availability;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

async function detectAll(): Promise<Map<ProviderId, ProviderAvailability>> {
  const results = await Promise.all(PROVIDERS.map((p) => safeDetect(p)));
  return new Map(PROVIDERS.map((p, i) => [p.id, results[i]]));
}

async function safeDetect(provider: Provider): Promise<ProviderAvailability> {
  try {
    const result = await provider.detect();
    return result && typeof result.available === 'boolean'
      ? result
      : { available: false, reason: '알 수 없는 상태입니다.' };
  } catch (err) {
    return { available: false, reason: errorMessage(err) };
  }
}
