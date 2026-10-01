// A new version of a lecture's PDF (DESIGN §28, 「새 버전 올리기」): the professor re-posted the deck. The new PDF is
// converted next to the lecture and its slides are matched to the old ones (library.ts stageNextVersion, the image
// worker's match job → the plan); applying it swaps the render sets and every subsystem renumbers what the student
// made (the remaps), so it follows its slide. The last apply can be undone.
//
// The swap is journaled in library/.prev-<docId>/prev.json, next to the replaced deck: each step is recorded once it is
// done, so a swap the server stopped in the middle is finished at the next start (resumeSwaps, before requests are
// accepted; every remap is idempotent). While a swap runs the lecture is marked swapping (library.ts): its writes answer
// 409, its digest and turns are held (lockDigest, reserveDocTurns), nothing renders into it. Uploads, drops, applies
// and undos of one lecture run one after another.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DeckChange, DocMeta, NextVersionInfo, VersionPlan } from '../shared/types.ts';
import { drainAnnotations, rebuildIndex, remapAnnotationLinks, remapDocAnnotations, removedSlideCounts, sendDeckEvent } from './annotations.ts';
import { thumbPath } from './assets.ts';
import { remapRegionAttachments, stopAttachmentJobs } from './attachments.ts';
import { reserveDocTurns } from './chat.ts';
import { HttpError } from './config.ts';
import { courseOf, writeCourseMarkdown } from './courses.ts';
import { lockDigest, remapDigest } from './digest.ts';
import { smsg } from './i18n.ts';
import type { DeckMap } from './internal-types.ts';
import {
  beginDocSwap,
  createKeyedQueue,
  discardNextVersion,
  docPaths,
  endDocSwap,
  getDoc,
  interruptNextVersion,
  isDocSwapping,
  isNextVersionConverting,
  looksLikePdf,
  markInterruptedNextVersions,
  mkdirWithRetry,
  moveRenderEntries,
  nextVersionPaths,
  prevVersionDocIds,
  prevVersionPaths,
  readJsonFile,
  readNextVersion,
  readStoredDoc,
  rmWithRetry,
  setDocDeck,
  slideFileName,
  stageNextVersion,
  stopDocImageWork,
  swapRefusal,
  waitForNextVersion,
  writeJsonAtomic,
} from './library.ts';
import type { StoredDocMeta, StoredNextVersion } from './library.ts';
import { recordingsBusy, remapDocRecordings } from './recordings/service.ts';
import { questionCountOnSlides, remapSessionSlides, writeNotes } from './sessions.ts';

/** The texts of this module's errors, in the request's language (DESIGN §27). */
const texts = () => smsg().library.versions;

/** What a swap does, in order: the render sets, doc.json, then every subsystem's remap and the files made from them. */
export type SwapStep =
  | 'render-out'
  | 'render'
  | 'meta'
  | 'annotations'
  | 'attachments'
  | 'sessions'
  | 'recordings'
  | 'digest'
  | 'links'
  | 'notes'
  | 'course'
  | 'index';

/** Everything after these depends on them: a swap whose render sets or doc.json could not be switched stops there. */
const FOUNDATION_STEPS: ReadonlySet<SwapStep> = new Set<SwapStep>(['render-out', 'render', 'meta']);

/** library/.prev-<docId>/prev.json: the journal of the last apply, and the source of its undo. */
export interface SwapJournal {
  /** DocMeta.deckRev of the replaced deck (the plan's fromRev), and of the new one. */
  fromRev: number;
  toRev: number;
  /** doc.json's deck fields of the replaced deck (an undo brings them back). */
  oldMeta: { pageCount: number; aspectRatio: number; fileName: string };
  newFileName: string;
  /** Width / height of the new deck's slides. */
  newAspectRatio: number;
  plan: VersionPlan;
  appliedAt: string;
  /** Steps of the apply done so far. */
  steps: SwapStep[];
  /** Every step is done (or was given up after a retry, `failed`): the apply can be undone. */
  complete: boolean;
  /** Steps that failed twice: the lecture stays swapped with what succeeded (logged). */
  failed?: SwapStep[];
  /** The undo of this apply, once begun; the folder is removed when its steps are done. */
  undo?: { fromRev: number; toRev: number; at: string; steps: SwapStep[]; failed?: SwapStep[] };
}

