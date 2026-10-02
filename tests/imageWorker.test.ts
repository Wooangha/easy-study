// The image worker (server/imageWorker.ts, DESIGN §15): the PDF (PDFium-wasm), contact sheets and derived images
// in short-lived child processes, and a server that never loads sharp or PDFium itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { encodeInkPoints, inkRect } from '../shared/ink.ts';
import type { InkPoint } from '../shared/ink.ts';
import { MAX_INK_STROKES } from '../shared/types.ts';
import {
  INLINE_MAX_BYTES,
  INLINE_MAX_EDGE,
  REGION_MIN_PX,
  THUMB_WIDTH,
  VIEW_WIDTHS,
  inlinePathFor,
  isInlineReady,
  regionCropBox,
  thumbPath,
  viewPath,
} from '../server/assets.ts';
import { repoRoot } from '../server/config.ts';
import {
  imageWorkerPath,
  isImageWorkerStopped,
  runAttachmentWorker,
  runImageWorker,
  runPdfWorker,
  runTextWorker,
  slideLabel,
  UPLOAD_MAX_DECODE_BYTES,
  UPLOAD_MAX_PIXELS,
  uploadRefusal,
} from '../server/imageWorker.ts';
import type { AttachmentJob, AttachmentWorkerResult, RegionInk, UploadImageType } from '../server/imageWorker.ts';
import { pngHeaderOnly, svgBehindAvifHeader } from './imageFixtures.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE, layoutFileName, textFileName } from '../server/pageNames.ts';
import { fallbackFontFiles } from '../server/pdf.ts';
import { GARBAGE_PDF, cjkPdf, deckPdf, encryptedPdf, symbolFontPdf } from './pdfFixtures.ts';

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-worker-'));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A document directory with `count` rendered slides (1600x900 PNGs), like the PDF worker leaves them. */
async function makeDocDir(name: string, count: number): Promise<{ docDir: string; slides: string[] }> {
  const docDir = path.join(tmpRoot, name);
  await fs.mkdir(path.join(docDir, 'slides'), { recursive: true });
  const slides: string[] = [];
  for (let n = 1; n <= count; n++) {
    const file = `${String(n).padStart(3, '0')}.png`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#fff"/><text x="80" y="200" font-size="120">Slide ${n}</text><rect x="80" y="400" width="${200 * n}" height="200" fill="#36c"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(docDir, 'slides', file));
    slides.push(file);
  }
  return { docDir, slides };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Runs `fn` with environment variables set (undefined = removed): the worker inherits them at fork time. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

describe('image worker', () => {
  test('builds the contact sheets first, then every derived image; a second run writes nothing', async () => {
    const { docDir, slides } = await makeDocDir('deck', 5);
    const run = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
    const sheets = await run.sheets;
    assert.deepEqual(sheets, [
      { file: 'sheet-01.png', fromSlide: 1, toSlide: 4 },
      { file: 'sheet-02.png', fromSlide: 5, toSlide: 5 },
    ]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(docDir, 'sheets', 'sheets.json'), 'utf8')), sheets);
    const result = await run.done;
    assert.deepEqual(result.failed, []);
    assert.equal(result.written, 5 * (VIEW_WIDTHS.length + 2) + 2);
    assert.deepEqual(result.sheets, sheets);

    const full = await sharp(path.join(docDir, 'sheets', 'sheet-01.png')).metadata();
    assert.equal(full.width, 1600);
    for (const slide of slides) {
      for (const width of VIEW_WIDTHS) assert.equal((await sharp(viewPath(docDir, slide, width)).metadata()).width, width);
      assert.equal((await sharp(thumbPath(docDir, slide)).metadata()).width, THUMB_WIDTH);
      const inline = inlinePathFor(path.join(docDir, 'slides', slide));
      assert.ok(inline && (await exists(inline)));
    }
    for (const sheet of sheets) {
      const inline = inlinePathFor(path.join(docDir, 'sheets', sheet.file));
      assert.equal(inline, path.join(docDir, 'inline', `sheets-${sheet.file.replace('.png', '.jpg')}`));
      assert.ok(await exists(inline));
    }

    const again = await runImageWorker({ docDir, slides, derived: true }).done;
    assert.deepEqual(again, { sheets: null, written: 0, failed: [] });

    // Only what is missing is written again (sheet files come from sheets.json).
    await fs.rm(thumbPath(docDir, slides[2]));
    await fs.rm(inlinePathFor(path.join(docDir, 'sheets', 'sheet-02.png'))!);
    assert.equal((await runImageWorker({ docDir, slides, derived: true }).done).written, 2);
  });

  test('slides of extreme aspect ratios (1 x 1600, 1600 x 1) still get contact sheets, letterboxed', async () => {
    for (const [name, width, height] of [['strip-tall', 1, 1600], ['strip-wide', 1600, 1]] as const) {
      const docDir = path.join(tmpRoot, name);
      await fs.mkdir(path.join(docDir, 'slides'), { recursive: true });
      await sharp({ create: { width, height, channels: 3, background: '#3366cc' } }).png().toFile(path.join(docDir, 'slides', '001.png'));
      const run = runImageWorker({ docDir, slides: ['001.png'], sheets: { aspectRatio: width / height }, derived: true });
      assert.deepEqual(await run.sheets, [{ file: 'sheet-01.png', fromSlide: 1, toSlide: 1 }]);
      assert.deepEqual((await run.done).failed, []);
      const sheet = await sharp(path.join(docDir, 'sheets', 'sheet-01.png')).metadata();
      assert.ok(Math.max(sheet.width ?? 0, sheet.height ?? 0) <= 1600, `${name}: ${sheet.width}x${sheet.height}`);
    }
  });

  test('the "Slide N" badges need no font: strokes only, every digit drawn, the same sheet on a system without fonts', async () => {
    for (const slide of [1, 10, 1234567890]) {
      const { svg, height } = slideLabel(slide, 34);
      assert.doesNotMatch(svg.toString(), /<text|font-/, 'no text to set, so no font to look for');
      assert.equal(height, 55);
    }
    // Slides 0..9: ten different badges, each with white strokes on the dark badge.
    const badges = await Promise.all(Array.from({ length: 10 }, (_, n) => sharp(slideLabel(n, 34).svg).flatten().greyscale().raw().toBuffer()));
    assert.equal(new Set(badges.map((pixels) => pixels.toString('base64'))).size, 10);
    for (const pixels of badges) assert.ok(pixels.filter((value) => value > 200).length > 150);

    // fontconfig without a single font (as in a slim Docker image; macOS and Windows set text without fontconfig):
    // the same contact sheet, where <text> came out as boxes.
    const emptyConfig = path.join(tmpRoot, 'no-fonts.conf');
    await fs.writeFile(emptyConfig, `<?xml version="1.0"?>\n<fontconfig><cachedir>${path.join(tmpRoot, 'fc-cache')}</cachedir></fontconfig>\n`);
    const sheet = async (name: string, env: Record<string, string | undefined>) => {
      const { docDir, slides } = await makeDocDir(name, 2);
      await withEnv(env, () => runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: false }).done);
      return sharp(path.join(docDir, 'sheets', 'sheet-01.png')).raw().toBuffer();
    };
    const [withFonts, withoutFonts] = [await sheet('badges-fonts', {}), await sheet('badges-no-fonts', { FONTCONFIG_FILE: emptyConfig })];
    assert.ok(withFonts.equals(withoutFonts));
  });

  test('inline JPEGs step the quality (then the size) down until they fit INLINE_MAX_BYTES', async () => {
    const docDir = path.join(tmpRoot, 'noisy');
    await fs.mkdir(path.join(docDir, 'slides'), { recursive: true });
    // Noise does not compress: the first qualities are far too large.
    await sharp({ create: { width: 1600, height: 1600, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 90 } } })
      .png()
      .toFile(path.join(docDir, 'slides', '001.png'));
    const result = await runImageWorker({ docDir, slides: ['001.png'], derived: true }).done;
    assert.deepEqual(result.failed, []);
    const bytes = await fs.readFile(inlinePathFor(path.join(docDir, 'slides', '001.png'))!);
    assert.ok(bytes.length <= INLINE_MAX_BYTES, `${bytes.length} bytes`);
    const info = await sharp(bytes).metadata();
    assert.equal(info.format, 'jpeg');
    assert.ok(Math.max(info.width ?? 0, info.height ?? 0) < INLINE_MAX_EDGE, 'made smaller as well');
  });

  test('an unreadable slide fails only its own files; unreadable slides fail the contact sheets', async () => {
    const { docDir, slides } = await makeDocDir('broken', 2);
    await fs.writeFile(path.join(docDir, 'slides', slides[1]), 'not a png');
    const result = await runImageWorker({ docDir, slides, derived: true }).done;
    assert.equal(result.written, VIEW_WIDTHS.length + 2);
    assert.equal(result.failed.length, VIEW_WIDTHS.length + 2);
    assert.ok(result.failed.every((failure) => failure.file.includes('002')));
    assert.equal(await exists(viewPath(docDir, slides[1], 1000)), false);

    const run = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
    await assert.rejects(run.sheets);
    await assert.rejects(run.done, (err: unknown) => err instanceof Error && !isImageWorkerStopped(err));
  });

  test('kill() stops the worker; partial files never exist; invalid jobs are refused', async () => {
    const { docDir, slides } = await makeDocDir('killed', 12);
    // kill() right away lands before the child's 'spawn' event, so the job is never sent. That is a stop
    // too, never 'could not be started' (EPIPE/ENOTCONN); repeated because the timing varies per run.
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
      run.kill();
      await assert.rejects(run.done, (err: unknown) => isImageWorkerStopped(err));
      await assert.rejects(run.sheets);
    }
    // kill() while the worker is busy with the derived images (the job was sent and the sheets are done).
    const busy = runImageWorker({ docDir, slides, sheets: { aspectRatio: 16 / 9 }, derived: true });
    await busy.sheets;
    busy.kill();
    await assert.rejects(busy.done, (err: unknown) => isImageWorkerStopped(err));
    for (const dir of ['view', 'thumbs', 'inline']) {
      const names = await fs.readdir(path.join(docDir, dir)).catch(() => [] as string[]);
      assert.ok(!names.some((name) => name.endsWith('.tmp')), `${dir}: ${names.join(', ')}`);
    }

    await assert.rejects(runImageWorker({ docDir, slides: ['../../etc/passwd.png'], derived: true }).done, /invalid worker job/);
    await assert.rejects(runImageWorker({ docDir: 'relative/dir', slides, derived: true }).done, /invalid worker job/);
  });

  test('the worker is this very module, run by the same Node executable', () => {
    assert.equal(imageWorkerPath(), path.join(repoRoot(), 'server', 'imageWorker.ts'));
  });
});

