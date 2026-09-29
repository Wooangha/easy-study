// Undo / redo of slide annotations (DESIGN §25): one global stack in edit order, inverse ops from the pre-state,
// coalesced text edits, the cap, pruning. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MemoItem, RectItem, SlideAnnotations } from '../../shared/types.ts';
import { applyOps, emptySlideAnnotations } from '../src/lib/annotations/geometry.ts';
import {
  MAX_HISTORY,
  TEXT_COALESCE_MS,
  emptyHistory,
  entryItemId,
  inverseOps,
  popRedo,
  popUndo,
  pruneSlide,
  recordEntry,
} from '../src/lib/annotations/history.ts';

const NOW = '2026-09-29T10:00:00.000Z';
const rect = (id: string, x = 0.1): RectItem => ({ id, type: 'rect', color: 'yellow', createdAt: NOW, updatedAt: NOW, rect: { x, y: 0.1, w: 0.2, h: 0.1 } });
const memo = (id: string, text = ''): MemoItem => ({
  id,
  type: 'memo',
  color: 'pink',
  createdAt: NOW,
  updatedAt: NOW,
  at: { x: 0.5, y: 0.5 },
  text,
  tags: [],
  collapsed: false,
  tutor: true,
  links: [],
});
const doc = (items: SlideAnnotations['items'] = []): SlideAnnotations => ({ ...emptySlideAnnotations(2), rev: 1, items });
const key = { sessionId: 's', messageId: 'm', attachmentId: 'a' };

describe('inverseOps', () => {
  test('add ↔ remove, update ↔ update with the previous fields, hide ↔ unhide; applying both gives the start back', () => {
    const start = doc([rect('an-000000000001'), memo('an-000000000002', 'old')]);
    const ops = [
      { op: 'add' as const, item: rect('an-000000000003') },
      { op: 'update' as const, id: 'an-000000000001', patch: { color: 'blue' as const, rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, updatedAt: 'later' } },
      { op: 'remove' as const, id: 'an-000000000002' },
      { op: 'hideMarker' as const, key },
    ];
    const inverse = inverseOps(start, ops);
    assert.deepEqual(inverse, [
      { op: 'unhideMarker', key },
      { op: 'add', item: memo('an-000000000002', 'old') },
      { op: 'update', id: 'an-000000000001', patch: { color: 'yellow', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } } },
      { op: 'remove', id: 'an-000000000003' },
    ]);
    const after = applyOps(start, ops);
    // `updatedAt` is never restored (the server stamps it): everything else is back.
    const without = (items: SlideAnnotations['items']) => items.map(({ updatedAt: _u, ...rest }) => rest);
    assert.deepEqual(without(applyOps(after, inverse).items), without(start.items));
    assert.deepEqual(applyOps(after, inverse).hiddenMarkers, []);
  });

  test('ops that change nothing have no inverse', () => {
    const start = doc([rect('an-000000000001')]);
    assert.deepEqual(inverseOps(start, [{ op: 'remove', id: 'an-000000000009' }]), []);
    assert.deepEqual(inverseOps(start, [{ op: 'update', id: 'an-000000000009', patch: { color: 'blue' } }]), []);
    assert.deepEqual(inverseOps(start, [{ op: 'add', item: rect('an-000000000001') }]), []);
    assert.deepEqual(inverseOps(start, [{ op: 'unhideMarker', key }]), []);
    // A sequence: the second op sees the first.
    assert.deepEqual(inverseOps(start, [{ op: 'remove', id: 'an-000000000001' }, { op: 'remove', id: 'an-000000000001' }]), [
      { op: 'add', item: rect('an-000000000001') },
    ]);
  });
});