/** Under .prev-<docId> during an undo: the undone deck's render set, until its remaps have read its thumbnails. */
const UNDONE_DIR = 'undone';

/** Uploads, drops, applies and undos of a lecture, one at a time. */
const versionsQueue = createKeyedQueue();

// ---------------------------------------------------------------------------
// The uploaded new version
// ---------------------------------------------------------------------------

/**
 * POST /api/docs/:docId/versions: stores a new version of the lecture's PDF and starts converting and matching it in
 * the background; a pending new version is replaced. 400 not a PDF, 404 unknown lecture, 409 the lecture is not ready
 * or its deck is being swapped.
 */
export async function importNextVersion(docId: string, bytes: Buffer, fileName: string): Promise<NextVersionInfo> {
  if (!looksLikePdf(bytes)) throw new HttpError(400, texts().notPdf);
  await requireReadyDoc(docId);
  if (isDocSwapping(docId)) throw new HttpError(409, texts().swapping);
  return versionsQueue(docId, async () => {
    // A swap that failed half-way is finished first: it may still need the staging folder this replaces.
    await finishInterruptedSwap(docId);
    await requireReadyDoc(docId);
    return toInfo(docId, await stageNextVersion(docId, bytes, fileName));
  });
}

/** GET …/versions/next: the uploaded new version (its plan's onRemoved counted now), or null when there is none. */
export async function getNextVersion(docId: string): Promise<NextVersionInfo | null> {
  await requireDoc(docId);
  const stored = await readNextVersion(docId);
  return stored ? toInfo(docId, stored) : null;
}

/** GET …/versions/next/thumbs/:file (`<n>.webp`): the new version's thumbnail and its slide PNG (the fallback); 404 otherwise. */
export async function nextVersionThumb(docId: string, file: string): Promise<{ thumb: string; png: string }> {
  await requireDoc(docId);
  const stored = await readNextVersion(docId);
  const match = /^(\d{1,6})\.webp$/.exec(file);
  const slide = match ? Number(match[1]) : 0;
  if (!stored || slide < 1 || slide > stored.pageCount) throw new HttpError(404, smsg().common.notFound.slide);
  const paths = nextVersionPaths(docId);
  const slideFile = slideFileName(slide, stored.pageCount);
  return { thumb: thumbPath(paths.dir, slideFile), png: path.join(paths.slidesDir, slideFile) };
}

/** DELETE …/versions/next: drops the uploaded new version (its conversion stopped, its folder removed). Idempotent. */
export async function dropNextVersion(docId: string): Promise<void> {
  await requireDoc(docId);
  if (isDocSwapping(docId)) throw new HttpError(409, texts().swapping);
  await versionsQueue(docId, () => discardNextVersion(docId));
}

async function toInfo(docId: string, stored: StoredNextVersion): Promise<NextVersionInfo> {
  const info: NextVersionInfo = {
    status: stored.status,
    fileName: stored.fileName,
    progress: stored.progress,
    pageCount: stored.pageCount,
    createdAt: stored.createdAt,
  };
  if (stored.error) info.error = stored.error;
  if (stored.status === 'ready' && stored.plan) info.plan = await withOnRemoved(docId, stored.plan);
  return info;
}

/** The plan with what the student has on its removed slides now (they may keep writing while the dialog is open). */
async function withOnRemoved(docId: string, plan: Omit<VersionPlan, 'onRemoved'>): Promise<VersionPlan> {
  if (plan.removed.length === 0) return { ...plan, onRemoved: { items: 0, memos: 0, questions: 0 } };
  const [counts, questions] = await Promise.all([removedSlideCounts(docId, plan.removed), questionCountOnSlides(docId, plan.removed)]);
  return { ...plan, onRemoved: { items: counts.items, memos: counts.memos, questions } };
}

// ---------------------------------------------------------------------------
// Apply and undo
// ---------------------------------------------------------------------------

