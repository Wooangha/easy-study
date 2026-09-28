// 화면 테마 (DESIGN §24): 시스템 설정 따르기 / 라이트 / 다크. styles.css keeps its tokens twice for dark, under
// prefers-color-scheme (unless data-theme="light") and under data-theme="dark"; this module sets data-theme on <html>.
//
// - Browser: the setting is this browser's (localStorage "easy-study:theme"; web/public/theme-boot.js applies it
//   before the first paint). Other tabs follow through the `storage` event.
// - Desktop app: the shell keeps the setting for every window and the chooser (desktop.json). A change here asks the
//   shell (desktopAction 'theme/<v>'), which sets the native theme and pushes its state; each push is applied here and
//   copied to this origin's localStorage (theme-boot.js uses the copy on Linux, where the WebView may not follow).
import { useSyncExternalStore } from 'react';
import { desktopAction, desktopMarker, getDesktopState, subscribeDesktop } from './desktop.ts';
import type { ThemeSetting } from './desktop.ts';
import { readStorage, storageItemName, storageKeys, writeStorage } from './storage.ts';

export type ThemePref = ThemeSetting;

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

/** The top bar's color (--surface) of each theme: the browser's window color when a theme is forced. */
export const THEME_COLORS = { light: '#ffffff', dark: '#161920' } as const;

export const isThemePref = (v: unknown): v is ThemePref => typeof v === 'string' && (THEME_PREFS as readonly string[]).includes(v);

/** Only 'light' / 'dark' are stored; 시스템 설정 is no item. */
const isForced = (v: unknown): v is 'light' | 'dark' => v === 'light' || v === 'dark';

/**
 * Shows `pref`: data-theme and the root's inline color-scheme (native controls, scrollbars), both removed for
 * 시스템 설정; the theme-color metas (media-conditioned in index.html) get the forced theme's color, or theirs back.
 */
export function applyTheme(pref: ThemePref, doc: Pick<Document, 'documentElement' | 'querySelectorAll'> = document): void {
  const root = doc.documentElement;
  if (pref === 'system') {
    root.removeAttribute('data-theme');
    root.style.colorScheme = '';
  } else {
    root.setAttribute('data-theme', pref);
    root.style.colorScheme = pref;
  }
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const system = (meta.dataset.systemColor ??= meta.content);
    meta.content = pref === 'system' ? system : THEME_COLORS[pref];
  }
}

/** What the page starts with before the shell's first push (or in a browser): see theme-boot.js. */
function initialPref(): ThemePref {
  const state = getDesktopState();
  if (state) return state.theme;
  const marker = desktopMarker();
  // macOS / Windows: the window already has the shell's theme, and this origin's copy may be stale.
  if (marker && marker.os !== 'linux') return 'system';
  return readStorage<ThemePref>(storageKeys.theme, 'system', isForced);
}

let current: ThemePref | null = null;
const listeners = new Set<() => void>();

export function getThemePref(): ThemePref {
  current ??= initialPref();
  return current;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribeTheme, getThemePref, () => 'system' as ThemePref);
}

function show(pref: ThemePref): void {
  writeStorage(storageKeys.theme, isForced(pref) ? pref : null);
  if (pref === current) return;
  current = pref;
  applyTheme(pref);
  for (const l of listeners) l();
}

/** 테마 바꾸기: shown at once; inside the app the shell keeps it (and pushes it back), in a browser this browser. */
export function setThemePref(pref: ThemePref): void {
  if (!isThemePref(pref)) return;
  show(pref);
  if (desktopMarker()) desktopAction(`theme/${pref}`);
}

let started = false;

/** Applies the setting and follows its changes (the shell's pushes, other tabs). Once per page. */
export function startTheme(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  applyTheme(getThemePref());
  subscribeDesktop(() => {
    const state = getDesktopState();
    if (state) show(state.theme);
  });
  // A push that came before this subscription (the shell pushes when the page has loaded).
  const state = getDesktopState();
  if (state) show(state.theme);
  window.addEventListener('storage', (e) => {
    if (desktopMarker() || (e.key !== null && e.key !== storageItemName(storageKeys.theme))) return;
    show(readStorage<ThemePref>(storageKeys.theme, 'system', isForced));
  });
}

// As soon as the web client loads (the app imports this module), whichever screen it shows first: the login screen
// follows the shell's pushes too. Not in Node (the tests).
if (typeof window !== 'undefined' && typeof document !== 'undefined') startTheme();
