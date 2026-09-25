// The LLM CLI process budget (server/cliBudget.ts, DESIGN §15): at most N CLI children across chat turns
// and digest batches, chat turns first.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCliBudget } from '../server/cliBudget.ts';
import { maxCliProcs } from '../server/config.ts';

const never = () => new AbortController().signal;

/** Settles on the next macrotask: true when `promise` resolved by then. */
async function isGranted(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe('CLI process budget', () => {
  test('EASY_STUDY_MAX_CLI_PROCS: default 2, clamped to 1..16', () => {
    const saved = process.env.EASY_STUDY_MAX_CLI_PROCS;
    try {
      delete process.env.EASY_STUDY_MAX_CLI_PROCS;
      assert.equal(maxCliProcs(), 2);
      process.env.EASY_STUDY_MAX_CLI_PROCS = '3';
      assert.equal(maxCliProcs(), 3);
      process.env.EASY_STUDY_MAX_CLI_PROCS = '0';
      assert.equal(maxCliProcs(), 1);
      process.env.EASY_STUDY_MAX_CLI_PROCS = '64';
      assert.equal(maxCliProcs(), 16);
      process.env.EASY_STUDY_MAX_CLI_PROCS = 'many';
      assert.equal(maxCliProcs(), 2);
    } finally {
      if (saved === undefined) delete process.env.EASY_STUDY_MAX_CLI_PROCS;
      else process.env.EASY_STUDY_MAX_CLI_PROCS = saved;
    }
  });

  test('digest batches share the limit and wait in arrival order', async () => {
    const budget = createCliBudget(() => 2);
    const first = await budget.acquire('digest', never());
    const second = await budget.acquire('digest', never());
    let waited = 0;
    const third = budget.acquire('digest', never(), () => waited++);
    const fourth = budget.acquire('digest', never());
    assert.equal(waited, 1, 'onWait is called when the call has to queue');
    assert.equal(await isGranted(third), false);
    assert.deepEqual(budget.usage(), { chat: 0, digest: 2, waitingChat: 0, waitingDigest: 2 });

    first();
    first(); // idempotent
    assert.equal(await isGranted(third), true);
    assert.equal(await isGranted(fourth), false);
    second();
    assert.equal(await isGranted(fourth), true);
    (await third)();
    (await fourth)();
    assert.deepEqual(budget.usage(), { chat: 0, digest: 0, waitingChat: 0, waitingDigest: 0 });
  });

  test('a chat turn never waits for digest batches: it starts even when digests fill the budget', async () => {
    const budget = createCliBudget(() => 2);
    const digests = [await budget.acquire('digest', never()), await budget.acquire('digest', never())];
    let waited = false;
    const chat = await budget.acquire('chat', never(), () => (waited = true));
    assert.equal(waited, false);
    assert.deepEqual(budget.usage(), { chat: 1, digest: 2, waitingChat: 0, waitingDigest: 0 });

    // Over the limit now: a digest batch that finishes frees no slot for the next digest batch.
    const nextDigest = budget.acquire('digest', never());
    digests[0]();
    assert.equal(await isGranted(nextDigest), false, '1 chat + 1 digest = the limit');
    chat();
    assert.equal(await isGranted(nextDigest), true);
    digests[1]();
    (await nextDigest)();
  });

  test('chat turns wait only for chat turns; a waiting chat turn holds every digest back', async () => {
    const budget = createCliBudget(() => 2);
    const chats = [await budget.acquire('chat', never()), await budget.acquire('chat', never())];
    let chatWaited = false;
    const thirdChat = budget.acquire('chat', never(), () => (chatWaited = true));
    assert.equal(chatWaited, true);
    const digest = budget.acquire('digest', never());
    chats[0]();
    assert.equal(await isGranted(thirdChat), true, 'the freed slot goes to the waiting chat turn');
    assert.equal(await isGranted(digest), false);
    chats[1]();
    assert.equal(await isGranted(digest), true);
    (await thirdChat)();
    (await digest)();
    assert.deepEqual(budget.usage(), { chat: 0, digest: 0, waitingChat: 0, waitingDigest: 0 });
  });

  test('an aborted wait leaves the queue (and lets the digests behind a chat turn go)', async () => {
    const budget = createCliBudget(() => 1);
    const chat = await budget.acquire('chat', never());
    const controller = new AbortController();
    const waitingChat = budget.acquire('chat', controller.signal);
    const digest = budget.acquire('digest', never());
    controller.abort(new Error('사용자가 중단했습니다'));
    await assert.rejects(waitingChat, /사용자가 중단했습니다/);
    assert.equal(budget.usage().waitingChat, 0);
    chat();
    assert.equal(await isGranted(digest), true, 'no chat turn waits any more');
    (await digest)();

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(budget.acquire('digest', aborted.signal));
    assert.deepEqual(budget.usage(), { chat: 0, digest: 0, waitingChat: 0, waitingDigest: 0 });
  });

  test('the limit is read on every decision', async () => {
    let limit = 1;
    const budget = createCliBudget(() => limit);
    const first = await budget.acquire('digest', never());
    assert.equal(await isGranted(budget.acquire('chat', never())), true, 'chat turns only count chat turns');
    limit = 2;
    const second = budget.acquire('digest', never());
    assert.equal(await isGranted(second), false, '1 chat + 1 digest already');
    limit = 3;
    first();
    assert.equal(await isGranted(second), true);
  });
});
