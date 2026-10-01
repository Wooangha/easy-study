// Attachments of a question (DESIGN §21): a region selected on a slide, or an image pasted / dropped / picked.
// Pure helpers (no DOM, no React) so they can be tested with node:test: selection geometry, file
// classification, labels, and the reducer of the composer's chips.
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type Attachment,
  type RegionRect,
} from '../../../shared/types.ts';
import { msg } from '../i18n/index.ts';

// ---------------------------------------------------------------------------
// Selection geometry
// ---------------------------------------------------------------------------

/** A mouse press becomes a selection once the pointer moved this far (a plain click keeps its meaning). */
export const DRAG_THRESHOLD_PX = 6;
/** Touch: holding still this long starts a selection (moving before that scrolls as usual). */
export const LONG_PRESS_MS = 350;
/** Touch: moving farther than this before the long press fires is a scroll, not a selection. */
export const LONG_PRESS_SLOP_PX = 8;
/** A finished selection is at least this big on screen (a drag along one line of text still gets that line). */
export const MIN_REGION_PX = 12;
/** A release smaller than this in both directions (e.g. a long press without dragging) selects nothing. */
export const MIN_DRAG_PX = 5;

export interface Point {
  x: number;
  y: number;
}

/** Client-space box (a DOMRect). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the slide image is drawn inside its box, as fractions of the box (0..1). */
export type Frame = RegionRect;

export const FULL_FRAME: Frame = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Where an image of aspect `imageAspect` is drawn inside a box of aspect `boxAspect` with `object-fit: contain`
 * (every slide box has the aspect of page 1; a page of another shape is letterboxed). Fractions of the box, so
 * the same at every zoom level and for every rendition (WebP 1000/1600, the PNG fallback). Unknown → the box.
 */
export function imageFrame(boxAspect: number, imageAspect: number | null | undefined): Frame {
  if (!imageAspect || !boxAspect || !Number.isFinite(imageAspect) || !Number.isFinite(boxAspect)) return FULL_FRAME;
  const ratio = imageAspect / boxAspect;
  if (Math.abs(ratio - 1) < 0.005) return FULL_FRAME;
  if (ratio > 1) {
    const h = 1 / ratio; // wider than the box: full width, bands above and below
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  return { x: (1 - ratio) / 2, y: 0, w: ratio, h: 1 };
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A pointer position (client px) → a point on the slide image (0..1 each way, clamped to the image). */
export function toImagePoint(clientX: number, clientY: number, box: Box, frame: Frame = FULL_FRAME): Point {
  const fw = box.width * frame.w;
  const fh = box.height * frame.h;
  if (!(fw > 0) || !(fh > 0)) return { x: 0, y: 0 };
  return {
    x: clamp01((clientX - (box.left + frame.x * box.width)) / fw),
    y: clamp01((clientY - (box.top + frame.y * box.height)) / fh),
  };
}

/** On-screen size (px) of the image drawn in `box`. */
export function framePixels(box: Box, frame: Frame = FULL_FRAME): { width: number; height: number } {
  return { width: box.width * frame.w, height: box.height * frame.h };
}

export function movedBeyond(a: Point, b: Point, threshold: number): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) >= threshold;
}

const PRECISION = 1e4;

/** Rounded to 4 decimals without leaving the image: 0 ≤ x, 0 < w, x + w ≤ 1 (same for y, h). */
export function roundRect(rect: RegionRect): RegionRect {
  const axis = (start: number, size: number): [number, number] => {
    let a = Math.floor(clamp01(start) * PRECISION) / PRECISION;
    let b = Math.ceil(clamp01(start + size) * PRECISION) / PRECISION;
    if (b <= a) {
      if (a >= 1) a = 1 - 1 / PRECISION;
      b = a + 1 / PRECISION;
    }
    let len = Math.round((b - a) * PRECISION) / PRECISION;
    // Floating point: 0.7 + 0.3000000001 must not end up above 1.
    while (a + len > 1) len = Math.round((len - 1 / PRECISION) * PRECISION) / PRECISION;
    return [a, Math.max(1 / PRECISION, len)];
  };
  const [x, w] = axis(rect.x, rect.w);
  const [y, h] = axis(rect.y, rect.h);
  return { x, y, w, h };
}

