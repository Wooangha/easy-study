// The text layout of a page (server/pdf.ts textLayout(), DESIGN §25): word boxes normalised to the rendered image,
// lines in content order with the axis their words advance along ('h' / 'v'), rotation-aware (a /Rotate page whose
// glyphs are drawn at angle 0 gives vertical lines; one whose glyphs are drawn turned gives upright ones), CJK word
// breaks, super/subscripts kept in their word (the rule text() uses), char ranges consistent with textInRegion, the
// Symbol-font remap; the worker writes text/NNN.layout.json and the backfill retrofits a pdfium-2 library.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { LayoutBox, SlideTextLayout } from '../shared/types.ts';
import { docPaths, importPdf, startBackfill, waitForBackfill, waitForIngest } from '../server/library.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE, layoutFileName } from '../server/pageNames.ts';
import { isCjkBreakPoint, isHangulSyllable, lineDirection, openPdf } from '../server/pdf.ts';
import type { PdfPage } from '../server/pdf.ts';
import { baselinePdf, cjkPdf, deckPdf, pagesPdf, symbolFontPdf } from './pdfFixtures.ts';

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-layout-'));
  process.env.EASY_STUDY_LIBRARY = path.join(tmpRoot, 'library');
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function fixture(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(tmpRoot, name);
  await fs.writeFile(file, bytes);
  return file;
}

/** Opens a fixture and runs `use` on its page `n` (closed afterwards). */
async function withPage<T>(name: string, bytes: Buffer, n: number, use: (page: PdfPage) => T): Promise<T> {
  const doc = await openPdf(await fixture(name, bytes));
  try {
    return doc.withPage(n, use);
  } finally {
    doc.close();
  }
}

type Line = SlideTextLayout['lines'][number];

const words = (lines: Line[]) => lines.map((line) => line.words.map((word) => word.t));
const inside = ([x, y, w, h]: LayoutBox, band: { x0: number; y0: number; x1: number; y1: number }) =>
  x >= band.x0 && y >= band.y0 && x + w <= band.x1 && y + h <= band.y1;
const contains = (outer: LayoutBox, inner: LayoutBox) =>
  inner[0] >= outer[0] - 1e-4 && inner[1] >= outer[1] - 1e-4 && inner[0] + inner[2] <= outer[0] + outer[2] + 1e-4 && inner[1] + inner[3] <= outer[1] + outer[3] + 1e-4;

/** A CJK page in the non-embedded Korean CID font of cjkPdf: `hex` = UCS-2 big-endian code units. */
function cjkLinePdf(hex: string): Buffer {
  return pagesPdf(
    [{ content: `BT /F1 96 Tf 80 250 Td <${hex}> Tj ET` }],
    ['<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [ 4 0 R ] >>'],
    [
      '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /DW 1000 /FontDescriptor 5 0 R >>',
      '<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 6 /FontBBox [-6 -145 1003 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>',
    ],
  );
}

describe('lineDirection and the CJK classes (pure)', () => {
  test('upright glyphs on an unrotated page and glyphs turned with their /Rotate read horizontally; the others vertically', () => {
    assert.equal(lineDirection(0, 0), 'h');
    assert.equal(lineDirection(2 * Math.PI - 0.1, 0), 'h', 'a synthetic italic stays upright');
    assert.equal(lineDirection(Math.PI, 0), 'h', 'upside down still runs along x');
    assert.equal(lineDirection(Math.PI / 2, 0), 'v');
    assert.equal(lineDirection((3 * Math.PI) / 2, 0), 'v');
    // /Rotate 90 (one quarter turn clockwise) turns an angle-0 glyph on its side and straightens a glyph drawn at +90°.
    assert.equal(lineDirection(0, 1), 'v');
    assert.equal(lineDirection(Math.PI / 2, 1), 'h');
    assert.equal(lineDirection(0, 2), 'h');
    assert.equal(lineDirection(0, 3), 'v');
    assert.equal(lineDirection(Math.PI / 2, 3), 'h', 'a quarter turn each way: upside down, still along x');
    assert.equal(lineDirection((3 * Math.PI) / 2, 1), 'h');
    assert.equal(lineDirection(Math.PI / 4, 0), null, 'diagonal text gets no box');
    assert.equal(lineDirection(Number.NaN, 0), null);
  });

  test('Han, Hiragana and Katakana break words; Hangul syllables are told apart from other letters', () => {
    assert.ok(isCjkBreakPoint('漢'.codePointAt(0)!));
    assert.ok(isCjkBreakPoint('あ'.codePointAt(0)!));
    assert.ok(isCjkBreakPoint('ア'.codePointAt(0)!));
    assert.ok(isCjkBreakPoint(0x20000));
    assert.ok(!isCjkBreakPoint('한'.codePointAt(0)!));
    assert.ok(!isCjkBreakPoint('a'.codePointAt(0)!));
    assert.ok(isHangulSyllable('한'.codePointAt(0)!));
    assert.ok(!isHangulSyllable('漢'.codePointAt(0)!));
  });
});

