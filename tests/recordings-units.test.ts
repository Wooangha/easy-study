// Lecture recordings (DESIGN §22), pure parts: the lexical slide aligner (accuracy on a small synthetic lecture,
// markers as hard constraints, the live timeline prior, LLM votes, large decks), the ASR window segmenter (tiling,
// pauses, hard cuts), whisper JSON parsing, content sniffing, WAV helpers, Range parsing and the AI prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { alignSegments, lectureSpans, markerConstraints, timelinePrior } from '../server/recordings/align/align.ts';
import type { AlignSegment } from '../server/recordings/align/align.ts';
import { DEFAULT_DP, emissions, viterbi } from '../server/recordings/align/dp.ts';
import { features, skeletons, tokens } from '../server/recordings/align/text.ts';
import { alignInWorker } from '../server/recordings/align/worker.ts';
import { buildAlignPrompt, deckLines, parseAlignRuns } from '../server/recordings/aiPrompt.ts';
import { acceleration, findFfmpeg, findWhisper, parseWhisperJson, progressReader, whisperArgs } from '../server/recordings/asr.ts';
import { repoRoot } from '../server/config.ts';
import { existsSync } from 'node:fs';
import { conversionError, ffmpegArgs, parseDuration, sniffMedia } from '../server/recordings/ffmpeg.ts';
import { parseRange } from '../server/recordings/routes.ts';
import { Segmenter, WINDOW_PRESETS } from '../server/recordings/segmenter.ts';
import { ownSegments } from '../server/recordings/service.ts';
import type { AsrWindow } from '../server/recordings/segmenter.ts';
import { readWavInfo, wavHeader, writeWavSlice } from '../server/recordings/wav.ts';
import { capEnd, capStart } from '../server/recordings/speech.ts';
import { tonesPcm } from './recordingFixtures.ts';

let tmp = '';
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-rec-units-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// A small synthetic lecture: 8 slides (English slide text + a Korean digest), Korean speech that writes English
// terms in Hangul like whisper does ("퍼스트 셋", "팔로우"), one announcement in the middle.
// ---------------------------------------------------------------------------------------------------------------

const SLIDES = [
  'Lexical Analysis\nTokens, lexemes and patterns. A scanner groups characters into tokens using regular expressions.\n어휘 분석: 문자들을 토큰으로 묶는 스캐너, 정규 표현식',
  'Finite Automata\nDFA and NFA. Subset construction converts an NFA into a DFA.\n유한 오토마타: 결정적 오토마타와 비결정적 오토마타, 부분집합 구성',
  'Context-Free Grammars\nProductions, nonterminals, terminals and derivations. Leftmost derivation and parse trees.\n문맥 자유 문법: 생성 규칙, 논터미널, 유도, 파스 트리',
  'FIRST sets\nFIRST(X) is the set of terminals that begin strings derived from X. Epsilon if X derives the empty string.\n퍼스트 집합: 유도되는 문자열의 첫 터미널들의 집합',
  'FOLLOW sets\nFOLLOW(A) is the set of terminals that can appear immediately to the right of A. The end marker $ is in FOLLOW(S).\n팔로우 집합: 논터미널 바로 뒤에 올 수 있는 터미널들',
  'LL(1) Parsing Table\nFor each production A -> alpha, put it in M[A, a] for every a in FIRST(alpha). Conflicts mean the grammar is not LL(1).\n파싱 테이블 채우기, 충돌이 있으면 LL(1) 문법이 아님',
  'Recursive Descent\nOne procedure per nonterminal. Lookahead decides which production to use. Backtracking is avoided.\n재귀 하강 파서: 논터미널마다 함수 하나, 룩어헤드',
  'Error Recovery\nPanic mode skips input until a synchronizing token. Phrase-level recovery repairs locally.\n오류 복구: 패닉 모드, 동기화 토큰',
];

