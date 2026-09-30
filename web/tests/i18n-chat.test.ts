// The chat area in English (DESIGN §27): context chips, the priming card, the LLM switch texts, token counts and
// limits, the digest labels, attachment labels and errors, the course context sentence, dates and durations. The
// Korean texts are pinned by the other tests (they run in Korean). Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { MAX_ATTACHMENTS, type Course, type DigestInfo, type DocMeta, type LlmSwitch, type UsageLimits } from '../../shared/types.ts';
import { msg, setLang } from '../src/i18n/index.ts';
import {
  attachErrorMessage,
  attachmentLabel,
  attachmentTitle,
  defaultQuestion,
  dropOverlayCopy,
  explainRegionPrompt,
  limitMessage,
  missingAttachmentsMessage,
  planDrop,
} from '../src/lib/attachments.ts';
import { courseBadgeTitle, courseContextSentence, earlierLectures } from '../src/lib/courseContext.ts';
import { digestContinueLabel, digestNote, digestStatusLabel, digestView } from '../src/lib/digestState.ts';
import {
  describeContext,
  effortName,
  formatDate,
  formatDuration,
  formatTime,
  llmSwitchNotice,
  primeCardState,
  providerWithModel,
  switchMarkerText,
  switchMarkerTitle,
} from '../src/lib/format.ts';
import { formatTokens, limitItems, limitsAge, limitsTitle, sessionUsageSummary, usageLine, usageTitle, windowName } from '../src/lib/usage.ts';

beforeEach(() => setLang('en'));
afterEach(() => setLang('system'));

describe('LLM names and switches in English', () => {
  const change: LlmSwitch = {
    at: new Date(2026, 8, 23, 15, 42).toISOString(),
    afterMessageId: 'm1',
    from: { provider: 'claude-code', model: 'sonnet' },
    to: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
  };

  test('effort levels are named in the language, whatever label the provider list carries', () => {
    const providers = [
      { id: 'codex' as const, label: 'Codex', kind: 'cli' as const, available: true, models: [], efforts: [{ id: 'xhigh', label: '매우 높음' }] },
    ];
    assert.equal(effortName(providers as never, 'codex', 'xhigh'), 'very high');
    assert.equal(effortName(undefined, 'codex', 'turbo'), 'turbo', 'an unknown level keeps its id');
    assert.equal(providerWithModel(undefined, 'codex', 'gpt-5.5', 'high'), 'Codex · gpt-5.5 · high reasoning');
    assert.equal(providerWithModel(undefined, 'claude-code'), 'Claude Code');
  });

  test('the switch marker, its tooltip and the notice', () => {
    assert.equal(switchMarkerText(undefined, change), 'From here: Codex · gpt-5.5 · high reasoning');
    assert.match(switchMarkerTitle(undefined, change), /^LLM changed at .+: Claude Code · sonnet → Codex · gpt-5\.5 · high reasoning\. /);
    assert.match(llmSwitchNotice('Codex · gpt-5.5'), /^Codex · gpt-5\.5 answers from your next question on\./);
  });
});

describe('what was sent with a question, in English', () => {
  test('context chips', () => {
    const chips = describeContext({
      primed: true,
      rollover: true,
      attachedSlides: [7],
      reusedSlides: [8, 6],
      overviewImages: 1,
      attachments: 2,
      memos: 1,
    });
    assert.deepEqual(
      chips.map((c) => c.text),
      ['Continued in a new conversation', 'All slides sent', '1 overview image', 'p.7 attached', 'p.6·8 already sent', '2 attachments', '1 memo'],
    );
    assert.equal(describeContext({ primed: false, rollover: true, recoveredFrom: 'context_overflow', attachedSlides: [], reusedSlides: [], overviewImages: 0 })[0].text, 'Conversation too long, continued in a new one');
  });

  test('the priming card', () => {
    assert.equal(primeCardState(49, false, 'complete').title, 'Sent all 49 slides to the LLM');
    assert.equal(primeCardState(49, false, 'error').title, "Couldn't send all 49 slides to the LLM");
    assert.equal(primeCardState(1, true, undefined).title, 'Sending the slide to the LLM…');
    assert.equal(primeCardState(12, false, 'aborted').title, 'Stopped sending all 12 slides');
  });
});

