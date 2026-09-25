// Image worker (DESIGN §15): every sharp/libvips job runs in a short-lived child process, so the
// long-lived server never keeps libvips' memory (and the malloc fragmentation it leaves behind). The PDF
// engine runs here too (DESIGN §3, §17): PDFium-wasm (server/pdf.ts) is only ever instantiated in a worker,
// and its WebAssembly memory goes away with the process.
//
// A run works on one document directory and is one of three jobs:
//   - PdfJob (ingest, runPdfWorker): source.pdf → slides/NNN.png + text/NNN.txt + text/.engine, reporting the
//     page count first and then every slide written (§3 steps 1-3);
//   - TextJob (backfill, runTextWorker): source.pdf → text/NNN.txt + text/.engine only, for documents whose
//     text an older engine wrote (poppler's pdftotext, an earlier PDFium extraction); the slides are not touched (§17);
//   - ImageJob (runImageWorker):
//       1. optionally (ingest) the overview contact sheets: sheets/sheet-NN.png + sheets/sheets.json (§3 step 4),
//       2. optionally the derived files of server/assets.ts that are still missing: view renditions (lossy
//          WebP), thumbnails (WebP) and inline JPEGs for every slide, and inline JPEGs for every contact sheet.
//
// Parent side: run*Worker() forks this very file with process.execPath (server/imageWorker.ts in development
// and tests, dist-server/server/imageWorker.js in the production build) and talks to it over the IPC channel.
// Child side: the bottom of this file, run only when it is the entry module. sharp and PDFium are imported
// there, dynamically, so importing this module from the server never loads either.
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
import { childProcessEnv } from './config.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE, slideFileName, textFileName } from './pageNames.ts';
import type { PdfDocument, PdfPage } from './pdf.ts';

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

/** Job of runPdfWorker(): library/<docId>/source.pdf → slides/NNN.png + text/NNN.txt (DESIGN §3 steps 1-3). */
export interface PdfJob {
  kind: 'pdf';
  /** Absolute path of library/<docId> (source.pdf in, slides/ and text/ out). */
  docDir: string;
  /** Long edge of the slide PNGs in pixels. */
  longEdge: number;
}

/** Job of runTextWorker(): library/<docId>/source.pdf → text/NNN.txt + text/.engine (DESIGN §17). */
export interface TextJob {
  kind: 'text';
  /** Absolute path of library/<docId>. */
  docDir: string;
  /** Page count of doc.json: the text files are named (padded) for it, and pages past it are ignored. */
  pageCount: number;
}

export interface PdfInfo {
  pageCount: number;
  /** Width / height of page 1 in points, /Rotate applied. */
  aspectRatio: number;
}

export interface PdfWorkerHandlers {
  /** Page count and aspect ratio, as soon as the PDF is open (before any page is rendered). */
  onInfo?(info: PdfInfo): void;
  /** Number of slide PNGs written so far (1, 2, …, pageCount). */
  onProgress?(rendered: number): void;
  /** Something the user should know about the slides (at most once per run), e.g. CJK text not drawn for want of a font. */
  onWarning?(message: string): void;
}

export interface PdfWorkerRun {
  /** Resolves when every slide and text file is written; rejects when the PDF cannot be read, or on kill(). */
  readonly done: Promise<PdfInfo>;
  kill(): void;
}

export interface TextWorkerRun {
  /** Resolves with the number of text files written; rejects when the PDF cannot be read, or on kill(). */
  readonly done: Promise<{ written: number }>;
  kill(): void;
}

type ChildMessage =
  | { type: 'info'; pageCount: number; aspectRatio: number }
  | { type: 'progress'; rendered: number }
  | { type: 'warning'; message: string }
  | { type: 'sheets'; entries: SheetEntry[] }
  | { type: 'done'; written: number; failed: ImageFailure[] }
  | { type: 'error'; message: string };

type DoneMessage = Extract<ChildMessage, { type: 'done' }>;

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
 * The server's environment without its secrets (config.ts childProcessEnv); on macOS plus
 * MallocSpaceEfficient=1, which made libmalloc hand freed libvips buffers back sooner: the worker's peak
 * RSS for a 49-slide deck went from ~275 to ~225 MB (same run time). Other platforms ignore it.
 */