const SPEECH: Array<[number | null, string]> = [
  [1, '자 오늘은 어휘 분석부터 시작하겠습니다'],
  [1, '스캐너는 문자들을 읽어서 토큰으로 묶어요'],
  [1, '토큰의 패턴은 보통 정규 표현식으로 씁니다'],
  [1, '렉심이라는 말은 실제 문자열을 말하는 거예요'],
  [2, '다음은 유한 오토마타입니다'],
  [2, '디에프에이와 엔에프에이의 차이를 봅시다'],
  [2, '비결정적 오토마타를 결정적 오토마타로 바꾸는 게 부분집합 구성이에요'],
  [3, '이제 문맥 자유 문법으로 넘어갑니다'],
  [3, '생성 규칙은 논터미널을 터미널과 논터미널의 문자열로 바꿔요'],
  [3, '레프트모스트 유도를 하면 파스 트리가 만들어집니다'],
  [null, '아 참고로 다음 주 월요일 과제 마감이니까 잊지 마세요'],
  [4, '자 그러면 퍼스트 셋을 계산해 봅시다'],
  [4, '퍼스트 집합은 유도되는 문자열의 첫 터미널들의 집합이에요'],
  [4, '빈 문자열이 유도되면 엡실런을 퍼스트에 넣습니다'],
  [5, '다음은 팔로우 집합입니다'],
  [5, '팔로우는 논터미널 바로 뒤에 올 수 있는 터미널들이에요'],
  [5, '시작 기호의 팔로우에는 엔드 마커 달러가 들어갑니다'],
  [6, '이제 파싱 테이블을 채워 봅시다'],
  [6, '각 생성 규칙에 대해 퍼스트 알파의 터미널 칸에 규칙을 넣어요'],
  [6, '한 칸에 두 규칙이 들어가면 충돌이고 엘엘 원 문법이 아닙니다'],
  [7, '재귀 하강 파서는 논터미널마다 함수를 하나씩 만들어요'],
  [7, '룩어헤드를 보고 어떤 생성 규칙을 쓸지 결정합니다'],
  [7, '그래서 백트래킹을 하지 않아도 돼요'],
  [8, '마지막으로 오류 복구를 봅시다'],
  [8, '패닉 모드는 동기화 토큰이 나올 때까지 입력을 건너뛰어요'],
  [8, '구문 수준 복구는 그 자리에서 고치는 방법입니다'],
];

function speechSegments(): AlignSegment[] {
  return SPEECH.map(([, text], i) => ({ start: i * 5, end: i * 5 + 4.5, text }));
}

function accuracy(labels: Array<number | null>, truth: Array<number | null>): number {
  return labels.filter((l, i) => l === truth[i]).length / truth.length;
}

