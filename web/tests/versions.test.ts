// 새 버전 올리기 on the client (DESIGN §28): the 새 버전 확인 dialog's view model, the slide remap of positions, the
// banner's helpers, the deck revs handled once, the `v=` of slide image URLs, the versions API, the annotation
// stream's `deck` event (parsed, the store stopped and replaced, its subscribers moved), and what a moved question or
// attachment says. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AnnotationSummary, Attachment, ChatMessage, DeckChange, DocMeta, MemoItem, NotesResponse, RectItem, SlideAnnotations, VersionPlan } from '../../shared/types.ts';
import { LANG_HEADER } from '../../shared/i18n.ts';
import {
  applyNextVersion,
  dropNextVersion,
  getRemovedSlides,
  listDocs,
  nextThumbUrl,
  removedThumbUrl,
  slideUrl,
  thumbUrl,
  undoLastVersion,
  uploadNextVersion,
  viewSrcSet,
  viewUrl,
} from '../src/api.ts';
import { setLang } from '../src/i18n/index.ts';
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
  type DeckEvent,
  type StoreDeps,
} from '../src/lib/annotations/store.ts';
import { attachmentLabel } from '../src/lib/attachments.ts';
import { applyAuthStatus, resetAuthForTests } from '../src/lib/auth.ts';
import { describeContext } from '../src/lib/format.ts';
import type { EventSourceLike, Timers } from '../src/lib/recording/events.ts';
import {
  DeckRevs,
  bannerShown,
  changeBadges,
  changeSlides,
  oldToNewOf,
  planView,
  remapSlide,
  removedItemText,
  stepSlide,
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
    const got: Array<[string, DeckEvent]> = [];
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
