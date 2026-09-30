// The recording UI in English (DESIGN §27): status badges, speech recognition and microphone messages, spans of time,
// markers, the transcript and the playback speed follow the language; Korean stays the reference, byte for byte.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/experimental';
import type { AsrStatus, RecordingInfo, TranscriptSegment } from '../../shared/types.ts';
import { MAX_RECORDING_UPLOAD_BYTES } from '../../shared/types.ts';
import { hangulIn, shapeProblems } from '../../tests/i18nParity.ts';
import { en } from '../src/i18n/en/index.ts';
import { setLang } from '../src/i18n/index.ts';
import { ko } from '../src/i18n/ko/index.ts';
import {
  aiAlignModelLabel,
  alignmentLabel,
  asrProblem,
  durationLine,
  languageLabel,
  micErrorMessage,
  recordingFileProblem,
  recordingLanguageLabel,
  recordingStatus,
  recordingUnavailableReason,
  transcriptionBlocker,
} from '../src/lib/recording/labels.ts';
import { markerLabel, markerShortLabel } from '../src/lib/recording/markers.ts';
import { formatSpan } from '../src/lib/recording/timeline.ts';
import {
  getRecordingSettings,
  parseRecordingSettings,
  setRecordingSettings,
  subscribeRecordingSettings,
} from '../src/lib/recording/settings.ts';

// The components are .tsx (JSX, which Node's type stripping does not take): transpiled on load like markdown.test.ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith('.css') ? { url: 'data:text/javascript,', shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    const { code, errors } = transformSync(fileURLToPath(url), fs.readFileSync(new URL(url), 'utf8'), { jsx: { runtime: 'automatic' } });
    if (errors.length > 0) throw new Error(`${url}: ${errors.map((e) => e.message).join('; ')}`);
    return { format: 'module', source: code, shortCircuit: true };
  },
});
const { Transcript } = await import('../src/components/recording/Transcript.tsx');
const { PlaybackRate } = await import('../src/components/recording/PlaybackRate.tsx');
type TranscriptProps = Parameters<typeof Transcript>[0];

