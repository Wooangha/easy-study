// Sessions of the current document + the streaming turns (prime / question) running in them.
//
// Persisted state (session.messages) is only updated when a turn finishes (`done`). While a turn is
// running, its user message and the growing assistant text live in a mutable "live turn" object and
// are overlaid on top of the persisted messages at render time. This keeps streaming cheap (only the
// live message re-renders) and survives switching away from / back to a session mid-turn.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChatMessage, Session, SessionSummary, StreamEvent } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { readStorage, storageKeys, writeStorage, isString } from '../lib/storage.ts';
import { toast } from '../lib/toast.ts';
import { useLatest } from './useLatest.ts';
import type { ProviderChoice } from './useProviderChoice.ts';

export type TurnKind = 'question' | 'prime';

/** How a turn ended. 'rejected' = refused before it started (validation, 409, network) — nothing saved. */
export type TurnOutcome = 'complete' | 'error' | 'aborted' | 'rejected' | 'disconnected';

export interface LiveTurn {
  /** Unique per turn (increments). */
  seq: number;
  key: string;
  docId: string;
  sessionId: string;
  kind: TurnKind;
  slide: number;
  question: string;
  /** 'pending' until the server's `start` event arrives. */
  phase: 'pending' | 'streaming';
  userMessage: ChatMessage | null;
  assistantMessage: ChatMessage | null;
  /** Accumulated assistant text. */
  text: string;
  /** Latest transient status line. */
  status: string | null;
  stopRequested: boolean;
  controller: AbortController;
}

/** Synthetic ids used for the optimistic messages shown before the server's `start` event. */
export const PENDING_USER_ID = 'pending-user';
export const PENDING_ASSISTANT_ID = 'pending-assistant';

/** When the user presses stop, give the server this long to finish the turn cleanly before cutting the stream. */
const STOP_GRACE_MS = 4000;
/** Re-render throttle for streamed deltas. */
const RENDER_THROTTLE_MS = 50;

const turnKey = (docId: string, sid: string) => `${docId}/${sid}`;
let turnSeq = 0;

function mergeMessages(base: ChatMessage[], add: ChatMessage[]): ChatMessage[] {
  const ids = new Set(add.map((m) => m.id));
  return [...base.filter((m) => !ids.has(m.id)), ...add];
}

function upsertSummary(list: SessionSummary[], s: SessionSummary): SessionSummary[] {
  const i = list.findIndex((x) => x.id === s.id);
  if (i === -1) return [s, ...list];
  const next = list.slice();
  next[i] = s;
  return next;
}

function toSummary(s: Session | SessionSummary): SessionSummary {
  if (!('messages' in s)) return s;
  const { messages: _messages, ...summary } = s;
  return summary;
}

/**
 * The persisted messages when the server sent the whole session in `done` (it does so when it changed
 * the turn's user message after `start`, e.g. its context after recovering from a lost conversation).
 */
function messagesOf(s: SessionSummary): ChatMessage[] | null {
  const messages = (s as Partial<Session>).messages;
  return Array.isArray(messages) ? messages : null;
}

/** Persisted messages + the live turn (optimistic or streaming) of the same session. */
function overlayLiveTurn(base: ChatMessage[], turn: LiveTurn | null): ChatMessage[] {
  if (!turn) return base;
  if (turn.phase === 'pending' || !turn.userMessage || !turn.assistantMessage) {
    const now = new Date().toISOString();
    const common = { slide: turn.slide, kind: turn.kind, createdAt: now, status: 'streaming' as const };
    return [
      ...base,
      { ...common, id: PENDING_USER_ID, role: 'user', text: turn.question },
      { ...common, id: PENDING_ASSISTANT_ID, role: 'assistant', text: '' },
    ];
  }
  return mergeMessages(base, [
    turn.userMessage,
    { ...turn.assistantMessage, text: turn.text, status: 'streaming' },
  ]);
}

interface Options {
  /** Ready document currently shown (null = none). */
  docId: string | null;
  /** Provider/model for new sessions (null = no provider available). */
  choice: ProviderChoice | null;
  /** Neighbor slides (±N) fed with every turn; read when a turn starts. */
  neighbors: number;
  /** Called after every finished turn (notes need refreshing). */
  onTurnFinished?: (docId: string) => void;
  /** Called when a session was created (the server may have started the document's digest). */
  onSessionCreated?: (docId: string) => void;
}

