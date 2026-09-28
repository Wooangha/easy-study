// The live lecture recorder (DESIGN §22): one per page, outside React so that it survives switching lectures,
// tabs and views, and the login screen coming up over the app (remote mode). It owns:
//   capture   getUserMedia → AudioContext({sampleRate: 16000}) → AudioWorklet (pcm-worklet.js) → s16le blocks,
//             collected into ~1 s chunks → IndexedDB (idbStore.ts)
//   upload    LiveUploader (uploader.ts): offset POSTs, one in flight, backoff, login wait, pause/resume/stop
//   clock     frames captured / 16 000 — slide-view events of the viewer are stamped with it
//   recovery  after a reload / crash / app restart the unfinished recording comes back paused: its unsent audio is
//             uploaded at once, and the user continues it (a click: the microphone needs a user gesture) or ends it.
import workletUrl from './pcm-worklet.js?url&no-inline';
import type { RecordingInfo } from '../../../../shared/types.ts';
import { ApiError, busyRecordingOf, createLiveRecording, deleteRecording, recordingErrorMessage, recordingHttp, untilLoggedIn } from '../../api.ts';
import { toast } from '../toast.ts';
import { notifyRecordingsChanged } from './bus.ts';
import { recordingFeed, updateFeedInfo } from './feeds.ts';
import { recordingDb } from './idbStore.ts';
import { detectPlatform, micErrorMessage, recordingUnavailableReason } from './labels.ts';
import { BYTES_PER_SECOND, PcmChunker, WORKLET_BLOCK_FRAMES, bytesToSeconds, levelOf, meterFraction, samplesOf } from './pcm.ts';
import { ChunkPersister } from './persister.ts';
import { getRecordingSettings } from './settings.ts';
import type { LocalRecording, RecordingDb, RecordingStore } from './store.ts';
import { formatSpan } from './timeline.ts';
import { LiveUploader, type UploaderFatal, type UploaderStatus } from './uploader.ts';

export { notifyRecordingsChanged, onRecordingsChanged } from './bus.ts';

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

/** A start refused because the server already has a live recording (`recording`), maybe of a device that is gone. */
export class RecordingBusyError extends Error {
  readonly recording: RecordingInfo;
  constructor(message: string, recording: RecordingInfo) {
    super(message);
    this.name = 'RecordingBusyError';
    this.recording = recording;
  }
}

/** A recording left unfinished by a reload / crash, waiting for "이어서 녹음" or "끝내기". */
export interface InterruptedRecording {
  id: string;
  docId: string;
  title: string;
  /** Audio captured before the interruption (seconds). */
  seconds: number;
  /** Of that, not on the server yet (seconds). */
  unsentSeconds: number;
  liveTranscribe: boolean;
}

export interface RecorderSnapshot {
  phase: RecorderPhase;
  docId: string | null;
  recordingId: string | null;
  title: string;
  /** Recording clock: seconds captured (whole seconds; the level store ticks faster). */
  seconds: number;
  liveTranscribe: boolean;
  /** Audio captured but not acknowledged by the server yet (seconds). */
  unsentSeconds: number;
  /** The last upload request failed; retrying. */
  offline: boolean;
  uploadError: string | null;
  /** Waiting for a login (remote mode) — capture goes on. */
  authRequired: boolean;
  /** The microphone went away (unplugged, taken by the system): the recording was paused. */
  micProblem: string | null;
  /** Date.now() when the recording was paused (null unless phase 'paused'). */
  pausedAt: number | null;
  /** False when IndexedDB is unavailable: a reload loses the audio not uploaded yet. */
  persistent: boolean;
  interrupted: InterruptedRecording[];
  /** Recordings being finished in the background (their last audio is still uploading). */
  finishing: number;
}

const IDLE: RecorderSnapshot = {
  phase: 'idle',
  docId: null,
  recordingId: null,
  title: '',
  seconds: 0,
  liveTranscribe: true,
  unsentSeconds: 0,
  offline: false,
  uploadError: null,
  authRequired: false,
  micProblem: null,
  pausedAt: null,
  persistent: true,
  interrupted: [],
  finishing: 0,
};

/** Slide-view events the server refused are only a hint for the alignment: the recording goes on without them. */
function warnEventsRefused(count: number, detail: string): void {
  console.warn(`[easy-study] the server refused ${count} slide-view event(s); they were dropped: ${detail}`);
}

