// Tests for server/context.ts (pure context strategy). Run: node --test tests/context.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChatMessage, DigestSlide, ProviderId } from '../shared/types.ts';
import type {
  BuildTurnInput,
  BuildTurnOutput,
  ContextSettings,
  CourseContext,
  CourseLectureRef,
  DocAssets,
  ProviderState,
  SessionRecord,
} from '../server/internal-types.ts';
import type { Part } from '../server/providers/types.ts';
import {
  DEFAULT_CONTEXT_SETTINGS,
  appendHistory,
  buildTurn,
  defaultContextSettings,
  initialProviderState,
} from '../server/context.ts';
import {
  COURSE_HEADING,
  DIGEST_HEADING,
  EXTRACTED_TEXT_HEADING,
  MIXED_MATERIAL_HEADING,
  NO_SUMMARY_PLACEHOLDER,
  NO_TEXT_PLACEHOLDER,
  PRIME_COURSE_NOTE,
  PRIME_INSTRUCTION,
  RECAP_HEADING,
  SUMMARY_OMITTED_NOTE,
  TRUNCATED_MARK,
  TUTOR_SYSTEM_PROMPT,
} from '../server/prompts.ts';

const LIB = '/library';
const DIR = `${LIB}/sample-lecture-abc123`;

function makeDoc(pageCount = 9, texts?: string[], extra: Partial<DocAssets> = {}): DocAssets {
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
      courseId: null,
      digestStatus: 'none',
    },
    dir: DIR,
    texts: texts ?? Array.from({ length: pageCount }, (_, i) => `Text of slide ${i + 1}`),
    slidePath: (n: number) => `${DIR}/slides/${String(n).padStart(3, '0')}.png`,
    sheets,
    digest: null,
    digestComplete: false,
    course: null,
    ...extra,
  };
}

