// Whisper models (DESIGN §22): downloaded on first use into the models folder, never bundled; resumable (Range
// requests into `<file>.part`), verified by size and sha256 before the rename that makes them visible. Every ASR
// model needs the Silero VAD model too, which is fetched with it. Model files and hashes come from the ASR spike
// (huggingface ggerganov/whisper.cpp at a pinned commit; sha256 = the LFS oid).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AsrModelInfo } from '../../shared/types.ts';
import { HttpError, desktopMode, libraryDir, repoRoot } from '../config.ts';

export interface ModelFile {
  file: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

export interface CatalogModel extends ModelFile {
  id: string;
  label: string;
}

export interface ModelCatalog {
  models: CatalogModel[];
  vad: ModelFile;
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1';

export const TURBO_MODEL_ID = 'large-v3-turbo-q5_0';
export const SMALL_MODEL_ID = 'small-q5_1';

export const DEFAULT_CATALOG: Readonly<ModelCatalog> = Object.freeze({
  models: [
    {
      id: TURBO_MODEL_ID,
      label: '정확 (large-v3-turbo)',
      file: 'ggml-large-v3-turbo-q5_0.bin',
      url: `${HF_WHISPER}/ggml-large-v3-turbo-q5_0.bin`,
      sizeBytes: 574_041_195,
      sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    },
    {
      id: SMALL_MODEL_ID,
      label: '빠름 (small)',
      file: 'ggml-small-q5_1.bin',
      url: `${HF_WHISPER}/ggml-small-q5_1.bin`,
      sizeBytes: 190_085_487,
      sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    },
  ],
  vad: {
    file: 'ggml-silero-v6.2.0.bin',
    // Pinned revision (like the models): the file behind `main` may change, the hash would then refuse it.
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
    sizeBytes: 885_098,
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  },
});

/**
 * Models folder: EASY_STUDY_MODELS_DIR; in desktop mode `<app data dir>/models` (the library's parent: the shell
 * keeps the library in the app data dir); otherwise `<repo>/.cache/models`.
 */
export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.EASY_STUDY_MODELS_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (desktopMode(env, [])) return path.join(path.dirname(libraryDir()), 'models');
  return path.join(repoRoot(), '.cache', 'models');
}

interface Download {
  modelId: string;
  received: number;
  total: number;
  controller: AbortController;
  done: Promise<void>;
}

export interface ModelStoreOptions {
  dir?: () => string;
  catalog?: ModelCatalog;
  fetch?: typeof fetch;
  /** Called after a model became installed (the transcription queue starts waiting jobs). */
  onInstalled?: (modelId: string) => void;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export class ModelStore {
  readonly catalog: ModelCatalog;
  private readonly dirOf: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly downloads = new Map<string, Download>();
  private readonly lastErrors = new Map<string, string>();
  onInstalled: ((modelId: string) => void) | undefined;

  constructor(options: ModelStoreOptions = {}) {
    this.catalog = options.catalog ?? DEFAULT_CATALOG;
    this.dirOf = options.dir ?? (() => modelsDir());
    this.fetchImpl = options.fetch ?? fetch;
    this.onInstalled = options.onInstalled;
  }

  get dir(): string {
    return this.dirOf();
  }

  model(id: string): CatalogModel | undefined {
    return this.catalog.models.find((m) => m.id === id);
  }

  filePath(file: ModelFile): string {
    return path.join(this.dir, file.file);
  }

  /** The model file and the VAD file are both in place (sizes match; hashes were checked at download). */
  isInstalled(id: string): boolean {
    const m = this.model(id);
    if (!m) return false;
    return sizeOf(this.filePath(m)) === m.sizeBytes && sizeOf(this.filePath(this.catalog.vad)) === this.catalog.vad.sizeBytes;
  }

  isDownloading(id: string): boolean {
    return this.downloads.has(id);
  }

  /** The last download failure of a model (cleared by the next start). */
  lastError(id: string): string | undefined {
    return this.lastErrors.get(id);
  }

  list(recommended: string): AsrModelInfo[] {
    return this.catalog.models.map((m) => {
      const d = this.downloads.get(m.id);
      const info: AsrModelInfo = {
        id: m.id,
        label: m.label,
        sizeBytes: m.sizeBytes,
        installed: this.isInstalled(m.id),
        recommended: m.id === recommended,
      };
      if (d) info.downloading = { receivedBytes: d.received, totalBytes: d.total };
      return info;
    });
  }

  /** Files still missing for a model (the VAD model first). */
  private missing(m: CatalogModel): ModelFile[] {
    return [this.catalog.vad, m].filter((f) => sizeOf(this.filePath(f)) !== f.sizeBytes);
  }

  /**
   * Starts downloading a model (and the VAD model when missing). Resolves once the first request answered (so an
   * unreachable server or a 404 is an HTTP error for the caller) — the rest continues in the background.
   * No-op when installed or already downloading. HttpError 404 for unknown ids, 502 when the download cannot start.
   */
  async startDownload(id: string): Promise<void> {
    const m = this.model(id);
    if (!m) throw new HttpError(404, `알 수 없는 모델입니다: ${id}`);
    if (this.downloads.has(id) || this.isInstalled(id)) return;
    const files = this.missing(m);
    const controller = new AbortController();
    const total = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    let started: () => void = () => {};
    let failedToStart: (err: unknown) => void = () => {};
    const startedPromise = new Promise<void>((resolve, reject) => {
      started = resolve;
      failedToStart = reject;
    });
    const download: Download = { modelId: id, received: 0, total, controller, done: Promise.resolve() };
    this.downloads.set(id, download);
    this.lastErrors.delete(id);
    download.done = (async () => {
      let base = 0;
      let first = true;
      try {
        await fs.mkdir(this.dir, { recursive: true });
        for (const file of files) {
          await this.fetchFile(file, controller.signal, (n) => (download.received = base + n), () => {
            if (first) started();
            first = false;
          });
          base += file.sizeBytes;
          download.received = base;
        }
        if (first) started();
        this.downloads.delete(id);
        this.onInstalled?.(id);
      } catch (err) {
        this.downloads.delete(id);
        const message = controller.signal.aborted ? '다운로드를 취소했습니다' : errorText(err);
        this.lastErrors.set(id, message);
        if (!controller.signal.aborted) console.warn(`[asr] download of ${id} failed: ${message}`);
        failedToStart(err);
      }
    })();
    try {
      await startedPromise;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `모델을 내려받을 수 없습니다: ${errorText(err)}`);
    }
  }

