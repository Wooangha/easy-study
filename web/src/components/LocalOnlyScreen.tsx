import { Settings } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { msg, useLang } from '../i18n/index.ts';
import { LangPicker, SwitchServerButton } from './LoginScreen.tsx';

interface LocalOnlyScreenProps {
  /** The server's refusal message. */
  message: string | null;
  onRetry: () => void;
}

/**
 * The server runs in local mode (loopback only, no login) and this page was opened through another
 * address — e.g. a host name forwarded by `tailscale serve`. Explains how to open it (DESIGN §16).
 */
export function LocalOnlyScreen({ message, onRetry }: LocalOnlyScreenProps) {
  const port = window.location.port || '5180';
  const m = msg().shell.auth.localOnly;
  // The server's message is in the language it was asked in (DESIGN §27): asked again when the language changes here.
  const lang = useLang();
  const askedLang = useRef(lang);
  useEffect(() => {
    if (askedLang.current === lang) return;
    askedLang.current = lang;
    onRetry();
  }, [lang, onRetry]);
  return (
    <div className="auth-screen">
      <main className="auth-card" aria-labelledby="local-title">
        <div className="auth-brand">
          <img className="auth-logo" src="/icons/icon-192.png" width={56} height={56} alt="" />
          <h1 id="local-title" className="auth-title">
            {m.title}
          </h1>
          <p className="auth-sub">{m.sub(<code>{window.location.host}</code>)}</p>
        </div>
        <div className="auth-hint auth-hint-plain">
          <ul>
            <li>{m.useApp(<Settings />)}</li>
            <li>{m.thisComputer(<code>http://127.0.0.1:{port}</code>)}</li>
            <li>
              {m.remoteMode}
              <pre className="auth-cmd">EASY_STUDY_HOST=0.0.0.0 npm start</pre>
              <span className="muted small">Windows PowerShell:</span>
              <pre className="auth-cmd">$env:EASY_STUDY_HOST="0.0.0.0"; npm start</pre>
            </li>
            <li>{m.proxy(<code>tailscale serve</code>, <code>EASY_STUDY_AUTH=on</code>)}</li>
          </ul>
          {message && <p className="muted small">{m.serverSaid(message)}</p>}
        </div>
        <button type="button" className="primary-btn auth-submit" onClick={onRetry}>
          {m.checkAgain}
        </button>
        <SwitchServerButton />
        <LangPicker />
      </main>
    </div>
  );
}
