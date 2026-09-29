// Context strategy: decides what is sent to the LLM on every turn (DESIGN §5, §10–§12, §14).
//
// - The first turn of a provider conversation "primes" it with the whole deck: course context
//   (when the deck is a lecture of a course), overview contact sheets (unless a complete digest
//   makes them unnecessary), the per-slide material of every slide (digest entry, else extracted
//   text) and the focus window at full resolution. When the material exceeds its size cap, every
//   slide keeps a shorter entry (a digest entry keeps at least its title and "핵심:" line) instead of
//   the last slides being dropped.
// - Every turn feeds a focus window: the focused slide plus `neighbors` slides before and after it.
//   Window slides whose image is among the slides sent recently (LRU window) are only pointed back
//   to; the others are attached, so reading sequentially costs about one image per step.
// - A question may carry attachments (DESIGN §21: selected slide regions, images of the student): they follow
//   the focus window, each introduced by its label, and count toward the image budget like slide images.
//   Priming turns take none.
// - Lecture recordings (DESIGN §22): a question may carry what the professor said on the slides of the focus window
//   and, while the lecture is being recorded, its last minutes (BuildTurnInput.lectureSpeech, resolved by chat.ts;
//   capped again here). Priming then says in one line that recordings exist.
// - Slide annotations (DESIGN §25): a question may carry the student's own memos on the slides of the focus window
//   (BuildTurnInput.studentMemos, resolved by chat.ts; capped again here, the focused slide first), and a region
//   attachment made from a 필기 carries the item's text after the selection text. Priming takes neither.
// - When the conversation would exceed the provider's image budget, or the orchestrator reports that
//   the provider lost the conversation / found it too large (BuildTurnInput.forceNewConversation), or
//   the session's LLM was changed and its conversation dropped (ProviderState.switched), a fresh
//   conversation is started (rollover): the deck is primed again and a text recap of the latest Q&A
//   is included, closed by a note saying why. Request sizes in bytes and tokens are enforced by the
//   providers, which see the encoded request (they fail with ProviderError 'context_overflow', which leads here).
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
  recentWindow: 16,
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

/** Do not bother with a partial course summary shorter than this when its cap is hit. */
const MIN_PARTIAL_SECTION_CHARS = 200;

/** A capped priming dump never cuts a slide's material below about this many characters. */
const MIN_BODY_CHARS = 120;
/** A digest entry is only cut before its "핵심:" line when at least this much of the text before it fits. */
const MIN_HEAD_CHARS = 80;
/** Longest "핵심:" takeaway kept when a digest entry is cut. */
const MAX_KEY_CHARS = 400;
/** What shortenBody may add beyond its limit: the truncation mark and a closing code fence. */
const SHORTEN_SLACK = prompts.TRUNCATED_MARK.length + 4;

/** Digest titles are single short lines. */
const MAX_TITLE_CHARS = 200;

/** Lecture speech caps (DESIGN §22): per slide, all slides of the window together, the recent speech. */
export const MAX_SLIDE_SPEECH_CHARS = 1_500;
export const MAX_WINDOW_SPEECH_CHARS = 4_000;
export const MAX_RECENT_SPEECH_CHARS = 3_000;
/** Student memo caps (DESIGN §25): per memo, all memos of the window together, and how many. */
export const MAX_MEMO_CHARS = 600;
export const MAX_WINDOW_MEMO_CHARS = 2_000;
export const MAX_TUTOR_MEMOS = 12;

type ImagePart = Extract<Part, { type: 'image' }>;
type Sheet = DocAssets['sheets'][number];
type PrimeImagesMode = ContextSettings['primeWithImages'];
type RecoveryKind = NonNullable<BuildTurnInput['forceNewConversation']>;
type TurnAttachment = NonNullable<BuildTurnInput['attachments']>[number];

/** Material of one slide: its digest entry when usable, otherwise its extracted text. */
interface SlideMaterial {
  kind: 'digest' | 'extracted';
  /** Digest title ('' for extracted text). */
  title: string;
  /** Cleaned body, capped at maxSlideTextChars (NO_TEXT_PLACEHOLDER when the slide has no text). */
  body: string;
  /** The slide has neither a usable digest entry nor extracted text. */
  empty: boolean;
}

