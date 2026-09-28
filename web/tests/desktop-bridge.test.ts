// The page inside the desktop app (DESIGN §24, web/src/lib/desktop.ts): the checks of what the shell pushes, the
// action URLs, the leave flag, and the wording before a change of server or an update. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  DESKTOP_ACTIONS,
  MAX_NOTES,
  NOT_BUSY,
  allowLeave,
  compareVersions,
  desktopAction,
  desktopActionUrl,
  downloadHint,
  downloadPercent,
  exposePageHook,
  getDesktopState,
  installBlockReason,
  installWarning,
  leaveAllowed,
  leaveConfirm,
  parseDesktopMarker,
  parseDesktopState,
  readPageBusy,
  settingsSection,
  TOASTED_UPDATE_ITEM,
  firstUpdatedToast,
  updateErrorText,
  updatePending,
  updateStatusLine,
  updatedToast,
  type DesktopActionName,
  type PageBusy,
  type UpdateState,
} from '../src/lib/desktop.ts';

const PUSH = {
  v: 1,
  theme: 'dark',
  connection: { kind: 'local', origin: 'http://127.0.0.1:5350', startup: 'auto' },
  update: {
    phase: 'available',
    current: '0.5.0',
    version: '0.5.1',
    notes: '녹음 탭이 빨라졌어요.',
    date: '2026-10-05T09:00:00Z',
    releaseUrl: 'https://github.com/Wooangha/easy-study-releases/releases/tag/v0.5.1',
    received: 0,
    install: 'inApp',
    kind: 'app',
    checkedAt: '2026-10-05T10:00:00Z',
    auto: true,
    dismissed: false,
  },
  justUpdated: null,
};

/** PUSH with `patch` applied to its update. */
const withUpdate = (patch: Record<string, unknown>) => ({ ...PUSH, update: { ...PUSH.update, ...patch } });

describe('parseDesktopState: what the shell pushes is checked', () => {
  test('a complete push', () => {
    const state = parseDesktopState(PUSH);
    assert.deepEqual(state, { ...PUSH, update: { ...PUSH.update } });
  });

  test('pages of other computers get fewer update fields; unknown fields of a newer shell are ignored', () => {
    const remote = {
      v: 1,
      theme: 'system',
      connection: { kind: 'remote', origin: 'http://192.0.2.10:5180', startup: 'ask' },
      update: { phase: 'downloading', current: '0.5.0', version: '0.5.1', received: 1024, total: 4096, install: 'inApp', dismissed: false },
      justUpdated: '0.5.0',
      somethingNew: { x: 1 },
    };
    const state = parseDesktopState(remote)!;
    assert.equal(state.update?.kind, undefined);
    assert.equal(state.update?.total, 4096);
    assert.equal(state.justUpdated, '0.5.0');
    assert.equal('somethingNew' in state, false);
    // Before the first check and without a connection yet.
    assert.deepEqual(parseDesktopState({ v: 1, theme: 'light' }), { v: 1, theme: 'light', connection: null, update: null, justUpdated: null });
  });

  test('the shell’s push before any check (serde of UpdateState: empty releaseUrl, kind and install "none")', () => {
    const state = parseDesktopState({
      v: 1,
      theme: 'system',
      connection: { kind: 'local', origin: 'http://127.0.0.1:5351', startup: 'ask' },
      update: { phase: 'idle', current: '0.5.0', releaseUrl: '', received: 0, install: 'none', kind: 'none', auto: true, dismissed: false },
      justUpdated: null,
    });
    assert.ok(state);
    assert.equal(state.update?.releaseUrl, undefined);
    assert.equal(state.update?.kind, 'none');
  });

  test('release notes are cut to MAX_NOTES', () => {
    const state = parseDesktopState(withUpdate({ notes: 'ㄱ'.repeat(MAX_NOTES + 500) }))!;
    assert.equal(state.update?.notes?.length, MAX_NOTES);
  });

  test('malformed pushes are refused as a whole', () => {
    const bad: Array<[string, unknown]> = [
      ['not an object', 'dark'],
      ['an array', [PUSH]],
      ['another version', { ...PUSH, v: 2 }],
      ['unknown theme', { ...PUSH, theme: 'blue' }],
      ['connection kind', { ...PUSH, connection: { ...PUSH.connection, kind: 'lan' } }],
      ['connection origin: script', { ...PUSH, connection: { ...PUSH.connection, origin: 'javascript:alert(1)' } }],
      ['connection origin: file', { ...PUSH, connection: { ...PUSH.connection, origin: 'file:///etc/passwd' } }],
      ['connection startup', { ...PUSH, connection: { ...PUSH.connection, startup: 'never' } }],
      ['update phase', withUpdate({ phase: 'done' })],
      ['update current', withUpdate({ current: '<img src=x>' })],
      ['update version', withUpdate({ version: 5 })],
      ['received negative', withUpdate({ received: -1 })],
      ['received text', withUpdate({ received: '5' })],
      ['total NaN', withUpdate({ total: Number.NaN })],
      ['release url: script', withUpdate({ releaseUrl: 'javascript:alert(1)' })],
      ['release url: plain http', withUpdate({ releaseUrl: 'http://example.com/' })],
      ['install mode', withUpdate({ install: 'silent' })],
      ['install kind', withUpdate({ kind: 'snap' })],
      ['dismissed', withUpdate({ dismissed: 'yes' })],
      ['auto', withUpdate({ auto: 1 })],
      ['error text', withUpdate({ error: { message: 'x' } })],
      ['update as an array', { ...PUSH, update: [] }],
      ['justUpdated', { ...PUSH, justUpdated: 5 }],
    ];
    for (const [what, value] of bad) assert.equal(parseDesktopState(value), null, what);
  });
});

