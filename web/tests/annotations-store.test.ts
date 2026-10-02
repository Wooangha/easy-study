// The annotation store (DESIGN §25, lib/annotations/store.ts) with a fake API, EventSource and timers: optimistic
// ops, one PATCH in flight per slide (ops meanwhile go out next), ops events applied in rev order, a rev gap → refetch,
// the 409 rebase then the second-409 replace, the network retry and the "저장 안 됨" mark, undo / redo through the
// store (and what the toolbar's buttons read of it), the loading window, the own-client echo, the caps that 펜 strokes
// fill (DESIGN §29: the room for the server's recording stamps, an add refused for a full slide), and the held item
// objects a document from the server keeps. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_ANNOTATION_ITEMS,
  MAX_ANNOTATION_OPS,
  MAX_INK_POINTS,
  MAX_INK_STROKES,
  MAX_SLIDE_ANNOTATION_BYTES,
  type AnnotationEvent,
  type AnnotationOp,
  type AnnotationSummary,
  type InkItem,
  type RectItem,
  type SlideAnnotations,
  type TextItem,
} from '../../shared/types.ts';
import { ApiError } from '../src/api.ts';
import { annotationBytes, applyOps, emptySlideAnnotations, RECORDING_STAMP_BYTES, stampRoom } from '../src/lib/annotations/geometry.ts';
import { canRedoIn, canUndoIn } from '../src/lib/annotations/history.ts';
import {
  conflictReloaded,
  DocAnnotations,
  KEEP_RADIUS,
  NETWORK_RETRY_MS,
  parseAnnotationEvent,
  tooManyItems,
  tooMuchOnSlide,
  type StoreDeps,
} from '../src/lib/annotations/store.ts';
import type { EventSourceLike, Timers } from '../src/lib/recording/events.ts';

