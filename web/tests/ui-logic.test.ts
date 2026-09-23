// Pure UI helpers (no DOM). Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Course, DocMeta } from '../../shared/types.ts';
import { canOpenFiles, courseBadgeTitle, courseContextSentence, earlierLectures } from '../src/lib/courseContext.ts';
import { describeContext, primeCardState } from '../src/lib/format.ts';

const ctx = {
  primed: false,
  rollover: false,
  attachedSlides: [7],
  reusedSlides: [6, 8],
  overviewImages: 0,
};

describe('describeContext', () => {
  test('ordinary turn', () => {
    assert.deepEqual(
      describeContext(ctx).map((c) => c.text),
      ['🖼 p.7 첨부', '↺ p.6·8 이미 전달됨'],
    );
  });

  test('a recovered turn says why a new conversation was started (instead of the plain rollover chip)', () => {
    const lost = describeContext({ ...ctx, primed: true, rollover: true, recoveredFrom: 'resume_invalid' });
    assert.deepEqual(lost.map((c) => c.kind), ['recovered', 'primed', 'attached', 'reused']);
    assert.equal(lost[0].text, '🔄 이전 대화를 잃어 새 대화로 다시 전달');
    assert.ok(lost[0].title && lost[0].title.length > 10);
    const long = describeContext({ ...ctx, primed: true, recoveredFrom: 'context_overflow' });
    assert.equal(long[0].text, '🔄 대화가 길어져 새 대화로 전달');
    assert.deepEqual(
      describeContext({ ...ctx, primed: true, rollover: true }).map((c) => c.text).slice(0, 2),
      ['🔄 새 대화로 이어감', '📚 전체 슬라이드 전달'],
    );
  });
});

describe('primeCardState', () => {
  test('the deck only counts as delivered when the priming answer completed', () => {
    assert.deepEqual(primeCardState(49, false, 'complete'), {
      title: '📚 전체 슬라이드 49장을 LLM에게 전달했어요',
      tone: 'normal',
      delivered: true,
    });
    assert.equal(primeCardState(49, false, 'error').title, '⚠️ 전체 슬라이드 49장을 LLM에게 전달하지 못했어요');
    assert.equal(primeCardState(49, false, 'error').delivered, false);
    assert.equal(primeCardState(49, false, 'aborted').title, '⏹ 전체 슬라이드 49장 전달이 중단됐어요');
    assert.match(primeCardState(49, false, 'streaming').title, /전달하는 중/);
    assert.match(primeCardState(49, true, undefined).title, /전달하는 중/);
    assert.equal(primeCardState(49, false, undefined).delivered, false);
  });
});

function doc(id: string, patch: Partial<DocMeta> = {}): DocMeta {
  return {
    id,
    title: id.toUpperCase(),
    fileName: `${id}.pdf`,
    pageCount: 10,
    aspectRatio: 16 / 9,
    status: 'ready',
    progress: 10,
    createdAt: '2026-09-01T00:00:00.000Z',
    courseId: 'c',
    digestStatus: 'none',
    ...patch,
  };
}

describe('course context copy', () => {
  const course: Course = { id: 'c', title: 'Compiler', createdAt: '', docIds: ['l1', 'l2', 'l3', 'l4', 'l5'] };
  const docs = [
    doc('l1', { digestStatus: 'ready' }),
    doc('l2', { digestStatus: 'running' }),
    doc('l3', { digestStatus: 'aborted' }),
    doc('l4', { status: 'error', digestStatus: 'none' }),
    doc('l5'),
  ];

  test('earlierLectures counts only what is really sent', () => {
    const e = earlierLectures(course, 5, docs);
    assert.equal(e.total, 4);
    assert.equal(e.withSummary, 1);
    assert.equal(e.running, 1);
    assert.deepEqual(
      e.missing.map((d) => d.id),
      ['l3'],
    ); // l4 failed to convert: nothing to digest
    assert.equal(earlierLectures(course, 1, docs).total, 0);
  });

  test('the sentence never promises summaries that do not exist', () => {
    const none = courseContextSentence('Compiler', 3, { total: 2, withSummary: 0, running: 0, missing: [] }, false);
    assert.match(none, /요약이 있는 강의가 아직 없어서 제목만 전달해요/);
    assert.doesNotMatch(none, /파일/);
    const some = courseContextSentence('Compiler', 5, earlierLectures(course, 5, docs), true);
    assert.match(some, /이전 강의 4개 중 요약이 있는 1개만 요약을 전달하고/);
    assert.match(some, /1개는 정리본을 만드는 중/);
    assert.match(some, /이전 강의 파일/);
    const all = courseContextSentence('Compiler', 2, { total: 1, withSummary: 1, running: 0, missing: [] }, false);
    assert.equal(all, '📁 Compiler의 2강이라서 이전 강의 1개의 요약도 함께 전달해요.');
    assert.match(courseBadgeTitle('Compiler', 5, earlierLectures(course, 5, docs)), /4개 중 요약\(정리본\)이 있는 1개/);
  });

  test('only CLI providers can open the other lectures’ files', () => {
    assert.equal(canOpenFiles(undefined, 'claude-code'), true);
    assert.equal(canOpenFiles(undefined, 'codex'), true);
    assert.equal(canOpenFiles(undefined, 'anthropic-api'), false);
    assert.equal(canOpenFiles(undefined, 'openai-api'), false);
  });
});
