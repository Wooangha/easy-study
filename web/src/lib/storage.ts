// Tiny, failure-tolerant wrappers around localStorage (private mode / quota errors are ignored).

const PREFIX = 'easy-study:';

export const storageKeys = {
  split: 'split',
  lastDoc: 'lastDoc',
  zoom: 'zoom',
  providerChoice: 'providerChoice',
  slide: (docId: string) => `slide:${docId}`,
  session: (docId: string) => `session:${docId}`,
} as const;

export function readStorage<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    if (validate && !validate(value)) return fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

export function writeStorage(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isString = (v: unknown): v is string => typeof v === 'string';
