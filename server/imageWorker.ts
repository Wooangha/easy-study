// Image worker (DESIGN §15): every sharp/libvips job runs in a short-lived child process, so the
// long-lived server never keeps libvips' memory (and the malloc fragmentation it leaves behind).
//
// One run works on one document directory:
//   1. optionally (ingest) the overview contact sheets: sheets/sheet-NN.png + sheets/sheets.json (§3 step 4),
//   2. optionally the derived files of server/assets.ts that are still missing: view renditions (lossy WebP),
//      thumbnails (WebP) and inline JPEGs for every slide, and inline JPEGs for every contact sheet.
//
// Parent side: runImageWorker() forks this very file with process.execPath (server/imageWorker.ts in
// development and tests, dist-server/server/imageWorker.js in the production build) and talks to it over
// the IPC channel. Child side: the bottom of this file, run only when it is the entry module. sharp is
// imported there, dynamically, so importing this module from the server never loads sharp.
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type sharpModule from 'sharp';
import type { OutputInfo, OverlayOptions, Sharp as SharpPipeline } from 'sharp';
import {
  INLINE_MAX_BYTES,
  INLINE_MAX_EDGE,
  THUMB_WEBP_QUALITY,
  THUMB_WIDTH,
  VIEW_WEBP_QUALITY,
  VIEW_WIDTHS,
  inlinePathFor,
  thumbPath,
  viewPath,
} from './assets.ts';

// ---------------------------------------------------------------------------
// Protocol (shared by both sides)
// ---------------------------------------------------------------------------

/** Entry of sheets/sheets.json. */
export interface SheetEntry {
  file: string;
  fromSlide: number;
  toSlide: number;
}

export interface ImageJob {
  /** Absolute path of library/<docId>. */
  docDir: string;
  /** File names of the rendered slides under slides/, in slide order (slide n = slides[n - 1]). */
  slides: string[];
  /** (Re)build the contact sheets and sheets.json first, for slides of this aspect ratio (width / height). */
  sheets?: { aspectRatio: number };
  /** Write the derived files (server/assets.ts) that do not exist yet. */
  derived: boolean;
}

/** A derived file that could not be written (the run goes on with the others). */
export interface ImageFailure {
  file: string;
  error: string;
}

export interface ImageWorkerResult {
  /** The contact sheets, when the job built them. */
  sheets: SheetEntry[] | null;
  /** Derived files written by this run. */
  written: number;
  failed: ImageFailure[];
}

type ChildMessage =
  | { type: 'sheets'; entries: SheetEntry[] }
  | { type: 'done'; written: number; failed: ImageFailure[] }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Parent side
// ---------------------------------------------------------------------------

export interface ImageWorkerOptions {
  /** Run below normal priority (background backfill). */
  lowPriority?: boolean;
}

export interface ImageWorkerRun {
  /** Resolves when the worker has finished; rejects when it failed, crashed or was killed. */
  readonly done: Promise<ImageWorkerResult>;
  /**
   * Resolves as soon as the contact sheets are written (only for jobs with `sheets`), while the worker
   * goes on with the derived files; rejects when the worker ends without them.
   */
  readonly sheets: Promise<SheetEntry[]>;
  /** Stops the worker (the run then rejects). Files already written stay; partial ones never exist. */
  kill(): void;
}

const STDERR_TAIL_CHARS = 2_000;

/** The error a run rejects with after kill() (name 'ImageWorkerStopped'). */
function stoppedError(): Error {
  const err = new Error('image worker was stopped');
  err.name = 'ImageWorkerStopped';
  return err;
}

export function isImageWorkerStopped(err: unknown): boolean {
  return err instanceof Error && err.name === 'ImageWorkerStopped';
}

