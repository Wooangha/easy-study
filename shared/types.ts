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

/** GET /api/auth/status (DESIGN §16; answered without a session). */
export interface AuthStatusResponse {
  /** Remote mode: the API needs a login (access code). */
  authRequired: boolean;
  /** This request carries a valid session (or the access code as a bearer token); always true when no login is required. */
  authenticated: boolean;
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
  /** Course ("과목" folder) this lecture belongs to, derived from the course files. null = uncategorized. */
  courseId: string | null;
  /** Digest status of this document (for badges in pickers). */
  digestStatus: DigestStatus;
}

// ---------------------------------------------------------------------------
// Courses: an ordered folder of lecture PDFs (e.g. "Compiler" → Lec 1, Lec 2, …). When studying
// lecture k, the LLM also receives the summaries of lectures 1..k-1 and may open their files.
// ---------------------------------------------------------------------------

export interface Course {
  /** Same format as DocMeta.id (COURSE_ID_RE). */
  id: string;
  title: string;
  createdAt: string;
  /** Lecture order. A document belongs to at most one course. */
  docIds: string[];
}

export interface CreateCourseRequest {
  title: string;
}

export interface UpdateCourseRequest {
  title?: string;
  /**
   * New full ordered list of lectures. Every id must be an existing document. Documents newly
   * listed here are removed from any other course; documents omitted become uncategorized.
   */
  docIds?: string[];
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
  /**
   * Set when this turn had to start a new provider conversation because the previous one was lost
   * ('resume_invalid') or became too large ('context_overflow'); the turn was retried automatically.
   */
  recoveredFrom?: 'resume_invalid' | 'context_overflow';
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
  /**
   * Also feed the N slides before and after the focused slide (0–3). Omitted = server default
   * (ContextSettings.neighborWindow, default 1).
   */
  neighbors?: number;
}

export interface PrimeRequest {
  /** Slide the user is currently looking at (used as the initial focus). */
  slide: number;
  /** Same meaning as SendMessageRequest.neighbors. */
  neighbors?: number;
}

// ---------------------------------------------------------------------------
// Digest ("정리본"): a per-slide text transcription + explanation written once by an LLM
// that reads every slide image. Reused for priming later sessions (cheap, text only) and
// shown to the student next to the focused slide.
// ---------------------------------------------------------------------------

export type DigestStatus = 'none' | 'running' | 'ready' | 'error' | 'aborted';

export interface DigestSlide {
  slide: number;
  /** Slide title as read from the image ('' if none). */
  title: string;
  /** Markdown: faithful transcription (LaTeX math, Markdown tables, code fences), figure descriptions, then a "핵심:" takeaway. */
  markdown: string;
  /** True when the model output for this slide could not be parsed (markdown holds a placeholder). */
  failed?: boolean;
}

export interface DigestInfo {
  docId: string;
  status: DigestStatus;
  provider?: ProviderId;
  model?: string;
  /** Slides digested so far (successfully or failed). */
  done: number;
  total: number;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  /** Ascending by slide; partial while running. */
  slides: DigestSlide[];
  /** LLM-written summary of the whole lecture (made after all slides are digested). Used as course context. */
  summary: string | null;
  /** Absolute path of DIGEST.md. */
  markdownPath: string;
}

export interface StartDigestRequest {
  provider: ProviderId;
  /** '' or omitted = provider default. */
  model?: string;
  /** Re-digest every slide even if a digest exists (otherwise only missing/failed slides are done). */
  force?: boolean;
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
export const COURSE_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
