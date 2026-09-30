// The web client's language inside the desktop app (DESIGN §27): 시스템 설정 follows the shell's language (the marker's
// `lang`, the OS's language as the app's menus and dialogs use it) rather than what the web view reports.
// Run: node --test web/tests/i18n-desktop.test.ts
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { getLang, setLang, systemLang } from '../src/i18n/index.ts';

describe('the language in the desktop app', () => {
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    delete g.window;
    setLang('system');
  });

  test("the shell's language wins over the web view's; an unknown or missing one is ignored", () => {
    const nav = { language: 'ja-JP', languages: ['ja-JP'] };
    assert.equal(systemLang(nav, 'ko'), 'ko');
    assert.equal(systemLang(nav, 'en'), 'en');
    assert.equal(systemLang({ language: 'ko-KR', languages: ['ko-KR'] }, 'en'), 'en');
    assert.equal(systemLang(nav, 'fr'), 'en', 'not a language of the app: the web view decides');
    assert.equal(systemLang(nav, undefined), 'en');
    assert.equal(systemLang(undefined, undefined), 'ko');
  });

  test('read from the marker the shell sets before any script', () => {
    const marker = { v: 1, version: '0.6.6', os: 'macos', lang: 'en' };
    g.window = { navigator: { language: 'ko-KR', languages: ['ko-KR'] }, __EASY_STUDY_DESKTOP__: marker };
    assert.equal(systemLang(), 'en');
    setLang('system');
    assert.equal(getLang(), 'en');
    g.window = { navigator: { language: 'ko-KR', languages: ['ko-KR'] }, __EASY_STUDY_DESKTOP__: { v: 1, version: '0.6.6', os: 'macos' } };
    assert.equal(systemLang(), 'ko', 'an older shell without lang: the web view decides');
    g.window = { navigator: { language: 'en-US', languages: ['en-US'] } };
    assert.equal(systemLang(), 'en', 'a browser: its language');
  });
});