/** Debounce of slide-view events (the viewer's focus while scrolling through slides). */
const SLIDE_DEBOUNCE_MS = 300;
/** Warn once this much audio waits for the server (30 min ≈ 58 MB in IndexedDB). */
const BACKLOG_WARN_BYTES = 30 * 60 * BYTES_PER_SECOND;
/**
 * Audio the local store could not write is kept in memory (and written first once it can); past this much the
 * recording is paused with the reason, so the clock never runs ahead of the audio the server will get.
 */
const MAX_UNSAVED_BYTES = 60 * BYTES_PER_SECOND;

interface Capture {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
}

interface Session {
  docId: string;
  rid: string;
  title: string;
  liveTranscribe: boolean;
  store: RecordingStore;
  uploader: LiveUploader;
  capture: Capture | null;
  chunker: PcmChunker;
  /** Frames before this capture started (continuing after a reload). */
  baseFrames: number;
  /** Frames the worklet delivered in this capture. */
  workletFrames: number;
  /** Writes the captured chunks to the store, in order (keeps what it could not write yet). */
  persister: ChunkPersister;
  flushWaiters: Array<() => void>;
  slideTimer: number;
  lastSlide: number | null;
  backlogWarned: boolean;
}

class Recorder {
  private snapshot: RecorderSnapshot = IDLE;
  private listeners = new Set<() => void>();
  private level = 0;
  private levelListeners = new Set<() => void>();
  private session: Session | null = null;
  /** Uploaders of recordings that are not the active one (interrupted, or finishing after stop). */
  private background = new Map<string, { uploader: LiveUploader; store: RecordingStore; finishing: boolean }>();
  private initialized: Promise<void> | null = null;
  private wakeLock: { release: () => Promise<void> } | null = null;
  /** The slide the viewer shows, per document (for the first event of a recording and after a resume). */
  private viewer: { docId: string; slide: number } | null = null;

  // ---- store for React ---------------------------------------------------------------------------------------

  getSnapshot = (): RecorderSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getLevel = (): number => this.level;

  subscribeLevel = (listener: () => void): (() => void) => {
    this.levelListeners.add(listener);
    return () => {
      this.levelListeners.delete(listener);
    };
  };

  private set(patch: Partial<RecorderSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private setLevel(value: number): void {
    if (Math.abs(value - this.level) < 0.01) return;
    this.level = value;
    for (const l of this.levelListeners) l();
  }

  /** Back to "not recording" (what survives: storage kind, interrupted and finishing recordings). */
  private toIdle(): void {
    this.set({ ...IDLE, persistent: this.snapshot.persistent, interrupted: this.snapshot.interrupted, finishing: this.snapshot.finishing });
  }

  // ---- one tab per recording ------------------------------------------------------------------------------------
  // Every tab of the app finds the same IndexedDB. A tab that captures or uploads a recording holds a Web Lock on
  // it, so a second tab (or a reload racing the old page) neither uploads it too nor takes it for an interrupted
  // recording (which would tell the server "pause" under the recording tab).

  private locks = new Map<string, () => void>();

  /**
   * Takes the lock of a recording for this tab: at once (false when another tab has it), or with `wait` once the
   * other tab lets it go (the page before a reload, or a tab that recorded and was closed).
   */
  private async claim(id: string, wait = false): Promise<boolean> {
    if (this.locks.has(id)) return true;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
      this.locks.set(id, () => {});
      return true;
    }
    const release = await new Promise<(() => void) | null>((resolve) => {
      locks
        .request(`easy-study-recording:${id}`, wait ? {} : { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise<void>((done) => resolve(done));
        })
        .catch(() => resolve(() => {}));
    });
    if (!release) return false;
    this.locks.set(id, release);
    return true;
  }

  private unclaim(id: string): void {
    const release = this.locks.get(id);
    this.locks.delete(id);
    release?.();
  }

  /** A recording is being captured or paused (the page should not be closed without asking). */
  get active(): boolean {
    return this.snapshot.phase !== 'idle';
  }

  // ---- startup: recordings left unfinished ------------------------------------------------------------------

  /** Looks for recordings a reload / crash left unfinished and starts uploading their audio. Idempotent. */
  init(): Promise<void> {
    this.initialized ??= this.recover().catch((e) => {
      console.warn('[easy-study] could not look for unfinished recordings', e);
    });
    return this.initialized;
  }

  private async recover(): Promise<void> {
    const db = await recordingDb();
    this.set({ persistent: db.persistent });
    for (const rec of await db.list()) void this.recoverWhenFree(db, rec.id);
  }

