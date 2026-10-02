// What a press on a slide does (DESIGN §25), the pure part: hit-testing the slide's items under the pointer (the
// smallest wins, so a small highlight inside a big rectangle stays reachable; a few pixels of slack for thin bands
// and outlines; an unselected outline shape counts on its ring only in EVERY state, so its inside passes through to
// what is under it; a 펜 stroke near its centre line only), the items a marquee crosses, the strokes an eraser move
// touches (DESIGN §29), and the plan of a press — resize a handle, select / move the item under it with ANY tool
// active (Shift: add it to / take it out of the selection), re-drag a text highlight with its own tool, draw with the
// active tool on empty area, drag a marquee with 범위 선택, write or erase under 펜 / 지우개 (by the kind of pointer:
// a finger scrolls), or (no tool: the default 선택·첨부 state) start the region gesture — a stylus counts as a mouse
// there, only a finger is imprecise and long-presses; and which pointer / touch events start a gesture, replace one
// whose contact is gone (a release that never arrived must not block the next press) or are kept from the browser.
// No DOM (the viewer measures memo cards for the marquee and passes their boxes in).
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
// The pointer and touch events of a gesture (DESIGN §29)
// ---------------------------------------------------------------------------

/**
 * A finger: imprecise (TOUCH_HIT_SLOP_PX), it scrolls the slides by dragging — so a region needs a long press and an
 * unselected item is selected before it is moved — and draws at once under a tool. A stylus (Apple Pencil, S Pen) is
 * a mouse with a tip: precise, its drags start right away and it never scrolls the slides.
 */
export const fingerPointer = (pointerType: string): boolean => pointerType === 'touch';

/**
 * Whether a pointerdown may start a gesture on the slides: the primary pointer, or any pen — iPadOS Safari makes only
 * the first touch of a sequence primary, so an Apple Pencil put down after a palm or a finger is not (the pen
 * replaces what the hand started, the viewer's pointerdown) —, and of a mouse only the main button.
 */
export function acceptsPress(e: { isPrimary: boolean; pointerType: string; button: number }): boolean {
  if (!e.isPrimary && e.pointerType !== 'pen') return false;
  return e.pointerType !== 'mouse' || e.button === 0;
}

/** What the viewer knows of the gesture a press finds registered. */
export interface HeldGesture {
  pointerId: number;
  pointerType: string;
  /** A 펜 stroke or an eraser drag (what it drew is kept when it ends unseen). */
  stroke: boolean;
  /** Live (a drag past its threshold, a long press that fired); a stroke always is. */
  active: boolean;
}

/**
 * What a pointerdown does about the gesture already registered:
 * - 'start': there is none.
 * - 'finish': a stroke whose contact is gone — the release never arrived — keeps what it drew; the press goes on.
 * - 'drop': a gesture that is over, or that the hand started before the pen, goes with what it drew; the press goes on.
 * - 'cancel': a second finger on a finger's press that is not live yet (two fingers pinch): it goes, the press too.
 * - 'ignore': the press is not for the slides (a palm or a second finger during a gesture); the gesture stays.
 *
 * A pointer that goes down is not down already, and there is one pen and one mouse: a press of the gesture's own
 * pointer, of a pen or of a mouse always means the old gesture's contact has ended, whatever became of its pointerup
 * (iPadOS gives every contact of the Pencil a new pointerId). A gesture never outlives the next press, so one lost
 * release cannot make the slides ignore the pen. A finger is the exception: a palm lands during a stroke, a second
 * finger during a drag — only the first finger of a new sequence (isPrimary) says the old finger is gone.
 */
export type PressOver = 'start' | 'finish' | 'drop' | 'cancel' | 'ignore';

export function pressOver(current: HeldGesture | null, e: { pointerId: number; pointerType: string; isPrimary: boolean }): PressOver {
  if (!current) return 'start';
  const over = current.stroke ? 'finish' : 'drop';
  if (e.pointerId === current.pointerId) return over;
  if (!fingerPointer(e.pointerType)) {
    // What a finger or a palm began before the pen (a stroke under 손가락으로도 쓰기 too) is not the student's.
    return e.pointerType === 'pen' && fingerPointer(current.pointerType) ? 'drop' : over;
  }
  if (!fingerPointer(current.pointerType)) return 'ignore';
  if (e.isPrimary) return over;
  return current.active ? 'ignore' : 'cancel';
}