/** Summaries of the earlier lectures of the course, ready for the priming turn. */
interface EarlierLectures {
  /** "### Lecture i: <title>\n<summary>" per earlier lecture, oldest first. */
  sections: string[];
  /** At least one earlier lecture has a summary (even if it was omitted for length). */
  anySummary: boolean;
  /** Earlier lectures whose summary is actually included (in full or truncated). */
  included: number;
}

/** What the priming dump contains (see planDump). */
interface DumpPlan {
  kind: prompts.MaterialKind;
  /** "### Slide N" sections of the slides that have an entry, in slide order. */
  sections: string[];
  /** First slide whose material did not fit at all (it and every later slide are left out); null = none. */
  firstOmitted: number | null;
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
  const earlier = course ? earlierLectureSections(course.lectures.slice(0, course.position), settings.maxCourseContextChars) : null;
  const agenticCli = isAgenticCli(session.provider);
  const forced = recoveryKind(input.forceNewConversation);
  // Attachments of the question (never of a priming turn), each one image; they leave room for one slide at least.
  const attachments = kind === 'question' ? normalizeAttachments(input.attachments, maxImages - 1) : [];

  const windowSlides = focusWindow(
    slide,
    pageCount,
    resolveNeighbors(input.neighbors, settings.neighborWindow),
    Math.max(1, maxImages - attachments.length),
  );

  // A primed conversation without a resume handle cannot be continued, so treat it as unprimed.
  const needsPrime = !state.primed || state.resume === null;
  const cost =
    (needsPrime ? windowSlides.length : windowSlides.filter((s) => !state.recentSlides.includes(s)).length) + attachments.length;
  const overBudget = !needsPrime && state.imagesSent + cost > maxImages;
  // The session's LLM was changed and the conversation it had dropped (ProviderState.switched).
  const switched = state.switched === true;
  // The orchestrator forces a new conversation when the provider lost the old one or it grew too large.
  const rollover = overBudget || forced !== null || switched;
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
    sheets = appendPriming(out, {
      doc,
      pageCount,
      settings,
      agenticCli,
      course,
      earlier,
      materialOf,
      windowSlides,
      extraImages: attachments.length,
      maxImages,
    });
    // The document has transcribed lecture recordings (DESIGN §22): one line, the speech itself comes with questions.
    if (input.lectureSpeech) out.text(prompts.LECTURE_RECORDINGS_NOTE);
    // Recap the Q&A so far whenever a conversation starts in a session that already has some
    // (after a rollover, a recovery, an LLM switch, or a provider state that was reset).
    const reason: prompts.RestartReason = forced ?? (switched ? 'provider_switch' : overBudget ? 'budget' : 'restart');
    appendRecap(out, Array.isArray(session.messages) ? session.messages : [], settings.recapTurns, reason);
    // A fresh state: no `switched` any more, the switch's new conversation is this one.
    nextState = {
      resume: null, // filled in by the orchestrator from the provider result
      primed: true,
      imagesSent: sheets.length + attached.length + attachments.length,
      recentSlides,
      generation: state.generation + 1,
      history: [],
    };
  } else {
    nextState = {
      ...state,
      resume: cloneResume(state.resume),
      imagesSent: state.imagesSent + attached.length + attachments.length,
      recentSlides,
      history: [...state.history],
    };
  }

  appendFocus(out, doc, slide, pageCount, windowSlides, new Set(attached), materialOf, agenticCli);
  appendAttachments(out, attachments, settings.maxSlideTextChars);
  if (kind === 'question') appendLectureSpeech(out, input.lectureSpeech, windowSlides, slide);
  const memosIncluded = kind === 'question' ? appendStudentMemos(out, input.studentMemos, windowSlides, slide) : 0;
  if (kind === 'prime') {
    // Only ask how the lecture builds on earlier ones when their summaries are actually in context.
    out.text(prompts.primeInstruction((earlier?.included ?? 0) > 0));
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
  if (forced !== null) context.recoveredFrom = forced;
  if (switched) context.switched = true;
  if (attachments.length > 0) context.attachments = attachments.length;
  if (memosIncluded > 0) context.memos = memosIncluded;

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
  settings: ContextSettings;
  agenticCli: boolean;
  course: ResolvedCourse | null;
  earlier: EarlierLectures | null;
  materialOf: (slide: number) => SlideMaterial;
  /** Focus window of this turn (attached in full resolution right after the priming). */
  windowSlides: number[];
  /** Other images of this turn after the priming (the question's attachments). */
  extraImages: number;
  maxImages: number;
}

