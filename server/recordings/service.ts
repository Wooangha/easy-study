// Lecture recordings (DESIGN §22): the recordings of a document, recorded live in the app (PCM uploaded as it is
// captured, transcribed a few windows behind) or uploaded as a file (converted by ffmpeg, then transcribed), aligned
// to the slides, replayed, and used as tutor context.
//
// State lives on disk (store.ts); a Rec object is loaded on demand and holds a recording's in-memory state while it
// is used: its transcript, windows, slide timeline, markers, the open live audio (live.ts), the segmenter, its SSE
// subscribers. Mutations of one recording run one after another (a promise chain). One whisper process runs at a
// time for the whole server (a FIFO queue, live windows first); a download of a model starts waiting jobs.
// After a restart, live recordings left in 'recording'/'paused' stay resumable (the client resends from the
// acknowledged offset) and unfinished conversions / transcriptions resume (resumeRecordings).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIVE_SAMPLE_RATE, LIVE_SPEECH_IDLE_MS, MAX_RECORDING_UPLOAD_BYTES } from '../../shared/types.ts';
import type {
  AlignmentKind,
  AlignmentMarker,
  AsrStatus,
  CreateLiveRecordingRequest,
  RecordingInfo,
  RecordingLanguage,
  RecordingTranscript,
  SlideViewEvent,
  TranscriptSegment,
} from '../../shared/types.ts';
import { HttpError, desktopMode, libraryDir } from '../config.ts';
import { DEFAULT_LANG, isLang, runInLang, slang, smsg } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import type { DeckMap } from '../internal-types.ts';
import { docPaths, isDocSwapping, isNotFound, loadDocAssets, readStoredDoc, renameWithRetry, rmWithRetry } from '../library.ts';
import type { Label } from './align/align.ts';
import { hasSlideText, timelinePrior } from './align/align.ts';
import { DEFAULT_EMIT, emissions } from './align/dp.ts';
import { buildIndex, simMatrix } from './align/sim.ts';
import type { LexIndex } from './align/sim.ts';
import { stripMarkdown } from './align/text.ts';
import { alignInWorker } from './align/worker.ts';
import {
  configureWhisperGpu,
  contextPrompt,
  detectLanguage,
  findFfmpeg,
  findWhisper,
  gpuState,
  probeGpu,
  probeVersion,
  runWhisper,
  usesMetal,
} from './asr.ts';
import type { GpuOptions, ToolLocation } from './asr.ts';
import { EventHub, RECORDING_PING_MS, sseFrame } from './events.ts';
import type { SseTarget } from './events.ts';
import { conversionError, convertUpload } from './ffmpeg.ts';
import { LiveAudio } from './live.ts';
import type { LiveHooks } from './live.ts';
import { ModelStore, SMALL_MODEL_ID, TURBO_MODEL_ID } from './models.ts';
import { BYTES_PER_SECOND, Segmenter, WINDOW_PRESETS, uploadPresetFor } from './segmenter.ts';
import type { AsrWindow, WindowPreset } from './segmenter.ts';
import {
  cleanTitle,
  defaultLiveTitle,
  defaultUploadTitle,
  emptyTranscript,
  isRecordingId,
  listRecordingIds,
  newRecordingId,
  readDeckArchive,
  readLlmLabels,
  readMarkers,
  readMeta,
  readTimeline,
  readTranscriptState,
  readWindows,
  recordingPaths,
  recordingsDir,
  removeDeckArchive,
  writeDeckArchive,
  writeJsonLines,
  writeLlmLabels,
  writeMarkers,
  writeMeta,
  writeTimeline,
  writeTranscriptState,
} from './store.ts';
import type { DeckArchive, LlmLabels, RecordingMeta, RecordingPaths, TranscriptState } from './store.ts';
import { readWavInfo, wavHeader, writeWavSlice } from './wav.ts';

// ---------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------

export interface RecordingsConfig {
  models: ModelStore;
  /** Largest accepted upload (bytes). */
  maxUploadBytes: number;
  /** An upload whose sender sends nothing for this long (ms) is stopped with 408. */
  uploadIdleMs: number;
  livePreset: WindowPreset;
  uploadPreset: WindowPreset;
  /** Test hooks of the live audio store (fault injection). */
  liveHooks?: LiveHooks;
  /** Minimum time between two full re-alignments of a live recording while it runs (ms). */
  liveRealignMs: number;
  /** Status events of a recording are sent at most this often (ms). */
  statusThrottleMs: number;
  /** `event: ping` interval of the SSE streams (ms). */
  pingMs: number;
  /**
   * A live recording stopped with audio still to come (stop {bytes} beyond what is stored) is ended with what it has
   * when a new live recording is asked for and nothing arrived for this long (ms): the device that had the rest is gone.
   */
  staleStopMs: number;
  /**
   * A loaded recording nobody used for this long (ms) and that has nothing running (not live, no job, no subscriber)
   * is dropped from memory; the next request loads it from its files again.
   */
  idleUnloadMs: number;
  /**
   * A question during a live recording: how long (ms) the turn may wait for the audio not transcribed yet (cut into a
   * window at once) so that "the last minutes of the lecture" reach up to the question.
   */
  questionSpeechWaitMs: number;
  /** A live recording's speech is "recent" for the tutor only with audio (or a pause/resume) this recently (ms). */
  liveSpeechIdleMs: number;
  /** Test hooks of the engine's GPU choice (another platform, the probe's timeout). */
  gpu?: GpuOptions;
}

function defaultConfig(): RecordingsConfig {
  return {
    models: new ModelStore(),
    maxUploadBytes: MAX_RECORDING_UPLOAD_BYTES,
    uploadIdleMs: 60_000,
    livePreset: WINDOW_PRESETS.live,
    uploadPreset: WINDOW_PRESETS.upload,
    liveRealignMs: 60_000,
    statusThrottleMs: 500,
    pingMs: RECORDING_PING_MS,
    staleStopMs: 10 * 60_000,
    idleUnloadMs: 10 * 60_000,
    questionSpeechWaitMs: 6_000,
    liveSpeechIdleMs: LIVE_SPEECH_IDLE_MS,
  };
}

let config: RecordingsConfig = defaultConfig();

function applyConfig(partial: Partial<RecordingsConfig>): void {
  config = { ...defaultConfig(), ...partial };
  config.models.onInstalled = (modelId) => {
    warmUp(modelId);
    pumpQueue();
  };
}
applyConfig({});

/**
 * The default configuration with `partial` on top (startServer, tests). The service starts here: the engine's GPU
 * probe (Vulkan) begins at once, so the recommended model knows about the GPU before the first recording.
 */
export function configureRecordings(partial: Partial<RecordingsConfig> = {}): void {
  applyConfig(partial);
  configureWhisperGpu(config.gpu);
  const engine = findWhisper();
  if (engine && existsSync(engine.path)) void probeGpu(engine.path);
}

export function recordingsConfig(): Readonly<RecordingsConfig> {
  return config;
}

/** Windows with less speech than this are not transcribed (silence, noise). */
const MIN_SPEECH_MS = 300;
/** Attempts of one window before it is given up. */
const WINDOW_ATTEMPTS = 3;
/** Pending requests per recording before 429 (live spike). */
const MAX_PENDING = 8;
/** Length of the clip whisper detects the language of an upload on. */
const DETECT_CLIP_MS = 30_000;
/** Minimum speech of a live window whose detected language is kept for the next ones. */
const DETECT_MIN_SPEECH_MS = 5_000;
/** A question waits for the live transcription only when no more than this much audio (ms) is still to transcribe. */
const QUESTION_BACKLOG_MS = 60_000;
/**
 * A live window's timeline prior looks at this many recent segments (their speech decides the back-visits); in the
 * simulation it gave the same labels as the whole recording.
 */
const LIVE_CONTEXT_SEGMENTS = 80;

const LANGUAGES: readonly RecordingLanguage[] = ['ko', 'en', 'auto'];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------------------------------------------
// One recording
// ---------------------------------------------------------------------------------------------------------------

type Mutation<T> = () => Promise<T>;

class Rec {
  readonly docId: string;
  readonly id: string;
  readonly paths: RecordingPaths;
  meta: RecordingMeta;
  transcript: TranscriptState;
  windows: AsrWindow[] = [];
  timeline: SlideViewEvent[] = [];
  markers: AlignmentMarker[] = [];
  llm: LlmLabels | null = null;
  live: LiveAudio | null = null;
  seg: Segmenter | null = null;
  /** Live: bytes stored (acknowledged). */
  committed = 0;
  /** Live: when audio or a pause/resume/stop last arrived (loading counts: a restart gives the client time again). */
  lastActivity = Date.now();
  /** Last request that loaded this recording or queued work on it (idle unloading). */
  lastUsed = Date.now();
  readonly hub = new EventHub(config.pingMs);
  deleted = false;
  /** Controllers of work to stop when the recording is deleted (conversion, AI alignment). */
  readonly jobs = new Set<AbortController>();
  aiRunning = false;
  /** Bumped by every remap to a new deck (DESIGN §28): labels computed before it count the old slides. */
  deckGen = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private statusTimer: NodeJS.Timeout | null = null;
  private aligning: Promise<void> | null = null;
  /** Background work of this recording (conversion, alignment, AI alignment): awaited by close/shutdown. */
  private readonly background = new Set<Promise<unknown>>();
  private closed = false;
  private alignAgain = false;
  private lastAlignAt = 0;
  /** The slide material of the last alignment (live windows' back-visit evidence). */
  private material: string[] | null = null;
  /** The lexical index of `material` (rebuilt only when the material changed). */
  private lexIndex: { material: string[]; index: LexIndex } | null = null;
  /** Live: the timeline prior each recent segment got at the last window (a change calls for a realign now). */
  private recentPrior = new Map<number, number | null>();
  private wavInfo: { dataOffset: number; dataBytes: number } | null = null;
  /** The window being transcribed and how far whisper got in it (seconds on the recording clock). */
  private progress: { i: number; sec: number } | null = null;

  constructor(meta: RecordingMeta) {
    this.docId = meta.docId;
    this.id = meta.id;
    this.paths = recordingPaths(meta.docId, meta.id);
    this.meta = meta;
    this.transcript = emptyTranscript(meta.id);
  }

  get key(): string {
    return recKey(this.docId, this.id);
  }

  /** The language of the recording's background work (conversion, transcription): the one it was made in. */
  get lang(): Lang {
    return isLang(this.meta.lang) ? this.meta.lang : DEFAULT_LANG;
  }

  get isLive(): boolean {
    return this.meta.source === 'live' && !this.meta.finalized && (this.meta.status === 'recording' || this.meta.status === 'paused');
  }

