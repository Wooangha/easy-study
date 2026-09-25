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
  return (
    <div className="auth-screen">
      <main className="auth-card" aria-labelledby="local-title">
        <div className="auth-brand">
          <img className="auth-logo" src="/icons/icon-192.png" width={56} height={56} alt="" />
          <h1 id="local-title" className="auth-title">
            이 컴퓨터에서만 열 수 있어요
          </h1>
          <p className="auth-sub">
            easy-study 서버가 로컬 모드로 실행 중이라 이 주소(<code>{window.location.host}</code>)로는 열 수 없어요.
          </p>
        </div>
        <div className="auth-hint auth-hint-plain">
          <ul>
            <li>
              서버를 실행한 컴퓨터에서는 <code>http://127.0.0.1:{port}</code> 로 열 수 있어요.
            </li>
            <li>
              다른 컴퓨터에서도 쓰려면 서버를 원격 모드로 다시 실행하세요. 터미널에 접속 주소와 접속 코드가 표시돼요.
              <pre className="auth-cmd">EASY_STUDY_HOST=0.0.0.0 npm start</pre>
              <span className="muted small">Windows PowerShell:</span>
              <pre className="auth-cmd">$env:EASY_STUDY_HOST="0.0.0.0"; npm start</pre>
            </li>
            <li>
              <code>tailscale serve</code> 같은 프록시를 거친다면 <code>EASY_STUDY_AUTH=on</code> 을 붙여 실행하세요.
            </li>
          </ul>
          {message && <p className="muted small">서버 응답: {message}</p>}
        </div>
        <button type="button" className="primary-btn auth-submit" onClick={onRetry}>
          다시 확인
        </button>
      </main>
    </div>
  );
}