/**
 * POST …/versions/next/apply: the new version replaces the lecture's deck, and everything the student made follows its
 * slide (DESIGN §28 Apply). Resolves with the swapped lecture. 404 no new version; 409 the lecture is not ready, the
 * new version is not ready or was matched against another deck (stale), or something runs that a swap must not
 * interrupt (a digest, an answer, a recording).
 */
export async function applyNextVersion(docId: string): Promise<DocMeta> {
  if (isDocSwapping(docId)) throw new HttpError(409, texts().swapping);
  return versionsQueue(docId, async () => {
    await finishInterruptedSwap(docId);
    const doc = await requireReadyDoc(docId);
    const next = await readNextVersion(docId);
    if (!next) throw new HttpError(404, texts().noNext);
    if (next.status !== 'ready' || !next.plan) throw new HttpError(409, texts().nextNotReady);
    // 'ready' is the conversion's last write: it is ending.
    if (isNextVersionConverting(docId)) await waitForNextVersion(docId);
    const plan = await withOnRemoved(docId, next.plan);
    if (plan.fromRev !== (doc.deckRev ?? 0) || plan.oldPageCount !== doc.pageCount) throw new HttpError(409, texts().stalePlan);
    const journal: SwapJournal = {
      fromRev: plan.fromRev,
      toRev: plan.fromRev + 1,
      oldMeta: { pageCount: doc.pageCount, aspectRatio: doc.aspectRatio, fileName: doc.fileName },
      newFileName: next.fileName,
      newAspectRatio: next.aspectRatio,
      plan,
      appliedAt: new Date().toISOString(),
      steps: [],
      complete: false,
    };
    await withSwapGates(docId, async () => {
      const prev = prevVersionPaths(docId);
      // One level: a new apply replaces the deck the previous one kept for its undo.
      await rmWithRetry(prev.dir, { recursive: true, force: true });
      await mkdirWithRetry(prev.dir);
      await writeJournal(docId, journal);
      await runApply(docId, journal);
    });
    sendDeckEvent(docId, { rev: journal.toRev, kind: 'apply', oldToNew: applyMap(journal).oldToNew });
    return requireDocMeta(docId);
  });
}

/**
 * POST …/versions/undo: the deck the last apply replaced comes back, with everything the student did since mapped back
 * (DESIGN §28 Undo). Resolves with the lecture. 409 when there is nothing to undo (no apply kept, or the deck changed
 * since) or something runs that a swap must not interrupt.
 */
export async function undoLastVersion(docId: string): Promise<DocMeta> {
  if (isDocSwapping(docId)) throw new HttpError(409, texts().swapping);
  return versionsQueue(docId, async () => {
    await finishInterruptedSwap(docId);
    const doc = await requireReadyDoc(docId);
    const journal = await readJournal(docId);
    if (!journal || !journal.complete || journal.undo || journal.toRev !== (doc.deckRev ?? 0)) {
      throw new HttpError(409, texts().nothingToUndo);
    }
    const undo = { fromRev: journal.toRev, toRev: journal.toRev + 1, at: new Date().toISOString(), steps: [] };
    await withSwapGates(docId, async () => {
      // A new version being converted is matched against the deck that goes away.
      await interruptNextVersion(docId, texts().interrupted);
      journal.undo = undo;
      await writeJournal(docId, journal);
      await runUndo(docId, journal);
    });
    sendDeckEvent(docId, { rev: undo.toRev, kind: 'undo', oldToNew: undoMap(journal).oldToNew });
    return requireDocMeta(docId);
  });
}

/**
 * Startup, before requests are accepted: a swap the server stopped in the middle (prev.json incomplete, or an undo
 * begun) is finished from its journal; then new versions left converting are marked interrupted. Returns how many
 * swaps were finished.
 */
