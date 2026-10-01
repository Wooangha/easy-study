// Server-internal contracts shared by sessions.ts, context.ts and chat.ts.
import type {
  AttachmentAnnotation,
  ChatMessage,
  ContextInfo,
  CourseGroup,
  DigestSlide,
  DigestStatus,
  DocMeta,
  LayoutItem,
  LlmSwitch,
  ProviderId,
  SessionUsage,
  TokenUsage,
  UsageLimits,
} from '../shared/types.ts';
import type { Lang } from '../shared/i18n.ts';
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
  /**
   * The session's LLM was changed (PATCH …/sessions/:sid) and the conversation it had was dropped: the next turn
   * starts a new provider conversation on the new LLM as a forced rollover, whose recap says the earlier answers
   * came from another model (prompts.RestartReason 'provider_switch'). Gone once a conversation starts.
   */
  switched?: true;
  /**
   * The lecture's deck was replaced by a new version (or the replacement undone, DESIGN §28) and the conversation was
   * dropped: the next turn starts a new provider conversation with the new deck as a forced rollover, whose recap
   * gives the earlier questions' slides in the new numbering (prompts.RestartReason 'deck_update'). Gone once a
   * conversation starts.
   */
  deckUpdated?: true;
}

/** Persisted as library/<docId>/sessions/<sessionId>.json */
export interface SessionRecord {
  version: 1;
  id: string;
  docId: string;
  title: string;
  provider: ProviderId;
  model: string;
  /** Reasoning effort; absent = the CLI's default (always absent in sessions made before efforts existed). */
  effort?: string;
  createdAt: string;
  updatedAt: string;
  providerState: ProviderState;
  messages: ChatMessage[];
  /** Running token totals (DESIGN §23); absent in sessions without reported usage (and those made before it). */
  usage?: SessionUsage;
  /** The subscription's usage limits as last reported in this session (dropped when the provider changes). */
  limits?: UsageLimits;
  /** Changes of the session's LLM (SessionSummary.switches); absent when it never changed. */
  switches?: LlmSwitch[];
  /**
   * The language of the latest turn (DESIGN §27): an answer the server stopped mid-turn is marked in it by the startup
   * sweep. Absent (sessions without a turn since languages existed) = Korean.
   */
  lang?: Lang;
}

export interface ContextSettings {
  /**
   * Do not re-send a slide's full image if it is among the last N slides sent in the current
   * provider conversation. Default 16 (env EASY_STUDY_RECENT_WINDOW).
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
  /** The language the digest was made in (DigestRecord.lang: its "핵심:" or "Key point:" lines). Absent = Korean. */
  digestLang?: Lang;
  /** Course context, or null when the document is not in a course. */
  course: CourseContext | null;
}

/** One memo of the student as the tutor context takes it (BuildTurnInput.studentMemos). */
export interface StudentMemo {
  /** 1-based slide the memo is stuck on. */
  slide: number;
  /** Whitespace squeezed, capped (context.ts MAX_MEMO_CHARS). */
  text: string;
  /** The memo's tags, when it has any (shown as "[tags: …]" before the text). */
  tags?: string[];
}

/**
 * A session of a document changed in a way the notes (question markers, DESIGN §25) care about: a turn finished
 * (`updatedAt` = the saved session's) or the session was deleted (`updatedAt: null`). sessions.ts emits it to
 * onSessionsChanged listeners; annotations.ts forwards it to the document's SSE hub as AnnotationEvent 'qa'.
 */
export interface SessionChange {
  docId: string;
  sessionId: string;
  updatedAt: string | null;
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
  /**
   * Start a new provider conversation even though the current one is primed (the provider lost it or it
   * overflowed): behaves like a rollover (re-prime + recap), and ContextInfo.recoveredFrom is set.
   */
  forceNewConversation?: 'resume_invalid' | 'context_overflow';
  /**
   * Attachments of this question, in the order the student added them (resolved by chat.ts from the ids):
   * the stored image path (inline-ready JPEG/PNG), a label, for regions the text inside the selection, and for a
   * region made from a 필기 (Attachment.annotation, DESIGN §25) the item's type and its text.
   */
  attachments?: Array<{
    kind: 'region' | 'image';
    path: string;
    label: string;
    text?: string;
    annotation?: Pick<AttachmentAnnotation, 'type' | 'text'>;
  }>;
  /**
   * Lecture speech from this document's recordings (DESIGN §22), resolved by chat.ts:
   * per slide of the focus window what was said on it (already capped), and — while a live recording of this
   * document is running — the last few minutes of speech.
   */
  lectureSpeech?: {
    bySlide: Array<{ slide: number; text: string }>;
    recent?: { text: string; minutes: number };
  };
  /**
   * The student's own memos on the slides of the focus window (DESIGN §25 "학생의 메모"), resolved by chat.ts
   * (annotations.memosForTutor) for question turns unless the request said `memos: false`: only memos with
   * MemoItem.tutor !== false and non-blank text, each ≤ MAX_MEMO_CHARS, at most MAX_TUTOR_MEMOS (the focused slide's
   * first, then the nearest neighbours). Absent for prime turns. context.ts orders them the same way and caps the total.
   */
  studentMemos?: StudentMemo[];
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
  /** Reasoning effort (absent = the CLI's default). */
  effort?: string;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  /** Ascending by slide. */
  slides: DigestSlide[];
  summary: string | null;
  /** True when slide entries changed after the summary was written (the summary must be regenerated). */
  summaryStale?: boolean;
  /** Tokens of the latest run (DigestInfo.usage). */
  usage?: TokenUsage;
  /**
   * The language the latest run was made in (DESIGN §27): the model's figure descriptions, takeaways and summary, the
   * stored notes and the headings of DIGEST.md. Absent (records written before languages) = Korean.
   */
  lang?: Lang;
}

/** Persisted as library/courses/<courseId>/course.json (the Course type from shared/types.ts plus a version). */
export interface CourseRecord {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  docIds: string[];
}

/**
 * Persisted as library/layout.json (DESIGN §18): the LibraryLayout (groups of courses and the top-level order)
 * plus a version. Normalised on read (server/layout.ts); lecture membership stays in the course files.
 */
export interface LayoutRecord {
  version: 1;
  groups: CourseGroup[];
  order: LayoutItem[];
}

/**
 * One swap of a lecture's deck (DESIGN §28), as every subsystem remaps its slide numbers: a new version applied
 * (fromRev r → toRev r + 1) or the last one undone (the inverse map, with `restoreRev` = the deck coming back).
 * Every remap is idempotent: it records `toRev` with its data and does nothing when it finds it there.
 */
export interface DeckMap {
  /** DocMeta.deckRev of the deck the data is numbered in before the remap. */
  fromRev: number;
  /** DocMeta.deckRev after it (fromRev + 1). */
  toRev: number;
  oldPageCount: number;
  newPageCount: number;
  /** oldToNew[old - 1] = the slide's number in the new deck (1-based), or null when the new deck dropped it. */
  oldToNew: (number | null)[];
  /** New-deck slides (new numbering) whose content differs from the old slide they continue. */
  changed: ReadonlySet<number>;
  /** New-deck slides (new numbering) without an old counterpart. */
  added: ReadonlySet<number>;
  /**
   * Undo only: the deckRev of the deck coming back. What the apply from it archived — the removed slides' 필기,
   * recording labels it cleared, the digest as it was, messages' RemovedFrom with this rev — is restored and the
   * archive removed.
   */
  restoreRev?: number;
}