describe('PDF worker', () => {
  const SAMPLE = path.join(repoRoot(), 'samples', 'sample-lecture.pdf');

  async function pdfDocDir(name: string, source: Buffer): Promise<string> {
    const docDir = path.join(tmpRoot, name);
    await fs.mkdir(docDir, { recursive: true });
    await fs.writeFile(path.join(docDir, 'source.pdf'), source);
    return docDir;
  }

  /** Pixels darker than mid-grey in a slide PNG. */
  async function darkPixels(file: string): Promise<number> {
    const { data } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
    return data.reduce((count, value) => count + (value < 128 ? 1 : 0), 0);
  }

  test('renders every page at 1600 px and extracts its text, reporting info first and then progress', async () => {
    const docDir = await pdfDocDir('pdf-sample', await fs.readFile(SAMPLE));
    const events: string[] = [];
    const info = await runPdfWorker(
      { kind: 'pdf', docDir, longEdge: 1600 },
      { onInfo: (i) => events.push(`info ${i.pageCount}`), onProgress: (n) => events.push(`progress ${n}`) },
    ).done;
    assert.equal(info.pageCount, 9);
    assert.ok(Math.abs(info.aspectRatio - 16 / 9) < 0.001, String(info.aspectRatio));
    assert.deepEqual(events, ['info 9', ...Array.from({ length: 9 }, (_, i) => `progress ${i + 1}`)]);
    assert.deepEqual((await fs.readdir(path.join(docDir, 'slides'))).sort(), Array.from({ length: 9 }, (_, i) => `00${i + 1}.png`));
    const meta = await sharp(path.join(docDir, 'slides', '001.png')).metadata();
    assert.deepEqual([meta.width, meta.height, meta.channels], [1600, 900, 3]);
    const first = await fs.readFile(path.join(docDir, 'text', '001.txt'), 'utf8');
    assert.match(first, /^Lecture 5: CPU Scheduling/); // non-embedded Helvetica: PDFium's built-in substitute
    // Every text file with its layout (the word boxes, DESIGN §25), then the marker of the engine that wrote them (DESIGN §17).
    assert.deepEqual(
      (await fs.readdir(path.join(docDir, 'text'))).sort(),
      [TEXT_ENGINE_FILE, ...Array.from({ length: 9 }, (_, i) => [layoutFileName(i + 1, 9), textFileName(i + 1, 9)]).flat()],
    );
    const layout = JSON.parse(await fs.readFile(path.join(docDir, 'text', layoutFileName(1, 9)), 'utf8')) as { version: number; engine: string; lines: unknown[] };
    assert.deepEqual([layout.version, layout.engine], [1, TEXT_ENGINE]);
    assert.ok(layout.lines.length > 0, 'the first slide has text lines');
    assert.equal(await fs.readFile(path.join(docDir, 'text', TEXT_ENGINE_FILE), 'utf8'), `${TEXT_ENGINE}\n`);
    assert.ok(!(await fs.readdir(path.join(docDir, 'slides'))).some((name) => name.endsWith('.tmp')));
  });

  test('needs nothing on PATH (no external PDF tool)', async () => {
    const docDir = await pdfDocDir('pdf-no-path', deckPdf(2));
    const info = await withEnv({ PATH: path.join(tmpRoot, 'empty-bin') }, () => runPdfWorker({ kind: 'pdf', docDir, longEdge: 800 }).done);
    assert.equal(info.pageCount, 2);
    assert.equal(await fs.readFile(path.join(docDir, 'text', '002.txt'), 'utf8'), 'Slide 2');
  });

  test('pages with /Rotate 90 come out portrait, like pdftoppm rendered them', async () => {
    const docDir = await pdfDocDir('pdf-rotated', deckPdf(3, { rotate: 90 }));
    const info = await runPdfWorker({ kind: 'pdf', docDir, longEdge: 1600 }).done;
    assert.equal(info.pageCount, 3);
    assert.ok(Math.abs(info.aspectRatio - 540 / 960) < 0.001, String(info.aspectRatio));
    const meta = await sharp(path.join(docDir, 'slides', '003.png')).metadata();
    assert.deepEqual([meta.width, meta.height], [900, 1600]);
  });

  test('Symbol-font text keeps its symbols in text/NNN.txt', async () => {
    const docDir = await pdfDocDir('pdf-symbol', symbolFontPdf());
    await runPdfWorker({ kind: 'pdf', docDir, longEdge: 800 }).done;
    assert.equal(await fs.readFile(path.join(docDir, 'text', '001.txt'), 'utf8'), 'Sets: α β ∪ ∈ ∅ →\n\uf0a7 done');
  });

  test('an unreadable or password-protected PDF rejects with a readable message; kill() is a stop', async () => {
    const broken = await pdfDocDir('pdf-broken', GARBAGE_PDF);
    await assert.rejects(runPdfWorker({ kind: 'pdf', docDir: broken, longEdge: 1600 }).done, {
      message: 'could not read the PDF: the file is damaged or is not a PDF',
    });
    const locked = await pdfDocDir('pdf-locked', encryptedPdf('secret'));
    await assert.rejects(runPdfWorker({ kind: 'pdf', docDir: locked, longEdge: 1600 }).done, { message: 'the PDF is password protected' });
    await assert.rejects(runTextWorker({ kind: 'text', docDir: locked, pageCount: 1 }).done, { message: 'the PDF is password protected' });
    assert.deepEqual(await fs.readdir(path.join(locked, 'slides')), [], 'nothing was written');

    const docDir = await pdfDocDir('pdf-killed', await fs.readFile(SAMPLE));
    const run = runPdfWorker({ kind: 'pdf', docDir, longEdge: 1600 });
    run.kill();
    await assert.rejects(run.done, (err: unknown) => isImageWorkerStopped(err));
    await assert.rejects(runPdfWorker({ kind: 'pdf', docDir: 'relative', longEdge: 1600 }).done, /invalid worker job/);
    await assert.rejects(runTextWorker({ kind: 'text', docDir, pageCount: 0 }).done, /invalid worker job/);
  });

  test('non-embedded CJK text is drawn with the host fallback font; other text is unaffected', async (t) => {
    const font = fallbackFontFiles().find((file) => existsSync(file));
    if (!font) {
      t.skip(`no CJK fallback font on this machine (looked for ${fallbackFontFiles().join(', ')})`);
      return;
    }
    const missing = path.join(tmpRoot, 'no-such-font.ttf');
    const warnings = new Map<string, string[]>();
    const render = async (name: string, source: Buffer, fallback: string) => {
      const docDir = await pdfDocDir(name, source);
      const messages: string[] = [];
      warnings.set(name, messages);
      await withEnv({ EASY_STUDY_PDF_FALLBACK_FONT: fallback }, () =>
        runPdfWorker({ kind: 'pdf', docDir, longEdge: 1600 }, { onWarning: (message) => messages.push(message) }).done,
      );
      return docDir;
    };
    const withFont = await render('cjk-font', cjkPdf(), font);
    const withoutFont = await render('cjk-no-font', cjkPdf(), missing);
    assert.ok((await darkPixels(path.join(withFont, 'slides', '001.png'))) > 5_000, 'the Korean glyphs are drawn');
    assert.equal(await darkPixels(path.join(withoutFont, 'slides', '001.png')), 0, 'without a fallback font nothing is drawn');
    // The text does not depend on fonts; the run without any font file did not fail either.
    assert.equal(await fs.readFile(path.join(withoutFont, 'text', '001.txt'), 'utf8'), '한글 강의');
    assert.deepEqual(warnings.get('cjk-font'), [], 'drawn: nothing to say');
    assert.equal(warnings.get('cjk-no-font')?.length, 1, 'not drawn: said once');

    // Base-14 fonts keep PDFium's built-in substitutes: identical pixels with or without the fallback font.
    const sample = await fs.readFile(SAMPLE);
    const a = await render('sample-font', sample, font);
    const b = await render('sample-no-font', sample, missing);
    assert.deepEqual(warnings.get('sample-no-font'), [], 'no CJK font asked for: nothing to say');
    for (const slide of ['001.png', '005.png']) {
      const [pixelsA, pixelsB] = await Promise.all([a, b].map((dir) => sharp(path.join(dir, 'slides', slide)).raw().toBuffer()));
      assert.ok(pixelsA.equals(pixelsB), slide);
    }
  });

  test('CJK text left undrawn for want of a fallback font is reported once, with the file looked for and the remedy', async () => {
    const missing = path.join(tmpRoot, 'mistyped-font.ttf');
    const docDir = await pdfDocDir('cjk-warning', cjkPdf(3));
    const messages: string[] = [];
    const info = await withEnv({ EASY_STUDY_PDF_FALLBACK_FONT: missing }, () =>
      runPdfWorker({ kind: 'pdf', docDir, longEdge: 800 }, { onWarning: (message) => messages.push(message) }).done,
    );
    assert.equal(info.pageCount, 3, 'the conversion itself goes on');
    assert.equal(messages.length, 1, messages.join('\n'));
    assert.match(messages[0], /CJK font it does not embed/);
    assert.ok(messages[0].includes(missing), messages[0]);
    assert.match(messages[0], /fonts-noto-cjk/);
    assert.match(messages[0], /EASY_STUDY_PDF_FALLBACK_FONT/);
    assert.equal(await fs.readFile(path.join(docDir, 'text', '003.txt'), 'utf8'), '한글 강의');
  });

  test('the text job rewrites text/NNN.txt and the marker only (DESIGN §17)', async () => {
    // A document converted by poppler: pdftotext's text with PUA code points, no marker.
    const docDir = await pdfDocDir('pdf-text-only', symbolFontPdf());
    await fs.mkdir(path.join(docDir, 'text'), { recursive: true });
    await fs.mkdir(path.join(docDir, 'slides'), { recursive: true });
    await fs.writeFile(path.join(docDir, 'slides', '001.png'), 'old rendering');
    await fs.writeFile(path.join(docDir, 'text', '001.txt'), 'Sets: \uf061 \uf062 \uf0c8 \uf0ce \uf0c6 \uf0ae');
    // doc.json said 2 pages (the PDF has 1): the page PDFium does not have keeps its file.
    await fs.writeFile(path.join(docDir, 'text', '002.txt'), 'kept');
    // Left behind by a text job that was stopped mid-write.
    await fs.writeFile(path.join(docDir, 'text', '001.txt.123.abcd1234.tmp'), 'partial');

    const { written } = await runTextWorker({ kind: 'text', docDir, pageCount: 2 }, { lowPriority: true }).done;
    assert.equal(written, 1);
    assert.equal(await fs.readFile(path.join(docDir, 'text', '001.txt'), 'utf8'), 'Sets: α β ∪ ∈ ∅ →\n\uf0a7 done');
    assert.equal(await fs.readFile(path.join(docDir, 'text', '002.txt'), 'utf8'), 'kept');
    assert.equal(await fs.readFile(path.join(docDir, 'text', TEXT_ENGINE_FILE), 'utf8'), `${TEXT_ENGINE}\n`);
    assert.deepEqual((await fs.readdir(path.join(docDir, 'text'))).sort(), [TEXT_ENGINE_FILE, '001.layout.json', '001.txt', '002.txt']);
    // The layout of the page PDFium has (DESIGN §25); the page it does not have gets none.
    const layout = JSON.parse(await fs.readFile(path.join(docDir, 'text', '001.layout.json'), 'utf8')) as { engine: string; lines: Array<{ words: Array<{ t: string }> }> };
    assert.equal(layout.engine, TEXT_ENGINE);
    assert.deepEqual(layout.lines.map((line) => line.words.map((word) => word.t)), [['Sets:', 'α β ∪ ∈ ∅ →'], ['\uf0a7', 'done']]);
    assert.equal(await fs.readFile(path.join(docDir, 'slides', '001.png'), 'utf8'), 'old rendering', 'no slide is rendered');
    assert.deepEqual((await fs.readdir(docDir)).sort(), ['slides', 'source.pdf', 'text']);
  });
});

