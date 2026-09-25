// The on-disk library: PDF import, the background ingest pipeline (poppler + the image worker),
// document metadata, read access to course and digest files, and a few filesystem helpers
// shared with sessions.ts / courses.ts / digest.ts.
//
// Layout (docs/DESIGN.md §2, §11, §12, §15):
//   library/<docId>/doc.json, source.pdf, slides/NNN.png, sheets/sheet-NN.png, sheets/sheets.json,
//   text/NNN.txt, sessions/<sid>.json, notes/<sid>.md, STUDY_NOTES.md,
//   digest/digest.json, DIGEST.md,
//   view/NNN-<w>.webp, thumbs/NNN.webp, inline/<dir>-<name>.jpg (derived images, server/assets.ts)
//   library/courses/<courseId>/course.json, COURSE.md
//
// All image work (contact sheets, derived images) runs in the image worker (server/imageWorker.ts), a
// short-lived child process: this module never loads sharp. Documents converted before the derived
// images existed get them from a background backfill, one document at a time.
//
// Course and digest files are *read* here (DocMeta.courseId / digestStatus and DocAssets are derived
// from them) but written only by courses.ts and digest.ts, which import this module — never the
// other way round.
//
// Also: deleting a document / retrying a failed ingest (DESIGN §14), and the single-instance lock
// library/.server.lock that keeps a second server away from a library another one is using.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COURSE_ID_RE, DOC_ID_RE } from '../shared/types.ts';
import type { DigestSlide, DigestStatus, DocMeta } from '../shared/types.ts';
import { VIEW_WIDTHS, inlinePathFor, thumbPath, viewPath } from './assets.ts';
import { HttpError, childProcessEnv, libraryDir } from './config.ts';
import { isImageWorkerStopped, runImageWorker } from './imageWorker.ts';
import type { ImageJob, ImageWorkerOptions, ImageWorkerRun, SheetEntry } from './imageWorker.ts';
import type { CourseContext, CourseLectureRef, CourseRecord, DigestRecord, DocAssets } from './internal-types.ts';

export type { SheetEntry } from './imageWorker.ts';

/**
 * Why an import failed when pdftoppm/pdftotext/pdfinfo cannot be found, with the install command of the
 * platform's usual package manager.
 */
export function popplerMissingMessage(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'poppler is not installed (brew install poppler)';
    case 'linux':
      return (
        'poppler is not installed (Debian/Ubuntu: sudo apt install poppler-utils · Fedora: sudo dnf install poppler-utils · ' +
        'Arch: sudo pacman -S poppler)'
      );
    case 'win32':
      return (
        'poppler is not installed (winget install oschwartz10612.Poppler, or scoop install poppler; ' +
        'then open a new terminal so pdftoppm.exe is on PATH)'
      );
    default:
      return 'poppler is not installed (install the poppler utilities: pdftoppm, pdftotext, pdfinfo)';
  }
}

export const POPPLER_MISSING_MESSAGE = popplerMissingMessage();

const RENDER_LONG_EDGE = 1600;
const PROGRESS_POLL_MS = 400;
const MAX_TITLE_CHARS = 200;

/** Directory of library/ that holds the courses; never a document (DOC_ID_RE would accept the name). */
export const COURSES_DIR_NAME = 'courses';

/** library/.server.lock: `{ pid, port, startedAt }` of the server using the library (DESIGN §14). */
export const SERVER_LOCK_FILE_NAME = '.server.lock';

/**
 * A deleted document's folder is first renamed to `.deleted-<docId>-<hex>` (it disappears at once),
 * then removed. The dot keeps it out of every listing (DOC_ID_RE needs a letter or digit first).
 */
const DELETED_PREFIX = '.deleted-';

const DIGEST_STATUSES: ReadonlySet<DigestStatus> = new Set<DigestStatus>(['none', 'running', 'ready', 'error', 'aborted']);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface DocPaths {
  dir: string;
  docJson: string;
  sourcePdf: string;
  slidesDir: string;
  sheetsDir: string;
  sheetsJson: string;
  textDir: string;
  /** Derived images (server/assets.ts): view renditions, thumbnails, inline JPEGs. */
  viewDir: string;
  thumbsDir: string;
  inlineDir: string;
  sessionsDir: string;
  notesDir: string;
  studyNotes: string;
  digestDir: string;
  digestJson: string;
  digestMd: string;
}

export interface CoursePaths {
  dir: string;
  courseJson: string;
  courseMd: string;
}

/** A syntactically valid document id that does not name a reserved library directory. */
export function isDocId(docId: string): boolean {
  return DOC_ID_RE.test(docId) && docId !== COURSES_DIR_NAME;
}

/**
 * Paths of a document directory. Throws for ids that do not match DOC_ID_RE so an
 * unvalidated id can never reach the filesystem.
 */
export function docPaths(docId: string): DocPaths {
  if (!isDocId(docId)) throw new HttpError(404, '문서를 찾을 수 없습니다');
  const dir = path.join(libraryDir(), docId);
  return {
    dir,
    docJson: path.join(dir, 'doc.json'),
    sourcePdf: path.join(dir, 'source.pdf'),
    slidesDir: path.join(dir, 'slides'),
    sheetsDir: path.join(dir, 'sheets'),
    sheetsJson: path.join(dir, 'sheets', 'sheets.json'),
    textDir: path.join(dir, 'text'),
    viewDir: path.join(dir, 'view'),
    thumbsDir: path.join(dir, 'thumbs'),
    inlineDir: path.join(dir, 'inline'),
    sessionsDir: path.join(dir, 'sessions'),
    notesDir: path.join(dir, 'notes'),
    studyNotes: path.join(dir, 'STUDY_NOTES.md'),
    digestDir: path.join(dir, 'digest'),
    digestJson: path.join(dir, 'digest', 'digest.json'),
    digestMd: path.join(dir, 'DIGEST.md'),
  };
}

/** Absolute path of library/courses. */
export function coursesDir(): string {
  return path.join(libraryDir(), COURSES_DIR_NAME);
}

