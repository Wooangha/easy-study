// Context strategy: decides what is sent to the LLM on every turn (DESIGN §5).
//
// - The first turn of a provider conversation "primes" it with the whole deck (overview contact
//   sheets + extracted text of every slide) plus the focused slide at full resolution.
// - Later turns re-send the focused slide's image only when it is not among the slides sent
//   recently (LRU window), and just point back to it otherwise.
// - When the conversation would exceed the provider's image budget, a fresh conversation is started
//   (rollover): the deck is primed again and a text recap of the latest Q&A is included.
//
// Everything in this file is pure: no filesystem access, no clock, no randomness. Paths and texts
// come from DocAssets; identical inputs always produce identical outputs.
import path from 'node:path';
import type { ChatMessage, ContextInfo } from '../shared/types.ts';
import type {
  BuildTurnInput,
  BuildTurnOutput,
  ContextSettings,
  DocAssets,
  ProviderState,
} from './internal-types.ts';
import type { HistoryTurn, Part, ResumeHandle } from './providers/types.ts';
import * as prompts from './prompts.ts';

export const DEFAULT_CONTEXT_SETTINGS: Readonly<ContextSettings> = Object.freeze({
  recentWindow: 4,
  primeWithImages: true,
  maxPrimeTextChars: 60_000,
  maxSlideTextChars: 2_500,
  recapTurns: 6,
});

/** Max characters of each question / answer quoted in a rollover recap. */
const RECAP_CHARS = 600;

/**
 * Focus images kept in reserve when capping overview sheets for huge decks, so that a freshly
 * primed conversation can still take a few questions before rolling over again.
 */
const FOCUS_IMAGE_RESERVE = 16;

/** Do not bother with a partial slide section shorter than this when the prime text cap is hit. */
const MIN_PARTIAL_SECTION_CHARS = 200;

type ImagePart = Extract<Part, { type: 'image' }>;
type Sheet = DocAssets['sheets'][number];

// ---------------------------------------------------------------------------
// Settings / state
// ---------------------------------------------------------------------------

