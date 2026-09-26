// PDF engine (DESIGN §3 steps 1-3, §17): PDFium compiled to WebAssembly (@embedpdf/pdfium, pinned) for the page
// count and size, the slide renderings and the page text. It replaced poppler (pdfinfo / pdftoppm / pdftotext):
// nothing to install, the same files on every platform (no native binary), BSD/Apache-licensed
// (THIRD_PARTY_NOTICES.md).
//
// Child side only: the image worker (server/imageWorker.ts) imports this module dynamically, so the long-lived
// server process never instantiates the WebAssembly module (its memory is gone when the worker exits).
//
// Memory: the PDF is never copied into the wasm heap as a whole. PDFium reads the byte ranges it needs through
// an FPDF_FILEACCESS callback (fs.readSync straight into the heap), which took the peak RSS for a 150 MB PDF
// from ~539 MB to ~259 MB. Every page, text page, bitmap and document is closed as soon as it is done.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { RegionRect } from '../shared/types.ts';

const FPDF_ANNOT = 0x01;
/** RGBx instead of BGRx: sharp takes the bitmap as raw 4-channel pixels. */
const FPDF_REVERSE_BYTE_ORDER = 0x10;
/** FPDF_GetLastError() codes (fpdfview.h). */
const FPDF_ERR_FILE = 2;
const FPDF_ERR_FORMAT = 3;
const FPDF_ERR_PASSWORD = 4;
const FPDF_ERR_SECURITY = 5;
/** Windows charsets PDFium asks for when a CJK font is not embedded: SHIFTJIS, HANGEUL, GB2312, CHINESEBIG5. */
const CJK_CHARSETS: ReadonlySet<number> = new Set([128, 129, 134, 136]);
/** Face name under which the host CJK font is offered to PDFium (FPDF_AddInstalledFont). */
const FALLBACK_FACE = 'EasyStudyFallbackCJK';
/** Handle of the (only) fallback font returned by MapFont / GetFont: any non-zero value. */
const FALLBACK_HANDLE = 1;
/** FPDF_FILEACCESS.m_FileLen is an `unsigned long`: 32 bits on wasm32. */
const MAX_PDF_BYTES = 0xffff_ffff;
/** Initial size of the font name buffer of FPDFText_GetFontInfo (longer names get their own buffer). */
const FONT_NAME_BUF = 256;
/** Characters looked through, on each side of a generated line break, for the ones it separates. */
const JOIN_SCAN = 8;
/** Largest glyph angle (radians, either way; a synthetic italic is ~0.32) of text still treated as upright. */
const UPRIGHT_ANGLE = 0.6;
/** FPDFAnnot_GetSubtype() values (fpdf_annot.h) whose text is drawn on the page, as pdftotext extracts it. */
const FPDF_ANNOT_FREETEXT = 3;
const FPDF_ANNOT_WIDGET = 20;
/** FPDFAnnot_GetFlags() bits of annotations that are not shown: invisible (unknown type), hidden, no view. */
const ANNOT_NOT_SHOWN = 0x01 | 0x02 | 0x20;
/** FPDFAnnot_GetFormFieldType() values whose value is text: combo box, list box, text field. */
const TEXT_VALUE_FIELDS: ReadonlySet<number> = new Set([4, 5, 6]);
/**
 * Long edge (device units) of the virtual device a selected region is mapped from (FPDF_DeviceToPage takes
 * integer device coordinates): fine enough that rounding moves a corner by less than 0.01 pt on a slide.
 */
const REGION_DEVICE_EDGE = 100_000;

export interface RenderedPage {
  /** RGBx pixels, row after row (stride = width * 4). */
  data: Buffer;
  width: number;
  height: number;
}