/**
 * Whether a pointermove shows that a gesture's contact ended without its pointerup: the mouse that made it moves with
 * no button held, or the pen hovers (no button, no pressure — a pen is one device, whatever its pointerId) while a
 * pen's gesture is registered. A finger does not hover.
 *
 * Not while the touch events still show the gesture's own contact on the glass (`down`), nor by a move sent before
 * the press (`downAt` / `timeStamp`): iPadOS sends the Pencil's hover apart from its contact (another pointerId,
 * another queue), so a last hover move can arrive after the pointerdown of the stroke it preceded — the stroke would
 * end as a dot and the rest of it be ignored. The touch ending, or the next press, ends such a gesture.
 */
export function releasedUnseen(
  g: { pointerId: number; pointerType: string; downAt?: number },
  e: { pointerId: number; pointerType: string; buttons: number; pressure: number; timeStamp?: number },
  down = false,
): boolean {
  if (down || e.pointerType !== g.pointerType || e.buttons !== 0) return false;
  if (g.downAt !== undefined && e.timeStamp !== undefined && e.timeStamp <= g.downAt) return false;
  if (e.pointerType === 'mouse') return e.pointerId === g.pointerId;
  return e.pointerType === 'pen' && !(e.pressure > 0);
}

/** A touch on the glass as the touch events list it. */
export interface Contact {
  /** Touch.identifier. */
  id: number;
  x: number;
  y: number;
  /** A stylus (iOS `touchType === 'stylus'`; elsewhere the pointerdown before its touchstart said so). */
  stylus: boolean;
}

/** A gesture's touch is looked for this close (CSS px) to where its pointer is. */
export const CONTACT_MATCH_PX = 48;

/**
 * The touch that makes a gesture begun by a pointer at `at` (client px): of a pen the stylus touch (the nearest of
 * them, wherever), of a finger the nearest finger within `slop`. A pen whose touch is not marked as a stylus is not
 * guessed among the fingers — the palm lies right next to it, and its lifting would end the stroke. Undefined when
 * none fits: the gesture then ends by its pointer events alone.
 */
