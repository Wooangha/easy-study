import { useCallback, useState } from 'react';
import { readStorage, storageKeys, writeStorage } from '../lib/storage.ts';

/** Choices of the "앞뒤 ±N" selector (slides before AND after the focused one fed with every turn). */
export const NEIGHBOR_OPTIONS = [0, 1, 2, 3] as const;
export const DEFAULT_NEIGHBORS = 1;

const isNeighborCount = (v: unknown): v is number =>
  typeof v === 'number' && (NEIGHBOR_OPTIONS as readonly number[]).includes(v);

/** Neighbor window sent as `neighbors` with every question / prime (persisted). */
export function useNeighbors() {
  const [neighbors, setState] = useState(() => readStorage(storageKeys.neighbors, DEFAULT_NEIGHBORS, isNeighborCount));
  const setNeighbors = useCallback((n: number) => {
    if (!isNeighborCount(n)) return;
    setState(n);
    writeStorage(storageKeys.neighbors, n);
  }, []);
  return [neighbors, setNeighbors] as const;
}
