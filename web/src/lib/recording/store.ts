// Local, persistent side of a live recording (DESIGN §22, protocol spike): the client owns every byte past the
// server's acknowledged offset, so they must survive a network drop, a page reload or an app crash. The browser
// keeps them in IndexedDB (idbStore.ts); MemoryRecordingDb here has the same semantics (tests, and the fallback
// when IndexedDB is unavailable, e.g. some private windows). Pure, no DOM.
import type { SlideViewEvent } from '../../../../shared/types.ts';
import { BYTES_PER_SECOND, concatBytes } from './pcm.ts';

/** Acknowledged audio kept locally (60 s), so a server that lost its last commit can still be healed (409 gap). */
export const KEEP_ACKED_BYTES = 60 * BYTES_PER_SECOND;

/** What the client remembers about one live recording. */
export interface LocalRecording {
  /** RecordingInfo.id */
  id: string;
  docId: string;
  title: string;
  /** Bytes the server has confirmed (fsynced). */
  acked: number;
  /** Bytes captured and persisted locally. */
  captured: number;
  /** Next slide-view event sequence number (local only: events are delivered in order). */
  nextSeq: number;
  /** Events up to this seq were accepted by the server. */
  eventsAckedSeq: number;
  /** The student paused (or the page was reloaded: it comes back paused and asks). */
  wantPaused: boolean;
  /** What the server was last told (pause/resume). */
  serverPaused: boolean;
  /** Stop requested: all audio up to here, then POST stop. */
  stopBytes: number | null;
  stopAcked: boolean;
  liveTranscribe: boolean;
  /** Date.now() when the recording was created. */
  createdAt: number;
  /** Date.now() of the last local write (audio, pause, stop). */
  updatedAt: number;
}

export type LocalRecordingInit = Pick<LocalRecording, 'id' | 'docId' | 'title' | 'liveTranscribe'> &
  Partial<Pick<LocalRecording, 'acked' | 'captured' | 'serverPaused'>>;

export interface StoredSlideEvent extends SlideViewEvent {
  seq: number;
}

/** One recording's local state, audio blocks and pending slide-view events. All methods persist before resolving. */
export interface RecordingStore {
  readonly id: string;
  load(): Promise<LocalRecording | null>;
  /** Appends captured audio at the current end; resolves with the new `captured`. */
  appendAudio(bytes: Uint8Array): Promise<number>;
  /** Persisted bytes from `offset` on, at most `max` (fewer when not captured yet; empty when already dropped). */
  read(offset: number, max: number): Promise<Uint8Array>;
  /** The server acknowledged up to `n`: blocks older than n − KEEP_ACKED_BYTES may be dropped. */
  setAcked(n: number): Promise<void>;
  update(patch: Partial<Omit<LocalRecording, 'id'>>): Promise<LocalRecording>;
  addEvent(event: SlideViewEvent): Promise<StoredSlideEvent>;
  /** Events not yet accepted by the server, oldest first. */
  pendingEvents(max: number): Promise<StoredSlideEvent[]>;
  /** The server accepted the events up to `seq`. */
  dropEvents(seq: number): Promise<void>;
  /** Forget everything about this recording (after the stop was acknowledged, or the recording is gone). */
  destroy(): Promise<void>;
}

/** All recordings kept on this device (per origin). */
export interface RecordingDb {
  /** Recordings with local state (unfinished ones first need uploading / a decision after a reload). */
  list(): Promise<LocalRecording[]>;
  create(init: LocalRecordingInit): Promise<RecordingStore>;
  open(id: string): RecordingStore;
  /** False for the in-memory fallback: a reload loses what was not uploaded yet. */
  readonly persistent: boolean;
}

export function newLocalRecording(init: LocalRecordingInit, now: number): LocalRecording {
  return {
    id: init.id,
    docId: init.docId,
    title: init.title,
    acked: init.acked ?? 0,
    captured: init.captured ?? init.acked ?? 0,
    nextSeq: 1,
    eventsAckedSeq: 0,
    wantPaused: false,
    serverPaused: init.serverPaused ?? false,
    stopBytes: null,
    stopAcked: false,
    liveTranscribe: init.liveTranscribe,
    createdAt: now,
    updatedAt: now,
  };
}

