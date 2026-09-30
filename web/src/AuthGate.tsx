// Startup login check and the switch between the login screen and the app (DESIGN §16).
import { useCallback, useEffect } from 'react';
import { App } from './App.tsx';
import { errorMessage, getAuthStatus, logout } from './api.ts';
import { LocalOnlyScreen } from './components/LocalOnlyScreen.tsx';
import { LoginScreen } from './components/LoginScreen.tsx';
import { useAuth } from './hooks/useAuth.ts';
import { msg, useLang } from './i18n/index.ts';
import { applyAuthStatus, getAuthSnapshot, markLoggedOut, markStatusUnknown, type LoginLinkResult } from './lib/auth.ts';
import { toast } from './lib/toast.ts';

/** GET /api/auth/status; `loginLink`: the page was opened by a login link that did not work. */
async function checkAuth(loginLink: LoginLinkResult): Promise<void> {
  try {
    const status = await getAuthStatus();
    applyAuthStatus(status, loginLink);
    if (loginLink === 'failed' && getAuthSnapshot().phase === 'ok') {
      toast(msg().shell.auth.linkAlreadyLoggedIn, 'info');
    }
  } catch {
    // 403 (local-only) already switched the phase; otherwise the app starts and shows its own
    // "cannot connect" banner, and a later 401 brings the login screen.
    markStatusUnknown();
  }
}

export function AuthGate({ loginLink }: { loginLink: LoginLinkResult }) {
  const auth = useAuth();
  // A change of language re-renders everything below (the texts come from msg() in render, DESIGN §27): the app stays
  // mounted, so nothing typed, playing or recording is lost.
  useLang();

  useEffect(() => {
    void checkAuth(loginLink);
  }, [loginLink]);

  const onLogout = useCallback(async () => {
    try {
      await logout();
      markLoggedOut();
    } catch (e) {
      toast(msg().shell.auth.logoutFailed(errorMessage(e)), 'error');
    }
  }, []);

  if (auth.phase === 'checking') return <div className="auth-splash" aria-busy="true" />;
  if (auth.phase === 'local') {
    return <LocalOnlyScreen message={auth.message} onRetry={() => void checkAuth(null)} />;
  }

  // The session ended while the app was in use: keep the app (open document, slide, session, drafts)
  // mounted under the login screen; its requests wait for the login and then continue.
  const keepApp = auth.phase === 'ok' || auth.overApp;
  const needsLogin = auth.phase === 'login';
  return (
    <>
      {keepApp && <App suspended={needsLogin} authRequired={auth.authRequired} onLogout={onLogout} />}
      {needsLogin && <LoginScreen key={auth.reason ?? ''} reason={auth.reason} overlay={keepApp} />}
    </>
  );
}
