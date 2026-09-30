// The page inside the desktop app (DESIGN §19, §24). The app's shell never gives a server's page IPC; the two talk
// through the page itself:
//
//   marker   window.__EASY_STUDY_DESKTOP__ = {v:1, version, os}, frozen, set by the shell before any script of a
//            page in the main window. Absent in browsers: every desktop-only control is hidden then.
//   state    window.__easyStudyDesktopState = {v:1, theme, connection, update, justUpdated, share?}, pushed by the
//            shell on every page load and every change, followed by an 'easy-study-desktop' event. Untrusted input as
//            far as this page goes (another shell version, a bug): checked field by field, and a malformed push is
//            ignored. `share` (다른 기기에서 접속 허용) comes only to the page of this computer's own server.
//   actions  a navigation to <origin>/__easy-study-desktop/<action>: the shell cancels it and acts (no parameters,
//            the query is ignored). The server answers the prefix with 204, so one that gets through changes nothing.
//            Only desktopAction() navigates there: it notes the action first, and the shell asks the page through
//            __easyStudyAskedAction(name) before acting — a link to that path (in an answer, say) is not the page
//            asking (on macOS a target=_blank link reaches the shell like a navigation, DESIGN §19).
//   hooks    functions the shell calls with eval: __easyStudyAskedAction (main.tsx installs it, before anything
//            renders), __easyStudyBusy, __easyStudyOpenSettings, __easyStudyAllowLeave (App.tsx).
//
// Pure helpers and a tiny store; no React state of the app and no recorder (they are passed in), so the tests can run
// it in Node.
import { useSyncExternalStore } from 'react';
import { msg } from '../i18n/index.ts';
import type { ConfirmOptions } from './confirm.ts';

export type DesktopOs = 'macos' | 'windows' | 'linux';

export interface DesktopMarker {
  v: 1;
  /** The app's version (the shell's package version). */
  version: string;
  os: DesktopOs;
}

export type ThemeSetting = 'system' | 'light' | 'dark';
export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
/** How this install gets a new version: in the app, from the download page, or not at all (a development build). */
export type InstallMode = 'inApp' | 'download' | 'none';
export type InstallKind = 'app' | 'nsis' | 'appimage' | 'deb' | 'rpm' | 'arch' | 'none';

/** The shell's update state (UpdateState in update.rs). Pages of other computers get only some of the fields. */
export interface UpdateState {
  phase: UpdatePhase;
  /** The running app's version. */
  current: string;
  /** The new version (available … installing, and an error of those). */
  version?: string;
  /** Release notes: plain text, never Markdown or HTML (latest.json is not signed). */
  notes?: string;
  date?: string;
  /** The release page (https only). */
  releaseUrl?: string;
  /** Bytes downloaded so far, and the size when known. */
  received: number;
  total?: number;
  /** What went wrong, in the shell's language (the computer's: Korean or English; phase 'error'). */
  error?: string;
  install: InstallMode;
  /** Why the update is not installed in the app, in the shell's language (install 'download'). */
  reason?: string;
  kind?: InstallKind;
  checkedAt?: string;
  /** Automatic checks are on. */
  auto?: boolean;
  /** "나중에": the banner stays hidden until the next launch. */
  dismissed: boolean;
  /** The last automatic check that failed (automatic checks fail silently). */
  lastError?: string;
  lastErrorAt?: string;
}

export interface DesktopConnection {
  /** 'local' = the app's own server ("이 컴퓨터"), 'remote' = a server on another computer. */
  kind: 'local' | 'remote';
  /**
   * The server's origin. For a plain-http remote shown through the app's loopback relay (DESIGN §19) this is still the
   * remote's own origin (http://192.168.0.10:5180), not the relay's (http://127.0.0.1:<port>) the page runs on.
   */
  origin: string;
  /** What the next launch does: connect to this again ('auto') or show the chooser ('ask'). */
  startup: 'auto' | 'ask';
}

/** "다른 기기에서 접속 허용" of this computer's server (DESIGN §16/§19); pushed only to that server's own page. */
export interface DesktopShare {
  /** The setting (desktop.json `share`). */
  on: boolean;
  /** This computer's server runs shared right now (the setting applies at a start; `urls` can be empty meanwhile). */
  running: boolean;
  /** The addresses other devices can use while the server runs shared (empty otherwise, or before a restart). */
  urls: string[];
  /**
   * The access code, when the shell chose to push it (after 'share/reveal', for a short while); null otherwise — the
   * chooser's ⚙ 앱 설정 always shows it.
   */
  code: string | null;
}

