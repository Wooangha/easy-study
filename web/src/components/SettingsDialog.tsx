// 설정 (⚙ in the top bar; inside the desktop app also the menu "설정…", DESIGN §24): a modal over the app, so the open
// lecture stays as it is. Sections 화면 · 공부 · 녹음 · 데스크톱 앱 (inside the app only) · 정보, stacked; on wide
// screens a list on the left jumps to them. What is set here is this device's (browser storage), except the theme
// inside the app, which the shell keeps for all of its windows.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { HealthResponse } from '../../../shared/types.ts';
import { useAsrStatus } from '../hooks/useAsrStatus.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { NEIGHBOR_OPTIONS, useNeighbors } from '../hooks/useNeighbors.ts';
import { copyText } from '../lib/clipboard.ts';
import { confirmDialog } from '../lib/confirm.ts';
import {
  MAC_MIC_HINT,
  SETTINGS_SECTIONS,
  compareVersions,
  desktopAction,
  desktopMarker,
  downloadHint,
  installBlockReason,
  leaveConfirm,
  readPageBusy,
  updateStatusLine,
  useDesktopState,
  type DesktopMarker,
  type PageBusy,
  type SettingsSection,
} from '../lib/desktop.ts';
import { storageKeys, writeStorage } from '../lib/storage.ts';
import { setThemePref, useThemePref, type ThemePref } from '../lib/theme.ts';
import { toast } from '../lib/toast.ts';
import { AsrSettings } from './recording/AsrSettings.tsx';
import { Toaster } from './Toaster.tsx';
import { UpdateProgress, startInstall } from './UpdateBanner.tsx';