/** One loaded page; close() it (PdfDocument.withPage does). */
export interface PdfPage {
  /** Size in points, /Rotate applied (what pdfinfo's "Page size" and "Page rot" gave together). */
  readonly width: number;
  readonly height: number;
  /** The page at `longEdge` pixels on its long side (like pdftoppm -scale-to), annotations included, on white. */
  render(longEdge: number): RenderedPage;
  /**
   * The page text in content order, lines separated by '\n'; Symbol-font PUA code points mapped back, and
   * superscripts / subscripts kept on their line (lineBreakJoint). Then, one per line, the text that annotations
   * draw on the page (pdftotext had it too): filled-in form fields and typed notes (FreeText).
   */
  text(): string;
  /**
   * The text of the page's text layer inside a region of the rendered page (normalised to the page as render()
   * draws it: 0..1, origin top-left, /Rotate applied), as FPDFText_GetBoundedText gives it (a character counts when
   * its box meets the region), Symbol-font PUA code points mapped back like text(), cleaned like the page text
   * (cleanPageText). '' when the page has no text there (DESIGN §21).
   */
  textInRegion(rect: RegionRect): string;
  close(): void;
}

export interface PdfDocument {
  readonly pageCount: number;
  /** Loads page `n` (1-based), runs `use` and closes the page again. */
  withPage<T>(n: number, use: (page: PdfPage) => T): T;
  /** Closes the document and its file (idempotent). */
  close(): void;
}

/** Why PDFium could not open a PDF, from FPDF_GetLastError(). */
export function openErrorMessage(code: number): string {
  switch (code) {
    case FPDF_ERR_PASSWORD:
      return 'the PDF is password protected';
    case FPDF_ERR_FORMAT:
      return 'could not read the PDF: the file is damaged or is not a PDF';
    case FPDF_ERR_SECURITY:
      return 'could not read the PDF: it is encrypted with an unsupported security handler';
    case FPDF_ERR_FILE:
      return 'could not read the PDF file';
    default:
      return `could not read the PDF (PDFium error ${code})`;
  }
}

// ---------------------------------------------------------------------------
// Text: Symbol-font PUA code points, cleanup
// ---------------------------------------------------------------------------

// Microsoft Office writes Symbol-font glyphs (SymbolMT) with ToUnicode entries in the Private Use Area:
// U+F000 + the Symbol encoding byte. Every extractor returns those code points (pdftotext too), which show
// as blanks; this is the Adobe Symbol encoding, so α ε ∪ ∈ ∩ ∅ come back.
const SYMBOL_ENCODING: Record<number, string> = {
  0x20: ' ', 0x21: '!', 0x22: '∀', 0x23: '#', 0x24: '∃', 0x25: '%', 0x26: '&', 0x27: '∋', 0x28: '(', 0x29: ')',
  0x2a: '∗', 0x2b: '+', 0x2c: ',', 0x2d: '−', 0x2e: '.', 0x2f: '/', 0x30: '0', 0x31: '1', 0x32: '2', 0x33: '3',
  0x34: '4', 0x35: '5', 0x36: '6', 0x37: '7', 0x38: '8', 0x39: '9', 0x3a: ':', 0x3b: ';', 0x3c: '<', 0x3d: '=',
  0x3e: '>', 0x3f: '?', 0x40: '≅', 0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ', 0x47: 'Γ',
  0x48: 'Η', 0x49: 'Ι', 0x4a: 'ϑ', 0x4b: 'Κ', 0x4c: 'Λ', 0x4d: 'Μ', 0x4e: 'Ν', 0x4f: 'Ο', 0x50: 'Π', 0x51: 'Θ',
  0x52: 'Ρ', 0x53: 'Σ', 0x54: 'Τ', 0x55: 'Υ', 0x56: 'ς', 0x57: 'Ω', 0x58: 'Ξ', 0x59: 'Ψ', 0x5a: 'Ζ', 0x5b: '[',
  0x5c: '∴', 0x5d: ']', 0x5e: '⊥', 0x5f: '_', 0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ',
  0x67: 'γ', 0x68: 'η', 0x69: 'ι', 0x6a: 'ϕ', 0x6b: 'κ', 0x6c: 'λ', 0x6d: 'μ', 0x6e: 'ν', 0x6f: 'ο', 0x70: 'π',
  0x71: 'θ', 0x72: 'ρ', 0x73: 'σ', 0x74: 'τ', 0x75: 'υ', 0x76: 'ϖ', 0x77: 'ω', 0x78: 'ξ', 0x79: 'ψ', 0x7a: 'ζ',
  0x7b: '{', 0x7c: '|', 0x7d: '}', 0x7e: '∼', 0xa0: '€', 0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞',
  0xa6: 'ƒ', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓',
  0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠',
  0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xbd: '|', 0xbe: '—', 0xbf: '↵', 0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘',
  0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆',
  0xce: '∈', 0xcf: '∉', 0xd0: '∠', 0xd1: '∇', 0xd2: '®', 0xd3: '©', 0xd4: '™', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅',
  0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓', 0xe0: '◊', 0xe1: '⟨',
  0xe2: '®', 0xe3: '©', 0xe4: '™', 0xe5: '∑', 0xe6: '⎛', 0xe7: '⎜', 0xe8: '⎝', 0xe9: '⎡', 0xea: '⎢', 0xeb: '⎣',
  0xec: '⎧', 0xed: '⎨', 0xee: '⎩', 0xef: '⎪', 0xf1: '⟩', 0xf2: '∫', 0xf3: '⌠', 0xf4: '⎮', 0xf5: '⌡', 0xf6: '⎞',
  0xf7: '⎟', 0xf8: '⎠', 0xf9: '⎤', 0xfa: '⎥', 0xfb: '⎦', 0xfc: '⎫', 0xfd: '⎬', 0xfe: '⎭',
};