/** Context settings from the environment (DESIGN §5 defaults; unset/invalid values fall back). */
export function defaultContextSettings(env: NodeJS.ProcessEnv = process.env): ContextSettings {
  const d = DEFAULT_CONTEXT_SETTINGS;
  return {
    recentWindow: intFromEnv(env.EASY_STUDY_RECENT_WINDOW, d.recentWindow, 1, 100),
    primeWithImages: boolFromEnv(env.EASY_STUDY_PRIME_IMAGES, d.primeWithImages),
    maxPrimeTextChars: intFromEnv(env.EASY_STUDY_MAX_PRIME_TEXT_CHARS, d.maxPrimeTextChars, 0, 5_000_000),
    maxSlideTextChars: intFromEnv(env.EASY_STUDY_MAX_SLIDE_TEXT_CHARS, d.maxSlideTextChars, 0, 1_000_000),
    recapTurns: intFromEnv(env.EASY_STUDY_RECAP_TURNS, d.recapTurns, 0, 100),
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

  const alreadySent = state.primed && state.recentSlides.includes(slide);
  const focusCost = alreadySent ? 0 : 1;
  // A primed conversation without a resume handle cannot be continued, so treat it as unprimed.
  const needsPrime = !state.primed || state.resume === null;
  const rollover = !needsPrime && state.imagesSent + focusCost > maxImages;
  const startsConversation = needsPrime || rollover;

  const out = new PartsBuilder();
  let sheets: Sheet[] = [];
  let nextState: ProviderState;
  let attachFocusImage: boolean;

  if (startsConversation) {
    sheets = settings.primeWithImages ? selectSheets(doc.sheets, maxImages) : [];
    appendPriming(out, doc, pageCount, sheets, settings, isAgenticCli(session.provider));
    if (rollover) appendRecap(out, Array.isArray(session.messages) ? session.messages : [], settings.recapTurns);
    attachFocusImage = true;
    nextState = {
      resume: null, // filled in by the orchestrator from the provider result
      primed: true,
      imagesSent: sheets.length + 1,
      recentSlides: [slide],
      generation: state.generation + 1,
      history: [],
    };
  } else if (alreadySent) {
    attachFocusImage = false;
    nextState = {
      ...state,
      resume: cloneResume(state.resume),
      recentSlides: moveToFront(state.recentSlides, slide).slice(0, settings.recentWindow),
      history: [...state.history],
    };
  } else {
    attachFocusImage = true;
    nextState = {
      ...state,
      resume: cloneResume(state.resume),
      imagesSent: state.imagesSent + 1,
      recentSlides: moveToFront(state.recentSlides, slide).slice(0, settings.recentWindow),
      history: [...state.history],
    };
  }

  appendFocus(out, doc, slide, pageCount, attachFocusImage, settings.maxSlideTextChars);
  if (kind === 'prime') {
    out.text(prompts.PRIME_INSTRUCTION);
  } else {
    out.text(prompts.questionBlock(slide, String(input.question ?? '').trim()));
  }

  const context: ContextInfo = {
    primed: startsConversation,
    rollover,
    attachedSlides: attachFocusImage ? [slide] : [],
    reusedSlides: attachFocusImage ? [] : [slide],
    overviewImages: startsConversation ? sheets.length : 0,
  };

  return {
    systemPrompt: prompts.tutorSystemPrompt(),
    parts: out.parts,
    resume: startsConversation ? null : cloneResume(state.resume),
    history: startsConversation ? [] : state.history.map(cloneTurn),
    context,
    nextState,
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** PRIMING(doc): header, overview sheets (each preceded by its label line), all slide text. */
function appendPriming(
  out: PartsBuilder,
  doc: DocAssets,
  pageCount: number,
  sheets: Sheet[],
  settings: ContextSettings,
  agenticCli: boolean,
): void {
  out.text(
    prompts.primingHeader({
      title: doc.meta.title || doc.meta.fileName || 'Untitled deck',
      fileName: doc.meta.fileName || 'source.pdf',
      pageCount,
      overviewImages: sheets.length,
    }),
  );

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

  out.text(slideTextDump(doc, pageCount, settings));

  if (agenticCli) {
    out.text(prompts.slideFilesNote(slideFileRef(doc, 1), slideFileRef(doc, pageCount), pageCount));
  }
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

/** FOCUS(slide, withImage). */
function appendFocus(
  out: PartsBuilder,
  doc: DocAssets,
  slide: number,
  pageCount: number,
  withImage: boolean,
  maxSlideTextChars: number,
): void {
  out.text(prompts.focusLine(slide, pageCount));
  if (!withImage) {
    out.text(prompts.focusReusedLine(slide));
    return;
  }
  out.text(prompts.focusImageLine(slide));
  out.image({ type: 'image', path: doc.slidePath(slide), detail: 'high', label: prompts.focusImageLabel(slide) });
  out.text(prompts.focusTextBlock(slide, slideBody(doc, slide, maxSlideTextChars)));
}

/** "### Slide N" sections for every slide, capped per slide and as a whole. */
function slideTextDump(doc: DocAssets, pageCount: number, settings: ContextSettings): string {
  const cap = settings.maxPrimeTextChars;
  const sections: string[] = [];
  let used = 0;
  for (let n = 1; n <= pageCount; n++) {
    const body = slideBody(doc, n, settings.maxSlideTextChars);
    const section = prompts.slideTextSection(n, body);
    const cost = section.length + 2; // sections are joined by a blank line
    if (used + cost <= cap) {
      sections.push(section);
      used += cost;
      continue;
    }
    // The whole-dump cap is reached: keep a truncated piece of this slide if it is worth it,
    // then summarise the remaining slides in a single line.
    let firstOmitted = n;
    const heading = prompts.slideTextSection(n, '');
    const room = cap - used - 2 - heading.length;
    if (room >= MIN_PARTIAL_SECTION_CHARS) {
      sections.push(heading + truncate(body, room));
      firstOmitted = n + 1;
    }
    if (firstOmitted <= pageCount) sections.push(prompts.textOmittedNote(firstOmitted, pageCount));
    break;
  }
  return [prompts.EXTRACTED_TEXT_HEADING, ...sections].join('\n\n');
}

/** Cleaned, capped extracted text of one slide (placeholder when it has none). */
function slideBody(doc: DocAssets, slide: number, maxChars: number): string {
  const text = cleanText(doc.texts[slide - 1] ?? '');
  return text ? truncate(text, maxChars) : prompts.NO_TEXT_PLACEHOLDER;
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
 * that the priming turn leaves room for the focus image and a few more focus images afterwards.
 */
function selectSheets(sheets: Sheet[], maxImages: number): Sheet[] {
  const reserve = Math.min(FOCUS_IMAGE_RESERVE, Math.floor(maxImages / 3));
  const budget = Math.max(0, maxImages - 1 - reserve);
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
    primeWithImages: typeof s?.primeWithImages === 'boolean' ? s.primeWithImages : d.primeWithImages,
    maxPrimeTextChars: Math.max(0, Math.floor(finiteOr(s?.maxPrimeTextChars, d.maxPrimeTextChars))),
    maxSlideTextChars: Math.max(0, Math.floor(finiteOr(s?.maxSlideTextChars, d.maxSlideTextChars))),
    recapTurns: Math.max(0, Math.floor(finiteOr(s?.recapTurns, d.recapTurns))),
  };
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

function moveToFront(list: number[], item: number): number[] {
  return [item, ...list.filter((x) => x !== item)];
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

/**
 * Normalises pdftotext -layout output: unix newlines, no control chars, no trailing spaces,
 * at most one blank line, and long runs of layout padding shortened to 4 spaces (columns stay
 * separated, but padding no longer eats the prime text budget).
 */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{5,}/g, '    ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cuts `text` to at most `max` characters (+ the truncation mark), never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd() + prompts.TRUNCATED_MARK;
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

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return fallback;
}
