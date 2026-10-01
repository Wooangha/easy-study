// 새 버전 올리기 on the client (DESIGN §28): the 새 버전 확인 dialog's view model, the slide remap of positions (once per
// swap, whichever tab), the banner's helpers, the deck revs handled once, the order of a swap's steps (DeckSwaps), the
// `v=` of slide image URLs, the versions API, the deck rev every slide-numbered write carries and the 409 that refuses
// it for another deck, the annotation stream's `deck` event (parsed, the store stopped and replaced, its subscribers
// moved), and what a moved question or attachment says. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AnnotationSummary, Attachment, ChatMessage, DeckChange, DocMeta, MemoItem, NotesResponse, RectItem, SlideAnnotations, VersionPlan } from '../../shared/types.ts';
import { LANG_HEADER } from '../../shared/i18n.ts';
import { DECK_REV_HEADER } from '../../shared/types.ts';
import {
  ApiError,
  applyNextVersion,
  createRegion,
  deckChangedOf,
  deckRevOf,
  dropNextVersion,
  dropNextVersionOnLeave,
  errorMessage,
  getRemovedSlides,
  listDocs,
  nextThumbUrl,
  onDeckChanged,
  patchSlideAnnotations,
  primeSession,
  putSlideAnnotations,
  removedThumbUrl,
  sendMessage,
  slideUrl,
  thumbUrl,
  undoLastVersion,
  uploadNextVersion,
  viewSrcSet,
  viewUrl,
} from '../src/api.ts';
import { msg, setLang } from '../src/i18n/index.ts';
import { emptySlideAnnotations } from '../src/lib/annotations/geometry.ts';
import { deriveMarkers } from '../src/lib/annotations/markers.ts';
import {
  DocAnnotations,
  annotationStore,
  onDeckEvent,
  parseAnnotationEvent,
  peekAnnotationStore,
  resetAnnotationStore,
  subscribeAnnotations,
  type DeckSwap,
  type StoreDeps,
} from '../src/lib/annotations/store.ts';
import { attachmentLabel, regionOnSlide } from '../src/lib/attachments.ts';
import { applyAuthStatus, resetAuthForTests } from '../src/lib/auth.ts';
import { describeContext } from '../src/lib/format.ts';
import type { EventSourceLike, Timers } from '../src/lib/recording/events.ts';
import { readRememberedSlide, rememberSlide } from '../src/lib/storage.ts';
import {
  DECK_REFRESH_MAX_MS,
  DeckRevs,
  DeckSwaps,
  bannerShown,
  changeBadges,
  changeSlides,
  deckRefreshDelay,
  oldToNewOf,
  planView,
  remapRemembered,
  remapSlide,
  removedItemText,
  stepSlide,
  type DeckSwapDeps,
} from '../src/lib/versionPlan.ts';

const NOW = '2026-10-02T10:00:00.000Z';

/** 5 old slides → 5 new: 1 same, 2 changed, 3 dropped, 4 same but moved after 5 (changed), a new slide 3. */
const PLAN: VersionPlan = {
  fromRev: 0,
  oldPageCount: 5,
  newPageCount: 5,
  slides: [
    { slide: 1, from: 1, change: 'same' },
    { slide: 2, from: 2, change: 'changed' },
    { slide: 3, from: null, change: 'new' },
    { slide: 4, from: 5, change: 'same' },
    { slide: 5, from: 4, change: 'changed', moved: true },
  ],
  removed: [3],
  unrelated: false,
  onRemoved: { items: 2, memos: 1, questions: 3 },
};

describe('the 새 버전 확인 dialog: planView', () => {
  test('counts, the changed slides (old → new, moved), the new and the removed ones, what sits on the removed', () => {
    const view = planView(PLAN);
    assert.deepEqual(view.counts, { same: 2, changed: 2, added: 1, removed: 1 });
    assert.equal(view.unchanged, false);
    assert.deepEqual(view.changed, [
      { slide: 2, from: 2, moved: false },
      { slide: 5, from: 4, moved: true },
    ]);
    assert.deepEqual(view.added, [3]);
    assert.deepEqual(view.removed, [3]);
    assert.deepEqual(view.keptOnRemoved, { items: 2, memos: 1 });
    assert.equal(view.questionsMoved, 3);
    assert.equal(view.unrelated, false);
  });

  test('the same PDF again: everything same, "바뀐 장이 없어요", no lines about removed slides', () => {
    const same: VersionPlan = {
      fromRev: 2,
      oldPageCount: 3,
      newPageCount: 3,
      slides: [1, 2, 3].map((n) => ({ slide: n, from: n, change: 'same' as const })),
      removed: [],
      unrelated: false,
      onRemoved: { items: 0, memos: 0, questions: 0 },
    };
    const view = planView(same);
    assert.deepEqual(view.counts, { same: 3, changed: 0, added: 0, removed: 0 });
    assert.equal(view.unchanged, true);
    assert.equal(view.keptOnRemoved, null);
    assert.equal(view.questionsMoved, 0);
  });

  test('another lecture: unrelated, the removed slides ascending, only memos on them', () => {
    const view = planView({
      ...PLAN,
      slides: [{ slide: 1, from: null, change: 'new' }],
      removed: [5, 1, 3],
      unrelated: true,
      onRemoved: { items: 0, memos: 4, questions: 0 },
    });
    assert.equal(view.unrelated, true);
    assert.deepEqual(view.removed, [1, 3, 5]);
    assert.deepEqual(view.keptOnRemoved, { items: 0, memos: 4 });
  });
});

