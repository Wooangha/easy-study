// A new version of a lecture PDF and its recordings (DESIGN §28 "Remaps › Recordings"): remapDocRecordings moves the
// segments' slides, the timeline, the markers and the AI labels to the new numbering, keeps what fell on a removed
// slide in deck-r<fromRev>.json and puts it back on undo; it runs once per rev and repeats the same writes after a
// crash; uploads still arriving are skipped. recordingsBusy names a live recording, a transcription waiting, an
// upload arriving. Transcripts carry the stored markers. While the lecture is swapped, recording writes answer 409
// (the recordings router is not under the API's docId gate). No whisper engine: nothing is transcribed.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AlignmentMarker, RecordingEvent, SlideViewEvent, TranscriptSegment } from '../shared/types.ts';
import { HttpError, repoRoot } from '../server/config.ts';
import { smsg } from '../server/i18n.ts';
import { startServer } from '../server/index.ts';
import { beginDocSwap, endDocSwap } from '../server/library.ts';
import type { DeckMap } from '../server/internal-types.ts';
import type { SseTarget } from '../server/recordings/events.ts';
import { ModelStore } from '../server/recordings/models.ts';
import type { ModelCatalog } from '../server/recordings/models.ts';
import {
  abortUpload,
  appendLiveAudio,
  beginUpload,
  configureRecordings,
  createLiveRecording,
  deleteRecording,
  getTranscript,
  putMarkers,
  recordingsBusy,
  remapDocRecordings,
  renameRecording,
  resetRecordingsForTests,
  startAiAlignment,
  stopRecording,
  subscribe,
} from '../server/recordings/service.ts';
import type { LlmLabels, RecordingMeta } from '../server/recordings/store.ts';
import { tonesPcm } from './recordingFixtures.ts';

const DOC = 'lecture-abc123';
const LIVE_DOC = 'other-def456';
const UNDO_DOC = 'undo-ghi789';
const CRASH_DOC = 'crash-jkl012';
const UPLOAD = 'rec-20261001-100000-aaaa';
const LIVE = 'rec-20261001-110000-bbbb';
const ARRIVING = 'rec-20261001-120000-cccc';
const CRASHED = 'rec-20261001-130000-dddd';

let tmp = '';
let library = '';

const catalog = (): ModelCatalog => ({
  models: [{ id: 'small-q5_1', label: 'small', file: 'small.bin', url: 'http://127.0.0.1:9/small', sizeBytes: 8, sha256: '0' }],
  vad: { file: 'vad.bin', url: 'http://127.0.0.1:9/vad', sizeBytes: 4, sha256: '0' },
});

async function makeDoc(docId: string, pageCount = 5): Promise<void> {
  const dir = path.join(library, docId);
  await fs.mkdir(path.join(dir, 'text'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'doc.json'),
    JSON.stringify({ id: docId, title: 'Parsing', fileName: 'Parsing.pdf', pageCount, aspectRatio: 4 / 3, status: 'ready', progress: pageCount, createdAt: new Date().toISOString() }),
  );
  for (let i = 1; i <= pageCount; i++) await fs.writeFile(path.join(dir, 'text', `${String(i).padStart(3, '0')}.txt`), `slide ${i}`);
}

const recDir = (rid: string, docId = DOC) => path.join(library, docId, 'recordings', rid);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;

interface Stored {
  source: 'upload' | 'live';
  slides: Array<number | null>;
  timeline?: SlideViewEvent[];
  markers?: AlignmentMarker[];
  llm?: Record<string, number | null>;
}

