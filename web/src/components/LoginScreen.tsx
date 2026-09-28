import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, login } from '../api.ts';
import { formatWait, hasHangul, isLoopbackHost, markLoggedIn, normalizeAccessCode, type LoginReason } from '../lib/auth.ts';
import { desktopAction, desktopMarker, leaveConfirm, readPageBusy } from '../lib/desktop.ts';

interface LoginScreenProps {
  reason: LoginReason | null;
  /** Shown over the app, which stays mounted underneath (the session ended while it was in use). */
  overlay: boolean;
}

const NOTICES: Record<LoginReason, { text: string; tone: 'info' | 'error' } | null> = {
  required: null,
  expired: { text: '로그인이 만료됐어요. 다시 로그인하면 보던 화면 그대로 이어서 쓸 수 있어요.', tone: 'info' },
  logout: { text: '로그아웃했어요.', tone: 'info' },
  'link-failed': {
    text: '로그인 링크의 접속 코드가 맞지 않아요. 서버 터미널에 표시된 코드를 직접 입력해 주세요.',
    tone: 'error',
  },
  'link-limited': {
    text: '로그인 시도가 너무 많아서 링크로 로그인하지 못했어요. 잠시 후에 다시 시도해 주세요.',
    tone: 'error',
  },
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
    if (!accessCode) {
      setError('접속 코드를 입력해 주세요.');
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
          setError('로그인 시도가 너무 많아요. 잠시 후에 다시 시도해 주세요.');
        }
      } else if (err instanceof ApiError && err.status === 401) {
        setError('접속 코드가 맞지 않아요. 서버 터미널에 표시된 코드를 다시 확인해 주세요.');
      } else {
        setError(errorMessage(err));
      }
      setBusy(false);
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  };

  const notice = reason ? NOTICES[reason] : null;
  const hangul = hasHangul(code);
  const insecure = window.location.protocol === 'http:' && !isLoopbackHost(window.location.hostname);
  const message = locked ? `로그인 시도가 너무 많아요. ${formatWait(waitLeft)} 후에 다시 시도해 주세요.` : error;

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
          <p className="auth-sub">접속 코드를 입력하면 시작할 수 있어요.</p>
        </div>

        {notice && (
          <p className={notice.tone === 'error' ? 'auth-notice is-error' : 'auth-notice'} role="status">
            {notice.text}
          </p>
        )}

        <form className="auth-form" onSubmit={(e) => void submit(e)} noValidate>
          {/* Lets password managers file the code under a recognisable name. */}
          <input type="text" name="username" autoComplete="username" value="easy-study" readOnly hidden />
          <label htmlFor="access-code" className="auth-label">
            접속 코드
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
              {reveal ? '숨기기' : '보기'}
            </button>
          </div>
          <p id="access-code-help" className="auth-field-hint">
            {hangul
              ? '⌨️ 한글이 입력됐어요. 한/영 키를 눌러 영문으로 바꾼 뒤 다시 입력해 주세요.'
              : '대시(-)나 띄어쓰기는 있어도 없어도 괜찮아요. 붙여넣기도 돼요.'}
          </p>

          <button type="submit" className="primary-btn auth-submit" disabled={busy || locked || code.trim() === ''}>
            {busy ? '확인하는 중…' : locked ? `${formatWait(waitLeft)} 후 다시 시도` : '로그인'}
          </button>

          <div className="auth-error" role="alert" aria-live="assertive">
            {message && <p>⚠️ {message}</p>}
          </div>
        </form>

        <div className="auth-hint">
          <p>
            💡 접속 코드는 <strong>easy-study 서버를 실행한 컴퓨터의 터미널</strong>에 표시돼요. 터미널에 함께 나온
            로그인 링크(<code>…/login?code=…</code>)를 열어도 바로 들어올 수 있어요.
          </p>
          <details className="auth-help">
            <summary>코드가 보이지 않나요?</summary>
            <ul>
              <li>서버를 다시 실행하면 같은 코드가 다시 표시돼요.</li>
              <li>
                <code>EASY_STUDY_PASSWORD</code>로 비밀번호를 직접 정해 두었다면 그 비밀번호를 입력하세요.
              </li>
              <li>
                새 코드가 필요하면 터미널에 함께 나온 ‘코드를 바꾸고 모든 로그인을 끊으려면’ 명령(
                <code>… -- --reset-access-code</code>)으로 서버를 다시 실행하세요. 로그인해 둔 다른 기기들도 모두
                로그아웃돼요.
              </li>
            </ul>
          </details>
        </div>

        <SwitchServerButton />

        {insecure && (
          <p className="auth-foot">
            🔓 암호화되지 않은 연결(HTTP)이에요. 같은 Wi‑Fi처럼 믿을 수 있는 네트워크에서만 사용하세요. 이
            주소에서는 Chrome/Edge의 ‘앱 설치’도 되지 않아요 (HTTPS가 필요해요: README의 ‘앱으로 설치하기’ 참고).
          </p>
        )}
      </main>
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
          ⚠️ {warning}
        </p>
      )}
      <button type="button" className="auth-switch-btn" onClick={choose}>
        {warning ? '그래도 다른 서버에 연결' : '다른 서버에 연결…'}
      </button>
    </div>
  );
}
