// The 메모 tab (DESIGN §25): search over text and tags, the tag and slide filters, tag counts, the two lines.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MemoSummary } from '../../shared/types.ts';
import { EMPTY_MEMO_FILTER, filterMemos, memoLines, memoTagCounts } from '../src/lib/annotations/memoList.ts';

const memo = (id: string, slide: number, text: string, tags: string[] = []): MemoSummary => ({
  id,
  slide,
  color: 'yellow',
  text,
  tags,
  tutor: true,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  links: [],
});

const memos = [
  memo('an-000000000001', 2, 'LL(1) 파싱 테이블\n첫째 줄 아래', ['시험', '파싱']),
  memo('an-000000000002', 2, '예제 다시 풀기', ['예제']),
  memo('an-000000000003', 5, 'Follow 집합 계산', ['시험']),
  memo('an-000000000004', 9, '', []),
];

describe('filterMemos', () => {
  test('no filter: everything in order', () => {
    assert.deepEqual(filterMemos(memos, EMPTY_MEMO_FILTER).map((m) => m.id), memos.map((m) => m.id));
  });

  test('search words must all match, in the text or the tags, case-insensitively', () => {
    assert.deepEqual(filterMemos(memos, { ...EMPTY_MEMO_FILTER, query: '파싱' }).map((m) => m.slide), [2]);
    assert.deepEqual(filterMemos(memos, { ...EMPTY_MEMO_FILTER, query: 'follow' }).map((m) => m.slide), [5]);
    assert.deepEqual(filterMemos(memos, { ...EMPTY_MEMO_FILTER, query: '시험' }).map((m) => m.id), ['an-000000000001', 'an-000000000003']);
    assert.deepEqual(filterMemos(memos, { ...EMPTY_MEMO_FILTER, query: '시험 집합' }).map((m) => m.id), ['an-000000000003']);
    assert.deepEqual(filterMemos(memos, { ...EMPTY_MEMO_FILTER, query: '   ' }), memos);
  });

  test('tag and slide filters combine with the search', () => {
    assert.deepEqual(filterMemos(memos, { ...EMPTY_MEMO_FILTER, tag: '시험' }).map((m) => m.slide), [2, 5]);
    assert.deepEqual(filterMemos(memos, { ...EMPTY_MEMO_FILTER, slide: 2 }).length, 2);
    assert.deepEqual(filterMemos(memos, { query: '예제', tag: '시험', slide: null }), []);
    assert.deepEqual(filterMemos(memos, { query: '', tag: '시험', slide: 5 }).map((m) => m.id), ['an-000000000003']);
  });
});

describe('memoTagCounts and memoLines', () => {
  test('tags most used first, then alphabetical', () => {
    assert.deepEqual(memoTagCounts(memos), [
      { tag: '시험', count: 2 },
      { tag: '예제', count: 1 },
      { tag: '파싱', count: 1 },
    ]);
    assert.deepEqual(memoTagCounts([]), []);
  });

  test('the first two non-blank lines; a blank memo says so', () => {
    assert.deepEqual(memoLines('LL(1) 파싱 테이블\n\n첫째 줄 아래\n셋째'), ['LL(1) 파싱 테이블', '첫째 줄 아래']);
    assert.deepEqual(memoLines('한 줄'), ['한 줄', null]);
    assert.deepEqual(memoLines('  \n '), ['(빈 메모)', null]);
  });
});