describe('dates, durations and token counts in English', () => {
  test('dates and times', () => {
    assert.equal(formatDate(new Date(2026, 8, 21, 9, 5).toISOString()), 'Sep 21, 2026');
    const other = formatTime(new Date(2020, 8, 21, 15, 42).toISOString());
    assert.match(other, /^Sep 21, 3:42\sPM$/);
    const today = new Date();
    today.setHours(9, 5, 0, 0);
    assert.match(formatTime(today.toISOString()), /^9:05\sAM$/);
    assert.equal(formatTime('not a date'), '');
  });

  test('durations', () => {
    assert.equal(formatDuration(12_340), '12.3s');
    assert.equal(formatDuration(125_000), '2m 5s');
    assert.equal(formatDuration(undefined), '');
  });

  test('compact token counts: exact below 10,000, then K / M / B', () => {
    assert.equal(formatTokens(820), '820');
    assert.equal(formatTokens(9_876), '9,876');
    assert.equal(formatTokens(47_213), '47.2K');
    assert.equal(formatTokens(123_456), '123.5K');
    assert.equal(formatTokens(1_234_567), '1.2M');
    assert.equal(formatTokens(1_200_000_000), '1.2B');
  });

  test('usage lines and tooltips', () => {
    assert.equal(usageLine({ input: 47_213, cachedInput: 41_000, output: 820 }), '47.2K in (41K cached) · 820 out');
    assert.equal(usageLine({ input: 8_595, output: 5 }), '8,595 in · 5 out');
    assert.equal(usageTitle({ input: 10, output: 2 }), ['Tokens used by this answer', 'Input 10', 'Output 2', 'Total 12'].join('\n'));
    const summary = sessionUsageSummary({ total: { input: 50_000, output: 900 } }, 1);
    assert.equal(summary.text, 'This session: 50.9K tokens');
    assert.match(summary.title, /1 answer without recorded tokens isn't included/);
  });
});

describe('usage limits in English', () => {
  const NOW = Date.parse('2026-09-29T03:00:00.000Z');
  const HOUR = 3_600_000;
  const later = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
  const limits = (windows: UsageLimits['windows'], status: UsageLimits['status'] = 'ok', at = new Date(NOW).toISOString()): UsageLimits => ({
    at,
    status,
    windows,
  });

  test('window names', () => {
    assert.equal(windowName({ minutes: 300 }), '5-hour');
    assert.equal(windowName({ minutes: 10_080 }), 'Weekly');
    assert.equal(windowName({ minutes: 10_080, label: 'Opus' }), 'Weekly (Opus)');
    assert.equal(windowName({ minutes: 4_320 }), '3-day');
    assert.equal(windowName({ minutes: 90 }), '90-minute');
  });

  test('the limit line, its age and its tooltip', () => {
    const plus = limits([
      { minutes: 300, usedPercent: 12, resetsAt: later(2) },
      { minutes: 10_080, usedPercent: 100, resetsAt: later(20) },
    ]);
    assert.deepEqual(limitItems(plus, NOW), [
      { text: '5-hour limit 12%', level: 'ok' },
      { text: `Weekly 100% (resets ${formatTime(later(20))})`, level: 'danger' },
    ]);
    assert.deepEqual(limitItems(limits([], 'reached'), NOW), [{ text: 'Usage limit reached', level: 'danger' }]);
    const old = limits([{ minutes: 10_080, usedPercent: 9, resetsAt: later(20) }], 'ok', new Date(NOW - 2 * HOUR).toISOString());
    assert.equal(limitsAge(old, NOW), `as of ${formatTime(old.at)}`);
    assert.equal(
      limitsTitle(plus, NOW, 'Claude Code'),
      [
        `Claude Code usage limits (as of ${formatTime(plus.at)})`,
        `5-hour limit: 12% used · resets ${formatTime(later(2))}`,
        `Weekly limit: 100% used · resets ${formatTime(later(20))}`,
      ].join('\n'),
    );
  });
});

describe('the digest in English', () => {
  const info = (over: Partial<DigestInfo>): DigestInfo => ({
    status: 'ready',
    total: 4,
    done: 4,
    slides: [1, 2, 3, 4].map((slide) => ({ slide, title: `S${slide}`, markdown: 'x' })),
    summary: 'sum',
    error: null,
    ...over,
  }) as DigestInfo;

  test('status, buttons and hints', () => {
    const complete = info({});
    assert.equal(digestStatusLabel(complete, digestView(complete, 4)).text, 'Digest done · 4 slides');
    const noSummary = info({ summary: null, error: 'Could not make the lecture summary: timeout' });
    const v = digestView(noSummary, 4);
    assert.deepEqual(digestContinueLabel(noSummary, v), { icon: 'summary', text: 'Make lecture summary' });
    assert.equal(digestStatusLabel(noSummary, v).text, 'Digest done · 4 slides · no summary');
    assert.equal(digestNote(noSummary, v)?.hint, 'Use ‘Make lecture summary’ to make just the summary.');
    const partial = info({ status: 'aborted', done: 2, slides: [] });
    assert.deepEqual(digestContinueLabel(partial, digestView(partial, 4)), { icon: 'continue', text: 'Continue' });
    assert.equal(digestStatusLabel(partial, digestView(partial, 4)).text, 'Stopped');
  });
});

describe('attachments in English', () => {
  test('labels, descriptions and the question an empty send asks', () => {
    assert.equal(attachmentLabel({ kind: 'region', slide: 12 }), 'p.12 region');
    assert.equal(attachmentLabel({ kind: 'region', slide: 12, annotation: { id: 'an-000000000001', type: 'ellipse' } }), 'p.12 circle');
    assert.equal(attachmentLabel({ kind: 'image' }), 'Image');
    assert.equal(attachmentTitle({ kind: 'region', slide: 12 }), 'Region selected on slide 12');
    assert.equal(attachmentTitle({ kind: 'region', slide: 3, annotation: { id: 'an-000000000001', type: 'memo' } }), 'Memo on slide 3');
    assert.equal(attachmentTitle({ kind: 'image', name: 'a.png' }), 'Attached image: a.png');
    assert.equal(defaultQuestion([{ kind: 'region' }]), 'Explain this part');
    assert.equal(defaultQuestion([{ kind: 'image' }]), 'Explain the attached image');
    assert.equal(explainRegionPrompt(), 'Explain this part');
    assert.equal(limitMessage(2), `You can attach up to ${MAX_ATTACHMENTS} items to a question (2 not attached)`);
  });

  test("the server's own reason is kept in any language; a proxy's 413 is not", () => {
    const server = 'The image is 9000×9000 px; the largest allowed is 8000 px';
    assert.equal(attachErrorMessage(413, server), server);
    for (const proxy of ['Payload Too Large', 'Request Entity Too Large', '413 Request Entity Too Large', 'HTTP 413 Payload Too Large', 'Attachment failed (HTTP 413)', '<html><body>413</body></html>']) {
      assert.equal(attachErrorMessage(413, proxy), 'The image is too large (max 10 MB)', proxy);
    }
    assert.equal(attachErrorMessage(409, ''), "The document isn't ready yet");
    assert.equal(attachErrorMessage(0, ''), "Can't connect to the server");
  });

  test('drops and missing attachments', () => {
    const pdf = { name: 'a.pdf', type: 'application/pdf' };
    const txt = { name: 'b.txt', type: 'text/plain' };
    assert.deepEqual(planDrop([pdf, txt], false).notices, [{ message: 'Only PDF files can be uploaded: b.txt', kind: 'error' }]);
    assert.equal(dropOverlayCopy({ pdf: false, image: true, unknown: false }, 'x', false).title, 'Open a lecture first, then drop images to attach them to a question');
    assert.match(missingAttachmentsMessage([{ id: 'att-a', kind: 'region', slide: 3 }], ['att-a']), /no longer has these attachments \(p\.3 region\)/);
    assert.match(missingAttachmentsMessage([], ['att-x']), /no longer has one of its attachments/);
  });
});

describe('the course context in English', () => {
  const course = { id: 'c1', title: 'Compilers', docIds: ['d1', 'd2', 'd3'] } as Course;
  const doc = (id: string, digestStatus?: DocMeta['digestStatus']) => ({ id, status: 'ready', digestStatus }) as DocMeta;

  test('the sentence and the badge tooltip', () => {
    const none = earlierLectures(course, 1, []);
    assert.equal(courseContextSentence('Compilers', 1, none, false), 'Lecture 1 of Compilers.');
    const all = earlierLectures(course, 3, [doc('d1', 'ready'), doc('d2', 'ready')]);
    assert.equal(courseContextSentence('Compilers', 3, all, false), 'Lecture 3 of Compilers, so the summaries of the 2 earlier lectures are sent too.');
    const some = earlierLectures(course, 3, [doc('d1', 'ready'), doc('d2', 'running')]);
    assert.equal(
      courseContextSentence('Compilers', 3, some, true),
      'Lecture 3 of Compilers — 1 of the 2 earlier lectures has a summary, which is sent; for the other one only the title is sent (1 digest in progress). A lecture gets its summary once its digest is finished. When needed, it also opens the earlier lectures\' files (digests, slides).',
    );
    const big = { id: 'c2', title: 'Compilers', docIds: ['d1', 'd2', 'd3', 'd4', 'd5'] } as Course;
    const two = earlierLectures(big, 5, [doc('d1', 'ready'), doc('d2', 'ready'), doc('d3', 'running')]);
    assert.equal(
      courseContextSentence('Compilers', 5, two, false),
      'Lecture 5 of Compilers — 2 of the 4 earlier lectures have summaries, which are sent; for the others only the titles are sent (1 digest in progress). A lecture gets its summary once its digest is finished.',
    );
    assert.equal(courseBadgeTitle('Compilers', 1, none), 'Lecture 1 of the course ‘Compilers’ (click for COURSE.md)');
    assert.equal(
      courseBadgeTitle('Compilers', 3, some),
      'Lecture 3 of the course ‘Compilers’ — the LLM also gets the summary of 1 of the 2 earlier lectures (the one with a digest) (click for COURSE.md)',
    );
    assert.equal(
      courseBadgeTitle('Compilers', 5, two),
      'Lecture 5 of the course ‘Compilers’ — the LLM also gets the summaries of 2 of the 4 earlier lectures (those with a digest) (click for COURSE.md)',
    );
    assert.equal(
      courseBadgeTitle('Compilers', 3, all),
      'Lecture 3 of the course ‘Compilers’ — the LLM also gets the summaries of both earlier lectures (click for COURSE.md)',
    );
    assert.equal(msg().chat.course.badge(3, 12), 'Lecture 3/12');
  });
});
