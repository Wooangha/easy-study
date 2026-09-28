// IndexedDB side of a live recording (DESIGN §22; the protocol spike's idb-store): one record per recording, its
// audio in ~1 s blocks keyed [id, offset] and its pending slide-view events keyed [id, seq]. What is not yet
// acknowledged by the server survives a reload, a crash or an app restart (same origin). Acknowledged blocks are
// dropped except the last 60 s (KEEP_ACKED_BYTES). Falls back to memory when IndexedDB cannot be opened.
import type { SlideViewEvent } from '../../../../shared/types.ts';
import {
  MemoryRecordingDb,
  keepBlock,
  newLocalRecording,
  readBlocks,
  type LocalRecording,
  type LocalRecordingInit,
  type RecordingDb,
  type RecordingStore,
  type StoredSlideEvent,
} from './store.ts';

const DB_NAME = 'easy-study-recordings';
const DB_VERSION = 1;
const RECS = 'recs';
const BLOCKS = 'blocks';
const EVENTS = 'events';
const MAX_KEY = Number.MAX_SAFE_INTEGER;
/** Largest audio block written (the recorder writes ~1 s = 32 000 B); bounds the key range of a read. */
const MAX_BLOCK_BYTES = 1024 * 1024;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });
}

function range(id: string, from = 0): IDBKeyRange {
  return IDBKeyRange.bound([id, from], [id, MAX_KEY]);
}

interface BlockRow {
  id: string;
  offset: number;
  bytes: ArrayBuffer;
}

interface EventRow extends StoredSlideEvent {
  id: string;
}

