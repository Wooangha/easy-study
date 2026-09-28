import { useSyncExternalStore } from 'react';
import { readStorage, storageKeys, writeStorage } from '../lib/storage.ts';

/** Choices of the "앞뒤 ±N" selector (slides before AND after the focused one fed with every turn). */
export const NEIGHBOR_OPTIONS = [0, 1, 2, 3] as const;
export const DEFAULT_NEIGHBORS = 1;

const isNeighborCount = (v: unknown): v is number =>
  typeof v === 'number' && (NEIGHBOR_OPTIONS as readonly number[]).includes(v);

// A tiny shared store (persisted): the chat panel's ±N and the settings dialog (DESIGN §24) show the same value.
let current: number | null = null;
const listeners = new Set<() => void>();

export function getNeighbors(): number {
  current ??= readStorage(storageKeys.neighbors, DEFAULT_NEIGHBORS, isNeighborCount);
  return current;
}

export function setNeighbors(n: number): void {
  if (!isNeighborCount(n) || n === getNeighbors()) return;
  current = n;
  writeStorage(storageKeys.neighbors, n);
  for (const l of listeners) l();
}

export function subscribeNeighbors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Neighbor window sent as `neighbors` with every question / prime (persisted). */
export function useNeighbors() {
  const neighbors = useSyncExternalStore(subscribeNeighbors, getNeighbors);
  return [neighbors, setNeighbors] as const;
}
