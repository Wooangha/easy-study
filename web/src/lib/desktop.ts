// The page inside the desktop app (DESIGN §19, §24). The app's shell never gives a server's page IPC; the two talk
// through the page itself:
//
//   marker   window.__EASY_STUDY_DESKTOP__ = {v:1, version, os}, frozen, set by the shell before any script of a
//            page in the main window. Absent in browsers: every desktop-only control is hidden then.
//   state    window.__easyStudyDesktopState = {v:1, theme, connection, update, justUpdated}, pushed by the shell on
//            every page load and every change, followed by an 'easy-study-desktop' event. Untrusted input as far as
//            this page goes (another shell version, a bug): checked field by field, and a malformed push is ignored.
//   actions  a navigation to <origin>/__easy-study-desktop/<action>: the shell cancels it and acts (no parameters,
//            the query is ignored). The server answers the prefix with 204, so one that gets through changes nothing.
//   hooks    functions the shell calls with eval (App.tsx installs them): __easyStudyBusy, __easyStudyOpenSettings,
//            __easyStudyAllowLeave.
//
// Pure helpers and a tiny store; no React state of the app and no recorder (they are passed in), so the tests can run
// it in Node.
import { useSyncExternalStore } from 'react';
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
  /** What went wrong, in Korean (phase 'error'). */
  error?: string;
  install: InstallMode;
  /** Why the update is not installed in the app, in Korean (install 'download'). */
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
  origin: string;
  /** What the next launch does: connect to this again ('auto') or show the chooser ('ask'). */
  startup: 'auto' | 'ask';
}

export interface DesktopState {
  v: 1;
  theme: ThemeSetting;
  connection: DesktopConnection | null;
  update: UpdateState | null;
  /** Set once after an update: the version the app was updated to (a toast says so). */
  justUpdated: string | null;
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

/** Functions the shell calls on the page (installed by App.tsx while the app is shown). */
export interface PageHooks {
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
function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Malformed('connection.origin');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Malformed('connection.origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Malformed('connection.origin');
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

/** Asks the shell to do `action` (inside the app only; see the top of this file). */
export function desktopAction(action: DesktopActionName, location: Pick<Location, 'origin' | 'assign'> = window.location): void {
  const url = desktopActionUrl(location.origin, action);
  allowLeave(ACTION_LEAVE_MS);
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
  const base = { title: '연결 대상을 바꿀까요?', confirmLabel: '바꾸기' };
  if (b.recording) {
    return {
      ...base,
      message: '강의를 녹음하는 중이에요. 바꾸면 녹음이 멈춰요 (녹음한 부분은 저장돼 있어서 같은 서버에 다시 연결하면 마저 올라가요).',
    };
  }
  if (b.unsentSeconds > 0 || b.finishing > 0) {
    return {
      ...base,
      message: '녹음한 소리를 아직 서버로 보내는 중이에요. 바꾸면 멈춰요 (이 기기에 저장돼 있어서 같은 서버에 다시 연결하면 마저 올라가요).',
    };
  }
  if (b.answering || b.uploads > 0 || b.recordingUploads > 0) {
    return { ...base, message: '답변을 만들거나 파일을 올리는 중이에요. 지금 바꾸면 이 화면에서는 결과를 볼 수 없어요.' };
  }
  return null;
}

/** Why the update cannot be installed now (the shell refuses it too), or null. */
export function installBlockReason(b: PageBusy): string | null {
  if (b.recording) return '녹음 중에는 설치할 수 없어요 — 녹음을 끝낸 뒤 눌러 주세요.';
  if (b.unsentSeconds > 0 || b.finishing > 0) return '녹음한 소리를 서버로 보내는 중이에요 — 다 보낸 뒤 설치할 수 있어요.';
  if (b.recordingUploads > 0) return '녹음 파일을 올리는 중이에요 — 다 올린 뒤 설치할 수 있어요.';
  return null;
}

/** What a restart would stop that the user may accept (asked first), or null. */
export function installWarning(b: PageBusy): string | null {
  return b.answering || b.uploads > 0 ? '답변을 만들거나 파일을 올리는 중이에요. 다시 시작하면 멈춰요. 그래도 설치할까요?' : null;
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

/** An update is waiting to be installed (the ⚙ dot). */
export function updatePending(u: UpdateState | null | undefined): boolean {
  return !!u && (u.phase === 'available' || u.phase === 'downloading' || u.phase === 'downloaded');
}

/** The status line of Settings › 데스크톱 앱. */
export function updateStatusLine(u: UpdateState): string {
  const v = u.version ?? '';
  switch (u.phase) {
    case 'checking':
      return '확인하는 중…';
    case 'available':
      return `easy-study ${v} 버전이 나왔어요`;
    case 'downloading': {
      const pct = downloadPercent(u);
      return pct === null ? '내려받는 중…' : `내려받는 중… ${pct}%`;
    }
    case 'downloaded':
      return `easy-study ${v} 버전을 받아 두었어요`;
    case 'installing':
      return `easy-study ${v} 버전을 설치하는 중…`;
    case 'error':
      return updateErrorText(u);
    case 'latest':
      return '최신 버전이에요';
    default:
      return u.lastError ? `마지막 확인 실패: ${u.lastError}` : u.checkedAt ? '최신 버전이에요' : '아직 확인하지 않았어요';
  }
}

const PACKAGE_KINDS: Partial<Record<InstallKind, string>> = { deb: 'deb', rpm: 'rpm', arch: 'Arch' };

/** Why this install takes the new version from the download page (install 'download'). */
export function downloadHint(u: UpdateState): string {
  if (u.reason) return u.reason;
  const pkg = u.kind ? PACKAGE_KINDS[u.kind] : undefined;
  if (pkg) {
    return `이 설치 방식(${pkg})에서는 새 패키지를 받아 설치해 주세요.${u.kind === 'arch' ? ' (릴리스의 PKGBUILD로 makepkg -si)' : ''}`;
  }
  return '다운로드 페이지에서 새 버전을 받아 설치해 주세요.';
}

/**
 * macOS keeps the microphone permission per signature, and an app signed without a developer ID gets a new one with
 * every version: it may ask again, or silently record nothing while System Settings still shows it allowed.
 */
export const MAC_MIC_FIX = '녹음이 안 되면 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 easy-study를 껐다 켜 주세요.';
export const MAC_MIC_HINT = `macOS에서는 업데이트 뒤 처음 녹음할 때 마이크 권한을 다시 물을 수 있어요. ${MAC_MIC_FIX}`;

/** The toast after an update (the shell pushes justUpdated during the whole launch after it). */
export function updatedToast(version: string, os: DesktopOs | undefined): string {
  return `easy-study ${version} 버전으로 업데이트했어요.${os === 'macos' ? ` ${MAC_MIC_FIX}` : ''}`;
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
 * An error of the update state as a sentence: "업데이트하지 못했어요: …", unless the shell's text says so itself
 * ("업데이트가 끝나지 않았어요…", "업데이트하지 못했어요. …"; update.rs says_update_failed).
 */
export function updateErrorText(u: UpdateState): string {
  const error = u.error ?? '알 수 없는 오류';
  return /^업데이트(가|하지) /.test(error) ? error : `업데이트하지 못했어요: ${error}`;
}