  /**
   * Runs `fn` after every earlier mutation of this recording. `limited` (client requests): 429 when too many are
   * waiting. The server's own work (transcription results, alignment, conversion, SSE replays) is never refused.
   */
  serial<T>(fn: Mutation<T>, limited = false): Promise<T> {
    if (limited && this.pending >= MAX_PENDING) {
      throw new HttpError(429, smsg().recordings.tooManyRequests, { retryAfterMs: 1000 });
    }
    this.pending++;
    this.lastUsed = Date.now();
    const run = this.chain.then(() => {
      if (this.deleted) throw new HttpError(404, smsg().recordings.notFound.recording);
      if (this.closed) throw new HttpError(503, smsg().recordings.shuttingDown);
      return fn();
    });
    this.chain = run.catch(() => {}).finally(() => this.pending--);
    return run;
  }

  /** Nothing of this recording runs or waits, and nobody listens: it may be dropped from memory. */
  idle(now: number): boolean {
    return (
      now - this.lastUsed >= config.idleUnloadMs &&
      !this.isLive &&
      this.meta.status !== 'converting' &&
      this.pending === 0 &&
      this.aligning === null &&
      this.background.size === 0 &&
      this.jobs.size === 0 &&
      !this.aiRunning &&
      this.statusTimer === null &&
      this.hub.size === 0 &&
      runningJob?.rec !== this &&
      !queue.some((j) => j.rec === this)
    );
  }

  /** Registers background work so that close/shutdown can wait for it. */
  track<T>(work: Promise<T>): Promise<T> {
    this.background.add(work);
    void work.then(
      () => this.background.delete(work),
      () => this.background.delete(work),
    );
    return work;
  }

