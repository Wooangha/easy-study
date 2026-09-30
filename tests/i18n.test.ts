// Languages of the server's texts (DESIGN §27): the request's language (X-Easy-Study-Lang, Accept-Language, Korean),
// kept through the async work of a request, and every English text against the Korean reference.
// Run: node --test tests/i18n.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { LANG_HEADER, acceptLanguageTags, langOfTag, pickLang } from '../shared/i18n.ts';
import { requestLang, runInLang, slang, smsg } from '../server/i18n.ts';
import { createApiRouter } from '../server/index.ts';
import { en } from '../server/messages/en/index.ts';
import { ko } from '../server/messages/ko/index.ts';
import { hangulIn, shapeProblems } from './i18nParity.ts';

describe('shared: language tags', () => {
  test('langOfTag: the primary subtag of a supported language', () => {
    assert.equal(langOfTag('ko'), 'ko');
    assert.equal(langOfTag('ko-KR'), 'ko');
    assert.equal(langOfTag('EN_us.UTF-8'), 'en');
    assert.equal(langOfTag('ja-JP'), null);
    assert.equal(langOfTag(''), null);
  });

  test('Accept-Language: by quality, ties in order, q=0 dropped', () => {
    assert.deepEqual(acceptLanguageTags('ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'), ['ko-KR', 'ko', 'en-US', 'en']);
    assert.deepEqual(acceptLanguageTags('en;q=0.5, fr, ko;q=0'), ['fr', 'en']);
    assert.deepEqual(acceptLanguageTags(undefined), []);
  });

  test('pickLang: the first supported language; English for unsupported ones; null without a real tag', () => {
    assert.equal(pickLang(['fr', 'ko', 'en']), 'ko');
    assert.equal(pickLang(['ja']), 'en');
    assert.equal(pickLang(['*']), null);
    assert.equal(pickLang([]), null);
  });
});

describe('server: the language of a request', () => {
  const req = (headers: Record<string, string>) => ({
    get: (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1],
  });

  test('X-Easy-Study-Lang, then Accept-Language, then Korean', () => {
    assert.equal(requestLang(req({ [LANG_HEADER]: 'en', 'Accept-Language': 'ko' })), 'en');
    assert.equal(requestLang(req({ [LANG_HEADER]: 'xx', 'Accept-Language': 'ko-KR,en;q=0.5' })), 'ko');
    assert.equal(requestLang(req({ 'Accept-Language': 'ja' })), 'en');
    assert.equal(requestLang(req({ 'Accept-Language': '*' })), 'ko', "Node's fetch sends '*'");
    assert.equal(requestLang(req({})), 'ko');
  });

  test('?lang= (plain links, EventSource): after the header, before Accept-Language', () => {
    const withQuery = (headers: Record<string, string>, query: unknown) => ({ ...req(headers), query });
    assert.equal(requestLang(withQuery({ 'Accept-Language': 'ko-KR' }, { lang: 'en' })), 'en');
    assert.equal(requestLang(withQuery({ [LANG_HEADER]: 'ko' }, { lang: 'en' })), 'ko');
    assert.equal(requestLang(withQuery({ 'Accept-Language': 'en' }, { lang: 'fr' })), 'en');
    assert.equal(requestLang(withQuery({ 'Accept-Language': 'en' }, { lang: ['ko', 'en'] })), 'en', 'only a single value');
    assert.equal(requestLang(withQuery({}, undefined)), 'ko');
  });

  test('Korean outside a request; runInLang for the work it starts, awaits included', async () => {
    assert.equal(slang(), 'ko');
    assert.equal(smsg(), ko);
    const seen = await runInLang('en', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return [slang(), smsg().common.notFound.doc];
    });
    assert.deepEqual(seen, ['en', 'Document not found']);
    assert.equal(slang(), 'ko');
  });
});

describe('server: API errors in the request language', () => {
  let tmp = '';
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-i18n-'));
    process.env.EASY_STUDY_LIBRARY = tmp;
    const app = express();
    app.use('/api', createApiRouter());
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const errorOf = async (method: string, p: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, error: ((await res.json()) as { error: string }).error };
  };

  test('Korean by default, English when asked (header or Accept-Language), also after a queued mutation', async () => {
    assert.deepEqual(await errorOf('POST', '/courses', { title: ' ' }), { status: 400, error: '과목 이름을 입력해 주세요' });
    assert.deepEqual(await errorOf('POST', '/courses', { title: ' ' }, { [LANG_HEADER]: 'en' }), {
      status: 400,
      error: 'Enter a course name',
    });
    assert.deepEqual(await errorOf('POST', '/courses', { title: ' ' }, { 'Accept-Language': 'en-US,en;q=0.9' }), {
      status: 400,
      error: 'Enter a course name',
    });
    assert.deepEqual(await errorOf('PATCH', '/courses/missing-000000', { title: 'x' }, { [LANG_HEADER]: 'en' }), {
      status: 404,
      error: 'Course not found',
    });
    assert.deepEqual(await errorOf('PATCH', '/courses/missing-000000', { title: 'x' }), { status: 404, error: '과목을 찾을 수 없습니다' });
  });
});

describe('server messages: English against the Korean reference', () => {
  test('the same keys and kinds in every namespace, no empty texts', () => {
    assert.deepEqual(shapeProblems(ko, en), []);
  });

  test('no Korean left in the English texts', () => {
    assert.deepEqual(hangulIn(en), []);
  });
});
