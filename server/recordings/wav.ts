// WAV helpers (DESIGN §22): the 44-byte header of 16 kHz s16le mono PCM (live playback = header + audio.pcm; the
// windows handed to whisper-cli), reading the data chunk of ffmpeg's asr.wav, and copying a PCM range into a WAV
// file in pieces (never the whole recording in memory).
import fs from 'node:fs/promises';
import { LIVE_SAMPLE_RATE } from '../../shared/types.ts';

export const WAV_HEADER_BYTES = 44;
const COPY_PIECE = 1 << 20;

/** RIFF/WAVE header of `dataBytes` bytes of PCM s16le (mono, 16 kHz unless given). */
export function wavHeader(dataBytes: number, sampleRate = LIVE_SAMPLE_RATE, channels = 1): Buffer {
  const b = Buffer.alloc(WAV_HEADER_BYTES);
  const size = Math.min(dataBytes, 0xffffffff - 36);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + size, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(size, 40);
  return b;
}

export interface WavInfo {
  dataOffset: number;
  dataBytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Where the PCM data of a WAV file is (walks the RIFF chunks: ffmpeg writes a LIST chunk before `data`). */
export async function readWavInfo(file: string): Promise<WavInfo> {
  const fh = await fs.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let pos = 12;
    let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
    const chunk = Buffer.alloc(8);
    while (pos + 8 <= size) {
      await fh.read(chunk, 0, 8, pos);
      const id = chunk.toString('ascii', 0, 4);
      const len = chunk.readUInt32LE(4);
      if (id === 'fmt ') {
        const body = Buffer.alloc(16);
        await fh.read(body, 0, 16, pos + 8);
        fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitsPerSample: body.readUInt16LE(14) };
      } else if (id === 'data') {
        if (!fmt) throw new Error('WAV without a fmt chunk');
        const dataOffset = pos + 8;
        // A streamed WAV may carry 0 or 0xFFFFFFFF: the data then runs to the end of the file.
        const available = size - dataOffset;
        const dataBytes = len === 0 || len === 0xffffffff || len > available ? available : len;
        return { dataOffset, dataBytes: dataBytes - (dataBytes % 2), ...fmt };
      }
      pos += 8 + len + (len % 2);
    }
    throw new Error('WAV without a data chunk');
  } finally {
    await fh.close();
  }
}

/**
 * Writes `out` = WAV header + bytes [start, end) of the PCM that begins at `dataOffset` in `source`. Returns the
 * number of PCM bytes written (less than asked when the source is shorter).
 */
export async function writeWavSlice(source: string, dataOffset: number, start: number, end: number, out: string): Promise<number> {
  const src = await fs.open(source, 'r');
  try {
    const available = Math.max(0, (await src.stat()).size - dataOffset);
    const from = Math.min(start, available);
    const to = Math.min(end, available);
    const length = Math.max(0, to - from);
    const dst = await fs.open(out, 'w');
    try {
      await dst.write(wavHeader(length), 0, WAV_HEADER_BYTES, 0);
      const piece = Buffer.alloc(Math.min(COPY_PIECE, Math.max(length, 1)));
      let done = 0;
      while (done < length) {
        const n = Math.min(piece.length, length - done);
        const { bytesRead } = await src.read(piece, 0, n, dataOffset + from + done);
        if (bytesRead <= 0) break;
        await dst.write(piece, 0, bytesRead, WAV_HEADER_BYTES + done);
        done += bytesRead;
      }
      return done;
    } finally {
      await dst.close();
    }
  } finally {
    await src.close();
  }
}
