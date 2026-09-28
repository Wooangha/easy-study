// Live recording audio store (DESIGN §22, server/recordings/live.ts): the tus-like offset protocol (gaps,
// overlaps, retries, conflicts), fsync before the acknowledgement, and crash recovery (fault injection at each
// durability step, torn index lines, power-loss garbage, a torn page in the last commit).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HttpError } from '../server/config.ts';
import { LiveAudio } from '../server/recordings/live.ts';
import type { LiveHooks } from '../server/recordings/live.ts';

let tmp = '';
let n = 0;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-live-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function freshStore(hooks: LiveHooks = {}): Promise<{ store: LiveAudio; audio: string; index: string }> {
  const dir = path.join(tmp, `r${++n}`);
  await fs.mkdir(dir);
  const audio = path.join(dir, 'audio.pcm');
  const index = path.join(dir, 'audio.idx');
  await LiveAudio.create(audio, index);
  const store = new LiveAudio(audio, index, hooks);
  await store.open();
  return { store, audio, index };
}

async function reopen(audio: string, index: string): Promise<{ store: LiveAudio; report: Awaited<ReturnType<LiveAudio['open']>> }> {
  const store = new LiveAudio(audio, index);
  const report = await store.open();
  return { store, report };
}

function status409(err: unknown, offset: number): boolean {
  assert.ok(err instanceof HttpError, String(err));
  assert.equal(err.status, 409);
  assert.equal(err.fields?.offset, offset);
  return true;
}

const source = randomBytes(64_000);

describe('live audio: offset protocol', () => {
  test('appends in order, acknowledges the new end', async () => {
    const { store, audio } = await freshStore();
    assert.deepEqual((await store.append(0, source.subarray(0, 1000))).offset, 1000);
    assert.equal((await store.append(1000, source.subarray(1000, 3000))).offset, 3000);
    await store.close();
    assert.ok((await fs.readFile(audio)).equals(source.subarray(0, 3000)));
  });

  test('a gap is refused with the stored end (the client resends from there)', async () => {
    const { store } = await freshStore();
    await store.append(0, source.subarray(0, 1000));
    await assert.rejects(store.append(2000, source.subarray(2000, 3000)), (err) => status409(err, 1000));
    await store.close();
  });

  test('a retry of stored bytes is a duplicate; a partial overlap appends only the new tail', async () => {
    const { store, audio } = await freshStore();
    await store.append(0, source.subarray(0, 2000));
    const dup = await store.append(0, source.subarray(0, 2000));
    assert.equal(dup.duplicate, true);
    assert.equal(dup.offset, 2000);
    const partial = await store.append(1500, source.subarray(1500, 4000));
    assert.equal(partial.duplicate, false);
    assert.equal(partial.at, 2000);
    assert.equal(partial.appended.length, 2000);
    assert.equal(partial.offset, 4000);
    await store.close();
    assert.ok((await fs.readFile(audio)).equals(source.subarray(0, 4000)));
  });

  test('overlapping bytes that differ are a conflict (never overwritten)', async () => {
    const { store, audio } = await freshStore();
    await store.append(0, source.subarray(0, 2000));
    const other = Buffer.from(source.subarray(1000, 3000));
    other[10] ^= 0xff;
    await assert.rejects(store.append(1000, other), (err) => status409(err, 2000));
    await store.close();
    assert.ok((await fs.readFile(audio)).equals(source.subarray(0, 2000)));
  });

  test('after the stop only stored bytes are acknowledged', async () => {
    const { store } = await freshStore();
    await store.append(0, source.subarray(0, 2000));
    assert.equal((await store.append(1000, source.subarray(1000, 2000), true)).duplicate, true);
    await assert.rejects(store.append(2000, source.subarray(2000, 3000), true), (err) => status409(err, 2000));
    await store.close();
  });

  test('fsync ordering: data written and synced, then its index line written and synced, then the acknowledgement', async () => {
    const steps: string[] = [];
    const { store } = await freshStore({ trace: (step) => steps.push(step) });
    const result = await store.append(0, source.subarray(0, 1000));
    steps.push(`ack ${result.offset}`);
    assert.deepEqual(steps, ['write-data', 'sync-data', 'write-index', 'sync-index', 'ack 1000']);
    // A duplicate touches nothing.
    steps.length = 0;
    await store.append(0, source.subarray(0, 1000));
    assert.deepEqual(steps, []);
    await store.close();
  });
});

