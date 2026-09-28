// Live view of one recording (DESIGN §22), shared by everything that shows it (the live transcript strip, the
// 녹음 tab): the transcript loaded once, then kept up to date by the SSE stream while something still happens to
// the recording (recording, conversion, transcription, an AI alignment). One stream per recording, reference
// counted; it closes a little after the last viewer leaves.
import type { RecordingInfo, RecordingTranscript } from '../../../../shared/types.ts';
import { checkSessionSoon, getRecordingTranscript, recordingErrorMessage, recordingEventsUrl } from '../../api.ts';
import {
  RecordingEventsClient,
  applyRecordingEvent,
  lastSegmentId,
  type ConnectionState,
  type FeedState,
} from './events.ts';
import { isInProgress } from './labels.ts';
import { sortSegments } from './timeline.ts';

export interface FeedSnapshot extends FeedState {
  /** The transcript was loaded (or the recording is new: nothing to load). */
  loaded: boolean;
  error: string | null;
  connection: ConnectionState;
  /** An "AI 정밀 정렬" was started here and its result has not arrived yet. */
  aligning: boolean;
}

/** How long a stream stays open after its last viewer left (switching tabs back and forth). */
const LINGER_MS = 5000;
/** An AI alignment is no longer shown as running after this long… */
const ALIGN_TIMEOUT_MS = 15 * 60_000;
/** …or this long after its last change (the LLM answers chunk by chunk). */
const ALIGN_QUIET_MS = 60_000;

type Listener = () => void;

class Feed {
  readonly docId: string;
  readonly rid: string;
  snapshot: FeedSnapshot;
  private listeners = new Set<Listener>();
  private client: RecordingEventsClient | null = null;
  private loading = false;
  private lingerTimer = 0;
  private alignTimer = 0;
  private quietTimer = 0;
  private alignError: string | undefined;

  constructor(docId: string, rid: string, seed: { info?: RecordingInfo | null; fresh?: boolean }) {
    this.docId = docId;
    this.rid = rid;
    this.snapshot = {
      info: seed.info ?? null,
      segments: [],
      loaded: seed.fresh === true,
      error: null,
      connection: 'stopped',
      aligning: false,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    window.clearTimeout(this.lingerTimer);
    this.ensure();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        window.clearTimeout(this.lingerTimer);
        this.lingerTimer = window.setTimeout(() => this.dispose(), LINGER_MS);
      }
    };
  }

  private set(patch: Partial<FeedSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  /** Load the transcript if needed, then keep the stream open while the recording is in progress. */
  ensure(): void {
    if (!this.snapshot.loaded) {
      void this.load();
      return;
    }
    this.syncStream();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const t = await getRecordingTranscript(this.docId, this.rid);
      this.set({ segments: sortSegments(t.segments), loaded: true, error: null });
    } catch (e) {
      // A recording without a transcript yet may answer 404/409: start from nothing, the stream fills it in.
      this.set({ loaded: true, error: this.snapshot.info && isInProgress(this.snapshot.info) ? null : recordingErrorMessage(e) });
    } finally {
      this.loading = false;
    }
    this.syncStream();
  }

  /** Reload the transcript (retry after an error, or after the server re-aligned it). */
  reload(): void {
    this.set({ loaded: false });
    void this.load();
  }

  /**
   * The stream stays open while anyone shows the recording: new segments while it is recorded or transcribed,
   * slides changed by an alignment (this device's AI alignment, markers set on another device), renames.
   */
  private wantsStream(): boolean {
    return this.listeners.size > 0;
  }

  private syncStream(): void {
    if (this.wantsStream()) {
      if (!this.client) {
        this.client = new RecordingEventsClient({
          url: (since) => recordingEventsUrl(this.docId, this.rid, since),
          create: (url) => new EventSource(url),
          since: lastSegmentId(this.snapshot.segments),
          onEvent: (event) => {
            const next = applyRecordingEvent(this.snapshot, event);
            if (this.snapshot.aligning) this.alignProgress(event.type, next !== this.snapshot, next.info);
            if (next !== this.snapshot) this.set({ info: next.info, segments: next.segments });
          },
          onState: (connection) => this.set({ connection }),
          onClosedByServer: () => checkSessionSoon(),
        });
        this.client.start();
      }
    } else if (this.client) {
      this.client.stop();
      this.client = null;
    }
  }

  setInfo(info: RecordingInfo): void {
    if (this.snapshot.info === info) return;
    this.set({ info });
  }

  setTranscript(t: RecordingTranscript): void {
    this.set({ segments: sortSegments(t.segments), loaded: true, error: null });
  }

  /**
   * An AI alignment was started here. The API does not say when it ends: the server applies the LLM's labels chunk
   * by chunk (each a `realigned` + `status` event) and reports a failure in `error`. So "running" ends at a new
   * error, after a quiet spell once the alignment is 'llm', or after a long timeout.
   */
  startAligning(): void {
    this.alignError = this.snapshot.info?.error;
    this.set({ aligning: true });
    window.clearTimeout(this.alignTimer);
    window.clearTimeout(this.quietTimer);
    this.alignTimer = window.setTimeout(() => this.finishAligning(), ALIGN_TIMEOUT_MS);
    this.syncStream();
  }

  private alignProgress(type: string, changed: boolean, info: RecordingInfo | null): void {
    if (type === 'status' && info?.error && info.error !== this.alignError) {
      this.finishAligning();
      return;
    }
    if ((type === 'realigned' && changed) || (type === 'status' && info?.alignment === 'llm')) {
      window.clearTimeout(this.quietTimer);
      this.quietTimer = window.setTimeout(() => this.finishAligning(), ALIGN_QUIET_MS);
    }
  }

  private finishAligning(): void {
    window.clearTimeout(this.alignTimer);
    window.clearTimeout(this.quietTimer);
    if (this.snapshot.aligning) this.set({ aligning: false });
  }

  reconnectNow(): void {
    this.client?.reconnectNow();
  }

  dispose(): void {
    if (this.listeners.size > 0) return;
    this.client?.stop();
    this.client = null;
    window.clearTimeout(this.alignTimer);
    window.clearTimeout(this.quietTimer);
    feeds.delete(key(this.docId, this.rid));
  }
}

const feeds = new Map<string, Feed>();
const key = (docId: string, rid: string) => `${docId}\n${rid}`;

/**
 * The feed of a recording (created on first use). `seed.info` gives what is already known; `seed.fresh` says the
 * recording was just created here, so there is no transcript to load.
 */
export function recordingFeed(docId: string, rid: string, seed: { info?: RecordingInfo | null; fresh?: boolean } = {}): Feed {
  let feed = feeds.get(key(docId, rid));
  if (!feed) {
    feed = new Feed(docId, rid, seed);
    feeds.set(key(docId, rid), feed);
  } else if (seed.info && !feed.snapshot.info) {
    feed.setInfo(seed.info);
  }
  return feed;
}

/** The feed of a recording if one exists (no side effects: for render). */
export function peekRecordingFeed(docId: string, rid: string): Feed | null {
  return feeds.get(key(docId, rid)) ?? null;
}

/** The info of a recording changed (list refresh, rename, pause…): tell its feed, if one exists. */
export function updateFeedInfo(info: RecordingInfo): void {
  feeds.get(key(info.docId, info.id))?.setInfo(info);
}

export type RecordingFeed = Feed;

// The page is visible or online again: reopen streams that are waiting for their next retry.
if (typeof window !== 'undefined') {
  const kick = () => {
    for (const f of feeds.values()) f.reconnectNow();
  };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
}