function info(patch: Partial<RecordingInfo> = {}): RecordingInfo {
  return {
    id: 'rec-1',
    docId: 'doc-1',
    title: 'Week 3',
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

const asrStatus: AsrStatus = {
  engineAvailable: true,
  acceleration: 'cpu',
  ffmpegAvailable: true,
  models: [
    { id: 'large-v3-turbo-q5_0', label: 'turbo', sizeBytes: 574_041_195, installed: true, recommended: false },
    { id: 'small-q5_1', label: 'small', sizeBytes: 190_085_487, installed: false, recommended: true },
  ],
};

const err = (name: string) => Object.assign(new Error('x'), { name });

const segments: TranscriptSegment[] = [
  { id: 1, start: 0, end: 4, text: 'Good morning.', slide: null },
  { id: 2, start: 5, end: 9, text: 'Look at this slide.', slide: 2 },
];

const transcriptProps: TranscriptProps = {
  segments,
  mode: 'all',
  focusedSlide: 1,
  pageCount: 3,
  activeId: null,
  playing: false,
  live: false,
  markers: [{ t: 5, slide: 2 }],
  canMark: true,
  onPlayFrom: () => {},
  onGoToSlide: () => {},
  onMarker: () => {},
  scroller: null,
};

const renderTranscript = (patch: Partial<TranscriptProps> = {}) =>
  renderToStaticMarkup(createElement(Transcript, { ...transcriptProps, ...patch }));

describe('recording texts: English against the Korean reference', () => {
  test('the same keys and kinds, no Korean left', () => {
    assert.deepEqual(shapeProblems(ko.recording, en.recording), []);
    assert.deepEqual(hangulIn(en.recording), []);
  });
});

describe('the recording UI in English', () => {
  afterEach(() => setLang('system'));

  test('status badges, alignment, languages and the live duration line', () => {
    setLang('en');
    assert.deepEqual(recordingStatus(info({ status: 'recording' })), { text: 'Recording', tone: 'live', icon: 'live' });
    assert.deepEqual(recordingStatus(info({ transcriptStatus: 'none' })), { text: 'Not transcribed', tone: 'muted' });
    assert.equal(recordingStatus(info({ transcriptStatus: 'running', transcribedSec: 50 })).text, 'Transcribing 25%');
    assert.equal(recordingStatus(info({ status: 'converting' })).title, 'Extracting the audio from the uploaded file');
    assert.equal(recordingStatus(info({ status: 'error', error: 'decode failed' })).title, 'decode failed', 'server text as is');
    assert.equal(alignmentLabel('llm')?.text, 'AI-aligned');
    assert.equal(languageLabel('en'), 'English');
    assert.equal(recordingLanguageLabel(info({ language: 'ko' })), 'Korean');
    assert.equal(recordingLanguageLabel(info({ language: 'auto', detectedLanguage: 'ja' })), 'Auto-detected (Japanese)');
    assert.equal(recordingLanguageLabel(info({ language: 'auto', detectedLanguage: 'de' })), 'Auto-detected (de)');
    assert.equal(recordingLanguageLabel(info({ language: 'auto', detectedLanguage: 'constructor' })), 'Auto-detected (constructor)');
    assert.equal(
      durationLine(info({ status: 'recording', source: 'live', transcriptStatus: 'running', transcribedSec: 185 })),
      '3:20 · transcribed up to 3:05',
    );
    assert.equal(aiAlignModelLabel({ defaultModel: '', models: [{ id: '', label: 'Default' }] }), 'Default model');
  });

  test('speech recognition, microphone, origin and file problems', () => {
    setLang('en');
    assert.equal(asrProblem({ ...asrStatus, engineAvailable: false }, null), "Couldn't find the speech recognition engine (whisper.cpp).");
    assert.equal(
      transcriptionBlocker(asrStatus, 'small-q5_1'),
      "The speech recognition model for transcripts isn't downloaded yet: small (190 MB). " +
        'Once you download it in the Recordings tab, transcription starts — the recording goes on meanwhile.',
    );
    const mac = micErrorMessage(err('NotAllowedError'), 'mac');
    assert.match(mac, /System Settings › Privacy & Security › Microphone/);
    assert.match(mac, /\. If it's on and still doesn't work, turn it off and on again/);
    assert.doesNotMatch(micErrorMessage(err('NotAllowedError'), 'windows'), /turn it off and on/);
    assert.match(micErrorMessage(err('NotFoundError'), 'linux'), /PipeWire or PulseAudio/);
    assert.equal(micErrorMessage(err('Weird')), "Couldn't start the microphone: x");
    assert.equal(micErrorMessage('?'), "Couldn't start the microphone");
    const lan = recordingUnavailableReason({ isSecureContext: false, hasMediaDevices: false, hasAudioWorklet: true, origin: 'http://pc.lan:5180' });
    assert.match(lan!, /^This address \(http:\/\/pc\.lan:5180\) isn't a secure connection \(HTTPS\)/);
    assert.equal(recordingFileProblem({ name: 's.pdf', type: 'application/pdf', size: 10 }), '‘s.pdf’ isn\'t an audio or video file.');
    assert.match(recordingFileProblem({ name: 'a.m4a', type: '', size: MAX_RECORDING_UPLOAD_BYTES + 1 })!, /^‘a\.m4a’ is too large \(max /);
  });

  test('spans of time and markers', () => {
    setLang('en');
    assert.deepEqual([45, 180, 192, 3600, 3720].map(formatSpan), ['45 sec', '3 min', '3 min 12 sec', '1 hr', '1 hr 2 min']);
    assert.equal(markerLabel({ t: 1, slide: 7 }), 'From here: p.7');
    assert.equal(markerLabel({ t: 1, slide: null }), 'From here: off slides');
    assert.equal(markerShortLabel({ t: 1, slide: 7 }), '→ p.7');
    assert.equal(markerShortLabel({ t: 1, slide: null }), '→ off slides');
  });

  test('the transcript and the playback speed render in the language', () => {
    setLang('en');
    const html = renderTranscript();
    assert.match(html, /Off slides/);
    assert.match(html, /title="Play from 0:05"/);
    assert.match(html, /title="Marked by you: From here: p\.2"/);
    assert.match(html, />From here: p\.1</);
    assert.doesNotMatch(html, /[가-힯]/);
    assert.match(renderTranscript({ segments: [] }), /No transcribed sentences yet\./);
    assert.match(renderTranscript({ mode: 'current', focusedSlide: 3, live: true }), /Nothing said on this slide yet\./);
    const rate = renderToStaticMarkup(createElement(PlaybackRate, { rate: 1.25, onChange: () => {} }));
    assert.match(rate, /aria-label="Playback speed 1\.25×"/);
    assert.doesNotMatch(rate, /[가-힯]/);

    setLang('ko');
    assert.match(renderTranscript(), /title="직접 표시한 구간: 여기부터 p\.2"/);
    assert.match(renderToStaticMarkup(createElement(PlaybackRate, { rate: 1.25, onChange: () => {} })), /aria-label="재생 속도 1\.25배속"/);
  });
});

describe('Korean stays byte for byte what it was', () => {
  test('texts no other test pins in full', () => {
    assert.equal(
      micErrorMessage(err('NotAllowedError'), 'mac'),
      '마이크 사용이 허용되지 않았어요. 주소창의 마이크 아이콘에서 이 사이트의 마이크를 허용하고, ' +
        '시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 이 앱(또는 브라우저)이 켜져 있는지 확인해 주세요.' +
        ' 켜져 있는데도 안 되면 껐다가 다시 켜 주세요 (앱을 업데이트한 뒤에 그럴 수 있어요).',
    );
    assert.equal(micErrorMessage('?'), '마이크를 시작하지 못했어요');
    assert.equal(
      recordingUnavailableReason({ isSecureContext: false, hasMediaDevices: true, hasAudioWorklet: true, origin: 'http://pc.lan:5180' }),
      '이 주소(http://pc.lan:5180)는 보안 연결(HTTPS)이 아니라서 브라우저가 마이크를 막아요. ' +
        '녹음하려면 서버 컴퓨터에서 easy-study 앱이나 http://127.0.0.1 주소로 열거나, ' +
        'easy-study 앱으로 그 컴퓨터에 연결하거나(앱 안에서는 http 주소여도 녹음돼요), ' +
        'HTTPS로 접속해 주세요 (예: tailscale serve, 또는 EASY_STUDY_TLS_CERT/KEY). 녹음 파일 올리기는 여기서도 돼요.',
    );
    assert.equal(
      transcriptionBlocker({ ...asrStatus, engineAvailable: false }, null),
      '녹음은 저장되지만 아직 받아쓸 수 없어요: 음성 인식 엔진(whisper.cpp)을 찾지 못했어요.',
    );
    assert.equal(
      transcriptionBlocker(asrStatus, 'small-q5_1'),
      '받아쓰기에 필요한 음성 인식 모델이 아직 없어요: small (190 MB). 녹음 탭에서 내려받으면 그때부터 받아써요 — 녹음은 그대로 계속돼요.',
    );
    assert.equal(recordingFileProblem({ name: 'a.m4a', type: '', size: 0 }), '‘a.m4a’은(는) 빈 파일이에요.');
    assert.equal(recordingStatus(info({ status: 'converting' })).title, '올린 파일에서 소리를 꺼내는 중이에요');
    assert.equal(recordingLanguageLabel(info({ language: 'auto', detectedLanguage: 'zh' })), '자동 감지 (중국어)');
    assert.equal(markerShortLabel({ t: 1, slide: null }), '→ 슬라이드 밖');
    assert.equal(formatSpan(3600), '1시간');
    assert.equal(
      ko.recording.consent.message,
      '교수님과 학교의 녹음 규정을 먼저 확인해 주세요. 수업 녹음을 허락받지 않았다면 녹음하지 마세요.\n' +
        '녹음은 이 컴퓨터(또는 연결한 easy-study 서버)에만 저장되고, 받아쓰기도 그 컴퓨터에서 해요. ' +
        '녹음 파일과 받아쓴 글은 녹음 탭에서 언제든 지울 수 있어요.',
    );
  });
});

// Last in this file: it changes the settings of this (test) process.
describe('the lecture language of new recordings follows the UI language until one is chosen', () => {
  afterEach(() => setLang('system'));

  test('stored settings: a valid language is kept, none (or an invalid one) is the UI language', () => {
    assert.equal(parseRecordingSettings(null).language, 'ko');
    assert.equal(parseRecordingSettings({}, 'en').language, 'en');
    assert.equal(parseRecordingSettings({ language: 'fr' }, 'en').language, 'en');
    assert.equal(parseRecordingSettings({ language: 'auto' }, 'en').language, 'auto');
    assert.equal(parseRecordingSettings({ language: 'ko' }, 'en').language, 'ko');
  });

  test('read at use: a change of the UI language moves it (and tells the subscribers) until the user chooses one', () => {
    let calls = 0;
    const off = subscribeRecordingSettings(() => calls++);
    try {
      const korean = getRecordingSettings();
      assert.equal(korean.language, 'ko');
      assert.equal(getRecordingSettings(), korean, 'the same object while nothing changes');
      setLang('en');
      assert.equal(calls, 1);
      assert.equal(getRecordingSettings().language, 'en');
      setRecordingSettings({ model: 'small-q5_1' });
      assert.deepEqual(getRecordingSettings(), { model: 'small-q5_1', language: 'en', liveTranscribe: true });
      setLang('ko');
      assert.equal(getRecordingSettings().language, 'ko', 'changing the model did not store a language');
      setRecordingSettings({ language: 'auto' });
      setLang('en');
      assert.equal(getRecordingSettings().language, 'auto', 'a chosen language stays');
    } finally {
      off();
    }
  });
});
