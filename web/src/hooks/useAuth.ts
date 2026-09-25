import { useSyncExternalStore } from 'react';
import { getAuthSnapshot, subscribeAuth, type AuthSnapshot } from '../lib/auth.ts';

/** Login state (DESIGN §16): phase, whether the server asks for an access code, login epoch. */
export function useAuth(): AuthSnapshot {
  return useSyncExternalStore(subscribeAuth, getAuthSnapshot);
}

/** Increments on every successful login (e.g. to load again what failed while logged out). */
export function useLoginEpoch(): number {
  return useSyncExternalStore(subscribeAuth, () => getAuthSnapshot().epoch);
}
