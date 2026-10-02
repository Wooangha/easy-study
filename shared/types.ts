// Shared API contract between the server (server/) and the web client (web/).
// Keep this file free of runtime code other than constants — it is imported by both sides.

export type ProviderId = 'claude-code' | 'codex' | 'anthropic-api' | 'openai-api';

export interface ModelOption {
  /** Value passed to the provider ('' = provider/CLI default). */
  id: string;
  label: string;
  /** Longer explanation (tooltip), e.g. the description of the Codex model catalog. */
  description?: string;
  /**
   * Reasoning efforts this model supports (ids of ProviderInfo.efforts). Omitted = all of them, [] = none (the CLI
   * default only).
   */
  efforts?: string[];
}

/** A reasoning-effort level of a CLI provider (claude --effort, Codex model_reasoning_effort). */
export interface EffortOption {
  /** Value passed to the CLI, e.g. 'high'. */
  id: string;
  /** Its name in the request's language, e.g. '높음' / 'high' (the server's texts, DESIGN §27). */
  label: string;
  /** Longer explanation (tooltip). */
  description?: string;
}

/**
 * Korean names of the reasoning-effort levels; an unknown level is shown by its id. The server sends each level's name
 * in the request's language (EffortOption.label); these are the Korean fallback for a level a provider does not list.
 */
export const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: '없음',
  minimal: '최소',
  low: '낮음',
  medium: '보통',
  high: '높음',
  xhigh: '매우 높음',
  max: '최대',
  ultra: '울트라',
};

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
  /**
   * Reasoning-effort levels one can pick for this provider, weakest first (CLI providers). Omitted or empty = no
   * choice: the provider's own default is always used. '' (not listed) = the CLI's default.
   */
  efforts?: EffortOption[];
}

export interface HealthResponse {
  ok: true;
  providers: ProviderInfo[];
  /** Absolute path of the library directory on disk (so the user can find notes). */
  libraryDir: string;
  /** The server's version (package.json), e.g. "0.5.0". Absent from servers before it was added. */
  version?: string;
}

/**
 * GET /api/desktop/busy (desktop mode only, DESIGN §24): what a restart of the app's server would interrupt, asked by
 * the shell before an update is installed. Counts and the live recording only — no paths, no content.
 */
export interface DesktopBusyResponse {
  /** The server's live recording ('recording' or 'paused'; it stays resumable across a restart), or null. */
  recording: {
    id: string;
    docId: string;
    status: RecordingStatus;
    /** The recording's and its lecture's titles, for the shell's warning ("‘{docTitle}’의 ‘{title}’ 녹음…"). */
    title: string;
    docTitle: string | null;
  } | null;
  /** Transcription jobs waiting or running. */
  transcriptions: number;
  /** 정리본 LLM calls running. */
  digests: number;
  /** Chat turns (answers) running. */
  chatTurns: number;
  /** Speech-recognition models being downloaded. */
  modelDownloads: number;
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
  /**
   * How many times the deck was swapped (DESIGN §28: a new version applied, or undone); absent = 0. Part of every slide
   * image URL (`?v=`), which the server caches for good, and of the viewer's key.
   */
  deckRev?: number;
  /** The last swap of the deck (DESIGN §28), for the banner and the 수정 / 새로 badges; absent = never swapped. */
  lastChange?: DeckChange;
}

// ---------------------------------------------------------------------------
// New version of a lecture PDF (DESIGN §28): the professor re-posted the deck. The new PDF is converted next to the
// lecture, its slides are matched to the old ones (server/slideMatch.ts), and on apply everything the student made
// follows its slide.
// ---------------------------------------------------------------------------

/**
 * Sent by the web client with every slide-numbered write (annotations PUT / PATCH, POST …/regions, questions and prime
 * turns): the DocMeta.deckRev its slide numbers belong to. When it differs from the lecture's, the server answers 409
 * `{ error, deckRev }` (no `current`) so a stale client reloads instead of writing onto whatever slide now has that number.
 */
export const DECK_REV_HEADER = 'X-Easy-Study-Deck-Rev';

/** The body of POST /api/docs/:docId/versions/undo: the deckRev the client saw (409 when the deck changed since). */
export interface UndoVersionRequest {
  fromRev?: number;
}

/** A slide of the new deck: the same as its old slide, changed, or new (no old counterpart). */
export type SlideChangeKind = 'same' | 'changed' | 'new';

export interface VersionPlanSlide {
  /** 1-based slide of the new deck. */
  slide: number;
  /** The 1-based old slide it continues; null for a new slide. */
  from: number | null;
  change: SlideChangeKind;
  /** The old slide was elsewhere in the order. */
  moved?: true;
}

/** How the new deck's slides continue the old ones (NextVersionInfo.plan). */
export interface VersionPlan {
  /** DocMeta.deckRev the plan was made against; apply refuses (409) when the deck changed since. */
  fromRev: number;
  oldPageCount: number;
  newPageCount: number;
  /** One entry per new slide, in order. */
  slides: VersionPlanSlide[];
  /** Old slides without a counterpart, ascending. */
  removed: number[];
  /** Fewer than half of the old slides found a counterpart: probably another lecture's PDF. */
  unrelated: boolean;
  /**
   * What the student has on the removed slides: 필기 items and memos (kept in the 빠진 슬라이드 archive) and questions
   * (they stay in their sessions, shown on the nearest kept slide).
   */
  onRemoved: { items: number; memos: number; questions: number };
}

/** GET /api/docs/:docId/versions/next: the uploaded new version, while it is converted and until applied or dropped. */
export interface NextVersionInfo {
  status: 'processing' | 'ready' | 'error';
  /** The uploaded file's name. */
  fileName: string;
  /** Slides rendered so far while 'processing'. */
  progress: number;
  /** 0 until the PDF is open. */
  pageCount: number;
  createdAt: string;
  /** status 'error': why the PDF could not be converted. */
  error?: string;
  /** status 'ready'. */
  plan?: VersionPlan;
}

