// The slide viewer's zoom (SlideViewer): a factor of "fit width" (1), any value from ZOOM_MIN to ZOOM_MAX. The − / ＋
// buttons step through ZOOM_LEVELS; a two-finger pinch, Ctrl+wheel and a trackpad pinch zoom continuously, and the
// point of the slide under the fingers / the pointer stays under them.
//
// No DOM here (unit-tested, web/tests/zoom.test.ts): the viewer measures, these decide.
import type { Point } from './attachments.ts';

/** The steps of the − / ＋ buttons, relative to "fit width" (1). */
export const ZOOM_LEVELS: readonly number[] = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
export const ZOOM_MIN = ZOOM_LEVELS[0];
export const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

/** A zoom this close to 맞춤 (1) is 맞춤: a pinch can come back to it, and 99 % is not shown as a zoom of its own. */
export const ZOOM_SNAP = 0.03;
/** Two zooms closer than this are the same step for the − / ＋ buttons (1.249 → ＋ gives 1.5, not 1.25). */
const STEP_EPSILON = 0.01;

/** A zoom inside the range, with three decimals (what is stored and shown); not a number → 1. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 1000) / 1000;
}

/** clampZoom, and 맞춤 when it is within ZOOM_SNAP of it (a continuous zoom: a pinch, the wheel). */
export function snapZoom(zoom: number): number {
  const z = clampZoom(zoom);
  return Math.abs(z - 1) <= ZOOM_SNAP ? 1 : z;
}

/** The zoom kept in localStorage: any number in the range (a pinch stores what it ended on), else 맞춤. */
export function storedZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX ? clampZoom(value) : 1;
}

/**
 * The − (dir -1) / ＋ (dir 1) button: the next level below / above the zoom, which may lie between two levels after
 * a pinch. At the end of the range it is the zoom itself (the button is disabled).
 */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const z = clampZoom(zoom);
  if (dir > 0) return ZOOM_LEVELS.find((level) => level > z + STEP_EPSILON) ?? (z < ZOOM_MAX ? ZOOM_MAX : z);
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) if (ZOOM_LEVELS[i] < z - STEP_EPSILON) return ZOOM_LEVELS[i];
  return z > ZOOM_MIN ? ZOOM_MIN : z;
}

/** The zoom as the toolbar shows it next to 맞춤: '125%'. */
export const zoomPercent = (zoom: number): string => `${Math.round(zoom * 100)}%`;

// ---- A two-finger pinch ----------------------------------------------------------------------------------------

/** Two fingers must move this far (CSS px) before they pan, their distance must change this much before they zoom. */
export const PINCH_SLOP_PX = 10;
/** Fingers that start closer than this count as this far apart (a few px of jitter would be a big factor). */
const PINCH_MIN_SPAN_PX = 24;

export const touchDistance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export const touchMidpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Whether two fingers that landed at `fromA` / `fromB` have begun to pinch: their distance, or their midpoint, moved
 * more than the slop. Until then nothing moves (a hand resting on the slide with two contacts shifts by a few px).
 */
export function pinchBegan(fromA: Point, fromB: Point, a: Point, b: Point, slop = PINCH_SLOP_PX): boolean {
  if (Math.abs(touchDistance(a, b) - touchDistance(fromA, fromB)) > slop) return true;
  return touchDistance(touchMidpoint(a, b), touchMidpoint(fromA, fromB)) > slop;
}

/**
 * The factor a pinch multiplies the zoom it started at by: 1 while the fingers' distance stays within `slop` of where
 * it began, then growing from there without a jump (the slop is taken off the change).
 */
export function pinchScale(startDistance: number, distance: number, slop = PINCH_SLOP_PX): number {
  const base = Math.max(startDistance, PINCH_MIN_SPAN_PX);
  const change = distance - startDistance;
  if (Math.abs(change) <= slop) return 1;
  return Math.max(0, base + change - Math.sign(change) * slop) / base;
}

// ---- Ctrl+wheel ------------------------------------------------------------------------------------------------

/** One wheel event counts for at most this many px: a mouse wheel's notch (±100 and more) is one step, not a leap. */
const WHEEL_MAX_PX = 24;

/**
 * The factor of one Ctrl+wheel event (up / a trackpad's fingers apart = in). A trackpad pinch arrives as many small
 * deltas (the browser's own pinch uses the same exp(-Δ/100)); a wheel's notch is capped to about ×1.27.
 * `deltaMode`: 0 px, 1 lines, 2 pages (WheelEvent).
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY)) return 1;
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  return Math.exp(-Math.min(WHEEL_MAX_PX, Math.max(-WHEEL_MAX_PX, px)) / 100);
}

/**
 * The zoom after one Ctrl+wheel event, kept in the range but neither rounded nor snapped to 맞춤: a run of wheel
 * events carries this value on (the small steps of a trackpad would never leave the snap of 맞춤 otherwise) and
 * shows snapZoom of it.
 */
export function wheelZoom(zoom: number, deltaY: number, deltaMode = 0): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * wheelZoomFactor(deltaY, deltaMode)));
}

// ---- Keeping a point of a slide in place -----------------------------------------------------------------------

/** A box on screen (a DOMRect of a slide). */
export interface ZoomBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a client point lies in a box, as fractions of its size (outside it: below 0 / above 1 — a point in the gap
 * between two slides is anchored to the nearer one). Measured before the zoom changes.
 */
export function anchorIn(box: ZoomBox, at: Point): Point {
  return { x: box.width > 0 ? (at.x - box.left) / box.width : 0, y: box.height > 0 ? (at.y - box.top) / box.height : 0 };
}

/**
 * How far the scroller scrolls (added to scrollLeft / scrollTop) so that the anchored point of the box — measured
 * again, at its new size and place — lies under the client point: the same point after a zoom, or the fingers'
 * midpoint wherever it moved (two fingers moving together pan).
 */
export function anchorScroll(box: ZoomBox, anchor: Point, at: Point): Point {
  return { x: box.left + anchor.x * box.width - at.x, y: box.top + anchor.y * box.height - at.y };
}

/**
 * The index of the box a zoom is anchored to among boxes stacked from top to bottom (`bottomOf(i)`: where box i ends
 * on screen): the first one that reaches down to `y` — the one under it, or the next one below a gap; the last one
 * past the end. -1 when there is none or one cannot be measured.
 */
export function boxIndexAt(count: number, bottomOf: (index: number) => number | null, y: number): number {
  let lo = 0;
  let hi = count - 1;
  let found = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bottom = bottomOf(mid);
    if (bottom === null) return -1;
    if (bottom >= y) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}
