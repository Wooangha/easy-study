// The digest and a new version of the lecture's PDF (server/digest.ts, DESIGN §28 "Remaps › Digest"): lockDigest
// (no job, no DIGEST.md rewrite during a swap), remapDigest for an apply and an undo, its idempotency, the notes and
// the files it writes. No real CLI or API is ever called.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { DigestSlide, DocMeta } from '../shared/types.ts';
import { HttpError } from '../server/config.ts';
import { createCourse, updateCourse, writeCourseMarkdown } from '../server/courses.ts';
import {
  getDigestInfo,
  isDigestRunning,
  lockDigest,
  remapDigest,
  rewriteDigestMarkdown,
  startDigest,
  waitForDigest,
} from '../server/digest.ts';
import type { DigestDeps, DigestPrompts } from '../server/digest.ts';
import { smsg } from '../server/i18n.ts';
import type { DeckMap, DigestRecord } from '../server/internal-types.ts';
import { coursePaths, docPaths, textFileName } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import type { Provider, ProviderRunInput } from '../server/providers/types.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-versions-digest-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A ready document (doc.json + extracted texts); called again it sets the new page count, as the swap does. */
async function writeDoc(docId: string, pages: number, title = 'L7 Parsing', deckRev = 0): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.textDir, { recursive: true });
  await fs.mkdir(paths.slidesDir, { recursive: true });
  const meta: StoredDocMeta & Pick<DocMeta, 'deckRev'> = {
    id: docId,
    title,
    fileName: `${title}.pdf`,
    pageCount: pages,
    aspectRatio: 16 / 9,
    status: 'ready',
    progress: pages,
    createdAt: new Date().toISOString(),
  };
  if (deckRev > 0) meta.deckRev = deckRev;
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
  for (let n = 1; n <= pages; n++) await fs.writeFile(path.join(paths.textDir, textFileName(n, pages)), `text of slide ${n}`);
}

function entry(slide: number, name = `Old ${slide}`): DigestSlide {
  return { slide, title: name, markdown: `body of ${name}` };
}

/** A finished Korean digest of `pages` slides ("Old N"). */
function oldRecord(pages: number, extra: Partial<DigestRecord> = {}): DigestRecord {
  return {
    version: 1,
    status: 'ready',
    provider: 'claude-code',
    model: 'default-model',
    startedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:10:00.000Z',
    slides: Array.from({ length: pages }, (_, i) => entry(i + 1)),
    summary: 'Old summary',
    ...extra,
  };
}

async function writeRecord(docId: string, record: DigestRecord): Promise<void> {
  await fs.mkdir(docPaths(docId).digestDir, { recursive: true });
  await fs.writeFile(docPaths(docId).digestJson, JSON.stringify(record));
}

async function readRecord(docId: string): Promise<DigestRecord> {
  return JSON.parse(await fs.readFile(docPaths(docId).digestJson, 'utf8')) as DigestRecord;
}

const digestFile = (docId: string, name: string) => path.join(docPaths(docId).digestDir, name);

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A swap from deck `fromRev`: the new deck's slides without an old one are `added`. */
function deckMap(fromRev: number, oldToNew: (number | null)[], newPageCount: number, changed: number[], restoreRev?: number): DeckMap {
  const continued = new Set(oldToNew.filter((slide) => slide !== null));
  const map: DeckMap = {
    fromRev,
    toRev: fromRev + 1,
    oldPageCount: oldToNew.length,
    newPageCount,
    oldToNew,
    changed: new Set(changed),
    added: new Set(range(1, newPageCount).filter((slide) => !continued.has(slide))),
  };
  if (restoreRev !== undefined) map.restoreRev = restoreRev;
  return map;
}

// The swap used by most tests. Old deck 1..6 → new deck 1..6: old 1 → 1, old 2 → 2 (changed), old 3 removed,
// old 4 → 4, old 5 → 3 (moved), old 6 → 6, new 5 added.
const APPLY = deckMap(0, [1, 2, null, 4, 3, 6], 6, [2]);
// Its undo: the new deck's slides back to the old numbers; the changed slide and the removed one are not `same`.
const UNDO = deckMap(1, [1, 2, 5, 4, null, 6], 6, [2], 0);

