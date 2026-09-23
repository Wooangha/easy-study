// Tests for server/context.ts (pure context strategy). Run: node --test tests/context.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChatMessage, ProviderId } from '../shared/types.ts';
import type { BuildTurnInput, BuildTurnOutput, ContextSettings, DocAssets, ProviderState, SessionRecord } from '../server/internal-types.ts';
import type { Part } from '../server/providers/types.ts';
import {
  DEFAULT_CONTEXT_SETTINGS,
  appendHistory,
  buildTurn,
  defaultContextSettings,
  initialProviderState,
} from '../server/context.ts';
import { TRUNCATED_MARK, NO_TEXT_PLACEHOLDER, PRIME_INSTRUCTION, RECAP_HEADING, TUTOR_SYSTEM_PROMPT } from '../server/prompts.ts';

const DIR = '/library/sample-lecture-abc123';

function makeDoc(pageCount = 9, texts?: string[]): DocAssets {
  const sheets: DocAssets['sheets'] = [];
  for (let from = 1, i = 1; from <= pageCount; from += 4, i++) {
    sheets.push({
      path: `${DIR}/sheets/sheet-${String(i).padStart(2, '0')}.png`,
      fromSlide: from,
      toSlide: Math.min(from + 3, pageCount),
    });
  }
  return {
    meta: {
      id: 'sample-lecture-abc123',
      title: 'Sample Lecture',
      fileName: 'sample-lecture.pdf',
      pageCount,
      aspectRatio: 16 / 9,
      status: 'ready',
      progress: pageCount,
      createdAt: '2026-09-23T00:00:00.000Z',
    },
    dir: DIR,
    texts: texts ?? Array.from({ length: pageCount }, (_, i) => `Text of slide ${i + 1}`),
    slidePath: (n: number) => `${DIR}/slides/${String(n).padStart(3, '0')}.png`,
    sheets,
  };
}

function makeSession(state: ProviderState = initialProviderState(), messages: ChatMessage[] = [], provider: ProviderId = 'claude-code'): SessionRecord {
  return {
    version: 1,
    id: '20260923-120000-abcd',
    docId: 'sample-lecture-abc123',
    title: 'Session',
    provider,
    model: '',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    providerState: state,
    messages,
  };
}

function settings(overrides: Partial<ContextSettings> = {}): ContextSettings {
  return { ...DEFAULT_CONTEXT_SETTINGS, ...overrides };
}

function turn(overrides: Partial<BuildTurnInput> & { session: SessionRecord }): BuildTurnOutput {
  return buildTurn({
    doc: makeDoc(),
    kind: 'question',
    question: '이 슬라이드 설명해줘',
    slide: 1,
    settings: settings(),
    maxImagesPerConversation: 90,
    ...overrides,
  });
}

/** What the orchestrator does after a successful turn. */
function succeed(out: BuildTurnOutput, id = 'cli-session'): ProviderState {
  return { ...out.nextState, resume: { cliSessionId: id } };
}

const images = (parts: Part[]) => parts.filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image');
const allText = (parts: Part[]) => parts.map((p) => (p.type === 'text' ? p.text : `<image ${p.label}>`)).join('\n');