export function contactFor(g: { pointerType: string; at: Point }, touches: readonly Contact[], slop = CONTACT_MATCH_PX): number | undefined {
  const pen = g.pointerType === 'pen';
  let best: Contact | undefined;
  let bestD = pen ? Infinity : slop;
  for (const t of touches) {
    if (t.stylus !== pen) continue;
    const d = Math.hypot(t.x - g.at.x, t.y - g.at.y);
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  return best?.id;
}

/**
 * Whether the touches on the glass show that a gesture's contact is gone (its touchend went to a node that had left
 * the document, or its pointerup was never sent): its own touch is not among them; or, for a pen's gesture whose touch
 * was never seen, no stylus is — where the browser marks every touch with its kind (`typed`, iOS). The mouse has no
 * touch: its gestures end by pointer events.
 */
export function contactGone(g: { pointerType: string; touchId?: number }, touches: readonly Contact[], typed: boolean): boolean {
  if (g.pointerType === 'mouse') return false;
  if (g.touchId !== undefined) return !touches.some((t) => t.id === g.touchId);
  return g.pointerType === 'pen' && typed && !touches.some((t) => t.stylus);
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

export interface ViewerTouch {
  type: 'touchstart' | 'touchmove' | string;
  /** 펜 / 지우개 without 손가락으로도 쓰기: the viewer scrolls and zooms the slides itself (lib/touchPan.ts). */
  penMode: boolean;
  /** One of the event's touches is a stylus. */
  stylus: boolean;
  /** The touch is on a control (onInkControl). */
  control: boolean;
  /**
   * The contact of a live gesture (a stroke, an eraser drag, a selection or an item being dragged) is on the glass
   * right now: among the event's touches. Never the gesture object alone — one whose release was lost would stop
   * every finger for good.
   */
  contact: boolean;
  /** That gesture writes or erases. */
  stroke: boolean;
}

/**
 * Whether the viewer's non-passive touch listener prevents a touch's default (DESIGN §29): under 펜 / 지우개 everything
 * that is not on a control — the browser must do nothing of its own with a palm (no scroll that takes the pen's
 * touches, no double-tap zoom); a touch on a control keeps its tap. While a stroke's contact is down, every touch,
 * on a control too. A stylus in every tool (it never scrolls the slides) — but not its touchstart on a control, which
 * would swallow the tap (the Q&A badge, a marker, a memo card's buttons and textarea, a menu). And the touchmove of a
 * live gesture whose contact is down: its finger must not scroll.
 */
export function blocksTouch(t: ViewerTouch): boolean {
  if (t.stroke && t.contact) return true;
  if (t.penMode && !t.control) return true;
  if (t.stylus && !(t.type === 'touchstart' && t.control)) return true;
  return t.type === 'touchmove' && t.contact;
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
  /** A finger (fingerPointer); a stylus is a mouse here. Overridden by `pointerType` when that is given. */
  touch: boolean;
  /** Shift held: an item is added to / taken out of the selection, a marquee adds to it. */
  shift?: boolean;
  /** PointerEvent.pointerType ('mouse' | 'pen' | 'touch'); absent: a finger when `touch`, else the mouse. */
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
  /** Draw with the tool on empty area; `immediate` = the gesture is live from the press (a click tool, or a finger). */
  | { kind: 'draw'; tool: DrawingTool; immediate: boolean }
  /** 범위 선택 on empty area: a drag selects what it crosses (`add`: on top of the selection); `immediate` on touch. */
  | { kind: 'marquee'; add: boolean; immediate: boolean }
  /** 텍스트 형광 pressed on a text highlight: a drag re-fits that item's words (a click selects it); `immediate` on touch. */
  | { kind: 'redraw'; item: TextHighlightItem; immediate: boolean }
  /** No tool, empty area: the region gesture (mouse or stylus: a drag; a finger: a long press then a drag). */
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
 * the mouse writes / erases (a pen's eraser end or barrel button erases under 펜), a finger does nothing — the viewer
 * scrolls and zooms, and a palm resting on the slide writes nothing — unless 손가락으로도 쓰기 is on. Under every other
 * tool a stylus is a mouse (fingerPointer): its drag moves an item, draws or selects a region right away.
 */
export function pressPlan({ tool, target, item, selected, touch, shift = false, pointerType, buttons = 0, fingerInk = false }: PressInput): PressPlan {
  if (target.kind === 'marker') return { kind: 'ignore' };
  if (target.kind === 'handle') {
    return item && canResize(item) ? { kind: 'resize', item, handle: target.handle } : { kind: 'ignore' };
  }
  const finger = pointerType === undefined ? touch : fingerPointer(pointerType);
  if (isInkTool(tool)) {
    if (finger && !fingerInk) return { kind: 'ignore' };
    if (tool === 'eraser' || (pointerType === 'pen' && (buttons & PEN_ERASE_BUTTONS) !== 0)) return { kind: 'erase' };
    return { kind: 'ink' };
  }
  if (item) {
    if (shift) return { kind: 'toggle', item };
    if (item.type === 'textHighlight' && tool === 'textHighlight') return { kind: 'redraw', item, immediate: finger };
    // A text highlight is never moved (re-drag it with 텍스트 형광); a finger selects an unselected item first, so it can still scroll.
    const move = item.type !== 'textHighlight' && !(finger && !selected);
    return { kind: 'select', item, move };
  }
  if (tool === 'marquee') return { kind: 'marquee', add: shift, immediate: finger };
  if (tool !== 'select') return { kind: 'draw', tool, immediate: finger || CLICK_TOOLS.has(tool) };
  return { kind: 'region' };
}