// A fake provider for the jobs (only its calls matter here).
const STAND_IN_PROMPTS: DigestPrompts = {
  batchSize: 4,
  systemPrompt: () => 'DIGEST',
  buildBatchParts: (input) => input.slides.map((s) => ({ type: 'image', path: s.imagePath, detail: 'high', label: `Slide ${s.slide}` })),
  parseOutput: (_output, expected) => expected.map((slide) => ({ slide, title: `New ${slide}`, markdown: `body of New ${slide}` })),
  summarySystemPrompt: () => 'SUMMARY',
  buildSummaryParts: () => [{ type: 'text', text: 'summarize' }],
};

interface FakeProvider extends Provider {
  calls: ProviderRunInput[];
}

function fakeProvider(wait: Promise<void> = Promise.resolve()): FakeProvider {
  const provider: FakeProvider = {
    id: 'claude-code',
    label: 'Fake',
    kind: 'cli',
    models: [],
    defaultModel: 'default-model',
    maxImagesPerConversation: 90,
    calls: [],
    detect: async () => ({ available: true }),
    run: async (input) => {
      provider.calls.push(input);
      await wait;
      return { text: input.systemPrompt === 'SUMMARY' ? 'New summary' : 'digest', resume: {} };
    },
  };
  return provider;
}

