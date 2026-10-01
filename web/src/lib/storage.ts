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
  /** Recording settings (model / language / live transcription) for new recordings (DESIGN §22). */
  recordingSettings: 'recordingSettings',
  /** The one-time notice about recording rules was confirmed. */
  recordingConsent: 'recordingConsent',
  /** 녹음 tab: playback speed, "슬라이드 따라가기", transcript mode ('current' | 'all'). */
  playbackRate: 'playbackRate',
  followSlides: 'followSlides',
  transcriptMode: 'transcriptMode',
  /** Collapsed live transcript strip under the top bar. */
  liveStripCollapsed: 'liveStripCollapsed',
  /** The newest subscription usage limits of each provider (DESIGN §23; the account's, cached per device). */
  usageLimits: 'usageLimits',
  /**
   * 화면 테마 'light' | 'dark' (absent = 시스템 설정, DESIGN §24). Also read by web/public/theme-boot.js before the
   * first paint, under this exact name: keep the two in sync.
   */
  theme: 'theme',
  /** UI language 'ko' | 'en' (absent = 시스템 설정: the browser's language, DESIGN §27). */
  lang: 'lang',
  /** Slide annotations (DESIGN §25): the color of new items, the layer toggle, 질문 표시, "학생의 메모" → 튜터, 그때 필기 재생. */
  annotColor: 'annotColor',
  annotLayer: 'annotLayer',
  questionMarkers: 'questionMarkers',
  memosToTutor: 'memosToTutor',
  replayAnnotations: 'replayAnnotations',
  /** "여기부터 p.N" markers sent for a recording (the API has no GET for them). */
  recordingMarkers: (recordingId: string) => `recordingMarkers:${recordingId}`,
  slide: (docId: string) => `slide:${docId}`,
  /** The deck rev (DocMeta.deckRev, DESIGN §28) the remembered `slide:<docId>` is numbered in; absent = 0. */
  slideRev: (docId: string) => `slideRev:${docId}`,
  session: (docId: string) => `session:${docId}`,
  /** The deck swap (DocMeta.lastChange.rev, DESIGN §28) whose banner was dismissed in this browser. */
  deckSeen: (docId: string) => `deckSeen:${docId}`,
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
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * The remembered slide of a lecture and the deck rev it is numbered in (DESIGN §28), or null when none is remembered.
 * A slide remembered before deck revs were stored counts as rev 0.
 */
export function readRememberedSlide(docId: string): { slide: number; rev: number } | null {
  const slide = readStorage<number | null>(storageKeys.slide(docId), null, isNumber);
  if (slide === null) return null;
  return { slide, rev: readStorage(storageKeys.slideRev(docId), 0, isNumber) };
}

/**
 * Remember the slide of a lecture, numbered in deck `rev`. Never over a slide of a later deck: a viewer of the old
 * deck still shown (here, or in another tab) must not undo the remap of a swap.
 */
export function rememberSlide(docId: string, slide: number, rev: number): void {
  const stored = readRememberedSlide(docId);
  if (stored && stored.rev > rev) return;
  writeStorage(storageKeys.slide(docId), slide);
  writeStorage(storageKeys.slideRev(docId), rev > 0 ? rev : null); // absent = 0: nothing more for a lecture never swapped
}
