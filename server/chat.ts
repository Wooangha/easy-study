// Turn orchestration (DESIGN §5 "Turn orchestration").
//
// One turn = validate → buildTurn() → persist the user message + a streaming assistant placeholder
// (emit `start`) → provider.run() streaming `delta`/`status` → persist the outcome, regenerate the
// notes (emit `done`). At most one turn runs per session; it can be aborted at any time.
//
// Errors thrown *before* `start` is emitted are HttpErrors (the HTTP layer answers them with a JSON
// error instead of opening the SSE stream). After `start`, provider failures never throw: they end
// the turn with an assistant message in status 'error' / 'aborted'.
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ProviderId, SessionSummary, StreamEvent } from '../shared/types.ts';
import { HttpError } from './config.ts';
import { appendHistory, buildTurn, defaultContextSettings } from './context.ts';
import type { BuildTurnInput, BuildTurnOutput, ContextSettings, ProviderState, SessionRecord } from './internal-types.ts';
import { loadDocAssets } from './library.ts';
import { getProvider, providerInfos } from './providers/index.ts';
import type { Part, Provider } from './providers/types.ts';
import { getSession, repairInterruptedMessages, saveSession, toSummary, writeNotes } from './sessions.ts';

const MAX_QUESTION_CHARS = 20_000;
/** Neighbor slides fed before/after the focused one are clamped to 0..MAX_NEIGHBORS (DESIGN §10). */
export const MAX_NEIGHBORS = 3;
const FALLBACK_NEIGHBORS = 1;

/** Stateless providers get the conversation history re-sent every turn (see appendHistory). */
const STATELESS_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['anthropic-api']);

export interface ProviderCheck {
  available: boolean;
  reason?: string;
}

/** Collaborators of the orchestrator; injectable so tests can use fakes. */
export interface ChatDeps {
  getProvider: (id: ProviderId) => Provider | undefined;
  /** Availability of a provider (should be cached: it runs on every turn). */
  checkProvider: (id: ProviderId) => Promise<ProviderCheck>;
  buildTurn: (input: BuildTurnInput) => BuildTurnOutput;
  appendHistory: (state: ProviderState, parts: Part[], answer: string) => ProviderState;
  contextSettings: () => ContextSettings;
}

/** The real modules: provider registry (availability cached 60 s) and the context builder. */
export function defaultChatDeps(): ChatDeps {
  return {
    getProvider,
    checkProvider: async (id) => {
      const info = (await providerInfos()).find((candidate) => candidate.id === id);
      return info ? { available: info.available, reason: info.reason } : { available: false, reason: 'unknown provider' };
    },
    buildTurn,
    appendHistory,
    contextSettings: () => defaultContextSettings(),
  };
}

export interface TurnRequest {
  docId: string;
  sessionId: string;
  kind: 'question' | 'prime';
  /** The question (ignored for kind === 'prime'). */
  text: string;
  /** 1-based focused slide. */
  slide: number;
  /**
   * Slides before and after the focused one to feed as well (clamped to 0..3).
   * Omitted = ContextSettings.neighborWindow.
   */
  neighbors?: number;
  /** Receives start / delta / status / done. Exceptions thrown by the listener are ignored. */
  onEvent: (event: StreamEvent) => void;
  /** External cancellation, e.g. the HTTP client disconnected. */
  signal?: AbortSignal;
}

export interface TurnResult {
  assistantMessage: ChatMessage;
  session: SessionSummary;
}

interface RunningTurn {
  controller: AbortController;
  finished: Promise<void>;
}

const runningTurns = new Map<string, RunningTurn>();

function turnKey(docId: string, sessionId: string): string {
  return `${docId}/${sessionId}`;
}

/** Aborts the running turn of a session. Returns false when none is running. */
export function abortTurn(docId: string, sessionId: string): boolean {
  const turn = runningTurns.get(turnKey(docId, sessionId));
  if (!turn) return false;
  turn.controller.abort(new Error('사용자가 답변 생성을 중단했습니다'));
  return true;
}

