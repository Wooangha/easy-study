// Context strategy: decides what is sent to the LLM on every turn (DESIGN §5, §10–§12).
//
// - The first turn of a provider conversation "primes" it with the whole deck: course context
//   (when the deck is a lecture of a course), overview contact sheets (unless a complete digest
//   makes them unnecessary), the per-slide material of every slide (digest entry, else extracted
//   text) and the focus window at full resolution.
// - Every turn feeds a focus window: the focused slide plus `neighbors` slides before and after it.
//   Window slides whose image is among the slides sent recently (LRU window) are only pointed back
//   to; the others are attached, so reading sequentially costs about one image per step.
// - When the conversation would exceed the provider's image budget, a fresh conversation is started
//   (rollover): the deck is primed again and a text recap of the latest Q&A is included.
//
// Everything in this file is pure: no filesystem access, no clock, no randomness. Paths and texts
// come from DocAssets; identical inputs always produce identical outputs.
import path from 'node:path';
import type { ChatMessage, ContextInfo, DigestSlide } from '../shared/types.ts';
import type {
  BuildTurnInput,
  BuildTurnOutput,
  ContextSettings,
  CourseLectureRef,
  DocAssets,
  ProviderState,
} from './internal-types.ts';
import type { HistoryTurn, Part, ResumeHandle } from './providers/types.ts';
import * as prompts from './prompts.ts';

export const DEFAULT_CONTEXT_SETTINGS: Readonly<ContextSettings> = Object.freeze({
  recentWindow: 8,
  neighborWindow: 1,
  primeWithImages: 'auto',
  maxPrimeTextChars: 120_000,
  maxSlideTextChars: 4_000,
  recapTurns: 6,
  maxCourseContextChars: 30_000,
});

/** Largest accepted neighbour window (slides before AND after the focused slide). */
export const MAX_NEIGHBORS = 3;

/** Max characters of each question / answer quoted in a rollover recap. */
const RECAP_CHARS = 600;

/**
 * Focus images kept in reserve when capping overview sheets for huge decks, so that a freshly
 * primed conversation can still take a few questions before rolling over again.
 */
const FOCUS_IMAGE_RESERVE = 16;

/** Do not bother with a partial section shorter than this when a text cap is hit. */
const MIN_PARTIAL_SECTION_CHARS = 200;

/** Digest titles are single short lines. */
const MAX_TITLE_CHARS = 200;

type ImagePart = Extract<Part, { type: 'image' }>;
type Sheet = DocAssets['sheets'][number];
type PrimeImagesMode = ContextSettings['primeWithImages'];

/** Material of one slide: its digest entry when usable, otherwise its extracted text. */
interface SlideMaterial {
  kind: 'digest' | 'extracted';
  /** Digest title ('' for extracted text). */
  title: string;
  /** Cleaned body, capped at maxSlideTextChars. */
  body: string;
}

/** The course of the document, resolved around the current lecture. */
interface ResolvedCourse {
  title: string;
  /** All lectures in course order, including the current one. */
  lectures: CourseLectureRef[];
  /** 0-based position of the current document in `lectures`. */
  position: number;
}

// ---------------------------------------------------------------------------
// Settings / state
// ---------------------------------------------------------------------------

/** Context settings from the environment (DESIGN §5/§10–§12 defaults; unset/invalid values fall back). */
export function defaultContextSettings(env: NodeJS.ProcessEnv = process.env): ContextSettings {
  const d = DEFAULT_CONTEXT_SETTINGS;
  return {
    recentWindow: intFromEnv(env.EASY_STUDY_RECENT_WINDOW, d.recentWindow, 1, 100),
    neighborWindow: intFromEnv(env.EASY_STUDY_NEIGHBORS, d.neighborWindow, 0, MAX_NEIGHBORS),
    primeWithImages: primeImagesFromEnv(env.EASY_STUDY_PRIME_IMAGES, d.primeWithImages),
    maxPrimeTextChars: intFromEnv(env.EASY_STUDY_MAX_PRIME_TEXT_CHARS, d.maxPrimeTextChars, 0, 5_000_000),
    maxSlideTextChars: intFromEnv(env.EASY_STUDY_MAX_SLIDE_TEXT_CHARS, d.maxSlideTextChars, 0, 1_000_000),
    recapTurns: intFromEnv(env.EASY_STUDY_RECAP_TURNS, d.recapTurns, 0, 100),
    maxCourseContextChars: intFromEnv(env.EASY_STUDY_MAX_COURSE_CONTEXT_CHARS, d.maxCourseContextChars, 0, 5_000_000),
  };
}