function depsFor(provider: FakeProvider, overrides: Partial<DigestDeps> = {}): DigestDeps {
  return {
    getProvider: (id) => (id === provider.id ? provider : undefined),
    checkProvider: async () => ({ available: true }),
    prompts: STAND_IN_PROMPTS,
    concurrency: () => 2,
    now: () => new Date(),
    ...overrides,
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function isHttpError(status: number, message?: () => string) {
  return (err: unknown) => err instanceof HttpError && err.status === status && (!message || err.message === message());
}

const slidesOf = (input: ProviderRunInput) =>
  input.parts.flatMap((part) => (part.type === 'image' ? [Number(part.label.replace(/^Slide /, ''))] : []));

// ---------------------------------------------------------------------------
// lockDigest
// ---------------------------------------------------------------------------

describe('lockDigest', () => {
  test('409 while a job runs; while held no job starts and DIGEST.md is not rewritten; release is idempotent', async () => {
    const docId = 'lock-000001';
    await writeDoc(docId, 3);
    const running = gate();
    await startDigest(docId, { provider: 'claude-code' }, depsFor(fakeProvider(running.promise)));
    assert.throws(() => lockDigest(docId), isHttpError(409, () => smsg().library.versions.busyDigest));
    running.open();
    assert.equal(await waitForDigest(docId), true);
    assert.equal((await getDigestInfo(docId)).status, 'ready');

    const first = lockDigest(docId);
    const second = lockDigest(docId);
    const deps = depsFor(fakeProvider());
    await assert.rejects(startDigest(docId, { provider: 'claude-code', force: true }, deps), isHttpError(409, () => smsg().library.versions.swapping));
    assert.equal(isDigestRunning(docId), false);

    // A rename while the deck is swapped: DIGEST.md keeps its title until the swap rewrites it.
    await writeDoc(docId, 3, 'Renamed');
    await rewriteDigestMarkdown(docId);
    assert.match(await fs.readFile(docPaths(docId).digestMd, 'utf8'), /^# L7 Parsing — 정리본/);

    first();
    first(); // idempotent: the second holder still holds it
    await assert.rejects(startDigest(docId, { provider: 'claude-code', force: true }, deps), isHttpError(409));
    await rewriteDigestMarkdown(docId);
    assert.match(await fs.readFile(docPaths(docId).digestMd, 'utf8'), /^# L7 Parsing — 정리본/);

    second();
    await rewriteDigestMarkdown(docId);
    assert.match(await fs.readFile(docPaths(docId).digestMd, 'utf8'), /^# Renamed — 정리본/);
    await startDigest(docId, { provider: 'claude-code', force: true }, deps);
    assert.equal(await waitForDigest(docId), true);
    assert.equal((await getDigestInfo(docId)).status, 'ready');
  });

  test('a start that read the deck before a swap does not run after it', async () => {
    const docId = 'lock-race-000001';
    await writeDoc(docId, 2);
    const checked = gate();
    const deps = depsFor(fakeProvider(), {
      checkProvider: async () => {
        await checked.promise;
        return { available: true };
      },
    });
    const start = startDigest(docId, { provider: 'claude-code' }, deps);
    // The whole swap happens while the start waits for the provider check.
    lockDigest(docId)();
    checked.open();
    await assert.rejects(start, isHttpError(409, () => smsg().library.versions.swapping));
    assert.equal(isDigestRunning(docId), false);
    assert.equal(await exists(docPaths(docId).digestJson), false);
  });
});

// ---------------------------------------------------------------------------
// remapDigest
// ---------------------------------------------------------------------------

describe('remapDigest', () => {
  test('apply: same slides renumbered, changed and removed ones dropped, summary stale with a note; snapshot, DIGEST.md', async () => {
    const docId = 'apply-000001';
    await writeDoc(docId, 6);
    const before = oldRecord(6);
    await writeRecord(docId, before);
    await writeDoc(docId, 6, 'L7 Parsing v2', 1); // the swap updates doc.json first

    await remapDigest(docId, APPLY, 'L7 Parsing v2');
    const record = await readRecord(docId);
    assert.deepEqual(record.slides, [entry(1, 'Old 1'), { ...entry(5, 'Old 5'), slide: 3 }, entry(4, 'Old 4'), entry(6, 'Old 6')]);
    assert.equal(record.summary, 'Old summary');
    assert.equal(record.summaryStale, true);
    assert.equal(record.status, 'ready');
    assert.equal(record.error, '새 버전으로 바뀐 장 2개를 다시 정리해야 해요.');
    assert.equal(record.updatedAt, before.updatedAt);
    assert.deepEqual(await readJson(digestFile(docId, 'digest-r0.json')), before);
    assert.deepEqual(await readJson(digestFile(docId, 'deck.json')), { rev: 1 });

    const md = await fs.readFile(docPaths(docId).digestMd, 'utf8');
    assert.match(md, /^# L7 Parsing v2 — 정리본\n\n_\(미완성 정리본: 4\/6 슬라이드\)_\n/);
    assert.match(md, /## Slide 3 · Old 5\n\n!\[slide 3\]\(slides\/003\.png\)\n\nbody of Old 5\n/);
    assert.doesNotMatch(md, /Old 2|Old 3/);

    const info = await getDigestInfo(docId);
    assert.equal(info.done, 4);
    assert.equal(info.total, 6);
    assert.equal(info.error, '새 버전으로 바뀐 장 2개를 다시 정리해야 해요.');
  });

  test('idempotent: a second call does nothing; a swap resumed after a crash remaps its snapshot, not its result', async () => {
    const docId = 'again-000001';
    await writeDoc(docId, 6);
    await writeRecord(docId, oldRecord(6));
    await remapDigest(docId, APPLY, 'L7 Parsing');
    const once = await readRecord(docId);

    await remapDigest(docId, APPLY, 'L7 Parsing');
    assert.deepEqual(await readRecord(docId), once);

    // The server stopped after digest.json was written but before the mark.
    await fs.rm(digestFile(docId, 'deck.json'));
    await remapDigest(docId, APPLY, 'L7 Parsing');
    assert.deepEqual(await readRecord(docId), once);
    assert.deepEqual(await readJson(digestFile(docId, 'deck.json')), { rev: 1 });
  });

  test('undo: the slides that were not same come back from the snapshot with the summary and the state', async () => {
    const docId = 'undo-000001';
    await writeDoc(docId, 6);
    const original = oldRecord(6, { error: '강의 요약을 만들지 못했습니다: busy', summaryStale: true });
    await writeRecord(docId, original);
    const course = await createCourse('Compiler');
    await updateCourse(course.id, { docIds: [docId] });
    await remapDigest(docId, APPLY, 'L7 Parsing');

    // 이어서 만들기 on the new deck: the changed and added slides, a redo of slide 1, a new summary.
    const continued = await readRecord(docId);
    continued.slides = [
      { ...entry(1, 'Old 1'), markdown: 'redone' },
      entry(2, 'New 2'),
      continued.slides[1],
      continued.slides[2],
      entry(5, 'New 5'),
      continued.slides[3],
    ];
    continued.summary = 'New summary';
    delete continued.summaryStale;
    delete continued.error;
    await writeRecord(docId, continued);
    await writeCourseMarkdown(course.id);
    assert.match(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /New summary/);

    await remapDigest(docId, UNDO, 'L7 Parsing');
    const record = await readRecord(docId);
    assert.deepEqual(record.slides, [{ ...entry(1, 'Old 1'), markdown: 'redone' }, entry(2), entry(3), entry(4), entry(5), entry(6)]);
    assert.equal(record.summary, 'Old summary');
    assert.equal(record.summaryStale, true);
    assert.equal(record.error, original.error);
    assert.equal(record.status, 'ready');
    assert.equal(await exists(digestFile(docId, 'digest-r0.json')), false, 'the snapshot is consumed');
    assert.equal(await exists(digestFile(docId, 'digest-r1.json')), false);
    assert.deepEqual(await readJson(digestFile(docId, 'deck.json')), { rev: 2 });
    assert.doesNotMatch(await fs.readFile(docPaths(docId).digestMd, 'utf8'), /미완성|New/);
    assert.match(await fs.readFile(coursePaths(course.id).courseMd, 'utf8'), /## 1\. L7 Parsing\n\nOld summary\n/);

    // Again (a resumed undo): nothing changes.
    await remapDigest(docId, UNDO, 'L7 Parsing');
    assert.deepEqual(await readRecord(docId), record);
  });

  test('undo right after the apply gives the digest back as it was', async () => {
    const docId = 'undo-direct-000001';
    await writeDoc(docId, 6);
    const original = oldRecord(6, { status: 'aborted', error: '사용자가 정리본 만들기를 중단했습니다' });
    original.slides = original.slides.filter((e) => e.slide !== 3);
    await writeRecord(docId, original);
    await remapDigest(docId, APPLY, 'L7 Parsing');
    await remapDigest(docId, UNDO, 'L7 Parsing');
    assert.deepEqual(await readRecord(docId), original);
  });

  test('the note is in the digest language; a running record becomes aborted; an unchanged deck keeps everything', async () => {
    const docId = 'english-000001';
    await writeDoc(docId, 3);
    await writeRecord(docId, oldRecord(3, { lang: 'en', status: 'running' }));
    // Only moved: nothing to redo, but the summary may cite the old numbers.
    await remapDigest(docId, deckMap(0, [2, 1, 3], 3, []), 'Parsing');
    let record = await readRecord(docId);
    assert.equal(record.status, 'aborted');
    assert.equal(record.error, 'The lecture summary needs to be made again for the new version.');
    assert.equal(record.summaryStale, true);
    assert.deepEqual(record.slides.map((e) => [e.slide, e.title]), [[1, 'Old 2'], [2, 'Old 1'], [3, 'Old 3']]);
    assert.match(await fs.readFile(docPaths(docId).digestMd, 'utf8'), /^# Parsing — digest\n/);

    await remapDigest(docId, deckMap(1, [1, 2, 3], 4, [3]), 'Parsing');
    record = await readRecord(docId);
    assert.equal(record.error, '2 slides changed in the new version and need a new digest.');
    assert.deepEqual(record.slides.map((e) => e.slide), [1, 2]);

    const docId2 = 'unchanged-000001';
    await writeDoc(docId2, 3);
    const unchanged = oldRecord(3, { status: 'running', error: 'older note' });
    await writeRecord(docId2, unchanged);
    await remapDigest(docId2, deckMap(0, [1, 2, 3], 3, []), 'L7 Parsing');
    record = await readRecord(docId2);
    assert.deepEqual(record.slides, unchanged.slides);
    assert.equal(record.summaryStale, undefined);
    assert.equal(record.status, 'aborted');
    assert.equal(record.error, smsg('ko').chat.digest.interrupted);
  });

  test('without a digest only the mark; an undo without a snapshot works like an apply; an apply drops older snapshots', async () => {
    const docId = 'none-000001';
    await writeDoc(docId, 6);
    await remapDigest(docId, APPLY, 'L7 Parsing');
    // A digest made from now on is numbered in the new deck.
    assert.deepEqual(await fs.readdir(docPaths(docId).digestDir), ['deck.json']);
    assert.deepEqual(await readJson(digestFile(docId, 'deck.json')), { rev: 1 });
    assert.equal(await exists(docPaths(docId).digestMd), false);

    // A digest made on the new deck, then the swap undone: there is nothing to restore.
    await writeRecord(docId, oldRecord(6));
    await remapDigest(docId, UNDO, 'L7 Parsing');
    let record = await readRecord(docId);
    assert.deepEqual(record.slides.map((e) => [e.slide, e.title]), [[1, 'Old 1'], [4, 'Old 4'], [5, 'Old 3'], [6, 'Old 6']]);
    assert.equal(record.error, '새 버전으로 바뀐 장 2개를 다시 정리해야 해요.');
    assert.equal(await exists(digestFile(docId, 'digest-r1.json')), false);

    // Applying twice: only the latest apply can be undone, so only its snapshot is kept.
    await remapDigest(docId, deckMap(2, range(1, 6), 7, [1]), 'L7 Parsing');
    await remapDigest(docId, deckMap(3, range(1, 7), 7, [2]), 'L7 Parsing');
    assert.equal(await exists(digestFile(docId, 'digest-r2.json')), false);
    assert.equal(await exists(digestFile(docId, 'digest-r3.json')), true);
    record = await readRecord(docId);
    assert.deepEqual(record.slides.map((e) => e.slide), [4, 5, 6]);
  });

  test('an undo of an apply that gave the digest up only marks it; a digest of another deck is left alone', async () => {
    const docId = 'gaveup-000001';
    await writeDoc(docId, 6);
    const original = oldRecord(6);
    await writeRecord(docId, original);
    // The apply kept its snapshot, then gave up before it renumbered anything (no mark: deck 0).
    await fs.writeFile(digestFile(docId, 'digest-r0.json'), JSON.stringify(original));
    await remapDigest(docId, UNDO, 'L7 Parsing');
    assert.deepEqual(await readRecord(docId), original, 'already in the deck that came back');
    assert.deepEqual(await readJson(digestFile(docId, 'deck.json')), { rev: 2 });
    assert.equal(await exists(digestFile(docId, 'digest-r0.json')), false, 'nothing to bring back');

    // A swap from deck 4 while the digest is numbered in deck 2: nothing renumbered, no snapshot.
    await remapDigest(docId, deckMap(4, [1, 2, null, 4, 3, 6], 6, [2]), 'L7 Parsing');
    assert.deepEqual(await readRecord(docId), original);
    assert.deepEqual(await readJson(digestFile(docId, 'deck.json')), { rev: 2 });
    assert.equal(await exists(digestFile(docId, 'digest-r4.json')), false);
  });

  test('a job after the swap redoes only the changed and added slides, then the summary', async () => {
    const docId = 'continue-000001';
    await writeDoc(docId, 6);
    await writeRecord(docId, oldRecord(6));
    await writeDoc(docId, 6, 'L7 Parsing', 1);
    await remapDigest(docId, APPLY, 'L7 Parsing');

    const provider = fakeProvider();
    await startDigest(docId, { provider: 'claude-code' }, depsFor(provider));
    assert.equal(await waitForDigest(docId), true);
    assert.deepEqual(provider.calls.filter((c) => c.systemPrompt === 'DIGEST').map(slidesOf), [[2], [5]]);
    assert.equal(provider.calls.filter((c) => c.systemPrompt === 'SUMMARY').length, 1);
    const info = await getDigestInfo(docId);
    assert.equal(info.status, 'ready');
    assert.equal(info.done, 6);
    assert.equal(info.summary, 'New summary');
    assert.equal(info.error, undefined);
    assert.equal((await readRecord(docId)).summaryStale, undefined);
  });
});
