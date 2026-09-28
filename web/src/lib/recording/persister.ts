// Captured audio → the local store, in order (DESIGN §22). A chunk the store could not write (a full disk, WebKit's
// "Connection to Indexed Database server lost") is not dropped: it stays queued in memory at its offset and is
// written before the next one, so the store never gets a hole and the recording clock (frames captured) never runs
// ahead of the audio that will reach the server. The recorder pauses the recording once too much waits in memory.
// Pure (no DOM): tested with the in-memory store.
import type { RecordingStore } from './store.ts';

export interface PersisterHooks {
  /** Everything queued is stored (the uploader may send it). */
  onSaved: () => void;
  /** A write failed; `first`: the first failure since the store last worked. The chunk stays queued. */
  onError: (error: unknown, unsavedBytes: number, first: boolean) => void;
  /** The store works again after failures. */
  onRecovered?: () => void;
}

export class ChunkPersister {
  private readonly store: RecordingStore;
  private readonly hooks: PersisterHooks;
  private readonly queue: Array<{ at: number; bytes: Uint8Array }> = [];
  /** Store offset of the next chunk pushed. */
  private next: number;
  private chain: Promise<void> = Promise.resolve();
  /** Bytes pushed but not stored yet. */
  unsavedBytes = 0;
  /** The last write failed. */
  failing = false;

  constructor(store: RecordingStore, startOffset: number, hooks: PersisterHooks) {
    this.store = store;
    this.next = startOffset;
    this.hooks = hooks;
  }

  /** Queues a chunk and writes the queue; resolves when this attempt ended (never rejects). */
  push(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 0) {
      this.queue.push({ at: this.next, bytes });
      this.next += bytes.byteLength;
      this.unsavedBytes += bytes.byteLength;
    }
    return this.flush();
  }

  /** Writes whatever is queued, oldest first (after the writes already running); never rejects. */
  flush(): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.queue.length === 0) return;
      try {
        while (this.queue.length > 0) {
          const chunk = this.queue[0];
          // With its offset: a retry of a write that did land is not stored twice.
          await this.store.appendAudio(chunk.bytes, chunk.at);
          this.queue.shift();
          this.unsavedBytes -= chunk.bytes.byteLength;
        }
      } catch (e) {
        const first = !this.failing;
        this.failing = true;
        this.hooks.onError(e, this.unsavedBytes, first);
        return;
      }
      if (this.failing) {
        this.failing = false;
        this.hooks.onRecovered?.();
      }
      this.hooks.onSaved();
    });
    // A hook that threw does not break the chain: the next flush still runs, and callers never see a rejection.
    this.chain = run.catch((e: unknown) => console.warn('[easy-study] recording persister hook failed', e));
    return this.chain;
  }
}
