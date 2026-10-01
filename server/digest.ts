// Digest ("정리본", DESIGN §11): turns a whole deck into reusable text once. An LLM reads the slide
// images a few at a time and writes a faithful per-slide transcription + explanation; when every
// slide has an entry, one more call writes a summary of the lecture (used as course context).
//
// Stored as library/<docId>/digest/digest.json (DigestRecord) and rendered to library/<docId>/DIGEST.md
// (plus the course's COURSE.md). A job persists after every batch, so a crash or an abort keeps the
// finished slides and a later run ("이어서 만들기") only does the missing or failed ones. A forced redo
// ("다시 만들기") keeps every old entry (and the old summary) until a new one replaces it, so an aborted
// or failed redo never loses the digest the student already had.
//
// Every call's token usage (DESIGN §23), failed calls included, is added to the record's `usage`, which
// describes the latest run like its provider / model / startedAt do.
//
// A run is made in the language of the request that started it (DESIGN §27), stored as the record's `lang`: the
// model's figure descriptions, takeaways and summary, the notes of the record and the headings of DIGEST.md.
//
// One job per document at a time. Provider calls are one-shot (resume: null, ephemeral, no tools) and
// never touch the study sessions. All jobs together run at most EASY_STUDY_DIGEST_CONCURRENCY calls at
// a time (a process-wide limit), so opening several lectures does not multiply the load; with a CLI
// provider each call also needs a slot of the CLI process budget (server/cliBudget.ts), where chat turns
// go first.
//
// A new version of the lecture's PDF (DESIGN §28) renumbers the digest (remapDigest): entries of unchanged slides
// follow their slide, the others are dropped for 이어서 만들기 to redo; an undo puts back what the swap dropped.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DigestInfo, DigestSlide, ProviderId, TokenUsage } from '../shared/types.ts';
import { addUsage, totalTokens } from '../shared/usage.ts';
import { defaultChatDeps } from './chat.ts';
import type { ProviderCheck } from './chat.ts';
import { acquireCliSlot } from './cliBudget.ts';
import type { AcquireCliSlot } from './cliBudget.ts';
import { HttpError, digestConcurrency } from './config.ts';
import { courseOf, writeCourseMarkdown } from './courses.ts';
import {
  DIGEST_BATCH_SIZE,
  buildDigestBatchParts,
  buildLectureSummaryParts,
  digestSystemPrompt,
  lectureSummarySystemPrompt,
  parseDigestOutput,
} from './digestPrompt.ts';
import { DEFAULT_LANG, runInLang, slang, smsg } from './i18n.ts';
import type { Lang } from './i18n.ts';
import type { DeckMap, DocAssets, DigestRecord } from './internal-types.ts';
import {
  createKeyedQueue,
  demoteHeadings,
  docPaths,
  isNotFound,
  listStoredDocs,
  loadDocAssets,
  readDigestRecord,
  readJsonFile,
  readStoredDoc,
  rmWithRetry,
  slideFileName,
  sortDigestSlides,
  writeFileAtomic,
  writeJsonAtomic,
} from './library.ts';
import type { Part, Provider } from './providers/types.ts';

/**
 * Provider calls in a row that produced nothing usable (the call threw, or no slide could be parsed)
 * after which a job gives up with status 'error' instead of burning through the whole deck.
 */
const MAX_FAILED_CALLS_IN_A_ROW = 4;

/** The prompt/parse functions of digestPrompt.ts (injectable for tests). */
export interface DigestPrompts {
  batchSize: number;
  systemPrompt: typeof digestSystemPrompt;
  buildBatchParts: typeof buildDigestBatchParts;
  parseOutput: typeof parseDigestOutput;
  summarySystemPrompt: typeof lectureSummarySystemPrompt;
  buildSummaryParts: typeof buildLectureSummaryParts;
}

/** Collaborators of the digest runner; injectable so tests can use fakes. */
export interface DigestDeps {
  getProvider: (id: ProviderId) => Provider | undefined;
  /** Availability of a provider (should be cached). */
  checkProvider: (id: ProviderId) => Promise<ProviderCheck>;
  prompts: DigestPrompts;
  /** Provider calls that all digest jobs together run at the same time (process-wide limit). */
  concurrency: () => number;
  now: () => Date;
  /**
   * The server-wide budget of LLM CLI processes (DESIGN §15), shared with chat turns, which go first.
   * Omitted = no limit beyond `concurrency`.
   */
  cliSlot?: AcquireCliSlot;
}

