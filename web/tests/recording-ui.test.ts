// 녹음 tab logic (DESIGN §22): time ↔ segment ↔ slide mapping ("슬라이드 따라가기", slide headers), the
// "여기부터 p.N" marker reducer, and the Korean copy (status badges, microphone errors, uploads).
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { AsrStatus, RecordingInfo, TranscriptSegment } from '../../shared/types.ts';
import { ApiError, busyRecordingOf, createLiveRecording, finishRecordingOnServer } from '../src/api.ts';
import { MAX_RECORDING_UPLOAD_BYTES } from '../../shared/types.ts';
import {
  aiAlignModelLabel,
  alignmentLabel,
  asrProblem,
  detectPlatform,
  downloadFraction,
  durationLine,
  effectiveModel,
  formatSize,
  isInProgress,
  isRecordingFile,
  micErrorMessage,
  recordingFileProblem,
  recordingLanguageLabel,
  recordingStatus,
  recordingUnavailableReason,
  titleFromFileName,
  transcriptFraction,
  transcriptionBlocker,
} from '../src/lib/recording/labels.ts';
import {
  markerAtSegment,
  markerLabel,
  markersReducer,
  normalizeMarkers,
  parseStoredMarkers,
  previewMarkers,
  sameMarkers,
} from '../src/lib/recording/markers.ts';
import {
  formatClock,
  formatSpan,
  groupBySlide,
  groupsOfSlide,
  pastLoadedEnd,
  recentMinutes,
  segmentIndexAt,
  slideAtTime,
  sortSegments,
  speechSecondsBySlide,
  transcriptLag,
} from '../src/lib/recording/timeline.ts';

function seg(id: number, start: number, end: number, slide: number | null): TranscriptSegment {
  return { id, start, end, text: `s${id}`, slide };
}

// A lecture: slides 1, 2, an announcement (off-slide), back to 2, then a look back at 1 and on to 3.
const lecture: TranscriptSegment[] = [
  seg(0, 0.5, 4, 1),
  seg(1, 4.2, 9, 1),
  seg(2, 9.5, 15, 2),
  seg(3, 15.2, 18, null),
  seg(4, 18.5, 25, 2),
  seg(5, 26, 30, 1),
  seg(6, 31, 40, 3),
];

describe('time ↔ segment ↔ slide', () => {
  test('formatClock / formatSpan', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(65.9), '1:05');
    assert.equal(formatClock(3723), '1:02:03');
    assert.equal(formatClock(-4), '0:00');
    assert.equal(formatClock(Number.NaN), '0:00');
    assert.equal(formatSpan(45), '45초');
    assert.equal(formatSpan(192), '3분 12초');
    assert.equal(formatSpan(180), '3분');
    assert.equal(formatSpan(3720), '1시간 2분');
  });

  test('segmentIndexAt: the last segment started at or before t (a pause keeps the earlier one)', () => {
    assert.equal(segmentIndexAt(lecture, 0), -1);
    assert.equal(segmentIndexAt(lecture, 0.5), 0);
    assert.equal(segmentIndexAt(lecture, 4.1), 0); // between two segments
    assert.equal(segmentIndexAt(lecture, 12), 2);
    assert.equal(segmentIndexAt(lecture, 1000), 6);
    assert.equal(segmentIndexAt([], 5), -1);
  });

  test('slideAtTime follows the discussed slide; off-slide speech keeps the slide before it', () => {
    assert.equal(slideAtTime(lecture, 0), 1); // before the first segment: where it will start
    assert.equal(slideAtTime(lecture, 10), 2);
    assert.equal(slideAtTime(lecture, 16), 2); // the announcement
    assert.equal(slideAtTime(lecture, 27), 1); // looked back
    assert.equal(slideAtTime(lecture, 35), 3);
    assert.equal(slideAtTime([seg(0, 0, 3, null)], 1), null);
    assert.equal(slideAtTime([], 1), null);
  });

  test('groupBySlide: runs for the slide headers; groupsOfSlide keeps each return to a slide apart', () => {
    const groups = groupBySlide(lecture);
    assert.deepEqual(
      groups.map((g) => [g.slide, g.start, g.segments.length]),
      [
        [1, 0.5, 2],
        [2, 9.5, 1],
        [null, 15.2, 1],
        [2, 18.5, 1],
        [1, 26, 1],
        [3, 31, 1],
      ],
    );
    assert.deepEqual(groupsOfSlide(lecture, 1).map((g) => g.start), [0.5, 26]);
    assert.deepEqual(groupsOfSlide(lecture, 9), []);
  });

  test('sortSegments and speech per slide', () => {
    const shuffled = [lecture[3], lecture[0], lecture[6]];
    assert.deepEqual(sortSegments(shuffled).map((s) => s.id), [0, 3, 6]);
    const secs = speechSecondsBySlide(lecture);
    assert.equal(Math.round(secs.get(1)! * 10) / 10, 3.5 + 4.8 + 4);
    assert.equal(secs.has(0), false);
  });

  test('the player of a live recording is reloaded before seeking past what it loaded', () => {
    // A live WAV has the length it had when it was loaded (186 s of a recording now 224 s long).
    assert.equal(pastLoadedEnd(186.45, 218), true);
    assert.equal(pastLoadedEnd(186.45, 186.3), true, 'the last moment: the end would come at once');
    assert.equal(pastLoadedEnd(186.45, 120), false);
    assert.equal(pastLoadedEnd(Number.NaN, 5), true, 'nothing loaded yet');
    assert.equal(pastLoadedEnd(Number.POSITIVE_INFINITY, 5), true);
  });

  test('recent minutes for the composer chip and the transcript lag', () => {
    assert.equal(recentMinutes(0), 0);
    assert.equal(recentMinutes(20), 1);
    assert.equal(recentMinutes(61), 2);
    assert.equal(recentMinutes(3600), 3);
    assert.equal(recentMinutes(3600, 5), 5);
    assert.equal(transcriptLag(100, 90), 10);
    assert.equal(transcriptLag(90, 100), 0);
  });
});

