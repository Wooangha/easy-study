// 설정 (the gear in the top bar; inside the desktop app also the menu "설정…", DESIGN §24): a modal over the app, so the open
// lecture stays as it is. Sections 화면 · 공부 · 녹음 · 데스크톱 앱 (inside the app only) · 정보, stacked; on wide
// screens a list on the left jumps to them. What is set here is this device's (browser storage), except the theme
// inside the app, which the shell keeps for all of its windows.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Languages, Settings, TriangleAlert, X } from 'lucide-react';
import type { HealthResponse } from '../../../shared/types.ts';
import { useAsrStatus } from '../hooks/useAsrStatus.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { NEIGHBOR_OPTIONS, useNeighbors } from '../hooks/useNeighbors.ts';
import { msg } from '../i18n/index.ts';
import { LangSelect } from '../i18n/LangSelect.tsx';
import { useMemosToTutor, useQuestionMarkers } from '../lib/annotations/settings.ts';
import { copyText } from '../lib/clipboard.ts';
import { confirmDialog } from '../lib/confirm.ts';
import {
  SETTINGS_SECTIONS,
  compareVersions,
  desktopAction,
  desktopMarker,
  downloadHint,
  installBlockReason,
  isNameUrl,
  leaveConfirm,
  macMicHint,
  readPageBusy,
  resetCodeConfirm,
  shareBlockReason,
  shareWarning,
  updateStatusLine,
  useDesktopState,
  type DesktopMarker,
  type DesktopShare,
  type PageBusy,
  type SettingsSection,
} from '../lib/desktop.ts';
import { storageKeys, writeStorage } from '../lib/storage.ts';
import { THEME_PREFS, setThemePref, useThemePref } from '../lib/theme.ts';
import { toast } from '../lib/toast.ts';
import { AsrSettings } from './recording/AsrSettings.tsx';
import { Toaster } from './Toaster.tsx';
import { UpdateProgress, startInstall } from './UpdateBanner.tsx';

interface SettingsDialogProps {
  open: boolean;
  /** The section to show first (null: the top). */
  section: SettingsSection | null;
  onClose: () => void;
  health: HealthResponse | null;
  /** What the page is doing (an update or a change of server would interrupt it). */
  busy: PageBusy;
}

export function SettingsDialog({ open, section, onClose, health, busy }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // Like ConfirmHost: a modal <dialog> (the rest of the page is inert), Esc or the backdrop closes, focus returns.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      dialog.close();
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected) target.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault(); // closed by the effect
        onClose();
      }}
      // Closed some other way (a browser closes a modal on a second Esc without asking).
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // The app's shortcuts (j/k, /) must not act on the page behind the dialog.
      onKeyDown={(e) => e.stopPropagation()}
    >
      {open && <SettingsContent section={section} onClose={onClose} health={health} busy={busy} />}
      {/* The page's toasts are under the modal's backdrop: shown here while it is open (App leaves its own out). */}
      {open && <Toaster />}
    </dialog>
  );
}

