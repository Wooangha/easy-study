// What a press on a slide does (DESIGN §25), the pure part: hit-testing the slide's items under the pointer (the
// smallest wins, so a small highlight inside a big rectangle stays reachable; a few pixels of slack for thin bands
// and outlines; an unselected outline shape counts on its ring only in EVERY state, so its inside passes through to
// what is under it; a 펜 stroke near its centre line only), the items a marquee crosses, the strokes an eraser move
// touches (DESIGN §29), and the plan of a press — resize a handle, select / move the item under it with ANY tool
// active (Shift: add it to / take it out of the selection), re-drag a text highlight with its own tool, draw with the
// active tool on empty area, drag a marquee with 범위 선택, write or erase under 펜 / 지우개 (by the kind of pointer:
// a finger scrolls), or (no tool: the default 선택·첨부 state) start the region gesture; and which pointer / touch
// events of 펜 / 지우개 start, block or keep a stroke. No DOM (the viewer measures memo cards for the marquee and passes
// their boxes in).
import { inkDistance, inkMaxRadius, inkPointsOf, inkTouches } from '../../../../shared/ink.ts';
import type { AnnotationItem, RegionRect, TextHighlightItem } from '../../../../shared/types.ts';
import type { Point } from '../attachments.ts';
import { CLICK_TOOLS, isInkTool, itemBounds, type AnnotationTool, type DrawingTool, type Handle } from './geometry.ts';

/** A press this close to an item (in pixels of the rendered slide) counts as on it: thin bands and 3 px outlines. */
export const HIT_SLOP_PX = 4;
/** A finger is less precise. */
export const TOUCH_HIT_SLOP_PX = 10;
/** The (non-scaling) stroke of a rect / ellipse outline, `.annot-shape.kind-rect` in styles.css. */
export const SHAPE_STROKE_PX = 3;

/** The slack around an item, as fractions of the image (a slide is not square, so one value per axis). */
export interface Slop {
  x: number;
  y: number;
  /** Half the width of an outline's ring: the slack plus half the stroke, either side of the shape's edge. */
  ring: { x: number; y: number };
  /** The slack in px, and the rendered image in px: a 펜 stroke is hit by its distance in px (inkDistance). */
  px: number;
  box: { w: number; h: number };
}

export const slopFor = (size: { width: number; height: number }, touch: boolean): Slop => {
  const px = touch ? TOUCH_HIT_SLOP_PX : HIT_SLOP_PX;
  const ring = px + SHAPE_STROKE_PX / 2;
  const frac = (v: number, extent: number) => (extent > 0 ? v / extent : 0);
  return {
    x: frac(px, size.width),
    y: frac(px, size.height),
    ring: { x: frac(ring, size.width), y: frac(ring, size.height) },
    px,
    box: { w: size.width, h: size.height },
  };
};

type Pad = { x: number; y: number };

const inRect = (r: RegionRect, p: Point, s: Pad): boolean =>
  p.x >= r.x - s.x && p.x <= r.x + r.w + s.x && p.y >= r.y - s.y && p.y <= r.y + r.h + s.y;

const inEllipse = (r: RegionRect, p: Point, s: Pad): boolean => {
  const rx = r.w / 2 + s.x;
  const ry = r.h / 2 + s.y;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (p.x - (r.x + r.w / 2)) / rx;
  const dy = (p.y - (r.y + r.h / 2)) / ry;
  return dx * dx + dy * dy <= 1;
};

/** On the ring around the edge (inside the padded shape but not inside the shrunk one; a shape thinner than the ring is all ring). */
const onRing = (inside: (r: RegionRect, p: Point, s: Pad) => boolean, r: RegionRect, p: Point, ring: Pad): boolean =>
  inside(r, p, ring) && !inside(r, p, { x: -ring.x, y: -ring.y });

/**
 * Whether `p` is on the item (memos are HTML cards with their own pointer handling and are never hit here). With
 * `outline` a rect / ellipse counts on its ring only — the inside of a box drawn around a paragraph is empty slide
 * for the tool in hand (see `outlineOnly`). A 펜 stroke counts near its centre line only (the slack plus its widest
 * half width, in px of the rendered image), never in its bounding box: handwriting does not block what is under it.
 */
export function itemHit(item: AnnotationItem, p: Point, slop: Slop, outline = false): boolean {
  switch (item.type) {
    case 'memo':
      return false;
    case 'ink':
      // The rect is padded by the widest half width already: a cheap first test before the points are measured.
      return (
        inRect(item.rect, p, slop) &&
        inkDistance(inkPointsOf(item), p.x, p.y, slop.box.w, slop.box.h) <= slop.px + inkMaxRadius(item.width, slop.box.h)
      );
    case 'textHighlight':
      return item.rects.some((r) => inRect(r, p, slop));
    case 'ellipse':
      return outline ? onRing(inEllipse, item.rect, p, slop.ring) : inEllipse(item.rect, p, slop);
    case 'rect':
      return outline ? onRing(inRect, item.rect, p, slop.ring) : inRect(item.rect, p, slop);
    default:
      return inRect(item.rect, p, slop);
  }
}