/**
 * The rectangle between two points of the image (normalised, any drag direction). With `minPx`, each side is
 * grown around its center to at least that many screen pixels (`size` = the image's on-screen size), staying
 * inside the image. Rounded (roundRect).
 */
export function regionFromPoints(
  a: Point,
  b: Point,
  size: { width: number; height: number },
  minPx = 0,
): RegionRect {
  const grow = (lo: number, hi: number, px: number): [number, number] => {
    lo = clamp01(lo);
    hi = clamp01(hi);
    const min = px > 0 && minPx > 0 ? Math.min(1, minPx / px) : 0;
    if (hi - lo >= min) return [lo, hi - lo];
    let start = (lo + hi) / 2 - min / 2;
    start = Math.min(Math.max(0, start), 1 - min);
    return [start, min];
  };
  const [x, w] = grow(Math.min(a.x, b.x), Math.max(a.x, b.x), size.width);
  const [y, h] = grow(Math.min(a.y, b.y), Math.max(a.y, b.y), size.height);
  return roundRect({ x, y, w, h });
}

/** A rectangle inside a frame → fractions of the whole box (where to draw it in the slide box). */
export function rectInBox(rect: RegionRect, frame: Frame = FULL_FRAME): RegionRect {
  return { x: frame.x + rect.x * frame.w, y: frame.y + rect.y * frame.h, w: rect.w * frame.w, h: rect.h * frame.h };
}

export function percentStyle(rect: RegionRect): { left: string; top: string; width: string; height: string } {
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) };
}

export type MenuPlacement = 'below' | 'above' | 'inside';

/** A vertical extent in client px. */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * Where the floating menu of a selection goes: under it when the visible part of the viewer has room there, else
 * over it, else inside its bottom edge (covering the selection only when nothing else is possible). The menu may
 * hang over the slide's edge into the gap or the next slide: at a small zoom a selection filling the slide still
 * gets its menu outside.
 */
export function menuPlacement(selection: Span, visible: Span, menuHeightPx = 40): MenuPlacement {
  const need = menuHeightPx + 8;
  if (visible.bottom - selection.bottom >= need) return 'below';
  if (selection.top - visible.top >= need) return 'above';
  return 'inside';
}

// ---------------------------------------------------------------------------
// Files: what a drop / paste / pick contains
// ---------------------------------------------------------------------------

export interface FileLike {
  name: string;
  type: string;
}

/**
 * The images the server takes (its magic-byte check: PNG, JPEG, WebP, GIF; HEIC/HEIF/AVIF when it can decode
 * them), by extension. Anything else (BMP, TIFF, SVG, ...) is refused here, before an upload that would only be
 * refused there.
 */
const IMAGE_TYPES_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
};

const SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([...Object.values(IMAGE_TYPES_BY_EXT), 'image/pjpeg', 'image/heic-sequence', 'image/heif-sequence']);

/** Formats named in refusals. */
export const SUPPORTED_IMAGE_FORMATS = 'PNG, JPEG, WebP, GIF';

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

export function isPdfLike(file: FileLike): boolean {
  return file.type === 'application/pdf' || extension(file.name) === 'pdf';
}

const isSupportedImageType = (type: string) => SUPPORTED_IMAGE_TYPES.has(type.toLowerCase());

/** An image the server can take (see IMAGE_TYPES_BY_EXT): by its MIME type, or its extension when it has none. */
export function isImageLike(file: FileLike): boolean {
  if (file.type.startsWith('image/')) return isSupportedImageType(file.type);
  return file.type === '' || file.type === 'application/octet-stream' ? extension(file.name) in IMAGE_TYPES_BY_EXT : false;
}

/** Content-Type to upload an image with (the browser leaves `type` empty for some formats, e.g. HEIC). */
export function imageContentType(file: FileLike): string {
  if (file.type.startsWith('image/')) return file.type;
  return IMAGE_TYPES_BY_EXT[extension(file.name)] ?? 'application/octet-stream';
}

/** Split dropped / picked files: PDFs become documents, images become attachments, the rest is refused. */
export function classifyFiles<T extends FileLike>(files: readonly T[]): { pdfs: T[]; images: T[]; others: T[] } {
  const out = { pdfs: [] as T[], images: [] as T[], others: [] as T[] };
  for (const f of files) {
    if (isPdfLike(f)) out.pdfs.push(f);
    else if (isImageLike(f)) out.images.push(f);
    else out.others.push(f);
  }
  return out;
}