function message(role: 'user' | 'assistant', text: string, slide: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${role}-${slide}-${text.length}`,
    role,
    text,
    slide,
    kind: 'question',
    createdAt: '2026-09-23T00:00:00.000Z',
    status: 'complete',
    ...extra,
  };
}

describe('buildTurn: priming', () => {
  test('first turn primes a new conversation with sheets, all text and the focus image', () => {
    const out = turn({ session: makeSession(), slide: 3, question: '이 그림은 뭐야?' });

    assert.equal(out.resume, null);
    assert.deepEqual(out.history, []);
    assert.equal(out.systemPrompt, TUTOR_SYSTEM_PROMPT);

    const imgs = images(out.parts);
    assert.deepEqual(
      imgs.map((i) => [i.path, i.detail]),
      [
        [`${DIR}/sheets/sheet-01.png`, 'low'],
        [`${DIR}/sheets/sheet-02.png`, 'low'],
        [`${DIR}/sheets/sheet-03.png`, 'low'],
        [`${DIR}/slides/003.png`, 'high'],
      ],
    );
    assert.deepEqual(imgs.map((i) => i.label), ['Slides 1–4 overview', 'Slides 5–8 overview', 'Slide 9 overview', 'Slide 3']);

    const text = allText(out.parts);
    assert.match(text, /Lecture deck: "Sample Lecture"/);
    assert.match(text, /9 slides/);
    for (let n = 1; n <= 9; n++) assert.ok(text.includes(`### Slide ${n}\nText of slide ${n}`), `slide ${n} text`);
    assert.match(text, /slides\/001\.png … slides\/009\.png/, 'CLI providers are told where the slide files are');
    assert.match(text, /The student is currently looking at slide 3 of 9\./);
    assert.match(text, /Student's question \(about slide 3\):\n이 그림은 뭐야\?$/);

    assert.deepEqual(out.context, { primed: true, rollover: false, attachedSlides: [3], reusedSlides: [], overviewImages: 3 });
    assert.deepEqual(out.nextState, {
      resume: null,
      primed: true,
      imagesSent: 4,
      recentSlides: [3],
      generation: 1,
      history: [],
    });
  });

  test('every image is labelled by the text part right before it', () => {
    const out = turn({ session: makeSession(), slide: 5 });
    out.parts.forEach((part, i) => {
      if (part.type !== 'image') return;
      const prev = out.parts[i - 1];
      assert.ok(prev && prev.type === 'text', `image ${i} must follow a text part`);
      const expected = part.detail === 'high' ? 'Full-resolution image of slide 5:' : `Overview image: ${part.label.replace(/^S/, 's').replace(/ overview$/, '')}`;
      assert.ok(prev.text.endsWith(expected), `"${prev.text.slice(-60)}" should end with "${expected}"`);
    });
    // Consecutive text pieces are merged: no two text parts in a row.
    out.parts.forEach((part, i) => {
      if (i > 0) assert.ok(!(part.type === 'text' && out.parts[i - 1].type === 'text'));
    });
  });

  test('API providers are not told about slide files', () => {
    const out = turn({ session: makeSession(initialProviderState(), [], 'anthropic-api') });
    assert.doesNotMatch(allText(out.parts), /slides\/001\.png/);
  });

  test("kind 'prime' asks for an overview instead of answering a question", () => {
    const out = turn({ session: makeSession(), kind: 'prime', question: '', slide: 1 });
    const text = allText(out.parts);
    assert.ok(text.endsWith(PRIME_INSTRUCTION));
    assert.doesNotMatch(text, /Student's question/);
    assert.equal(out.context.primed, true);
  });

  test('primeWithImages=false skips the overview sheets', () => {
    const out = turn({ session: makeSession(), slide: 2, settings: settings({ primeWithImages: false }) });
    assert.deepEqual(images(out.parts).map((i) => i.path), [`${DIR}/slides/002.png`]);
    assert.equal(out.context.overviewImages, 0);
    assert.equal(out.nextState.imagesSent, 1);
    assert.doesNotMatch(allText(out.parts), /Overview image/);
  });

  test('a primed state without a resume handle is primed again', () => {
    const state: ProviderState = { ...initialProviderState(), primed: true, imagesSent: 5, recentSlides: [1], generation: 1 };
    const out = turn({ session: makeSession(state), slide: 1 });
    assert.equal(out.context.primed, true);
    assert.equal(out.nextState.generation, 2);
  });
});

describe('buildTurn: follow-up turns', () => {
  test('same slide on the next turn is reused (no image)', () => {
    const first = turn({ session: makeSession(), slide: 4 });
    const out = turn({ session: makeSession(succeed(first)), slide: 4, question: '다시 설명해줘' });

    assert.deepEqual(out.resume, { cliSessionId: 'cli-session' });
    assert.equal(images(out.parts).length, 0);
    const text = allText(out.parts);
    assert.match(text, /already provided earlier/);
    assert.doesNotMatch(text, /Extracted slide text/);
    assert.deepEqual(out.context, { primed: false, rollover: false, attachedSlides: [], reusedSlides: [4], overviewImages: 0 });
    assert.equal(out.nextState.imagesSent, 4);
    assert.deepEqual(out.nextState.recentSlides, [4]);
    assert.equal(out.nextState.generation, 1);
  });

  test('a new slide is attached; the recent window evicts the least recent slide', () => {
    const s = settings({ recentWindow: 2 });
    let state = succeed(turn({ session: makeSession(), slide: 1, settings: s }));

    let out = turn({ session: makeSession(state), slide: 2, settings: s });
    assert.deepEqual(images(out.parts).map((i) => [i.path, i.detail]), [[`${DIR}/slides/002.png`, 'high']]);
    assert.match(allText(out.parts), /Extracted text of slide 2:\nText of slide 2/);
    assert.deepEqual(out.context.attachedSlides, [2]);
    assert.deepEqual(out.nextState.recentSlides, [2, 1]);
    assert.equal(out.nextState.imagesSent, 5);
    state = succeed(out);

    // Reusing slide 1 moves it to the front.
    out = turn({ session: makeSession(state), slide: 1, settings: s });
    assert.deepEqual(out.context.reusedSlides, [1]);
    assert.deepEqual(out.nextState.recentSlides, [1, 2]);
    assert.equal(out.nextState.imagesSent, 5);
    state = succeed(out);

    // Slide 3 evicts slide 2 (the least recently used).
    out = turn({ session: makeSession(state), slide: 3, settings: s });
    assert.deepEqual(out.nextState.recentSlides, [3, 1]);
    state = succeed(out);

    // Slide 2 fell out of the window, so its image is sent again.
    out = turn({ session: makeSession(state), slide: 2, settings: s });
    assert.deepEqual(out.context.attachedSlides, [2]);
    assert.deepEqual(out.nextState.recentSlides, [2, 3]);
    assert.equal(out.nextState.imagesSent, 7);
  });

  test('history is passed through for stateless providers', () => {
    const first = turn({ session: makeSession(initialProviderState(), [], 'anthropic-api'), slide: 1 });
    const state = appendHistory({ ...first.nextState, resume: {} }, first.parts, '답변');
    const out = turn({ session: makeSession(state, [], 'anthropic-api'), slide: 1 });
    assert.deepEqual(out.resume, {});
    assert.equal(out.history.length, 2);
    assert.deepEqual(out.history, state.history);
    assert.notEqual(out.history, state.history, 'history is copied, not aliased');
  });
});