describe('attachment jobs (DESIGN §21)', () => {
  const SAMPLE = path.join(repoRoot(), 'samples', 'sample-lecture.pdf');
  let sampleDir = '';
  let symbolDir = '';

  /** A document directory with source.pdf rendered by the PDF worker (1600 px slides) and an attachments folder. */
  async function renderedDocDir(name: string, source: Buffer): Promise<string> {
    const docDir = path.join(tmpRoot, name);
    await fs.mkdir(path.join(docDir, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(docDir, 'source.pdf'), source);
    await runPdfWorker({ kind: 'pdf', docDir, longEdge: 1600 }).done;
    return docDir;
  }

  before(async () => {
    sampleDir = await renderedDocDir('attach-sample', await fs.readFile(SAMPLE));
    symbolDir = await renderedDocDir('attach-symbol', symbolFontPdf());
  });

  let counter = 0;
  const nextId = () => `att-${(++counter).toString(16).padStart(16, '0')}`;

  async function region(docDir: string, slide: number, rect: { x: number; y: number; w: number; h: number }, ink?: RegionInk[]) {
    const id = nextId();
    const result = await runAttachmentWorker({ kind: 'region', docDir, id, slide, slideFile: `${String(slide).padStart(3, '0')}.png`, rect, ...(ink ? { ink } : {}) }).done;
    assert.equal(result.ok, true, JSON.stringify(result));
    const ok = result as Extract<AttachmentWorkerResult, { ok: true }>;
    const file = path.join(docDir, 'attachments', ok.file);
    return { id, result: ok, file, meta: await sharp(file).metadata() };
  }

  test('regionCropBox: padded by 2 % of the slide, clamped to it, at least 16 px a side', () => {
    // 1600 x 900: 32 px of padding across, 18 px down.
    assert.deepEqual(regionCropBox({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1600, 900), { left: 368, top: 207, width: 864, height: 486 });
    // At the corner the padding is cut off by the slide's edge.
    assert.deepEqual(regionCropBox({ x: 0, y: 0, w: 0.1, h: 0.1 }, 1600, 900), { left: 0, top: 0, width: 192, height: 108 });
    assert.deepEqual(regionCropBox({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, 1600, 900), { left: 1408, top: 792, width: 192, height: 108 });
    // Out of range values are clamped first.
    assert.deepEqual(regionCropBox({ x: -1, y: -1, w: 3, h: 3 }, 1600, 900), { left: 0, top: 0, width: 1600, height: 900 });
    // A tiny selection on a small image grows to 16 px around its centre, inside the image.
    assert.deepEqual(regionCropBox({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 }, 100, 100), { left: 43, top: 43, width: REGION_MIN_PX, height: REGION_MIN_PX });
    assert.deepEqual(regionCropBox({ x: 0.99, y: 0, w: 0.01, h: 0.01 }, 100, 100), { left: 84, top: 0, width: 16, height: 16 });
    // An image smaller than that is taken whole.
    assert.deepEqual(regionCropBox({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, 10, 8), { left: 0, top: 0, width: 10, height: 8 });
  });

  test('a region of the sample lecture: the padded crop of the full-resolution slide, and the text inside the selection', async () => {
    const { id, result, file, meta } = await region(sampleDir, 5, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    assert.equal(path.basename(file), result.file);
    assert.match(result.file, new RegExp(`^${id}\\.(jpg|png)$`));
    assert.deepEqual([result.width, result.height], [864, 486]);
    assert.deepEqual([meta.width, meta.height], [864, 486]);
    assert.equal(meta.format, result.file.endsWith('.png') ? 'png' : 'jpeg');
    assert.ok((await fs.stat(file)).size <= INLINE_MAX_BYTES);
    assert.equal(typeof result.text, 'string');

    // The body of slide 5 (bullets), without its title or footer.
    const body = await region(sampleDir, 5, { x: 0, y: 0.2, w: 1, h: 0.2 });
    assert.match(body.result.text ?? '', /^• Bursts: P1 = 24, P2 = 3, P3 = 3\n• Average waiting time = \(0 \+ 24 \+ 27\) \/ 3 = 17\n• Convoy effect/);
    assert.doesNotMatch(body.result.text ?? '', /First-Come|OS 101/);
    // The whole slide width is scaled into INLINE_MAX_EDGE: 1600 x (180 + 2 x 18) → 1568 x 212/213.
    assert.equal(body.result.width, INLINE_MAX_EDGE);
    assert.ok(Math.abs(body.result.height - (216 * INLINE_MAX_EDGE) / 1600) <= 1, String(body.result.height));

    // The title only.
    assert.equal((await region(sampleDir, 5, { x: 0, y: 0, w: 1, h: 0.2 })).result.text, 'First-Come, First-Served (FCFS)');
  });

  test('clamping: a region at the corner keeps only the padding inside the slide; a tiny one still has its padding', async () => {
    const corner = await region(sampleDir, 1, { x: 0, y: 0, w: 0.1, h: 0.1 });
    assert.deepEqual([corner.result.width, corner.result.height], [192, 108]);
    const tiny = await region(sampleDir, 1, { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 });
    // 2 % on each side of a (nearly) empty selection: 64 x 36 px (+1 for the rounding outwards).
    assert.ok(tiny.result.width >= 64 && tiny.result.width <= 66, String(tiny.result.width));
    assert.ok(tiny.result.height >= 36 && tiny.result.height <= 38, String(tiny.result.height));
  });

  test('the crop is the slide’s own pixels (a flat area comes out white, as the smaller PNG)', async () => {
    // Lower right of slide 4 of the sample: empty white.
    const blank = await region(sampleDir, 4, { x: 0.7, y: 0.6, w: 0.1, h: 0.1 });
    assert.equal(blank.result.text, '');
    assert.equal(blank.result.file.endsWith('.png'), true, 'a flat area is smaller as a PNG');
    const stats = await sharp(blank.file).stats();
    for (const channel of stats.channels.slice(0, 3)) assert.ok(channel.min > 200, JSON.stringify(stats.channels));
    // Compare with the slide itself at the same place.
    const box = regionCropBox({ x: 0.7, y: 0.6, w: 0.1, h: 0.1 }, 1600, 900);
    const expected = await sharp(path.join(sampleDir, 'slides', '004.png')).extract(box).removeAlpha().raw().toBuffer();
    const actual = await sharp(blank.file).removeAlpha().raw().toBuffer();
    assert.deepEqual(actual, expected, 'a PNG crop is lossless');
  });

  /** A 펜 stroke through `points` (image coordinates) as the server passes it to a region job. */
  function stroke(points: InkPoint[], width: number, color: string): RegionInk {
    const rect = inkRect(points, width, 16 / 9);
    return { rect, width, pts: encodeInkPoints(points, rect), color };
  }

  test('a region draws the 펜 strokes it is given into the crop (DESIGN §29), clipped to it', async () => {
    const rect = { x: 0.7, y: 0.6, w: 0.1, h: 0.1 };
    const ink = [
      // A line across the crop, a dot below it, and a line elsewhere on the slide (not in the crop).
      stroke([{ x: 0.72, y: 0.65, p: 0.5 }, { x: 0.78, y: 0.65, p: 0.5 }], 0.009, '#1c2230'),
      stroke([{ x: 0.75, y: 0.69, p: 0.5 }], 0.009, '#c62828'),
      stroke([{ x: 0.1, y: 0.1, p: 0.5 }, { x: 0.3, y: 0.1, p: 0.5 }], 0.009, '#1f4fbf'),
    ];
    const written = await region(sampleDir, 4, rect, ink);
    const box = regionCropBox(rect, 1600, 900);
    assert.deepEqual([written.result.width, written.result.height], [box.width, box.height]);
    const pixel = async (x: number, y: number) =>
      [...(await sharp(written.file).removeAlpha().extract({ left: Math.round(x * 1600) - box.left, top: Math.round(y * 900) - box.top, width: 1, height: 1 }).raw().toBuffer())];
    const near = (actual: number[], expected: number[]) => assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 24), `${actual} ≉ ${expected}`);
    near(await pixel(0.75, 0.65), [0x1c, 0x22, 0x30]);
    near(await pixel(0.72, 0.65), [0x1c, 0x22, 0x30]);
    near(await pixel(0.75, 0.69), [0xc6, 0x28, 0x28]);
    near(await pixel(0.75, 0.62), [255, 255, 255]);
    near(await pixel(0.7, 0.7), [255, 255, 255]);
    // The same region without strokes is the slide's own white.
    const plain = await sharp((await region(sampleDir, 4, rect)).file).stats();
    for (const channel of plain.channels.slice(0, 3)) assert.ok(channel.min > 200);
  });

  test('text inside the selection keeps its symbols (Symbol-font PUA remapped)', async () => {
    const line1 = await region(symbolDir, 1, { x: 0, y: 0.1, w: 1, h: 0.15 });
    assert.equal(line1.result.text, 'Sets: α β ∪ ∈ ∅ →');
    const line2 = await region(symbolDir, 1, { x: 0, y: 0.3, w: 1, h: 0.15 });
    assert.equal(line2.result.text, '\uf0a7 done');
  });

  test('without a readable source.pdf the crop is made all the same, with no text', async () => {
    const docDir = path.join(tmpRoot, 'attach-no-pdf');
    await fs.mkdir(path.join(docDir, 'attachments'), { recursive: true });
    await fs.cp(path.join(sampleDir, 'slides'), path.join(docDir, 'slides'), { recursive: true });
    const withoutPdf = await region(docDir, 5, { x: 0, y: 0.2, w: 1, h: 0.2 });
    assert.equal(withoutPdf.result.text, '');
    await fs.writeFile(path.join(docDir, 'source.pdf'), GARBAGE_PDF);
    assert.equal((await region(docDir, 5, { x: 0, y: 0.2, w: 1, h: 0.2 })).result.text, '');
  });

  async function upload(input: Buffer, type: UploadImageType): Promise<{ result: AttachmentWorkerResult; file: string | null }> {
    const docDir = sampleDir;
    const id = nextId();
    const inputFile = path.join(tmpRoot, `${id}.upload`);
    await fs.writeFile(inputFile, input);
    const result = await runAttachmentWorker({ kind: 'upload', docDir, id, input: inputFile, type }).done;
    return { result, file: result.ok ? path.join(docDir, 'attachments', result.file) : null };
  }

  const refusalOf = (result: AttachmentWorkerResult) => (result.ok ? null : result.reason);

  test('uploads: EXIF orientation applied, metadata dropped, scaled into the inline limits', async () => {
    // 300 x 200 pixels whose EXIF says "rotate 90° clockwise" (a phone photo held upright): 200 x 300 upright.
    const photo = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3366cc' } })
      .composite([{ input: { create: { width: 60, height: 200, channels: 3, background: '#ff0000' } }, left: 0, top: 0 }])
      .jpeg()
      .withMetadata({ orientation: 6, density: 300 })
      .toBuffer();
    assert.equal((await sharp(photo).metadata()).orientation, 6);
    const { result, file } = await upload(photo, 'jpeg');
    assert.equal(result.ok, true);
    const meta = await sharp(file!).metadata();
    assert.deepEqual([meta.width, meta.height], [200, 300]);
    assert.equal(meta.orientation, undefined, 'no orientation left');
    assert.equal(meta.exif, undefined, 'no EXIF');
    assert.equal(meta.icc, undefined);
    // Rotated clockwise: the red band that was on the left is now at the top.
    const top = await sharp(await sharp(file!).extract({ left: 90, top: 10, width: 10, height: 10 }).toBuffer()).stats();
    assert.ok(top.channels[0].mean > 200 && top.channels[2].mean < 80, JSON.stringify(top.channels.map((c) => c.mean)));

    // A large picture is scaled into INLINE_MAX_EDGE and INLINE_MAX_BYTES.
    const large = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).png().toBuffer();
    const big = await upload(large, 'png');
    assert.equal(big.result.ok, true);
    const bigMeta = await sharp(big.file!).metadata();
    assert.ok(Math.max(bigMeta.width ?? 0, bigMeta.height ?? 0) <= INLINE_MAX_EDGE);
    assert.ok((await fs.stat(big.file!)).size <= INLINE_MAX_BYTES);
    assert.equal(bigMeta.format, 'jpeg', 'a noisy picture is smaller as a JPEG');
  });

  test('uploads: the first frame of an animated GIF, transparency on white, WebP', async () => {
    const frame = (color: string) => sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).png().toBuffer();
    const gif = await sharp([await frame('#ff0000'), await frame('#0000ff')], { join: { animated: true } }).gif().toBuffer();
    assert.equal((await sharp(gif).metadata()).pages, 2);
    const first = await upload(gif, 'gif');
    assert.equal(first.result.ok, true);
    const firstMeta = await sharp(first.file!).metadata();
    assert.deepEqual([firstMeta.width, firstMeta.height, firstMeta.pages ?? 1], [40, 30, 1]);
    const firstColor = await sharp(first.file!).stats();
    assert.ok(firstColor.channels[0].mean > 200 && firstColor.channels[2].mean < 60, 'the first (red) frame');

    const transparent = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const flat = await upload(transparent, 'png');
    assert.equal(flat.result.ok, true);
    const flatStats = await sharp(flat.file!).stats();
    assert.equal(flatStats.isOpaque, true);
    for (const channel of flatStats.channels.slice(0, 3)) assert.ok(channel.min >= 250, 'on white');

    const webp = await sharp({ create: { width: 50, height: 40, channels: 3, background: '#00aa00' } }).webp().toBuffer();
    const fromWebp = await upload(webp, 'webp');
    assert.equal(fromWebp.result.ok, true);
    assert.deepEqual([(fromWebp.result as { width: number }).width, (fromWebp.result as { height: number }).height], [50, 40]);
  });

  test('an upload that cannot be decoded is a result, not a crash; invalid jobs are refused', async () => {
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a png')]);
    const { result } = await upload(broken, 'png');
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'undecodable');

    const bad: unknown[] = [
      { kind: 'region', docDir: sampleDir, id: '../escape', slide: 1, slideFile: '001.png', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { kind: 'region', docDir: sampleDir, id: nextId(), slide: 1, slideFile: '../001.png', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { kind: 'region', docDir: sampleDir, id: nextId(), slide: 0, slideFile: '001.png', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { kind: 'region', docDir: sampleDir, id: nextId(), slide: 1, slideFile: '001.png', rect: { x: 0, y: 0, w: Number.NaN, h: 1 } },
      ...[
        { color: 'red' },
        { color: '#1c2230"/><image href="x' },
        { pts: 'AAAA+' },
        { pts: 'AAAAg'.repeat(2001) },
        { width: 0 },
        { width: Number.POSITIVE_INFINITY },
        { rect: { x: 0, y: 0, w: 1 } },
      ].map((bad) => ({ kind: 'region', docDir: sampleDir, id: nextId(), slide: 1, slideFile: '001.png', rect: { x: 0, y: 0, w: 1, h: 1 }, ink: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, width: 0.005, pts: 'AAAAg', color: '#1c2230', ...bad }] })),
      { kind: 'region', docDir: sampleDir, id: nextId(), slide: 1, slideFile: '001.png', rect: { x: 0, y: 0, w: 1, h: 1 }, ink: 'strokes' },
      {
        kind: 'region',
        docDir: sampleDir,
        id: nextId(),
        slide: 1,
        slideFile: '001.png',
        rect: { x: 0, y: 0, w: 1, h: 1 },
        ink: Array.from({ length: MAX_INK_STROKES + 1 }, () => ({ rect: { x: 0, y: 0, w: 1, h: 1 }, width: 0.005, pts: 'AAAAg', color: '#1c2230' })),
      },
      { kind: 'upload', docDir: 'relative/dir', id: nextId(), input: path.join(tmpRoot, 'x'), type: 'png' },
      { kind: 'upload', docDir: sampleDir, id: nextId(), input: 'relative.upload', type: 'png' },
      { kind: 'upload', docDir: sampleDir, id: nextId(), input: path.join(tmpRoot, 'x') },
      { kind: 'upload', docDir: sampleDir, id: nextId(), input: path.join(tmpRoot, 'x'), type: 'svg' },
    ];
    for (const job of bad) {
      await assert.rejects(runAttachmentWorker(job as AttachmentJob).done, /invalid worker job/, JSON.stringify(job));
    }
  });

  test('uploads: only the loader the first bytes name reads the file — an SVG behind an AVIF header is never rendered', async () => {
    const before = await fs.readdir(path.join(sampleDir, 'attachments'));
    // It would pull in an attachment next to it if librsvg rendered it (and did, before the loaders were limited).
    const polyglot = await upload(svgBehindAvifHeader(before.find((name) => /\.(jpg|png)$/.test(name)) ?? 'x.png'), 'heif');
    assert.equal(refusalOf(polyglot.result), 'unsupported', JSON.stringify(polyglot.result));
    assert.equal(polyglot.file, null);
    // Claimed as another type than it is: refused as well (a PNG is only ever read as a PNG).
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } }).png().toBuffer();
    assert.equal(refusalOf((await upload(png, 'jpeg')).result), 'unsupported');
    assert.deepEqual(await fs.readdir(path.join(sampleDir, 'attachments')), before, 'nothing was written');

    // The loaders that stay allowed read every depth and colour model of their format.
    const deep = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 1 } } })
      .toColourspace('rgb16')
      .png()
      .toBuffer();
    assert.equal((await sharp(deep).metadata()).depth, 'ushort');
    const deepUpload = await upload(deep, 'png');
    assert.equal(deepUpload.result.ok, true, JSON.stringify(deepUpload.result));
    const cmyk = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#cc3300' } }).toColourspace('cmyk').jpeg().toBuffer();
    assert.equal((await sharp(cmyk).metadata()).space, 'cmyk');
    const cmykUpload = await upload(cmyk, 'jpeg');
    assert.equal(cmykUpload.result.ok, true, JSON.stringify(cmykUpload.result));
    const color = await sharp(cmykUpload.file!).stats();
    assert.ok(color.channels[0].mean > 150 && color.channels[2].mean < 90, JSON.stringify(color.channels.map((c) => c.mean)));
  });

  test('uploads: images too large to decode are refused from their header, before any pixel is decoded', async () => {
    // Over the pixel limit (a damaged file it is not).
    assert.equal(refusalOf((await upload(pngHeaderOnly(12_000, 10_000, { colorType: 0 }), 'png')).result), 'too-large');
    // Under it, but interlaced 16-bit RGBA must be decoded whole: 7000 x 7000 x 8 bytes = 392 MB.
    assert.equal(refusalOf((await upload(pngHeaderOnly(7000, 7000, { bitDepth: 16, interlaced: true }), 'png')).result), 'too-large');
    // The same picture not interlaced is read line by line: it gets as far as decoding (and this one's data is fake).
    assert.equal(refusalOf((await upload(pngHeaderOnly(7000, 7000, { bitDepth: 16 }), 'png')).result), 'undecodable');
  });

  test('uploadRefusal: format, pixel limit, and the size of formats decoded whole', () => {
    const at = (header: Parameters<typeof uploadRefusal>[0], type: UploadImageType) => uploadRefusal(header, type)?.reason ?? null;
    const photo = { width: 8064, height: 6048, channels: 3, depth: 'uchar' }; // 48 MP
    assert.equal(at({ ...photo, format: 'jpeg' }, 'jpeg'), null);
    assert.equal(at({ ...photo, format: 'jpeg', isProgressive: true }, 'jpeg'), null, '146 MB decoded whole still fits');
    assert.equal(at({ ...photo, format: 'svg' }, 'heif'), 'unsupported');
    assert.equal(at({ ...photo, format: undefined }, 'png'), 'unsupported');
    assert.equal(at({ ...photo, format: 'png', width: 0 }, 'png'), 'undecodable');
    // Pixels: the first frame counts (pageHeight), up to UPLOAD_MAX_PIXELS.
    assert.equal(at({ format: 'png', width: 10_000, height: 10_000, channels: 4 }, 'png'), null);
    assert.equal(at({ format: 'png', width: 10_001, height: 10_000, channels: 4 }, 'png'), 'too-large');
    assert.equal(at({ format: 'gif', width: 1000, height: 500_000, pageHeight: 1000, channels: 4 }, 'gif'), null);
    // Formats decoded whole: interlaced PNG, progressive JPEG, GIF, HEIF.
    assert.equal(at({ format: 'png', width: 10_000, height: 10_000, channels: 4, depth: 'ushort' }, 'png'), null, 'read line by line');
    assert.equal(at({ format: 'png', width: 10_000, height: 10_000, channels: 4, isProgressive: true }, 'png'), 'too-large');
    assert.equal(at({ format: 'jpeg', width: 10_000, height: 10_000, channels: 3, isProgressive: true }, 'jpeg'), 'too-large');
    assert.equal(at({ format: 'gif', width: 7000, height: 7000, channels: 3 }, 'gif'), 'too-large', 'GIF frames are RGBA');
    assert.equal(at({ format: 'gif', width: 5000, height: 5000, channels: 3 }, 'gif'), null);
    assert.equal(at({ format: 'heif', width: 9000, height: 7000, channels: 3 }, 'heif'), 'too-large');
    assert.equal(at({ format: 'webp', width: 10_000, height: 10_000, channels: 4 }, 'webp'), null, 'WebP shrinks while it loads');
    const budget = Math.floor(UPLOAD_MAX_DECODE_BYTES / 4);
    assert.equal(at({ format: 'png', width: budget, height: 1, channels: 4, isProgressive: true }, 'png'), null);
    assert.equal(at({ format: 'png', width: budget + 1, height: 1, channels: 4, isProgressive: true }, 'png'), 'too-large');
    assert.ok(UPLOAD_MAX_PIXELS >= 100_000_000);
  });

  test('the attachments folder is never made again (a deleted document stays deleted)', async () => {
    const docDir = path.join(tmpRoot, 'attach-gone');
    await fs.mkdir(docDir, { recursive: true });
    await fs.cp(path.join(sampleDir, 'slides'), path.join(docDir, 'slides'), { recursive: true });
    await assert.rejects(
      runAttachmentWorker({ kind: 'region', docDir, id: nextId(), slide: 1, slideFile: '001.png', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }).done,
      /ENOENT/,
    );
    assert.equal(await exists(path.join(docDir, 'attachments')), false);
  });

  test('attachments are their own inline image (providers send them as stored)', () => {
    assert.equal(isInlineReady('/lib/doc-abc123/attachments/att-0123456789abcdef.jpg'), true);
    assert.equal(isInlineReady('/lib/doc-abc123/attachments/att-0123456789abcdef.png'), true);
    assert.equal(isInlineReady('/lib/doc-abc123/slides/001.png'), false);
    assert.equal(isInlineReady('/lib/doc-abc123/attachments/other.png'), false);
    assert.equal(inlinePathFor('/lib/doc-abc123/attachments/att-0123456789abcdef.png'), null);
  });
});