export interface DragKinds {
  pdf: boolean;
  image: boolean;
  /** Some items have no MIME type during the drag (the browser tells only on drop). */
  unknown: boolean;
}

/** What a drag carries, from the MIME types of its file items (names are only known on drop). */
export function classifyDragTypes(itemTypes: readonly string[]): DragKinds {
  const kinds: DragKinds = { pdf: false, image: false, unknown: false };
  for (const t of itemTypes) {
    if (t === 'application/pdf') kinds.pdf = true;
    else if (isSupportedImageType(t)) kinds.image = true;
    else kinds.unknown = true; // no type yet, or one that will be refused on drop (BMP, TIFF, SVG, ...)
  }
  return kinds;
}

/** An image dropped where no lecture is open (the library): the overlay says it (with the image icon), and so does the toast. */
const imageNeedsLecture = (): string => msg().chat.attachments.imageNeedsLecture;

export interface DropPlan<T> {
  /** PDFs to upload as new lectures. */
  pdfs: T[];
  /** Images to attach to the next question of the open lecture. */
  images: T[];
  /** What to tell the student about the rest (and about images with no lecture open). */
  notices: { message: string; kind: 'info' | 'error' }[];
}

/**
 * What a drop does, wherever it lands (the window, the library's drop zone, a course card): PDFs become lectures;
 * images are attached to the next question while a lecture is open (`attachOpen`), and explained otherwise; other
 * files are refused with the formats that are taken.
 */
export function planDrop<T extends FileLike>(files: readonly T[], attachOpen: boolean): DropPlan<T> {
  const { pdfs, images, others } = classifyFiles(files);
  const notices: DropPlan<T>['notices'] = [];
  if (images.length > 0 && !attachOpen) notices.push({ message: imageNeedsLecture(), kind: 'info' });
  if (others.length > 0) {
    const m = msg().chat.attachments;
    const names = others.map((f) => f.name).join(', ');
    notices.push({ message: attachOpen ? m.dropRefused(SUPPORTED_IMAGE_FORMATS, names) : m.pdfOnly(names), kind: 'error' });
  }
  return { pdfs, images: attachOpen ? images : [], notices };
}

/** What the drop overlay shows. The text has no emoji: `titleIcon` / `subIcon` = that line starts with the image icon. */
export interface DropOverlayCopy<P> {
  title: P | string;
  titleIcon: 'image' | null;
  sub: string | null;
  subIcon: 'image' | null;
}

/**
 * Copy of the window-wide drop overlay. `pdfTarget` is the caller's line about PDFs (text, or a node with its own
 * icons). `attachOpen` = a lecture is open, so images can be attached to a question.
 */
export function dropOverlayCopy<P = string>(kinds: DragKinds, pdfTarget: P, attachOpen: boolean): DropOverlayCopy<P> {
  const m = msg().chat.attachments;
  if (kinds.image && !kinds.pdf && !kinds.unknown) {
    return { title: attachOpen ? m.dropImage : m.imageNeedsLecture, titleIcon: 'image', sub: null, subIcon: null };
  }
  // PDFs and images together: the images go with this lecture's question, so the new lecture is not opened.
  if (kinds.image && attachOpen) {
    return { title: pdfTarget, titleIcon: null, sub: m.dropImageWithPdf, subIcon: 'image' };
  }
  return { title: pdfTarget, titleIcon: null, sub: attachOpen && kinds.unknown ? m.dropMaybeImage : null, subIcon: null };
}

/** Names browsers give a pasted screenshot: not worth showing. */
export function isGenericPastedName(name: string): boolean {
  return name === '' || /^image\.(png|jpe?g|gif|webp|tiff?|bmp|heic)$/i.test(name);
}

/**
 * The images a paste should attach. A paste that carries text (e.g. from a slide program, which also puts a
 * picture of the text on the clipboard) stays a text paste.
 */
export function clipboardImages<T extends FileLike>(text: string, files: readonly T[]): T[] {
  if (text.trim() !== '') return [];
  return files.filter(isImageLike);
}

// ---------------------------------------------------------------------------
// Labels and messages
// ---------------------------------------------------------------------------

