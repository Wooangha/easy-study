// anthropic-api provider: Claude through the Messages API with an API key (DESIGN §6).
//
// Stateless: every turn resends the current provider conversation (`history`) plus this turn's
// parts, with images inlined as base64. Two prompt-cache breakpoints keep that cheap: one at the end
// of the first (priming) user turn — the deck — and one at the end of the current turn.
// ANTHROPIC_BASE_URL is honoured by the SDK itself.
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ModelOption } from '../../shared/types.ts';
import type {
  HistoryTurn,
  Part,
  Provider,
  ProviderAvailability,
  ProviderRunInput,
  ProviderRunResult,
} from './types.ts';
import { abortError, errorMessage, loadImageBase64 } from './proc.ts';

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
      const image = await loadImageBase64(part.path);
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

/** Turns stream events into onDelta/onStatus calls and assembles the final text. */
export class AnthropicStreamState {
  /** Text of the model that produced the final answer (reset when a fallback model takes over). */
  text = '';
  private lastIndex: number | null = null;
  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;

  constructor(onDelta: (text: string) => void, onStatus: (text: string) => void) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
  }

  handle(event: BetaRawMessageStreamEvent): void {
    if (event.type === 'content_block_start') {
      const type = event.content_block.type;
      if (type === 'thinking' || type === 'redacted_thinking') {
        this.onStatus('생각하는 중…');
      } else if (type === 'fallback') {
        // The requested model declined mid-answer and another model restarts the answer. The
        // partial text stays visible in the live view, but only the new answer is kept.
        this.onStatus('다른 모델이 이어서 답변하는 중…');
        if (this.text) this.onDelta('\n\n---\n\n');
        this.text = '';
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

function toProviderError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic API 인증에 실패했습니다. ANTHROPIC_API_KEY를 확인하세요.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error(`Anthropic API 권한 오류: ${err.message}`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new Error(`Anthropic API: 모델 또는 경로를 찾을 수 없습니다 (${err.message})`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic API 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new Error(`Anthropic API 요청 오류: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error(`Anthropic API에 연결할 수 없습니다: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API 오류${err.status ? ` (${err.status})` : ''}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(errorMessage(err));
}

async function runAnthropic(input: ProviderRunInput): Promise<ProviderRunResult> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.');
  if (input.signal.aborted) throw abortError();

  const params = await buildAnthropicRequest({
    systemPrompt: input.systemPrompt,
    parts: input.parts,
    history: input.history,
    model: input.model,
  });
  const client = new Anthropic({ maxRetries: 2 });
  const state = new AnthropicStreamState(input.onDelta, input.onStatus);

  try {
    const stream = client.beta.messages.stream(params, { signal: input.signal });
    for await (const event of stream) state.handle(event);
    if (input.signal.aborted) throw abortError();
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      const category = final.stop_details?.category;
      throw new Error(`모델이 이 요청에 대한 답변을 거절했습니다${category ? ` (${category})` : ''}. 질문을 바꿔 다시 시도해 보세요.`);
    }
  } catch (err) {
    if (input.signal.aborted || err instanceof Anthropic.APIUserAbortError) throw abortError();
    throw toProviderError(err);
  }
  return { text: state.text, resume: {} };
}

export const anthropicApiProvider: Provider = {
  id: 'anthropic-api',
  label: 'Claude API (API 키)',
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
    return process.env.ANTHROPIC_API_KEY
      ? { available: true }
      : { available: false, reason: 'ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.' };
  },
  run: runAnthropic,
};
