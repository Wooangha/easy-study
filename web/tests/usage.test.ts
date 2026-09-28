// Token usage and limits as the chat shows them (web/src/lib/usage.ts, DESIGN §23). Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChatMessage, UsageLimits } from '../../shared/types.ts';
import { formatTime } from '../src/lib/format.ts';
import {
  currentWindows,
  exactTokens,
  formatTokens,
  limitItems,
  limitsAge,
  limitsTitle,
  newerLimits,
  nextLimitsChange,
  readLatestLimits,
  sessionUsageSummary,
  unrecordedAnswers,
  usageLine,
  usageTitle,
  windowName,
  withLatestLimits,
} from '../src/lib/usage.ts';

const NOW = Date.parse('2026-09-29T03:00:00.000Z');
const HOUR = 3_600_000;
const later = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

describe('token counts', () => {
  test('formatTokens: plain up to 9,999, then 만 (one decimal below 100만) and 억', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [820, '820'],
      [9_876, '9,876'],
      [10_000, '1만'],
      [47_213, '4.7만'],
      [123_456, '12.3만'],
      [99_960, '10만'],
      [999_499, '99.9만'],
      [999_960, '100만'],
      [1_234_567, '123만'],
      [98_765_432, '9,877만'],
      [123_456_789, '1.2억'],
      [-5, '0'],
      [Number.NaN, '0'],
    ];
    for (const [n, text] of cases) assert.equal(formatTokens(n), text, String(n));
    assert.equal(exactTokens(47_213), '47,213');
    assert.equal(exactTokens(undefined), '0');
  });

  test('usageLine: the cached part only when there is one', () => {
    assert.equal(usageLine({ input: 47_213, cachedInput: 41_000, output: 820, reasoning: 120 }), '입력 4.7만 (캐시 4.1만) · 출력 820');
    assert.equal(usageLine({ input: 8_595, output: 5 }), '입력 8,595 · 출력 5');
  });

  test('usageTitle: the exact numbers, parts indented, then the total', () => {
    assert.equal(
      usageTitle({ input: 42_506, cachedInput: 41_000, cacheWrite: 1_500, output: 820, reasoning: 300 }),
      ['이 답변에 쓴 토큰', '입력 42,506', '  캐시에서 읽음 41,000', '  캐시에 저장 1,500', '출력 820', '  추론 300', '합계 43,326'].join('\n'),
    );
    assert.equal(usageTitle({ input: 10, output: 2 }, '제목'), ['제목', '입력 10', '출력 2', '합계 12'].join('\n'));
  });

  test("sessionUsageSummary: the session's total, the priming part in the tooltip", () => {
    const summary = sessionUsageSummary({
      total: { input: 120_000, cachedInput: 80_000, output: 3_000 },
      priming: { input: 40_000, output: 900 },
    });
    assert.equal(summary.text, '이 세션 12.3만 토큰');
    assert.match(summary.title, /^이 세션에서 쓴 토큰/);
    assert.match(summary.title, /합계 123,000/);
    assert.match(summary.title, /그중 슬라이드 전달 40,900$/);
    assert.doesNotMatch(sessionUsageSummary({ total: { input: 5, output: 1 } }).title, /슬라이드 전달 \d/);
  });

  test('answers saved before usage was recorded are named as left out of the total', () => {
    const answer = (status: ChatMessage['status'], usage?: ChatMessage['usage']): ChatMessage => ({
      id: 'x',
      role: 'assistant',
      text: '',
      slide: 1,
      kind: 'question',
      createdAt: '2026-09-26T00:00:00.000Z',
      status,
      ...(usage ? { usage } : {}),
    });
    const messages = [
      answer('complete'), // the old priming
      { ...answer('complete'), role: 'user' as const },
      answer('complete'), // an old answer
      answer('error'),
      answer('complete', { input: 50_000, output: 900 }),
      answer('streaming'),
    ];
    assert.equal(unrecordedAnswers(messages), 2);
    const { title } = sessionUsageSummary({ total: { input: 50_000, output: 900 } }, 2);
    assert.match(title, /토큰이 기록되지 않은 답변 2개는 빠져 있어요/);
    assert.doesNotMatch(sessionUsageSummary({ total: { input: 1, output: 1 } }, 0).title, /빠져/);
  });
});