export interface DesktopState {
  v: 1;
  theme: ThemeSetting;
  connection: DesktopConnection | null;
  update: UpdateState | null;
  /** Set once after an update: the version the app was updated to (a toast says so). */
  justUpdated: string | null;
  /** Only on the page of this computer's own server (absent elsewhere). */
  share: DesktopShare | null;
}

/** What the page is doing that a restart or leaving would interrupt (`window.__easyStudyBusy()`). */
export interface PageBusy {
  /** A lecture is being recorded here (recording, paused, starting or stopping). */
  recording: boolean;
  /** Recorded audio the server has not acknowledged yet (seconds). */
  unsentSeconds: number;
  /** Recordings whose last audio is still being uploaded after 끝내기. */
  finishing: number;
  /** Recording files being uploaded ("녹음 파일 올리기"). */
  recordingUploads: number;
  /** PDFs being uploaded. */
  uploads: number;
  /** An answer is being made. */
  answering: boolean;
}

export const NOT_BUSY: PageBusy = { recording: false, unsentSeconds: 0, finishing: 0, recordingUploads: 0, uploads: 0, answering: false };

/** Sections of the settings dialog (`__easyStudyOpenSettings(section)`). */
export type SettingsSection = 'display' | 'study' | 'recording' | 'desktop' | 'about';
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['display', 'study', 'recording', 'desktop', 'about'];

/** Functions the shell calls on the page (main.tsx installs __easyStudyAskedAction, App.tsx the others while the app is shown). */
export interface PageHooks {
  /** Whether the page's own code asked for this action just now (takeAskedAction): the shell acts only then. */
  __easyStudyAskedAction: (action: unknown) => boolean;
  __easyStudyBusy: () => PageBusy;
  __easyStudyOpenSettings: (section?: unknown) => boolean;
  __easyStudyAllowLeave: () => boolean;
}

interface DesktopWindow extends Partial<PageHooks> {
  __EASY_STUDY_DESKTOP__?: unknown;
  __easyStudyDesktopState?: unknown;
}

/** The event the shell dispatches on window after each state push. */
export const DESKTOP_EVENT = 'easy-study-desktop';
/** Path prefix of the actions (the server answers it with 204). */
export const DESKTOP_ACTION_PREFIX = '/__easy-study-desktop/';

export const DESKTOP_ACTIONS = [
  'choose',
  'forget-choice',
  'check-update',
  'install-update',
  'dismiss-update',
  'cancel-update',
  'theme/system',
  'theme/light',
  'theme/dark',
  // 다른 기기에서 접속 허용 (this computer's page only): the switch, showing the code, a new code for every device.
  'share/on',
  'share/off',
  'share/reveal',
  'share/reset-code',
] as const;
export type DesktopActionName = (typeof DESKTOP_ACTIONS)[number];

// ---------------------------------------------------------------------------------------------------------------
// Checking what the shell sent
// ---------------------------------------------------------------------------------------------------------------

const OSES: readonly DesktopOs[] = ['macos', 'windows', 'linux'];
const THEMES: readonly ThemeSetting[] = ['system', 'light', 'dark'];
const PHASES: readonly UpdatePhase[] = ['idle', 'checking', 'latest', 'available', 'downloading', 'downloaded', 'installing', 'error'];
const INSTALL_MODES: readonly InstallMode[] = ['inApp', 'download', 'none'];
const INSTALL_KINDS: readonly InstallKind[] = ['app', 'nsis', 'appimage', 'deb', 'rpm', 'arch', 'none'];
/** Release notes are shown up to this length (the shell trims them too). */
export const MAX_NOTES = 2000;
const MAX_TEXT = 500;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
/** A generated access code (server/auth.ts): 4 groups of 5 base32 characters. */
const ACCESS_CODE_RE = /^[0-9a-z]{5}(-[0-9a-z]{5}){3}$/;
/** More addresses than any computer has network adapters. */
const MAX_SHARE_URLS = 32;

/** A malformed field: the whole push is refused. */
class Malformed extends Error {}

type Fields = Record<string, unknown>;

const isRecord = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Malformed(field);
  return value as T;
}

function optionalText(o: Fields, field: string, max = MAX_TEXT): string | undefined {
  const value = o[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Malformed(field);
  return value.length > max ? value.slice(0, max) : value;
}

function version(value: unknown, field: string): string {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) throw new Malformed(field);
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Malformed(field);
  return value;
}

function optionalFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Malformed(field);
  return value;
}

