// Turn orchestration (DESIGN §5 "Turn orchestration").
//
// One turn = validate → buildTurn() → persist the user message + a streaming assistant placeholder
// (emit `start`) → provider.run() streaming `delta`/`status` → persist the outcome, regenerate the
// notes (emit `done`). At most one turn runs per session; it can be aborted at any time.
//
// Errors thrown *before* `start` is emitted are HttpErrors (the HTTP layer answers them with a JSON
// error instead of opening the SSE stream). After `start`, provider failures never throw: they end
// the turn with an assistant message in status 'error' / 'aborted'.
//
// Attachments (DESIGN §21): a question may refer to attachments created beforehand (selected slide regions,
// images of the student). They are resolved and pinned (so no cleanup takes them away) for the whole turn, fed
// after the focus window, and stored as Attachment[] on the user message.
//
// Slide annotations (DESIGN §25): a question also carries the student's memos on the slides of the focus window
// ("학생의 메모", ChatDeps.studentMemos, unless the request says `memos: false`); a region attachment made from a
// 필기 keeps its snapshot (Attachment.annotation) for the label and the note's text. Once the turn's final save is
// done, sessions.ts listeners are told (the question markers of other devices refresh).
//
// Recovery (DESIGN §14): when the provider lost the conversation ('resume_invalid': expired CLI
// session, unknown thread or previous_response_id) or it became too large ('context_overflow'), the
// turn is rebuilt as a new conversation (re-prime + recap) and retried once within the same request.
//
// A new version of a lecture's deck (DESIGN §28): while the deck is swapped, reserveDocTurns keeps every turn (and LLM
// switch) of the lecture off, so no turn's final save can undo the sessions' remap.
//
// Token usage (DESIGN §23): what the provider reports (ProviderRunInput.onUsage / onLimits) is streamed as `usage`
// events — the turn's running total over all its attempts — stored on the assistant message and added to the
// session's totals (a priming turn to its priming cost too), whether the turn succeeds, fails or is aborted.
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ProviderId, Session, StreamEvent, TokenUsage, UsageLimits } from '../shared/types.ts';
import { addSessionUsage, addUsage, totalTokens } from '../shared/usage.ts';
import { memosForTutor } from './annotations.ts';
import { holdAttachments } from './attachments.ts';
import type { HeldAttachments } from './attachments.ts';
import { acquireCliSlot } from './cliBudget.ts';
import type { AcquireCliSlot } from './cliBudget.ts';
import { HttpError } from './config.ts';
import { appendHistory, buildTurn, defaultContextSettings } from './context.ts';
import { slang, smsg } from './i18n.ts';
import type { Lang } from './i18n.ts';
import type { BuildTurnInput, BuildTurnOutput, ContextSettings, DocAssets, ProviderState, SessionRecord, StudentMemo } from './internal-types.ts';
import { checkDeckRev, loadDocAssets } from './library.ts';
import { attachmentLabel } from './prompts.ts';
import { getProvider, providerInfos } from './providers/index.ts';
import { lectureSpeechFor } from './recordings/speech.ts';
import { providerErrorKind } from './providers/types.ts';
import type { Part, Provider, ProviderRunResult } from './providers/types.ts';
import { getSession, notifySessionsChanged, repairInterruptedMessages, saveSession, toSession, writeNotes } from './sessions.ts';

const MAX_QUESTION_CHARS = 20_000;
/** Neighbor slides fed before/after the focused one are clamped to 0..MAX_NEIGHBORS (DESIGN §10). */
export const MAX_NEIGHBORS = 3;
const FALLBACK_NEIGHBORS = 1;

/** Stateless providers get the conversation history re-sent every turn (see appendHistory). */
const STATELESS_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['anthropic-api']);

/** Provider failures that a new provider conversation can fix (BuildTurnInput.forceNewConversation). */
type RecoverableKind = NonNullable<BuildTurnInput['forceNewConversation']>;

/**
 * Sent once the waiting turn got its slot: an empty status line clears the waiting status (chat.turns.waitingForSlot;
 * the client keeps the latest status and hides an empty one), so the turn looks like one that never waited.
 */
const SLOT_GRANTED_STATUS = '';

