// Incremental ASR windows over 16 kHz s16le mono PCM (DESIGN §22; the live spike's segmenter, verified to tile a
// recording exactly and to transcribe every window once through crashes and restarts).
//
// Windows tile the recording without gaps: each window has an "own" region [ownStartMs, ownEndMs) — consecutive
// own regions are adjacent — and the audio actually transcribed [startMs, endMs), which begins OVERLAP earlier
// than ownStart only after a hard cut (no pause found before maxMs). A transcript segment belongs to the window
// whose own region contains its midpoint, so text at a hard cut is neither lost nor duplicated.
//
// Cuts: 20 ms frames in dBFS; silence threshold = clamp(10th percentile of the last 30 s + 10 dB, −65, −25); a
// silence run ≥ 200 ms is a cut candidate, cut at min(its middle, start + 400 ms). Pause/resume/stop force a cut
// (breaks). Memory: one float per 20 ms frame (≈ 720 KB per hour).

export const FRAME_MS = 20;
export const BYTES_PER_SECOND = 32_000;

export interface WindowPreset {
  minMs: number;
  targetMs: number;
  maxMs: number;
  /** 'best' = the longest pause between min and target; 'first' = the first pause after min. */
  pick: 'best' | 'first';
}

export const WINDOW_PRESETS: Readonly<Record<'live' | 'short' | 'upload', WindowPreset>> = Object.freeze({
  // Live lectures (DESIGN §22): 20–30 s windows, whisper gets whole sentences with context.
  live: { minMs: 20_000, targetMs: 25_000, maxMs: 30_000, pick: 'best' },
  // Lower latency variant of the live spike (p50 2.9 s instead of 14 s behind).
  short: { minMs: 6_000, targetMs: 10_000, maxMs: 30_000, pick: 'first' },
  // Uploaded files: chunks of at most 15 minutes cut at pauses (keeps whisper's RSS near 1 GB for long lectures).
  upload: { minMs: 5 * 60_000, targetMs: 10 * 60_000, maxMs: 15 * 60_000, pick: 'best' },
});

export type WindowCut = 'silence' | 'max' | 'break' | 'stop';

export interface AsrWindow {
  i: number;
  startMs: number;
  endMs: number;
  ownStartMs: number;
  ownEndMs: number;
  cut: WindowCut;
  /** Milliseconds above the silence threshold in the own region (windows with < 300 ms are not transcribed). */
  speechMs: number;
}

export interface SegmenterOptions {
  preset?: WindowPreset;
  overlapMs?: number;
  minSilenceMs?: number;
}

const FRAME_BYTES = (16_000 * FRAME_MS * 2) / 1000; // 640
const FLOOR_WINDOW_FRAMES = 30_000 / FRAME_MS;

export class Segmenter {
  readonly minF: number;
  readonly targetF: number;
  readonly maxF: number;
  readonly pick: 'best' | 'first';
  readonly overlapF: number;
  readonly minSilF: number;
  private energy = new Float32Array(1 << 14);
  /** Complete frames seen (index of the next frame). */
  frames = 0;
  /** Bytes fed so far (the next feed must start here). */
  fedBytes = 0;
  private pending: Buffer = Buffer.alloc(0);
  private ownStart = 0;
  private winStart = 0;
  private breaks: number[] = [];
  private index = 0;

  constructor(options: SegmenterOptions = {}) {
    const preset = options.preset ?? WINDOW_PRESETS.live;
    this.minF = Math.round(preset.minMs / FRAME_MS);
    this.targetF = Math.round(preset.targetMs / FRAME_MS);
    this.maxF = Math.round(preset.maxMs / FRAME_MS);
    this.pick = preset.pick;
    this.overlapF = Math.round((options.overlapMs ?? 1000) / FRAME_MS);
    this.minSilF = Math.round((options.minSilenceMs ?? 200) / FRAME_MS);
  }

  /** The next window index and where its own region starts (ms). */
  get nextWindow(): { i: number; ownStartMs: number } {
    return { i: this.index, ownStartMs: this.ownStart * FRAME_MS };
  }

  /** Continue after the last persisted window (restart): frames before `from` need not be fed again. */
  restore(last: AsrWindow | undefined): void {
    if (!last) return;
    this.index = last.i + 1;
    this.ownStart = Math.round(last.ownEndMs / FRAME_MS);
    this.winStart = last.cut === 'max' ? Math.max(0, this.ownStart - this.overlapF) : this.ownStart;
  }

  /**
   * Byte offset from which feeding is enough to decide the next windows the same way (the noise floor looks 30 s
   * back from any cut after ownStart). Frame aligned.
   */
  resumeByte(): number {
    return Math.max(0, this.ownStart - FLOOR_WINDOW_FRAMES - this.overlapF) * FRAME_BYTES;
  }

  /** Skips to a frame-aligned byte offset without energies (after restore; the skipped frames are never read). */
  skipTo(byte: number): void {
    if (byte % FRAME_BYTES !== 0) throw new Error('segmenter: skip must be frame aligned');
    this.fedBytes = byte;
    this.frames = byte / FRAME_BYTES;
    this.pending = Buffer.alloc(0);
    this.ensure(this.frames + 1);
  }

  private ensure(frames: number): void {
    if (frames <= this.energy.length) return;
    const grown = new Float32Array(Math.max(this.energy.length * 2, frames + 1024));
    grown.set(this.energy.subarray(0, this.frames));
    this.energy = grown;
  }