/** The origin of an http(s) URL (a connection is to a web server, nothing else). */
function origin(value: unknown, field = 'connection.origin'): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Malformed(field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Malformed(field);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Malformed(field);
  return url.origin;
}

/** An https URL for a link (the release page): anything else would be a way to run script or leave the web. */
function httpsUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw new Malformed(field);
  try {
    if (new URL(value).protocol === 'https:') return value;
  } catch {
    // below
  }
  throw new Malformed(field);
}

function parseUpdate(value: unknown): UpdateState {
  if (!isRecord(value)) throw new Malformed('update');
  const u: UpdateState = {
    phase: oneOf(value.phase, PHASES, 'update.phase'),
    current: version(value.current, 'update.current'),
    received: value.received === undefined ? 0 : count(value.received, 'update.received'),
    install: value.install === undefined ? 'none' : oneOf(value.install, INSTALL_MODES, 'update.install'),
    dismissed: optionalFlag(value.dismissed, 'update.dismissed') ?? false,
  };
  if (value.version !== undefined && value.version !== null) u.version = version(value.version, 'update.version');
  const notes = optionalText(value, 'notes', MAX_NOTES);
  if (notes !== undefined) u.notes = notes;
  for (const field of ['date', 'error', 'reason', 'checkedAt', 'lastError', 'lastErrorAt'] as const) {
    const text = optionalText(value, field);
    if (text !== undefined) u[field] = text;
  }
  const releaseUrl = httpsUrl(value.releaseUrl, 'update.releaseUrl');
  if (releaseUrl !== undefined) u.releaseUrl = releaseUrl;
  if (value.total !== undefined && value.total !== null) u.total = count(value.total, 'update.total');
  if (value.kind !== undefined && value.kind !== null) u.kind = oneOf(value.kind, INSTALL_KINDS, 'update.kind');
  const auto = optionalFlag(value.auto, 'update.auto');
  if (auto !== undefined) u.auto = auto;
  return u;
}

function parseConnection(value: unknown): DesktopConnection | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Malformed('connection');
  return {
    kind: oneOf(value.kind, ['local', 'remote'] as const, 'connection.kind'),
    origin: origin(value.origin),
    startup: oneOf(value.startup, ['auto', 'ask'] as const, 'connection.startup'),
  };
}

function parseShare(value: unknown): DesktopShare | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.on !== 'boolean') throw new Malformed('share');
  const urls = value.urls === undefined || value.urls === null ? [] : value.urls;
  if (!Array.isArray(urls) || urls.length > MAX_SHARE_URLS) throw new Malformed('share.urls');
  // `running` (0.5.1): a shell without it ran shared exactly when it had addresses.
  if (value.running !== undefined && typeof value.running !== 'boolean') throw new Malformed('share.running');
  const running = value.running ?? urls.length > 0;
  let code: string | null = null;
  if (value.code !== undefined && value.code !== null) {
    if (typeof value.code !== 'string' || !ACCESS_CODE_RE.test(value.code)) throw new Malformed('share.code');
    code = value.code;
  }
  return { on: value.on, running, urls: urls.map((u) => origin(u, 'share.urls')), code };
}

/** The shell's pushed state, checked; null when anything in it is malformed (or it is not version 1). */
export function parseDesktopState(value: unknown): DesktopState | null {
  try {
    if (!isRecord(value) || value.v !== 1) return null;
    const justUpdated = value.justUpdated === undefined || value.justUpdated === null ? null : version(value.justUpdated, 'justUpdated');
    return {
      v: 1,
      theme: oneOf(value.theme, THEMES, 'theme'),
      connection: parseConnection(value.connection),
      update: value.update === undefined || value.update === null ? null : parseUpdate(value.update),
      justUpdated,
      share: parseShare(value.share),
    };
  } catch (err) {
    if (err instanceof Malformed) return null;
    throw err;
  }
}

/** The static marker, checked; null in a browser (or for a marker this page does not understand). */
export function parseDesktopMarker(value: unknown): DesktopMarker | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (typeof value.version !== 'string' || !VERSION_RE.test(value.version)) return null;
  if (typeof value.os !== 'string' || !OSES.includes(value.os as DesktopOs)) return null;
  return { v: 1, version: value.version, os: value.os as DesktopOs };
}

// ---------------------------------------------------------------------------------------------------------------
// Marker and state store
// ---------------------------------------------------------------------------------------------------------------

const desktopWindow = (): DesktopWindow | null => (typeof window === 'undefined' ? null : (window as DesktopWindow));

