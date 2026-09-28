// Crash-safe append-only audio of a live recording (DESIGN §22; the live spike's protocol, verified through server
// SIGKILLs, power-loss garbage, torn pages and lossy networks with byte-exact results).
//
// One byte stream per recording. Every upload names its offset (`POST …/audio?offset=N`, like the tus resumable
// upload protocol), so any retry is idempotent:
// - offset > committed → 409 {offset: committed} (a gap: the client resends from there);
// - bytes that overlap stored ones are compared: all equal → 200 (duplicate); different → 409 (conflict);
//   a partial overlap appends only the new tail;
// - the answer {offset} is sent only after the bytes AND their index line are fsynced (the client deletes
//   acknowledged audio).
// audio.idx holds one line per commit "offset length crc32 receivedAtMs". Recovery truncates audio.pcm and the index
// at the first entry that is not contiguous, runs past the end of the file or (for the last CHECKED_COMMITS
// commits) fails its CRC; the client then resends what it still holds.
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { HttpError } from '../config.ts';
import { isNotFound } from '../library.ts';

/** CRCs checked at recovery (older commits were fsynced long before; reading a whole lecture would cost ~115 MB/h). */
const CHECKED_COMMITS = 64;
/** Longest live recording (24 h of 16 kHz s16 mono): the WAV header of the playback is 32-bit. */
export const MAX_LIVE_BYTES = 24 * 3600 * 32_000;

export interface AppendResult {
  offset: number;
  duplicate: boolean;
  /** Bytes appended by this request (the new tail). */
  appended: Buffer;
  /** Where the appended bytes start. */
  at: number;
}

/** Test hooks: `trace` sees every durability step in order; `fault` may throw at a step to simulate a crash. */
export interface LiveHooks {
  trace?: (step: 'write-data' | 'sync-data' | 'write-index' | 'sync-index') => void;
  fault?: (step: 'after-data' | 'after-index-write' | 'after-index') => void;
}

export interface RecoveryReport {
  /** Bytes of audio.pcm dropped past the last verified commit. */
  truncatedBytes: number;
  /** Index lines dropped (torn, non-contiguous, CRC mismatch). */
  droppedEntries: number;
}

interface IndexEntry {
  offset: number;
  length: number;
  crc: number;
  at: number;
}

function parseIndex(text: string): { entries: IndexEntry[]; clean: boolean } {
  const entries: IndexEntry[] = [];
  let clean = text.length === 0 || text.endsWith('\n');
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ').map(Number);
    if (parts.length !== 4 || parts.some((x) => !Number.isSafeInteger(x) || x < 0)) {
      clean = false;
      break;
    }
    entries.push({ offset: parts[0], length: parts[1], crc: parts[2], at: parts[3] });
  }
  return { entries, clean };
}

const indexLine = (e: IndexEntry) => `${e.offset} ${e.length} ${e.crc} ${e.at}\n`;

export class LiveAudio {
  readonly audioPath: string;
  readonly indexPath: string;
  private audio: FileHandle | null = null;
  private index: FileHandle | null = null;
  private hooks: LiveHooks;
  /** Bytes stored and acknowledged. */
  committed = 0;
  /** Size of the index file after the last complete line (a failed write is cut back to it). */
  private indexBytes = 0;

  constructor(audioPath: string, indexPath: string, hooks: LiveHooks = {}) {
    this.audioPath = audioPath;
    this.indexPath = indexPath;
    this.hooks = hooks;
  }

  /** Creates empty audio and index files (a new recording). */
  static async create(audioPath: string, indexPath: string): Promise<void> {
    await fs.writeFile(audioPath, '');
    await fs.writeFile(indexPath, '');
  }

