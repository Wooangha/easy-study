// Generated audio for the recording tests (DESIGN §22): no files from outside the repository, no network.

/** PCM s16le mono 16 kHz: tones (with 10 ms fades) at [start, end) seconds, silence elsewhere. */
export function tonesPcm(totalSec: number, tones: Array<{ start: number; end: number; hz: number }>, amplitude = 0.3): Buffer {
  const n = Math.round(totalSec * 16000);
  const buf = Buffer.alloc(n * 2);
  for (const tone of tones) {
    const a = Math.round(tone.start * 16000);
    const b = Math.min(n, Math.round(tone.end * 16000));
    const fade = 160;
    for (let i = a; i < b; i++) {
      const env = Math.min(1, (i - a) / fade, (b - 1 - i) / fade);
      buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * tone.hz * (i - a)) / 16000) * amplitude * env * 32767), i * 2);
    }
  }
  return buf;
}