/** A finished recording on disk: segment k (id k + 1) on slides[k]. */
async function writeRecording(rid: string, r: Stored, extra: Partial<RecordingMeta> = {}, docId = DOC): Promise<void> {
  const dir = recDir(rid, docId);
  await fs.mkdir(dir, { recursive: true });
  const meta: RecordingMeta = {
    version: 1,
    id: rid,
    docId,
    title: rid,
    source: r.source,
    status: 'ready',
    language: 'ko',
    model: 'small-q5_1',
    liveTranscribe: r.source === 'live',
    createdAt: '2026-10-01T10:00:00.000Z',
    transcriptStatus: 'ready',
    transcribedSec: r.slides.length * 2,
    alignment: 'lexical',
    hasManualMarkers: (r.markers ?? []).length > 0,
    ...(r.source === 'live' ? { finalized: true, stoppedAt: '2026-10-01T10:30:00.000Z' } : { durationSec: r.slides.length * 2 }),
    ...extra,
  };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  const segments: TranscriptSegment[] = r.slides.map((slide, k) => ({ id: k + 1, start: k * 2, end: k * 2 + 1.5, text: `sentence ${k + 1}`, slide }));
  await fs.writeFile(path.join(dir, 'transcript.json'), JSON.stringify({ recordingId: rid, segments, doneWindows: [], failedWindows: {}, nextId: segments.length + 1 }));
  if (r.timeline) await fs.writeFile(path.join(dir, 'timeline.json'), JSON.stringify(r.timeline));
  if (r.markers) await fs.writeFile(path.join(dir, 'markers.json'), JSON.stringify(r.markers));
  if (r.llm) await fs.writeFile(path.join(dir, 'align-llm.json'), JSON.stringify({ provider: 'claude-code', model: 'haiku', at: '2026-10-01T11:00:00.000Z', labels: r.llm }));
}

/** An SSE subscriber that keeps the events. */
function sink() {
  const chunks: string[] = [];
  const target: SseTarget = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {},
    writableEnded: false,
    destroyed: false,
  };
  const events = (): RecordingEvent[] =>
    chunks
      .join('')
      .split('\n\n')
      .map((frame) => /^data: (.+)$/m.exec(frame)?.[1])
      .filter((data): data is string => !!data)
      .map((data) => JSON.parse(data) as RecordingEvent);
  return { target, events, clear: () => chunks.splice(0) };
}

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const slidesOf = async (rid: string, docId = DOC) => (await getTranscript(docId, rid)).segments.map((s) => s.slide);
const sortedLabels = (labels: Record<string, number | null>) => Object.entries(labels).sort(([a], [b]) => Number(a) - Number(b));

// The professor's new deck: a slide inserted after slide 1, old slide 3 dropped, slide 4 edited.
const APPLY: DeckMap = { fromRev: 0, toRev: 1, oldPageCount: 5, newPageCount: 5, oldToNew: [1, 3, null, 4, 5], changed: new Set([4]), added: new Set([2]) };
// Its undo: new slide 2 goes away, old slide 3 comes back.
const UNDO: DeckMap = { fromRev: 1, toRev: 2, oldPageCount: 5, newPageCount: 5, oldToNew: [1, null, 2, 4, 5], changed: new Set([4]), added: new Set([3]), restoreRev: 0 };

const MARKERS: AlignmentMarker[] = [
  { t: 1, slide: 2 },
  { t: 5, slide: 3 },
  { t: 7, slide: null },
  { t: 9, slide: 5 },
];
const LLM: Record<string, number | null> = { '1': 1, '2': 3, '3': 3, '4': null, '5': 4 };
const TIMELINE: SlideViewEvent[] = [
  { t: 0, slide: 1 },
  { t: 2, slide: 2 },
  { t: 4, slide: 3 },
  { t: 8, slide: 4 },
];

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-versions-rec-')));
  library = path.join(tmp, 'library');
  await fs.mkdir(path.join(tmp, 'models'), { recursive: true });
  process.env.EASY_STUDY_LIBRARY = library;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
  process.env.EASY_STUDY_WHISPER = path.join(tmp, 'no-whisper-here');
  process.env.EASY_STUDY_FFMPEG = path.join(repoRoot(), 'tests', 'fixtures', 'fake-ffmpeg.mjs');
  configureRecordings({ models: new ModelStore({ dir: () => path.join(tmp, 'models'), catalog: catalog() }), statusThrottleMs: 20, pingMs: 60_000 });
  for (const docId of [DOC, LIVE_DOC, UNDO_DOC, CRASH_DOC]) await makeDoc(docId);
});