describe('old slide numbers into the new deck', () => {
  test('oldToNewOf: the apply map from the plan (null for dropped slides)', () => {
    assert.deepEqual(oldToNewOf(PLAN), [1, 2, null, 5, 4]);
  });

  test('remapSlide: kept → its new number; dropped → the closest preceding kept slide, else the following, else 1', () => {
    const map = oldToNewOf(PLAN);
    assert.equal(remapSlide(1, map), 1);
    assert.equal(remapSlide(4, map), 5);
    assert.equal(remapSlide(5, map), 4);
    assert.equal(remapSlide(3, map), 2, 'old 3 dropped: old 2 is the closest preceding one kept');
    assert.equal(remapSlide(1, [null, null, 7]), 7, 'nothing kept before: the following one');
    assert.equal(remapSlide(2, [null, null]), 1, 'nothing kept at all');
    assert.equal(remapSlide(9, map), 4, 'beyond the old deck: its last slide');
    assert.equal(remapSlide(0, map), 1);
    assert.equal(remapSlide(3, []), 1);
  });
});

describe('the banner', () => {
  const change: DeckChange = {
    rev: 3,
    at: NOW,
    kind: 'apply',
    fromFileName: 'L7.pdf',
    changed: [9, 2],
    added: [5],
    removed: [4],
    undoable: true,
  };

  test('the changed and added slides, ascending, with their badges', () => {
    assert.deepEqual(changeSlides(change), [2, 5, 9]);
    assert.deepEqual([...changeBadges(change)], [
      [9, 'changed'],
      [2, 'changed'],
      [5, 'added'],
    ]);
  });

  test('shown until dismissed for this swap (deckSeen = its rev); a later swap shows again', () => {
    assert.equal(bannerShown(undefined, null), false);
    assert.equal(bannerShown(change, null), true);
    assert.equal(bannerShown(change, 3), false);
    assert.equal(bannerShown(change, 2), true);
  });

  test('‹ › step from the focused slide and wrap around', () => {
    const list = [2, 5, 9];
    assert.equal(stepSlide(list, 1, 1), 2);
    assert.equal(stepSlide(list, 2, 1), 5);
    assert.equal(stepSlide(list, 9, 1), 2);
    assert.equal(stepSlide(list, 6, -1), 5);
    assert.equal(stepSlide(list, 2, -1), 9);
    assert.equal(stepSlide([], 3, 1), null);
  });
});

describe('DeckRevs: a swap is handled once', () => {
  test('the event and the answer of the same swap: the first one handles it', () => {
    const revs = new DeckRevs();
    assert.equal(revs.see('d', 2), false, 'first sight only records');
    assert.equal(revs.take('d', 3), true);
    assert.equal(revs.take('d', 3), false);
    assert.equal(revs.see('d', 3), false, 'the DocMeta that follows is no news');
  });

  test('a newer rev seen in a DocMeta (the event was missed) is handled; an older one is not', () => {
    const revs = new DeckRevs();
    revs.see('d', 1);
    assert.equal(revs.see('d', 2), true);
    assert.equal(revs.see('d', 1), false);
    assert.equal(revs.take('d', 2), false);
    assert.equal(revs.take('other', 1), true, 'a lecture never seen here (applied from the library)');
  });
});