class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.pending) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  readonly url: string;
  private listeners = new Map<string, Array<(ev: MessageEvent) => unknown>>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (ev: MessageEvent) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  emit(type: string, data: unknown): void {
    const ev = { data: JSON.stringify(data) } as MessageEvent;
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

const NOW = '2026-09-29T10:00:00.000Z';
const rect = (id: string, x = 0.1): RectItem => ({ id, type: 'rect', color: 'yellow', createdAt: NOW, updatedAt: NOW, rect: { x, y: 0.1, w: 0.2, h: 0.1 } });
const doc = (slide: number, rev: number, items: SlideAnnotations['items'] = []): SlideAnnotations => ({ ...emptySlideAnnotations(slide), rev, items, updatedAt: NOW });
const summary = (slides: AnnotationSummary['slides'] = []): AnnotationSummary => ({ version: 1, slides, memos: [], tags: [] });
const conflict = (current: SlideAnnotations) => new ApiError('conflict', 409, null, [], { current });
const offline = () => new ApiError('offline', 0);

function setup(options: { slides?: Record<number, SlideAnnotations>; summary?: AnnotationSummary } = {}) {
  const timers = new FakeTimers();
  const sources: FakeEventSource[] = [];
  const patches: Array<{ slide: number; baseRev: number; ops: AnnotationOp[]; client: string; answer: Deferred<SlideAnnotations> }> = [];
  const slideLoads: number[] = [];
  const toasts: string[] = [];
  let summaryLoads = 0;
  const slides = new Map<number, SlideAnnotations>(Object.entries(options.slides ?? {}).map(([k, v]) => [Number(k), v]));
  const deps: StoreDeps = {
    getSummary: () => {
      summaryLoads++;
      return Promise.resolve(options.summary ?? summary());
    },
    getSlide: (_doc, slide) => {
      slideLoads.push(slide);
      return Promise.resolve(slides.get(slide) ?? doc(slide, 0));
    },
    patch: (_doc, slide, body, client) => {
      const answer = deferred<SlideAnnotations>();
      patches.push({ slide, baseRev: body.baseRev, ops: body.ops, client, answer });
      return answer.promise;
    },
    eventsUrl: (docId, client) => `/api/docs/${docId}/annotations/events?client=${client}`,
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    timers,
    toast: (message) => void toasts.push(message),
    now: () => timers.now,
  };
  const store = new DocAnnotations('doc-1', deps);
  const unsubscribe = store.subscribe(() => {});
  const last = () => patches[patches.length - 1];
  const es = () => sources[sources.length - 1];
  const slide = (n: number) => store.snapshot.slides.get(n);
  return { store, timers, sources, patches, slideLoads, toasts, unsubscribe, last, es, slide, summaryLoads: () => summaryLoads };
}

const A = 'an-0000000000aa';
const B = 'an-0000000000bb';
const C = 'an-0000000000cc';

describe('DocAnnotations: optimistic writes', () => {
  test('mutate applies at once and PATCHes with the held rev and the client id; the answer replaces the document', async () => {
    const t = setup({ slides: { 3: doc(3, 2) } });
    await store_loaded(t, 3);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: rect(A) }]), true);
    assert.equal(t.slide(3)?.items.length, 1);
    assert.equal(t.slide(3)?.rev, 2, 'the rev is the server’s until it answers');
    assert.equal(t.patches.length, 1);
    assert.equal(t.last().baseRev, 2);
    assert.equal(t.last().client, t.store.clientId);
    assert.match(t.store.clientId, /^[0-9a-f]{16}$/);
    assert.ok(t.es().url.endsWith(`?client=${t.store.clientId}`));
    t.last().answer.resolve(doc(3, 3, [{ ...rect(A), updatedAt: 'server' }]));
    await tick();
    assert.equal(t.slide(3)?.rev, 3);
    assert.equal(t.slide(3)?.items[0].updatedAt, 'server', 'the server’s normalised form wins');
    assert.equal(t.store.mutate(3, [{ op: 'remove', id: 'an-0000000000zz' }]), false, 'nothing to change: nothing sent');
    assert.equal(t.patches.length, 1);
    t.unsubscribe();
  });

  test('one request in flight per slide: ops meanwhile go out in the next one with the returned rev', async () => {
    const t = setup({ slides: { 3: doc(3, 0) } });
    await store_loaded(t, 3);
    t.store.mutate(3, [{ op: 'add', item: rect(A) }]);
    t.store.mutate(3, [{ op: 'add', item: rect(B) }]);
    t.store.mutate(3, [{ op: 'update', id: B, patch: { color: 'blue' } }]);
    assert.equal(t.patches.length, 1);
    assert.equal(t.slide(3)?.items.length, 2, 'both applied locally');
    t.last().answer.resolve(doc(3, 1, [rect(A)]));
    await tick();
    assert.equal(t.patches.length, 2);
    assert.equal(t.last().baseRev, 1);
    assert.deepEqual(t.last().ops.map((o) => o.op), ['add', 'update']);
    assert.equal(t.slide(3)?.items.length, 2, 'the pending ops stay on top of the server’s answer');
    assert.equal(t.slide(3)?.items[1].color, 'blue');
    t.last().answer.resolve(doc(3, 2, [rect(A), { ...rect(B), color: 'blue' }]));
    await tick();
    assert.equal(t.patches.length, 2);
    assert.equal(t.slide(3)?.rev, 2);
    t.unsubscribe();
  });

  test('a group action on more items than the server takes per PATCH goes out in several PATCHes, in order, as one undo step', async () => {
    const items = Array.from({ length: 150 }, (_, i) => rect(`an-${String(i).padStart(12, '0')}`));
    const t = setup({ slides: { 3: doc(3, 1, items) } });
    await store_loaded(t, 3);
    // 범위 선택 over all 150, 🗑 삭제: one mutation of 150 removes.
    assert.equal(t.store.mutate(3, items.map((it) => ({ op: 'remove' as const, id: it.id }))), true);
    assert.equal(t.slide(3)?.items.length, 0, 'applied at once');
    assert.equal(t.store.snapshot.history.undo.length, 1, 'one undo entry');
    assert.equal(t.patches.length, 1);
    assert.equal(t.last().ops.length, MAX_ANNOTATION_OPS);
    assert.deepEqual(t.last().ops.map((o) => (o.op === 'remove' ? o.id : '')), items.slice(0, MAX_ANNOTATION_OPS).map((it) => it.id));
    t.last().answer.resolve(doc(3, 2, items.slice(MAX_ANNOTATION_OPS)));
    await tick();
    assert.equal(t.patches.length, 2, 'the rest follows with the returned rev');
    assert.equal(t.last().baseRev, 2);
    assert.equal(t.last().ops.length, 50);
    assert.deepEqual(t.last().ops.map((o) => (o.op === 'remove' ? o.id : '')), items.slice(MAX_ANNOTATION_OPS).map((it) => it.id));
    t.last().answer.resolve(doc(3, 3, []));
    await tick();
    assert.equal(t.patches.length, 2);
    assert.equal(t.slide(3)?.rev, 3);
    // ⌘Z: the 150 re-adds, in z-order, again in two PATCHes.
    assert.deepEqual(t.store.undo(), { slide: 3, itemId: items[0].id });
    assert.equal(t.slide(3)?.items.length, 150);
    assert.deepEqual(t.slide(3)?.items.map((it) => it.id), items.map((it) => it.id), 'the original order');
    assert.equal(t.patches.length, 3);
    assert.equal(t.last().ops.length, MAX_ANNOTATION_OPS);
    t.last().answer.resolve(doc(3, 4, items.slice(0, MAX_ANNOTATION_OPS)));
    await tick();
    assert.equal(t.patches.length, 4);
    assert.equal(t.last().ops.length, 50);
    t.last().answer.resolve(doc(3, 5, items));
    await tick();
    assert.equal(t.slide(3)?.rev, 5);
    assert.equal(t.slide(3)?.items.length, 150);
    t.unsubscribe();
  });

  test('a slide not loaded yet starts from an empty document (the 409 rebases onto the server’s)', async () => {
    const t = setup({ slides: { 9: doc(9, 4, [rect(C)]) } });
    t.store.mutate(9, [{ op: 'add', item: rect(A) }]);
    assert.equal(t.slide(9)?.items.length, 1);
    assert.equal(t.last().baseRev, 0);
    t.last().answer.reject(conflict(doc(9, 4, [rect(C)])));
    await tick();
    assert.equal(t.patches.length, 2);
    assert.equal(t.last().baseRev, 4);
    assert.deepEqual(t.slide(9)?.items.map((i) => i.id), [C, A]);
    t.unsubscribe();
  });
});