describe('"여기부터 p.N" markers', () => {
  test('add keeps them sorted; the same place is replaced by the newer marker', () => {
    let m = markersReducer([], { type: 'add', t: 30, slide: 4 });
    m = markersReducer(m, { type: 'add', t: 10.123, slide: 2 });
    m = markersReducer(m, { type: 'add', t: 30.2, slide: 5 });
    assert.deepEqual(m, [
      { t: 10.12, slide: 2 },
      { t: 30.2, slide: 5 },
    ]);
    m = markersReducer(m, { type: 'add', t: 50, slide: null });
    assert.equal(markerLabel(m[2]), '여기부터 슬라이드 밖');
    assert.equal(markerLabel(m[0]), '여기부터 p.2');
  });

  test('remove / clear / set', () => {
    const m = normalizeMarkers([
      { t: 5, slide: 1 },
      { t: 20, slide: 2 },
    ]);
    assert.deepEqual(markersReducer(m, { type: 'remove', t: 20.3 }), [{ t: 5, slide: 1 }]);
    assert.deepEqual(markersReducer(m, { type: 'remove', t: 12 }), m);
    assert.deepEqual(markersReducer(m, { type: 'clear' }), []);
    assert.deepEqual(markersReducer([], { type: 'set', markers: [{ t: 9, slide: 3 }, { t: 1, slide: 1 }] }), [
      { t: 1, slide: 1 },
      { t: 9, slide: 3 },
    ]);
  });

  test('invalid slides and times are refused (the list stays as it was)', () => {
    const m = [{ t: 5, slide: 1 }];
    assert.deepEqual(markersReducer(m, { type: 'add', t: 9, slide: 0 }), m);
    assert.deepEqual(markersReducer(m, { type: 'add', t: 9, slide: 1.5 }), m);
    assert.deepEqual(markersReducer(m, { type: 'add', t: Number.NaN, slide: 2 }), m);
    assert.deepEqual(markersReducer(m, { type: 'add', t: 9, slide: 43 }, 42), m);
    assert.deepEqual(markersReducer(m, { type: 'add', t: -3, slide: 2 }), [
      { t: 0, slide: 2 },
      { t: 5, slide: 1 },
    ]);
  });

  test('sameMarkers, markerAtSegment, the preview and stored markers', () => {
    const m = normalizeMarkers([{ t: 18.5, slide: 3 }]);
    assert.ok(sameMarkers(m, [{ t: 18.5, slide: 3 }]));
    assert.ok(!sameMarkers(m, [{ t: 18.5, slide: 4 }]));
    assert.deepEqual(markerAtSegment(m, lecture[4]), { t: 18.5, slide: 3 });
    assert.equal(markerAtSegment(m, lecture[5]), null);
    const preview = previewMarkers(lecture, m);
    assert.equal(preview[4].slide, 3);
    assert.equal(preview[5].slide, 1); // the server decides the rest
    assert.equal(lecture[4].slide, 2); // not mutated
    assert.deepEqual(parseStoredMarkers([{ t: 3, slide: null }, { t: 'x' }, 7]), [{ t: 3, slide: null }]);
    assert.deepEqual(parseStoredMarkers('nope'), []);
  });
});

