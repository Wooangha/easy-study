// 📎 첨부 of a 필기 (DESIGN §25): the chip labels of a region made from an annotation item, the 'ready' recompute that
// keeps them, the plan of attaching a group selection (the free slots counted once; every selected 펜 stroke in one
// region, §29), the region request (no strokes in the crop while they are not shown), and the context chip for the
// memos given to the tutor. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ATTACHMENTS, type Attachment } from '../../shared/types.ts';
import { annotationAttachPlan, attachmentLabel, attachmentTitle, chipOfItem, chipsReducer, regionRequest, type Chip } from '../src/lib/attachments.ts';
import { describeContext } from '../src/lib/format.ts';
import { itemBounds } from '../src/lib/annotations/geometry.ts';

const region = (annotation?: Attachment['annotation']): Attachment => ({
  id: 'att-1',
  kind: 'region',
  slide: 12,
  rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  width: 200,
  height: 100,
  text: '',
  createdAt: '2026-09-29T10:00:00.000Z',
  ...(annotation ? { annotation } : {}),
});

describe('chip labels of a 필기 attachment', () => {
  test('p.12 메모 / 형광 / 텍스트 / 사각형 / 동그라미; a plain region stays p.12 영역', () => {
    assert.equal(attachmentLabel(region()), 'p.12 영역');
    assert.equal(attachmentLabel(region({ id: 'an-000000000001', type: 'memo', text: '메모' })), 'p.12 메모');
    assert.equal(attachmentLabel(region({ id: 'an-000000000001', type: 'highlight' })), 'p.12 형광');
    assert.equal(attachmentLabel(region({ id: 'an-000000000001', type: 'textHighlight', text: 'words' })), 'p.12 형광');
    assert.equal(attachmentLabel(region({ id: 'an-000000000001', type: 'text', text: 't' })), 'p.12 텍스트');
    assert.equal(attachmentLabel(region({ id: 'an-000000000001', type: 'rect' })), 'p.12 사각형');
    assert.equal(attachmentLabel(region({ id: 'an-000000000001', type: 'ellipse' })), 'p.12 동그라미');
    assert.equal(attachmentLabel({ kind: 'region', annotation: { id: 'an-000000000001', type: 'memo' } }), '메모');
  });

  test('titles say what the region shows', () => {
    assert.equal(attachmentTitle(region()), '슬라이드 12에서 선택한 영역');
    assert.equal(attachmentTitle(region({ id: 'an-000000000001', type: 'memo' })), '슬라이드 12에 붙인 메모');
    assert.equal(attachmentTitle(region({ id: 'an-000000000001', type: 'ellipse' })), '슬라이드 12에 동그라미로 표시한 부분');
  });

  test('the chip keeps the 필기 label once the server answers (the ready recompute)', () => {
    const uploading: Chip = {
      key: 'region-1',
      kind: 'region',
      label: 'p.12 메모',
      title: '슬라이드 12에 붙인 메모',
      slide: 12,
      rect: itemBounds({ id: 'an-000000000001', type: 'memo', color: 'pink', createdAt: '', updatedAt: '', at: { x: 0.3, y: 0.3 }, text: '', tags: [], collapsed: false, tutor: true, links: [] }),
      status: 'uploading',
      progress: 0,
    };
    const state = chipsReducer({ docId: 'doc-1', items: [uploading] }, { type: 'ready', key: 'region-1', attachment: region({ id: 'an-000000000001', type: 'memo', text: '메모' }) });
    assert.equal(state.items[0].label, 'p.12 메모');
    assert.equal(state.items[0].status, 'ready');
    assert.equal(state.items[0].attachment?.annotation?.id, 'an-000000000001');
    assert.deepEqual(uploading.rect, { x: 0.3, y: 0.3, w: 0.12, h: 0.08 });
  });
});