class IdbRecordingStore implements RecordingStore {
  readonly id: string;
  private readonly db: IDBDatabase;
  /** Writes of one recording run one after another (IndexedDB transactions would interleave them). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(db: IDBDatabase, id: string) {
    this.db = db;
    this.id = id;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  async load(): Promise<LocalRecording | null> {
    const rec = await req<LocalRecording | undefined>(this.db.transaction(RECS).objectStore(RECS).get(this.id));
    return rec ?? null;
  }

  appendAudio(bytes: Uint8Array, at?: number): Promise<number> {
    return this.serial(async () => {
      const tx = this.db.transaction([RECS, BLOCKS], 'readwrite');
      const recs = tx.objectStore(RECS);
      const rec = await req<LocalRecording | undefined>(recs.get(this.id));
      if (!rec) throw new Error(`recording ${this.id} has no local state`);
      if (bytes.byteLength > MAX_BLOCK_BYTES) throw new Error('audio blocks are at most 1 MiB');
      // A retried write that had landed (see RecordingStore.appendAudio).
      const stored = at !== undefined && rec.captured >= at + bytes.byteLength;
      if (at !== undefined && !stored && rec.captured !== at) {
        throw new Error(`audio at ${at} does not follow the stored ${rec.captured} bytes`);
      }
      if (bytes.byteLength > 0 && !stored) {
        const copy = bytes.slice();
        const row: BlockRow = { id: this.id, offset: rec.captured, bytes: copy.buffer };
        tx.objectStore(BLOCKS).put(row);
        rec.captured += bytes.byteLength;
        rec.updatedAt = Date.now();
        recs.put(rec);
      }
      await done(tx);
      return rec.captured;
    });
  }

  async read(offset: number, max: number): Promise<Uint8Array> {
    // Only the blocks that can overlap [offset, offset + max): a block starts at most MAX_BLOCK_BYTES before it.
    const keys = IDBKeyRange.bound([this.id, Math.max(0, offset - MAX_BLOCK_BYTES)], [this.id, offset + max], false, true);
    const rows = await req<BlockRow[]>(this.db.transaction(BLOCKS).objectStore(BLOCKS).getAll(keys));
    return readBlocks(
      rows.map((r) => ({ offset: r.offset, bytes: new Uint8Array(r.bytes) })),
      offset,
      max,
    );
  }

  setAcked(n: number): Promise<void> {
    return this.serial(async () => {
      const tx = this.db.transaction([RECS, BLOCKS], 'readwrite');
      const recs = tx.objectStore(RECS);
      const rec = await req<LocalRecording | undefined>(recs.get(this.id));
      if (rec) {
        rec.acked = n;
        recs.put(rec);
      }
      const cursorReq = tx.objectStore(BLOCKS).openCursor(range(this.id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const row = cursor.value as BlockRow;
        if (keepBlock({ offset: row.offset, bytes: new Uint8Array(row.bytes) }, n)) return; // sorted: the rest stays
        cursor.delete();
        cursor.continue();
      };
      await done(tx);
    });
  }

  update(patch: Partial<Omit<LocalRecording, 'id'>>): Promise<LocalRecording> {
    return this.serial(async () => {
      const tx = this.db.transaction(RECS, 'readwrite');
      const recs = tx.objectStore(RECS);
      const rec = await req<LocalRecording | undefined>(recs.get(this.id));
      if (!rec) throw new Error(`recording ${this.id} has no local state`);
      const next: LocalRecording = { ...rec, ...patch, id: rec.id, updatedAt: Date.now() };
      recs.put(next);
      await done(tx);
      return next;
    });
  }

  addEvent(event: SlideViewEvent): Promise<StoredSlideEvent> {
    return this.serial(async () => {
      const tx = this.db.transaction([RECS, EVENTS], 'readwrite');
      const recs = tx.objectStore(RECS);
      const rec = await req<LocalRecording | undefined>(recs.get(this.id));
      if (!rec) throw new Error(`recording ${this.id} has no local state`);
      const stored: StoredSlideEvent = { seq: rec.nextSeq, t: event.t, slide: event.slide };
      const row: EventRow = { id: this.id, ...stored };
      tx.objectStore(EVENTS).put(row);
      rec.nextSeq += 1;
      recs.put(rec);
      await done(tx);
      return stored;
    });
  }

  async pendingEvents(max: number): Promise<StoredSlideEvent[]> {
    const rec = await this.load();
    if (!rec) return [];
    const rows = await req<EventRow[]>(
      this.db.transaction(EVENTS).objectStore(EVENTS).getAll(range(this.id, rec.eventsAckedSeq + 1), max),
    );
    return rows.map((r) => ({ seq: r.seq, t: r.t, slide: r.slide }));
  }

  dropEvents(seq: number): Promise<void> {
    return this.serial(async () => {
      const tx = this.db.transaction([RECS, EVENTS], 'readwrite');
      const recs = tx.objectStore(RECS);
      const rec = await req<LocalRecording | undefined>(recs.get(this.id));
      if (rec) {
        rec.eventsAckedSeq = Math.max(rec.eventsAckedSeq, seq);
        recs.put(rec);
      }
      tx.objectStore(EVENTS).delete(IDBKeyRange.bound([this.id, 0], [this.id, seq]));
      await done(tx);
    });
  }

  destroy(): Promise<void> {
    return this.serial(async () => {
      const tx = this.db.transaction([RECS, BLOCKS, EVENTS], 'readwrite');
      tx.objectStore(RECS).delete(this.id);
      tx.objectStore(BLOCKS).delete(range(this.id));
      tx.objectStore(EVENTS).delete(range(this.id));
      await done(tx);
    });
  }
}

class IdbRecordingDb implements RecordingDb {
  readonly persistent = true;
  private readonly db: IDBDatabase;
  private readonly stores = new Map<string, IdbRecordingStore>();

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async list(): Promise<LocalRecording[]> {
    return req<LocalRecording[]>(this.db.transaction(RECS).objectStore(RECS).getAll());
  }

  async create(init: LocalRecordingInit): Promise<RecordingStore> {
    const tx = this.db.transaction(RECS, 'readwrite');
    const recs = tx.objectStore(RECS);
    const existing = await req<LocalRecording | undefined>(recs.get(init.id));
    if (!existing) recs.put(newLocalRecording(init, Date.now()));
    await done(tx);
    return this.open(init.id);
  }

  open(id: string): RecordingStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new IdbRecordingStore(this.db, id);
      this.stores.set(id, store);
    }
    return store;
  }
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(RECS)) db.createObjectStore(RECS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOCKS)) db.createObjectStore(BLOCKS, { keyPath: ['id', 'offset'] });
      if (!db.objectStoreNames.contains(EVENTS)) db.createObjectStore(EVENTS, { keyPath: ['id', 'seq'] });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

let dbPromise: Promise<RecordingDb> | null = null;

/** The recording database of this origin (IndexedDB, or memory when it cannot be opened). */
export function recordingDb(): Promise<RecordingDb> {
  dbPromise ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      return new IdbRecordingDb(await openIdb());
    } catch (e) {
      console.warn('[easy-study] IndexedDB unavailable; unsent recording audio is kept in memory only', e);
      return new MemoryRecordingDb();
    }
  })();
  return dbPromise;
}
