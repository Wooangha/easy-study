// Slide annotations (DESIGN §25), the pure part: the ops reducer the server applies too (applyOps), what a drag
// becomes (a 형광펜 band snapped to a text line, a rectangle, a text box, a memo anchor, a 펜 stroke of §29), an item's
// bounds (for 📎 첨부 and question markers), moving / resizing, the slide's caps, the recording stamp and the replay
// predicate. No DOM, no React. Every geometry is normalised 0..1 to the slide image (RegionRect of §21), rounded to 4
// decimals.
import {
  ANNOTATION_COLORS,
  HIGHLIGHT_BAND_H,
  MAX_ANNOTATION_ITEMS,
  MAX_ANNOTATION_TEXT_CHARS,
  MAX_HIDDEN_MARKERS,
  MAX_INK_STROKES,
  MAX_MEMO_LINKS,
  MAX_MEMO_TAGS,
  MAX_SLIDE_ANNOTATION_BYTES,
  MAX_TAG_CHARS,
  type AnnotationColor,
  type AnnotationItem,
  type AnnotationOp,
  type EllipseItem,
  type HighlightItem,
  type InkItem,
  type MarkerKey,
  type MemoItem,
  type MemoLink,
  type RecordedAt,
  type RectItem,
  type RegionRect,
  type SlideAnnotations,
  type SlideTextLayout,
  type TextHighlightItem,
  type TextItem,
} from '../../../../shared/types.ts';
import { roundRect, type Point } from '../attachments.ts';

/**
 * 'select' is the default state (no tool: a drag on empty area attaches that region; a click selects an item);
 * 'marquee' is the 범위 선택 tool (a drag on empty area selects every item it crosses); 'pen' writes and 'eraser'
 * removes 펜 strokes (DESIGN §29: a stylus or the mouse, a finger only with 손가락으로도 쓰기); the rest draw.
 */
export type AnnotationTool = 'select' | 'marquee' | 'pen' | 'eraser' | 'highlight' | 'textHighlight' | 'rect' | 'ellipse' | 'text' | 'memo';

export const ANNOTATION_TOOLS: readonly AnnotationTool[] = ['select', 'marquee', 'pen', 'eraser', 'highlight', 'textHighlight', 'rect', 'ellipse', 'text', 'memo'];

/** The tools that make an item from a drag / click (not the default state, not 범위 선택, not 펜 / 지우개). */
export type DrawingTool = Exclude<AnnotationTool, 'select' | 'marquee' | 'pen' | 'eraser'>;

/** 펜 and 지우개: a press of a stylus or the mouse writes / erases (over existing items too); a finger scrolls. */
export const isInkTool = (tool: AnnotationTool): tool is 'pen' | 'eraser' => tool === 'pen' || tool === 'eraser';

/** Tools that place something with a click (no drag needed). */
export const CLICK_TOOLS: ReadonlySet<AnnotationTool> = new Set(['text', 'memo']);

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export const roundPoint = (p: Point): Point => ({ x: round4(clamp01(p.x)), y: round4(clamp01(p.y)) });

/**
 * Each side rounded to 4 decimals (not grown like attachments.ts roundRect, which ceils the far edge: a rect moved
 * a hundred times must not grow a hundredth), kept inside the image with a positive size.
 */
export function round4Rect(rect: RegionRect): RegionRect {
  let w = Math.max(1e-4, round4(Math.min(rect.w, 1)));
  let h = Math.max(1e-4, round4(Math.min(rect.h, 1)));
  const x = round4(Math.min(Math.max(0, rect.x), 1 - w));
  const y = round4(Math.min(Math.max(0, rect.y), 1 - h));
  w = round4(Math.min(w, 1 - x));
  h = round4(Math.min(h, 1 - y));
  return { x, y, w, h };
}

