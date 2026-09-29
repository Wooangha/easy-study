// File names of a document's per-page files (DESIGN §2), shared by library.ts, annotations.ts and the image worker.

/** 1-based page number, zero padded to 3 digits (more when the deck has > 999 pages). */
export function pageBaseName(n: number, pageCount: number): string {
  return String(n).padStart(Math.max(3, String(pageCount).length), '0');
}

/** File name of a rendered slide, e.g. `007.png`. */
export function slideFileName(n: number, pageCount: number): string {
  return `${pageBaseName(n, pageCount)}.png`;
}

/** File name of a slide's extracted text, e.g. `007.txt`. */
export function textFileName(n: number, pageCount: number): string {
  return `${pageBaseName(n, pageCount)}.txt`;
}

/** File name of a slide's text layout (word boxes, SlideTextLayout of DESIGN §25), e.g. `007.layout.json`, next to its text. */
export function layoutFileName(n: number, pageCount: number): string {
  return `${pageBaseName(n, pageCount)}.layout.json`;
}

/** File name of a slide's annotations (SlideAnnotations of DESIGN §25) under annotations/, e.g. `007.json`. */
export function annotationFileName(n: number, pageCount: number): string {
  return `${pageBaseName(n, pageCount)}.json`;
}

/**
 * text/.engine: which text extraction wrote text/NNN.txt (DESIGN §17). Written last, after every text file.
 * Documents converted before (poppler's pdftotext: no marker) or by an older extraction get their text
 * extracted again by the backfill (library.ts), never their images.
 */
export const TEXT_ENGINE_FILE = '.engine';

/**
 * Content of text/.engine for the current extraction (server/pdf.ts); bump it when the text output changes.
 * pdfium-1: the first PDFium extraction. pdfium-2: superscripts and subscripts stay on their line, and the text of
 * form fields and typed notes (FreeText annotations) is added. pdfium-3: the word boxes of every page are written
 * as well (text/NNN.layout.json, DESIGN §25), so old libraries gain them through the backfill.
 */
export const TEXT_ENGINE = 'pdfium-3';