/** Status line shown while a turn is retried in a new provider conversation. */
function recoveryStatus(kind: RecoverableKind): string {
  const m = smsg().chat.turns.recovery;
  return kind === 'resume_invalid' ? m.resumeInvalid : m.contextOverflow;
}

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
  /**
   * The server-wide budget of LLM CLI processes (DESIGN §15): CLI providers run only with a slot.
   * Omitted = no limit.
   */
  cliSlot?: AcquireCliSlot;
  /**
   * What the professor said on the slides of the focus window, and the recent speech while a live recording of the
   * document runs (DESIGN §22). Omitted or undefined = the document has no transcribed recording.
   */
  lectureSpeech?: (
    docId: string,
    slide: number,
    windowSlides: number[],
    options?: { fresh?: boolean; signal?: AbortSignal },
  ) => Promise<BuildTurnInput['lectureSpeech']>;
  /**
   * The student's memos on the slides of the focus window (DESIGN §25 "학생의 메모"), for question turns unless the
   * request says `memos: false`; `slide` is the focused one (its memos come first when the cap bites). Omitted = no
   * memos are ever given.
   */
  studentMemos?: (docId: string, windowSlides: number[], slide: number) => Promise<StudentMemo[]>;
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
    cliSlot: acquireCliSlot,
    lectureSpeech: lectureSpeechFor,
    studentMemos: memosForTutor,
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
   * The DocMeta.deckRev `slide` belongs to (the request's DECK_REV_HEADER, DESIGN §28): another deck than the lecture's
   * → HttpError 409 deckChanged before anything is persisted. Omitted = not checked.
   */
  deckRev?: number;
  /**
   * Slides before and after the focused one to feed as well (clamped to 0..3).
   * Omitted = ContextSettings.neighborWindow.
   */
  neighbors?: number;
  /**
   * Ids of attachments of this document (SendMessageRequest.attachments; at most MAX_ATTACHMENTS, duplicates
   * dropped). Ignored for kind === 'prime'. Unknown ids → HttpError 400.
   */
  attachments?: string[];
  /**
   * Whether the student's memos on the focus window go to the tutor (SendMessageRequest.memos, DESIGN §25). Omitted
   * = true. Ignored for kind === 'prime'.
   */
  memos?: boolean;
  /** Receives start / delta / status / done. Exceptions thrown by the listener are ignored. */
  onEvent: (event: StreamEvent) => void;
  /** External cancellation, e.g. the HTTP client disconnected. */
  signal?: AbortSignal;
}

export interface TurnResult {
  assistantMessage: ChatMessage;
  /** The session after the turn, with its messages (the user message may carry a replaced context). */
  session: Session;
}

interface RunningTurn {
  controller: AbortController;
  finished: Promise<void>;
  /** The language of the request that started it: a shutdown stops it with a reason in that language. */
  lang: Lang;
}

const runningTurns = new Map<string, RunningTurn>();
/** Lectures whose deck is being swapped (reserveDocTurns): their turns and LLM switches answer 409. */
const reservedDocs = new Set<string>();

function turnKey(docId: string, sessionId: string): string {
  return `${docId}/${sessionId}`;
}

/** Aborts the running turn of a session. Returns false when none is running. */
export function abortTurn(docId: string, sessionId: string): boolean {
  const turn = runningTurns.get(turnKey(docId, sessionId));
  if (!turn) return false;
  turn.controller.abort(new Error(smsg().chat.turns.abortedByUser));
  return true;
}

/** Aborts every running turn (server shutdown). Returns how many were aborted. */
export function abortAllTurns(): number {
  for (const turn of runningTurns.values()) turn.controller.abort(new Error(smsg(turn.lang).chat.turns.abortedByShutdown));
  return runningTurns.size;
}

export function isTurnRunning(docId: string, sessionId: string): boolean {
  return runningTurns.has(turnKey(docId, sessionId));
}

