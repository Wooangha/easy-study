// 질문 표시 (DESIGN §25): markers derived from the notes and the loaded slide documents — a plain region, an
// item-linked attachment that follows its item, the fallback to the attachment's rect, hidden keys, stacking,
// an attachment on another slide than the question's, the setting off; where a region's "Q" label goes.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Attachment, ChatMessage, MemoItem, NotesResponse, SlideAnnotations } from '../../shared/types.ts';
import { emptySlideAnnotations } from '../src/lib/annotations/geometry.ts';
import { deriveMarkers, markerId, noTextLabel, questionsOnItem, regionLabelPlace, regionLabelWidth } from '../src/lib/annotations/markers.ts';

const region = (id: string, slide: number, rect: Attachment['rect'], annotation?: Attachment['annotation']): Attachment => ({
  id,
  kind: 'region',
  slide,
  rect,
  width: 100,
  height: 60,
  text: '',
  createdAt: '2026-09-29T09:00:00.000Z',
  ...(annotation ? { annotation } : {}),
});

const question = (id: string, slide: number, text: string, createdAt: string, attachments: Attachment[]): ChatMessage => ({
  id,
  role: 'user',
  text,
  slide,
  kind: 'question',
  createdAt,
  status: 'complete',
  attachments,
});

const notes = (entries: Array<{ sessionId: string; question: ChatMessage }>): NotesResponse => {
  const bySlide = new Map<number, typeof entries>();
  for (const e of entries) bySlide.set(e.question.slide, [...(bySlide.get(e.question.slide) ?? []), e]);
  return {
    docId: 'doc-1',
    markdownPath: '/x/STUDY_NOTES.md',
    slides: [...bySlide.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slide, list]) => ({
        slide,
        entries: list.map((e) => ({ sessionId: e.sessionId, sessionTitle: 'S', provider: 'claude-code' as const, question: e.question, answer: null })),
      })),
  };
};

const memo = (id: string, x: number, y: number): MemoItem => ({
  id,
  type: 'memo',
  color: 'pink',
  createdAt: '2026-09-29T08:00:00.000Z',
  updatedAt: '2026-09-29T08:00:00.000Z',
  at: { x, y },
  text: '메모',
  tags: [],
  collapsed: false,
  tutor: true,
  links: [],
});

const docs = (map: Record<number, Partial<SlideAnnotations>>) => (slide: number) => {
  const patch = map[slide];
  return patch ? { ...emptySlideAnnotations(slide), ...patch } : undefined;
};

const R = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };

