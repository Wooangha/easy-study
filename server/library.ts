// The on-disk library: PDF import, the background ingest pipeline (poppler + sharp),
// document metadata, read access to course and digest files, and a few filesystem helpers
// shared with sessions.ts / courses.ts / digest.ts.
//
// Layout (docs/DESIGN.md §2, §11, §12):
//   library/<docId>/doc.json, source.pdf, slides/NNN.png, sheets/sheet-NN.png, sheets/sheets.json,
//   text/NNN.txt, sessions/<sid>.json, notes/<sid>.md, STUDY_NOTES.md,
//   digest/digest.json, DIGEST.md
//   library/courses/<courseId>/course.json, COURSE.md
//
// Course and digest files are *read* here (DocMeta.courseId / digestStatus and DocAssets are derived
// from them) but written only by courses.ts and digest.ts, which import this module — never the
// other way round.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import { COURSE_ID_RE, DOC_ID_RE } from '../shared/types.ts';
import type { DigestSlide, DigestStatus, DocMeta } from '../shared/types.ts';
import { HttpError, libraryDir } from './config.ts';
import type { CourseContext, CourseLectureRef, CourseRecord, DigestRecord, DocAssets } from './internal-types.ts';

export const POPPLER_MISSING_MESSAGE = 'poppler is not installed (brew install poppler)';

const RENDER_LONG_EDGE = 1600;
const SLIDES_PER_SHEET = 4;
const SHEET_CELL_WIDTH = 800;
const SHEET_GUTTER = 8;
const SHEET_MAX_EDGE = 1600;
const PROGRESS_POLL_MS = 400;
const MAX_TITLE_CHARS = 200;

/** Directory of library/ that holds the courses; never a document (DOC_ID_RE would accept the name). */
export const COURSES_DIR_NAME = 'courses';

const DIGEST_STATUSES: ReadonlySet<DigestStatus> = new Set<DigestStatus>(['none', 'running', 'ready', 'error', 'aborted']);

// Slides are re-rendered in place when an ingest is resumed; never serve stale decoded files.
sharp.cache({ files: 0 });

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