describe('slide aligner (lexical DP, DESIGN §22)', () => {
  test('text features: Hangul transliterations share a skeleton with the English term', () => {
    assert.deepEqual(tokens('FIRST셋은 LL(1)'), ['first', '셋은', 'll', '1']);
    const english = skeletons('first')[0];
    const hangul = skeletons('퍼스트')[0];
    assert.equal(english, hangul, `${english} vs ${hangul}`);
    assert.equal(skeletons('follow')[0], skeletons('팔로우')[0]);
    assert.ok(features('FOLLOW sets', { skelLatinOnly: true }).skel.size > 0);
  });

  test('a synthetic Korean lecture against English slides + Korean digests: ≥ 85 % of segments on the right slide', () => {
    const truth = SPEECH.map(([slide]) => slide);
    const labels = alignSegments({ slideTexts: SLIDES, segments: speechSegments() });
    const acc = accuracy(labels, truth);
    assert.ok(acc >= 0.85, `accuracy ${acc.toFixed(2)}: ${JSON.stringify(labels)}`);
    // Monotone: the lecture never runs backwards here.
    const slides = labels.filter((l): l is number => l !== null);
    for (let i = 1; i < slides.length; i++) assert.ok(slides[i] >= slides[i - 1] - 1, JSON.stringify(labels));
  });

  test('markers are hard constraints: a slide start, and "not about a slide" until the next marker', () => {
    const segs = speechSegments();
    // Force slide 6 from segment 20 on (the lexical evidence says 7 there), and off-slide for segments 11–13.
    const markers = [
      { t: 11 * 5, slide: null },
      { t: 14 * 5, slide: 5 },
      { t: 20 * 5, slide: 6 },
    ];
    const labels = alignSegments({ slideTexts: SLIDES, segments: segs, markers });
    assert.equal(labels[11], null);
    assert.equal(labels[12], null);
    assert.equal(labels[13], null);
    assert.equal(labels[14], 5);
    assert.equal(labels[20], 6);
    // Before a start marker the frontier stays below its slide.
    for (let i = 0; i < 14; i++) assert.ok(labels[i] === null || (labels[i] as number) < 5, `segment ${i}: ${labels[i]}`);
    const constraints = markerConstraints(segs, markers, SLIDES.length);
    assert.deepEqual(
      constraints.filter((c) => c.label === null).map((c) => c.seg),
      [11, 12, 13],
    );
    assert.equal(constraints.find((c) => c.label === 5)?.front, true);
  });

  test('contradictory markers: the oldest is dropped, the newest still hold', () => {
    const segs = speechSegments();
    // "slide 7 starts at segment 5" and "slide 3 starts at segment 8" cannot both be starts (3 < 7 = a revisit),
    // plus an impossible pair on one segment region.
    const labels = alignSegments({
      slideTexts: SLIDES,
      segments: segs,
      markers: [
        { t: 5 * 5, slide: 7 },
        { t: 8 * 5, slide: 3 },
      ],
    });
    assert.equal(labels[5], 7);
    assert.equal(labels[8], 3);
  });

  test('re-solving with markers is fast for an hour of speech (≈ 540 segments × 49 slides)', () => {
    const slides = Array.from({ length: 49 }, (_, i) => `${SLIDES[i % SLIDES.length]} part ${i + 1} 슬라이드 ${i + 1}`);
    const segs = Array.from({ length: 540 }, (_, i) => ({ start: i * 6.6, end: i * 6.6 + 6, text: SPEECH[i % SPEECH.length][1] }));
    const t0 = performance.now();
    const labels = alignSegments({ slideTexts: slides, segments: segs, markers: [{ t: 1200, slide: 20 }] });
    const ms = performance.now() - t0;
    assert.equal(labels.length, 540);
    assert.ok(ms < 5_000, `took ${ms.toFixed(0)} ms`);
  });

  test('large decks use a band of back-excursions (memory stays bounded) and still advance', () => {
    const N = 300;
    const T = 600;
    // Emissions that point at slide floor(t / 2) + 1.
    const E = Array.from({ length: T }, (_, t) => Array.from({ length: N }, (_, s) => (s === Math.floor(t / 2) ? 3 : 0)));
    const En = Array.from({ length: T }, () => -2);
    const labels = viterbi(E, En, DEFAULT_DP);
    assert.equal(labels[0], 1);
    assert.equal(labels[T - 1], T / 2);
  });

  test('live timeline prior: the slide the student viewed wins unless the text says otherwise', () => {
    // Generic speech (no lexical evidence) follows the timeline exactly.
    const generic = Array.from({ length: 12 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: '음 그러니까 이거는 이렇게 되는 거예요' }));
    const events = [
      { t: 0, slide: 2 },
      { t: 40, slide: 3 },
      { t: 80, slide: 4 },
    ];
    const prior = timelinePrior(generic, events, 120);
    assert.deepEqual(prior, [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    const labels = alignSegments({ slideTexts: SLIDES, segments: generic, prior });
    assert.deepEqual(labels, prior);
  });

  test('dwell rule: a short look ahead or back is the student, not the lecture', () => {
    const spans = lectureSpans(
      [
        { t: 0, slide: 3 },
        { t: 20, slide: 4 }, // peek ahead for 2 s
        { t: 22, slide: 3 },
        { t: 60, slide: 1 }, // look back for 10 s
        { t: 70, slide: 3 },
        { t: 100, slide: 4 }, // real move
      ],
      200,
    );
    assert.deepEqual(
      spans.map((s) => [s.slide, s.from]),
      [
        [3, 0],
        [4, 100],
      ],
    );
  });

  test('LLM votes are soft: they decide where the text is silent', () => {
    const generic = Array.from({ length: 6 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: '네 이건 중요합니다' }));
    const llm = [1, 1, 2, 2, null, 3];
    const labels = alignSegments({ slideTexts: SLIDES, segments: generic, llm });
    assert.deepEqual(labels.slice(0, 4), [1, 1, 2, 2]);
    assert.equal(labels[5], 3);
  });

  test('a deck without any text: segments stay off-slide unless the timeline or a marker says otherwise', () => {
    const segs = speechSegments().slice(0, 6);
    assert.deepEqual(alignSegments({ slideTexts: ['', ' ', '\n'], segments: segs }), [null, null, null, null, null, null]);
    assert.deepEqual(alignSegments({ slideTexts: ['', '', ''], segments: segs, prior: [1, 1, 2, 2, 3, 3] }), [1, 1, 2, 2, 3, 3]);
    assert.equal(alignSegments({ slideTexts: ['', '', ''], segments: segs, markers: [{ t: 10, slide: 2 }] })[2], 2);
  });

  test('the worker thread gives the same answer as the in-process aligner', async () => {
    const input = { slideTexts: SLIDES, segments: speechSegments(), markers: [{ t: 55, slide: null }] };
    assert.deepEqual(await alignInWorker(input), alignSegments(input));
  });

  test('emissions: z-scores clipped, null level adapts to the recording', () => {
    const { E, En } = emissions(
      [
        [1, 0, 0],
        [0, 0.5, 0.5],
      ],
      ['가나다라마바사아자차카타파하 가나다라마바사아자차카타파하', 'x'],
    );
    assert.ok(E[0][0] > E[0][1]);
    assert.ok(E[0][0] <= 2 * 3);
    assert.equal(En.length, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Segmenter
// ---------------------------------------------------------------------------------------------------------------

function checkTiling(windows: AsrWindow[], totalMs: number): void {
  assert.equal(windows[0].ownStartMs, 0);
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].i, i);
    assert.equal(windows[i].ownStartMs, windows[i - 1].ownEndMs, `window ${i} does not follow ${i - 1}`);
  }
  assert.equal(windows.at(-1)?.ownEndMs, totalMs);
}

describe('ASR windows (segmenter)', () => {
  test('live preset: windows of 20–30 s cut in pauses tile the recording; fed in odd pieces', () => {
    const tones = Array.from({ length: 50 }, (_, k) => ({ start: k * 2, end: k * 2 + 1.4, hz: 300 + 20 * k }));
    const pcm = tonesPcm(100, tones);
    const seg = new Segmenter({ preset: WINDOW_PRESETS.live });
    const windows: AsrWindow[] = [];
    for (let at = 0; at < pcm.length; at += 12_346) {
      seg.feed(pcm.subarray(at, Math.min(pcm.length, at + 12_346)), at);
      windows.push(...seg.poll());
    }
    windows.push(...seg.poll(true));
    checkTiling(windows, 100_000);
    for (const w of windows.slice(0, -1)) {
      assert.equal(w.cut, 'silence');
      const len = w.ownEndMs - w.ownStartMs;
      assert.ok(len >= 20_000 && len <= 30_000, `window ${w.i}: ${len} ms`);
      assert.equal(w.startMs, w.ownStartMs);
    }
  });

  test('no pause: a hard cut at 30 s in the quietest spot, the next window overlaps by 1 s', () => {
    // 1.3 s tones with 100 ms gaps: no silence of 200 ms anywhere.
    const tones = Array.from({ length: 50 }, (_, k) => ({ start: k * 1.4, end: k * 1.4 + 1.3, hz: 300 + 20 * k }));
    const pcm = tonesPcm(70, tones);
    const seg = new Segmenter({ preset: WINDOW_PRESETS.live });
    seg.feed(pcm, 0);
    const windows = [...seg.poll(), ...seg.poll(true)];
    checkTiling(windows, 70_000);
    assert.equal(windows[0].cut, 'max');
    assert.equal(windows[1].startMs, windows[1].ownStartMs - 1000);
  });

  test('pauses force a cut (break) even inside a window; restore continues after the last window', () => {
    const pcm = tonesPcm(40, [{ start: 0, end: 39, hz: 440 }]);
    const seg = new Segmenter({ preset: WINDOW_PRESETS.live });
    seg.feed(pcm.subarray(0, 32000 * 7), 0);
    seg.addBreak(7000);
    const first = seg.poll();
    assert.deepEqual(
      first.map((w) => [w.ownStartMs, w.ownEndMs, w.cut]),
      [[0, 7000, 'break']],
    );
    // Restart: a new segmenter restored from the persisted window, fed from resumeByte.
    const again = new Segmenter({ preset: WINDOW_PRESETS.live });
    again.restore(first[0]);
    again.skipTo(again.resumeByte());
    again.feed(pcm.subarray(again.resumeByte()), again.resumeByte());
    const rest = [...again.poll(), ...again.poll(true)];
    checkTiling([...first, ...rest], 40_000);
  });

  test('upload preset: chunks of at most 15 minutes', () => {
    const seg = new Segmenter({ preset: WINDOW_PRESETS.upload });
    // 40 minutes of tones with a pause every 20 s (fed without allocating 77 MB at once).
    const minute = tonesPcm(60, [
      { start: 0, end: 19.5, hz: 400 },
      { start: 20, end: 39.5, hz: 500 },
      { start: 40, end: 59.5, hz: 600 },
    ]);
    for (let m = 0; m < 40; m++) seg.feed(minute, m * minute.length);
    const windows = [...seg.poll(), ...seg.poll(true)];
    checkTiling(windows, 40 * 60_000);
    for (const w of windows) assert.ok(w.ownEndMs - w.ownStartMs <= 15 * 60_000);
    assert.ok(windows.length >= 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// whisper-cli, ffmpeg, WAV, HTTP ranges, AI prompt
// ---------------------------------------------------------------------------------------------------------------

describe('engine glue', () => {
  test('engine lookup order: EASY_STUDY_WHISPER, (desktop sidecar), <repo>/.cache/whisper/bin, PATH; ffmpeg: env, PATH', async () => {
    const bin = path.join(tmp, 'pathdir');
    await fs.mkdir(bin, { recursive: true });
    const exe = (name: string) => path.join(bin, process.platform === 'win32' ? `${name}.exe` : name);
    await fs.writeFile(exe('whisper-cli'), '#!/bin/sh\n');
    await fs.writeFile(exe('ffmpeg'), '#!/bin/sh\n');
    await fs.chmod(exe('whisper-cli'), 0o755);
    await fs.chmod(exe('ffmpeg'), 0o755);
    assert.deepEqual(findWhisper({ EASY_STUDY_WHISPER: '/opt/w/whisper-cli', PATH: bin }), { path: path.resolve('/opt/w/whisper-cli'), source: 'env' });
    const repoBuild = path.join(repoRoot(), '.cache', 'whisper', 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    const found = findWhisper({ PATH: bin });
    if (existsSync(repoBuild)) assert.deepEqual(found, { path: repoBuild, source: 'repo' });
    else assert.deepEqual(found, { path: exe('whisper-cli'), source: 'path' });
    assert.equal(findWhisper({ PATH: path.join(tmp, 'nothing-here') })?.source ?? 'none', existsSync(repoBuild) ? 'repo' : 'none');
    assert.deepEqual(findFfmpeg({ EASY_STUDY_FFMPEG: '/opt/f/ffmpeg' }), { path: path.resolve('/opt/f/ffmpeg'), source: 'env' });
    assert.deepEqual(findFfmpeg({ PATH: bin }), { path: exe('ffmpeg'), source: 'path' });
    assert.equal(findFfmpeg({ PATH: path.join(tmp, 'nothing-here') }), null);
    assert.equal(acceleration('darwin', 'arm64'), 'metal');
    assert.equal(acceleration('darwin', 'x64'), 'cpu');
    assert.equal(acceleration('linux', 'arm64'), 'cpu');
  });

  test('whisper-cli arguments follow the ASR spike (beam default, forced language, VAD, -ojf)', () => {
    const args = whisperArgs({ bin: 'w', model: '/m/turbo.bin', vadModel: '/m/vad.bin', wav: '/r/a.wav', outBase: '/r/out', language: 'ko', threads: 4 });
    assert.deepEqual(args, ['-m', '/m/turbo.bin', '-f', '/r/a.wav', '-l', 'ko', '-t', '4', '--vad', '-vm', '/m/vad.bin', '-ojf', '-of', '/r/out', '-pp']);
    for (const banned of ['--prompt', '-ml', '--dtw', '-nfa', '-bs', '-np']) assert.equal(args.includes(banned), false, banned);
  });

  test('whisper -pp progress lines are read even when split across chunks', () => {
    const seen: number[] = [];
    const read = progressReader((f) => seen.push(f));
    read('whisper_init_state: kv self size = 1 MB\nwhisper_print_progress_callback: progr');
    read('ess =   5%\nwhisper_print_progress_callback: progress =  50%\n');
    read('whisper_print_progress_callback: progress = 100%\n');
    assert.deepEqual(seen, [0.05, 0.5, 1]);
  });

  test('segments of a window: on the recording clock; overlap after a hard cut decided by midpoint, nothing else dropped', () => {
    const win = (w: Partial<AsrWindow>): AsrWindow => ({ i: 0, startMs: 0, endMs: 0, ownStartMs: 0, ownEndMs: 0, cut: 'silence', speechMs: 5000, ...w });
    // A window cut in a pause: the next one starts at its end, so text stamped slightly past the end stays (clamped).
    const silence = win({ startMs: 40_000, endMs: 64_000, ownStartMs: 40_000, ownEndMs: 64_000, cut: 'silence' });
    assert.deepEqual(ownSegments(silence, [
      { start: 0.5, end: 3, text: 'a' },
      { start: 23.2, end: 24.9, text: 'b' },
    ]), [
      { start: 40.5, end: 43, text: 'a' },
      { start: 63.2, end: 64, text: 'b' },
    ]);
    // A hard cut at 30 s: the next window starts 1 s earlier and hears the end again, so text past the cut is its.
    const hard = win({ startMs: 0, endMs: 30_000, ownStartMs: 0, ownEndMs: 30_000, cut: 'max' });
    assert.deepEqual(ownSegments(hard, [
      { start: 27, end: 29.5, text: 'mine' },
      { start: 29.6, end: 30, text: 'cut word' },
    ]).map((s) => s.text), ['mine', 'cut word']);
    assert.deepEqual(ownSegments(hard, [{ start: 29.5, end: 31, text: 'past' }]), []);
    // The window after it: what it hears before its own start belongs to the previous window.
    const next = win({ i: 1, startMs: 29_000, endMs: 52_000, ownStartMs: 30_000, ownEndMs: 52_000, cut: 'silence' });
    assert.deepEqual(ownSegments(next, [
      { start: 0, end: 0.8, text: 'heard twice' },
      { start: 0.5, end: 2.5, text: 'straddles' },
      { start: 3, end: 5, text: 'new' },
    ]).map((s) => [s.start, s.text]), [[29.5, 'straddles'], [32, 'new']]);
  });

  test('whisper JSON: invalid UTF-8 removed, special tokens skipped, repetition loops cut, long segments split by token time', () => {
    const long = {
      offsets: { from: 10_000, to: 40_000 },
      text: ' First sentence here. Second sentence follows now. Third one ends it.',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
        // VAD-compressed token times (0..6 s), remapped into 10..40 s
        { text: ' First sentence here.', offsets: { from: 0, to: 2000 } },
        { text: ' Second sentence follows now.', offsets: { from: 2000, to: 4000 } },
        { text: ' Third one ends it.', offsets: { from: 4000, to: 6000 } },
      ],
    };
    const json = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { offsets: { from: 0, to: 2000 }, text: ' 배타�� 연산' },
        { offsets: { from: 2000, to: 3000 }, text: '감사합니다.' },
        { offsets: { from: 3000, to: 4000 }, text: '감사합니다.' },
        { offsets: { from: 4000, to: 5000 }, text: '감사합니다.' },
        { offsets: { from: 5000, to: 6000 }, text: '   ' },
        long,
      ],
    });
    const { segments, language } = parseWhisperJson(json);
    assert.equal(language, 'en');
    assert.equal(segments[0].text, '배타 연산');
    assert.equal(segments.filter((s) => s.text === '감사합니다.').length, 2);
    const pieces = segments.filter((s) => s.start >= 10);
    assert.deepEqual(
      pieces.map((p) => [p.start, p.end, p.text]),
      [
        [10, 20, 'First sentence here.'],
        [20, 30, 'Second sentence follows now.'],
        [30, 40, 'Third one ends it.'],
      ],
    );
  });

  test('upload sniffing by content, not by name', () => {
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from(`ftyp${brand}`), Buffer.alloc(20)]);
    assert.equal(sniffMedia(ftyp('M4A '), 'x.bin')?.ext, 'm4a');
    assert.equal(sniffMedia(ftyp('isom'), 'lecture.mp4')?.ext, 'mp4');
    assert.equal(sniffMedia(ftyp('qt  '))?.ext, 'mov');
    assert.equal(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))?.ext, 'webm');
    assert.equal(sniffMedia(Buffer.from('OggS\0\x02'))?.ext, 'ogg');
    assert.equal(sniffMedia(Buffer.from('ID3\x04\0\0'))?.ext, 'mp3');
    assert.equal(sniffMedia(Buffer.from([0xff, 0xfb, 0x90, 0x44]))?.ext, 'mp3');
    assert.equal(sniffMedia(Buffer.from([0xff, 0xf1, 0x50, 0x80]))?.ext, 'aac');
    assert.equal(sniffMedia(wavHeader(100))?.ext, 'wav');
    assert.equal(sniffMedia(Buffer.from('fLaC\0\0'))?.ext, 'flac');
    assert.equal(sniffMedia(Buffer.from('%PDF-1.7\n'), 'lecture.m4a'), null);
    assert.equal(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), 'a.mp3'), null);
    assert.equal(sniffMedia(Buffer.alloc(0)), null);
  });

  test('ffmpeg: one pass, argument array, readable errors', () => {
    const args = ffmpegArgs('/r/source.m4a', '/r/asr.wav.tmp', '/r/playback.m4a.tmp');
    assert.deepEqual(args.slice(0, 6), ['-nostdin', '-hide_banner', '-nostats', '-y', '-i', '/r/source.m4a']);
    assert.ok(args.includes('pcm_s16le') && args.includes('16000') && args.includes('+faststart') && args.includes('64k'));
    assert.equal(args.filter((a) => a === '0:a:0').length, 2);
    assert.equal(conversionError(Object.assign(new Error('x'), { exitCode: 183, stderr: 'moov atom not found' })), '파일이 손상되었거나 업로드가 끝나지 않았습니다');
    assert.equal(conversionError(Object.assign(new Error('x'), { exitCode: 234, stderr: "Stream map '0:a:0' matches no streams." })), '오디오 트랙이 없습니다');
    assert.match(conversionError(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), /ffmpeg를 찾을 수 없습니다/);
    assert.equal(parseDuration('  Duration: 01:00:00.02, start: 0'), 3600.02);
  });

  test('WAV: header, data chunk behind a LIST chunk, slices copied in pieces', async () => {
    const pcm = tonesPcm(3, [{ start: 0.5, end: 2, hz: 440 }]);
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([10, 0, 0, 0]), Buffer.from('INFOabcdef')]);
    const header = wavHeader(pcm.length);
    // RIFF header (12) + fmt chunk (24) + LIST chunk + data chunk
    const file = path.join(tmp, 'list.wav');
    await fs.writeFile(file, Buffer.concat([header.subarray(0, 36), list, header.subarray(36), pcm]));
    const info = await readWavInfo(file);
    assert.equal(info.sampleRate, 16000);
    assert.equal(info.channels, 1);
    assert.equal(info.dataBytes, pcm.length);
    const out = path.join(tmp, 'slice.wav');
    const written = await writeWavSlice(file, info.dataOffset, 32000, 64000, out);
    assert.equal(written, 32000);
    const slice = await fs.readFile(out);
    assert.equal(slice.readUInt32LE(40), 32000);
    assert.ok(slice.subarray(44).equals(pcm.subarray(32000, 64000)));
  });

  test('Range header parsing', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=500-5000', 1000), { start: 500, end: 999 });
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
    assert.equal(parseRange(undefined, 1000), null);
  });

  test('AI alignment prompt: rich deck, no draft, runs parsed and holes filled', () => {
    const deck = [
      { slide: 1, title: 'Intro', digest: '# Intro\n핵심: 컴파일러의 단계', text: 'Compiler phases overview' },
      { slide: 2, title: '', digest: '', text: 'FIRST sets' },
    ];
    assert.equal(deckLines(deck), 'S1 | Intro | 컴파일러의 단계 | slide text: Compiler phases overview\nS2 | (title slide) |  | slide text: FIRST sets');
    const [part] = buildAlignPrompt(deck, [{ start: 65, text: '퍼스트 셋' }], 150, 1);
    assert.equal(part.type, 'text');
    const text = part.type === 'text' ? part.text : '';
    assert.match(text, /\[150\] 1:05 퍼스트 셋/);
    assert.match(text, /Before segment 150, the lecturer was on slide 1/);
    assert.doesNotMatch(text, /draft/i);
    assert.deepEqual(parseAlignRuns('Here: [{"from":150,"to":151,"slide":2},{"from":153,"to":153,"slide":null},{"from":154,"to":154,"slide":99}]', 150, 5, 2), [2, 2, 2, null, null]);
    assert.throws(() => parseAlignRuns('no json', 0, 3, 2));
  });

  test('speech caps keep whole characters', () => {
    assert.equal(capStart('가나다라마', 3), '가나…');
    assert.equal(capEnd('가나다라마', 3), '…라마');
    assert.equal(capStart('abc', 3), 'abc');
  });
});
