// Lecture recordings in English (DESIGN §22, §27): the texts of server/recordings/ follow the request's language;
// the Korean ones stay as they were. A recording's background work (conversion, transcription — also when a restart
// resumes it, or another request's work pumps the queue) writes its errors in the language the recording was made in.
// Run: node --test tests/i18n-recordings.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LANG_HEADER } from '../shared/i18n.ts';
import type { AsrStatus, RecordingInfo } from '../shared/types.ts';
import { repoRoot } from '../server/config.ts';
import { runInLang } from '../server/i18n.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer, ServerOptions } from '../server/index.ts';
import { buildAlignPrompt, deckLines, parseAlignRuns } from '../server/recordings/aiPrompt.ts';
import { clearVersionCache, probeVersion } from '../server/recordings/asr.ts';
import { conversionError } from '../server/recordings/ffmpeg.ts';
import { DEFAULT_CATALOG, ModelStore } from '../server/recordings/models.ts';
import type { ModelCatalog } from '../server/recordings/models.ts';
import { parseLanguage, parseModel } from '../server/recordings/service.ts';
import { defaultLiveTitle, defaultUploadTitle } from '../server/recordings/store.ts';
import { wavHeader } from '../server/recordings/wav.ts';
import { tonesPcm } from './recordingFixtures.ts';

const FAKE_WHISPER = path.join(repoRoot(), 'tests', 'fixtures', 'fake-whisper.mjs');
const FAKE_FFMPEG = path.join(repoRoot(), 'tests', 'fixtures', 'fake-ffmpeg.mjs');
const EN = { [LANG_HEADER]: 'en' };

describe('recordings: AI alignment reads a digest made in English', () => {
  test('the "Key point:" line is the slide\'s takeaway in an English digest, like "핵심:" in a Korean one', () => {
    const english = [
      { slide: 1, title: 'Intro', digest: '# Intro\nCompiler phases.\n\n**Key point:** A compiler works in phases', text: 'Compiler phases overview' },
      { slide: 2, title: 'FIRST', digest: '## FIRST\n- Key points of FIRST\nKey Point: FIRST sets', text: 'FIRST sets' },
    ];
    assert.equal(
      deckLines(english, 'en'),
      [
        'S1 | Intro | A compiler works in phases | slide text: Compiler phases overview',
        'S2 | FIRST | FIRST sets | slide text: FIRST sets',
      ].join('\n'),
    );
    const [part] = buildAlignPrompt(english, [{ start: 0, text: 'phases' }], 0, undefined, 'en');
    assert.ok(part.type === 'text' && part.text.includes('one-line summary in English'));
  });

  test('a Korean digest takes only its own "핵심:" line, the last one: a transcribed English bullet is slide text', () => {
    const korean = [
      { slide: 1, title: 'Parse', digest: '# Parse\n- Key points of parsing: LL, LR\n- 핵심 개념 정리\n\n**핵심:** 파싱', text: 'Parsing' },
      { slide: 2, title: 'LL', digest: '# LL\nKey point: top-down', text: 'LL(1)' },
    ];
    assert.equal(
      deckLines(korean),
      ['S1 | Parse | 파싱 | slide text: Parsing', 'S2 | LL | LL Key point: top-down | slide text: LL(1)'].join('\n'),
    );
  });
});

