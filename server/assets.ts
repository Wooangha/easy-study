// Derived image files of a document (contract shared by library.ts, the image worker, index.ts and
// providers/proc.ts). All of them are produced OUTSIDE the long-lived server process by the image
// worker (sharp in a short-lived child), so the server never keeps libvips' memory around.
//
//   library/<docId>/slides/NNN.png            original render (PDFium, long edge 1600) — kept as the source of truth
//   library/<docId>/view/NNN-<w>.webp         display renditions for the browser (lossy WebP, see VIEW_WIDTHS)
//   library/<docId>/thumbs/NNN.webp           small thumbnails (THUMB_WIDTH) for notes/digest lists
//   library/<docId>/inline/<dir>-<name>.jpg   pre-encoded JPEGs sent to LLMs (long edge ≤ INLINE_MAX_EDGE,
//                                             ≤ INLINE_MAX_BYTES), e.g. inline/slides-007.jpg, inline/sheets-sheet-02.jpg
import path from 'node:path';

/** Widths (px) of the lossy WebP display renditions. The client picks one with srcset/sizes. */
export const VIEW_WIDTHS = [1000, 1600] as const;
export type ViewWidth = (typeof VIEW_WIDTHS)[number];
export const VIEW_WEBP_QUALITY = 85;

export const THUMB_WIDTH = 240;
export const THUMB_WEBP_QUALITY = 75;

/** Inline JPEGs for LLM requests (same limits the providers used to apply in-process). */
export const INLINE_MAX_EDGE = 1568;
export const INLINE_MAX_BYTES = 280 * 1024;

export function viewPath(docDir: string, slideFile: string, width: ViewWidth): string {
  return path.join(docDir, 'view', `${stem(slideFile)}-${width}.webp`);
}

export function thumbPath(docDir: string, slideFile: string): string {
  return path.join(docDir, 'thumbs', `${stem(slideFile)}.webp`);
}

/**
 * Pre-encoded inline JPEG for an image under a document directory (a slide or a contact sheet):
 * `<docDir>/<dir>/<name>.png` → `<docDir>/inline/<dir>-<name>.jpg`. Returns null when `pngPath` is not
 * directly inside a sub-directory of a document directory (callers then encode on the fly).
 */
export function inlinePathFor(pngPath: string): string | null {
  const dir = path.dirname(pngPath);
  const docDir = path.dirname(dir);
  const sub = path.basename(dir);
  if (!sub || sub === '.' || sub === 'inline') return null;
  return path.join(docDir, 'inline', `${sub}-${stem(path.basename(pngPath))}.jpg`);
}

function stem(file: string): string {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
