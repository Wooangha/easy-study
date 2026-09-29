// The desktop app's start page (DESIGN §19). Talks to the shell (src-tauri/src/main.rs) through Tauri's IPC,
// which only this bundled page may use: get_state, connect_local, connect_remote, pick_library, set_library,
// open_library, and for "⚙ 앱 설정" (DESIGN §24) check_update, install_update, cancel_update, set_theme,
// set_update_check, forget_choice, open_logs, set_share, reset_share_code. Everything it shows comes from get_state
// (never from the address), so a page that links here cannot put text on it.
'use strict';

const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const $ = (id) => document.getElementById(id);
const form = $('form');
let polling = null;
let pendingLibrary = null;

function mode() {
  return new FormData(form).get('mode');
}

function setMode(value) {
  const input = form.querySelector(`input[name=mode][value=${value}]`);
  if (input) input.checked = true;
  showOptionBodies();
}

/** Only the chosen option shows its fields. */
function showOptionBodies() {
  for (const option of form.querySelectorAll('.option')) {
    option.querySelector('[data-body]').hidden = option.dataset.mode !== mode();
  }
}

function setBusy(busy) {
  for (const el of form.querySelectorAll('input, button')) el.disabled = busy;
}

/** kind: 'info' | 'busy' | 'error'. tail: the server's last stderr lines (shown for errors). */
function showStatus(text, kind = 'info', tail = [], logFile = '') {
  const box = $('status');
  if (!text) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = `status ${kind}`;
  $('status-text').textContent = text;
  if (kind === 'error') box.scrollIntoView({ block: 'nearest' });
  const showLog = kind === 'error' && tail.length > 0;
  $('log').hidden = !showLog;
  if (showLog) {
    $('log-tail').textContent = tail.join('\n');
    $('log-file').textContent = logFile;
    $('log').open = true;
  }
}

function renderLibrary(lib) {
  $('library-path').textContent = lib.path;
  $('default-library').hidden = lib.isDefault || lib.fromEnv;
  $('pick-library').disabled = lib.fromEnv;
  $('library-note').textContent = lib.fromEnv
    ? 'EASY_STUDY_DESKTOP_LIBRARY 환경 변수로 지정된 폴더예요.'
    : lib.isDefault
      ? '기본 위치예요. 저장소의 library/ 같은 기존 폴더를 쓰려면 "라이브러리 폴더 선택…"을 누르세요.'
      : '직접 고른 폴더예요. 같은 폴더를 npm start로 실행 중인 서버와 함께 쓸 수는 없어요.';
}

/** The theme's tokens (chooser.css): the shell also sets the app-wide theme, which drives prefers-color-scheme. */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

/** An update is on its way (its buttons wait). */
const moving = (u) => u.phase === 'checking' || u.phase === 'downloading' || u.phase === 'installing';

function percent(u) {
  if (u.total) return `${Math.min(100, Math.floor((u.received / u.total) * 100))}%`;
  return `${(u.received / 1048576).toFixed(0)} MB`;
}

/** "업데이트하지 못했어요: …", unless the shell's text says so itself (update.rs says_update_failed). */
const errorText = (u) => (/^업데이트(가|하지) /.test(u.error ?? '') ? u.error : `업데이트하지 못했어요: ${u.error ?? ''}`);

/** The update's line in "⚙ 앱 설정". */
function updateText(u) {
  switch (u.phase) {
    case 'checking':
      return '확인하는 중…';
    case 'latest':
      return '최신 버전이에요';
    case 'available':
      return `easy-study ${u.version} 버전이 나왔어요`;
    case 'downloading':
      return `내려받는 중… ${percent(u)}`;
    case 'downloaded':
      return `easy-study ${u.version} 버전을 받아 두었어요`;
    case 'installing':
      return '설치하는 중…';
    case 'error':
      return u.error ?? '업데이트하지 못했어요';
    default:
      return u.lastError ? `마지막 확인 실패: ${u.lastError}` : '아직 확인하지 않았어요';
  }
}

