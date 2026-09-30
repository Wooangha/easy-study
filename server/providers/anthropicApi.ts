// anthropic-api provider: Claude through the Messages API with an API key (DESIGN §6).
//
// Stateless: every turn resends the current provider conversation (`history`) plus this turn's
// parts, with images inlined as base64 (re-encoded as compact JPEGs, see loadInlineImage). Two
// prompt-cache breakpoints keep that cheap: one at the end of the first (priming) user turn — the
// deck — and one at the end of the current turn. ANTHROPIC_BASE_URL is honoured by the SDK itself.
// ProviderRunInput.ephemeral needs no handling (nothing is stored server-side); extraReadDirs and
// allowTools are ignored (the model has no tools or file access).
//
// Size limits: because the whole conversation is resent, it must stay under the API's 32 MB request
// limit and the model's context window (200K tokens for Haiku 4.5, 1M for the current Opus / Sonnet
// models). Before sending, the request is measured (exact bytes, estimated tokens); a conversation
// that would not fit fails with ProviderError 'context_overflow' without calling the API, and the
// orchestrator continues in a new conversation (re-prime + recap). API errors are classified the same
// way (413, "prompt is too long", …).
//
// Token usage (DESIGN §23) streams with message_start / message_delta; the final message's usage is the total.
//
// The SDK is imported on the first call (measured: importing it and the openai SDK at startup costs the
// server ~12 MB of idle footprint, and most users never use an API provider).
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ModelOption, TokenUsage } from '../../shared/types.ts';
import type {
  HistoryTurn,
  Part,
  Provider,
  ProviderAvailability,
  ProviderErrorKind,
  ProviderRunInput,
  ProviderRunResult,
} from './types.ts';
import { ProviderError } from './types.ts';
import { smsg } from '../i18n.ts';
import { abortError, errorMessage, loadInlineImage } from './proc.ts';
import { AnthropicUsageTracker, anthropicUsage } from './usage.ts';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';

export const ANTHROPIC_MODELS: ModelOption[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

/** Streaming responses can be long; keep room for (adaptive) thinking plus a long answer. */
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * Models whose safety classifiers may decline a request. For them we opt into server-side
 * fallbacks ("default" routing picks Anthropic's recommended substitute per refusal category).
 * Disable with EASY_STUDY_ANTHROPIC_FALLBACKS=0 (e.g. behind a gateway that rejects the field).
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1']);

const CACHE = { type: 'ephemeral' } as const;

/** Context windows (tokens) of the offered models; see anthropicContextWindow for others. */
const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-fable-5': 1_000_000,
  'claude-fable-5-1': 1_000_000,
};

/** Room left in the context window for the answer (thinking + text) when checking a request. */
const OUTPUT_RESERVE_TOKENS = 32_000;
/** The Messages API rejects request bodies over 32 MB (HTTP 413); keep a margin. */
export const MAX_REQUEST_BYTES = 30_000_000;

/** Context window of a model: known models, else by family (current Opus/Sonnet/Fable: 1M), else 200K. */
export function anthropicContextWindow(model: string): number {
  const known = CONTEXT_WINDOWS[model];
  if (known) return known;
  if (/haiku/i.test(model)) return 200_000;
  if (/^claude-(?:opus|sonnet|fable|mythos)-(?:4-[6-9]|[5-9])/i.test(model)) return 1_000_000;
  return 200_000;
}

/**
 * Tokens an image costs at most (our images are at most 1568 px, see INLINE_IMAGE_MAX_EDGE): about
 * 1600 on standard-resolution models (Haiku 4.5), up to about (w·h)/750 ≈ 2100–3300 on high-resolution ones.
 */
function imageTokens(model: string): number {
  return /haiku/i.test(model) ? 1_600 : 2_400;
}

/** Rough token count of text: ASCII at ~3.5 characters per token, other characters (Korean, math) ~0.9 each. */
function textTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3.5 + (text.length - ascii) * 0.9);
}