describe('textLayout() of a page', () => {
  test('a plain deck: one horizontal line, words with boxes in the title band and char ranges textInRegion agrees with', async () => {
    await withPage('deck.pdf', deckPdf(2), 2, (page) => {
      const lines = page.textLayout();
      assert.deepEqual(words(lines), [['Slide', '2']]);
      const line = lines[0];
      assert.equal(line.dir, 'h');
      // "Slide 2" is drawn at (60, 440) pt in 48 pt on a 960 x 540 page: the top-left band of the image.
      for (const word of line.words) assert.ok(inside(word.r, { x0: 0.05, y0: 0.08, x1: 0.25, y1: 0.22 }), JSON.stringify(word));
      assert.ok(contains(line.r, line.words[0].r) && contains(line.r, line.words[1].r), 'the line box holds its words');
      assert.ok(line.words[1].r[0] > line.words[0].r[0] + line.words[0].r[2], 'words advance along x');
      assert.deepEqual(line.words.map((word) => word.c), [[0, 5], [6, 7]]);
      for (const word of line.words) {
        const [x, y, w, h] = word.r;
        assert.equal(page.textInRegion({ x, y, w, h }), word.t, `the box of ${word.t} covers exactly it`);
      }
      // Four decimals everywhere.
      for (const value of [...line.r, ...line.words.flatMap((word) => word.r)]) assert.equal(value, Math.round(value * 1e4) / 1e4);
    });
  });

  test('a /Rotate 90 page (glyphs at angle 0): the line runs down the image, in the top-right band', async () => {
    await withPage('rotated.pdf', deckPdf(1, { rotate: 90 }), 1, (page) => {
      assert.deepEqual([page.width, page.height], [540, 960]);
      const lines = page.textLayout();
      assert.deepEqual(words(lines), [['Slide', '1']]);
      const line = lines[0];
      assert.equal(line.dir, 'v');
      for (const word of line.words) assert.ok(inside(word.r, { x0: 0.75, y0: 0.05, x1: 0.95, y1: 0.25 }), JSON.stringify(word));
      const [slide, one] = line.words;
      assert.ok(one.r[1] > slide.r[1] + slide.r[3], 'the second word is below the first');
      assert.ok(Math.abs(one.r[0] - slide.r[0]) < 0.005, 'both words share the line band across');
      for (const word of line.words) {
        const [x, y, w, h] = word.r;
        assert.equal(page.textInRegion({ x, y, w, h }), word.t);
      }
    });
  });

  test('glyphs drawn turned (Tm [0 1 -1 0 x y]) on a /Rotate 90 page read upright: a horizontal line, boxes where the text shows', async () => {
    const turned = pagesPdf([{ content: 'BT /F1 48 Tf 0 1 -1 0 500 60 Tm (Slide 1) Tj ET', rotate: 90 }], [HELVETICA]);
    await withPage('turned.pdf', turned, 1, (page) => {
      const lines = page.textLayout();
      assert.deepEqual(words(lines), [['Slide', '1']]);
      const line = lines[0];
      assert.equal(line.dir, 'h');
      // The text starts at user-space (500, 60) going up; the page's clockwise quarter turn puts it left of centre,
      // reading left to right at about 47 % down the 540 x 960 image.
      for (const word of line.words) assert.ok(inside(word.r, { x0: 0.08, y0: 0.44, x1: 0.42, y1: 0.56 }), JSON.stringify(word));
      assert.ok(line.words[1].r[0] > line.words[0].r[0] + line.words[0].r[2], 'words advance along x');
      for (const word of line.words) {
        const [x, y, w, h] = word.r;
        assert.equal(page.textInRegion({ x, y, w, h }), word.t);
      }
    });
    // The same glyphs on an unrotated page run up the image: a vertical line.
    const flat = pagesPdf([{ content: 'BT /F1 48 Tf 0 1 -1 0 500 60 Tm (Slide 1) Tj ET' }], [HELVETICA]);
    await withPage('turned-flat.pdf', flat, 1, (page) => {
      const lines = page.textLayout();
      assert.deepEqual(words(lines), [['Slide', '1']]);
      assert.equal(lines[0].dir, 'v');
    });
  });

  test('Symbol-font PUA characters come back in the words; a Wingdings bullet stays as it is', async () => {
    await withPage('symbol.pdf', symbolFontPdf(), 1, (page) => {
      const lines = page.textLayout();
      assert.deepEqual(words(lines), [['Sets:', 'α β ∪ ∈ ∅ →'], ['', 'done']]);
      assert.ok(lines[1].r[1] > lines[0].r[1] + lines[0].r[3], 'the second line is below the first');
      const [x, y, w, h] = lines[0].words[1].r;
      assert.equal(page.textInRegion({ x, y, w, h }), 'α β ∪ ∈ ∅ →');
    });
  });

  test('super/subscripts stay in their word (as in the page text); real line ends split lines; cells on one baseline stay on one line', async () => {
    await withPage('baselines.pdf', baselinePdf(), 1, (page) => {
      const lines = page.textLayout();
      assert.deepEqual(words(lines), [
        ['Rank', '1st', 'and', '2nd'],
        ['x2', '+', 'Ai', 'done'],
        ['if', 'E2', 'then'],
        ['fixed', 'point†'],
        ['lower', 'right'],
        ['Cell', 'A', 'Cell', 'B'],
      ]);
      assert.deepEqual(
        page.text().split('\n'),
        lines.map((line) => line.words.map((word) => word.t).join(' ')),
        'the layout lines are the text lines',
      );
      // The superscript joined into "1st" widens the word's band upward.
      const rank = lines[0].words[0].r;
      const first = lines[0].words[1].r;
      assert.ok(first[1] <= rank[1] && first[1] + first[3] >= rank[1] + rank[3] - 1e-4);
      // Char ranges advance with the text and never overlap.
      const ranges = lines.flatMap((line) => line.words.map((word) => word.c));
      for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] >= ranges[i - 1][1], JSON.stringify(ranges));
    });
  });

  test('CJK: Korean keeps its spaced words, a line without spaces is split per syllable, Han is one word per character', async () => {
    await withPage('korean.pdf', cjkPdf(), 1, (page) => {
      assert.deepEqual(words(page.textLayout()), [['한글', '강의']]);
    });
    await withPage('korean-nospace.pdf', cjkLinePdf('D55CAE00AC15C758'), 1, (page) => {
      const lines = page.textLayout();
      assert.deepEqual(words(lines), [['한', '글', '강', '의']]);
      const xs = lines[0].words.map((word) => word.r[0]);
      assert.deepEqual(xs, [...xs].sort((a, b) => a - b), 'syllables advance along x');
      assert.deepEqual(lines[0].words.map((word) => word.c), [[0, 1], [1, 2], [2, 3], [3, 4]]);
    });
    // 漢字 (U+6F22 U+5B57) then a space and 한글: the Han characters are words of their own even with a space on the line.
    await withPage('han.pdf', cjkLinePdf('6F225B570020D55CAE00'), 1, (page) => {
      assert.deepEqual(words(page.textLayout()), [['漢', '字', '한글']]);
    });
  });

  test('a page without text has no lines', async () => {
    const blank = pagesPdf([{ content: '0 0 1 rg 100 100 200 200 re f' }], [HELVETICA]);
    await withPage('blank.pdf', blank, 1, (page) => {
      assert.deepEqual(page.textLayout(), []);
    });
  });
});

