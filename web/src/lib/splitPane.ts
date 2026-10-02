// Pure parts of the split pane (components/SplitPane.tsx): its two layouts, the ratio from a pointer or a key, taps.

/** 'row': slides left, chat right (a vertical divider). 'stacked': slides on top, chat below (a horizontal one). */
export type SplitLayout = 'row' | 'stacked';

/**
 * The panes stack when this matches. SplitPane.tsx alone decides the layout (the `.is-stacked` class); the width is
 * the one of the responsive block of styles.css (web/tests/split-pane.test.ts checks it).
 */
export const STACKED_QUERY = '(max-width: 800px)';

/** The first pane's share of the container per layout: the default and the limits of dragging. */
export const SPLIT_RANGE: Record<SplitLayout, { def: number; min: number; max: number }> = {
  row: { def: 0.58, min: 0.25, max: 0.8 },
  stacked: { def: 0.46, min: 0.2, max: 0.8 },
};

/** A ratio within the limits of a layout; the default for a value that is not a number. */
export function clampRatio(layout: SplitLayout, ratio: number): number {
  const { def, min, max } = SPLIT_RANGE[layout];
  return Number.isFinite(ratio) ? Math.min(max, Math.max(min, ratio)) : def;
}

interface Point {
  clientX: number;
  clientY: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * px from the middle of the divider (its box) to the point it was pressed at, along the layout's axis: the wide grab
 * area of a touch screen must not make the divider jump under the finger.
 */
export function grabOffset(layout: SplitLayout, point: Point, divider: Box): number {
  return layout === 'row' ? point.clientX - (divider.left + divider.width / 2) : point.clientY - (divider.top + divider.height / 2);
}

/** The ratio that puts the divider under a pointer (pressed `grab` px off its middle); null for an empty container. */
export function ratioFromPointer(layout: SplitLayout, point: Point, container: Box, grab = 0): number | null {
  const size = layout === 'row' ? container.width : container.height;
  if (!(size > 0)) return null;
  const offset = layout === 'row' ? point.clientX - container.left : point.clientY - container.top;
  return clampRatio(layout, (offset - grab) / size);
}

/**
 * The ratio after a key on the focused divider: ← / → move a vertical divider and ↑ / ↓ a horizontal one (bigger
 * steps with Shift), Home and Enter reset it. null for any other key (left to the page).
 */
export function ratioFromKey(layout: SplitLayout, key: string, shiftKey: boolean, ratio: number): number | null {
  const step = shiftKey ? 0.08 : 0.02;
  if (key === 'Home' || key === 'Enter') return SPLIT_RANGE[layout].def;
  if (key === (layout === 'row' ? 'ArrowLeft' : 'ArrowUp')) return clampRatio(layout, ratio - step);
  if (key === (layout === 'row' ? 'ArrowRight' : 'ArrowDown')) return clampRatio(layout, ratio + step);
  return null;
}

/** px a press may wander and still be a tap rather than a drag: a finger or a pencil tip slips more than a mouse. */
export function tapSlop(pointerType: string): number {
  return pointerType === 'mouse' ? 3 : 10;
}

/** The end of a press that did not drag. */
export interface Tap {
  time: number;
  clientX: number;
  clientY: number;
}

const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_PX = 30;

/** Whether `tap` right after `prev`, about the same place, makes a double tap (which resets the divider). */
export function isDoubleTap(prev: Tap | null, tap: Tap): boolean {
  if (!prev) return false;
  const dt = tap.time - prev.time;
  return dt >= 0 && dt <= DOUBLE_TAP_MS && Math.hypot(tap.clientX - prev.clientX, tap.clientY - prev.clientY) <= DOUBLE_TAP_PX;
}