/** Aborts every running turn (server shutdown). Returns how many were aborted. */
export function abortAllTurns(): number {
  for (const turn of runningTurns.values()) turn.controller.abort(new Error('서버가 종료되어 중단되었습니다'));
  return runningTurns.size;
}

export function isTurnRunning(docId: string, sessionId: string): boolean {
  return runningTurns.has(turnKey(docId, sessionId));
}

function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Resolves true once the session's turn (if any) has fully finished, false on timeout. */
export function waitForTurn(docId: string, sessionId: string, timeoutMs: number): Promise<boolean> {
  const turn = runningTurns.get(turnKey(docId, sessionId));
  return turn ? withTimeout(turn.finished, timeoutMs) : Promise.resolve(true);
}

/** Resolves true once no turn is running, false on timeout. */
export function waitForIdle(timeoutMs: number): Promise<boolean> {
  return withTimeout(Promise.all([...runningTurns.values()].map((turn) => turn.finished)), timeoutMs);
}

/**
 * Runs one turn. Rejects with HttpError (404 / 400 / 409) when the turn cannot start; in that
 * case no event has been emitted and nothing was persisted.
 */
export async function runTurn(request: TurnRequest, deps: ChatDeps = defaultChatDeps()): Promise<TurnResult> {
  const key = turnKey(request.docId, request.sessionId);
  // Check-and-reserve without an await in between, so concurrent requests cannot both pass.
  if (runningTurns.has(key)) throw new HttpError(409, '이 세션은 이미 답변을 생성하고 있습니다');
  const controller = new AbortController();
  let markFinished = () => {};
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  runningTurns.set(key, { controller, finished });

  const forwardAbort = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) forwardAbort();
  else request.signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    return await executeTurn(request, deps, controller.signal);
  } finally {
    request.signal?.removeEventListener('abort', forwardAbort);
    runningTurns.delete(key);
    markFinished();
  }
}

/** The neighbor window of a turn: the request's value, else the settings default, clamped to 0..3. */
export function resolveNeighbors(requested: number | undefined, settings: Pick<ContextSettings, 'neighborWindow'>): number {
  const clamp = (value: number) => Math.min(MAX_NEIGHBORS, Math.max(0, Math.trunc(value)));
  if (typeof requested === 'number' && Number.isFinite(requested)) return clamp(requested);
  const fallback = settings.neighborWindow;
  return typeof fallback === 'number' && Number.isFinite(fallback) ? clamp(fallback) : FALLBACK_NEIGHBORS;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** Human readable reason stored on aborted assistant messages. */
function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name !== 'AbortError' && reason.message) return reason.message;
  return '답변 생성이 중단되었습니다';
}