/** First and last Private Use Area code point a Symbol font is written with (U+F000 + 0x20..0xFF). */
const SYMBOL_PUA_FIRST = 0xf020;
const SYMBOL_PUA_LAST = 0xf0ff;

/**
 * The real character of a PUA code point drawn with a Symbol font (the font name as in the PDF, subset prefix
 * allowed), else null: other PUA fonts (Wingdings, Webdings, …) use other encodings and are left alone.
 */
export function symbolPuaToUnicode(codePoint: number, fontName: string): string | null {
  if (codePoint < SYMBOL_PUA_FIRST || codePoint > SYMBOL_PUA_LAST) return null;
  if (!/symbol/i.test(fontName.replace(/^[A-Z]{6}\+/, ''))) return null;
  return SYMBOL_ENCODING[codePoint - 0xf000] ?? null;
}

/** Trims trailing spaces, surrounding blank lines and the common left margin; at most one blank line. */
export function cleanPageText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const indents = lines.filter((line) => line !== '').map((line) => line.length - line.trimStart().length);
  const margin = indents.length > 0 ? Math.min(...indents) : 0;
  // Runs of blank lines carry no information for the model; keep at most one.
  return lines
    .map((line) => line.slice(margin))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** A character's box in page coordinates (points, y upwards). */