describe('DocAnnotations: conflicts and failures', () => {
  test('a 409 is rebased (their document + our ops that still apply) and retried once; a second 409 replaces the document', async () => {
    const t = setup({ slides: { 3: doc(3, 1, [rect(A)]) } });
    await store_loaded(t, 3);
    t.store.mutate(3, [{ op: 'update', id: A, patch: { color: 'blue' } }, { op: 'add', item: rect(B) }]);
    t.store.mutate(3, [{ op: 'update', id: B, patch: { color: 'pink' } }]); // pending behind the flight
    // Meanwhile another device deleted A and added C.
    const theirs = doc(3, 2, [rect(C)]);
    t.last().answer.reject(conflict(theirs));
    await tick();
    assert.equal(t.patches.length, 2);
    assert.equal(t.last().baseRev, 2);
    assert.deepEqual(
      t.last().ops.map((o) => `${o.op}:${'id' in o ? o.id : 'item' in o ? o.item.id : ''}`),
      [`add:${B}`, `update:${B}`],
      'the update of the deleted A is dropped; our add and its pending update stay',
    );
    assert.deepEqual(t.slide(3)?.items.map((i) => i.id), [C, B]);
    assert.equal(t.slide(3)?.items[1].color, 'pink');
    assert.deepEqual(t.toasts, []);
    // Twice in a row: theirs, and a word about it; the slide's undo entries are gone.
    const theirsAgain = doc(3, 3, [rect(C), rect(B)]);
    t.last().answer.reject(conflict(theirsAgain));
    await tick();
    assert.equal(t.patches.length, 2);
    assert.deepEqual(t.slide(3), theirsAgain);
    assert.deepEqual(t.toasts, [conflictReloaded()]);
    assert.equal(t.store.canUndo, false);
    // The next write starts clean (a 409 rebases again).
    t.store.mutate(3, [{ op: 'remove', id: B }]);
    assert.equal(t.last().baseRev, 3);
    t.unsubscribe();
  });

  test('a network failure keeps the local state, retries once after 2 s, then marks the slide unsaved until a write succeeds', async () => {
    const t = setup({ slides: { 3: doc(3, 1) } });
    await store_loaded(t, 3);
    t.store.mutate(3, [{ op: 'add', item: rect(A) }]);
    t.last().answer.reject(offline());
    await tick();
    assert.equal(t.slide(3)?.items.length, 1);
    assert.equal(t.patches.length, 1);
    t.timers.advance(NETWORK_RETRY_MS - 1);
    assert.equal(t.patches.length, 1);
    t.timers.advance(1);
    assert.equal(t.patches.length, 2);
    assert.deepEqual(t.last().ops.map((o) => o.op), ['add']);
    t.last().answer.reject(offline());
    await tick();
    assert.ok(t.store.snapshot.unsaved.has(3));
    assert.equal(t.patches.length, 2, 'no more retries by itself');
    // Back online: flushAll sends what waits; success clears the mark.
    t.store.flushAll();
    assert.equal(t.patches.length, 3);
    t.last().answer.resolve(doc(3, 2, [rect(A)]));
    await tick();
    assert.equal(t.store.snapshot.unsaved.has(3), false);
    t.unsubscribe();
  });

  test('a refused write (400) drops its ops, says why and reloads the slide', async () => {
    const t = setup({ slides: { 3: doc(3, 1) } });
    await store_loaded(t, 3);
    t.store.mutate(3, [{ op: 'add', item: rect(A) }]);
    t.last().answer.reject(new ApiError('필기 항목이 올바르지 않습니다', 400));
    await tick();
    assert.equal(t.toasts.length, 1);
    assert.match(t.toasts[0], /필기 항목이 올바르지 않습니다/);
    await tick();
    assert.equal(t.slide(3)?.items.length, 0, 'reloaded from the server');
    t.unsubscribe();
  });
});