  /** Takes over a recording left in this origin's storage as soon as no other tab holds it. */
  private async recoverWhenFree(db: RecordingDb, id: string): Promise<void> {
    if (!(await this.claim(id, true))) return;
    const store = db.open(id);
    const rec = await store.load().catch(() => null);
    if (!rec || this.session?.rid === id || this.background.has(id)) {
      if (!rec) this.unclaim(id);
      return;
    }
    if (rec.stopAcked) {
      await store.destroy().catch(() => {});
      this.unclaim(id);
      return;
    }
    if (rec.stopBytes !== null) {
      this.finishInBackground(rec, store);
      return;
    }
    // It comes back paused and asks (the uploader drains the audio and tells the server "pause").
    await store.update({ wantPaused: true });
    this.runBackground(rec, store, false);
    this.addInterrupted(rec);
  }

  private addInterrupted(rec: LocalRecording): void {
    const entry: InterruptedRecording = {
      id: rec.id,
      docId: rec.docId,
      title: rec.title,
      seconds: bytesToSeconds(rec.captured),
      unsentSeconds: bytesToSeconds(rec.captured - rec.acked),
      liveTranscribe: rec.liveTranscribe,
    };
    this.set({ interrupted: [...this.snapshot.interrupted.filter((r) => r.id !== rec.id), entry] });
  }

  private dropInterrupted(id: string): void {
    if (!this.snapshot.interrupted.some((r) => r.id === id)) return;
    this.set({ interrupted: this.snapshot.interrupted.filter((r) => r.id !== id) });
  }

  private runBackground(rec: LocalRecording, store: RecordingStore, finishing: boolean): void {
    this.background.get(rec.id)?.uploader.close();
    const uploader = new LiveUploader({
      docId: rec.docId,
      recordingId: rec.id,
      store,
      http: recordingHttp,
      waitForAuth: untilLoggedIn,
      onStatus: (s) => {
        const entry = this.snapshot.interrupted.find((r) => r.id === rec.id);
        if (entry) {
          const unsentSeconds = bytesToSeconds(s.captured - s.acked);
          if (unsentSeconds !== entry.unsentSeconds) {
            this.set({
              interrupted: this.snapshot.interrupted.map((r) => (r.id === rec.id ? { ...r, unsentSeconds } : r)),
            });
          }
        }
      },
      onInfo: (info) => updateFeedInfo(info),
      onEventsRefused: warnEventsRefused,
      onDone: () => {
        void store.destroy().finally(() => this.unclaim(rec.id));
        this.background.delete(rec.id);
        this.dropInterrupted(rec.id);
        this.set({ finishing: this.countFinishing() });
        notifyRecordingsChanged(rec.docId);
        if (finishing) toast(`‘${rec.title}’ 녹음을 모두 올렸어요. 받아쓰기가 끝나면 녹음 탭에서 볼 수 있어요.`, 'success', 6000);
      },
      onFatal: (reason, detail) => {
        this.background.delete(rec.id);
        this.dropInterrupted(rec.id);
        this.set({ finishing: this.countFinishing() });
        this.onFatal(rec.title, rec.docId, reason, detail, store);
        this.unclaim(rec.id);
      },
    });
    this.background.set(rec.id, { uploader, store, finishing });
    this.set({ finishing: this.countFinishing() });
    void uploader.start();
  }

  /** Stops a background uploader and waits (briefly) for its request in flight, so two never overlap. */
  private async retire(uploader: LiveUploader): Promise<void> {
    uploader.close();
    await Promise.race([uploader.start(), new Promise((r) => window.setTimeout(r, 3000))]);
  }

  private countFinishing(): number {
    let n = 0;
    for (const b of this.background.values()) if (b.finishing) n++;
    return n;
  }

  private finishInBackground(rec: LocalRecording, store: RecordingStore): void {
    this.runBackground(rec, store, true);
  }

  /** "끝내기" for an interrupted recording: upload what is left, then stop it on the server. */
  async finishInterrupted(id: string): Promise<void> {
    const entry = this.background.get(id);
    if (!entry) {
      this.dropInterrupted(id);
      return;
    }
    const rec = await entry.store.load();
    if (!rec) {
      this.dropInterrupted(id);
      return;
    }
    this.dropInterrupted(id);
    await this.retire(entry.uploader);
    await entry.store.update({ stopBytes: rec.captured });
    this.finishInBackground({ ...rec, stopBytes: rec.captured }, entry.store);
  }