export interface CharBox {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * What replaces a line break PDFium generated between two characters (the last one before it, `before`, and the
 * first one after it, `after`: their loose boxes, font ascent to descent), or null to keep the break. PDFium breaks
 * the line wherever the baseline moves, so a superscript or subscript ("1st", "x²", "Aᵢ →", a footnote mark "†")
 * came out on a line of its own: "1\nst". Joined when both sit on one line (their boxes overlap by at least half
 * the smaller height) and `after` starts where `before` ends (from a quarter em back to one em on): '' when the
 * text has a space there already or the glyphs touch, else ' '. Real line ends start the next line to the left
 * of the previous one's end, or below it.
 */
export function lineBreakJoint(before: CharBox, after: CharBox, spaced: boolean): string | null {
  const heightBefore = before.top - before.bottom;
  const heightAfter = after.top - after.bottom;
  if (!(heightBefore > 0 && heightAfter > 0)) return null;
  const em = Math.max(heightBefore, heightAfter);
  const gap = (after.left - before.right) / em;
  const overlap = (Math.min(before.top, after.top) - Math.max(before.bottom, after.bottom)) / Math.min(heightBefore, heightAfter);
  if (overlap < 0.5 || gap < -0.25 || gap > 1) return null;
  return spaced || gap < 0.15 ? '' : ' ';
}

/** Spaces and line breaks (generated or not), and code point 0. */
function isBlank(codePoint: number | undefined): boolean {
  return codePoint === 0x20 || codePoint === 0x0d || codePoint === 0x0a || codePoint === 0x09 || codePoint === 0;
}

// ---------------------------------------------------------------------------
// Fallback font for non-embedded CJK fonts
// ---------------------------------------------------------------------------

/**
 * Host font files for non-embedded CJK fonts, in order of preference (the first one that exists is used).
 * PDFium-wasm cannot see the system fonts: without one of these, such text is not drawn at all. Base-14 fonts
 * (Helvetica, Times, ...) never need this: PDFium has its own substitutes built in.
 * EASY_STUDY_PDF_FALLBACK_FONT (a .ttf/.otf/.ttc file) replaces the list.
 */
export function fallbackFontFiles(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.EASY_STUDY_PDF_FALLBACK_FONT?.trim();
  if (override) return [override];
  switch (platform) {
    case 'darwin':
      return [
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        '/Library/Fonts/Arial Unicode.ttf',
        '/System/Library/Fonts/AppleSDGothicNeo.ttc',
      ];
    case 'win32': {
      const fonts = path.win32.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts');
      return ['malgun.ttf', 'gulim.ttc', 'msgothic.ttc', 'msyh.ttc'].map((name) => path.win32.join(fonts, name));
    }
    default:
      return [
        // Noto Sans CJK: Debian/Ubuntu (fonts-noto-cjk), Arch (noto-fonts-cjk), Fedora (google-noto-sans-cjk-*).
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
        // Nanum Gothic: Debian/Ubuntu (fonts-nanum), Fedora (naver-nanum-*), Arch only via the AUR.
        '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
        '/usr/share/fonts/nanum/NanumGothic.ttf',
        '/usr/share/fonts/naver-nanum/NanumGothic.ttf',
      ];
  }
}

/** The first of `files` that can be read (whole file), or null. */
function readFirstFont(files: string[]): Buffer | null {
  for (const file of files) {
    try {
      return fs.readFileSync(file);
    } catch {
      // Not on this system: try the next one.
    }
  }
  return null;
}

/** The fallback font files looked for in vain when a page asked for a CJK font (null: none asked, or found). */
let missingFallbackFont: string[] | null = null;

/**
 * Why text of this process's PDFs was not drawn, or null: a page used a CJK font that is not embedded, and none of
 * the fallback font files could be read (the text itself is extracted all the same).
 */
export function fallbackFontWarning(): string | null {
  if (!missingFallbackFont) return null;
  return (
    `the PDF uses a CJK font it does not embed, and no fallback font could be read (${missingFallbackFont.join(', ')}): ` +
    `such text is missing from the slide images (not from the text). Install one (Linux: fonts-noto-cjk or ` +
    `fonts-nanum) or set EASY_STUDY_PDF_FALLBACK_FONT to a .ttf/.otf/.ttc file, then upload the PDF again`
  );
}

/**
 * Makes PDFium ask us for the fonts it does not have (FPDF_SetSystemFontInfo with JavaScript callbacks). Only
 * CJK charsets get the host fallback font; everything else keeps PDFium's built-in substitutes. The font file
 * is read on first use only, so documents with embedded fonts (nearly all) never pay for it, and a system
 * without any of the files simply keeps drawing nothing for such text.
 */
function installFallbackFonts(m: WrappedPdfiumModule, files: string[]): void {
  const P = m.pdfium;
  let bytes: Buffer | null | undefined;
  const fontBytes = (): Buffer | null => {
    if (bytes === undefined) bytes = readFirstFont(files);
    if (!bytes) missingFallbackFont = files;
    return bytes;
  };
  const faceName = Buffer.from(`${FALLBACK_FACE}\0`, 'latin1');
  const facePtr = P.wasmExports.malloc(faceName.length); // kept for the life of the module (= the process)
  heap(m).set(faceName, facePtr);
  const copyOut = (data: Buffer, buffer: number, size: number): number => {
    if (buffer && size >= data.length) heap(m).set(data, buffer);
    return data.length;
  };
  // struct FPDF_SYSFONTINFO { int version; Release, EnumFonts, MapFont, GetFont, GetFontData, GetFaceName,
  // GetFontCharset, DeleteFont } — 9 x 4 bytes on wasm32. Every callback gets the struct itself first.
  const callbacks = [
    // void Release(self)
    P.addFunction(() => {}, 'vi'),
    // void EnumFonts(self, mapper)
    P.addFunction((_self: number, mapper: number) => {
      for (const charset of CJK_CHARSETS) m.FPDF_AddInstalledFont(mapper, facePtr, charset);
    }, 'vii'),
    // void* MapFont(self, weight, italic, charset, pitchFamily, face, exact*)
    P.addFunction(
      (_self: number, _weight: number, _italic: number, charset: number) =>
        CJK_CHARSETS.has(charset) && fontBytes() ? FALLBACK_HANDLE : 0,
      'iiiiiiii',
    ),
    // void* GetFont(self, face): only the face enumerated above exists here.
    P.addFunction((_self: number, face: number) => (face && P.UTF8ToString(face) === FALLBACK_FACE && fontBytes() ? FALLBACK_HANDLE : 0), 'iii'),
    // unsigned long GetFontData(self, font, table, buffer, size): the whole file (table 0) only.
    P.addFunction((_self: number, _font: number, table: number, buffer: number, size: number) => {
      const data = fontBytes();
      return data && table === 0 ? copyOut(data, buffer >>> 0, size >>> 0) : 0;
    }, 'iiiiii'),
    // unsigned long GetFaceName(self, font, buffer, size)
    P.addFunction((_self: number, _font: number, buffer: number, size: number) => copyOut(faceName, buffer >>> 0, size >>> 0), 'iiiii'),
    // int GetFontCharset(self, font): only asked for fonts mapped for the default charset, which never happens here.
    P.addFunction(() => 129, 'iii'),
    // void DeleteFont(self, font)
    P.addFunction(() => {}, 'vii'),
  ];
  const info = P.wasmExports.malloc(4 * (1 + callbacks.length)); // kept for the life of the module
  P.setValue(info, 1, 'i32');
  callbacks.forEach((fn, i) => P.setValue(info + 4 * (i + 1), fn, 'i32'));
  m.FPDF_SetSystemFontInfo(info);
}

// ---------------------------------------------------------------------------
// Engine and documents
// ---------------------------------------------------------------------------

/** The current heap view (memory growth replaces the buffer, so never keep one across calls). */
function heap(m: WrappedPdfiumModule): Uint8Array {
  return (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}

let enginePromise: Promise<WrappedPdfiumModule> | null = null;

/** PDFium, instantiated once per process on first use. */
function engine(): Promise<WrappedPdfiumModule> {
  enginePromise ??= (async () => {
    const { init } = await import('@embedpdf/pdfium');
    const wasm = fs.readFileSync(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm'));
    const m = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    m.PDFiumExt_Init();
    installFallbackFonts(m, fallbackFontFiles());
    return m;
  })();
  return enginePromise;
}

/** Size of PDFium's WebAssembly heap in bytes (it only ever grows): lets tests see memory that is not given back. */
export async function engineHeapBytes(): Promise<number> {
  return heap(await engine()).length;
}

/**
 * Opens a PDF file. PDFium reads it on demand (FPDF_LoadCustomDocument), so the file stays open until
 * close(). Throws a readable message when PDFium cannot open it (openErrorMessage).
 */
export async function openPdf(file: string): Promise<PdfDocument> {
  const m = await engine();
  const P = m.pdfium;
  const malloc = (size: number) => P.wasmExports.malloc(size);
  const free = (ptr: number) => P.wasmExports.free(ptr);

  const fd = fs.openSync(file, 'r');
  let getBlock = 0;
  let access = 0;
  let doc = 0;
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_PDF_BYTES) throw new Error('the PDF is too large (4 GB or more)');
    // int GetBlock(param, unsigned long position, unsigned char* buffer, unsigned long size): 1 = read, 0 = failed.
    getBlock = P.addFunction((_param: number, position: number, buffer: number, length: number) => {
      const target = heap(m);
      let offset = 0;
      const want = length >>> 0;
      const start = buffer >>> 0;
      try {
        while (offset < want) {
          const read = fs.readSync(fd, target, start + offset, want - offset, (position >>> 0) + offset);
          if (read <= 0) return 0;
          offset += read;
        }
        return 1;
      } catch {
        return 0;
      }
    }, 'iiiii');
    // struct FPDF_FILEACCESS { unsigned long m_FileLen; GetBlock*; void* m_Param } — 12 bytes on wasm32. It must
    // stay valid until FPDF_CloseDocument.
    access = malloc(12);
    P.setValue(access, size, 'i32');
    P.setValue(access + 4, getBlock, 'i32');
    P.setValue(access + 8, 0, 'i32');
    doc = m.FPDF_LoadCustomDocument(access, '');
    if (!doc) throw new Error(openErrorMessage(m.FPDF_GetLastError()));
  } catch (err) {
    if (access) free(access);
    if (getBlock) P.removeFunction(getBlock);
    fs.closeSync(fd);
    throw err;
  }

  // Form fields (widget annotations: filled-in text, check marks) are drawn by PDFium's form layer only
  // (FPDF_FFLDraw), never by FPDF_RenderPageBitmap, FPDF_ANNOT or not: a document with a form needs a form-fill
  // environment, else its fields are blank where poppler drew them. Released before the document (fpdf_formfill.h).
  let formInfo = 0;
  let form = 0;
  if (m.FPDF_GetFormType(doc) !== 0) {
    formInfo = m.PDFiumExt_OpenFormFillInfo();
    form = formInfo ? m.PDFiumExt_InitFormFillEnvironment(doc, formInfo) : 0;
  }

  const nameBuf = malloc(FONT_NAME_BUF);
  const flagsPtr = malloc(4);
  const rectPtr = malloc(16); // FS_RECTF { float left, top, right, bottom }
  const doublesPtr = malloc(32); // up to four doubles (FPDF_DeviceToPage, FPDFText_GetCharBox)

  /** A UTF-16LE string of PDFium's "length in bytes, NUL included" getters (asked twice: size, then text). */
  const utf16 = (get: (buffer: number, length: number) => number): string => {
    const length = get(0, 0);
    if (length <= 2) return '';
    const buffer = malloc(length);
    try {
      if (get(buffer, length) !== length) return '';
      return Buffer.from(heap(m).subarray(buffer, buffer + length - 2)).toString('utf16le');
    } finally {
      free(buffer);
    }
  };

  /** Text of the shown FreeText annotations and text-valued form fields of a page, in /Annots order. */
  const annotationTexts = (page: number): string[] => {
    const texts: string[] = [];
    const count = m.FPDFPage_GetAnnotCount(page);
    for (let i = 0; i < count; i++) {
      const annot = m.FPDFPage_GetAnnot(page, i);
      if (!annot) continue;
      try {
        if (m.FPDFAnnot_GetFlags(annot) & ANNOT_NOT_SHOWN) continue;
        const subtype = m.FPDFAnnot_GetSubtype(annot);
        let text = '';
        if (subtype === FPDF_ANNOT_FREETEXT) {
          text = utf16((buffer, length) => m.FPDFAnnot_GetStringValue(annot, 'Contents', buffer, length));
        } else if (subtype === FPDF_ANNOT_WIDGET && form && TEXT_VALUE_FIELDS.has(m.FPDFAnnot_GetFormFieldType(form, annot))) {
          text = utf16((buffer, length) => m.FPDFAnnot_GetFormFieldValue(form, annot, buffer, length));
        }
        if (text.trim()) texts.push(text);
      } finally {
        m.FPDFPage_CloseAnnot(annot);
      }
    }
    return texts;
  };

  /** The name of the font character `i` of a text page is drawn with ('' when unknown). */
  const fontName = (textPage: number, i: number): string => {
    const needed = m.FPDFText_GetFontInfo(textPage, i, nameBuf, FONT_NAME_BUF, flagsPtr);
    if (needed <= 0) return '';
    if (needed <= FONT_NAME_BUF) return P.UTF8ToString(nameBuf);
    // Longer than the buffer: PDFium did not write it.
    const big = malloc(needed);
    try {
      return m.FPDFText_GetFontInfo(textPage, i, big, needed, flagsPtr) === needed ? P.UTF8ToString(big) : '';
    } finally {
      free(big);
    }
  };

  /** Loose box of character `i` (font ascent to descent), or null for a glyph that is not upright or has none. */
  const looseBox = (textPage: number, i: number): CharBox | null => {
    const angle = m.FPDFText_GetCharAngle(textPage, i);
    if (!(angle >= 0 && (angle <= UPRIGHT_ANGLE || angle >= 2 * Math.PI - UPRIGHT_ANGLE))) return null;
    if (!m.FPDFText_GetLooseCharBox(textPage, i, rectPtr)) return null;
    const [left, top, right, bottom] = [0, 4, 8, 12].map((offset) => P.getValue(rectPtr + offset, 'float'));
    return { left, right, bottom, top };
  };

  /** lineBreakJoint() for the generated break "\r\n" at `codes[i]`, `codes[i + 1]`. */
  const joinAt = (textPage: number, codes: number[], i: number): string | null => {
    let before = i - 1;
    while (before >= 0 && i - before < JOIN_SCAN && isBlank(codes[before])) before--;
    let after = i + 2;
    while (after < codes.length && after - i < JOIN_SCAN && isBlank(codes[after])) after++;
    if (before < 0 || after >= codes.length || isBlank(codes[before]) || isBlank(codes[after])) return null;
    const boxBefore = looseBox(textPage, before);
    const boxAfter = boxBefore && looseBox(textPage, after);
    if (!boxBefore || !boxAfter) return null;
    return lineBreakJoint(boxBefore, boxAfter, isBlank(codes[i - 1]) || isBlank(codes[i + 2]));
  };

  /**
   * The region (normalised to the rendered page) in page coordinates (points, y upwards): its corners mapped with
   * FPDF_DeviceToPage, which applies /Rotate and the crop box origin the way rendering does.
   */
  const regionToPage = (page: number, width: number, height: number, rect: RegionRect) => {
    const scale = REGION_DEVICE_EDGE / Math.max(width, height, 1e-6);
    const deviceW = Math.max(1, Math.round(width * scale));
    const deviceH = Math.max(1, Math.round(height * scale));
    const clamp = (value: number) => Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
    const x0 = clamp(rect.x);
    const y0 = clamp(rect.y);
    const x1 = clamp(rect.x + rect.w);
    const y1 = clamp(rect.y + rect.h);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [dx, dy] of [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ]) {
      m.FPDF_DeviceToPage(page, 0, 0, deviceW, deviceH, 0, Math.round(dx * deviceW), Math.round(dy * deviceH), doublesPtr, doublesPtr + 8);
      xs.push(P.getValue(doublesPtr, 'double'));
      ys.push(P.getValue(doublesPtr + 8, 'double'));
    }
    return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  };