/** Paths of a course directory. Throws (404) for ids that do not match COURSE_ID_RE. */
export function coursePaths(courseId: string): CoursePaths {
  if (!COURSE_ID_RE.test(courseId)) throw new HttpError(404, '과목을 찾을 수 없습니다');
  const dir = path.join(coursesDir(), courseId);
  return { dir, courseJson: path.join(dir, 'course.json'), courseMd: path.join(dir, 'COURSE.md') };
}

/** 1-based page number, zero padded to 3 digits (more when the deck has > 999 pages). */
function pageBaseName(n: number, pageCount: number): string {
  return String(n).padStart(Math.max(3, String(pageCount).length), '0');
}

/** File name of a rendered slide, e.g. `007.png`. */
export function slideFileName(n: number, pageCount: number): string {
  return `${pageBaseName(n, pageCount)}.png`;
}

/** File name of a slide's extracted text, e.g. `007.txt`. */
export function textFileName(n: number, pageCount: number): string {
  return `${pageBaseName(n, pageCount)}.txt`;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (also used by sessions.ts)
// ---------------------------------------------------------------------------

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

export function isNotFound(err: unknown): boolean {
  return isErrnoException(err) && err.code === 'ENOENT';
}

/** Errors Windows reports while another process (antivirus, indexer, OneDrive, an editor) briefly holds a file. */
const WINDOWS_LOCK_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Waits between attempts: about 1.5 s in total, like graceful-fs. */
const WINDOWS_LOCK_RETRY_MS = [20, 40, 80, 120, 160, 240, 320, 400];

/**
 * Runs a filesystem operation; on Windows it is retried for a moment when the file is locked by another
 * process (EPERM/EBUSY/EACCES). Elsewhere those codes are real permission errors and are thrown at once.
 */
export async function withFsRetry<T>(operation: () => Promise<T>, platform: NodeJS.Platform = process.platform): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const delay = WINDOWS_LOCK_RETRY_MS[attempt];
      if (platform !== 'win32' || delay === undefined || !isErrnoException(err) || !WINDOWS_LOCK_CODES.has(err.code ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function renameWithRetry(from: string, to: string): Promise<void> {
  return withFsRetry(() => fs.rename(from, to));
}

/** fs.rm with retries (Windows file locks; a directory that is still being written to: ENOTEMPTY). */
export function rmWithRetry(target: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
  return withFsRetry(() => fs.rm(target, options.recursive ? { ...options, maxRetries: 3, retryDelay: 100 } : options));
}

export async function mkdirWithRetry(dir: string): Promise<void> {
  await withFsRetry(() => fs.mkdir(dir, { recursive: true }));
}

/** Writes `<file>.<unique>.tmp` and renames it over `file`, so readers never see a partial file. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parsed JSON, or null when the file is missing or unreadable (the latter is logged). */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[library] ignoring unreadable JSON file ${file}: ${(err as Error).message}`);
    return null;
  }
}

export type KeyedQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Runs tasks with the same key one after another (in call order); different keys run concurrently.
 * A failing task does not block the ones queued after it.
 */
export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

// ---------------------------------------------------------------------------
// Poppler
// ---------------------------------------------------------------------------

interface ToolResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * Environment of the poppler tools (they parse untrusted PDFs): without the server's secrets
 * (config.ts childProcessEnv), and on macOS with the usual Homebrew locations appended to PATH
 * (GUI-launched shells often lack them).
 */
export function toolEnv(): NodeJS.ProcessEnv {
  const env = childProcessEnv();
  if (process.platform !== 'darwin') return env;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dirs.includes(extra)) dirs.push(extra);
  }
  return { ...env, PATH: dirs.join(path.delimiter) };
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter((line) => line.trim() !== '');
  return lines.at(-1)?.trim() ?? '';
}

/**
 * Runs a poppler command line tool (argument array, never a shell). A missing binary rejects
 * with POPPLER_MISSING_MESSAGE; a non-zero exit rejects with the last stderr line.
 */
export function runPoppler(tool: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(isErrnoException(err) && err.code === 'ENOENT' ? new Error(POPPLER_MISSING_MESSAGE) : err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      } else {
        const detail = lastLine(stderr) || (signal ? `killed by ${signal}` : `exit code ${code}`);
        reject(new Error(`${tool} failed: ${detail}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Document metadata
// ---------------------------------------------------------------------------

/** doc.json as stored on disk: DocMeta without the fields derived from course and digest files. */
export type StoredDocMeta = Omit<DocMeta, 'courseId' | 'digestStatus'>;

const metaQueue = createKeyedQueue();
/** Running ingests, from the start until their image worker has exited (derived images included). */
const activeIngests = new Map<string, Promise<void>>();
/** Ingests past 'ready' that only write the derived images: the document is usable (and deletable). */
const derivingDocs = new Set<string>();
/** Documents being deleted: every read already treats them as missing. */
const deletingDocs = new Set<string>();

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Drops derived fields (they are never authoritative on disk) and fixes the id. */
function toStoredMeta(value: StoredDocMeta & Partial<DocMeta>, docId: string): StoredDocMeta {
  const { courseId: _courseId, digestStatus: _digestStatus, ...stored } = value;
  // The directory name is authoritative (a copied/renamed folder still works).
  return { ...stored, id: docId };
}

/**
 * doc.json of a document without the derived fields — cheap, for callers that only need the
 * title / page count. Null when the id is invalid or the document does not exist.
 */
export async function readStoredDoc(docId: string): Promise<StoredDocMeta | null> {
  if (!isDocId(docId) || deletingDocs.has(docId)) return null;
  const meta = await readJsonFile<StoredDocMeta & Partial<DocMeta>>(docPaths(docId).docJson);
  if (deletingDocs.has(docId)) return null; // deleted while reading
  return typeof meta === 'object' && meta !== null ? toStoredMeta(meta, docId) : null;
}

/** Metadata of a document, or null when the id is invalid or the document does not exist. */
export async function getDoc(docId: string): Promise<DocMeta | null> {
  const stored = await readStoredDoc(docId);
  if (!stored) return null;
  const [courses, digestStatus] = await Promise.all([readCourseRecords(), readDigestStatus(docId)]);
  return withDerivedFields(stored, courseIdIndex(courses), digestStatus);
}

function withDerivedFields(stored: StoredDocMeta, courseIds: Map<string, string>, digestStatus: DigestStatus): DocMeta {
  return { ...stored, courseId: courseIds.get(stored.id) ?? null, digestStatus };
}

/** Names of the directories of library/ that may hold a document (library/courses excluded). */
async function listDocDirs(): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(libraryDir(), { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries.filter((entry) => entry.isDirectory() && isDocId(entry.name)).map((entry) => entry.name);
}

/** doc.json of every document (without the derived fields), newest first. */
export async function listStoredDocs(): Promise<StoredDocMeta[]> {
  const metas = await Promise.all((await listDocDirs()).map((docId) => readStoredDoc(docId)));
  return metas.filter(isPresent).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** All documents of the library, newest first. */
export async function listDocs(): Promise<DocMeta[]> {
  const [stored, courses] = await Promise.all([listStoredDocs(), readCourseRecords()]);
  const courseIds = courseIdIndex(courses);
  return Promise.all(stored.map(async (meta) => withDerivedFields(meta, courseIds, await readDigestStatus(meta.id))));
}

/** Applies a patch to doc.json (serialized per document; `undefined` values remove the key). */
async function updateMeta(docId: string, patch: Partial<StoredDocMeta>): Promise<StoredDocMeta> {
  return metaQueue(docId, async () => {
    const file = docPaths(docId).docJson;
    const current = await readJsonFile<StoredDocMeta & Partial<DocMeta>>(file);
    if (!current) throw new Error(`doc.json of ${docId} is missing`);
    const next = toStoredMeta({ ...current, ...patch }, docId);
    await writeJsonAtomic(file, next);
    return next;
  });
}

/**
 * Everything the context builder needs, including the digest and the course context.
 * Throws (HttpError 404/409) unless the document is ready.
 */
export async function loadDocAssets(docId: string): Promise<DocAssets> {
  const stored = await readStoredDoc(docId);
  if (!stored) throw new HttpError(404, '문서를 찾을 수 없습니다');
  if (stored.status !== 'ready') {
    throw new HttpError(
      409,
      stored.status === 'error' ? `문서 처리에 실패했습니다: ${stored.error ?? '알 수 없는 오류'}` : '문서를 아직 처리하는 중입니다',
    );
  }
  const paths = docPaths(docId);
  const pageCount = stored.pageCount;
  const [texts, sheetEntries, courses, digestRecord] = await Promise.all([
    Promise.all(
      Array.from({ length: pageCount }, (_, i) =>
        fs.readFile(path.join(paths.textDir, textFileName(i + 1, pageCount)), 'utf8').catch(() => ''),
      ),
    ),
    readJsonFile<SheetEntry[]>(paths.sheetsJson),
    readCourseRecords(),
    readDigestRecord(docId),
  ]);
  const sheets = (Array.isArray(sheetEntries) ? sheetEntries : []).map((entry) => ({
    // basename(): sheets.json is data on disk, never let it point outside the sheets dir.
    path: path.join(paths.sheetsDir, path.basename(entry.file)),
    fromSlide: entry.fromSlide,
    toSlide: entry.toSlide,
  }));
  const courseIds = courseIdIndex(courses);
  const meta = withDerivedFields(stored, courseIds, digestRecord?.status ?? 'none');
  const courseRecord = courses.find((course) => course.id === meta.courseId);
  const digestSlides = (digestRecord?.slides ?? []).filter((entry) => entry.slide <= pageCount);
  return {
    meta,
    dir: paths.dir,
    texts,
    slidePath: (slide: number) => path.join(paths.slidesDir, slideFileName(slide, pageCount)),
    sheets,
    digest: digestSlides.length > 0 ? digestSlides : null,
    digestComplete: isDigestComplete(digestSlides, pageCount),
    course: courseRecord ? await buildCourseContext(courseRecord, docId) : null,
  };
}

/** The course as the context builder sees it: every existing lecture in order, with its summary. */
async function buildCourseContext(course: CourseRecord, docId: string): Promise<CourseContext> {
  const refs = await Promise.all(
    course.docIds.map(async (lectureId): Promise<Omit<CourseLectureRef, 'index'> | null> => {
      const [lecture, digest] = await Promise.all([readStoredDoc(lectureId), readDigestRecord(lectureId)]);
      // A lecture whose folder was removed by hand is skipped (the course file still lists it).
      if (!lecture) return null;
      return {
        docId: lectureId,
        title: lecture.title,
        pageCount: lecture.pageCount,
        dir: docPaths(lectureId).dir,
        summary: digest?.summary ?? null,
        hasDigest: digest ? isDigestComplete(digest.slides, lecture.pageCount) : false,
      };
    }),
  );
  const lectures: CourseLectureRef[] = refs.filter(isPresent).map((ref, i) => ({ ...ref, index: i + 1 }));
  const current = lectures.find((lecture) => lecture.docId === docId);
  return { id: course.id, title: course.title, lectures, currentIndex: current?.index ?? 0 };
}

// ---------------------------------------------------------------------------
// Courses and digests — read side (written by courses.ts / digest.ts)
// ---------------------------------------------------------------------------

function normalizeCourseRecord(value: unknown, courseId: string): CourseRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<Record<keyof CourseRecord, unknown>>;
  if (typeof raw.title !== 'string' || !Array.isArray(raw.docIds)) return null;
  const docIds = raw.docIds.filter((id): id is string => typeof id === 'string' && isDocId(id));
  return {
    version: 1,
    // The directory name is authoritative, like for documents.
    id: courseId,
    title: raw.title,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    docIds: [...new Set(docIds)],
  };
}

/** A course file, or null when the id is invalid or the course does not exist. */
export async function readCourseRecord(courseId: string): Promise<CourseRecord | null> {
  if (!COURSE_ID_RE.test(courseId)) return null;
  return normalizeCourseRecord(await readJsonFile<unknown>(coursePaths(courseId).courseJson), courseId);
}

/** Oldest first (createdAt, then id) — the order of GET /api/courses and of membership conflicts. */
export function compareCourses(a: CourseRecord, b: CourseRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Every course of the library, oldest first. */
export async function readCourseRecords(): Promise<CourseRecord[]> {
  let entries;
  try {
    entries = await fs.readdir(coursesDir(), { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const records = await Promise.all(
    entries.filter((entry) => entry.isDirectory() && COURSE_ID_RE.test(entry.name)).map((entry) => readCourseRecord(entry.name)),
  );
  return records.filter(isPresent).sort(compareCourses);
}

/**
 * docId → id of the course that lists it. `courses` must be oldest first: a document listed by
 * several courses (a data error) belongs to the oldest one.
 */
export function courseIdIndex(courses: CourseRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const course of courses) {
    for (const docId of course.docIds) if (!index.has(docId)) index.set(docId, course.id);
  }
  return index;
}

function normalizeDigestSlide(value: unknown): DigestSlide | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<Record<keyof DigestSlide, unknown>>;
  if (typeof raw.slide !== 'number' || !Number.isInteger(raw.slide) || raw.slide < 1) return null;
  if (typeof raw.markdown !== 'string') return null;
  const entry: DigestSlide = { slide: raw.slide, title: typeof raw.title === 'string' ? raw.title : '', markdown: raw.markdown };
  if (raw.failed === true) entry.failed = true;
  return entry;
}

/** One entry per slide (a later entry replaces an earlier one), ascending by slide. */
export function sortDigestSlides(slides: DigestSlide[]): DigestSlide[] {
  const bySlide = new Map<number, DigestSlide>();
  for (const entry of slides) bySlide.set(entry.slide, entry);
  return [...bySlide.values()].sort((a, b) => a.slide - b.slide);
}

function normalizeDigestRecord(value: unknown): DigestRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<Record<keyof DigestRecord, unknown>>;
  const status = raw.status as DigestStatus;
  if (!DIGEST_STATUSES.has(status) || !Array.isArray(raw.slides)) return null;
  const record: DigestRecord = {
    version: 1,
    status,
    slides: sortDigestSlides(raw.slides.map(normalizeDigestSlide).filter(isPresent)),
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : null,
  };
  if (typeof raw.provider === 'string') record.provider = raw.provider as DigestRecord['provider'];
  if (typeof raw.model === 'string') record.model = raw.model;
  if (typeof raw.startedAt === 'string') record.startedAt = raw.startedAt;
  if (typeof raw.updatedAt === 'string') record.updatedAt = raw.updatedAt;
  if (typeof raw.error === 'string' && raw.error) record.error = raw.error;
  if (raw.summaryStale === true) record.summaryStale = true;
  return record;
}

/** digest/digest.json of a document, or null when there is none (or the id is invalid). */
export async function readDigestRecord(docId: string): Promise<DigestRecord | null> {
  if (!isDocId(docId)) return null;
  return normalizeDigestRecord(await readJsonFile<unknown>(docPaths(docId).digestJson));
}

/**
 * docId → status of its digest.json, keyed by the file's identity (inode, size, mtime). digest.json is
 * always replaced atomically (a new inode), so a changed file never matches a stale key.
 */
const digestStatusCache = new Map<string, { key: string; status: DigestStatus }>();

/**
 * Status of a document's digest ('none' when there is none) without parsing digest.json (tens of KB) on
 * every request: DocMeta.digestStatus of GET /api/docs and GET /api/docs/:docId.
 */
export async function readDigestStatus(docId: string): Promise<DigestStatus> {
  if (!isDocId(docId)) return 'none';
  let stat;
  try {
    stat = await fs.stat(docPaths(docId).digestJson);
  } catch (err) {
    digestStatusCache.delete(docId);
    if (isNotFound(err)) return 'none';
    throw err;
  }
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = digestStatusCache.get(docId);
  if (cached?.key === key) return cached.status;
  const status = (await readDigestRecord(docId))?.status ?? 'none';
  digestStatusCache.set(docId, { key, status });
  return status;
}

/** Every slide 1..pageCount has a non-failed digest entry. */
export function isDigestComplete(slides: DigestSlide[], pageCount: number): boolean {
  if (pageCount < 1) return false;
  const done = new Set(slides.filter((entry) => !entry.failed).map((entry) => entry.slide));
  for (let n = 1; n <= pageCount; n++) if (!done.has(n)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Markdown helpers (notes, DIGEST.md, COURSE.md)
// ---------------------------------------------------------------------------

/** Shifts ATX headings down by `levels` (max h6) so they nest under the file's own headings; code fences are left alone. */
export function demoteHeadings(markdown: string, levels: number): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const heading = /^(#{1,6})(\s)/.exec(line);
      if (!heading) return line;
      const level = Math.min(6, heading[1].length + levels);
      return '#'.repeat(level) + line.slice(heading[1].length);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** True when the buffer carries a PDF header (readers accept it anywhere in the first 1 KB). */
function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length > 5 && bytes.subarray(0, 1024).includes('%PDF-');
}

/** Original file name without any directory part, NFC-normalized (macOS hands out NFD Hangul). */
function cleanFileName(fileName: string): string {
  const base = fileName.normalize('NFC').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned || 'document.pdf';
}

/** Title = file name without its extension (unicode kept). */
function titleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]*$/, '').trim();
  return (withoutExt || fileName).slice(0, MAX_TITLE_CHARS);
}

/** ascii `[a-z0-9-]`, max 40 chars, `fallback` (default `doc`) when nothing ascii is left. */
export function slugify(title: string, fallback = 'doc'): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents: é -> e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || fallback;
}

/**
 * Stores a PDF in the library and starts the ingest in the background.
 * Resolves right away with the `processing` DocMeta.
 */
export async function importPdf(bytes: Buffer, fileName: string): Promise<DocMeta> {
  if (!looksLikePdf(bytes)) throw new HttpError(400, 'PDF 파일이 아닙니다 (%PDF 헤더가 없습니다)');
  const name = cleanFileName(fileName);
  const title = titleFromFileName(name);
  const slug = slugify(title);
  await fs.mkdir(libraryDir(), { recursive: true });

  let docId = '';
  for (let attempt = 0; !docId; attempt++) {
    const candidate = `${slug}-${randomBytes(3).toString('hex')}`;
    try {
      await fs.mkdir(docPaths(candidate).dir);
      docId = candidate;
    } catch (err) {
      if (!(isErrnoException(err) && err.code === 'EEXIST') || attempt >= 10) throw err;
    }
  }

  const paths = docPaths(docId);
  await fs.writeFile(paths.sourcePdf, bytes);
  const meta: StoredDocMeta = {
    id: docId,
    title,
    fileName: name,
    pageCount: 0,
    aspectRatio: 16 / 9, // placeholder until pdfinfo has run
    status: 'processing',
    progress: 0,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(paths.docJson, meta);
  void startIngest(docId);
  // A brand-new document is in no course (courses.ts adds it afterwards) and has no digest.
  return { ...meta, courseId: null, digestStatus: 'none' };
}

// ---------------------------------------------------------------------------
// Ingest pipeline (DESIGN §3, §15)
// ---------------------------------------------------------------------------

/** Starts (or joins) the ingest of a document. The promise never rejects; failures end in status 'error'. */
function startIngest(docId: string): Promise<void> {
  const running = activeIngests.get(docId);
  if (running) return running;
  const run = ingest(docId).finally(() => activeIngests.delete(docId));
  activeIngests.set(docId, run);
  return run;
}

/** Resolves when the running ingest of `docId` (if any) has finished, derived images included. */
export function waitForIngest(docId: string): Promise<void> {
  return activeIngests.get(docId) ?? Promise.resolve();
}

/** True while the document's PDF is being converted by this process (until it is 'ready' or 'error'). */
export function isIngestRunning(docId: string): boolean {
  return activeIngests.has(docId) && !derivingDocs.has(docId);
}

/** Re-processes documents left in `processing` (e.g. the server stopped mid-ingest). */
export async function resumePendingIngests(): Promise<void> {
  const pending = (await listStoredDocs()).filter((doc) => doc.status === 'processing');
  // One at a time: rendering is CPU heavy and this runs while the server starts.
  for (const doc of pending) {
    // The list is a snapshot: the document may have been deleted meanwhile.
    if ((await readStoredDoc(doc.id))?.status !== 'processing') continue;
    console.log(`[library] resuming ingest of ${doc.id}`);
    await startIngest(doc.id);
  }
}

/**
 * Converts a document whose conversion failed (status 'error') again, e.g. after installing poppler
 * (POST /api/docs/:docId/retry). Resolves with the document in status 'processing'; the ingest runs in
 * the background. Throws 404 (unknown document) or 409 (not in status 'error').
 */
export async function retryIngest(docId: string): Promise<DocMeta> {
  const stored = await readStoredDoc(docId);
  if (!stored) throw new HttpError(404, '문서를 찾을 수 없습니다');
  // Check and start without an await in between (startIngest registers the ingest synchronously).
  if (deletingDocs.has(docId)) throw new HttpError(404, '문서를 찾을 수 없습니다');
  if (stored.status !== 'error' || activeIngests.has(docId)) {
    throw new HttpError(409, stored.status === 'ready' ? '이미 변환이 끝난 문서입니다' : '문서를 이미 변환하고 있습니다');
  }
  void startIngest(docId);
  // ingest() first marks the document 'processing' (through the same queue): answer with that state.
  await metaQueue(docId, async () => undefined);
  const meta = await getDoc(docId);
  if (!meta) throw new HttpError(404, '문서를 찾을 수 없습니다');
  return meta;
}

/**
 * Deletes a document and everything stored with it (library/<docId>: slides, sessions, notes, digest).
 * `busyReason` is asked right before the point of no return, with no await in between, so nothing can
 * start in the gap; a non-null answer (or a PDF conversion) refuses with 409. From then on every read
 * treats the document as missing; an image worker still writing its derived images is stopped, and its
 * folder is renamed away, then removed. Course membership is not touched here (courses.ts owns the course
 * files). Throws 404 for unknown documents.
 */
export async function deleteDoc(docId: string, busyReason: () => string | null = () => null): Promise<void> {
  if ((await readStoredDoc(docId)) === null) throw new HttpError(404, '문서를 찾을 수 없습니다');
  if (deletingDocs.has(docId)) throw new HttpError(404, '문서를 찾을 수 없습니다');
  const reason = isIngestRunning(docId) ? 'PDF를 변환하는 중에는 지울 수 없습니다. 변환이 끝난 뒤에 다시 시도해 주세요' : busyReason();
  if (reason) throw new HttpError(409, reason);
  deletingDocs.add(docId);
  try {
    backfillQueue.delete(docId);
    // Derived images of the ingest or of the backfill are not wanted any more (and on Windows an open
    // file would make the rename below fail).
    await stopImageRun(docId);
    await activeIngests.get(docId);
    digestStatusCache.delete(docId);
    const dir = docPaths(docId).dir;
    const trash = path.join(libraryDir(), `${DELETED_PREFIX}${docId}-${randomBytes(3).toString('hex')}`);
    try {
      await renameWithRetry(dir, trash);
    } catch (err) {
      if (isNotFound(err)) return; // removed by hand meanwhile
      throw err;
    }
    await rmWithRetry(trash, { recursive: true, force: true }).catch((err: unknown) => {
      // Invisible already; the startup sweep (removeDeletedLeftovers) tries again.
      console.warn(`[library] could not remove ${trash}: ${(err as Error).message}`);
    });
    console.log(`[library] ${docId}: deleted`);
  } finally {
    deletingDocs.delete(docId);
  }
}

/** Removes folders of deleted documents that could not be removed at the time (startup sweep). */
export async function removeDeletedLeftovers(): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(libraryDir(), { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return 0;
    throw err;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(DELETED_PREFIX)) continue;
    await rmWithRetry(path.join(libraryDir(), entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** File names of a document's rendered slides, in slide order. */
function slideFileNames(pageCount: number): string[] {
  return Array.from({ length: pageCount }, (_, i) => slideFileName(i + 1, pageCount));
}

async function ingest(docId: string): Promise<void> {
  const paths = docPaths(docId);
  let images: ImageWorkerRun | null = null;
  try {
    // First (retryIngest waits for this write): mark the document as being converted.
    await updateMeta(docId, { status: 'processing', progress: 0, error: undefined });
    // A backfill of the previous rendering must not write into the new one.
    await stopImageRun(docId);
    // Start from a clean slate: a resumed ingest may have left partial output behind, and derived images
    // of an earlier rendering must go (the image worker writes only the missing ones).
    for (const dir of [paths.slidesDir, paths.sheetsDir, paths.textDir, paths.viewDir, paths.thumbsDir, paths.inlineDir]) {
      await rmWithRetry(dir, { recursive: true, force: true });
    }
    for (const dir of [paths.slidesDir, paths.textDir]) await mkdirWithRetry(dir);

    const info = await readPdfInfo(paths.sourcePdf);
    await updateMeta(docId, { pageCount: info.pageCount, aspectRatio: info.aspectRatio });

    await renderSlides(docId, paths, info.pageCount);
    // The rendered image is authoritative (it accounts for rotation, crop boxes, ...).
    const aspectRatio = await pngAspectRatio(path.join(paths.slidesDir, slideFileName(1, info.pageCount)), info.aspectRatio);

    await extractTexts(paths, info.pageCount);
    // Contact sheets (required for 'ready'), then the derived images, in one worker process.
    images = startImageRun(docId, { docDir: paths.dir, slides: slideFileNames(info.pageCount), sheets: { aspectRatio }, derived: true });
    await images.sheets;

    // `error: undefined` drops the message of a failed attempt that another process may have left.
    await updateMeta(docId, { status: 'ready', progress: info.pageCount, pageCount: info.pageCount, aspectRatio, error: undefined });
    console.log(`[library] ${docId}: ready (${info.pageCount} slides)`);
  } catch (err) {
    images?.kill();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[library] ingest of ${docId} failed: ${message}`);
    await updateMeta(docId, { status: 'error', error: message }).catch((writeErr: unknown) => {
      console.error(`[library] could not record the failure of ${docId}:`, writeErr);
    });
    return;
  }

  // The document is ready; the view renditions, thumbnails and inline JPEGs are a convenience that the
  // backfill makes later when this part fails (the routes fall back to the slide PNGs meanwhile).
  derivingDocs.add(docId);
  try {
    logDerivedResult(docId, await images.done);
  } catch (err) {
    // Stopped on purpose (deletion, shutdown): the backfill writes what is missing on the next start.
    if (!isImageWorkerStopped(err)) console.warn(`[library] ${docId}: derived images not written: ${(err as Error).message}`);
  } finally {
    derivingDocs.delete(docId);
  }
}

interface PdfInfo {
  pageCount: number;
  aspectRatio: number;
}

async function readPdfInfo(pdfPath: string): Promise<PdfInfo> {
  const { stdout } = await runPoppler('pdfinfo', [pdfPath]);
  const text = stdout.toString('utf8');
  const pages = /^Pages:\s+(\d+)/m.exec(text);
  const pageCount = pages ? Number(pages[1]) : 0;
  if (!pageCount) throw new Error('could not read the page count of the PDF');

  const size = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)/m.exec(text);
  const rotation = /^Page rot:\s+(\d+)/m.exec(text);
  let width = size ? Number(size[1]) : 0;
  let height = size ? Number(size[2]) : 0;
  if (rotation && Number(rotation[1]) % 180 === 90) [width, height] = [height, width];
  const aspectRatio = width > 0 && height > 0 ? width / height : 4 / 3;
  return { pageCount, aspectRatio };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width / height of a PNG from its IHDR chunk (no image decoder needed); `fallback` when unreadable. */
export async function pngAspectRatio(file: string, fallback: number): Promise<number> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE) || header.toString('latin1', 12, 16) !== 'IHDR') {
      return fallback;
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return width > 0 && height > 0 ? width / height : fallback;
  } catch {
    return fallback;
  } finally {
    await handle?.close();
  }
}

/**
 * `pdftoppm -png -scale-to 1600 source.pdf slides/p`, then renames the outputs to `%03d.png`.
 * pdftoppm pads the page number depending on the page count (p-1 / p-01 / p-001), so outputs are
 * matched by number rather than by an expected name. Progress is reported while it runs.
 */
async function renderSlides(docId: string, paths: DocPaths, pageCount: number): Promise<void> {
  const outputPattern = /^p-(\d+)\.png$/;
  const countOutputs = async () =>
    (await fs.readdir(paths.slidesDir).catch(() => [] as string[])).filter((name) => outputPattern.test(name)).length;

  let lastProgress = 0;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return; // previous tick still running
    inFlight = (async () => {
      // The newest file may still be being written, so it does not count yet.
      const progress = Math.min(pageCount, Math.max(0, (await countOutputs()) - 1));
      if (progress > lastProgress) {
        lastProgress = progress;
        await updateMeta(docId, { progress });
      }
    })()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
  }, PROGRESS_POLL_MS);

  try {
    await runPoppler('pdftoppm', ['-png', '-scale-to', String(RENDER_LONG_EDGE), paths.sourcePdf, path.join(paths.slidesDir, 'p')]);
  } finally {
    clearInterval(timer);
    await inFlight;
  }

  const outputs = new Map<number, string>();
  for (const name of await fs.readdir(paths.slidesDir)) {
    const match = outputPattern.exec(name);
    if (match) outputs.set(Number(match[1]), name);
  }
  const missing = Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => !outputs.has(n));
  if (missing.length > 0) {
    throw new Error(`pdftoppm rendered ${pageCount - missing.length} of ${pageCount} pages`);
  }
  for (const [n, name] of outputs) {
    const from = path.join(paths.slidesDir, name);
    if (n >= 1 && n <= pageCount) await renameWithRetry(from, path.join(paths.slidesDir, slideFileName(n, pageCount)));
    else await rmWithRetry(from, { force: true });
  }
  await updateMeta(docId, { progress: pageCount });
}

/** `pdftotext -layout`, split on form feeds, one trimmed file per page ('' when a page has no text). */
async function extractTexts(paths: DocPaths, pageCount: number): Promise<void> {
  let raw = '';
  try {
    raw = (await runPoppler('pdftotext', ['-layout', '-enc', 'UTF-8', paths.sourcePdf, '-'])).stdout.toString('utf8');
  } catch (err) {
    if (err instanceof Error && err.message === POPPLER_MISSING_MESSAGE) throw err;
    // Slides still work from their images; the text is only a helper.
    console.warn(`[library] text extraction failed, continuing without text: ${(err as Error).message}`);
  }
  const pages = raw.split('\f');
  for (let n = 1; n <= pageCount; n++) {
    await fs.writeFile(path.join(paths.textDir, textFileName(n, pageCount)), cleanPageText(pages[n - 1] ?? ''));
  }
}

/** Trims trailing spaces, surrounding blank lines and the common left margin that -layout adds. */
function cleanPageText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const indents = lines.filter((line) => line !== '').map((line) => line.length - line.trimStart().length);
  const margin = indents.length > 0 ? Math.min(...indents) : 0;
  // Runs of blank lines carry no information for the model; keep at most one.
  return lines
    .map((line) => line.slice(margin))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Derived images: the image worker runs, and the backfill (DESIGN §15)
// ---------------------------------------------------------------------------

/** The image worker running for a document (its ingest's or the backfill's): at most one per document. */
const imageRuns = new Map<string, { run: ImageWorkerRun; settled: Promise<void> }>();

/** Documents waiting for the backfill, in order (the backfill works on one at a time). */
const backfillQueue = new Set<string>();
let backfillLoop: Promise<void> | null = null;
/** docId → when the backfill last ran for it: requests for missing files do not start it again sooner. */
const backfillRanAt = new Map<string, number>();
const BACKFILL_COOLDOWN_MS = 60_000;

function startImageRun(docId: string, job: ImageJob, options: ImageWorkerOptions = {}): ImageWorkerRun {
  const run = runImageWorker(job, options);
  const entry = {
    run,
    settled: run.done.then(
      () => undefined,
      () => undefined,
    ),
  };
  imageRuns.set(docId, entry);
  void entry.settled.then(() => {
    if (imageRuns.get(docId) === entry) imageRuns.delete(docId);
  });
  return run;
}

/** Stops the document's image worker (if any) and waits until it has exited. */
async function stopImageRun(docId: string): Promise<void> {
  const entry = imageRuns.get(docId);
  if (!entry) return;
  entry.run.kill();
  await entry.settled;
}

function logDerivedResult(docId: string, result: { written: number; failed: { file: string; error: string }[] }): void {
  if (result.written > 0) console.log(`[library] ${docId}: wrote ${result.written} derived image file(s)`);
  if (result.failed.length > 0) {
    const first = result.failed[0];
    console.warn(`[library] ${docId}: ${result.failed.length} derived image file(s) failed, e.g. ${first.file}: ${first.error}`);
  }
}

/** Every derived file (server/assets.ts) the document should have: slides, then contact sheets. */
async function derivedFiles(paths: DocPaths, pageCount: number): Promise<string[]> {
  const files: string[] = [];
  for (const slide of slideFileNames(pageCount)) {
    for (const width of VIEW_WIDTHS) files.push(viewPath(paths.dir, slide, width));
    files.push(thumbPath(paths.dir, slide));
    const inline = inlinePathFor(path.join(paths.slidesDir, slide));
    if (inline) files.push(inline);
  }
  const sheets = await readJsonFile<SheetEntry[]>(paths.sheetsJson);
  for (const entry of Array.isArray(sheets) ? sheets : []) {
    if (typeof entry?.file !== 'string') continue;
    const inline = inlinePathFor(path.join(paths.sheetsDir, path.basename(entry.file)));
    if (inline) files.push(inline);
  }
  return files;
}

async function hasMissingDerivedFiles(paths: DocPaths, pageCount: number): Promise<boolean> {
  for (const file of await derivedFiles(paths, pageCount)) {
    try {
      await fs.access(file);
    } catch {
      return true;
    }
  }
  return false;
}

/** Busy with the document in another way: its ingest (which writes the derived files itself) or a deletion. */
function imageWorkBlocked(docId: string): boolean {
  return activeIngests.has(docId) || imageRuns.has(docId) || deletingDocs.has(docId);
}

/**
 * Asks the backfill for the missing derived images of a document (e.g. a view rendition was requested
 * but does not exist yet). No-op while the document is converted, queued, being backfilled, or when the
 * backfill ran for it within the last minute (files it could not write are not retried on every request).
 */
export function requestDerivedImages(docId: string): void {
  if (!isDocId(docId) || backfillQueue.has(docId) || imageWorkBlocked(docId)) return;
  if (Date.now() - (backfillRanAt.get(docId) ?? -Infinity) < BACKFILL_COOLDOWN_MS) return;
  backfillQueue.add(docId);
  pumpBackfill();
}

/**
 * Startup: queues every ready document for the backfill (documents that already have every derived file
 * cost a few stat calls). The work happens in the background, one document at a time, at low priority.
 */
export async function backfillDerivedImages(): Promise<void> {
  for (const doc of await listStoredDocs()) {
    if (doc.status === 'ready' && !imageWorkBlocked(doc.id)) backfillQueue.add(doc.id);
  }
  pumpBackfill();
}

function pumpBackfill(): void {
  if (backfillLoop || backfillQueue.size === 0) return;
  backfillLoop = (async () => {
    for (const docId of backfillQueue) {
      backfillQueue.delete(docId);
      try {
        await backfillDoc(docId);
      } catch (err) {
        console.warn(`[library] ${docId}: backfill of derived images failed: ${(err as Error).message}`);
      }
    }
  })().finally(() => {
    backfillLoop = null;
    pumpBackfill(); // queued while the loop was finishing
  });
}

async function backfillDoc(docId: string): Promise<void> {
  if (imageWorkBlocked(docId)) return;
  const stored = await readStoredDoc(docId);
  if (stored?.status !== 'ready') return;
  const paths = docPaths(docId);
  if (!(await hasMissingDerivedFiles(paths, stored.pageCount))) return;
  // Checked again right before the start (no await in between): an ingest may have begun meanwhile.
  if (imageWorkBlocked(docId)) return;
  backfillRanAt.set(docId, Date.now());
  const run = startImageRun(docId, { docDir: paths.dir, slides: slideFileNames(stored.pageCount), derived: true }, { lowPriority: true });
  try {
    logDerivedResult(docId, await run.done);
  } catch (err) {
    // Stopped by a new ingest, a deletion or shutdown: the next start picks the document up again.
    if (!isImageWorkerStopped(err)) console.warn(`[library] ${docId}: derived images not written: ${(err as Error).message}`);
  }
}

/** Resolves once the backfill has nothing queued or running (tests). */
export async function waitForBackfill(): Promise<void> {
  while (backfillLoop) await backfillLoop;
}

/**
 * Shutdown: empties the backfill queue and stops every image worker that only writes derived images (the
 * backfill's, and those of ingests whose document is ready already); the next start backfills what is
 * missing. Workers of ingests still converting are left alone: they end with the process, and the document
 * (still 'processing') is converted again on the next start.
 */
export async function stopImageWork(): Promise<void> {
  backfillQueue.clear();
  await Promise.all([...imageRuns.keys()].filter((docId) => !isIngestRunning(docId)).map((docId) => stopImageRun(docId)));
  await waitForBackfill();
}

// ---------------------------------------------------------------------------
// Single-instance lock (library/.server.lock, DESIGN §14)
// ---------------------------------------------------------------------------

/** Content of library/.server.lock. */
export interface ServerLockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

/** Another live process holds the library lock. */
export class LibraryLockedError extends Error {
  lockFile: string;
  holder: ServerLockInfo;

  constructor(lockFile: string, holder: ServerLockInfo) {
    super(`easy-study가 이미 이 라이브러리로 실행 중입니다 (pid ${holder.pid}, http://127.0.0.1:${holder.port})`);
    this.name = 'LibraryLockedError';
    this.lockFile = lockFile;
    this.holder = holder;
  }
}

export interface ServerLock {
  readonly file: string;
  /** Records the port the server actually listens on (e.g. after listening on port 0). */
  setPort(port: number): Promise<void>;
  /** Gives the lock up (idempotent); the file is removed once no server of this process holds it. */
  release(): Promise<void>;
}

/** Lock files this process holds, with the number of servers holding each (tests may run several). */
const heldLocks = new Map<string, { holders: number; onExit: () => void }>();
/** Serializes acquisitions within this process (two concurrent starts must not both "replace" the lock). */
const lockQueue = createKeyedQueue();

export function serverLockPath(): string {
  return path.join(libraryDir(), SERVER_LOCK_FILE_NAME);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return isErrnoException(err) && err.code === 'EPERM';
  }
}

function parseLockInfo(raw: string): ServerLockInfo | null {
  try {
    const value = JSON.parse(raw) as Partial<ServerLockInfo> | null;
    if (typeof value !== 'object' || value === null || typeof value.pid !== 'number') return null;
    return {
      pid: value.pid,
      port: typeof value.port === 'number' ? value.port : 0,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * Creates `file` with `content` only if it does not exist yet. A hard link of a complete temporary
 * file makes creation and content one atomic step (a reader never sees an empty lock); filesystems
 * without hard links fall back to an exclusive create.
 */
async function createExclusive(file: string, content: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content);
  try {
    await fs.link(tmp, file);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EEXIST') return false;
    try {
      await fs.writeFile(file, content, { flag: 'wx' });
      return true;
    } catch (fallbackErr) {
      if (isErrnoException(fallbackErr) && fallbackErr.code === 'EEXIST') return false;
      throw fallbackErr;
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Removes the lock file if this process still owns it. */
function removeOwnLockSync(file: string): void {
  try {
    if (parseLockInfo(readFileSync(file, 'utf8'))?.pid === process.pid) unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * Takes library/.server.lock before the server touches the library (startup sweeps, ingests, jobs).
 * Throws LibraryLockedError when another live process holds it; a lock left behind by a process that
 * no longer runs (crash, kill -9) is replaced.
 */
export function acquireServerLock(port: number): Promise<ServerLock> {
  const file = serverLockPath();
  return lockQueue(file, () => lockLibrary(file, port));
}

async function lockLibrary(file: string, port: number): Promise<ServerLock> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info: ServerLockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };

  let held = heldLocks.get(file);
  if (!held) {
    for (let attempt = 0; ; attempt++) {
      if (attempt >= 5) throw new Error(`서버 잠금 파일을 만들 수 없습니다: ${file}`);
      if (await createExclusive(file, `${JSON.stringify(info, null, 2)}\n`)) break;
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (err) {
        if (isNotFound(err)) continue; // released in the meantime: try again
        throw err;
      }
      const holder = parseLockInfo(raw);
      if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid)) throw new LibraryLockedError(file, holder);
      // Stale: its process is gone (or it is unreadable, or an earlier process had our pid).
      console.warn(`[library] replacing a stale lock ${file}${holder ? ` (pid ${holder.pid} is not running)` : ''}`);
      await fs.rm(file, { force: true });
    }
    // Safety net: a forced exit (second Ctrl+C, shutdown timeout) still removes the lock.
    held = { holders: 0, onExit: () => removeOwnLockSync(file) };
    heldLocks.set(file, held);
    process.on('exit', held.onExit);
  }
  held.holders++;
  const entry = held;

  let released = false;
  return {
    file,
    async setPort(actualPort: number) {
      if (released) return;
      const current = parseLockInfo(await fs.readFile(file, 'utf8').catch(() => ''));
      if (current?.pid !== process.pid || current.port === actualPort) return;
      await writeJsonAtomic(file, { ...current, port: actualPort } satisfies ServerLockInfo);
    },
    async release() {
      if (released) return;
      released = true;
      entry.holders--;
      if (entry.holders > 0) return;
      if (heldLocks.get(file) === entry) heldLocks.delete(file);
      process.off('exit', entry.onExit);
      removeOwnLockSync(file);
    },
  };
}