const SECTION_TITLES: Record<SettingsSection, string> = {
  display: '화면',
  study: '공부',
  recording: '녹음',
  desktop: '데스크톱 앱',
  about: '정보',
};

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: 'system', label: '시스템 설정 따르기' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
];

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
          설정
        </h2>
        <button type="button" className="icon-btn" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="설정 항목">
          {sections.map((s) => (
            <button
              key={s}
              type="button"
              className={s === active ? 'settings-nav-item is-active' : 'settings-nav-item'}
              aria-current={s === active ? 'true' : undefined}
              onClick={() => show(s)}
            >
              {SECTION_TITLES[s]}
            </button>
          ))}
        </nav>
        <div ref={bodyRef} className="settings-body" onScroll={onScroll}>
          {sections.map((s) => (
            <section key={s} ref={register(s)} className="settings-section" aria-labelledby={`settings-${s}`}>
              <h3 id={`settings-${s}`} className="settings-section-title">
                {SECTION_TITLES[s]}
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
  return (
    <>
      <div className="settings-row">
        <span className="settings-label" id="settings-theme-label">
          테마
        </span>
        <div className="settings-seg" role="radiogroup" aria-labelledby="settings-theme-label">
          {THEME_OPTIONS.map((o) => (
            <label key={o.value}>
              <input
                type="radio"
                name="settings-theme"
                value={o.value}
                checked={theme === o.value}
                onChange={() => setThemePref(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </div>
      <p className="settings-hint">{inApp ? '앱의 모든 화면(연결 선택 화면 포함)에 적용돼요.' : '이 브라우저에만 저장돼요.'}</p>
    </>
  );
}

function StudySection() {
  const [neighbors, setNeighbors] = useNeighbors();
  return (
    <>
      <label className="settings-row">
        <span className="settings-label">질문과 함께 보낼 앞뒤 슬라이드</span>
        <select className="picker" value={neighbors} onChange={(e) => setNeighbors(Number(e.target.value))}>
          {NEIGHBOR_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? '지금 슬라이드만' : `앞뒤 ${n}장`}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-hint">대화 창의 ‘앞뒤 ±N’과 같은 설정이에요.</p>
    </>
  );
}

function RecordingSection() {
  const asr = useAsrStatus(true);
  return (
    <>
      {asr.error && !asr.status && <div className="inline-error">⚠️ 음성 인식 상태를 확인하지 못했어요: {asr.error}</div>}
      <AsrSettings asr={asr} />
      <div className="settings-actions">
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => {
            writeStorage(storageKeys.recordingConsent, null);
            toast('다음에 녹음할 때 안내를 다시 보여 드려요.', 'success');
          }}
        >
          녹음 안내 다시 보기
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

function DesktopSection({ marker, busy }: { marker: DesktopMarker; busy: PageBusy }) {
  const state = useDesktopState();
  const update = state?.update ?? null;
  const connection = state?.connection ?? null;
  const mac = marker.os === 'macos';
  const pending = update && (update.phase === 'available' || update.phase === 'downloaded');
  const canInstall = !!pending && update.install === 'inApp';
  const blocked = installBlockReason(busy);
  const working = update?.phase === 'checking' || update?.phase === 'downloading' || update?.phase === 'installing';

  return (
    <>
      <h4 className="settings-sub">업데이트</h4>
      <p className="settings-line">
        버전 <b>{update?.current ?? marker.version}</b>
        {update && <span className="settings-status"> · {updateStatusLine(update)}</span>}
      </p>
      {update?.phase === 'downloading' && <UpdateProgress update={update} />}
      {pending && update.notes && (
        <details className="settings-notes">
          <summary>새 버전의 변경 사항</summary>
          <p>{update.notes}</p>
        </details>
      )}
      <div className="settings-actions">
        <button type="button" className="ghost-btn small" disabled={working} onClick={() => desktopAction('check-update')}>
          업데이트 확인
        </button>
        {canInstall && (
          <button
            type="button"
            className="primary-btn small"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => void startInstall(busy)}
          >
            업데이트하고 다시 시작
          </button>
        )}
        {/* Also after an update that did not take (phase error: "다운로드 페이지에서 직접 설치해 주세요"). */}
        {(pending || update?.phase === 'error') && update.install === 'download' && update.releaseUrl && (
          <a className="ghost-btn small" href={update.releaseUrl} target="_blank" rel="noreferrer">
            다운로드 페이지 열기 ↗
          </a>
        )}
      </div>
      {canInstall && blocked && <p className="settings-hint">{blocked}</p>}
      {pending && update.install === 'download' && <p className="settings-hint">{downloadHint(update)}</p>}
      {canInstall && mac && <p className="settings-hint">{MAC_MIC_HINT}</p>}
      {update?.auto === false && (
        <p className="settings-hint">시작할 때 새 버전 확인은 꺼져 있어요 (연결 선택 화면의 ⚙ 앱 설정에서 켤 수 있어요).</p>
      )}

      <h4 className="settings-sub">연결</h4>
      <p className="settings-line">
        {connection
          ? connection.kind === 'local'
            ? '연결: 이 컴퓨터'
            : `연결: 다른 컴퓨터 (${connection.origin})`
          : `연결: ${window.location.origin}`}
      </p>
      {connection && (
        <p className="settings-line">
          {connection.startup === 'auto' ? '시작할 때: 마지막 연결 대상에 바로 연결' : '시작할 때: 선택 화면 보여주기'}
        </p>
      )}
      <div className="settings-actions">
        <button type="button" className="ghost-btn small" onClick={() => void chooseServer(busy)}>
          연결 대상 바꾸기…
        </button>
        {connection?.startup === 'auto' && (
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => {
              desktopAction('forget-choice');
              toast('다음에 앱을 열면 연결 선택 화면이 먼저 나와요.', 'success');
            }}
          >
            다음 실행 때 선택 화면 보기
          </button>
        )}
      </div>
      <p className="settings-hint">
        메뉴 연결 › 연결 대상 바꾸기… (<kbd>{mac ? '⌘⇧K' : 'Ctrl+Shift+K'}</kbd>)로도 바꿀 수 있어요.
      </p>
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
  const keys: Array<[ReactNode, string]> = [
    [<><kbd>j</kbd> <kbd>↓</kbd> <kbd>PageDown</kbd></>, '다음 슬라이드'],
    [<><kbd>k</kbd> <kbd>↑</kbd> <kbd>PageUp</kbd></>, '이전 슬라이드'],
    [<><kbd>Home</kbd> <kbd>End</kbd></>, '첫 슬라이드 · 마지막 슬라이드'],
    [<kbd>/</kbd>, '질문 입력창으로'],
    [<kbd>Enter</kbd>, '질문 보내기'],
    [<><kbd>Shift</kbd>+<kbd>Enter</kbd></>, '줄 바꾸기'],
    [<kbd>Esc</kbd>, '창 닫기'],
  ];
  if (marker) {
    keys.push([<kbd>{`${mod},`}</kbd>, '설정 (앱)']);
    keys.push([<kbd>{marker.os === 'macos' ? '⌘⇧K' : 'Ctrl+Shift+K'}</kbd>, '연결 대상 바꾸기 (앱)']);
  }

  return (
    <>
      <dl className="settings-kv">
        <dt>서버 버전</dt>
        <dd>{health ? (health.version ?? '알 수 없음') : '불러오는 중…'}</dd>
        {marker && (
          <>
            <dt>앱 버전</dt>
            <dd>{marker.version}</dd>
          </>
        )}
        <dt>라이브러리 폴더</dt>
        <dd>
          {health ? (
            <span className="settings-path">
              <code>{health.libraryDir}</code>
              <button
                type="button"
                className="ghost-btn tiny"
                onClick={() => {
                  copyText(health.libraryDir).then(
                    () => toast('라이브러리 폴더 경로를 복사했어요.', 'success'),
                    () => toast('복사하지 못했어요.', 'error'),
                  );
                }}
              >
                복사
              </button>
            </span>
          ) : (
            '불러오는 중…'
          )}
        </dd>
      </dl>
      {olderServer && <p className="settings-hint is-warn">이 서버는 앱보다 오래된 버전이에요. 서버 컴퓨터에서 업데이트해 주세요.</p>}
      <h4 className="settings-sub">단축키</h4>
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
      <p className="settings-hint">슬라이드 단축키는 글을 입력하는 중이 아닐 때 동작해요.</p>
    </>
  );
}
