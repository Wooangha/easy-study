// Lecture speech in the tutor context (DESIGN §22 "Tutor context"): context.ts adds, for each slide of the focus
// window that has speech, what the professor said (≤ 1500 characters per slide, ≤ 4000 together), and while a live
// recording runs the last minutes (≤ 3000, the latest kept) before the question; priming says in one line that
// recordings exist; the system prompt has one bullet. speech.ts resolves the speech from the stored transcripts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { TranscriptSegment } from '../shared/types.ts';
import { DEFAULT_CONTEXT_SETTINGS, MAX_RECENT_SPEECH_CHARS, MAX_WINDOW_SPEECH_CHARS, buildTurn, initialProviderState } from '../server/context.ts';
import type { BuildTurnInput, DocAssets, ProviderState, SessionRecord } from '../server/internal-types.ts';
import { LECTURE_RECORDINGS_NOTE, TUTOR_SYSTEM_PROMPT } from '../server/prompts.ts';
import type { Part } from '../server/providers/types.ts';
import { lectureSpeechFor } from '../server/recordings/speech.ts';

const DIR = '/library/deck-abc123';

function doc(pageCount = 9): DocAssets {
  return {
    meta: {
      id: 'deck-abc123',
      title: 'Deck',
      fileName: 'deck.pdf',
      pageCount,
      aspectRatio: 4 / 3,
      status: 'ready',
      progress: pageCount,
      createdAt: '2026-09-23T00:00:00.000Z',
      courseId: null,
      digestStatus: 'none',
    },
    dir: DIR,
    texts: Array.from({ length: pageCount }, (_, i) => `Text of slide ${i + 1}`),
    slidePath: (n) => `${DIR}/slides/${String(n).padStart(3, '0')}.png`,
    sheets: [],
    digest: null,
    digestComplete: false,
    course: null,
  };
}

function session(state: ProviderState = initialProviderState()): SessionRecord {
  return {
    version: 1,
    id: '20260923-120000-abcd',
    docId: 'deck-abc123',
    title: 'S',
    provider: 'claude-code',
    model: '',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    providerState: state,
    messages: [],
  };
}

function turn(overrides: Partial<BuildTurnInput>) {
  return buildTurn({
    doc: doc(),
    session: session(),
    kind: 'question',
    question: '이건 무슨 말이야?',
    slide: 5,
    neighbors: 1,
    settings: { ...DEFAULT_CONTEXT_SETTINGS },
    maxImagesPerConversation: 48,
    ...overrides,
  });
}

const text = (parts: Part[]) => parts.map((p) => (p.type === 'text' ? p.text : `<image ${p.label}>`)).join('\n');

describe('lecture speech in the context (context.ts)', () => {
  test('per slide of the focus window, before the question; slides outside the window are ignored', () => {
    const out = turn({
      lectureSpeech: {
        bySlide: [
          { slide: 4, text: '앞 슬라이드 설명' },
          { slide: 5, text: '퍼스트 셋은 첫 터미널들의 집합입니다' },
          { slide: 8, text: '먼 슬라이드' },
        ],
      },
    });
    const all = text(out.parts);
    assert.match(
      all,
      /What the professor said on slide 4 \(lecture recording, may contain transcription errors; English terms may be written in Hangul\):\n앞 슬라이드 설명/,
    );
    assert.match(all, /What the professor said on slide 5 \(lecture recording[^)]*\):\n퍼스트 셋은 첫 터미널들의 집합입니다/);
    assert.doesNotMatch(all, /slide 8 \(lecture recording/);
    assert.ok(all.indexOf('said on slide 4') < all.indexOf('said on slide 5'));
    assert.ok(all.indexOf('said on slide 5') < all.indexOf("Student's question"));
    assert.ok(all.indexOf('Full-resolution image of slide 6') < all.indexOf('said on slide 4'), 'after the focus window');
    // Priming mentions the recordings once.
    assert.equal(all.split(LECTURE_RECORDINGS_NOTE).length, 2);
  });

  test('caps: 1500 characters per slide, 4000 for the window with the focused slide first', () => {
    const long = (c: string) => c.repeat(2000);
    const out = turn({
      neighbors: 3,
      lectureSpeech: { bySlide: [2, 3, 4, 5, 6, 7, 8].map((slide) => ({ slide, text: long(String(slide)) })) },
    });
    const blocks = out.parts
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .flatMap((p) => p.text.split('\n\n'))
      .filter((b) => b.startsWith('What the professor said'));
    const bodies = new Map(blocks.map((b) => [Number(/slide (\d+)/.exec(b)?.[1]), b.slice(b.indexOf('\n') + 1)]));
    assert.ok([...bodies.values()].every((b) => b.length <= 1500), 'per-slide cap');
    const total = [...bodies.values()].reduce((sum, b) => sum + b.length, 0);
    assert.ok(total <= MAX_WINDOW_SPEECH_CHARS, `total ${total}`);
    assert.ok(bodies.has(5) && bodies.has(4) && bodies.has(6), 'the focused slide and its nearest neighbours first');
    assert.equal(bodies.has(2), false);
  });

  test('recent speech of a live recording: last, before the question, the latest 3000 characters kept', () => {
    const recentText = `처음${'가'.repeat(4000)}마지막 말`;
    const out = turn({ lectureSpeech: { bySlide: [], recent: { text: recentText, minutes: 3 } } });
    const all = text(out.parts);
    const at = all.indexOf('The last 3 minutes of the lecture:\n');
    assert.ok(at > 0);
    assert.ok(at < all.indexOf("Student's question"));
    const body = all.slice(at).split('\n')[1];
    assert.ok(body.endsWith('마지막 말'));
    assert.ok(body.length <= MAX_RECENT_SPEECH_CHARS);
    assert.doesNotMatch(body, /처음/);
  });

  test('without recordings nothing changes; prime turns get no speech blocks', () => {
    const plain = turn({});
    const withEmpty = turn({ lectureSpeech: { bySlide: [] } });
    assert.doesNotMatch(text(plain.parts), /professor said|recorded/);
    // The only difference: the priming line.
    assert.equal(text(withEmpty.parts).replace(`\n\n${LECTURE_RECORDINGS_NOTE}`, ''), text(plain.parts));
    const prime = turn({ kind: 'prime', question: '', lectureSpeech: { bySlide: [{ slide: 5, text: '말' }], recent: { text: '최근', minutes: 3 } } });
    const primeText = text(prime.parts);
    assert.ok(primeText.includes(LECTURE_RECORDINGS_NOTE));
    assert.doesNotMatch(primeText, /What the professor said|The last \d+ minutes/);
    // A continued conversation does not repeat the priming line.
    const next = turn({ session: session({ ...prime.nextState, resume: { cliSessionId: 'x' } }), lectureSpeech: { bySlide: [{ slide: 5, text: '말' }] } });
    assert.doesNotMatch(text(next.parts), new RegExp(LECTURE_RECORDINGS_NOTE.slice(0, 30)));
    assert.match(text(next.parts), /What the professor said on slide 5/);
  });

  test('the system prompt tells the tutor how to use lecture speech', () => {
    assert.match(TUTOR_SYSTEM_PROMPT, /what the professor said in the recorded lecture/);
    assert.match(TUTOR_SYSTEM_PROMPT, /trust the slides for definitions, formulas and notation/);
  });
});