interface Block {
  offset: number;
  bytes: Uint8Array;
}

/** Bytes from `offset`, at most `max`, out of blocks sorted by offset (shared by both stores). */
export function readBlocks(blocks: readonly Block[], offset: number, max: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let got = 0;
  for (const b of blocks) {
    if (got >= max) break;
    const end = b.offset + b.bytes.byteLength;
    const want = offset + got;
    if (end <= want) continue;
    if (b.offset > want) break; // a hole (dropped blocks): stop at it
    const from = want - b.offset;
    const slice = b.bytes.subarray(from, from + Math.min(b.bytes.byteLength - from, max - got));
    parts.push(slice);
    got += slice.byteLength;
  }
  return concatBytes(parts);
}

/** Blocks still needed once `acked` bytes are confirmed. */
export function keepBlock(block: Block, acked: number): boolean {
  return block.offset + block.bytes.byteLength > acked - KEEP_ACKED_BYTES;
}

class MemoryRecordingStore implements RecordingStore {
  readonly id: string;
  private db: MemoryRecordingDb;

  constructor(db: MemoryRecordingDb, id: string) {
    this.db = db;
    this.id = id;
  }

  private entry() {
    const e = this.db.entries.get(this.id);
    if (!e) throw new Error(`recording ${this.id} has no local state`);
    return e;
  }

  async load(): Promise<LocalRecording | null> {
    const e = this.db.entries.get(this.id);
    return e ? { ...e.rec } : null;
  }

  async appendAudio(bytes: Uint8Array): Promise<number> {
    const e = this.entry();
    if (bytes.byteLength === 0) return e.rec.captured;
    e.blocks.push({ offset: e.rec.captured, bytes: bytes.slice() });
    e.rec = { ...e.rec, captured: e.rec.captured + bytes.byteLength, updatedAt: this.db.now() };
    return e.rec.captured;
  }

  async read(offset: number, max: number): Promise<Uint8Array> {
    return readBlocks(this.entry().blocks, offset, max);
  }

  async setAcked(n: number): Promise<void> {
    const e = this.entry();
    e.rec = { ...e.rec, acked: n };
    e.blocks = e.blocks.filter((b) => keepBlock(b, n));
  }

  async update(patch: Partial<Omit<LocalRecording, 'id'>>): Promise<LocalRecording> {
    const e = this.entry();
    e.rec = { ...e.rec, ...patch, id: e.rec.id, updatedAt: this.db.now() };
    return { ...e.rec };
  }

  async addEvent(event: SlideViewEvent): Promise<StoredSlideEvent> {
    const e = this.entry();
    const stored: StoredSlideEvent = { seq: e.rec.nextSeq, t: event.t, slide: event.slide };
    e.events.push(stored);
    e.rec = { ...e.rec, nextSeq: e.rec.nextSeq + 1 };
    return stored;
  }

  async pendingEvents(max: number): Promise<StoredSlideEvent[]> {
    const e = this.entry();
    return e.events.filter((ev) => ev.seq > e.rec.eventsAckedSeq).slice(0, max);
  }

  async dropEvents(seq: number): Promise<void> {
    const e = this.entry();
    e.rec = { ...e.rec, eventsAckedSeq: Math.max(e.rec.eventsAckedSeq, seq) };
    e.events = e.events.filter((ev) => ev.seq > e.rec.eventsAckedSeq);
  }

  async destroy(): Promise<void> {
    this.db.entries.delete(this.id);
  }
}

/** In-memory RecordingDb: tests, and the fallback without IndexedDB. */
export class MemoryRecordingDb implements RecordingDb {
  readonly persistent = false;
  readonly entries = new Map<string, { rec: LocalRecording; blocks: Block[]; events: StoredSlideEvent[] }>();
  readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async list(): Promise<LocalRecording[]> {
    return [...this.entries.values()].map((e) => ({ ...e.rec }));
  }

  async create(init: LocalRecordingInit): Promise<RecordingStore> {
    if (!this.entries.has(init.id)) {
      this.entries.set(init.id, { rec: newLocalRecording(init, this.now()), blocks: [], events: [] });
    }
    return this.open(init.id);
  }

  open(id: string): RecordingStore {
    return new MemoryRecordingStore(this, id);
  }
}
