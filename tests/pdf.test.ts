// The PDF engine (server/pdf.ts, DESIGN §3, §17): PDFium-wasm opened on a file (FPDF_LoadCustomDocument),
// page sizes and renderings (form fields included), text with the Symbol-font PUA remap and the annotations' text,
// readable open errors, the CJK fallback font list, and resources that are given back. In-process here; the server itself only runs it in the worker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { repoRoot } from '../server/config.ts';
import { cleanPageText, engineHeapBytes, fallbackFontFiles, lineBreakJoint, openErrorMessage, openPdf, symbolPuaToUnicode } from '../server/pdf.ts';
import { GARBAGE_PDF, baselinePdf, cjkPdf, deckPdf, encryptedPdf, formPdf, symbolFontPdf } from './pdfFixtures.ts';

const SAMPLE = path.join(repoRoot(), 'samples', 'sample-lecture.pdf');
let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-pdf-'));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function fixture(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(tmpRoot, name);
  await fs.writeFile(file, bytes);
  return file;
}

/** Open file descriptors of this process (null where /dev/fd does not list them, e.g. Windows). */
function openFdCount(): number | null {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

describe('Symbol-font PUA remap', () => {
  test('U+F020..U+F0FF of a Symbol font map through the Adobe Symbol encoding', () => {
    assert.equal(symbolPuaToUnicode(0xf061, 'BCDNEE+SymbolMT'), 'α');
    assert.equal(symbolPuaToUnicode(0xf065, 'SymbolMT'), 'ε');
    assert.equal(symbolPuaToUnicode(0xf0c8, 'Symbol'), '∪');
    assert.equal(symbolPuaToUnicode(0xf0c7, 'symbol'), '∩');
    assert.equal(symbolPuaToUnicode(0xf0ce, 'SymbolMT'), '∈');
    assert.equal(symbolPuaToUnicode(0xf0c6, 'SymbolMT'), '∅');
    assert.equal(symbolPuaToUnicode(0xf0ae, 'SymbolMT'), '→');
    assert.equal(symbolPuaToUnicode(0xf020, 'SymbolMT'), ' ');
    assert.equal(symbolPuaToUnicode(0xf0fe, 'SymbolMT'), '⎭');
  });

  test('other fonts, code points outside the range and unassigned codes stay as they are', () => {
    assert.equal(symbolPuaToUnicode(0xf0a7, 'Wingdings-Regular'), null);
    assert.equal(symbolPuaToUnicode(0xf06c, 'ABCDEF+Webdings'), null);
    assert.equal(symbolPuaToUnicode(0xf061, ''), null);
    assert.equal(symbolPuaToUnicode(0x61, 'SymbolMT'), null);
    assert.equal(symbolPuaToUnicode(0xf01f, 'SymbolMT'), null);
    assert.equal(symbolPuaToUnicode(0xf100, 'SymbolMT'), null);
    assert.equal(symbolPuaToUnicode(0xf060, 'SymbolMT'), null, '0x60 has no Symbol glyph');
    assert.equal(symbolPuaToUnicode(0xf0ff, 'SymbolMT'), null);
  });

  test('page text: Symbol-font PUA characters come back, a Wingdings bullet is left alone', async () => {
    const doc = await openPdf(await fixture('symbol.pdf', symbolFontPdf()));
    try {
      const text = doc.withPage(1, (page) => page.text());
      assert.equal(text, 'Sets: α β ∪ ∈ ∅ →\n\uf0a7 done');
      assert.equal(cleanPageText(text), 'Sets: α β ∪ ∈ ∅ →\n\uf0a7 done');
    } finally {
      doc.close();
    }
  });
});

describe('opening PDFs', () => {
  test('page count, sizes with /Rotate applied, renderings at the requested long edge', async () => {
    const sample = await openPdf(SAMPLE);
    try {
      assert.equal(sample.pageCount, 9);
      const first = sample.withPage(1, (page) => ({ width: page.width, height: page.height, rendered: page.render(1600) }));
      assert.deepEqual([Math.round(first.width), Math.round(first.height)], [960, 540]);
      assert.deepEqual([first.rendered.width, first.rendered.height], [1600, 900]);
      assert.equal(first.rendered.data.length, 1600 * 900 * 4);
      assert.match(sample.withPage(1, (page) => page.text()), /^Lecture 5: CPU Scheduling/);
    } finally {
      sample.close();
    }

    const rotated = await openPdf(await fixture('rotated.pdf', deckPdf(2, { rotate: 90 })));
    try {
      const page = rotated.withPage(2, (p) => ({ width: p.width, height: p.height, rendered: p.render(1600), text: p.text() }));
      assert.deepEqual([page.width, page.height], [540, 960]);
      assert.deepEqual([page.rendered.width, page.rendered.height], [900, 1600]);
      assert.equal(page.text, 'Slide 2');
    } finally {
      rotated.close();
    }
  });

  test('form fields are drawn (with or without an appearance stream); their text and typed notes are extracted', async () => {
    const doc = await openPdf(await fixture('form.pdf', formPdf()));
    try {
      const { rendered, text } = doc.withPage(1, (page) => ({ rendered: page.render(960), text: page.text() }));
      assert.deepEqual([rendered.width, rendered.height], [960, 540]);
      // 1 px = 1 pt; PDF y runs upwards. RGBx, so a red check box stays red (the form layer uses the same byte order).
      const pixel = (x: number, yFromBottom: number) => [...rendered.data.subarray(((539 - yFromBottom) * 960 + x) * 4, ((539 - yFromBottom) * 960 + x) * 4 + 3)];
      assert.deepEqual(pixel(150, 150), [255, 0, 0], 'the checked check box');
      const inkIn = (x0: number, y0: number, x1: number, y1: number) => {
        let ink = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pixel(x, y).some((value) => value < 128)) ink++;
        return ink;
      };
      assert.ok(inkIn(100, 300, 900, 400) > 500, 'the filled-in text field (appearance stream)');
      assert.ok(inkIn(300, 200, 900, 260) > 200, 'the text field without an appearance stream');
      assert.ok(inkIn(300, 100, 900, 160) > 200, 'the typed note');
      assert.equal(inkIn(300, 20, 900, 80), 0, 'the hidden note');
      assert.equal(text, 'Name:\nFILLED ANSWER\ntyped without appearance\ntyped note');
    } finally {
      doc.close();
    }
  });

  test('text of a non-embedded CJK font is extracted (its CMap is built in)', async () => {
    const doc = await openPdf(await fixture('cjk.pdf', cjkPdf()));
    try {
      assert.equal(doc.withPage(1, (page) => page.text()), '한글 강의');
    } finally {
      doc.close();
    }
  });

  test('a password-protected, a damaged and a missing PDF fail with readable messages', async () => {
    await assert.rejects(openPdf(await fixture('locked.pdf', encryptedPdf('secret'))), { message: 'the PDF is password protected' });
    await assert.rejects(openPdf(await fixture('garbage.pdf', GARBAGE_PDF)), {
      message: 'could not read the PDF: the file is damaged or is not a PDF',
    });
    const truncated = (await fs.readFile(SAMPLE)).subarray(0, 400);
    await assert.rejects(openPdf(await fixture('truncated.pdf', truncated)), /^Error: could not read the PDF/);
    await assert.rejects(openPdf(path.join(tmpRoot, 'missing.pdf')), { code: 'ENOENT' });
  });

  test('open error messages by PDFium error code', () => {
    assert.equal(openErrorMessage(4), 'the PDF is password protected');
    assert.equal(openErrorMessage(3), 'could not read the PDF: the file is damaged or is not a PDF');
    assert.equal(openErrorMessage(5), 'could not read the PDF: it is encrypted with an unsupported security handler');
    assert.equal(openErrorMessage(2), 'could not read the PDF file');
    assert.equal(openErrorMessage(1), 'could not read the PDF (PDFium error 1)');
  });

  test('pages, bitmaps and documents are given back: the heap stays, no file stays open, close() is idempotent', async () => {
    const file = await fixture('deck.pdf', deckPdf(3));
    const form = await fixture('form-again.pdf', formPdf());
    const locked = await fixture('locked-again.pdf', encryptedPdf('secret'));
    // Warm up (the engine, the wasm file, one full-size bitmap).
    const warm = await openPdf(file);
    warm.withPage(1, (page) => [page.render(1600), page.text()]);
    warm.close();
    const heapBefore = await engineHeapBytes();
    const before = openFdCount();
    for (let i = 0; i < 25; i++) {
      const doc = await openPdf(file);
      // 75 bitmaps of 1600x900 (5.8 MB each) would grow the heap by far if one was kept.
      for (let n = 1; n <= doc.pageCount; n++) doc.withPage(n, (page) => [page.render(1600), page.text()]);
      // A throwing callback still closes its page.
      assert.throws(() => doc.withPage(1, () => {
        throw new Error('boom');
      }), /boom/);
      assert.throws(() => doc.withPage(4, () => 0), /could not load page 4/);
      doc.close();
      doc.close();
      // A document with a form: its form-fill environment, page views and annotation handles are released too.
      const withForm = await openPdf(form);
      withForm.withPage(1, (page) => [page.render(1600), page.text()]);
      withForm.close();
      await assert.rejects(openPdf(locked), /password/);
    }
    const after = openFdCount();
    if (before !== null) assert.equal(after, before, 'every PDF file was closed again');
    assert.equal(await engineHeapBytes(), heapBefore, 'the wasm heap did not grow');
  });
});

