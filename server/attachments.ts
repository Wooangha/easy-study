// Attachments of questions (DESIGN §21): a region of a slide the student selected, or an image they pasted,
// dropped or picked. Created first (the composer shows a thumbnail), then referenced by id when the question is
// sent; the user message stores the resolved Attachment[] (chat.ts).
//
// Storage: library/<docId>/attachments/<id>.jpg|png (the image, made by the image worker: sharp and PDFium never run
// in this process) + <id>.json (the Attachment, written after the image, so metadata always has its image).
//
// A region may be made from a 필기 (DESIGN §25, CreateRegionRequest.annotationId): the item's id, type and text are
// snapshotted into Attachment.annotation when the attachment is made (nothing is written into the annotation store),
// so the tutor gets the note's words and the question markers can link the item to the Q&A.
//
// A new version of the deck (DESIGN §28) moves region attachments to their slide's new number; one whose slide was
// dropped goes to the nearest kept slide with `removedFrom` (remapRegionAttachments). attachments/deck.json {rev} marks
// the deck the slides are numbered in.
//
// Lifetime: an attachment no message refers to is deleted after 24 h (sweepAttachments: at startup and hourly);
// deleting a session deletes the attachments only its messages referred to; deleting a document deletes its
// folder. Attachments of a running turn are pinned (in memory) so neither can take them away under it; the checks
// and the deletions run under a per-document lock.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ANNOTATION_ID_RE, ATTACHMENT_ID_RE, MAX_ANNOTATION_TEXT_CHARS, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../shared/types.ts';
import type { AnnotationItem, Attachment, AttachmentAnnotation, RegionRect, RemovedFrom } from '../shared/types.ts';
import { readSlideAnnotations } from './annotations.ts';
import { ATTACHMENTS_DIR, ATTACHMENT_IMAGE_EXTS } from './assets.ts';
import { HttpError } from './config.ts';
import { smsg } from './i18n.ts';
import { isImageWorkerStopped, runAttachmentWorker } from './imageWorker.ts';
import type { AttachmentJob, AttachmentWorkerResult, AttachmentWorkerRun, UploadImageType } from './imageWorker.ts';
import type { DeckMap } from './internal-types.ts';
import {
  createKeyedQueue,
  createSlots,
  docPaths,
  isDocSwapping,
  isNotFound,
  listStoredDocs,
  notReadyError,
  readJsonFile,
  readStoredDoc,
  rmWithRetry,
  slideFileName,
  withFsRetry,
  writeJsonAtomic,
} from './library.ts';

/** Unreferenced attachments older than this are deleted by the sweep. */
export const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How often the sweep runs while the server is up (it also runs at startup). */
export const ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Image worker processes making attachments at a time (each is short-lived, ~100–200 MB while it runs). */
export const MAX_ATTACHMENT_WORKERS = 2;
/** Longest stored file name of an uploaded image. */
const MAX_NAME_CHARS = 120;
/** A rect coordinate may overshoot 0..1 by this much (floating point of the client), and is then clamped. */
const RECT_EPSILON = 1e-6;

/** Item types a region can be made from (Attachment.annotation.type). */
const ANNOTATION_TYPES: ReadonlySet<string> = new Set<AnnotationItem['type']>(['highlight', 'textHighlight', 'rect', 'ellipse', 'text', 'memo']);
/** The texts of this module's errors, in the request's language (DESIGN §27). */
const texts = () => smsg().library.attachments;
/** Decimals a stored rect keeps (the client sends 4; clamping must not add floating-point noise). */
const RECT_DECIMALS = 1e6;
/** attachments/deck.json {rev}: the deckRev region slides are numbered in (absent = 0; DESIGN §28). */
const DECK_FILE = 'deck.json';
/**
 * Stems of the deck mark and of a remap's journal (deck-r<toRev>.json), and of their temporary files: never
 * attachments, though they fit ATTACHMENT_ID_RE (attachment ids are `att-…`).
 */
const DECK_STEM_RE = /^deck(-r\d+)?$/;

/** 409 while the lecture's deck is being swapped (DESIGN §28). */
function swappingError(): HttpError {
  return new HttpError(409, smsg().library.versions.swapping);
}