  private onFatal(title: string, docId: string, reason: UploaderFatal, detail: string, store: RecordingStore): void {
    notifyRecordingsChanged(docId);
    switch (reason) {
      case 'gone':
        void store.destroy();
        toast(`‘${title}’ 녹음이 서버에서 지워져서 녹음을 멈췄어요.`, 'info', 8000);
        return;
      case 'not-live':
        void store.destroy();
        toast(`‘${title}’ 녹음은 이미 끝나 있었어요 (다른 창이나 기기에서 멈췄을 수 있어요).`, 'info', 8000);
        return;
      case 'local-missing':
        toast(`‘${title}’ 녹음의 이 기기 기록이 사라졌어요 (브라우저 저장소가 지워졌을 수 있어요).`, 'error', 10000);
        return;
      case 'data-lost':
      case 'server-ahead':
        // Keep the local data: nothing is deleted when the two sides disagree.
        toast(`‘${title}’ 녹음을 더 올릴 수 없어요: ${detail}`, 'error', 12000);
        return;
    }
  }

  // ---- the viewer ---------------------------------------------------------------------------------------------

  /** The viewer shows `slide` of `docId` (the focused slide changed, or another lecture was opened). */
  slideViewed(docId: string | null, slide: number): void {
    this.viewer = docId ? { docId, slide } : null;
    const s = this.session;
    if (!s || !docId || docId !== s.docId || !s.capture) return;
    const t = this.clockSeconds();
    window.clearTimeout(s.slideTimer);
    s.slideTimer = window.setTimeout(() => {
      if (this.session !== s || s.lastSlide === slide) return;
      this.addSlideEvent(s, t, slide);
    }, SLIDE_DEBOUNCE_MS);
  }

  private addSlideEvent(s: Session, t: number, slide: number): void {
    s.lastSlide = slide;
    void s.store
      .addEvent({ t: Math.round(t * 1000) / 1000, slide })
      .then(() => s.uploader.notify())
      .catch((e) => console.warn('[easy-study] could not store a slide-view event', e));
  }

  private clockSeconds(): number {
    const s = this.session;
    if (!s) return 0;
    return (s.baseFrames + s.workletFrames) / (BYTES_PER_SECOND / 2);
  }

  // ---- start / continue ---------------------------------------------------------------------------------------

  /** Why recording is impossible on this page (insecure origin, no microphone API), or null. */
  unavailableReason(): string | null {
    return recordingUnavailableReason({
      isSecureContext: window.isSecureContext,
      hasMediaDevices: !!navigator.mediaDevices?.getUserMedia,
      hasAudioWorklet: typeof AudioWorkletNode !== 'undefined',
      origin: window.location.origin,
    });
  }