describe('the global stack', () => {
  test('entries in edit order across slides; undo moves to redo and back; a new edit clears the redo stack', () => {
    let h = emptyHistory();
    h = recordEntry(h, 3, doc(), [{ op: 'add', item: rect('an-000000000001') }], 1000);
    h = recordEntry(h, 5, doc(), [{ op: 'add', item: rect('an-000000000002') }], 2000);
    assert.deepEqual(h.undo.map((e) => e.slide), [3, 5]);
    const u1 = popUndo(h)!;
    assert.equal(u1.entry.slide, 5);
    assert.deepEqual(u1.entry.undo, [{ op: 'remove', id: 'an-000000000002' }]);
    assert.equal(entryItemId(u1.entry), 'an-000000000002');
    h = u1.history;
    assert.deepEqual([h.undo.length, h.redo.length], [1, 1]);
    const r1 = popRedo(h)!;
    assert.equal(r1.entry.slide, 5);
    assert.deepEqual(r1.entry.redo, [{ op: 'add', item: rect('an-000000000002') }]);
    h = r1.history;
    assert.deepEqual([h.undo.length, h.redo.length], [2, 0]);
    h = popUndo(h)!.history;
    h = recordEntry(h, 7, doc(), [{ op: 'add', item: rect('an-000000000003') }], 3000);
    assert.deepEqual([h.undo.map((e) => e.slide), h.redo.length], [[3, 7], 0]);
    assert.equal(popRedo(h), null);
  });

  test('nothing is recorded for ops that change nothing', () => {
    const h = emptyHistory();
    assert.equal(recordEntry(h, 1, doc(), [{ op: 'remove', id: 'an-000000000009' }], 0), h);
  });

  test('consecutive text edits of one item within 2 s are one entry (the undo keeps the oldest text)', () => {
    let h = emptyHistory();
    let d = doc([memo('an-000000000001', '')]);
    const type = (text: string, at: number) => {
      const ops = [{ op: 'update' as const, id: 'an-000000000001', patch: { text } }];
      h = recordEntry(h, 2, d, ops, at);
      d = applyOps(d, ops);
    };
    type('가', 1000);
    type('가나', 1600);
    type('가나다', 2500);
    assert.equal(h.undo.length, 1);
    assert.deepEqual(h.undo[0].undo, [{ op: 'update', id: 'an-000000000001', patch: { text: '' } }]);
    assert.deepEqual(h.undo[0].redo, [{ op: 'update', id: 'an-000000000001', patch: { text: '가나다' } }]);
    type('가나다라', 2500 + TEXT_COALESCE_MS + 1); // a pause: a new step
    assert.equal(h.undo.length, 2);
    assert.deepEqual(h.undo[1].undo, [{ op: 'update', id: 'an-000000000001', patch: { text: '가나다' } }]);
    // Another item's text, or another field: not coalesced.
    h = recordEntry(h, 2, d, [{ op: 'update', id: 'an-000000000001', patch: { color: 'blue' } }], 4600);
    assert.equal(h.undo.length, 3);
  });

  test('the cap keeps the newest MAX_HISTORY entries', () => {
    let h = emptyHistory();
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      h = recordEntry(h, 1, doc(), [{ op: 'add', item: rect(`an-${String(i).padStart(12, '0')}`) }], i);
    }
    assert.equal(h.undo.length, MAX_HISTORY);
    assert.equal(h.undo[0].at, 5);
  });

  test('pruneSlide drops the entries of one slide from both stacks', () => {
    let h = emptyHistory();
    h = recordEntry(h, 1, doc(), [{ op: 'add', item: rect('an-000000000001') }], 1);
    h = recordEntry(h, 2, doc(), [{ op: 'add', item: rect('an-000000000002') }], 2);
    h = recordEntry(h, 1, doc(), [{ op: 'add', item: rect('an-000000000003') }], 3);
    h = popUndo(h)!.history;
    const pruned = pruneSlide(h, 1);
    assert.deepEqual(pruned.undo.map((e) => e.slide), [2]);
    assert.deepEqual(pruned.redo, []);
    assert.equal(pruneSlide(pruned, 9), pruned);
  });
});
