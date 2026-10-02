// Pure parts of the split pane (components/SplitPane.tsx): its two layouts, the ratio from a pointer or a key, the
// press on the divider (a tap, a drag, and everything that ends it), taps, folding the chat pane.

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

/** The press on the divider: its pointer, where it holds the divider and whether it has dragged yet (else a tap). */
export interface DividerPress {
  pointerId: number;
  pointerType: string;
  grab: number;
  clientX: number;
  clientY: number;
  dragged: boolean;
}

/** What the divider is told of (SplitPane.tsx), from its own events and from the window's. */
export type DividerEvent =
  | { type: 'down'; pointerId: number; pointerType: string; clientX: number; clientY: number; grab: number }
  | { type: 'move'; pointerId: number; clientX: number; clientY: number; buttons: number }
  /** pointerup, pointercancel, lostpointercapture. */
  | { type: 'up' | 'cancel' | 'lost'; pointerId: number }
  /** touchend / touchcancel on the divider; `remaining`: the touches still on it. */
  | { type: 'touchend'; remaining: number }
  /** A press anywhere else, the window lost the focus, the page was hidden, the divider changed (layout, collapsed). */
  | { type: 'outside' | 'blur' | 'hidden' | 'layout' };

/**
 * The press on the divider after an event. A press alone is a tap so far; it drags once its pointer left the slop.
 * It must never outlive its pointer (a drag that stays would keep the divider, and under a mouse the panes, which
 * ignore the pointer meanwhile), so whatever may mean "that pointer is gone" ends it, not only its own pointerup: a
 * touch screen with a palm and a pencil on it does not always send that one.
 */
export function dividerPress(press: DividerPress | null, event: DividerEvent): DividerPress | null {
  switch (event.type) {
    case 'down':
      // A new press takes the divider over (a palm resting on it must not keep it from the pencil).
      return {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        grab: event.grab,
        clientX: event.clientX,
        clientY: event.clientY,
        dragged: false,
      };
    case 'move':
      if (!press || event.pointerId !== press.pointerId) return press;
      // The button was let go where no pointerup came from (outside the window).
      if (press.pointerType === 'mouse' && (event.buttons & 1) === 0) return null;
      // Not before the pointer really moves: a (double) tap does not resize.
      if (press.dragged) return press;
      if (Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) < tapSlop(press.pointerType)) return press;
      return { ...press, dragged: true };
    case 'up':
    case 'cancel':
    case 'lost':
      return press && event.pointerId === press.pointerId ? null : press;
    case 'touchend':
      return press && press.pointerType !== 'mouse' && event.remaining === 0 ? null : press;
    default:
      return null;
  }
}

/**
 * 'pressed': held, not moved yet — only the divider shows it. 'dragging': the divider follows the pointer
 * (`.split.is-dragging` of styles.css: under a mouse the panes ignore it meanwhile).
 */
export type DividerPhase = 'idle' | 'pressed' | 'dragging';

export function dividerPhase(press: DividerPress | null): DividerPhase {
  if (!press) return 'idle';
  return press.dragged ? 'dragging' : 'pressed';
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

const TOGGLE_TAP_MS = 800;

/**
 * Whether a press of `heldMs` on the collapse button folds / unfolds the chat pane: a tap of a finger or a pencil,
 * not the palm that rested on the button while writing (a mouse may hold it as long as it likes).
 */
export function isToggleTap(pointerType: string, heldMs: number): boolean {
  return pointerType === 'mouse' || heldMs <= TOGGLE_TAP_MS;
}

const openListeners = new Set<() => void>();

/**
 * Unfolds the chat pane if it is collapsed (nothing otherwise): for whatever puts something into it from outside,
 * like a region attached from the slides, which nobody would see in a folded pane.
 */
export function openChatPane(): void {
  for (const listener of [...openListeners]) listener();
}

/** SplitPane.tsx listens here for openChatPane. Returns the function that stops listening. */
export function onOpenChatPane(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}
