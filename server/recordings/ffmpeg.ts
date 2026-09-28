// Uploaded recordings (DESIGN §22): content sniffing of the uploaded bytes and the one ffmpeg pass (argument array,
// no shell) that writes `asr.wav` (16 kHz mono s16 for whisper) and `playback.m4a` (AAC-LC 64 kbps mono,
// +faststart) from the same timeline. Recipe and error codes from the audio spike (minimal LGPL ffmpeg 8.1:
// exit 183 = not media / damaged ("moov atom not found", "Invalid data found"), 234 = no audio stream).
import fs from 'node:fs/promises';
import { runTool } from './asr.ts';

export interface SniffedMedia {
  /** File extension used for source.<ext>. */
  ext: string;
  label: string;
}

/**
 * The container of an uploaded file, by its first bytes (null = not an audio/video file we accept). The name's
 * extension is only used to tell MP3 without an ID3 tag apart from other MPEG streams.
 */
export function sniffMedia(head: Buffer, fileName = ''): SniffedMedia | null {
  const ascii = (from: number, to: number) => head.toString('latin1', from, to);
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).toLowerCase();
    if (brand.startsWith('qt')) return { ext: 'mov', label: 'QuickTime' };
    if (brand.startsWith('m4a') || brand.startsWith('m4b')) return { ext: 'm4a', label: 'MPEG-4 audio' };
    if (brand.startsWith('3g')) return { ext: '3gp', label: '3GPP' };
    return { ext: /\.m4a$/i.test(fileName) ? 'm4a' : 'mp4', label: 'MPEG-4' };
  }
  if (head.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(4, 8))) return { ext: 'mov', label: 'QuickTime' };
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { ext: /\.mkv$/i.test(fileName) ? 'mkv' : 'webm', label: 'WebM/Matroska' };
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg', label: 'Ogg' };
  if (ascii(0, 4) === 'fLaC') return { ext: 'flac', label: 'FLAC' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { ext: 'wav', label: 'WAV' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return { ext: 'avi', label: 'AVI' };
  if (ascii(0, 4) === 'riff') return { ext: 'w64', label: 'Wave64' };
  if (ascii(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(8, 12))) return { ext: 'aiff', label: 'AIFF' };
  if (ascii(0, 4) === 'caff') return { ext: 'caf', label: 'CAF' };
  if (ascii(0, 5) === '#!AMR') return { ext: 'amr', label: 'AMR' };
  if (ascii(0, 3) === 'ID3') return { ext: 'mp3', label: 'MP3' };
  if (head.length >= 16 && head.subarray(0, 16).equals(Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex'))) return { ext: 'wma', label: 'ASF/WMA' };
  if (head.length >= 2 && head[0] === 0x0b && head[1] === 0x77) return { ext: 'ac3', label: 'AC-3' };
  if (head.length >= 189 && head[0] === 0x47 && head[188] === 0x47) return { ext: 'ts', label: 'MPEG-TS' };
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync: ADTS AAC (layer bits 00) or MP3.
    return (head[1] & 0x06) === 0 ? { ext: 'aac', label: 'AAC (ADTS)' } : { ext: 'mp3', label: 'MP3' };
  }
  return null;
}

export const SUPPORTED_UPLOADS = 'm4a, mp3, wav, mp4, mov, webm, ogg, flac, aac';

/** ffmpeg arguments of the single conversion pass (DESIGN §22). Output formats are explicit (temporary names). */
export function ffmpegArgs(source: string, asrWav: string, playback: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-y',
    '-i',
    source,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-map_metadata',
    '-1',
    '-f',
    'wav',
    asrWav,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-movflags',
    '+faststart',
    '-f',
    'ipod',
    playback,
  ];
}

/** A readable Korean reason for a failed conversion. */
export function conversionError(err: unknown): string {
  const e = err as Error & { exitCode?: number | null; stderr?: string; code?: string };
  if (e.code === 'ENOENT') return 'ffmpeg를 찾을 수 없습니다. ffmpeg를 설치하거나 EASY_STUDY_FFMPEG에 경로를 지정하세요';
  const stderr = e.stderr ?? e.message ?? '';
  if (e.exitCode === 234 || /matches no streams|does not contain any stream|Output file .* does not contain/i.test(stderr)) {
    return '오디오 트랙이 없습니다';
  }
  if (e.exitCode === 183 || /moov atom not found|Invalid data found|could not find codec parameters|End of file/i.test(stderr)) {
    return '파일이 손상되었거나 업로드가 끝나지 않았습니다';
  }
  const last = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
  return `녹음 파일을 변환하지 못했습니다${last ? `: ${last.slice(0, 300)}` : ''}`;
}

/** "Duration: 01:00:00.02" of ffmpeg's input banner → seconds. */
export function parseDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Runs the conversion; the outputs appear under their final names only when ffmpeg succeeded. */
export async function convertUpload(options: { ffmpeg: string; source: string; asrWav: string; playback: string; signal?: AbortSignal }): Promise<void> {
  const tmpWav = `${options.asrWav}.tmp`;
  const tmpPlay = `${options.playback}.tmp`;
  try {
    await runTool(options.ffmpeg, ffmpegArgs(options.source, tmpWav, tmpPlay), { signal: options.signal });
    await fs.rename(tmpWav, options.asrWav);
    await fs.rename(tmpPlay, options.playback);
  } finally {
    await fs.rm(tmpWav, { force: true }).catch(() => {});
    await fs.rm(tmpPlay, { force: true }).catch(() => {});
  }
}
