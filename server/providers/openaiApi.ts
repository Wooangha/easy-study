// openai-api provider: OpenAI Responses API with an API key (DESIGN §6).
//
// The conversation lives on OpenAI's side (store: true); each turn continues it with
// previous_response_id and only sends the new user turn. `instructions` are not carried over
// between responses, so the system prompt is sent every turn. OPENAI_BASE_URL is honoured by the SDK.
// One-shot (ephemeral) calls such as digest batches are never continued, so they are not stored.
// extraReadDirs and allowTools are ignored: the model has no tools or file access. Images are sent
// inline, re-encoded as compact JPEGs (see loadInlineImage).
//
// Failures are classified (ProviderError): an expired / deleted previous_response_id (stored
// responses are kept for a limited time) is 'resume_invalid'; context_length_exceeded / HTTP 413 is
// 'context_overflow' — both make the orchestrator continue in a new conversation (re-prime + recap).
//
// Token usage (DESIGN §23) comes with response.completed / response.incomplete / response.failed.
//
// The SDK is imported on the first call (measured: importing it and the Anthropic SDK at startup costs the
// server ~12 MB of idle footprint, and most users never use an API provider).
import type OpenAI from 'openai';
import type {
  ResponseCreateParamsStreaming,
  ResponseInputContent,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { ModelOption, TokenUsage } from '../../shared/types.ts';
import type {
  Part,
  Provider,
  ProviderAvailability,
  ProviderErrorKind,
  ProviderRunInput,
  ProviderRunResult,
  ResumeHandle,
} from './types.ts';
import { ProviderError } from './types.ts';
import { smsg } from '../i18n.ts';
import { abortError, errorMessage, loadInlineImage } from './proc.ts';
import { openaiUsage } from './usage.ts';

export const OPENAI_FALLBACK_MODEL = 'gpt-5';

function defaultModel(): string {
  return process.env.OPENAI_MODEL?.trim() || OPENAI_FALLBACK_MODEL;
}

function modelOptions(): ModelOption[] {
  const ids = [defaultModel(), 'gpt-5', 'gpt-5-mini'];
  return [...new Set(ids)].map((id) => ({ id, label: id }));
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface OpenAIRequestInput {
  systemPrompt: string;
  parts: Part[];
  resume: ResumeHandle | null;
  model: string;
  /** One-shot call that will never be continued: store: false. */
  ephemeral?: boolean;
}

async function toContent(parts: Part[]): Promise<ResponseInputContent[]> {
  const content: ResponseInputContent[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) content.push({ type: 'input_text', text: part.text });
    } else {
      const image = await loadInlineImage(part.path);
      content.push({
        type: 'input_image',
        image_url: `data:${image.mediaType};base64,${image.data}`,
        detail: part.detail,
      });
    }
  }
  if (content.length === 0) content.push({ type: 'input_text', text: '(empty)' });
  return content;
}

/** Builds the streaming request body (exported for tests). */
export async function buildOpenAIRequest(input: OpenAIRequestInput): Promise<ResponseCreateParamsStreaming> {
  const params: ResponseCreateParamsStreaming = {
    model: input.model || defaultModel(),
    instructions: input.systemPrompt,
    input: [{ role: 'user', content: await toContent(input.parts) }],
    store: input.ephemeral !== true,
    stream: true,
  };
  const previous = input.resume?.previousResponseId;
  if (previous) params.previous_response_id = previous;
  return params;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Turns Responses stream events into onDelta/onStatus/onUsage calls; throws on failure events. */
export class OpenAIStreamState {
  text = '';
  responseId: string | undefined;
  completed = false;
  /** Tokens of the response (undefined until reported). */
  usage: TokenUsage | undefined;
  private lastPart: string | null = null;
  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;
  private readonly onUsage: ((usage: TokenUsage) => void) | undefined;

  constructor(onDelta: (text: string) => void, onStatus: (text: string) => void, onUsage?: (usage: TokenUsage) => void) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
    this.onUsage = onUsage;
  }

  private reportUsage(value: unknown): void {
    const usage = openaiUsage(value);
    if (!usage) return;
    this.usage = usage;
    this.onUsage?.(usage);
  }

  handle(event: ResponseStreamEvent): void {
    switch (event.type) {
      case 'response.created':
        this.responseId = event.response.id;
        break;
      case 'response.output_item.added':
        if (event.item.type === 'reasoning') this.onStatus(smsg().chat.providers.thinking);
        break;
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        this.append(`${event.output_index}:${event.content_index}`, event.delta);
        break;
      case 'response.completed':
        this.responseId = event.response.id;
        this.completed = true;
        this.reportUsage(event.response.usage);
        break;
      case 'response.incomplete': {
        // Usually max_output_tokens: keep the (truncated) answer.
        this.responseId = event.response.id;
        this.completed = true;
        this.reportUsage(event.response.usage);
        const reason = event.response.incomplete_details?.reason;
        if (reason) this.onStatus(smsg().chat.providers.openai.endedEarly(reason));
        break;
      }
      case 'response.failed': {
        this.reportUsage(event.response.usage);
        const error = event.response.error;
        const message = error?.message ?? smsg().chat.providers.openai.failed;
        throw openaiFailure({ code: error?.code ?? null, message }, false);
      }
      case 'error':
        throw openaiFailure({ code: event.code ?? null, param: event.param ?? null, message: event.message }, false);
      default:
        break;
    }
  }

  private append(partKey: string, delta: string): void {
    if (!delta) return;
    let chunk = delta;
    if (this.lastPart !== null && partKey !== this.lastPart && this.text) {
      chunk = (this.text.endsWith('\n\n') ? '' : this.text.endsWith('\n') ? '\n' : '\n\n') + chunk;
    }
    this.lastPart = partKey;
    this.text += chunk;
    this.onDelta(chunk);
  }
}