/** An attachment with the absolute path of its stored image. */
export interface StoredAttachment {
  attachment: Attachment;
  /** Absolute path of attachments/<id>.jpg|png. */
  path: string;
}

/** Referenced attachment ids of a document (all messages of all its sessions; sessions.ts). */
export type ReferencedIds = (docId: string) => Promise<Set<string>>;

// ---------------------------------------------------------------------------
// Ids and paths
// ---------------------------------------------------------------------------

/** `att-` + 16 random hex. */
export function newAttachmentId(): string {
  return `att-${randomBytes(8).toString('hex')}`;
}

/** Absolute path of library/<docId>/attachments (404 for an invalid document id). */
export function attachmentsDir(docId: string): string {
  return path.join(docPaths(docId).dir, ATTACHMENTS_DIR);
}

/**
 * Makes library/<docId>/attachments when it is missing — never the document folder itself: a document deleted
 * meanwhile stays deleted (404).
 */
async function ensureAttachmentsDir(docId: string): Promise<string> {
  const dir = attachmentsDir(docId);
  try {
    await withFsRetry(() => fs.mkdir(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return dir;
    if (isNotFound(err)) throw new HttpError(404, smsg().common.notFound.doc);
    throw err;
  }
  return dir;
}

function metaFile(docId: string, id: string): string {
  if (!ATTACHMENT_ID_RE.test(id)) throw new HttpError(404, smsg().common.notFound.attachment);
  return path.join(attachmentsDir(docId), `${id}.json`);
}

// ---------------------------------------------------------------------------
// Pins and the per-document lock
// ---------------------------------------------------------------------------

/** `docId/id` → number of running turns using the attachment. */
const pins = new Map<string, number>();
/** Checks-then-deletes and the resolution of a turn's attachments, one at a time per document. */
const lock = createKeyedQueue();

function pinKey(docId: string, id: string): string {
  return `${docId}/${id}`;
}

export function isAttachmentPinned(docId: string, id: string): boolean {
  return (pins.get(pinKey(docId, id)) ?? 0) > 0;
}

/** Pins attachments (a running turn uses them); returns the release (idempotent). */
function pin(docId: string, ids: readonly string[]): () => void {
  for (const id of ids) pins.set(pinKey(docId, id), (pins.get(pinKey(docId, id)) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) {
      const key = pinKey(docId, id);
      const count = (pins.get(key) ?? 0) - 1;
      if (count > 0) pins.set(key, count);
      else pins.delete(key);
    }
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isRect(value: unknown): value is RegionRect {
  const rect = value as Partial<RegionRect> | null;
  if (typeof rect !== 'object' || rect === null) return false;
  return [rect.x, rect.y, rect.w, rect.h].every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Attachment.annotation as stored (id, type and a capped text), or null when it is not well formed. */
function normalizeAnnotation(value: unknown): AttachmentAnnotation | null {
  const raw = value as Partial<AttachmentAnnotation> | null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.id !== 'string' || !ANNOTATION_ID_RE.test(raw.id) || typeof raw.type !== 'string' || !ANNOTATION_TYPES.has(raw.type)) return null;
  const annotation: AttachmentAnnotation = { id: raw.id, type: raw.type };
  if (typeof raw.text === 'string' && raw.text) annotation.text = raw.text.slice(0, MAX_ANNOTATION_TEXT_CHARS);
  return annotation;
}

/** Attachment.removedFrom as stored, or null when it is not well formed. */
function normalizeRemovedFrom(value: unknown): RemovedFrom | null {
  const raw = value as Partial<RemovedFrom> | null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (!Number.isInteger(raw.rev) || (raw.rev as number) < 0 || !Number.isInteger(raw.slide) || (raw.slide as number) < 1) return null;
  return { rev: raw.rev as number, slide: raw.slide as number };
}

/** The stored Attachment, checked (the file name is authoritative for the id); null when missing or malformed. */
function normalizeAttachment(value: unknown, id: string): Attachment | null {
  const raw = value as Partial<Attachment> | null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (raw.kind !== 'region' && raw.kind !== 'image') return null;
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(raw.width) || !Number.isFinite(raw.height)) return null;
  const attachment: Attachment = { id, kind: raw.kind, width: raw.width as number, height: raw.height as number, createdAt: raw.createdAt };
  if (raw.kind === 'region') {
    if (!Number.isInteger(raw.slide) || (raw.slide as number) < 1 || !isRect(raw.rect)) return null;
    attachment.slide = raw.slide;
    attachment.rect = { x: raw.rect.x, y: raw.rect.y, w: raw.rect.w, h: raw.rect.h };
    attachment.text = typeof raw.text === 'string' ? raw.text : '';
    const annotation = normalizeAnnotation(raw.annotation);
    if (annotation) attachment.annotation = annotation;
    const removedFrom = normalizeRemovedFrom(raw.removedFrom);
    if (removedFrom) attachment.removedFrom = removedFrom;
  } else if (typeof raw.name === 'string' && raw.name) {
    attachment.name = raw.name;
  }
  return attachment;
}

/** An attachment of a document, or null when the id is invalid or it does not exist. */
export async function readAttachment(docId: string, id: string): Promise<Attachment | null> {
  if (!ATTACHMENT_ID_RE.test(id) || (await readStoredDoc(docId)) === null) return null;
  return normalizeAttachment(await readJsonFile<unknown>(metaFile(docId, id)), id);
}

/** Absolute path of an attachment's stored image (attachments/<id>.jpg or .png), or null. */
export async function attachmentImagePath(docId: string, id: string): Promise<string | null> {
  if (!ATTACHMENT_ID_RE.test(id)) return null;
  const dir = attachmentsDir(docId);
  for (const ext of ATTACHMENT_IMAGE_EXTS) {
    const file = path.join(dir, `${id}.${ext}`);
    try {
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
      // Not this extension.
    }
  }
  return null;
}

/** An attachment with its image, or null when either is missing. */
export async function readStoredAttachment(docId: string, id: string): Promise<StoredAttachment | null> {
  const attachment = await readAttachment(docId, id);
  if (!attachment) return null;
  const file = await attachmentImagePath(docId, id);
  return file ? { attachment, path: file } : null;
}

/**
 * File names (`<id>.jpg` / `<id>.png`) of attachments' images, for links in the notes. An attachment whose
 * image is missing gets `<id>.jpg`.
 */
export async function attachmentFileNames(docId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of ids) {
    if (names.has(id) || !ATTACHMENT_ID_RE.test(id)) continue;
    const file = await attachmentImagePath(docId, id);
    names.set(id, file ? path.basename(file) : `${id}.jpg`);
  }
  return names;
}

// ---------------------------------------------------------------------------
// A turn's attachments
// ---------------------------------------------------------------------------

export interface HeldAttachments {
  /** In the order of the request. */
  items: StoredAttachment[];
  /** Unpins them (idempotent); call once the turn has ended. */
  release(): void;
}

/**
 * Validates and pins the attachments of a question (SendMessageRequest.attachments): ids of this document that
 * exist (with their image), at most MAX_ATTACHMENTS, duplicates dropped. Throws HttpError 400 otherwise (nothing
 * stays pinned then); ids that do not exist (swept after 24 h unused, deleted, another document's) are listed in
 * the error body as `missingAttachments`, so the client can drop exactly those from the composer. Pinned
 * attachments are neither swept nor deleted until release().
 */
export async function holdAttachments(docId: string, ids: readonly string[]): Promise<HeldAttachments> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_ATTACHMENTS) {
    throw new HttpError(400, texts().tooMany(MAX_ATTACHMENTS));
  }
  for (const id of unique) {
    if (typeof id !== 'string' || !ATTACHMENT_ID_RE.test(id)) throw new HttpError(400, texts().idInvalid(String(id)));
  }
  if (unique.length === 0) return { items: [], release: () => {} };
  return lock(docId, async () => {
    const release = pin(docId, unique);
    try {
      const items: StoredAttachment[] = [];
      const missing: string[] = [];
      for (const id of unique) {
        const stored = await readStoredAttachment(docId, id);
        if (stored) items.push(stored);
        else missing.push(id);
      }
      if (missing.length > 0) {
        throw new HttpError(400, texts().missing(missing.join(', ')), { missingAttachments: missing });
      }
      return { items, release };
    } catch (err) {
      release();
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

const attachmentSlots = createSlots(MAX_ATTACHMENT_WORKERS);
/** Attachment workers running, per document (a deletion or the shutdown stops them). */
const runningJobs = new Map<string, Set<AttachmentWorkerRun>>();

/**
 * Runs an attachment job in the image worker (at most MAX_ATTACHMENT_WORKERS at a time). A failure is logged and
 * answered with `failure` (the worker's message may name files of the server); a stopped worker means the document
 * was deleted (404) or the server is shutting down (503).
 */
async function runJob(docId: string, job: AttachmentJob, failure: string): Promise<AttachmentWorkerResult> {
  const release = await attachmentSlots.acquire();
  if (!release) throw new HttpError(503, smsg().common.http.shuttingDown);
  try {
    // The document may have been deleted while the job waited for a slot.
    if ((await readStoredDoc(docId)) === null) throw new HttpError(404, smsg().common.notFound.doc);
    const run = runAttachmentWorker(job);
    let runs = runningJobs.get(docId);
    if (!runs) runningJobs.set(docId, (runs = new Set()));
    runs.add(run);
    try {
      return await run.done;
    } catch (err) {
      if ((await readStoredDoc(docId)) === null) throw new HttpError(404, smsg().common.notFound.doc);
      // A swap of the deck stops the lecture's jobs (DESIGN §28).
      if (isDocSwapping(docId)) throw swappingError();
      if (isImageWorkerStopped(err)) throw new HttpError(503, smsg().common.http.shuttingDown);
      console.warn(`[attachments] ${docId}: ${job.kind} ${job.id} failed: ${(err as Error).message}`);
      throw new HttpError(500, failure);
    } finally {
      runs.delete(run);
      if (runs.size === 0 && runningJobs.get(docId) === runs) runningJobs.delete(docId);
    }
  } finally {
    release();
  }
}

/**
 * Stops the attachment workers of a document (it is being deleted), or of every document (shutdown: the ones
 * waiting for a slot are turned away as well). Their requests fail; nothing half-written stays.
 */
export function stopAttachmentJobs(docId?: string): void {
  if (docId === undefined) attachmentSlots.cancelWaiting();
  for (const [id, runs] of runningJobs) {
    if (docId === undefined || id === docId) for (const run of runs) run.kill();
  }
}

/** True while an attachment of the document is being made (tests). */
export function hasAttachmentJobs(docId: string): boolean {
  return runningJobs.has(docId);
}

/**
 * Writes <id>.json once the image exists; a document deleted meanwhile is not made again (404, image removed). With
 * `deckRev` (a region): 409 when the deck was swapped meanwhile (or is being swapped), since `slide` is of the old one.
 */
async function saveAttachment(docId: string, attachment: Attachment, deckRev?: number): Promise<Attachment> {
  try {
    const doc = await readStoredDoc(docId);
    if (doc === null) throw new HttpError(404, smsg().common.notFound.doc);
    if (deckRev !== undefined && (isDocSwapping(docId) || (doc.deckRev ?? 0) !== deckRev)) throw swappingError();
    // No mkdir: when the folder went away with its document, this fails instead of making it again.
    await writeJsonAtomic(metaFile(docId, attachment.id), attachment);
    return attachment;
  } catch (err) {
    await removeAttachmentFiles(docId, attachment.id).catch(() => {});
    if (isNotFound(err)) throw new HttpError(404, smsg().common.notFound.doc);
    throw err;
  }
}

/** A CreateRegionRequest, validated against the document (HttpError 400); `annotationId` when the body names a 필기. */
export function parseRegionRequest(body: unknown, pageCount: number): { slide: number; rect: RegionRect; annotationId?: string } {
  const request = (typeof body === 'object' && body !== null ? body : {}) as { slide?: unknown; rect?: unknown; annotationId?: unknown };
  const slide = request.slide;
  if (typeof slide !== 'number' || !Number.isInteger(slide) || slide < 1 || slide > pageCount) {
    throw new HttpError(400, smsg().common.slideOutOfRange(pageCount));
  }
  if (!isRect(request.rect)) throw new HttpError(400, texts().regionInvalid);
  const { x, y, w, h } = request.rect;
  const inside = (value: number) => value >= -RECT_EPSILON && value <= 1 + RECT_EPSILON;
  if (!(w > 0 && h > 0) || !inside(x) || !inside(y) || !inside(x + w) || !inside(y + h)) {
    throw new HttpError(400, texts().regionOutside);
  }
  // Clamped and rounded to 6 decimals (0.1 + 0.62 - 0.1 would be stored as 0.6200000000000001): x + w stays ≤ 1.
  const round = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * RECT_DECIMALS) / RECT_DECIMALS;
  const x0 = round(x);
  const y0 = round(y);
  const rect = { x: x0, y: y0, w: round(round(x + w) - x0), h: round(round(y + h) - y0) };
  if (!(rect.w > 0 && rect.h > 0)) throw new HttpError(400, texts().regionOutside);
  const annotationId = request.annotationId;
  if (annotationId === undefined || annotationId === null) return { slide, rect };
  if (typeof annotationId !== 'string' || !ANNOTATION_ID_RE.test(annotationId)) throw new HttpError(400, texts().annotationNotFound);
  return { slide, rect, annotationId };
}

/**
 * The snapshot of a 필기 a region is made from (DESIGN §25): its id and type, and the memo's / text box's text or
 * the highlighted words when it has any. 400 when the slide has no such item.
 */
async function annotationSnapshot(docId: string, slide: number, annotationId: string): Promise<AttachmentAnnotation> {
  const item = (await readSlideAnnotations(docId, slide)).items.find((candidate) => candidate.id === annotationId);
  if (!item) throw new HttpError(400, texts().annotationNotFound);
  const annotation: AttachmentAnnotation = { id: item.id, type: item.type };
  const text = item.type === 'memo' || item.type === 'text' || item.type === 'textHighlight' ? item.text.trim() : '';
  if (text) annotation.text = text.slice(0, MAX_ANNOTATION_TEXT_CHARS);
  return annotation;
}

/**
 * POST /api/docs/:docId/regions: crops the region (padded) from the full-resolution slide and reads the PDF's
 * text inside it, in the image worker. 404 unknown document, 409 not converted (yet) or its deck being swapped
 * (DESIGN §28), 400 bad slide / rect, or an `annotationId` that names no 필기 of the slide (its snapshot is taken
 * before the image is made).
 */
export async function createRegionAttachment(docId: string, body: unknown, now: Date = new Date()): Promise<Attachment> {
  if (isDocSwapping(docId)) throw swappingError();
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  if (doc.status !== 'ready') throw notReadyError(doc);
  const { slide, rect, annotationId } = parseRegionRequest(body, doc.pageCount);
  const annotation = annotationId ? await annotationSnapshot(docId, slide, annotationId) : null;
  await ensureAttachmentsDir(docId);
  const id = newAttachmentId();
  const job: AttachmentJob = { kind: 'region', docDir: docPaths(docId).dir, id, slide, slideFile: slideFileName(slide, doc.pageCount), rect };
  const failure = texts().cropFailed(slide);
  const result = await runJob(docId, job, failure);
  if (!result.ok) throw new HttpError(500, failure);
  return saveAttachment(
    docId,
    {
      id,
      kind: 'region',
      slide,
      rect,
      width: result.width,
      height: result.height,
      text: result.text ?? '',
      ...(annotation ? { annotation } : {}),
      createdAt: now.toISOString(),
    },
    doc.deckRev ?? 0,
  );
}

export type { UploadImageType } from './imageWorker.ts';

const HEIF_BRANDS: ReadonlySet<string> = new Set([
  ...['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'], // HEIC / HEIF
  ...['avif', 'avis'], // AVIF
]);

/** The image type of `bytes` by its magic number, or null (the Content-Type header is not trusted). */
export function sniffImageType(bytes: Buffer): UploadImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const ascii = (from: number, to: number) => (bytes.length >= to ? bytes.toString('latin1', from, to) : '');
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(8, 12))) return 'heif';
  return null;
}