describe('the layout files of a library document', () => {
  test('the ingest writes text/NNN.layout.json next to the text; a pdfium-2 document is re-extracted by the backfill and gains them', async () => {
    const doc = await importPdf(deckPdf(3), 'Layout Deck.pdf');
    await waitForIngest(doc.id);
    await waitForBackfill();
    const paths = docPaths(doc.id);
    const file = (n: number) => path.join(paths.textDir, layoutFileName(n, 3));
    const read = async (n: number) => JSON.parse(await fs.readFile(file(n), 'utf8')) as SlideTextLayout;
    for (let n = 1; n <= 3; n++) {
      const layout = await read(n);
      assert.deepEqual([layout.version, layout.engine], [1, TEXT_ENGINE]);
      assert.deepEqual(words(layout.lines), [['Slide', String(n)]]);
      assert.equal(layout.lines[0].dir, 'h');
    }

    // A library converted by pdfium-2: text files but no layouts, and the older marker.
    for (let n = 1; n <= 3; n++) await fs.rm(file(n));
    await fs.writeFile(path.join(paths.textDir, TEXT_ENGINE_FILE), 'pdfium-2\n');
    await startBackfill();
    await waitForBackfill();
    assert.equal(await fs.readFile(path.join(paths.textDir, TEXT_ENGINE_FILE), 'utf8'), `${TEXT_ENGINE}\n`);
    for (let n = 1; n <= 3; n++) assert.deepEqual(words((await read(n)).lines), [['Slide', String(n)]]);
  });
});