/** How much of the image an item covers (the ranking of overlapping hits; a 펜 stroke covers almost nothing). */
export function itemArea(item: AnnotationItem): number {
  switch (item.type) {
    case 'memo':
    case 'ink':
      return 0;
    case 'textHighlight':
      return item.rects.reduce((sum, r) => sum + r.w * r.h, 0);
    case 'ellipse':
      return (Math.PI / 4) * item.rect.w * item.rect.h;
    default:
      return item.rect.w * item.rect.h;
  }
}

/**
 * The rule of outline shapes (0.6.2: in every state, not only under a drawing tool): an unselected rect / ellipse is
 * hit on its outline ring only — its transparent inside is empty slide, so a 형광펜 stroke, a 텍스트 상자 / 메모 click,
 * another shape, a text-highlight word or the region drag of the default state all go through a box drawn around a
 * paragraph. Selected, its inside counts (it is moved by its body).
 */
export const outlineOnly =
  (selectedIds: readonly string[] | null) =>
  (item: AnnotationItem): boolean =>
    !selectedIds?.includes(item.id);

export interface HitOptions {
  /** Leaves out what is not drawn right now (그때 필기 재생). */
  visible?: (item: AnnotationItem) => boolean;
  /** Hit-tests a rect / ellipse on its ring only (`outlineOnly`). */
  outline?: (item: AnnotationItem) => boolean;
}

/**
 * The item under `p`: of every item hit, the one covering the least of the image, and among equals the topmost
 * (later in z-order). Null when nothing is there.
 */