/** Digest entries "Title n" / "Digest body of slide n" for the given slides. */
function digestFor(slides: number[], overrides: Record<number, Partial<DigestSlide>> = {}): DigestSlide[] {
  return slides.map((n) => ({ slide: n, title: `Title ${n}`, markdown: `Digest body of slide ${n}\n\n핵심: 요점 ${n}`, ...overrides[n] }));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
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

/** One turn; neighbors default to 0 so the Round 1 tests keep their single-slide focus. */
function turn(overrides: Partial<BuildTurnInput> & { session: SessionRecord }): BuildTurnOutput {
  return buildTurn({
    doc: makeDoc(),
    kind: 'question',
    question: '이 슬라이드 설명해줘',
    slide: 1,
    neighbors: 0,
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
    assert.deepEqual(out.readDirs, []);
    assert.deepEqual(out.nextState, {
      resume: null,
      primed: true,
      imagesSent: 4,
      recentSlides: [3],
      generation: 1,
      history: [],
    });
    assert.ok(text.includes(EXTRACTED_TEXT_HEADING));
    assert.doesNotMatch(text, /Course context/);
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

  test("primeWithImages 'never' skips the overview sheets", () => {
    const out = turn({ session: makeSession(), slide: 2, settings: settings({ primeWithImages: 'never' }) });
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
    assert.ok(text.includes(`${TRUNCATED_MARK} (material of slides 4–5 omitted`));
    // The focused slide's own text uses the same placeholder.
    assert.ok(text.includes(`Extracted text of slide 2:\n${NO_TEXT_PLACEHOLDER}`));
  });

  test('a slide that only partly fits the whole-dump cap is cut, the rest summarised', () => {
    const doc = makeDoc(4, ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000), 'd'.repeat(1000)]);
    const text = allText(turn({ doc, session: makeSession(), settings: settings({ maxPrimeTextChars: 1500 }) }).parts);
    assert.ok(text.includes(`### Slide 1\n${'a'.repeat(1000)}\n\n### Slide 2\n${'b'.repeat(472)}${TRUNCATED_MARK}`));
    assert.ok(text.includes(`${TRUNCATED_MARK} (material of slides 3–4 omitted`));
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
      recentWindow: 8,
      neighborWindow: 1,
      primeWithImages: 'auto',
      maxPrimeTextChars: 120000,
      maxSlideTextChars: 4000,
      recapTurns: 6,
      maxCourseContextChars: 30000,
    });
    const s = defaultContextSettings({ EASY_STUDY_RECENT_WINDOW: '7', EASY_STUDY_PRIME_IMAGES: '0', EASY_STUDY_NEIGHBORS: '2' });
    assert.equal(s.recentWindow, 7);
    assert.equal(s.primeWithImages, 'never');
    assert.equal(s.neighborWindow, 2);
    assert.equal(defaultContextSettings({ EASY_STUDY_RECENT_WINDOW: 'abc' }).recentWindow, 8);
    assert.equal(defaultContextSettings({ EASY_STUDY_RECENT_WINDOW: '0' }).recentWindow, 1);
    assert.equal(defaultContextSettings({ EASY_STUDY_NEIGHBORS: '9' }).neighborWindow, 3);
    assert.equal(defaultContextSettings({ EASY_STUDY_NEIGHBORS: '-1' }).neighborWindow, 0);
    assert.equal(defaultContextSettings({ EASY_STUDY_NEIGHBORS: 'x' }).neighborWindow, 1);
    assert.equal(defaultContextSettings({ EASY_STUDY_PRIME_IMAGES: '1' }).primeWithImages, 'always');
    assert.equal(defaultContextSettings({ EASY_STUDY_PRIME_IMAGES: ' Always ' }).primeWithImages, 'always');
    assert.equal(defaultContextSettings({ EASY_STUDY_PRIME_IMAGES: 'never' }).primeWithImages, 'never');
    assert.equal(defaultContextSettings({ EASY_STUDY_PRIME_IMAGES: 'bogus' }).primeWithImages, 'auto');
    assert.equal(defaultContextSettings({ EASY_STUDY_MAX_COURSE_CONTEXT_CHARS: '500' }).maxCourseContextChars, 500);
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

// ---------------------------------------------------------------------------
// Round 2: neighbour slides (DESIGN §10)
// ---------------------------------------------------------------------------

/** The text part right before every image must name it. */
function assertImagesLabelled(parts: Part[]): void {
  parts.forEach((part, i) => {
    if (part.type !== 'image') return;
    const prev = parts[i - 1];
    assert.ok(prev && prev.type === 'text', `image ${i} must follow a text part`);
    if (part.detail === 'high') {
      const n = Number(part.label.replace('Slide ', ''));
      assert.ok(prev.text.endsWith(`Full-resolution image of slide ${n}:`), `"${prev.text.slice(-60)}" labels ${part.label}`);
    }
  });
}

describe('buildTurn: neighbour slides', () => {
  test('priming attaches the whole window in ascending order, marking the current slide', () => {
    const out = turn({ session: makeSession(), slide: 5, neighbors: 1 });
    const imgs = images(out.parts).filter((i) => i.detail === 'high');
    assert.deepEqual(imgs.map((i) => i.path), [4, 5, 6].map((n) => `${DIR}/slides/00${n}.png`));
    assert.deepEqual(imgs.map((i) => i.label), ['Slide 4', 'Slide 5', 'Slide 6']);
    assertImagesLabelled(out.parts);

    const text = allText(out.parts);
    assert.match(text, /The student is currently looking at slide 5 of 9\.\n\nSlides 4–6 are included for context because lecture slides often continue across pages; answer about slide 5 unless asked otherwise\./);
    assert.ok(text.indexOf('[Slide 4]') < text.indexOf('[Slide 5 — CURRENT]'));
    assert.ok(text.indexOf('[Slide 5 — CURRENT]') < text.indexOf('[Slide 6]'));
    for (const n of [4, 5, 6]) assert.ok(text.includes(`Extracted text of slide ${n}:\nText of slide ${n}`));

    assert.deepEqual(out.context, { primed: true, rollover: false, attachedSlides: [4, 5, 6], reusedSlides: [], overviewImages: 3 });
    assert.equal(out.nextState.imagesSent, 3 + 3);
    assert.deepEqual(out.nextState.recentSlides, [5, 4, 6]);
  });

  test('the window is clamped at the deck edges and the neighbour count to 0..3', () => {
    const at = (slide: number, neighbors: number) => turn({ session: makeSession(), slide, neighbors }).context.attachedSlides;
    assert.deepEqual(at(1, 2), [1, 2, 3]);
    assert.deepEqual(at(9, 3), [6, 7, 8, 9]);
    assert.deepEqual(at(2, 1), [1, 2, 3]);
    assert.deepEqual(at(5, 7), [2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(at(5, -2), [5]);
    assert.deepEqual(at(5, 1.4), [4, 5, 6]);
    assert.deepEqual(turn({ doc: makeDoc(1), session: makeSession(), slide: 1, neighbors: 3 }).context.attachedSlides, [1]);
    // A missing / invalid request value falls back to settings.neighborWindow.
    const fallback = (neighbors: unknown) =>
      turn({ session: makeSession(), slide: 5, neighbors: neighbors as number, settings: settings({ neighborWindow: 2 }) }).context
        .attachedSlides;
    assert.deepEqual(fallback(undefined), [3, 4, 5, 6, 7]);
    assert.deepEqual(fallback(Number.NaN), [3, 4, 5, 6, 7]);
    // Without neighbours there is no "included for context" line.
    assert.doesNotMatch(allText(turn({ session: makeSession(), slide: 5, neighbors: 0 }).parts), /included for context/);
  });

  test('sequential reading costs one new image per step', () => {
    let state = succeed(turn({ session: makeSession(), slide: 1, neighbors: 1 }));
    assert.equal(state.imagesSent, 3 + 2);
    for (let slide = 2; slide <= 9; slide++) {
      const out = turn({ session: makeSession(state), slide, neighbors: 1 });
      assert.equal(out.context.primed, false);
      const expected = slide < 9 ? [slide + 1] : [];
      assert.deepEqual(out.context.attachedSlides, expected, `slide ${slide}`);
      assert.deepEqual(out.context.reusedSlides, slide < 9 ? [slide - 1, slide] : [8, 9]);
      assert.equal(out.nextState.imagesSent, state.imagesSent + expected.length);
      assert.equal(images(out.parts).length, expected.length);
      state = succeed(out);
    }
    assert.equal(state.imagesSent, 3 + 9, 'every slide was sent exactly once');
  });

  test('reused window slides are pointed back to; new ones are attached with their material', () => {
    const state = succeed(turn({ session: makeSession(), slide: 5, neighbors: 1 }));
    const out = turn({ session: makeSession(state), slide: 4, neighbors: 1 });
    assert.deepEqual(out.context, { primed: false, rollover: false, attachedSlides: [3], reusedSlides: [4, 5], overviewImages: 0 });
    assert.deepEqual(images(out.parts).map((i) => i.path), [`${DIR}/slides/003.png`]);
    assertImagesLabelled(out.parts);
    const text = allText(out.parts);
    assert.ok(text.includes("[Slide 4 — CURRENT]\n(Slide 4's full-resolution image was already provided earlier in this conversation.)"));
    assert.ok(text.includes("[Slide 5]\n(Slide 5's full-resolution image was already provided earlier in this conversation.)"));
    assert.ok(text.includes('Extracted text of slide 3:\nText of slide 3'));
    assert.doesNotMatch(text, /Extracted text of slide [45]/);
    assert.deepEqual(out.nextState.recentSlides, [4, 3, 5, 6]);
  });

  test('recentSlides: current, other window slides nearest first, then the previous list; cut to recentWindow', () => {
    const state: ProviderState = { resume: { cliSessionId: 's' }, primed: true, imagesSent: 10, recentSlides: [9, 8, 2], generation: 1, history: [] };
    const recent = (recentWindow: number) =>
      turn({ session: makeSession(state), slide: 5, neighbors: 2, settings: settings({ recentWindow }) }).nextState.recentSlides;
    assert.deepEqual(recent(8), [5, 4, 6, 3, 7, 9, 8, 2]);
    assert.deepEqual(recent(6), [5, 4, 6, 3, 7, 9]);
    // Never shorter than the window that was just shown.
    assert.deepEqual(recent(2), [5, 4, 6, 3, 7]);
  });

  test('rollover is decided by the cost of the new window slides', () => {
    const base: ProviderState = { resume: { cliSessionId: 's' }, primed: true, imagesSent: 0, recentSlides: [5], generation: 1, history: [] };
    const at = (imagesSent: number, slide: number) =>
      turn({ session: makeSession({ ...base, imagesSent }), slide, neighbors: 1, maxImagesPerConversation: 90 });
    // Window 6–8 is all new: cost 3.
    assert.equal(at(87, 7).context.rollover, false);
    assert.equal(at(87, 7).nextState.imagesSent, 90);
    const rolled = at(88, 7);
    assert.equal(rolled.context.rollover, true);
    assert.equal(rolled.context.primed, true);
    assert.deepEqual(rolled.context.attachedSlides, [6, 7, 8], 'a fresh conversation gets the whole window again');
    assert.deepEqual(rolled.context.reusedSlides, []);
    assert.equal(rolled.nextState.imagesSent, 3 + 3);
    assert.deepEqual(rolled.nextState.recentSlides, [7, 6, 8]);
    // Window 4–6 reuses slide 5: cost 2.
    assert.equal(at(88, 5).context.rollover, false);
    assert.equal(at(89, 5).context.rollover, true);
  });

  test('the window shrinks when it could never fit the image budget', () => {
    const out = turn({ session: makeSession(), slide: 5, neighbors: 3, maxImagesPerConversation: 3, settings: settings({ primeWithImages: 'never' }) });
    assert.deepEqual(out.context.attachedSlides, [4, 5, 6]);
    const tiny = turn({ session: makeSession(), slide: 5, neighbors: 3, maxImagesPerConversation: 2 });
    assert.deepEqual(tiny.context.attachedSlides, [5]);
  });
});

// ---------------------------------------------------------------------------
// Round 2: digest material (DESIGN §11)
// ---------------------------------------------------------------------------

describe('buildTurn: digest material', () => {
  test('a complete digest replaces the extracted text and (auto) the overview sheets', () => {
    const doc = makeDoc(9, undefined, { digest: digestFor(range(1, 9)), digestComplete: true });
    const out = turn({ doc, session: makeSession(), slide: 5, neighbors: 1 });
    const text = allText(out.parts);

    assert.equal(out.context.overviewImages, 0);
    assert.equal(images(out.parts).length, 3);
    assert.equal(out.nextState.imagesSent, 3);
    assert.match(text, /A digest of every slide under "### Slide N" headings: a transcription made earlier from each slide image/);
    assert.doesNotMatch(text, /Overview image/);
    assert.ok(text.includes(DIGEST_HEADING));
    assert.doesNotMatch(text, /Extracted slide text/);
    for (let n = 1; n <= 9; n++) {
      assert.ok(text.includes(`### Slide ${n} · Title ${n}\nDigest body of slide ${n}\n\n핵심: 요점 ${n}`), `slide ${n} digest`);
    }
    assert.doesNotMatch(text, /Text of slide/);
    assert.ok(
      text.includes('Digest of slide 5 (transcribed earlier from the slide image):\nTitle: Title 5\nDigest body of slide 5'),
    );
    assertImagesLabelled(out.parts);
  });

  test("primeWithImages: 'always' keeps the sheets with a digest, 'never' drops them without one", () => {
    const withDigest = makeDoc(9, undefined, { digest: digestFor(range(1, 9)), digestComplete: true });
    assert.equal(turn({ doc: withDigest, session: makeSession(), settings: settings({ primeWithImages: 'always' }) }).context.overviewImages, 3);
    assert.equal(turn({ doc: withDigest, session: makeSession(), settings: settings({ primeWithImages: 'auto' }) }).context.overviewImages, 0);
    assert.equal(turn({ session: makeSession(), settings: settings({ primeWithImages: 'auto' }) }).context.overviewImages, 3);
    assert.equal(turn({ session: makeSession(), settings: settings({ primeWithImages: 'never' }) }).context.overviewImages, 0);
    // Round 1 booleans are still understood.
    const legacy = (v: boolean) => turn({ doc: withDigest, session: makeSession(), settings: settings({ primeWithImages: v as never }) });
    assert.equal(legacy(true).context.overviewImages, 3);
    assert.equal(legacy(false).context.overviewImages, 0);
  });

  test('a partial digest mixes digest entries with marked PDF text, and keeps the sheets', () => {
    const digest = digestFor([1, 2, 3, 5], { 3: { failed: true, markdown: '_(실패)_' }, 5: { markdown: '   ' } });
    const doc = makeDoc(6, undefined, { digest, digestComplete: false });
    const out = turn({ doc, session: makeSession(), slide: 2, neighbors: 1 });
    const text = allText(out.parts);

    assert.equal(out.context.overviewImages, 2);
    assert.ok(text.includes(MIXED_MATERIAL_HEADING));
    assert.ok(text.includes('### Slide 1 · Title 1\nDigest body of slide 1'));
    assert.ok(text.includes('### Slide 3 (PDF text)\nText of slide 3'), 'failed entries fall back to the extracted text');
    assert.ok(text.includes('### Slide 5 (PDF text)\nText of slide 5'), 'empty entries fall back too');
    assert.ok(text.includes('### Slide 4 (PDF text)\nText of slide 4'));
    assert.doesNotMatch(text, /실패/);
    // Focus window 1–3: digest for 1 and 2, extracted text for 3.
    assert.ok(text.includes('Digest of slide 1 (transcribed earlier from the slide image):\nTitle: Title 1'));
    assert.ok(text.includes('Digest of slide 2 (transcribed earlier from the slide image):'));
    assert.ok(text.includes('Extracted text of slide 3:\nText of slide 3'));
  });

  test('digest material is used for newly attached slides in follow-up turns', () => {
    const doc = makeDoc(9, undefined, { digest: digestFor(range(1, 9)), digestComplete: true });
    const state = succeed(turn({ doc, session: makeSession(), slide: 2, neighbors: 1 }));
    const out = turn({ doc, session: makeSession(state), slide: 3, neighbors: 1 });
    assert.deepEqual(out.context.attachedSlides, [4]);
    const text = allText(out.parts);
    assert.ok(text.includes('[Slide 4]\nFull-resolution image of slide 4:'));
    assert.ok(text.includes('Digest of slide 4 (transcribed earlier from the slide image):\nTitle: Title 4\nDigest body of slide 4'));
    assert.doesNotMatch(text, /### Slide/, 'no deck dump outside priming');
  });

  test('digest Markdown: headings are demoted below "### Slide N", code fences are respected and closed when cut', () => {
    const markdown = '## Big heading\n# Top\ntext\n```python\n# a comment, not a heading\nx = 1\n```\n\n\n\nafter';
    const doc = makeDoc(2, undefined, { digest: [{ slide: 1, title: '  Multi\n line  ', markdown }], digestComplete: false });
    const text = allText(turn({ doc, session: makeSession(), slide: 1 }).parts);
    assert.ok(
      text.includes('### Slide 1 · Multi line\n##### Big heading\n#### Top\ntext\n```python\n# a comment, not a heading\nx = 1\n```\n\nafter'),
    );

    const long = makeDoc(1, undefined, { digest: [{ slide: 1, title: '', markdown: `intro\n\`\`\`\n${'y'.repeat(500)}\n\`\`\`` }], digestComplete: true });
    const cut = allText(turn({ doc: long, session: makeSession(), settings: settings({ maxSlideTextChars: 100 }) }).parts);
    assert.ok(cut.includes(`### Slide 1\nintro\n\`\`\`\n${'y'.repeat(100 - 10)}${TRUNCATED_MARK}\n\`\`\``));
  });
});

// ---------------------------------------------------------------------------
// Round 2: course context (DESIGN §12)
// ---------------------------------------------------------------------------

function lecture(index: number, docId: string, extra: Partial<CourseLectureRef> = {}): CourseLectureRef {
  return {
    docId,
    title: `L${index} title`,
    index,
    pageCount: 30,
    dir: `${LIB}/${docId}`,
    summary: `Summary of lecture ${index}`,
    hasDigest: true,
    ...extra,
  };
}

/** Course "Compiler": L1 (digest), L2 (no digest, no summary), L3 = the sample doc, L4 (later). */
function courseDoc(extra: Partial<CourseContext> = {}): DocAssets {
  const course: CourseContext = {
    id: 'compiler-a1b2c3',
    title: 'Compiler',
    lectures: [
      lecture(1, 'l1-intro-aaaaaa'),
      lecture(2, 'l2-lexing-bbbbbb', { summary: null, hasDigest: false, pageCount: 12 }),
      lecture(3, 'sample-lecture-abc123', { title: 'Sample Lecture', pageCount: 9, dir: DIR }),
      lecture(4, 'l4-bottom-up-dddddd', { summary: 'Summary of a later lecture' }),
    ],
    currentIndex: 3,
    ...extra,
  };
  return makeDoc(9, undefined, { course, meta: { ...makeDoc().meta, courseId: course.id } });
}

describe('buildTurn: course context', () => {
  test('priming lists the lectures, summarises the earlier ones and points CLIs to their files', () => {
    const out = turn({ doc: courseDoc(), session: makeSession(), slide: 2, kind: 'prime', question: '' });
    const text = allText(out.parts);

    assert.match(text, /Course context: where this lecture sits in its course/);
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      assert.ok(i >= 0, `missing: ${needle}`);
      return i;
    };
    // Order: header, course context, overview images, deck material, focus.
    assert.ok(at('# Lecture deck') < at(COURSE_HEADING));
    assert.ok(at(COURSE_HEADING) < at('Overview image: slides 1–4'));
    assert.ok(at('Overview image: slides 1–4') < at(EXTRACTED_TEXT_HEADING));
    assert.ok(at(EXTRACTED_TEXT_HEADING) < at('The student is currently looking at slide 2'));

    assert.ok(text.includes('This lecture is part of the course "Compiler": lecture 3 of 4.'));
    assert.ok(text.includes('1. L1 title\n2. L2 title\n3. Sample Lecture  ← this lecture\n4. L4 title  (later lecture)'));
    assert.ok(text.includes('### Lecture 1: L1 title\nSummary of lecture 1'));
    assert.ok(text.includes(`### Lecture 2: L2 title\n${NO_SUMMARY_PLACEHOLDER}`));
    assert.ok(at('### Lecture 1:') < at('### Lecture 2:'), 'oldest first');
    assert.doesNotMatch(text, /### Lecture 3/);
    assert.doesNotMatch(text, /### Lecture 4/);
    assert.doesNotMatch(text, /Summary of a later lecture/, 'later lectures: titles only');
    assert.match(text, /Lectures after this one are listed by title only/);

    // CLI-only file pointers, relative to the document directory.
    assert.ok(text.includes('- Lecture 1 "L1 title": ../l1-intro-aaaaaa/DIGEST.md (per-slide transcription); ../l1-intro-aaaaaa/slides/001.png … ../l1-intro-aaaaaa/slides/030.png (slide images)'));
    assert.ok(text.includes('- Lecture 2 "L2 title": no digest yet — ../l2-lexing-bbbbbb/text/001.txt … ../l2-lexing-bbbbbb/text/012.txt (extracted text)'));
    assert.ok(text.includes('- Lecture 4 "L4 title": ../l4-bottom-up-dddddd/DIGEST.md'));
    assert.doesNotMatch(text, /- Lecture 3 /);

    assert.deepEqual(out.readDirs, [`${LIB}/l1-intro-aaaaaa`, `${LIB}/l2-lexing-bbbbbb`, `${LIB}/l4-bottom-up-dddddd`]);
    assert.ok(text.endsWith(PRIME_INSTRUCTION.replace('Finish', `${PRIME_COURSE_NOTE}Finish`)));
  });

  test('API providers get the course context without file pointers; readDirs are still reported', () => {
    const out = turn({ doc: courseDoc(), session: makeSession(initialProviderState(), [], 'openai-api'), slide: 1 });
    const text = allText(out.parts);
    assert.ok(text.includes('### Lecture 1: L1 title\nSummary of lecture 1'));
    assert.doesNotMatch(text, /DIGEST\.md|Files of the other lectures/);
    assert.equal(out.readDirs.length, 3);
  });

  test('follow-up turns do not repeat the course context but keep readDirs', () => {
    const doc = courseDoc();
    const state = succeed(turn({ doc, session: makeSession(), slide: 1 }));
    const out = turn({ doc, session: makeSession(state), slide: 1 });
    assert.doesNotMatch(allText(out.parts), /Course context|### Lecture/);
    assert.deepEqual(out.readDirs, [`${LIB}/l1-intro-aaaaaa`, `${LIB}/l2-lexing-bbbbbb`, `${LIB}/l4-bottom-up-dddddd`]);
  });

  test('the first lecture of a course has no earlier summaries and a plain prime instruction', () => {
    const doc = courseDoc();
    const course = doc.course!;
    const first: CourseContext = {
      ...course,
      lectures: [course.lectures[2], course.lectures[0]].map((l, i) => ({ ...l, index: i + 1 })),
      currentIndex: 1,
    };
    const out = turn({ doc: { ...doc, course: first }, session: makeSession(), kind: 'prime', question: '' });
    const text = allText(out.parts);
    assert.ok(text.includes('lecture 1 of 2.'));
    assert.doesNotMatch(text, /Summaries of the earlier lectures/);
    assert.ok(text.endsWith(PRIME_INSTRUCTION));
  });

  test('the cap drops the oldest summaries first (keeping titles), then truncates the newest', () => {
    const lectures = [
      lecture(1, 'l1-aaaaaa', { summary: 'a'.repeat(1000) }),
      lecture(2, 'l2-bbbbbb', { summary: 'b'.repeat(1000) }),
      lecture(3, 'l3-cccccc', { summary: 'c'.repeat(1000) }),
      lecture(4, 'sample-lecture-abc123', { dir: DIR, summary: 'own summary is never included' }),
    ];
    const doc = makeDoc(9, undefined, { course: { id: 'c-1', title: 'C', lectures, currentIndex: 4 } });
    const withCap = (maxCourseContextChars: number) =>
      allText(turn({ doc, session: makeSession(), settings: settings({ maxCourseContextChars }) }).parts);

    let text = withCap(30000);
    for (const ch of 'abc') assert.ok(text.includes(ch.repeat(1000)));
    assert.doesNotMatch(text, /own summary/);

    text = withCap(2500);
    assert.ok(text.includes(`### Lecture 1: L1 title\n${SUMMARY_OMITTED_NOTE}`));
    assert.ok(text.includes(`### Lecture 2: L2 title\n${'b'.repeat(1000)}`));
    assert.ok(text.includes(`### Lecture 3: L3 title\n${'c'.repeat(1000)}`));

    text = withCap(600);
    assert.ok(text.includes(`### Lecture 1: L1 title\n${SUMMARY_OMITTED_NOTE}`));
    assert.ok(text.includes(`### Lecture 2: L2 title\n${SUMMARY_OMITTED_NOTE}`));
    const newest = /### Lecture 3: L3 title\n(c+)…\[truncated\]/.exec(text);
    assert.ok(newest, 'the newest summary is truncated rather than dropped');
    const sectionsLength = text.slice(text.indexOf('### Lecture 1'), text.indexOf(TRUNCATED_MARK) + TRUNCATED_MARK.length).length;
    assert.ok(sectionsLength <= 600, `summaries stay within the cap (${sectionsLength})`);

    text = withCap(0);
    for (const n of [1, 2, 3]) assert.ok(text.includes(`### Lecture ${n}: L${n} title\n${SUMMARY_OMITTED_NOTE}`));
  });

  test('summary Markdown headings are demoted; the current lecture is found by doc id', () => {
    const doc = courseDoc();
    const course = doc.course!;
    const lectures = course.lectures.map((l) => (l.index === 1 ? { ...l, summary: '## 주제\n- FIRST 집합' } : l));
    const out = turn({ doc: { ...doc, course: { ...course, lectures, currentIndex: 99 } }, session: makeSession() });
    const text = allText(out.parts);
    assert.ok(text.includes('### Lecture 1: L1 title\n##### 주제\n- FIRST 집합'));
    assert.ok(text.includes('lecture 3 of 4.'), 'position comes from the doc id, not the stale index');
  });
});