export async function resumeSwaps(): Promise<number> {
  let resumed = 0;
  for (const docId of await prevVersionDocIds()) {
    const journal = await readJournal(docId);
    if (!journal || (journal.complete && !journal.undo) || !(await readStoredDoc(docId))) continue;
    console.log(`[versions] ${docId}: finishing the interrupted ${journal.undo ? 'undo' : 'switch to the new version'}`);
    beginDocSwap(docId);
    try {
      await resumeJournal(docId, journal);
      resumed++;
    } catch (err) {
      console.error(`[versions] ${docId}: the interrupted swap could not be finished:`, err);
    } finally {
      endDocSwap(docId);
    }
  }
  await markInterruptedNextVersions().catch((err: unknown) => {
    // Shown as still converting until the next start; the server starts either way.
    console.error('[versions] could not mark interrupted new versions:', err);
  });
  return resumed;
}

/**
 * Takes the gates of a swap, runs `work` and releases them (DESIGN §28 Apply 1-2). The recordings are asked first
 * (their answer needs an await); from the other checks to the swapping mark nothing awaits, like deleteDoc's
 * busyReason, so nothing can start in between. Then the lecture's attachment crops and image work stop and its
 * annotation writes drain.
 */
async function withSwapGates<T>(docId: string, work: () => Promise<T>): Promise<T> {
  const recordings = await recordingsBusy(docId);
  if (recordings) throw new HttpError(409, recordings);
  const refusal = swapRefusal(docId);
  if (refusal) throw refusal;
  const releaseDigest = lockDigest(docId);
  let releaseTurns: () => void;
  try {
    releaseTurns = reserveDocTurns(docId);
  } catch (err) {
    releaseDigest();
    throw err;
  }
  beginDocSwap(docId);
  try {
    // Regions being cropped from slides that are about to move are not wanted any more.
    stopAttachmentJobs(docId);
    await stopDocImageWork(docId);
    await drainAnnotations(docId);
    return await work();
  } finally {
    endDocSwap(docId);
    releaseTurns();
    releaseDigest();
  }
}

/** A swap of the lecture that failed half-way in this process (its render sets or doc.json): finished under the gates. */
async function finishInterruptedSwap(docId: string): Promise<void> {
  const journal = await readJournal(docId);
  if (!journal || (journal.complete && !journal.undo)) return;
  const event = await withSwapGates(docId, () => resumeJournal(docId, journal));
  sendDeckEvent(docId, event);
}

/** Finishes a journaled swap (an apply, or its undo); resolves with the `deck` event that announces it. */
async function resumeJournal(docId: string, journal: SwapJournal): Promise<{ rev: number; kind: 'apply' | 'undo'; oldToNew: (number | null)[] }> {
  if (journal.undo) {
    await runUndo(docId, journal);
    return { rev: journal.undo.toRev, kind: 'undo', oldToNew: undoMap(journal).oldToNew };
  }
  await runApply(docId, journal);
  return { rev: journal.toRev, kind: 'apply', oldToNew: applyMap(journal).oldToNew };
}

/**
 * The apply's steps (DESIGN §28 Apply 3-4): the lecture's render set moves to .prev-<docId> and the new version's takes
 * its place, doc.json gets the new deck, then the remaps. Then the journal is complete and the staging folder goes.
 */
async function runApply(docId: string, journal: SwapJournal): Promise<void> {
  const live = docPaths(docId);
  const prev = prevVersionPaths(docId);
  const next = nextVersionPaths(docId);
  const map = applyMap(journal);
  const { plan } = journal;
  const change: DeckChange = {
    rev: journal.toRev,
    at: journal.appliedAt,
    kind: 'apply',
    fromFileName: journal.oldMeta.fileName,
    changed: ascending(map.changed),
    added: ascending(map.added),
    removed: [...plan.removed],
    undoable: true,
  };
  const meta: Parameters<typeof setDocDeck>[1] = {
    pageCount: plan.newPageCount,
    aspectRatio: journal.newAspectRatio,
    fileName: journal.newFileName,
    progress: plan.newPageCount,
    deckRev: journal.toRev,
    lastChange: change,
  };
  const failed = await runSteps(docId, journal.steps, () => writeJournal(docId, journal), [
    ['render-out', () => moveRenderEntries(live.dir, prev.dir)],
    ['render', () => moveRenderEntries(next.dir, live.dir)],
    ['meta', () => setDocDeck(docId, meta)],
    ...remapSteps(docId, map, prev.dir),
  ]);
  journal.complete = true;
  if (failed.length > 0) journal.failed = failed;
  await writeJournal(docId, journal);
  await rmWithRetry(next.dir, { recursive: true, force: true });
  console.log(`[versions] ${docId}: switched to the new version (deck ${journal.toRev})`);
}