describe('live audio: crash recovery', () => {
  test('crash after the data write, before the index line: the unindexed tail is dropped and resent', async () => {
    let crash = true;
    const { store, audio, index } = await freshStore({
      fault: (step) => {
        if (crash && step === 'after-data') throw new Error('simulated crash');
      },
    });
    crash = false;
    await store.append(0, source.subarray(0, 1000));
    crash = true;
    await assert.rejects(store.append(1000, source.subarray(1000, 2000)), /simulated crash/);
    assert.equal(store.committed, 1000, 'nothing was acknowledged');
    await store.close();
    assert.equal((await fs.stat(audio)).size, 2000, 'the bytes are on disk without an index line');
    const { store: again, report } = await reopen(audio, index);
    assert.equal(report.truncatedBytes, 1000);
    assert.equal(again.committed, 1000);
    // The client resends from the acknowledged offset.
    await again.append(1000, source.subarray(1000, 2000));
    await again.close();
    assert.ok((await fs.readFile(audio)).equals(source.subarray(0, 2000)));
  });

  test('crash after the index line, before the answer: the retry is absorbed as a duplicate', async () => {
    let crash = false;
    const { store, audio, index } = await freshStore({
      fault: (step) => {
        if (crash && step === 'after-index') throw new Error('simulated crash');
      },
    });
    await store.append(0, source.subarray(0, 1000));
    crash = true;
    await assert.rejects(store.append(1000, source.subarray(1000, 2000)));
    await store.close();
    const { store: again, report } = await reopen(audio, index);
    assert.equal(report.truncatedBytes, 0);
    assert.equal(again.committed, 2000);
    const retry = await again.append(1000, source.subarray(1000, 2000));
    assert.equal(retry.duplicate, true);
    await again.close();
    assert.ok((await fs.readFile(audio)).equals(source.subarray(0, 2000)));
  });

  test('a failed index write (disk full) is cut back: later commits survive a restart', async () => {
    let fail = false;
    const { store, audio, index } = await freshStore({
      fault: (step) => {
        if (fail && step === 'after-index-write') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
    });
    await store.append(0, source.subarray(0, 1000));
    fail = true;
    await assert.rejects(store.append(1000, source.subarray(1000, 2000)), /ENOSPC/);
    assert.equal(store.committed, 1000);
    fail = false;
    // The client resends; the server goes on (no restart in between).
    await store.append(1000, source.subarray(1000, 2000));
    await store.append(2000, source.subarray(2000, 3000));
    await store.close();
    assert.equal((await fs.readFile(index, 'utf8')).trim().split('\n').length, 3, 'no line of the failed write is left');
    const { store: again, report } = await reopen(audio, index);
    assert.deepEqual(report, { truncatedBytes: 0, droppedEntries: 0 });
    assert.equal(again.committed, 3000, 'every acknowledged byte is still there');
    await again.close();
  });

  test('power loss: garbage after the last commit and a torn index line are dropped', async () => {
    const { store, audio, index } = await freshStore();
    for (let at = 0; at < 8000; at += 1000) await store.append(at, source.subarray(at, at + 1000));
    await store.close();
    await fs.appendFile(audio, randomBytes(12_345));
    await fs.appendFile(index, '8000 1000 123');
    const { store: again, report } = await reopen(audio, index);
    assert.equal(again.committed, 8000);
    assert.equal(report.truncatedBytes, 12_345);
    assert.equal(report.droppedEntries, 0);
    assert.doesNotMatch(await fs.readFile(index, 'utf8'), /8000 1000 123$/);
    await again.append(8000, source.subarray(8000, 9000));
    await again.close();
    assert.ok((await fs.readFile(audio)).equals(source.subarray(0, 9000)));
  });

  test('a torn page in the last commit fails its CRC: truncated there, the client gets a gap and heals it', async () => {
    const { store, audio, index } = await freshStore();
    for (let at = 0; at < 5000; at += 1000) await store.append(at, source.subarray(at, at + 1000));
    await store.close();
    const fh = await fs.open(audio, 'r+');
    await fh.write(Buffer.from([0x00, 0x11, 0x22]), 0, 3, 4500);
    await fh.close();
    const { store: again, report } = await reopen(audio, index);
    assert.equal(again.committed, 4000);
    assert.equal(report.droppedEntries, 1);
    await assert.rejects(again.append(5000, source.subarray(5000, 6000)), (err) => status409(err, 4000));
    await again.append(4000, source.subarray(4000, 6000));
    await again.close();
    assert.ok((await fs.readFile(audio)).equals(source.subarray(0, 6000)));
  });

  test('an index entry that is not contiguous ends the verified audio', async () => {
    const { store, audio, index } = await freshStore();
    await store.append(0, source.subarray(0, 1000));
    await store.close();
    await fs.appendFile(audio, source.subarray(1000, 2000));
    await fs.appendFile(index, '1500 500 0 0\n');
    const { store: again } = await reopen(audio, index);
    assert.equal(again.committed, 1000);
    await again.close();
  });
});