/**
 * PRIMING(doc): header, course context, overview sheets (each preceded by its label line), all slide
 * material. Returns the overview sheets that were attached.
 */
function appendPriming(out: PartsBuilder, input: PrimingInput): Sheet[] {
  const { doc, pageCount, settings, agenticCli, course, earlier, materialOf, windowSlides, extraImages, maxImages } = input;
  const turnImages = windowSlides.length + extraImages;
  const digestSlides = countDigestSlides(materialOf, pageCount);
  const material: prompts.MaterialKind =
    digestSlides === 0 ? 'extracted' : digestSlides === pageCount ? 'digest' : 'mixed';

  // Overview sheets: 'always', or 'auto' without a complete digest (capped for huge decks).
  let sheets = useOverviewSheets(settings.primeWithImages, material === 'digest')
    ? selectSheets(doc.sheets, maxImages, turnImages)
    : [];
  // Slides whose image the model gets in this turn; a slide without text may only say "see the image" then.
  const shown = new Set<number>(windowSlides);
  for (const sheet of sheets) for (let s = sheet.fromSlide; s <= sheet.toSlide; s++) shown.add(s);
  const placeholderFor = (slide: number) =>
    shown.has(slide)
      ? prompts.NO_TEXT_PLACEHOLDER
      : agenticCli
        ? prompts.NO_TEXT_FILE_PLACEHOLDER
        : prompts.NO_TEXT_NO_IMAGE_PLACEHOLDER;
  const dump = planDump(pageCount, settings.maxPrimeTextChars, material, materialOf, placeholderFor);

  // A complete digest normally replaces the sheets ('auto'), but slides whose material did not fit
  // at all would then be unknown to the model: attach the sheets of those slides instead.
  if (sheets.length === 0 && settings.primeWithImages === 'auto' && dump.firstOmitted !== null) {
    const first = dump.firstOmitted;
    sheets = selectSheets(
      doc.sheets.filter((sheet) => sheet.toSlide >= first),
      maxImages,
      turnImages,
    );
  }

  out.text(
    prompts.primingHeader({
      title: doc.meta.title || doc.meta.fileName || 'Untitled deck',
      fileName: doc.meta.fileName || 'source.pdf',
      pageCount,
      overviewImages: sheets.length,
      material,
      courseContext: course !== null,
      earlierSummaries: (earlier?.included ?? 0) > 0,
    }),
  );

  if (course && earlier) appendCourseContext(out, doc, course, earlier, agenticCli);

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
  if (sheets.length > 0 && sheets.length < doc.sheets.length && sheets[0] === doc.sheets[0]) {
    const lastCovered = sheets[sheets.length - 1].toSlide;
    if (lastCovered < pageCount) out.text(prompts.overviewLimitedNote(lastCovered, pageCount, dump.firstOmitted === null));
  }

  const dumpParts = [prompts.materialHeading(material), ...dump.sections];
  if (dump.firstOmitted !== null) {
    dumpParts.push(
      prompts.textOmittedNote(dump.firstOmitted, pageCount, {
        overviewUpTo: coveredUpTo(sheets, dump.firstOmitted),
        slideFiles: agenticCli,
      }),
    );
  }
  out.text(dumpParts.join('\n\n'));

  if (agenticCli) {
    out.text(prompts.slideFilesNote(slideFileRef(doc, 1), slideFileRef(doc, pageCount), pageCount));
  }
  return sheets;
}

/** Last slide such that every slide from `from` up to it is on one of `sheets`; null when `from` is not. */
function coveredUpTo(sheets: Sheet[], from: number): number | null {
  const covered = new Set<number>();
  for (const sheet of sheets) for (let s = sheet.fromSlide; s <= sheet.toSlide; s++) covered.add(s);
  let last = from - 1;
  while (covered.has(last + 1)) last++;
  return last >= from ? last : null;
}