describe('the state store', () => {
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    delete g.window;
  });

  test('keeps the last valid push when a malformed one follows; no window, no state', () => {
    assert.equal(getDesktopState(), null);
    const fakeWindow: Record<string, unknown> = { addEventListener() {}, removeEventListener() {} };
    g.window = fakeWindow;
    fakeWindow.__easyStudyDesktopState = PUSH;
    const first = getDesktopState();
    assert.equal(first?.theme, 'dark');
    assert.equal(getDesktopState(), first, 'the same object while nothing new was pushed');
    const warn = console.warn;
    console.warn = () => {};
    try {
      fakeWindow.__easyStudyDesktopState = { ...PUSH, theme: 'neon' };
      assert.equal(getDesktopState(), first);
    } finally {
      console.warn = warn;
    }
    fakeWindow.__easyStudyDesktopState = { ...PUSH, theme: 'light' };
    assert.equal(getDesktopState()?.theme, 'light');
  });

  test('page hooks: installed on window, removed only by their own removal; readPageBusy calls the hook', () => {
    const fakeWindow: Record<string, unknown> = {};
    g.window = fakeWindow;
    assert.equal(readPageBusy(), null, 'no app shown');
    const busy: PageBusy = { ...NOT_BUSY, answering: true };
    const remove = exposePageHook('__easyStudyBusy', () => busy);
    assert.deepEqual(readPageBusy(), busy);
    const newer = () => NOT_BUSY;
    const removeNewer = exposePageHook('__easyStudyBusy', newer);
    remove(); // the older removal leaves the newer hook
    assert.equal(fakeWindow.__easyStudyBusy, newer);
    removeNewer();
    assert.equal('__easyStudyBusy' in fakeWindow, false);
    exposePageHook('__easyStudyBusy', () => {
      throw new Error('broken');
    });
    assert.equal(readPageBusy(), null);
  });
});

describe('parseDesktopMarker', () => {
  test('v1 with a version and a known OS; anything else is "not in the app"', () => {
    assert.deepEqual(parseDesktopMarker({ v: 1, version: '0.5.0', os: 'macos' }), { v: 1, version: '0.5.0', os: 'macos' });
    assert.deepEqual(parseDesktopMarker({ v: 1, version: '0.5.0-e2e.1', os: 'linux' })?.version, '0.5.0-e2e.1');
    for (const bad of [undefined, null, true, { v: 2, version: '0.5.0', os: 'macos' }, { v: 1, version: '', os: 'macos' }, { v: 1, version: '0.5 0', os: 'macos' }, { v: 1, version: '0.5.0', os: 'android' }]) {
      assert.equal(parseDesktopMarker(bad), null, JSON.stringify(bad));
    }
  });
});