describe('line breaks at shifted baselines (superscripts, subscripts)', () => {
  test('lineBreakJoint: one line when the boxes overlap and the next starts where the last ends', () => {
    // Loose boxes (ascent to descent) in points, y upwards: "1" at 18 pt, then "st" at 12 pt raised by 5.
    const one = { left: 100, right: 110, bottom: 96, top: 116 };
    const sup = { left: 110.2, right: 118, bottom: 102, top: 115 };
    assert.equal(lineBreakJoint(one, sup, false), '', 'touching glyphs: "1st"');
    assert.equal(lineBreakJoint(sup, { left: 118.5, right: 128, bottom: 96, top: 116 }, false), '', 'back on the baseline');
    assert.equal(lineBreakJoint(one, { ...sup, left: 118, right: 126 }, false), ' ', 'a visible gap: "E2 then"');
    assert.equal(lineBreakJoint(one, { ...sup, left: 118, right: 126 }, true), '', 'the text has its space already');
    assert.equal(lineBreakJoint(one, { ...sup, left: 106, right: 114 }, false), '', 'a little overlap is fine (kerning)');
    // Real line ends stay.
    assert.equal(lineBreakJoint(one, { left: 40, right: 50, bottom: 74, top: 94 }, false), null, 'the next line, at the margin');
    assert.equal(lineBreakJoint(one, { left: 112, right: 150, bottom: 74, top: 94 }, false), null, 'the next line, further right');
    assert.equal(lineBreakJoint(one, { left: 112, right: 150, bottom: 84, top: 104 }, false), null, 'overlapping by 40 % only (very tight leading)');
    assert.equal(lineBreakJoint(one, { left: 135, right: 150, bottom: 96, top: 116 }, false), null, 'more than an em apart (a table cell)');
    assert.equal(lineBreakJoint(one, { left: 90, right: 99, bottom: 96, top: 116 }, false), null, 'starts before the last one ends');
    assert.equal(lineBreakJoint(one, { left: 111, right: 111, bottom: 100, top: 100 }, false), null, 'no height');
  });

  test('page text: superscripts and subscripts stay on their line; real line ends stay', async () => {
    const doc = await openPdf(await fixture('baselines.pdf', baselinePdf()));
    try {
      // PDFium generated line breaks before and after "2" (x2), "i" (Ai) and the subscript of "E2 then".
      assert.equal(doc.withPage(1, (page) => page.text()), 'Rank 1st and 2nd\nx2 + Ai done\nif E2 then\nfixed point†\nlower right\nCell A Cell B');
    } finally {
      doc.close();
    }
  });
});

