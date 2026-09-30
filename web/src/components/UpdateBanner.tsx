// The desktop app's update banner under the top bar (DESIGN §24): a new version, its download, what went wrong. The
// shell checks, downloads and installs; the page shows its pushed state and asks it for actions (web/src/lib/desktop.ts).
import { useState } from 'react';
import { ExternalLink, PartyPopper, TriangleAlert } from 'lucide-react';
import { msg } from '../i18n/index.ts';
import { confirmDialog } from '../lib/confirm.ts';
import {
  desktopAction,
  desktopMarker,
  downloadHint,
  downloadPercent,
  installBlockReason,
  installWarning,
  macMicHint,
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
  const m = msg().shell.update.installConfirm;
  if (warning && !(await confirmDialog({ title: m.title, message: warning, confirmLabel: m.confirmLabel }))) {
    return;
  }
  desktopAction('install-update');
}

export function UpdateProgress({ update }: { update: UpdateState }) {
  const pct = downloadPercent(update);
  return <progress className="update-progress" max={100} value={pct ?? undefined} aria-label={msg().shell.update.downloadLabel} />;
}

/** A link to the release page (opened in the system browser: the app sends other sites there), with the ↗ icon. */
function ReleaseLink({ update, children }: { update: UpdateState; children: string }) {
  if (!update.releaseUrl) return null;
  return (
    <a className="ghost-btn small" href={update.releaseUrl} target="_blank" rel="noreferrer">
      {children} <ExternalLink />
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
  const m = msg().shell.update;

  const later = (
    <button
      type="button"
      className="ghost-btn small"
      onClick={() => {
        setHiddenFor(`${v}:${update.phase}`);
        desktopAction('dismiss-update');
      }}
    >
      {update.phase === 'error' ? msg().common.close : m.later}
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
              <PartyPopper /> {m.available(v)} {update.install === 'download' ? downloadHint(update) : ''}
            </span>
            <ReleaseLink update={update}>{update.install === 'download' ? m.openDownloadPage : m.releaseNotes}</ReleaseLink>
            {later}
          </div>
        );
      }
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">
            <PartyPopper /> {m.available(v)}
          </span>
          {installButton(m.installAndRestart)}
          <ReleaseLink update={update}>{m.releaseNotes}</ReleaseLink>
          {later}
          {blockedHint}
          {desktopMarker()?.os === 'macos' && <span className="update-hint">{macMicHint()}</span>}
        </div>
      );
    }
    case 'downloading': {
      const pct = downloadPercent(update);
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">
            {m.downloading}
            {pct === null ? '' : ` ${pct}%`}
          </span>
          <UpdateProgress update={update} />
          <button type="button" className="ghost-btn small" onClick={() => desktopAction('cancel-update')}>
            {msg().common.cancel}
          </button>
        </div>
      );
    }
    case 'downloaded':
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">{m.downloaded}</span>
          {installButton(m.restartNow)}
          {later}
          {blockedHint}
        </div>
      );
    case 'installing':
      return (
        <div className="banner banner-info update-banner" role="status">
          <span className="update-text">{m.installing(v)}</span>
        </div>
      );
    case 'error': {
      const retryInstall = update.version !== undefined && update.install === 'inApp';
      return (
        <div className="banner banner-error update-banner" role="alert">
          <span className="update-text">
            <TriangleAlert /> {updateErrorText(update)}
          </span>
          {retryInstall ? (
            installButton(msg().common.retry)
          ) : (
            <button type="button" className="ghost-btn small" onClick={() => desktopAction('check-update')}>
              {msg().common.retry}
            </button>
          )}
          {(update.version || update.install === 'download') && <ReleaseLink update={update}>{m.openDownloadPage}</ReleaseLink>}
          {later}
          {retryInstall && blockedHint}
        </div>
      );
    }
    default:
      return null;
  }
}
