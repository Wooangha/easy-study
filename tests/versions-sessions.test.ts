// A new version of a lecture's deck (DESIGN §28), sessions side: remapSessionSlides (apply, undo, idempotency),
// questionCountOnSlides, the 'deck_update' restart of the context builder, and chat.reserveDocTurns. No real CLI or
// API is ever called.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Attachment, ChatMessage, ProviderId } from '../shared/types.ts';
import { reserveDocTurns, runTurn, withSessionReserved, abortTurn, isTurnRunning } from '../server/chat.ts';
import type { ChatDeps } from '../server/chat.ts';
import { HttpError } from '../server/config.ts';
import { DEFAULT_CONTEXT_SETTINGS, appendHistory, buildTurn, defaultContextSettings, initialProviderState } from '../server/context.ts';
import type { BuildTurnInput, DeckMap, DocAssets, ProviderState, SessionRecord } from '../server/internal-types.ts';
import { docPaths } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import { RECAP_HEADING, recapLine, restartNote } from '../server/prompts.ts';
import type { Provider, ProviderRunInput, ProviderRunResult } from '../server/providers/types.ts';
import { createSession, deleteSession, getSession, questionCountOnSlides, remapSessionSlides, saveSession } from '../server/sessions.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-versions-sessions-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A ready lecture without rendered assets (enough for sessions and turns with a fake provider). */
async function makeDoc(docId: string, pageCount = 6, deckRev?: number): Promise<void> {
  const paths = docPaths(docId);
  await fs.rm(paths.dir, { recursive: true, force: true });
  await fs.mkdir(paths.dir, { recursive: true });
  const meta: StoredDocMeta = {
    id: docId,
    title: '컴파일러 7강',
    fileName: 'L7.pdf',
    pageCount,
    aspectRatio: 16 / 9,
    status: 'ready',
    progress: pageCount,
    createdAt: '2026-09-23T00:00:00.000Z',
    ...(deckRev ? { deckRev } : {}),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
}

/**
 * Old deck of 6 slides → new deck of 6: old 3 dropped, old 4 is new 3, new 4 added, old 5 changed (new 5).
 * The undo map is its inverse, bringing deck 0 back as deck 2.
 */
const APPLY: DeckMap = {
  fromRev: 0,
  toRev: 1,
  oldPageCount: 6,
  newPageCount: 6,
  oldToNew: [1, 2, null, 3, 5, 6],
  changed: new Set([5]),
  added: new Set([4]),
};
const UNDO: DeckMap = {
  fromRev: 1,
  toRev: 2,
  oldPageCount: 6,
  newPageCount: 6,
  oldToNew: [1, 2, 4, null, 5, 6],
  changed: new Set([5]),
  added: new Set([3]),
  restoreRev: 0,
};

let seq = 0;
function message(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'slide'>): ChatMessage {
  return { id: `m${seq++}`, text: '', kind: 'question', createdAt: '2026-09-23T06:00:00.000Z', status: 'complete', ...partial };
}

function region(id: string, slide: number): Attachment {
  return { id, kind: 'region', slide, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, width: 100, height: 80, text: '', createdAt: '2026-09-23T06:00:00.000Z' };
}

async function sessionWith(docId: string, messages: ChatMessage[], state: ProviderState): Promise<SessionRecord> {
  const record = await createSession(docId, { provider: 'claude-code', model: 'sonnet' });
  record.messages = messages;
  record.providerState = state;
  await saveSession(record);
  return record;
}

const fileOf = (docId: string, sessionId: string) => path.join(docPaths(docId).sessionsDir, `${sessionId}.json`);
const rawOf = (docId: string, sessionId: string) => fs.readFile(fileOf(docId, sessionId), 'utf8');
const deckRevOf = async (docId: string, sessionId: string) => (JSON.parse(await rawOf(docId, sessionId)) as { deckRev?: number }).deckRev;

// ---------------------------------------------------------------------------
// remapSessionSlides
// ---------------------------------------------------------------------------

describe('remapSessionSlides', () => {
  const DOC = 'compiler-l7-aaa111';
  let rich: SessionRecord;
  let fresh: SessionRecord;
  let switched: SessionRecord;

  before(async () => {
    await makeDoc(DOC);
    const image: Attachment = { id: 'img-1', kind: 'image', width: 10, height: 10, createdAt: '2026-09-23T06:00:00.000Z' };
    rich = await sessionWith(
      DOC,
      [
        message({ role: 'user', slide: 1, kind: 'prime', context: { primed: true, rollover: false, attachedSlides: [1, 2], reusedSlides: [], overviewImages: 2 } }),
        message({ role: 'assistant', slide: 1, kind: 'prime' }),
        message({
          role: 'user',
          slide: 2,
          text: '이거 뭐예요?',
          context: { primed: false, rollover: false, attachedSlides: [3], reusedSlides: [1, 2], overviewImages: 0, attachments: 2 },
          attachments: [region('reg-on-3', 3), image],
        }),
        message({ role: 'assistant', slide: 2, text: '답 1' }),
        message({ role: 'user', slide: 3, text: '빠지는 장 질문' }),
        message({ role: 'assistant', slide: 3, text: '답 2' }),
        message({ role: 'user', slide: 4, text: '옮겨지는 장 질문' }),
        message({ role: 'assistant', slide: 4, text: '답 3' }),
      ],
      { resume: { cliSessionId: 'cli-1' }, primed: true, imagesSent: 12, recentSlides: [4, 3, 2], generation: 2, history: [] },
    );
    fresh = await sessionWith(DOC, [], initialProviderState());
    switched = await sessionWith(DOC, [message({ role: 'user', slide: 6, text: 'q' }), message({ role: 'assistant', slide: 6, text: 'a' })], {
      ...initialProviderState(),
      generation: 3,
      switched: true,
    });
  });

  test('questionCountOnSlides counts the questions of the given slides only (not primes or answers)', async () => {
    assert.equal(await questionCountOnSlides(DOC, [3]), 1);
    assert.equal(await questionCountOnSlides(DOC, [1, 3, 6]), 2);
    assert.equal(await questionCountOnSlides(DOC, []), 0);
    assert.equal(await questionCountOnSlides('no-such-doc-zzz999', [1]), 0);
  });

  test('apply: slides follow the new deck, a dropped slide goes to the nearest kept one with removedFrom', async () => {
    const old = await getSession(DOC, rich.id);
    assert.ok(old);
    await remapSessionSlides(DOC, APPLY);
    const remapped = await getSession(DOC, rich.id);
    assert.ok(remapped);

    assert.deepEqual(
      remapped.messages.map((m) => [m.slide, m.removedFrom ?? null]),
      [
        [1, null],
        [1, null],
        [2, null],
        [2, null],
        [2, { rev: 0, slide: 3 }],
        [2, { rev: 0, slide: 3 }],
        [3, null],
        [3, null],
      ],
    );
    // The region attachment of the dropped slide moves like a message; an image has no slide.
    assert.deepEqual(remapped.messages[2].attachments?.[0], { ...region('reg-on-3', 2), removedFrom: { rev: 0, slide: 3 } });
    assert.deepEqual(remapped.messages[2].attachments?.[1], old.messages[2].attachments?.[1]);
    // ContextInfo slides mapped, the dropped ones left out.
    assert.deepEqual(remapped.messages[0].context, { primed: true, rollover: false, attachedSlides: [1, 2], reusedSlides: [], overviewImages: 2 });
    assert.deepEqual(remapped.messages[2].context, { primed: false, rollover: false, attachedSlides: [], reusedSlides: [1, 2], overviewImages: 0, attachments: 2 });
    // The conversation made with the old deck is dropped: the next turn restarts with the new one.
    assert.deepEqual(remapped.providerState, { ...initialProviderState(), generation: 2, deckUpdated: true });
    // Texts, ids and times stay; updatedAt is kept (the list order does not change).
    assert.deepEqual(remapped.messages.map((m) => [m.id, m.text, m.createdAt]), old.messages.map((m) => [m.id, m.text, m.createdAt]));
    assert.equal(remapped.updatedAt, old.updatedAt);
    assert.equal(await deckRevOf(DOC, rich.id), 1);
  });

  test('apply: a session without a conversation gets a fresh state; a switched one keeps switched', async () => {
    const plain = await getSession(DOC, fresh.id);
    assert.deepEqual(plain?.providerState, initialProviderState());
    assert.equal(await deckRevOf(DOC, fresh.id), 1);
    const other = await getSession(DOC, switched.id);
    assert.deepEqual(other?.providerState, { ...initialProviderState(), generation: 3, switched: true, deckUpdated: true });
    assert.deepEqual(other?.messages.map((m) => m.slide), [6, 6]);
  });

  test('a second run of the same map changes nothing (idempotent)', async () => {
    const raws = await Promise.all([rich, fresh, switched].map((record) => rawOf(DOC, record.id)));
    await remapSessionSlides(DOC, APPLY);
    assert.deepEqual(await Promise.all([rich, fresh, switched].map((record) => rawOf(DOC, record.id))), raws);
  });

  test('undo: what the apply moved goes back; a question on an added slide moves with removedFrom', async () => {
    // A question asked on the added slide 4 after the apply.
    const record = await getSession(DOC, rich.id);
    assert.ok(record);
    record.messages.push(message({ role: 'user', slide: 4, text: '새 장 질문' }), message({ role: 'assistant', slide: 4, text: '답 4' }));
    await saveSession(record);

    await remapSessionSlides(DOC, UNDO);
    const undone = await getSession(DOC, rich.id);
    assert.ok(undone);
    assert.deepEqual(
      undone.messages.map((m) => [m.slide, m.removedFrom ?? null]),
      [
        [1, null],
        [1, null],
        [2, null],
        [2, null],
        [3, null],
        [3, null],
        [4, null],
        [4, null],
        // Added slide 4 (deck 1) is gone: nearest preceding kept slide, deck 1's 3 → deck 2's 4.
        [4, { rev: 1, slide: 4 }],
        [4, { rev: 1, slide: 4 }],
      ],
    );
    assert.deepEqual(undone.messages[2].attachments?.[0], region('reg-on-3', 3));
    // Still no conversation since the apply: the next turn says the deck changed.
    assert.deepEqual(undone.providerState, { ...initialProviderState(), generation: 2, deckUpdated: true });
    assert.equal(await deckRevOf(DOC, rich.id), 2);
    assert.deepEqual((await getSession(DOC, fresh.id))?.providerState, initialProviderState());
  });

  test('a slide dropped at the start goes to the closest following kept slide', async () => {
    const doc = 'compiler-l8-bbb222';
    await makeDoc(doc, 3);
    const record = await sessionWith(doc, [message({ role: 'user', slide: 1, text: 'q' })], initialProviderState());
    await remapSessionSlides(doc, { fromRev: 0, toRev: 1, oldPageCount: 3, newPageCount: 2, oldToNew: [null, 1, 2], changed: new Set(), added: new Set() });
    assert.deepEqual((await getSession(doc, record.id))?.messages[0], { ...record.messages[0], slide: 1, removedFrom: { rev: 0, slide: 1 } });
  });

  test('a session deleted meanwhile is not written again; a malformed file is left alone', async () => {
    const doc = 'compiler-l9-ccc333';
    await makeDoc(doc);
    const doomed = await sessionWith(doc, [message({ role: 'user', slide: 3, text: 'q' })], initialProviderState());
    const broken = path.join(docPaths(doc).sessionsDir, '20260923-120000-beef.json');
    await fs.writeFile(broken, '{ not json');
    await Promise.all([remapSessionSlides(doc, APPLY), deleteSession(doc, doomed.id)]);
    await assert.rejects(fs.access(fileOf(doc, doomed.id)));
    assert.equal(await fs.readFile(broken, 'utf8'), '{ not json');
  });

  test('an undo of an apply that gave a session up only marks it (a new conversation); one of another deck is left alone', async () => {
    const doc = 'compiler-l11-eee555';
    await makeDoc(doc, 6, 2);
    // Still numbered in deck 0: the apply's remap of it was given up.
    const kept = await sessionWith(doc, [message({ role: 'user', slide: 3, text: 'q' })], { ...initialProviderState(), primed: true, generation: 1 });
    await fs.writeFile(fileOf(doc, kept.id), JSON.stringify({ ...JSON.parse(await rawOf(doc, kept.id)), deckRev: undefined }));
    await remapSessionSlides(doc, UNDO);
    const undone = await getSession(doc, kept.id);
    assert.deepEqual(undone?.messages.map((m) => [m.slide, m.removedFrom ?? null]), [[3, null]], 'already in the deck that came back');
    assert.deepEqual(undone?.providerState, { ...initialProviderState(), generation: 1, deckUpdated: true });
    assert.equal(await deckRevOf(doc, kept.id), 2);

    // Numbered in deck 2 while the lecture is swapped from deck 4: not this swap's numbering.
    const raw = await rawOf(doc, kept.id);
    await remapSessionSlides(doc, { ...APPLY, fromRev: 4, toRev: 5 });
    assert.equal(await rawOf(doc, kept.id), raw);
  });

  test('a session made after a swap carries the deck it is numbered in, so a rerun of that swap skips it', async () => {
    const doc = 'compiler-l10-ddd444';
    await makeDoc(doc, 6, 1);
    const record = await sessionWith(doc, [message({ role: 'user', slide: 4, text: 'q' })], initialProviderState());
    assert.equal(await deckRevOf(doc, record.id), 1);
    await remapSessionSlides(doc, APPLY);
    assert.equal((await getSession(doc, record.id))?.messages[0].slide, 4);
  });
});

// ---------------------------------------------------------------------------
// Context: the 'deck_update' restart
// ---------------------------------------------------------------------------

describe("buildTurn: a deck update (ProviderState.deckUpdated) is a forced rollover with the 'deck_update' note", () => {
  const doc: DocAssets = {
    meta: {
      id: 'sample-lecture-abc123',
      title: 'Sample Lecture',
      fileName: 'sample-lecture.pdf',
      pageCount: 6,
      aspectRatio: 16 / 9,
      status: 'ready',
      progress: 6,
      createdAt: '2026-09-23T00:00:00.000Z',
      courseId: null,
      digestStatus: 'none',
      deckRev: 1,
    },
    dir: '/library/sample-lecture-abc123',
    texts: Array.from({ length: 6 }, (_, i) => `Text of slide ${i + 1}`),
    slidePath: (n) => `/library/sample-lecture-abc123/slides/${String(n).padStart(3, '0')}.png`,
    sheets: [],
    digest: null,
    digestComplete: false,
    course: null,
  };
  const qa: ChatMessage[] = [
    message({ role: 'user', slide: 2, text: '질문 A' }),
    message({ role: 'assistant', slide: 2, text: '답변 A' }),
    message({ role: 'user', slide: 2, text: '질문 B', removedFrom: { rev: 0, slide: 3 } }),
    message({ role: 'assistant', slide: 2, text: '답변 B' }),
  ];
  const session = (state: ProviderState, messages = qa, provider: ProviderId = 'claude-code'): SessionRecord => ({
    version: 1,
    id: '20260923-120000-abcd',
    docId: doc.meta.id,
    title: 'Session',
    provider,
    model: '',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    providerState: state,
    messages,
  });
  const turn = (overrides: Partial<BuildTurnInput> & { session: SessionRecord }) =>
    buildTurn({ doc, kind: 'question', question: '다시 설명해줘', slide: 2, neighbors: 0, settings: { ...DEFAULT_CONTEXT_SETTINGS }, maxImagesPerConversation: 90, ...overrides });
  const textOf = (out: ReturnType<typeof buildTurn>) => out.parts.map((p) => (p.type === 'text' ? p.text : '<image>')).join('\n');

  test('re-primes with the new deck, recaps with the new numbers and says why; the flag is gone afterwards', () => {
    const out = turn({ session: session({ ...initialProviderState(), generation: 2, deckUpdated: true }) });
    assert.equal(out.resume, null);
    assert.deepEqual(out.context, { primed: true, rollover: true, attachedSlides: [2], reusedSlides: [], overviewImages: 0, deckUpdated: true });
    assert.deepEqual(out.nextState, { resume: null, primed: true, imagesSent: 1, recentSlides: [2], generation: 3, history: [] });
    const text = textOf(out);
    assert.ok(text.includes('### Slide 6'), 'the deck is attached again');
    assert.ok(
      text.includes(
        [RECAP_HEADING, recapLine(2, '질문 A', '답변 A'), recapLine(2, '질문 B', '답변 B', true), '', restartNote('deck_update')].join('\n'),
      ),
    );
    assert.match(restartNote('deck_update'), /new version/);
    assert.match(recapLine(2, 'q', 'a', true), /^- \(near slide 2; the question's own slide is no longer in the deck\) Q: q \/ A: a$/);
    assert.equal(recapLine(2, 'q', 'a'), '- (slide 2) Q: q / A: a');
  });

  test('with an LLM switch too: both flags, the deck note', () => {
    const out = turn({ session: session({ ...initialProviderState(), generation: 2, switched: true, deckUpdated: true }, qa, 'codex') });
    assert.equal(out.context.switched, true);
    assert.equal(out.context.deckUpdated, true);
    assert.ok(textOf(out).includes(restartNote('deck_update')));
    assert.ok(!textOf(out).includes(restartNote('provider_switch')));
  });

  test('without Q&A there is nothing to recap; any other value of the flag is ignored', () => {
    const empty = turn({ session: session({ ...initialProviderState(), deckUpdated: true }, []) });
    assert.equal(empty.context.deckUpdated, true);
    assert.doesNotMatch(textOf(empty), /Earlier in this study session/);
    const plain = turn({ session: session({ ...initialProviderState(), deckUpdated: 'yes' as never }) });
    assert.equal('deckUpdated' in plain.context, false);
    assert.equal(plain.context.rollover, false);
    assert.ok(textOf(plain).includes(restartNote('restart')));
  });
});

// ---------------------------------------------------------------------------
// chat.reserveDocTurns
// ---------------------------------------------------------------------------

describe('reserveDocTurns', () => {
  const DOC = 'compiler-l11-eee555';
  const OTHER = 'compiler-l12-fff666';
  const BUSY_ANSWERING = '답변하는 중에는 바꿀 수 없어요. 답변이 끝난 뒤에 다시 해 주세요.';
  const SWAPPING = '새 버전으로 바꾸는 중이에요. 잠시 후 다시 해 주세요.';

  /** A fake CLI provider: hangs until aborted while `hang` is set, else answers at once. */
  let hang = false;
  const calls: ProviderRunInput[] = [];
  const provider: Provider = {
    id: 'claude-code',
    label: 'Fake',
    kind: 'cli',
    models: [{ id: '', label: 'default' }],
    defaultModel: '',
    maxImagesPerConversation: 90,
    detect: async () => ({ available: true }),
    run: (input): Promise<ProviderRunResult> => {
      calls.push(input);
      if (!hang) return Promise.resolve({ text: 'answer', resume: { cliSessionId: `cli-${calls.length}` } });
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (input.signal.aborted) fail();
        input.signal.addEventListener('abort', fail, { once: true });
      });
    },
  };
  const deps: ChatDeps = {
    getProvider: (id) => (id === provider.id ? provider : undefined),
    checkProvider: async () => ({ available: true }),
    buildTurn,
    appendHistory,
    contextSettings: () => defaultContextSettings({}),
  };
  const ask = (docId: string, sessionId: string, kind: 'question' | 'prime' = 'question') =>
    runTurn({ docId, sessionId, kind, text: '질문', slide: 1, neighbors: 0, onEvent: () => {} }, deps);
  const conflict = (message: string) => (err: unknown) => err instanceof HttpError && err.status === 409 && err.message === message;

  before(async () => {
    await makeDoc(DOC);
    await makeDoc(OTHER);
  });

  test('409 while a turn of the lecture runs; nothing is reserved then', async () => {
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    hang = true;
    const callsBefore = calls.length;
    const running = ask(DOC, session.id);
    assert.equal(isTurnRunning(DOC, session.id), true);
    // Answering: the provider has the turn.
    while (calls.length === callsBefore) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.throws(() => reserveDocTurns(DOC), conflict(BUSY_ANSWERING));
    // Another lecture is not affected.
    reserveDocTurns(OTHER)();
    abortTurn(DOC, session.id);
    assert.equal((await running).assistantMessage.status, 'aborted');
    hang = false;
    // The failed reservation left nothing behind.
    reserveDocTurns(DOC)();
  });

  test('while held: turns, prime turns and LLM switches of the lecture answer 409; released (idempotent) they run again', async () => {
    const session = await createSession(DOC, { provider: 'claude-code', model: '' });
    const other = await createSession(OTHER, { provider: 'claude-code', model: '' });
    const release = reserveDocTurns(DOC);
    const callsBefore = calls.length;
    await assert.rejects(ask(DOC, session.id), conflict(SWAPPING));
    await assert.rejects(ask(DOC, session.id, 'prime'), conflict(SWAPPING));
    await assert.rejects(withSessionReserved(DOC, session.id, async () => 'switched'), conflict(SWAPPING));
    assert.throws(() => reserveDocTurns(DOC), conflict(SWAPPING));
    assert.equal(calls.length, callsBefore, 'no provider call');
    assert.equal((await getSession(DOC, session.id))?.messages.length, 0, 'nothing persisted');
    // Other lectures go on.
    assert.equal((await ask(OTHER, other.id)).assistantMessage.status, 'complete');

    release();
    release();
    assert.equal(await withSessionReserved(DOC, session.id, async () => 'switched'), 'switched');
    assert.equal((await ask(DOC, session.id)).assistantMessage.status, 'complete');
    // A second release of the first reservation does not release a newer one.
    const again = reserveDocTurns(DOC);
    release();
    await assert.rejects(ask(DOC, session.id), conflict(SWAPPING));
    again();
  });
});