describe('buildTurn: rollover', () => {
  const pairs: ChatMessage[] = [
    message('user', '', 1, { kind: 'prime' }),
    message('assistant', '덱 개요', 1, { kind: 'prime' }),
    message('user', '질문 A', 2),
    message('assistant', '답변 A', 2),
    message('user', '질문 B', 3),
    message('assistant', '실패한 답변', 3, { status: 'error' }),
    message('user', '질문 C\n여러 줄', 4),
    message('assistant', '답변 C', 4),
    message('user', '질문 D', 5),
    message('assistant', 'x'.repeat(1000), 5),
  ];

  test('starts a new conversation with a recap when the image budget would be exceeded', () => {
    const state: ProviderState = {
      resume: { cliSessionId: 'old' },
      primed: true,
      imagesSent: 10,
      recentSlides: [5, 4],
      generation: 2,
      history: [],
    };
    const out = turn({
      session: makeSession(state, pairs),
      slide: 6,
      maxImagesPerConversation: 10,
      settings: settings({ recapTurns: 2 }),
    });

    assert.equal(out.resume, null);
    assert.deepEqual(out.history, []);
    assert.deepEqual(out.context, { primed: true, rollover: true, attachedSlides: [6], reusedSlides: [], overviewImages: 3 });
    assert.equal(out.nextState.generation, 3);
    assert.deepEqual(out.nextState.recentSlides, [6]);
    assert.equal(out.nextState.imagesSent, 4);

    const text = allText(out.parts);
    assert.ok(text.includes(RECAP_HEADING));
    // Only the last 2 complete question pairs; prime and failed answers are excluded.
    assert.doesNotMatch(text, /질문 A/);
    assert.doesNotMatch(text, /질문 B/);
    assert.ok(text.includes('- (slide 4) Q: 질문 C 여러 줄 / A: 답변 C'));
    assert.ok(text.includes(`- (slide 5) Q: 질문 D / A: ${'x'.repeat(600)}…`));
    // Order: deck, then recap, then the focus slide and question.
    assert.ok(text.indexOf('### Slide 9') < text.indexOf(RECAP_HEADING));
    assert.ok(text.indexOf(RECAP_HEADING) < text.indexOf('currently looking at slide 6'));
  });

  test('a reused slide costs nothing and does not trigger a rollover at the limit', () => {
    const state: ProviderState = {
      resume: { cliSessionId: 'old' },
      primed: true,
      imagesSent: 10,
      recentSlides: [5],
      generation: 1,
      history: [],
    };
    const out = turn({ session: makeSession(state, pairs), slide: 5, maxImagesPerConversation: 10 });
    assert.equal(out.context.rollover, false);
    assert.deepEqual(out.context.reusedSlides, [5]);
    assert.deepEqual(out.resume, { cliSessionId: 'old' });
  });

  test('huge decks cap the overview sheets to leave room for focus images', () => {
    const doc = makeDoc(400);
    const out = turn({ doc, session: makeSession(), slide: 1, maxImagesPerConversation: 90 });
    assert.equal(out.context.overviewImages, 73);
    assert.equal(out.nextState.imagesSent, 74);
    assert.match(allText(out.parts), /Overview images stop at slide 292/);
  });
});