describe('the server process never loads sharp or PDFium', () => {
  test('import, ingest, derived images, attachments and every image route run without sharp or PDFium in the server', async () => {
    const library = await fs.mkdtemp(path.join(tmpRoot, 'library-'));
    const script = path.join(tmpRoot, 'no-sharp.mjs');
    // An image to upload, made here (the child must not make it with sharp).
    const photoFile = path.join(tmpRoot, 'upload-photo.jpg');
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#cc3366' } }).jpeg().withMetadata({ orientation: 6 }).toFile(photoFile);
    await fs.writeFile(
      script,
      `import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({
  resolve(specifier, context, next) {
    if (/^(sharp|@img\\/|@embedpdf\\/)/.test(specifier)) loaded.push(specifier);
    return next(specifier, context);
  },
});
const { startServer } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot(), 'server', 'index.ts')).href)});
const library = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot(), 'server', 'library.ts')).href)});
const fs = await import('node:fs/promises');
const server = await startServer({ port: 0, log: false, resumeIngests: false });
const pdf = await fs.readFile(${JSON.stringify(path.join(repoRoot(), 'samples', 'sample-lecture.pdf'))});
const created = await (await fetch(server.url + '/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf })).json();
await library.waitForIngest(created.id);
const meta = await (await fetch(server.url + '/api/docs/' + created.id)).json();
const types = [];
for (const p of ['/slides/1.png', '/view/1.webp?w=1000', '/view/2.webp', '/thumbs/3.webp']) {
  const res = await fetch(server.url + '/api/docs/' + created.id + p);
  types.push(res.status + ' ' + res.headers.get('content-type'));
  await res.arrayBuffer();
}
// Attachments (DESIGN §21): a region, an upload, the stored image, and what a provider sends of it.
const docUrl = server.url + '/api/docs/' + created.id;
const regionRes = await fetch(docUrl + '/regions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slide: 5, rect: { x: 0, y: 0.2, w: 1, h: 0.2 } }) });
const region = await regionRes.json();
const photo = await fs.readFile(${JSON.stringify(photoFile)});
const uploadRes = await fetch(docUrl + '/attachments', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: photo });
const uploaded = await uploadRes.json();
const attachmentTypes = [regionRes.status, uploadRes.status];
for (const id of [region.id, uploaded.id]) {
  const res = await fetch(docUrl + '/attachments/' + id);
  attachmentTypes.push(res.status + ' ' + res.headers.get('content-type'));
  await res.arrayBuffer();
}
const { loadInlineImage } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot(), 'server', 'providers', 'proc.ts')).href)});
const dir = library.docPaths(created.id).dir + '/attachments/';
const names = await fs.readdir(dir);
const inline = [];
for (const name of names.filter((n) => !n.endsWith('.json')).sort()) inline.push((await loadInlineImage(dir + name)).mediaType);
await server.close();
console.log(JSON.stringify({ status: meta.status, types, attachmentTypes, regionText: region.text, uploaded: [uploaded.width, uploaded.height], inline, loaded }));
`,
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, EASY_STUDY_LIBRARY: library, EASY_STUDY_AUTO_DIGEST: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, stderr);
    const report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      status: string;
      types: string[];
      attachmentTypes: (string | number)[];
      regionText: string;
      uploaded: number[];
      inline: string[];
      loaded: string[];
    };
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.types, ['200 image/png', '200 image/webp', '200 image/webp', '200 image/webp']);
    assert.equal(report.attachmentTypes[0], 201);
    assert.equal(report.attachmentTypes[1], 201);
    for (const type of report.attachmentTypes.slice(2)) assert.match(String(type), /^200 image\/(jpeg|png)$/);
    assert.match(report.regionText, /^• Bursts: P1 = 24/);
    assert.deepEqual(report.uploaded, [80, 120], 'EXIF orientation applied');
    assert.equal(report.inline.length, 2);
    for (const type of report.inline) assert.match(type, /^image\/(jpeg|png)$/);
    assert.deepEqual(report.loaded, [], 'sharp or PDFium was resolved in the server process');
  });
});