describe('usage limits', () => {
  const limits = (windows: UsageLimits['windows'], status: UsageLimits['status'] = 'ok', at = new Date(NOW - 60_000).toISOString()): UsageLimits => ({
    at,
    status,
    windows,
  });

  test('windowName: by length; a model family keeps its name', () => {
    assert.equal(windowName({ minutes: 300 }), '5시간');
    assert.equal(windowName({ minutes: 10_080 }), '주간');
    assert.equal(windowName({ minutes: 10_080, label: 'Opus' }), '주간(Opus)');
    assert.equal(windowName({ minutes: 4_320 }), '3일');
    assert.equal(windowName({ minutes: 90 }), '90분');
  });

  test('limitItems: "5시간 한도 12% · 주간 9%", warning from 80 %, over the limit at 100 %', () => {
    const plus = limits([
      { minutes: 300, usedPercent: 12.4, resetsAt: later(2) },
      { minutes: 10_080, usedPercent: 9, resetsAt: later(90) },
    ]);
    assert.deepEqual(limitItems(plus, NOW), [
      { text: '5시간 한도 12%', level: 'ok' },
      { text: '주간 9%', level: 'ok' },
    ]);
    assert.deepEqual(
      limitItems(limits([{ minutes: 300, usedPercent: 85, resetsAt: later(1) }, { minutes: 10_080, usedPercent: 101, resetsAt: later(9) }]), NOW).map((i) => i.level),
      ['warn', 'danger'],
    );
    assert.deepEqual(limitItems(undefined, NOW), []);
    assert.deepEqual(limitItems(null, NOW), []);
  });

  test("a window whose reset time has passed is left out (it started over); without a reset time it lasts its length", () => {
    const old = limits([
      { minutes: 300, usedPercent: 95, resetsAt: later(-1) },
      { minutes: 10_080, usedPercent: 40, resetsAt: later(24) },
      { minutes: 300, usedPercent: 50, label: 'Spark' },
    ]);
    assert.deepEqual(
      currentWindows(old, NOW).map((w) => windowName(w)),
      ['주간', '5시간(Spark)'],
    );
    assert.deepEqual(currentWindows(old, NOW + 6 * HOUR).map((w) => windowName(w)), ['주간']);
    assert.deepEqual(limitItems(limits([{ minutes: 300, usedPercent: 99, resetsAt: later(-0.1) }]), NOW), [], 'nothing current: no line');
  });

  test("the provider's warning / reached status marks the window it is about (named, else the fullest), or stands alone", () => {
    const warned = limitItems(
      limits(
        [
          { minutes: 300, usedPercent: 40, resetsAt: later(2) },
          { minutes: 10_080, usedPercent: 70, resetsAt: later(50), label: 'Opus' },
        ],
        'warning',
      ),
      NOW,
    );
    assert.deepEqual(warned, [
      { text: '5시간 한도 40%', level: 'ok' },
      { text: `주간(Opus) 70% (${formatTime(later(50))} 초기화)`, level: 'warn' },
    ]);
    // Claude names the window (rateLimitType): not the fullest one.
    const named = limits(
      [
        { minutes: 300, usedPercent: 78, resetsAt: later(2) },
        { minutes: 10_080, usedPercent: 75, resetsAt: later(50), binding: true },
      ],
      'warning',
    );
    assert.deepEqual(
      limitItems(named, NOW).map((i) => i.level),
      ['ok', 'warn'],
    );
    assert.deepEqual(limitItems(limits([], 'reached'), NOW), [{ text: '사용 한도 도달', level: 'danger' }]);
    assert.deepEqual(limitItems(limits([], 'warning'), NOW), [{ text: '사용 한도 임박', level: 'warn' }]);
    // A day-old status says nothing about now.
    assert.deepEqual(limitItems(limits([], 'reached', new Date(NOW - 30 * HOUR).toISOString()), NOW), []);
  });

  test('reached, then the window it is about resets: the status is gone with it', () => {
    // Claude refused at 01:00: the 5-hour window at 100 % (resets 03:00 + 1 h), the week at 40 %.
    const at = new Date(NOW - 2 * HOUR).toISOString();
    const reached = limits(
      [
        { minutes: 300, usedPercent: 100, resetsAt: later(1), binding: true },
        { minutes: 10_080, usedPercent: 40, resetsAt: later(90) },
      ],
      'reached',
      at,
    );
    assert.deepEqual(limitItems(reached, NOW), [
      { text: `5시간 한도 100% (${formatTime(later(1))} 초기화)`, level: 'danger' },
      { text: '주간 40%', level: 'ok' },
    ]);
    assert.match(limitsTitle(reached, NOW, 'Claude Code'), /한도에 도달했어요/);
    // After the reset the week is fine: not shown as used up.
    assert.deepEqual(limitItems(reached, NOW + 2 * HOUR), [{ text: '주간 한도 40%', level: 'ok' }]);
    assert.doesNotMatch(limitsTitle(reached, NOW + 2 * HOUR, 'Claude Code'), /도달/);
    // Codex names no window: its fullest one, gone at its reset too (no standalone "사용 한도 도달").
    const codex = limits([{ minutes: 300, usedPercent: 100, resetsAt: later(-1) }], 'reached', at);
    assert.deepEqual(limitItems(codex, NOW), []);
    // A warning moves to no other window either.
    const warned = limits(
      [
        { minutes: 300, usedPercent: 90, resetsAt: later(-0.5), binding: true },
        { minutes: 10_080, usedPercent: 30, resetsAt: later(90) },
      ],
      'warning',
      at,
    );
    assert.deepEqual(limitItems(warned, NOW), [{ text: '주간 한도 30%', level: 'ok' }]);
  });

  test('an older report says when it was made; the line changes by itself at the next reset', () => {
    const fresh = limits([{ minutes: 300, usedPercent: 12, resetsAt: later(2) }]);
    assert.equal(limitsAge(fresh, NOW), null);
    const old = limits([{ minutes: 10_080, usedPercent: 12, resetsAt: later(20) }], 'ok', new Date(NOW - 3 * HOUR).toISOString());
    assert.equal(limitsAge(old, NOW), `${formatTime(old.at)} 기준`);

    // The age label at an hour, then the 5-hour reset.
    assert.equal(nextLimitsChange(fresh, NOW), Date.parse(fresh.at) + HOUR);
    assert.equal(nextLimitsChange(fresh, Date.parse(fresh.at) + HOUR), Date.parse(later(2)));
    // A window without a reset time lasts its length after the report.
    const noReset = limits([{ minutes: 90, usedPercent: 5 }], 'ok', new Date(NOW - 2 * HOUR).toISOString());
    assert.equal(nextLimitsChange(noReset, NOW), Date.parse(noReset.at) + 24 * HOUR);
    assert.equal(nextLimitsChange(limits([], 'ok', new Date(NOW - 48 * HOUR).toISOString()), NOW), null);
  });

  test('limits are the account\'s: the newest report of each provider wins, whichever session it came from', () => {
    const older = limits([{ minutes: 300, usedPercent: 85 }], 'ok', new Date(NOW - 2 * HOUR).toISOString());
    const newer = limits([{ minutes: 300, usedPercent: 12 }], 'ok', new Date(NOW - HOUR).toISOString());
    assert.equal(newerLimits(older, newer), newer);
    assert.equal(newerLimits(newer, older), newer);
    assert.equal(newerLimits(null, older), older);
    assert.equal(newerLimits(undefined, null), null);

    const latest = withLatestLimits({}, 'claude-code', newer);
    assert.deepEqual(latest, { 'claude-code': newer });
    assert.equal(withLatestLimits(latest, 'claude-code', older), latest, 'an older session does not replace it');
    assert.equal(withLatestLimits(latest, 'claude-code', undefined), latest);
    assert.deepEqual(withLatestLimits(latest, 'codex', older), { 'claude-code': newer, codex: older });

    assert.deepEqual(readLatestLimits(JSON.parse(JSON.stringify({ 'claude-code': newer, codex: { at: 'x' } }))), { 'claude-code': newer });
    assert.deepEqual(readLatestLimits(null), {});
    assert.deepEqual(readLatestLimits('junk'), {});
  });

  test('limitsTitle: provider, report time, each window with its reset time', () => {
    const plus = limits([
      { minutes: 300, usedPercent: 12, resetsAt: later(2) },
      { minutes: 10_080, usedPercent: 9 },
    ]);
    assert.equal(
      limitsTitle(plus, NOW, 'Claude Code (구독)'),
      [`Claude Code (구독) 사용 한도 (${formatTime(plus.at)} 기준)`, `5시간: 12% 사용 · ${formatTime(later(2))}에 초기화`, '주간: 9% 사용'].join('\n'),
    );
    assert.match(limitsTitle(limits([], 'reached'), NOW, 'Codex'), /한도에 도달했어요/);
  });
});
