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
// Lifetime: an attachment no message refers to is deleted after 24 h (sweepAttachments: at startup and hourly);
// deleting a session deletes the attachments only its messages referred to; deleting a document deletes its
// folder. Attachments of a running turn are pinned (in memory) so neither can take them away under it; the checks
// and the deletions run under a per-document lock.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ANNOTATION_ID_RE, ATTACHMENT_ID_RE, MAX_ANNOTATION_TEXT_CHARS, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../shared/types.ts';
import type { AnnotationItem, Attachment, AttachmentAnnotation, RegionRect } from '../shared/types.ts';
import { readSlideAnnotations } from './annotations.ts';
import { ATTACHMENTS_DIR, ATTACHMENT_IMAGE_EXTS } from './assets.ts';
import { HttpError } from './config.ts';
import { isImageWorkerStopped, runAttachmentWorker } from './imageWorker.ts';
import type { AttachmentJob, AttachmentWorkerResult, AttachmentWorkerRun, UploadImageType } from './imageWorker.ts';
import {
  createKeyedQueue,
  createSlots,
  docPaths,
  isNotFound,
  listStoredDocs,
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

const NOT_FOUND = '첨부를 찾을 수 없습니다';
/** 400 of POST …/regions when `annotationId` names no item of that slide (DESIGN §25). */
export const ANNOTATION_NOT_FOUND = '그 필기를 찾을 수 없습니다';
const SHUTTING_DOWN = '서버를 종료하는 중입니다';
/** Item types a region can be made from (Attachment.annotation.type). */
const ANNOTATION_TYPES: ReadonlySet<string> = new Set<AnnotationItem['type']>(['highlight', 'textHighlight', 'rect', 'ellipse', 'text', 'memo']);
const UNSUPPORTED_IMAGE = '지원하지 않는 이미지 형식입니다 (PNG, JPEG, WebP, GIF만 올릴 수 있습니다)';
/** 413 for an image whose resolution the worker refuses (imageWorker.ts uploadRefusal): not a damaged file. */
export const IMAGE_TOO_LARGE_PIXELS = '이미지 해상도가 너무 커서 처리할 수 없습니다. 스크린샷이나 더 작은 이미지로 올려 주세요';
/** Decimals a stored rect keeps (the client sends 4; clamping must not add floating-point noise). */
const RECT_DECIMALS = 1e6;

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
    if (isNotFound(err)) throw new HttpError(404, '문서를 찾을 수 없습니다');
    throw err;
  }
  return dir;
}