describe('DocAnnotations: the stream', () => {
  test('a slide event with the next rev is applied with the same reducer; an older rev (our own echo) is ignored', async () => {
    const t = setup({ slides: { 3: doc(3, 1, [rect(A)]) } });
    await store_loaded(t, 3);
    t.es().open();
    const ops: AnnotationOp[] = [{ op: 'update', id: A, patch: { color: 'green' } }, { op: 'add', item: rect(B) }];
    t.es().emit('slide', { type: 'slide', slide: 3, rev: 2, updatedAt: 'later', ops } satisfies AnnotationEvent);
    assert.equal(t.slide(3)?.rev, 2);
    assert.equal(t.slide(3)?.updatedAt, 'later');
    assert.deepEqual(t.slide(3)?.items, applyOps(doc(3, 1, [rect(A)]), ops).items);
    t.es().emit('slide', { type: 'slide', slide: 3, rev: 2, updatedAt: 'x', ops: [{ op: 'remove', id: A }] });
    t.es().emit('slide', { type: 'slide', slide: 3, rev: 1, updatedAt: 'x', ops: [{ op: 'remove', id: A }] });
    assert.equal(t.slide(3)?.items.length, 2, 'an old rev changes nothing');
    assert.deepEqual(t.slideLoads, [3]);
    t.unsubscribe();
  });

  test('a rev gap refetches the slide; an event during a flight is applied by a refetch after it', async () => {
    const t = setup({ slides: { 3: doc(3, 1) } });
    await store_loaded(t, 3);
    t.es().open();
    t.es().emit('slide', { type: 'slide', slide: 3, rev: 5, updatedAt: 'x', ops: [] });
    await tick();
    assert.deepEqual(t.slideLoads, [3, 3]);
    // During a flight: not applied now.
    t.store.mutate(3, [{ op: 'add', item: rect(A) }]);
    t.es().emit('slide', { type: 'slide', slide: 3, rev: 2, updatedAt: 'x', ops: [{ op: 'add', item: rect(B) }] });
    assert.equal(t.slide(3)?.items.length, 1);
    t.last().answer.resolve(doc(3, 3, [rect(B), rect(A)]));
    await tick();
    assert.deepEqual(t.slideLoads, [3, 3, 3], 'refetched after the flight');
    t.unsubscribe();
  });

  test('a slide-reset replaces the document; summary events refetch the summary (debounced); qa reaches its listeners', async () => {
    const t = setup({ slides: { 3: doc(3, 1, [rect(A)]) } });
    await store_loaded(t, 3);
    t.es().open();
    const qa: string[] = [];
    t.store.onQa((c) => qa.push(`${c.sessionId}:${c.updatedAt}`));
    t.es().emit('slide-reset', { type: 'slide-reset', annotations: doc(3, 4, [rect(C)]) });
    assert.deepEqual(t.slide(3)?.items.map((i) => i.id), [C]);
    assert.equal(t.slide(3)?.rev, 4);
    const before = t.summaryLoads();
    t.es().emit('summary', { type: 'summary' });
    t.es().emit('summary', { type: 'summary' });
    t.timers.advance(600);
    await tick();
    assert.equal(t.summaryLoads(), before + 1);
    t.es().emit('qa', { type: 'qa', sessionId: 's1', updatedAt: NOW });
    t.es().emit('qa', { type: 'qa', sessionId: 's2', updatedAt: null });
    assert.deepEqual(qa, [`s1:${NOW}`, 's2:null']);
    t.unsubscribe();
  });

  test('after a reconnect the summary is loaded again and held slides whose rev differs are refetched', async () => {
    const t = setup({ slides: { 3: doc(3, 1), 4: doc(4, 2, [rect(A)]) }, summary: summary([{ slide: 4, rev: 7, items: 1, memos: 0, tags: [] }]) });
    await store_loaded(t, 3);
    await store_loaded(t, 4);
    t.es().open();
    const loads = t.slideLoads.length;
    t.es().close();
    t.es().onerror?.(new Event('error'));
    t.timers.advance(2000);
    t.es().open();
    await tick();
    await tick();
    assert.deepEqual(t.slideLoads.slice(loads), [4], 'slide 3 (no items, not in the summary) is fine; slide 4 is stale');
    t.unsubscribe();
  });

  test('parseAnnotationEvent accepts the event object or the bare payload and drops malformed frames', () => {
    assert.deepEqual(parseAnnotationEvent('ping', ''), { type: 'ping' });
    assert.deepEqual(parseAnnotationEvent('summary', '{}'), { type: 'summary' });
    assert.deepEqual(parseAnnotationEvent('qa', JSON.stringify({ sessionId: 's', updatedAt: null })), { type: 'qa', sessionId: 's', updatedAt: null });
    assert.equal(parseAnnotationEvent('slide', JSON.stringify({ slide: 1 })), null);
    assert.equal(parseAnnotationEvent('slide', '{not json'), null);
    assert.equal(parseAnnotationEvent('slide-reset', JSON.stringify({ annotations: { slide: 1 } })), null);
    assert.equal(parseAnnotationEvent('slide-reset', JSON.stringify(doc(2, 1)))?.type, 'slide-reset');
    const ev = parseAnnotationEvent('message', JSON.stringify({ type: 'slide', slide: 2, rev: 3, updatedAt: 'x', ops: [{ op: 'remove', id: A }, 'junk'] }));
    assert.deepEqual(ev, { type: 'slide', slide: 2, rev: 3, updatedAt: 'x', ops: [{ op: 'remove', id: A }] });
  });
});