type Labelled = Pick<Attachment, 'kind' | 'slide' | 'name' | 'annotation' | 'removedFrom'>;

/**
 * "p.12 영역" / "p.12 메모" (a region made from a 필기, Attachment.annotation, DESIGN §25) / the file name / "이미지".
 * The kinds are named by chat.attachments.kinds (and kindTitles in attachmentTitle). A region whose slide a new
 * version dropped (Attachment.removedFrom, DESIGN §28) says where it was: "p.12 영역 (빠진 장 p.15)".
 */
export function attachmentLabel(a: Labelled): string {
  const m = msg().chat.attachments;
  if (a.kind === 'region') {
    const what = a.annotation ? m.kinds[a.annotation.type] : m.region;
    if (a.slide && a.removedFrom) return m.onRemovedPage(a.slide, what, a.removedFrom.slide);
    return a.slide ? m.onPage(a.slide, what) : a.annotation ? what : m.selectedRegion;
  }
  return a.name?.trim() || m.image;
}

/** Longer description (tooltips, alt text). */
export function attachmentTitle(a: Labelled): string {
  const m = msg().chat.attachments;
  if (a.kind === 'region') {
    const where = a.slide ? m.onSlide(a.slide) : m.someSlide;
    return a.annotation ? m.kindTitles[a.annotation.type](where) : m.regionTitle(where);
  }
  return a.name?.trim() ? m.imageTitleNamed(a.name.trim()) : m.imageTitle;
}

/** The question sent when only attachments were given (Enter on an empty composer). */
export function defaultQuestion(attachments: ReadonlyArray<Pick<Attachment, 'kind'>>): string {
  const m = msg().chat.attachments;
  return attachments.length > 0 && attachments.every((a) => a.kind === 'region') ? m.explainRegion : m.explainImage;
}

/** The question sent by the region menu's "이 부분 설명해줘" (a function: it is in the page's language). */
export const explainRegionPrompt = (): string => msg().chat.attachments.explainRegion;

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const MAX_ATTACHMENT_MB = Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024);

export const limitMessage = (refused: number) => msg().chat.attachments.limit(MAX_ATTACHMENTS, refused);

/**
 * A message the server wrote (in any language), not a fallback: "첨부 실패 (HTTP 413)" (api.ts), "HTTP 413 Payload Too
 * Large", a proxy's status text ("Request Entity Too Large") or its HTML error page.
 */
function fromServer(message: string): boolean {
  const text = message.trim();
  if (text === '' || text.startsWith('<') || /\(HTTP \d{3}\)$/.test(text) || /^HTTP \d{3}\b/.test(text)) return false;
  return /[가-힣]/.test(text) || !/^(\d{3}\s+)?(payload|request entity|content) too large\.?$/i.test(text);
}

/** Readable reason an upload / region was refused, from the HTTP status and the server's message. */
export function attachErrorMessage(status: number, serverMessage: string): string {
  const m = msg().chat.attachments;
  switch (status) {
    case 0:
      return serverMessage || msg().common.api.cannotConnect;
    case 413:
      // The server says why (the file's size, or its resolution); a proxy's own 413 page does not.
      return fromServer(serverMessage) ? serverMessage : m.tooLarge(MAX_ATTACHMENT_MB);
    case 415:
      return serverMessage || m.unsupported(SUPPORTED_IMAGE_FORMATS);
    case 409:
      return serverMessage || m.docNotReady;
    case 404:
      return serverMessage || m.docNotFound;
    default:
      return serverMessage || `HTTP ${status}`;
  }
}

// ---------------------------------------------------------------------------
// Composer chips
// ---------------------------------------------------------------------------

export interface Chip {
  /** Client-side key (the attachment id is only known once the server made it). */
  key: string;
  kind: 'region' | 'image';
  label: string;
  title: string;
  slide?: number;
  rect?: RegionRect;
  status: 'uploading' | 'ready';
  /** 0..1 while uploading an image (a region has no progress). */
  progress: number;
  /** Object URL of the picked / pasted file, shown until the server's copy exists. */
  localUrl?: string;
  attachment?: Attachment;
}

export interface ChipState {
  /** Document the chips belong to (attachment ids are per document). */
  docId: string | null;
  items: Chip[];
}

