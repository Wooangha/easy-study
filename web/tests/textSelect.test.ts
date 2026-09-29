// 텍스트 형광 (DESIGN §25): the nearest words in reading order (along a line's direction, 'h' or 'v'), the char range
// and one rect per line; re-anchoring by text after an engine change. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SlideTextLayout } from '../../shared/types.ts';
import { nearestLine, reanchorTextHighlight, textHighlightFromDrag, wordAt } from '../src/lib/annotations/textSelect.ts';

const layout: SlideTextLayout = {
  version: 1,
  engine: 'pdfium-3',
  lines: [
    {
      r: [0.1, 0.2, 0.6, 0.04],
      dir: 'h',
      words: [
        { r: [0.1, 0.2, 0.15, 0.04], t: 'Parsing', c: [0, 7] },
        { r: [0.27, 0.2, 0.1, 0.04], t: 'is', c: [8, 10] },
        { r: [0.39, 0.2, 0.31, 0.04], t: 'analysis', c: [11, 19] },
      ],
    },
    {
      r: [0.1, 0.26, 0.4, 0.04],
      dir: 'h',
      words: [
        { r: [0.1, 0.26, 0.12, 0.04], t: 'of', c: [21, 23] },
        { r: [0.24, 0.26, 0.26, 0.04], t: 'tokens', c: [24, 30] },
      ],
    },
  ],
};

const vertical: SlideTextLayout = {
  version: 1,
  engine: 'pdfium-3',
  lines: [
    {
      r: [0.8, 0.1, 0.04, 0.6],
      dir: 'v',
      words: [
        { r: [0.8, 0.1, 0.04, 0.2], t: 'top', c: [0, 3] },
        { r: [0.8, 0.32, 0.04, 0.18], t: 'middle', c: [4, 10] },
        { r: [0.8, 0.52, 0.04, 0.18], t: 'bottom', c: [11, 17] },
      ],
    },
  ],
};

describe('textHighlightFromDrag', () => {
  test('words between the nearest word to each end, in reading order; one rect per line; chars = [min, max)', () => {
    const fit = textHighlightFromDrag({ x: 0.3, y: 0.22 }, { x: 0.15, y: 0.27 }, layout)!;
    assert.deepEqual(fit.chars, [8, 23]);
    assert.equal(fit.text, 'is analysis\nof');
    assert.deepEqual(fit.rects, [
      { x: 0.27, y: 0.2, w: 0.43, h: 0.04 },
      { x: 0.1, y: 0.26, w: 0.12, h: 0.04 },
    ]);
    assert.equal(fit.engine, 'pdfium-3');
  });

  test('a drag within one word gives that word; either direction is the same', () => {
    const a = textHighlightFromDrag({ x: 0.12, y: 0.21 }, { x: 0.2, y: 0.21 }, layout)!;
    const b = textHighlightFromDrag({ x: 0.2, y: 0.21 }, { x: 0.12, y: 0.21 }, layout)!;
    assert.deepEqual(a, b);
    assert.equal(a.text, 'Parsing');
    assert.deepEqual(a.chars, [0, 7]);
  });

  test('past the last line / beyond a line’s end: the nearest line, its last word', () => {
    assert.equal(nearestLine(layout, { x: 0.3, y: 0.9 }), 1);
    assert.deepEqual(wordAt(layout, { x: 0.95, y: 0.21 }), { line: 0, word: 2 });
    assert.deepEqual(wordAt(layout, { x: 0.0, y: 0.5 }), { line: 1, word: 0 });
    const fit = textHighlightFromDrag({ x: 0.28, y: 0.21 }, { x: 0.3, y: 0.95 }, layout)!;
    assert.equal(fit.text, 'is analysis\nof tokens');
  });

  test('a vertical line orders its words along y', () => {
    const fit = textHighlightFromDrag({ x: 0.82, y: 0.55 }, { x: 0.82, y: 0.35 }, vertical)!;
    assert.equal(fit.text, 'middle bottom');
    assert.deepEqual(fit.chars, [4, 17]);
    assert.deepEqual(fit.rects, [{ x: 0.8, y: 0.32, w: 0.04, h: 0.38 }]);
  });

  test('a layout without words gives nothing (the tool falls back to a plain band)', () => {
    assert.equal(textHighlightFromDrag({ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { version: 1, engine: 'pdfium-3', lines: [] }), null);
  });
});

describe('reanchorTextHighlight', () => {
  const item = { chars: [100, 110] as [number, number], engine: 'pdfium-2', text: 'is analysis\nof' };

  test('the same engine: trusted as is', () => {
    assert.equal(reanchorTextHighlight({ ...item, engine: 'pdfium-3' }, layout), null);
  });

  test('another engine: the words are searched and the fit recomputed there', () => {
    const fit = reanchorTextHighlight(item, layout)!;
    assert.deepEqual(fit.chars, [8, 23]);
    assert.equal(fit.engine, 'pdfium-3');
    assert.equal(fit.rects.length, 2);
  });

  test('words not found: unchanged', () => {
    assert.equal(reanchorTextHighlight({ ...item, text: 'nowhere at all' }, layout), null);
    assert.equal(reanchorTextHighlight({ ...item, text: '  ' }, layout), null);
  });
});
