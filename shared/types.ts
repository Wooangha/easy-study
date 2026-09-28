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
  /** Korean name, e.g. '높음' (EFFORT_LABELS). */
  label: string;
  /** Longer explanation (tooltip). */
  description?: string;
}

/** Korean names of the reasoning-effort levels; an unknown level is shown by its id. */
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
  /** Number of attachments (selected slide regions / images) sent with this question. */
  attachments?: number;
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
  /** Present on user messages that carried attachments (selected slide regions or images). */
  attachments?: Attachment[];
  /** Present on assistant messages. */
  provider?: ProviderId;
  model?: string;
  /** Reasoning effort of the assistant message (absent = the CLI's default). */
  effort?: string;
  durationMs?: number;
}

export interface SessionSummary {
  id: string;
  docId: string;
  title: string;
  provider: ProviderId;
  model: string;
  /** Reasoning effort (EffortOption.id); absent = the CLI's default (and sessions made before efforts existed). */
  effort?: string;
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
  /** One of ProviderInfo.efforts that the model supports; '' or omitted = the CLI's default. */
  effort?: string;
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
  /** Ids of attachments created beforehand (POST …/attachments or …/regions) of this document, max MAX_ATTACHMENTS. */
  attachments?: string[];
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
  createdAt: string;
}

/** POST /api/docs/:docId/regions */
export interface CreateRegionRequest {
  slide: number;
  rect: RegionRect;
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
  /** 'metal' on Apple Silicon builds, otherwise 'cpu'. */
  acceleration: 'metal' | 'cpu';
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