describe('buildTurn: text handling', () => {
  test('long slide texts and the whole dump are truncated; empty texts get a placeholder', () => {
    const texts = ['A'.repeat(100), '', 'B'.repeat(100), 'C'.repeat(100), 'D'.repeat(100)];
    const doc = makeDoc(5, texts);
    const s = settings({ maxSlideTextChars: 50, maxPrimeTextChars: 250 });
    const text = allText(turn({ doc, session: makeSession(), slide: 2, settings: s }).parts);

    assert.ok(text.includes(`### Slide 1\n${'A'.repeat(50)}${TRUNCATED_MARK}`));
    assert.ok(text.includes(`### Slide 2\n${NO_TEXT_PLACEHOLDER}`));
    assert.ok(text.includes(`### Slide 3\n${'B'.repeat(50)}${TRUNCATED_MARK}`));
    // The cap is reached after slide 3: the rest is summarised in one line.
    assert.doesNotMatch(text, /### Slide 4/);
    assert.ok(text.includes(`${TRUNCATED_MARK} (extracted text of slides 4–5 omitted`));
    // The focused slide's own text uses the same placeholder.
    assert.ok(text.includes(`Extracted text of slide 2:\n${NO_TEXT_PLACEHOLDER}`));
  });

  test('a slide that only partly fits the whole-dump cap is cut, the rest summarised', () => {
    const doc = makeDoc(4, ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000), 'd'.repeat(1000)]);
    const text = allText(turn({ doc, session: makeSession(), settings: settings({ maxPrimeTextChars: 1500 }) }).parts);
    assert.ok(text.includes(`### Slide 1\n${'a'.repeat(1000)}\n\n### Slide 2\n${'b'.repeat(472)}${TRUNCATED_MARK}`));
    assert.ok(text.includes(`${TRUNCATED_MARK} (extracted text of slides 3–4 omitted`));
    assert.doesNotMatch(text, /### Slide 3/);
  });

  test('slide text is cleaned (CRLF, trailing spaces, blank line runs)', () => {
    const doc = makeDoc(1, ['Title   \r\n\r\n\r\n\r\nBody\u0007 line  \n                    footer · 1']);
    const text = allText(turn({ doc, session: makeSession() }).parts);
    assert.ok(text.includes('### Slide 1\nTitle\n\nBody line\n    footer · 1'));
  });

  test('the slide number is clamped defensively', () => {
    assert.deepEqual(turn({ session: makeSession(), slide: 0 }).context.attachedSlides, [1]);
    assert.deepEqual(turn({ session: makeSession(), slide: 999 }).context.attachedSlides, [9]);
    assert.deepEqual(turn({ session: makeSession(), slide: Number.NaN }).context.attachedSlides, [1]);
    assert.deepEqual(turn({ session: makeSession(), slide: 2.6 }).context.attachedSlides, [3]);
  });

  test('output is deterministic and does not mutate its input', () => {
    const state = succeed(turn({ session: makeSession(), slide: 2 }));
    const session = makeSession(state);
    const snapshot = structuredClone(session);
    const a = turn({ session, slide: 7 });
    const b = turn({ session, slide: 7 });
    assert.deepEqual(a, b);
    assert.deepEqual(session, snapshot);
  });
});

describe('settings and history helpers', () => {
  test('defaultContextSettings reads the environment', () => {
    assert.deepEqual(defaultContextSettings({}), {
      recentWindow: 4,
      primeWithImages: true,
      maxPrimeTextChars: 60000,
      maxSlideTextChars: 2500,
      recapTurns: 6,
    });
    const s = defaultContextSettings({ EASY_STUDY_RECENT_WINDOW: '7', EASY_STUDY_PRIME_IMAGES: '0' });
    assert.equal(s.recentWindow, 7);
    assert.equal(s.primeWithImages, false);
    assert.equal(defaultContextSettings({ EASY_STUDY_RECENT_WINDOW: 'abc' }).recentWindow, 4);
    assert.equal(defaultContextSettings({ EASY_STUDY_RECENT_WINDOW: '0' }).recentWindow, 1);
  });

  test('initialProviderState', () => {
    assert.deepEqual(initialProviderState(), {
      resume: null,
      primed: false,
      imagesSent: 0,
      recentSlides: [],
      generation: 0,
      history: [],
    });
  });

  test('appendHistory appends the user turn and the answer without mutating', () => {
    const state = initialProviderState();
    const parts: Part[] = [{ type: 'text', text: 'Q' }, { type: 'image', path: '/x.png', detail: 'high', label: 'Slide 1' }];
    const next = appendHistory(state, parts, '답변');
    assert.deepEqual(state.history, []);
    assert.deepEqual(next.history, [
      { role: 'user', parts },
      { role: 'assistant', parts: [{ type: 'text', text: '답변' }] },
    ]);
    const again = appendHistory(next, [{ type: 'text', text: 'Q2' }], '');
    assert.equal(again.history.length, 4);
    assert.deepEqual(again.history[3], { role: 'assistant', parts: [{ type: 'text', text: '(no answer)' }] });
  });
});