describe('DocAnnotations: undo / redo, the window, the lifetime', () => {
  test('undo sends the inverse ops, redo the ops again; entries whose items vanished are skipped', async () => {
    const t = setup({ slides: { 3: doc(3, 1) } });
    await store_loaded(t, 3);
    t.store.mutate(3, [{ op: 'add', item: rect(A) }]);
    t.last().answer.resolve(doc(3, 2, [rect(A)]));
    await tick();
    t.store.mutate(3, [{ op: 'update', id: A, patch: { color: 'blue' } }]);
    t.last().answer.resolve(doc(3, 3, [{ ...rect(A), color: 'blue' }]));
    await tick();
    assert.deepEqual(t.store.undo(), { slide: 3, itemId: A });
    assert.equal(t.slide(3)?.items[0].color, 'yellow');
    assert.deepEqual(t.last().ops, [{ op: 'update', id: A, patch: { color: 'yellow' } }]);
    t.last().answer.resolve(doc(3, 4, [rect(A)]));
    await tick();
    assert.deepEqual(t.store.redo(), { slide: 3, itemId: A });
    assert.equal(t.slide(3)?.items[0].color, 'blue');
    t.last().answer.resolve(doc(3, 5, [{ ...rect(A), color: 'blue' }]));
    await tick();
    assert.equal(t.store.canRedo, false);
    // Another device removes A: the remaining entries about it no longer apply and are dropped.
    t.es().open();
    t.es().emit('slide', { type: 'slide', slide: 3, rev: 6, updatedAt: 'x', ops: [{ op: 'remove', id: A }] });
    assert.equal(t.store.undo(), null);
    assert.equal(t.store.canUndo, false);
    t.unsubscribe();
  });

  test('setWindow loads the slides around the focus (more at a small zoom) and drops those far away', async () => {
    const t = setup();
    t.store.setWindow(10, 1, 60);
    assert.deepEqual([...t.slideLoads].sort((a, b) => a - b), [7, 8, 9, 10, 11, 12, 13]);
    await tick();
    t.store.setWindow(10, 0.5, 60);
    assert.deepEqual([...new Set(t.slideLoads)].sort((a, b) => a - b), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    await tick();
    t.store.setWindow(1, 1, 60);
    await tick();
    assert.deepEqual([...t.store.snapshot.slides.keys()].filter((s) => s > 1 + KEEP_RADIUS), []);
    assert.ok(t.store.snapshot.slides.has(4));
    // The edge of the deck: clamped.
    t.store.setWindow(60, 1, 60);
    assert.ok(!t.slideLoads.includes(61));
    t.unsubscribe();
  });

  test('canUndo / canRedo follow the history and every change of it reaches the subscribers (the toolbar’s 되돌리기 / 다시 실행)', async () => {
    const t = setup({ slides: { 3: doc(3, 1) } });
    await store_loaded(t, 3);
    let calls = 0;
    const off = t.store.subscribe(() => calls++);
    const state = () => [t.store.canUndo, t.store.canRedo, canUndoIn(t.store.snapshot.history), canRedoIn(t.store.snapshot.history)];
    assert.deepEqual(state(), [false, false, false, false]);
    t.store.mutate(3, [{ op: 'add', item: rect(A) }]);
    assert.deepEqual(state(), [true, false, true, false]);
    t.last().answer.resolve(doc(3, 2, [rect(A)]));
    await tick();
    let before = calls;
    t.store.undo();
    assert.deepEqual(state(), [false, true, false, true]);
    assert.ok(calls > before, 'told');
    before = calls;
    t.store.redo();
    assert.deepEqual(state(), [true, false, true, false]);
    assert.ok(calls > before);
    off();
    t.unsubscribe();
  });

  test('the store lingers after its last subscriber and then closes its stream', () => {
    const t = setup();
    assert.equal(t.sources.length, 1);
    t.unsubscribe();
    t.timers.advance(4999);
    assert.equal(t.es().closed, false);
    t.timers.advance(1);
    assert.equal(t.es().closed, true);
  });
});

describe('DocAnnotations: the caps of 펜 strokes (DESIGN §29)', () => {
  const id = (i: number) => `an-${i.toString(16).padStart(12, '0')}`;
  /** A stroke of `points` points (5 characters each). */
  const ink = (itemId: string, points = 1): InkItem => ({
    id: itemId,
    type: 'ink',
    color: 'black',
    createdAt: NOW,
    updatedAt: NOW,
    rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    width: 0.005,
    pts: 'AAAAA'.repeat(points),
  });

  test('strokes are counted apart: a slide full of other items still takes a stroke, but not another item', async () => {
    const rects = Array.from({ length: MAX_ANNOTATION_ITEMS }, (_, i) => rect(id(i)));
    const t = setup({ slides: { 3: doc(3, 1, rects) } });
    await store_loaded(t, 3);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: ink(id(1000)) }]), true);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: rect(id(1001)) }]), false);
    assert.deepEqual(t.toasts, [tooManyItems()]);
    t.unsubscribe();
  });

  test('MAX_INK_STROKES strokes take no more (a toast, nothing sent); another item still fits', async () => {
    const strokes = Array.from({ length: MAX_INK_STROKES }, (_, i) => ink(id(i)));
    const t = setup({ slides: { 3: doc(3, 1, strokes) } });
    await store_loaded(t, 3);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: ink(id(MAX_INK_STROKES)) }]), false);
    assert.deepEqual(t.toasts, ['이 슬라이드에 필기가 너무 많아요']);
    assert.equal(t.patches.length, 0);
    assert.equal(t.slide(3)?.items.length, MAX_INK_STROKES);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: rect(id(MAX_INK_STROKES + 1)) }]), true);
    t.unsubscribe();
  });

  test('a write that would pass MAX_SLIDE_ANNOTATION_BYTES is refused before it is sent; a remove still goes', async () => {
    // As many of the longest strokes as fit: one more would pass the cap.
    const big = (i: number) => ink(id(i), MAX_INK_POINTS);
    const one = annotationBytes(doc(3, 1, [big(0)]));
    const per = annotationBytes(doc(3, 1, [big(0), big(1)])) - one;
    const n = Math.floor((MAX_SLIDE_ANNOTATION_BYTES - (one - per)) / per);
    const strokes = Array.from({ length: n }, (_, i) => big(i));
    assert.ok(annotationBytes(doc(3, 1, strokes)) <= MAX_SLIDE_ANNOTATION_BYTES);
    const t = setup({ slides: { 3: doc(3, 1, strokes) } });
    await store_loaded(t, 3);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: big(n) }]), false);
    assert.deepEqual(t.toasts, [tooMuchOnSlide()]);
    assert.equal(t.patches.length, 0);
    assert.equal(t.store.mutate(3, [{ op: 'remove', id: id(0) }]), true);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: big(n) }]), true, 'room again');
    t.unsubscribe();
  });
});

