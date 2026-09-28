// Live-recording audio on the client (DESIGN §22): PCM s16le, mono, 16 kHz. The AudioWorklet (pcm-worklet.js)
// posts 100 ms blocks; they are collected into ~1 s chunks that go to IndexedDB, from where the uploader sends
// them with `?offset=` (the byte offset in the recording's single append-only stream). Pure helpers, no DOM.
import { LIVE_SAMPLE_RATE } from '../../../../shared/types.ts';

/** Bytes per second of live audio (s16le mono): 32 000. */
export const BYTES_PER_SECOND = LIVE_SAMPLE_RATE * 2;

/** Frames the worklet collects before posting a block (100 ms). */
export const WORKLET_BLOCK_FRAMES = LIVE_SAMPLE_RATE / 10;

/** Size of the chunks written to IndexedDB (1 s; the spike's verified unit). */
export const CHUNK_BYTES = BYTES_PER_SECOND;

/** Recording clock: seconds of audio in `bytes` of s16le mono 16 kHz. */
export function bytesToSeconds(bytes: number): number {
  return bytes / BYTES_PER_SECOND;
}

/** Whole samples (an even byte count) of `seconds` of audio. */
export function secondsToBytes(seconds: number): number {
  return Math.max(0, Math.round(seconds * LIVE_SAMPLE_RATE)) * 2;
}

/**
 * Collects the worklet's blocks into chunks of exactly `chunkBytes` (the last one, from flush(), may be shorter).
 * Blocks are copied, so the caller may reuse or transfer its buffers.
 */
export class PcmChunker {
  readonly chunkBytes: number;
  private buf: Uint8Array;
  private fill = 0;

  constructor(chunkBytes: number = CHUNK_BYTES) {
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes % 2 !== 0) {
      throw new Error(`chunkBytes must be a positive even integer (got ${chunkBytes})`);
    }
    this.chunkBytes = chunkBytes;
    this.buf = new Uint8Array(chunkBytes);
  }

  /** Bytes held back until the next full chunk or flush(). */
  get pendingBytes(): number {
    return this.fill;
  }

  /** Adds a block; returns the chunks it completed (usually none or one). */
  push(block: Uint8Array): Uint8Array[] {
    if (block.byteLength % 2 !== 0) throw new Error('PCM blocks must hold whole 16-bit samples');
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < block.byteLength) {
      const n = Math.min(this.chunkBytes - this.fill, block.byteLength - at);
      this.buf.set(block.subarray(at, at + n), this.fill);
      this.fill += n;
      at += n;
      if (this.fill === this.chunkBytes) {
        out.push(this.buf);
        this.buf = new Uint8Array(this.chunkBytes);
        this.fill = 0;
      }
    }
    return out;
  }

  /** The partial chunk (pause, stop, page hide), or null when nothing is held. */
  flush(): Uint8Array | null {
    if (this.fill === 0) return null;
    const out = this.buf.slice(0, this.fill);
    this.fill = 0;
    return out;
  }

  /** Drops what is held (a reload/crash would lose it too). */
  reset(): void {
    this.fill = 0;
  }
}

/** Joins byte arrays (IndexedDB blocks → one request body). */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Signal level of a block of samples: RMS and peak in dBFS (−100 for silence). */
export function levelOf(samples: Int16Array): { rmsDb: number; peakDb: number } {
  if (samples.length === 0) return { rmsDb: -100, peakDb: -100 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const toDb = (x: number) => (x > 0 ? Math.max(-100, 20 * Math.log10(x)) : -100);
  return { rmsDb: toDb(Math.sqrt(sum / samples.length)), peakDb: toDb(peak) };
}

/** Meter position 0..1 for a level in dBFS: −60 dB (and below) → 0, 0 dB → 1. */
export function meterFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** Samples of an s16le byte block (a copy when the block is not 2-byte aligned in its buffer). */
export function samplesOf(block: Uint8Array): Int16Array {
  const n = block.byteLength >> 1;
  if (block.byteOffset % 2 === 0) return new Int16Array(block.buffer, block.byteOffset, n);
  return new Int16Array(block.slice(0, n * 2).buffer);
}