/** Entry of sheets/sheets.json. */
export interface SheetEntry {
  file: string;
  fromSlide: number;
  toSlide: number;
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

/** Writes `<file>.<unique>.tmp` and renames it over `file`, so readers never see a partial file. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
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

/** PATH with the usual Homebrew locations appended (GUI-launched shells often lack them). */
function toolEnv(): NodeJS.ProcessEnv {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dirs.includes(extra)) dirs.push(extra);
  }
  return { ...process.env, PATH: dirs.join(path.delimiter) };
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
    const child = spawn(tool, args, { env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
const activeIngests = new Map<string, Promise<void>>();

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
  if (!isDocId(docId)) return null;
  const meta = await readJsonFile<StoredDocMeta & Partial<DocMeta>>(docPaths(docId).docJson);
  return typeof meta === 'object' && meta !== null ? toStoredMeta(meta, docId) : null;
}

/** Metadata of a document, or null when the id is invalid or the document does not exist. */
export async function getDoc(docId: string): Promise<DocMeta | null> {
  const stored = await readStoredDoc(docId);
  if (!stored) return null;
  const [courses, digest] = await Promise.all([readCourseRecords(), readDigestRecord(docId)]);
  return withDerivedFields(stored, courseIdIndex(courses), digest);
}

function withDerivedFields(stored: StoredDocMeta, courseIds: Map<string, string>, digest: DigestRecord | null): DocMeta {
  return { ...stored, courseId: courseIds.get(stored.id) ?? null, digestStatus: digest?.status ?? 'none' };
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
  return Promise.all(stored.map(async (meta) => withDerivedFields(meta, courseIds, await readDigestRecord(meta.id))));
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
  const meta = withDerivedFields(stored, courseIds, digestRecord);
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
  return record;
}

/** digest/digest.json of a document, or null when there is none (or the id is invalid). */
export async function readDigestRecord(docId: string): Promise<DigestRecord | null> {
  if (!isDocId(docId)) return null;
  return normalizeDigestRecord(await readJsonFile<unknown>(docPaths(docId).digestJson));
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
// Ingest pipeline (DESIGN §3)
// ---------------------------------------------------------------------------

/** Starts (or joins) the ingest of a document. The promise never rejects; failures end in status 'error'. */
function startIngest(docId: string): Promise<void> {
  const running = activeIngests.get(docId);
  if (running) return running;
  const run = ingest(docId).finally(() => activeIngests.delete(docId));
  activeIngests.set(docId, run);
  return run;
}

/** Resolves when the running ingest of `docId` (if any) has finished. */
export function waitForIngest(docId: string): Promise<void> {
  return activeIngests.get(docId) ?? Promise.resolve();
}

/** Re-processes documents left in `processing` (e.g. the server stopped mid-ingest). */
export async function resumePendingIngests(): Promise<void> {
  const pending = (await listStoredDocs()).filter((doc) => doc.status === 'processing');
  // One at a time: rendering is CPU heavy and this runs while the server starts.
  for (const doc of pending) {
    console.log(`[library] resuming ingest of ${doc.id}`);
    await startIngest(doc.id);
  }
}

async function ingest(docId: string): Promise<void> {
  const paths = docPaths(docId);
  try {
    await updateMeta(docId, { status: 'processing', progress: 0, error: undefined });
    // Start from a clean slate: a resumed ingest may have left partial output behind.
    for (const dir of [paths.slidesDir, paths.sheetsDir, paths.textDir]) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
    }

    const info = await readPdfInfo(paths.sourcePdf);
    await updateMeta(docId, { pageCount: info.pageCount, aspectRatio: info.aspectRatio });

    await renderSlides(docId, paths, info.pageCount);
    // The rendered image is authoritative (it accounts for rotation, crop boxes, ...).
    const aspectRatio = await imageAspectRatio(path.join(paths.slidesDir, slideFileName(1, info.pageCount)), info.aspectRatio);

    await extractTexts(paths, info.pageCount);
    await buildContactSheets(paths, info.pageCount, aspectRatio);

    await updateMeta(docId, { status: 'ready', progress: info.pageCount, pageCount: info.pageCount, aspectRatio });
    console.log(`[library] ${docId}: ready (${info.pageCount} slides)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[library] ingest of ${docId} failed: ${message}`);
    await updateMeta(docId, { status: 'error', error: message }).catch((writeErr: unknown) => {
      console.error(`[library] could not record the failure of ${docId}:`, writeErr);
    });
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

async function imageAspectRatio(file: string, fallback: number): Promise<number> {
  const { width, height } = await sharp(file).metadata();
  return width && height ? width / height : fallback;
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
    if (n >= 1 && n <= pageCount) await fs.rename(from, path.join(paths.slidesDir, slideFileName(n, pageCount)));
    else await fs.rm(from, { force: true });
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

interface SlideLabel {
  svg: Buffer;
  height: number;
}

/** SVG badge "Slide N" (dark, white bold text) for the label band above a sheet cell. */
function slideLabel(slide: number, fontSize: number): SlideLabel {
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
async function buildContactSheets(paths: DocPaths, pageCount: number, aspectRatio: number): Promise<void> {
  const cellWidth = SHEET_CELL_WIDTH;
  const imageHeight = Math.max(1, Math.round(cellWidth / aspectRatio));
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
      const image = await sharp(path.join(paths.slidesDir, slideFileName(slide, pageCount)))
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
    await sharp(composed)
      .resize({ width: SHEET_MAX_EDGE, height: SHEET_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(path.join(paths.sheetsDir, file));
    entries.push({ file, fromSlide, toSlide });
  }

  await writeJsonAtomic(paths.sheetsJson, entries);
}