/** Waits for the store to hold `slide` (loading it through the fake API). */
async function store_loaded(t: ReturnType<typeof setup>, slide: number): Promise<void> {
  await t.store.ensureSlide(slide);
  await tick();
  assert.ok(t.store.snapshot.slides.has(slide));
}

describe('DocAnnotations: a document from the server keeps the held item objects (the views cache per object)', () => {
  const stroke = (itemId: string, x = 0.1): InkItem => ({
    id: itemId,
    type: 'ink',
    color: 'black',
    createdAt: NOW,
    updatedAt: NOW,
    rect: { x, y: 0.1, w: 0.2, h: 0.1 },
    width: 0.005,
    pts: 'AAAAAgggg_____',
  });
  const D = 'an-0000000000dd';
  /** As it comes over the wire: every item a new object. */
  const wire = (d: SlideAnnotations): SlideAnnotations => JSON.parse(JSON.stringify(d));

  test('a write’s answer, a slide-reset and a 409 keep every unchanged item; a changed one (its updatedAt too) is taken', async () => {
    const t = setup({ slides: { 3: doc(3, 1, [stroke(A), rect(B)]) } });
    await store_loaded(t, 3);
    const [a0, b0] = t.slide(3)!.items;
    // A stroke written: the answer brings every item anew, the new one with the server's updatedAt.
    t.store.mutate(3, [{ op: 'add', item: stroke(C, 0.5) }]);
    const optimistic = t.slide(3)!.items[2];
    t.last().answer.resolve(wire(doc(3, 2, [stroke(A), rect(B), { ...stroke(C, 0.5), updatedAt: 'server' }])));
    await tick();
    const [a1, b1, c1] = t.slide(3)!.items;
    assert.equal(a1, a0, 'the stroke written before is the same object: not decoded and outlined again');
    assert.equal(b1, b0);
    assert.notEqual(c1, optimistic);
    assert.equal(c1.updatedAt, 'server', 'the server’s updatedAt is kept');
    // Another device moved A (slide-reset): A is new, the rest stays.
    t.es().open();
    t.es().emit('slide-reset', { type: 'slide-reset', annotations: wire(doc(3, 3, [stroke(A, 0.3), rect(B), { ...stroke(C, 0.5), updatedAt: 'server' }])) });
    const [a2, b2, c2] = t.slide(3)!.items;
    assert.notEqual(a2, a1);
    assert.equal((a2 as InkItem).rect.x, 0.3);
    assert.equal(b2, b1);
    assert.equal(c2, c1);
    // A 409: their document (D added) with our remove on top; the equal items keep their objects.
    t.store.mutate(3, [{ op: 'remove', id: B }]);
    t.last().answer.reject(conflict(wire(doc(3, 4, [stroke(A, 0.3), rect(B), { ...stroke(C, 0.5), updatedAt: 'server' }, rect(D)]))));
    await tick();
    const rebased = t.slide(3)!.items;
    assert.deepEqual(rebased.map((i) => i.id), [A, C, D]);
    assert.equal(rebased[0], a2);
    assert.equal(rebased[1], c2);
    // Twice in a row: theirs is taken, still with the held objects.
    t.last().answer.reject(conflict(wire(doc(3, 5, [stroke(A, 0.3), { ...stroke(C, 0.5), updatedAt: 'server' }]))));
    await tick();
    assert.equal(t.slide(3)!.items[0], a2);
    assert.equal(t.slide(3)!.items[1], c2);
    t.unsubscribe();
  });
});