/** The original file name of an upload as stored: its last path segment, one line, at most 120 characters. */
export function cleanAttachmentName(name: string | undefined | null): string | undefined {
  if (typeof name !== 'string') return undefined;
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > MAX_NAME_CHARS ? `${clean.slice(0, MAX_NAME_CHARS).trimEnd()}…` : clean;
}

/**
 * POST /api/docs/:docId/attachments: an uploaded image, checked by its first bytes (PNG, JPEG, WebP, GIF; HEIC/AVIF
 * when sharp can decode them here), re-encoded by the image worker. 404 unknown document, 413 too large, 415 not a
 * supported image, 400 empty or unreadable.
 */
export async function createImageAttachment(docId: string, bytes: Buffer, fileName?: string, now: Date = new Date()): Promise<Attachment> {
  if ((await readStoredDoc(docId)) === null) throw new HttpError(404, smsg().common.notFound.doc);
  if (bytes.length === 0) throw new HttpError(400, texts().imageEmpty);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw tooLarge();
  const type = sniffImageType(bytes);
  if (!type) throw new HttpError(415, texts().unsupportedImage);
  const dir = await ensureAttachmentsDir(docId);
  const id = newAttachmentId();
  // The worker reads the upload from a file (not through the IPC channel); the sweep removes it if we crash.
  const input = path.join(dir, `${id}.upload`);
  let result: AttachmentWorkerResult;
  try {
    try {
      await fs.writeFile(input, bytes);
    } catch (err) {
      if (isNotFound(err)) throw new HttpError(404, smsg().common.notFound.doc);
      throw err;
    }
    result = await runJob(docId, { kind: 'upload', docDir: docPaths(docId).dir, id, input, type }, texts().imageFailed);
  } finally {
    await rmWithRetry(input, { force: true }).catch(() => {});
  }
  if (!result.ok) {
    // A resolution the worker refuses (imageWorker.ts uploadRefusal) is not a damaged file.
    if (result.reason === 'too-large') throw new HttpError(413, texts().imageTooManyPixels);
    if (type === 'heif') throw new HttpError(415, texts().heifUnsupported);
    if (result.reason === 'unsupported') throw new HttpError(415, texts().unsupportedImage);
    throw new HttpError(400, texts().imageUnreadable);
  }
  const name = cleanAttachmentName(fileName);
  return saveAttachment(docId, {
    id,
    kind: 'image',
    ...(name ? { name } : {}),
    width: result.width,
    height: result.height,
    createdAt: now.toISOString(),
  });
}