  /**
   * Start recording the lecture `docId`. Call it from the click handler of the record button (after the one-time
   * notice): the AudioContext needs the user gesture. Throws an Error with a Korean message on failure.
   */
  async start(docId: string, slide: number | null): Promise<void> {
    if (this.snapshot.phase === 'stopping') {
      throw new Error('방금 멈춘 녹음을 마저 올리는 중이에요. 끝난 뒤에 새로 녹음할 수 있어요.');
    }
    if (this.snapshot.phase !== 'idle') throw new Error('이미 녹음하고 있어요.');
    const unavailable = this.unavailableReason();
    if (unavailable) throw new Error(unavailable);
    this.set({ phase: 'starting', docId, micProblem: null });
    let capture: Capture | null = null;
    try {
      const settings = getRecordingSettings();
      capture = await this.openCapture();
      let info: RecordingInfo;
      try {
        info = await createLiveRecording(docId, {
          language: settings.language,
          model: settings.model ?? undefined,
          liveTranscribe: settings.liveTranscribe,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const message = `${e.message ? `${e.message} — ` : ''}다른 녹음이 진행 중이에요. 한 번에 하나만 녹음할 수 있어요.`;
          const busy = busyRecordingOf(e);
          throw busy ? new RecordingBusyError(message, busy) : new Error(message);
        }
        throw new Error(`녹음을 시작하지 못했어요: ${recordingErrorMessage(e)}`);
      }
      let store: RecordingStore;
      try {
        await this.claim(info.id);
        const db = await recordingDb();
        store = await db.create({ id: info.id, docId, title: info.title, liveTranscribe: info.liveTranscribe });
      } catch (e) {
        // Nothing can be kept on this device: do not leave a live recording behind on the server (it would refuse
        // the next one).
        this.unclaim(info.id);
        void deleteRecording(docId, info.id).catch(() => {});
        throw new Error(`녹음을 이 기기에 저장할 수 없어요: ${e instanceof Error ? e.message : String(e)}`);
      }
      recordingFeed(docId, info.id, { info, fresh: true });
      this.begin({ docId, rid: info.id, title: info.title, liveTranscribe: info.liveTranscribe, store, baseBytes: 0 }, capture);
      // The slide shown now: the viewer may have moved while the permission prompt and the requests ran (the slide
      // of the click is only the fallback).
      const v = this.viewer;
      const first = v && v.docId === docId ? v.slide : slide;
      if (first !== null) this.addSlideEvent(this.session!, 0, first);
      notifyRecordingsChanged(docId);
      void navigator.storage?.persist?.().catch(() => {});
    } catch (e) {
      if (capture) void this.closeCapture(capture);
      this.toIdle();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** "이어서 녹음": continue an interrupted recording (from the click handler, like start). */
  async continueInterrupted(id: string): Promise<void> {
    if (this.snapshot.phase !== 'idle') throw new Error('이미 녹음하고 있어요.');
    const entry = this.background.get(id);
    if (!entry) {
      this.dropInterrupted(id);
      throw new Error('이어서 녹음할 수 없어요: 이 기기에 남은 녹음 정보가 없어요.');
    }
    const unavailable = this.unavailableReason();
    if (unavailable) throw new Error(unavailable);
    const known = this.snapshot.interrupted.find((r) => r.id === id);
    this.set({ phase: 'starting', docId: known?.docId ?? null, micProblem: null });
    let capture: Capture | null = null;
    try {
      // First, while the click still counts as a user gesture: the AudioContext.
      capture = await this.openCapture();
      const rec = await entry.store.load();
      if (!rec) {
        this.dropInterrupted(id);
        throw new Error('이어서 녹음할 수 없어요: 이 기기에 남은 녹음 정보가 없어요.');
      }
      this.background.delete(id);
      await this.retire(entry.uploader);
      this.dropInterrupted(id);
      await entry.store.update({ wantPaused: false });
      recordingFeed(rec.docId, rec.id);
      this.begin(
        { docId: rec.docId, rid: rec.id, title: rec.title, liveTranscribe: rec.liveTranscribe, store: entry.store, baseBytes: rec.captured },
        capture,
      );
      const v = this.viewer;
      if (v && v.docId === rec.docId) this.addSlideEvent(this.session!, this.clockSeconds(), v.slide);
      notifyRecordingsChanged(rec.docId);
    } catch (e) {
      if (capture) void this.closeCapture(capture);
      this.toIdle();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** getUserMedia + AudioContext + worklet. The context is created first, inside the user gesture. */
  private async openCapture(): Promise<Capture> {
    const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch (e) {
      throw new Error(micErrorMessage(e, platform));
    }
    void ctx.resume().catch(() => {});
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await ctx.audioWorklet.addModule(workletUrl);
      if (ctx.state !== 'running') await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'easy-study-pcm-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { blockFrames: WORKLET_BLOCK_FRAMES },
      });
      source.connect(node);
      return { ctx, stream, source, node };
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
      throw new Error(micErrorMessage(e, platform));
    }
  }

  private async closeCapture(c: Capture): Promise<void> {
    try {
      c.source.disconnect();
    } catch {
      /* already disconnected */
    }
    c.node.port.onmessage = null;
    c.stream.getTracks().forEach((t) => t.stop());
    await c.ctx.close().catch(() => {});
  }

  private begin(
    s: { docId: string; rid: string; title: string; liveTranscribe: boolean; store: RecordingStore; baseBytes: number },
    capture: Capture,
  ): void {
    const uploader = new LiveUploader({
      docId: s.docId,
      recordingId: s.rid,
      store: s.store,
      http: recordingHttp,
      waitForAuth: untilLoggedIn,
      onStatus: (st) => this.onUploadStatus(st),
      onInfo: (info) => updateFeedInfo(info),
      onEventsRefused: warnEventsRefused,
      onDone: () => this.onStopped(),
      onFatal: (reason, detail) => this.onSessionFatal(reason, detail),
    });
    const session: Session = {
      docId: s.docId,
      rid: s.rid,
      title: s.title,
      liveTranscribe: s.liveTranscribe,
      store: s.store,
      uploader,
      capture: null,
      chunker: new PcmChunker(),
      baseFrames: s.baseBytes / 2,
      workletFrames: 0,
      persister: new ChunkPersister(s.store, s.baseBytes, {
        onSaved: () => uploader.notify(),
        onError: (e, unsavedBytes, first) => this.onStoreError(session, e, unsavedBytes, first),
        onRecovered: () => {
          if (this.session === session) toast('녹음을 다시 이 기기에 저장하고 있어요.', 'success', 4000);
        },
      }),
      flushWaiters: [],
      slideTimer: 0,
      lastSlide: null,
      backlogWarned: false,
    };
    this.session = session;
    this.attach(session, capture);
    this.set({
      phase: 'recording',
      docId: s.docId,
      recordingId: s.rid,
      title: s.title,
      liveTranscribe: s.liveTranscribe,
      seconds: Math.floor(bytesToSeconds(s.baseBytes)),
      unsentSeconds: 0,
      offline: false,
      uploadError: null,
      authRequired: false,
      micProblem: null,
    });
    void uploader.start();
    this.installPageHooks();
    void this.holdWakeLock();
  }

  /** Connects a capture to the session: worklet blocks, microphone loss. */
  private attach(s: Session, capture: Capture): void {
    s.capture = capture;
    s.workletFrames = 0;
    capture.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; frames: number; flushed: boolean }>) => {
      if (this.session !== s || s.capture !== capture) return;
      this.onBlock(s, e.data);
    };
    const track = capture.stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => {
        if (this.session !== s || s.capture !== capture) return;
        this.set({ micProblem: '마이크 연결이 끊겼어요. 녹음을 일시정지했어요 — 마이크를 확인하고 ‘계속’을 누르세요.' });
        void this.pause();
      };
      track.onmute = () => {
        if (this.session !== s) return;
        this.set({ micProblem: '마이크 소리가 들어오지 않아요 (시스템이 마이크를 막았거나 다른 앱이 쓰고 있어요).' });
      };
      track.onunmute = () => {
        if (this.session === s && this.snapshot.micProblem && track.readyState === 'live') this.set({ micProblem: null });
      };
    }
  }

  private onBlock(s: Session, data: { pcm: ArrayBuffer; frames: number; flushed: boolean }): void {
    const bytes = new Uint8Array(data.pcm);
    if (bytes.byteLength > 0) {
      const { rmsDb } = levelOf(samplesOf(bytes));
      const target = meterFraction(rmsDb + 6);
      this.setLevel(target > this.level ? target : this.level * 0.8 + target * 0.2);
      for (const chunk of s.chunker.push(bytes)) this.persist(s, chunk);
    }
    s.workletFrames = data.frames;
    const seconds = Math.floor(this.clockSeconds());
    if (seconds !== this.snapshot.seconds) this.set({ seconds });
    if (data.flushed) {
      const waiters = s.flushWaiters;
      s.flushWaiters = [];
      for (const w of waiters) w();
    }
  }

  private persist(s: Session, chunk: Uint8Array): Promise<void> {
    return s.persister.push(chunk);
  }

  /** The store refused audio: say so once, and pause when too much waits in memory. */
  private onStoreError(s: Session, e: unknown, unsavedBytes: number, first: boolean): void {
    const quota = e instanceof DOMException && e.name === 'QuotaExceededError';
    const reason = quota ? '저장 공간이 부족해요' : e instanceof Error ? e.message : String(e);
    console.warn('[easy-study] could not store recorded audio', e);
    if (first) {
      toast(
        quota
          ? '저장 공간이 부족해서 녹음을 이 기기에 저장하지 못하고 있어요. 공간을 확보해 주세요 — 잠시 메모리에 보관하고 있어요.'
          : `녹음을 이 기기에 저장하지 못하고 있어요: ${reason} — 잠시 메모리에 보관하고 있어요.`,
        'error',
        10000,
      );
    }
    if (unsavedBytes > MAX_UNSAVED_BYTES && this.session === s && this.snapshot.phase === 'recording') {
      this.set({
        micProblem: `이 기기에 녹음을 저장할 수 없어서 일시정지했어요 (${reason}). 공간을 확보한 뒤 ‘계속’을 누르고, 그래도 안 되면 새로고침한 뒤 ‘이어서 녹음’을 누르세요.`,
      });
      void this.pause();
    }
  }

  /** Everything the worklet and the chunker hold goes to the store. */
  private async drain(s: Session): Promise<void> {
    const c = s.capture;
    if (c) {
      await new Promise<void>((resolve) => {
        s.flushWaiters.push(resolve);
        c.node.port.postMessage('flush');
        // A closed or broken context never answers.
        window.setTimeout(resolve, 1500);
      });
    }
    const rest = s.chunker.flush();
    if (rest) await this.persist(s, rest);
    else await s.persister.flush();
  }

  /** Closes the microphone of a session, keeping its clock (frames so far move into baseFrames). */
  private async releaseCapture(s: Session): Promise<void> {
    const c = s.capture;
    if (!c) return;
    s.baseFrames += s.workletFrames;
    s.workletFrames = 0;
    s.capture = null;
    await this.closeCapture(c);
  }

  private onUploadStatus(st: UploaderStatus): void {
    const s = this.session;
    if (!s) return;
    const unsent = st.captured - st.acked;
    const patch: Partial<RecorderSnapshot> = {
      unsentSeconds: Math.round(bytesToSeconds(unsent)),
      offline: !st.online,
      uploadError: st.error,
      authRequired: st.authRequired,
    };
    if (unsent > BACKLOG_WARN_BYTES && !s.backlogWarned) {
      s.backlogWarned = true;
      toast(
        `서버에 아직 못 보낸 녹음이 ${formatSpan(bytesToSeconds(unsent))} 쌓였어요. 이 기기에 안전하게 보관 중이고, 연결되면 이어서 보내요.`,
        'info',
        10000,
      );
    }
    const s2 = this.snapshot;
    if (
      s2.unsentSeconds !== patch.unsentSeconds ||
      s2.offline !== patch.offline ||
      s2.uploadError !== patch.uploadError ||
      s2.authRequired !== patch.authRequired
    ) {
      this.set(patch);
    }
  }

  // ---- pause / resume / stop ---------------------------------------------------------------------------------

  /**
   * Pause: the audio so far goes to the store, then the microphone and the screen wake lock are released (the
   * system's microphone indicator goes off during a break); "계속" opens the microphone again.
   */
  async pause(): Promise<void> {
    const s = this.session;
    if (!s || this.snapshot.phase !== 'recording') return;
    this.set({ phase: 'paused', pausedAt: Date.now() });
    s.capture?.node.port.postMessage('pause');
    await this.drain(s);
    this.setLevel(0);
    // Resumed or stopped meanwhile (a quick second click): that action owns the microphone, the wake lock and the
    // stored state now.
    const stillPaused = () => this.session === s && this.getSnapshot().phase === 'paused';
    if (!stillPaused()) return;
    await this.releaseCapture(s);
    if (!stillPaused()) return;
    void this.releaseWakeLock();
    try {
      await s.store.update({ wantPaused: true });
    } catch (e) {
      console.warn('[easy-study] could not store the pause', e);
    }
    s.uploader.flush();
    notifyRecordingsChanged(s.docId);
  }

  /** "계속". From a click handler (a new microphone stream may be needed after the old one ended). */
  async resume(): Promise<void> {
    const s = this.session;
    if (!s || this.snapshot.phase !== 'paused') return;
    if (s.persister.unsavedBytes > MAX_UNSAVED_BYTES) {
      await s.persister.flush();
      if (s.persister.unsavedBytes > MAX_UNSAVED_BYTES) {
        throw new Error('아직 이 기기에 녹음을 저장할 수 없어요. 저장 공간을 확보하거나, 페이지를 새로고침한 뒤 ‘이어서 녹음’을 눌러 주세요.');
      }
    }
    const track = s.capture?.stream.getAudioTracks()[0];
    if (!s.capture || !track || track.readyState === 'ended') {
      // The microphone went away: open a new capture (the clock continues from the stored audio).
      const old = s.capture;
      const capture = await this.openCapture().catch((e: unknown) => {
        throw e instanceof Error ? e : new Error(String(e));
      });
      if (old) void this.closeCapture(old);
      s.baseFrames += s.workletFrames;
      this.attach(s, capture);
    } else {
      if (s.capture.ctx.state !== 'running') await s.capture.ctx.resume().catch(() => {});
      s.capture.node.port.postMessage('resume');
    }
    await s.store.update({ wantPaused: false });
    s.uploader.notify();
    this.set({ phase: 'recording', micProblem: null, pausedAt: null });
    const v = this.viewer;
    if (v && v.docId === s.docId && v.slide !== s.lastSlide) this.addSlideEvent(s, this.clockSeconds(), v.slide);
    void this.holdWakeLock();
    notifyRecordingsChanged(s.docId);
  }

  /** Stop: the rest of the audio is uploaded, then the server is told to finish (transcription, alignment). */
  async stop(): Promise<void> {
    const s = this.session;
    if (!s || (this.snapshot.phase !== 'recording' && this.snapshot.phase !== 'paused')) return;
    this.set({ phase: 'stopping' });
    window.clearTimeout(s.slideTimer);
    s.capture?.node.port.postMessage('pause');
    try {
      await this.drain(s);
      const rec = await s.store.load();
      const captured = rec?.captured ?? 0;
      await s.store.update({ stopBytes: captured });
      if (s.persister.unsavedBytes > 0) {
        toast(
          `마지막 ${formatSpan(bytesToSeconds(s.persister.unsavedBytes))}은 이 기기에 저장하지 못해서 녹음에서 빠졌어요.`,
          'error',
          10000,
        );
      }
      s.uploader.flush();
    } catch (e) {
      // The store failed: the recording stays (paused) — the user can try again, or reload and continue it.
      if (this.session === s) this.set({ phase: 'paused', pausedAt: Date.now() });
      throw new Error(`이 기기에 저장된 녹음을 읽지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Whatever happened: the microphone and the screen are released.
      await this.releaseCapture(s);
      this.setLevel(0);
      void this.releaseWakeLock();
    }
  }

  /** The stop was acknowledged: everything is on the server. */
  private onStopped(): void {
    const s = this.session;
    if (!s) return;
    void s.store.destroy().finally(() => this.unclaim(s.rid));
    this.session = null;
    this.toIdle();
    notifyRecordingsChanged(s.docId);
    toast(
      s.liveTranscribe
        ? `‘${s.title}’ 녹음을 저장했어요. 남은 받아쓰기와 슬라이드 정렬이 끝나면 녹음 탭에서 다시 들을 수 있어요.`
        : `‘${s.title}’ 녹음을 저장했어요. 이제 받아쓰기를 시작해요 — 진행 상황은 녹음 탭에서 볼 수 있어요.`,
      'success',
      7000,
    );
  }

  private onSessionFatal(reason: UploaderFatal, detail: string): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    window.clearTimeout(s.slideTimer);
    if (s.capture) void this.closeCapture(s.capture);
    this.setLevel(0);
    void this.releaseWakeLock();
    this.toIdle();
    this.onFatal(s.title, s.docId, reason, detail, s.store);
    this.unclaim(s.rid);
  }

  /**
   * The recording is being deleted from the list: stop capturing and forget the local audio (the server deletes
   * its copy). Works for the active recording and for interrupted ones.
   */
  async discard(rid: string): Promise<void> {
    const s = this.session;
    if (s && s.rid === rid) {
      this.session = null;
      window.clearTimeout(s.slideTimer);
      s.uploader.close();
      if (s.capture) await this.closeCapture(s.capture);
      await s.store.destroy().catch(() => {});
      this.unclaim(rid);
      this.setLevel(0);
      void this.releaseWakeLock();
      this.toIdle();
      return;
    }
    const b = this.background.get(rid);
    if (b) {
      b.uploader.close();
      this.background.delete(rid);
      await b.store.destroy().catch(() => {});
      this.unclaim(rid);
      this.dropInterrupted(rid);
      this.set({ finishing: this.countFinishing() });
    }
  }

  // ---- page hooks ------------------------------------------------------------------------------------------------

  private hooksInstalled = false;

  private installPageHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    const kickAll = () => {
      this.session?.uploader.kick();
      for (const b of this.background.values()) b.uploader.kick();
    };
    window.addEventListener('online', kickAll);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        kickAll();
        if (this.snapshot.phase === 'recording') void this.holdWakeLock();
      } else {
        // Hidden (tab switch, app switch, screen lock): store what is held, in case the page is killed.
        const s = this.session;
        const rest = s?.chunker.flush();
        if (s && rest) this.persist(s, rest);
      }
    });
    window.addEventListener('pagehide', () => {
      const s = this.session;
      const rest = s?.chunker.flush();
      if (s && rest) this.persist(s, rest);
    });
  }

  private async holdWakeLock(): Promise<void> {
    const wl = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } })
      .wakeLock;
    if (!wl || this.wakeLock) return;
    try {
      const lock = await wl.request('screen');
      this.wakeLock = lock;
      (lock as unknown as EventTarget).addEventListener?.('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch {
      /* not allowed (hidden page, policy): the recording goes on */
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    await lock?.release().catch(() => {});
  }
}

/** The page's recorder. */
export const recorder = new Recorder();
