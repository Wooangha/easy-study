// The playhead store (DESIGN §25 "그때 필기 재생"): set / clear / subscribe semantics. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clearPlayhead, getPlayhead, samePlayhead, setPlayhead, subscribePlayhead } from '../src/lib/recording/playhead.ts';

describe('playhead store', () => {
  test('set notifies on a change only; clear removes the playhead of that recording only', () => {
    const seen: Array<string | null> = [];
    const off = subscribePlayhead(() => seen.push(getPlayhead() ? `${getPlayhead()!.rid}@${getPlayhead()!.t}` : null));
    assert.equal(getPlayhead(), null);
    setPlayhead(null);
    setPlayhead({ docId: 'doc-1', rid: 'rec-1', t: 12.5, playing: true });
    setPlayhead({ docId: 'doc-1', rid: 'rec-1', t: 12.5, playing: true }); // the same values
    setPlayhead({ docId: 'doc-1', rid: 'rec-1', t: 13, playing: true });
    clearPlayhead('rec-2');
    clearPlayhead('rec-1');
    assert.deepEqual(seen, ['rec-1@12.5', 'rec-1@13', null]);
    off();
    setPlayhead({ docId: 'doc-1', rid: 'rec-1', t: 1, playing: false });
    assert.equal(seen.length, 3);
    setPlayhead(null);
  });

  test('samePlayhead compares every field', () => {
    const a = { docId: 'd', rid: 'r', t: 1, playing: false };
    assert.equal(samePlayhead(a, { ...a }), true);
    assert.equal(samePlayhead(a, { ...a, playing: true }), false);
    assert.equal(samePlayhead(a, { ...a, t: 2 }), false);
    assert.equal(samePlayhead(null, null), true);
    assert.equal(samePlayhead(a, null), false);
  });
});