export type ChipAction =
  | { type: 'reset'; docId: string | null }
  | { type: 'add'; item: Chip }
  | { type: 'progress'; key: string; fraction: number }
  | { type: 'ready'; key: string; attachment: Attachment }
  | { type: 'remove'; keys: readonly string[] }
  /** Put back the chips of a question that was not accepted (before the ones added meanwhile). */
  | { type: 'restore'; docId: string | null; items: readonly Chip[] };

export function chipsReducer(state: ChipState, action: ChipAction): ChipState {
  switch (action.type) {
    case 'reset':
      return state.docId === action.docId && state.items.length === 0 ? state : { docId: action.docId, items: [] };
    case 'add':
      if (state.items.length >= MAX_ATTACHMENTS || state.items.some((c) => c.key === action.item.key)) return state;
      return { ...state, items: [...state.items, action.item] };
    case 'progress': {
      const fraction = clamp01(action.fraction);
      const i = state.items.findIndex((c) => c.key === action.key);
      if (i === -1 || state.items[i].status !== 'uploading' || state.items[i].progress === fraction) return state;
      const items = state.items.slice();
      items[i] = { ...items[i], progress: fraction };
      return { ...state, items };
    }
    case 'ready': {
      const i = state.items.findIndex((c) => c.key === action.key);
      if (i === -1) return state;
      const a = action.attachment;
      const items = state.items.slice();
      items[i] = {
        ...items[i],
        status: 'ready',
        progress: 1,
        localUrl: undefined,
        attachment: a,
        label: attachmentLabel(a.kind === 'image' && !a.name ? { ...a, name: items[i].label } : a),
        title: attachmentTitle(a),
        slide: a.slide ?? items[i].slide,
        rect: a.rect ?? items[i].rect,
      };
      return { ...state, items };
    }
    case 'remove': {
      const items = state.items.filter((c) => !action.keys.includes(c.key));
      return items.length === state.items.length ? state : { ...state, items };
    }
    case 'restore': {
      if (action.docId !== state.docId) return state;
      const back = action.items.filter((c) => !state.items.some((x) => x.key === c.key));
      if (back.length === 0) return state;
      return { ...state, items: [...back, ...state.items].slice(0, MAX_ATTACHMENTS) };
    }
  }
}

export const freeSlots = (items: readonly Chip[]) => Math.max(0, MAX_ATTACHMENTS - items.length);

/** Whether a chip is the 📎 첨부 of this annotation item (its region carries the item, or the chip's key does while it uploads). */
export const chipOfItem = (chip: Chip, itemId: string): boolean => chip.attachment?.annotation?.id === itemId || chip.key.endsWith(`:${itemId}`);

/**
 * 📎 첨부 of several selected items at once (DESIGN §25, a group selection): the items to attach — those not in
 * the composer already, as many as there are free slots —, how many were refused for lack of room and how many
 * were skipped as attached already; one toast for each count, not one per item.
 */
export function annotationAttachPlan<T extends { id: string }>(chips: readonly Chip[], items: readonly T[]): { take: T[]; refused: number; attached: number } {
  const fresh = items.filter((item) => !chips.some((c) => chipOfItem(c, item.id)));
  const take = fresh.slice(0, freeSlots(chips));
  return { take, refused: fresh.length - take.length, attached: items.length - fresh.length };
}

export const isUploading = (items: readonly Chip[]) => items.some((c) => c.status === 'uploading');

/** The chips of a question that was not accepted, without those whose attachment the server no longer has. */
export function withoutAttachments(chips: readonly Chip[], ids: readonly string[]): Chip[] {
  if (ids.length === 0) return [...chips];
  return chips.filter((c) => !(c.attachment && ids.includes(c.attachment.id)));
}

/** Why a question was not sent when some of its attachments are gone from the server (swept, deleted). */
export function missingAttachmentsMessage(attachments: ReadonlyArray<Labelled & Pick<Attachment, 'id'>>, missing: readonly string[]): string {
  const m = msg().chat.attachments;
  const labels = attachments.filter((a) => missing.includes(a.id)).map(attachmentLabel);
  return labels.length > 0 ? m.missing(labels.join(', ')) : m.missingCount(missing.length);
}

export function readyAttachments(items: readonly Chip[]): Attachment[] {
  const out: Attachment[] = [];
  for (const c of items) if (c.status === 'ready' && c.attachment) out.push(c.attachment);
  return out;
}
