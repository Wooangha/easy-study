// Server-internal contracts shared by sessions.ts, context.ts and chat.ts.
import type { ChatMessage, ContextInfo, DocMeta, ProviderId } from '../shared/types.ts';
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
  /** Do not re-send a slide's full image if it is among the last N slides sent. Default 4. */
  recentWindow: number;
  /** Feed overview contact sheets (2x2 slides per image) when priming. Default true. */
  primeWithImages: boolean;
  /** Max characters of extracted slide text included when priming. Default 60000. */
  maxPrimeTextChars: number;
  /** Max characters per slide in the priming text dump. Default 2500. */
  maxSlideTextChars: number;
  /** Number of most recent Q&A pairs recapped (as text) after a rollover. Default 6. */
  recapTurns: number;
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
  /**
   * Provider state to persist *if the turn succeeds*. The orchestrator fills in `resume`
   * from the provider result and, for stateless providers, appends this turn + the answer
   * to `history` (see appendHistory in context.ts).
   */
  nextState: ProviderState;
}