describe('actions: a navigation to the reserved path of the page’s own origin', () => {
  test('URLs of every action; unknown ones throw', () => {
    assert.equal(desktopActionUrl('http://127.0.0.1:5350', 'choose'), 'http://127.0.0.1:5350/__easy-study-desktop/choose');
    assert.equal(desktopActionUrl('https://my-mac.tail1234.ts.net', 'theme/dark'), 'https://my-mac.tail1234.ts.net/__easy-study-desktop/theme/dark');
    for (const action of ['choose', 'forget-choice', 'check-update', 'install-update', 'dismiss-update', 'theme/system', 'theme/light', 'theme/dark']) {
      assert.ok((DESKTOP_ACTIONS as readonly string[]).includes(action), `${action} (the shared contract)`);
    }
    for (const action of DESKTOP_ACTIONS) assert.match(desktopActionUrl('http://127.0.0.1:5350', action), /^http:\/\/127\.0\.0\.1:5350\/__easy-study-desktop\/[a-z-]+(\/[a-z]+)?$/);
    for (const bad of ['../choose', 'install-update?now=1', 'theme/blue', '', 'CHOOSE']) {
      assert.throws(() => desktopActionUrl('http://127.0.0.1:5350', bad as DesktopActionName), /unknown desktop action/, bad);
    }
  });

  test('desktopAction navigates and lets that navigation pass the beforeunload guard for a moment', () => {
    const assigned: string[] = [];
    const now = Date.now();
    desktopAction('forget-choice', { origin: 'http://127.0.0.1:5351', assign: (url: string | URL) => assigned.push(String(url)) });
    assert.deepEqual(assigned, ['http://127.0.0.1:5351/__easy-study-desktop/forget-choice']);
    assert.equal(leaveAllowed(now + 500), true);
    assert.equal(leaveAllowed(now + 5_000), false);
  });

  test('allowLeave (the shell’s hook) extends, never shortens', () => {
    const t = Date.now() + 60_000; // after anything an earlier test allowed
    allowLeave(3_000, t);
    allowLeave(100, t);
    assert.equal(leaveAllowed(t + 2_000), true);
    assert.equal(leaveAllowed(t + 3_001), false);
  });

  test('settings sections the shell or a link may name', () => {
    assert.equal(settingsSection('desktop'), 'desktop');
    assert.equal(settingsSection('update'), 'desktop');
    assert.equal(settingsSection('theme'), 'display');
    assert.equal(settingsSection(undefined), null);
    assert.equal(settingsSection('__proto__'), null);
    assert.equal(settingsSection(3), null);
  });
});

describe('before leaving or restarting', () => {
  const busy = (patch: Partial<PageBusy>): PageBusy => ({ ...NOT_BUSY, ...patch });

  test('연결 대상 바꾸기: asks only when something would be lost, recording first', () => {
    assert.equal(leaveConfirm(null), null, 'an old page that does not answer');
    assert.equal(leaveConfirm(NOT_BUSY), null);
    const recording = leaveConfirm(busy({ recording: true, answering: true }))!;
    assert.equal(recording.title, '연결 대상을 바꿀까요?');
    assert.equal(recording.confirmLabel, '바꾸기');
    assert.match(recording.message!, /^강의를 녹음하는 중이에요/);
    assert.match(leaveConfirm(busy({ unsentSeconds: 3 }))!.message!, /녹음한 소리를/);
    assert.match(leaveConfirm(busy({ finishing: 1 }))!.message!, /녹음한 소리를/);
    for (const other of [{ answering: true }, { uploads: 1 }, { recordingUploads: 1 }]) {
      assert.match(leaveConfirm(busy(other))!.message!, /답변을 만들거나 파일을 올리는 중이에요/);
    }
  });

  test('업데이트: blocked while audio could be cut off, asked for answers and uploads', () => {
    assert.equal(installBlockReason(NOT_BUSY), null);
    assert.equal(installWarning(NOT_BUSY), null);
    assert.match(installBlockReason(busy({ recording: true }))!, /녹음 중에는 설치할 수 없어요/);
    assert.ok(installBlockReason(busy({ unsentSeconds: 1 })));
    assert.ok(installBlockReason(busy({ finishing: 1 })));
    assert.ok(installBlockReason(busy({ recordingUploads: 1 })));
    assert.equal(installBlockReason(busy({ answering: true, uploads: 2 })), null);
    assert.match(installWarning(busy({ answering: true }))!, /그래도 설치할까요/);
    assert.ok(installWarning(busy({ uploads: 1 })));
  });
});

