import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Keyboard, Languages, Lightbulb, LockOpen, Settings, TriangleAlert } from 'lucide-react';
import { ApiError, errorMessage, login } from '../api.ts';
import { msg, type Messages } from '../i18n/index.ts';
import { LangSelect } from '../i18n/LangSelect.tsx';
import { formatWait, hasHangul, isLoopbackHost, markLoggedIn, normalizeAccessCode, type LoginReason } from '../lib/auth.ts';
import { desktopAction, desktopMarker, leaveConfirm, readPageBusy, useDesktopState } from '../lib/desktop.ts';

interface LoginScreenProps {
  reason: LoginReason | null;
  /** Shown over the app, which stays mounted underneath (the session ended while it was in use). */
  overlay: boolean;
}

type NoticeKey = keyof Messages['shell']['auth']['notices'];

/** The notice above the form for each reason (its text is msg().shell.auth.notices[key]). */
const NOTICES: Record<LoginReason, { key: NoticeKey; tone: 'info' | 'error' } | null> = {
  required: null,
  expired: { key: 'expired', tone: 'info' },
  logout: { key: 'logout', tone: 'info' },
  'link-failed': { key: 'linkFailed', tone: 'error' },
  'link-limited': { key: 'linkLimited', tone: 'error' },
};

/** Access code login for the remote mode (DESIGN §16). */
export function LoginScreen({ reason, overlay }: LoginScreenProps) {
  const [code, setCode] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Rate limited (429): no attempts before this time (ms). */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const desktop = useDesktopState();

  useEffect(() => {
    if (lockedUntil === null) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) {
        setLockedUntil(null);
        setError(null);
        inputRef.current?.focus();
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const waitLeft = lockedUntil === null ? 0 : Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  const locked = waitLeft > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || locked) return;
    const accessCode = normalizeAccessCode(code);
    const m = msg().shell.auth;
    if (!accessCode) {
      setError(m.enterCode);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(accessCode);
      markLoggedIn(); // the gate swaps this screen for the app
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        if (err.retryAfter !== null && err.retryAfter > 0) {
          setLockedUntil(Date.now() + err.retryAfter * 1000);
          setError(null);
        } else {
          setError(msg().shell.auth.tooManyAttempts);
        }
      } else if (err instanceof ApiError && err.status === 401) {
        setError(msg().shell.auth.wrongCode);
      } else {
        setError(errorMessage(err));
      }
      setBusy(false);
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  };

  const m = msg().shell.auth;
  const notice = reason ? NOTICES[reason] : null;
  const hangul = hasHangul(code);
  // Plain HTTP to another computer — also when the app shows a plain-http remote through its loopback relay (the page
  // is at 127.0.0.1 then, but the code and cookie still cross the network unencrypted).
  const remoteHttp = desktop?.connection?.kind === 'remote' && desktop.connection.origin.startsWith('http:');
  const insecure = (window.location.protocol === 'http:' && !isLoopbackHost(window.location.hostname)) || remoteHttp;
  const message = locked ? m.tooManyAttemptsWait(formatWait(waitLeft)) : error;

  return (
    <div
      className={overlay ? 'auth-screen is-overlay' : 'auth-screen'}
      // A PDF dropped here must neither upload (the app underneath) nor replace the page.
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <main className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <img className="auth-logo" src="/icons/icon-192.png" width={56} height={56} alt="" />
          <h1 id="auth-title" className="auth-title">
            easy-study
          </h1>
          <p className="auth-sub">{m.sub}</p>
        </div>

        {notice && (
          <p className={notice.tone === 'error' ? 'auth-notice is-error' : 'auth-notice'} role="status">
            {m.notices[notice.key]}
          </p>
        )}

        <form className="auth-form" onSubmit={(e) => void submit(e)} noValidate>
          {/* Lets password managers file the code under a recognisable name. */}
          <input type="text" name="username" autoComplete="username" value="easy-study" readOnly hidden />
          <label htmlFor="access-code" className="auth-label">
            {m.codeLabel}
          </label>
          <div className="auth-field">
            <input
              ref={inputRef}
              id="access-code"
              name="password"
              className="auth-input"
              type={reveal ? 'text' : 'password'}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError(null);
              }}
              placeholder="xxxxx-xxxxx-xxxxx-xxxxx"
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              autoFocus
              aria-invalid={message ? true : undefined}
              aria-describedby="access-code-help"
            />
            <button
              type="button"
              className="auth-reveal"
              onClick={() => {
                setReveal((r) => !r);
                inputRef.current?.focus();
              }}
              aria-pressed={reveal}
              aria-controls="access-code"
            >
              {reveal ? m.hide : m.show}
            </button>
          </div>
          <p id="access-code-help" className="auth-field-hint">
            {hangul ? (
              <>
                <Keyboard /> {m.hangulTyped}
              </>
            ) : (
              m.codeFormatHint
            )}
          </p>

          <button type="submit" className="primary-btn auth-submit" disabled={busy || locked || code.trim() === ''}>
            {busy ? m.checking : locked ? m.retryIn(formatWait(waitLeft)) : m.login}
          </button>

          <div className="auth-error" role="alert" aria-live="assertive">
            {message && (
              <p>
                <TriangleAlert /> {message}
              </p>
            )}
          </div>
        </form>

        <div className="auth-hint">
          <p>
            <Lightbulb />{' '}
            {m.codeWhere(
              <strong>{m.codeWhereServer}</strong>,
              <Settings />,
              <code>npm run start:remote</code>,
              <code>…/login?code=…</code>,
            )}
          </p>
          <details className="auth-help">
            <summary>{m.noCode}</summary>
            <ul>
              <li>{m.noCodeRestart}</li>
              <li>{m.noCodePassword(<code>EASY_STUDY_PASSWORD</code>)}</li>
              <li>{m.noCodeNew(<code>… -- --reset-access-code</code>)}</li>
            </ul>
          </details>
        </div>

        <SwitchServerButton />
        <LangPicker />

        {insecure && (
          <p className="auth-foot">
            <LockOpen /> {m.insecure}
          </p>
        )}
      </main>
    </div>
  );
}

/** The language before a login (the same setting as 설정 › 화면 › 언어). */
export function LangPicker() {
  return (
    <div className="auth-lang">
      <Languages aria-hidden />
      <LangSelect className="picker small" />
    </div>
  );
}

/**
 * Inside the desktop app: back to its chooser — a wrong server, or a forgotten access code (DESIGN §24). Over the app
 * (the session ended while it was in use) a recording may still run underneath: the first click says so, inline (the
 * app's dialogs cannot be answered under this screen).
 */
export function SwitchServerButton() {
  const [warning, setWarning] = useState<string | null>(null);
  if (!desktopMarker()) return null;
  const choose = () => {
    const confirm = warning === null ? leaveConfirm(readPageBusy()) : null;
    if (confirm) {
      setWarning(confirm.message ?? confirm.title);
      return;
    }
    desktopAction('choose');
  };
  return (
    <div className="auth-switch">
      {warning && (
        <p className="auth-switch-warning" role="alert">
          <TriangleAlert /> {warning}
        </p>
      )}
      <button type="button" className="auth-switch-btn" onClick={choose}>
        {warning ? msg().shell.auth.switchServerAnyway : msg().shell.auth.switchServer}
      </button>
    </div>
  );
}