/** `n` random bytes as lower-case hex (crypto.getRandomValues; a fallback for tests without WebCrypto). */
function randomHex(n: number, random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): string {
  const bytes = new Uint8Array(n);
  if (random) random(bytes);
  else crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `an-` + 12 hex from 6 random bytes (ANNOTATION_ID_RE), minted here so an optimistic item keeps its id. */
export function newAnnotationId(random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): string {
  return `an-${randomHex(6, random)}`;
}

/** A client id for the SSE / write pairing (ANNOTATION_CLIENT_ID_RE): 16 hex, one per tab. */
export function newClientId(): string {
  return randomHex(8);
}

export const isAnnotationColor = (v: unknown): v is AnnotationColor => (ANNOTATION_COLORS as readonly unknown[]).includes(v);

// ---------------------------------------------------------------------------
// The ops reducer (the same semantics as the server's PATCH)
// ---------------------------------------------------------------------------

/** The fields an `update` may change per type (never id / type / createdAt / recordedAt). */
export const PATCHABLE_FIELDS: Record<AnnotationItem['type'], readonly string[]> = {
  highlight: ['color', 'rect', 'updatedAt'],
  textHighlight: ['color', 'rects', 'chars', 'engine', 'text', 'updatedAt'],
  rect: ['color', 'rect', 'updatedAt'],
  ellipse: ['color', 'rect', 'updatedAt'],
  text: ['color', 'rect', 'text', 'size', 'font', 'bold', 'updatedAt'],
  memo: ['color', 'at', 'text', 'tags', 'collapsed', 'tutor', 'links', 'size', 'updatedAt'],
  // A stroke's points are relative to its rect: moving / resizing it is a new rect, `pts` is never patched.
  ink: ['color', 'rect', 'width', 'updatedAt'],
};

export const sameMarkerKey = (a: MarkerKey, b: MarkerKey): boolean =>
  a.sessionId === b.sessionId && a.messageId === b.messageId && a.attachmentId === b.attachmentId;

export function emptySlideAnnotations(slide: number, updatedAt = new Date(0).toISOString()): SlideAnnotations {
  return { version: 1, slide, rev: 0, updatedAt, items: [], hiddenMarkers: [] };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies ops in order on a copy of `doc`; returns the same object when nothing changed. The rev is not touched
 * (the server's answer or its event carries the new one). An `add` of an existing id and an `update` / `remove` of a
 * missing id change nothing (the server answers 409 / 409 / 200 for those; a rebase after a 409 drops them first,
 * see rebaseOps). A field patched to `null` is removed (an optional field back to its default).
 */
export function applyOps(doc: SlideAnnotations, ops: readonly AnnotationOp[]): SlideAnnotations {
  let items = doc.items;
  let hidden = doc.hiddenMarkers;
  for (const op of ops) {
    switch (op.op) {
      case 'add':
        if (items.some((it) => it.id === op.item.id)) break;
        items = [...items, op.item];
        break;
      case 'update': {
        const i = items.findIndex((it) => it.id === op.id);
        if (i === -1) break;
        const item = items[i];
        const allowed = PATCHABLE_FIELDS[item.type];
        let changed = false;
        const next: Record<string, unknown> = { ...item };
        for (const [key, value] of Object.entries(op.patch as Record<string, unknown>)) {
          if (!allowed.includes(key) || value === undefined) continue;
          if (value === null) {
            if (!(key in next)) continue;
            delete next[key];
            changed = true;
            continue;
          }
          if (shallowEqual((item as unknown as Record<string, unknown>)[key], value)) continue;
          next[key] = value;
          changed = true;
        }
        if (!changed) break;
        items = items.slice();
        items[i] = next as unknown as AnnotationItem;
        break;
      }
      case 'remove': {
        const without = items.filter((it) => it.id !== op.id);
        if (without.length !== items.length) items = without;
        break;
      }
      case 'hideMarker':
        if (!hidden.some((k) => sameMarkerKey(k, op.key))) hidden = [...hidden, op.key];
        break;
      case 'unhideMarker': {
        const without = hidden.filter((k) => !sameMarkerKey(k, op.key));
        if (without.length !== hidden.length) hidden = without;
        break;
      }
    }
  }
  if (items === doc.items && hidden === doc.hiddenMarkers) return doc;
  return { ...doc, items, hiddenMarkers: hidden };
}

/**
 * The ops of a write that a 409 refused, made applicable to the document the server holds now: an `add` whose id
 * exists there and an `update` / `remove` whose id is gone are dropped (the remote side made or deleted it first).
 */
export function rebaseOps(doc: SlideAnnotations, ops: readonly AnnotationOp[]): AnnotationOp[] {
  const ids = new Set(doc.items.map((it) => it.id));
  const out: AnnotationOp[] = [];
  for (const op of ops) {
    if (op.op === 'add') {
      if (ids.has(op.item.id)) continue;
      ids.add(op.item.id);
    } else if (op.op === 'update') {
      if (!ids.has(op.id)) continue;
    } else if (op.op === 'remove') {
      if (!ids.has(op.id)) continue;
      ids.delete(op.id);
    }
    out.push(op);
  }
  return out;
}

/**
 * How many items other than 펜 strokes `doc` holds once `ops` are applied (the MAX_ANNOTATION_ITEMS check before an
 * optimistic add; strokes are counted apart, against MAX_INK_STROKES).
 */
export function itemsAfter(doc: SlideAnnotations, ops: readonly AnnotationOp[]): number {
  const strokes = new Set(doc.items.filter((it) => it.type === 'ink').map((it) => it.id));
  let n = doc.items.length - strokes.size;
  for (const op of ops) {
    if (op.op === 'add') {
      if (op.item.type === 'ink') strokes.add(op.item.id);
      else n++;
    } else if (op.op === 'remove' && !strokes.has(op.id)) {
      n--;
    }
  }
  return n;
}

export const canAddItems = (doc: SlideAnnotations, ops: readonly AnnotationOp[]): boolean =>
  itemsAfter(doc, ops) <= MAX_ANNOTATION_ITEMS;

/** The 펜 strokes of a slide document. */
export const inkStrokes = (doc: SlideAnnotations): number => doc.items.reduce((n, it) => (it.type === 'ink' ? n + 1 : n), 0);

/** The UTF-8 bytes of a slide document as JSON (the server's MAX_SLIDE_ANNOTATION_BYTES cap). */
export const annotationBytes = (doc: SlideAnnotations): number => new TextEncoder().encode(JSON.stringify(doc)).length;

/**
 * Whether a slide document stays within the server's caps that 펜 strokes fill (DESIGN §29): MAX_INK_STROKES strokes
 * and MAX_SLIDE_ANNOTATION_BYTES — checked before an optimistic write, so pending strokes are not lost to a 400.
 */
export const fitsSlide = (doc: SlideAnnotations): boolean => inkStrokes(doc) <= MAX_INK_STROKES && annotationBytes(doc) <= MAX_SLIDE_ANNOTATION_BYTES;

export const canHideMarker = (doc: SlideAnnotations): boolean => doc.hiddenMarkers.length < MAX_HIDDEN_MARKERS;

// ---------------------------------------------------------------------------
// Bounds, moving, resizing
// ---------------------------------------------------------------------------

/** The box a memo's 📎 첨부 crops (and its marker sits on): 12 % × 8 % around the anchor, clamped. */
export const MEMO_BOUNDS = { w: 0.12, h: 0.08 } as const;

/** The union rect of a text highlight's line rects. */
export function unionRects(rects: readonly RegionRect[]): RegionRect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0.0001, h: 0.0001 };
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return round4Rect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/** Where an item is on the image: its rect, the union of its rects, or a small box around a memo's anchor. */
export function itemBounds(item: AnnotationItem): RegionRect {
  switch (item.type) {
    case 'memo':
      return round4Rect({
        x: Math.min(item.at.x, 1 - MEMO_BOUNDS.w),
        y: Math.min(item.at.y, 1 - MEMO_BOUNDS.h),
        w: MEMO_BOUNDS.w,
        h: MEMO_BOUNDS.h,
      });
    case 'textHighlight':
      return unionRects(item.rects);
    default:
      return item.rect;
  }
}

/** A rect moved by (dx, dy) on the image, kept inside it. */
export function moveRect(rect: RegionRect, dx: number, dy: number): RegionRect {
  const x = Math.min(Math.max(0, rect.x + dx), 1 - rect.w);
  const y = Math.min(Math.max(0, rect.y + dy), 1 - rect.h);
  return round4Rect({ x, y, w: rect.w, h: rect.h });
}

/** How far a memo's anchor may go (movePoint): a little inside the image so the card's corner stays visible. */
export const MEMO_ANCHOR_MAX = 0.98;

/** A memo anchor moved by (dx, dy), kept on the image (MEMO_ANCHOR_MAX). */
export function movePoint(at: Point, dx: number, dy: number): Point {
  return roundPoint({ x: Math.min(at.x + dx, MEMO_ANCHOR_MAX), y: Math.min(at.y + dy, MEMO_ANCHOR_MAX) });
}

/** What a move of several items writes: a memo's anchor, or the rect of everything else (a text highlight is never moved). */
export type ItemMove = { rect?: RegionRect; at?: Point };

/**
 * The move of (dx, dy) cut down so that EVERY item stays inside the image — one common delta, so a group keeps its
 * layout and stops as a whole when its first item reaches an edge (items clamped one by one would pile up there,
 * and the pile would be what a release commits). Text highlights (never moved) do not count; a single item gets
 * the same delta `moveRect` / `movePoint` would clamp to.
 */
export function groupDelta(items: readonly AnnotationItem[], dx: number, dy: number): { dx: number; dy: number } {
  let minDx = -Infinity;
  let maxDx = Infinity;
  let minDy = -Infinity;
  let maxDy = Infinity;
  for (const item of items) {
    if (item.type === 'memo') {
      minDx = Math.max(minDx, -item.at.x);
      maxDx = Math.min(maxDx, MEMO_ANCHOR_MAX - item.at.x);
      minDy = Math.max(minDy, -item.at.y);
      maxDy = Math.min(maxDy, MEMO_ANCHOR_MAX - item.at.y);
    } else if (item.type !== 'textHighlight') {
      minDx = Math.max(minDx, -item.rect.x);
      maxDx = Math.min(maxDx, 1 - item.rect.x - item.rect.w);
      minDy = Math.max(minDy, -item.rect.y);
      maxDy = Math.min(maxDy, 1 - item.rect.y - item.rect.h);
    }
  }
  // An item already past an edge (a stored rect wider than the image) leaves no room on that axis: it stays put.
  const clampTo = (v: number, lo: number, hi: number) => (lo > hi ? 0 : round4(Math.min(Math.max(v, lo), hi)));
  return { dx: clampTo(dx, minDx, maxDx), dy: clampTo(dy, minDy, maxDy) };
}

/** The items moved together by (dx, dy) of the image (`groupDelta`: the group stops at an edge as one), by id. */
export function moveItems(items: readonly AnnotationItem[], dx: number, dy: number): Record<string, ItemMove> {
  const d = groupDelta(items, dx, dy);
  const out: Record<string, ItemMove> = {};
  for (const item of items) {
    if (item.type === 'memo') out[item.id] = { at: movePoint(item.at, d.dx, d.dy) };
    else if (item.type !== 'textHighlight') out[item.id] = { rect: moveRect(item.rect, d.dx, d.dy) };
  }
  return out;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const CORNER_HANDLES: readonly Handle[] = ['nw', 'ne', 'sw', 'se'];
export const ALL_HANDLES: readonly Handle[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

/** The handles of a highlight band: its two ends along the direction it runs. */
export function bandHandles(rect: RegionRect): readonly Handle[] {
  return rect.w >= rect.h ? ['w', 'e'] : ['n', 's'];
}

/** The rect after dragging `handle` by (dx, dy); each side stays at least `min` long and inside the image. */
export function resizeRect(rect: RegionRect, handle: Handle, dx: number, dy: number, min = 0.005): RegionRect {
  let x0 = rect.x;
  let y0 = rect.y;
  let x1 = rect.x + rect.w;
  let y1 = rect.y + rect.h;
  if (handle.includes('w')) x0 = Math.min(Math.max(0, x0 + dx), x1 - min);
  if (handle.includes('e')) x1 = Math.max(Math.min(1, x1 + dx), x0 + min);
  if (handle.includes('n')) y0 = Math.min(Math.max(0, y0 + dy), y1 - min);
  if (handle.includes('s')) y1 = Math.max(Math.min(1, y1 + dy), y0 + min);
  return round4Rect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

// ---------------------------------------------------------------------------
// What a drag becomes
// ---------------------------------------------------------------------------

/** The rectangle between two points (any drag direction), each side at least `min` (grown around its center). */
export function rectFromPoints(a: Point, b: Point, min = 0.01): RegionRect {
  const axis = (p: number, q: number): [number, number] => {
    let lo = clamp01(Math.min(p, q));
    let hi = clamp01(Math.max(p, q));
    if (hi - lo < min) {
      const mid = (lo + hi) / 2;
      lo = Math.min(Math.max(0, mid - min / 2), 1 - min);
      hi = lo + min;
    }
    return [lo, hi - lo];
  };
  const [x, w] = axis(a.x, b.x);
  const [y, h] = axis(a.y, b.y);
  return roundRect({ x, y, w, h });
}

/** Default size of a text box placed with a click (of the image). */
export const TEXT_BOX_DEFAULT = { w: 0.18, h: 0.06 } as const;
/** A drag shorter than this (either way) is a click for the text tool. */
export const TEXT_BOX_MIN_DRAG = 0.02;

/** A text box: the dragged rectangle, or the default box at the click. */
export function textBoxFromDrag(a: Point, b: Point): RegionRect {
  if (Math.abs(a.x - b.x) >= TEXT_BOX_MIN_DRAG || Math.abs(a.y - b.y) >= TEXT_BOX_MIN_DRAG) {
    return rectFromPoints(a, b, 0.02);
  }
  return roundRect({
    x: Math.min(Math.max(0, a.x), 1 - TEXT_BOX_DEFAULT.w),
    y: Math.min(Math.max(0, a.y), 1 - TEXT_BOX_DEFAULT.h),
    w: TEXT_BOX_DEFAULT.w,
    h: TEXT_BOX_DEFAULT.h,
  });
}

/** Where a memo placed with a click is anchored. */
export function memoAt(p: Point): Point {
  return roundPoint({ x: Math.min(p.x, 0.98), y: Math.min(p.y, 0.98) });
}

type LayoutLine = SlideTextLayout['lines'][number];

/** Half a line height of slack across a line's direction: a press just under a line still counts as on it. */
const LINE_SLACK = 0.5;
/** The band of a snapped 형광펜 may run this far past the line's ends. */
const LINE_PAD = 0.005;
/** Minimum length of a band along its direction. */
export const MIN_BAND_LENGTH = 0.01;

/** The extent of a box along ('major') and across ('minor') a line direction. */
function axes(r: readonly [number, number, number, number], dir: 'h' | 'v') {
  const [x, y, w, h] = r;
  return dir === 'h' ? { major: [x, x + w] as const, minor: [y, y + h] as const } : { major: [y, y + h] as const, minor: [x, x + w] as const };
}

/**
 * The layout line under `p`: the nearest line whose extent across its direction contains `p` (with half a line of
 * slack) and whose extent along it contains `p` (padded). Null when none.
 */
export function lineAt(layout: SlideTextLayout | null | undefined, p: Point): LayoutLine | null {
  if (!layout) return null;
  let best: LayoutLine | null = null;
  let bestDistance = Infinity;
  for (const line of layout.lines) {
    if (line.words.length === 0) continue;
    const { major, minor } = axes(line.r, line.dir);
    const across = line.dir === 'h' ? p.y : p.x;
    const along = line.dir === 'h' ? p.x : p.y;
    const size = minor[1] - minor[0];
    if (across < minor[0] - size * LINE_SLACK || across > minor[1] + size * LINE_SLACK) continue;
    if (along < major[0] - LINE_PAD || along > major[1] + LINE_PAD) continue;
    const distance = across < minor[0] ? minor[0] - across : across > minor[1] ? across - minor[1] : 0;
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

/** [lo, hi] of a drag along an axis, at least MIN_BAND_LENGTH long, clamped to [min, max]. */
function span(a: number, b: number, min: number, max: number): [number, number] {
  let lo = Math.max(min, Math.min(a, b));
  let hi = Math.min(max, Math.max(a, b));
  if (hi - lo < MIN_BAND_LENGTH) {
    const mid = (lo + hi) / 2;
    lo = Math.max(min, mid - MIN_BAND_LENGTH / 2);
    hi = Math.min(max, lo + MIN_BAND_LENGTH);
    lo = Math.max(min, hi - MIN_BAND_LENGTH);
  }
  return [lo, hi];
}

/**
 * The band of a 형광펜 drag from `from` to `to`: snapped to the text line under `from` when the layout has one (the
 * line's extent across its direction, the drag's extent along it, clamped to the line's range padded 0.5 %), else a
 * horizontal band of HIGHLIGHT_BAND_H centred on `from`.
 */
export function snapBand(from: Point, to: Point, layout: SlideTextLayout | null | undefined): RegionRect {
  const line = lineAt(layout, from);
  if (line) {
    const { major, minor } = axes(line.r, line.dir);
    const [lo, hi] = span(
      line.dir === 'h' ? from.x : from.y,
      line.dir === 'h' ? to.x : to.y,
      Math.max(0, major[0] - LINE_PAD),
      Math.min(1, major[1] + LINE_PAD),
    );
    return line.dir === 'h'
      ? round4Rect({ x: lo, y: minor[0], w: hi - lo, h: minor[1] - minor[0] })
      : round4Rect({ x: minor[0], y: lo, w: minor[1] - minor[0], h: hi - lo });
  }
  const [x0, x1] = span(from.x, to.x, 0, 1);
  const y = Math.min(Math.max(0, from.y - HIGHLIGHT_BAND_H / 2), 1 - HIGHLIGHT_BAND_H);
  return round4Rect({ x: x0, y, w: x1 - x0, h: HIGHLIGHT_BAND_H });
}

export const highlightFromDrag = snapBand;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface ItemSeed {
  id: string;
  color: AnnotationColor;
  createdAt: string;
  recordedAt?: RecordedAt;
}

function base(seed: ItemSeed) {
  return {
    id: seed.id,
    color: seed.color,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
    ...(seed.recordedAt ? { recordedAt: seed.recordedAt } : {}),
  };
}

export const newHighlight = (seed: ItemSeed, rect: RegionRect): HighlightItem => ({ ...base(seed), type: 'highlight', rect });

export const newShape = (seed: ItemSeed, type: 'rect' | 'ellipse', rect: RegionRect): RectItem | EllipseItem =>
  type === 'rect' ? { ...base(seed), type: 'rect', rect } : { ...base(seed), type: 'ellipse', rect };

export const newTextBox = (seed: ItemSeed, rect: RegionRect, text = ''): TextItem => ({ ...base(seed), type: 'text', rect, text });

/** A 펜 stroke (one piece of shared/ink.ts inkPieces: its rect and encoded points) of nominal `width`. */
export const newInk = (seed: ItemSeed, piece: { rect: RegionRect; pts: string }, width: number): InkItem => ({
  ...base(seed),
  type: 'ink',
  rect: piece.rect,
  width,
  pts: piece.pts,
});

export const newTextHighlight = (
  seed: ItemSeed,
  fit: { rects: RegionRect[]; chars: [number, number]; text: string; engine: string },
): TextHighlightItem => ({
  ...base(seed),
  type: 'textHighlight',
  rects: fit.rects,
  chars: fit.chars,
  engine: fit.engine,
  text: fit.text.slice(0, MAX_ANNOTATION_TEXT_CHARS),
});

/** A memo made during a live recording also links to that moment (its 🎙 chip exists without replay). */
export const newMemo = (seed: ItemSeed, at: Point): MemoItem => ({
  ...base(seed),
  type: 'memo',
  at,
  text: '',
  tags: [],
  collapsed: false,
  tutor: true,
  links: seed.recordedAt ? [{ kind: 'recording', rid: seed.recordedAt.rid, t: seed.recordedAt.t }] : [],
});

// ---------------------------------------------------------------------------
// Tags and links
// ---------------------------------------------------------------------------

/** Control and bidi characters (the server's normalizeTag drops the same). */
// eslint-disable-next-line no-control-regex
const TAG_CONTROLS_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** A tag as the server keeps it: no control characters, trimmed, inner whitespace squeezed, no leading '#', ≤ MAX_TAG_CHARS; null when empty. */
export function normalizeTag(raw: string): string | null {
  const tag = raw.replace(TAG_CONTROLS_RE, '').replace(/^\s*#+/, '').trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_CHARS).trim();
  return tag === '' ? null : tag;
}

/** Unique (case-sensitive), normalised, at most MAX_MEMO_TAGS. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_MEMO_TAGS) break;
  }
  return out;
}

export const sameLink = (a: MemoLink, b: MemoLink): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'slide' && b.kind === 'slide') return a.slide === b.slide;
  if (a.kind === 'doc' && b.kind === 'doc') return a.docId === b.docId && (a.slide ?? null) === (b.slide ?? null);
  if (a.kind === 'recording' && b.kind === 'recording') return a.rid === b.rid && a.t === b.t;
  return false;
};

/** `links` with `link` added (unless it is there already), at most MAX_MEMO_LINKS; null when it does not fit. */
export function withLink(links: readonly MemoLink[], link: MemoLink): MemoLink[] | null {
  if (links.some((l) => sameLink(l, link))) return [...links];
  if (links.length >= MAX_MEMO_LINKS) return null;
  return [...links, link];
}

/**
 * Tag suggestions for what is being typed: the lecture's and the library's tags (most used first) that start with
 * the prefix, then those containing it; tags already on the memo are left out.
 */
export function suggestTags(
  typed: string,
  candidates: ReadonlyArray<{ tag: string; count: number }>,
  taken: readonly string[],
  limit = 8,
): string[] {
  const prefix = normalizeTag(typed)?.toLowerCase() ?? '';
  const seen = new Set(taken);
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (seen.has(c.tag)) continue;
    counts.set(c.tag, (counts.get(c.tag) ?? 0) + c.count);
  }
  const rank = (tag: string) => {
    const lower = tag.toLowerCase();
    return prefix === '' ? 0 : lower.startsWith(prefix) ? 0 : lower.includes(prefix) ? 1 : 2;
  };
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count, rank: rank(tag) }))
    .filter((c) => c.rank < 2)
    .sort((a, b) => a.rank - b.rank || b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit)
    .map((c) => c.tag);
}

// ---------------------------------------------------------------------------
// The recording clock: stamping at creation, replaying
// ---------------------------------------------------------------------------

export interface RecorderLike {
  phase: string;
  docId: string | null;
  recordingId: string | null;
}

/**
 * The `recordedAt` of an item made now: while a live recording of `docId` runs (or is paused) on this device, its
 * recording and clock (seconds, 3 decimals); otherwise none (another device's recording is stamped by the server).
 */
export function recordedAtFor(snapshot: RecorderLike, clock: number, docId: string): RecordedAt | undefined {
  if (snapshot.docId !== docId || !snapshot.recordingId) return undefined;
  if (snapshot.phase !== 'recording' && snapshot.phase !== 'paused') return undefined;
  if (!Number.isFinite(clock) || clock < 0) return undefined;
  return { rid: snapshot.recordingId, t: Math.round(clock * 1000) / 1000 };
}

/** How far ahead of the playhead an item may have been made and still show (the stamp is a little coarse). */
export const REPLAY_SLACK_S = 0.5;

/** While replaying `replay` (그때 필기 재생) an item shows only once its recording moment has been reached. */
export function replayVisible(item: Pick<AnnotationItem, 'recordedAt'>, replay: { rid: string; t: number } | null): boolean {
  if (!replay) return true;
  return item.recordedAt !== undefined && item.recordedAt.rid === replay.rid && item.recordedAt.t <= replay.t + REPLAY_SLACK_S;
}

/** The first line of a memo for its collapsed pill / the memo list. */
export function memoPreview(text: string, max = 24): string {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? '';
  if (line === '') return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Text capped as the server caps it. */
export const capText = (text: string): string => (text.length > MAX_ANNOTATION_TEXT_CHARS ? text.slice(0, MAX_ANNOTATION_TEXT_CHARS) : text);
