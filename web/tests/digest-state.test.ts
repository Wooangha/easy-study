// 정리본 panel state (web/src/lib/digestState.ts). Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DigestInfo, DigestSlide } from '../../shared/types.ts';
import { digestContinueLabel, digestNote, digestStatusLabel, digestView } from '../src/lib/digestState.ts';

function slides(n: number, failed: number[] = []): DigestSlide[] {
  return Array.from({ length: n }, (_, i) => {
    const slide = i + 1;
    const entry: DigestSlide = { slide, title: `S${slide}`, markdown: 'x' };
    if (failed.includes(slide)) entry.failed = true;
    return entry;
  });
}

function info(patch: Partial<DigestInfo>): DigestInfo {
  return {
    docId: 'd',
    status: 'ready',
    done: 4,
    total: 4,
    slides: slides(4),
    summary: 'summary',
    markdownPath: '/lib/d/DIGEST.md',
    ...patch,
  };
}

function view(i: DigestInfo) {
  const v = digestView(i, i.total);
  return { v, label: digestContinueLabel(i, v), note: digestNote(i, v), status: digestStatusLabel(i, v) };
}

describe('digest panel state', () => {
  test('a finished digest offers nothing but a full redo', () => {
    const { v, label, note, status } = view(info({}));
    assert.equal(v.complete, true);
    assert.equal(v.summaryPending, false);
    assert.equal(label, null);
    assert.equal(note, null);
    assert.equal(status, '✓ 정리본 완성 · 4장');
  });

  test('the summary could not be rewritten after the slides changed: a summary-only run is offered (not only a redo)', () => {
    const error = '강의 요약을 만들지 못했습니다: rate limited';
    const { v, label, note, status } = view(info({ summary: 'summary of slides 1-3', error }));
    assert.equal(v.complete, true);
    assert.equal(v.summaryPending, true);
    assert.equal(v.summaryOutdated, true);
    assert.equal(label, '📘 강의 요약 다시 만들기');
    assert.equal(note?.message, `⚠️ ${error}`, 'the server message is shown as it is, not prefixed a second time');
    assert.match(note?.hint ?? '', /바뀌기 전에 만든 거예요/);
    assert.match(note?.hint ?? '', /‘📘 강의 요약 다시 만들기’로 요약만 다시 만들 수 있어요/);
    assert.match(status, /요약 갱신 필요/);
  });

  test('no summary at all (its first call failed): 📘 강의 요약 만들기', () => {
    const { v, label, note, status } = view(info({ summary: null, error: '강의 요약을 만들지 못했습니다: timeout' }));
    assert.equal(v.summaryPending, true);
    assert.equal(v.summaryOutdated, false);
    assert.equal(label, '📘 강의 요약 만들기');
    assert.equal(note?.message, '⚠️ 강의 요약을 만들지 못했습니다: timeout');
    assert.equal(note?.hint, '‘📘 강의 요약 만들기’로 요약만 다시 만들 수 있어요.');
    assert.match(status, /요약 없음/);
    // Without a note either (e.g. an empty summary answer was never stored).
    assert.equal(view(info({ summary: null })).label, '📘 강의 요약 만들기');
  });

  test('failed slides: their note is shown as it is, without a summary prefix', () => {
    const error = '슬라이드 3의 정리본을 만들지 못했습니다 (이어서 만들기로 다시 시도할 수 있습니다)';
    const { v, label, note, status } = view(info({ slides: slides(4, [3]), error }));
    assert.equal(v.complete, false);
    assert.equal(v.summaryPending, false);
    assert.equal(label, '↻ 실패한 슬라이드 다시');
    assert.deepEqual(note, { message: `⚠️ ${error}`, hint: null });
    assert.equal(status, '✓ 정리본 · 실패 1장');
  });

  test('aborted / error / running', () => {
    const aborted = view(info({ status: 'aborted', done: 2, slides: slides(2), error: '사용자가 정리본 만들기를 중단했습니다' }));
    assert.equal(aborted.label, '▶ 이어서 만들기');
    assert.deepEqual(aborted.note, { message: '⚠️ 사용자가 정리본 만들기를 중단했습니다', hint: null });
    // Aborted during the summary call (every slide done): resuming makes the summary.
    assert.equal(view(info({ status: 'aborted', error: '중단' })).label, '▶ 이어서 만들기');
    const failed = view(info({ status: 'error', done: 0, slides: [], summary: null, error: 'boom' }));
    assert.equal(failed.label, '▶ 이어서 만들기');
    assert.deepEqual(failed.note, { message: '⚠️ boom', hint: null });
    const running = view(info({ status: 'running', done: 1, error: 'old note' }));
    assert.equal(running.label, null);
    assert.equal(running.note, null);
    assert.equal(running.status, '⏳ 정리하는 중');
  });
});
