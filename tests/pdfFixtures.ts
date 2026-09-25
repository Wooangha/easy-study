// Small PDFs for the PDF engine tests (server/pdf.ts), written byte by byte so no external tool is needed:
// Symbol-font text with Private Use Area ToUnicode entries (as Microsoft Office writes it), a non-embedded CJK
// font, a rotated page, a filled-in form with annotations, a password-protected file (standard security handler,
// RC4 40-bit) and multi-page decks.
import { createHash } from 'node:crypto';

/**
 * A complete PDF from its objects: `objects[i]` is the body of object i + 1 (object 1 must be the catalog).
 * The cross-reference table and the trailer are computed; `trailer` adds entries to the trailer dictionary.
 */
export function buildPdf(objects: (string | Buffer)[], trailer = ''): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/** A stream object body. */
export function stream(data: string, dict = ''): string {
  return `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;
}

interface PageSpec {
  /** Content stream (PDF operators). */
  content: string;
  width?: number;
  height?: number;
  rotate?: number;
}

/**
 * A PDF with one page per spec; `fonts` are font dictionaries (bodies) named /F1, /F2, … in every page's
 * resources, `extra` more objects they may refer to (numbered after the fonts).
 */
export function pagesPdf(pages: PageSpec[], fonts: string[] = [], extra: string[] = [], trailer = ''): Buffer {
  // 1 catalog, 2 pages, fonts, extra objects, then per page: page + content.
  const fontBase = 3;
  const extraBase = fontBase + fonts.length;
  const pageBase = extraBase + extra.length;
  const fontRefs = fonts.map((_, i) => `/F${i + 1} ${fontBase + i} 0 R`).join(' ');
  const pageObjects: string[] = [];
  pages.forEach((page, i) => {
    const contentRef = pageBase + 2 * i + 1;
    pageObjects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width ?? 960} ${page.height ?? 540}]` +
        `${page.rotate ? ` /Rotate ${page.rotate}` : ''} /Resources << /Font << ${fontRefs} >> >> /Contents ${contentRef} 0 R >>`,
      stream(page.content),
    );
  });
  const kids = pages.map((_, i) => `${pageBase + 2 * i} 0 R`).join(' ');
  return buildPdf(
    ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`, ...fonts, ...extra, ...pageObjects],
    trailer,
  );
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** A ToUnicode CMap mapping single-byte codes to code points (bfchar entries). */
function toUnicodeCMap(map: Record<number, number>): string {
  const hex = (value: number, digits: number) => value.toString(16).toUpperCase().padStart(digits, '0');
  const entries = Object.entries(map).map(([code, unicode]) => `<${hex(Number(code), 2)}> <${hex(unicode, 4)}>`);
  return stream(
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n' +
      '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      `${entries.length} beginbfchar\n${entries.join('\n')}\nendbfchar\n` +
      'endcmap CMapName currentdict /CMap defineresource pop end end',
  );
}

/**
 * One slide whose Symbol-font text maps to U+F0xx through its ToUnicode CMap (what Office writes for SymbolMT):
 * "Sets: α β ∪ ∈ ∅ →" on the first line, then a Wingdings bullet (U+F0A7, must stay as it is) and "done".
 */
export function symbolFontPdf(): Buffer {
  // Symbol codes: a (α), b (β), 0xC8 (∪), 0xCE (∈), 0xC6 (∅), 0xAE (→), space; all through the PUA.
  const symbolCodes = [0x20, 0x61, 0x62, 0xc8, 0xce, 0xc6, 0xae];
  const symbolMap = Object.fromEntries(symbolCodes.map((code) => [code, 0xf000 + code]));
  const fonts = [
    HELVETICA,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /TrueType /BaseFont /Wingdings-Regular /FirstChar 167 /LastChar 167 /Widths [ 458 ] /FontDescriptor 8 0 R /ToUnicode 7 0 R >>',
  ];
  const extra = [
    toUnicodeCMap(symbolMap),
    toUnicodeCMap({ 0xa7: 0xf0a7 }),
    '<< /Type /FontDescriptor /FontName /Wingdings-Regular /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ];
  const content =
    'BT /F1 36 Tf 60 420 Td (Sets: ) Tj /F2 36 Tf (a b \\310 \\316 \\306 \\256) Tj ET\n' +
    'BT /F3 36 Tf 60 340 Td (\\247) Tj /F1 36 Tf ( done) Tj ET';
  return pagesPdf([{ content }], fonts, extra);
}

/** `pages` slides (one by default) with Korean text in a non-embedded CID font (HYGoThic-Medium, Adobe-Korea1): "한글 강의". */
export function cjkPdf(pages = 1): Buffer {
  const fonts = [
    '<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [ 4 0 R ] >>',
  ];
  const extra = [
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /DW 1000 /FontDescriptor 5 0 R >>',
    '<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 6 /FontBBox [-6 -145 1003 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>',
  ];
  // UCS-2 big endian: 한 D55C, 글 AE00, space 0020, 강 AC15, 의 C758.
  return pagesPdf(Array.from({ length: pages }, () => ({ content: 'BT /F1 96 Tf 80 250 Td <D55CAE000020AC15C758> Tj ET' })), fonts, extra);
}

/**
 * One slide with an interactive form and annotations, all drawn over a page whose own content is only "Name:":
 * a filled-in text field with an appearance stream ("FILLED ANSWER"), a checked check box whose appearance is a
 * red square (x 100-200, y 100-200 pt), a text field with a value but no appearance stream, a typed note
 * (FreeText "typed note", appearance included) and a hidden FreeText ("hidden note").
 */
export function formPdf(): Buffer {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 8 0 R 11 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [5 0 R 8 0 R 11 0 R 12 0 R 14 0 R] >>',
    stream('BT /F1 24 Tf 100 450 Td (Name:) Tj ET'),
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (answer) /V (FILLED ANSWER) /DA (/Helv 48 Tf 0 g) /Rect [100 300 900 400] /F 4 /P 3 0 R /AP << /N 6 0 R >> >>',
    stream('/Tx BMC BT /Helv 48 Tf 0 g 10 30 Td (FILLED ANSWER) Tj ET EMC', '/Type /XObject /Subtype /Form /BBox [0 0 800 100] /Resources << /Font << /Helv 7 0 R >> >>'),
    HELVETICA,
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Yes /AS /Yes /Rect [100 100 200 200] /F 4 /P 3 0 R /AP << /N << /Yes 9 0 R /Off 10 0 R >> >> >>',
    stream('1 0 0 rg 0 0 100 100 re f', '/Type /XObject /Subtype /Form /BBox [0 0 100 100]'),
    stream('', '/Type /XObject /Subtype /Form /BBox [0 0 100 100]'),
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (plain) /V (typed without appearance) /DA (/Helv 24 Tf 0 g) /Rect [300 200 900 260] /F 4 /P 3 0 R >>',
    '<< /Type /Annot /Subtype /FreeText /Rect [300 100 900 160] /F 4 /Contents (typed note) /DA (/Helv 36 Tf 0 0 1 rg) /AP << /N 13 0 R >> >>',
    stream('BT /Helv 36 Tf 0 0 1 rg 10 20 Td (typed note) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 600 60] /Resources << /Font << /Helv 7 0 R >> >>'),
    '<< /Type /Annot /Subtype /FreeText /Rect [300 20 900 80] /F 6 /Contents (hidden note) /DA (/Helv 36 Tf 0 g) >>',
  ]);
}

/**
 * One slide with text on shifted baselines, each piece its own text object as PowerPoint writes it: superscripts
 * ("1st", "2nd", "x2", a footnote mark †) and subscripts ("Ai", "E2" before a gap), where PDFium generates line breaks
 * for some of them; then real line ends that must stay: a line that starts to the right of the previous line's end
 * (lower down), and two cells on one baseline.
 */
export function baselinePdf(): Buffer {
  // Helvetica advance widths (1/1000 em) of the characters used, for the position after each piece.
  const widths: Record<string, number> = { ' ': 278, '1': 556, '2': 556, '+': 584, A: 667, E: 667, R: 722, a: 556, d: 556, e: 556, f: 278, h: 556, i: 222, k: 500, n: 556, o: 556, p: 556, s: 500, t: 278, x: 500 };
  const width = (text: string, size: number) => ([...text].reduce((sum, char) => sum + (widths[char] ?? 556), 0) * size) / 1000;
  const pieces: string[] = [];
  /** Pieces of one line from x = 60: [text, font size, baseline shift, extra space before it]. */
  const line = (y: number, parts: [string, number, number, number?][]) => {
    let x = 60;
    for (const [text, size, shift, space = 0] of parts) {
      x += space;
      pieces.push(`BT /F1 ${size} Tf ${x.toFixed(2)} ${y + shift} Td (${text}) Tj ET`);
      x += width(text, size);
    }
  };
  line(470, [['Rank 1', 36, 0], ['st', 24, 12], [' and 2', 36, 0], ['nd', 24, 12]]);
  line(410, [['x', 36, 0], ['2', 24, 12], [' + A', 36, 0], ['i', 24, -8], [' done', 36, 0]]);
  line(350, [['if E', 36, 0], ['2', 24, -8], ['then', 36, 0, 18]]);
  line(290, [['fixed point', 36, 0], ['\\206', 24, 12]]);
  pieces.push('BT /F1 36 Tf 500 230 Td (lower right) Tj ET');
  pieces.push('BT /F1 36 Tf 60 120 Td (Cell A) Tj ET', 'BT /F1 36 Tf 600 120 Td (Cell B) Tj ET');
  return pagesPdf([{ content: pieces.join('\n') }], [HELVETICA]);
}

/** A deck of `count` 16:9 slides titled "Slide 1", "Slide 2", …; `rotate` applies to every page. */
export function deckPdf(count: number, options: { rotate?: number; draw?: (n: number) => string } = {}): Buffer {
  return pagesPdf(
    Array.from({ length: count }, (_, i) => ({
      content: `BT /F1 48 Tf 60 440 Td (Slide ${i + 1}) Tj ET\n${options.draw?.(i + 1) ?? ''}`,
      rotate: options.rotate,
    })),
    [HELVETICA],
  );
}

// ---------------------------------------------------------------------------
// Standard security handler, revision 2 (RC4, 40-bit key): PDF 1.7 §7.6.3.3, algorithms 2-4
// ---------------------------------------------------------------------------

const PASSWORD_PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

function padPassword(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, 'latin1'), PASSWORD_PAD]).subarray(0, 32);
}

function md5(...parts: Buffer[]): Buffer {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/**
 * A one-page PDF that needs `userPassword` to open (RC4 40-bit). The page has no content stream and no strings,
 * so nothing else needs encrypting; opening it with the right password works in any reader.
 */
export function encryptedPdf(userPassword: string, ownerPassword = `${userPassword}-owner`): Buffer {
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const permissions = -4; // everything allowed
  const owner = rc4(md5(padPassword(ownerPassword)).subarray(0, 5), padPassword(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const key = md5(padPassword(userPassword), owner, p, id).subarray(0, 5);
  const user = rc4(key, PASSWORD_PAD);
  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << >> >>',
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${permissions} /O <${owner.toString('hex')}> /U <${user.toString('hex')}> >>`,
    ],
    `/Encrypt 4 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] `,
  );
}

/** Bytes that start like a PDF but are not one. */
export const GARBAGE_PDF = Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF\n');