/** DocMeta.lastChange: the last swap of the deck. */
export interface DeckChange {
  /** DocMeta.deckRev after the swap. */
  rev: number;
  at: string;
  /** 'apply' = a new version replaced the deck; 'undo' = the deck before it came back. */
  kind: 'apply' | 'undo';
  /** File name of the deck that was replaced. */
  fromFileName: string;
  /** Slides (current numbering) whose content differs from the slide they continue. */
  changed: number[];
  /** Slides (current numbering) without a counterpart in the replaced deck. */
  added: number[];
  /** Slides of the replaced deck without a counterpart (their numbers there). */
  removed: number[];
  /** POST …/versions/undo can bring the replaced deck back (only the last apply, until the next swap). */
  undoable: boolean;
}

/** Where a message or attachment was, when a new version dropped its slide: `slide` (in deck `rev`). */
export interface RemovedFrom {
  /** DocMeta.deckRev of the deck the slide was in. */
  rev: number;
  /** Its 1-based number in that deck. */
  slide: number;
}

/** GET /api/docs/:docId/annotations/removed: the 필기 of a slide a new version dropped (the 빠진 슬라이드 archive). */
export interface RemovedSlide {
  /** DocMeta.deckRev of the deck the slide was in. */
  rev: number;
  /** Its 1-based number in that deck. */
  slide: number;
  removedAt: string;
  /** A thumbnail exists: GET /api/docs/:docId/annotations/removed/:rev/:slide.webp */
  thumb: boolean;
  items: AnnotationItem[];
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
  /** Put the new course at the end of this group (otherwise at the end of the top level). */
  groupId?: string;
}

/**
 * A group of courses (e.g. a semester "2026-2학기" containing Compiler, OS, …). Purely organisational: it does not change
 * what the LLM sees. Persisted in library/layout.json together with the top-level order.
 */
export interface CourseGroup {
  /** Same format as COURSE_ID_RE. */
  id: string;
  title: string;
  createdAt: string;
  /** Courses in this group, in display order. A course is either in exactly one group or at the top level. */
  courseIds: string[];
}

/** One entry of the top-level library order. */
export type LayoutItem = { type: 'group'; id: string } | { type: 'course'; id: string };

/** GET /api/layout — normalised: every existing course appears exactly once (in a group or as a top-level item). */
export interface LibraryLayout {
  groups: CourseGroup[];
  /** Top-level order of groups and ungrouped courses. */
  order: LayoutItem[];
}

/** PUT /api/layout — the full arrangement; must mention every existing course and group exactly once. */
export interface PutLayoutRequest {
  groups: Array<{ id: string; courseIds: string[] }>;
  order: LayoutItem[];
  /**
   * layoutRevision() (shared/layoutRevision.ts) of the arrangement this one was made from. When given and the
   * current arrangement is a different one (changed in another tab or on another device), the answer is 409 and
   * nothing is written.
   */
  baseRevision?: string;
}

export interface CreateGroupRequest {
  title: string;
  /** Courses to move into the new group (removed from wherever they were). */
  courseIds?: string[];
}

export interface UpdateGroupRequest {
  title: string;
}

export interface UpdateCourseRequest {
  title?: string;
  /**
   * New full ordered list of lectures. Every id must be an existing document. Documents newly
   * listed here are removed from any other course; documents omitted become uncategorized.
   */
  docIds?: string[];
  /**
   * The course's lecture list that `docIds` was made from (as GET /api/courses showed it). When given and the
   * course's list is a different one now (changed in another tab or on another device), the answer is 409 and
   * nothing is written.
   */
  baseDocIds?: string[];
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
  /**
   * Set when this turn started a new provider conversation because the session's LLM was changed
   * (PATCH …/sessions/:sid): a forced rollover on the new LLM, the earlier Q&A recapped.
   */
  switched?: true;
  /**
   * Set when this turn started a new provider conversation because the lecture's deck was replaced by a new version
   * (DESIGN §28): a forced rollover with the new deck, the earlier Q&A recapped with the slides' new numbers.
   */
  deckUpdated?: true;
  /** Number of attachments (selected slide regions / images) sent with this question. */
  attachments?: number;
  /** Number of the student's own memos (§25 "학생의 메모") given to the tutor with this question; absent when none. */
  memos?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** Markdown text. For the user this is the question. */
  text: string;
  /** 1-based slide number the question was about (the focused slide when sent). */
  slide: number;
  /**
   * A new version of the deck dropped the slide this message was on (DESIGN §28): `slide` is then the nearest kept slide,
   * and this is where the message really was.
   */
  removedFrom?: RemovedFrom;
  /** 'prime' messages are the automatic "feed the whole deck" turn, not a user question. */
  kind: 'question' | 'prime';
  createdAt: string; // ISO
  status: MessageStatus;
  error?: string;
  /** Present on user messages. */
  context?: ContextInfo;
  /** Present on user messages that carried attachments (selected slide regions or images). */
  attachments?: Attachment[];
  /** Present on assistant messages. */
  provider?: ProviderId;
  model?: string;
  /** Reasoning effort of the assistant message (absent = the CLI's default). */
  effort?: string;
  durationMs?: number;
  /**
   * Present on assistant messages whose provider reported token usage (DESIGN §23): every model call of the turn,
   * an automatic retry in a new conversation included. Absent in messages saved before usage was recorded.
   */
  usage?: TokenUsage;
}