  private async settleBackground(): Promise<void> {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref?.());
    await Promise.race([Promise.allSettled([...this.background]), timeout]);
  }

  // --- loading / recovery -----------------------------------------------------------------------------------

  async init(): Promise<void> {
    const [transcript, windows, timeline, markers, llm] = await Promise.all([
      readTranscriptState(this.docId, this.id),
      readWindows(this.docId, this.id),
      readTimeline(this.docId, this.id),
      readMarkers(this.docId, this.id),
      readLlmLabels(this.docId, this.id),
    ]);
    this.transcript = transcript;
    this.windows = windows;
    this.timeline = timeline.sort((a, b) => a.t - b.t);
    this.markers = markers;
    this.llm = llm;
    // A done mark of a window that was lost from windows.jsonl (not fsynced before a crash) is dropped.
    this.transcript.doneWindows = this.transcript.doneWindows.filter((i) => i < this.windows.length);
    if (this.meta.source === 'live') await this.initLive();
    else await this.initUpload();
  }

  private async initLive(): Promise<void> {
    if (this.meta.finalized) {
      this.committed = await fileSize(this.paths.audioPcm);
    } else {
      this.live = new LiveAudio(this.paths.audioPcm, this.paths.audioIdx, config.liveHooks);
      const report = await this.live.open();
      if (report.truncatedBytes > 0 || report.droppedEntries > 0) {
        console.warn(`[recordings] ${this.id}: dropped ${report.truncatedBytes} unverified bytes (${report.droppedEntries} index entries); the client resends them`);
      }
      this.committed = this.live.committed;
      this.seg = new Segmenter({ preset: config.livePreset });
      this.seg.restore(this.windows.at(-1));
      const from = Math.min(this.seg.resumeByte(), this.committed - (this.committed % 640));
      this.seg.skipTo(from);
      const piece = 1 << 20;
      for (let at = from; at < this.committed; at += piece) {
        this.seg.feed(await this.live.read(at, Math.min(this.committed, at + piece)), at);
      }
      if (this.meta.status === 'paused') this.seg.addBreak(this.committedMs());
      await this.cutWindows(false);
      if (this.meta.stoppedAt && (this.meta.stopBytes === undefined || this.committed >= this.meta.stopBytes)) await this.finalize();
    }
    this.queuePendingWindows();
  }

  private async initUpload(): Promise<void> {
    if (this.meta.status === 'converting') {
      // In the recording's language: this may be a restart resuming it, or another user's request loading it.
      void this.track(runInLang(this.lang, () => this.convert()));
      return;
    }
    if (this.meta.status === 'ready' && this.windows.length === 0 && this.meta.transcriptStatus !== 'ready') {
      await this.cutUploadWindows();
    }
    this.queuePendingWindows();
  }

  // --- derived info --------------------------------------------------------------------------------------------

  committedMs(): number {
    return Math.floor((this.committed / BYTES_PER_SECOND) * 1000);
  }

  durationSec(): number {
    if (this.meta.source === 'live') return round3(this.committed / BYTES_PER_SECOND);
    return round3(this.meta.durationSec ?? 0);
  }

  info(): RecordingInfo {
    const m = this.meta;
    const info: RecordingInfo = {
      id: m.id,
      docId: m.docId,
      title: m.title,
      source: m.source,
      status: m.status,
      language: m.language,
      model: m.model,
      liveTranscribe: m.liveTranscribe,
      createdAt: m.createdAt,
      durationSec: this.durationSec(),
      transcriptStatus: m.transcriptStatus,
      transcribedSec: round3(Math.max(m.transcribedSec, this.progressSec())),
      alignment: m.alignment,
      hasManualMarkers: this.markers.length > 0,
      playback: this.playback(),
    };
    if (m.error) info.error = m.error;
    if (m.language === 'auto' && m.detectedLanguage) info.detectedLanguage = m.detectedLanguage;
    return info;
  }

  /** Where whisper is in the first unfinished window (0 when that window is not the one running). */
  private progressSec(): number {
    const p = this.progress;
    if (!p) return 0;
    const w = this.windows[p.i];
    return w && Math.abs(w.ownStartMs / 1000 - this.meta.transcribedSec) < 0.001 ? p.sec : 0;
  }

  private playback(): RecordingInfo['playback'] {
    const url = `/api/docs/${this.docId}/recordings/${this.id}/audio`;
    if (this.meta.source === 'live') return this.committed > 0 ? { url, mime: 'audio/wav' } : null;
    return this.meta.status === 'ready' ? { url, mime: 'audio/mp4' } : null;
  }

  transcriptView(): RecordingTranscript {
    return { recordingId: this.id, segments: this.transcript.segments.map((s) => ({ ...s })), markers: this.markers.map((m) => ({ ...m })) };
  }

  /** Status event now (`immediate`) or at most every statusThrottleMs. */
  emitStatus(immediate = false): void {
    if (immediate) {
      if (this.statusTimer) clearTimeout(this.statusTimer);
      this.statusTimer = null;
      this.hub.send({ type: 'status', recording: this.info() });
      return;
    }
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (!this.deleted) this.hub.send({ type: 'status', recording: this.info() });
    }, config.statusThrottleMs);
    this.statusTimer.unref?.();
  }

  async saveMeta(): Promise<void> {
    if (this.deleted) return;
    await writeMeta(this.meta);
  }

  // --- live audio ----------------------------------------------------------------------------------------------

  async append(offset: number, body: Buffer): Promise<{ offset: number }> {
    if (this.meta.source !== 'live') throw new HttpError(409, smsg().recordings.live.uploadCannotAppend);
    if (this.meta.finalized || !this.live) {
      // Stopped: bytes that are already stored are acknowledged again (a retry), anything else is refused.
      if (offset + body.length <= this.committed && offset >= 0) {
        const stored = await readRange(this.paths.audioPcm, offset, offset + body.length);
        if (stored.equals(body)) return { offset: this.committed };
      }
      throw new HttpError(409, smsg().recordings.live.ended, { offset: this.committed });
    }
    this.lastActivity = Date.now();
    const result = await this.live.append(offset, body, false);
    this.committed = this.live.committed;
    if (!result.duplicate && this.seg) {
      this.seg.feed(result.appended, result.at);
      await this.cutWindows(false);
      if (this.meta.stopBytes !== undefined && this.committed >= this.meta.stopBytes) await this.finalize();
    }
    this.emitStatus();
    return { offset: result.offset };
  }

  /** Persists the windows the segmenter can decide now and queues them (live transcription on). */
  private async cutWindows(final: boolean): Promise<void> {
    if (!this.seg) return;
    await this.addWindows(this.seg.poll(final), final);
  }

  private async addWindows(cut: AsrWindow[], final: boolean): Promise<void> {
    if (cut.length === 0) return;
    const fh = await fs.open(this.paths.windows, 'a');
    try {
      await fh.write(cut.map((w) => `${JSON.stringify(w)}\n`).join(''));
      await fh.datasync();
    } finally {
      await fh.close();
    }
    this.windows.push(...cut);
    if (this.meta.liveTranscribe || this.meta.finalized || final) for (const w of cut) enqueue(this, w);
    this.refreshTranscriptStatus();
  }

  async pause(): Promise<RecordingInfo> {
    if (!this.isLive) throw new HttpError(409, smsg().recordings.live.notRecording);
    this.lastActivity = Date.now();
    if (this.meta.status !== 'paused') {
      this.meta.status = 'paused';
      this.seg?.addBreak(this.committedMs());
      await this.cutWindows(false);
      await this.saveMeta();
    }
    this.emitStatus(true);
    return this.info();
  }

  async resume(): Promise<RecordingInfo> {
    if (!this.isLive) throw new HttpError(409, smsg().recordings.live.notRecording);
    this.lastActivity = Date.now();
    if (this.meta.status !== 'recording') {
      this.meta.status = 'recording';
      await this.saveMeta();
    }
    this.emitStatus(true);
    return this.info();
  }

  /** Stop: `bytes` (optional) = everything the client captured; the recording ends once that much is stored. */
  async stop(bytes: number | undefined): Promise<RecordingInfo> {
    if (this.meta.source !== 'live') throw new HttpError(409, smsg().recordings.live.uploadCannotStop);
    if (this.meta.finalized) return this.info();
    this.lastActivity = Date.now();
    if (bytes !== undefined) {
      if (bytes < this.committed) throw new HttpError(409, smsg().recordings.live.stopBeforeStored, { offset: this.committed });
      this.meta.stopBytes = bytes;
    }
    this.meta.stoppedAt ??= new Date().toISOString();
    if (bytes === undefined || this.committed >= bytes) await this.finalize();
    else await this.saveMeta();
    this.emitStatus(true);
    return this.info();
  }

  /** All audio is in: cut the last window, close the files, transcribe what is left, align. */
  private async finalize(): Promise<void> {
    if (this.meta.finalized) return;
    this.meta.finalized = true;
    // The last window ends at the exact end of the audio (a break at the last whole frame would leave a sliver).
    await this.cutWindows(true);
    this.seg = null;
    await this.live?.close();
    this.live = null;
    this.meta.status = 'ready';
    this.meta.stoppedAt ??= new Date().toISOString();
    delete this.meta.stopBytes;
    if (liveKey === this.key) liveKey = null;
    this.refreshTranscriptStatus();
    await this.saveMeta();
    this.queuePendingWindows();
    if (this.windowsLeft() === 0) void this.track(this.realign());
  }

  /**
   * A question about the lecture being recorded: the audio not in a window yet becomes one now (cut at its last pause,
   * else at its end) and is queued. Returns the index of the last window, or -1. Nothing when paused (the pause cut
   * one already) or without live transcription.
   */
  async cutForQuestion(): Promise<number> {
    if (this.isLive && this.meta.status === 'recording' && this.meta.liveTranscribe && this.seg) {
      await this.cutWindows(false);
      const w = this.seg.cutNow();
      if (w) await this.addWindows([w], false);
    }
    return this.windows.at(-1)?.i ?? -1;
  }

  /** Audio (ms) of the windows up to `last` not transcribed yet. */
  backlogMs(last: number): number {
    const done = new Set(this.transcript.doneWindows);
    return this.windows.filter((w) => w.i <= last && !done.has(w.i)).reduce((sum, w) => sum + (w.ownEndMs - w.ownStartMs), 0);
  }

  /** Resolves when every window up to `last` is transcribed, after `ms`, or when `signal` aborts. */
  async waitForWindows(last: number, ms: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.backlogMs(last) > 0 && Date.now() < deadline && !this.deleted && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The live recording's speech counts as "the last minutes of the lecture" (audio or a pause/resume lately). */
  get speechIsLive(): boolean {
    return this.isLive && Date.now() - this.lastActivity < config.liveSpeechIdleMs;
  }

  // --- slide timeline -------------------------------------------------------------------------------------------

  async addSlideEvents(events: SlideViewEvent[]): Promise<void> {
    const seen = new Set(this.timeline.map((e) => `${e.t}:${e.slide}`));
    const fresh = events.filter((e) => !seen.has(`${e.t}:${e.slide}`));
    if (fresh.length === 0) return;
    this.timeline = [...this.timeline, ...fresh].sort((a, b) => a.t - b.t);
    await writeTimeline(this.docId, this.id, this.timeline);
  }

  // --- transcription --------------------------------------------------------------------------------------------

  windowsLeft(): number {
    const done = new Set(this.transcript.doneWindows);
    return this.windows.filter((w) => !done.has(w.i)).length;
  }

  /** Queues every window that is not done (restart, stop of a recording without live transcription). */
  queuePendingWindows(): void {
    if (this.meta.source === 'live' && !this.meta.liveTranscribe && !this.meta.finalized) return;
    if (this.meta.source === 'upload' && this.meta.status !== 'ready') return;
    const done = new Set(this.transcript.doneWindows);
    for (const w of this.windows) if (!done.has(w.i)) enqueue(this, w);
    this.refreshTranscriptStatus();
  }

  refreshTranscriptStatus(): void {
    const m = this.meta;
    const recording = m.source === 'live' && !m.finalized;
    const left = this.windowsLeft();
    let status = m.transcriptStatus;
    if (runningJob?.rec === this) status = 'running';
    else if (m.source === 'upload' && m.status === 'converting') status = 'queued';
    else if (m.source === 'upload' && m.status === 'error') status = 'none';
    else if (recording && !m.liveTranscribe) status = 'none';
    else if (left > 0) status = 'queued';
    // Live transcription follows the audio: nothing waits right now, more is coming.
    else if (recording) status = this.windows.length > 0 || this.committed > 0 ? 'running' : 'queued';
    else {
      const failed = Object.keys(this.transcript.failedWindows).length;
      status = failed > 0 && failed >= this.windowsWithSpeech() ? 'error' : 'ready';
    }
    m.transcriptStatus = status;
  }

  private windowsWithSpeech(): number {
    return this.windows.filter((w) => w.speechMs >= MIN_SPEECH_MS).length;
  }

  private async pcmSource(): Promise<{ file: string; dataOffset: number; dataBytes: number }> {
    if (this.meta.source === 'live') return { file: this.paths.audioPcm, dataOffset: 0, dataBytes: this.committed };
    this.wavInfo ??= await readWavInfo(this.paths.asrWav);
    return { file: this.paths.asrWav, ...this.wavInfo };
  }

  /** Language to force for a window: the recording's, or the one detected for 'auto'. */
  private async languageFor(engine: string, model: { model: string; vad: string }, signal: AbortSignal): Promise<string> {
    if (this.meta.language !== 'auto') return this.meta.language;
    if (this.meta.detectedLanguage) return this.meta.detectedLanguage;
    if (this.meta.source === 'upload') {
      // Detect on 30 s from the middle (the first 30 s are often chatter before class), then force it.
      const src = await this.pcmSource();
      const mid = Math.max(0, Math.floor(src.dataBytes / 2 / 2) * 2 - (DETECT_CLIP_MS / 1000) * BYTES_PER_SECOND / 2);
      const clip = path.join(this.paths.dir, `.detect-${randomBytes(3).toString('hex')}.wav`);
      try {
        await writeWavSlice(src.file, src.dataOffset, mid, mid + (DETECT_CLIP_MS / 1000) * BYTES_PER_SECOND, clip);
        const lang = await detectLanguage({ bin: engine, model: model.model, vadModel: model.vad, wav: clip, signal });
        if (lang) {
          this.meta.detectedLanguage = lang;
          await this.saveMeta();
          return lang;
        }
      } catch (err) {
        if (signal.aborted) throw err;
        console.warn(`[recordings] ${this.id}: language detection failed: ${errorText(err)}`);
      } finally {
        await fs.rm(clip, { force: true }).catch(() => {});
      }
    }
    return 'auto';
  }

  /** Transcribes one window (called by the queue; one at a time server-wide). */
  async transcribeWindow(w: AsrWindow, engine: string, model: { model: string; vad: string }, signal: AbortSignal): Promise<void> {
    if (w.speechMs < MIN_SPEECH_MS) {
      await this.serial(() => this.windowDone(w, [], null));
      return;
    }
    let lastError = '';
    for (let attempt = 1; attempt <= WINDOW_ATTEMPTS; attempt++) {
      this.progress = null;
      const wav = path.join(this.paths.dir, `.window-${w.i}.wav`);
      try {
        const src = await this.pcmSource();
        const startByte = Math.floor((w.startMs / 1000) * BYTES_PER_SECOND / 2) * 2;
        const endByte = Math.min(src.dataBytes, Math.ceil((w.endMs / 1000) * BYTES_PER_SECOND / 2) * 2);
        const whole = this.meta.source === 'upload' && startByte === 0 && endByte >= src.dataBytes;
        if (!whole) await writeWavSlice(src.file, src.dataOffset, startByte, endByte, wav);
        const language = await this.languageFor(engine, model, signal);
        const result = await runWhisper({
          bin: engine,
          model: model.model,
          vadModel: model.vad,
          wav: whole ? this.paths.asrWav : wav,
          outBase: path.join(this.paths.dir, `.window-${w.i}`),
          language,
          prompt: this.contextBefore(w),
          signal,
          onProgress: (fraction) => {
            if (this.deleted) return;
            const sec = (w.ownStartMs + fraction * (w.ownEndMs - w.ownStartMs)) / 1000;
            if (this.progress?.i === w.i && this.progress.sec >= sec) return;
            this.progress = { i: w.i, sec };
            this.emitStatus();
          },
        });
        if (language === 'auto' && result.language && w.speechMs >= DETECT_MIN_SPEECH_MS && this.meta.language === 'auto') {
          this.meta.detectedLanguage = result.language;
        }
        const own = ownSegments(w, result.segments);
        await this.serial(() => this.windowDone(w, own, null));
        return;
      } catch (err) {
        if (signal.aborted || this.deleted) return;
        lastError = errorText(err);
        console.warn(`[recordings] ${this.id}: window ${w.i} attempt ${attempt} failed: ${lastError}`);
      } finally {
        await fs.rm(wav, { force: true }).catch(() => {});
      }
    }
    await this.serial(() => this.windowDone(w, [], smsg().recordings.transcription.failed(lastError)));
  }

  /**
   * A later chunk of an upload, for models that need it (models.ts carryContext): the end of what was said before it,
   * as whisper's prompt. Nothing for live windows, the first chunk, or when the chunk before is not transcribed.
   */
  private contextBefore(w: AsrWindow): string | undefined {
    if (this.meta.source !== 'upload' || w.i === 0 || !config.models.model(this.meta.model)?.carryContext) return undefined;
    const from = w.ownStartMs / 1000;
    const before = this.transcript.segments.filter((s) => s.end <= from + 0.5 && s.start < from);
    return before.length > 0 ? contextPrompt(before.map((s) => s.text).join(' ')) : undefined;
  }

  private async windowDone(w: AsrWindow, segments: Array<{ start: number; end: number; text: string }>, error: string | null): Promise<void> {
    if (this.progress?.i === w.i) this.progress = null;
    if (this.transcript.doneWindows.includes(w.i)) return;
    const live = this.meta.source === 'live';
    const { prior, changed } = live ? await this.livePrior(segments) : { prior: segments.map(() => null), changed: false };
    const fresh: TranscriptSegment[] = segments.map((s, k) => ({ id: this.transcript.nextId++, start: s.start, end: s.end, text: s.text, slide: prior[k] }));
    if (live) for (const s of fresh) this.recentPrior.set(s.id, s.slide);
    this.transcript.segments.push(...fresh);
    this.transcript.segments.sort((a, b) => a.start - b.start || a.id - b.id);
    this.transcript.doneWindows.push(w.i);
    this.transcript.doneWindows.sort((a, b) => a - b);
    if (error) {
      this.transcript.failedWindows[String(w.i)] = error;
      this.meta.error = error;
    }
    await writeTranscriptState(this.docId, this.transcript);
    this.meta.transcribedSec = this.contiguousDoneSec();
    if (fresh.length > 0 && this.meta.alignment === 'none') this.meta.alignment = this.meta.source === 'live' && this.timeline.length > 0 ? 'timeline' : 'none';
    this.refreshTranscriptStatus();
    await this.saveMeta();
    for (const s of fresh) this.hub.send({ type: 'segment', segment: { ...s } }, s.id);
    this.emitStatus(true);
    const finished = this.windowsLeft() === 0 && (this.meta.source === 'upload' || this.meta.finalized === true);
    if (finished) void this.track(this.realign());
    else if (live && this.transcript.segments.length > 0 && (changed || Date.now() - this.lastAlignAt >= config.liveRealignMs)) {
      // A back-visit adopted (or dropped) for segments already shown is relabelled now, not after liveRealignMs.
      void this.track(this.realign());
    }
  }

  /**
   * Live: the timeline prior of a window's segments. The lecture timeline's back-visits are decided with the speech of
   * the last LIVE_CONTEXT_SEGMENTS segments (align.ts); `changed`: the prior of a segment shown before changed since
   * the last window (the student's look back became the lecture's once enough was said, or the other way round).
   */
  private async livePrior(segments: Array<{ start: number; end: number; text: string }>): Promise<{ prior: Array<number | null>; changed: boolean }> {
    const room = LIVE_CONTEXT_SEGMENTS - segments.length;
    const recent = room > 0 ? this.transcript.segments.slice(-room) : [];
    const ctx = [...recent.map((s) => ({ ...s, fresh: -1 })), ...segments.map((s, k) => ({ ...s, id: -1, fresh: k }))].sort((a, b) => a.start - b.start);
    // The deck is read once (alignOnce keeps it up to date); if it cannot be read the window is still labelled.
    this.material ??= await deckOf(this.docId).then((deck) => deck.entries.map(slideMaterial), () => null);
    const material = this.material;
    const texts = ctx.map((s) => s.text);
    // Without any slide text there is no evidence to gate by (as in alignSegments): a look back needs BACK_SEC.
    const evidence = material && hasSlideText(material) ? () => emissions(simMatrix(this.indexOf(material), texts), texts, DEFAULT_EMIT).E : undefined;
    const all = timelinePrior(ctx, this.timeline, this.durationSec(), evidence);
    const prior = segments.map((): number | null => null);
    let changed = false;
    const next = new Map<number, number | null>();
    ctx.forEach((s, i) => {
      if (s.fresh >= 0) prior[s.fresh] = all[i];
      else {
        if (this.recentPrior.has(s.id) && this.recentPrior.get(s.id) !== all[i]) changed = true;
        next.set(s.id, all[i]);
      }
    });
    this.recentPrior = next;
    return { prior, changed };
  }

  private indexOf(material: string[]): LexIndex {
    if (!this.lexIndex || !sameTexts(this.lexIndex.material, material)) this.lexIndex = { material, index: buildIndex(material) };
    return this.lexIndex.index;
  }

  private contiguousDoneSec(): number {
    const done = new Set(this.transcript.doneWindows);
    let end = 0;
    for (const w of this.windows) {
      if (!done.has(w.i)) break;
      end = w.ownEndMs;
    }
    return end / 1000;
  }

  // --- alignment ------------------------------------------------------------------------------------------------

  /** Full alignment in a worker (serialized: a request while one runs runs once more afterwards). */
  realign(): Promise<void> {
    if (this.aligning) {
      this.alignAgain = true;
      return this.aligning;
    }
    this.aligning = (async () => {
      try {
        do {
          this.alignAgain = false;
          await this.alignOnce();
        } while (this.alignAgain && !this.deleted);
      } catch (err) {
        if (!this.deleted) console.warn(`[recordings] ${this.id}: alignment failed: ${errorText(err)}`);
      } finally {
        this.aligning = null;
      }
    })();
    return this.aligning;
  }

  /** A local alignment runs (or waits to run once more). */
  get isAligning(): boolean {
    return this.aligning !== null;
  }

  /** Resolves when no local alignment runs. */
  async settleAlignment(): Promise<void> {
    while (this.aligning) await this.aligning;
  }

  private async alignOnce(): Promise<void> {
    this.lastAlignAt = Date.now();
    const gen = this.deckGen;
    const snapshot = this.transcript.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text }));
    if (snapshot.length === 0 || this.deleted) return;
    const material = (await deckOf(this.docId)).entries.map(slideMaterial);
    if (!this.material || !sameTexts(this.material, material)) this.material = material;
    const llm = this.llm;
    const labels = await alignInWorker({
      slideTexts: material,
      segments: snapshot,
      timeline: this.meta.source === 'live' ? { events: this.timeline, endSec: this.durationSec() } : undefined,
      markers: this.markers,
      llm: llm ? snapshot.map((s) => (String(s.id) in llm.labels ? llm.labels[String(s.id)] : undefined)) : undefined,
    });
    if (this.deleted) return;
    await this.serial(async () => {
      // The deck was swapped meanwhile (DESIGN §28): these labels count the old slides, so align once more.
      if (gen !== this.deckGen) this.alignAgain = true;
      else await this.applyLabels(snapshot.map((s) => s.id), labels, llm ? 'llm' : 'lexical');
    });
  }

  private async applyLabels(ids: number[], labels: Label[], kind: AlignmentKind): Promise<void> {
    const byId = new Map(this.transcript.segments.map((s) => [s.id, s]));
    const changed: Array<{ id: number; slide: number | null }> = [];
    ids.forEach((id, i) => {
      const s = byId.get(id);
      const slide = labels[i] ?? null;
      if (s && s.slide !== slide) {
        s.slide = slide;
        changed.push({ id, slide });
      }
    });
    if (changed.length > 0) await writeTranscriptState(this.docId, this.transcript);
    if (this.meta.alignment !== kind) {
      this.meta.alignment = kind;
      await this.saveMeta();
    }
    if (changed.length > 0) this.hub.send({ type: 'realigned', segments: changed });
    this.emitStatus(true);
  }

  async setMarkers(markers: AlignmentMarker[]): Promise<void> {
    this.markers = markers;
    await writeMarkers(this.docId, this.id, markers);
    this.meta.hasManualMarkers = markers.length > 0;
    await this.saveMeta();
  }

  // --- new version of the lecture (DESIGN §28) ------------------------------------------------------------------

  /**
   * The lecture's deck was swapped: the segments' slides, the timeline, the markers and the AI labels follow `map`.
   * A segment on a removed slide loses it (null), events / markers / labels on one are dropped; all of that is kept in
   * deck-r<fromRev>.json, and an undo (map.restoreRev) puts back what the swap from that rev kept, then removes its
   * file. Only a recording numbered in map.fromRev (meta.deckRev, absent = 0) is renumbered, then marked map.toRev;
   * what it writes is in the archive first, so a crash repeats the same writes. An undo that finds it still in the deck
   * coming back (map.restoreRev: the apply gave it up) only marks it; any other numbering is left alone. No realign.
   * Runs in serial().
   */
  async remapDeck(map: DeckMap): Promise<void> {
    const mark = this.meta.deckRev ?? 0;
    if (mark !== map.fromRev) {
      if (map.restoreRev === undefined || mark !== map.restoreRev) return;
      this.deckGen++;
      await removeDeckArchive(this.docId, this.id, map.restoreRev);
      this.meta.deckRev = map.toRev;
      await this.saveMeta();
      // The live deck changed all the same.
      this.material = null;
      this.lexIndex = null;
      this.recentPrior.clear();
      return;
    }
    this.deckGen++;
    let archive = await readDeckArchive(this.docId, this.id, map.fromRev);
    if (archive?.toRev !== map.toRev || !archive.next) {
      archive = await this.deckArchive(map);
      await writeDeckArchive(this.docId, this.id, archive);
    }
    const next = archive.next as NonNullable<DeckArchive['next']>;
    const changed: Array<{ id: number; slide: number | null }> = [];
    for (const s of this.transcript.segments) {
      const slide = next.slides[String(s.id)];
      if (slide !== undefined && s.slide !== slide) {
        s.slide = slide;
        changed.push({ id: s.id, slide });
      }
    }
    if (changed.length > 0) await writeTranscriptState(this.docId, this.transcript);
    if (!sameJson(this.timeline, next.timeline)) {
      this.timeline = next.timeline;
      await writeTimeline(this.docId, this.id, this.timeline);
    }
    if (!sameJson(this.markers, next.markers)) await this.setMarkers(next.markers);
    if (next.llm && !sameJson(this.llm, next.llm)) {
      this.llm = next.llm;
      await writeLlmLabels(this.docId, this.id, next.llm);
    }
    if (map.restoreRev !== undefined) await removeDeckArchive(this.docId, this.id, map.restoreRev);
    this.meta.deckRev = map.toRev;
    await this.saveMeta();
    // What the undo needs stays (nothing cleared: no file).
    const c = archive.cleared;
    if (Object.keys(c.segments).length + c.timeline.length + c.markers.length + Object.keys(c.llm).length === 0) {
      await removeDeckArchive(this.docId, this.id, map.fromRev);
    } else await writeDeckArchive(this.docId, this.id, { fromRev: map.fromRev, toRev: map.toRev, cleared: c });
    // The slide material and what was derived from it belong to the old deck.
    this.material = null;
    this.lexIndex = null;
    this.recentPrior.clear();
    if (changed.length > 0) this.hub.send({ type: 'realigned', segments: changed });
    this.emitStatus(true);
  }

  /** The archive of a remap: what it clears and drops, and the state it writes (with the undo's restore in it). */
  private async deckArchive(map: DeckMap): Promise<DeckArchive> {
    const to = (slide: number): number | null => map.oldToNew[slide - 1] ?? null;
    const cleared: DeckArchive['cleared'] = { segments: {}, timeline: [], markers: [], llm: {} };
    const slides: Record<string, number | null> = {};
    for (const s of this.transcript.segments) {
      const slide = s.slide === null ? null : to(s.slide);
      if (s.slide !== null && slide === null) cleared.segments[String(s.id)] = s.slide;
      slides[String(s.id)] = slide;
    }
    const timeline: SlideViewEvent[] = [];
    for (const e of this.timeline) {
      const slide = to(e.slide);
      if (slide === null) cleared.timeline.push(e);
      else timeline.push({ t: e.t, slide });
    }
    const markers: AlignmentMarker[] = [];
    for (const m of this.markers) {
      const slide = m.slide === null ? null : to(m.slide);
      if (m.slide !== null && slide === null) cleared.markers.push(m);
      else markers.push({ t: m.t, slide });
    }
    let llm: LlmLabels | null = null;
    if (this.llm) {
      const labels: Record<string, number | null> = {};
      for (const [id, label] of Object.entries(this.llm.labels)) {
        const slide = typeof label === 'number' ? to(label) : null;
        if (typeof label === 'number' && slide === null) cleared.llm[id] = label;
        else labels[id] = slide;
      }
      llm = { ...this.llm, labels };
    }
    const restore = map.restoreRev === undefined ? null : await readDeckArchive(this.docId, this.id, map.restoreRev);
    if (restore) {
      // What the swap being undone took away; what was set since (a marker at the same time, a new label) stays.
      const back = restore.cleared;
      for (const [id, slide] of Object.entries(back.segments)) if (slides[id] === null) slides[id] = slide;
      const seen = new Set(timeline.map((e) => `${e.t}:${e.slide}`));
      timeline.push(...back.timeline.filter((e) => !seen.has(`${e.t}:${e.slide}`)));
      timeline.sort((a, b) => a.t - b.t);
      const times = new Set(markers.map((m) => m.t));
      markers.push(...back.markers.filter((m) => !times.has(m.t)));
      markers.sort((a, b) => a.t - b.t);
      if (llm) for (const [id, slide] of Object.entries(back.llm)) if (!(id in llm.labels)) llm.labels[id] = slide;
    }
    return { fromRev: map.fromRev, toRev: map.toRev, cleared, next: { slides, timeline, markers, llm } };
  }

  // --- uploads --------------------------------------------------------------------------------------------------

  async convert(): Promise<void> {
    const controller = new AbortController();
    this.jobs.add(controller);
    const release = await conversionSlot(controller.signal).catch(() => null);
    try {
      if (!release || this.deleted) return;
      const ffmpeg = findFfmpeg();
      if (!ffmpeg) throw Object.assign(new Error('ffmpeg not found'), { code: 'ENOENT' });
      await convertUpload({
        ffmpeg: ffmpeg.path,
        source: path.join(this.paths.dir, this.meta.sourceFile ?? 'source'),
        asrWav: this.paths.asrWav,
        playback: this.paths.playback,
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.deleted || this.closed) return;
      const info = await readWavInfo(this.paths.asrWav);
      this.wavInfo = info;
      await this.serial(async () => {
        this.meta.durationSec = round3(info.dataBytes / BYTES_PER_SECOND);
        this.meta.status = 'ready';
        delete this.meta.error;
        await this.saveMeta();
      });
      await this.serial(() => this.cutUploadWindows());
      this.queuePendingWindows();
      await this.serial(() => this.saveMeta());
      this.emitStatus(true);
    } catch (err) {
      if (controller.signal.aborted || this.deleted) return;
      const message = conversionError(err);
      console.warn(`[recordings] ${this.id}: conversion failed: ${errorText(err)}`);
      await this.serial(async () => {
        this.meta.status = 'error';
        this.meta.transcriptStatus = 'none';
        this.meta.error = message;
        await this.saveMeta();
      }).catch(() => {});
      this.emitStatus(true);
    } finally {
      release?.();
      this.jobs.delete(controller);
    }
  }

  /** Cuts an uploaded recording into windows (one when it fits, else ≤ 15 min at pauses) and persists them. */
  private async cutUploadWindows(): Promise<void> {
    if (this.windows.length > 0) return;
    const info = await this.pcmSource();
    const seg = new Segmenter({ preset: uploadPresetFor((info.dataBytes / BYTES_PER_SECOND) * 1000, config.uploadPreset) });
    const fh = await fs.open(info.file, 'r');
    try {
      const piece = Buffer.alloc(1 << 20);
      for (let at = 0; at < info.dataBytes; at += piece.length) {
        const n = Math.min(piece.length, info.dataBytes - at);
        const { bytesRead } = await fh.read(piece, 0, n, info.dataOffset + at);
        if (bytesRead <= 0) break;
        seg.feed(Buffer.from(piece.subarray(0, bytesRead)), at);
      }
    } finally {
      await fh.close();
    }
    this.windows = seg.poll(true);
    await writeJsonLines(this.paths.windows, this.windows);
    if (this.windows.length === 0) {
      this.meta.transcriptStatus = 'ready';
      await this.saveMeta();
    }
  }

  // --- teardown -------------------------------------------------------------------------------------------------

  /** Stops everything of this recording (deletion). The files are removed by the caller. */
  async shutdown(): Promise<void> {
    this.deleted = true;
    for (const job of this.jobs) job.abort();
    const running = dropJobsOf(this);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.hub.closeAll();
    if (liveKey === this.key) liveKey = null;
    await Promise.all([this.settleBackground(), running]);
    await this.chain.catch(() => {});
    await this.live?.close();
    this.live = null;
  }

  /** Closes the files and streams without deleting anything (server shutdown). */
  async close(): Promise<void> {
    for (const job of this.jobs) job.abort();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.hub.closeAll();
    await this.settleBackground();
    this.closed = true;
    await this.chain.catch(() => {});
    await this.live?.close();
    this.live = null;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * The segments whisper found in a window, on the recording clock (+ the window's start, clamped to the audio it
 * heard), that belong to this window: the midpoint decides only where windows overlap — after a hard cut ('max') the
 * next window starts OVERLAP earlier and hears the end again, so text past the own region is left to it, and the
 * start of a window that overlaps its predecessor is left to that one. Everywhere else the audio was heard by this
 * window alone, so nothing it found there is dropped (whisper may stamp the last words slightly past the end).
 */
export function ownSegments(w: AsrWindow, segments: Array<{ start: number; end: number; text: string }>): Array<{ start: number; end: number; text: string }> {
  const from = w.startMs / 1000;
  const to = w.endMs / 1000;
  return segments
    .filter((s) => {
      // Decided on whisper's own times (the next window sees the same words at the same recording time).
      const mid = (from + (s.start + s.end) / 2) * 1000;
      if (w.startMs < w.ownStartMs && mid < w.ownStartMs) return false;
      return w.cut !== 'max' || mid < w.ownEndMs;
    })
    .map((s) => {
      const start = round3(Math.min(to, Math.max(from, s.start + from)));
      return { start, end: round3(Math.min(to, Math.max(start, s.end + from))), text: s.text };
    });
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (err) {
    if (isNotFound(err)) return 0;
    throw err;
  }
}

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    await fh.read(buf, 0, buf.length, start);
    return buf;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Deck material for alignment
// ---------------------------------------------------------------------------------------------------------------

export interface DeckEntry {
  slide: number;
  title: string;
  digest: string;
  text: string;
}

export interface Deck {
  entries: DeckEntry[];
  /** The language the digest was made in: its takeaway lines are "핵심:" (Korean, also older digests) or "Key point:". */
  digestLang: Lang;
}

/** Per slide: digest title and markdown (when present and not failed) and the extracted text. */
export async function deckOf(docId: string): Promise<Deck> {
  const assets = await loadDocAssets(docId);
  const digest = new Map((assets.digest ?? []).filter((d) => !d.failed).map((d) => [d.slide, d]));
  const entries = Array.from({ length: assets.meta.pageCount }, (_, i) => {
    const d = digest.get(i + 1);
    return { slide: i + 1, title: d?.title ?? '', digest: d?.markdown ?? '', text: assets.texts[i] ?? '' };
  });
  return { entries, digestLang: assets.digestLang ?? DEFAULT_LANG };
}

/** The spike's slide document: title twice + digest (markdown stripped) + extracted text. */
function slideMaterial(d: DeckEntry): string {
  return `${d.title}\n${d.title}\n${stripMarkdown(d.digest)}\n${d.text}`;
}

const sameTexts = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------

const recs = new Map<string, Promise<Rec>>();
/** The loaded ones of `recs` (synchronous access: idle unloading, touching on every request). */
const loaded = new Map<string, Rec>();
/** Recordings being deleted (`docId/rid`). */
const deleting = new Set<string>();
/** The one live recording of the server (status recording/paused), `docId/rid`. */
let liveKey: string | null = null;
let stopping = false;

function recKey(docId: string, rid: string): string {
  return `${docId}/${rid}`;
}

async function loadRec(docId: string, rid: string): Promise<Rec> {
  if (!isRecordingId(rid)) throw new HttpError(404, smsg().recordings.notFound.recording);
  const key = recKey(docId, rid);
  if (deleting.has(key)) throw new HttpError(404, smsg().recordings.notFound.recording);
  let pending = recs.get(key);
  const known = loaded.get(key);
  if (known) known.lastUsed = Date.now();
  if (!pending) {
    const load = async (): Promise<Rec> => {
      const meta = await readMeta(docId, rid);
      if (!meta) throw new HttpError(404, smsg().recordings.notFound.recording);
      const rec = new Rec(meta);
      await rec.init();
      if (rec.isLive && !liveKey) liveKey = rec.key;
      return rec;
    };
    const mine: Promise<Rec> = load().then((rec) => {
      // Still the registered one (not deleted or forgotten while it loaded): reachable for touching and unloading.
      if (recs.get(key) === mine) loaded.set(key, rec);
      return rec;
    });
    pending = mine;
    recs.set(key, pending);
    pending.catch(() => recs.delete(key));
    startUnloadSweep();
  }
  return pending;
}

let unloadTimer: NodeJS.Timeout | null = null;

/** Every minute (or idleUnloadMs when shorter): drop idle recordings from memory (DESIGN §15). */
function startUnloadSweep(): void {
  if (unloadTimer) return;
  unloadTimer = setInterval(unloadIdle, Math.max(20, Math.min(60_000, config.idleUnloadMs)));
  unloadTimer.unref?.();
}

/** Synchronous (no await): nothing can pick a recording up between the check and its removal. */
function unloadIdle(): void {
  const now = Date.now();
  for (const [key, rec] of [...loaded]) {
    if (recs.get(key) === undefined || !rec.idle(now)) continue;
    recs.delete(key);
    loaded.delete(key);
    rec.hub.closeAll();
  }
  if (recs.size === 0 && unloadTimer) {
    clearInterval(unloadTimer);
    unloadTimer = null;
  }
}

/** Recordings held in memory (tests, diagnostics). */
export function loadedRecordings(): number {
  return recs.size;
}

async function requireReadyDoc(docId: string): Promise<{ pageCount: number }> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  if (doc.status !== 'ready') throw new HttpError(409, smsg().recordings.docNotReady);
  return { pageCount: doc.pageCount };
}

async function requireDocExists(docId: string): Promise<void> {
  if (!(await readStoredDoc(docId))) throw new HttpError(404, smsg().common.notFound.doc);
}

/**
 * A new recording's slides will be numbered in the lecture's current deck (DESIGN §28): meta.deckRev, so a later undo
 * of the swap to it maps them back (absent = deck 0).
 */
async function stampDeckRev(meta: RecordingMeta): Promise<void> {
  const deckRev = (await readStoredDoc(meta.docId))?.deckRev;
  if (deckRev) meta.deckRev = deckRev;
}

/** While the lecture is swapped to a new version (DESIGN §28) its recordings take no writes, like the rest of it. */
function refuseWhileSwapping(docId: string): void {
  if (isDocSwapping(docId)) throw new HttpError(409, smsg().library.versions.swapping);
}

// ---------------------------------------------------------------------------------------------------------------
// Transcription queue (one whisper process at a time)
// ---------------------------------------------------------------------------------------------------------------

interface Job {
  rec: Rec;
  window: AsrWindow;
}

const queue: Job[] = [];
let runningJob: (Job & { controller: AbortController; done: Promise<void> }) | null = null;
let pumping = false;

function enqueue(rec: Rec, window: AsrWindow): void {
  if (rec.deleted) return;
  if (runningJob?.rec === rec && runningJob.window.i === window.i) return;
  if (queue.some((j) => j.rec === rec && j.window.i === window.i)) return;
  queue.push({ rec, window });
  pumpQueue();
}

/** Removes a recording's queued jobs and stops its running one; resolves when that one has ended. */
function dropJobsOf(rec: Rec): Promise<void> {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].rec === rec) queue.splice(i, 1);
  if (runningJob?.rec !== rec) return Promise.resolve();
  runningJob.controller.abort();
  return runningJob.done;
}

