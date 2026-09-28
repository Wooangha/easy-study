// Storage of lecture recordings (DESIGN §22): library/<docId>/recordings/<rid>/
//   meta.json        RecordingMeta (RecordingInfo minus derived fields, plus internal state), atomic writes
//   audio.pcm        live: PCM s16le 16 kHz mono, append-only, fsynced before every acknowledgement
//   audio.idx        live: one line per commit "offset length crc32 receivedAtMs" (crash recovery, live.ts)
//   source.<ext>     upload: the file as uploaded;  asr.wav: 16 kHz mono PCM for whisper;  playback.m4a: AAC 64k
//   windows.jsonl    ASR windows as they are cut (segmenter.ts), append-only
//   transcript.json  TranscriptState: segments (with slides) + which windows are done, atomic writes
//   timeline.json    SlideViewEvent[] (live), markers.json AlignmentMarker[], align-llm.json LLM labels
// Recording ids: `rec-` + YYYYMMDD-HHMMSS + 4 hex (sortable, RECORDING_ID_RE).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RECORDING_ID_RE } from '../../shared/types.ts';
import type {
  AlignmentKind,
  AlignmentMarker,
  RecordingLanguage,
  RecordingSource,
  RecordingStatus,
  SlideViewEvent,
  TranscriptSegment,
  TranscriptStatus,
} from '../../shared/types.ts';
import { docPaths, isNotFound, readJsonFile, writeFileAtomic, writeJsonAtomic } from '../library.ts';
import type { AsrWindow } from './segmenter.ts';

export const RECORDINGS_DIR_NAME = 'recordings';
export const META_FILE = 'meta.json';

export interface RecordingMeta {
  version: 1;
  id: string;
  docId: string;
  title: string;
  source: RecordingSource;
  status: RecordingStatus;
  language: RecordingLanguage;
  model: string;
  liveTranscribe: boolean;
  createdAt: string;
  /** Uploads: total seconds (live recordings derive it from the stored bytes). */
  durationSec?: number;
  transcriptStatus: TranscriptStatus;
  /** Seconds of audio transcribed so far (end of the contiguous run of finished windows). */
  transcribedSec: number;
  alignment: AlignmentKind;
  hasManualMarkers: boolean;
  error?: string;
  /** Language whisper detected for 'auto' (then forced for the following windows). */
  detectedLanguage?: string;
  /** Live: the recording was stopped (no more audio is accepted beyond the committed bytes). */
  stoppedAt?: string;
  /** Live: stop asked for this many bytes, some of which had not arrived yet. */
  stopBytes?: number;
  /** Live: the last window was cut (all audio is in windows). */
  finalized?: boolean;
  /** Upload: stored file name (source.<ext>) and the name it was uploaded with. */
  sourceFile?: string;
  originalName?: string;
}

export interface TranscriptState {
  recordingId: string;
  segments: TranscriptSegment[];
  /** Windows whose segments are in `segments` (or that failed for good / had no speech). */
  doneWindows: number[];
  /** Windows that failed for good → the error. */
  failedWindows: Record<string, string>;
  nextId: number;
}

export interface LlmLabels {
  provider: string;
  model: string;
  at: string;
  /** segment id → slide (null = off-slide). */
  labels: Record<string, number | null>;
}

export interface RecordingPaths {
  dir: string;
  meta: string;
  audioPcm: string;
  audioIdx: string;
  windows: string;
  transcript: string;
  timeline: string;
  markers: string;
  llm: string;
  asrWav: string;
  playback: string;
}

export function recordingsDir(docId: string): string {
  return path.join(docPaths(docId).dir, RECORDINGS_DIR_NAME);
}

export function isRecordingId(rid: string): boolean {
  return RECORDING_ID_RE.test(rid);
}