/**
 * The undo's steps (DESIGN §28 Undo): the undone deck's render set moves aside (its thumbnails are still read by the
 * annotations' remap), the replaced deck's comes back, doc.json gets it again, the remaps run with the inverse map
 * (their restore half puts back what the apply archived); then .prev-<docId> is removed, the undone deck with it.
 */
async function runUndo(docId: string, journal: SwapJournal): Promise<void> {
  const undo = journal.undo;
  if (!undo) throw new Error('the journal has no undo');
  const live = docPaths(docId);
  const prev = prevVersionPaths(docId);
  const undone = path.join(prev.dir, UNDONE_DIR);
  const map = undoMap(journal);
  const change: DeckChange = {
    rev: undo.toRev,
    at: undo.at,
    kind: 'undo',
    fromFileName: journal.newFileName,
    changed: ascending(map.changed),
    added: ascending(map.added),
    removed: journal.plan.slides.filter((entry) => entry.change === 'new').map((entry) => entry.slide),
    undoable: false,
  };
  const { oldMeta } = journal;
  const meta: Parameters<typeof setDocDeck>[1] = {
    pageCount: oldMeta.pageCount,
    aspectRatio: oldMeta.aspectRatio,
    fileName: oldMeta.fileName,
    progress: oldMeta.pageCount,
    deckRev: undo.toRev,
    lastChange: change,
  };
  const failed = await runSteps(docId, undo.steps, () => writeJournal(docId, journal), [
    ['render-out', () => moveRenderEntries(live.dir, undone)],
    ['render', () => moveRenderEntries(prev.dir, live.dir)],
    ['meta', () => setDocDeck(docId, meta)],
    ...remapSteps(docId, map, undone),
  ]);
  if (failed.length > 0) console.error(`[versions] ${docId}: the undo left out: ${failed.join(', ')}`);
  await rmWithRetry(prev.dir, { recursive: true, force: true });
  console.log(`[versions] ${docId}: back to the replaced deck (deck ${undo.toRev})`);
}

type Step = readonly [name: SwapStep, run: () => Promise<unknown>];

/** The remaps of a swap and the files made from what they renumber; `oldDeckDir` holds the replaced deck's thumbnails. */
function remapSteps(docId: string, map: DeckMap, oldDeckDir: string): Step[] {
  const oldThumb = (oldSlide: number): string | null => {
    const file = thumbPath(oldDeckDir, slideFileName(oldSlide, map.oldPageCount));
    return existsSync(file) ? file : null;
  };
  return [
    ['annotations', () => remapDocAnnotations(docId, map, { oldThumb })],
    ['attachments', () => remapRegionAttachments(docId, map)],
    ['sessions', () => remapSessionSlides(docId, map)],
    ['recordings', () => remapDocRecordings(docId, map)],
    ['digest', async () => remapDigest(docId, map, (await readStoredDoc(docId))?.title ?? '')],
    ['links', () => remapAnnotationLinks(docId, map)],
    ['notes', () => writeNotes(docId)],
    [
      'course',
      async () => {
        const course = await courseOf(docId);
        if (course) await writeCourseMarkdown(course.id);
      },
    ],
    ['index', () => rebuildIndex(docId)],
  ];
}

/**
 * Runs the steps not in `done` in order, each added to `done` and saved once it is done. A failing step is tried again
 * once: the render sets and doc.json at once (everything depends on them: if they still fail the run stops, the journal
 * stays incomplete and the next start resumes it), the others after the rest (one subsystem failing does not stop the
 * others). Resolves with the steps given up (logged).
 */