describe('lecture speech from stored transcripts (speech.ts)', () => {
  let tmp = '';
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-speech-'));
    process.env.EASY_STUDY_LIBRARY = tmp;
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function recording(rid: string, createdAt: string, segments: TranscriptSegment[], status = 'ready'): Promise<void> {
    const dir = path.join(tmp, 'deck-abc123', 'recordings', rid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({ version: 1, id: rid, docId: 'deck-abc123', title: rid, source: 'upload', status, language: 'ko', model: 'small-q5_1', liveTranscribe: false, createdAt, durationSec: 600, transcriptStatus: 'ready', transcribedSec: 600, alignment: 'lexical', hasManualMarkers: false }),
    );
    await fs.writeFile(path.join(dir, 'transcript.json'), JSON.stringify({ recordingId: rid, segments, doneWindows: [0], failedWindows: {}, nextId: segments.length + 1 }));
  }

  test('no recording → undefined; per slide the newest recording with speech on it; only the window; failed recordings skipped', async () => {
    assert.equal(await lectureSpeechFor('deck-abc123', 5, [4, 5, 6]), undefined);
    await recording('rec-20260101-100000-aaaa', '2026-01-01T10:00:00.000Z', [
      { id: 1, start: 0, end: 5, text: '옛 녹음 슬라이드 5', slide: 5 },
      { id: 2, start: 5, end: 9, text: '슬라이드 9', slide: 9 },
      { id: 3, start: 9, end: 14, text: '옛 녹음 슬라이드 6', slide: 6 },
    ]);
    await recording('rec-20260102-100000-bbbb', '2026-01-02T10:00:00.000Z', [
      { id: 1, start: 0, end: 5, text: '새 녹음', slide: 5 },
      { id: 2, start: 5, end: 9, text: '앞 슬라이드', slide: 4 },
      { id: 3, start: 9, end: 12, text: '공지', slide: null },
      { id: 4, start: 12, end: 15, text: '이어서', slide: 5 },
    ]);
    await recording('rec-20260103-100000-cccc', '2026-01-03T10:00:00.000Z', [{ id: 1, start: 0, end: 5, text: '실패', slide: 5 }], 'error');
    const speech = await lectureSpeechFor('deck-abc123', 5, [4, 5, 6]);
    assert.deepEqual(speech, {
      bySlide: [
        { slide: 4, text: '앞 슬라이드' },
        // Two recordings of one lecture (a phone memo and the video) would say the same twice: the newest only.
        { slide: 5, text: '새 녹음 이어서' },
        // A slide only the older recording has speech on still gets it.
        { slide: 6, text: '옛 녹음 슬라이드 6' },
      ],
    });
  });
});