describe('DocAnnotations: room for the server’s recording stamps, and an add refused for a full slide (DESIGN §29)', () => {
  const S = 'an-0000000000e1';
  const T = 'an-0000000000e2';
  const stroke = (itemId: string, recordedAt?: InkItem['recordedAt']): InkItem => ({
    id: itemId,
    type: 'ink',
    color: 'black',
    createdAt: NOW,
    updatedAt: NOW,
    rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    width: 0.005,
    pts: 'AAAAA'.repeat(40),
    ...(recordedAt ? { recordedAt } : {}),
  });
  const filler = (chars: number): TextItem => ({ id: 'an-0000000000f0', type: 'text', color: 'yellow', createdAt: NOW, updatedAt: NOW, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, text: 'x'.repeat(chars) });
  /** Slide 3 filled so that `free` bytes are left once `adds` are applied. */
  const filled = (free: number, adds: AnnotationOp[]): SlideAnnotations => {
    const bare = applyOps(doc(3, 1, [filler(0)]), adds);
    return doc(3, 1, [filler(MAX_SLIDE_ANNOTATION_BYTES - annotationBytes(bare) - free)]);
  };

  test('an add without its own recordedAt leaves room for the stamp the server adds (another device recording)', async () => {
    const add: AnnotationOp = { op: 'add', item: stroke(S) };
    assert.equal(stampRoom(applyOps(doc(3, 1), [add]), [add]), RECORDING_STAMP_BYTES);
    const t = setup({ slides: { 3: filled(RECORDING_STAMP_BYTES - 10, [add]) } });
    await store_loaded(t, 3);
    assert.equal(t.store.mutate(3, [add]), false, 'it fits only without the stamp');
    assert.deepEqual(t.toasts, [tooMuchOnSlide()]);
    assert.equal(t.patches.length, 0);
    // Stamped here (this device records): no room needed.
    const stamped: AnnotationOp = { op: 'add', item: stroke(S, { rid: 'rec-20261002-100000-abcd', t: 12.5 }) };
    const u = setup({ slides: { 3: filled(5, [stamped]) } });
    await store_loaded(u, 3);
    assert.equal(u.store.mutate(3, [stamped]), true);
    t.unsubscribe();
    u.unsubscribe();
  });

  test('the room counts the adds still in flight and waiting, not only the new one', async () => {
    const first: AnnotationOp = { op: 'add', item: stroke(S) };
    const second: AnnotationOp = { op: 'add', item: stroke(T) };
    // Room for both strokes and one stamp, not two.
    const t = setup({ slides: { 3: filled(RECORDING_STAMP_BYTES + 30, [first, second]) } });
    await store_loaded(t, 3);
    // Alone, the first one has room for its stamp (the second's bytes are free still).
    assert.equal(t.store.mutate(3, [first]), true);
    assert.equal(t.patches.length, 1, 'in flight');
    assert.equal(t.store.mutate(3, [second]), false, 'the stamp of the one in flight counts too');
    assert.deepEqual(t.toasts, [tooMuchOnSlide()]);
    t.unsubscribe();
  });

  test('a write that only adds, refused (400) because the slide is full, drops just those items: what waits and the undo history stay', async () => {
    const t = setup({ slides: { 3: filled(4000, []) } });
    await store_loaded(t, 3);
    assert.equal(t.store.mutate(3, [{ op: 'update', id: 'an-0000000000f0', patch: { color: 'blue' } }]), true);
    t.last().answer.resolve(applyOps({ ...t.slide(3)!, rev: 2 }, []));
    await tick();
    const loads = t.slideLoads.length;
    assert.equal(t.store.mutate(3, [{ op: 'add', item: stroke(S) }]), true);
    // Waiting behind it: a recolor of that stroke and another item.
    assert.equal(t.store.mutate(3, [{ op: 'update', id: S, patch: { color: 'red' } }]), true);
    assert.equal(t.store.mutate(3, [{ op: 'add', item: rect(A) }]), true);
    assert.equal(t.patches.length, 2);
    t.last().answer.reject(new ApiError('이 슬라이드의 필기가 너무 많아요 (일부를 지워 주세요)', 400));
    await tick();
    assert.deepEqual(t.toasts, [tooMuchOnSlide()]);
    assert.deepEqual(t.slide(3)!.items.map((i) => i.id), ['an-0000000000f0', A], 'the refused stroke is gone, the rest stays');
    assert.equal(t.slide(3)!.items[0].color, 'blue');
    assert.equal(t.patches.length, 3, 'what waited is sent');
    assert.deepEqual(t.last().ops, [{ op: 'add', item: rect(A) }], 'without the recolor of the refused stroke');
    assert.equal(t.last().baseRev, 2);
    assert.equal(t.slideLoads.length, loads, 'not reloaded');
    // The history keeps the slide's other entries: ⌘Z takes back the rect, then the recolor.
    t.last().answer.resolve(doc(3, 3, [{ ...filler(0), ...t.slide(3)!.items[0] } as TextItem, rect(A)]));
    await tick();
    assert.deepEqual(t.store.undo(), { slide: 3, itemId: A });
    assert.equal(t.slide(3)!.items.length, 1);
    t.last().answer.resolve(doc(3, 4, [t.slide(3)!.items[0]]));
    await tick();
    assert.deepEqual(t.store.undo(), { slide: 3, itemId: 'an-0000000000f0' });
    assert.equal(t.slide(3)!.items[0].color, 'yellow');
    t.unsubscribe();
  });
});