after(async () => {
  await resetRecordingsForTests();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('recordings follow a new version of the lecture (remapDocRecordings)', () => {
  test('apply: slides renumbered, what was on the removed slide cleared or dropped and archived; realigned + status sent', async () => {
    await writeRecording(UPLOAD, { source: 'upload', slides: [1, 2, 3, null, 4, 5], markers: MARKERS, llm: LLM });
    await writeRecording(LIVE, { source: 'live', slides: [1, 2, 3, 4], timeline: TIMELINE });
    // An upload still arriving: no meta.json yet.
    await fs.mkdir(recDir(ARRIVING), { recursive: true });
    await fs.writeFile(path.join(recDir(ARRIVING), 'source.part'), 'partial');

    const listener = sink();
    const unsubscribe = await subscribe(DOC, UPLOAD, listener.target, 0);
    listener.clear();
    await remapDocRecordings(DOC, APPLY);
    unsubscribe();

    assert.deepEqual(await slidesOf(UPLOAD), [1, 3, null, null, 4, 5]);
    const transcript = await getTranscript(DOC, UPLOAD);
    assert.deepEqual(transcript.markers, [
      { t: 1, slide: 3 },
      { t: 7, slide: null },
      { t: 9, slide: 5 },
    ]);
    assert.deepEqual(await readJson(path.join(recDir(UPLOAD), 'markers.json')), transcript.markers);
    const llm = await readJson<LlmLabels>(path.join(recDir(UPLOAD), 'align-llm.json'));
    assert.deepEqual(sortedLabels(llm.labels), [
      ['1', 1],
      ['4', null],
      ['5', 4],
    ]);
    assert.equal(llm.provider, 'claude-code');
    assert.equal((await readJson<RecordingMeta>(path.join(recDir(UPLOAD), 'meta.json'))).deckRev, 1);

    const archive = await readJson<{ fromRev: number; toRev: number; cleared: Record<string, unknown>; next?: unknown }>(path.join(recDir(UPLOAD), 'deck-r0.json'));
    assert.equal(archive.toRev, 1);
    assert.equal(archive.next, undefined, 'the writes are done');
    assert.deepEqual(archive.cleared, { segments: { '3': 3 }, timeline: [], markers: [{ t: 5, slide: 3 }], llm: { '2': 3, '3': 3 } });

    const events = listener.events();
    const realigned = events.find((e) => e.type === 'realigned');
    assert.deepEqual(realigned?.type === 'realigned' && realigned.segments, [
      { id: 2, slide: 3 },
      { id: 3, slide: null },
    ]);
    assert.ok(events.some((e) => e.type === 'status' && e.recording.hasManualMarkers));

    assert.deepEqual(await slidesOf(LIVE), [1, 3, null, 4]);
    assert.deepEqual(await readJson(path.join(recDir(LIVE), 'timeline.json')), [
      { t: 0, slide: 1 },
      { t: 2, slide: 3 },
      { t: 8, slide: 4 },
    ]);
    assert.deepEqual((await readJson<{ cleared: { timeline: SlideViewEvent[] } }>(path.join(recDir(LIVE), 'deck-r0.json'))).cleared.timeline, [{ t: 4, slide: 3 }]);
    assert.equal(existsSync(path.join(recDir(LIVE), 'markers.json')), false, 'nothing written that was not there');

    assert.ok(existsSync(path.join(recDir(ARRIVING), 'source.part')), 'the arriving upload is left alone');
    assert.equal(existsSync(path.join(recDir(ARRIVING), 'meta.json')), false);
  });

  test('the same remap again does nothing (meta.json deckRev)', async () => {
    const listener = sink();
    const unsubscribe = await subscribe(DOC, UPLOAD, listener.target, 0);
    listener.clear();
    await remapDocRecordings(DOC, APPLY);
    unsubscribe();
    assert.deepEqual(await slidesOf(UPLOAD), [1, 3, null, null, 4, 5]);
    assert.deepEqual(await slidesOf(LIVE), [1, 3, null, 4]);
    assert.deepEqual(listener.events(), []);
  });

  test('undo: renumbered back, the archive put back and removed', async () => {
    await remapDocRecordings(DOC, UNDO);
    assert.deepEqual(await slidesOf(UPLOAD), [1, 2, 3, null, 4, 5]);
    assert.deepEqual((await getTranscript(DOC, UPLOAD)).markers, MARKERS);
    assert.deepEqual(await readJson(path.join(recDir(UPLOAD), 'markers.json')), MARKERS);
    assert.deepEqual(sortedLabels((await readJson<LlmLabels>(path.join(recDir(UPLOAD), 'align-llm.json'))).labels), sortedLabels(LLM));
    assert.deepEqual(await slidesOf(LIVE), [1, 2, 3, 4]);
    assert.deepEqual(await readJson(path.join(recDir(LIVE), 'timeline.json')), TIMELINE);
    for (const rid of [UPLOAD, LIVE]) {
      assert.equal((await readJson<RecordingMeta>(path.join(recDir(rid), 'meta.json'))).deckRev, 2);
      assert.equal(existsSync(path.join(recDir(rid), 'deck-r0.json')), false, 'the archive is consumed');
      assert.equal(existsSync(path.join(recDir(rid), 'deck-r1.json')), false, 'the undo dropped nothing');
    }
  });

  test('an undo drops what sits on a slide the new version added (kept in its own archive)', async () => {
    const rid = 'rec-20261001-140000-eeee';
    // Made after an apply (rev 1): numbered in the new deck, where slide 2 is the added one.
    await writeRecording(rid, { source: 'upload', slides: [1, 2, 3], markers: [{ t: 2, slide: 2 }] }, { deckRev: 1 }, UNDO_DOC);
    await remapDocRecordings(UNDO_DOC, UNDO);
    assert.deepEqual(await slidesOf(rid, UNDO_DOC), [1, null, 2]);
    assert.deepEqual((await getTranscript(UNDO_DOC, rid)).markers, []);
    const archive = await readJson<{ cleared: { segments: Record<string, number>; markers: AlignmentMarker[] } }>(path.join(recDir(rid, UNDO_DOC), 'deck-r1.json'));
    assert.deepEqual(archive.cleared.segments, { '2': 2 });
    assert.deepEqual(archive.cleared.markers, [{ t: 2, slide: 2 }]);
  });

  test('a crash between the writes: the archive’s pending state is written as it is, nothing is mapped twice', async () => {
    await writeRecording(CRASHED, { source: 'upload', slides: [1, 2, 3], markers: [{ t: 3, slide: 2 }] }, { deckRev: 3 }, CRASH_DOC);
    // The remap 3 → 4 had written its archive and the transcript, not the markers nor meta.json.
    const map: DeckMap = { ...APPLY, fromRev: 3, toRev: 4 };
    const transcriptFile = path.join(recDir(CRASHED, CRASH_DOC), 'transcript.json');
    const state = await readJson<{ segments: TranscriptSegment[] }>(transcriptFile);
    state.segments = state.segments.map((s) => ({ ...s, slide: s.slide === null ? null : map.oldToNew[s.slide - 1] }));
    await fs.writeFile(transcriptFile, JSON.stringify(state));
    await fs.writeFile(
      path.join(recDir(CRASHED, CRASH_DOC), 'deck-r3.json'),
      JSON.stringify({
        fromRev: 3,
        toRev: 4,
        cleared: { segments: { '3': 3 }, timeline: [], markers: [], llm: {} },
        next: { slides: { '1': 1, '2': 3, '3': null }, timeline: [], markers: [{ t: 3, slide: 3 }], llm: null },
      }),
    );
    await remapDocRecordings(CRASH_DOC, map);
    assert.deepEqual(await slidesOf(CRASHED, CRASH_DOC), [1, 3, null], 'slide 3 (old 2) was not mapped again (it would be dropped)');
    assert.deepEqual((await getTranscript(CRASH_DOC, CRASHED)).markers, [{ t: 3, slide: 3 }]);
    assert.equal((await readJson<RecordingMeta>(path.join(recDir(CRASHED, CRASH_DOC), 'meta.json'))).deckRev, 4);
    assert.deepEqual(await readJson(path.join(recDir(CRASHED, CRASH_DOC), 'deck-r3.json')), {
      fromRev: 3,
      toRev: 4,
      cleared: { segments: { '3': 3 }, timeline: [], markers: [], llm: {} },
    });
  });
});

describe('the deck a recording is numbered in (meta.deckRev)', () => {
  test('an undo of an apply that gave the recording up only marks it; a recording in another deck is left alone', async () => {
    const docId = 'gaveup-mno345';
    await makeDoc(docId);
    const kept = 'rec-20261001-150000-ffff';
    const stray = 'rec-20261001-160000-abab';
    // Still numbered in deck 0 (the apply's remap of it was given up), with what that remap had begun to write.
    await writeRecording(kept, { source: 'upload', slides: [1, 2, 3], markers: [{ t: 2, slide: 3 }] }, {}, docId);
    const leftover = path.join(recDir(kept, docId), 'deck-r0.json');
    await fs.writeFile(leftover, JSON.stringify({ fromRev: 0, toRev: 1, cleared: { segments: { '3': 3 }, timeline: [], markers: [], llm: {} } }));

    await remapDocRecordings(docId, UNDO);
    assert.deepEqual(await slidesOf(kept, docId), [1, 2, 3], 'already in the deck that came back');
    assert.deepEqual((await getTranscript(docId, kept)).markers, [{ t: 2, slide: 3 }]);
    assert.equal((await readJson<RecordingMeta>(path.join(recDir(kept, docId), 'meta.json'))).deckRev, 2);
    assert.equal(existsSync(leftover), false, 'nothing to bring back');

    // Numbered in deck 1 while the lecture is swapped from deck 3: not this swap's numbering.
    await writeRecording(stray, { source: 'upload', slides: [1, 2, 3], markers: [{ t: 2, slide: 2 }] }, { deckRev: 1 }, docId);
    await remapDocRecordings(docId, { ...APPLY, fromRev: 3, toRev: 4 });
    assert.deepEqual(await slidesOf(stray, docId), [1, 2, 3]);
    assert.deepEqual((await getTranscript(docId, stray)).markers, [{ t: 2, slide: 2 }]);
    assert.equal((await readJson<RecordingMeta>(path.join(recDir(stray, docId), 'meta.json'))).deckRev, 1);
    assert.equal((await readJson<RecordingMeta>(path.join(recDir(kept, docId), 'meta.json'))).deckRev, 2);
  });

  test('a recording made on a swapped deck carries its deck', async () => {
    const docId = 'swapped-pqr678';
    await makeDoc(docId);
    const docJson = path.join(library, docId, 'doc.json');
    await fs.writeFile(docJson, JSON.stringify({ ...(await readJson<Record<string, unknown>>(docJson)), deckRev: 2 }));
    const live = await createLiveRecording(docId, { language: 'ko' });
    try {
      assert.equal((await readJson<RecordingMeta>(path.join(recDir(live.id, docId), 'meta.json'))).deckRev, 2);
    } finally {
      await appendLiveAudio(docId, live.id, 0, tonesPcm(1, [{ start: 0.2, end: 0.8, hz: 440 }]));
      await stopRecording(docId, live.id, undefined);
      await deleteRecording(docId, live.id);
    }
  });
});

describe('recordings that keep a lecture from being swapped (recordingsBusy)', () => {
  test('a live recording, then its transcription waiting; uploads while they arrive; other lectures are not affected', async () => {
    const m = smsg('ko').library.versions;
    assert.equal(await recordingsBusy(DOC), null);
    assert.equal(await recordingsBusy(LIVE_DOC), null);

    const live = await createLiveRecording(LIVE_DOC, { language: 'ko' });
    assert.equal(await recordingsBusy(LIVE_DOC), m.busyRecording);
    assert.equal(await recordingsBusy(DOC), null);
    await appendLiveAudio(LIVE_DOC, live.id, 0, tonesPcm(4, [{ start: 0.5, end: 3, hz: 440 }]));
    // Stopped: the last window waits for the engine (none here).
    await stopRecording(LIVE_DOC, live.id, undefined);
    assert.equal(await recordingsBusy(LIVE_DOC), m.busyTranscribing);
    await deleteRecording(LIVE_DOC, live.id);
    assert.equal(await recordingsBusy(LIVE_DOC), null);

    const upload = await beginUpload(DOC);
    assert.equal(await recordingsBusy(DOC), m.busyTranscribing);
    await abortUpload(upload.dir);
    assert.equal(await recordingsBusy(DOC), null);
  });

  test('an AI alignment keeps it busy; one the deck changed under anyway stops without writing its labels', async () => {
    const rid = 'rec-20261001-140000-eeee';
    let reply: (text: string) => void = () => {};
    const job = { provider: 'claude-code', model: 'haiku', call: () => new Promise<string>((resolve) => (reply = resolve)) };
    await startAiAlignment(UNDO_DOC, rid, job);
    assert.equal(await recordingsBusy(UNDO_DOC), smsg('ko').library.versions.busyTranscribing);
    await remapDocRecordings(UNDO_DOC, { ...APPLY, fromRev: 2, toRev: 3 });
    reply(JSON.stringify([{ from: 0, to: 2, slide: 1 }]));
    await waitFor(async () => (await recordingsBusy(UNDO_DOC)) === null, 'the AI alignment ended');
    assert.equal(existsSync(path.join(recDir(rid, UNDO_DOC), 'align-llm.json')), false, 'labels of the old numbering were not written');
    assert.deepEqual(await slidesOf(rid, UNDO_DOC), [1, null, 3]);
  });
});

describe('recording writes of a lecture being swapped', () => {
  const swapping = (err: unknown) => err instanceof HttpError && err.status === 409 && err.message === smsg('ko').library.versions.swapping;

  test('service: create, live audio, markers, rename, delete, uploads and AI alignment refuse with 409; reads work', async () => {
    beginDocSwap(DOC);
    try {
      await assert.rejects(createLiveRecording(DOC, { language: 'ko' }), swapping);
      await assert.rejects(appendLiveAudio(DOC, LIVE, 0, Buffer.alloc(320)), swapping);
      await assert.rejects(putMarkers(DOC, UPLOAD, []), swapping);
      await assert.rejects(renameRecording(DOC, UPLOAD, 'x'), swapping);
      await assert.rejects(deleteRecording(DOC, UPLOAD), swapping);
      await assert.rejects(beginUpload(DOC), swapping);
      let called = false;
      const job = { provider: 'claude-code', model: 'haiku', call: async () => ((called = true), '[]') };
      await assert.rejects(startAiAlignment(DOC, UPLOAD, job), swapping);
      assert.equal(called, false);
      assert.equal(await recordingsBusy(DOC), null, 'nothing was registered by the refused requests');
      assert.deepEqual((await getTranscript(DOC, UPLOAD)).markers, MARKERS);
    } finally {
      endDocSwap(DOC);
    }
    assert.equal((await renameRecording(DOC, UPLOAD, '7강')).title, '7강');
  });

  test('HTTP: 409 with the message (an upload body too), GETs answer; other lectures are not affected', async () => {
    const server = await startServer({
      port: 0,
      log: false,
      resumeIngests: false,
      resumeRecordings: false,
      backfillImages: false,
      sweepAttachments: false,
      providerInfos: async () => [],
      recordings: { models: new ModelStore({ dir: () => path.join(tmp, 'models'), catalog: catalog() }), statusThrottleMs: 20 },
    });
    const api = (target: string, init: RequestInit = {}) => fetch(`${server.url}/api${target}`, init);
    const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const message = smsg('ko').library.versions.swapping;
    beginDocSwap(DOC);
    try {
      const refused: Array<[string, RequestInit]> = [
        [`/docs/${DOC}/recordings`, json('POST', { language: 'ko' })],
        [`/docs/${DOC}/recordings/upload`, { method: 'POST', headers: { 'X-Filename': 'a.wav' }, body: Buffer.alloc(64 * 1024, 1) }],
        [`/docs/${DOC}/recordings/${UPLOAD}/markers`, json('PUT', [])],
        [`/docs/${DOC}/recordings/${UPLOAD}`, json('PATCH', { title: 'x' })],
        [`/docs/${DOC}/recordings/${UPLOAD}`, { method: 'DELETE' }],
        [`/docs/${DOC}/recordings/${LIVE}/audio?offset=0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(320) }],
        [`/docs/${DOC}/recordings/${LIVE}/slides`, json('POST', [{ t: 1, slide: 1 }])],
        [`/docs/${DOC}/recordings/${LIVE}/stop`, json('POST', {})],
      ];
      for (const [target, init] of refused) {
        const res = await api(target, init);
        assert.equal(res.status, 409, `${init.method} ${target}`);
        assert.equal(((await res.json()) as { error: string }).error, message);
      }
      assert.equal((await api(`/docs/${DOC}/recordings`)).status, 200);
      const transcript = await api(`/docs/${DOC}/recordings/${UPLOAD}/transcript`);
      assert.equal(transcript.status, 200);
      assert.deepEqual(((await transcript.json()) as { markers: AlignmentMarker[] }).markers, MARKERS);
      const other = await api(`/docs/${LIVE_DOC}/recordings`, json('POST', { language: 'ko' }));
      assert.equal(other.status, 201);
      assert.equal((await api(`/docs/${LIVE_DOC}/recordings/${((await other.json()) as { id: string }).id}`, { method: 'DELETE' })).status, 204);
    } finally {
      endDocSwap(DOC);
      await server.close();
    }
  });
});