/**
 * COURSE CONTEXT (DESIGN §12): the lecture list, summaries of the earlier lectures (oldest first,
 * capped by dropping the oldest summaries first; left out when none of them has a summary) and, for
 * agentic CLIs, where the other lectures' files are.
 */
function appendCourseContext(
  out: PartsBuilder,
  doc: DocAssets,
  course: ResolvedCourse,
  earlier: EarlierLectures,
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

  if (earlier.anySummary && earlier.sections.length > 0) {
    out.text([prompts.EARLIER_LECTURES_HEADING, ...earlier.sections].join('\n\n'));
  }
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
function earlierLectureSections(earlier: CourseLectureRef[], maxChars: number): EarlierLectures {
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
  return {
    sections: bodies.map((_, i) => section(i)),
    anySummary: withSummary.length > 0,
    included: withSummary.filter((i) => bodies[i] !== prompts.SUMMARY_OMITTED_NOTE).length,
  };
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

/** RECAP: the latest complete Q&A pairs of this session, as text, and why the conversation restarted. */
function appendRecap(out: PartsBuilder, messages: ChatMessage[], recapTurns: number, reason: prompts.RestartReason): void {
  if (recapTurns <= 0) return;
  const pairs = completedPairs(messages).slice(-recapTurns);
  if (pairs.length === 0) return;
  const lines = pairs.map((p) =>
    prompts.recapLine(
      p.slide,
      squeeze(p.question, RECAP_CHARS) + (p.attachments > 0 ? prompts.recapAttachmentsNote(p.attachments) : ''),
      squeeze(p.answer, RECAP_CHARS),
    ),
  );
  out.text([prompts.RECAP_HEADING, ...lines, '', prompts.restartNote(reason)].join('\n'));
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
  agenticCli: boolean,
): void {
  out.text(prompts.focusLine(slide, pageCount));
  if (windowSlides.length > 1) {
    out.text(prompts.neighborsLine(windowSlides[0], windowSlides[windowSlides.length - 1], slide));
  }
  for (const s of windowSlides) {
    const label = prompts.windowSlideLabel(s, s === slide);
    if (!attached.has(s)) {
      // Agentic CLIs may have compacted old images away: tell them where the file is.
      out.text(`${label}\n${prompts.focusReusedLine(s, agenticCli ? slideFileRef(doc, s) : undefined)}`);
      continue;
    }
    // The line right before the image names it (keeps image parts next to their label).
    out.text(`${label}\n${prompts.focusImageLine(s)}`);
    out.image({ type: 'image', path: doc.slidePath(s), detail: 'high', label: prompts.focusImageLabel(s) });
    const m = materialOf(s);
    out.text(m.kind === 'digest' ? prompts.focusDigestBlock(s, m.title, m.body) : prompts.focusTextBlock(s, m.body));
  }
}

/**
 * ATTACHMENTS (DESIGN §21), after the focus window: how many there are, then per attachment its label line, the
 * image (detail 'high') and, for a selected region, the PDF text inside the selection (capped like slide text).
 */
function appendAttachments(out: PartsBuilder, attachments: TurnAttachment[], maxTextChars: number): void {
  if (attachments.length === 0) return;
  out.text(prompts.attachmentsIntro(attachments.length));
  for (const attachment of attachments) {
    out.text(prompts.attachmentLabelLine(attachment.label));
    out.image({ type: 'image', path: attachment.path, detail: 'high', label: attachment.label });
    if (attachment.kind === 'region') {
      out.text(prompts.selectionTextBlock(truncateText(cleanExtractedText(attachment.text ?? ''), maxTextChars)));
      // A region made from a 필기 with text (DESIGN §25): the student's note or the highlighted words follow.
      const annotation = attachment.annotation;
      if (annotation && typeof annotation.text === 'string' && annotation.text.trim()) {
        out.text(prompts.annotationTextBlock(annotation.type, truncateText(cleanExtractedText(annotation.text), maxTextChars)));
      }
    }
  }
}

/**
 * STUDENT MEMOS (DESIGN §25), after the lecture speech and before the question: the student's memos on the slides
 * of the focus window (others are ignored), one text part per slide in ascending slide order; the focused slide's
 * memos are kept first when the caps bite (≤ MAX_MEMO_CHARS each, ≤ MAX_WINDOW_MEMO_CHARS together, ≤
 * MAX_TUTOR_MEMOS). Returns how many memos were included (ContextInfo.memos).
 */
function appendStudentMemos(out: PartsBuilder, memos: BuildTurnInput['studentMemos'], windowSlides: number[], slide: number): number {
  if (!Array.isArray(memos)) return 0;
  const bySlide = new Map<number, Array<{ text: string; tags?: string[] }>>();
  for (const memo of memos) {
    if (!memo || typeof memo !== 'object' || !windowSlides.includes(memo.slide) || typeof memo.text !== 'string') continue;
    const text = memo.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tags = Array.isArray(memo.tags) ? memo.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '') : [];
    const list = bySlide.get(memo.slide) ?? [];
    list.push(tags.length > 0 ? { text, tags } : { text });
    bySlide.set(memo.slide, list);
  }
  // The focused slide first, then its neighbours nearest first, share the caps.
  const order = [...bySlide.keys()].sort((a, b) => Math.abs(a - slide) - Math.abs(b - slide) || a - b);
  let budget = MAX_WINDOW_MEMO_CHARS;
  let count = 0;
  const kept = new Map<number, Array<{ text: string; tags?: string[] }>>();
  for (const s of order) {
    for (const memo of bySlide.get(s) ?? []) {
      const cap = Math.min(MAX_MEMO_CHARS, budget);
      if (count >= MAX_TUTOR_MEMOS || cap <= prompts.TRUNCATED_MARK.length) break;
      const text = memo.text.length > cap ? truncateText(memo.text, cap - prompts.TRUNCATED_MARK.length) : memo.text;
      budget -= text.length;
      count++;
      const list = kept.get(s) ?? [];
      list.push(memo.tags ? { text, tags: memo.tags } : { text });
      kept.set(s, list);
    }
  }
  for (const s of [...kept.keys()].sort((a, b) => a - b)) out.text(prompts.studentMemosBlock(s, kept.get(s) ?? []));
  return count;
}

/**
 * LECTURE SPEECH (DESIGN §22), before the question: for each slide of the focus window that has speech, what the
 * professor said on it (≤ 1500 characters each, ≤ 4000 together, the focused slide's first), then — while a live
 * recording of the document runs — the last minutes of the lecture (≤ 3000 characters, the latest kept).
 */
function appendLectureSpeech(out: PartsBuilder, speech: BuildTurnInput['lectureSpeech'], windowSlides: number[], slide: number): void {
  if (!speech || typeof speech !== 'object') return;
  const inWindow = new Map<number, string>();
  for (const entry of Array.isArray(speech.bySlide) ? speech.bySlide : []) {
    if (!entry || !windowSlides.includes(entry.slide) || typeof entry.text !== 'string') continue;
    const text = entry.text.replace(/\s+/g, ' ').trim();
    if (text) inWindow.set(entry.slide, text);
  }
  let budget = MAX_WINDOW_SPEECH_CHARS;
  const kept = new Map<number, string>();
  // The focused slide first, then its neighbours nearest first.
  const order = [...inWindow.keys()].sort((a, b) => Math.abs(a - slide) - Math.abs(b - slide) || a - b);
  for (const s of order) {
    const cap = Math.min(MAX_SLIDE_SPEECH_CHARS, budget);
    if (cap <= prompts.TRUNCATED_MARK.length) break;
    const full = inWindow.get(s) ?? '';
    const text = full.length > cap ? truncateText(full, cap - prompts.TRUNCATED_MARK.length) : full;
    budget -= text.length;
    kept.set(s, text);
  }
  for (const s of [...kept.keys()].sort((a, b) => a - b)) out.text(prompts.slideSpeechBlock(s, kept.get(s) ?? ''));
  const recent = speech.recent;
  if (recent && typeof recent.text === 'string') {
    const text = recent.text.replace(/\s+/g, ' ').trim();
    if (text) {
      const minutes = Math.max(1, Math.round(finiteOr(recent.minutes, 3)));
      const tail = text.length > MAX_RECENT_SPEECH_CHARS ? `…${text.slice(text.length - MAX_RECENT_SPEECH_CHARS + 1).trimStart()}` : text;
      out.text(prompts.recentSpeechBlock(minutes, tail));
    }
  }
}

/** BuildTurnInput.attachments, validated (entries without a path or label are dropped), at most `max`. */
function normalizeAttachments(raw: BuildTurnInput['attachments'], max: number): TurnAttachment[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(
    (a): a is TurnAttachment =>
      !!a && typeof a === 'object' && (a.kind === 'region' || a.kind === 'image') && typeof a.path === 'string' && !!a.path && typeof a.label === 'string',
  );
  return valid.slice(0, Math.max(0, max)).map((a) => {
    const attachment: TurnAttachment = { ...a, label: a.label.replace(/\s+/g, ' ').trim() || 'Attachment' };
    // The 필기 snapshot (DESIGN §25) only when it is well formed.
    const annotation = a.annotation;
    if (annotation && typeof annotation === 'object' && typeof annotation.type === 'string') {
      attachment.annotation = typeof annotation.text === 'string' ? { type: annotation.type, text: annotation.text } : { type: annotation.type };
    } else {
      delete attachment.annotation;
    }
    return attachment;
  });
}

/**
 * The "### Slide N" sections of the priming dump, within `cap` characters (sections plus the blank
 * lines between them).
 *
 * When everything does not fit, the slides share the cap: each keeps its material up to a common
 * per-slide limit, chosen as large as the cap allows (short entries stay whole, long ones are cut; a
 * digest entry keeps its "핵심:" line and loses text before it). Only when not even a minimal entry
 * per slide fits are the last slides left out (DumpPlan.firstOmitted).
 */
function planDump(
  pageCount: number,
  cap: number,
  kind: prompts.MaterialKind,
  materialOf: (slide: number) => SlideMaterial,
  placeholderFor: (slide: number) => string,
): DumpPlan {
  interface Entry {
    n: number;
    kind: SlideMaterial['kind'];
    opts: { title: string; pdfTextMark: boolean };
    body: string;
    /** Heading line, its newline and the blank line separating the section from the next one. */
    fixed: number;
  }
  const entries: Entry[] = [];
  for (let n = 1; n <= pageCount; n++) {
    const m = materialOf(n);
    const opts = { title: m.kind === 'digest' ? m.title : '', pdfTextMark: kind === 'mixed' && m.kind === 'extracted' };
    const body = m.empty ? placeholderFor(n) : m.body;
    entries.push({ n, kind: m.kind, opts, body, fixed: prompts.slideTextSection(n, '', opts).length + 2 });
  }
  const section = (e: Entry, body: string) => prompts.slideTextSection(e.n, body, e.opts);
  /** The body cut to about `limit` characters (never below MIN_BODY_CHARS, never longer than the body). */
  const cut = (e: Entry, limit: number) => {
    const short = shortenBody(e.kind, e.body, Math.max(limit, MIN_BODY_CHARS));
    return short.length < e.body.length ? short : e.body;
  };

  const fixedTotal = entries.reduce((sum, e) => sum + e.fixed, 0);
  if (fixedTotal + entries.reduce((sum, e) => sum + e.body.length, 0) <= cap) {
    return { kind, sections: entries.map((e) => section(e, e.body)), firstOmitted: null };
  }

  const minLength = entries.map((e) => cut(e, 0).length);
  if (fixedTotal + minLength.reduce((sum, n) => sum + n, 0) > cap) {
    // Not even a minimal entry per slide fits: keep minimal entries in order and leave out the rest.
    const sections: string[] = [];
    let used = 0;
    for (const [i, e] of entries.entries()) {
      if (used + e.fixed + minLength[i] > cap) return { kind, sections, firstOmitted: e.n };
      sections.push(section(e, cut(e, 0)));
      used += e.fixed + minLength[i];
    }
    return { kind, sections, firstOmitted: null };
  }

  // Upper bound of the dump's size when every body is cut at `limit` (monotone in `limit`).
  const bound = (limit: number) =>
    entries.reduce((sum, e, i) => {
      const l = Math.max(limit, MIN_BODY_CHARS);
      return sum + e.fixed + Math.min(e.body.length, Math.max(l + SHORTEN_SLACK, minLength[i]));
    }, 0);
  let lo = 0;
  let hi = entries.reduce((max, e) => Math.max(max, e.body.length), 0);
  if (bound(lo) > cap) {
    // The minimal entries fit, but the bound is not tight enough to allow more.
    return { kind, sections: entries.map((e) => section(e, cut(e, 0))), firstOmitted: null };
  }
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bound(mid) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return { kind, sections: entries.map((e) => section(e, cut(e, lo))), firstOmitted: null };
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
      m = { kind: 'digest', title: cleanTitle(entry.title), body: shortenBody('digest', body, maxChars), empty: false };
    } else {
      const text = cleanExtractedText(doc.texts[slide - 1] ?? '');
      m = text
        ? { kind: 'extracted', title: '', body: shortenBody('extracted', text, maxChars), empty: false }
        : { kind: 'extracted', title: '', body: prompts.NO_TEXT_PLACEHOLDER, empty: true };
    }
    cache.set(slide, m);
    return m;
  };
}