/** The LLM a session runs on: the provider, its model ('' = the provider's default) and the reasoning effort. */
export interface LlmChoice {
  provider: ProviderId;
  model: string;
  /** Absent = the CLI's default. */
  effort?: string;
}

/**
 * A change of a session's LLM (PATCH …/sessions/:sid): the answers up to `afterMessageId` (null = none yet) were
 * given by `from`; from `at` on the session runs on `to`, in a new provider conversation (DESIGN §5).
 */
export interface LlmSwitch {
  at: string; // ISO
  afterMessageId: string | null;
  from: LlmChoice;
  to: LlmChoice;
}

export interface SessionSummary {
  id: string;
  docId: string;
  title: string;
  /** The LLM the session runs on now (changed by PATCH …/sessions/:sid; see `switches`). */
  provider: ProviderId;
  model: string;
  /** Reasoning effort (EffortOption.id); absent = the CLI's default (and sessions made before efforts existed). */
  effort?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Whether the provider conversation has been fed the deck. */
  primed: boolean;
  /** Tokens of the session's turns so far (DESIGN §23); absent until a turn reported usage. */
  usage?: SessionUsage;
  /**
   * The subscription's usage limits as the provider last reported them in this session (subscription CLIs only;
   * dropped when the session's provider changes).
   */
  limits?: UsageLimits;
  /** Changes of the session's LLM, oldest first; absent when it never changed (and in sessions saved before). */
  switches?: LlmSwitch[];
}

export interface Session extends SessionSummary {
  messages: ChatMessage[];
}

export interface CreateSessionRequest {
  provider: ProviderId;
  /** '' or omitted = provider default. */
  model?: string;
  /** One of ProviderInfo.efforts that the model supports; '' or omitted = the CLI's default. */
  effort?: string;
  title?: string;
}

/**
 * PATCH /api/docs/:docId/sessions/:sid — change the session's LLM, validated like CreateSessionRequest. The next
 * turn starts a new provider conversation on it (the deck fed again, the latest Q&A recapped). 409 while the
 * session is answering; the unchanged session (200) when nothing differs.
 */
export interface UpdateSessionRequest {
  provider: ProviderId;
  /** '' or omitted = provider default. */
  model?: string;
  /** Same as CreateSessionRequest.effort. */
  effort?: string;
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
  /** Ids of attachments created beforehand (POST …/attachments or …/regions) of this document, max MAX_ATTACHMENTS. */
  attachments?: string[];
  /**
   * Include the student's memos on the focus window's slides as "학생의 메모" (DESIGN §25; the device's 설정 › 공부
   * switch). Omitted = true. Memos with MemoItem.tutor === false are never included.
   */
  memos?: boolean;
}

export interface PrimeRequest {
  /** Slide the user is currently looking at (used as the initial focus). */
  slide: number;
  /** Same meaning as SendMessageRequest.neighbors. */
  neighbors?: number;
}

// ---------------------------------------------------------------------------
// Token usage and subscription limits (DESIGN §23): what turns and digest runs cost, as the providers report it,
// and — for the subscription CLIs — how much of the plan's usage limits is used.
// ---------------------------------------------------------------------------

/**
 * Tokens of one or more model calls. `input` and `output` are totals; the other counts are parts of them, omitted
 * when zero or not reported.
 */
export interface TokenUsage {
  /** Every input token, the cached ones included. */
  input: number;
  /** Part of `input` read from the prompt cache. */
  cachedInput?: number;
  /** Part of `input` written to the prompt cache (Claude). */
  cacheWrite?: number;
  /** Every output token, reasoning included. */
  output: number;
  /** Part of `output` spent on reasoning (thinking). */
  reasoning?: number;
}

/** Running totals of a session (SessionSummary.usage). */
export interface SessionUsage {
  /** Every turn so far: priming, questions, failed and aborted ones, automatic retries. */
  total: TokenUsage;
  /** The priming turns alone (feeding the deck). */
  priming?: TokenUsage;
}

/** One usage-limit window of a subscription (e.g. Claude's 5-hour and weekly limits, Codex's weekly limit). */
export interface LimitWindow {
  /** Length of the window in minutes: 300 = 5 hours, 10080 = a week. */
  minutes: number;
  /** How much of the window's allowance is used, in percent (can exceed 100). */
  usedPercent: number;
  /** When the window starts over (ISO), when reported. */
  resetsAt?: string;
  /** Set for a limit of one model family (e.g. 'Opus'), not the plan's general one. */
  label?: string;
  /** The window the report's 'warning' / 'reached' status is about, when the provider names it (Claude). */
  binding?: true;
}

/** The subscription's usage limits as the provider reported them. */
export interface UsageLimits {
  /** When they were reported (ISO). */
  at: string;
  /** 'warning' = close to a limit; 'reached' = a limit is reached (requests are refused until it resets). */
  status: 'ok' | 'warning' | 'reached';
  /** Shortest window first. */
  windows: LimitWindow[];
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
  /** Reasoning effort of the digest run (absent = the CLI's default). */
  effort?: string;
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
  /** Tokens of the latest run (every call, failed ones included), when the provider reported them (DESIGN §23). */
  usage?: TokenUsage;
}