/** True while a turn of any session of the document is running. */
export function hasRunningTurns(docId: string): boolean {
  const prefix = turnKey(docId, '');
  for (const key of runningTurns.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/** Turns running right now, across all documents (the desktop app's busy check, DESIGN §24). */
export function runningTurnCount(): number {
  return runningTurns.size;
}

/**
 * Keeps the lecture's turns off while its deck is swapped for a new version (DESIGN §28). Synchronous, so the caller
 * can check its other gates in the same tick: throws HttpError 409 when a turn of the lecture is running (or one of its
 * sessions' LLM is being changed) or the lecture is already reserved. Until the returned function is called (it may be
 * called more than once), new turns, prime turns and LLM switches of the lecture answer 409.
 */
export function reserveDocTurns(docId: string): () => void {
  if (reservedDocs.has(docId)) throw new HttpError(409, smsg().library.versions.swapping);
  if (hasRunningTurns(docId)) throw new HttpError(409, smsg().library.versions.busyAnswering);
  reservedDocs.add(docId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedDocs.delete(docId);
  };
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
 * Runs `fn` with the session reserved like a running turn, for a change of the session that must not race with a
 * turn (whose final save would undo it): the LLM switch (DESIGN §5). A turn asked for meanwhile gets 409, and this
 * rejects with HttpError 409 while a turn of the session is running or the lecture's deck is swapped (reserveDocTurns).
 */
export async function withSessionReserved<T>(docId: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
  const key = turnKey(docId, sessionId);
  if (reservedDocs.has(docId)) throw new HttpError(409, smsg().library.versions.swapping);
  if (runningTurns.has(key)) throw new HttpError(409, smsg().chat.turns.busy);
  let markFinished = () => {};
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  runningTurns.set(key, { controller: new AbortController(), finished, lang: slang() });
  try {
    return await fn();
  } finally {
    runningTurns.delete(key);
    markFinished();
  }
}

/**
 * Runs one turn. Rejects with HttpError (404 / 400 / 409) when the turn cannot start (409 also while the lecture's deck
 * is swapped, reserveDocTurns); in that case no event has been emitted and nothing was persisted.
 */
export async function runTurn(request: TurnRequest, deps: ChatDeps = defaultChatDeps()): Promise<TurnResult> {
  const key = turnKey(request.docId, request.sessionId);
  // Check-and-reserve without an await in between, so concurrent requests (and a deck swap) cannot both pass.
  if (reservedDocs.has(request.docId)) throw new HttpError(409, smsg().library.versions.swapping);
  if (runningTurns.has(key)) throw new HttpError(409, smsg().chat.turns.alreadyAnswering);
  const controller = new AbortController();
  let markFinished = () => {};
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  runningTurns.set(key, { controller, finished, lang: slang() });

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
  return smsg().chat.turns.aborted;
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
  const m = smsg();
  if (!session) throw new HttpError(404, m.common.notFound.session);
  const doc = await loadDocAssets(docId);
  // Read after the turn was registered: a swap cannot begin from here on (reserveDocTurns), so the number stays valid.
  checkDeckRev(doc.meta, request.deckRev);
  const provider = deps.getProvider(session.provider);
  if (!provider) throw new HttpError(400, m.chat.providers.unknownProvider(session.provider));
  const check = await deps.checkProvider(session.provider);
  if (!check.available) throw new HttpError(400, m.chat.providers.unavailable(provider.label, check.reason ?? ''));
  const pageCount = doc.meta.pageCount;
  const slide = request.slide;
  if (!Number.isInteger(slide) || slide < 1 || slide > pageCount) throw new HttpError(400, m.common.slideOutOfRange(pageCount));
  const question = kind === 'question' ? request.text.trim() : '';
  if (kind === 'question' && !question) throw new HttpError(400, m.chat.turns.questionRequired);
  if (question.length > MAX_QUESTION_CHARS) {
    throw new HttpError(400, m.chat.turns.questionTooLong(MAX_QUESTION_CHARS.toLocaleString('en-US')));
  }
  // Resolved and pinned until the turn has ended (HttpError 400 for unknown ids or more than MAX_ATTACHMENTS:
  // nothing was persisted). Priming turns take none.
  const attachmentIds = kind === 'question' && Array.isArray(request.attachments) ? request.attachments : [];
  const held = await holdAttachments(docId, attachmentIds);
  try {
    return await startTurn({ request, deps, signal, session, doc, provider, slide, question, held, emit });
  } finally {
    held.release();
  }
}

interface ValidatedTurn {
  request: TurnRequest;
  deps: ChatDeps;
  signal: AbortSignal;
  session: SessionRecord;
  doc: DocAssets;
  provider: Provider;
  slide: number;
  question: string;
  held: HeldAttachments;
  emit: (event: StreamEvent) => void;
}

/** Steps 2-5 of a validated turn. */
async function startTurn(validated: ValidatedTurn): Promise<TurnResult> {
  const { request, deps, signal, session, doc, provider, slide, question, held, emit } = validated;
  const { docId, sessionId, kind } = request;
  if (signal.aborted) throw new HttpError(400, abortReason(signal));

  // 2. Build the turn and persist the new messages ------------------------------------------
  // We hold the session's turn lock, so any 'streaming' message is a leftover of a crash.
  repairInterruptedMessages(session);
  const settings = deps.contextSettings();
  const turnInput: BuildTurnInput = {
    doc,
    session,
    kind,
    question,
    slide,
    neighbors: resolveNeighbors(request.neighbors, settings),
    settings,
    maxImagesPerConversation: provider.maxImagesPerConversation,
  };
  // The focus window as the context builder will see it (the same slides the speech and the memos are read for).
  const windowSlides: number[] = [];
  for (let s = Math.max(1, slide - turnInput.neighbors); s <= Math.min(doc.meta.pageCount, slide + turnInput.neighbors); s++) windowSlides.push(s);
  if (deps.lectureSpeech) {
    // Never fails the turn: without the speech the tutor still has the slides.
    try {
      // A question during a live recording waits a few seconds for the speech right before it (DESIGN §22).
      const speech = await deps.lectureSpeech(docId, slide, windowSlides, { fresh: kind === 'question', signal });
      if (speech) turnInput.lectureSpeech = speech;
    } catch (err) {
      console.warn(`[chat] lecture speech of ${docId} unavailable: ${errorText(err)}`);
    }
  }
  // The student's memos of the window (DESIGN §25): questions only, unless the request turned them off. Never
  // fails the turn either.
  if (kind === 'question' && request.memos !== false && deps.studentMemos) {
    try {
      const memos = await deps.studentMemos(docId, windowSlides, slide);
      if (Array.isArray(memos) && memos.length > 0) turnInput.studentMemos = memos;
    } catch (err) {
      console.warn(`[chat] memos of ${docId} unavailable: ${errorText(err)}`);
    }
  }
  if (held.items.length > 0) {
    turnInput.attachments = held.items.map(({ attachment, path }, i) => ({
      kind: attachment.kind,
      path,
      label: attachmentLabel(i + 1, attachment),
      ...(attachment.kind === 'region' ? { text: attachment.text ?? '' } : {}),
      // A region made from a 필기 (DESIGN §25): its kind and text reach the context builder.
      ...(attachment.annotation
        ? { annotation: attachment.annotation.text ? { type: attachment.annotation.type, text: attachment.annotation.text } : { type: attachment.annotation.type } }
        : {}),
    }));
  }
  let built = deps.buildTurn(turnInput);
  // BuildTurnInput.session is the session *before* this turn (a retry must not recap the new question).
  const messagesBefore = session.messages.slice();

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
  if (held.items.length > 0) userMessage.attachments = held.items.map(({ attachment }) => structuredClone(attachment));
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
  if (session.effort) assistantMessage.effort = session.effort;
  // The startup sweep marks this answer in the turn's language if the server stops before it ends.
  session.lang = slang();
  session.messages.push(userMessage, assistantMessage);
  await saveSession(session);
  emit({ type: 'start', userMessage: structuredClone(userMessage), assistantMessage: structuredClone(assistantMessage) });

  // Tokens of the finished attempts, of the running one (its latest report) and the latest limits.
  let attemptsUsage: TokenUsage | undefined;
  let attemptUsage: TokenUsage | undefined;
  let limits: UsageLimits | undefined;
  const turnUsage = () => {
    const usage = addUsage(attemptsUsage, attemptUsage);
    return usage && totalTokens(usage) > 0 ? usage : undefined;
  };
  const emitUsage = () => {
    const usage = turnUsage();
    emit({ type: 'usage', ...(usage ? { usage } : {}), ...(limits ? { limits } : {}) });
  };

  // 3. Run the provider (retried once in a new conversation when the old one is lost / too large) --
  const runAttempt = async (turn: BuildTurnOutput): Promise<Attempt> => {
    let streamed = '';
    let settled = false; // ignore callbacks that arrive after run() settled
    let releaseSlot: (() => void) | null = null;
    attemptUsage = undefined;
    try {
      if (provider.kind === 'cli' && deps.cliSlot) {
        let waited = false;
        releaseSlot = await deps.cliSlot('chat', signal, () => {
          waited = true;
          emit({ type: 'status', text: smsg().chat.turns.waitingForSlot });
        });
        if (waited) emit({ type: 'status', text: SLOT_GRANTED_STATUS });
      }
      const result = await provider.run({
        cwd: doc.dir,
        systemPrompt: turn.systemPrompt,
        parts: turn.parts,
        resume: turn.resume,
        history: turn.history,
        model: session.model,
        effort: session.effort ?? '',
        // Other lectures of the course, so agentic CLIs can open their DIGEST.md / slides.
        extraReadDirs: turn.readDirs,
        signal,
        onDelta: (text) => {
          if (settled || !text) return;
          streamed += text;
          emit({ type: 'delta', text });
        },
        onStatus: (text) => {
          if (!settled && text) emit({ type: 'status', text });
        },
        onUsage: (usage) => {
          if (settled) return;
          attemptUsage = usage;
          emitUsage();
        },
        onLimits: (reported) => {
          if (settled) return;
          limits = reported;
          emitUsage();
        },
      });
      settled = true;
      return { ok: true, result, streamed };
    } catch (error) {
      settled = true;
      return { ok: false, error, streamed };
    } finally {
      releaseSlot?.();
      attemptsUsage = addUsage(attemptsUsage, attemptUsage);
      attemptUsage = undefined;
    }
  };

  const startedAt = Date.now();
  let attempt = await runAttempt(built);
  const recovery = attempt.ok ? null : recoveryKind(attempt, built, signal);
  if (!attempt.ok && recovery !== null) {
    console.warn(`[chat] ${docId}/${sessionId}: ${recovery}, retrying in a new provider conversation: ${errorText(attempt.error)}`);
    let retry: BuildTurnOutput | null = null;
    try {
      retry = deps.buildTurn({ ...turnInput, session: { ...session, messages: messagesBefore }, forceNewConversation: recovery });
    } catch (err) {
      // Never leave the turn half done: it simply fails with the provider's error.
      console.error(`[chat] could not rebuild the turn of ${sessionId}:`, err);
    }
    if (retry !== null) {
      emit({ type: 'status', text: recoveryStatus(recovery) });
      built = retry;
      // The user message describes what the model was actually given: the retry's context.
      userMessage.context = { ...built.context, recoveredFrom: recovery };
      await saveSession(session).catch((err: unknown) => console.error(`[chat] could not save session ${sessionId}:`, err));
      attempt = await runAttempt(built);
    }
  }

  if (attempt.ok) {
    // 4a. Success: advance the provider conversation.
    const { result } = attempt;
    const answer = result.text.trim() ? result.text : attempt.streamed;
    assistantMessage.text = answer;
    assistantMessage.status = 'complete';
    let nextState: ProviderState = { ...built.nextState, resume: result.resume ?? {} };
    if (STATELESS_PROVIDERS.has(session.provider)) nextState = deps.appendHistory(nextState, built.parts, answer);
    session.providerState = nextState;
  } else {
    // 4b. Failure / abort: keep the partial text; the provider state is NOT advanced, so a
    // failed priming turn is simply re-primed next time.
    assistantMessage.text = attempt.streamed;
    if (signal.aborted) {
      assistantMessage.status = 'aborted';
      assistantMessage.error = abortReason(signal);
    } else {
      assistantMessage.status = 'error';
      assistantMessage.error = errorText(attempt.error);
    }
  }
  assistantMessage.durationMs = Date.now() - startedAt;
  const usage = turnUsage();
  if (usage) assistantMessage.usage = usage;
  session.usage = addSessionUsage(session.usage, usage, kind === 'prime');
  if (limits) session.limits = limits;

  // 5. Persist, regenerate notes, finish --------------------------------------------------------
  // `done` carries the whole session (a Session is a SessionSummary plus its messages) so the client
  // also gets the final user message, whose context a recovery may have replaced.
  const saved = await persistOutcome(session);
  emit({ type: 'done', assistantMessage: structuredClone(assistantMessage), session: structuredClone(toSession(session)) });
  // Once per turn, after its final save (DESIGN §25): other devices refresh their question markers.
  if (saved) notifySessionsChanged({ docId, sessionId, updatedAt: session.updatedAt });
  return { assistantMessage, session: toSession(session) };
}

type Attempt =
  | { ok: true; result: ProviderRunResult; streamed: string }
  | { ok: false; error: unknown; streamed: string };

/**
 * Whether a failed attempt is retried in a new provider conversation (DESIGN §14), and why. Only when
 * the provider says the conversation is gone or too large, the attempt continued an existing
 * conversation (a new one would be rebuilt identically), nothing was shown to the student yet (streamed
 * text cannot be taken back) and the turn was not aborted.
 */
function recoveryKind(attempt: Extract<Attempt, { ok: false }>, turn: BuildTurnOutput, signal: AbortSignal): RecoverableKind | null {
  if (signal.aborted || turn.resume === null || attempt.streamed !== '') return null;
  const kind = providerErrorKind(attempt.error);
  return kind === 'resume_invalid' || kind === 'context_overflow' ? kind : null;
}

/** Saves the finished turn unless the session was deleted meanwhile (false then). Never throws. */
async function persistOutcome(session: SessionRecord): Promise<boolean> {
  try {
    if ((await getSession(session.docId, session.id)) === null) return false;
    await saveSession(session);
  } catch (err) {
    console.error(`[chat] could not save session ${session.id}:`, err);
    return false;
  }
  try {
    await writeNotes(session.docId);
  } catch (err) {
    console.error(`[chat] could not regenerate notes of ${session.docId}:`, err);
  }
  return true;
}
