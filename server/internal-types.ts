// Server-internal contracts shared by sessions.ts, context.ts and chat.ts.
import type { ChatMessage, ContextInfo, DigestSlide, DigestStatus, DocMeta, ProviderId } from '../shared/types.ts';
import type { HistoryTurn, Part, ResumeHandle } from './providers/types.ts';

/** State of the conversation held *inside the provider* (CLI session / API thread). */
export interface ProviderState {
  /** null until the first successful turn of the current provider conversation. */
  resume: ResumeHandle | null;
  /** Whole deck has been fed to the current provider conversation. */
  primed: boolean;
  /** Images accumulated in the current provider conversation (overview sheets + focus slides). */
  imagesSent: number;
  /**
   * Slides whose full-resolution image was sent in the current provider conversation,
   * most recent first, at most ContextSettings.recentWindow entries.
   */
  recentSlides: number[];
  /** How many provider conversations this session has used (1 after the first priming). */
  generation: number;
  /** Turns of the current provider conversation (only kept for stateless API providers). */
  history: HistoryTurn[];
}

/** Persisted as library/<docId>/sessions/<sessionId>.json */
export interface SessionRecord {
  version: 1;
  id: string;
  docId: string;
  title: string;
  provider: ProviderId;
  model: string;
  createdAt: string;
  updatedAt: string;
  providerState: ProviderState;
  messages: ChatMessage[];
}

export interface ContextSettings {
  /**
   * Do not re-send a slide's full image if it is among the last N slides sent in the current
   * provider conversation. Default 8 (env EASY_STUDY_RECENT_WINDOW).
   */
  recentWindow: number;
  /**
   * Default number of slides before AND after the focused slide that are fed with it (0–3).
   * Default 1 (env EASY_STUDY_NEIGHBORS). A request may override it (SendMessageRequest.neighbors).
   */
  neighborWindow: number;
  /**
   * Overview contact sheets when priming: 'auto' = only when the document has no complete digest,
   * 'always', 'never'. Default 'auto' (env EASY_STUDY_PRIME_IMAGES=auto|always|never; legacy 1/0 = always/never).
   */
  primeWithImages: 'auto' | 'always' | 'never';
  /** Max characters of per-slide material (digest or extracted text) included when priming. Default 120000. */
  maxPrimeTextChars: number;
  /** Max characters per slide in the priming dump. Default 4000. */
  maxSlideTextChars: number;
  /** Number of most recent Q&A pairs recapped (as text) after a rollover. Default 6. */
  recapTurns: number;
  /** Max characters of course context (previous lecture summaries) included when priming. Default 30000. */
  maxCourseContextChars: number;
}

/** A lecture of the course the current document belongs to. */
export interface CourseLectureRef {
  docId: string;
  title: string;
  /** 1-based position in the course. */
  index: number;
  pageCount: number;
  /** Absolute path of library/<docId>. */
  dir: string;
  /** DigestInfo.summary of that lecture, if its digest has one. */
  summary: string | null;
  /** The lecture has a complete digest (DIGEST.md with every slide). */
  hasDigest: boolean;
}

export interface CourseContext {
  id: string;
  title: string;
  /** All lectures of the course in order, INCLUDING the current document. */
  lectures: CourseLectureRef[];
  /** 1-based index of the current document within `lectures`. */
  currentIndex: number;
}

/** Everything the context builder needs to know about the document on disk. */
export interface DocAssets {
  meta: DocMeta;
  /** Absolute path of library/<docId>. */
  dir: string;
  /** Extracted text per slide, index 0 = slide 1. */
  texts: string[];
  /** Absolute path of the full-resolution PNG for a 1-based slide number. */
  slidePath: (slide: number) => string;
  /** Overview contact sheets in slide order. */
  sheets: Array<{ path: string; fromSlide: number; toSlide: number }>;
  /** Digest entries available for this document (possibly partial), ascending; null when there is no digest. */
  digest: DigestSlide[] | null;
  /** Every slide has a non-failed digest entry. */
  digestComplete: boolean;
  /** Course context, or null when the document is not in a course. */
  course: CourseContext | null;
}

export interface BuildTurnInput {
  doc: DocAssets;
  /** Session *before* this turn (messages do not yet include the new user message). */
  session: SessionRecord;
  kind: 'question' | 'prime';
  /** User question ('' for kind === 'prime'). */
  question: string;
  /** 1-based focused slide. */
  slide: number;
  /** Slides before/after the focused slide to feed as well (buildTurn clamps to 0..3). */
  neighbors: number;
  settings: ContextSettings;
  /** Provider.maxImagesPerConversation of the session's provider. */
  maxImagesPerConversation: number;
}

export interface BuildTurnOutput {
  systemPrompt: string;
  parts: Part[];
  /** null = start a new provider conversation (priming / rollover). */
  resume: ResumeHandle | null;
  /** History to hand to the provider (empty when resume === null). */
  history: HistoryTurn[];
  context: ContextInfo;
  /** Absolute dirs of the OTHER lectures of the course (passed to providers as extraReadDirs). */
  readDirs: string[];
  /**
   * Provider state to persist *if the turn succeeds*. The orchestrator fills in `resume`
   * from the provider result and, for stateless providers, appends this turn + the answer
   * to `history` (see appendHistory in context.ts).
   */
  nextState: ProviderState;
}

/** Persisted as library/<docId>/digest/digest.json */
export interface DigestRecord {
  version: 1;
  status: DigestStatus;
  provider?: ProviderId;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  /** Ascending by slide. */
  slides: DigestSlide[];
  summary: string | null;
}

/** Persisted as library/courses/<courseId>/course.json (the Course type from shared/types.ts plus a version). */
export interface CourseRecord {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  docIds: string[];
}