function renderUpdate(st) {
  const u = st.update;
  const found = Boolean(u.version) && ['available', 'downloaded', 'error'].includes(u.phase);
  const busy = Boolean(st.busy) || moving(u);
  $('app-version').textContent = `버전 ${st.version}`;
  $('update-status').textContent = updateText(u);
  $('update-reason').hidden = !(found && u.install === 'download' && u.reason);
  $('update-reason').textContent = u.reason ?? '';
  $('update-progress').hidden = u.phase !== 'downloading';
  if (u.phase === 'downloading') {
    if (u.total) $('update-progress').value = u.received / u.total;
    else $('update-progress').removeAttribute('value');
  }
  $('update-check').hidden = u.phase === 'downloading' || u.phase === 'installing';
  $('update-check').disabled = busy;
  $('update-install').hidden = !(found && u.install === 'inApp');
  $('update-install').disabled = busy;
  // Also after an update that did not take (phase error, install download: "다운로드 페이지에서 직접 설치해 주세요").
  $('update-download').hidden = !((found || u.phase === 'error') && u.install === 'download');
  $('update-cancel').hidden = u.phase !== 'downloading';
  $('update-auto').checked = st.updateCheck;

  // The line at the top: a found version (or what went wrong with it), whatever section is open.
  const note = $('update-note');
  note.hidden = !(u.version && ['available', 'downloading', 'downloaded', 'error'].includes(u.phase));
  if (!note.hidden) {
    note.classList.toggle('error', u.phase === 'error');
    $('update-note-text').textContent =
      u.phase === 'error'
        ? errorText(u)
        : u.phase === 'downloading'
          ? `easy-study ${u.version} 버전을 내려받는 중… ${percent(u)}`
          : `easy-study ${u.version} 버전이 나왔어요 (지금 ${u.current}).`;
    const action = $('update-note-action');
    action.hidden = u.phase === 'downloading';
    action.disabled = busy;
    action.textContent = u.install === 'inApp' ? (u.phase === 'error' ? '다시 시도' : '설치하고 다시 시작') : '다운로드 페이지 열기 ↗';
  }
}

/** Copies `text` (the clipboard API, or the old command when the page cannot use it) and says so on `button`. */
function copyText(text, button) {
  const fallback = () => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  };
  const done = () => {
    const label = button.textContent;
    button.textContent = '복사됨';
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  };
  const clipboard = navigator.clipboard?.writeText(text);
  if (clipboard) clipboard.then(done, () => (fallback(), done()));
  else (fallback(), done());
}

/** "다른 기기에서 접속": the switch, and while the local server runs shared, its addresses and access code. */
function renderShare(st) {
  $('share').checked = st.share;
  $('share').disabled = Boolean(st.busy);
  $('share-off').hidden = st.share;
  $('share-idle').hidden = !(st.share && !st.shareRunning);
  $('share-info').hidden = !st.shareRunning;
  if (!st.shareRunning) return;
  const list = $('share-urls');
  const urls = st.shareUrls ?? [];
  if (list.dataset.urls !== urls.join(' ')) {
    list.dataset.urls = urls.join(' ');
    list.replaceChildren(
      ...urls.map((url) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.className = 'path inline';
        code.textContent = url;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'link copy';
        copy.textContent = '복사';
        copy.addEventListener('click', () => copyText(url, copy));
        li.append(code, copy);
        return li;
      }),
    );
  }
  $('share-no-urls').hidden = urls.length > 0;
  $('share-code').textContent = st.shareCode ?? '(코드를 읽지 못했어요)';
  $('share-copy').hidden = !st.shareCode;
  $('share-reset').disabled = Boolean(st.busy);
}

function renderSettings(st) {
  applyTheme(st.theme);
  for (const input of document.querySelectorAll('input[name=theme]')) input.checked = input.value === st.theme;
  renderUpdate(st);
  renderShare(st);
  const startup =
    st.mode === 'local'
      ? '시작하면 ‘이 컴퓨터에서 실행’에 바로 연결해요.'
      : st.mode === 'remote'
        ? `시작하면 ‘${st.remoteUrl ?? ''}’에 바로 연결해요.`
        : '시작하면 이 화면이 먼저 나와요. 바로 연결하려면 ‘다음에도 바로 연결’을 켜고 연결하세요.';
  $('startup-text').textContent = startup;
  $('forget-choice').hidden = st.mode === '';
  $('previous').hidden = !st.previous;
  $('previous').textContent = st.previous ? `방금까지 연결: ${st.previous}` : '';
  if (st.focus === 'settings') {
    $('settings').open = true;
    $('settings').scrollIntoView({ block: 'nearest' });
  }
}

async function refresh({ initial = false } = {}) {
  const st = await invoke('get_state');
  renderLibrary(st.library);
  renderSettings(st);
  $('shortcut').textContent = st.shortcut;
  if (initial) {
    if (st.mode === 'remote' || (!st.mode && st.remoteUrl && !st.running)) setMode('remote');
    $('url').value = st.remoteUrl ?? '';
    $('remember').checked = st.mode !== '' || !st.configured;
  }
  if (st.busy) {
    setBusy(true);
    showStatus(st.busy, 'busy');
    startPolling();
  } else {
    stopPolling();
    setBusy(false);
    if (st.error) showStatus(st.error, 'error', st.stderrTail, st.logFile);
    else if (st.running) showStatus('이 컴퓨터의 서버가 실행 중이에요. "연결"을 누르면 돌아가요.', 'info');
    else if (initial && st.notice) showStatus(st.notice, 'info');
    else if (!initial) showStatus('');
  }
  return st;
}

