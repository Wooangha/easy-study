// Where the floating menu of a selected item goes (DESIGN §25, 0.6.2), pure: from the item's ACTUAL box as drawn (a
// memo card is clamped inside the slide by CSS, so its anchor is not where the card is) — below it when the visible
// part of the viewer has room there, else above it, kept inside the viewer sideways; a menu that would cover a memo
// card is never placed over it. Every extent is in px of one coordinate space (the slide element's), measured by the
// menu itself. No DOM here.

/** A box in px: left/top inclusive, right/bottom exclusive. */
export interface PxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MenuPlaceInput {
  /** The union of the selected items' boxes as drawn. */
  item: PxRect;
  /** The slide box. */
  slide: PxRect;
  /** The visible part of the viewer (may extend past the slide). */
  view: PxRect;
  /** The menu's own size at its widest allowed width. */
  menu: { width: number; height: number };
  /** Never over the item (a memo card would be covered): the side with more room when neither fits. */
  outside?: boolean;
}

export type MenuSide = 'below' | 'above' | 'inside';

export interface MenuPlace {
  side: MenuSide;
  /** The menu's top-left corner, in the same space as the input. */
  left: number;
  top: number;
}

/** The gap between an item and its menu. */
export const MENU_GAP_PX = 8;

/**
 * Below the item when the menu fits there inside both the slide box and the visible viewer, else above it when it
 * fits there; then, when neither fits inside the slide (a small zoom, a big item), below or above by the visible
 * viewer alone (the menu hangs over the slide's edge into the gap between slides); otherwise inside the item's
 * bottom edge (a rectangle taller than the viewport: the menu sits over its transparent inside), or — `outside` —
 * on the side with more room, so a memo card is never covered. Sideways it starts at the item's left edge and stays
 * inside the visible part of the slide.
 */
export function placeItemMenu({ item, slide, view, menu, outside = false }: MenuPlaceInput): MenuPlace {
  const need = menu.height + MENU_GAP_PX;
  const roomBelow = view.bottom - item.bottom;
  const roomAbove = item.top - view.top;
  // Inside the slide box as well: a memo card clamped to the slide's bottom edge gets its menu above it, not in the gap.
  const within = { top: Math.max(slide.top, view.top), bottom: Math.min(slide.bottom, view.bottom) };
  let side: MenuSide;
  if (within.bottom - item.bottom >= need) side = 'below';
  else if (item.top - within.top >= need) side = 'above';
  else if (roomBelow >= need) side = 'below';
  else if (roomAbove >= need) side = 'above';
  else if (outside) side = roomBelow >= roomAbove ? 'below' : 'above';
  else side = 'inside';
  const top = side === 'below' ? item.bottom + MENU_GAP_PX : side === 'above' ? item.top - MENU_GAP_PX - menu.height : item.bottom - MENU_GAP_PX - menu.height;
  const minLeft = Math.max(slide.left, view.left);
  const maxLeft = Math.min(slide.right, view.right) - menu.width;
  const left = maxLeft < minLeft ? minLeft : Math.min(Math.max(item.left, minLeft), maxLeft);
  return { side, left, top };
}

/** The width a menu may take: the visible part of the slide (a narrow pane wraps it). */
export function menuMaxWidth(slide: PxRect, view: PxRect): number {
  return Math.max(120, Math.min(slide.right, view.right) - Math.max(slide.left, view.left));
}

/** The union of several boxes (null for none). */
export function unionPx(boxes: readonly PxRect[]): PxRect | null {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.left);
    top = Math.min(top, b.top);
    right = Math.max(right, b.right);
    bottom = Math.max(bottom, b.bottom);
  }
  return { left, top, right, bottom };
}

/** Whether two boxes overlap (touching edges do not count). */
export const overlapsPx = (a: PxRect, b: PxRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