  feed(buf: Buffer, offset: number): void {
    if (offset !== this.fedBytes) throw new Error(`segmenter: non-contiguous feed ${offset} != ${this.fedBytes}`);
    this.fedBytes += buf.length;
    const data = this.pending.length ? Buffer.concat([this.pending, buf]) : buf;
    const whole = Math.floor(data.length / FRAME_BYTES);
    this.ensure(this.frames + whole);
    for (let f = 0; f < whole; f++) {
      let sum = 0;
      const base = f * FRAME_BYTES;
      for (let i = 0; i < FRAME_BYTES; i += 2) {
        const s = data.readInt16LE(base + i);
        sum += s * s;
      }
      const rms = Math.sqrt(sum / (FRAME_BYTES / 2)) / 32768;
      this.energy[this.frames++] = rms > 0 ? 20 * Math.log10(rms) : -120;
    }
    this.pending = Buffer.from(data.subarray(whole * FRAME_BYTES));
  }

  /** A forced cut at `ms` (pause, resume, stop), unless it is at or before the current window's start. */
  addBreak(ms: number): void {
    const f = Math.round(ms / FRAME_MS);
    if (f <= this.ownStart || this.breaks.includes(f)) return;
    this.breaks.push(f);
    this.breaks.sort((a, b) => a - b);
  }

  private threshold(at: number): number {
    const from = Math.max(0, at - FLOOR_WINDOW_FRAMES);
    const slice = Array.from(this.energy.subarray(from, at)).sort((a, b) => a - b);
    if (slice.length === 0) return -50;
    const floor = slice[Math.floor(slice.length * 0.1)];
    return Math.min(-25, Math.max(floor + 10, -65));
  }

  /** Silence runs (≥ minSil frames) that start in [from, to); a run still open at `avail` counts once long enough. */
  private silenceRuns(from: number, to: number, avail: number, thr: number): Array<{ start: number; end: number }> {
    const runs: Array<{ start: number; end: number }> = [];
    let start = -1;
    for (let f = from; f < avail; f++) {
      const silent = this.energy[f] < thr;
      if (silent && start < 0) start = f;
      if ((!silent || f === avail - 1) && start >= 0) {
        const end = silent ? f + 1 : f;
        if (end - start >= this.minSilF && start < to) runs.push({ start, end });
        start = -1;
      }
      if (start < 0 && f >= to) break;
    }
    return runs;
  }

  private speechMs(from: number, to: number, thr: number): number {
    let n = 0;
    for (let f = from; f < to; f++) if (this.energy[f] >= thr) n++;
    return n * FRAME_MS;
  }

  private emit(cutF: number, cut: WindowCut): AsrWindow {
    const thr = this.threshold(Math.max(cutF, 1));
    const w: AsrWindow = {
      i: this.index++,
      startMs: this.winStart * FRAME_MS,
      endMs: cutF * FRAME_MS,
      ownStartMs: this.ownStart * FRAME_MS,
      ownEndMs: cutF * FRAME_MS,
      cut,
      speechMs: this.speechMs(this.ownStart, Math.min(cutF, this.frames), thr),
    };
    this.ownStart = cutF;
    this.winStart = cut === 'max' ? Math.max(0, cutF - this.overlapF) : cutF;
    this.breaks = this.breaks.filter((b) => b > cutF);
    return w;
  }

  /** Windows that can be decided with the audio seen so far. `final`: flush the rest (stop / end of file). */
  poll(final = false): AsrWindow[] {
    const out: AsrWindow[] = [];
    for (;;) {
      const avail = this.frames;
      const brk = this.breaks.find((b) => b > this.ownStart && b <= avail);
      if (brk !== undefined && brk - this.ownStart <= this.maxF) {
        out.push(this.emit(brk, 'break'));
        continue;
      }
      if (avail - this.ownStart < this.minF) break;
      const thr = this.threshold(avail);
      const lo = this.ownStart + this.minF;
      const hiTarget = this.ownStart + this.targetF;
      const hiMax = this.ownStart + this.maxF;
      const runs = this.silenceRuns(lo, hiMax, Math.min(avail, hiMax + this.minSilF), thr);
      const mid = (r: { start: number; end: number }) => Math.min(r.start + Math.floor((r.end - r.start) / 2), r.start + 20);
      let cutF: number | undefined;
      if (this.pick === 'first') {
        if (runs.length > 0) cutF = mid(runs[0]);
      } else if (avail >= hiTarget) {
        const inTarget = runs.filter((r) => r.start < hiTarget);
        if (inTarget.length > 0) cutF = mid(inTarget.reduce((a, b) => (b.end - b.start >= a.end - a.start ? b : a)));
        else if (runs.length > 0) cutF = mid(runs[0]);
      }
      if (cutF !== undefined) {
        out.push(this.emit(cutF, 'silence'));
        continue;
      }
      if (avail >= hiMax) {
        // No pause long enough: cut at the quietest 100 ms of the last 5 s, the next window overlaps by 1 s.
        let best = hiMax;
        let bestE = Infinity;
        for (let f = hiMax - 250; f <= hiMax - 5; f++) {
          let e = 0;
          for (let k = 0; k < 5; k++) e += 10 ** (this.energy[f + k] / 10);
          if (e < bestE) {
            bestE = e;
            best = f + 2;
          }
        }
        out.push(this.emit(best, 'max'));
        continue;
      }
      break;
    }
    if (final && this.fedBytes > this.ownStart * FRAME_BYTES) {
      // The last window ends at the exact end of the audio (a trailing partial frame included).
      const w = this.emit(this.frames, 'stop');
      w.endMs = w.ownEndMs = (this.fedBytes / FRAME_BYTES) * FRAME_MS;
      out.push(w);
    }
    return out;
  }
}
