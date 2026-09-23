// Shared API contract between the server (server/) and the web client (web/).
// Keep this file free of runtime code other than constants — it is imported by both sides.

export type ProviderId = 'claude-code' | 'codex' | 'anthropic-api' | 'openai-api';

export interface ModelOption {
  /** Value passed to the provider ('' = provider/CLI default). */
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** 'cli' = uses a locally logged-in CLI (subscription), 'api' = uses an API key. */
  kind: 'cli' | 'api';
  available: boolean;
  /** Human readable reason when unavailable (e.g. "codex CLI not found in PATH"). */
  reason?: string;
  version?: string;
  models: ModelOption[];
  defaultModel: string;
}

export interface HealthResponse {
  ok: true;
  providers: ProviderInfo[];
  /** Absolute path of the library directory on disk (so the user can find notes). */
  libraryDir: string;
}

// ---------------------------------------------------------------------------
// Documents (a PDF + its rendered slides)
// ---------------------------------------------------------------------------

export type DocStatus = 'processing' | 'ready' | 'error';

export interface DocMeta {
  /** URL-safe id, matches /^[a-z0-9][a-z0-9-]{0,80}$/ */
  id: string;
  title: string;
  /** Original uploaded filename. */
  fileName: string;
  pageCount: number;
  /** Width / height of page 1 (used by the viewer to reserve space before images load). */
  aspectRatio: number;
  status: DocStatus;
  /** Number of pages rendered so far while status === 'processing'. */
  progress: number;
  error?: string;
  createdAt: string; // ISO
}

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'streaming' | 'error' | 'aborted';

/** What was fed to the LLM for a turn — shown in the UI so the user knows what the model saw. */
export interface ContextInfo {
  /** True when this turn (re)started the provider conversation and fed the whole deck. */
  primed: boolean;
  /** True when priming happened because the previous provider conversation hit its image budget. */
  rollover: boolean;
  /** Slide numbers whose full-resolution image was attached this turn. */
  attachedSlides: number[];
  /** Slide numbers whose image was NOT re-sent because it was sent recently (already in context). */
  reusedSlides: number[];
  /** Number of overview contact-sheet images attached this turn (only when primed). */
  overviewImages: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** Markdown text. For the user this is the question. */
  text: string;
  /** 1-based slide number the question was about (the focused slide when sent). */
  slide: number;
  /** 'prime' messages are the automatic "feed the whole deck" turn, not a user question. */
  kind: 'question' | 'prime';
  createdAt: string; // ISO
  status: MessageStatus;
  error?: string;
  /** Present on user messages. */
  context?: ContextInfo;
  /** Present on assistant messages. */
  provider?: ProviderId;
  model?: string;
  durationMs?: number;
}

export interface SessionSummary {
  id: string;
  docId: string;
  title: string;
  provider: ProviderId;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Whether the provider conversation has been fed the deck. */
  primed: boolean;
}

export interface Session extends SessionSummary {
  messages: ChatMessage[];
}

export interface CreateSessionRequest {
  provider: ProviderId;
  /** '' or omitted = provider default. */
  model?: string;
  title?: string;
}

export interface SendMessageRequest {
  text: string;
  /** 1-based focused slide number. */
  slide: number;
}

export interface PrimeRequest {
  /** Slide the user is currently looking at (used as the initial focus). */
  slide: number;
}

// ---------------------------------------------------------------------------
// Streaming (Server-Sent Events) for POST .../messages and POST .../prime
// Each SSE frame is `event: <type>\ndata: <JSON>\n\n`.
// ---------------------------------------------------------------------------

export type StreamEvent =
  /** First event. The persisted user message + a placeholder assistant message (status 'streaming'). */
  | { type: 'start'; userMessage: ChatMessage; assistantMessage: ChatMessage }
  /** Appended assistant text. */
  | { type: 'delta'; text: string }
  /** Transient progress line (e.g. "슬라이드 12 이미지를 읽는 중"). */
  | { type: 'status'; text: string }
  /** Final assistant message (status 'complete' | 'error' | 'aborted'). Always the last event. */
  | { type: 'done'; assistantMessage: ChatMessage; session: SessionSummary }
  /** Fatal error before a turn could start (e.g. validation). Always the last event. */
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Notes (review later): all Q&A of a document grouped by slide.
// ---------------------------------------------------------------------------

export interface NoteEntry {
  sessionId: string;
  sessionTitle: string;
  provider: ProviderId;
  question: ChatMessage;
  answer: ChatMessage | null;
}

export interface SlideNotes {
  slide: number;
  entries: NoteEntry[];
}

export interface NotesResponse {
  docId: string;
  /** Only slides that have at least one entry, ascending. */
  slides: SlideNotes[];
  /** Absolute path of the generated STUDY_NOTES.md file. */
  markdownPath: string;
}

export const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