let lastMarkerRaw: unknown;
let lastMarker: DesktopMarker | null = null;

/** Inside the desktop app's main window: its marker (the shell sets it before any script runs). */
export function desktopMarker(): DesktopMarker | null {
  const raw = desktopWindow()?.__EASY_STUDY_DESKTOP__;
  if (raw !== lastMarkerRaw) {
    lastMarkerRaw = raw;
    lastMarker = parseDesktopMarker(raw);
  }
  return lastMarker;
}

let lastRaw: unknown;
let lastState: DesktopState | null = null;

/**
 * The newest valid state the shell pushed (null before the first one, and in a browser). A malformed push is ignored:
 * the state before it stays.
 */
export function getDesktopState(): DesktopState | null {
  const w = desktopWindow();
  if (!w) return null;
  const raw = w.__easyStudyDesktopState;
  if (raw !== lastRaw) {
    lastRaw = raw;
    const parsed = parseDesktopState(raw);
    if (parsed) lastState = parsed;
    else if (raw !== undefined) console.warn('[easy-study] ignored a malformed state from the desktop app');
  }
  return lastState;
}

export function subscribeDesktop(listener: () => void): () => void {
  const w = desktopWindow();
  if (!w) return () => {};
  window.addEventListener(DESKTOP_EVENT, listener);
  return () => window.removeEventListener(DESKTOP_EVENT, listener);
}

export function useDesktopState(): DesktopState | null {
  return useSyncExternalStore(subscribeDesktop, getDesktopState, () => null);
}

// ---------------------------------------------------------------------------------------------------------------
// Actions and leaving the page
// ---------------------------------------------------------------------------------------------------------------

export function isDesktopAction(name: string): name is DesktopActionName {
  return (DESKTOP_ACTIONS as readonly string[]).includes(name);
}

/** `<origin>/__easy-study-desktop/<action>` of the page's own origin. Throws for anything but a known action. */
export function desktopActionUrl(pageOrigin: string, action: DesktopActionName): string {
  if (!isDesktopAction(action)) throw new Error(`unknown desktop action: ${String(action)}`);
  return `${new URL(pageOrigin).origin}${DESKTOP_ACTION_PREFIX}${action}`;
}

/** How long a page-started navigation may pass the busy guard of beforeunload. */
const ACTION_LEAVE_MS = 1_000;
/** The shell navigates right after it asked the user and called `__easyStudyAllowLeave()`. */
export const SHELL_LEAVE_MS = 3_000;

let leaveAllowedUntil = 0;

/**
 * Let the next navigation pass without the page's "leave site?" prompt (App.tsx's beforeunload handler asks
 * leaveAllowed()). WebView2 runs beforeunload even for a navigation the shell then cancels, and the shell's own
 * navigations (show the chooser, reload, install) come after it asked the user in a native dialog: never twice.
 */
export function allowLeave(ms: number, now = Date.now()): void {
  leaveAllowedUntil = Math.max(leaveAllowedUntil, now + ms);
}

export function leaveAllowed(now = Date.now()): boolean {
  return now < leaveAllowedUntil;
}

/** How long the shell has to ask about an action (it asks right after cancelling the navigation). */
const ASKED_ACTION_MS = 5_000;
/** Actions asked for and not yet checked by the shell (a few: a page never asks for more at once). */
const ASKED_ACTION_MAX = 8;
let askedActions: Array<{ action: DesktopActionName; at: number }> = [];

/**
 * `window.__easyStudyAskedAction(name)`: whether this page's own code asked for `name` (desktopAction) within the
 * last ASKED_ACTION_MS; each ask answers once. A navigation to the reserved path that nobody asked for — a link to
 * it in an answer — is refused by the shell (DESIGN §24).
 */
export function takeAskedAction(action: unknown, now = Date.now()): boolean {
  askedActions = askedActions.filter((a) => now - a.at <= ASKED_ACTION_MS);
  const i = askedActions.findIndex((a) => a.action === action);
  if (i === -1) return false;
  askedActions.splice(i, 1);
  return true;
}

/** Asks the shell to do `action` (inside the app only; see the top of this file). */
export function desktopAction(action: DesktopActionName, location: Pick<Location, 'origin' | 'assign'> = window.location): void {
  const url = desktopActionUrl(location.origin, action);
  allowLeave(ACTION_LEAVE_MS);
  askedActions = [...askedActions.slice(-(ASKED_ACTION_MAX - 1)), { action, at: Date.now() }];
  location.assign(url);
}

