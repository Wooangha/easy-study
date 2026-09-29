// What a press on a slide does (DESIGN §25), the pure part: hit-testing the slide's items under the pointer (the
// smallest wins, so a small highlight inside a big rectangle stays reachable; a few pixels of slack for thin bands
// and outlines; an unselected outline shape counts on its ring only in EVERY state, so its inside passes through to
// what is under it), the items a marquee crosses, and the plan of a press — resize a handle, select / move the item
// under it with ANY tool active (Shift: add it to / take it out of the selection), re-drag a text highlight with its
// own tool, draw with the active tool on empty area, drag a marquee with 범위 선택, or (no tool: the default 선택·첨부
// state) start the region gesture. No DOM (the viewer measures memo cards for the marquee and passes their boxes in).
import type { AnnotationItem, RegionRect, TextHighlightItem } from '../../../../shared/types.ts';
import type { Point } from '../attachments.ts';
import { CLICK_TOOLS, itemBounds, type AnnotationTool, type DrawingTool, type Handle } from './geometry.ts';

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
}

export const slopFor = (size: { width: number; height: number }, touch: boolean): Slop => {
  const px = touch ? TOUCH_HIT_SLOP_PX : HIT_SLOP_PX;
  const ring = px + SHAPE_STROKE_PX / 2;
  const frac = (v: number, extent: number) => (extent > 0 ? v / extent : 0);
  return { x: frac(px, size.width), y: frac(px, size.height), ring: { x: frac(ring, size.width), y: frac(ring, size.height) } };
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
 * for the tool in hand (see `outlineOnly`).
 */
export function itemHit(item: AnnotationItem, p: Point, slop: Slop, outline = false): boolean {
  switch (item.type) {
    case 'memo':
      return false;
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

/** How much of the image an item covers (the ranking of overlapping hits). */
export function itemArea(item: AnnotationItem): number {
  switch (item.type) {
    case 'memo':
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

/** `ids` with `id` added (absent) or removed (present) — Shift+click. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** `base` plus `more` (Shift+drag adds to the selection), without duplicates, in the order first seen. */
export function unionIds(base: readonly string[], more: readonly string[]): string[] {
  const out = [...base];
  for (const id of more) if (!out.includes(id)) out.push(id);
  return out;
}

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
  | { kind: 'region' };

export const canResize = (item: AnnotationItem): boolean => item.type !== 'memo' && item.type !== 'textHighlight';

/**
 * The plan of a press. Existing items come first whatever the tool is (the user's request: a highlight just drawn is
 * moved or resized at once, without picking a selection tool), a handle before its item, markers are buttons of
 * their own; the one exception is a text highlight under its own tool, which is re-dragged (it has no handles —
 * dragging over words is how its extent changes); drawing happens only on empty area; without a tool the empty area
 * is the region (첨부) gesture.
 */
export function pressPlan({ tool, target, item, selected, touch, shift = false }: PressInput): PressPlan {
  if (target.kind === 'marker') return { kind: 'ignore' };
  if (target.kind === 'handle') {
    return item && canResize(item) ? { kind: 'resize', item, handle: target.handle } : { kind: 'ignore' };
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