/** Absolute path of this module: .ts in development and tests, .js in the compiled build. */
export function imageWorkerPath(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * The server's environment; on macOS plus MallocSpaceEfficient=1, which made libmalloc hand freed libvips
 * buffers back sooner: the worker's peak RSS for a 49-slide deck went from ~275 to ~225 MB (same run time).
 * Other platforms ignore it.
 */
function workerEnv(): NodeJS.ProcessEnv {
  return process.platform === 'darwin' ? { ...process.env, MallocSpaceEfficient: '1' } : process.env;
}

/** Runs `job` in a new worker process. */
export function runImageWorker(job: ImageJob, options: ImageWorkerOptions = {}): ImageWorkerRun {
  let resolveSheets: (entries: SheetEntry[]) => void = () => {};
  let rejectSheets: (err: Error) => void = () => {};
  const sheets = new Promise<SheetEntry[]>((resolve, reject) => {
    resolveSheets = resolve;
    rejectSheets = reject;
  });
  sheets.catch(() => {}); // callers that do not wait for the sheets must not see an unhandled rejection

  const child = fork(imageWorkerPath(), [], {
    execPath: process.execPath,
    // Never inherit the server's own flags (--test, --watch-path, --inspect, ...).
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
    windowsHide: true,
    env: workerEnv(),
  });
  let killed = false;
  const kill = () => {
    killed = true;
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };

  const done = new Promise<ImageWorkerResult>((resolve, reject) => {
    let stderr = '';
    let sheetEntries: SheetEntry[] | null = null;
    let final: ChildMessage | null = null;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      rejectSheets(err);
      reject(err);
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('message', (raw: unknown) => {
      const message = raw as ChildMessage;
      if (message?.type === 'sheets') {
        sheetEntries = message.entries;
        resolveSheets(message.entries);
      } else if (message?.type === 'done' || message?.type === 'error') {
        final = message;
      }
    });
    child.once('spawn', () => {
      // kill() can land before 'spawn': the job was never sent, and sending it now would fail with
      // EPIPE/ENOTCONN. The run is a stop, not a start failure; 'close' settles it.
      if (killed) return;
      if (options.lowPriority && child.pid !== undefined) {
        try {
          os.setPriority(child.pid, 10); // "below normal" on Windows as well
        } catch {
          // Not permitted here: it runs at normal priority.
        }
      }
      child.send(job, (err: Error | null) => {
        if (err) fail(killed ? stoppedError() : new Error(`image worker could not be started: ${err.message}`));
      });
    });
    child.on('error', (err) => fail(killed ? stoppedError() : new Error(`image worker could not run: ${err.message}`)));
    // 'close', not 'exit': it comes after the IPC channel is drained, so the final message has arrived.
    child.once('close', (code, signal) => {
      if (settled) return;
      const outcome = final as ChildMessage | null;
      if (outcome?.type === 'done' && code === 0) {
        settled = true;
        if (job.sheets && !sheetEntries) rejectSheets(new Error('image worker finished without the contact sheets'));
        resolve({ sheets: sheetEntries, written: outcome.written, failed: outcome.failed });
        return;
      }
      // After kill() the run is a stop, whatever the child managed to report before it died.
      if (killed) return fail(stoppedError());
      if (outcome?.type === 'error') return fail(new Error(outcome.message));
      const detail = stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
      fail(new Error(`image worker exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`));
    });
  });
  return { done, sheets, kill };
}

// ---------------------------------------------------------------------------
// Child side
// ---------------------------------------------------------------------------

type Sharp = typeof sharpModule;

const SLIDES_PER_SHEET = 4;
const SHEET_CELL_WIDTH = 800;
const SHEET_GUTTER = 8;
const SHEET_MAX_EDGE = 1600;
/** JPEG qualities tried in order until an inline image fits INLINE_MAX_BYTES (as providers/proc.ts did). */
const INLINE_QUALITIES = [85, 72, 60];
/** Then smaller long edges at quality 60, down to a legible minimum. */
const INLINE_FALLBACK_EDGES = [1200, 960, 768, 640, 512];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Removes `*.tmp` files a killed worker may have left in the derived-file directories. */
async function removeLeftoverTmpFiles(docDir: string): Promise<void> {
  for (const sub of ['view', 'thumbs', 'inline']) {
    const dir = path.join(docDir, sub);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (name.endsWith('.tmp')) await fs.rm(path.join(dir, name), { force: true });
  }
}

/** SVG badge "Slide N" (dark, white bold text) for the label band above a sheet cell. */
function slideLabel(slide: number, fontSize: number): { svg: Buffer; height: number } {
  const text = `Slide ${slide}`;
  const padX = Math.round(fontSize * 0.45);
  const padY = Math.round(fontSize * 0.2);
  const width = Math.round(text.length * fontSize * 0.62 + padX * 2);
  const height = Math.round(fontSize * 1.2 + padY * 2);
  const baseline = Math.round(height / 2 + fontSize * 0.36);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="0" y="0" width="${width}" height="${height}" rx="${Math.round(fontSize * 0.3)}" fill="#111827"/>` +
      `<text x="${width / 2}" y="${baseline}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" ` +
      `font-size="${fontSize}" font-weight="700" fill="#ffffff">${text}</text>` +
      `</svg>`,
  );
  return { svg, height };
}

/**
 * Overview contact sheets: groups of 4 consecutive slides laid out 2x2 (800 px wide cells, 8 px
 * white gutter), downscaled so the long edge is <= 1600 px. Each cell starts with a white band
 * holding a dark "Slide N" badge at its top-left, so the label never hides slide content (slide
 * titles usually sit exactly where an overlaid badge would go). Writes sheets.json.
 */
async function buildContactSheets(sharp: Sharp, job: ImageJob, aspectRatio: number): Promise<SheetEntry[]> {
  const slidesDir = path.join(job.docDir, 'slides');
  const sheetsDir = path.join(job.docDir, 'sheets');
  await fs.mkdir(sheetsDir, { recursive: true });
  const pageCount = job.slides.length;
  const cellWidth = SHEET_CELL_WIDTH;
  const imageHeight = Math.max(1, Math.round(cellWidth / (aspectRatio > 0 ? aspectRatio : 4 / 3)));
  const labelFontSize = Math.max(24, Math.round(cellWidth * 0.042));
  const bandHeight = slideLabel(1, labelFontSize).height + 6;
  const cellHeight = bandHeight + imageHeight;
  const sheetCount = Math.ceil(pageCount / SLIDES_PER_SHEET);
  const sheetDigits = Math.max(2, String(sheetCount).length);
  const entries: SheetEntry[] = [];

  for (let index = 0; index < sheetCount; index++) {
    const fromSlide = index * SLIDES_PER_SHEET + 1;
    const toSlide = Math.min(pageCount, fromSlide + SLIDES_PER_SHEET - 1);
    const count = toSlide - fromSlide + 1;
    const columns = count === 1 ? 1 : 2;
    const rows = Math.ceil(count / columns);
    const width = columns * cellWidth + (columns + 1) * SHEET_GUTTER;
    const height = rows * cellHeight + (rows + 1) * SHEET_GUTTER;

    const layers: OverlayOptions[] = [];
    for (let k = 0; k < count; k++) {
      const slide = fromSlide + k;
      const left = SHEET_GUTTER + (k % columns) * (cellWidth + SHEET_GUTTER);
      const top = SHEET_GUTTER + Math.floor(k / columns) * (cellHeight + SHEET_GUTTER);
      const image = await sharp(path.join(slidesDir, job.slides[slide - 1]))
        .resize(cellWidth, imageHeight, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
      layers.push({ input: slideLabel(slide, labelFontSize).svg, left, top });
      layers.push({ input: image, left, top: top + bandHeight });
    }

    const composed = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
      .composite(layers)
      .png()
      .toBuffer();
    const file = `sheet-${String(index + 1).padStart(sheetDigits, '0')}.png`;
    // Composite first, then scale: sharp applies resize before composite within one pipeline.
    const scaled = await sharp(composed)
      .resize({ width: SHEET_MAX_EDGE, height: SHEET_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    await writeAtomic(path.join(sheetsDir, file), scaled);
    entries.push({ file, fromSlide, toSlide });
  }

  await writeAtomic(path.join(sheetsDir, 'sheets.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

/** Sheet files listed by sheets/sheets.json ([] when it is missing or unreadable). */
async function readSheetFiles(docDir: string): Promise<string[]> {
  try {
    const entries = JSON.parse(await fs.readFile(path.join(docDir, 'sheets', 'sheets.json'), 'utf8')) as unknown;
    if (!Array.isArray(entries)) return [];
    // basename(): sheets.json is data on disk, never let it point outside the sheets dir.
    return entries.flatMap((entry) =>
      typeof (entry as SheetEntry | null)?.file === 'string' ? [path.basename((entry as SheetEntry).file)] : [],
    );
  } catch {
    return [];
  }
}

/**
 * Compact JPEG for LLM requests: long edge <= INLINE_MAX_EDGE, stepping the quality down (and then the
 * size) until it fits INLINE_MAX_BYTES. `input` is the decoded image (raw pixels), so nothing is decoded twice.
 */
async function encodeInlineJpeg(input: () => SharpPipeline): Promise<Buffer> {
  const resized = (edge: number) => input().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
  let out = Buffer.alloc(0);
  for (const quality of INLINE_QUALITIES) {
    out = await resized(INLINE_MAX_EDGE).jpeg({ quality }).toBuffer();
    if (out.length <= INLINE_MAX_BYTES) return out;
  }
  // Still too large (a photo or noise-like picture): make it smaller as well.
  for (const edge of INLINE_FALLBACK_EDGES) {
    out = await resized(edge).jpeg({ quality: 60 }).toBuffer();
    if (out.length <= INLINE_MAX_BYTES) break;
  }
  return out;
}

interface DerivedTarget {
  file: string;
  make: (input: () => SharpPipeline) => Promise<Buffer>;
}

/** Writes the missing derived files of one image (decoded once). */
async function deriveImage(sharp: Sharp, source: string, targets: DerivedTarget[], result: { written: number; failed: ImageFailure[] }) {
  const missing: DerivedTarget[] = [];
  for (const target of targets) if (!(await exists(target.file))) missing.push(target);
  if (missing.length === 0) return;
  let decoded: { data: Buffer; info: OutputInfo };
  try {
    // Flattened onto white once: every output is opaque (JPEG has no alpha; WebP stays smaller).
    decoded = await sharp(source).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    for (const target of missing) result.failed.push({ file: target.file, error: errorText(err) });
    return;
  }
  const { data, info } = decoded;
  const input = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  for (const target of missing) {
    try {
      await fs.mkdir(path.dirname(target.file), { recursive: true });
      await writeAtomic(target.file, await target.make(input));
      result.written++;
    } catch (err) {
      result.failed.push({ file: target.file, error: errorText(err) });
    }
  }
}

async function writeDerived(sharp: Sharp, job: ImageJob, sheetFiles: string[]): Promise<{ written: number; failed: ImageFailure[] }> {
  const result = { written: 0, failed: [] as ImageFailure[] };
  await removeLeftoverTmpFiles(job.docDir);
  const inline = (png: string): DerivedTarget[] => {
    const file = inlinePathFor(png);
    return file ? [{ file, make: encodeInlineJpeg }] : [];
  };
  for (const slideFile of job.slides) {
    const source = path.join(job.docDir, 'slides', slideFile);
    const targets: DerivedTarget[] = [
      ...VIEW_WIDTHS.map((width) => ({
        file: viewPath(job.docDir, slideFile, width),
        make: (input: () => SharpPipeline) =>
          input().resize({ width, withoutEnlargement: true }).webp({ quality: VIEW_WEBP_QUALITY }).toBuffer(),
      })),
      {
        file: thumbPath(job.docDir, slideFile),
        make: (input) => input().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: THUMB_WEBP_QUALITY }).toBuffer(),
      },
      ...inline(source),
    ];
    await deriveImage(sharp, source, targets, result);
  }
  for (const sheetFile of sheetFiles) {
    const source = path.join(job.docDir, 'sheets', sheetFile);
    await deriveImage(sharp, source, inline(source), result);
  }
  return result;
}

async function runJob(job: ImageJob, send: (message: ChildMessage) => Promise<void>): Promise<void> {
  const sharp = (await import('sharp')).default;
  // Short-lived process: no operation cache (slides may be re-rendered in place), one image at a time.
  sharp.cache(false);
  sharp.concurrency(Math.min(2, os.availableParallelism()));

  let sheetFiles: string[] | null = null;
  if (job.sheets) {
    const entries = await buildContactSheets(sharp, job, job.sheets.aspectRatio);
    await send({ type: 'sheets', entries });
    sheetFiles = entries.map((entry) => entry.file);
  }
  let written = 0;
  let failed: ImageFailure[] = [];
  if (job.derived) {
    ({ written, failed } = await writeDerived(sharp, job, sheetFiles ?? (await readSheetFiles(job.docDir))));
  }
  await send({ type: 'done', written, failed });
}

function isValidJob(value: unknown): value is ImageJob {
  const job = value as Partial<ImageJob> | null;
  return (
    typeof job === 'object' &&
    job !== null &&
    typeof job.docDir === 'string' &&
    path.isAbsolute(job.docDir) &&
    Array.isArray(job.slides) &&
    job.slides.every((name) => typeof name === 'string' && name === path.basename(name) && name.endsWith('.png'))
  );
}

function childMain(): void {
  const send = (message: ChildMessage) =>
    new Promise<void>((resolve, reject) => {
      process.send!(message, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  // The server went away (crash, kill -9): nobody wants the result any more.
  process.on('disconnect', () => process.exit(1));
  process.once('message', (value: unknown) => {
    if (!isValidJob(value)) {
      void send({ type: 'error', message: 'invalid image job' }).finally(() => process.exit(1));
      return;
    }
    runJob(value, send).then(
      () => process.exit(0),
      (err: unknown) => {
        void send({ type: 'error', message: errorText(err) })
          .catch(() => {})
          .finally(() => process.exit(1));
      },
    );
  });
}

if (import.meta.main && typeof process.send === 'function') {
  childMain();
}