/** Installs a hook the shell calls; returns its removal (which leaves a newer hook of the same name alone). */
export function exposePageHook<K extends keyof PageHooks>(name: K, hook: PageHooks[K]): () => void {
  const w = desktopWindow();
  if (!w) return () => {};
  w[name] = hook as DesktopWindow[K];
  return () => {
    if (w[name] === hook) delete w[name];
  };
}

/** What `window.__easyStudyBusy()` says right now; null when no app is shown (e.g. the login screen alone). */
export function readPageBusy(): PageBusy | null {
  const hook = desktopWindow()?.__easyStudyBusy;
  if (typeof hook !== 'function') return null;
  try {
    return hook();
  } catch {
    return null;
  }
}

const SECTION_ALIASES = new Map<string, SettingsSection>([
  ['theme', 'display'],
  ['update', 'desktop'],
  ['updates', 'desktop'],
  ['connection', 'desktop'],
  ['app', 'desktop'],
]);

/** The section named by the shell (or a link), with a few aliases; null for none or anything unknown. */
export function settingsSection(value: unknown): SettingsSection | null {
  if (typeof value !== 'string') return null;
  if ((SETTINGS_SECTIONS as readonly string[]).includes(value)) return value as SettingsSection;
  return SECTION_ALIASES.get(value) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// What the page says before leaving or restarting
// ---------------------------------------------------------------------------------------------------------------

/** Audio could be cut off: a recording runs here, or recorded audio / a recording file is still on its way. */
export function recordingAtRisk(b: PageBusy): boolean {
  return b.recording || b.unsentSeconds > 0 || b.finishing > 0 || b.recordingUploads > 0;
}

/** The confirmation before "연결 대상 바꾸기" (the chooser replaces this page), or null when nothing is lost. */
export function leaveConfirm(b: PageBusy | null): ConfirmOptions | null {
  if (!b) return null;
  const m = msg().settings.bridge.leave;
  const base = { title: m.title, confirmLabel: m.confirmLabel };
  if (b.recording) return { ...base, message: m.recording };
  if (b.unsentSeconds > 0 || b.finishing > 0) return { ...base, message: m.unsent };
  if (b.answering || b.uploads > 0 || b.recordingUploads > 0) return { ...base, message: m.busy };
  return null;
}

/** Why the update cannot be installed now (the shell refuses it too), or null. */
export function installBlockReason(b: PageBusy): string | null {
  return blockReason(b, msg().settings.bridge.installBlocked);
}

/** The reason of `texts` for what could cut audio off, or null. */
function blockReason(b: PageBusy, texts: { recording: string; unsent: string; uploads: string }): string | null {
  if (b.recording) return texts.recording;
  if (b.unsentSeconds > 0 || b.finishing > 0) return texts.unsent;
  if (b.recordingUploads > 0) return texts.uploads;
  return null;
}

/** What a restart would stop that the user may accept (asked first), or null. */
export function installWarning(b: PageBusy): string | null {
  return b.answering || b.uploads > 0 ? msg().settings.bridge.installWarning : null;
}

/**
 * 다른 기기에서 접속 허용: turning it on or off (and a new access code) restarts this computer's server, under the same
 * gate as an update (the shell refuses these too). Why it cannot be changed now, or null.
 */
export function shareBlockReason(b: PageBusy): string | null {
  return blockReason(b, msg().settings.bridge.shareBlocked);
}

/** What the restart for a share change would stop that the user may accept (asked first), or null. */
export function shareWarning(b: PageBusy): string | null {
  return b.answering || b.uploads > 0 ? msg().settings.bridge.shareWarning : null;
}

/** The confirmation before "접속 코드 새로 만들기" (every device is logged out; the server restarts once). */
export function resetCodeConfirm(b: PageBusy): ConfirmOptions {
  const m = msg().settings.bridge.resetCode;
  return {
    title: m.title,
    // What would stop, without shareWarning's question (the dialog asks it).
    message: shareWarning(b) ? `${m.message} ${m.busy}` : m.message,
    confirmLabel: m.confirmLabel,
  };
}

/** A shared address that is a host name (not an IP): it resolves only on networks that know it. */
export function isNameUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return !/^[\d.]+$/.test(host) && !host.includes(':');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Update wording
// ---------------------------------------------------------------------------------------------------------------

/** a < b: negative, equal: 0. Numeric parts compare as numbers; a pre-release ("0.5.0-e2e.1") is below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('+')[0].split(/-(.*)/s);
    return { main: main.split('.').map((p) => Number.parseInt(p, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.main.length, y.main.length, 3); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  // Semver: identifier by identifier, numbers numerically and below words, a shorter list first.
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    if (xs[i] === ys[i]) continue;
    const xn = /^\d+$/.test(xs[i]);
    const yn = /^\d+$/.test(ys[i]);
    if (xn && yn) return Number(xs[i]) - Number(ys[i]);
    if (xn || yn) return xn ? -1 : 1;
    return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

/** Downloaded share 0–100, or null while the size is unknown. */
export function downloadPercent(u: UpdateState): number | null {
  if (!u.total || u.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((u.received / u.total) * 100)));
}