let warming: Promise<void> | null = null;

/**
 * Right after a model download on Apple Silicon: one short run so that Metal compiles its shaders now (about 15 s,
 * once per build and machine) and not in the first window of a lecture. Only when nothing else waits; no VAD (it
 * would skip the silent input before the encoder runs).
 */
function warmUp(modelId: string): void {
  if (!usesMetal() || runningJob || warming || queue.length > 0 || stopping) return;
  const engine = findWhisper();
  const model = config.models.paths(modelId);
  if (!engine || !existsSync(engine.path) || !model) return;
  warming = (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-warmup-'));
    try {
      const wav = path.join(dir, 'silence.wav');
      await fs.writeFile(wav, Buffer.concat([wavHeader(BYTES_PER_SECOND), Buffer.alloc(BYTES_PER_SECOND)]));
      await runWhisper({ bin: engine.path, model: model.model, vadModel: model.vad, wav, outBase: path.join(dir, 'out'), language: 'en', vad: false });
    } catch (err) {
      console.warn(`[recordings] warm-up of ${modelId} failed: ${errorText(err)}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })().finally(() => {
    warming = null;
    pumpQueue();
  });
}

/** Starts the next job when none runs and the engine and the job's model are there (live windows first). */
export function pumpQueue(): void {
  if (runningJob || pumping || stopping || warming || queue.length === 0) return;
  const engine = findWhisper();
  // A missing engine (not installed yet, a wrong EASY_STUDY_WHISPER) leaves the jobs waiting instead of failing them.
  if (!engine || !existsSync(engine.path)) return;
  const runnable = (j: Job) => config.models.isInstalled(j.rec.meta.model);
  let index = queue.findIndex((j) => j.rec.isLive && runnable(j));
  if (index < 0) index = queue.findIndex(runnable);
  if (index < 0) return;
  const [job] = queue.splice(index, 1);
  const model = config.models.paths(job.rec.meta.model);
  if (!model) return;
  const controller = new AbortController();
  let finished: () => void = () => {};
  runningJob = { ...job, controller, done: new Promise<void>((resolve) => (finished = resolve)) };
  job.rec.refreshTranscriptStatus();
  job.rec.emitStatus();
  pumping = true;
  void (async () => {
    try {
      // In the recording's language (its errors are stored): the queue runs from whichever request pumped it.
      await runInLang(job.rec.lang, () => job.rec.transcribeWindow(job.window, engine.path, model, controller.signal));
    } catch (err) {
      if (!controller.signal.aborted) console.warn(`[recordings] transcription job failed: ${errorText(err)}`);
    } finally {
      runningJob = null;
      pumping = false;
      if (!job.rec.deleted) {
        job.rec.refreshTranscriptStatus();
        try {
          await job.rec.serial(() => job.rec.saveMeta());
          job.rec.emitStatus();
        } catch {
          // deleted or closed meanwhile
        }
      }
      finished();
      setImmediate(pumpQueue);
    }
  })();
}

/** Jobs waiting and running (tests, diagnostics). */
export function queueState(): { queued: number; running: boolean } {
  return { queued: queue.length, running: runningJob !== null };
}

/** Resolves when no transcription job waits or runs (tests), false on timeout. */
export async function waitForTranscriptionIdle(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (runningJob || queue.some((j) => !j.rec.deleted && config.models.isInstalled(j.rec.meta.model) && existsSync(findWhisper()?.path ?? ''))) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

// Conversions: one ffmpeg at a time.
let conversionBusy: Promise<void> = Promise.resolve();
function conversionSlot(signal: AbortSignal): Promise<() => void> {
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => (release = resolve));
  const previous = conversionBusy;
  conversionBusy = previous.then(() => mine);
  return previous.then(() => {
    if (signal.aborted) {
      release();
      throw new Error('aborted');
    }
    return release;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Public operations (HTTP routes)
// ---------------------------------------------------------------------------------------------------------------

/** GET /api/asr */
export async function asrStatus(): Promise<AsrStatus> {
  const engine = findWhisper();
  // The GPU probe (once per engine and server) runs beside the version probe: acceleration and the recommended model wait for it.
  const gpu = engine && existsSync(engine.path) ? probeGpu(engine.path) : Promise.resolve(null);
  const status: AsrStatus = {
    engineAvailable: false,
    acceleration: 'cpu',
    ffmpegAvailable: false,
    models: [],
  };
  const m = smsg().recordings.engine;
  if (engine?.source === 'env' && !existsSync(engine.path)) {
    status.reason = m.missingEnv(engine.path);
  } else if (!engine) {
    status.reason = desktopMode(process.env, []) ? m.notFoundDesktop : m.missing;
  } else {
    const probe = await probeVersion(engine.path, '--version', /whisper\.cpp version:\s*(\S+)/);
    if (probe.ok) {
      status.engineAvailable = true;
      if (probe.version) status.engineVersion = probe.version;
    } else {
      status.reason = m.cannotRun(engine.path, probe.error ?? m.unknownError);
    }
  }
  const ffmpeg = findFfmpeg();
  if (ffmpeg) status.ffmpegAvailable = (await probeVersion(ffmpeg.path, '-version', /ffmpeg version\s+(\S+)/)).ok;
  await gpu;
  Object.assign(status, acceleration(engine));
  status.models = config.models.list(recommendedModel(engine));
  if (status.engineAvailable) pumpQueue();
  return status;
}

/**
 * What transcription runs on now: Metal on Apple Silicon; Vulkan when the engine's probe found a GPU that has not
 * failed; else the CPU (with why the GPU was turned off, when it was). Before the probe has ended: the CPU.
 */
export function acceleration(engine: ToolLocation | null = findWhisper()): Pick<AsrStatus, 'acceleration' | 'gpu' | 'gpuError'> {
  if (usesMetal()) return { acceleration: 'metal' };
  const state = engine ? gpuState(engine.path) : null;
  if (state?.device) return { acceleration: 'vulkan', gpu: { name: state.device.name, integrated: state.device.integrated } };
  return state?.error ? { acceleration: 'cpu', gpuError: state.error } : { acceleration: 'cpu' };
}

/**
 * turbo with Metal (Apple Silicon) or a discrete GPU (Vulkan); small on built-in graphics and CPU-only machines
 * (about 4× faster there).
 */
export function recommendedModel(engine: ToolLocation | null = findWhisper()): string {
  const now = acceleration(engine);
  return now.acceleration === 'metal' || (now.acceleration === 'vulkan' && !now.gpu?.integrated) ? TURBO_MODEL_ID : SMALL_MODEL_ID;
}

/** The recommended model if installed, else any installed model, else the recommended one (downloaded later). */
function defaultModel(): string {
  const recommended = recommendedModel();
  if (config.models.isInstalled(recommended)) return recommended;
  return config.models.catalog.models.find((m) => config.models.isInstalled(m.id))?.id ?? recommended;
}

export async function startModelDownload(modelId: string): Promise<void> {
  await config.models.startDownload(modelId);
}

export async function deleteModel(modelId: string): Promise<void> {
  if (runningJob && runningJob.rec.meta.model === modelId) throw new HttpError(409, smsg().recordings.models.inUse);
  await config.models.delete(modelId);
}

/** GET /api/docs/:docId/recordings — newest first. */
export async function listRecordings(docId: string): Promise<RecordingInfo[]> {
  await requireDocExists(docId);
  const out: RecordingInfo[] = [];
  for (const rid of await listRecordingIds(docId)) {
    const loaded = recs.get(recKey(docId, rid));
    if (loaded) {
      const rec = await loaded.catch(() => null);
      if (rec && !rec.deleted) out.push(rec.info());
      continue;
    }
    const meta = await readMeta(docId, rid);
    if (!meta) continue;
    const rec = new Rec(meta);
    if (meta.source === 'live') rec.committed = await fileSize(rec.paths.audioPcm);
    rec.markers = await readMarkers(docId, rid);
    out.push(rec.info());
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export async function getRecording(docId: string, rid: string): Promise<RecordingInfo> {
  return (await loadRec(docId, rid)).info();
}

export async function getTranscript(docId: string, rid: string): Promise<RecordingTranscript> {
  return (await loadRec(docId, rid)).transcriptView();
}

/** The live recording of the server, if any. */
export async function currentLiveRecording(): Promise<RecordingInfo | null> {
  return (await liveRec())?.info() ?? null;
}

async function liveRec(): Promise<Rec | null> {
  if (!liveKey) return null;
  const pending = recs.get(liveKey);
  const rec = pending ? await pending.catch(() => null) : null;
  return rec && rec.isLive && !rec.deleted ? rec : null;
}

/** The lecture language of each UI language: what a client that names none gets (the web's default is the same). */
const LECTURE_LANGUAGE: Record<Lang, RecordingLanguage> = { ko: 'ko', en: 'en' };

/** A request's lecture language; none named = the request's language (a Korean UI records Korean lectures). */
export function parseLanguage(value: unknown): RecordingLanguage {
  if (value === undefined || value === null) return LECTURE_LANGUAGE[slang()];
  if (typeof value !== 'string' || !LANGUAGES.includes(value as RecordingLanguage)) throw new HttpError(400, smsg().recordings.request.badLanguage);
  return value as RecordingLanguage;
}

export function parseModel(value: unknown): string {
  if (value === undefined || value === null || value === '') return defaultModel();
  if (typeof value !== 'string' || !config.models.model(value)) throw new HttpError(400, smsg().recordings.request.unknownAsrModel(String(value)));
  return value;
}

/** POST /api/docs/:docId/recordings (CreateLiveRecordingRequest) → 201. 409 while another live recording runs. */
export async function createLiveRecording(docId: string, body: Partial<Record<keyof CreateLiveRecordingRequest, unknown>>): Promise<RecordingInfo> {
  await requireReadyDoc(docId);
  const language = parseLanguage(body.language);
  const model = parseModel(body.model);
  if (body.liveTranscribe !== undefined && typeof body.liveTranscribe !== 'boolean') throw new HttpError(400, smsg().recordings.request.badLiveTranscribe);
  refuseWhileSwapping(docId);
  if (creatingLive) throw new HttpError(409, smsg().recordings.live.starting);
  creatingLive = docId;
  try {
    const live = await liveRec();
    // Stopped with audio still to come that never came (the device that recorded it is gone): end it with what is stored.
    if (live?.meta.stoppedAt && Date.now() - live.lastActivity >= config.staleStopMs) await live.serial(() => live.stop(undefined));
    const running = await liveRec();
    if (running) {
      const doc = await readStoredDoc(running.docId).catch(() => null);
      const docTitle = doc && running.docId !== docId ? doc.title : null;
      throw new HttpError(409, smsg().recordings.live.alreadyRecording(running.meta.title, docTitle), {
        recording: running.info(),
      });
    }
    return await createLive(docId, body, language, model);
  } finally {
    creatingLive = null;
  }
}

/** The document a live recording is being created for (one at a time). */
let creatingLive: string | null = null;

async function createLive(
  docId: string,
  body: Partial<Record<keyof CreateLiveRecordingRequest, unknown>>,
  language: RecordingLanguage,
  model: string,
): Promise<RecordingInfo> {
  const now = new Date();
  const id = newRecordingId(now);
  const meta: RecordingMeta = {
    version: 1,
    id,
    docId,
    title: cleanTitle(body.title) ?? defaultLiveTitle(now),
    source: 'live',
    status: 'recording',
    language,
    model,
    liveTranscribe: body.liveTranscribe !== false,
    createdAt: now.toISOString(),
    transcriptStatus: body.liveTranscribe === false ? 'none' : 'queued',
    transcribedSec: 0,
    alignment: 'none',
    hasManualMarkers: false,
    lang: slang(),
  };
  const paths = recordingPaths(docId, id);
  await fs.mkdir(paths.dir, { recursive: true });
  await LiveAudio.create(paths.audioPcm, paths.audioIdx);
  await stampDeckRev(meta);
  await writeMeta(meta);
  liveKey = recKey(docId, id);
  const rec = await loadRec(docId, id);
  return rec.info();
}

export async function appendLiveAudio(docId: string, rid: string, offset: number, body: Buffer): Promise<{ offset: number }> {
  refuseWhileSwapping(docId);
  const rec = await loadRec(docId, rid);
  return rec.serial(() => rec.append(offset, body), true);
}

export async function addSlideEvents(docId: string, rid: string, raw: unknown): Promise<void> {
  refuseWhileSwapping(docId);
  const { pageCount } = await requireReadyDoc(docId);
  if (!Array.isArray(raw) || raw.length > 1000) throw new HttpError(400, smsg().recordings.request.slideEventsRequired);
  const events: SlideViewEvent[] = raw.map((e: unknown) => {
    const ev = e as Partial<SlideViewEvent> | null;
    if (!ev || typeof ev.t !== 'number' || !Number.isFinite(ev.t) || ev.t < 0 || !Number.isInteger(ev.slide) || (ev.slide as number) < 1 || (ev.slide as number) > pageCount) {
      throw new HttpError(400, smsg().recordings.request.badSlideEvent(JSON.stringify(e).slice(0, 100)));
    }
    return { t: round3(ev.t), slide: ev.slide as number };
  });
  const rec = await loadRec(docId, rid);
  if (rec.meta.source !== 'live') throw new HttpError(409, smsg().recordings.request.uploadHasNoSlides);
  await rec.serial(() => rec.addSlideEvents(events), true);
}

export async function pauseRecording(docId: string, rid: string): Promise<RecordingInfo> {
  refuseWhileSwapping(docId);
  const rec = await loadRec(docId, rid);
  return rec.serial(() => rec.pause(), true);
}

export async function resumeRecording(docId: string, rid: string): Promise<RecordingInfo> {
  refuseWhileSwapping(docId);
  const rec = await loadRec(docId, rid);
  return rec.serial(() => rec.resume(), true);
}

export async function stopRecording(docId: string, rid: string, bytes: unknown): Promise<RecordingInfo> {
  refuseWhileSwapping(docId);
  if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new HttpError(400, smsg().recordings.request.badBytes);
  }
  const rec = await loadRec(docId, rid);
  return rec.serial(() => rec.stop(bytes as number | undefined), true);
}

export async function renameRecording(docId: string, rid: string, title: unknown): Promise<RecordingInfo> {
  refuseWhileSwapping(docId);
  const clean = cleanTitle(title);
  if (!clean) throw new HttpError(400, smsg().recordings.request.titleRequired);
  const rec = await loadRec(docId, rid);
  return rec.serial(async () => {
    rec.meta.title = clean;
    await rec.saveMeta();
    rec.emitStatus(true);
    return rec.info();
  }, true);
}

/** PUT …/markers: replaces the markers and re-aligns with them as hard constraints. */
export async function putMarkers(docId: string, rid: string, raw: unknown): Promise<RecordingTranscript> {
  refuseWhileSwapping(docId);
  const { pageCount } = await requireReadyDoc(docId);
  if (!Array.isArray(raw) || raw.length > 500) throw new HttpError(400, smsg().recordings.request.markersRequired);
  const byTime = new Map<number, AlignmentMarker>();
  for (const e of raw as unknown[]) {
    const m = e as Partial<AlignmentMarker> | null;
    const okSlide = m?.slide === null || (Number.isInteger(m?.slide) && (m?.slide as number) >= 1 && (m?.slide as number) <= pageCount);
    if (!m || typeof m.t !== 'number' || !Number.isFinite(m.t) || m.t < 0 || !okSlide) {
      throw new HttpError(400, smsg().recordings.request.badMarker(JSON.stringify(e).slice(0, 100)));
    }
    byTime.set(round3(m.t), { t: round3(m.t), slide: m.slide as number | null });
  }
  const markers = [...byTime.values()].sort((a, b) => a.t - b.t);
  const rec = await loadRec(docId, rid);
  await rec.serial(() => rec.setMarkers(markers), true);
  await rec.realign();
  return rec.transcriptView();
}

export async function deleteRecording(docId: string, rid: string): Promise<void> {
  refuseWhileSwapping(docId);
  const rec = await loadRec(docId, rid);
  // Until the folder is gone, nothing may load the recording again from its files (an SSE reconnect, a retry).
  deleting.add(rec.key);
  try {
    recs.delete(rec.key);
    loaded.delete(rec.key);
    await rec.shutdown();
    await removeDir(rec.paths.dir);
  } finally {
    deleting.delete(rec.key);
  }
}

async function removeDir(dir: string): Promise<void> {
  const trash = path.join(path.dirname(dir), `.deleted-${path.basename(dir)}-${randomBytes(3).toString('hex')}`);
  try {
    await renameWithRetry(dir, trash);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  await rmWithRetry(trash, { recursive: true, force: true }).catch((err: unknown) => {
    console.warn(`[recordings] could not remove ${trash}: ${errorText(err)}`);
  });
}

/** SSE subscription with replay: segments after `since`, and the slides of the older ones (they may have changed). */
export async function subscribe(docId: string, rid: string, target: SseTarget, since: number): Promise<() => void> {
  const rec = await loadRec(docId, rid);
  target.write('retry: 2000\n\n');
  // Queued behind pending mutations (segments and re-alignments are sent from inside them), and subscribed in the
  // same step: every segment reaches the subscriber exactly once, either in the replay or as a live event.
  await rec.serial(async () => {
    const frames: string[] = [];
    frames.push(sseFrame({ type: 'status', recording: rec.info() }));
    const older: Array<{ id: number; slide: number | null }> = [];
    for (const s of rec.transcript.segments) {
      if (s.id > since) frames.push(sseFrame({ type: 'segment', segment: { ...s } }, s.id));
      else older.push({ id: s.id, slide: s.slide });
    }
    if (since > 0 && older.length > 0) frames.push(sseFrame({ type: 'realigned', segments: older }));
    if (target.writableEnded || target.destroyed) return;
    target.write(frames.join(''));
    rec.hub.add(target);
  });
  return () => rec.hub.remove(target);
}

/** What the playback route needs. */
export async function playbackSource(
  docId: string,
  rid: string,
): Promise<{ kind: 'file'; file: string; mime: string } | { kind: 'live'; file: string; bytes: number }> {
  const rec = await loadRec(docId, rid);
  if (rec.meta.source === 'live') return { kind: 'live', file: rec.paths.audioPcm, bytes: rec.committed };
  if (rec.meta.status !== 'ready') throw new HttpError(404, smsg().recordings.notFound.playbackAudio);
  return { kind: 'file', file: rec.paths.playback, mime: 'audio/mp4' };
}

// --- uploads --------------------------------------------------------------------------------------------------

/** Folders of uploads still arriving (before finishUpload / abortUpload) → their document. */
const uploading = new Map<string, string>();

/** A new upload's folder and id (the caller streams the body into `partFile`, then calls finishUpload). */
export async function beginUpload(docId: string): Promise<{ id: string; dir: string; partFile: string }> {
  refuseWhileSwapping(docId);
  const id = newRecordingId();
  const dir = recordingPaths(docId, id).dir;
  uploading.set(dir, docId);
  try {
    await requireReadyDoc(docId);
    if (!findFfmpeg()) {
      const m = smsg().recordings.upload;
      throw new HttpError(503, desktopMode(process.env, []) ? m.ffmpegNotFoundDesktop : m.ffmpegMissing);
    }
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    uploading.delete(dir);
    throw err;
  }
  return { id, dir, partFile: path.join(dir, 'source.part') };
}

export async function abortUpload(dir: string): Promise<void> {
  uploading.delete(dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export interface UploadOptions {
  language: RecordingLanguage;
  /** Whisper model id (parseModel: the recommended installed one when not named). */
  model: string;
}

/**
 * Settings of an upload from the X-Language / X-Model headers (the recording settings of the web app), validated
 * like CreateLiveRecordingRequest; missing = the request's language (parseLanguage) and the recommended installed model.
 */
export function uploadOptions(language: string | undefined, model: string | undefined): UploadOptions {
  return { language: parseLanguage(language?.trim() || undefined), model: parseModel(model?.trim() || undefined) };
}

/** The body is on disk as source.part with the sniffed extension: the recording exists from here on. */
export async function finishUpload(
  docId: string,
  id: string,
  ext: string,
  originalName: string,
  options: UploadOptions = { language: 'auto', model: defaultModel() },
): Promise<RecordingInfo> {
  const paths = recordingPaths(docId, id);
  try {
    const sourceFile = `source.${ext}`;
    await fs.rename(path.join(paths.dir, 'source.part'), path.join(paths.dir, sourceFile));
    const base = originalName.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const now = new Date();
    const meta: RecordingMeta = {
      version: 1,
      id,
      docId,
      title: cleanTitle(base) ?? defaultUploadTitle(now),
      source: 'upload',
      status: 'converting',
      language: options.language,
      model: options.model,
      liveTranscribe: false,
      createdAt: now.toISOString(),
      transcriptStatus: 'queued',
      transcribedSec: 0,
      alignment: 'none',
      hasManualMarkers: false,
      sourceFile,
      originalName: cleanTitle(originalName) ?? sourceFile,
      lang: slang(),
    };
    await stampDeckRev(meta);
    await writeMeta(meta);
    const rec = await loadRec(docId, id);
    return rec.info();
  } finally {
    // From here on the recording itself is busy (converting) for recordingsBusy.
    uploading.delete(paths.dir);
  }
}

// --- AI alignment ----------------------------------------------------------------------------------------------

export interface AiAlignJob {
  /** Runs one LLM call; resolves with the reply text. */
  call: (parts: import('../providers/types.ts').Part[], signal: AbortSignal) => Promise<string>;
  provider: string;
  model: string;
}

/** POST …/align-ai → 202: labels chunk by chunk (≤ 150 segments), fused into the DP after each chunk. */
export async function startAiAlignment(docId: string, rid: string, job: AiAlignJob): Promise<void> {
  const { pageCount } = await requireReadyDoc(docId);
  const rec = await loadRec(docId, rid);
  const m = smsg().recordings.aiAlign;
  if (rec.aiRunning) throw new HttpError(409, m.running);
  if (rec.transcript.segments.length === 0) throw new HttpError(409, m.noTranscript);
  if (rec.windowsLeft() > 0 || rec.isLive) throw new HttpError(409, m.notFinished);
  const { AI_CHUNK_SEGMENTS, buildAlignPrompt, parseAlignRuns } = await import('./aiPrompt.ts');
  const deck = await deckOf(docId);
  refuseWhileSwapping(docId);
  const gen = rec.deckGen;
  const controller = new AbortController();
  rec.jobs.add(controller);
  rec.aiRunning = true;
  rec.emitStatus(true);
  const segments = rec.transcript.segments.map((s) => ({ id: s.id, start: s.start, text: s.text }));
  void rec.track((async () => {
    const labels: Record<string, number | null> = {};
    let previous: Label | undefined;
    try {
      for (let offset = 0; offset < segments.length; offset += AI_CHUNK_SEGMENTS) {
        const chunk = segments.slice(offset, offset + AI_CHUNK_SEGMENTS);
        const reply = await job.call(buildAlignPrompt(deck.entries, chunk, offset, previous, deck.digestLang), controller.signal);
        const parsed = parseAlignRuns(reply, offset, chunk.length, pageCount);
        chunk.forEach((s, i) => (labels[String(s.id)] = parsed[i]));
        previous = parsed[parsed.length - 1];
        if (rec.deleted) return;
        const stale = await rec.serial(async () => {
          // The deck was swapped meanwhile (DESIGN §28): these labels count the old slides; the run stops here.
          if (rec.deckGen !== gen) return true;
          rec.llm = { provider: job.provider, model: job.model, at: new Date().toISOString(), labels: { ...labels } };
          await writeLlmLabels(docId, rid, rec.llm);
          return false;
        });
        if (stale) return;
        await rec.realign();
      }
      await rec.serial(async () => {
        delete rec.meta.error;
        await rec.saveMeta();
      });
    } catch (err) {
      if (controller.signal.aborted || rec.deleted) return;
      console.warn(`[recordings] ${rid}: AI alignment failed: ${errorText(err)}`);
      await rec
        .serial(async () => {
          rec.meta.error = m.failed(errorText(err));
          await rec.saveMeta();
        })
        .catch(() => {});
    } finally {
      rec.aiRunning = false;
      rec.jobs.delete(controller);
      if (!rec.deleted) rec.emitStatus(true);
    }
  })());
}

// --- lecture speech for the tutor -------------------------------------------------------------------------------

/** Loaded recordings of a document, or their state from disk. */
export async function recordingsForSpeech(
  docId: string,
): Promise<Array<{ meta: RecordingMeta; segments: TranscriptSegment[]; durationSec: number; live: boolean }>> {
  const out: Array<{ meta: RecordingMeta; segments: TranscriptSegment[]; durationSec: number; live: boolean }> = [];
  for (const rid of await listRecordingIds(docId)) {
    const loaded = recs.get(recKey(docId, rid));
    const rec = loaded ? await loaded.catch(() => null) : null;
    if (rec) {
      if (!rec.deleted) out.push({ meta: rec.meta, segments: rec.transcript.segments, durationSec: rec.durationSec(), live: rec.speechIsLive });
      continue;
    }
    const meta = await readMeta(docId, rid);
    if (!meta) continue;
    const state = await readTranscriptState(docId, rid);
    const durationSec = meta.source === 'live' ? (await fileSize(recordingPaths(docId, rid).audioPcm)) / BYTES_PER_SECOND : (meta.durationSec ?? 0);
    out.push({ meta, segments: state.segments, durationSec, live: false });
  }
  return out;
}

/**
 * A question about `docId` while it is being recorded (live transcription on, audio arriving): the audio not
 * transcribed yet is cut into a window and the turn waits for it (at most questionSpeechWaitMs, and only when little
 * is left to transcribe), so the tutor hears what the professor said right before the question.
 */
export async function catchUpLiveSpeech(docId: string, signal?: AbortSignal): Promise<void> {
  const rec = await liveRec();
  if (!rec || rec.docId !== docId || !rec.speechIsLive || !rec.meta.liveTranscribe) return;
  const last = await rec.serial(() => rec.cutForQuestion());
  if (last < 0 || rec.backlogMs(last) > QUESTION_BACKLOG_MS) return;
  if (!config.models.isInstalled(rec.meta.model)) return;
  await rec.waitForWindows(last, config.questionSpeechWaitMs, signal);
}

// --- new version of the lecture (DESIGN §28) ----------------------------------------------------------------------

/**
 * Why the lecture's deck cannot be swapped now because of its recordings (a message), or null: a live recording of it
 * (also one stopped with audio still to come), a transcription queued or running, an upload arriving or converting, a
 * local or AI alignment running. Synchronous after the recordings being loaded are in: the caller sets its gate next.
 */
export async function recordingsBusy(docId: string): Promise<string | null> {
  const prefix = `${docId}/`;
  await Promise.all([...recs].filter(([key]) => key.startsWith(prefix)).map(([, pending]) => pending.catch(() => null)));
  const mine = [...loaded.values()].filter((rec) => rec.docId === docId && !rec.deleted);
  const m = smsg().library.versions;
  if (creatingLive === docId || mine.some((rec) => rec.meta.source === 'live' && !rec.meta.finalized)) return m.busyRecording;
  const transcribing =
    [...uploading.values()].includes(docId) ||
    runningJob?.rec.docId === docId ||
    queue.some((j) => j.rec.docId === docId) ||
    mine.some((rec) => rec.meta.status === 'converting' || rec.isAligning || rec.aiRunning);
  return transcribing ? m.busyTranscribing : null;
}

/**
 * The lecture's deck was swapped (versions.ts, while its gate is up): every recording's slides follow `map`
 * (Rec.remapDeck), after an alignment in flight, through its queue. Folders of uploads still arriving (no meta.json)
 * are skipped. Idempotent; one recording failing does not stop the others (the first error is thrown at the end).
 */
export async function remapDocRecordings(docId: string, map: DeckMap): Promise<void> {
  let failure: unknown = null;
  for (const rid of await listRecordingIds(docId)) {
    try {
      if (!recs.has(recKey(docId, rid)) && !(await readMeta(docId, rid))) continue;
      const rec = await loadRec(docId, rid);
      await rec.settleAlignment();
      await rec.serial(() => rec.remapDeck(map));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) continue; // deleted meanwhile
      console.warn(`[recordings] ${docId}/${rid}: remap to deck r${map.toRev} failed: ${errorText(err)}`);
      failure ??= err;
    }
  }
  if (failure) throw failure;
}

// --- lifecycle -------------------------------------------------------------------------------------------------

/**
 * Startup (DESIGN §22 crash safety): live recordings left in 'recording'/'paused' are loaded (their audio verified
 * and truncated to the last acknowledged commit), unfinished conversions and transcriptions are resumed; folders of
 * uploads that never finished arriving are removed.
 */
export async function resumeRecordings(): Promise<number> {
  stopping = false;
  let resumed = 0;
  let docs: string[] = [];
  try {
    docs = await fs.readdir(libraryDir());
  } catch {
    return 0;
  }
  for (const docId of docs) {
    let ids: string[];
    try {
      docPaths(docId);
      ids = await listRecordingIds(docId);
    } catch {
      continue;
    }
    // Leftovers of deleted recordings whose removal failed (e.g. a file held open on Windows).
    for (const name of await fs.readdir(recordingsDir(docId)).catch(() => [] as string[])) {
      if (name.startsWith('.deleted-')) await fs.rm(path.join(recordingsDir(docId), name), { recursive: true, force: true }).catch(() => {});
    }
    for (const rid of ids) {
      const meta = await readMeta(docId, rid).catch(() => null);
      if (!meta) {
        // An upload that never finished arriving (no meta.json yet).
        const dir = recordingPaths(docId, rid).dir;
        const entries = await fs.readdir(dir).catch(() => [] as string[]);
        if (!entries.includes('meta.json')) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const unfinished =
        meta.status === 'recording' ||
        meta.status === 'paused' ||
        meta.status === 'converting' ||
        meta.transcriptStatus === 'queued' ||
        meta.transcriptStatus === 'running' ||
        (meta.source === 'live' && meta.stoppedAt !== undefined && !meta.finalized);
      if (!unfinished) continue;
      try {
        await loadRec(docId, rid);
        resumed++;
      } catch (err) {
        console.warn(`[recordings] could not resume ${docId}/${rid}: ${errorText(err)}`);
      }
    }
  }
  return resumed;
}

/** Server shutdown: stop whisper/ffmpeg/downloads, close files and streams. */
export async function stopRecordingWork(): Promise<void> {
  stopping = true;
  queue.length = 0;
  runningJob?.controller.abort();
  await runningJob?.done;
  await warming;
  const all = await Promise.all([...recs.values()].map((p) => p.catch(() => null)));
  await Promise.all(all.map((rec) => rec?.close()));
  recs.clear();
  loaded.clear();
  liveKey = null;
  if (unloadTimer) clearInterval(unloadTimer);
  unloadTimer = null;
  await config.models.stopAll();
  stopping = false;
}

/** A document is being deleted (synchronous part: nothing of it may keep running). */
export function forgetDocRecordings(docId: string): void {
  for (const [key, pending] of [...recs]) {
    if (!key.startsWith(`${docId}/`)) continue;
    recs.delete(key);
    loaded.delete(key);
    void pending.then((rec) => rec.shutdown()).catch(() => {});
  }
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].rec.docId === docId) queue.splice(i, 1);
  if (runningJob?.rec.docId === docId) runningJob.controller.abort();
  if (liveKey?.startsWith(`${docId}/`)) liveKey = null;
}

/** For tests: forget every loaded recording without touching the files (like a restart). */
export async function resetRecordingsForTests(): Promise<void> {
  await stopRecordingWork();
}

export { LIVE_SAMPLE_RATE, recordingsDir };
