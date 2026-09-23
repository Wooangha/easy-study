// openai-api provider: OpenAI Responses API with an API key (DESIGN §6).
//
// The conversation lives on OpenAI's side (store: true); each turn continues it with
// previous_response_id and only sends the new user turn. `instructions` are not carried over
// between responses, so the system prompt is sent every turn. OPENAI_BASE_URL is honoured by the SDK.
import OpenAI from 'openai';
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
  ProviderRunInput,
  ProviderRunResult,
  ResumeHandle,
} from './types.ts';
import { abortError, errorMessage, loadImageBase64 } from './proc.ts';

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
}

async function toContent(parts: Part[]): Promise<ResponseInputContent[]> {
  const content: ResponseInputContent[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) content.push({ type: 'input_text', text: part.text });
    } else {
      const image = await loadImageBase64(part.path);
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
    store: true,
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
      case 'response.failed':
        throw new Error(`OpenAI API 오류: ${event.response.error?.message ?? '응답 생성에 실패했습니다.'}`);
      case 'error':
        throw new Error(`OpenAI API 오류: ${event.message}`);
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

function toProviderError(err: unknown): Error {
  if (err instanceof OpenAI.AuthenticationError) {
    return new Error('OpenAI API 인증에 실패했습니다. OPENAI_API_KEY를 확인하세요.');
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new Error(`OpenAI API: 모델 또는 이전 응답을 찾을 수 없습니다 (${err.message})`);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new Error(`OpenAI API 요청 한도를 초과했습니다: ${err.message}`);
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new Error(`OpenAI API 요청 오류: ${err.message}`);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new Error(`OpenAI API에 연결할 수 없습니다: ${err.message}`);
  }
  if (err instanceof OpenAI.APIError) {
    return new Error(`OpenAI API 오류${err.status ? ` (${err.status})` : ''}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(errorMessage(err));
}

async function runOpenAI(input: ProviderRunInput): Promise<ProviderRunResult> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.');
  if (input.signal.aborted) throw abortError();

  const params = await buildOpenAIRequest({
    systemPrompt: input.systemPrompt,
    parts: input.parts,
    resume: input.resume,
    model: input.model,
  });
  const client = new OpenAI({ maxRetries: 2 });
  const state = new OpenAIStreamState(input.onDelta, input.onStatus);

  try {
    const stream = await client.responses.create(params, { signal: input.signal });
    for await (const event of stream) state.handle(event);
  } catch (err) {
    if (input.signal.aborted || err instanceof OpenAI.APIUserAbortError) throw abortError();
    throw toProviderError(err);
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