describe('update wording', () => {
  const update = (patch: Partial<UpdateState>): UpdateState => ({
    phase: 'idle',
    current: '0.5.0',
    received: 0,
    install: 'inApp',
    dismissed: false,
    ...patch,
  });

  test('versions compare like semver (pre-releases below their release)', () => {
    const sorted = ['0.4.2', '0.5.0-e2e.1', '0.5.0-e2e.2', '0.5.0-e2e.10', '0.5.0', '0.5.1', '0.10.0', '1.0.0'];
    const shuffled = [...sorted].reverse();
    assert.deepEqual(shuffled.sort(compareVersions), sorted);
    assert.equal(compareVersions('v0.5.0', '0.5.0'), 0);
    assert.equal(compareVersions('0.5', '0.5.0'), 0);
    assert.ok(compareVersions('0.5.0-alpha', '0.5.0-1') > 0, 'words above numbers');
  });

  test('status line of each phase', () => {
    assert.equal(updateStatusLine(update({ phase: 'latest' })), '최신 버전이에요');
    assert.equal(updateStatusLine(update({ phase: 'checking' })), '확인하는 중…');
    assert.equal(updateStatusLine(update({ phase: 'available', version: '0.5.1' })), 'easy-study 0.5.1 버전이 나왔어요');
    assert.equal(updateStatusLine(update({ phase: 'downloading', version: '0.5.1', received: 50, total: 200 })), '내려받는 중… 25%');
    assert.equal(updateStatusLine(update({ phase: 'downloading', received: 50 })), '내려받는 중…');
    assert.equal(updateStatusLine(update({ phase: 'error', error: '업데이트 서버에 연결하지 못했어요.' })), '업데이트하지 못했어요: 업데이트 서버에 연결하지 못했어요.');
    // The shell's texts that are whole sentences themselves get no prefix (an update that did not take, MSG_OTHER).
    const stuck = '업데이트가 끝나지 않았어요 (지금 0.5.0). 다운로드 페이지에서 직접 설치해 주세요.';
    assert.equal(updateStatusLine(update({ phase: 'error', error: stuck })), stuck);
    assert.equal(updateErrorText(update({ phase: 'error', error: '업데이트하지 못했어요. 잠시 뒤 다시 시도해 주세요.' })), '업데이트하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    assert.equal(updateErrorText(update({ phase: 'error' })), '업데이트하지 못했어요: 알 수 없는 오류');
    assert.equal(updateStatusLine(update({ lastError: '업데이트 서버에 연결하지 못했어요.' })), '마지막 확인 실패: 업데이트 서버에 연결하지 못했어요.');
    assert.equal(updateStatusLine(update({})), '아직 확인하지 않았어요');
  });

  test('download percentage, the ⚙ dot, the download-page hint, the toast', () => {
    assert.equal(downloadPercent(update({ received: 999, total: 1000 })), 99);
    assert.equal(downloadPercent(update({ received: 2000, total: 1000 })), 100);
    assert.equal(downloadPercent(update({ received: 10 })), null);
    assert.equal(updatePending(null), false);
    assert.equal(updatePending(update({ phase: 'available' })), true);
    assert.equal(updatePending(update({ phase: 'downloaded' })), true);
    assert.equal(updatePending(update({ phase: 'latest' })), false);
    assert.match(downloadHint(update({ install: 'download', kind: 'deb' })), /\(deb\)/);
    assert.match(downloadHint(update({ install: 'download', kind: 'arch' })), /Arch.*makepkg -si/);
    assert.equal(downloadHint(update({ install: 'download', kind: 'app', reason: '앱을 옮겨 주세요.' })), '앱을 옮겨 주세요.');
    assert.equal(updatedToast('0.5.1', 'windows'), 'easy-study 0.5.1 버전으로 업데이트했어요.');
    assert.match(updatedToast('0.5.1', 'macos'), /마이크/);
  });

  test('the "updated" toast: once per version and tab, across reloads (the shell pushes it for its whole launch)', () => {
    const items = new Map<string, string>();
    const tab = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
    assert.equal(firstUpdatedToast('0.5.1', tab), true);
    assert.equal(items.get(TOASTED_UPDATE_ITEM), '0.5.1');
    // The second page load of the same launch, a reload, a second push: no second toast.
    assert.equal(firstUpdatedToast('0.5.1', tab), false);
    assert.equal(firstUpdatedToast('0.5.1', tab), false);
    // The next update in the same tab.
    assert.equal(firstUpdatedToast('0.5.2', tab), true);
    // Without sessionStorage (it throws, or there is none): remembered in memory for the page.
    const broken = {
      getItem: (): string | null => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    assert.equal(firstUpdatedToast('0.5.3', broken), true);
    assert.equal(firstUpdatedToast('0.5.3', broken), false);
    assert.equal(firstUpdatedToast('0.5.3', null), false);
  });
});