/** An update is waiting to be installed (the dot on the settings gear). */
export function updatePending(u: UpdateState | null | undefined): boolean {
  return !!u && (u.phase === 'available' || u.phase === 'downloading' || u.phase === 'downloaded');
}

/** The status line of Settings › 데스크톱 앱. */
export function updateStatusLine(u: UpdateState): string {
  const v = u.version ?? '';
  const m = msg().settings.bridge.status;
  switch (u.phase) {
    case 'checking':
      return m.checking;
    case 'available':
      return m.available(v);
    case 'downloading': {
      const pct = downloadPercent(u);
      return pct === null ? m.downloading : m.downloadingPercent(pct);
    }
    case 'downloaded':
      return m.downloaded(v);
    case 'installing':
      return m.installing(v);
    case 'error':
      return updateErrorText(u);
    case 'latest':
      return m.latest;
    default:
      return u.lastError ? m.lastCheckFailed(u.lastError) : u.checkedAt ? m.latest : m.notChecked;
  }
}

const PACKAGE_KINDS: Partial<Record<InstallKind, string>> = { deb: 'deb', rpm: 'rpm', arch: 'Arch' };

/** Why this install takes the new version from the download page (install 'download'). */
export function downloadHint(u: UpdateState): string {
  if (u.reason) return u.reason;
  const m = msg().settings.bridge;
  const pkg = u.kind ? PACKAGE_KINDS[u.kind] : undefined;
  return pkg ? m.downloadPackage(pkg, u.kind === 'arch') : m.downloadPage;
}

/**
 * macOS keeps the microphone permission per signature, and an app signed without a developer ID gets a new one with
 * every version: it may ask again, or silently record nothing while System Settings still shows it allowed.
 */
export const macMicFix = (): string => msg().settings.bridge.macMicFix;
export const macMicHint = (): string => `${msg().settings.bridge.macMicHint} ${macMicFix()}`;

/** The toast after an update (the shell pushes justUpdated during the whole launch after it). */
export function updatedToast(version: string, os: DesktopOs | undefined): string {
  const updated = msg().settings.bridge.updated(version);
  return os === 'macos' ? `${updated} ${macMicFix()}` : updated;
}

/** sessionStorage item: the version the "updated" toast was shown for in this tab. */
export const TOASTED_UPDATE_ITEM = 'easy-study:toastedUpdate';
let toastedHere: string | null = null;

function tabStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Whether the "updated" toast for `version` is still due in this tab, marking it shown. Every push of the launch
 * carries justUpdated, and the page reloads (or loads twice, or comes back from the chooser): once per version and
 * tab, kept in sessionStorage (in memory when that is unavailable).
 */
export function firstUpdatedToast(version: string, storage = tabStorage()): boolean {
  let shown = toastedHere;
  try {
    shown = storage?.getItem(TOASTED_UPDATE_ITEM) ?? shown;
  } catch {
    // below
  }
  if (shown === version) return false;
  toastedHere = version;
  try {
    storage?.setItem(TOASTED_UPDATE_ITEM, version);
  } catch {
    // the memory copy stands
  }
  return true;
}

/**
 * The shell's text says itself that the update failed (update.rs says_update_failed): "업데이트가 끝나지 않았어요…",
 * "업데이트하지 못했어요. …", or the same in English. The shell speaks the computer's language, which need not be the
 * page's, so both are recognized whatever the page's language.
 */
const SAYS_UPDATE_FAILED = /^(업데이트(가|하지) |(The update|Couldn['’]t update|Could not update)\b)/;

/** An error of the update state as a sentence: "업데이트하지 못했어요: …", unless the shell's text says so itself. */
export function updateErrorText(u: UpdateState): string {
  const m = msg();
  const error = u.error ?? m.common.unknownError;
  return SAYS_UPDATE_FAILED.test(error) ? error : m.settings.bridge.updateFailed(error);
}