export function hitTestItems(items: readonly AnnotationItem[], p: Point, slop: Slop, { visible, outline }: HitOptions = {}): AnnotationItem | null {
  let best: AnnotationItem | null = null;
  let bestArea = Infinity;
  for (const item of items) {
    if (visible && !visible(item)) continue;
    if (!itemHit(item, p, slop, outline?.(item) ?? false)) continue;
    const area = itemArea(item);
    if (area <= bestArea) {
      best = item;
      bestArea = area;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Marquee (범위 선택): the items a dragged rectangle crosses
// ---------------------------------------------------------------------------

/** Whether two rects overlap (touching edges do not count). */
export const rectsIntersect = (a: RegionRect, b: RegionRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Whether the marquee `rect` crosses the item: a text highlight by any of its line rects, a memo by its card as
 * drawn (`box`, measured by the viewer — the card is clamped inside the slide by CSS and is much bigger than the
 * anchor box; without a measurement the 12 % × 8 % box around its anchor, itemBounds), the rest by their rect (an
 * ellipse by its bounding box — close enough for a drag).
 */
export function itemIntersects(item: AnnotationItem, rect: RegionRect, box?: RegionRect | null): boolean {
  if (item.type === 'textHighlight') return item.rects.some((r) => rectsIntersect(r, rect));
  return rectsIntersect(box ?? itemBounds(item), rect);
}

export interface MarqueeOptions {
  /** Leaves out what is not drawn right now (그때 필기 재생). */
  visible?: (item: AnnotationItem) => boolean;
  /** The box an item is drawn at when it differs from its geometry: a memo card as laid out (the viewer measures it). */
  boxOf?: (item: AnnotationItem) => RegionRect | null | undefined;
}

/** The ids of the items a marquee crosses, in z-order (items not drawn right now are skipped). */
export function marqueeSelect(items: readonly AnnotationItem[], rect: RegionRect, { visible, boxOf }: MarqueeOptions = {}): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (visible && !visible(item)) continue;
    if (itemIntersects(item, rect, boxOf?.(item))) out.push(item.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 지우개 (DESIGN §29): the strokes an eraser move touches
// ---------------------------------------------------------------------------

/** How far from its path the eraser reaches, in px of the rendered slide. */
export const ERASER_RADIUS_PX = 8;

export interface EraseOptions {
  /** In px of `box` (default ERASER_RADIUS_PX). */
  radius?: number;
  /** Strokes erased already in this drag. */
  skip?: ReadonlySet<string>;
  /** Leaves out what is not drawn right now (그때 필기 재생). */
  visible?: (item: AnnotationItem) => boolean;
}

/**
 * The ids of the 펜 strokes (only strokes are erased) the eraser's move from `a` to `b` (image coordinates; a == b for
 * a tap) comes within `radius` px of, in z-order — `box` = the rendered image in px. A stroke whose rect is out of
 * reach is not measured.
 */
export function eraserHits(
  items: readonly AnnotationItem[],
  a: Point,
  b: Point,
  box: { w: number; h: number },
  { radius = ERASER_RADIUS_PX, skip, visible }: EraseOptions = {},
): string[] {
  if (!(box.w > 0) || !(box.h > 0)) return [];
  const rx = radius / box.w;
  const ry = radius / box.h;
  const x0 = Math.min(a.x, b.x) - rx;
  const x1 = Math.max(a.x, b.x) + rx;
  const y0 = Math.min(a.y, b.y) - ry;
  const y1 = Math.max(a.y, b.y) + ry;
  const out: string[] = [];
  for (const item of items) {
    if (item.type !== 'ink' || skip?.has(item.id) || (visible && !visible(item))) continue;
    const r = item.rect;
    if (r.x > x1 || r.x + r.w < x0 || r.y > y1 || r.y + r.h < y0) continue;
    if (inkTouches(inkPointsOf(item), item.width, a, b, box.w, box.h, radius)) out.push(item.id);
  }
  return out;
}

/** `ids` with `id` added (absent) or removed (present) — Shift+click. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * `base` plus `more` (Shift+drag adds to the selection), without duplicates, in the order first seen. A Set keeps it
 * linear: a marquee over thousands of 펜 strokes runs this every frame.
 */
export function unionIds(base: readonly string[], more: readonly string[]): string[] {
  const out = [...base];
  const seen = new Set(base);
  for (const id of more) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pointer and touch events of 펜 / 지우개 (DESIGN §29)
// ---------------------------------------------------------------------------

/**
 * Whether a pointerdown may start a gesture on the slides: the primary pointer, or any pen — iPadOS Safari makes only
 * the first touch of a sequence primary, so an Apple Pencil put down after a palm or a finger is not (the pen
 * replaces what the hand started, the viewer's pointerdown) —, and of a mouse only the main button.
 */
export function acceptsPress(e: { isPrimary: boolean; pointerType: string; button: number }): boolean {
  if (!e.isPrimary && e.pointerType !== 'pen') return false;
  return e.pointerType !== 'mouse' || e.button === 0;
}

/**
 * What a stylus pressing on these does not write on (the viewer's touch listener leaves its touchstart alone so the
 * tap reaches the control): buttons, links, fields, memo cards, question markers and the floating menus.
 */
export const INK_TOUCH_CONTROLS =
  'button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-annot="memo"], [data-annot="marker"], .memo-card, .tag-input, .region-menu, .annot-pop, .link-picker, .popover-menu';

/** Whether a touch event's target is (inside) one of INK_TOUCH_CONTROLS. No DOM types: a duck-typed `closest`. */
export function onInkControl(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === 'function' && el.closest(INK_TOUCH_CONTROLS) !== null;
}

export interface InkTouch {
  type: 'touchstart' | 'touchmove' | string;
  /** A 펜 stroke or an eraser drag is being made. */
  stroke: boolean;
  /** 펜 / 지우개 is active and the touch is a stylus (iOS `touchType === 'stylus'`). */
  stylus: boolean;
  /** The touch is on a control (onInkControl). */
  control: boolean;
  /** A gesture is live (a selection being dragged, a move): its finger must not scroll. */
  active: boolean;
}

/**
 * Whether the viewer's non-passive touch listener prevents a touch's default (palm rejection, DESIGN §29): always
 * during a stroke (a palm put down meanwhile must not scroll); a stylus otherwise — but not its touchstart on a
 * control, which would swallow the tap (the Q&A badge, a marker, a memo card's buttons and textarea, a menu); and a
 * touchmove of a live gesture.
 */
export function blocksInkTouch(t: InkTouch): boolean {
  if (t.stroke) return true;
  if (t.stylus && !(t.type === 'touchstart' && t.control)) return true;
  return t.type === 'touchmove' && t.active;
}

/**
 * A 펜 stroke the browser cancels (pointercancel) before it got this far from its start, in CSS px, was not meant to
 * be written: Chrome on Android turns an S Pen fling into a scroll. A stroke that got farther keeps what was drawn.
 */
export const INK_CANCEL_SLOP_PX = 12;

/** Whether a cancelled stroke that reached `reachPx` from its start (the farthest sample) is kept. */
export const keepsCancelledStroke = (reachPx: number): boolean => reachPx >= INK_CANCEL_SLOP_PX;

/** What the DOM says was pressed: a selection handle, a question marker, or anything else (the items are hit-tested). */
export type PressTarget = { kind: 'handle'; handle: Handle } | { kind: 'marker' } | { kind: 'other' };

export interface PressInput {
  /** The active tool ('select' = no drawing tool: the default 선택·첨부 state); the layer hidden counts as 'select'. */
  tool: AnnotationTool;
  target: PressTarget;
  /** The item under the press (hitTestItems), or the handle's item. */
  item: AnnotationItem | null;
  /** The item is part of the selection already. */
  selected: boolean;
  /** A finger or a pen (not a mouse / trackpad). */
  touch: boolean;
  /** Shift held: an item is added to / taken out of the selection, a marquee adds to it. */
  shift?: boolean;
  /** PointerEvent.pointerType ('mouse' | 'pen' | 'touch'); absent: 'touch' when `touch`, else 'mouse'. */
  pointerType?: string;
  /** PointerEvent.buttons: on a pen, the eraser end (32) or the barrel button (2) erases under 펜. */
  buttons?: number;
  /** 손가락으로도 쓰기: under 펜 / 지우개 a finger writes / erases too (else it scrolls and zooms). */
  fingerInk?: boolean;
}

export type PressPlan =
  | { kind: 'ignore' }
  | { kind: 'resize'; item: AnnotationItem; handle: Handle }
  /**
   * Select the item (when it is part of the selection already, the selection stays: a drag then moves all of it);
   * `move` = a drag from here moves it (a text highlight is never moved; a finger first selects).
   */
  | { kind: 'select'; item: AnnotationItem; move: boolean }
  /** Shift+click: add the item to the selection, or take it out. Nothing is moved. */
  | { kind: 'toggle'; item: AnnotationItem }
  /** Draw with the tool on empty area; `immediate` = the gesture is live from the press (a click tool, or touch). */
  | { kind: 'draw'; tool: DrawingTool; immediate: boolean }
  /** 범위 선택 on empty area: a drag selects what it crosses (`add`: on top of the selection); `immediate` on touch. */
  | { kind: 'marquee'; add: boolean; immediate: boolean }
  /** 텍스트 형광 pressed on a text highlight: a drag re-fits that item's words (a click selects it); `immediate` on touch. */
  | { kind: 'redraw'; item: TextHighlightItem; immediate: boolean }
  /** No tool, empty area: the region gesture (mouse: a drag; touch: a long press then a drag). */
  | { kind: 'region' }
  /** 펜: a stroke is written from the press (over existing items too). */
  | { kind: 'ink' }
  /** 지우개 (or a pen's eraser end / barrel button under 펜): a drag removes the strokes it touches. */
  | { kind: 'erase' };

/** PointerEvent.buttons of a pen's eraser end (32) and barrel button (2). */
const PEN_ERASE_BUTTONS = 32 | 2;

export const canResize = (item: AnnotationItem): boolean => item.type !== 'memo' && item.type !== 'textHighlight';

/**
 * The plan of a press. Existing items come first whatever the tool is (the user's request: a highlight just drawn is
 * moved or resized at once, without picking a selection tool), a handle before its item, markers are buttons of
 * their own; the one exception is a text highlight under its own tool, which is re-dragged (it has no handles —
 * dragging over words is how its extent changes); drawing happens only on empty area; without a tool the empty area
 * is the region (첨부) gesture. Under 펜 / 지우개 (DESIGN §29) the kind of pointer decides, over items too: a stylus or
 * the mouse writes / erases (a pen's eraser end or barrel button erases under 펜), a finger does nothing — the browser
 * scrolls and zooms, and a palm resting on the slide writes nothing — unless 손가락으로도 쓰기 is on.
 */
export function pressPlan({ tool, target, item, selected, touch, shift = false, pointerType, buttons = 0, fingerInk = false }: PressInput): PressPlan {
  if (target.kind === 'marker') return { kind: 'ignore' };
  if (target.kind === 'handle') {
    return item && canResize(item) ? { kind: 'resize', item, handle: target.handle } : { kind: 'ignore' };
  }
  if (isInkTool(tool)) {
    const pointer = pointerType ?? (touch ? 'touch' : 'mouse');
    if (pointer === 'touch' && !fingerInk) return { kind: 'ignore' };
    if (tool === 'eraser' || (pointer === 'pen' && (buttons & PEN_ERASE_BUTTONS) !== 0)) return { kind: 'erase' };
    return { kind: 'ink' };
  }
  if (item) {
    if (shift) return { kind: 'toggle', item };
    if (item.type === 'textHighlight' && tool === 'textHighlight') return { kind: 'redraw', item, immediate: touch };
    // A text highlight is never moved (re-drag it with 텍스트 형광); on touch an unselected item is selected first so a finger can still scroll.
    const move = item.type !== 'textHighlight' && !(touch && !selected);
    return { kind: 'select', item, move };
  }
  if (tool === 'marquee') return { kind: 'marquee', add: shift, immediate: touch };
  if (tool !== 'select') return { kind: 'draw', tool, immediate: touch || CLICK_TOOLS.has(tool) };
  return { kind: 'region' };
}
