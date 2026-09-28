// Turn orchestration (server/chat.ts) with fake providers, and an in-process HTTP smoke test of
// server/index.ts. No real CLI or API is ever called.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Attachment, ChatMessage, DocMeta, NotesResponse, ProviderId, ProviderInfo, Session, StreamEvent } from '../shared/types.ts';
import { isAttachmentPinned } from '../server/attachments.ts';
import { abortTurn, defaultChatDeps, isTurnRunning, resolveNeighbors, runTurn } from '../server/chat.ts';
import type { ChatDeps, TurnRequest } from '../server/chat.ts';
import { createCliBudget } from '../server/cliBudget.ts';
import { HttpError, repoRoot } from '../server/config.ts';
import { initialProviderState } from '../server/context.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import { createCourse, updateCourse } from '../server/courses.ts';
import type { BuildTurnInput, BuildTurnOutput, ProviderState } from '../server/internal-types.ts';
import { docPaths, slideFileName, textFileName } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import { ProviderError } from '../server/providers/types.ts';
import type { Part, Provider, ProviderRunInput, ProviderRunResult } from '../server/providers/types.ts';
import { createSession, getSession, saveSession } from '../server/sessions.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-chat-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  // Digest jobs are covered by digest.test.ts; here they would only add provider calls.
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGES = 9;

/** A ready 9-slide document with extracted texts and sheets.json (images are never opened). */
async function makeReadyDoc(docId: string, status: DocMeta['status'] = 'ready', title = 'Fake Deck'): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.textDir, { recursive: true });
  await fs.mkdir(paths.sheetsDir, { recursive: true });
  await fs.mkdir(paths.slidesDir, { recursive: true });
  const meta: StoredDocMeta = {
    id: docId,
    title,
    fileName: 'Fake Deck.pdf',
    pageCount: PAGES,
    aspectRatio: 16 / 9,
    status,
    progress: status === 'ready' ? PAGES : 0,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
  for (let n = 1; n <= PAGES; n++) {
    await fs.writeFile(path.join(paths.textDir, textFileName(n, PAGES)), `Slide ${n} text`);
  }
  await fs.writeFile(
    paths.sheetsJson,
    JSON.stringify([
      { file: 'sheet-01.png', fromSlide: 1, toSlide: 4 },
      { file: 'sheet-02.png', fromSlide: 5, toSlide: 8 },
      { file: 'sheet-03.png', fromSlide: 9, toSlide: 9 },
    ]),
  );
}

type Script = (input: ProviderRunInput, call: number) => Promise<ProviderRunResult>;

interface FakeProvider extends Provider {
  calls: ProviderRunInput[];
  script: Script;
}

function fakeProvider(id: ProviderId, script: Script): FakeProvider {
  const provider: FakeProvider = {
    id,
    label: `Fake ${id}`,
    kind: 'cli',
    models: [{ id: '', label: 'default' }],
    defaultModel: '',
    maxImagesPerConversation: 90,
    calls: [],
    script,
    detect: async () => ({ available: true }),
    run: async (input) => {
      provider.calls.push(input);
      return provider.script(input, provider.calls.length);
    },
  };
  return provider;
}

/** Streams the answer in two chunks with a status line in between. */
const streamingAnswer =
  (answer: (call: number) => string): Script =>
  async (input, call) => {
    const text = answer(call);
    const half = Math.ceil(text.length / 2);
    input.onDelta(text.slice(0, half));
    input.onStatus('slides/003.png 읽는 중');
    input.onDelta(text.slice(half));
    return { text, resume: { cliSessionId: `cli-${call}` } };
  };

function abortError(): Error {
  const err = new Error('요청이 중단되었습니다.');
  err.name = 'AbortError';
  return err;
}