function info(patch: Partial<RecordingInfo> = {}): RecordingInfo {
  return {
    id: 'rec-1',
    docId: 'doc-1',
    title: '녹음',
    source: 'upload',
    status: 'ready',
    language: 'ko',
    model: 'large-v3-turbo-q5_0',
    liveTranscribe: true,
    createdAt: '2026-09-27T00:00:00Z',
    durationSec: 200,
    transcriptStatus: 'ready',
    transcribedSec: 200,
    alignment: 'lexical',
    hasManualMarkers: false,
    playback: { url: '/x', mime: 'audio/mp4' },
    ...patch,
  };
}

describe('recording status copy', () => {
  test('status badges', () => {
    assert.deepEqual(recordingStatus(info({ status: 'recording' })), { text: '녹음 중', tone: 'live', icon: 'live' });
    assert.deepEqual(recordingStatus(info({ status: 'paused' })), { text: '일시정지', tone: 'warn', icon: 'paused' });
    assert.equal(recordingStatus(info({ status: 'converting' })).text, '변환 중');
    assert.equal(recordingStatus(info({ status: 'converting' })).icon, 'waiting');
    assert.equal(recordingStatus(info({ status: 'error', error: '디코딩 실패' })).title, '디코딩 실패');
    assert.equal(recordingStatus(info({ status: 'error', error: '디코딩 실패' })).icon, 'warning');
    assert.equal(recordingStatus(info({ transcriptStatus: 'running', transcribedSec: 50 })).text, '받아쓰기 25%');
    assert.equal(recordingStatus(info({ transcriptStatus: 'queued' })).text, '받아쓰기 대기');
    assert.deepEqual(recordingStatus(info()), { text: '받아쓰기 완료', tone: 'ok', icon: 'done' });
    assert.equal(recordingStatus(info({ transcriptStatus: 'error' })).tone, 'error');
    assert.deepEqual(recordingStatus(info({ transcriptStatus: 'none' })), { text: '받아쓰기 전', tone: 'muted' });
  });

  test('status badge text is plain words: the icon is a separate choice the JSX draws', () => {
    const all = [
      info({ status: 'recording' }),
      info({ status: 'paused' }),
      info({ status: 'converting' }),
      info({ status: 'error' }),
      info({ transcriptStatus: 'queued' }),
      info({ transcriptStatus: 'running', transcribedSec: 50 }),
      info({ transcriptStatus: 'running', durationSec: 0 }),
      info(),
      info({ transcriptStatus: 'error' }),
      info({ transcriptStatus: 'none' }),
    ];
    for (const i of all) assert.doesNotMatch(recordingStatus(i).text, /[\u2190-\u2BFF\u{1F000}-\u{1FFFF}\uFE0F]/u);
  });

  test('language: the setting, or for auto what whisper detected', () => {
    assert.equal(recordingLanguageLabel(info({ language: 'ko' })), '한국어');
    assert.equal(recordingLanguageLabel(info({ language: 'auto' })), '자동 감지');
    assert.equal(recordingLanguageLabel(info({ language: 'auto', detectedLanguage: 'en' })), '자동 감지 (영어)');
    assert.equal(recordingLanguageLabel(info({ language: 'auto', detectedLanguage: 'de' })), '자동 감지 (de)');
    assert.equal(recordingLanguageLabel(info({ language: 'en', detectedLanguage: 'ko' })), '영어', 'a forced language stays');
  });

  test('progress, in-progress, duration line, alignment badge', () => {
    assert.equal(transcriptFraction(info({ transcribedSec: 300 })), 1);
    assert.equal(transcriptFraction(info({ durationSec: 0 })), null);
    assert.equal(isInProgress(info()), false);
    assert.equal(isInProgress(info({ status: 'converting' })), true);
    assert.equal(isInProgress(info({ transcriptStatus: 'queued' })), true);
    assert.equal(durationLine(info()), '3:20');
    assert.equal(
      durationLine(info({ status: 'recording', source: 'live', transcriptStatus: 'running', transcribedSec: 185 })),
      '3:20 · 받아쓰기 3:05까지',
    );
    assert.equal(alignmentLabel('none'), null);
    assert.equal(alignmentLabel('llm')?.text, 'AI 정렬');
  });

  test('models: the chosen one, else the recommended one; sizes; download progress; engine problems', () => {
    const status: AsrStatus = {
      engineAvailable: true,
      acceleration: 'metal',
      ffmpegAvailable: true,
      models: [
        { id: 'large-v3-turbo-q5_0', label: 'turbo', sizeBytes: 574_041_195, installed: false, recommended: true },
        {
          id: 'small-q5_1',
          label: 'small',
          sizeBytes: 190_085_487,
          installed: false,
          recommended: false,
          downloading: { receivedBytes: 95_000_000, totalBytes: 190_000_000 },
        },
      ],
    };
    assert.equal(effectiveModel(status, 'small-q5_1')?.id, 'small-q5_1');
    assert.equal(effectiveModel(status, 'gone')?.id, 'large-v3-turbo-q5_0');
    assert.equal(effectiveModel(null, 'x'), null);
    assert.equal(formatSize(574_041_195), '574 MB');
    assert.equal(formatSize(4 * 1024 ** 3), '4.3 GB');
    assert.equal(downloadFraction(status.models[1]), 0.5);
    assert.equal(downloadFraction(status.models[0]), null);
    assert.equal(asrProblem(status, status.models[0]), null);
    assert.match(asrProblem({ ...status, engineAvailable: false, reason: 'whisper-cli 없음' }, null)!, /whisper-cli 없음/);
  });

  test('a recording that just started: says when it cannot be transcribed yet (engine or model missing)', () => {
    const status: AsrStatus = {
      engineAvailable: true,
      acceleration: 'cpu',
      ffmpegAvailable: false,
      models: [
        { id: 'large-v3-turbo-q5_0', label: 'turbo', sizeBytes: 574_041_195, installed: true, recommended: false },
        { id: 'small-q5_1', label: 'small', sizeBytes: 190_085_487, installed: false, recommended: true },
      ],
    };
    assert.equal(transcriptionBlocker(status, 'large-v3-turbo-q5_0'), null);
    const missing = transcriptionBlocker(status, 'small-q5_1');
    assert.match(missing!, /small \(190 MB\)/);
    assert.match(missing!, /녹음 탭에서 내려받으면/);
    // An unknown model id (older server): nothing to say about it.
    assert.equal(transcriptionBlocker(status, null), null);
    assert.match(transcriptionBlocker({ ...status, engineAvailable: false, reason: 'npm run setup:whisper' }, 'small-q5_1')!, /setup:whisper/);
    assert.match(transcriptionBlocker({ ...status, engineAvailable: false }, null)!, /whisper\.cpp/);
  });

  test('AI 정밀 정렬 names the model the server will use: Haiku when the provider has it, else its default', () => {
    const claude = {
      defaultModel: '',
      models: [
        { id: '', label: '기본값' },
        { id: 'opus', label: 'Opus' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      ],
    };
    assert.equal(aiAlignModelLabel(claude), 'Haiku 4.5');
    assert.equal(aiAlignModelLabel({ defaultModel: 'gpt-5.5', models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] }), 'GPT-5.5');
    assert.equal(aiAlignModelLabel({ defaultModel: '', models: [{ id: '', label: '기본값' }] }), '기본 모델');
  });
});