/** Estimated input tokens of a request (system prompt, every text block, a per-image allowance). */
export function estimateAnthropicInputTokens(params: BetaMessageStreamParams): number {
  const model = params.model;
  let tokens = typeof params.system === 'string' ? textTokens(params.system) : 0;
  for (const message of params.messages) {
    if (typeof message.content === 'string') {
      tokens += textTokens(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') tokens += textTokens(block.text);
      else if (block.type === 'image') tokens += imageTokens(model);
    }
  }
  return tokens;
}

/**
 * Throws ProviderError 'context_overflow' when a request cannot succeed: its body exceeds the request
 * size limit, or (for a continued conversation, which a new conversation can shrink) its estimated
 * tokens leave no room for an answer in the model's context window.
 */
export function checkAnthropicRequest(params: BetaMessageStreamParams, continued: boolean): void {
  const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
  if (bytes > MAX_REQUEST_BYTES) {
    const m = smsg().chat.providers.anthropic;
    throw new ProviderError(
      m.requestTooLarge((bytes / 1_000_000).toFixed(1)) + (continued ? ` ${m.tooManyImages}` : ''),
      'context_overflow',
    );
  }
  if (!continued) return;
  const window = anthropicContextWindow(params.model);
  const estimate = estimateAnthropicInputTokens(params);
  if (estimate + OUTPUT_RESERVE_TOKENS > window) {
    throw new ProviderError(
      smsg().chat.providers.anthropic.nearContextLimit(params.model, Math.round(window / 1000), Math.round(estimate / 1000)),
      'context_overflow',
    );
  }
}

function defaultModel(): string {
  return process.env.EASY_STUDY_ANTHROPIC_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
}

function maxTokens(): number {
  const n = Number(process.env.EASY_STUDY_ANTHROPIC_MAX_TOKENS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

function fallbacksEnabled(model: string): boolean {
  return process.env.EASY_STUDY_ANTHROPIC_FALLBACKS !== '0' && FALLBACK_MODELS.has(model);
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface AnthropicRequestInput {
  systemPrompt: string;
  parts: Part[];
  history: HistoryTurn[];
  model: string;
}

async function toContent(parts: Part[]): Promise<BetaContentBlockParam[]> {
  const content: BetaContentBlockParam[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) content.push({ type: 'text', text: part.text }); // empty text blocks are rejected
    } else {
      const image = await loadInlineImage(part.path);
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '(empty)' });
  return content;
}

function withCacheBreakpoint(message: BetaMessageParam): void {
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content[message.content.length - 1];
  message.content[message.content.length - 1] = { ...last, cache_control: CACHE } as BetaContentBlockParam;
}

/** Builds the streaming request body (exported for tests). */
export async function buildAnthropicRequest(input: AnthropicRequestInput): Promise<BetaMessageStreamParams> {
  const turns: HistoryTurn[] = [...input.history, { role: 'user', parts: input.parts }];
  const messages: BetaMessageParam[] = [];
  for (const turn of turns) {
    messages.push({ role: turn.role, content: await toContent(turn.parts) });
  }
  // Breakpoint 1: end of the first user turn (system prompt + deck). Breakpoint 2: end of this turn.
  withCacheBreakpoint(messages[0]);
  if (messages.length > 1) withCacheBreakpoint(messages[messages.length - 1]);

  const model = input.model || defaultModel();
  const params: BetaMessageStreamParams = {
    model,
    max_tokens: maxTokens(),
    system: input.systemPrompt,
    messages,
  };
  if (fallbacksEnabled(model)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Turns stream events into onDelta/onStatus/onUsage calls and assembles the final text. */
export class AnthropicStreamState {
  /**
   * The answer text, equal to the concatenation of the onDelta chunks. Across a server-side fallback it
   * holds the declined model's partial text followed by the fallback model's continuation.
   */
  text = '';
  /** Tokens used so far (undefined until the stream reported any). */
  usage: TokenUsage | undefined;
  private lastIndex: number | null = null;
  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;
  private readonly onUsage: ((usage: TokenUsage) => void) | undefined;
  private readonly calls = new AnthropicUsageTracker();

  constructor(onDelta: (text: string) => void, onStatus: (text: string) => void, onUsage?: (usage: TokenUsage) => void) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
    this.onUsage = onUsage;
  }

  /** Reports usage (the stream's running total, or the final message's). */
  reportUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    this.usage = usage;
    this.onUsage?.(usage);
  }

  handle(event: BetaRawMessageStreamEvent): void {
    if (event.type === 'message_start') {
      this.reportUsage(this.calls.start(event.message.usage));
      return;
    }
    if (event.type === 'message_delta') {
      this.reportUsage(this.calls.update(event.usage));
      return;
    }
    if (event.type === 'content_block_start') {
      const type = event.content_block.type;
      if (type === 'thinking' || type === 'redacted_thinking') {
        this.onStatus(smsg().chat.providers.thinking);
      } else if (type === 'fallback') {
        // The requested model declined; a fallback model takes over. After partial output it is given
        // the partial text as continuation context and carries on from it (mid-sentence), so the text
        // is kept and the continuation appended without a separator (lastIndex = null).
        this.onStatus(smsg().chat.providers.anthropic.continuedByOtherModel);
        this.lastIndex = null;
      }
      return;
    }
    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta' || !event.delta.text) return;
    let chunk = event.delta.text;
    if (this.lastIndex !== null && event.index !== this.lastIndex && this.text) {
      chunk = (this.text.endsWith('\n\n') ? '' : this.text.endsWith('\n') ? '\n' : '\n\n') + chunk;
    }
    this.lastIndex = event.index;
    this.text += chunk;
    this.onDelta(chunk);
  }
}

/** The request or conversation is too large for the model (the message of a 400 / 413). */
const OVERFLOW_RE =
  /prompt is too long|input is too long|too many tokens|request_too_large|request (?:size )?exceeds|exceed(?:s|ed)? (?:the )?context|context (?:limit|window)|too many images/i;
/** A model the account cannot use or that does not exist. */
const MODEL_RE = /\bmodel\b/i;

/** Kind of a Messages API error. */
export function classifyAnthropicError(status: number | undefined, message: string): ProviderErrorKind {
  if (status === 413 || ((status === 400 || status === undefined) && OVERFLOW_RE.test(message))) return 'context_overflow';
  if (status === 401) return 'auth';
  if (status === 403) return MODEL_RE.test(message) ? 'model_unavailable' : 'auth';
  if (status === 404 && MODEL_RE.test(message)) return 'model_unavailable';
  return 'other';
}

type AnthropicSdk = typeof Anthropic;

let sdk: Promise<AnthropicSdk> | null = null;

/** The SDK's client class (with the error classes as statics), imported on first use. */
function loadAnthropicSdk(): Promise<AnthropicSdk> {
  sdk ??= import('@anthropic-ai/sdk').then(
    (mod) => mod.default,
    (err: unknown) => {
      sdk = null; // let a later call try again
      throw err;
    },
  );
  return sdk;
}

function toProviderError(Anthropic: AnthropicSdk, err: unknown): Error {
  if (err instanceof ProviderError) return err;
  const m = smsg().chat.providers.anthropic;
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(m.connectFailed(err.message), 'other', { cause: err });
  if (!(err instanceof Anthropic.APIError)) return err instanceof Error ? err : new Error(errorMessage(err));
  const kind = classifyAnthropicError(err.status, err.message);
  let message: string;
  if (err instanceof Anthropic.AuthenticationError) {
    message = m.authFailed;
  } else if (err instanceof Anthropic.PermissionDeniedError) {
    message = m.permissionDenied(err.message);
  } else if (err instanceof Anthropic.NotFoundError) {
    message = m.notFound(err.message);
  } else if (err instanceof Anthropic.RateLimitError) {
    message = m.rateLimited;
  } else if (kind === 'context_overflow') {
    message = m.tooLargeForModel(err.message);
  } else if (err instanceof Anthropic.BadRequestError) {
    message = m.badRequest(err.message);
  } else {
    message = m.error(err.status ?? 0, err.message);
  }
  return new ProviderError(message, kind, { cause: err });
}

async function runAnthropic(input: ProviderRunInput): Promise<ProviderRunResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ProviderError(smsg().chat.providers.apiKeyMissing('ANTHROPIC_API_KEY'), 'auth');
  }
  if (input.signal.aborted) throw abortError();

  const params = await buildAnthropicRequest({
    systemPrompt: input.systemPrompt,
    parts: input.parts,
    history: input.history,
    model: input.model,
  });
  checkAnthropicRequest(params, input.history.length > 0);
  const Anthropic = await loadAnthropicSdk();
  if (input.signal.aborted) throw abortError();
  const client = new Anthropic({ maxRetries: 2 });
  const state = new AnthropicStreamState(input.onDelta, input.onStatus, input.onUsage);

  try {
    const stream = client.beta.messages.stream(params, { signal: input.signal });
    for await (const event of stream) state.handle(event);
    if (input.signal.aborted) throw abortError();
    const final = await stream.finalMessage();
    // The SDK folds every message_delta into the final message: its usage is the call's total.
    state.reportUsage(anthropicUsage(final.usage));
    if (final.stop_reason === 'refusal') {
      const category = final.stop_details?.category;
      throw new Error(smsg().chat.providers.anthropic.refused(category ?? ''));
    }
    if ((final.stop_reason as string) === 'model_context_window_exceeded') {
      // The context window filled up while answering: without an answer a new conversation is needed.
      if (!state.text.trim()) {
        throw new ProviderError(smsg().chat.providers.anthropic.contextFull, 'context_overflow');
      }
      input.onStatus(smsg().chat.providers.anthropic.cutOffByContext);
    }
  } catch (err) {
    if (input.signal.aborted || err instanceof Anthropic.APIUserAbortError) throw abortError();
    throw toProviderError(Anthropic, err);
  }
  const out: ProviderRunResult = { text: state.text, resume: {} };
  if (state.usage) out.usage = state.usage;
  return out;
}

/** Available with an API key; checked once for every language (the reason is worded when the result is). */
async function probeAnthropic(): Promise<() => ProviderAvailability> {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  return () => (hasKey ? { available: true } : { available: false, reason: smsg().chat.providers.apiKeyMissing('ANTHROPIC_API_KEY') });
}

export const anthropicApiProvider: Provider = {
  id: 'anthropic-api',
  // In the request's language (DESIGN §27).
  get label(): string {
    return smsg().chat.providers.label['anthropic-api'];
  },
  kind: 'api',
  get models(): ModelOption[] {
    const model = defaultModel();
    const known = ANTHROPIC_MODELS.some((m) => m.id === model);
    return known ? [...ANTHROPIC_MODELS] : [{ id: model, label: model }, ...ANTHROPIC_MODELS];
  },
  get defaultModel(): string {
    return defaultModel();
  },
  maxImagesPerConversation: 90,
  async detect(): Promise<ProviderAvailability> {
    return (await probeAnthropic())();
  },
  probe: probeAnthropic,
  run: runAnthropic,
};
