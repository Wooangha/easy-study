// The desktop app's update banner under the top bar (DESIGN §24): a new version, its download, what went wrong. The
// shell checks, downloads and installs; the page shows its pushed state and asks it for actions (web/src/lib/desktop.ts).
import { useState } from 'react';
import { confirmDialog } from '../lib/confirm.ts';
import {
  MAC_MIC_HINT,
  desktopAction,
  desktopMarker,
  downloadHint,
  downloadPercent,
  installBlockReason,
  installWarning,
  updateErrorText,
  type PageBusy,
  type UpdateState,
} from '../lib/desktop.ts';

/**
 * "업데이트하고 다시 시작": never while audio could be cut off (the button is disabled then; the shell refuses too), and
 * only after a question when an answer or an upload would stop.
 */
export async function startInstall(busy: PageBusy): Promise<void> {
  if (installBlockReason(busy)) return;
  const warning = installWarning(busy);
  if (warning && !(await confirmDialog({ title: '업데이트하고 다시 시작할까요?', message: warning, confirmLabel: '설치하고 다시 시작' }))) {
    return;
  }
  desktopAction('install-update');
}

export function UpdateProgress({ update }: { update: UpdateState }) {
  const pct = downloadPercent(update);
  return <progress className="update-progress" max={100} value={pct ?? undefined} aria-label="새 버전 내려받기" />;
}

/** A link to the release page (opened in the system browser: the app sends other sites there). */
function ReleaseLink({ update, children }: { update: UpdateState; children: string }) {
  if (!update.releaseUrl) return null;
  return (
    <a className="ghost-btn small" href={update.releaseUrl} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

interface UpdateBannerProps {
  update: UpdateState | null;
  busy: PageBusy;
}

export function UpdateBanner({ update, busy }: UpdateBannerProps) {
  // "나중에" hides it at once; the shell's push (dismissed) keeps it hidden until the next launch.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  if (!update || update.dismissed) return null;
  const v = update.version ?? '';
  if (hiddenFor !== null && hiddenFor === `${v}:${update.phase}`) return null;

  const later = (
    <button
      type="button"
      className="ghost-btn small"
      onClick={() => {
        setHiddenFor(`${v}:${update.phase}`);
        desktopAction('dismiss-update');
      }}
    >
      {update.phase === 'error' ? '닫기' : '나중에'}
    </button>
  );
  const blocked = installBlockReason(busy);
  const installButton = (label: string) => (
    <button
      type="button"
      className="primary-btn small"
      disabled={blocked !== null}
      title={blocked ?? undefined}
      onClick={() => void startInstall(busy)}
    >
      {label}
    </button>
  );
  const blockedHint = blocked && <span className="update-hint">{blocked}</span>;

  switch (update.phase) {
    case 'available': {
      if (update.install !== 'inApp') {
        return (
          <div className="banner banner-info update-banner" role="status">
            <span className="update-text">
              🎉 easy-study {v} 버전이 나왔어요. {update.install === 'download' ? downloadHint(update) : ''}
            </span>
            <ReleaseLink update={update}>{update.install === 'download' ? '다운로드 페이지 열기 ↗' : '변경 사항 ↗'}</ReleaseLink>
            {later}
          </div>
        );
      }
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">🎉 easy-study {v} 버전이 나왔어요.</span>
          {installButton('업데이트하고 다시 시작')}
          <ReleaseLink update={update}>변경 사항 ↗</ReleaseLink>
          {later}
          {blockedHint}
          {desktopMarker()?.os === 'macos' && <span className="update-hint">{MAC_MIC_HINT}</span>}
        </div>
      );
    }
    case 'downloading': {
      const pct = downloadPercent(update);
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">새 버전을 내려받는 중…{pct === null ? '' : ` ${pct}%`}</span>
          <UpdateProgress update={update} />
          <button type="button" className="ghost-btn small" onClick={() => desktopAction('cancel-update')}>
            취소
          </button>
        </div>
      );
    }
    case 'downloaded':
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">새 버전을 받아 두었어요. 녹음이 끝나면 다시 시작해서 설치할 수 있어요.</span>
          {installButton('지금 다시 시작해서 설치')}
          {later}
          {blockedHint}
        </div>
      );
    case 'installing':
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">easy-study {v} 버전을 설치하는 중… 끝나면 앱이 다시 시작돼요.</span>
        </div>
      );
    case 'error': {
      const retryInstall = update.version !== undefined && update.install === 'inApp';
      return (
        <div className="banner banner-error update-banner" role="alert">
          <span className="update-text">⚠️ {updateErrorText(update)}</span>
          {retryInstall ? (
            installButton('다시 시도')
          ) : (
            <button type="button" className="ghost-btn small" onClick={() => desktopAction('check-update')}>
              다시 시도
            </button>
          )}
          {(update.version || update.install === 'download') && <ReleaseLink update={update}>다운로드 페이지 열기 ↗</ReleaseLink>}
          {later}
          {retryInstall && blockedHint}
        </div>
      );
    }
    default:
      return null;
  }
}