describe('microphone and origin', () => {
  test('getUserMedia errors become clear Korean messages', () => {
    const err = (name: string) => Object.assign(new Error('x'), { name });
    assert.match(micErrorMessage(err('NotAllowedError'), 'mac'), /시스템 설정 › 개인정보 보호 및 보안 › 마이크/);
    assert.match(micErrorMessage(err('NotAllowedError'), 'mac'), /껐다가 다시 켜 주세요/);
    assert.doesNotMatch(micErrorMessage(err('NotAllowedError'), 'windows'), /껐다가/);
    assert.match(micErrorMessage(err('NotAllowedError'), 'windows'), /데스크톱 앱이 마이크에 액세스/);
    assert.match(micErrorMessage(err('NotFoundError'), 'linux'), /PipeWire 또는 PulseAudio/);
    assert.match(micErrorMessage(err('OverconstrainedError')), /마이크를 찾지 못했어요/);
    assert.match(micErrorMessage(err('NotReadableError')), /다른 앱/);
    assert.match(micErrorMessage(new DOMException('denied', 'NotAllowedError')), /허용되지 않았어요/);
    assert.match(micErrorMessage(err('Weird')), /마이크를 시작하지 못했어요: x/);
  });

  test('an insecure origin explains HTTPS; a secure one with everything can record', () => {
    const base = { isSecureContext: true, hasMediaDevices: true, hasAudioWorklet: true, origin: 'http://127.0.0.1:5180' };
    assert.equal(recordingUnavailableReason(base), null);
    const lan = recordingUnavailableReason({ ...base, isSecureContext: false, hasMediaDevices: false, origin: 'http://study-pc.lan:5180' });
    assert.match(lan!, /http:\/\/study-pc\.lan:5180/);
    assert.match(lan!, /HTTPS/);
    assert.match(lan!, /easy-study 앱으로 그 컴퓨터에 연결/, 'the app records over http through its loopback relay');
    assert.match(recordingUnavailableReason({ ...base, hasAudioWorklet: false })!, /AudioWorklet/);
  });

  test('platform detection', () => {
    assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac');
    assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios'); // iPadOS
    assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
    assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
    assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14)'), 'android');
  });
});