/** HttpError 413 for an image over MAX_ATTACHMENT_BYTES. */
export function tooLarge(): HttpError {
  return new HttpError(413, texts().imageTooLarge(Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))));
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

/** Removes every file of an attachment: the metadata first (it is gone at once), then the image and leftovers. */
async function removeAttachmentFiles(docId: string, id: string): Promise<void> {
  if (!ATTACHMENT_ID_RE.test(id)) return;
  const dir = attachmentsDir(docId);
  await rmWithRetry(path.join(dir, `${id}.json`), { force: true });
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  for (const name of names) if (name.split('.')[0] === id) await rmWithRetry(path.join(dir, name), { force: true });
}

/**
 * DELETE /api/docs/:docId/attachments/:id (the student removed a chip): 404 unknown, 409 once a message refers to
 * it (or a running turn uses it).
 */
export async function deleteAttachment(docId: string, id: string, referenced: ReferencedIds): Promise<void> {
  if ((await readAttachment(docId, id)) === null) throw new HttpError(404, smsg().common.notFound.attachment);
  await lock(docId, async () => {
    if ((await readAttachment(docId, id)) === null) throw new HttpError(404, smsg().common.notFound.attachment);
    if (isAttachmentPinned(docId, id) || (await referenced(docId)).has(id)) throw new HttpError(409, texts().inUse);
    await removeAttachmentFiles(docId, id);
  });
}

