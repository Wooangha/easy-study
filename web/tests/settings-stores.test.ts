// The small shared stores behind 설정 (DESIGN §24): the ±N of the chat panel and the dialog (hooks/useNeighbors.ts),
// and the theme (lib/theme.ts: this browser's setting, or the desktop shell's). Each case loads its own copy of the
// module (a query on the URL) with a fake window, localStorage and document. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

type NeighborsModule = typeof import('../src/hooks/useNeighbors.ts');
type ThemeModule = typeof import('../src/lib/theme.ts');

let copies = 0;
/** A fresh instance of a module (its own module-level state; the modules it imports are shared). */
async function fresh<T>(relative: string): Promise<T> {
  return (await import(new URL(`${relative}?copy=${++copies}`, import.meta.url).href)) as T;
}

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

describe('±N (useNeighbors): one value for the chat panel and the settings dialog', () => {
  test('a change reaches every subscriber and is stored; invalid or unchanged values change nothing', async () => {
    const storage = fakeStorage();
    Object.assign(globalThis, { window: { localStorage: storage } });
    const n = await fresh<NeighborsModule>('../src/hooks/useNeighbors.ts');
    assert.equal(n.getNeighbors(), n.DEFAULT_NEIGHBORS);
    const chatPanel: number[] = [];
    const dialog: number[] = [];
    const offChat = n.subscribeNeighbors(() => chatPanel.push(n.getNeighbors()));
    const offDialog = n.subscribeNeighbors(() => dialog.push(n.getNeighbors()));
    n.setNeighbors(2);
    assert.deepEqual([chatPanel, dialog], [[2], [2]]);
    assert.equal(storage.items.get('easy-study:neighbors'), '2');
    n.setNeighbors(2);
    n.setNeighbors(7);
    n.setNeighbors(-1);
    assert.deepEqual([chatPanel, dialog], [[2], [2]]);
    offDialog();
    n.setNeighbors(0);
    assert.deepEqual([chatPanel, dialog], [[2, 0], [2]]);
    offChat();
  });

  test('starts from what is stored (a value of an older version is checked)', async () => {
    Object.assign(globalThis, { window: { localStorage: fakeStorage({ 'easy-study:neighbors': '3' }) } });
    assert.equal((await fresh<NeighborsModule>('../src/hooks/useNeighbors.ts')).getNeighbors(), 3);
    Object.assign(globalThis, { window: { localStorage: fakeStorage({ 'easy-study:neighbors': '9' }) } });
    const n = await fresh<NeighborsModule>('../src/hooks/useNeighbors.ts');
    assert.equal(n.getNeighbors(), n.DEFAULT_NEIGHBORS);
  });
});

describe('the theme store (lib/theme.ts)', () => {
  const ORIGIN = 'http://127.0.0.1:5351';

  /** theme.ts loaded as in a page (it starts itself when there is a window and a document). */
  async function page(options: { marker?: unknown; stored?: string } = {}) {
    const storage = fakeStorage(options.stored === undefined ? {} : { 'easy-study:theme': options.stored });
    const assigned: string[] = [];
    const win = Object.assign(new EventTarget(), {
      __EASY_STUDY_DESKTOP__: options.marker,
      localStorage: storage,
      location: { origin: ORIGIN, assign: (url: string) => void assigned.push(url) },
    });
    const attributes = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
      style: { colorScheme: '' },
    };
    Object.assign(globalThis, { window: win, document: { documentElement: root, querySelectorAll: () => [] } });
    const theme = await fresh<ThemeModule>('../src/lib/theme.ts');
    return { theme, win, storage, assigned, shown: () => attributes.get('data-theme') ?? 'system' };
  }

  const mac = { v: 1, version: '0.5.0', os: 'macos' };

  // Before any state push in this process (lib/desktop.ts keeps the last valid push for the page).
  test('a browser: this browser’s setting, applied at start, stored, never sent anywhere; other tabs follow', async () => {
    const p = await page({ stored: '"dark"' });
    assert.equal(p.theme.getThemePref(), 'dark');
    assert.equal(p.shown(), 'dark');
    p.theme.setThemePref('light');
    assert.equal(p.shown(), 'light');
    assert.equal(p.storage.items.get('easy-study:theme'), '"light"');
    p.theme.setThemePref('system');
    assert.equal(p.storage.items.has('easy-study:theme'), false, '시스템 설정 is no item');
    assert.deepEqual(p.assigned, []);
    // Another tab chose dark.
    p.storage.items.set('easy-study:theme', '"dark"');
    p.win.dispatchEvent(Object.assign(new Event('storage'), { key: 'easy-study:theme' }));
    assert.equal(p.theme.getThemePref(), 'dark');
  });

  test('the app on macOS / Windows starts from the window’s theme, not this origin’s copy', async () => {
    for (const os of ['macos', 'windows']) {
      const p = await page({ marker: { ...mac, os }, stored: '"dark"' });
      assert.equal(p.theme.getThemePref(), 'system', os);
    }
    // Linux: the WebView may not follow the shell, so the copy is used until the first push.
    const linux = await page({ marker: { ...mac, os: 'linux' }, stored: '"dark"' });
    assert.equal(linux.theme.getThemePref(), 'dark');
  });

  test('the app: a change asks the shell (theme/<v> on the page’s own origin)', async () => {
    const p = await page({ marker: mac });
    p.theme.setThemePref('dark');
    assert.equal(p.shown(), 'dark');
    assert.deepEqual(p.assigned, [`${ORIGIN}/__easy-study-desktop/theme/dark`]);
    p.theme.setThemePref('purple' as never);
    assert.equal(p.assigned.length, 1, 'an unknown value is not sent');
  });

  // Last: the push stays in lib/desktop.ts for the rest of this process.
  test('the app: every push is shown and copied to this origin (for theme-boot.js on Linux)', async () => {
    const p = await page({ marker: mac });
    const push = (theme: string) => {
      Object.assign(p.win, { __easyStudyDesktopState: { v: 1, theme, connection: null, update: null, justUpdated: null } });
      p.win.dispatchEvent(new Event('easy-study-desktop'));
    };
    push('light');
    assert.equal(p.theme.getThemePref(), 'light');
    assert.equal(p.shown(), 'light');
    assert.equal(p.storage.items.get('easy-study:theme'), '"light"');
    push('system');
    assert.equal(p.theme.getThemePref(), 'system');
    assert.equal(p.storage.items.has('easy-study:theme'), false);
    assert.deepEqual(p.assigned, [], 'a push is not sent back');
    // Another tab's storage event does not override the shell in the app.
    p.storage.items.set('easy-study:theme', '"dark"');
    p.win.dispatchEvent(Object.assign(new Event('storage'), { key: 'easy-study:theme' }));
    assert.equal(p.theme.getThemePref(), 'system');
  });
});
