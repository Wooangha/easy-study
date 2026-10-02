// 펜 strokes in the web client (DESIGN §29), the pure part: what a pointer event gives a live stroke (its coalesced
// samples, the pressure only from a pen), the image's aspect a stroke is measured in, and the outline a stored stroke
// is drawn as, mapped through its rect (a move / resize preview moves and scales it). No DOM, no React; the geometry
// itself (encoding, simplification, the outline, hit testing) is shared/ink.ts.
import { inkOutline, inkPointsOf, NO_PRESSURE, type InkPoint } from '../../../../shared/ink.ts';
import type { InkItem, RegionRect } from '../../../../shared/types.ts';
import type { Frame } from '../attachments.ts';

/** The pressure of a sample: a pen's own when it reports one (> 0), else NO_PRESSURE (a mouse, a finger: the nominal width). */
export function inkPressure(pointerType: string, pressure: number): number {
  return pointerType === 'pen' && pressure > 0 && Number.isFinite(pressure) ? Math.min(1, pressure) : NO_PRESSURE;
}

/** The samples of a pointer event: its coalesced events (a fast pen moves many times per frame), else the event itself. */
export function inkSamples<E extends { getCoalescedEvents?: () => E[] }>(event: E): E[] {
  const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
  return coalesced.length > 0 ? coalesced : [event];
}

/** The slide image's width / height: the slide box's aspect (page 1's) through the frame the image is drawn in. */
export function imageAspectOf(boxAspect: number, frame: Frame): number {
  const aspect = frame.h > 0 ? (boxAspect * frame.w) / frame.h : boxAspect;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

/**
 * The outline of a stored stroke as an SVG path in a box of `w` × `h` (the image's aspect): its points mapped from the
 * item's rect to `rect` (the same rect, or a move / resize preview), drawn at the item's width.
 */
export function inkPathOf(item: InkItem, rect: RegionRect, w: number, h: number): string {
  const points = inkPointsOf(item);
  const from = item.rect;
  const mapped: InkPoint[] =
    rect === from
      ? points
      : points.map((pt) => ({
          x: rect.x + (from.w > 0 ? (pt.x - from.x) / from.w : 0) * rect.w,
          y: rect.y + (from.h > 0 ? (pt.y - from.y) / from.h : 0) * rect.h,
          p: pt.p,
        }));
  return inkOutline(mapped, item.width, w, h);
}
