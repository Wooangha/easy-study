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
// The SDK is imported on the first call (measured: importing it and the Anthropic SDK at startup costs the
// server ~12 MB of idle footprint, and most users never use an API provider).
import type OpenAI from 'openai';
import type {
  ResponseCreateParamsStreaming,
  ResponseInputContent,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { ModelOption } from '../../shared/types.ts';
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
import { abortError, errorMessage, loadInlineImage } from './proc.ts';

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

/** Turns Responses stream events into onDelta/onStatus calls; throws on failure events. */
export class OpenAIStreamState {
  text = '';
  responseId: string | undefined;
  completed = false;
  private lastPart: string | null = null;
  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;

  constructor(onDelta: (text: string) => void, onStatus: (text: string) => void) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
  }

  handle(event: ResponseStreamEvent): void {
    switch (event.type) {
      case 'response.created':
        this.responseId = event.response.id;
        break;
      case 'response.output_item.added':
        if (event.item.type === 'reasoning') this.onStatus('생각하는 중…');
        break;
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        this.append(`${event.output_index}:${event.content_index}`, event.delta);
        break;
      case 'response.completed':
        this.responseId = event.response.id;
        this.completed = true;
        break;
      case 'response.incomplete': {
        // Usually max_output_tokens: keep the (truncated) answer.
        this.responseId = event.response.id;
        this.completed = true;
        const reason = event.response.incomplete_details?.reason;
        if (reason) this.onStatus(`응답이 중간에 끝났습니다 (${reason})`);
        break;
      }
      case 'response.failed': {
        const error = event.response.error;
        const message = error?.message ?? '응답 생성에 실패했습니다.';
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

/** ProviderError with a Korean message for an OpenAI failure. */
function openaiFailure(info: OpenAIErrorInfo, resumed: boolean, cause?: unknown): ProviderError {
  const kind = classifyOpenAIError(info, resumed);
  const detail = info.message;
  let message: string;
  switch (kind) {
    case 'resume_invalid':
      message = `OpenAI API: 이전 응답(previous_response_id)을 찾을 수 없습니다. 저장된 대화가 만료되었거나 삭제되었습니다 (${detail})`;
      break;
    case 'context_overflow':
      message = `OpenAI API: 대화가 모델의 컨텍스트 한도를 넘었습니다 (${detail})`;
      break;
    case 'auth':
      message =
        info.status === 403
          ? `OpenAI API 권한 오류: ${detail}`
          : 'OpenAI API 인증에 실패했습니다. OPENAI_API_KEY를 확인하세요.';
      break;
    case 'model_unavailable':
      message = `OpenAI API: 모델을 찾을 수 없거나 사용할 수 없습니다 (${detail})`;
      break;
    default:
      if (info.status === 429) message = `OpenAI API 요청 한도를 초과했습니다: ${detail}`;
      else if (info.status === 400) message = `OpenAI API 요청 오류: ${detail}`;
      else if (info.status === 404) message = `OpenAI API: 요청한 항목을 찾을 수 없습니다 (${detail})`;
      else if (info.status) message = `OpenAI API 오류 (${info.status}): ${detail}`;
      else message = `OpenAI API 오류: ${detail}`;
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
    return new ProviderError(`OpenAI API에 연결할 수 없습니다: ${err.message}`, 'other', { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    return openaiFailure({ status: err.status, code: err.code, param: err.param, message: err.message }, resumed, err);
  }
  return err instanceof Error ? err : new Error(errorMessage(err));
}

async function runOpenAI(input: ProviderRunInput): Promise<ProviderRunResult> {
  if (!process.env.OPENAI_API_KEY) throw new ProviderError('OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.', 'auth');
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
  const state = new OpenAIStreamState(input.onDelta, input.onStatus);

  try {
    const stream = await client.responses.create(params, { signal: input.signal });
    for await (const event of stream) state.handle(event);
  } catch (err) {
    if (input.signal.aborted || err instanceof OpenAI.APIUserAbortError) throw abortError();
    throw toProviderError(OpenAI, err, Boolean(params.previous_response_id));
  }
  // The SDK may end the stream quietly instead of throwing when the request is aborted.
  if (input.signal.aborted) throw abortError();
  if (!state.completed) throw new Error('OpenAI API 응답이 완료되지 않았습니다.');
  if (!state.responseId) throw new Error('OpenAI API가 response id를 알려주지 않았습니다.');
  return { text: state.text, resume: { previousResponseId: state.responseId } };
}

export const openaiApiProvider: Provider = {
  id: 'openai-api',
  label: 'OpenAI API (API 키)',
  kind: 'api',
  get models(): ModelOption[] {
    return modelOptions();
  },
  get defaultModel(): string {
    return defaultModel();
  },
  maxImagesPerConversation: 150,
  async detect(): Promise<ProviderAvailability> {
    return process.env.OPENAI_API_KEY
      ? { available: true }
      : { available: false, reason: 'OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.' };
  },
  run: runOpenAI,
};