function startPolling() {
  polling ??= setInterval(() => refresh().catch(fail), 400);
}

function stopPolling() {
  if (polling) clearInterval(polling);
  polling = null;
}

function fail(err) {
  setBusy(false);
  stopPolling();
  showStatus(String(err?.message ?? err), 'error');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const remember = $('remember').checked;
  try {
    if (mode() === 'local') {
      setBusy(true);
      showStatus('이 컴퓨터에서 easy-study 서버를 시작하는 중…', 'busy');
      await invoke('connect_local', { remember });
      await refresh();
    } else {
      const url = $('url').value.trim();
      if (!url) {
        showStatus('연결할 컴퓨터의 주소를 입력하세요 (예: http://192.168.0.10:5180).', 'error');
        $('url').focus();
        return;
      }
      setBusy(true);
      showStatus('연결할 수 있는지 확인하는 중…', 'busy');
      await invoke('connect_remote', { url, code: $('code').value.trim() || null, remember });
      showStatus('연결하는 중…', 'busy'); // the shell navigates this window to the server
    }
  } catch (err) {
    fail(err);
  }
});

for (const input of form.querySelectorAll('input[name=mode]')) {
  input.addEventListener('change', () => {
    showOptionBodies();
    if (mode() === 'remote') $('url').focus();
  });
}

$('pick-library').addEventListener('click', async () => {
  setMode('local');
  try {
    const picked = await invoke('pick_library');
    if (!picked) return;
    if (picked.warning) {
      pendingLibrary = picked.path;
      $('library-confirm-text').textContent = picked.warning;
      $('library-confirm').hidden = false;
      $('library-confirm-no').focus();
      return;
    }
    await useLibrary(picked.path);
  } catch (err) {
    fail(err);
  }
});

async function useLibrary(path) {
  $('library-confirm').hidden = true;
  pendingLibrary = null;
  const result = await invoke('set_library', { path });
  renderLibrary(result.library);
  showStatus(result.message ?? '', 'info');
}

$('library-confirm-yes').addEventListener('click', () => useLibrary(pendingLibrary).catch(fail));
$('library-confirm-no').addEventListener('click', () => {
  $('library-confirm').hidden = true;
  pendingLibrary = null;
  $('pick-library').focus();
});
$('default-library').addEventListener('click', () => useLibrary(null).catch(fail));
$('open-library').addEventListener('click', () => invoke('open_library').catch(fail));

// "⚙ 앱 설정". The shell does the work on its own threads; the page polls get_state meanwhile.
for (const input of document.querySelectorAll('input[name=theme]')) {
  input.addEventListener('change', () => {
    applyTheme(input.value);
    invoke('set_theme', { theme: input.value }).then(() => refresh(), fail);
  });
}
async function updateAction(cmd) {
  await invoke(cmd);
  await refresh();
}
$('update-check').addEventListener('click', () => updateAction('check_update').catch(fail));
$('update-install').addEventListener('click', () => updateAction('install_update').catch(fail));
$('update-download').addEventListener('click', () => updateAction('install_update').catch(fail));
$('update-note-action').addEventListener('click', () => updateAction('install_update').catch(fail));
$('update-cancel').addEventListener('click', () => updateAction('cancel_update').catch(fail));
$('update-auto').addEventListener('change', () => {
  invoke('set_update_check', { on: $('update-auto').checked }).then(() => refresh(), fail);
});
// Sharing: the shell asks (busy check, a dialog) and restarts the server on its own thread; the busy line shows up
// through polling, and the box follows the setting the shell keeps.
$('share').addEventListener('change', () => {
  // A moment for the shell to write the setting (no server running) or to put up its busy line: the box would
  // otherwise snap back to the old value for one poll.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
  invoke('set_share', { on: $('share').checked }).then(settle).then(() => refresh(), fail);
});
$('share-copy').addEventListener('click', () => copyText($('share-code').textContent, $('share-copy')));
$('share-reset').addEventListener('click', () => invoke('reset_share_code').then(() => refresh(), fail));
$('forget-choice').addEventListener('click', async () => {
  try {
    await invoke('forget_choice');
    $('remember').checked = false;
    await refresh();
  } catch (err) {
    fail(err);
  }
});
$('open-logs').addEventListener('click', () => invoke('open_logs').catch(fail));

// The update section follows the shell: checks and installs run on its threads, maybe behind one of its dialogs.
// Only that section is redrawn (the status line keeps what the last action said); an install's busy line takes over.
setInterval(() => {
  if (document.hidden || polling) return;
  invoke('get_state')
    .then((st) => (st.busy ? refresh() : renderSettings(st)))
    .catch(() => {});
}, 1000);

showOptionBodies();
refresh({ initial: true }).catch(fail);