describe('recordings: texts in the current language', () => {
  test('default titles', () => {
    const at = new Date(2026, 8, 27, 15, 30);
    assert.equal(defaultLiveTitle(at), '녹음 2026-09-27 15:30');
    assert.equal(defaultUploadTitle(at), '녹음 파일 2026-09-27 15:30');
    runInLang('en', () => {
      assert.equal(defaultLiveTitle(at), 'Recording Sep 27, 2026, 3:30 PM');
      assert.equal(defaultUploadTitle(at), 'Recording file Sep 27, 2026, 3:30 PM');
    });
  });

  test('conversion errors', () => {
    const damaged = Object.assign(new Error('x'), { exitCode: 183, stderr: 'moov atom not found' });
    const noAudio = Object.assign(new Error('x'), { exitCode: 234, stderr: "Stream map '0:a:0' matches no streams." });
    const other = Object.assign(new Error('x'), { exitCode: 1, stderr: 'first\nUnknown encoder\n' });
    assert.equal(conversionError(other), '녹음 파일을 변환하지 못했습니다: Unknown encoder');
    assert.equal(conversionError(Object.assign(new Error(''), { exitCode: 1, stderr: '' })), '녹음 파일을 변환하지 못했습니다');
    runInLang('en', () => {
      assert.equal(conversionError(damaged), "The file is damaged or the upload didn't finish");
      assert.equal(conversionError(noAudio), 'The file has no audio track');
      assert.equal(conversionError(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), "Couldn't find ffmpeg. Install ffmpeg or set its path in EASY_STUDY_FFMPEG");
      assert.equal(conversionError(other), "Couldn't convert the recording file: Unknown encoder");
    });
  });

  test('AI alignment replies that cannot be used', () => {
    assert.throws(() => parseAlignRuns('no json', 0, 2, 3), /AI 정렬 결과에서 JSON 배열을 찾을 수 없습니다/);
    runInLang('en', () => {
      assert.throws(() => parseAlignRuns('no json', 0, 2, 3), /^Error: Couldn't find a JSON array in the AI alignment result$/);
      assert.throws(() => parseAlignRuns('[{"a": 1}]', 0, 2, 3), /^Error: The AI alignment result has no ranges$/);
    });
  });

  test('request validation', () => {
    assert.throws(() => parseLanguage('fr'), { status: 400, message: 'language는 ko, en, auto 중 하나여야 합니다' });
    runInLang('en', () => {
      assert.throws(() => parseLanguage('fr'), { status: 400, message: 'language must be ko, en or auto' });
      assert.throws(() => parseModel('huge'), { status: 400, message: 'Unknown speech recognition model: huge' });
    });
    // Without a language the lecture is in the request's language, like the web's default setting.
    assert.equal(parseLanguage(undefined), 'ko');
    assert.equal(runInLang('en', () => parseLanguage(undefined)), 'en');
    assert.equal(runInLang('en', () => parseLanguage('auto')), 'auto');
  });

  test('model labels: the catalog names in the request language; a catalog without labelKey keeps its label', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-i18n-models-'));
    try {
      const store = new ModelStore({ dir: () => dir });
      assert.deepEqual(
        store.list('small-q5_1').map((m) => m.label),
        ['정확 (large-v3-turbo)', '빠름 (small)'],
      );
      assert.deepEqual(
        runInLang('en', () => store.list('small-q5_1').map((m) => m.label)),
        ['Accurate (large-v3-turbo)', 'Fast (small)'],
      );
      const custom: ModelCatalog = { models: [{ ...DEFAULT_CATALOG.models[0], labelKey: undefined, label: 'turbo' }], vad: DEFAULT_CATALOG.vad };
      assert.equal(runInLang('en', () => new ModelStore({ dir: () => dir, catalog: custom }).list('x')[0].label), 'turbo');
      await assert.rejects(runInLang('en', () => store.startDownload('nope')), { status: 404, message: 'Unknown model: nope' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing engine file: the cached probe answers in each caller’s language', async () => {
    clearVersionCache();
    const missing = path.join(os.tmpdir(), 'easy-study-no-such-whisper-cli');
    assert.equal((await runInLang('en', () => probeVersion(missing, '--version', /x/))).error, `File not found: ${missing}`);
    assert.equal((await probeVersion(missing, '--version', /x/)).error, `파일이 없습니다: ${missing}`);
    clearVersionCache();
  });
});

describe('recordings over HTTP in English (fake whisper-cli / ffmpeg)', () => {
  const DOC = 'lecture-en0001';
  const OTHER_DOC = 'other-en0002';
  let tmp = '';
  let library = '';
  let modelsDir = '';
  let server: RunningServer | null = null;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['EASY_STUDY_LIBRARY', 'EASY_STUDY_AUTO_DIGEST', 'EASY_STUDY_WHISPER', 'EASY_STUDY_FFMPEG', 'FAKE_WHISPER_LOG', 'FAKE_WHISPER_FAIL', 'FAKE_FFMPEG_EXIT'];

  const catalog = (): ModelCatalog => ({
    models: [
      { id: 'large-v3-turbo-q5_0', label: 'turbo', labelKey: 'turbo', file: 'turbo.bin', url: 'http://127.0.0.1:9/turbo', sizeBytes: 16, sha256: '0' },
      { id: 'small-q5_1', label: 'small', file: 'small.bin', url: 'http://127.0.0.1:9/small', sizeBytes: 8, sha256: '0' },
    ],
    vad: { file: 'vad.bin', url: 'http://127.0.0.1:9/vad', sizeBytes: 4, sha256: '0' },
  });
  const options = (extra: Partial<ServerOptions> = {}): ServerOptions => ({
    port: 0,
    log: false,
    resumeIngests: false,
    resumeRecordings: false,
    providerInfos: async () => [],
    recordings: { models: new ModelStore({ dir: () => modelsDir, catalog: catalog() }), statusThrottleMs: 20, pingMs: 150 },
    ...extra,
  });

  const call = async <T = { error?: string }>(target: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const raw = Buffer.isBuffer(init.body);
    const res = await fetch(`${server?.url}/api${target}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.body === undefined ? undefined : raw ? (init.body as Buffer) : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const recording = async (docId: string, rid: string) => (await call<RecordingInfo>(`/docs/${docId}/recordings/${rid}`)).body;
  const waitFor = async (predicate: () => Promise<boolean>, what: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`${what} not met in time`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const makeDoc = async (docId: string, title: string) => {
    const dir = path.join(library, docId);
    await fs.mkdir(path.join(dir, 'text'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'doc.json'),
      JSON.stringify({ id: docId, title, fileName: `${title}.pdf`, pageCount: 2, aspectRatio: 4 / 3, status: 'ready', progress: 2, createdAt: new Date().toISOString() }),
    );
    for (let i = 1; i <= 2; i++) await fs.writeFile(path.join(dir, 'text', `00${i}.txt`), `slide ${i}`);
  };
  const tone = tonesPcm(4, [{ start: 0.5, end: 2, hz: 400 }]);
  const wav = Buffer.concat([wavHeader(tone.length), tone]);

  before(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-i18n-rec-')));
    library = path.join(tmp, 'library');
    modelsDir = path.join(tmp, 'models');
    await fs.mkdir(library, { recursive: true });
    await fs.mkdir(modelsDir, { recursive: true });
    await fs.writeFile(path.join(modelsDir, 'turbo.bin'), Buffer.alloc(16));
    await fs.writeFile(path.join(modelsDir, 'small.bin'), Buffer.alloc(8));
    await fs.writeFile(path.join(modelsDir, 'vad.bin'), Buffer.alloc(4));
    process.env.EASY_STUDY_LIBRARY = library;
    process.env.EASY_STUDY_AUTO_DIGEST = '0';
    process.env.EASY_STUDY_WHISPER = FAKE_WHISPER;
    process.env.EASY_STUDY_FFMPEG = FAKE_FFMPEG;
    delete process.env.FAKE_WHISPER_FAIL;
    delete process.env.FAKE_FFMPEG_EXIT;
    await makeDoc(DOC, 'Parsing');
    await makeDoc(OTHER_DOC, 'Other');
    server = await startServer(options());
  });

  after(async () => {
    await server?.close();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test('errors of requests, the engine status and the model labels', async () => {
    assert.deepEqual((await call('/docs/nope-000000/recordings', { headers: EN })).body, { error: 'Document not found' });
    assert.deepEqual((await call(`/docs/${DOC}/recordings/rec-20260101-000000-abcd`, { headers: EN })).body, { error: 'Recording not found' });
    assert.deepEqual((await call(`/docs/${DOC}/recordings/rec-20260101-000000-abcd`)).body, { error: '녹음을 찾을 수 없습니다' });
    assert.deepEqual((await call(`/docs/${DOC}/recordings`, { method: 'POST', body: { language: 'fr' }, headers: EN })).body, {
      error: 'language must be ko, en or auto',
    });
    assert.deepEqual((await call(`/docs/${DOC}/recordings/rec-20260101-000000-abcd`, { method: 'PATCH', body: { title: ' ' }, headers: EN })).body, {
      error: 'Enter a title',
    });
    const pdf = await call(`/docs/${DOC}/recordings/upload`, { method: 'POST', body: Buffer.from('%PDF-1.7 not audio'), headers: EN });
    assert.equal(pdf.status, 415);
    assert.equal(pdf.body.error, 'Not an audio or video file (supported: m4a, mp3, wav, mp4, mov, webm, ogg, flac, aac)');

    const asr = (await call<AsrStatus>('/asr', { headers: EN })).body;
    assert.deepEqual(
      asr.models.map((m) => m.label),
      ['Accurate (large-v3-turbo)', 'small'],
    );
    assert.equal((await call<AsrStatus>('/asr')).body.models[0].label, '정확 (large-v3-turbo)');
    const missing = path.join(tmp, 'no-whisper-cli');
    process.env.EASY_STUDY_WHISPER = missing;
    try {
      assert.equal((await call<AsrStatus>('/asr', { headers: EN })).body.reason, `The transcription engine (whisper-cli) set in EASY_STUDY_WHISPER doesn't exist: ${missing}`);
    } finally {
      process.env.EASY_STUDY_WHISPER = FAKE_WHISPER;
    }
  });

  test('live: default title and the "already recording" conflict in the request language', async () => {
    const created = await call<RecordingInfo>(`/docs/${DOC}/recordings`, { method: 'POST', body: { language: 'ko', liveTranscribe: false }, headers: EN });
    assert.equal(created.status, 201);
    assert.match(created.body.title, /^Recording [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/);
    const meta = JSON.parse(await fs.readFile(path.join(library, DOC, 'recordings', created.body.id, 'meta.json'), 'utf8')) as { lang?: string };
    assert.equal(meta.lang, 'en');
    const title = created.body.title;
    assert.equal((await call(`/docs/${OTHER_DOC}/recordings`, { method: 'POST', body: {}, headers: EN })).body.error, `A lecture is already being recorded (‘${title}’ in ‘Parsing’). Finish that recording first`);
    assert.equal((await call(`/docs/${OTHER_DOC}/recordings`, { method: 'POST', body: {} })).body.error, `이미 녹음 중인 강의가 있습니다 (‘Parsing’의 ‘${title}’). 그 녹음을 먼저 끝내 주세요`);
    assert.equal((await call(`/docs/${DOC}/recordings`, { method: 'POST', body: {}, headers: EN })).body.error, `A lecture is already being recorded (‘${title}’). Finish that recording first`);
    const stale = await call<{ offset: number; error: string }>(`/docs/${DOC}/recordings/${created.body.id}/audio?offset=64`, {
      method: 'POST',
      body: Buffer.alloc(64),
      headers: { ...EN, 'Content-Type': 'application/octet-stream' },
    });
    assert.deepEqual(stale, { status: 409, body: { offset: 0, error: 'offset 64 is past the stored end (0). Send again from that point' } });
    assert.equal((await call(`/docs/${DOC}/recordings/${created.body.id}`, { method: 'DELETE' })).status, 204);
  });

  test('transcription errors are written in the recording’s language, whoever pumps the queue', async () => {
    process.env.FAKE_WHISPER_LOG = path.join(tmp, 'whisper.log');
    process.env.FAKE_WHISPER_FAIL = '3';
    try {
      const created = await call<RecordingInfo>(`/docs/${DOC}/recordings`, { method: 'POST', body: { language: 'ko' }, headers: EN });
      assert.equal(created.status, 201);
      const rid = created.body.id;
      // Audio and stop in Korean requests: the windows are queued (and run) from them.
      const sent = await call(`/docs/${DOC}/recordings/${rid}/audio?offset=0`, { method: 'POST', body: tone, headers: { 'Content-Type': 'application/octet-stream' } });
      assert.equal(sent.status, 200);
      assert.equal((await call(`/docs/${DOC}/recordings/${rid}/stop`, { method: 'POST', body: {} })).status, 200);
      await waitFor(async () => (await recording(DOC, rid)).transcriptStatus === 'error', 'failed transcription');
      assert.match((await recording(DOC, rid)).error ?? '', /^Transcription failed: /);
      assert.equal((await call(`/docs/${DOC}/recordings/${rid}`, { method: 'DELETE' })).status, 204);
    } finally {
      delete process.env.FAKE_WHISPER_FAIL;
    }
  });

  test('conversion errors are written in the recording’s language, also when a restart resumes the conversion', async () => {
    process.env.FAKE_FFMPEG_EXIT = '234';
    const upload = async (headers: Record<string, string>) => {
      const res = await call<RecordingInfo>(`/docs/${DOC}/recordings/upload`, {
        method: 'POST',
        body: wav,
        headers: { ...headers, 'X-Filename': encodeURIComponent('lecture.wav'), 'X-Language': 'ko' },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.id;
    };
    const english = await upload(EN);
    const korean = await upload({});
    await waitFor(async () => (await recording(DOC, english)).status === 'error' && (await recording(DOC, korean)).status === 'error', 'failed conversions');
    assert.equal((await recording(DOC, english)).error, 'The file has no audio track');
    assert.equal((await recording(DOC, korean)).error, '오디오 트랙이 없습니다');

    // A restart finds both converting again (as after a crash): the resumed conversions run in their own languages
    // (the Korean one as made before recordings stored their language: no `lang` means Korean).
    await server?.close();
    server = null;
    for (const rid of [english, korean]) {
      const file = path.join(library, DOC, 'recordings', rid, 'meta.json');
      const meta = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      assert.equal(meta.lang, rid === english ? 'en' : 'ko');
      delete meta.error;
      if (rid === korean) delete meta.lang;
      await fs.writeFile(file, JSON.stringify({ ...meta, status: 'converting', transcriptStatus: 'queued' }));
    }
    process.env.FAKE_FFMPEG_EXIT = '183';
    server = await startServer(options({ resumeRecordings: true }));
    try {
      await waitFor(async () => (await recording(DOC, english)).status === 'error' && (await recording(DOC, korean)).status === 'error', 'resumed conversions');
      assert.equal((await recording(DOC, english)).error, "The file is damaged or the upload didn't finish");
      assert.equal((await recording(DOC, korean)).error, '파일이 손상되었거나 업로드가 끝나지 않았습니다');
    } finally {
      delete process.env.FAKE_FFMPEG_EXIT;
    }
  });
});
