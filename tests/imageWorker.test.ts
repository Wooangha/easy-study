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
import { INLINE_MAX_BYTES, INLINE_MAX_EDGE, THUMB_WIDTH, VIEW_WIDTHS, inlinePathFor, thumbPath, viewPath } from '../server/assets.ts';
import { repoRoot } from '../server/config.ts';
import { imageWorkerPath, isImageWorkerStopped, runImageWorker, runPdfWorker, runTextWorker, slideLabel } from '../server/imageWorker.ts';
import { TEXT_ENGINE, TEXT_ENGINE_FILE } from '../server/pageNames.ts';
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
    // Every text file, then the marker of the engine that wrote them (DESIGN §17).
    assert.deepEqual((await fs.readdir(path.join(docDir, 'text'))).sort(), [TEXT_ENGINE_FILE, ...Array.from({ length: 9 }, (_, i) => `00${i + 1}.txt`)]);
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
    assert.deepEqual((await fs.readdir(path.join(docDir, 'text'))).sort(), [TEXT_ENGINE_FILE, '001.txt', '002.txt']);
    assert.equal(await fs.readFile(path.join(docDir, 'slides', '001.png'), 'utf8'), 'old rendering', 'no slide is rendered');
    assert.deepEqual((await fs.readdir(docDir)).sort(), ['slides', 'source.pdf', 'text']);
  });
});

describe('the server process never loads sharp or PDFium', () => {
  test('import, ingest, derived images and every image route run without sharp or PDFium in the server', async () => {
    const library = await fs.mkdtemp(path.join(tmpRoot, 'library-'));
    const script = path.join(tmpRoot, 'no-sharp.mjs');
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
await server.close();
console.log(JSON.stringify({ status: meta.status, types, loaded }));
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
    const report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { status: string; types: string[]; loaded: string[] };
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.types, ['200 image/png', '200 image/webp', '200 image/webp', '200 image/webp']);
    assert.deepEqual(report.loaded, [], 'sharp or PDFium was resolved in the server process');
  });
});