export const DEFAULT_DIGEST_PROMPTS: Readonly<DigestPrompts> = Object.freeze({
  batchSize: DIGEST_BATCH_SIZE,
  systemPrompt: digestSystemPrompt,
  buildBatchParts: buildDigestBatchParts,
  parseOutput: parseDigestOutput,
  summarySystemPrompt: lectureSummarySystemPrompt,
  buildSummaryParts: buildLectureSummaryParts,
});

/** The real provider registry (same availability check as chat turns) and digestPrompt.ts. */
export function defaultDigestDeps(): DigestDeps {
  const chat = defaultChatDeps();
  return {
    getProvider: chat.getProvider,
    checkProvider: chat.checkProvider,
    prompts: DEFAULT_DIGEST_PROMPTS,
    concurrency: digestConcurrency,
    now: () => new Date(),
    cliSlot: acquireCliSlot,
  };
}

export interface StartDigestOptions {
  provider: ProviderId;
  /** '' or omitted = provider default. */
  model?: string;
  /** Reasoning effort; '' or omitted = the CLI's default. */
  effort?: string;
  /** Redo every slide (otherwise only slides without a successful entry are done). */
  force?: boolean;
}

interface DigestJob {
  controller: AbortController;
  finished: Promise<void>;
  /** The job's working copy (authoritative while it runs); null until the job has read the old record. */
  record: DigestRecord | null;
  /**
   * Forced redo only: slides not redone yet (their old entries are still in `record`). Progress of a
   * redo is counted from this set, since every slide keeps an entry the whole time.
   */
  redo: Set<number> | null;
  /** The language the job runs in (DigestRecord.lang). */
  lang: Lang;
}

const jobs = new Map<string, DigestJob>();
/** Serializes writes of digest.json / DIGEST.md per document. */
const persistQueue = createKeyedQueue();
/** Holders of lockDigest per document: its deck is being swapped for a new version (DESIGN §28). */
const swapLocks = new Map<string, number>();
/** lockDigest calls so far per document, so a start that read the deck before a swap never runs after it. */
const swapCounts = new Map<string, number>();

// ---------------------------------------------------------------------------
// Process-wide limit on digest provider calls
// ---------------------------------------------------------------------------

interface SlotWaiter {
  limit: number;
  grant: () => void;
}

/** Digest provider calls running right now, across all jobs. */
let callsInFlight = 0;
/** Calls waiting for a slot, first come first served. */
const slotWaiters: SlotWaiter[] = [];

function pumpCallSlots(): void {
  while (slotWaiters.length > 0 && callsInFlight < slotWaiters[0].limit) {
    slotWaiters.shift()?.grant();
  }
}

/**
 * Waits for one of the `limit` process-wide call slots; resolves with its release function. Rejects
 * (and leaves the queue) when `signal` aborts first, so aborting a queued job never waits for others.
 */