async function executeTurn(request: TurnRequest, deps: ChatDeps, signal: AbortSignal): Promise<TurnResult> {
  const { docId, sessionId, kind } = request;
  let listenerFailed = false;
  const emit = (event: StreamEvent) => {
    try {
      request.onEvent(event);
    } catch (err) {
      // A broken listener must not break the turn; report it once.
      if (!listenerFailed) console.error('[chat] event listener failed:', err);
      listenerFailed = true;
    }
  };

  // 1. Validate ------------------------------------------------------------------------------
  const session = await getSession(docId, sessionId);
  if (!session) throw new HttpError(404, '세션을 찾을 수 없습니다');
  const doc = await loadDocAssets(docId);
  const provider = deps.getProvider(session.provider);
  if (!provider) throw new HttpError(400, `알 수 없는 제공자입니다: ${session.provider}`);
  const check = await deps.checkProvider(session.provider);
  if (!check.available) {
    throw new HttpError(400, `${provider.label}을(를) 사용할 수 없습니다${check.reason ? `: ${check.reason}` : ''}`);
  }
  const pageCount = doc.meta.pageCount;
  const slide = request.slide;
  if (!Number.isInteger(slide) || slide < 1 || slide > pageCount) {
    throw new HttpError(400, `슬라이드 번호가 올바르지 않습니다 (1–${pageCount})`);
  }
  const question = kind === 'question' ? request.text.trim() : '';
  if (kind === 'question' && !question) throw new HttpError(400, '질문을 입력해 주세요');
  if (question.length > MAX_QUESTION_CHARS) {
    throw new HttpError(400, `질문이 너무 깁니다 (최대 ${MAX_QUESTION_CHARS.toLocaleString('en-US')}자)`);
  }
  if (signal.aborted) throw new HttpError(400, abortReason(signal));

  // 2. Build the turn and persist the new messages ------------------------------------------
  // We hold the session's turn lock, so any 'streaming' message is a leftover of a crash.
  repairInterruptedMessages(session);
  const settings = deps.contextSettings();
  const built = deps.buildTurn({
    doc,
    session,
    kind,
    question,
    slide,
    neighbors: resolveNeighbors(request.neighbors, settings),
    settings,
    maxImagesPerConversation: provider.maxImagesPerConversation,
  });

  const createdAt = new Date().toISOString();
  const userMessage: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    text: question,
    slide,
    kind,
    createdAt,
    status: 'complete',
    context: built.context,
  };
  const assistantMessage: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    text: '',
    slide,
    kind,
    createdAt,
    status: 'streaming',
    provider: session.provider,
    model: session.model,
  };
  session.messages.push(userMessage, assistantMessage);
  await saveSession(session);
  emit({ type: 'start', userMessage: structuredClone(userMessage), assistantMessage: structuredClone(assistantMessage) });

  // 3. Run the provider ------------------------------------------------------------------------
  let streamed = '';
  let settled = false; // ignore callbacks that arrive after run() settled
  const startedAt = Date.now();
  try {
    const result = await provider.run({
      cwd: doc.dir,
      systemPrompt: built.systemPrompt,
      parts: built.parts,
      resume: built.resume,
      history: built.history,
      model: session.model,
      // Other lectures of the course, so agentic CLIs can open their DIGEST.md / slides.
      extraReadDirs: built.readDirs,
      signal,
      onDelta: (text) => {
        if (settled || !text) return;
        streamed += text;
        emit({ type: 'delta', text });
      },
      onStatus: (text) => {
        if (!settled && text) emit({ type: 'status', text });
      },
    });
    settled = true;
    // 4a. Success: advance the provider conversation.
    const answer = result.text.trim() ? result.text : streamed;
    assistantMessage.text = answer;
    assistantMessage.status = 'complete';
    let nextState: ProviderState = { ...built.nextState, resume: result.resume ?? {} };
    if (STATELESS_PROVIDERS.has(session.provider)) nextState = deps.appendHistory(nextState, built.parts, answer);
    session.providerState = nextState;
  } catch (err) {
    settled = true;
    // 4b. Failure / abort: keep the partial text; the provider state is NOT advanced, so a
    // failed priming turn is simply re-primed next time.
    assistantMessage.text = streamed;
    if (signal.aborted) {
      assistantMessage.status = 'aborted';
      assistantMessage.error = abortReason(signal);
    } else {
      assistantMessage.status = 'error';
      assistantMessage.error = errorText(err);
    }
  }
  assistantMessage.durationMs = Date.now() - startedAt;

  // 5. Persist, regenerate notes, finish --------------------------------------------------------
  await persistOutcome(session);
  emit({ type: 'done', assistantMessage: structuredClone(assistantMessage), session: toSummary(session) });
  return { assistantMessage, session: toSummary(session) };
}

/** Saves the finished turn unless the session was deleted meanwhile. Never throws. */
async function persistOutcome(session: SessionRecord): Promise<void> {
  try {
    if ((await getSession(session.docId, session.id)) === null) return;
    await saveSession(session);
  } catch (err) {
    console.error(`[chat] could not save session ${session.id}:`, err);
    return;
  }
  try {
    await writeNotes(session.docId);
  } catch (err) {
    console.error(`[chat] could not regenerate notes of ${session.docId}:`, err);
  }
}