describe('text cleanup', () => {
  test('trims trailing spaces, surrounding blank lines and the common margin; at most one blank line', () => {
    assert.equal(cleanPageText('\r\n\n   Title  \r\n     body\n\n\n\n   end   \n\n'), 'Title\n  body\n\nend');
    assert.equal(cleanPageText(''), '');
    assert.equal(cleanPageText('\n \n'), '');
  });
});

describe('CJK fallback font files', () => {
  test('per platform, in order of preference', () => {
    const empty: NodeJS.ProcessEnv = {};
    assert.deepEqual(fallbackFontFiles('darwin', empty), [
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      '/Library/Fonts/Arial Unicode.ttf',
      '/System/Library/Fonts/AppleSDGothicNeo.ttc',
    ]);
    assert.deepEqual(fallbackFontFiles('win32', { WINDIR: 'D:\\Win' }), [
      'D:\\Win\\Fonts\\malgun.ttf',
      'D:\\Win\\Fonts\\gulim.ttc',
      'D:\\Win\\Fonts\\msgothic.ttc',
      'D:\\Win\\Fonts\\msyh.ttc',
    ]);
    assert.equal(fallbackFontFiles('win32', empty)[0], 'C:\\Windows\\Fonts\\malgun.ttf');
    const linux = fallbackFontFiles('linux', empty);
    assert.ok(linux.some((file) => file.endsWith('NotoSansCJK-Regular.ttc')));
    assert.ok(linux.some((file) => file.endsWith('NanumGothic.ttf')));
    assert.deepEqual(fallbackFontFiles('freebsd', empty), linux);
  });

  test('EASY_STUDY_PDF_FALLBACK_FONT replaces the list (blank = unset)', () => {
    assert.deepEqual(fallbackFontFiles('darwin', { EASY_STUDY_PDF_FALLBACK_FONT: '/fonts/Noto.otf' }), ['/fonts/Noto.otf']);
    assert.deepEqual(fallbackFontFiles('win32', { EASY_STUDY_PDF_FALLBACK_FONT: 'C:\\f\\a.ttf' }), ['C:\\f\\a.ttf']);
    assert.equal(fallbackFontFiles('linux', { EASY_STUDY_PDF_FALLBACK_FONT: '  ' }).length > 1, true);
  });
});