  /** Waits until the running download of a model ends (tests). */
  async waitForDownload(id: string): Promise<void> {
    await this.downloads.get(id)?.done;
  }

  /** Downloads one file into `<file>.part` (continuing it), verifies size and sha256, then renames it. */
  private async fetchFile(file: ModelFile, signal: AbortSignal, onProgress: (bytes: number) => void, onStarted: () => void): Promise<void> {
    const target = this.filePath(file);
    const part = `${target}.part`;
    let have = Math.max(0, sizeOf(part));
    if (have > file.sizeBytes) {
      await fs.rm(part, { force: true });
      have = 0;
    }
    if (have < file.sizeBytes) {
      const res = await this.fetchImpl(file.url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        redirect: 'follow',
        signal,
      });
      if (res.status === 416 && have > 0) {
        // Nothing more to send: the part is complete (checked below).
        await res.body?.cancel();
      } else {
        if (res.status !== 200 && res.status !== 206) {
          await res.body?.cancel();
          throw new Error(`HTTP ${res.status} (${file.url})`);
        }
        if (!res.body) throw new Error('빈 응답');
        const append = res.status === 206 && have > 0;
        if (!append) have = 0;
        onStarted();
        let received = have;
        onProgress(received);
        // Chunk by chunk with an awaited write: whatever arrived before a dropped connection is on disk for the resume.
        const fh = await fs.open(part, append ? 'a' : 'w');
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            received += chunk.length;
            if (received > file.sizeBytes) throw new Error('파일이 예상보다 큽니다');
            await fh.write(chunk);
            onProgress(received);
          }
        } finally {
          await fh.close();
        }
      }
    } else {
      onStarted();
    }
    const size = sizeOf(part);
    if (size !== file.sizeBytes) throw new Error(`다운로드가 끝나지 않았습니다 (${size}/${file.sizeBytes} 바이트). 다시 시도하면 이어서 받습니다`);
    const digest = await sha256Of(part);
    if (digest !== file.sha256) {
      await fs.rm(part, { force: true });
      throw new Error(`내려받은 파일이 손상되었습니다 (sha256 불일치: ${file.file}). 다시 시도해 주세요`);
    }
    await fs.rename(part, target);
    onProgress(file.sizeBytes);
  }

  /** Cancels a running download and removes the model file (the VAD model stays: other models use it). */
  async delete(id: string): Promise<void> {
    const m = this.model(id);
    if (!m) throw new HttpError(404, `알 수 없는 모델입니다: ${id}`);
    const running = this.downloads.get(id);
    if (running) {
      running.controller.abort();
      await running.done.catch(() => {});
    }
    const target = this.filePath(m);
    await fs.rm(target, { force: true });
    await fs.rm(`${target}.part`, { force: true });
  }

  /** Cancels every download (shutdown). */
  async stopAll(): Promise<void> {
    const running = [...this.downloads.values()];
    for (const d of running) d.controller.abort();
    await Promise.all(running.map((d) => d.done.catch(() => {})));
  }

  /** Absolute paths for a run, or null when not installed. */
  paths(id: string): { model: string; vad: string } | null {
    const m = this.model(id);
    if (!m || !this.isInstalled(id)) return null;
    return { model: this.filePath(m), vad: this.filePath(this.catalog.vad) };
  }

  /** Whether any model file exists at all (for messages). */
  anyInstalled(): boolean {
    return this.catalog.models.some((m) => this.isInstalled(m.id));
  }

  hasFile(file: string): boolean {
    return existsSync(path.join(this.dir, file));
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error && cause.message ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
