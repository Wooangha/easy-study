// UI language of the web client (DESIGN §27): Korean (the reference) or English, and every user-facing text.
//
// - Texts live in typed objects, one file per namespace and language: ./ko/<ns>.ts is the reference, ./en/<ns>.ts must
//   `satisfies typeof ko` (a missing or extra key is a type error). Dynamic texts are functions ((n: number) => string)
//   so each language builds its own sentence (plurals, word order); there is no template syntax.
// - `msg()` is the current language's texts, for any code (React or not). Call it where the text is used (in render, in
//   the handler), never at module level: the language can change while the page is open.
// - A change re-renders the whole tree (AuthGate subscribes with useLang), so `msg()` in render is enough. Text made in
//   useMemo / useCallback or inside a memo() component needs `useLang()` there (and `lang` in the dependencies).
// - The setting is this browser's (localStorage "easy-study:lang": 'ko' | 'en', absent = 시스템 설정 = the browser's
//   language, 'ko*' → Korean, anything else → English; in the desktop app the shell's). Outside a browser (the tests)
//   the language is Korean.
// - Every API request carries the language (header X-Easy-Study-Lang, api.ts), so the server answers in it. A plain
//   link or an EventSource cannot send a header: their URLs carry it as ?lang= (langUrl).
import { useSyncExternalStore } from 'react';
import { DEFAULT_LANG, LANG_HEADER, LANG_PARAM, LANGS, isLang, pickLang, type Lang } from '../../../shared/i18n.ts';
import { readStorage, storageItemName, storageKeys, writeStorage } from '../lib/storage.ts';
import { en } from './en/index.ts';
import { ko, type Messages } from './ko/index.ts';

export { rich } from './rich.ts';

export { LANG_HEADER, LANGS, isLang };
export type { Lang, Messages };

/** The setting: a language, or 'system' (follow the browser). */
export type LangPref = Lang | 'system';

export const isLangPref = (v: unknown): v is LangPref => v === 'system' || isLang(v);

const MESSAGES: Record<Lang, Messages> = { ko, en };

/** The texts of `lang` (default: the current language). */
export function msg(lang: Lang = getLang()): Messages {
  return MESSAGES[lang];
}

/**
 * The system's language: in the desktop app the shell's (its marker's `lang`: the OS's language, as the app's menus
 * and dialogs use it), otherwise the browser's (navigator.language, then navigator.languages); Korean without a browser.
 */
export function systemLang(nav: Pick<Navigator, 'language' | 'languages'> | undefined = browserNavigator(), shell: unknown = shellLang()): Lang {
  if (isLang(shell)) return shell;
  if (!nav) return DEFAULT_LANG;
  const tags = [nav.language, ...(nav.languages ?? [])].filter((t): t is string => typeof t === 'string');
  return pickLang(tags) ?? DEFAULT_LANG;
}

/** window.__EASY_STUDY_DESKTOP__.lang (desktop/src-tauri/src/bridge.rs INIT_SCRIPT), set before any script runs. */
function shellLang(): unknown {
  if (typeof window === 'undefined') return undefined;
  const marker: unknown = (window as { __EASY_STUDY_DESKTOP__?: unknown }).__EASY_STUDY_DESKTOP__;
  return marker !== null && typeof marker === 'object' ? (marker as { lang?: unknown }).lang : undefined;
}

function browserNavigator(): Navigator | undefined {
  // window.navigator, not the global one: Node has a global navigator, and tests fake a window without one.
  return typeof window === 'undefined' ? undefined : (window.navigator ?? undefined);
}

export const resolveLang = (pref: LangPref): Lang => (pref === 'system' ? systemLang() : pref);

let pref: LangPref | null = null;
let current: Lang | null = null;
const listeners = new Set<() => void>();

const storedPref = (): LangPref => readStorage<LangPref>(storageKeys.lang, 'system', isLang);

export function getLangPref(): LangPref {
  pref ??= storedPref();
  return pref;
}

/** The current language. */
export function getLang(): Lang {
  current ??= resolveLang(getLangPref());
  return current;
}

export function subscribeLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current language, re-rendering on a change. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/** The setting ('system' or a language), re-rendering on a change. */
export function useLangPref(): LangPref {
  return useSyncExternalStore(subscribeLang, getLangPref, getLangPref);
}

function show(next: LangPref): void {
  const lang = resolveLang(next);
  const changed = next !== pref || lang !== current;
  pref = next;
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  if (changed) for (const l of listeners) l();
}

/** Changes the language (stored in this browser; 'system' removes the setting). Shown at once. */
export function setLang(next: LangPref): void {
  if (!isLangPref(next)) return;
  writeStorage(storageKeys.lang, next === 'system' ? null : next);
  show(next);
}

/** The locale for Intl formatting of dates, numbers and relative times in `lang`. */
export function intlLocale(lang: Lang = getLang()): string {
  return lang === 'ko' ? 'ko-KR' : 'en-US';
}

/** The header every API request carries: the language the server should answer in. */
export function langHeaders(): Record<string, string> {
  return { [LANG_HEADER]: getLang() };
}

/**
 * Whether a server answer asked in `asked` (labels, reasons) may replace what is shown: yes while that language is
 * still the page's, or when nothing is shown yet (the answer fetched for the new language replaces it then).
 */
export function keepAnswer(asked: Lang, shown: unknown): boolean {
  return asked === getLang() || shown === null;
}

/** `url` with the current language as ?lang= (for a plain link or an EventSource, which send no header). */
export function langUrl(url: string, lang: Lang = getLang()): string {
  return `${url}${url.includes('?') ? '&' : '?'}${LANG_PARAM}=${lang}`;
}

let started = false;

/** Sets <html lang> and follows other tabs and the browser's language. Once per page, not in Node. */
function start(): void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined' || typeof window.addEventListener !== 'function') return;
  started = true;
  document.documentElement.lang = getLang();
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== storageItemName(storageKeys.lang)) return;
    show(storedPref());
  });
  window.addEventListener('languagechange', () => {
    if (getLangPref() === 'system') show('system');
  });
}

start();