describe('recording uploads', () => {
  test('audio and video by type, or by extension when the type is empty', () => {
    assert.ok(isRecordingFile({ name: 'a.bin', type: 'audio/mp4' }));
    assert.ok(isRecordingFile({ name: 'lecture.MOV', type: '' }));
    assert.ok(isRecordingFile({ name: 'x.m4a', type: '' }));
    assert.ok(!isRecordingFile({ name: 'slides.pdf', type: 'application/pdf' }));
    assert.ok(!isRecordingFile({ name: 'x.txt', type: '' }));
  });

  test('refused before uploading: not audio, empty, too large', () => {
    assert.match(recordingFileProblem({ name: 's.pdf', type: 'application/pdf', size: 10 })!, /오디오·동영상/);
    assert.match(recordingFileProblem({ name: 'a.m4a', type: '', size: 0 })!, /빈 파일/);
    assert.match(recordingFileProblem({ name: 'a.m4a', type: '', size: MAX_RECORDING_UPLOAD_BYTES + 1 })!, /너무 커요/);
    assert.equal(recordingFileProblem({ name: 'a.m4a', type: '', size: 1000 }), null);
    assert.equal(titleFromFileName('3주차 강의.m4a'), '3주차 강의');
    assert.equal(titleFromFileName('.m4a'), '.m4a');
  });
});

describe('a live recording another device left running', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a start refused with 409 names the recording that blocks it; "녹음 끝내기" stops it with what the server has', async () => {
    const blocking = info({ id: 'rec-20260928-090000-abcd', status: 'recording', source: 'live', docId: 'other-doc' });
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null };
      calls.push(call);
      if (call.path.endsWith('/stop')) return Response.json({ ...blocking, status: 'ready' });
      if (call.path === '/api/docs/doc-1/recordings') {
        return Response.json({ error: '이미 녹음 중인 강의가 있습니다', recording: blocking }, { status: 409 });
      }
      return Response.json({ error: 'nope' }, { status: 409 });
    }) as typeof fetch;
    const refused = await createLiveRecording('doc-1', {}).catch((e: unknown) => e);
    assert.ok(refused instanceof ApiError);
    assert.equal(refused.status, 409);
    assert.equal(refused.message, '이미 녹음 중인 강의가 있습니다');
    assert.deepEqual(busyRecordingOf(refused), blocking);
    // Without the recording in the body (or another status), there is nothing to offer.
    const plain = await createLiveRecording('doc-2', {}).catch((e: unknown) => e);
    assert.ok(plain instanceof ApiError && plain.status === 409);
    assert.equal(busyRecordingOf(plain), null);
    assert.equal(busyRecordingOf(new ApiError('x', 409, null, [], { recording: { id: 1 } })), null);
    assert.equal(busyRecordingOf(new ApiError('x', 500, null, [], { recording: blocking })), null);
    assert.equal(busyRecordingOf(new Error('x')), null);
    calls.length = 0;
    const ended = await finishRecordingOnServer(blocking.docId, blocking.id);
    assert.equal(ended.status, 'ready');
    assert.deepEqual(calls, [{ path: `/api/docs/other-doc/recordings/${blocking.id}/stop`, method: 'POST', body: {} }]);
  });
});