describe('📎 첨부 of a group selection (annotationAttachPlan)', () => {
  const chip = (key: string, attachment?: Attachment): Chip => ({ key, kind: 'region', label: 'p.12 영역', title: '', slide: 12, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, status: attachment ? 'ready' : 'uploading', progress: 0, ...(attachment ? { attachment } : {}) });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `an-${String(i + 1).padStart(12, '0')}` }));

  test('as many items as there are free slots, in order; the rest is counted as refused (one toast, not one per item)', () => {
    assert.equal(MAX_ATTACHMENTS, 6);
    const items = ids(8);
    const full = annotationAttachPlan([], items);
    assert.deepEqual(full.take.map((unit) => unit.item.id), items.slice(0, 6).map((it) => it.id));
    assert.ok(full.take.every((unit) => unit.members.length === 1 && unit.members[0] === unit.item), 'one chip per item');
    assert.deepEqual([full.refused, full.attached], [2, 0]);
    const twoFree = annotationAttachPlan([chip('a'), chip('b'), chip('c'), chip('d')], items);
    assert.deepEqual([twoFree.take.length, twoFree.refused, twoFree.attached], [2, 6, 0]);
    const none = annotationAttachPlan(Array.from({ length: 6 }, (_, i) => chip(`c${i}`)), items);
    assert.deepEqual([none.take.length, none.refused], [0, 8]);
  });

  test('items attached already are skipped (by the ready chip’s region, or by the uploading chip’s key) and counted apart', () => {
    const items = ids(3);
    const ready = chip('region-1:an-000000000001', region({ id: 'an-000000000001', type: 'rect' }));
    const uploading = chip('region-2:an-000000000002');
    assert.equal(chipOfItem(ready, 'an-000000000001'), true);
    assert.equal(chipOfItem(uploading, 'an-000000000002'), true);
    assert.equal(chipOfItem(uploading, 'an-000000000003'), false);
    const plan = annotationAttachPlan([ready, uploading], items);
    assert.deepEqual(plan.take.map((unit) => unit.item.id), ['an-000000000003']);
    assert.deepEqual([plan.refused, plan.attached], [0, 2]);
    // All attached already: nothing to do, nothing refused.
    assert.deepEqual(annotationAttachPlan([ready, uploading], items.slice(0, 2)), { take: [], refused: 0, attached: 2 });
  });

  // 펜 strokes (DESIGN §29): a word written in ten strokes is one crop, not ten slivers filling the six slots.
  const stroke = (n: number) => ({ id: `an-${String(n).padStart(12, '0')}`, type: 'ink' });
  const shape = (n: number) => ({ id: `an-${String(n).padStart(12, '0')}`, type: 'rect' });

  test('every selected stroke is one chip (made from the first stroke, one slot); other items keep one chip each', () => {
    const strokes = Array.from({ length: 10 }, (_, i) => stroke(i + 1));
    const all = annotationAttachPlan([], strokes);
    assert.equal(all.take.length, 1);
    assert.equal(all.take[0].item.id, strokes[0].id);
    assert.deepEqual(all.take[0].members.map((m) => m.id), strokes.map((m) => m.id));
    assert.deepEqual([all.refused, all.attached], [0, 0]);
    // In z-order: the strokes' chip where the first stroke is.
    const mixed = annotationAttachPlan([], [shape(20), stroke(1), shape(21), stroke(2)]);
    assert.deepEqual(
      mixed.take.map((unit) => unit.members.map((m) => m.id)),
      [[shape(20).id], [stroke(1).id, stroke(2).id], [shape(21).id]],
    );
    // One free slot: the strokes' chip takes it; the shape after it is refused (counted as items).
    const five = Array.from({ length: 5 }, (_, i) => chip(`c${i}`));
    const tight = annotationAttachPlan(five, [stroke(1), stroke(2), stroke(3), shape(20)]);
    assert.deepEqual([tight.take.length, tight.take[0].members.length, tight.refused], [1, 3, 1]);
  });

  test('the merged chip counts each of its strokes as attached; a stroke attached already is left out of a new one', () => {
    const merged: Chip = { ...chip('region-9:an-000000000001'), items: [stroke(1).id, stroke(2).id, stroke(3).id] };
    assert.equal(chipOfItem(merged, stroke(2).id), true, 'not only the stroke it was made from');
    assert.equal(chipOfItem(merged, stroke(4).id), false);
    // Once the server answered, its region names only the first stroke: the chip still stands for all of them.
    const ready = chipsReducer({ docId: 'doc-1', items: [merged] }, { type: 'ready', key: merged.key, attachment: region({ id: stroke(1).id, type: 'ink' }) }).items[0];
    assert.equal(chipOfItem(ready, stroke(3).id), true);
    const again = annotationAttachPlan([ready], [stroke(1), stroke(2), stroke(3)]);
    assert.deepEqual(again, { take: [], refused: 0, attached: 3 });
    const more = annotationAttachPlan([ready], [stroke(2), stroke(4), stroke(5)]);
    assert.deepEqual(more.take.map((unit) => unit.members.map((m) => m.id)), [[stroke(4).id, stroke(5).id]]);
    assert.equal(more.attached, 1);
  });
});

describe('the region request (POST …/regions)', () => {
  const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

  test('the 펜 strokes are drawn into the crop unless the 필기 layer is hidden or a replay runs (ink: false)', () => {
    assert.deepEqual(regionRequest(3, rect, null), { slide: 3, rect });
    assert.deepEqual(regionRequest(3, rect, null, true), { slide: 3, rect });
    assert.deepEqual(regionRequest(3, rect, null, false), { slide: 3, rect, ink: false });
    assert.deepEqual(regionRequest(3, rect, { id: 'an-000000000001', type: 'memo' }, false), { slide: 3, rect, annotationId: 'an-000000000001', ink: false });
  });

  test('a region made from a stroke always has them', () => {
    assert.deepEqual(regionRequest(3, rect, { id: 'an-000000000001', type: 'ink' }, false), { slide: 3, rect, annotationId: 'an-000000000001' });
  });
});

describe('the memos context chip', () => {
  test('메모 N개 after the attachments chip; absent when none', () => {
    const chips = describeContext({ primed: false, rollover: false, attachedSlides: [3], reusedSlides: [], overviewImages: 0, attachments: 1, memos: 2 });
    assert.deepEqual(chips.map((c) => c.kind), ['attached', 'attachments', 'memos']);
    assert.equal(chips[2].text, '메모 2개');
    assert.ok(chips[2].title && chips[2].title.includes('튜터'));
    const none = describeContext({ primed: false, rollover: false, attachedSlides: [], reusedSlides: [], overviewImages: 0, memos: 0 });
    assert.equal(none.length, 0);
  });
});
