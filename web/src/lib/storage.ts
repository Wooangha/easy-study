// Tiny, failure-tolerant wrappers around localStorage (private mode / quota errors are ignored).

const PREFIX = 'easy-study:';

export const storageKeys = {
  split: 'split',
  lastDoc: 'lastDoc',
  zoom: 'zoom',
  providerChoice: 'providerChoice',
  /** Neighbor slides (±N) fed with every question. */
  neighbors: 'neighbors',
  /** Digest tab content mode ('current' | 'all'). */
  digestMode: 'digestMode',
  /** Course that uploads from the library drop zone / top bar go into (null = uncategorized). */
  uploadCourse: 'uploadCourse',
  /** Collapsed courses and groups of the library (`course:<id>` / `group:<id>`, per device). */
  collapsed: 'collapsed',
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

/**
 * Like readStorage, but tells "nothing (valid) stored" (null) apart from "storage unavailable" (undefined), for
 * read-modify-write of a value that other tabs change too.
 */
export function readStored<T>(key: string, validate: (value: unknown) => value is T): T | null | undefined {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFIX + key);
  } catch {
    return undefined;
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

/** The localStorage item name of a key (what `storage` events of other tabs carry). */
export const storageItemName = (key: string): string => PREFIX + key;

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
