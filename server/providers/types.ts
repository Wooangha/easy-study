// Internal contract between the chat orchestrator (server/chat.ts) and LLM providers.
import type { ModelOption, ProviderId } from '../../shared/types.ts';

/** One piece of a user turn. Images are referenced by absolute path and loaded by the provider. */
export type Part =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      /** Absolute path to a PNG file. */
      path: string;
      /** 'low' = overview/contact sheet, 'high' = focused slide at full resolution. */
      detail: 'low' | 'high';
      /** Short human label, e.g. "Slide 7" or "Slides 1-4 overview". */
      label: string;
    };

/** A previous turn, for stateless API providers that must resend history. */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  /** User turns keep their parts (images by path); assistant turns are plain text. */
  parts: Part[];
}

/**
 * Opaque per-provider conversation handle persisted in the session file.
 * - claude-code: { cliSessionId }   (claude -p --resume <id>)
 * - codex:       { cliSessionId }   (codex exec resume <thread_id>)
 * - openai-api:  { previousResponseId }
 * - anthropic-api: {} (history is resent every turn; see ProviderRunInput.history)
 */
export interface ResumeHandle {
  cliSessionId?: string;
  previousResponseId?: string;
}

export interface ProviderRunInput {
  /** Working directory for CLI providers: the document directory (library/<docId>). */
  cwd: string;
  systemPrompt: string;
  /** Content of this user turn. */
  parts: Part[];
  /** null = start a brand new provider conversation; otherwise continue it. */
  resume: ResumeHandle | null;
  /**
   * Prior turns of the *current* provider conversation (empty when resume === null).
   * Only stateless providers (anthropic-api) use it; others may ignore it.
   */
  history: HistoryTurn[];
  /** '' = provider default. */
  model: string;
  /**
   * One-shot call that will never be resumed (digest batches): CLI providers should not persist
   * a session (claude: --no-session-persistence without --session-id; codex: --ephemeral).
   * Defaults to false.
   */
  ephemeral?: boolean;
  /**
   * Extra directories the model may read (other lectures of the same course).
   * claude: one `--add-dir <dir>` per entry. codex: its read-only sandbox can already read them.
   * API providers ignore it.
   */
  extraReadDirs?: string[];
  /**
   * false = the model needs no tools for this call (digest batches: images are attached). CLI providers then
   * disable tools as far as the CLI allows (claude: --tools ""). Defaults to true.
   */
  allowTools?: boolean;
  signal: AbortSignal;
  /** Streamed assistant text (append-only). */
  onDelta: (text: string) => void;
  /** Transient progress information (tool use, reasoning, ...). */
  onStatus: (text: string) => void;
}

export interface ProviderRunResult {
  /** Full assistant text of this turn (should equal the concatenation of onDelta chunks). */
  text: string;
  /** Handle to continue this conversation next turn. */
  resume: ResumeHandle;
}

export interface ProviderAvailability {
  available: boolean;
  reason?: string;
  version?: string;
}

export interface Provider {
  id: ProviderId;
  label: string;
  kind: 'cli' | 'api';
  models: ModelOption[];
  defaultModel: string;
  /**
   * Max images one provider conversation may accumulate (history included) before the
   * orchestrator starts a fresh conversation (re-priming). Keeps requests under API limits.
   */
  maxImagesPerConversation: number;
  detect(): Promise<ProviderAvailability>;
  /**
   * Must reject with an Error on failure (preferably a ProviderError with a precise kind); must reject with an
   * AbortError-like error when aborted.
   */
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
}

/**
 * Why a provider call failed, so the orchestrator can recover:
 * - 'resume_invalid'   the conversation handle no longer exists (expired/deleted CLI session, unknown thread,
 *                      unknown previous_response_id) → start a new conversation (re-prime + recap) and retry once.
 * - 'context_overflow' the request/conversation is too large (HTTP 413, "prompt is too long",
 *                      context_length_exceeded, …) → start a new conversation (re-prime + recap) and retry once.
 * - 'auth'             not logged in / invalid key → show a login hint, no retry.
 * - 'model_unavailable' the chosen model is unknown or needs a newer CLI → show a hint, no retry.
 * - 'other'            anything else.
 */
export type ProviderErrorKind = 'resume_invalid' | 'context_overflow' | 'auth' | 'model_unavailable' | 'other';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  constructor(message: string, kind: ProviderErrorKind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

/** Kind of any thrown value ('other' unless it is a ProviderError-like object with a known kind). */
export function providerErrorKind(err: unknown): ProviderErrorKind {
  const kind = (err as { kind?: unknown } | null)?.kind;
  return kind === 'resume_invalid' || kind === 'context_overflow' || kind === 'auth' || kind === 'model_unavailable'
    ? kind
    : 'other';
}