function acquireCallSlot(limit: number, signal: AbortSignal): Promise<() => void> {
  const max = Math.max(1, Math.floor(limit) || 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    callsInFlight--;
    pumpCallSlots();
  };
  const aborted = () => (signal.reason instanceof Error ? signal.reason : new Error(smsg().chat.digest.aborted));
  if (signal.aborted) return Promise.reject(aborted());
  if (slotWaiters.length === 0 && callsInFlight < max) {
    callsInFlight++;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const index = slotWaiters.indexOf(waiter);
      if (index !== -1) slotWaiters.splice(index, 1);
      reject(aborted());
      pumpCallSlots(); // the next waiter may have a larger limit
    };
    const waiter: SlotWaiter = {
      limit: max,
      grant: () => {
        signal.removeEventListener('abort', onAbort);
        callsInFlight++;
        resolve(release);
      },
    };
    slotWaiters.push(waiter);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Digest provider calls running right now, across all jobs (for tests and diagnostics). */
export function digestCallsInFlight(): number {
  return callsInFlight;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function toInfo(docId: string, pageCount: number, record: DigestRecord | null, job: DigestJob | undefined): DigestInfo {
  const markdownPath = docPaths(docId).digestMd;
  if (!record) {
    return { docId, status: job ? 'running' : 'none', done: 0, total: pageCount, slides: [], summary: null, markdownPath };
  }
  const slides = record.slides.filter((entry) => entry.slide <= pageCount).map((entry) => ({ ...entry }));
  let status = record.status;
  if (job && !job.record) status = 'running'; // the job is still reading the previous record
  // 'running' on disk without a job is a leftover of a crash (the startup sweep rewrites it).
  else if (!job && status === 'running') status = 'aborted';
  // A forced redo keeps the old entries until they are replaced: its progress is what it redid.
  const done = job?.redo ? Math.max(0, pageCount - job.redo.size) : slides.length;
  const info: DigestInfo = { docId, status, done, total: pageCount, slides, summary: record.summary, markdownPath };
  if (record.provider) info.provider = record.provider;
  if (record.model !== undefined) info.model = record.model;
  if (record.effort) info.effort = record.effort;
  if (record.error) info.error = record.error;
  if (record.startedAt) info.startedAt = record.startedAt;
  if (record.updatedAt) info.updatedAt = record.updatedAt;
  if (record.usage) info.usage = { ...record.usage };
  return info;
}

/** Digest state of a document (status 'none' when there is none). Throws 404 for unknown documents. */
export async function getDigestInfo(docId: string): Promise<DigestInfo> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  const job = jobs.get(docId);
  const record = job?.record ?? (await readDigestRecord(docId));
  return toInfo(docId, doc.pageCount, record, job);
}

export function isDigestRunning(docId: string): boolean {
  return jobs.has(docId);
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

/**
 * Starts (or resumes, or with `force` redoes) the digest of a ready document in the background and
 * returns its state (status 'running'). Throws 404 (unknown document), 409 (document not ready, a
 * digest job already running or its deck being swapped) or 400 (unknown / unavailable provider).
 */
export async function startDigest(
  docId: string,
  options: StartDigestOptions,
  deps: DigestDeps = defaultDigestDeps(),
): Promise<DigestInfo> {
  const m = smsg();
  const swapsBefore = swapCounts.get(docId) ?? 0;
  const provider = deps.getProvider(options.provider);
  if (!provider) throw new HttpError(400, m.chat.providers.unknownProvider(String(options.provider)));
  const assets = await loadDocAssets(docId);
  const check = await deps.checkProvider(provider.id);
  if (!check.available) throw new HttpError(400, m.chat.providers.unavailable(provider.label, check.reason ?? ''));

  // Check-and-reserve without an await in between, so concurrent requests cannot both start a job.
  if (jobs.has(docId)) throw new HttpError(409, m.chat.digest.alreadyRunning);
  // A new version of the deck is being put in, or was while the deck above was read (DESIGN §28).
  if (swapLocks.has(docId) || (swapCounts.get(docId) ?? 0) !== swapsBefore) throw new HttpError(409, m.library.versions.swapping);
  let markFinished = () => {};
  const job: DigestJob = {
    controller: new AbortController(),
    record: null,
    redo: null,
    lang: slang(), // settled below, once the previous record is read
    finished: new Promise<void>((resolve) => {
      markFinished = resolve;
    }),
  };
  jobs.set(docId, job);
  const release = () => {
    jobs.delete(docId);
    markFinished();
  };

  const pageCount = assets.meta.pageCount;
  let courseTitle: string | null;
  try {
    // Read the previous record only now: with the reservation held no other job can be writing it.
    const [previous, course] = await Promise.all([readDigestRecord(docId), courseOf(docId)]);
    courseTitle = course?.title ?? null;
    const now = deps.now().toISOString();
    // Even a forced redo starts from the previous entries and summary: each is kept until a new one
    // replaces it, so an aborted or failed redo leaves a complete digest behind.
    const slides = (previous?.slides ?? []).filter((entry) => entry.slide <= pageCount);
    // A run that continues earlier entries fills in the rest in their language (older records: Korean), so one
    // digest never mixes two; only a redo, or a first run, takes the language of the request.
    if (!options.force && previous && slides.length > 0) job.lang = previous.lang ?? DEFAULT_LANG;
    const record: DigestRecord = {
      version: 1,
      status: 'running',
      provider: provider.id,
      model: (options.model ?? '').trim() || provider.defaultModel,
      startedAt: now,
      updatedAt: now,
      slides,
      summary: previous?.summary ?? null,
      lang: job.lang,
    };
    const effort = (options.effort ?? '').trim();
    if (effort) record.effort = effort;
    if (previous && (previous.summaryStale || summaryFailedLastTime(previous))) record.summaryStale = true;
    job.redo = options.force ? new Set(Array.from({ length: pageCount }, (_, i) => i + 1)) : null;
    job.record = record;
    await persist(docId, assets, record);
  } catch (err) {
    release();
    throw err;
  }

  const info = toInfo(docId, pageCount, job.record, job);
  console.log(
    `[digest] ${docId}: ${options.force ? 'redo ' : ''}started with ${provider.id}${job.record.model ? ` (${job.record.model})` : ''}` +
      (job.record.effort ? `, effort ${job.record.effort}` : ''),
  );
  const record = job.record;
  void runInLang(job.lang, () => runJob(docId, job, record, { assets, provider, courseTitle, deps })).finally(release);
  return info;
}

/**
 * The run that wrote `record` could not (re)write the lecture summary: a 'ready' digest without failed
 * slides carries a note only then. New records also say so with `summaryStale`; records written before it
 * existed only have the note, and the UI offers a summary-only run for exactly this state.
 */
function summaryFailedLastTime(record: DigestRecord): boolean {
  return record.status === 'ready' && !!record.error && record.slides.every((entry) => !entry.failed);
}

/** Aborts the running digest job of a document (finished slides are kept). False when none runs. */
export function abortDigest(docId: string): boolean {
  const job = jobs.get(docId);
  if (!job) return false;
  job.controller.abort(new Error(smsg().chat.digest.abortedByUser));
  return true;
}

/** Aborts every running digest job (server shutdown). Returns how many were aborted. */
export function abortAllDigests(): number {
  for (const job of jobs.values()) job.controller.abort(new Error(smsg(job.lang).chat.digest.abortedByShutdown));
  return jobs.size;
}

function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Resolves true once the document's job (if any) has finished and persisted, false on timeout. */
export function waitForDigest(docId: string, timeoutMs = 60_000): Promise<boolean> {
  const job = jobs.get(docId);
  return job ? withTimeout(job.finished, timeoutMs) : Promise.resolve(true);
}

/** Resolves true once no digest job is running, false on timeout. */
export function waitForDigestsIdle(timeoutMs: number): Promise<boolean> {
  return withTimeout(Promise.all([...jobs.values()].map((job) => job.finished)), timeoutMs);
}

/**
 * Startup sweep: a record left in 'running' (the server stopped mid-job) becomes 'aborted', so the
 * user can resume it; finished slides are kept. Returns how many records were changed.
 */
export async function recoverInterruptedDigests(): Promise<number> {
  let recovered = 0;
  for (const doc of await listStoredDocs()) {
    if (jobs.has(doc.id)) continue;
    const record = await readDigestRecord(doc.id);
    if (record?.status !== 'running') continue;
    record.status = 'aborted';
    // In the language the run was made in (there is no request at startup).
    record.error = smsg(record.lang ?? 'ko').chat.digest.interrupted;
    await persistQueue(doc.id, () => writeJsonAtomic(docPaths(doc.id).digestJson, record));
    recovered++;
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

interface JobContext {
  assets: DocAssets;
  provider: Provider;
  courseTitle: string | null;
  deps: DigestDeps;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name !== 'AbortError' && reason.message) return reason.message;
  return smsg().chat.digest.aborted;
}

/** Slides in runs of consecutive numbers, each run cut into batches of at most `size`. */
export function planBatches(slides: number[], size: number): number[][] {
  const limit = Math.max(1, Math.floor(size));
  const batches: number[][] = [];
  let current: number[] = [];
  for (const slide of [...new Set(slides)].sort((a, b) => a - b)) {
    const last = current.at(-1);
    if (last !== undefined && (current.length >= limit || slide !== last + 1)) {
      batches.push(current);
      current = [];
    }
    current.push(slide);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Runs `worker` over `items` with at most `limit` in flight; stops taking new items once `stop()` is true. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>, stop: () => boolean): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, async () => {
    while (next < items.length && !stop()) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

interface Attempt {
  /** Successfully parsed entries of the requested slides. */
  good: DigestSlide[];
  /** Entries the parser gave up on (they carry a placeholder), by slide. */
  failed: Map<number, DigestSlide>;
  /** The provider error, when the call threw. */
  error: string | null;
}

function cleanEntry(entry: DigestSlide): DigestSlide {
  const clean: DigestSlide = { slide: entry.slide, title: entry.title.replace(/\s+/g, ' ').trim(), markdown: entry.markdown.trim() };
  if (entry.failed) clean.failed = true;
  return clean;
}

async function runJob(docId: string, job: DigestJob, record: DigestRecord, ctx: JobContext): Promise<void> {
  const { assets, provider, courseTitle, deps } = ctx;
  const { prompts } = deps;
  const signal = job.controller.signal;
  const pageCount = assets.meta.pageCount;
  const deckTitle = assets.meta.title;
  const stamp = () => {
    record.updatedAt = deps.now().toISOString();
  };

  let succeeded = 0; // slides this job digested successfully
  let attempted = 0; // slides this job sent to the provider
  let firstError: string | null = null;
  let failedCallsInARow = 0;
  let streakError: string | null = null;
  let fatal: string | null = null;
  const stopped = () => signal.aborted || fatal !== null;

  const noteCall = (useful: boolean, error: string) => {
    if (useful) {
      failedCallsInARow = 0;
      streakError = null;
      return;
    }
    firstError ??= error;
    streakError ??= error;
    failedCallsInARow++;
    if (failedCallsInARow >= MAX_FAILED_CALLS_IN_A_ROW) fatal ??= streakError;
  };

  /** Stores this job's entries for some slides (the slides are then done, even when they failed). */
  const store = (entries: DigestSlide[]) => {
    for (const entry of entries) job.redo?.delete(entry.slide);
    const usableBefore = new Set(record.slides.filter((entry) => !entry.failed).map((entry) => entry.slide));
    // A failed attempt never replaces a usable entry (a forced redo keeps the old one).
    const accepted = entries.map(cleanEntry).filter((entry) => !entry.failed || !usableBefore.has(entry.slide));
    if (accepted.length === 0) return;
    record.slides = sortDigestSlides([...record.slides, ...accepted]);
    const usable = accepted.filter((entry) => !entry.failed).length;
    succeeded += usable;
    // The summary was written from other entries: it must be regenerated (persisted, so a later run
    // still does it when this one is interrupted before its summary step).
    if (usable > 0) record.summaryStale = true;
    stamp();
  };

  /** One provider call (waits for a digest slot, then a CLI process slot); resolves with the answer text. */
  const call = async (systemPrompt: string, parts: Part[]): Promise<string> => {
    const release = await acquireCallSlot(deps.concurrency(), signal);
    let releaseCli: (() => void) | null = null;
    let usage: TokenUsage | undefined;
    try {
      if (provider.kind === 'cli' && deps.cliSlot) releaseCli = await deps.cliSlot('digest', signal);
      let streamed = '';
      const result = await provider.run({
        cwd: assets.dir,
        systemPrompt,
        parts,
        resume: null,
        history: [],
        model: record.model ?? '',
        effort: record.effort ?? '',
        ephemeral: true,
        // The slide images are attached; the model has no reason to run commands or read files.
        allowTools: false,
        signal,
        onDelta: (text) => {
          streamed += text;
        },
        onStatus: () => {},
        onUsage: (reported) => {
          usage = reported;
        },
      });
      return result.text.trim() ? result.text : streamed;
    } finally {
      releaseCli?.();
      release();
      // Persisted with the batch (or at the end of the run).
      if (usage && totalTokens(usage) > 0) record.usage = addUsage(record.usage, usage);
    }
  };

  /** Digests `slides` in one call. Never throws; an aborted call resolves with nothing. */
  const attempt = async (slides: number[]): Promise<Attempt> => {
    attempted += slides.length;
    const parts = prompts.buildBatchParts({
      deckTitle,
      pageCount,
      courseTitle,
      slides: slides.map((slide) => ({ slide, imagePath: assets.slidePath(slide), text: assets.texts[slide - 1] ?? '' })),
    });
    let output: string;
    try {
      output = await call(prompts.systemPrompt(), parts);
    } catch (err) {
      if (signal.aborted) return { good: [], failed: new Map(), error: null };
      const message = errorText(err);
      console.warn(`[digest] ${docId}: slides ${slides.join(',')} failed: ${message}`);
      noteCall(false, message);
      return { good: [], failed: new Map(), error: message };
    }
    const wanted = new Set(slides);
    const parsed = prompts.parseOutput(output, slides).filter((entry) => wanted.has(entry.slide));
    const good = parsed.filter((entry) => !entry.failed && entry.markdown.trim() !== '');
    const failed = new Map(parsed.filter((entry) => entry.failed).map((entry) => [entry.slide, entry] as const));
    noteCall(good.length > 0, smsg().chat.digest.notInOutput(slides));
    return { good, failed, error: null };
  };

  const processBatch = async (batch: number[]) => {
    const first = await attempt(batch);
    store(first.good);
    const done = new Set(first.good.map((entry) => entry.slide));
    // Slides missing from the output get one more chance each, alone.
    for (const slide of batch.filter((candidate) => !done.has(candidate))) {
      if (stopped()) break;
      const retry = await attempt([slide]);
      if (signal.aborted) break;
      if (retry.good.length > 0) {
        store(retry.good);
        continue;
      }
      const reason = retry.error ?? first.error;
      const parsedFailure = retry.failed.get(slide) ?? first.failed.get(slide);
      store([
        parsedFailure ?? {
          slide,
          title: '',
          markdown: `_(${smsg().chat.digest.slideFailed(reason ? reason.replace(/\s+/g, ' ') : '')})_`,
          failed: true,
        },
      ]);
    }
    await persist(docId, assets, record);
  };

  try {
    const todo: number[] = [];
    const good = new Set(record.slides.filter((entry) => !entry.failed).map((entry) => entry.slide));
    for (let slide = 1; slide <= pageCount; slide++) if (job.redo?.has(slide) || !good.has(slide)) todo.push(slide);

    const batches = planBatches(todo, prompts.batchSize);
    await runPool(
      batches,
      deps.concurrency(),
      (batch) =>
        processBatch(batch).catch((err: unknown) => {
          // Not a provider failure (those are handled per call): e.g. the disk is full.
          fatal ??= errorText(err);
        }),
      stopped,
    );

    let summaryError: string | null = null;
    const entries = new Set(record.slides.map((entry) => entry.slide));
    const everySlideHasEntry = pageCount > 0 && Array.from({ length: pageCount }, (_, i) => i + 1).every((n) => entries.has(n));
    const usable = record.slides.filter((entry) => !entry.failed);
    // `summaryStale` is persisted, so a summary that an earlier run could not (re)write is made now.
    if (!stopped() && everySlideHasEntry && usable.length > 0 && (record.summaryStale === true || !record.summary)) {
      try {
        const text = await call(prompts.summarySystemPrompt(), prompts.buildSummaryParts({ deckTitle, courseTitle, digest: usable }));
        if (text.trim()) {
          record.summary = text.trim();
          delete record.summaryStale;
        } else {
          summaryError = smsg().chat.digest.emptySummary;
        }
      } catch (err) {
        if (!signal.aborted) summaryError = errorText(err);
      }
    }

    if (signal.aborted) {
      record.status = 'aborted';
      record.error = abortReason(signal);
    } else if (fatal !== null) {
      record.status = 'error';
      record.error = fatal;
    } else if (attempted > 0 && succeeded === 0) {
      record.status = 'error';
      record.error = firstError ?? smsg().chat.digest.failed;
    } else {
      record.status = 'ready';
      const notes: string[] = [];
      const failedSlides = record.slides.filter((entry) => entry.failed).map((entry) => entry.slide);
      if (failedSlides.length > 0) {
        notes.push(smsg().chat.digest.slidesFailed(failedSlides));
      }
      if (summaryError) notes.push(smsg().chat.digest.summaryFailed(summaryError));
      if (notes.length > 0) record.error = notes.join(' / ');
      else delete record.error;
    }
  } catch (err) {
    record.status = 'error';
    record.error = errorText(err);
    console.error(`[digest] ${docId}: job failed:`, err);
  }

  stamp();
  try {
    await persist(docId, assets, record);
  } catch (err) {
    console.error(`[digest] ${docId}: could not save the digest:`, err);
  }
  console.log(`[digest] ${docId}: ${record.status} (${record.slides.length}/${pageCount} slides)${record.error ? ` — ${record.error}` : ''}`);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * DIGEST.md: `# <title> — 정리본`, the lecture summary, then every slide's entry (DESIGN §11). Its headings are in the
 * language the digest was made in (DigestRecord.lang, Korean for older records).
 */
export function digestMarkdown(title: string, pageCount: number, record: DigestRecord): string {
  const m = smsg(record.lang ?? 'ko').chat.digest.markdown;
  const slides = record.slides.filter((entry) => entry.slide <= pageCount);
  const lines: string[] = [`# ${m.title(title)}`, ''];
  if (slides.length < pageCount) lines.push(`_(${m.incomplete(slides.length, pageCount)})_`, '');
  if (record.summary?.trim()) lines.push(`## ${m.summary}`, '', demoteHeadings(record.summary.trim(), 2), '');
  for (const entry of slides) {
    lines.push(
      entry.title ? `## Slide ${entry.slide} · ${entry.title}` : `## Slide ${entry.slide}`,
      '',
      `![slide ${entry.slide}](slides/${slideFileName(entry.slide, pageCount)})`,
      '',
    );
    if (entry.failed) lines.push(`> ${m.slideFailed}`, '');
    lines.push(demoteHeadings(entry.markdown.trim(), 2), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * DIGEST.md again from digest.json, with the lecture's current title (after a rename). Nothing without a digest; a
 * digest being made writes it with the new title when it saves, a deck being swapped when it is renumbered.
 */
export async function rewriteDigestMarkdown(docId: string): Promise<void> {
  if (jobs.has(docId) || swapLocks.has(docId)) return;
  const [doc, record] = await Promise.all([readStoredDoc(docId), readDigestRecord(docId)]);
  if (!doc || !record) return;
  await persistQueue(docId, () => writeFileAtomic(docPaths(docId).digestMd, digestMarkdown(doc.title, doc.pageCount, record)));
}

/** Writes digest.json + DIGEST.md, then the course's COURSE.md (its summaries may have changed). */
async function persist(docId: string, assets: DocAssets, record: DigestRecord): Promise<void> {
  const paths = docPaths(docId);
  // Serialized per document; the record is serialized when the write runs, so the latest state wins.
  await persistQueue(docId, async () => {
    await fs.mkdir(paths.digestDir, { recursive: true });
    await writeJsonAtomic(paths.digestJson, record);
    // The title as it is now: the lecture may have been renamed while the digest ran.
    const title = (await readStoredDoc(docId))?.title ?? assets.meta.title;
    await writeFileAtomic(paths.digestMd, digestMarkdown(title, assets.meta.pageCount, record));
  });
  try {
    const course = await courseOf(docId);
    if (course) await writeCourseMarkdown(course.id);
  } catch (err) {
    console.error(`[digest] ${docId}: could not update COURSE.md:`, err);
  }
}

/** DIGEST.md of a document, regenerated from digest.json when missing. Null when there is no digest. */
export async function readDigestMarkdown(docId: string): Promise<string | null> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  const paths = docPaths(docId);
  try {
    return await fs.readFile(paths.digestMd, 'utf8');
  } catch {
    // Missing (e.g. deleted by hand): rebuild it from the record below.
  }
  const record = jobs.get(docId)?.record ?? (await readDigestRecord(docId));
  if (!record) return null;
  const markdown = digestMarkdown(doc.title, doc.pageCount, record);
  // Not while the deck is swapped: the record read above may be about to be renumbered.
  if (!swapLocks.has(docId)) await persistQueue(docId, () => writeFileAtomic(paths.digestMd, markdown));
  return markdown;
}

// ---------------------------------------------------------------------------
// A new version of the deck (DESIGN §28)
// ---------------------------------------------------------------------------

/**
 * Holds the digest of a lecture while its deck is swapped for a new version (or back): no job starts (409) and
 * DIGEST.md is not rewritten until the returned function releases it (idempotent). Synchronous, so the swap can take it
 * with its other gates; throws 409 while a job runs.
 */
export function lockDigest(docId: string): () => void {
  if (jobs.has(docId)) throw new HttpError(409, smsg().library.versions.busyDigest);
  swapLocks.set(docId, (swapLocks.get(docId) ?? 0) + 1);
  swapCounts.set(docId, (swapCounts.get(docId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const held = (swapLocks.get(docId) ?? 1) - 1;
    if (held > 0) swapLocks.set(docId, held);
    else swapLocks.delete(docId);
  };
}

/** digest/deck.json {rev}: the deckRev the digest was last renumbered to (absent = never). */
function deckMarkPath(docId: string): string {
  return path.join(docPaths(docId).digestDir, 'deck.json');
}

/** digest/digest-r<rev>.json: the record as it was in deck `rev`, before the swap from it (an undo's source). */
function snapshotPath(docId: string, rev: number): string {
  return path.join(docPaths(docId).digestDir, `digest-r${rev}.json`);
}

async function readSnapshot(docId: string, rev: number): Promise<DigestRecord | null> {
  const value = await readJsonFile<DigestRecord>(snapshotPath(docId, rev));
  return value && Array.isArray(value.slides) ? value : null;
}

/** Removes the snapshots except the one of deck `keep` (null = all of them). */
async function removeSnapshots(docId: string, keep: number | null): Promise<void> {
  const dir = docPaths(docId).digestDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  for (const name of names) {
    const rev = /^digest-r(\d+)\.json$/.exec(name)?.[1];
    if (rev !== undefined && Number(rev) !== keep) await rmWithRetry(path.join(dir, name), { force: true });
  }
}

/** No job runs during a swap: 'running' on disk is a leftover of a crash, as at startup. */
function settleInterrupted(record: DigestRecord): void {
  if (record.status !== 'running') return;
  record.status = 'aborted';
  record.error = smsg(record.lang ?? 'ko').chat.digest.interrupted;
}

/**
 * `before` (numbered in deck map.fromRev) in the numbering of map.toRev: entries of the slides that continue an old
 * slide unchanged are renumbered, the others dropped. Unless every slide kept its number and content, the summary is
 * stale and the note says how many slides to redo (never old numbers). An undo with `restored`, the record from before
 * the apply, takes back its entries for the slides that are not unchanged, its summary and its state.
 */
function remapRecord(before: DigestRecord, map: DeckMap, restored: DigestRecord | null): DigestRecord {
  const slides: DigestSlide[] = [];
  for (const entry of before.slides) {
    const slide = entry.slide <= map.oldPageCount ? (map.oldToNew[entry.slide - 1] ?? null) : null;
    if (slide !== null && !map.changed.has(slide) && !map.added.has(slide)) slides.push({ ...entry, slide });
  }
  const record: DigestRecord = { ...before, slides: sortDigestSlides(slides) };
  settleInterrupted(record);
  const lang = record.lang ?? 'ko';
  if (restored) {
    // Restored in its own language when a redo changed it since, so one digest never mixes two.
    const whole = (restored.lang ?? 'ko') !== lang;
    const old = restored.slides.filter((entry) => entry.slide <= map.newPageCount);
    record.slides = sortDigestSlides(whole ? old : [...old, ...record.slides]);
    record.summary = restored.summary;
    if (restored.summaryStale) record.summaryStale = true;
    else delete record.summaryStale;
    record.status = restored.status;
    if (restored.error) record.error = restored.error;
    else delete record.error;
    if (whole) {
      if (restored.lang) record.lang = restored.lang;
      else delete record.lang;
    }
    settleInterrupted(record);
    return record;
  }
  const unchanged =
    map.oldPageCount === map.newPageCount &&
    map.changed.size === 0 &&
    map.added.size === 0 &&
    map.oldToNew.every((slide, index) => slide === index + 1);
  if (!unchanged) {
    record.summaryStale = true;
    record.error = smsg(lang).chat.digest.newVersion(map.changed.size + map.added.size);
  }
  return record;
}

/**
 * Renumbers the digest for a new version of the deck, or back for an undo (DESIGN §28 "Remaps › Digest"). The record
 * before is kept as digest/digest-r<fromRev>.json; an undo (map.restoreRev) takes back what the apply dropped from
 * digest-r<restoreRev>.json, and no snapshot is left. Then DIGEST.md (with `title`) and COURSE.md. Nothing without a
 * digest. Idempotent through digest/deck.json: a swap resumed after a crash remaps the snapshot it kept, never its own
 * result. Runs while lockDigest holds the lecture, so no job is writing the record.
 */
export async function remapDigest(docId: string, map: DeckMap, title: string): Promise<void> {
  if (jobs.has(docId)) throw new HttpError(409, smsg().library.versions.busyDigest);
  const paths = docPaths(docId);
  const remapped = await persistQueue(docId, async () => {
    const current = await readDigestRecord(docId);
    if (!current) return false;
    const mark = await readJsonFile<{ rev?: unknown }>(deckMarkPath(docId));
    if (mark?.rev !== map.toRev) {
      let before = await readSnapshot(docId, map.fromRev);
      if (!before) {
        before = current;
        await writeJsonAtomic(snapshotPath(docId, map.fromRev), before);
      }
      const restored = map.restoreRev === undefined ? null : await readSnapshot(docId, map.restoreRev);
      const record = remapRecord(before, map, restored);
      await writeJsonAtomic(paths.digestJson, record);
      await writeFileAtomic(paths.digestMd, digestMarkdown(title, map.newPageCount, record));
      await writeJsonAtomic(deckMarkPath(docId), { rev: map.toRev });
    }
    // An apply keeps its snapshot for the undo (older ones can no longer be undone); an undo consumes them.
    await removeSnapshots(docId, map.restoreRev === undefined ? map.fromRev : null);
    return true;
  });
  if (!remapped) return;
  try {
    const course = await courseOf(docId);
    if (course) await writeCourseMarkdown(course.id);
  } catch (err) {
    console.error(`[digest] ${docId}: could not update COURSE.md:`, err);
  }
}