describe('the 빠진 슬라이드 archive', () => {
  const base = { color: 'yellow' as const, createdAt: NOW, updatedAt: NOW };
  test('memos, text boxes and text highlights show their first line; the rest has none', () => {
    const memo = { ...base, id: 'an-0000000000a1', type: 'memo', text: '\n  첫 줄 \n둘째', anchor: { x: 0, y: 0 }, tags: [], links: [] } as unknown as MemoItem;
    const rect: RectItem = { ...base, id: 'an-0000000000a2', type: 'rect', rect: { x: 0, y: 0, w: 0.1, h: 0.1 } };
    assert.equal(removedItemText(memo), '첫 줄');
    assert.equal(removedItemText({ ...memo, text: '   ' }), null);
    assert.equal(removedItemText(rect), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------------------------------

const docMeta = (id: string, deckRev?: number): DocMeta => ({
  id,
  title: id,
  fileName: `${id}.pdf`,
  pageCount: 3,
  aspectRatio: 16 / 9,
  status: 'ready',
  progress: 3,
  createdAt: NOW,
  courseId: null,
  digestStatus: 'none',
  ...(deckRev !== undefined ? { deckRev } : {}),
});

describe('the API: slide image URLs carry the deck rev, the versions routes', () => {
  const realFetch = globalThis.fetch;
  const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  let answer: unknown = [];
  let seen: Array<{ url: string; method: string; headers: Headers }> = [];

  beforeEach(() => {
    resetAuthForTests();
    applyAuthStatus({ authRequired: false, authenticated: true });
    seen = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = realXhr;
    setLang('system');
    resetAuthForTests();
  });

  test('v=<deckRev> on every slide image of a swapped lecture; none at rev 0 (the URLs stay as they were)', async () => {
    answer = [docMeta('lec-a', 2), docMeta('lec-b'), docMeta('lec-c', 0)];
    await listDocs();
    assert.equal(slideUrl('lec-a', 4), '/api/docs/lec-a/slides/4.png?v=2');
    assert.equal(viewUrl('lec-a', 4, 1000), '/api/docs/lec-a/view/4.webp?w=1000&v=2');
    assert.equal(viewSrcSet('lec-a', 4), '/api/docs/lec-a/view/4.webp?w=1000&v=2 1000w, /api/docs/lec-a/view/4.webp?w=1600&v=2 1600w');
    assert.equal(thumbUrl('lec-a', 4), '/api/docs/lec-a/thumbs/4.webp?v=2');
    assert.equal(slideUrl('lec-b', 1), '/api/docs/lec-b/slides/1.png');
    assert.equal(viewUrl('lec-b', 1, 1600), '/api/docs/lec-b/view/1.webp?w=1600');
    assert.equal(thumbUrl('lec-c', 1), '/api/docs/lec-c/thumbs/1.webp');
  });

  test('apply and undo answer the swapped lecture: its URLs follow at once', async () => {
    answer = docMeta('lec-d', 1);
    const applied = await applyNextVersion('lec-d');
    assert.equal(applied.deckRev, 1);
    assert.deepEqual(
      seen.map((r) => [r.method, r.url]),
      [['POST', '/api/docs/lec-d/versions/next/apply']],
    );
    assert.equal(thumbUrl('lec-d', 2), '/api/docs/lec-d/thumbs/2.webp?v=1');
    answer = docMeta('lec-d', 2);
    await undoLastVersion('lec-d');
    assert.equal(seen[1].url, '/api/docs/lec-d/versions/undo');
    assert.equal(thumbUrl('lec-d', 2), '/api/docs/lec-d/thumbs/2.webp?v=2');
  });

  test('drop, the removed-slides archive and the thumbnails of the new version and of the archive', async () => {
    await dropNextVersion('lec-e');
    answer = [];
    assert.deepEqual(await getRemovedSlides('lec-e'), []);
    assert.deepEqual(
      seen.map((r) => [r.method, r.url]),
      [
        ['DELETE', '/api/docs/lec-e/versions/next'],
        ['GET', '/api/docs/lec-e/annotations/removed'],
      ],
    );
    assert.equal(nextThumbUrl('lec-e', 3), '/api/docs/lec-e/versions/next/thumbs/3.webp');
    assert.equal(nextThumbUrl('lec-e', 3, NOW), `/api/docs/lec-e/versions/next/thumbs/3.webp?t=${encodeURIComponent(NOW)}`);
    assert.equal(removedThumbUrl('lec-e', 2, 7), '/api/docs/lec-e/annotations/removed/2/7.webp');
  });

  test('uploadNextVersion: the raw PDF with X-Filename and the language, progress, the 202 answer', async () => {
    const sent: { method?: string; url?: string; headers: Record<string, string> } = { headers: {} };
    const progress: number[] = [];
    class FakeXhr {
      status = 0;
      responseText = '';
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(method: string, url: string) {
        sent.method = method;
        sent.url = url;
      }
      setRequestHeader(name: string, value: string) {
        sent.headers[name] = value;
      }
      send() {
        setTimeout(() => {
          this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
          this.status = 202;
          this.responseText = JSON.stringify({ status: 'processing', fileName: 'L7 v2.pdf', progress: 0, pageCount: 0, createdAt: NOW });
          this.onload?.();
        }, 0);
      }
      abort() {}
    }
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
    setLang('en');
    const file = new File([new Uint8Array(10)], 'L7 v2.pdf', { type: 'application/pdf' });
    const info = await uploadNextVersion('lec-f', file, { onProgress: (f) => progress.push(f) });
    assert.equal(info.status, 'processing');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/api/docs/lec-f/versions');
    assert.equal(sent.headers['X-Filename'], encodeURIComponent('L7 v2.pdf'));
    assert.equal(sent.headers['Content-Type'], 'application/pdf');
    assert.equal(sent.headers[LANG_HEADER], 'en');
    assert.deepEqual(progress, [0.5]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The `deck` event of the annotation stream
// ---------------------------------------------------------------------------------------------------------------------

class FakeTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, () => void>();
  setTimeout = (fn: () => void): unknown => {
    const id = this.next++;
    this.pending.set(id, fn);
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
}

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(ev: MessageEvent) => unknown>>();
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

const tick = () => new Promise<void>((r) => setImmediate(r));
const summary = (): AnnotationSummary => ({ version: 1, slides: [], memos: [], tags: [] });
const slideDoc = (slide: number, rev: number): SlideAnnotations => ({ ...emptySlideAnnotations(slide), rev, updatedAt: NOW });

function fakeDeps() {
  const sources: FakeEventSource[] = [];
  const calls = { summary: 0, slides: [] as number[], patches: 0 };
  const deps: StoreDeps = {
    getSummary: () => {
      calls.summary++;
      return Promise.resolve(summary());
    },
    getSlide: (_doc, slide) => {
      calls.slides.push(slide);
      return Promise.resolve(slideDoc(slide, 1));
    },
    patch: () => {
      calls.patches++;
      return new Promise(() => {});
    },
    eventsUrl: (docId, client) => `/api/docs/${docId}/annotations/events?client=${client}`,
    createEventSource: () => {
      const es = new FakeEventSource();
      sources.push(es);
      return es;
    },
    timers: new FakeTimers(),
    toast: () => {},
    now: () => 0,
  };
  return { deps, sources, calls };
}

const DECK = { type: 'deck', rev: 3, kind: 'apply', oldToNew: [1, null, 2] };

describe('the `deck` event', () => {
  test('parsed (malformed entries of the map are null); malformed events dropped', () => {
    assert.deepEqual(parseAnnotationEvent('deck', JSON.stringify(DECK)), DECK);
    assert.deepEqual(parseAnnotationEvent('deck', JSON.stringify({ rev: 4, kind: 'undo', oldToNew: [2, 0, 'x', 1.5, 3] })), {
      type: 'deck',
      rev: 4,
      kind: 'undo',
      oldToNew: [2, null, null, null, 3],
    });
    assert.equal(parseAnnotationEvent('deck', JSON.stringify({ rev: 4, kind: 'other', oldToNew: [] })), null);
    assert.equal(parseAnnotationEvent('deck', JSON.stringify({ rev: '4', kind: 'apply', oldToNew: [] })), null);
    assert.equal(parseAnnotationEvent('deck', JSON.stringify({ rev: 4, kind: 'apply' })), null);
  });

  test('the store stops (no writes, loads or stream) and tells the app, which then replaces it', async () => {
    const { deps, sources, calls } = fakeDeps();
    const store = new DocAnnotations('lec-deck', deps);
    store.subscribe(() => {});
    sources[0].open();
    await tick();
    const got: Array<[string, DeckSwap]> = [];
    const off = onDeckEvent((docId, event) => got.push([docId, event]));
    try {
      sources[0].emit('deck', DECK);
      assert.deepEqual(got, [['lec-deck', DECK]]);
      assert.equal(store.isSwapped, true);
      assert.equal(sources[0].closed, true, 'the stream of the old deck is closed, not reopened');
      assert.equal(store.mutate(1, [{ op: 'add', item: { id: 'an-0000000000b1', type: 'rect', color: 'yellow', createdAt: NOW, updatedAt: NOW, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } } }]), false);
      assert.equal(calls.patches, 0);
      const loads = calls.slides.length;
      store.setWindow(2, 1, 3);
      assert.equal(calls.slides.length, loads, 'nothing is loaded into the old store');
      store.reconnectNow();
      assert.equal(sources.length, 1);
    } finally {
      off();
    }
  });

  test('resetAnnotationStore: the subscribers move to a fresh store (same API), which loads the new deck', async () => {
    const { deps, sources, calls } = fakeDeps();
    const old = annotationStore('lec-reset', deps);
    let notified = 0;
    const unsubscribe = subscribeAnnotations('lec-reset', () => notified++);
    try {
      await tick();
      assert.equal(calls.summary, 1);
      notified = 0;
      resetAnnotationStore('lec-reset');
      const fresh = peekAnnotationStore('lec-reset');
      assert.ok(fresh && fresh !== old, 'a new store');
      assert.equal(fresh.isSwapped, false);
      assert.ok(notified >= 1, 'the subscriber is told');
      assert.equal(sources[0].closed, true, 'the old store’s stream is closed');
      assert.equal(sources.length, 2, 'the fresh store streams');
      await tick();
      assert.equal(calls.summary, 2, 'the fresh store loads the summary again');
      assert.equal(old.mutate(1, [{ op: 'remove', id: 'an-0000000000c1' }]), false, 'the old store writes nothing');
    } finally {
      unsubscribe();
      peekAnnotationStore('lec-reset')?.close();
    }
  });

  test('a `deck` event with nobody listening replaces the store right away', async () => {
    const { deps, sources } = fakeDeps();
    const old = annotationStore('lec-alone', deps);
    let notified = 0;
    const unsubscribe = subscribeAnnotations('lec-alone', () => notified++);
    try {
      sources[0].open();
      await tick();
      notified = 0;
      sources[0].emit('deck', DECK);
      const fresh = peekAnnotationStore('lec-alone');
      assert.ok(fresh && fresh !== old && !fresh.isSwapped);
      assert.ok(notified >= 1);
      assert.equal(old.isSwapped, true);
    } finally {
      unsubscribe();
      peekAnnotationStore('lec-alone')?.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Questions and attachments whose slide a new version dropped
// ---------------------------------------------------------------------------------------------------------------------

describe('a question or attachment on a dropped slide', () => {
  const region = (extra: Partial<Attachment> = {}): Attachment => ({
    id: 'att-000000000001',
    kind: 'region',
    slide: 4,
    rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    createdAt: NOW,
    ...extra,
  }) as Attachment;

  test('the attachment label says where it was', () => {
    assert.equal(attachmentLabel(region()), 'p.4 영역');
    assert.equal(attachmentLabel(region({ removedFrom: { rev: 1, slide: 6 } })), 'p.4 영역 (빠진 장 p.6)');
  });

  test('question markers skip it (it has no place on the slide it now names)', () => {
    const question = (id: string, attachment: Attachment): ChatMessage => ({
      id,
      role: 'user',
      text: '이거 뭐예요',
      slide: 4,
      kind: 'question',
      createdAt: NOW,
      status: 'complete',
      attachments: [attachment],
    });
    const notes = {
      slides: [
        {
          slide: 4,
          entries: [
            { sessionId: 's1', sessionTitle: 'S', provider: 'claude', question: question('m1', region()), answer: null },
            { sessionId: 's1', sessionTitle: 'S', provider: 'claude', question: question('m2', region({ id: 'att-000000000002', removedFrom: { rev: 1, slide: 6 } })), answer: null },
          ],
        },
      ],
    } as unknown as NotesResponse;
    const markers = deriveMarkers(notes, (s) => (s === 4 ? emptySlideAnnotations(4) : undefined));
    assert.deepEqual(
      markers.get(4)?.map((m) => m.messageId),
      ['m1'],
    );
  });

  test('ContextInfo.deckUpdated: "새 버전 슬라이드로 다시 시작" in place of the plain rollover chip', () => {
    const chips = describeContext({ primed: false, rollover: true, attachedSlides: [], reusedSlides: [], overviewImages: 0, deckUpdated: true });
    assert.deepEqual(
      chips.map((c) => [c.kind, c.text]),
      [['deckUpdated', '새 버전 슬라이드로 다시 시작']],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Every slide-numbered write says which deck its numbers belong to; a 409 for another deck reloads the lecture
// ---------------------------------------------------------------------------------------------------------------------

describe('the deck rev of slide-numbered writes (DECK_REV_HEADER), and the 409 for another deck', () => {
  const realFetch = globalThis.fetch;
  let seen: Array<{ url: string; method: string; headers: Headers; body: string | null; keepalive: boolean }> = [];
  /** The answer of the next requests: a JSON body and a status (an SSE stream for 200 on a turn). */
  let respond: (url: string) => Response = () => new Response('[]', { status: 200 });

  beforeEach(() => {
    resetAuthForTests();
    applyAuthStatus({ authRequired: false, authenticated: true });
    seen = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : null,
        keepalive: init?.keepalive === true,
      });
      return respond(String(input));
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    respond = () => new Response('[]', { status: 200 });
    resetAuthForTests();
  });

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const sse = () =>
    new Response('event: done\ndata: {"type":"ping"}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const deckChanged = (deckRev: number) => json({ error: '그사이 이 강의가 새 버전으로 바뀌었어요. 화면을 다시 불러올게요.', deckRev }, 409);

  test('annotations PUT / PATCH, regions, questions and prime turns carry the deck rev held for the lecture (0 when none)', async () => {
    respond = () => json([docMeta('lec-h1', 4), docMeta('lec-h0')]);
    await listDocs();
    assert.equal(deckRevOf('lec-h1'), 4);
    assert.equal(deckRevOf('lec-h0'), 0);
    assert.equal(deckRevOf('lec-never-seen'), 0);
    respond = () => json(slideDoc(2, 1));
    await patchSlideAnnotations('lec-h1', 2, { baseRev: 0, ops: [] }, 'client-1');
    await putSlideAnnotations('lec-h0', 2, { baseRev: 0, items: [], hiddenMarkers: [] });
    await patchSlideAnnotations('lec-h1', 2, { baseRev: 0, ops: [] }, 'client-1', 3); // a store made for deck 3
    respond = () => json({ id: 'att-0123456789abcdef', kind: 'region', slide: 2, createdAt: NOW }, 201);
    await createRegion('lec-h1', { slide: 2, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    respond = sse;
    await sendMessage('lec-h1', 's1', { text: 'x', slide: 2 }, () => {});
    await primeSession('lec-h0', 's1', { slide: 1 }, () => {});
    const writes = seen.slice(1);
    assert.deepEqual(
      writes.map((r) => [r.method, r.url, r.headers.get(DECK_REV_HEADER)]),
      [
        ['PATCH', '/api/docs/lec-h1/annotations/2', '4'],
        ['PUT', '/api/docs/lec-h0/annotations/2', '0'],
        ['PATCH', '/api/docs/lec-h1/annotations/2', '3'],
        ['POST', '/api/docs/lec-h1/regions', '4'],
        ['POST', '/api/docs/lec-h1/sessions/s1/messages', '4'],
        ['POST', '/api/docs/lec-h0/sessions/s1/prime', '0'],
      ],
    );
    assert.equal(writes[0].headers.get('X-Annotation-Client'), 'client-1', 'the client id still goes along');
    assert.equal(writes[4].headers.get('Accept'), 'text/event-stream');
  });

  test('undo says which deck it undoes (`fromRev`: the one shown, else the one held)', async () => {
    respond = () => json(docMeta('lec-u', 6));
    await undoLastVersion('lec-u', 5);
    await undoLastVersion('lec-u');
    assert.deepEqual(
      seen.map((r) => [r.method, r.url, r.body]),
      [
        ['POST', '/api/docs/lec-u/versions/undo', '{"fromRev":5}'],
        ['POST', '/api/docs/lec-u/versions/undo', '{"fromRev":6}'],
      ],
    );
  });

  test('deckChangedOf: only a 409 with a deck rev and no `current` (an annotation conflict is not one)', () => {
    const e = (status: number, data: Record<string, unknown> | null) => new ApiError('x', status, null, [], data);
    assert.equal(deckChangedOf(e(409, { error: 'x', deckRev: 3 })), 3);
    assert.equal(deckChangedOf(e(409, { error: 'x', deckRev: 0 })), 0);
    assert.equal(deckChangedOf(e(409, { error: 'x', deckRev: 3, current: slideDoc(1, 2) })), null);
    assert.equal(deckChangedOf(e(409, { error: 'x' })), null);
    assert.equal(deckChangedOf(e(409, { error: 'x', deckRev: '3' })), null);
    assert.equal(deckChangedOf(e(400, { error: 'x', deckRev: 3 })), null);
    assert.equal(deckChangedOf(new Error('x')), null);
  });

  test('a question, a region or an undo refused for another deck: the server’s words, and the app is told to reload', async () => {
    const told: Array<[string, number]> = [];
    const off = onDeckChanged((docId, rev) => told.push([docId, rev]));
    try {
      respond = () => deckChanged(7);
      await assert.rejects(sendMessage('lec-r', 's1', { text: 'x', slide: 2 }, () => {}), (e: unknown) => {
        assert.equal(errorMessage(e), '그사이 이 강의가 새 버전으로 바뀌었어요. 화면을 다시 불러올게요.', 'not "이미 답변을 생성하고 있어요"');
        return true;
      });
      await assert.rejects(primeSession('lec-r', 's1', { slide: 2 }, () => {}));
      await assert.rejects(createRegion('lec-r', { slide: 2, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }));
      await assert.rejects(undoLastVersion('lec-r', 6));
      assert.deepEqual(told, [
        ['lec-r', 7],
        ['lec-r', 7],
        ['lec-r', 7],
        ['lec-r', 7],
      ]);
      // A busy turn (409 without a deck rev) is still a busy turn, and reloads nothing.
      respond = () => json({ error: 'busy' }, 409);
      await assert.rejects(sendMessage('lec-r', 's1', { text: 'x', slide: 2 }, () => {}), (e: unknown) => {
        assert.equal(errorMessage(e), msg().common.api.busyAnswering);
        return true;
      });
      assert.equal(told.length, 4);
    } finally {
      off();
    }
  });

  test('the page goes away with a new version staged: DELETE …/versions/next with keepalive', () => {
    dropNextVersionOnLeave('lec-leave');
    assert.deepEqual(
      seen.map((r) => [r.method, r.url, r.keepalive]),
      [['DELETE', '/api/docs/lec-leave/versions/next', true]],
    );
  });
});

describe('the annotation store: a write refused for another deck', () => {
  const rect = { id: 'an-0000000000d1', type: 'rect' as const, color: 'yellow' as const, createdAt: NOW, updatedAt: NOW, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } };

  test('every write carries the deck the store was made for', async () => {
    const { deps } = fakeDeps();
    const revs: unknown[] = [];
    const store = new DocAnnotations('lec-store-rev', { ...deps, deckRev: () => 3, patch: (...args) => (revs.push(args[4]), new Promise(() => {})) });
    assert.equal(store.deckRev, 3);
    assert.equal(store.mutate(1, [{ op: 'add', item: rect }]), true);
    assert.deepEqual(revs, [3]);
    store.close();
  });

  test('409 { deckRev } is not rebased: the writes are dropped, the store stops and tells the app (no map)', async () => {
    const { deps } = fakeDeps();
    const toasts: Array<[string, string | undefined]> = [];
    let patches = 0;
    const store = new DocAnnotations('lec-store-409', {
      ...deps,
      toast: (message, kind) => toasts.push([message, kind]),
      patch: () => {
        patches++;
        return Promise.reject(new ApiError('그사이 이 강의가 새 버전으로 바뀌었어요. 화면을 다시 불러올게요.', 409, null, [], { error: '…', deckRev: 5 }));
      },
    });
    const got: Array<[string, DeckSwap]> = [];
    const off = onDeckEvent((docId, swap) => got.push([docId, swap]));
    try {
      store.subscribe(() => {});
      assert.equal(store.mutate(1, [{ op: 'add', item: rect }]), true);
      assert.equal(store.mutate(1, [{ op: 'add', item: { ...rect, id: 'an-0000000000d2' } }]), true, 'queued behind the request in flight');
      await tick();
      assert.equal(patches, 1, 'not sent again (a rebase would)');
      assert.deepEqual(got, [['lec-store-409', { rev: 5, oldToNew: null }]]);
      assert.equal(store.isSwapped, true);
      assert.deepEqual(toasts, [['그사이 이 강의가 새 버전으로 바뀌었어요. 화면을 다시 불러올게요.', 'info']]);
      assert.equal(store.mutate(1, [{ op: 'remove', id: rect.id }]), false, 'nothing more is written');
      await tick();
      assert.equal(patches, 1, 'the queued ops were dropped');
    } finally {
      off();
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The order of a swap's steps (DeckSwaps): a stopped store never stays, a failed refetch is retried
// ---------------------------------------------------------------------------------------------------------------------

describe('DeckSwaps', () => {
  /** App's steps, recorded; the DocMeta list and the store as plain state. */
  function harness(
    options: {
      listed?: number;
      fetches?: Array<number | null>;
      fetch?: () => Promise<number | null>;
      stopped?: () => boolean;
      reset?: () => void;
    } = {},
  ) {
    const log: string[] = [];
    const waits: number[] = [];
    let listed: number | null = options.listed ?? 0;
    const fetches = [...(options.fetches ?? [])];
    let gone = false;
    const deps: DeckSwapDeps = {
      remapPositions: (docId, rev, map) => void log.push(`remap ${docId} ${rev} ${map ? map.join(',') : 'none'}`),
      listedRev: () => listed,
      fetchRev: async () => {
        const got = options.fetch ? await options.fetch() : fetches.length > 0 ? fetches.shift()! : null;
        log.push(`fetch ${got}`);
        if (got !== null) listed = got;
        return got;
      },
      gone: () => gone,
      replaceDoc: (meta) => {
        listed = meta.deckRev ?? 0;
        log.push(`replace ${listed}`);
      },
      replaceStoppedStore: () => {
        const stopped = options.stopped?.() ?? false;
        if (stopped) {
          options.reset?.();
          log.push('reset store');
        }
        return stopped;
      },
      reload: (docId) => void log.push(`reload ${docId}`),
      wait: async (ms) => void waits.push(ms),
    };
    return {
      swaps: new DeckSwaps(() => deps),
      log,
      waits,
      setListed: (rev: number) => (listed = rev),
      setGone: () => (gone = true),
    };
  }

  test('the event: positions, the DocMeta, then the store and the rest — once', async () => {
    const { swaps, log } = harness({ fetches: [2] });
    swaps.shown('d', 1);
    await swaps.fromServer('d', 2, [1, null, 2]);
    await swaps.fromServer('d', 2, [1, null, 2]);
    swaps.shown('d', 2);
    assert.deepEqual(log, ['remap d 2 1,,2', 'fetch 2', 'reload d']);
  });

  test('a DocMeta showed the new deck before its event: the store the event stopped is replaced, the lecture loaded again', async () => {
    let stopped = false;
    const { swaps, log } = harness({ stopped: () => stopped, reset: () => (stopped = false) });
    swaps.shown('d', 0);
    swaps.shown('d', 1); // fetched mid-swap (useDocs replaced the store with it)
    assert.deepEqual(log, ['remap d 1 none', 'reload d']);
    stopped = true; // the replacement got the `deck` event
    await swaps.fromServer('d', 1, [1, 2]);
    assert.deepEqual(log, ['remap d 1 none', 'reload d', 'reset store', 'reload d']);
    assert.equal(stopped, false);
    await swaps.fromServer('d', 1, [1, 2]);
    assert.equal(log.length, 4, 'nothing stopped: nothing to do');
  });

  test('a failed refetch is retried with backoff (1 s, 2 s, …) until the DocMeta shows the new deck', async () => {
    let stopped = true;
    const { swaps, log, waits } = harness({ fetches: [null, null, 1, 3], stopped: () => stopped, reset: () => (stopped = false) });
    await swaps.fromServer('d', 3, null);
    assert.deepEqual(waits, [1000, 2000, 4000], 'an older DocMeta (rev 1) is not the new deck either');
    assert.deepEqual(log, ['remap d 3 none', 'fetch null', 'fetch null', 'fetch 1', 'fetch 3', 'reset store', 'reload d']);
    assert.equal(deckRefreshDelay(0), 1000);
    assert.equal(deckRefreshDelay(3), 8000);
    assert.equal(deckRefreshDelay(4), DECK_REFRESH_MAX_MS);
    assert.equal(deckRefreshDelay(60), DECK_REFRESH_MAX_MS);
  });

  test('another refresh brings the DocMeta meanwhile; a deleted lecture stops the retries', async () => {
    const a = harness({ fetches: [null] });
    const pending = a.swaps.fromServer('d', 2, null);
    a.setListed(2);
    await pending;
    assert.deepEqual(a.log, ['remap d 2 none', 'fetch null', 'reload d']);

    const b = harness({ fetches: [null] });
    const gone = b.swaps.fromServer('d', 2, null);
    b.setGone();
    await gone;
    assert.deepEqual(b.log, ['remap d 2 none', 'fetch null']);
  });

  test('while the DocMeta is being fetched, another notice of the same swap leaves the stopped store to it', async () => {
    let stopped = true;
    let release: (rev: number | null) => void = () => {};
    const { swaps, log } = harness({
      stopped: () => stopped,
      reset: () => (stopped = false),
      fetch: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const first = swaps.fromServer('d', 2, null);
    await swaps.fromServer('d', 2, null); // the store's own notice of the same 409, say
    assert.equal(stopped, true, 'not replaced before the viewer shows the new deck');
    release(2);
    await first;
    assert.equal(stopped, false);
    assert.deepEqual(log, ['remap d 2 none', 'fetch 2', 'reset store', 'reload d']);
  });

  test('the answer of an apply made here, then its event', async () => {
    const { swaps, log } = harness();
    swaps.shown('d', 0);
    swaps.fromAnswer(docMeta('d', 1), [2, 1]);
    await swaps.fromServer('d', 1, [2, 1]);
    swaps.shown('d', 1);
    assert.deepEqual(log, ['remap d 1 2,1', 'replace 1', 'reload d']);
  });

  test('with the real stores: the replacement made mid-swap gets the event — it is replaced, not left stopped', async () => {
    const { deps, sources } = fakeDeps();
    annotationStore('lec-c9', deps);
    const unsubscribe = subscribeAnnotations('lec-c9', () => {});
    let reloads = 0;
    const swaps = new DeckSwaps(() => ({
      remapPositions: () => {},
      listedRev: () => 1,
      fetchRev: async () => 1,
      gone: () => false,
      replaceDoc: () => {},
      replaceStoppedStore: (docId) => {
        if (!peekAnnotationStore(docId)?.isSwapped) return false;
        resetAnnotationStore(docId);
        return true;
      },
      reload: () => void reloads++,
      wait: async () => {},
    }));
    const off = onDeckEvent((docId, swap) => void swaps.fromServer(docId, swap.rev, swap.oldToNew));
    try {
      swaps.shown('lec-c9', 0);
      // A DocMeta fetched while the swap ran shows deck 1: useDocs replaces the store, App reloads.
      resetAnnotationStore('lec-c9');
      swaps.shown('lec-c9', 1);
      assert.equal(reloads, 1);
      const midSwap = peekAnnotationStore('lec-c9');
      assert.equal(sources.length, 2);
      sources[1].open();
      await tick();
      sources[1].emit('deck', { ...DECK, rev: 1 });
      await tick();
      const now = peekAnnotationStore('lec-c9');
      assert.equal(midSwap?.isSwapped, true);
      assert.ok(now && now !== midSwap && !now.isSwapped, 'a working store again');
      assert.equal(sources.length, 3, 'which streams');
      assert.equal(reloads, 2, 'what was loaded mid-swap is loaded again');
    } finally {
      off();
      unsubscribe();
      peekAnnotationStore('lec-c9')?.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The remembered slide follows a swap once, whichever tab gets there first
// ---------------------------------------------------------------------------------------------------------------------

describe('the remembered slide and its deck rev', () => {
  const items = new Map<string, string>();
  beforeEach(() => {
    items.clear();
    const localStorage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    Object.assign(globalThis, { window: { localStorage } });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  test('remapRemembered: once per swap (a second tab finds it done), nothing when none is remembered', () => {
    const map = [1, null, 2, 4];
    const first = remapRemembered({ slide: 4, rev: 0 }, 1, map);
    assert.deepEqual(first, { slide: 4, rev: 1 });
    assert.equal(remapRemembered(first, 1, map), null, 'the other tab: already numbered in deck 1');
    assert.equal(remapRemembered({ slide: 3, rev: 2 }, 1, map), null, 'a later deck');
    assert.equal(remapRemembered(null, 1, map), null);
    assert.deepEqual(remapRemembered({ slide: 2, rev: 0 }, 1, map), { slide: 1, rev: 1 }, 'a dropped slide: the nearest kept one');
  });

  test('two tabs: the slide is remapped by the first one only; a viewer of the old deck does not undo it', () => {
    const map = [2, 3, 4];
    rememberSlide('lec-tabs', 1, 0); // saved by a viewer of deck 0
    assert.equal(items.has('easy-study:slideRev:lec-tabs'), false, 'rev 0 is not stored');
    assert.deepEqual(readRememberedSlide('lec-tabs'), { slide: 1, rev: 0 });
    for (const _tab of ['A', 'B']) {
      const next = remapRemembered(readRememberedSlide('lec-tabs'), 1, map);
      if (next) rememberSlide('lec-tabs', next.slide, next.rev);
    }
    assert.deepEqual(readRememberedSlide('lec-tabs'), { slide: 2, rev: 1 }, 'not 3: remapped once');
    rememberSlide('lec-tabs', 1, 0); // the old deck's viewer, still shown, saves its focus
    assert.deepEqual(readRememberedSlide('lec-tabs'), { slide: 2, rev: 1 });
    rememberSlide('lec-tabs', 3, 1); // the new deck's viewer
    assert.deepEqual(readRememberedSlide('lec-tabs'), { slide: 3, rev: 1 });
    assert.equal(items.get('easy-study:slide:lec-tabs'), '3', 'the slide itself stays a number (older bundles read it)');
  });

  test('a slide remembered before deck revs were stored counts as deck 0', () => {
    items.set('easy-study:slide:lec-old', '5');
    assert.deepEqual(readRememberedSlide('lec-old'), { slide: 5, rev: 0 });
    assert.equal(readRememberedSlide('lec-none'), null);
  });
});

describe('a region whose slide a new version dropped is not shown on the slide it now names', () => {
  test('regionOnSlide', () => {
    const rect = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    assert.deepEqual(regionOnSlide({ kind: 'region', slide: 4, rect }), { slide: 4, rect });
    assert.equal(regionOnSlide({ kind: 'region', slide: 4, rect, removedFrom: { rev: 1, slide: 6 } }), null);
    assert.equal(regionOnSlide({ kind: 'region', slide: 4 }), null);
    assert.equal(regionOnSlide({ kind: 'image' }), null);
  });
});
