import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './AuthGate.tsx';
import { takeLoginLinkParam } from './lib/auth.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

// A login link (/login?code=…) that did not work redirects to /?login=failed or /?login=limited
// (DESIGN §16): remember it for the login screen and clean the address bar.
const { result: loginLink, cleanUrl } = takeLoginLinkParam(window.location.href);
if (cleanUrl !== null) window.history.replaceState(window.history.state, '', cleanUrl);

createRoot(root).render(
  <StrictMode>
    <AuthGate loginLink={loginLink} />
  </StrictMode>,
);