  /** Opens the files and truncates them to the last verified commit. */
  async open(): Promise<RecoveryReport> {
    try {
      this.audio = await fs.open(this.audioPath, 'r+');
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await fs.writeFile(this.audioPath, '');
      this.audio = await fs.open(this.audioPath, 'r+');
    }
    const size = (await this.audio.stat()).size;
    let text = '';
    try {
      text = await fs.readFile(this.indexPath, 'utf8');
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const { entries, clean } = parseIndex(text);
    const firstChecked = Math.max(0, entries.length - CHECKED_COMMITS);
    let good = 0;
    const kept: IndexEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.offset !== good || e.offset + e.length > size) break;
      if (i >= firstChecked) {
        const buf = Buffer.alloc(e.length);
        await this.audio.read(buf, 0, e.length, e.offset);
        if (crc32(buf) !== e.crc) break;
      }
      good += e.length;
      kept.push(e);
    }
    if (size !== good) await this.audio.truncate(good);
    if (!clean || kept.length !== entries.length) {
      await fs.writeFile(this.indexPath, kept.map(indexLine).join(''));
    }
    this.index = await fs.open(this.indexPath, 'a');
    this.indexBytes = (await this.index.stat()).size;
    this.committed = good;
    return { truncatedBytes: size - good, droppedEntries: entries.length - kept.length };
  }

  /**
   * Stores `body` at `offset` (see the file comment). `final`: the recording was stopped — only bytes that are
   * already stored are accepted (as duplicates). Throws HttpError 409 {offset} for gaps and conflicts.
   */
  async append(offset: number, body: Buffer, final = false): Promise<AppendResult> {
    const audio = this.audio;
    const index = this.index;
    if (!audio || !index) throw new HttpError(409, '녹음 파일이 닫혀 있습니다', { offset: this.committed });
    if (offset > this.committed) {
      throw new HttpError(409, `offset ${offset}은(는) 저장된 끝(${this.committed})보다 뒤입니다. 그 지점부터 다시 보내 주세요`, {
        offset: this.committed,
      });
    }
    const end = offset + body.length;
    const overlap = Math.min(end, this.committed) - offset;
    if (overlap > 0) {
      const stored = Buffer.alloc(overlap);
      await audio.read(stored, 0, overlap, offset);
      if (!stored.equals(body.subarray(0, overlap))) {
        throw new HttpError(409, '이미 저장된 오디오와 내용이 다릅니다', { offset: this.committed });
      }
      if (end <= this.committed) return { offset: this.committed, duplicate: true, appended: Buffer.alloc(0), at: this.committed };
    }
    if (final) throw new HttpError(409, '녹음이 이미 끝났습니다', { offset: this.committed });
    if (end > MAX_LIVE_BYTES) throw new HttpError(409, '녹음이 너무 깁니다 (최대 24시간)', { offset: this.committed });
    const tail = body.subarray(Math.max(0, overlap));
    const at = this.committed;
    const { trace, fault } = this.hooks;
    await audio.write(tail, 0, tail.length, at);
    trace?.('write-data');
    await audio.datasync();
    trace?.('sync-data');
    fault?.('after-data');
    const line = Buffer.from(indexLine({ offset: at, length: tail.length, crc: crc32(tail), at: Date.now() }));
    try {
      await index.write(line);
      trace?.('write-index');
      fault?.('after-index-write');
      await index.datasync();
      trace?.('sync-index');
    } catch (err) {
      // A partly written line (ENOSPC, EIO) must not stay in front of the next one: recovery stops at the first
      // malformed line and would drop every later commit. Cut the index back to its last complete line.
      await index.truncate(this.indexBytes).catch(() => {});
      throw err;
    }
    this.indexBytes += line.length;
    fault?.('after-index');
    this.committed = at + tail.length;
    return { offset: this.committed, duplicate: false, appended: Buffer.from(tail), at };
  }

  /** Reads committed bytes [start, end) (segmenter recovery). */
  async read(start: number, end: number): Promise<Buffer> {
    if (!this.audio) throw new Error('closed');
    const length = Math.max(0, Math.min(end, this.committed) - start);
    const buf = Buffer.alloc(length);
    if (length > 0) await this.audio.read(buf, 0, length, start);
    return buf;
  }

  async close(): Promise<void> {
    const handles = [this.audio, this.index];
    this.audio = null;
    this.index = null;
    await Promise.all(handles.map((h) => h?.close().catch(() => {})));
  }
}
