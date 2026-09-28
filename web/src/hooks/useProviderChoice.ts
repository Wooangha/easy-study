import { useCallback, useMemo, useState } from 'react';
import type { ProviderInfo } from '../../../shared/types.ts';
import { effectiveChoice, parseStoredChoice, storedChoice } from '../lib/providerChoice.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../lib/providerChoice.ts';
import { readStorage, storageKeys, writeStorage } from '../lib/storage.ts';

export type { ProviderChoice, ProviderChoiceUpdate };

/**
 * The stored choice when its provider is available (see effectiveChoice), otherwise the first available provider
 * with its default model. null while health is unknown or when no provider is available.
 */
export function useProviderChoice(providers: ProviderInfo[] | undefined) {
  const [stored, setStored] = useState<ProviderChoice | null>(() =>
    parseStoredChoice(readStorage<unknown>(storageKeys.providerChoice, null)),
  );

  const choice = useMemo(() => effectiveChoice(providers, stored), [providers, stored]);

  const setChoice = useCallback(
    (next: ProviderChoiceUpdate) => {
      const value = storedChoice(stored, next);
      setStored(value);
      writeStorage(storageKeys.providerChoice, value);
    },
    [stored],
  );

  return [choice, setChoice] as const;
}