function SettingsContent({ section, onClose, health, busy }: Omit<SettingsDialogProps, 'open'>) {
  const marker = desktopMarker();
  const sections = SETTINGS_SECTIONS.filter((s) => s !== 'desktop' || marker !== null);
  const first = section && sections.includes(section) ? section : sections[0];
  const [active, setActive] = useState<SettingsSection>(first);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<SettingsSection, HTMLElement>());

  const show = (s: SettingsSection) => {
    const el = sectionRefs.current.get(s);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    setActive(s);
  };
  // Only when a section is asked for (on opening, or by the app menu while open).
  const showRef = useLatest(show);
  useLayoutEffect(() => {
    if (section) showRef.current(section);
  }, [section, showRef]);

  // The list follows the scrolling: the last section whose heading is at the top (the last one at the very end).
  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const top = body.getBoundingClientRect().top;
    let current = sections[0];
    for (const s of sections) {
      const el = sectionRefs.current.get(s);
      if (el && el.getBoundingClientRect().top - top <= 48) current = s;
    }
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) current = sections[sections.length - 1];
    setActive(current);
  };

  const register = (s: SettingsSection) => (el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(s, el);
    else sectionRefs.current.delete(s);
  };

  const m = msg();
  const titles = m.settings.dialog.sections;
  const content: Record<SettingsSection, ReactNode> = {
    display: <DisplaySection inApp={marker !== null} />,
    study: <StudySection />,
    recording: <RecordingSection />,
    desktop: marker ? <DesktopSection marker={marker} busy={busy} /> : null,
    about: <AboutSection health={health} marker={marker} />,
  };

  return (
    <>
      <header className="settings-head">
        <h2 id="settings-title" className="settings-title">
          {m.common.settings}
        </h2>
        <button type="button" className="icon-btn" aria-label={m.common.close} title={m.settings.dialog.closeTitle} onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={m.settings.dialog.nav}>
          {sections.map((s) => (
            <button
              key={s}
              type="button"
              className={s === active ? 'settings-nav-item is-active' : 'settings-nav-item'}
              aria-current={s === active ? 'true' : undefined}
              onClick={() => show(s)}
            >
              {titles[s]}
            </button>
          ))}
        </nav>
        <div ref={bodyRef} className="settings-body" onScroll={onScroll}>
          {sections.map((s) => (
            <section key={s} ref={register(s)} className="settings-section" aria-labelledby={`settings-${s}`}>
              <h3 id={`settings-${s}`} className="settings-section-title">
                {titles[s]}
              </h3>
              {content[s]}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 화면 · 공부 · 녹음
// ---------------------------------------------------------------------------------------------------------------

function DisplaySection({ inApp }: { inApp: boolean }) {
  const theme = useThemePref();
  const m = msg().settings.display;
  return (
    <>
      <div className="settings-row">
        <span className="settings-label" id="settings-theme-label">
          {m.theme}
        </span>
        <div className="settings-seg" role="radiogroup" aria-labelledby="settings-theme-label">
          {THEME_PREFS.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="settings-theme"
                value={value}
                checked={theme === value}
                onChange={() => setThemePref(value)}
              />
              <span>{m.themeOptions[value]}</span>
            </label>
          ))}
        </div>
      </div>
      {inApp && <p className="settings-hint">{m.themeHintApp}</p>}
      <div className="settings-row settings-row-gap">
        <label className="settings-label" htmlFor="settings-lang">
          <Languages /> {m.language}
        </label>
        <LangSelect id="settings-lang" />
      </div>
      <p className="settings-hint">{inApp ? m.languageHintApp : m.browserOnlyHint}</p>
    </>
  );
}

function StudySection() {
  const [neighbors, setNeighbors] = useNeighbors();
  const [memosToTutor, setMemosToTutor] = useMemosToTutor();
  const [markers, setMarkers] = useQuestionMarkers();
  const m = msg().settings.study;
  return (
    <>
      <label className="settings-row">
        <span className="settings-label">{m.neighbors}</span>
        <select className="picker" value={neighbors} onChange={(e) => setNeighbors(Number(e.target.value))}>
          {NEIGHBOR_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? m.neighborsNone : m.neighborsCount(n)}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-hint">{m.neighborsHint}</p>
      <h4 className="settings-sub">{m.annotations}</h4>
      <label className="rec-setting rec-setting-check">
        <input type="checkbox" checked={memosToTutor} onChange={(e) => setMemosToTutor(e.target.checked)} />
        <span>{m.memosToTutor}</span>
      </label>
      <p className="settings-hint">{m.memosToTutorHint}</p>
      <label className="rec-setting rec-setting-check">
        <input type="checkbox" checked={markers} onChange={(e) => setMarkers(e.target.checked)} />
        <span>{m.questionMarkers}</span>
      </label>
      <p className="settings-hint">{m.questionMarkersHint}</p>
    </>
  );
}

function RecordingSection() {
  const asr = useAsrStatus(true);
  const m = msg().settings.recording;
  return (
    <>
      {asr.error && !asr.status && <div className="inline-error"><TriangleAlert /> {m.asrStatusFailed(asr.error)}</div>}
      <AsrSettings asr={asr} />
      <div className="settings-actions">
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => {
            writeStorage(storageKeys.recordingConsent, null);
            toast(msg().settings.recording.noticeReset, 'success');
          }}
        >
          {m.showNoticeAgain}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 데스크톱 앱 (inside the app only)
// ---------------------------------------------------------------------------------------------------------------

/** "연결 대상 바꾸기…": the chooser replaces this page, so first what would be lost is asked about. */
async function chooseServer(busy: PageBusy): Promise<void> {
  const confirm = leaveConfirm(readPageBusy() ?? busy);
  if (confirm && !(await confirmDialog(confirm))) return;
  desktopAction('choose');
}

/** The switch "다른 기기에서 접속 허용": the shell restarts this computer's server (the chooser shows meanwhile). */
async function setShare(on: boolean, busy: PageBusy): Promise<void> {
  const warning = shareWarning(readPageBusy() ?? busy);
  const m = msg().settings.share.restartConfirm;
  if (warning && !(await confirmDialog({ title: m.title, message: warning, confirmLabel: m.confirmLabel }))) return;
  desktopAction(on ? 'share/on' : 'share/off');
}

/** "접속 코드 새로 만들기": every device is logged out, the server restarts once with a new code. */
async function resetShareCode(busy: PageBusy): Promise<void> {
  if (!(await confirmDialog(resetCodeConfirm(readPageBusy() ?? busy)))) return;
  desktopAction('share/reset-code');
}

/** Copies `text`, then says `done` (or that it could not). */
function copyWithToast(text: string, done: string): void {
  copyText(text).then(
    () => toast(done, 'success'),
    () => toast(msg().settings.copyFailed, 'error'),
  );
}

/** 다른 기기에서 접속 (this computer's server only, DESIGN §16/§19). */
function ShareBlock({ share, busy }: { share: DesktopShare; busy: PageBusy }) {
  const blocked = shareBlockReason(busy);
  const { common } = msg();
  const m = msg().settings.share;
  return (
    <>
      <h4 className="settings-sub">{m.title}</h4>
      <label className="rec-setting rec-setting-check">
        <input type="checkbox" checked={share.on} disabled={blocked !== null} onChange={(e) => void setShare(e.target.checked, busy)} />
        <span>{m.allow}</span>
      </label>
      {blocked && <p className="settings-hint">{blocked}</p>}
      <p className="settings-hint">{m.about}</p>
      {share.on && !share.running && <p className="settings-hint">{m.restartForAddresses}</p>}
      {share.running && (
        <>
          <p className="settings-line">{m.addresses}</p>
          {share.urls.length === 0 && <p className="settings-hint">{m.noAddresses}</p>}
          {share.urls.map((url) => (
            <p key={url} className="settings-line">
              <span className="settings-path">
                <code>{url}</code>
                <button type="button" className="ghost-btn tiny" onClick={() => copyWithToast(url, m.copiedAddress)}>
                  {common.copy}
                </button>
                {isNameUrl(url) && <span className="settings-status">{m.nameOnly}</span>}
              </span>
            </p>
          ))}
          <p className="settings-line">
            {share.code ? (
              <span className="settings-path">
                {m.code} <code>{share.code}</code>
                <button type="button" className="ghost-btn tiny" onClick={() => copyWithToast(share.code!, m.copiedCode)}>
                  {common.copy}
                </button>
              </span>
            ) : (
              <span className="settings-path">
                {m.code}
                <button type="button" className="ghost-btn tiny" onClick={() => desktopAction('share/reveal')}>
                  {m.showCode}
                </button>
                <span className="settings-status">{m.codeInChooser(<Settings />)}</span>
              </span>
            )}
          </p>
          <div className="settings-actions">
            <button type="button" className="ghost-btn small" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => void resetShareCode(busy)}>
              {m.resetCode}
            </button>
          </div>
          <p className="settings-hint">{m.networkHint}</p>
        </>
      )}
    </>
  );
}

function DesktopSection({ marker, busy }: { marker: DesktopMarker; busy: PageBusy }) {
  const state = useDesktopState();
  const update = state?.update ?? null;
  const connection = state?.connection ?? null;
  const share = connection?.kind === 'local' ? (state?.share ?? null) : null;
  const mac = marker.os === 'macos';
  const pending = update && (update.phase === 'available' || update.phase === 'downloaded');
  const canInstall = !!pending && update.install === 'inApp';
  const blocked = installBlockReason(busy);
  const working = update?.phase === 'checking' || update?.phase === 'downloading' || update?.phase === 'installing';
  const m = msg().settings.desktop;

  return (
    <>
      <h4 className="settings-sub">{m.updates}</h4>
      <p className="settings-line">
        {m.version(<b>{update?.current ?? marker.version}</b>)}
        {update && <span className="settings-status"> · {updateStatusLine(update)}</span>}
      </p>
      {update?.phase === 'downloading' && <UpdateProgress update={update} />}
      {pending && update.notes && (
        <details className="settings-notes">
          <summary>{m.releaseNotes}</summary>
          <p>{update.notes}</p>
        </details>
      )}
      <div className="settings-actions">
        <button type="button" className="ghost-btn small" disabled={working} onClick={() => desktopAction('check-update')}>
          {m.checkUpdate}
        </button>
        {canInstall && (
          <button
            type="button"
            className="primary-btn small"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => void startInstall(busy)}
          >
            {m.installAndRestart}
          </button>
        )}
        {/* Also after an update that did not take (phase error: "다운로드 페이지에서 직접 설치해 주세요"). */}
        {(pending || update?.phase === 'error') && update.install === 'download' && update.releaseUrl && (
          <a className="ghost-btn small" href={update.releaseUrl} target="_blank" rel="noreferrer">
            {m.openDownloadPage} <ExternalLink />
          </a>
        )}
      </div>
      {canInstall && blocked && <p className="settings-hint">{blocked}</p>}
      {pending && update.install === 'download' && <p className="settings-hint">{downloadHint(update)}</p>}
      {canInstall && mac && <p className="settings-hint">{macMicHint()}</p>}
      {update?.auto === false && (
        <p className="settings-hint">{m.autoCheckOff(<Settings />)}</p>
      )}

      <h4 className="settings-sub">{m.connection}</h4>
      <p className="settings-line">
        {connection
          ? connection.kind === 'local'
            ? m.connectedLocal
            : m.connectedRemote(connection.origin)
          : m.connectedTo(window.location.origin)}
      </p>
      {connection && <p className="settings-line">{connection.startup === 'auto' ? m.startupAuto : m.startupAsk}</p>}
      <div className="settings-actions">
        <button type="button" className="ghost-btn small" onClick={() => void chooseServer(busy)}>
          {m.changeConnection}
        </button>
        {connection?.startup === 'auto' && (
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => {
              desktopAction('forget-choice');
              toast(msg().settings.desktop.askNextTimeDone, 'success');
            }}
          >
            {m.askNextTime}
          </button>
        )}
      </div>
      <p className="settings-hint">{m.menuHint(<kbd>{mac ? '⌘⇧K' : 'Ctrl+Shift+K'}</kbd>)}</p>
      {share && <ShareBlock share={share} busy={busy} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 정보
// ---------------------------------------------------------------------------------------------------------------

function AboutSection({ health, marker }: { health: HealthResponse | null; marker: DesktopMarker | null }) {
  const state = useDesktopState();
  const remote = state?.connection?.kind === 'remote';
  // A server from before the version was reported is older than any app that asks.
  const olderServer = marker !== null && remote && health !== null && (!health.version || compareVersions(health.version, marker.version) < 0);
  const mod = marker?.os === 'macos' ? '⌘' : 'Ctrl+';
  const { common } = msg();
  const m = msg().settings.about;
  const k = m.keys;
  const keys: Array<[ReactNode, string]> = [
    [<><kbd>j</kbd> <kbd>↓</kbd> <kbd>PageDown</kbd></>, k.nextSlide],
    [<><kbd>k</kbd> <kbd>↑</kbd> <kbd>PageUp</kbd></>, k.previousSlide],
    [<><kbd>Home</kbd> <kbd>End</kbd></>, k.firstLastSlide],
    [<kbd>/</kbd>, k.focusComposer],
    [<kbd>Enter</kbd>, k.send],
    [<><kbd>Shift</kbd>+<kbd>Enter</kbd></>, k.newLine],
    [<kbd>Esc</kbd>, k.escape],
    [<kbd>{`${mod}Z`}</kbd>, k.undo],
    [<kbd>{marker?.os === 'macos' || !marker ? '⌘⇧Z' : 'Ctrl+Y'}</kbd>, k.redo],
    [<kbd>Delete</kbd>, k.deleteSelected],
  ];
  if (marker) {
    keys.push([<kbd>{`${mod},`}</kbd>, k.settings]);
    keys.push([<kbd>{marker.os === 'macos' ? '⌘⇧K' : 'Ctrl+Shift+K'}</kbd>, k.changeConnection]);
  }

  return (
    <>
      <dl className="settings-kv">
        <dt>{m.serverVersion}</dt>
        <dd>{health ? (health.version ?? m.unknown) : common.loading}</dd>
        {marker && (
          <>
            <dt>{m.appVersion}</dt>
            <dd>{marker.version}</dd>
          </>
        )}
        <dt>{m.libraryFolder}</dt>
        <dd>
          {health ? (
            <span className="settings-path">
              <code>{health.libraryDir}</code>
              <button
                type="button"
                className="ghost-btn tiny"
                onClick={() => copyWithToast(health.libraryDir, m.copiedLibraryFolder)}
              >
                {common.copy}
              </button>
            </span>
          ) : (
            common.loading
          )}
        </dd>
      </dl>
      {olderServer && <p className="settings-hint is-warn">{m.olderServer}</p>}
      <h4 className="settings-sub">{m.shortcuts}</h4>
      <table className="settings-keys">
        <tbody>
          {keys.map(([k, what]) => (
            <tr key={what}>
              <th scope="row">{k}</th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="settings-hint">{m.shortcutsHint}</p>
    </>
  );
}