  /** Symbol-font PUA code points of the characters whose box meets `area`, mapped to their real characters. */
  const symbolRemapIn = (textPage: number, area: CharBox): Map<number, string> => {
    const remap = new Map<number, string>();
    const count = Math.max(0, m.FPDFText_CountChars(textPage));
    for (let i = 0; i < count; i++) {
      const codePoint = m.FPDFText_GetUnicode(textPage, i);
      if (codePoint < SYMBOL_PUA_FIRST || codePoint > SYMBOL_PUA_LAST || remap.has(codePoint)) continue;
      if (!m.FPDFText_GetCharBox(textPage, i, doublesPtr, doublesPtr + 8, doublesPtr + 16, doublesPtr + 24)) continue;
      const [left, right, bottom, top] = [0, 8, 16, 24].map((offset) => P.getValue(doublesPtr + offset, 'double'));
      if (left > area.right || right < area.left || bottom > area.top || top < area.bottom) continue;
      const mapped = symbolPuaToUnicode(codePoint, fontName(textPage, i));
      if (mapped !== null) remap.set(codePoint, mapped);
    }
    return remap;
  };

  const loadPage = (n: number): PdfPage => {
    const page = m.FPDF_LoadPage(doc, n - 1);
    if (!page) throw new Error(`could not load page ${n} of the PDF`);
    if (form) m.FORM_OnAfterLoadPage(page, form);
    const width = m.FPDF_GetPageWidthF(page);
    const height = m.FPDF_GetPageHeightF(page);
    let closed = false;
    return {
      width,
      height,
      render(longEdge) {
        const scale = longEdge / Math.max(width, height, 1e-6);
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const bitmap = m.FPDFBitmap_Create(w, h, 0);
        if (!bitmap) throw new Error(`could not allocate a ${w}x${h} bitmap for page ${n}`);
        try {
          m.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xffffffff);
          m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
          // Then the form fields on top (same byte order).
          if (form) m.FPDF_FFLDraw(form, bitmap, page, 0, 0, w, h, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
          const buffer = m.FPDFBitmap_GetBuffer(bitmap);
          const stride = m.FPDFBitmap_GetStride(bitmap);
          const pixels = heap(m).subarray(buffer, buffer + stride * h);
          // Copied out: the wasm heap is reused (and may grow, detaching views) by the next page.
          let data: Buffer;
          if (stride === w * 4) {
            data = Buffer.from(pixels);
          } else {
            data = Buffer.alloc(w * 4 * h);
            for (let y = 0; y < h; y++) data.set(pixels.subarray(y * stride, y * stride + w * 4), y * w * 4);
          }
          return { data, width: w, height: h };
        } finally {
          m.FPDFBitmap_Destroy(bitmap);
        }
      },
      text() {
        const annotations = annotationTexts(page);
        const textPage = m.FPDFText_LoadPage(page);
        if (!textPage) return annotations.join('\n').replace(/\r\n?/g, '\n');
        try {
          let out = '';
          const count = Math.max(0, m.FPDFText_CountChars(textPage));
          const codes = Array.from({ length: count }, (_, i) => m.FPDFText_GetUnicode(textPage, i));
          for (let i = 0; i < count; i++) {
            const codePoint = codes[i];
            if (!codePoint) continue;
            // A break PDFium inserted where the baseline moves (a superscript or subscript) is not a line end.
            if (codePoint === 0x0d && codes[i + 1] === 0x0a && m.FPDFText_IsGenerated(textPage, i) === 1) {
              const joint = joinAt(textPage, codes, i);
              if (joint !== null) {
                out += joint;
                i++;
                continue;
              }
            }
            // A full code point (wchar_t is 32 bits on wasm), or one UTF-16 half of a pair: both append correctly.
            let char = codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '�';
            if (codePoint >= SYMBOL_PUA_FIRST && codePoint <= SYMBOL_PUA_LAST) {
              char = symbolPuaToUnicode(codePoint, fontName(textPage, i)) ?? char;
            }
            out += char;
          }
          if (annotations.length > 0) out += `${out ? '\n' : ''}${annotations.join('\n')}`;
          return out.replace(/\r\n?/g, '\n');
        } finally {
          m.FPDFText_ClosePage(textPage);
        }
      },
      textInRegion(rect) {
        const area = regionToPage(page, width, height, rect);
        if (!(area.right > area.left && area.top > area.bottom)) return '';
        const textPage = m.FPDFText_LoadPage(page);
        if (!textPage) return '';
        try {
          const length = m.FPDFText_GetBoundedText(textPage, area.left, area.top, area.right, area.bottom, 0, 0);
          if (length <= 0) return '';
          const buffer = malloc((length + 1) * 2);
          let raw: string;
          try {
            const copied = m.FPDFText_GetBoundedText(textPage, area.left, area.top, area.right, area.bottom, buffer, length + 1);
            const units = Math.min(length, Math.max(0, copied));
            raw = Buffer.from(heap(m).subarray(buffer, buffer + units * 2)).toString('utf16le');
          } finally {
            free(buffer);
          }
          const remap = /[\uf020-\uf0ff]/.test(raw) ? symbolRemapIn(textPage, area) : new Map<number, string>();
          let out = '';
          for (const char of raw) {
            const codePoint = char.codePointAt(0) ?? 0;
            if (codePoint === 0) continue;
            out += remap.get(codePoint) ?? char;
          }
          return cleanPageText(out);
        } finally {
          m.FPDFText_ClosePage(textPage);
        }
      },
      close() {
        if (closed) return;
        closed = true;
        if (form) m.FORM_OnBeforeClosePage(page, form);
        m.FPDF_ClosePage(page);
      },
    };
  };

  let closed = false;
  return {
    pageCount: m.FPDF_GetPageCount(doc),
    withPage(n, use) {
      const page = loadPage(n);
      try {
        return use(page);
      } finally {
        page.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (form) m.PDFiumExt_ExitFormFillEnvironment(form);
      if (formInfo) m.PDFiumExt_CloseFormFillInfo(formInfo);
      m.FPDF_CloseDocument(doc);
      free(access);
      P.removeFunction(getBlock);
      free(nameBuf);
      free(flagsPtr);
      free(rectPtr);
      free(doublesPtr);
      fs.closeSync(fd);
    },
  };
}
