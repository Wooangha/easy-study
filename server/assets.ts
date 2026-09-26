// Derived image files of a document (contract shared by library.ts, the image worker, index.ts and
// providers/proc.ts). All of them are produced OUTSIDE the long-lived server process by the image
// worker (sharp in a short-lived child), so the server never keeps libvips' memory around.
//
//   library/<docId>/slides/NNN.png            original render (PDFium, long edge 1600) — kept as the source of truth
//   library/<docId>/view/NNN-<w>.webp         display renditions for the browser (lossy WebP, see VIEW_WIDTHS)
//   library/<docId>/thumbs/NNN.webp           small thumbnails (THUMB_WIDTH) for notes/digest lists
//   library/<docId>/inline/<dir>-<name>.jpg   pre-encoded JPEGs sent to LLMs (long edge ≤ INLINE_MAX_EDGE,
//                                             ≤ INLINE_MAX_BYTES), e.g. inline/slides-007.jpg, inline/sheets-sheet-02.jpg
//   library/<docId>/attachments/<id>.jpg|png  attachments of questions (DESIGN §21): a selected slide region or an
//                                             image of the student, encoded like the inline JPEGs (a PNG when that is
//                                             smaller), + <id>.json (the Attachment). They are their own inline image.
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
  if (!sub || sub === '.' || sub === 'inline' || sub === ATTACHMENTS_DIR) return null;
  return path.join(docDir, 'inline', `${sub}-${stem(path.basename(pngPath))}.jpg`);
}

// ---------------------------------------------------------------------------
// Attachments (DESIGN §21)
// ---------------------------------------------------------------------------

/** Sub-directory of a document directory that holds the attachments. */
export const ATTACHMENTS_DIR = 'attachments';

/** Ids the server gives attachments: `att-` + 16 hex (a subset of shared ATTACHMENT_ID_RE). */
export const ATTACHMENT_FILE_ID_RE = /^att-[0-9a-f]{16}$/;

/** Extensions of a stored attachment image, in the order they are looked for. */
export const ATTACHMENT_IMAGE_EXTS = ['jpg', 'png'] as const;
export type AttachmentImageExt = (typeof ATTACHMENT_IMAGE_EXTS)[number];

/** Each side of a selected slide region is widened by this fraction of the slide (clamped to the slide). */
export const REGION_PADDING = 0.02;
/** Smallest stored region crop (pixels per side; smaller slides are taken whole). */
export const REGION_MIN_PX = 16;

/**
 * An image that is already encoded for LLM requests (an attachment: ≤ INLINE_MAX_EDGE, ≤ INLINE_MAX_BYTES) and is
 * sent as it is: it has no pre-encoded JPEG of its own, and must never be re-encoded in the server process.
 */
export function isInlineReady(file: string): boolean {
  return path.basename(path.dirname(file)) === ATTACHMENTS_DIR && ATTACHMENT_FILE_ID_RE.test(stem(path.basename(file)));
}

/**
 * Pixel box of a selected region (normalised rect on the slide image, DESIGN §21) in an image of
 * `imageWidth` × `imageHeight`: the rect clamped to the image, widened by REGION_PADDING of the image on each
 * side (clamped again), at least REGION_MIN_PX per side (grown around its centre, kept inside the image).
 */
export function regionCropBox(
  rect: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
): { left: number; top: number; width: number; height: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const axis = (start: number, size: number, extent: number): [number, number] => {
    const from = clamp(start, 0, 1);
    const to = clamp(start + size, from, 1);
    // Outwards to whole pixels, ignoring floating-point dust ((0.1 + 0.02) × 1600 = 192.00000000000003).
    let lo = clamp(Math.floor((from - REGION_PADDING) * extent + 1e-9), 0, extent);
    let hi = clamp(Math.ceil((to + REGION_PADDING) * extent - 1e-9), lo, extent);
    const min = Math.min(REGION_MIN_PX, extent);
    if (hi - lo < min) {
      lo = clamp(Math.round((lo + hi - min) / 2), 0, extent - min);
      hi = lo + min;
    }
    return [lo, hi];
  };
  const [left, right] = axis(rect.x, rect.w, Math.max(1, Math.floor(imageWidth)));
  const [top, bottom] = axis(rect.y, rect.h, Math.max(1, Math.floor(imageHeight)));
  return { left, top, width: right - left, height: bottom - top };
}

function stem(file: string): string {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
