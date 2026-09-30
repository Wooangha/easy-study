// Languages of the web client (DESIGN §27): the default (Korean outside a browser, else the browser's language), the
// stored setting, the header on API requests, and every English text against the Korean reference.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { LANG_HEADER } from '../../shared/i18n.ts';
import { hangulIn, shapeProblems } from '../../tests/i18nParity.ts';
import {
  annotationEventsUrl,
  courseSummaryUrl,
  digestMarkdownUrl,
  listDocs,
  notesMarkdownUrl,
  recordingEventsUrl,
  uploadAttachment,
} from '../src/api.ts';
import { en } from '../src/i18n/en/index.ts';
import { getLang, getLangPref, intlLocale, keepAnswer, msg, setLang, subscribeLang, systemLang } from '../src/i18n/index.ts';
import { ko } from '../src/i18n/ko/index.ts';
import { applyAuthStatus, resetAuthForTests } from '../src/lib/auth.ts';

describe('the language', () => {
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    setLang('system');
    delete g.window;
  });

  test('Korean outside a browser (the tests), whatever Node says its language is', () => {
    assert.equal(getLangPref(), 'system');
    assert.equal(getLang(), 'ko');
    assert.equal(msg(), ko);
    assert.equal(msg().shell.topBar.noDocs, '문서 없음');
  });

  test("the browser's language: 'ko*' is Korean, a supported one first, anything else English", () => {
    assert.equal(systemLang({ language: 'ko-KR', languages: ['ko-KR', 'en-US'] }), 'ko');
    assert.equal(systemLang({ language: 'en-GB', languages: ['en-GB'] }), 'en');
    assert.equal(systemLang({ language: 'ja', languages: ['ja'] }), 'en');
    assert.equal(systemLang({ language: 'fr', languages: ['fr', 'ko'] }), 'ko');
    assert.equal(systemLang(undefined), 'ko');
  });

  test('setLang: shown at once, stored like the other settings, listeners told; system removes the setting', () => {
    const items = new Map<string, string>();
    g.window = {
      localStorage: {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
        removeItem: (k: string) => void items.delete(k),
      },
    };
    let calls = 0;
    const off = subscribeLang(() => calls++);
    try {
      setLang('en');
      assert.equal(getLang(), 'en');
      assert.equal(msg().shell.topBar.noDocs, 'No documents');
      assert.equal(msg('ko').shell.topBar.noDocs, '문서 없음');
      assert.equal(intlLocale(), 'en-US');
      assert.equal(items.get('easy-study:lang'), '"en"');
      assert.equal(calls, 1);
      setLang('en');
      assert.equal(calls, 1, 'no change, no render');
      setLang('system');
      assert.equal(getLang(), 'ko', 'no navigator on the fake window');
      assert.equal(items.has('easy-study:lang'), false);
      assert.equal(calls, 2);
      setLang('fr' as never);
      assert.equal(getLang(), 'ko', 'an unknown language is ignored');
    } finally {
      off();
    }
  });
});

describe('API requests carry the language', () => {
  const realFetch = globalThis.fetch;
  const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  let seen: Array<string | null> = [];

  beforeEach(() => {
    resetAuthForTests();
    applyAuthStatus({ authRequired: false, authenticated: true });
    seen = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get(LANG_HEADER));
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = realXhr;
    setLang('system');
    resetAuthForTests();
  });

  test('fetch: X-Easy-Study-Lang of the current language', async () => {
    await listDocs();
    setLang('en');
    await listDocs();
    assert.deepEqual(seen, ['ko', 'en']);
  });

  test('keepAnswer: an answer made for a language no longer shown only fills an empty place', () => {
    assert.equal(keepAnswer('ko', { labels: 'ko' }), true);
    setLang('en');
    assert.equal(keepAnswer('ko', { labels: 'en' }), false);
    assert.equal(keepAnswer('ko', null), true);
    assert.equal(keepAnswer('en', { labels: 'ko' }), true);
  });

  test('plain links and EventSource URLs carry it as ?lang=, read when the URL is made', () => {
    assert.equal(notesMarkdownUrl('lec-1a'), '/api/docs/lec-1a/notes.md?lang=ko');
    setLang('en');
    assert.equal(notesMarkdownUrl('lec-1a'), '/api/docs/lec-1a/notes.md?lang=en');
    assert.equal(digestMarkdownUrl('lec-1a'), '/api/docs/lec-1a/digest.md?lang=en');
    assert.equal(courseSummaryUrl('crs-1'), '/api/courses/crs-1/summary.md?lang=en');
    assert.equal(recordingEventsUrl('lec-1a', 'rec-1', null), '/api/docs/lec-1a/recordings/rec-1/events?lang=en');
    assert.equal(recordingEventsUrl('lec-1a', 'rec-1', 7), '/api/docs/lec-1a/recordings/rec-1/events?since=7&lang=en');
    assert.equal(annotationEventsUrl('lec-1a'), '/api/docs/lec-1a/annotations/events?lang=en');
    assert.equal(annotationEventsUrl('lec-1a', 'tab 1'), '/api/docs/lec-1a/annotations/events?client=tab%201&lang=en');
  });

  test('uploads (XMLHttpRequest) too, with the error texts in the language', async () => {
    const headers: Record<string, string> = {};
    class FakeXhr {
      status = 0;
      responseText = '';
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader(name: string, value: string) {
        headers[name] = value;
      }
      send() {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
    setLang('en');
    await assert.rejects(uploadAttachment('lec-1a', new Blob([new Uint8Array(4)], { type: 'image/png' })), {
      message: 'A network error interrupted the upload',
    });
    assert.equal(headers[LANG_HEADER], 'en');
  });
});

describe('web messages: English against the Korean reference', () => {
  test('the same keys and kinds in every namespace, no empty texts', () => {
    assert.deepEqual(shapeProblems(ko, en), []);
  });

  test('no Korean left in the English texts (functions called with sample arguments, rich text included)', () => {
    assert.deepEqual(hangulIn(en), []);
  });

  test('the checks themselves catch a missing key and a Korean text', () => {
    assert.deepEqual(shapeProblems({ a: 'x', b: { c: (n: number) => `${n}` } }, { a: 'y', b: { c: 'z' }, d: '' }), [
      'b.c: string where the reference has function',
      'd: not in the reference',
    ]);
    assert.deepEqual(hangulIn({ a: 'fine', b: { c: (n: number) => `${n}개` } }), ['b.c(1): "1개"', 'b.c(2): "2개"', 'b.c("x"): "x개"', 'b.c(["a","b"]): "a,b개"']);
  });
});