export function workerEnv(): NodeJS.ProcessEnv {
  const env = childProcessEnv();
  return process.platform === 'darwin' ? { ...env, MallocSpaceEfficient: '1' } : env;
}

interface WorkerProcess {
  /** The final 'done' message; rejects when the worker failed, crashed or was killed. */
  readonly done: Promise<DoneMessage>;
  kill(): void;
}

/**
 * Forks a worker for `job`. Messages other than the final one go to `onMessage` as they arrive; `label`
 * names the worker in error messages ("image worker", "PDF worker").
 */
function forkWorker(job: ImageJob | PdfJob | TextJob, label: string, options: ImageWorkerOptions, onMessage: (message: ChildMessage) => void): WorkerProcess {
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

  const done = new Promise<DoneMessage>((resolve, reject) => {
    let stderr = '';
    let final: ChildMessage | null = null;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('message', (raw: unknown) => {
      const message = raw as ChildMessage | null;
      if (message?.type === 'done' || message?.type === 'error') final = message;
      else if (message && !killed && !settled) onMessage(message);
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
        if (err) fail(killed ? stoppedError() : new Error(`${label} could not be started: ${err.message}`));
      });
    });
    child.on('error', (err) => fail(killed ? stoppedError() : new Error(`${label} could not run: ${err.message}`)));
    // 'close', not 'exit': it comes after the IPC channel is drained, so the final message has arrived.
    child.once('close', (code, signal) => {
      if (settled) return;
      const outcome = final as ChildMessage | null;
      if (outcome?.type === 'done' && code === 0) {
        settled = true;
        resolve(outcome);
        return;
      }
      // After kill() the run is a stop, whatever the child managed to report before it died.
      if (killed) return fail(stoppedError());
      if (outcome?.type === 'error') return fail(new Error(outcome.message));
      const detail = stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
      fail(new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`));
    });
  });
  return { done, kill };
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

  let sheetEntries: SheetEntry[] | null = null;
  const worker = forkWorker(job, 'image worker', options, (message) => {
    if (message.type === 'sheets') {
      sheetEntries = message.entries;
      resolveSheets(message.entries);
    }
  });
  const done = worker.done.then(
    (outcome): ImageWorkerResult => {
      if (job.sheets && !sheetEntries) rejectSheets(new Error('image worker finished without the contact sheets'));
      return { sheets: sheetEntries, written: outcome.written, failed: outcome.failed };
    },
    (err: Error) => {
      rejectSheets(err);
      throw err;
    },
  );
  return { done, sheets, kill: worker.kill };
}

/**
 * Renders a document's PDF in a new worker process (DESIGN §3 steps 1-3): `onInfo` once the PDF is open,
 * then `onProgress` after every slide written. Same process model and kill semantics as runImageWorker.
 */
export function runPdfWorker(job: PdfJob, handlers: PdfWorkerHandlers = {}, options: ImageWorkerOptions = {}): PdfWorkerRun {
  let info: PdfInfo | null = null;
  const worker = forkWorker(job, 'PDF worker', options, (message) => {
    if (message.type === 'info') {
      info = { pageCount: message.pageCount, aspectRatio: message.aspectRatio };
      handlers.onInfo?.(info);
    } else if (message.type === 'progress') {
      handlers.onProgress?.(message.rendered);
    } else if (message.type === 'warning') {
      handlers.onWarning?.(message.message);
    }
  });
  const done = worker.done.then((): PdfInfo => {
    if (!info) throw new Error('PDF worker finished without the page count');
    return info;
  });
  return { done, kill: worker.kill };
}

/** Extracts a document's text again in a new worker process (DESIGN §17): text/NNN.txt + text/.engine only. */
export function runTextWorker(job: TextJob, options: ImageWorkerOptions = {}): TextWorkerRun {
  const worker = forkWorker(job, 'PDF worker', options, () => {});
  return { done: worker.done.then((outcome) => ({ written: outcome.written })), kill: worker.kill };
}

// ---------------------------------------------------------------------------
// Child side
// ---------------------------------------------------------------------------

type Sharp = typeof sharpModule;

const SLIDES_PER_SHEET = 4;
const SHEET_CELL_WIDTH = 800;
const SHEET_GUTTER = 8;
const SHEET_MAX_EDGE = 1600;
/**
 * Cell shapes of a contact sheet are kept between 1:4 and 4:1; more extreme slides (a 3 x 14400 pt strip renders
 * as a 1 x 1600 PNG) are letterboxed in such a cell. Unclamped, a 1:1600 slide asked for a 1616 x 2.6M px canvas
 * and the ingest failed with sharp's "Input image exceeds pixel limit".
 */
const SHEET_CELL_MIN_RATIO = 1 / 4;
const SHEET_CELL_MAX_RATIO = 4;
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

/** Removes `*.tmp` files a killed worker may have left in the derived-file directories (or in `subs`). */
async function removeLeftoverTmpFiles(docDir: string, subs: readonly string[] = ['view', 'thumbs', 'inline']): Promise<void> {
  for (const sub of subs) {
    const dir = path.join(docDir, sub);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (name.endsWith('.tmp')) await fs.rm(path.join(dir, name), { force: true });
  }
}

/**
 * Glyphs of the "Slide N" badge, drawn as strokes (SVG paths) rather than text: SVG <text> is set with whatever
 * fonts the system has (fontconfig), and a system without any (a slim Docker image, a minimal Linux) drew every
 * character as a box, so the model could not read the slide numbers on the contact sheets. Units: 1000 per em,
 * y downwards, baseline at 0, cap height 700; each path is the centre line of a 120-unit stroke with round ends.
 */
const LABEL_STROKE = 120;
const LABEL_GLYPHS: Readonly<Record<string, { advance: number; d: string }>> = {
  S: { advance: 600, d: 'M455,-548 C420,-610 355,-640 280,-640 C180,-640 110,-590 110,-512 C110,-432 180,-400 280,-374 C390,-345 470,-300 470,-205 C470,-115 390,-60 280,-60 C190,-60 115,-95 80,-160' },
  l: { advance: 260, d: 'M130,-700 L130,-60' },
  i: { advance: 260, d: 'M130,-460 L130,-60 M130,-676 L130,-674' },
  d: { advance: 590, d: 'M460,-700 L460,-60 M460,-260 C460,-385 395,-460 290,-460 C185,-460 110,-380 110,-260 C110,-140 185,-60 290,-60 C395,-60 460,-135 460,-260' },
  e: { advance: 570, d: 'M105,-265 L455,-265 C455,-390 385,-460 285,-460 C180,-460 105,-380 105,-260 C105,-135 180,-60 290,-60 C360,-60 410,-85 445,-135' },
  ' ': { advance: 260, d: '' },
  '0': { advance: 580, d: 'M290,-640 C400,-640 470,-520 470,-350 C470,-180 400,-60 290,-60 C180,-60 110,-180 110,-350 C110,-520 180,-640 290,-640 Z' },
  '1': { advance: 580, d: 'M150,-520 L330,-640 L330,-60' },
  '2': { advance: 580, d: 'M115,-510 C125,-595 195,-640 285,-640 C390,-640 460,-580 460,-495 C460,-415 410,-365 330,-300 L110,-60 L480,-60' },
  '3': { advance: 580, d: 'M115,-555 C150,-610 210,-640 285,-640 C385,-640 450,-585 450,-505 C450,-420 380,-365 265,-365 C390,-365 465,-300 465,-210 C465,-115 385,-60 280,-60 C195,-60 130,-95 100,-150' },
  '4': { advance: 580, d: 'M390,-60 L390,-640 L90,-215 L500,-215' },
  '5': { advance: 580, d: 'M445,-640 L150,-640 L125,-375 C170,-405 225,-418 285,-418 C395,-418 470,-340 470,-240 C470,-130 390,-60 280,-60 C195,-60 130,-92 100,-145' },
  '6': { advance: 580, d: 'M435,-610 C395,-632 350,-640 305,-640 C180,-640 110,-520 110,-340 C110,-160 180,-60 295,-60 C400,-60 470,-135 470,-235 C470,-335 400,-405 300,-405 C210,-405 135,-345 112,-260' },
  '7': { advance: 580, d: 'M100,-640 L475,-640 L230,-60' },
  '8': { advance: 580, d: 'M290,-365 C195,-365 135,-420 135,-500 C135,-585 200,-640 290,-640 C380,-640 445,-585 445,-500 C445,-420 385,-365 290,-365 C180,-365 110,-300 110,-210 C110,-120 185,-60 290,-60 C395,-60 470,-120 470,-210 C470,-300 400,-365 290,-365 Z' },
  '9': { advance: 580, d: 'M145,-90 C185,-68 230,-60 275,-60 C400,-60 470,-180 470,-360 C470,-540 400,-640 285,-640 C180,-640 110,-565 110,-465 C110,-365 180,-295 280,-295 C370,-295 445,-355 468,-440' },
};

/** SVG badge "Slide N" (dark, white bold strokes; no font needed) for the label band above a sheet cell. */
export function slideLabel(slide: number, fontSize: number): { svg: Buffer; height: number } {
  const glyphs = [...`Slide ${slide}`].map((char) => LABEL_GLYPHS[char]);
  const scale = fontSize / 1000;
  const textWidth = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) * scale;
  const padX = Math.round(fontSize * 0.45);
  const padY = Math.round(fontSize * 0.2);
  const width = Math.round(textWidth + padX * 2);
  const height = Math.round(fontSize * 1.2 + padY * 2);
  const baseline = height / 2 + fontSize * 0.35;
  let x = (width - textWidth) / 2;
  const paths: string[] = [];
  for (const glyph of glyphs) {
    if (glyph.d) paths.push(`<path transform="translate(${x.toFixed(2)} ${baseline.toFixed(2)}) scale(${scale})" d="${glyph.d}"/>`);
    x += glyph.advance * scale;
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="0" y="0" width="${width}" height="${height}" rx="${Math.round(fontSize * 0.3)}" fill="#111827"/>` +
      `<g fill="none" stroke="#ffffff" stroke-width="${LABEL_STROKE}" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g>` +
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
  const cellRatio = Math.min(SHEET_CELL_MAX_RATIO, Math.max(SHEET_CELL_MIN_RATIO, aspectRatio > 0 ? aspectRatio : 4 / 3));
  const imageHeight = Math.max(1, Math.round(cellWidth / cellRatio));
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

/** Page text for text/NNN.txt ('' when the page has none or it cannot be read: the image is what matters). */
function pageText(page: PdfPage, clean: (text: string) => string): string {
  try {
    return clean(page.text());
  } catch {
    return '';
  }
}

/** text/.engine, written after every text file: the text of this document comes from the current engine. */
async function writeTextEngineMarker(textDir: string): Promise<void> {
  await writeAtomic(path.join(textDir, TEXT_ENGINE_FILE), `${TEXT_ENGINE}\n`);
}

/**
 * source.pdf → slides/NNN.png (long edge job.longEdge, RGB PNG) + text/NNN.txt (trimmed; '' without text),
 * then text/.engine. The PNG of page n is encoded (sharp, libuv pool) while page n+1 is rasterized (PDFium,
 * main thread); 'progress' is sent once a PNG is on disk.
 */
async function runPdfJob(job: PdfJob, send: (message: ChildMessage) => Promise<void>): Promise<void> {
  const [{ openPdf, cleanPageText, fallbackFontWarning }, sharp] = await Promise.all([import('./pdf.ts'), import('sharp').then((mod) => mod.default)]);
  sharp.cache(false);
  sharp.concurrency(Math.min(2, os.availableParallelism()));
  const slidesDir = path.join(job.docDir, 'slides');
  const textDir = path.join(job.docDir, 'text');
  await fs.mkdir(slidesDir, { recursive: true });
  await fs.mkdir(textDir, { recursive: true });

  const doc: PdfDocument = await openPdf(path.join(job.docDir, 'source.pdf'));
  let encoding: Promise<void> = Promise.resolve();
  let warned = false;
  try {
    const pageCount = doc.pageCount;
    if (pageCount < 1) throw new Error('the PDF has no pages');
    const first = doc.withPage(1, (page) => ({ width: page.width, height: page.height }));
    await send({ type: 'info', pageCount, aspectRatio: first.width > 0 && first.height > 0 ? first.width / first.height : 4 / 3 });
    for (let n = 1; n <= pageCount; n++) {
      const { rendered, text } = doc.withPage(n, (page) => ({ rendered: page.render(job.longEdge), text: pageText(page, cleanPageText) }));
      const warning = warned ? null : fallbackFontWarning();
      if (warning) {
        warned = true;
        await send({ type: 'warning', message: warning });
      }
      await encoding;
      const file = path.join(slidesDir, slideFileName(n, pageCount));
      encoding = sharp(rendered.data, { raw: { width: rendered.width, height: rendered.height, channels: 4 } })
        .removeAlpha()
        .png()
        .toBuffer()
        .then((png) => writeAtomic(file, png))
        .then(() => send({ type: 'progress', rendered: n }));
      // Awaited before the next page (or below); a failure while this page's text is written is not "unhandled".
      encoding.catch(() => {});
      await writeAtomic(path.join(textDir, textFileName(n, pageCount)), text);
    }
    await encoding;
    await writeTextEngineMarker(textDir);
    await send({ type: 'done', written: pageCount, failed: [] });
  } finally {
    await encoding.catch(() => {});
    doc.close();
  }
}

/**
 * source.pdf → text/NNN.txt for pages 1..job.pageCount, then text/.engine (DESIGN §17). Pages the PDF does not
 * have (a page count that differs from the earlier engine's) keep their file.
 */
async function runTextJob(job: TextJob, send: (message: ChildMessage) => Promise<void>): Promise<void> {
  const { openPdf, cleanPageText } = await import('./pdf.ts');
  const textDir = path.join(job.docDir, 'text');
  await fs.mkdir(textDir, { recursive: true });
  await removeLeftoverTmpFiles(job.docDir, ['text']); // of an earlier text job that was stopped
  const doc = await openPdf(path.join(job.docDir, 'source.pdf'));
  try {
    const pages = Math.min(doc.pageCount, job.pageCount);
    for (let n = 1; n <= pages; n++) {
      const text = doc.withPage(n, (page) => pageText(page, cleanPageText));
      await writeAtomic(path.join(textDir, textFileName(n, job.pageCount)), text);
    }
    await writeTextEngineMarker(textDir);
    await send({ type: 'done', written: pages, failed: [] });
  } finally {
    doc.close();
  }
}

function isValidPdfJob(value: unknown): value is PdfJob {
  const job = value as Partial<PdfJob> | null;
  return (
    typeof job === 'object' &&
    job !== null &&
    job.kind === 'pdf' &&
    typeof job.docDir === 'string' &&
    path.isAbsolute(job.docDir) &&
    Number.isInteger(job.longEdge) &&
    (job.longEdge ?? 0) >= 16 &&
    (job.longEdge ?? 0) <= 10_000
  );
}

function isValidTextJob(value: unknown): value is TextJob {
  const job = value as Partial<TextJob> | null;
  return (
    typeof job === 'object' &&
    job !== null &&
    job.kind === 'text' &&
    typeof job.docDir === 'string' &&
    path.isAbsolute(job.docDir) &&
    Number.isInteger(job.pageCount) &&
    (job.pageCount ?? 0) >= 1
  );
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
    const run = isValidPdfJob(value)
      ? () => runPdfJob(value, send)
      : isValidTextJob(value)
        ? () => runTextJob(value, send)
        : isValidJob(value)
          ? () => runJob(value, send)
          : null;
    if (!run) {
      void send({ type: 'error', message: 'invalid worker job' }).finally(() => process.exit(1));
      return;
    }
    run().then(
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