/**
 * Deletes those of `ids` that no message refers to any more (a session was deleted) and no running turn uses.
 * Returns how many were deleted.
 */
export async function removeUnreferencedAttachments(docId: string, ids: Iterable<string>, referenced: ReferencedIds): Promise<number> {
  const candidates = [...new Set(ids)].filter((id) => typeof id === 'string' && ATTACHMENT_ID_RE.test(id));
  if (candidates.length === 0 || (await readStoredDoc(docId)) === null) return 0;
  return lock(docId, async () => {
    const refs = await referenced(docId);
    let removed = 0;
    for (const id of candidates) {
      if (refs.has(id) || isAttachmentPinned(docId, id)) continue;
      await removeAttachmentFiles(docId, id);
      removed++;
    }
    return removed;
  });
}

export interface SweepOptions {
  /** Current time (ms), for tests. */
  now?: number;
  /** Age after which an unreferenced attachment is deleted (default 24 h). */
  maxAgeMs?: number;
}

/**
 * Deletes the attachments no message refers to that are older than 24 h (their createdAt; for files without
 * metadata — an interrupted upload, a crash between image and metadata — their newest modification time), in every
 * document. Pinned attachments (a running turn) stay. Returns how many attachments were deleted.
 */
export async function sweepAttachments(referenced: ReferencedIds, options: SweepOptions = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? ATTACHMENT_MAX_AGE_MS;
  let removed = 0;
  for (const doc of await listStoredDocs()) {
    const dir = attachmentsDir(doc.id);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    // An attachment is as old as its metadata says; files without metadata as old as the newest of them.
    const created = new Map<string, number>();
    const modified = new Map<string, number>();
    for (const name of names) {
      const id = name.split('.')[0];
      if (!ATTACHMENT_ID_RE.test(id) || DECK_STEM_RE.test(id)) continue;
      if (name === `${id}.json`) {
        const time = Date.parse((await readAttachment(doc.id, id))?.createdAt ?? '');
        if (Number.isFinite(time)) created.set(id, time);
      }
      try {
        const time = (await fs.stat(path.join(dir, name))).mtimeMs;
        modified.set(id, Math.max(modified.get(id) ?? -Infinity, time));
      } catch {
        // Removed meanwhile.
      }
    }
    const expired = [...new Set([...created.keys(), ...modified.keys()])].filter((id) => {
      const time = created.get(id) ?? modified.get(id);
      return time !== undefined && now - time > maxAge;
    });
    if (expired.length === 0) continue;
    removed += await lock(doc.id, async () => {
      if ((await readStoredDoc(doc.id)) === null) return 0; // deleted meanwhile
      const refs = await referenced(doc.id);
      let count = 0;
      for (const id of expired) {
        if (refs.has(id) || isAttachmentPinned(doc.id, id)) continue;
        await removeAttachmentFiles(doc.id, id);
        count++;
      }
      return count;
    });
  }
  return removed;
}