export interface StartDigestRequest {
  provider: ProviderId;
  /** '' or omitted = provider default. */
  model?: string;
  /** Same as CreateSessionRequest.effort. */
  effort?: string;
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
  /**
   * Tokens the turn has used so far (a running total over all its model calls) and the subscription's usage limits,
   * as far as the provider reported them (DESIGN §23). Sent again whenever either changes.
   */
  | { type: 'usage'; usage?: TokenUsage; limits?: UsageLimits }
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

/** A model name (CreateSessionRequest.model, …). Model names reach CLI argument lists: no leading dash, no whitespace. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
/** A reasoning-effort level (EffortOption.id). */
export const EFFORT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const COURSE_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

// ---------------------------------------------------------------------------
// Attachments (DESIGN §21): a region the student selected on a slide, or an image they pasted / dropped /
// picked. Created first (so the composer can show a thumbnail), then referenced by id when the question is sent.
// ---------------------------------------------------------------------------

/** Rectangle on a slide, normalised to the slide image (0..1, origin top-left). */
export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Attachment {
  /** ATTACHMENT_ID_RE */
  id: string;
  kind: 'region' | 'image';
  /** kind 'region': the slide and the selected rectangle. */
  slide?: number;
  rect?: RegionRect;
  /** kind 'image': the original file name, if any. */
  name?: string;
  /** Pixel size of the stored image. */
  width: number;
  height: number;
  /** kind 'region': text of the PDF text layer inside the rectangle ('' when none). */
  text?: string;
  /**
   * kind 'region' made from an annotation item (📎 첨부 of a 필기, DESIGN §25): a snapshot taken when the attachment was
   * made — the item's id and type and, for memos / text boxes / text highlights, its text (≤ MAX_ANNOTATION_TEXT_CHARS).
   * Stored on the user message with the attachment; question markers link the item to the Q&A through it.
   */
  annotation?: AttachmentAnnotation;
  /**
   * kind 'region': a new version of the deck dropped `slide` (DESIGN §28). `slide` is then the nearest kept slide (so the
   * attachment stays valid) and question markers skip the attachment.
   */
  removedFrom?: RemovedFrom;
  /**
   * kind 'region': the crop has the student's 펜 strokes drawn into it (DESIGN §29), so the tutor is told the dark
   * strokes are the student's writing, not the slide's.
   */
  inked?: true;
  createdAt: string;
}

/** Attachment.annotation: which 필기 a region attachment was made from. */
export interface AttachmentAnnotation {
  /** ANNOTATION_ID_RE — the item may be deleted later; markers then fall back to the attachment's rect. */
  id: string;
  type: AnnotationItem['type'];
  /** The memo's / text box's text or the highlighted words, as they were when attached. */
  text?: string;
}

/** POST /api/docs/:docId/regions */
export interface CreateRegionRequest {
  slide: number;
  rect: RegionRect;
  /**
   * Make the region from this annotation item of `slide` (DESIGN §25): the server reads the item and stores
   * Attachment.annotation; an unknown id → 400 '그 필기를 찾을 수 없습니다'.
   */
  annotationId?: string;
  /**
   * Draw the slide's 펜 strokes that meet the region into the crop (DESIGN §29). Omitted = true; the client sends false
   * while its 필기 layer is hidden (the crop is then the clean slide). A region made from a stroke always has them.
   */
  ink?: boolean;
}

export const MAX_ATTACHMENTS = 6;
/** Maximum size of an uploaded image (bytes). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

// ---------------------------------------------------------------------------
// Lecture recordings (DESIGN §22): recorded inside the app (live, transcribed a few seconds behind) or uploaded,
// transcribed locally with whisper.cpp, aligned to slides, used as tutor context and replayed in sync with slides.
// ---------------------------------------------------------------------------

export type RecordingSource = 'live' | 'upload';
export type RecordingStatus = 'recording' | 'paused' | 'converting' | 'ready' | 'error';
export type TranscriptStatus = 'none' | 'queued' | 'running' | 'ready' | 'error';
export type RecordingLanguage = 'ko' | 'en' | 'auto';
/** How the current slide assignment was produced. */
export type AlignmentKind = 'none' | 'timeline' | 'lexical' | 'llm';

export interface RecordingInfo {
  /** RECORDING_ID_RE */
  id: string;
  docId: string;
  title: string;
  source: RecordingSource;
  status: RecordingStatus;
  language: RecordingLanguage;
  /** language 'auto': the language whisper detected once it did (e.g. 'ko', 'en'). */
  detectedLanguage?: string;
  /** Whisper model id used (or to be used) for this recording. */
  model: string;
  /** Live recordings: transcribe while recording (false = only after stop). */
  liveTranscribe: boolean;
  createdAt: string;
  /** Seconds of audio stored so far (live) or total (upload). */
  durationSec: number;
  transcriptStatus: TranscriptStatus;
  /** Seconds of audio transcribed so far. */
  transcribedSec: number;
  alignment: AlignmentKind;
  /** Segments with a manually set slide (markers) exist. */
  hasManualMarkers: boolean;
  error?: string;
  /** Playback source (same-origin URL) once available. */
  playback: { url: string; mime: string } | null;
}

export interface TranscriptSegment {
  /** Stable, increasing within a recording. */
  id: number;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  /** Slide this segment was said on (null = not about a slide, e.g. an announcement). */
  slide: number | null;
}

export interface RecordingTranscript {
  recordingId: string;
  segments: TranscriptSegment[];
  /** The recording's manual markers (markers.json), so every device shows the stored list (DESIGN §28). */
  markers?: AlignmentMarker[];
}

/** The student viewed `slide` from recording time `t` (seconds, recording clock) on. */
export interface SlideViewEvent {
  t: number;
  slide: number;
}

/** Manual correction: from recording time `t` on, the lecture is on `slide` (null = off-slide). Hard constraint for alignment. */
export interface AlignmentMarker {
  t: number;
  slide: number | null;
}

export interface CreateLiveRecordingRequest {
  title?: string;
  language?: RecordingLanguage;
  /** Whisper model id; omitted = the recommended installed model. */
  model?: string;
  /** Default true. */
  liveTranscribe?: boolean;
}

export interface AsrModelInfo {
  id: string;
  label: string;
  sizeBytes: number;
  installed: boolean;
  /** Present while a download runs. */
  downloading?: { receivedBytes: number; totalBytes: number };
  /** Why the last download failed (Korean; absent while downloading, once installed, or before any failure). */
  error?: string;
  /** Recommended default for this machine. */
  recommended: boolean;
}

/** GET /api/asr */
export interface AsrStatus {
  /** whisper-cli found and runnable. */
  engineAvailable: boolean;
  engineVersion?: string;
  /** Why the engine is unavailable (Korean, actionable). */
  reason?: string;
  /**
   * What transcription runs on: 'metal' on Apple Silicon builds; 'vulkan' when the engine found a GPU through
   * Vulkan (Windows x64 / Linux x64 builds, see `gpu`); otherwise 'cpu' (also after the GPU failed, see `gpuError`).
   */
  acceleration: 'metal' | 'vulkan' | 'cpu';
  /** The GPU (present when acceleration is 'vulkan'). integrated: built-in graphics sharing the system memory. */
  gpu?: { name: string; integrated: boolean };
  /**
   * A GPU was found but a run on it failed, so everything runs on the CPU until the server restarts: why (the first
   * error line; acceleration is 'cpu').
   */
  gpuError?: string;
  /** ffmpeg found (needed for uploads only). */
  ffmpegAvailable: boolean;
  models: AsrModelInfo[];
}

/** Events on GET …/recordings/:rid/events (SSE, `event: <type>`, JSON data; `id:` = segment id for 'segment'). */
export type RecordingEvent =
  | { type: 'status'; recording: RecordingInfo }
  | { type: 'segment'; segment: TranscriptSegment }
  /** Slides of existing segments changed (re-alignment). */
  | { type: 'realigned'; segments: Array<{ id: number; slide: number | null }> }
  | { type: 'ping' };

export const RECORDING_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
/** Live audio format: PCM signed 16-bit little-endian, mono, 16 kHz. */
export const LIVE_SAMPLE_RATE = 16000;
/**
 * A live recording's speech is "the last minutes of the lecture" for the tutor only while its device sends audio (or
 * a pause / resume) at least this often (ms): a recording whose device is gone stops being injected.
 */
export const LIVE_SPEECH_IDLE_MS = 10 * 60 * 1000;
/** Maximum size of an uploaded recording (bytes). */
export const MAX_RECORDING_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Slide annotations (DESIGN §25): 형광펜 / 텍스트 형광 / 사각형 / 동그라미 / 텍스트 상자 / 스티커 메모 drawn on slides
// with the mouse or trackpad, and 펜 (handwriting, DESIGN §29) with a stylus (Apple Pencil, S Pen) or the mouse, stored per slide under the lecture folder (annotations/NNN.json), shared live between
// devices over SSE; 질문 표시 (question markers) are derived from sessions, only hidden ones are stored.
//
// Coordinates: every geometry is normalised 0..1 to the rendered slide IMAGE (origin top-left, /Rotate applied) —
// exactly RegionRect of §21, not PDF points and not the slide box — so a text-fitted highlight, a region attachment
// and a question marker share one coordinate system at every zoom and on letterboxed pages. The client rounds to
// 4 decimals; the server clamps to 0..1 and rounds to 4.
// ---------------------------------------------------------------------------

export type AnnotationColor = 'yellow' | 'green' | 'pink' | 'blue' | 'black' | 'red';
/** The colors of 형광펜, 텍스트 형광, shapes, text boxes and memos (light highlighter tints). */
export const ANNOTATION_COLORS: readonly AnnotationColor[] = ['yellow', 'green', 'pink', 'blue'];
/** The colors of 펜 ink (InkItem; dark inks: 'blue' and 'green' render darker than the highlighter tints of the same name). */
export const INK_COLORS: readonly AnnotationColor[] = ['black', 'blue', 'red', 'green'];
/** `an-` + 12 hex (6 random bytes, crypto.getRandomValues in the browser), chosen by the client so an optimistic item keeps its id. */
export const ANNOTATION_ID_RE = /^an-[0-9a-f]{12}$/;

/** When an item was made on the recording clock (seconds, 3 decimals; the clock of SlideViewEvent.t). */
export interface RecordedAt {
  /** RECORDING_ID_RE; the recording may be deleted later (the stamp stays, a click on it then toasts). */
  rid: string;
  /** Finite, ≥ 0, rounded to 3 decimals. */
  t: number;
}

export interface AnnotationBase {
  /** ANNOTATION_ID_RE; unique within the slide. */
  id: string;
  color: AnnotationColor;
  /** ISO; set by the client on `add` (the server stamps its own clock when the value is not a valid ISO string). */
  createdAt: string;
  /** ISO; always the server's clock, stamped on every accepted add / update (a client-sent value is replaced). */
  updatedAt: string;
  /**
   * Made while a live recording of this lecture ran. Stamped by the creating client (recorder.clock()); when absent
   * on an `add` and the server holds a live recording of the document, the server stamps `{ rid, t: durationSec }`
   * (the audio stored so far — the two-device case: the phone records, the laptop annotates). Only creation stamps
   * it: never patched.
   */
  recordedAt?: RecordedAt;
}
/**
 * 형광펜: one straight translucent band. Snapped to the text line under the drag's start when the slide's text layout
 * (SlideTextLayout) has one — the band takes the line's extent along its minor axis and the drag's along its major
 * axis (`dir`) — else a band of HIGHLIGHT_BAND_H centred on the start.
 */
export interface HighlightItem extends AnnotationBase {
  type: 'highlight';
  rect: RegionRect;
}
/**
 * 텍스트 형광: one rect per line, fitted to the words; anchored to the PDFium char index range [start, end) of the
 * page's text layer (SlideTextLayout words carry the same indices), so rects can be recomputed after an engine change.
 */
export interface TextHighlightItem extends AnnotationBase {
  type: 'textHighlight';
  /** ≤ MAX_TEXT_HIGHLIGHT_RECTS, each w,h > 0. */
  rects: RegionRect[];
  /** Integers, 0 ≤ start < end. */
  chars: [start: number, end: number];
  /**
   * The text layout's engine (SlideTextLayout.engine) `chars` were taken from. The layer draws the stored `rects`;
   * when the viewer loads the slide's layout (a highlight tool used on it) and its engine differs, the client
   * re-anchors by searching `text` in the layout and writes the new fit back (rects, chars, engine, text).
   */
  engine: string;
  /** The highlighted words (≤ MAX_ANNOTATION_TEXT_CHARS; for the tutor and the memo list). */
  text: string;
}
/** 사각형 */
export interface RectItem extends AnnotationBase {
  type: 'rect';
  rect: RegionRect;
}
/** 동그라미: the ellipse inscribed in `rect`. */
export interface EllipseItem extends AnnotationBase {
  type: 'ellipse';
  rect: RegionRect;
}
/** The font of a text box: the app's sans, a Korean-capable serif (명조), or the app's monospace. */
export type TextFont = 'sans' | 'serif' | 'mono';
export const TEXT_FONTS: readonly TextFont[] = ['sans', 'serif', 'mono'];
/**
 * "pt on the slide": a text size is stored as a fraction of the slide image's height (so it scales with the zoom
 * and looks the same on every device), shown to the user in points of a slide that is SLIDE_PT_HEIGHT pt tall (a
 * 16:9 deck's 7.5 in): size = pt / SLIDE_PT_HEIGHT. Clamped to MIN_TEXT_SIZE_PT … MAX_TEXT_SIZE_PT (as fractions) on
 * the server; 4 decimals.
 */
export const SLIDE_PT_HEIGHT = 540;
export const MIN_TEXT_SIZE_PT = 4;
export const MAX_TEXT_SIZE_PT = 72;
/** The size of a text box without `size` (files written before 0.6.2). */
export const DEFAULT_TEXT_SIZE_PT = 16;
/** The text size of a memo without `size` (renders UI-sized, 13 px, as before 0.6.2). */
export const DEFAULT_MEMO_TEXT_SIZE_PT = 12;
/** 텍스트 상자: typed text drawn on the slide (≤ MAX_ANNOTATION_TEXT_CHARS); rect.h is the last laid-out height. */
export interface TextItem extends AnnotationBase {
  type: 'text';
  rect: RegionRect;
  text: string;
  /** Font size as a fraction of the slide height (see SLIDE_PT_HEIGHT); absent = DEFAULT_TEXT_SIZE_PT. */
  size?: number;
  /** Absent = 'sans'. */
  font?: TextFont;
  /** Absent = false. */
  bold?: boolean;
}
/**
 * Where a memo links to (never a URL). Clicking navigates: a slide of this lecture, a slide of another lecture (its
 * title looked up client-side; a deleted one shows "지워진 강의"), or a moment of a recording (played in the 녹음 tab).
 */
export type MemoLink =
  | { kind: 'slide'; slide: number }
  | { kind: 'doc'; docId: string; slide?: number }
  | { kind: 'recording'; rid: string; t: number };
/** 스티커 메모 */
export interface MemoItem extends AnnotationBase {
  type: 'memo';
  /** Top-left anchor on the image (0..1). */
  at: { x: number; y: number };
  /** ≤ MAX_ANNOTATION_TEXT_CHARS. Rendered as plain text only (no Markdown). */
  text: string;
  /**
   * ≤ MAX_MEMO_TAGS, each ≤ MAX_TAG_CHARS: trimmed, inner whitespace squeezed to one space, no leading '#', unique
   * (case-sensitive).
   */
  tags: string[];
  collapsed: boolean;
  /** 👁 "튜터에게 보이기" (default true): included in the tutor's "학생의 메모" of the focus window. */
  tutor: boolean;
  /** ≤ MAX_MEMO_LINKS. A memo created during a live recording gets `{ kind: 'recording', rid, t }` (its 🎙 chip). */
  links: MemoLink[];
  /** Text size as a fraction of the slide height (the units of TextItem.size); absent = the UI-sized 13 px of 0.6.1. */
  size?: number;
}
/**
 * 펜 (DESIGN §29): one handwritten stroke. `rect` is its bounding box on the image, padded by half the stroke width (so it
 * is never empty: a dot is a stroke too); the points are stored relative to it, so moving or resizing the stroke is an
 * `update` of `rect` alone and the points never change after the stroke is drawn. Color ∈ INK_COLORS.
 */
export interface InkItem extends AnnotationBase {
  type: 'ink';
  rect: RegionRect;
  /** Stroke width at medium pressure, as a fraction of the image height (MIN_INK_WIDTH … MAX_INK_WIDTH; INK_WIDTHS in the UI). */
  width: number;
  /**
   * The points, 5 base64url characters each (shared/ink.ts encodeInkPoints): x and y within `rect` (12 bits each,
   * 0 … 4095 = the rect's left / top … right / bottom edge) and the pen pressure (6 bits, 0 … 63; 32 for a mouse).
   * 1 … MAX_INK_POINTS points; never patched.
   */
  pts: string;
}
/** Pen widths offered in the UI (가늘게 · 보통 · 굵게), fractions of the image height. */
export const INK_WIDTHS: readonly number[] = [0.002, 0.0032, 0.0055];
export const MIN_INK_WIDTH = 0.001;
export const MAX_INK_WIDTH = 0.05;
/** Points of one stroke, after simplification (a longer stroke is stored as several). */
export const MAX_INK_POINTS = 2000;
/** Strokes on one slide (counted apart from MAX_ANNOTATION_ITEMS, which counts the other items). */
export const MAX_INK_STROKES = 3000;

export type AnnotationItem = HighlightItem | TextHighlightItem | RectItem | EllipseItem | TextItem | MemoItem | InkItem;

/**
 * Which question a marker belongs to: the session (SESSION_ID_RE), the user message (MESSAGE_ID_RE) and the region
 * attachment (ATTACHMENT_ID_RE). Markers are derived from sessions on the client (DESIGN §25 "질문 표시"); only hidden
 * ones are stored, by key.
 */
export interface MarkerKey {
  sessionId: string;
  messageId: string;
  attachmentId: string;
}

/** library/<docId>/annotations/NNN.json (NNN = the slide's padded number, like text/NNN.txt) and GET/PUT/PATCH …/annotations/:slide. */
export interface SlideAnnotations {
  version: 1;
  slide: number;
  /** 0 = no file yet; +1 per accepted write (optimistic concurrency: PUT/PATCH carry `baseRev`). */
  rev: number;
  updatedAt: string;
  /** z-order = array order; ≤ MAX_ANNOTATION_ITEMS; ids unique. */
  items: AnnotationItem[];
  /** ≤ MAX_HIDDEN_MARKERS, unique keys. */
  hiddenMarkers: MarkerKey[];
}
/** Items on one slide other than 펜 strokes (those: MAX_INK_STROKES). */
export const MAX_ANNOTATION_ITEMS = 200;
/** Memo / text box text, the highlighted words of a 텍스트 형광, and Attachment.annotation.text. */
export const MAX_ANNOTATION_TEXT_CHARS = 2000;
/**
 * JSON length of a slide's stored document (SlideAnnotations) after a write; a write that would exceed it → 400
 * '이 슬라이드의 필기가 너무 많아요 (일부를 지워 주세요)'. Keeps every slide doc, the PATCH bodies and the client's held
 * slides small (≤ 24 loaded slides per client).
 */
export const MAX_SLIDE_ANNOTATION_BYTES = 1024 * 1024;
export const MAX_MEMO_TAGS = 10;
export const MAX_TAG_CHARS = 30;
export const MAX_MEMO_LINKS = 8;
export const MAX_TEXT_HIGHLIGHT_RECTS = 200;
export const MAX_ANNOTATION_OPS = 100;
export const MAX_HIDDEN_MARKERS = 500;
/** 형광펜 band height (of the image) when no text line is under the drag's start. */
export const HIGHLIGHT_BAND_H = 0.028;
/** ChatMessage.id inside a MarkerKey (a uuid today; checked, never used as a path). */
export const MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * A client's id for the annotation SSE / write pairing: PUT/PATCH send it in the ANNOTATION_CLIENT_HEADER header and
 * GET …/annotations/events takes it as `?client=`; the hub does not echo a client's own `slide` / `slide-reset` events
 * back to it. Optional (curl, tests): without it every subscriber gets every event.
 */
export const ANNOTATION_CLIENT_HEADER = 'X-Annotation-Client';
export const ANNOTATION_CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** PUT …/annotations/:slide — replaces the slide's items and hidden markers. */
export interface PutSlideAnnotationsRequest {
  /** The rev the client holds (0 for a slide without a file); ≠ the stored rev → 409 with `current`. */
  baseRev: number;
  items: AnnotationItem[];
  hiddenMarkers: MarkerKey[];
}
/**
 * The fields of an item an `update` op may change: everything but the id, the type, `createdAt` and `recordedAt`
 * (creation-only). `updatedAt` is accepted so the server's applied op (AnnotationEvent 'slide') can carry its stamp;
 * a client-sent value is replaced. Distributive over the union: `{ rect }` is valid for a rect item, `{ tags }` for a
 * memo; the server applies only the fields of that item's type (patchableFields[type]) and rejects a key of another
 * type (400). An optional field (`size`, `font`, `bold`) set to `null` is removed — back to its default; the undo of
 * setting it — and the applied op echoes `null` so every client removes it too.
 */
export type Patchable<T> = T extends AnnotationItem ? PatchFields<Omit<T, 'id' | 'type' | 'createdAt' | 'recordedAt'>> : never;
type PatchFields<F> = { [K in keyof F]?: F[K] | (undefined extends F[K] ? null : never) };
/** PATCH …/annotations/:slide — ops applied in order on the current document; undo/redo replay inverse ops. */
export type AnnotationOp =
  /** Duplicate id → 409 with `current`. */
  | { op: 'add'; item: AnnotationItem }
  /** Missing id → 409 with `current`. */
  | { op: 'update'; id: string; patch: Patchable<AnnotationItem> }
  /** Idempotent (undo/redo may replay it). */
  | { op: 'remove'; id: string }
  /** Both de-duplicate keys; unhiding an unknown key is a no-op. */
  | { op: 'hideMarker'; key: MarkerKey }
  | { op: 'unhideMarker'; key: MarkerKey };
export interface PatchSlideAnnotationsRequest {
  baseRev: number;
  /** ≤ MAX_ANNOTATION_OPS. */
  ops: AnnotationOp[];
}
/** 409 body of PUT/PATCH …/annotations/:slide (HttpError `fields`, like `missingAttachments`): the document as stored now. */
export interface SlideAnnotationsConflict {
  error: string;
  current: SlideAnnotations;
}

/** A memo as the per-lecture summary lists it (the memo tab, filters; no per-slide loads). */
export interface MemoSummary {
  id: string;
  slide: number;
  color: AnnotationColor;
  /** The first MAX_MEMO_SUMMARY_CHARS characters, at most two lines (whitespace squeezed). */
  text: string;
  tags: string[];
  tutor: boolean;
  createdAt: string;
  updatedAt: string;
  recordedAt?: RecordedAt;
  links: MemoLink[];
}
export const MAX_MEMO_SUMMARY_CHARS = 400;
/**
 * library/<docId>/annotations/index.json and GET …/annotations — the per-lecture summary, rewritten (debounced) after
 * every write, rebuilt from the slide files when missing. Readers ignore unknown fields.
 */
export interface AnnotationSummary {
  version: 1;
  /** Only slides that have items, ascending; `rev` lets a reconnecting client tell which loaded slides are stale. */
  slides: Array<{ slide: number; rev: number; items: number; memos: number; tags: string[] }>;
  /** Every memo of the lecture: slide order, then createdAt. */
  memos: MemoSummary[];
  /** Every tag of the lecture with the number of memos carrying it, most used first, then alphabetical. */
  tags: Array<{ tag: string; count: number }>;
}
/** GET /api/annotations/tags — library-wide, for autocomplete. */
export interface AnnotationTagsResponse {
  tags: Array<{ tag: string; count: number }>;
}

/** A box on the slide image: [x, y, w, h] normalised 0..1, 4 decimals. */
export type LayoutBox = [x: number, y: number, w: number, h: number];
/**
 * text/NNN.layout.json (engine pdfium-3) and GET …/text-layout/:slide: word boxes of the page's text layer, for
 * 텍스트 형광 and 형광펜 snapping. Lines are in reading (content) order; each knows the axis its words advance along on
 * the image ('h' for a page read left to right, 'v' when /Rotate or the glyphs' own angle turned the line): the band
 * of a 형광펜 takes the line's extent along the other axis, and 텍스트 형광 orders words by the coordinate along `dir`.
 */
export interface SlideTextLayout {
  version: 1;
  /** TEXT_ENGINE of the extraction that wrote it (TextHighlightItem.engine). */
  engine: string;
  lines: Array<{
    r: LayoutBox;
    dir: 'h' | 'v';
    /**
     * Split at blanks and, for CJK, around each Han / Hiragana / Katakana code point (and each Hangul syllable of a
     * run without spaces), so a drag can select less than a whole line. `c` = PDFium char indices [start, end) — the
     * anchor TextHighlightItem.chars uses.
     */
    words: Array<{ r: LayoutBox; t: string; c: [start: number, end: number] }>;
  }>;
}
/** 404 body of GET …/text-layout/:slide: `pending` = the backfill was asked for it (ask again later); false = it will never exist. */
export interface TextLayoutMissingResponse {
  error: string;
  pending: boolean;
}

/** Events on GET …/annotations/events (SSE, `event: <type>`, JSON data; no replay — clients refetch what they hold on reconnect). */
export type AnnotationEvent =
  /**
   * After every accepted PATCH: the ops as the server applied them (`add` carries the stored item with the server's
   * `updatedAt` / `recordedAt`, `update` the accepted patch plus `updatedAt`), and the new rev. Clients apply them with
   * the same pure applyOps when `rev` follows the rev they hold, else refetch the slide. Not sent to the writer's own
   * client id.
   */
  | { type: 'slide'; slide: number; rev: number; updatedAt: string; ops: AnnotationOp[] }
  /** After an accepted PUT (the whole slide document; not sent to the writer's own client id). */
  | { type: 'slide-reset'; annotations: SlideAnnotations }
  /** Counts / tags / memo summaries changed → clients refetch the summary if they show it. */
  | { type: 'summary' }
  /**
   * A session of this lecture finished a turn (`updatedAt` = the session's) or was deleted (`updatedAt: null`) →
   * clients refresh their notes (question markers) unless they already hold that state.
   */
  | { type: 'qa'; sessionId: string; updatedAt: string | null }
  /**
   * The lecture's deck was swapped (DESIGN §28: a new version applied, or undone): `oldToNew[old - 1]` = the new number of
   * an old slide (null = dropped). Clients drop everything they hold for the lecture (slide images, annotations, text
   * layouts, notes, the open session, composer chips, recordings) and load it again; the stream ends after this event.
   */
  | { type: 'deck'; rev: number; kind: 'apply' | 'undo'; oldToNew: (number | null)[] }
  | { type: 'ping' };

/**
 * Per-device annotation settings (localStorage; web/src/lib/storage.ts keys of the same names; DESIGN §25). Only
 * `memosToTutor` reaches the server, as SendMessageRequest.memos.
 */
export interface AnnotationDeviceSettings {
  /** Color of new items (`annotColor`). Default 'yellow'. */
  annotColor: AnnotationColor;
  /** 펜 color (`inkColor`, one of INK_COLORS). Default 'black'. */
  inkColor: AnnotationColor;
  /** 펜 width (`inkWidth`, one of INK_WIDTHS). Default INK_WIDTHS[1]. */
  inkWidth: number;
  /**
   * 손가락으로도 쓰기 (`fingerInk`). Default false: under 펜 and 지우개 a stylus or the mouse writes and fingers scroll and
   * zoom (palm rejection); true for a device without a stylus (a phone), where the finger writes too.
   */
  fingerInk: boolean;
  /** 필기 보기/숨기기 (`annotLayer`). Default true; hidden = layers unmount, tools disabled. */
  annotLayer: boolean;
  /** 슬라이드에 질문 표시 보기 (`questionMarkers`). Default true. */
  questionMarkers: boolean;
  /** 학생의 메모를 튜터에게 보이기 (`memosToTutor`). Default true. */
  memosToTutor: boolean;
  /** 그때 필기 재생 (`replayAnnotations`). Default false; effective only while a recording of the lecture is selected in the 녹음 tab. */
  replayAnnotations: boolean;
}