async function runSteps(docId: string, done: SwapStep[], save: () => Promise<void>, steps: Step[]): Promise<SwapStep[]> {
  const retry: Step[] = [];
  const run = async ([name, step]: Step) => {
    await step();
    done.push(name);
    await save();
  };
  for (const step of steps) {
    if (done.includes(step[0])) continue;
    try {
      await run(step);
    } catch (err) {
      console.warn(`[versions] ${docId}: step ${step[0]} failed, trying again: ${(err as Error).message}`);
      if (FOUNDATION_STEPS.has(step[0])) await run(step);
      else retry.push(step);
    }
  }
  const failed: SwapStep[] = [];
  for (const step of retry) {
    try {
      await run(step);
    } catch (err) {
      console.error(`[versions] ${docId}: step ${step[0]} failed again, given up:`, err);
      failed.push(step[0]);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Maps and the journal
// ---------------------------------------------------------------------------

/** The DeckMap of an apply: the plan's old → new slides. */
function applyMap(journal: Pick<SwapJournal, 'plan'>): DeckMap {
  const { plan } = journal;
  const oldToNew: (number | null)[] = Array.from({ length: plan.oldPageCount }, () => null);
  for (const entry of plan.slides) if (entry.from !== null) oldToNew[entry.from - 1] = entry.slide;
  return {
    fromRev: plan.fromRev,
    toRev: plan.fromRev + 1,
    oldPageCount: plan.oldPageCount,
    newPageCount: plan.newPageCount,
    oldToNew,
    changed: new Set(plan.slides.filter((entry) => entry.change === 'changed').map((entry) => entry.slide)),
    added: new Set(plan.slides.filter((entry) => entry.change === 'new').map((entry) => entry.slide)),
  };
}

/**
 * The inverse DeckMap of an undo: the new deck's slides back to the old ones (null for added slides); the plan's
 * changed slides changed again, its removed slides added back, restoreRev = the deck coming back.
 */
function undoMap(journal: SwapJournal): DeckMap {
  const { plan } = journal;
  const oldToNew: (number | null)[] = Array.from({ length: plan.newPageCount }, () => null);
  for (const entry of plan.slides) oldToNew[entry.slide - 1] = entry.from;
  const fromRev = journal.undo?.fromRev ?? journal.toRev;
  return {
    fromRev,
    toRev: journal.undo?.toRev ?? fromRev + 1,
    oldPageCount: plan.newPageCount,
    newPageCount: plan.oldPageCount,
    oldToNew,
    changed: new Set(plan.slides.flatMap((entry) => (entry.change === 'changed' && entry.from !== null ? [entry.from] : []))),
    added: new Set(plan.removed),
    restoreRev: plan.fromRev,
  };
}

function ascending(slides: ReadonlySet<number>): number[] {
  return [...slides].sort((a, b) => a - b);
}

/** prev.json of the lecture, or null when there is none (or it is unreadable: an undo is then refused). */
async function readJournal(docId: string): Promise<SwapJournal | null> {
  const value = await readJsonFile<SwapJournal>(prevVersionPaths(docId).journal);
  if (typeof value !== 'object' || value === null) return null;
  const valid =
    Number.isInteger(value.fromRev) &&
    Number.isInteger(value.toRev) &&
    typeof value.oldMeta === 'object' &&
    value.oldMeta !== null &&
    typeof value.plan === 'object' &&
    value.plan !== null &&
    Array.isArray(value.plan.slides) &&
    Array.isArray(value.plan.removed) &&
    Array.isArray(value.steps) &&
    typeof value.complete === 'boolean' &&
    (value.undo === undefined || Array.isArray(value.undo.steps));
  return valid ? value : null;
}

function writeJournal(docId: string, journal: SwapJournal): Promise<void> {
  return writeJsonAtomic(prevVersionPaths(docId).journal, journal);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireDoc(docId: string): Promise<StoredDocMeta> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  return doc;
}

/** The lecture, converted (a new version is matched against its deck): 404 unknown, 409 not ready. */
async function requireReadyDoc(docId: string): Promise<StoredDocMeta> {
  const doc = await requireDoc(docId);
  if (doc.status !== 'ready') throw new HttpError(409, texts().notReady);
  return doc;
}

async function requireDocMeta(docId: string): Promise<DocMeta> {
  const doc = await getDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  return doc;
}