/** Streams a partial answer, then waits until aborted. */
const hangUntilAborted: Script = (input) => {
  input.onDelta('partial ');
  return new Promise((_resolve, reject) => {
    if (input.signal.aborted) reject(abortError());
    input.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
};

function depsFor(provider: FakeProvider, overrides: Partial<ChatDeps> = {}): ChatDeps & { appendCalls: number } {
  const base = defaultChatDeps();
  const deps = {
    ...base,
    appendCalls: 0,
    getProvider: (id: ProviderId) => (id === provider.id ? provider : undefined),
    checkProvider: async () => ({ available: true }),
    appendHistory: (state: ProviderState, parts: Part[], answer: string) => {
      deps.appendCalls++;
      return base.appendHistory(state, parts, answer);
    },
    ...overrides,
  };
  return deps;
}

async function turn(
  deps: ChatDeps,
  args: Omit<TurnRequest, 'onEvent' | 'text'> & { text?: string },
): Promise<{ events: StreamEvent[]; assistant: ChatMessage }> {
  const events: StreamEvent[] = [];
  const result = await runTurn({ text: '', ...args, onEvent: (event) => events.push(event) }, deps);
  return { events, assistant: result.assistantMessage };
}

function textOf(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe('runTurn', () => {
  const DOC = 'fake-deck-aaa111';
  before(() => makeReadyDoc(DOC));

  test('prime then questions: events, persistence, provider state, notes', async () => {
    const provider = fakeProvider('claude-code', streamingAnswer((call) => `answer ${call}`));
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: 'sonnet' });

    // Prime (feeds the deck). No `neighbors` in the request: the default window (±1) applies.
    const prime = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 2 });
    assert.deepEqual(
      prime.events.map((e) => e.type),
      ['start', 'delta', 'status', 'delta', 'done'],
    );
    const start = prime.events[0] as Extract<StreamEvent, { type: 'start' }>;
    assert.equal(start.userMessage.kind, 'prime');
    assert.equal(start.userMessage.role, 'user');
    assert.equal(start.userMessage.slide, 2);
    assert.deepEqual(start.userMessage.context, {
      primed: true,
      rollover: false,
      attachedSlides: [1, 2, 3],
      reusedSlides: [],
      overviewImages: 3,
    });
    assert.equal(start.assistantMessage.status, 'streaming');
    assert.equal(start.assistantMessage.text, '');
    assert.equal(start.assistantMessage.provider, 'claude-code');
    assert.equal(start.assistantMessage.model, 'sonnet');

    const done = prime.events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.assistantMessage.status, 'complete');
    assert.equal(done.assistantMessage.text, 'answer 1');
    assert.equal(typeof done.assistantMessage.durationMs, 'number');
    assert.equal(done.session.primed, true);
    assert.equal(done.session.messageCount, 2);

    const firstCall = provider.calls[0];
    assert.equal(firstCall.resume, null);
    assert.equal(firstCall.cwd, docPaths(DOC).dir);
    assert.equal(firstCall.model, 'sonnet');
    assert.ok(firstCall.systemPrompt.length > 0);
    assert.equal(firstCall.parts.filter((p) => p.type === 'image').length, 6); // 3 sheets + slides 1–3
    assert.deepEqual(firstCall.extraReadDirs, [], 'not in a course: no other lecture dirs');

    let stored = await getSession(DOC, session.id);
    assert.ok(stored);
    assert.equal(stored.providerState.primed, true);
    assert.deepEqual(stored.providerState.resume, { cliSessionId: 'cli-1' });
    assert.equal(stored.providerState.generation, 1);
    assert.deepEqual(stored.providerState.recentSlides, [2, 1, 3]);
    assert.deepEqual(
      stored.messages.map((m) => [m.role, m.kind, m.status]),
      [
        ['user', 'prime', 'complete'],
        ['assistant', 'prime', 'complete'],
      ],
    );

    // Question about the same slide: continues the conversation, image not re-sent.
    const again = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: '  왜 그런가요?  ', slide: 2 });
    const againStart = again.events[0] as Extract<StreamEvent, { type: 'start' }>;
    assert.equal(againStart.userMessage.text, '왜 그런가요?');
    assert.deepEqual(againStart.userMessage.context?.reusedSlides, [1, 2, 3]);
    assert.deepEqual(provider.calls[1].resume, { cliSessionId: 'cli-1' });
    assert.equal(provider.calls[1].parts.filter((p) => p.type === 'image').length, 0);
    assert.match(textOf(provider.calls[1].parts), /왜 그런가요\?/);

    // Question about another slide: its window (slides 4–6) is attached.
    const other = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'slide 5?', slide: 5 });
    assert.equal(other.assistant.status, 'complete');
    const otherImages = provider.calls[2].parts.filter((p) => p.type === 'image');
    assert.deepEqual(
      otherImages.map((p) => p.type === 'image' && p.path),
      [4, 5, 6].map((n) => path.join(docPaths(DOC).slidesDir, slideFileName(n, PAGES))),
    );

    stored = await getSession(DOC, session.id);
    assert.equal(stored?.messages.length, 6);
    assert.deepEqual(stored?.providerState.resume, { cliSessionId: 'cli-3' });
    assert.equal(deps.appendCalls, 0, 'appendHistory is only for anthropic-api');

    // Notes were regenerated after the turn (prime excluded).
    const notes = await fs.readFile(docPaths(DOC).studyNotes, 'utf8');
    assert.match(notes, /### Q\. 왜 그런가요\?/);
    assert.match(notes, /## Slide 5/);
    assert.ok(!notes.includes('answer 1'));
    await fs.access(path.join(docPaths(DOC).notesDir, `${session.id}.md`));
  });

  test('CLI turns take a slot of the process budget: digests never hold them back, other chat turns do', async () => {
    const budget = createCliBudget(() => 1);
    const provider = fakeProvider('claude-code', streamingAnswer((call) => `slot answer ${call}`));
    const deps = depsFor(provider, { cliSlot: budget.acquire });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const free = () => new AbortController().signal;

    // A digest batch holds the only slot: the chat turn starts anyway (DESIGN §15).
    const digestSlot = await budget.acquire('digest', free());
    const first = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    assert.deepEqual(
      first.events.map((e) => e.type),
      ['start', 'delta', 'status', 'delta', 'done'],
    );
    digestSlot();

    // Another chat turn holds it: this one says that it waits, and runs once the slot is free.
    const otherChat = await budget.acquire('chat', free());
    const events: StreamEvent[] = [];
    const pending = runTurn(
      { docId: DOC, sessionId: session.id, kind: 'question', text: 'wait?', slide: 1, onEvent: (e) => events.push(e) },
      deps,
    );
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events[1], { type: 'status', text: '다른 답변이 끝나기를 기다리는 중…' });
    assert.equal(provider.calls.length, 1, 'the provider is not started while waiting');
    otherChat();
    const result = await pending;
    assert.equal(result.assistantMessage.status, 'complete');
    assert.equal(result.assistantMessage.text, 'slot answer 2');
    // Once the slot is granted the waiting line is cleared (an empty status), before the answer streams:
    // the client keeps the latest status, so it would otherwise stay under the growing answer.
    assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'status', 'status', 'delta', 'status', 'delta', 'done'],
    );
    assert.deepEqual(events[2], { type: 'status', text: '' });
    assert.deepEqual(budget.usage(), { chat: 0, digest: 0, waitingChat: 0, waitingDigest: 0 });

    // API providers start no process: no slot.
    const api = fakeProvider('anthropic-api', streamingAnswer(() => 'api'));
    api.kind = 'api';
    const apiSession = await createSession(DOC, { provider: 'anthropic-api', model: '' });
    const held = await budget.acquire('chat', free());
    const apiTurn = await turn(depsFor(api, { cliSlot: budget.acquire }), { docId: DOC, sessionId: apiSession.id, kind: 'prime', slide: 1 });
    assert.equal(apiTurn.assistant.status, 'complete');
    held();
  });

  test('aborting a turn that waits for a CLI slot ends it as aborted without starting the provider', async () => {
    const budget = createCliBudget(() => 1);
    const provider = fakeProvider('claude-code', streamingAnswer(() => 'never'));
    const deps = depsFor(provider, { cliSlot: budget.acquire });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const held = await budget.acquire('chat', new AbortController().signal);
    const events: StreamEvent[] = [];
    const pending = runTurn(
      { docId: DOC, sessionId: session.id, kind: 'prime', text: '', slide: 1, onEvent: (e) => events.push(e) },
      deps,
    );
    await waitFor(() => events.some((e) => e.type === 'status'));
    assert.equal(abortTurn(DOC, session.id), true);
    const result = await pending;
    assert.equal(result.assistantMessage.status, 'aborted');
    assert.equal(provider.calls.length, 0);
    assert.equal(budget.usage().waitingChat, 0);
    held();
    assert.deepEqual(budget.usage(), { chat: 0, digest: 0, waitingChat: 0, waitingDigest: 0 });
  });

  test('anthropic-api keeps the history via appendHistory', async () => {
    const provider = fakeProvider('anthropic-api', streamingAnswer((call) => `api answer ${call}`));
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'anthropic-api', model: '' });

    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'q2', slide: 1 });
    assert.equal(deps.appendCalls, 2);
    assert.equal(provider.calls[1].history.length, 2, 'second turn receives the first exchange');
    const stored = await getSession(DOC, session.id);
    assert.equal(stored?.providerState.history.length, 4);
    const lastTurn = stored?.providerState.history.at(-1);
    assert.deepEqual(lastTurn, { role: 'assistant', parts: [{ type: 'text', text: 'api answer 2' }] });
  });

  test('provider error keeps partial text and does not advance the provider state', async () => {
    const provider = fakeProvider('claude-code', async (input) => {
      input.onDelta('partial ');
      throw new Error('claude exited with code 1: boom');
    });
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });

    const { events, assistant } = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'delta', 'done'],
    );
    assert.equal(assistant.status, 'error');
    assert.equal(assistant.error, 'claude exited with code 1: boom');
    assert.equal(assistant.text, 'partial ');
    assert.equal(typeof assistant.durationMs, 'number');

    const stored = await getSession(DOC, session.id);
    assert.deepEqual(stored?.providerState, initialProviderState());
    assert.equal(stored?.messages[1].status, 'error');
    assert.equal(stored?.messages[1].text, 'partial ');

    // The next turn primes again because the failed priming was not recorded.
    provider.script = streamingAnswer(() => 'ok');
    const retry = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'again', slide: 1 });
    const retryStart = retry.events[0] as Extract<StreamEvent, { type: 'start' }>;
    assert.equal(retryStart.userMessage.context?.primed, true);
    assert.equal(provider.calls[1].resume, null);
    assert.equal(retry.assistant.status, 'complete');
  });

  test('abortTurn stops a running turn; partial text is kept as aborted', async () => {
    const provider = fakeProvider('claude-code', hangUntilAborted);
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const before = structuredClone((await getSession(DOC, session.id))?.providerState);

    const events: StreamEvent[] = [];
    const running = runTurn(
      { docId: DOC, sessionId: session.id, kind: 'question', text: 'long question', slide: 3, onEvent: (e) => events.push(e) },
      deps,
    );
    await waitFor(() => events.some((e) => e.type === 'delta'));
    assert.equal(isTurnRunning(DOC, session.id), true);
    assert.equal(abortTurn(DOC, session.id), true);
    const { assistantMessage } = await running;

    assert.equal(assistantMessage.status, 'aborted');
    assert.equal(assistantMessage.text, 'partial ');
    assert.equal(assistantMessage.error, '사용자가 답변 생성을 중단했습니다');
    assert.equal(events.at(-1)?.type, 'done');
    assert.equal(isTurnRunning(DOC, session.id), false);
    assert.equal(abortTurn(DOC, session.id), false);

    const stored = await getSession(DOC, session.id);
    assert.equal(stored?.messages[1].status, 'aborted');
    assert.deepEqual(stored?.providerState, before);
  });

  test('an external signal (client disconnect) aborts the turn', async () => {
    const provider = fakeProvider('claude-code', hangUntilAborted);
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const disconnect = new AbortController();
    const events: StreamEvent[] = [];
    const running = runTurn(
      {
        docId: DOC,
        sessionId: session.id,
        kind: 'question',
        text: 'q',
        slide: 1,
        signal: disconnect.signal,
        onEvent: (e) => events.push(e),
      },
      deps,
    );
    await waitFor(() => events.some((e) => e.type === 'delta'));
    disconnect.abort(new Error('client went away'));
    const { assistantMessage } = await running;
    assert.equal(assistantMessage.status, 'aborted');
    assert.equal(assistantMessage.error, 'client went away');
  });

  test('a second turn on the same session gets 409 while one is running', async () => {
    let release = () => {};
    const provider = fakeProvider('claude-code', async (input) => {
      input.onDelta('working');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { text: 'finished', resume: { cliSessionId: 'x' } };
    });
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });

    const events: StreamEvent[] = [];
    const first = runTurn({ docId: DOC, sessionId: session.id, kind: 'prime', text: '', slide: 1, onEvent: (e) => events.push(e) }, deps);
    const secondEvents: StreamEvent[] = [];
    await assert.rejects(
      runTurn({ docId: DOC, sessionId: session.id, kind: 'question', text: 'hi', slide: 1, onEvent: (e) => secondEvents.push(e) }, deps),
      (err: unknown) => err instanceof HttpError && err.status === 409,
    );
    assert.deepEqual(secondEvents, []);

    // Another session is not blocked.
    const otherSession = await createSession(DOC, { provider: 'claude-code', model: '' });
    const otherProvider = fakeProvider('claude-code', streamingAnswer(() => 'other'));
    const other = await turn(depsFor(otherProvider), { docId: DOC, sessionId: otherSession.id, kind: 'prime', slide: 1 });
    assert.equal(other.assistant.status, 'complete');

    await waitFor(() => events.some((e) => e.type === 'delta'));
    release();
    assert.equal((await first).assistantMessage.text, 'finished');

    provider.script = streamingAnswer(() => 'next');
    const next = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'now?', slide: 1 });
    assert.equal(next.assistant.status, 'complete');
  });

  test('validation failures reject before start and release the session', async () => {
    const provider = fakeProvider('claude-code', streamingAnswer(() => 'fine'));
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const base = { docId: DOC, sessionId: session.id, kind: 'question' as const, text: 'q', slide: 1 };

    const cases: Array<[string, ChatDeps, Partial<TurnRequest>, number]> = [
      ['unknown session', deps, { sessionId: '20200101-000000-0000' }, 404],
      ['unknown doc', deps, { docId: 'nope-doc-000000' }, 404],
      ['slide 0', deps, { slide: 0 }, 400],
      ['slide past the end', deps, { slide: PAGES + 1 }, 400],
      ['fractional slide', deps, { slide: 1.5 }, 400],
      ['empty question', deps, { text: '   ' }, 400],
      ['unknown provider', { ...deps, getProvider: () => undefined }, {}, 400],
      ['unavailable provider', { ...deps, checkProvider: async () => ({ available: false, reason: 'not logged in' }) }, {}, 400],
    ];
    for (const [name, caseDeps, patch, status] of cases) {
      const events: StreamEvent[] = [];
      await assert.rejects(
        runTurn({ ...base, ...patch, onEvent: (e) => events.push(e) }, caseDeps),
        (err: unknown) => err instanceof HttpError && err.status === status,
        name,
      );
      assert.deepEqual(events, [], name);
    }
    assert.equal(provider.calls.length, 0);
    assert.equal((await getSession(DOC, session.id))?.messages.length, 0);

    // A document that is still processing cannot be studied yet.
    await makeReadyDoc('processing-doc-bbb222', 'processing');
    const pending = await createSession('processing-doc-bbb222', { provider: 'claude-code', model: '' });
    await assert.rejects(
      runTurn({ ...base, docId: 'processing-doc-bbb222', sessionId: pending.id, onEvent: () => {} }, deps),
      (err: unknown) => err instanceof HttpError && err.status === 409,
    );

    // The lock was released every time.
    const ok = await turn(deps, base);
    assert.equal(ok.assistant.status, 'complete');
  });

  test('leftover streaming messages are repaired and listener errors are ignored', async () => {
    const provider = fakeProvider('claude-code', streamingAnswer(() => 'fine'));
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const record = await getSession(DOC, session.id);
    assert.ok(record);
    record.messages.push(
      { id: 'u', role: 'user', text: 'old', slide: 1, kind: 'question', createdAt: new Date().toISOString(), status: 'complete' },
      { id: 'a', role: 'assistant', text: 'half', slide: 1, kind: 'question', createdAt: new Date().toISOString(), status: 'streaming' },
    );
    await saveSession(record);

    const result = await runTurn(
      {
        docId: DOC,
        sessionId: session.id,
        kind: 'question',
        text: 'new',
        slide: 1,
        onEvent: () => {
          throw new Error('listener exploded');
        },
      },
      deps,
    );
    assert.equal(result.assistantMessage.status, 'complete');
    const stored = await getSession(DOC, session.id);
    assert.equal(stored?.messages[1].status, 'aborted');
    assert.equal(stored?.messages.at(-1)?.status, 'complete');
  });

  test('resolveNeighbors: request value clamped to 0..3, else the settings default', () => {
    assert.equal(resolveNeighbors(2, { neighborWindow: 1 }), 2);
    assert.equal(resolveNeighbors(0, { neighborWindow: 1 }), 0);
    assert.equal(resolveNeighbors(7, { neighborWindow: 1 }), 3);
    assert.equal(resolveNeighbors(-2, { neighborWindow: 1 }), 0);
    assert.equal(resolveNeighbors(undefined, { neighborWindow: 2 }), 2);
    assert.equal(resolveNeighbors(undefined, { neighborWindow: 9 }), 3);
    assert.equal(resolveNeighbors(Number.NaN, { neighborWindow: 0 }), 0);
  });

  test('neighbors reach buildTurn (request value, clamped, or the settings default)', async () => {
    const provider = fakeProvider('claude-code', streamingAnswer(() => 'ok'));
    const seen: number[] = [];
    const base = depsFor(provider);
    const deps = depsFor(provider, {
      contextSettings: () => ({ ...base.contextSettings(), neighborWindow: 2 }),
      buildTurn: (input: BuildTurnInput) => {
        seen.push(input.neighbors);
        return base.buildTurn(input);
      },
    });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const ask = (neighbors: number | undefined, slide = 5) =>
      turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'q', slide, neighbors });

    const first = await ask(undefined);
    const start = first.events[0] as Extract<StreamEvent, { type: 'start' }>;
    assert.deepEqual(start.userMessage.context?.attachedSlides, [3, 4, 5, 6, 7], 'settings default ±2');
    await ask(0);
    await ask(9);
    await ask(-1);
    assert.deepEqual(seen, [2, 0, 3, 0]);
  });

  test('BuildTurnOutput.readDirs are handed to the provider as extraReadDirs', async () => {
    const provider = fakeProvider('claude-code', streamingAnswer(() => 'ok'));
    const base = depsFor(provider);
    const deps = depsFor(provider, {
      buildTurn: (input: BuildTurnInput) => ({ ...base.buildTurn(input), readDirs: ['/abs/library/lecture-6-aaaaaa'] }),
    });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    assert.deepEqual(provider.calls[0].extraReadDirs, ['/abs/library/lecture-6-aaaaaa']);
  });

  test('a lecture of a course can read the other lectures (real loadDocAssets + buildTurn)', async () => {
    await makeReadyDoc('lec-6-ccc333', 'ready', 'Lecture 6');
    await makeReadyDoc('lec-7-ddd444', 'ready', 'Lecture 7');
    const course = await createCourse('Compiler');
    await updateCourse(course.id, { docIds: ['lec-6-ccc333', 'lec-7-ddd444'] });

    const provider = fakeProvider('claude-code', streamingAnswer(() => 'ok'));
    const session = await createSession('lec-7-ddd444', { provider: 'claude-code', model: '' });
    await turn(depsFor(provider), { docId: 'lec-7-ddd444', sessionId: session.id, kind: 'prime', slide: 1 });
    assert.deepEqual(provider.calls[0].extraReadDirs, [docPaths('lec-6-ccc333').dir]);
    assert.match(textOf(provider.calls[0].parts), /Compiler/);
  });
});