/**
 * `body` cut to about `max` characters: at most max + SHORTEN_SLACK, except that a digest entry always
 * keeps its "핵심:" takeaway (the text before it is cut first, down to just the truncation mark).
 * Other bodies are cut at the end (closing a code fence the cut leaves open).
 */
function shortenBody(kind: SlideMaterial['kind'], body: string, max: number): string {
  if (body.length <= max) return body;
  if (kind === 'digest') {
    const split = splitKeyLine(body);
    if (split) {
      if (!split.head) return split.key;
      const room = max - split.key.length - 1;
      const head = room >= MIN_HEAD_CHARS ? truncateMarkdown(split.head, room) : prompts.TRUNCATED_MARK;
      return `${head}\n${split.key}`;
    }
    return truncateMarkdown(body, max);
  }
  return truncateText(body, max);
}

/** A digest takeaway line: "핵심: …", also decorated ("**핵심:**", "- **핵심**: …"). */
const KEY_LINE_RE = /^\s{0,3}(?:[-*+>]\s+)?(?:\*\*|__)?\s*핵심\s*(?:\*\*|__)?\s*[:：]/;

/** Splits a digest body at its last "핵심:" line outside code fences (the takeaway runs to the end). */
function splitKeyLine(body: string): { head: string; key: string } | null {
  const lines = body.split('\n');
  let inFence = false;
  let at = -1;
  lines.forEach((line, i) => {
    if (FENCE_RE.test(line)) inFence = !inFence;
    else if (!inFence && KEY_LINE_RE.test(line)) at = i;
  });
  if (at < 0) return null;
  const key = lines.slice(at).join('\n').trim();
  return {
    head: lines.slice(0, at).join('\n').trim(),
    key: key.length > MAX_KEY_CHARS ? truncateMarkdown(key, MAX_KEY_CHARS) : key,
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

function completedPairs(messages: ChatMessage[]): Array<{ slide: number; question: string; answer: string; attachments: number }> {
  const pairs: Array<{ slide: number; question: string; answer: string; attachments: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const q = messages[i];
    if (q.role !== 'user' || q.kind !== 'question') continue;
    const a = messages[i + 1];
    if (a && a.role === 'assistant' && a.status === 'complete' && a.text.trim()) {
      const attachments = Array.isArray(q.attachments) ? q.attachments.length : 0;
      pairs.push({ slide: q.slide, question: q.text, answer: a.text, attachments });
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

/** BuildTurnInput.forceNewConversation, validated (null = not forced). */
function recoveryKind(value: unknown): RecoveryKind | null {
  return value === 'resume_invalid' || value === 'context_overflow' ? value : null;
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
  const state: ProviderState = {
    resume: raw.resume && typeof raw.resume === 'object' ? cloneResume(raw.resume) : null,
    primed: raw.primed === true,
    imagesSent: Math.max(0, Math.floor(finiteOr(raw.imagesSent, 0))),
    recentSlides: recent,
    generation: Math.max(0, Math.floor(finiteOr(raw.generation, 0))),
    history: Array.isArray(raw.history) ? raw.history : [],
  };
  if (raw.switched === true) state.switched = true;
  return state;
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
 * Normalises extracted page text (text/NNN.txt: PDFium's, or pdftotext -layout's in documents converted before
 * DESIGN §17): unix newlines, no control chars, no trailing spaces, at most one blank line, and long runs of
 * layout padding shortened to 4 spaces (columns stay separated, but padding no longer eats the prime text budget).
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