/** Provider state of a session that has not talked to its provider yet. */
export function initialProviderState(): ProviderState {
  return { resume: null, primed: false, imagesSent: 0, recentSlides: [], generation: 0, history: [] };
}

/**
 * Returns `state` with this turn's user parts and the assistant answer appended to `history`.
 * Only used for stateless providers (anthropic-api), which resend the whole conversation.
 */
export function appendHistory(state: ProviderState, parts: Part[], answer: string): ProviderState {
  const userTurn: HistoryTurn = { role: 'user', parts: parts.map(clonePart) };
  // Empty text blocks are rejected by the Messages API, so never store an empty answer.
  const assistantTurn: HistoryTurn = {
    role: 'assistant',
    parts: [{ type: 'text', text: answer.trim() ? answer : '(no answer)' }],
  };
  return { ...state, history: [...state.history, userTurn, assistantTurn] };
}

// ---------------------------------------------------------------------------
// buildTurn
// ---------------------------------------------------------------------------

export function buildTurn(input: BuildTurnInput): BuildTurnOutput {
  const { doc, session, kind } = input;
  const settings = sanitizeSettings(input.settings);
  const pageCount = resolvePageCount(doc);
  const slide = clampSlide(input.slide, pageCount);
  const maxImages = Math.max(1, Math.floor(finiteOr(input.maxImagesPerConversation, 1)));
  const state = normalizeState(session.providerState, pageCount);
  const materialOf = materialLookup(doc, pageCount, settings.maxSlideTextChars);
  const course = resolveCourse(doc);
  const agenticCli = isAgenticCli(session.provider);

  const windowSlides = focusWindow(slide, pageCount, resolveNeighbors(input.neighbors, settings.neighborWindow), maxImages);

  // A primed conversation without a resume handle cannot be continued, so treat it as unprimed.
  const needsPrime = !state.primed || state.resume === null;
  const cost = needsPrime ? windowSlides.length : windowSlides.filter((s) => !state.recentSlides.includes(s)).length;
  const rollover = !needsPrime && state.imagesSent + cost > maxImages;
  const startsConversation = needsPrime || rollover;

  // Slides whose image the provider conversation already has (none in a fresh conversation).
  const alreadySent = startsConversation ? [] : state.recentSlides;
  const attached = windowSlides.filter((s) => !alreadySent.includes(s));
  const reused = windowSlides.filter((s) => alreadySent.includes(s));
  // Never let the recent list be shorter than the window just shown (all of it is in context now).
  const recentSlides = mergeRecent(slide, windowSlides, alreadySent, Math.max(settings.recentWindow, windowSlides.length));

  const out = new PartsBuilder();
  let sheets: Sheet[] = [];
  let nextState: ProviderState;

  if (startsConversation) {
    const allDigest = countDigestSlides(materialOf, pageCount) === pageCount;
    sheets = useOverviewSheets(settings.primeWithImages, allDigest) ? selectSheets(doc.sheets, maxImages, windowSlides.length) : [];
    appendPriming(out, { doc, pageCount, sheets, settings, agenticCli, course, materialOf });
    if (rollover) appendRecap(out, Array.isArray(session.messages) ? session.messages : [], settings.recapTurns);
    nextState = {
      resume: null, // filled in by the orchestrator from the provider result
      primed: true,
      imagesSent: sheets.length + attached.length,
      recentSlides,
      generation: state.generation + 1,
      history: [],
    };
  } else {
    nextState = {
      ...state,
      resume: cloneResume(state.resume),
      imagesSent: state.imagesSent + attached.length,
      recentSlides,
      history: [...state.history],
    };
  }

  appendFocus(out, doc, slide, pageCount, windowSlides, new Set(attached), materialOf);
  if (kind === 'prime') {
    out.text(prompts.primeInstruction(course !== null && course.position > 0));
  } else {
    out.text(prompts.questionBlock(slide, String(input.question ?? '').trim()));
  }

  const context: ContextInfo = {
    primed: startsConversation,
    rollover,
    attachedSlides: attached,
    reusedSlides: reused,
    overviewImages: startsConversation ? sheets.length : 0,
  };

  return {
    systemPrompt: prompts.tutorSystemPrompt(),
    parts: out.parts,
    resume: startsConversation ? null : cloneResume(state.resume),
    history: startsConversation ? [] : state.history.map(cloneTurn),
    context,
    readDirs: otherLectureDirs(doc, course),
    nextState,
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface PrimingInput {
  doc: DocAssets;
  pageCount: number;
  sheets: Sheet[];
  settings: ContextSettings;
  agenticCli: boolean;
  course: ResolvedCourse | null;
  materialOf: (slide: number) => SlideMaterial;
}

/** PRIMING(doc): header, course context, overview sheets (each preceded by its label line), all slide material. */
function appendPriming(out: PartsBuilder, input: PrimingInput): void {
  const { doc, pageCount, sheets, settings, agenticCli, course, materialOf } = input;
  const digestSlides = countDigestSlides(materialOf, pageCount);
  const material: prompts.MaterialKind =
    digestSlides === 0 ? 'extracted' : digestSlides === pageCount ? 'digest' : 'mixed';

  out.text(
    prompts.primingHeader({
      title: doc.meta.title || doc.meta.fileName || 'Untitled deck',
      fileName: doc.meta.fileName || 'source.pdf',
      pageCount,
      overviewImages: sheets.length,
      material,
      courseContext: course !== null,
    }),
  );

  if (course) appendCourseContext(out, doc, course, settings.maxCourseContextChars, agenticCli);

  for (const sheet of sheets) {
    out.text(prompts.overviewLine(sheet.fromSlide, sheet.toSlide));
    out.image({
      type: 'image',
      path: sheet.path,
      detail: 'low',
      label: prompts.overviewLabel(sheet.fromSlide, sheet.toSlide),
    });
  }
  // Only possible for very long decks whose sheets exceed the image budget (see selectSheets).
  if (sheets.length > 0 && sheets.length < doc.sheets.length) {
    const lastCovered = sheets[sheets.length - 1].toSlide;
    if (lastCovered < pageCount) out.text(prompts.overviewLimitedNote(lastCovered, pageCount));
  }

  out.text(materialDump(pageCount, settings.maxPrimeTextChars, material, materialOf));

  if (agenticCli) {
    out.text(prompts.slideFilesNote(slideFileRef(doc, 1), slideFileRef(doc, pageCount), pageCount));
  }
}

/**
 * COURSE CONTEXT (DESIGN §12): the lecture list, summaries of the earlier lectures (oldest first,
 * capped by dropping the oldest summaries first) and, for agentic CLIs, where the other lectures'
 * files are.
 */
function appendCourseContext(
  out: PartsBuilder,
  doc: DocAssets,
  course: ResolvedCourse,
  maxChars: number,
  agenticCli: boolean,
): void {
  const { lectures, position } = course;
  const list = lectures.map((l, i) =>
    prompts.courseListLine(i + 1, lectureTitle(l), i < position ? 'earlier' : i === position ? 'current' : 'later'),
  );
  out.text(
    [
      prompts.COURSE_HEADING,
      prompts.courseIntro(course.title, position + 1, lectures.length),
      '',
      prompts.COURSE_LIST_HEADING,
      ...list,
    ].join('\n'),
  );

  const earlier = earlierLectureSections(lectures.slice(0, position), maxChars);
  if (earlier.length > 0) out.text([prompts.EARLIER_LECTURES_HEADING, ...earlier].join('\n\n'));
  if (position < lectures.length - 1) out.text(prompts.LATER_LECTURES_NOTE);

  if (agenticCli) {
    const files = lectures
      .map((l, i) => ({ lecture: l, index: i + 1 }))
      .filter((_, i) => i !== position)
      .map(({ lecture, index }) => courseFileRef(doc, lecture, index));
    if (files.length > 0) out.text(prompts.courseFilesNote(files));
  }
}

/**
 * "### Lecture i: <title>\n<summary>" for every earlier lecture, oldest first. When the total exceeds
 * `maxChars`, the oldest summaries are replaced by a short note first (titles are always kept); the
 * newest remaining summary is truncated rather than dropped when it alone is too long.
 */
function earlierLectureSections(earlier: CourseLectureRef[], maxChars: number): string[] {
  const titles = earlier.map((l) => lectureTitle(l));
  const summaries = earlier.map((l) => (typeof l.summary === 'string' ? prepareMarkdown(l.summary) : ''));
  const bodies = summaries.map((s) => s || prompts.NO_SUMMARY_PLACEHOLDER);
  const section = (i: number) => prompts.earlierLectureSection(i + 1, titles[i], bodies[i]);
  const total = () => bodies.reduce((sum, _, i) => sum + section(i).length + 2, 0);

  const withSummary = summaries.flatMap((s, i) => (s ? [i] : []));
  for (let k = 0; k < withSummary.length && total() > maxChars; k++) {
    const i = withSummary[k];
    const isNewest = k === withSummary.length - 1;
    if (isNewest) {
      // Leave room for the truncation mark (and a closing fence) so the cap holds.
      const room = maxChars - (total() - bodies[i].length) - prompts.TRUNCATED_MARK.length - 4;
      bodies[i] = room >= MIN_PARTIAL_SECTION_CHARS ? truncateMarkdown(summaries[i], room) : prompts.SUMMARY_OMITTED_NOTE;
    } else {
      bodies[i] = prompts.SUMMARY_OMITTED_NOTE;
    }
  }
  return bodies.map((_, i) => section(i));
}

/** Paths (relative to this document's directory) of another lecture's files. */
function courseFileRef(doc: DocAssets, lecture: CourseLectureRef, index: number): prompts.CourseFileRef {
  const pageCount = Math.max(1, Math.floor(finiteOr(lecture.pageCount, 1)));
  const dir = relativeDir(doc.dir, lecture.dir, lecture.docId);
  const file = (sub: string, n: number, ext: string) => `${dir}/${sub}/${pageBaseName(n, pageCount)}.${ext}`;
  return {
    index,
    title: lectureTitle(lecture),
    digest: lecture.hasDigest ? `${dir}/DIGEST.md` : null,
    firstText: file('text', 1, 'txt'),
    lastText: file('text', pageCount, 'txt'),
    firstSlide: file('slides', 1, 'png'),
    lastSlide: file('slides', pageCount, 'png'),
    pageCount,
  };
}

/** RECAP: the latest complete Q&A pairs of this session, as text (only after a rollover). */
function appendRecap(out: PartsBuilder, messages: ChatMessage[], recapTurns: number): void {
  if (recapTurns <= 0) return;
  const pairs = completedPairs(messages).slice(-recapTurns);
  if (pairs.length === 0) return;
  const lines = pairs.map((p) =>
    prompts.recapLine(p.slide, squeeze(p.question, RECAP_CHARS), squeeze(p.answer, RECAP_CHARS)),
  );
  out.text([prompts.RECAP_HEADING, ...lines, '', prompts.ROLLOVER_NOTE].join('\n'));
}

/** FOCUS(window) (DESIGN §10): every window slide in ascending order, attached or pointed back to. */
function appendFocus(
  out: PartsBuilder,
  doc: DocAssets,
  slide: number,
  pageCount: number,
  windowSlides: number[],
  attached: ReadonlySet<number>,
  materialOf: (slide: number) => SlideMaterial,
): void {
  out.text(prompts.focusLine(slide, pageCount));
  if (windowSlides.length > 1) {
    out.text(prompts.neighborsLine(windowSlides[0], windowSlides[windowSlides.length - 1], slide));
  }
  for (const s of windowSlides) {
    const label = prompts.windowSlideLabel(s, s === slide);
    if (!attached.has(s)) {
      out.text(`${label}\n${prompts.focusReusedLine(s)}`);
      continue;
    }
    // The line right before the image names it (keeps image parts next to their label).
    out.text(`${label}\n${prompts.focusImageLine(s)}`);
    out.image({ type: 'image', path: doc.slidePath(s), detail: 'high', label: prompts.focusImageLabel(s) });
    const m = materialOf(s);
    out.text(m.kind === 'digest' ? prompts.focusDigestBlock(s, m.title, m.body) : prompts.focusTextBlock(s, m.body));
  }
}

/** "### Slide N" sections for every slide, capped per slide (by materialOf) and as a whole. */
function materialDump(
  pageCount: number,
  cap: number,
  kind: prompts.MaterialKind,
  materialOf: (slide: number) => SlideMaterial,
): string {
  const sections: string[] = [];
  let used = 0;
  for (let n = 1; n <= pageCount; n++) {
    const m = materialOf(n);
    const opts = { title: m.kind === 'digest' ? m.title : '', pdfTextMark: kind === 'mixed' && m.kind === 'extracted' };
    const section = prompts.slideTextSection(n, m.body, opts);
    const cost = section.length + 2; // sections are joined by a blank line
    if (used + cost <= cap) {
      sections.push(section);
      used += cost;
      continue;
    }
    // The whole-dump cap is reached: keep a truncated piece of this slide if it is worth it,
    // then summarise the remaining slides in a single line.
    let firstOmitted = n;
    const heading = prompts.slideTextSection(n, '', opts);
    const room = cap - used - 2 - heading.length;
    if (room >= MIN_PARTIAL_SECTION_CHARS) {
      sections.push(heading + (m.kind === 'digest' ? truncateMarkdown(m.body, room) : truncateText(m.body, room)));
      firstOmitted = n + 1;
    }
    if (firstOmitted <= pageCount) sections.push(prompts.textOmittedNote(firstOmitted, pageCount));
    break;
  }
  return [prompts.materialHeading(kind), ...sections].join('\n\n');
}

// ---------------------------------------------------------------------------
// Slide material (digest entry or extracted text)
// ---------------------------------------------------------------------------

/** Returns a memoised lookup of each slide's material (DESIGN §11 "Context use"). */
function materialLookup(doc: DocAssets, pageCount: number, maxChars: number): (slide: number) => SlideMaterial {
  const digest = new Map<number, DigestSlide>();
  for (const entry of Array.isArray(doc.digest) ? doc.digest : []) {
    if (!entry || typeof entry !== 'object' || entry.failed) continue;
    const n = entry.slide;
    if (!Number.isInteger(n) || n < 1 || n > pageCount) continue;
    if (typeof entry.markdown !== 'string' || !entry.markdown.trim()) continue;
    digest.set(n, entry); // later entries win
  }
  const cache = new Map<number, SlideMaterial>();
  return (slide) => {
    let m = cache.get(slide);
    if (m) return m;
    const entry = digest.get(slide);
    const body = entry ? prepareMarkdown(entry.markdown) : '';
    if (entry && body) {
      m = { kind: 'digest', title: cleanTitle(entry.title), body: truncateMarkdown(body, maxChars) };
    } else {
      const text = cleanExtractedText(doc.texts[slide - 1] ?? '');
      m = { kind: 'extracted', title: '', body: text ? truncateText(text, maxChars) : prompts.NO_TEXT_PLACEHOLDER };
    }
    cache.set(slide, m);
    return m;
  };
}

function countDigestSlides(materialOf: (slide: number) => SlideMaterial, pageCount: number): number {
  let count = 0;
  for (let n = 1; n <= pageCount; n++) if (materialOf(n).kind === 'digest') count++;
  return count;
}

/**
 * Overview sheets when priming: 'always', 'never', or 'auto' = only when the digest does not cover
 * every slide (a complete digest already describes each slide, so the sheets would mostly cost images).
 */
function useOverviewSheets(mode: PrimeImagesMode, digestComplete: boolean): boolean {
  return mode === 'always' || (mode === 'auto' && !digestComplete);
}

// ---------------------------------------------------------------------------
// Focus window
// ---------------------------------------------------------------------------

function resolveNeighbors(requested: unknown, fallback: number): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? requested : fallback;
  return Math.min(Math.max(Math.round(n), 0), MAX_NEIGHBORS);
}

/**
 * Slides [slide-n .. slide+n] clamped to the deck, ascending. The window is narrowed if it could
 * never fit the image budget (otherwise every turn would roll over).
 */
function focusWindow(slide: number, pageCount: number, neighbors: number, maxImages: number): number[] {
  const range = (n: number) => {
    const slides: number[] = [];
    for (let s = Math.max(1, slide - n); s <= Math.min(pageCount, slide + n); s++) slides.push(s);
    return slides;
  };
  let n = neighbors;
  while (n > 0 && range(n).length > maxImages) n--;
  return range(n);
}

/** [slide, other window slides nearest first, ...previous] without duplicates, cut to `limit`. */
function mergeRecent(slide: number, windowSlides: number[], previous: number[], limit: number): number[] {
  const others = windowSlides
    .filter((s) => s !== slide)
    .sort((a, b) => Math.abs(a - slide) - Math.abs(b - slide) || a - b);
  return [...new Set([slide, ...others, ...previous])].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Course
// ---------------------------------------------------------------------------

function resolveCourse(doc: DocAssets): ResolvedCourse | null {
  const course = doc.course;
  if (!course || typeof course !== 'object' || !Array.isArray(course.lectures)) return null;
  const lectures = course.lectures.filter((l) => l && typeof l === 'object');
  if (lectures.length === 0) return null;
  let position = lectures.findIndex((l) => l.docId === doc.meta.id);
  if (position < 0) {
    const fromIndex = Math.floor(finiteOr(course.currentIndex, 1)) - 1;
    position = Math.min(Math.max(fromIndex, 0), lectures.length - 1);
  }
  return { title: String(course.title || '').trim() || 'Untitled course', lectures, position };
}

/** Absolute directories of the course's other lectures (for providers' extraReadDirs). */
function otherLectureDirs(doc: DocAssets, course: ResolvedCourse | null): string[] {
  if (!course) return [];
  const dirs = course.lectures
    .filter((_, i) => i !== course.position)
    .map((l) => (typeof l.dir === 'string' ? l.dir : ''))
    .filter((dir) => dir && dir !== doc.dir);
  return [...new Set(dirs)];
}

function lectureTitle(lecture: CourseLectureRef): string {
  return cleanTitle(lecture.title) || lecture.docId || 'Untitled lecture';
}

/** `to` relative to `from` with forward slashes (e.g. "../other-doc"); falls back to "../<docId>". */
function relativeDir(from: string, to: string, docId: string): string {
  if (!to) return `../${docId}`;
  const rel = path.relative(from, to);
  if (!rel || path.isAbsolute(rel)) return to.split(path.sep).join('/');
  return rel.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accumulates parts, merging consecutive text pieces into one text part. */
class PartsBuilder {
  readonly parts: Part[] = [];

  text(text: string): void {
    if (!text) return;
    const last = this.parts[this.parts.length - 1];
    if (last && last.type === 'text') {
      last.text = `${last.text}\n\n${text}`;
    } else {
      this.parts.push({ type: 'text', text });
    }
  }

  image(part: ImagePart): void {
    this.parts.push(part);
  }
}

/**
 * Overview sheets to attach when priming. Normally all of them; for huge decks the list is cut so
 * that the priming turn leaves room for the focus window and a few more focus images afterwards.
 */
function selectSheets(sheets: Sheet[], maxImages: number, focusImages: number): Sheet[] {
  const reserve = Math.min(FOCUS_IMAGE_RESERVE, Math.floor(maxImages / 3));
  const budget = Math.max(0, maxImages - focusImages - reserve);
  return sheets.slice(0, budget);
}

function completedPairs(messages: ChatMessage[]): Array<{ slide: number; question: string; answer: string }> {
  const pairs: Array<{ slide: number; question: string; answer: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const q = messages[i];
    if (q.role !== 'user' || q.kind !== 'question') continue;
    const a = messages[i + 1];
    if (a && a.role === 'assistant' && a.status === 'complete' && a.text.trim()) {
      pairs.push({ slide: q.slide, question: q.text, answer: a.text });
    }
  }
  return pairs;
}

/** Relative path of a slide image as the CLI sees it from its working directory (the doc dir). */
function slideFileRef(doc: DocAssets, slide: number): string {
  const abs = doc.slidePath(slide);
  const rel = path.relative(doc.dir, abs);
  const usable = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  return usable.split(path.sep).join('/');
}

/** Same naming rule as the library: 3 digits, more when the deck has > 999 pages. */
function pageBaseName(n: number, pageCount: number): string {
  return String(n).padStart(Math.max(3, String(pageCount).length), '0');
}

function isAgenticCli(provider: string): boolean {
  return provider === 'claude-code' || provider === 'codex';
}

function resolvePageCount(doc: DocAssets): number {
  const fromMeta = Math.floor(finiteOr(doc.meta.pageCount, 0));
  if (fromMeta >= 1) return fromMeta;
  const fromSheets = doc.sheets.reduce((max, s) => Math.max(max, s.toSlide), 0);
  return Math.max(1, doc.texts.length, fromSheets);
}

function clampSlide(slide: number, pageCount: number): number {
  const n = Math.round(finiteOr(slide, 1));
  return Math.min(Math.max(n, 1), pageCount);
}

function sanitizeSettings(s: ContextSettings): ContextSettings {
  const d = DEFAULT_CONTEXT_SETTINGS;
  return {
    recentWindow: Math.max(1, Math.floor(finiteOr(s?.recentWindow, d.recentWindow))),
    neighborWindow: Math.min(Math.max(Math.round(finiteOr(s?.neighborWindow, d.neighborWindow)), 0), MAX_NEIGHBORS),
    primeWithImages: normalizePrimeImages(s?.primeWithImages, d.primeWithImages),
    maxPrimeTextChars: Math.max(0, Math.floor(finiteOr(s?.maxPrimeTextChars, d.maxPrimeTextChars))),
    maxSlideTextChars: Math.max(0, Math.floor(finiteOr(s?.maxSlideTextChars, d.maxSlideTextChars))),
    recapTurns: Math.max(0, Math.floor(finiteOr(s?.recapTurns, d.recapTurns))),
    maxCourseContextChars: Math.max(0, Math.floor(finiteOr(s?.maxCourseContextChars, d.maxCourseContextChars))),
  };
}

/** Accepts the three modes, and the Round 1 boolean (true = always, false = never). */
function normalizePrimeImages(value: unknown, fallback: PrimeImagesMode): PrimeImagesMode {
  if (value === 'auto' || value === 'always' || value === 'never') return value;
  if (value === true) return 'always';
  if (value === false) return 'never';
  return fallback;
}

/** Defensive copy of a persisted state (tolerates missing / malformed fields). */
function normalizeState(raw: ProviderState | undefined | null, pageCount: number): ProviderState {
  const init = initialProviderState();
  if (!raw || typeof raw !== 'object') return init;
  const recent: number[] = [];
  for (const s of Array.isArray(raw.recentSlides) ? raw.recentSlides : []) {
    if (Number.isInteger(s) && s >= 1 && s <= pageCount && !recent.includes(s)) recent.push(s);
  }
  return {
    resume: raw.resume && typeof raw.resume === 'object' ? cloneResume(raw.resume) : null,
    primed: raw.primed === true,
    imagesSent: Math.max(0, Math.floor(finiteOr(raw.imagesSent, 0))),
    recentSlides: recent,
    generation: Math.max(0, Math.floor(finiteOr(raw.generation, 0))),
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

function cloneResume(resume: ResumeHandle | null): ResumeHandle | null {
  return resume ? { ...resume } : null;
}

function clonePart(part: Part): Part {
  return { ...part };
}

function cloneTurn(turn: HistoryTurn): HistoryTurn {
  return { role: turn.role, parts: turn.parts.map(clonePart) };
}

// ---------------------------------------------------------------------------
// Text utilities (also used by digestPrompt.ts)
// ---------------------------------------------------------------------------

/**
 * Normalises pdftotext -layout output: unix newlines, no control chars, no trailing spaces,
 * at most one blank line, and long runs of layout padding shortened to 4 spaces (columns stay
 * separated, but padding no longer eats the prime text budget).
 */
export function cleanExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{5,}/g, '    ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A line that opens or closes a fenced code block. */
const FENCE_RE = /^\s{0,3}(```|~~~)/;

/**
 * Normalises LLM-written Markdown (digest entries, lecture summaries) for embedding under our own
 * "###" headings: unix newlines, no control chars, no trailing spaces, at most one blank line, and
 * (unless disabled) headings outside code fences demoted to level 4+. Indentation is kept.
 */
export function prepareMarkdown(markdown: string, opts: { demoteHeadings?: boolean } = {}): string {
  const demote = opts.demoteHeadings !== false;
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n');
  let inFence = false;
  const out = lines.map((raw) => {
    const line = raw.replace(/[ \t]+$/, '');
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !demote) return line;
    return line.replace(/^(#{1,6})(?=\s)/, (hashes) => '#'.repeat(Math.min(6, Math.max(4, hashes.length + 3))));
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cuts `text` to at most `max` characters (+ the truncation mark), never splitting a surrogate pair. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd() + prompts.TRUNCATED_MARK;
}

/** truncateText for Markdown: closes a code fence left open by the cut. */
function truncateMarkdown(markdown: string, max: number): string {
  if (markdown.length <= max) return markdown;
  const cut = truncateText(markdown, max);
  const fences = cut.split('\n').filter((line) => FENCE_RE.test(line)).length;
  return fences % 2 === 1 ? `${cut}\n\`\`\`` : cut;
}

function cleanTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  const oneLine = title.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : oneLine;
}

/** Single-line, capped version of a message for the recap. */
function squeeze(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  let end = max;
  const code = oneLine.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${oneLine.slice(0, end).trimEnd()}…`;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** EASY_STUDY_PRIME_IMAGES: auto | always | never, or the Round 1 booleans (1/true/yes/on = always, 0/false/no/off = never). */
function primeImagesFromEnv(raw: string | undefined, fallback: PrimeImagesMode): PrimeImagesMode {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'auto' || v === 'always' || v === 'never') return v;
  if (['1', 'true', 'yes', 'on'].includes(v)) return 'always';
  if (['0', 'false', 'no', 'off'].includes(v)) return 'never';
  return fallback;
}