describe('deriveMarkers', () => {
  test('a plain region attachment: a marker at its rect on its slide with the question’s first line and time', () => {
    const n = notes([{ sessionId: 's1', question: question('q1', 3, '이 부분이 뭐야?\n둘째 줄', '2026-09-29T10:00:00.000Z', [region('a1', 3, R)]) }]);
    const markers = deriveMarkers(n, docs({ 3: {} }));
    assert.deepEqual([...markers.keys()], [3]);
    const [m] = markers.get(3)!;
    assert.deepEqual(m.rect, R);
    assert.equal(m.label, '이 부분이 뭐야?');
    assert.deepEqual(m.key, { sessionId: 's1', messageId: 'q1', attachmentId: 'a1' });
    assert.equal(m.count, 1);
    assert.equal(m.itemId, undefined);
    assert.equal(m.createdAt, '2026-09-29T10:00:00.000Z');
  });

  test('an attachment made from an item follows the item (moved) and falls back to its rect once the item is gone', () => {
    const n = notes([
      { sessionId: 's1', question: question('q1', 3, '메모 질문', '2026-09-29T10:00:00.000Z', [region('a1', 3, R, { id: 'an-000000000001', type: 'memo', text: '메모' })]) },
    ]);
    const moved = deriveMarkers(n, docs({ 3: { items: [memo('an-000000000001', 0.6, 0.7)] } })).get(3)![0];
    assert.deepEqual(moved.rect, { x: 0.6, y: 0.7, w: 0.12, h: 0.08 });
    assert.equal(moved.itemId, 'an-000000000001');
    assert.equal(moved.itemType, 'memo', 'a memo shows its dot on its card');
    const gone = deriveMarkers(n, docs({ 3: {} })).get(3)![0];
    assert.deepEqual(gone.rect, R);
    assert.equal(gone.itemId, undefined);
    assert.equal(gone.itemType, undefined);
  });

  test('hidden keys are left out; the key names the session, the message and the attachment', () => {
    const n = notes([
      { sessionId: 's1', question: question('q1', 3, 'A', '2026-09-29T10:00:00.000Z', [region('a1', 3, R)]) },
      { sessionId: 's1', question: question('q2', 3, 'B', '2026-09-29T11:00:00.000Z', [region('a2', 3, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })]) },
    ]);
    const hidden = docs({ 3: { hiddenMarkers: [{ sessionId: 's1', messageId: 'q1', attachmentId: 'a1' }] } });
    const markers = deriveMarkers(n, hidden).get(3)!;
    assert.equal(markers.length, 1);
    assert.equal(markers[0].label, 'B');
    // The same key in another session is a different marker.
    const other = docs({ 3: { hiddenMarkers: [{ sessionId: 's9', messageId: 'q1', attachmentId: 'a1' }] } });
    assert.equal(deriveMarkers(n, other).get(3)!.length, 2);
  });

  test('several questions on one rect or one item stack into one badge, newest first', () => {
    const n = notes([
      { sessionId: 's1', question: question('q1', 3, '먼저', '2026-09-29T10:00:00.000Z', [region('a1', 3, R)]) },
      { sessionId: 's2', question: question('q2', 3, '나중에', '2026-09-29T12:00:00.000Z', [region('a2', 3, R)]) },
      { sessionId: 's1', question: question('q3', 3, '', '2026-09-29T11:00:00.000Z', [region('a3', 3, R)]) },
    ]);
    const [m] = deriveMarkers(n, docs({ 3: {} })).get(3)!;
    assert.equal(m.count, 3);
    assert.equal(m.label, '나중에');
    assert.equal(m.sessionId, 's2');
    assert.deepEqual(m.questions.map((q) => q.label), ['나중에', noTextLabel(), '먼저']);
    assert.equal(markerId(m), 's2:q2:a2', 'the id follows the newest question');
  });

  test('the marker goes on the attachment’s slide, not the question’s', () => {
    const n = notes([{ sessionId: 's1', question: question('q1', 3, '앞 슬라이드 그림', '2026-09-29T10:00:00.000Z', [region('a1', 2, R)]) }]);
    const markers = deriveMarkers(n, docs({ 2: {}, 3: {} }));
    assert.deepEqual([...markers.keys()], [2]);
  });

  test('image attachments, slides whose document is not loaded, no notes, and the setting off give nothing', () => {
    const image: Attachment = { id: 'i1', kind: 'image', width: 10, height: 10, createdAt: '2026-09-29T09:00:00.000Z' };
    const n = notes([{ sessionId: 's1', question: question('q1', 3, 'x', '2026-09-29T10:00:00.000Z', [image, region('a1', 4, R)]) }]);
    assert.equal(deriveMarkers(n, docs({ 3: {} })).size, 0, 'slide 4 not loaded');
    assert.equal(deriveMarkers(n, docs({ 4: {} })).size, 1);
    assert.equal(deriveMarkers(n, docs({ 4: {} }), false).size, 0);
    assert.equal(deriveMarkers(null, docs({ 4: {} })).size, 0);
  });

  test('questionsOnItem counts the questions asked with an item', () => {
    const n = notes([
      { sessionId: 's1', question: question('q1', 3, 'a', '2026-09-29T10:00:00.000Z', [region('a1', 3, R, { id: 'an-000000000001', type: 'rect' })]) },
      { sessionId: 's1', question: question('q2', 3, 'b', '2026-09-29T11:00:00.000Z', [region('a2', 3, R, { id: 'an-000000000001', type: 'rect' })]) },
    ]);
    const item = { ...memo('an-000000000001', 0.1, 0.2), type: 'rect' as const };
    const markers = deriveMarkers(n, docs({ 3: { items: [{ id: item.id, type: 'rect', color: 'yellow', createdAt: item.createdAt, updatedAt: item.updatedAt, rect: R }] } })).get(3);
    assert.equal(questionsOnItem(markers, 'an-000000000001'), 2);
    assert.equal(questionsOnItem(markers, 'an-000000000002'), 0);
    assert.equal(questionsOnItem(undefined, 'an-000000000001'), 0);
  });
});

describe('regionLabelPlace', () => {
  // An image 800 × 450 px.
  const W = 800;
  const H = 450;

  test('left of the bar when the region leaves room on its left', () => {
    assert.equal(regionLabelPlace({ x: 0.3, y: 0.4, w: 0.2, h: 0.1 }, 1, W, H), 'left');
    // 8 px (bar + gaps) + the label + 2 px: exactly enough.
    const need = 8 + regionLabelWidth(1) + 2;
    assert.equal(regionLabelPlace({ x: need / W, y: 0.4, w: 0.2, h: 0.1 }, 1, W, H), 'left');
    assert.equal(regionLabelPlace({ x: (need - 1) / W, y: 0.4, w: 0.2, h: 0.1 }, 1, W, H), 'above');
  });

  test('a wider label (a count) needs more room on the left', () => {
    const x = (8 + regionLabelWidth(1) + 2) / W;
    assert.equal(regionLabelPlace({ x, y: 0.4, w: 0.2, h: 0.1 }, 1, W, H), 'left');
    assert.equal(regionLabelPlace({ x, y: 0.4, w: 0.2, h: 0.1 }, 3, W, H), 'above');
    assert.ok(regionLabelWidth(12) > regionLabelWidth(3));
  });

  test('above the region at the image’s left edge, inside it at the top-left corner', () => {
    assert.equal(regionLabelPlace({ x: 0, y: 0.3, w: 0.5, h: 0.5 }, 1, W, H), 'above');
    assert.equal(regionLabelPlace({ x: 0, y: 20 / H, w: 0.5, h: 0.5 }, 1, W, H), 'above');
    assert.equal(regionLabelPlace({ x: 0, y: 19 / H, w: 0.5, h: 0.5 }, 1, W, H), 'inside');
    assert.equal(regionLabelPlace({ x: 0.01, y: 0, w: 0.98, h: 1 }, 2, W, H), 'inside');
  });
});