export function recordingPaths(docId: string, rid: string): RecordingPaths {
  if (!isRecordingId(rid)) throw new Error(`invalid recording id: ${rid}`);
  const dir = path.join(recordingsDir(docId), rid);
  return {
    dir,
    meta: path.join(dir, META_FILE),
    audioPcm: path.join(dir, 'audio.pcm'),
    audioIdx: path.join(dir, 'audio.idx'),
    windows: path.join(dir, 'windows.jsonl'),
    transcript: path.join(dir, 'transcript.json'),
    timeline: path.join(dir, 'timeline.json'),
    markers: path.join(dir, 'markers.json'),
    llm: path.join(dir, 'align-llm.json'),
    asrWav: path.join(dir, 'asr.wav'),
    playback: path.join(dir, 'playback.m4a'),
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `rec-YYYYMMDD-HHMMSS-xxxx` (local time, like session ids). */
export function newRecordingId(now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `rec-${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Default title of a live recording: "녹음 2026-09-27 15:30". */
export function defaultLiveTitle(now: Date = new Date()): string {
  return `녹음 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const MAX_TITLE_CHARS = 200;

/** A title as stored: one line, trimmed, at most 200 characters; null when empty. */
export function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const oneLine = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return [...oneLine].slice(0, MAX_TITLE_CHARS).join('');
}

export async function readMeta(docId: string, rid: string): Promise<RecordingMeta | null> {
  const value = await readJsonFile<RecordingMeta>(recordingPaths(docId, rid).meta);
  if (!value || typeof value !== 'object' || value.id !== rid) return null;
  return {
    ...value,
    docId,
    transcribedSec: typeof value.transcribedSec === 'number' ? value.transcribedSec : 0,
    hasManualMarkers: value.hasManualMarkers === true,
  };
}

export async function writeMeta(meta: RecordingMeta): Promise<void> {
  await writeJsonAtomic(recordingPaths(meta.docId, meta.id).meta, meta);
}

/** Ids of the recording folders of a document (valid ids only). */
export async function listRecordingIds(docId: string): Promise<string[]> {
  try {
    return (await fs.readdir(recordingsDir(docId))).filter(isRecordingId);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

export function emptyTranscript(rid: string): TranscriptState {
  return { recordingId: rid, segments: [], doneWindows: [], failedWindows: {}, nextId: 1 };
}

export async function readTranscriptState(docId: string, rid: string): Promise<TranscriptState> {
  const value = await readJsonFile<Partial<TranscriptState>>(recordingPaths(docId, rid).transcript);
  if (!value || !Array.isArray(value.segments)) return emptyTranscript(rid);
  const segments = value.segments.filter(
    (s): s is TranscriptSegment =>
      !!s && typeof s.id === 'number' && typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string',
  );
  const maxId = segments.reduce((m, s) => Math.max(m, s.id), 0);
  return {
    recordingId: rid,
    segments: segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text, slide: typeof s.slide === 'number' ? s.slide : null })),
    doneWindows: Array.isArray(value.doneWindows) ? value.doneWindows.filter((n) => Number.isInteger(n)) : [],
    failedWindows: value.failedWindows && typeof value.failedWindows === 'object' ? value.failedWindows : {},
    nextId: Math.max(typeof value.nextId === 'number' ? value.nextId : 1, maxId + 1),
  };
}

export async function writeTranscriptState(docId: string, state: TranscriptState): Promise<void> {
  await writeJsonAtomic(recordingPaths(docId, state.recordingId).transcript, state);
}

/** Rows of a .jsonl file; a torn last line (crash mid-append) is dropped. */
export async function readJsonLines<T>(file: string): Promise<{ rows: T[]; torn: boolean }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return { rows: [], torn: false };
    throw err;
  }
  const rows: T[] = [];
  let torn = text.length > 0 && !text.endsWith('\n');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      torn = true;
    }
  }
  return { rows, torn };
}

export async function writeJsonLines(file: string, rows: unknown[]): Promise<void> {
  await writeFileAtomic(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

/** Windows of a recording in order (contiguous indices from 0; anything after a gap is dropped). */
export async function readWindows(docId: string, rid: string): Promise<AsrWindow[]> {
  const file = recordingPaths(docId, rid).windows;
  const { rows, torn } = await readJsonLines<AsrWindow>(file);
  const windows: AsrWindow[] = [];
  for (const w of rows) {
    if (!w || typeof w.i !== 'number' || w.i !== windows.length) break;
    windows.push(w);
  }
  if (torn || windows.length !== rows.length) await writeJsonLines(file, windows);
  return windows;
}

export async function readTimeline(docId: string, rid: string): Promise<SlideViewEvent[]> {
  const value = await readJsonFile<SlideViewEvent[]>(recordingPaths(docId, rid).timeline);
  return Array.isArray(value) ? value.filter((e) => e && typeof e.t === 'number' && typeof e.slide === 'number') : [];
}

export async function writeTimeline(docId: string, rid: string, events: SlideViewEvent[]): Promise<void> {
  await writeJsonAtomic(recordingPaths(docId, rid).timeline, events);
}

export async function readMarkers(docId: string, rid: string): Promise<AlignmentMarker[]> {
  const value = await readJsonFile<AlignmentMarker[]>(recordingPaths(docId, rid).markers);
  return Array.isArray(value) ? value.filter((m) => m && typeof m.t === 'number' && (m.slide === null || typeof m.slide === 'number')) : [];
}

export async function writeMarkers(docId: string, rid: string, markers: AlignmentMarker[]): Promise<void> {
  await writeJsonAtomic(recordingPaths(docId, rid).markers, markers);
}

export async function readLlmLabels(docId: string, rid: string): Promise<LlmLabels | null> {
  const value = await readJsonFile<LlmLabels>(recordingPaths(docId, rid).llm);
  return value && typeof value === 'object' && value.labels && typeof value.labels === 'object' ? value : null;
}

export async function writeLlmLabels(docId: string, rid: string, labels: LlmLabels): Promise<void> {
  await writeJsonAtomic(recordingPaths(docId, rid).llm, labels);
}
