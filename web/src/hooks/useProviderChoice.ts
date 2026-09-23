import { useCallback, useMemo, useState } from 'react';
import type { ProviderId, ProviderInfo } from '../../../shared/types.ts';
import { readStorage, storageKeys, writeStorage } from '../lib/storage.ts';

/** Provider + model used when creating new sessions. */
export interface ProviderChoice {
  provider: ProviderId;
  /** '' = provider default. */
  model: string;
}

const isChoice = (v: unknown): v is ProviderChoice =>
  !!v && typeof v === 'object' && typeof (v as ProviderChoice).provider === 'string' && typeof (v as ProviderChoice).model === 'string';

/**
 * The stored choice when its provider is available, otherwise the first available provider with its
 * default model. null while health is unknown or when no provider is available.
 */
export function useProviderChoice(providers: ProviderInfo[] | undefined) {
  const [stored, setStored] = useState<ProviderChoice | null>(() =>
    readStorage<ProviderChoice | null>(storageKeys.providerChoice, null, isChoice),
  );

  const choice = useMemo<ProviderChoice | null>(() => {
    if (!providers) return null;
    const available = providers.filter((p) => p.available);
    if (stored && available.some((p) => p.id === stored.provider)) return stored;
    const first = available[0];
    return first ? { provider: first.id, model: first.defaultModel } : null;
  }, [providers, stored]);

  const setChoice = useCallback((next: ProviderChoice) => {
    setStored(next);
    writeStorage(storageKeys.providerChoice, next);
  }, []);

  return [choice, setChoice] as const;
}