// ---------------------------------------------------------------------------
// Recovery: a lost or overflowing provider conversation (DESIGN §14)
// ---------------------------------------------------------------------------

describe('runTurn with attachments (DESIGN §21)', () => {
  const DOC = 'attach-deck-fff666';
  const OTHER = 'attach-other-ggg777';
  before(async () => {
    await makeReadyDoc(DOC);
    await makeReadyDoc(OTHER);
  });

  /** Stores an attachment as the routes do (metadata + image file), without the image worker. */
  async function storeAttachment(docId: string, attachment: Attachment, ext: 'jpg' | 'png' = 'png'): Promise<string> {
    const dir = path.join(docPaths(docId).dir, 'attachments');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${attachment.id}.${ext}`), 'image bytes');
    await fs.writeFile(path.join(dir, `${attachment.id}.json`), JSON.stringify(attachment));
    return path.join(dir, `${attachment.id}.${ext}`);
  }
  const REGION: Attachment = {
    id: 'att-00000000000000a1',
    kind: 'region',
    slide: 4,
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    width: 500,
    height: 300,
    text: 'x = y + 1',
    createdAt: '2026-09-26T00:00:00.000Z',
  };
  const IMAGE: Attachment = { id: 'att-00000000000000b2', kind: 'image', name: 'note.jpg', width: 80, height: 60, createdAt: '2026-09-26T00:00:00.000Z' };

  test('resolved in order into BuildTurnInput.attachments; the user message stores the Attachment[]', async () => {
    const regionPath = await storeAttachment(DOC, REGION);
    const imagePath = await storeAttachment(DOC, IMAGE, 'jpg');
    const provider = fakeProvider('claude-code', streamingAnswer(() => 'ok'));
    const seen: BuildTurnInput[] = [];
    const base = defaultChatDeps();
    const deps = depsFor(provider, { buildTurn: (input) => (seen.push(input), base.buildTurn(input)) });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const { events } = await turn(deps, {
      docId: DOC,
      sessionId: session.id,
      kind: 'question',
      text: '이거 뭐야',
      slide: 4,
      attachments: [IMAGE.id, REGION.id, IMAGE.id],
    });
    assert.deepEqual(seen[0].attachments, [
      { kind: 'image', path: imagePath, label: 'Attachment 1: an image from the student (note.jpg)' },
      { kind: 'region', path: regionPath, label: 'Attachment 2: the region of slide 4 the student selected', text: 'x = y + 1' },
    ]);
    const start = events[0] as Extract<StreamEvent, { type: 'start' }>;
    assert.deepEqual(start.userMessage.attachments, [IMAGE, REGION]);
    assert.equal(start.userMessage.context?.attachments, 2);
    const parts = provider.calls[0].parts;
    assert.deepEqual(
      parts.filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image' && p.label.startsWith('Attachment')).map((p) => p.path),
      [imagePath, regionPath],
    );
    const stored = await getSession(DOC, session.id);
    assert.deepEqual(stored?.messages[0].attachments, [IMAGE, REGION]);
    assert.equal(stored?.messages[1].status, 'complete');
    assert.equal(stored?.providerState.imagesSent, (start.userMessage.context?.overviewImages ?? 0) + (start.userMessage.context?.attachedSlides.length ?? 0) + 2);
  });

  test('a retried turn (lost conversation) keeps its attachments; a failed one still stores them', async () => {
    const provider = fakeProvider('claude-code', async (input, call) => {
      if (input.resume !== null) throw new ProviderError('No conversation found with session ID x', 'resume_invalid');
      if (textOf(input.parts).includes('FAIL')) throw new Error('model exploded');
      return streamingAnswer(() => `answer ${call}`)(input, call);
    });
    const seen: BuildTurnInput[] = [];
    const base = defaultChatDeps();
    const deps = depsFor(provider, { buildTurn: (input) => (seen.push(input), base.buildTurn(input)) });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    const { events } = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: '다시', slide: 4, attachments: [REGION.id] });
    assert.equal(seen.length, 3, 'prime, first attempt, retry');
    assert.equal(seen[2].forceNewConversation, 'resume_invalid');
    assert.deepEqual(seen[2].attachments, seen[1].attachments);
    const retryParts = provider.calls.at(-1)!.parts;
    assert.ok(retryParts.some((p) => p.type === 'image' && p.label === 'Attachment 1: the region of slide 4 the student selected'));
    const done = events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.assistantMessage.status, 'complete');
    const user = (await getSession(DOC, session.id))!.messages.at(-2)!;
    assert.deepEqual(user.attachments, [REGION]);
    assert.equal(user.context?.recoveredFrom, 'resume_invalid');
    assert.equal(user.context?.attachments, 1);

    const failing = await createSession(DOC, { provider: 'claude-code', model: '' });
    const failed = await turn(deps, { docId: DOC, sessionId: failing.id, kind: 'question', text: 'FAIL', slide: 4, attachments: [IMAGE.id] });
    assert.equal(failed.assistant.status, 'error');
    assert.deepEqual((await getSession(DOC, failing.id))!.messages[0].attachments, [IMAGE]);
  });

  test('unknown, foreign or too many ids: HttpError 400 before anything is persisted, nothing stays pinned', async () => {
    const foreign: Attachment = { ...IMAGE, id: 'att-00000000000000c3' };
    await storeAttachment(OTHER, foreign);
    const provider = fakeProvider('claude-code', streamingAnswer(() => 'ok'));
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const many = Array.from({ length: 7 }, (_, i) => `att-${String(i).padStart(16, '0')}`);
    for (const attachments of [['att-ffffffffffffffff'], [foreign.id], [REGION.id, 'att-ffffffffffffffff'], many]) {
      await assert.rejects(
        runTurn({ docId: DOC, sessionId: session.id, kind: 'question', text: 'q', slide: 1, attachments, onEvent: () => {} }, deps),
        (err: unknown) => err instanceof HttpError && err.status === 400,
      );
    }
    assert.equal(provider.calls.length, 0);
    assert.deepEqual((await getSession(DOC, session.id))?.messages, []);
    // REGION was looked up by the third request and released again.
    assert.equal(isAttachmentPinned(DOC, REGION.id), false);
    // Priming turns ignore attachments altogether (even unknown ids).
    const primed = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1, attachments: ['att-ffffffffffffffff'] });
    assert.equal(primed.assistant.status, 'complete');
  });
});

describe('runTurn recovery', () => {
  const DOC = 'recovery-deck-eee555';
  before(() => makeReadyDoc(DOC));

  /**
   * A stand-in for context.buildTurn that follows the contract closely enough to test the
   * orchestrator alone: a new conversation when unprimed or forced, else continue `resume`.
   */
  function stubBuildTurn(seen: BuildTurnInput[]) {
    return (input: BuildTurnInput): BuildTurnOutput => {
      seen.push(structuredClone({ ...input, doc: undefined }) as unknown as BuildTurnInput);
      const state = input.session.providerState;
      const forced = input.forceNewConversation;
      const fresh = forced !== undefined || !state.primed || state.resume === null;
      const prior = input.session.messages.filter((m) => m.role === 'user' && m.kind === 'question').map((m) => m.text);
      return {
        systemPrompt: 'SYSTEM',
        parts: [
          { type: 'text', text: fresh ? `PRIMING${forced ? ` RECAP[${prior.join('|')}]` : ''}` : 'CONTINUE' },
          { type: 'text', text: `QUESTION ${input.question}` },
        ],
        resume: fresh ? null : state.resume,
        history: fresh ? [] : state.history,
        context: {
          primed: fresh,
          rollover: false,
          attachedSlides: fresh ? [input.slide] : [],
          reusedSlides: fresh ? [] : [input.slide],
          overviewImages: fresh ? 3 : 0,
          ...(forced ? { recoveredFrom: forced } : {}),
        },
        readDirs: [],
        nextState: {
          resume: null,
          primed: true,
          imagesSent: fresh ? 4 : state.imagesSent,
          recentSlides: [input.slide],
          generation: fresh ? state.generation + 1 : state.generation,
          history: fresh ? [] : state.history,
        },
      };
    };
  }

  /** Answers like streamingAnswer, but continuing a conversation whose handle is in `dead` fails. */
  function expiringProvider(id: ProviderId, dead: Set<string>, kind: 'resume_invalid' | 'context_overflow' = 'resume_invalid') {
    return fakeProvider(id, async (input, call) => {
      const handle = input.resume === null ? null : (input.resume.cliSessionId ?? '');
      if (handle !== null && (dead.has(handle) || dead.has('*'))) {
        throw new ProviderError(kind === 'resume_invalid' ? `No conversation found with session ID ${handle}` : 'prompt is too long', kind);
      }
      return streamingAnswer((n) => `answer ${n}`)(input, call);
    });
  }

  test('a lost conversation is re-primed with a recap and the turn retried once', async () => {
    const dead = new Set<string>();
    const provider = expiringProvider('claude-code', dead);
    const seen: BuildTurnInput[] = [];
    const deps = depsFor(provider, { buildTurn: stubBuildTurn(seen) });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });

    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'first question', slide: 2 });
    assert.deepEqual((await getSession(DOC, session.id))?.providerState.resume, { cliSessionId: 'cli-2' });

    dead.add('cli-2'); // e.g. Claude Code deleted the transcript after 30 days
    const { events, assistant } = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'after a month', slide: 3 });
    assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'status', 'delta', 'status', 'delta', 'done'],
    );
    assert.deepEqual(events[1], { type: 'status', text: '이전 대화를 이어갈 수 없어 새 대화로 다시 시작해요' });
    const start = events[0] as Extract<StreamEvent, { type: 'start' }>;
    assert.equal(start.userMessage.context?.primed, false, '`start` shows the turn as first built');

    // One failed call, one retry in a brand-new conversation.
    assert.equal(provider.calls.length, 4);
    assert.deepEqual(provider.calls[2].resume, { cliSessionId: 'cli-2' });
    assert.equal(provider.calls[3].resume, null);
    assert.equal(textOf(provider.calls[3].parts), 'PRIMING RECAP[first question]\nQUESTION after a month');
    const retryInput = seen.at(-1);
    assert.equal(retryInput?.forceNewConversation, 'resume_invalid');
    assert.equal(retryInput?.session.messages.length, 4, 'the session before this turn (no new question in the recap)');
    assert.equal(seen.at(-2)?.forceNewConversation, undefined);

    assert.equal(assistant.status, 'complete');
    assert.equal(assistant.text, 'answer 4', 'only the retried answer');
    assert.equal(assistant.error, undefined);

    // `done` carries the messages, with the user message's context replaced by the retry's.
    const done = events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    const doneMessages = (done.session as Session).messages;
    assert.equal(doneMessages.length, 6);
    assert.equal(done.session.messageCount, 6);
    const recoveredContext = { primed: true, rollover: false, attachedSlides: [3], reusedSlides: [], overviewImages: 3, recoveredFrom: 'resume_invalid' };
    assert.deepEqual(doneMessages[4].context, recoveredContext);
    assert.deepEqual(doneMessages[5], done.assistantMessage);

    const stored = await getSession(DOC, session.id);
    assert.deepEqual(stored?.messages[4].context, recoveredContext);
    assert.deepEqual(stored?.providerState.resume, { cliSessionId: 'cli-4' });
    assert.equal(stored?.providerState.generation, 2, 'a second provider conversation');

    // The next turn simply continues the new conversation.
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'and then?', slide: 3 });
    assert.deepEqual(provider.calls[4].resume, { cliSessionId: 'cli-4' });
    assert.equal(provider.calls.length, 5);
  });

  test('context overflow of a stateless conversation starts a new history', async () => {
    const dead = new Set<string>();
    const provider = expiringProvider('anthropic-api', dead, 'context_overflow');
    const deps = depsFor(provider, { buildTurn: stubBuildTurn([]) });
    const session = await createSession(DOC, { provider: 'anthropic-api', model: '' });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'q1', slide: 1 });
    assert.equal((await getSession(DOC, session.id))?.providerState.history.length, 4);

    dead.add('*'); // every continued request is now too large (HTTP 413)
    const { events, assistant } = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'q2', slide: 1 });
    assert.ok(events.some((e) => e.type === 'status' && e.text === '대화가 너무 길어져 새 대화로 이어가요'));
    assert.equal(assistant.status, 'complete');
    assert.equal(provider.calls.at(-1)?.resume, null);
    assert.deepEqual(provider.calls.at(-1)?.history, []);
    const stored = await getSession(DOC, session.id);
    assert.equal(stored?.messages.at(-2)?.context?.recoveredFrom, 'context_overflow');
    assert.deepEqual(
      stored?.providerState.history.map((h) => h.role),
      ['user', 'assistant'],
      'the history restarts with the retried turn',
    );
    assert.equal(textOf(stored?.providerState.history[0].parts ?? []), 'PRIMING RECAP[q1]\nQUESTION q2');
  });

  test('no retry for other errors, fresh conversations, streamed text or aborts; a failing retry ends the turn', async () => {
    const seen: BuildTurnInput[] = [];
    let script: Script = streamingAnswer(() => 'ok');
    const provider = fakeProvider('claude-code', (input, call) => script(input, call));
    const deps = depsFor(provider, { buildTurn: stubBuildTurn(seen) });
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const ask = async (text: string) => turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text, slide: 1 });
    const stateNow = async () => structuredClone((await getSession(DOC, session.id))?.providerState);

    // A failure while starting a conversation: a new one would be identical, so no retry.
    script = async () => {
      throw new ProviderError('No conversation found', 'resume_invalid');
    };
    let result = await ask('first');
    assert.equal(result.assistant.status, 'error');
    assert.equal(provider.calls.length, 1);
    assert.ok(!result.events.some((e) => e.type === 'status'));

    script = streamingAnswer(() => 'primed');
    await ask('prime it');
    const primedState = await stateNow();
    assert.equal(provider.calls.length, 2);

    // Other kinds are not recovered.
    script = async () => {
      throw new ProviderError('로그인이 필요합니다', 'auth');
    };
    result = await ask('auth');
    assert.equal(result.assistant.error, '로그인이 필요합니다');
    assert.equal(provider.calls.length, 3);

    // Text already shown cannot be taken back: the partial answer stays, no retry.
    script = async (input) => {
      input.onDelta('partial ');
      throw new ProviderError('prompt is too long', 'context_overflow');
    };
    result = await ask('streamed');
    assert.equal(result.assistant.status, 'error');
    assert.equal(result.assistant.text, 'partial ');
    assert.equal(provider.calls.length, 4);

    // Aborted: never retried.
    script = (input) =>
      new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new ProviderError('No conversation found', 'resume_invalid')), { once: true });
      });
    const events: StreamEvent[] = [];
    const running = runTurn({ docId: DOC, sessionId: session.id, kind: 'question', text: 'abort me', slide: 1, onEvent: (e) => events.push(e) }, deps);
    await waitFor(() => provider.calls.length === 5);
    abortTurn(DOC, session.id);
    assert.equal((await running).assistantMessage.status, 'aborted');
    assert.equal(provider.calls.length, 5);

    // The retry fails too: one retry only, the turn fails with the retry's error, state not advanced.
    script = async (input) => {
      throw input.resume ? new ProviderError('No conversation found', 'resume_invalid') : new Error('network down');
    };
    result = await ask('twice');
    assert.equal(provider.calls.length, 7);
    assert.equal(result.assistant.status, 'error');
    assert.equal(result.assistant.error, 'network down');
    assert.equal(result.assistant.text, '');
    assert.deepEqual(await stateNow(), primedState);
    const stored = await getSession(DOC, session.id);
    assert.equal(stored?.messages.at(-2)?.context?.recoveredFrom, 'resume_invalid', 'the context says what was tried');

    // If the new conversation cannot even be built, the turn fails with the provider's error.
    const build = stubBuildTurn([]);
    const brokenDeps = depsFor(provider, {
      buildTurn: (input: BuildTurnInput) => {
        if (input.forceNewConversation) throw new Error('context bug');
        return build(input);
      },
    });
    script = async () => {
      throw new ProviderError('No conversation found', 'resume_invalid');
    };
    const broken = await turn(brokenDeps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'rebuild fails', slide: 1 });
    assert.equal(broken.assistant.status, 'error');
    assert.equal(broken.assistant.error, 'No conversation found');
    assert.ok(!broken.events.some((e) => e.type === 'status'));
    assert.equal(provider.calls.length, 8);
  });

  test('with the real context builder the retry re-primes the deck and recaps the earlier Q&A', async () => {
    const dead = new Set<string>();
    const provider = expiringProvider('claude-code', dead);
    const deps = depsFor(provider);
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'prime', slide: 1 });
    await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'What is on slide 4?', slide: 4 });

    dead.add('cli-2');
    const { assistant } = await turn(deps, { docId: DOC, sessionId: session.id, kind: 'question', text: 'Explain slide 6', slide: 6 });
    assert.equal(assistant.status, 'complete');
    const retry = provider.calls[3];
    assert.equal(retry.resume, null);
    const text = textOf(retry.parts);
    assert.match(text, /Slide 9 text/, 'the whole deck is fed again');
    assert.match(text, /What is on slide 4\?/, 'the earlier Q&A is recapped');
    assert.match(text, /Explain slide 6/);
    const stored = await getSession(DOC, session.id);
    assert.equal(stored?.messages.at(-2)?.context?.recoveredFrom, 'resume_invalid');
    assert.equal(stored?.messages.at(-2)?.context?.primed, true);
  });
});

// ---------------------------------------------------------------------------
// HTTP smoke test
// ---------------------------------------------------------------------------

interface SseFrame {
  event: string;
  data: StreamEvent;
}

function parseSse(raw: string): SseFrame[] {
  return raw
    .split('\n\n')
    .filter((frame) => frame.trim() && !frame.startsWith(':'))
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? 'null';
      return { event, data: JSON.parse(data) as StreamEvent };
    });
}

describe('HTTP server', () => {
  let server: RunningServer;
  let base = '';
  const provider = fakeProvider('claude-code', async (input, call) => {
    if (textOf(input.parts).includes('BLOCK')) return hangUntilAborted(input, call);
    return streamingAnswer(() => `http answer ${call}`)(input, call);
  });
  const infos: ProviderInfo[] = [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'cli',
      available: true,
      models: [
        { id: '', label: 'CLI 기본값' },
        { id: 'haiku', label: 'Haiku', efforts: [] },
      ],
      defaultModel: '',
      efforts: [
        { id: 'low', label: '낮음' },
        { id: 'high', label: '높음' },
      ],
    },
    { id: 'codex', label: 'Codex', kind: 'cli', available: false, reason: 'codex CLI not found', models: [], defaultModel: '' },
    { id: 'openai-api', label: 'OpenAI API', kind: 'api', available: true, models: [], defaultModel: 'gpt-5' },
  ];
  let docId = '';
  let sessionId = '';

  before(async () => {
    server = await startServer({
      port: 0,
      log: false,
      resumeIngests: false,
      providerInfos: async () => infos,
      chatDeps: depsFor(provider),
    });
    base = server.url;
  });

  after(async () => {
    await server?.close();
  });

  const api = (p: string, init?: RequestInit) => fetch(`${base}/api${p}`, init);
  const postJson = (p: string, body: unknown) =>
    api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function expectError(res: Response, status: number): Promise<string> {
    assert.equal(res.status, status);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, 'string');
    return body.error;
  }

  test('health', async () => {
    const res = await api('/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, providers: infos, libraryDir: path.resolve(tmpRoot) });
  });

  test('upload validates and ingests a PDF', async () => {
    await expectError(await api('/docs', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: 'nope' }), 400);

    const pdf = await fs.readFile(path.join(repoRoot(), 'samples', 'sample-lecture.pdf'));
    const res = await api('/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent('운영체제 5강.pdf') },
      body: pdf,
    });
    assert.equal(res.status, 201);
    const meta = (await res.json()) as DocMeta;
    assert.equal(meta.title, '운영체제 5강');
    assert.equal(meta.status, 'processing');
    docId = meta.id;

    let current = meta;
    await waitFor(async () => {
      current = (await (await api(`/docs/${docId}`)).json()) as DocMeta;
      return current.status !== 'processing';
    }, 60_000);
    assert.equal(current.status, 'ready', current.error ?? '');
    assert.equal(current.pageCount, 9);

    const list = (await (await api('/docs')).json()) as DocMeta[];
    assert.ok(list.some((d) => d.id === docId));
  });

  test('slides are served as immutable PNGs; bad ids and numbers are 404', async () => {
    const res = await api(`/docs/${docId}/slides/7.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
    assert.equal((await api(`/docs/${docId}/slides/007.png`)).status, 200);

    await expectError(await api(`/docs/${docId}/slides/0.png`), 404);
    await expectError(await api(`/docs/${docId}/slides/10.png`), 404);
    await expectError(await api(`/docs/${docId}/slides/..%2Fdoc.json`), 404);
    await expectError(await api('/docs/NOT_VALID/slides/1.png'), 404);
    await expectError(await api('/docs/missing-000000'), 404);
    await expectError(await api('/nope'), 404);
  });

  test('sessions: create, validate providers, list, get', async () => {
    await expectError(await postJson(`/docs/${docId}/sessions`, { provider: 'nope' }), 400);
    await expectError(await postJson(`/docs/${docId}/sessions`, { provider: 'codex' }), 400);
    await expectError(await postJson(`/docs/${docId}/sessions`, { provider: 'claude-code', model: '--evil' }), 400);
    await expectError(
      await api(`/docs/${docId}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' }),
      400,
    );

    const res = await postJson(`/docs/${docId}/sessions`, { provider: 'claude-code', model: 'sonnet', title: '스모크' });
    assert.equal(res.status, 201);
    const session = (await res.json()) as Session;
    assert.equal(session.title, '스모크');
    assert.equal(session.model, 'sonnet');
    assert.ok(!('effort' in session), 'no effort: the CLI default');
    assert.deepEqual(session.messages, []);
    sessionId = session.id;

    const list = (await (await api(`/docs/${docId}/sessions`)).json()) as Session[];
    assert.deepEqual(
      list.map((s) => s.id),
      [sessionId],
    );
    assert.equal(((await (await api(`/docs/${docId}/sessions/${sessionId}`)).json()) as Session).id, sessionId);
    await expectError(await api(`/docs/${docId}/sessions/20200101-000000-0000`), 404);
    await expectError(await api(`/docs/${docId}/sessions/BAD%20ID`), 404);
  });

  test('prime and messages stream SSE frames', async () => {
    const prime = await postJson(`/docs/${docId}/sessions/${sessionId}/prime`, { slide: 1 });
    assert.equal(prime.status, 200);
    assert.equal(prime.headers.get('content-type'), 'text/event-stream');
    assert.equal(prime.headers.get('cache-control'), 'no-cache');
    assert.equal(prime.headers.get('x-accel-buffering'), 'no');
    const frames = parseSse(await prime.text());
    assert.deepEqual(
      frames.map((f) => f.event),
      ['start', 'delta', 'status', 'delta', 'done'],
    );
    for (const frame of frames) assert.equal(frame.data.type, frame.event);
    const done = frames.at(-1)?.data as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.assistantMessage.status, 'complete');
    assert.equal(done.session.primed, true);

    const ask = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: '간트 차트 설명해줘', slide: 7 });
    const askFrames = parseSse(await ask.text());
    assert.equal(askFrames.at(-1)?.event, 'done');

    // Validation errors are plain JSON, not SSE.
    await expectError(await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: '', slide: 1 }), 400);
    await expectError(await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'x', slide: 99 }), 400);
    await expectError(await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'x' }), 400);
  });

  test('neighbors: integer 0..3 or absent, for /messages and /prime', async () => {
    for (const neighbors of [4, -1, 1.5, '1', null, true]) {
      await expectError(await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'x', slide: 1, neighbors }), 400);
      await expectError(await postJson(`/docs/${docId}/sessions/${sessionId}/prime`, { slide: 1, neighbors }), 400);
    }
    const ask = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: '이 슬라이드만', slide: 8, neighbors: 0 });
    const start = parseSse(await ask.text()).find((frame) => frame.event === 'start')?.data as Extract<StreamEvent, { type: 'start' }>;
    assert.deepEqual([...(start.userMessage.context?.attachedSlides ?? []), ...(start.userMessage.context?.reusedSlides ?? [])], [8]);
    const wide = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: '넓게', slide: 5, neighbors: 3 });
    const wideStart = parseSse(await wide.text()).find((frame) => frame.event === 'start')?.data as Extract<StreamEvent, { type: 'start' }>;
    const slides = [...(wideStart.userMessage.context?.attachedSlides ?? []), ...(wideStart.userMessage.context?.reusedSlides ?? [])];
    assert.deepEqual(
      slides.sort((a, b) => a - b),
      [2, 3, 4, 5, 6, 7, 8],
    );
  });

  test('409 while running, /abort stops the turn', async () => {
    const running = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'BLOCK please', slide: 2 });
    assert.equal(running.status, 200);
    const reader = running.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (!raw.includes('event: delta')) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    await expectError(await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'second', slide: 2 }), 409);
    const abort = await api(`/docs/${docId}/sessions/${sessionId}/abort`, { method: 'POST' });
    assert.equal(abort.status, 204);

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    const last = parseSse(raw).at(-1);
    assert.equal(last?.event, 'done');
    const done = last?.data as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.assistantMessage.status, 'aborted');
    assert.equal(done.assistantMessage.text, 'partial ');
  });

  test('a client disconnect aborts the turn (response close, not request close)', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/docs/${docId}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'BLOCK again', slide: 3 }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (!raw.includes('event: delta')) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    controller.abort();
    await waitFor(async () => {
      const session = (await (await api(`/docs/${docId}/sessions/${sessionId}`)).json()) as Session;
      return session.messages.at(-1)?.status === 'aborted';
    });
    const session = (await (await api(`/docs/${docId}/sessions/${sessionId}`)).json()) as Session;
    assert.equal(session.messages.at(-1)?.text, 'partial ');
    assert.equal(session.messages.at(-1)?.error, '클라이언트 연결이 끊어져 중단되었습니다');
  });

  test('notes endpoints', async () => {
    const notes = (await (await api(`/docs/${docId}/notes`)).json()) as NotesResponse;
    assert.equal(notes.docId, docId);
    assert.ok(notes.slides.some((s) => s.slide === 7 && s.entries[0].question.text === '간트 차트 설명해줘'));
    assert.ok(path.isAbsolute(notes.markdownPath));

    const md = await api(`/docs/${docId}/notes.md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type') ?? '', /^text\/markdown; charset=utf-8/);
    const text = await md.text();
    assert.match(text, /^# 운영체제 5강 — study notes/);
    assert.match(text, /!\[slide 7\]\(slides\/007\.png\)/);
  });

  test('delete a session', async () => {
    const res = await api(`/docs/${docId}/sessions/${sessionId}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    await expectError(await api(`/docs/${docId}/sessions/${sessionId}`), 404);
    await expectError(await api(`/docs/${docId}/sessions/${sessionId}`, { method: 'DELETE' }), 404);
    const md = await (await api(`/docs/${docId}/notes.md`)).text();
    assert.ok(!md.includes('간트 차트 설명해줘'));
  });

  test('reasoning effort: validated, kept with the session, passed on every turn and shown in the notes', async () => {
    const create = (body: Record<string, unknown>) => postJson(`/docs/${docId}/sessions`, { provider: 'claude-code', ...body });
    for (const effort of ['ultra', 'HIGH', 3, null]) await expectError(await create({ effort }), 400);
    assert.match(await expectError(await create({ model: 'haiku', effort: 'high' }), 400), /지원하지 않습니다/);
    assert.match(
      await expectError(await postJson(`/docs/${docId}/sessions`, { provider: 'openai-api', effort: 'high' }), 400),
      /추론 수준을 고를 수 없습니다/,
    );
    // '' = the default, like an omitted effort; a model typed in by hand may take any level.
    const plain = (await (await create({ effort: '' })).json()) as Session;
    assert.ok(!('effort' in plain));
    assert.equal(((await (await create({ model: 'my-model', effort: 'low' })).json()) as Session).effort, 'low');

    const res = await create({ effort: 'high', title: '추론' });
    assert.equal(res.status, 201);
    const session = (await res.json()) as Session;
    assert.equal(session.effort, 'high');
    const listed = ((await (await api(`/docs/${docId}/sessions`)).json()) as Session[]).find((s) => s.id === session.id);
    assert.equal(listed?.effort, 'high');

    const before = provider.calls.length;
    const prime = parseSse(await (await postJson(`/docs/${docId}/sessions/${session.id}/prime`, { slide: 1 })).text());
    const primed = prime.at(-1)?.data as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(primed.assistantMessage.effort, 'high');
    assert.equal(primed.session.effort, 'high');
    const ask = parseSse(await (await postJson(`/docs/${docId}/sessions/${session.id}/messages`, { text: '추론 질문', slide: 2 })).text());
    assert.equal(ask.at(-1)?.event, 'done');
    assert.deepEqual(
      provider.calls.slice(before).map((c) => [c.effort, c.resume === null ? 'new' : 'resumed']),
      [
        ['high', 'new'],
        ['high', 'resumed'],
      ],
    );
    const notes = await (await api(`/docs/${docId}/notes.md`)).text();
    assert.match(notes, /Claude Code \(effort high\)/);

    // A session without one (e.g. made before efforts existed) runs with the CLI default.
    const plainAsk = parseSse(await (await postJson(`/docs/${docId}/sessions/${plain.id}/messages`, { text: '기본', slide: 1 })).text());
    assert.equal(plainAsk.at(-1)?.event, 'done');
    assert.equal(provider.calls.at(-1)?.effort, '');
    assert.ok(!('effort' in (plainAsk.at(-1)?.data as Extract<StreamEvent, { type: 'done' }>).assistantMessage));
  });

  test('cross-site requests and foreign Host headers are refused', async () => {
    const session = (await (await postJson(`/docs/${docId}/sessions`, { provider: 'claude-code' })).json()) as Session;
    const abortPath = `/docs/${docId}/sessions/${session.id}/abort`;

    await expectError(await api(abortPath, { method: 'POST', headers: { Origin: 'https://evil.example' } }), 403);
    await expectError(await api(abortPath, { method: 'POST', headers: { Origin: 'null' } }), 403);
    assert.equal((await api(abortPath, { method: 'POST', headers: { Origin: base } })).status, 204);
    assert.equal((await api(`/docs/${docId}`, { headers: { Origin: 'https://evil.example' } })).status, 200, 'reads stay open');

    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends its own Host header.
    const { port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/docs', headers: { Host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  test('a document cannot be deleted while one of its sessions is answering', async () => {
    const doomed = 'doomed-deck-fff666';
    await makeReadyDoc(doomed, 'ready', 'Doomed');
    const session = (await (await postJson(`/docs/${doomed}/sessions`, { provider: 'claude-code' })).json()) as Session;
    const running = await postJson(`/docs/${doomed}/sessions/${session.id}/messages`, { text: 'BLOCK', slide: 1 });
    const reader = running.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (!raw.includes('event: delta')) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    const refused = await expectError(await api(`/docs/${doomed}`, { method: 'DELETE' }), 409);
    assert.match(refused, /답변을 생성하는 중/);
    assert.equal((await api(`/docs/${doomed}`)).status, 200);

    assert.equal((await api(`/docs/${doomed}/sessions/${session.id}/abort`, { method: 'POST' })).status, 204);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    // `done` carries the session with its messages.
    const done = parseSse(raw).at(-1)?.data as Extract<StreamEvent, { type: 'done' }>;
    assert.deepEqual(
      (done.session as Session).messages.map((m) => [m.role, m.status]),
      [
        ['user', 'complete'],
        ['assistant', 'aborted'],
      ],
    );

    assert.equal((await api(`/docs/${doomed}`, { method: 'DELETE' })).status, 204);
    await expectError(await api(`/docs/${doomed}`), 404);
    await expectError(await api(`/docs/${doomed}/sessions/${session.id}`), 404);
    await expectError(await api(`/docs/${doomed}`, { method: 'DELETE' }), 404);
    await expectError(await api('/docs/BAD%20ID', { method: 'DELETE' }), 404);
    await assert.rejects(fs.access(docPaths(doomed).dir));
  });

  test('without web/dist the SPA routes explain how to build', async () => {
    const res = await fetch(`${base}/some/page`);
    // Either the built client (index.html) or the 503 hint, depending on whether web/dist exists.
    assert.ok(res.status === 200 || res.status === 503, String(res.status));
  });
});
