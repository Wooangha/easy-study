// The desktop app's start page (DESIGN §19). Talks to the shell (src-tauri/src/main.rs) through Tauri's IPC,
// which only this bundled page may use: get_state, connect_local, connect_remote, pick_library, set_library,
// open_library. Everything it shows comes from get_state (never from the address), so a page that links here
// cannot put text on it.
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

async function refresh({ initial = false } = {}) {
  const st = await invoke('get_state');
  renderLibrary(st.library);
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

showOptionBodies();
refresh({ initial: true }).catch(fail);