export interface AttachmentSweeper {
  /** Stops the hourly sweep and waits for a running one. */
  stop(): Promise<void>;
}

/** Sweeps now (in the background) and every ATTACHMENT_SWEEP_INTERVAL_MS until stop(). */
export function startAttachmentSweeper(referenced: ReferencedIds, intervalMs: number = ATTACHMENT_SWEEP_INTERVAL_MS, log = true): AttachmentSweeper {
  let stopped = false;
  const sweep = async () => {
    if (stopped) return;
    try {
      const removed = await sweepAttachments(referenced);
      if (log && removed > 0) console.log(`[attachments] removed ${removed} unused attachment(s) older than 24 h`);
    } catch (err) {
      console.warn(`[attachments] sweep failed: ${(err as Error).message}`);
    }
  };
  let current = sweep();
  const timer = setInterval(() => {
    current = current.then(sweep);
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}

// ---------------------------------------------------------------------------
// A new version of the deck (DESIGN §28)
// ---------------------------------------------------------------------------

/** The journal of a remap (attachments/deck-r<toRev>.json): the region attachments as they will be, written first. */
interface AttachmentsJournal {
  version: 1;
  toRev: number;
  attachments: Attachment[];
}

/** The old slide's number in the new deck, or null when the new deck dropped it. */
function newSlideOf(map: DeckMap, old: number): number | null {
  if (!Number.isInteger(old) || old < 1 || old > map.oldPageCount) return null;
  const next = map.oldToNew[old - 1];
  return typeof next === 'number' ? next : null;
}

/** Where a dropped slide's region goes: the closest preceding old slide that was kept, else the closest following, else 1. */
function nearestKeptSlide(map: DeckMap, old: number): number {
  for (let slide = Math.min(old, map.oldPageCount + 1) - 1; slide >= 1; slide--) {
    const next = newSlideOf(map, slide);
    if (next !== null) return next;
  }
  for (let slide = old + 1; slide <= map.oldPageCount; slide++) {
    const next = newSlideOf(map, slide);
    if (next !== null) return next;
  }
  return 1;
}

/** A region attachment in the new deck, or null when it does not change. */
function remapRegion(attachment: Attachment, map: DeckMap): Attachment | null {
  if (attachment.kind !== 'region' || attachment.slide === undefined) return null;
  const { removedFrom, ...rest } = attachment;
  // Undo: what the apply from restoreRev moved off its dropped slide goes back there.
  if (map.restoreRev !== undefined && removedFrom?.rev === map.restoreRev && removedFrom.slide <= map.newPageCount) {
    return { ...rest, slide: removedFrom.slide };
  }
  const next = newSlideOf(map, attachment.slide);
  if (next !== null) return next === attachment.slide ? null : { ...attachment, slide: next };
  return { ...attachment, slide: nearestKeptSlide(map, attachment.slide), removedFrom: { rev: map.fromRev, slide: attachment.slide } };
}

function isAttachmentsJournal(value: unknown, toRev: number): value is AttachmentsJournal {
  const raw = value as Partial<AttachmentsJournal> | null;
  return typeof raw === 'object' && raw !== null && raw.version === 1 && raw.toRev === toRev && Array.isArray(raw.attachments);
}

/**
 * Region attachments follow their slide (DESIGN §28 Remaps › Attachments): `slide` remapped; a dropped slide → the
 * nearest kept slide and `removedFrom` {fromRev, old slide}; on an undo, `removedFrom.rev === restoreRev` → back to
 * removedFrom.slide, the flag removed. Under the attachments lock; idempotent (attachments/deck.json {rev}) and
 * resumable (the journal). The old numbering is map.oldPageCount (doc.json has the new deck by now).
 */
export async function remapRegionAttachments(docId: string, map: DeckMap): Promise<void> {
  await lock(docId, async () => {
    const dir = attachmentsDir(docId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isNotFound(err)) return; // no attachments at all
      throw err;
    }
    const journalFile = path.join(dir, `deck-r${map.toRev}.json`);
    const mark = await readJsonFile<{ rev?: unknown }>(path.join(dir, DECK_FILE));
    if (typeof mark?.rev === 'number' && mark.rev >= map.toRev) {
      await rmWithRetry(journalFile, { force: true });
      return;
    }
    const pending = await readJsonFile<unknown>(journalFile);
    let changed: Attachment[];
    if (isAttachmentsJournal(pending, map.toRev)) {
      changed = pending.attachments.flatMap((entry) => {
        const attachment = typeof entry?.id === 'string' && ATTACHMENT_ID_RE.test(entry.id) ? normalizeAttachment(entry, entry.id) : null;
        return attachment ? [attachment] : [];
      });
    } else {
      changed = [];
      for (const name of names) {
        const id = name.slice(0, -'.json'.length);
        if (!name.endsWith('.json') || !ATTACHMENT_ID_RE.test(id) || DECK_STEM_RE.test(id)) continue;
        const attachment = normalizeAttachment(await readJsonFile<unknown>(path.join(dir, name)), id);
        const next = attachment ? remapRegion(attachment, map) : null;
        if (next) changed.push(next);
      }
      if (changed.length > 0) await writeJsonAtomic(journalFile, { version: 1, toRev: map.toRev, attachments: changed } satisfies AttachmentsJournal);
    }
    for (const attachment of changed) {
      // Deleted meanwhile (a crash, then the sweep): its metadata is not made again.
      if ((await readJsonFile<unknown>(metaFile(docId, attachment.id))) !== null) await writeJsonAtomic(metaFile(docId, attachment.id), attachment);
    }
    await writeJsonAtomic(path.join(dir, DECK_FILE), { rev: map.toRev });
    await rmWithRetry(journalFile, { force: true });
  });
}