function metaFile(docId: string, id: string): string {
  if (!ATTACHMENT_ID_RE.test(id)) throw new HttpError(404, NOT_FOUND);
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
    throw new HttpError(400, `첨부는 질문 하나에 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다`);
  }
  for (const id of unique) {
    if (typeof id !== 'string' || !ATTACHMENT_ID_RE.test(id)) throw new HttpError(400, `첨부 id가 올바르지 않습니다: ${String(id)}`);
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
        throw new HttpError(
          400,
          `첨부를 찾을 수 없습니다: ${missing.join(', ')} (지워졌거나 다른 문서의 첨부입니다 — 질문에 쓰지 않은 첨부는 24시간 뒤에 지워집니다)`,
          { missingAttachments: missing },
        );
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
  if (!release) throw new HttpError(503, SHUTTING_DOWN);
  try {
    // The document may have been deleted while the job waited for a slot.
    if ((await readStoredDoc(docId)) === null) throw new HttpError(404, '문서를 찾을 수 없습니다');
    const run = runAttachmentWorker(job);
    let runs = runningJobs.get(docId);
    if (!runs) runningJobs.set(docId, (runs = new Set()));
    runs.add(run);
    try {
      return await run.done;
    } catch (err) {
      if ((await readStoredDoc(docId)) === null) throw new HttpError(404, '문서를 찾을 수 없습니다');
      if (isImageWorkerStopped(err)) throw new HttpError(503, SHUTTING_DOWN);
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

/** Writes <id>.json once the image exists; a document deleted meanwhile is not made again (404, image removed). */
async function saveAttachment(docId: string, attachment: Attachment): Promise<Attachment> {
  try {
    if ((await readStoredDoc(docId)) === null) throw new HttpError(404, '문서를 찾을 수 없습니다');
    // No mkdir: when the folder went away with its document, this fails instead of making it again.
    await writeJsonAtomic(metaFile(docId, attachment.id), attachment);
    return attachment;
  } catch (err) {
    await removeAttachmentFiles(docId, attachment.id).catch(() => {});
    if (isNotFound(err)) throw new HttpError(404, '문서를 찾을 수 없습니다');
    throw err;
  }
}

/** A CreateRegionRequest, validated against the document (HttpError 400); `annotationId` when the body names a 필기. */
export function parseRegionRequest(body: unknown, pageCount: number): { slide: number; rect: RegionRect; annotationId?: string } {
  const request = (typeof body === 'object' && body !== null ? body : {}) as { slide?: unknown; rect?: unknown; annotationId?: unknown };
  const slide = request.slide;
  if (typeof slide !== 'number' || !Number.isInteger(slide) || slide < 1 || slide > pageCount) {
    throw new HttpError(400, `슬라이드 번호가 올바르지 않습니다 (1–${pageCount})`);
  }
  if (!isRect(request.rect)) throw new HttpError(400, '선택 영역(rect: x, y, w, h)이 올바르지 않습니다');
  const { x, y, w, h } = request.rect;
  const inside = (value: number) => value >= -RECT_EPSILON && value <= 1 + RECT_EPSILON;
  if (!(w > 0 && h > 0) || !inside(x) || !inside(y) || !inside(x + w) || !inside(y + h)) {
    throw new HttpError(400, '선택 영역은 슬라이드 안(0–1)에 있고 넓이가 있어야 합니다');
  }
  // Clamped and rounded to 6 decimals (0.1 + 0.62 - 0.1 would be stored as 0.6200000000000001): x + w stays ≤ 1.
  const round = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * RECT_DECIMALS) / RECT_DECIMALS;
  const x0 = round(x);
  const y0 = round(y);
  const rect = { x: x0, y: y0, w: round(round(x + w) - x0), h: round(round(y + h) - y0) };
  if (!(rect.w > 0 && rect.h > 0)) throw new HttpError(400, '선택 영역은 슬라이드 안(0–1)에 있고 넓이가 있어야 합니다');
  const annotationId = request.annotationId;
  if (annotationId === undefined || annotationId === null) return { slide, rect };
  if (typeof annotationId !== 'string' || !ANNOTATION_ID_RE.test(annotationId)) throw new HttpError(400, ANNOTATION_NOT_FOUND);
  return { slide, rect, annotationId };
}

/**
 * The snapshot of a 필기 a region is made from (DESIGN §25): its id and type, and the memo's / text box's text or
 * the highlighted words when it has any. 400 when the slide has no such item.
 */
async function annotationSnapshot(docId: string, slide: number, annotationId: string): Promise<AttachmentAnnotation> {
  const item = (await readSlideAnnotations(docId, slide)).items.find((candidate) => candidate.id === annotationId);
  if (!item) throw new HttpError(400, ANNOTATION_NOT_FOUND);
  const annotation: AttachmentAnnotation = { id: item.id, type: item.type };
  const text = item.type === 'memo' || item.type === 'text' || item.type === 'textHighlight' ? item.text.trim() : '';
  if (text) annotation.text = text.slice(0, MAX_ANNOTATION_TEXT_CHARS);
  return annotation;
}

/**
 * POST /api/docs/:docId/regions: crops the region (padded) from the full-resolution slide and reads the PDF's
 * text inside it, in the image worker. 404 unknown document, 409 not converted (yet), 400 bad slide / rect, or an
 * `annotationId` that names no 필기 of the slide (its snapshot is taken before the image is made).
 */
export async function createRegionAttachment(docId: string, body: unknown, now: Date = new Date()): Promise<Attachment> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, '문서를 찾을 수 없습니다');
  if (doc.status !== 'ready') {
    throw new HttpError(
      409,
      doc.status === 'error' ? `문서 처리에 실패했습니다: ${doc.error ?? '알 수 없는 오류'}` : '문서를 아직 처리하는 중입니다',
    );
  }
  const { slide, rect, annotationId } = parseRegionRequest(body, doc.pageCount);
  const annotation = annotationId ? await annotationSnapshot(docId, slide, annotationId) : null;
  await ensureAttachmentsDir(docId);
  const id = newAttachmentId();
  const job: AttachmentJob = { kind: 'region', docDir: docPaths(docId).dir, id, slide, slideFile: slideFileName(slide, doc.pageCount), rect };
  const failure = `슬라이드 ${slide}의 선택 영역을 잘라내지 못했습니다`;
  const result = await runJob(docId, job, failure);
  if (!result.ok) throw new HttpError(500, failure);
  return saveAttachment(docId, {
    id,
    kind: 'region',
    slide,
    rect,
    width: result.width,
    height: result.height,
    text: result.text ?? '',
    ...(annotation ? { annotation } : {}),
    createdAt: now.toISOString(),
  });
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
  if ((await readStoredDoc(docId)) === null) throw new HttpError(404, '문서를 찾을 수 없습니다');
  if (bytes.length === 0) throw new HttpError(400, '이미지 내용이 비어 있습니다');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw tooLarge();
  const type = sniffImageType(bytes);
  if (!type) throw new HttpError(415, UNSUPPORTED_IMAGE);
  const dir = await ensureAttachmentsDir(docId);
  const id = newAttachmentId();
  // The worker reads the upload from a file (not through the IPC channel); the sweep removes it if we crash.
  const input = path.join(dir, `${id}.upload`);
  let result: AttachmentWorkerResult;
  try {
    try {
      await fs.writeFile(input, bytes);
    } catch (err) {
      if (isNotFound(err)) throw new HttpError(404, '문서를 찾을 수 없습니다');
      throw err;
    }
    result = await runJob(docId, { kind: 'upload', docDir: docPaths(docId).dir, id, input, type }, '이미지를 처리하지 못했습니다');
  } finally {
    await rmWithRetry(input, { force: true }).catch(() => {});
  }
  if (!result.ok) {
    if (result.reason === 'too-large') throw new HttpError(413, IMAGE_TOO_LARGE_PIXELS);
    if (type === 'heif') {
      throw new HttpError(415, 'HEIC/HEIF 이미지는 이 컴퓨터에서 열 수 없습니다. JPEG나 PNG로 바꿔서(예: 스크린샷) 다시 올려 주세요');
    }
    if (result.reason === 'unsupported') throw new HttpError(415, UNSUPPORTED_IMAGE);
    throw new HttpError(400, '이미지를 읽을 수 없습니다 (파일이 손상되었을 수 있습니다)');
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
  return new HttpError(413, `이미지가 너무 큽니다 (최대 ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB)`);
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
  if ((await readAttachment(docId, id)) === null) throw new HttpError(404, NOT_FOUND);
  await lock(docId, async () => {
    if ((await readAttachment(docId, id)) === null) throw new HttpError(404, NOT_FOUND);
    if (isAttachmentPinned(docId, id) || (await referenced(docId)).has(id)) {
      throw new HttpError(409, '이미 질문에 쓰인 첨부는 지울 수 없습니다');
    }
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
      if (!ATTACHMENT_ID_RE.test(id)) continue;
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