export interface OpenAIErrorInfo {
  status?: number;
  code?: string | null;
  param?: string | null;
  message: string;
}

/**
 * Kind of an OpenAI API error (HTTP error or failure event). `resumed` = the request continued a
 * conversation with previous_response_id. OpenAI reports an unknown previous response as a 400 or 404
 * with code previous_response_not_found / param previous_response_id, so the status alone says nothing.
 */
export function classifyOpenAIError(info: OpenAIErrorInfo, resumed: boolean): ProviderErrorKind {
  const { status, code, param, message } = info;
  if (resumed && (code === 'previous_response_not_found' || param === 'previous_response_id' || /previous[_ ]response/i.test(message))) {
    return 'resume_invalid';
  }
  if (
    status === 413 ||
    code === 'context_length_exceeded' ||
    /context[_ ]length|context window|maximum context length|too many tokens|input (?:is )?too (?:long|large)|request too large/i.test(message)
  ) {
    return 'context_overflow';
  }
  if (status === 401 || code === 'invalid_api_key') return 'auth';
  if (code === 'model_not_found' || ((status === 403 || status === 404) && /\bmodel\b/i.test(message))) {
    return 'model_unavailable';
  }
  if (status === 400 && /\bmodel\b.{0,80}(?:does not exist|not supported|not found|unsupported|not available)/i.test(message)) {
    return 'model_unavailable';
  }
  if (status === 403) return 'auth';
  return 'other';
}

/** ProviderError with a message (in the turn's language) for an OpenAI failure. */
function openaiFailure(info: OpenAIErrorInfo, resumed: boolean, cause?: unknown): ProviderError {
  const kind = classifyOpenAIError(info, resumed);
  const detail = info.message;
  const m = smsg().chat.providers.openai;
  let message: string;
  switch (kind) {
    case 'resume_invalid':
      message = m.previousResponseNotFound(detail);
      break;
    case 'context_overflow':
      message = m.contextOverflow(detail);
      break;
    case 'auth':
      message = info.status === 403 ? m.permissionDenied(detail) : m.authFailed;
      break;
    case 'model_unavailable':
      message = m.modelUnavailable(detail);
      break;
    default:
      if (info.status === 429) message = m.rateLimited(detail);
      else if (info.status === 400) message = m.badRequest(detail);
      else if (info.status === 404) message = m.notFound(detail);
      else message = m.error(info.status ?? 0, detail);
      break;
  }
  return new ProviderError(message, kind, cause === undefined ? undefined : { cause });
}

type OpenAISdk = typeof OpenAI;

let sdk: Promise<OpenAISdk> | null = null;

/** The SDK's client class (with the error classes as statics), imported on first use. */
function loadOpenAISdk(): Promise<OpenAISdk> {
  sdk ??= import('openai').then(
    (mod) => mod.default,
    (err: unknown) => {
      sdk = null; // let a later call try again
      throw err;
    },
  );
  return sdk;
}

function toProviderError(OpenAI: OpenAISdk, err: unknown, resumed: boolean): Error {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError(smsg().chat.providers.openai.connectFailed(err.message), 'other', { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    return openaiFailure({ status: err.status, code: err.code, param: err.param, message: err.message }, resumed, err);
  }
  return err instanceof Error ? err : new Error(errorMessage(err));
}

async function runOpenAI(input: ProviderRunInput): Promise<ProviderRunResult> {
  if (!process.env.OPENAI_API_KEY) throw new ProviderError(smsg().chat.providers.apiKeyMissing('OPENAI_API_KEY'), 'auth');
  if (input.signal.aborted) throw abortError();

  const params = await buildOpenAIRequest({
    systemPrompt: input.systemPrompt,
    parts: input.parts,
    resume: input.resume,
    model: input.model,
    ephemeral: input.ephemeral,
  });
  const OpenAI = await loadOpenAISdk();
  if (input.signal.aborted) throw abortError();
  const client = new OpenAI({ maxRetries: 2 });
  const state = new OpenAIStreamState(input.onDelta, input.onStatus, input.onUsage);

  try {
    const stream = await client.responses.create(params, { signal: input.signal });
    for await (const event of stream) state.handle(event);
  } catch (err) {
    if (input.signal.aborted || err instanceof OpenAI.APIUserAbortError) throw abortError();
    throw toProviderError(OpenAI, err, Boolean(params.previous_response_id));
  }
  // The SDK may end the stream quietly instead of throwing when the request is aborted.
  if (input.signal.aborted) throw abortError();
  if (!state.completed) throw new Error(smsg().chat.providers.openai.incomplete);
  if (!state.responseId) throw new Error(smsg().chat.providers.openai.noResponseId);
  const out: ProviderRunResult = { text: state.text, resume: { previousResponseId: state.responseId } };
  if (state.usage) out.usage = state.usage;
  return out;
}

/** Available with an API key; checked once for every language (the reason is worded when the result is). */
async function probeOpenAI(): Promise<() => ProviderAvailability> {
  const hasKey = !!process.env.OPENAI_API_KEY;
  return () => (hasKey ? { available: true } : { available: false, reason: smsg().chat.providers.apiKeyMissing('OPENAI_API_KEY') });
}

export const openaiApiProvider: Provider = {
  id: 'openai-api',
  // In the request's language (DESIGN §27).
  get label(): string {
    return smsg().chat.providers.label['openai-api'];
  },
  kind: 'api',
  get models(): ModelOption[] {
    return modelOptions();
  },
  get defaultModel(): string {
    return defaultModel();
  },
  maxImagesPerConversation: 150,
  async detect(): Promise<ProviderAvailability> {
    return (await probeOpenAI())();
  },
  probe: probeOpenAI,
  run: runOpenAI,
};