export function useStudySession({ docId, choice, neighbors, onTurnFinished, onSessionCreated }: Options) {
  // All three are tagged with the doc they belong to, so switching docs never shows stale data.
  const [sessionsState, setSessionsState] = useState<{ docId: string; list: SessionSummary[] } | null>(null);
  const [selection, setSelection] = useState<{ docId: string; sessionId: string } | null>(null);
  const [rawSession, setRawSession] = useState<Session | null>(null);
  /** A multi-step flow (create session → prime → ask) is in progress for this doc. */
  const [flow, setFlow] = useState<{ docId: string; creating: boolean } | null>(null);

  const turnsRef = useRef(new Map<string, LiveTurn>());
  /** Seq of the most recently started turn per session; kept after the turn ends (see scrollKey). */
  const lastTurnSeqRef = useRef(new Map<string, number>());
  const [version, rerender] = useReducer((x: number) => x + 1, 0);
  const renderTimer = useRef<number | null>(null);
  const scheduleRender = useCallback(() => {
    if (renderTimer.current !== null) return;
    renderTimer.current = window.setTimeout(() => {
      renderTimer.current = null;
      rerender();
    }, RENDER_THROTTLE_MS);
  }, []);

  const docIdRef = useLatest(docId);
  const choiceRef = useLatest(choice);
  const neighborsRef = useLatest(neighbors);
  const onTurnFinishedRef = useLatest(onTurnFinished);
  const onSessionCreatedRef = useLatest(onSessionCreated);
  /** Session just created by us (no need to GET it again). */
  const preloadedRef = useRef<string | null>(null);

  const sessions = sessionsState && sessionsState.docId === docId ? sessionsState.list : null;
  const sessionId = selection && selection.docId === docId ? selection.sessionId : null;
  const session =
    rawSession && rawSession.docId === docId && rawSession.id === sessionId ? rawSession : null;

  const refreshSessions = useCallback(
    async (forDoc: string) => {
      try {
        const list = await api.listSessions(forDoc);
        // Only one list is kept (the open document's). A turn of another document that finishes in the
        // background must not replace it; the docId effect reloads the list when the user returns.
        if (docIdRef.current !== forDoc) return;
        setSessionsState({ docId: forDoc, list });
      } catch {
        /* keep the previous list */
      }
    },
    [docIdRef],
  );

  // Load the session list when the document changes and pick the last used (or newest) session.
  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    api
      .listSessions(docId)
      .then((list) => {
        if (cancelled) return;
        // Keep sessions created while the list was loading (the response may predate them).
        setSessionsState((prev) => ({
          docId,
          list:
            prev?.docId === docId ? [...prev.list.filter((s) => !list.some((x) => x.id === s.id)), ...list] : list,
        }));
        setSelection((prev) => {
          // A selection already made for this doc (e.g. a session created meanwhile) wins.
          if (prev?.docId === docId) return prev;
          const saved = readStorage<string | null>(storageKeys.session(docId), null, isString);
          const pick = list.find((s) => s.id === saved)?.id ?? list[0]?.id;
          return pick ? { docId, sessionId: pick } : null;
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSessionsState({ docId, list: [] });
        toast(`세션 목록을 불러오지 못했어요: ${api.errorMessage(e)}`, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // Load the full session whenever the selection changes.
  useEffect(() => {
    if (!docId || !sessionId) return;
    writeStorage(storageKeys.session(docId), sessionId);
    const key = turnKey(docId, sessionId);
    if (preloadedRef.current === key) {
      preloadedRef.current = null;
      return;
    }
    let cancelled = false;
    api
      .getSession(docId, sessionId)
      .then((s) => {
        if (!cancelled) setRawSession(s);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast(`세션을 불러오지 못했어요: ${api.errorMessage(e)}`, 'error');
        if (e instanceof api.ApiError && e.status === 404) {
          setSelection(null);
          void refreshSessions(docId);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [docId, sessionId, refreshSessions]);

  /** Reload a finished session from the server (the saved messages are authoritative). */
  const reloadSession = useCallback(async (forDoc: string, sid: string) => {
    try {
      const s = await api.getSession(forDoc, sid);
      setRawSession((prev) => (prev && prev.docId === forDoc && prev.id === sid ? s : prev));
    } catch {
      /* keep what we have */
    }
  }, []);

  /** Reload a session after a stream ended without `done` (the server saves the aborted turn shortly after). */
  const resync = useCallback(async (forDoc: string, sid: string) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => window.setTimeout(r, attempt === 0 ? 300 : 700));
      try {
        const s = await api.getSession(forDoc, sid);
        setRawSession((prev) => (prev && prev.docId === forDoc && prev.id === sid ? s : prev));
        if (!s.messages.some((m) => m.status === 'streaming')) return;
      } catch {
        return;
      }
    }
  }, []);

  /** Run one streaming turn. Registers the live turn synchronously (before the first await). */
  const runTurn = useCallback(
    async (forDoc: string, sid: string, kind: TurnKind, question: string, slide: number): Promise<TurnOutcome> => {
      const key = turnKey(forDoc, sid);
      if (turnsRef.current.has(key)) {
        toast('이미 답변을 생성하고 있어요. 끝난 뒤에 다시 시도해 주세요.', 'error');
        return 'rejected';
      }
      const turn: LiveTurn = {
        seq: ++turnSeq,
        key,
        docId: forDoc,
        sessionId: sid,
        kind,
        slide,
        question,
        phase: 'pending',
        userMessage: null,
        assistantMessage: null,
        text: '',
        status: null,
        stopRequested: false,
        controller: new AbortController(),
      };
      turnsRef.current.set(key, turn);
      lastTurnSeqRef.current.set(key, turn.seq);
      rerender();

      let outcome: TurnOutcome = 'disconnected';
      let finished = false; // `done` or `error` received
      let gotDone = false;
      /** `done` came without the saved messages: reload them (the user message may have changed). */
      let reloadAfterDone = false;

      const onEvent = (ev: StreamEvent) => {
        switch (ev.type) {
          case 'start':
            turn.phase = 'streaming';
            turn.userMessage = ev.userMessage;
            turn.assistantMessage = ev.assistantMessage;
            turn.text = ev.assistantMessage.text ?? '';
            rerender();
            break;
          case 'delta':
            turn.text += ev.text;
            scheduleRender();
            break;
          case 'status':
            turn.status = ev.text;
            scheduleRender();
            break;
          case 'done': {
            finished = true;
            gotDone = true;
            const final = ev.assistantMessage;
            outcome = final.status === 'complete' ? 'complete' : final.status === 'aborted' ? 'aborted' : 'error';
            const summary = toSummary(ev.session);
            const saved = messagesOf(ev.session);
            const add = turn.userMessage ? [turn.userMessage, final] : [final];
            // With the saved messages, the user message's final context (e.g. `recoveredFrom` after the
            // server retried in a new conversation) replaces the one announced by `start`.
            reloadAfterDone = saved === null;
            setRawSession((prev) =>
              prev && prev.docId === forDoc && prev.id === sid
                ? { ...prev, ...summary, messages: saved ?? mergeMessages(prev.messages, add) }
                : prev,
            );
            setSessionsState((prev) =>
              prev && prev.docId === forDoc ? { docId: forDoc, list: upsertSummary(prev.list, summary) } : prev,
            );
            break;
          }
          case 'error':
            // Before `start` nothing was saved; after it, the server persisted the turn as failed.
            finished = true;
            outcome = turn.userMessage ? 'error' : 'rejected';
            toast(ev.message, 'error');
            break;
        }
      };

      const neighborCount = neighborsRef.current;
      try {
        if (kind === 'prime') {
          await api.primeSession(forDoc, sid, { slide, neighbors: neighborCount }, onEvent, turn.controller.signal);
        } else {
          await api.sendMessage(
            forDoc,
            sid,
            { text: question, slide, neighbors: neighborCount },
            onEvent,
            turn.controller.signal,
          );
        }
        if (!finished) toast('서버와의 연결이 끊겼어요. 대화를 다시 불러올게요.', 'error');
      } catch (e) {
        if (api.isAbortError(e)) {
          if (!finished) outcome = 'aborted';
        } else if (!finished && !turn.userMessage) {
          outcome = 'rejected';
          toast(api.errorMessage(e), 'error');
        } else if (!finished) {
          toast(`연결이 끊겼어요: ${api.errorMessage(e)}`, 'error');
        }
      } finally {
        turnsRef.current.delete(key);
        rerender();
      }

      // Without `done` the final messages never reached us: reload what the server saved.
      if (!gotDone && outcome !== 'rejected') await resync(forDoc, sid);
      else if (reloadAfterDone) void reloadSession(forDoc, sid);
      void refreshSessions(forDoc);
      onTurnFinishedRef.current?.(forDoc);
      return outcome;
    },
    [scheduleRender, resync, reloadSession, refreshSessions, neighborsRef, onTurnFinishedRef],
  );

  /** Create a session with the chosen provider, select it and prime it. */
  const createAndPrime = useCallback(
    async (forDoc: string, slide: number): Promise<{ sid: string; outcome: TurnOutcome } | null> => {
      const c = choiceRef.current;
      if (!c) {
        toast('사용할 수 있는 LLM이 없어요. 상단의 모델 선택을 확인해 주세요.', 'error');
        return null;
      }
      let created: Session;
      try {
        created = await api.createSession(forDoc, { provider: c.provider, model: c.model || undefined });
      } catch (e) {
        toast(`세션을 만들지 못했어요: ${api.errorMessage(e)}`, 'error');
        return null;
      }
      onSessionCreatedRef.current?.(forDoc);
      // Show it only while its document is still open: if the user switched documents meanwhile, the
      // open document's list and session must stay (they see the new session when they come back).
      if (docIdRef.current === forDoc) {
        setSessionsState((prev) => ({
          docId: forDoc,
          list: upsertSummary(prev?.docId === forDoc ? prev.list : [], toSummary(created)),
        }));
        setRawSession(created);
        preloadedRef.current = turnKey(forDoc, created.id); // already have it: skip the GET
        setSelection({ docId: forDoc, sessionId: created.id });
      }
      setFlow((f) => (f && f.docId === forDoc ? { ...f, creating: false } : f));
      const outcome = await runTurn(forDoc, created.id, 'prime', '', slide);
      return { sid: created.id, outcome };
    },
    [choiceRef, docIdRef, runTurn, onSessionCreatedRef],
  );

  const flowActive = flow !== null && flow.docId === docId;
  const endFlow = useCallback((forDoc: string) => setFlow((f) => (f?.docId === forDoc ? null : f)), []);

  /** "＋ 새 세션": create + prime immediately. */
  const newSession = useCallback(
    async (slide: number) => {
      if (!docId || flowActive) return;
      const forDoc = docId;
      setFlow({ docId: forDoc, creating: true });
      try {
        await createAndPrime(forDoc, slide);
      } finally {
        endFlow(forDoc);
      }
    },
    [docId, flowActive, createAndPrime, endFlow],
  );

  /**
   * Ask a question about `slide`. Without a session, one is created and primed first.
   * Resolves false when the question was not accepted (the composer then restores the text).
   */
  const ask = useCallback(
    async (text: string, slide: number): Promise<boolean> => {
      if (!docId || flowActive) return false;
      const forDoc = docId;
      if (sessionId) return (await runTurn(forDoc, sessionId, 'question', text, slide)) !== 'rejected';

      setFlow({ docId: forDoc, creating: true });
      try {
        const started = await createAndPrime(forDoc, slide);
        if (!started) return false;
        if (started.outcome !== 'complete') {
          if (started.outcome !== 'aborted') {
            toast('슬라이드를 LLM에게 전달하지 못해서 질문을 보내지 않았어요. 다시 시도해 주세요.', 'error');
          }
          return false;
        }
        const pending = runTurn(forDoc, started.sid, 'question', text, slide);
        endFlow(forDoc); // the question's live turn now keeps the composer busy
        return (await pending) !== 'rejected';
      } finally {
        endFlow(forDoc);
      }
    },
    [docId, sessionId, flowActive, runTurn, createAndPrime, endFlow],
  );

  /** Prime the current session (e.g. when an earlier priming failed). */
  const primeCurrent = useCallback(
    async (slide: number) => {
      if (!docId || !sessionId) return;
      await runTurn(docId, sessionId, 'prime', '', slide);
    },
    [docId, sessionId, runTurn],
  );

  const liveTurn = docId && sessionId ? (turnsRef.current.get(turnKey(docId, sessionId)) ?? null) : null;

  /** Stop: ask the server to abort (saves the partial answer), then cut the stream if it lingers. */
  const stop = useCallback(() => {
    const turn = liveTurn;
    if (!turn || turn.stopRequested) return;
    turn.stopRequested = true;
    rerender();
    api.abortTurn(turn.docId, turn.sessionId).catch(() => {
      /* the stream abort below still stops it */
    });
    if (turn.phase === 'pending') {
      // The server may not have registered the turn yet; disconnecting aborts it for sure.
      turn.controller.abort();
      return;
    }
    window.setTimeout(() => {
      if (turnsRef.current.get(turn.key) === turn) turn.controller.abort();
    }, STOP_GRACE_MS);
  }, [liveTurn]);

  const selectSession = useCallback(
    (sid: string | null) => {
      if (!docId) return;
      setSelection(sid ? { docId, sessionId: sid } : null);
    },
    [docId],
  );

  const deleteSession = useCallback(
    async (sid: string) => {
      if (!docId) return;
      if (turnsRef.current.has(turnKey(docId, sid))) {
        toast('답변이 생성되는 중에는 세션을 삭제할 수 없어요.', 'error');
        return;
      }
      const forDoc = docId;
      try {
        await api.deleteSession(forDoc, sid);
      } catch (e) {
        toast(`세션을 삭제하지 못했어요: ${api.errorMessage(e)}`, 'error');
        return;
      }
      // Without a loaded list (still loading), ask the server rather than assume there are no others.
      let list = sessions;
      if (!list) list = await api.listSessions(forDoc).catch(() => null);
      if (sessionId === sid) writeStorage(storageKeys.session(forDoc), null);
      if (docIdRef.current === forDoc) {
        const remaining = (list ?? []).filter((s) => s.id !== sid);
        if (list) setSessionsState({ docId: forDoc, list: remaining });
        if (sessionId === sid) setSelection(remaining[0] ? { docId: forDoc, sessionId: remaining[0].id } : null);
      }
      toast('세션을 삭제했어요.', 'success');
      onTurnFinishedRef.current?.(forDoc); // notes changed
    },
    [docId, docIdRef, sessionId, sessions, onTurnFinishedRef],
  );

  // Changes only when the chat should jump to the bottom: another session is shown, or a turn starts in
  // it. Unlike liveTurn.seq it does not change when the turn ends, so a student who scrolled up to read
  // the answer while it streamed keeps the position.
  const lastSeq = docId && sessionId ? lastTurnSeqRef.current.get(turnKey(docId, sessionId)) : undefined;
  const scrollKey = `${docId ?? ''}/${sessionId ?? ''}:${lastSeq ?? ''}`;

  const messages = useMemo(
    () => overlayLiveTurn(session?.messages ?? [], liveTurn),
    // `version` bumps whenever the (mutable) live turn changes.
    [session, liveTurn, version],
  );

  return {
    sessions,
    sessionId,
    /** Full session (null while loading or when none is selected). */
    session,
    /** Persisted messages with the live turn overlaid. */
    messages,
    liveTurn,
    /** Status line of the live turn. */
    liveStatus: liveTurn?.status ?? null,
    /** Changes when the message list should jump to the bottom (session switch, turn started). */
    scrollKey,
    /** A turn (or the create → prime → ask flow) is running for the current session. */
    running: liveTurn !== null || flowActive,
    /** Creating a new session (before priming starts). */
    creating: flowActive && flow !== null && flow.creating,
    stopping: liveTurn?.stopRequested ?? false,
    /** Any turn running anywhere (used for the beforeunload warning). */
    anyRunning: turnsRef.current.size > 0 || flow !== null,
    selectSession,
    newSession,
    ask,
    stop,
    primeCurrent,
    deleteSession,
    refreshSessions,
  };
}

export type StudySession = ReturnType<typeof useStudySession>;
