// The stroke being written with 펜 (DESIGN §29), drawn imperatively — no React state per point — on two canvases over
// the visible part of the slide image:
// - `ink`: every finished piece of the stroke, drawn once as its samples arrive (the cost of a frame does not grow with
//   the stroke): a smooth curve through the midpoints of the points (shared/ink.ts inkCurve draws the stored stroke the
//   same way: nothing changes when the pen lifts), each piece as wide as the pen pressed there. The points are the
//   pen's samples steadied a little (each eased towards its sample from the point before): a calmer line.
// - `tail`: the last half piece up to the pen and the browser's predicted samples (getPredictedEvents: where the pen
//   will be when the frame shows), cleared and drawn again with every event — the line stays under the pen's tip.
// Drawn inside the pointer event (events arrive once per frame), not a frame later. On release the viewer turns
// `points` into items (inkPieces) and removes the canvases a frame later, once the layer draws the stored stroke.
import { inkPressureScale, type InkPoint } from '../../../../shared/ink.ts';
import type { AnnotationColor } from '../../../../shared/types.ts';
import { inkPressure, inkSamples } from '../../lib/annotations/ink.ts';
import { inkDebug } from '../../lib/inkDebug.ts';
import { framePixels, toImagePoint, type Frame } from '../../lib/attachments.ts';

/** What a sample needs of a PointerEvent. */
export type InkSample = Pick<PointerEvent, 'clientX' | 'clientY' | 'pressure'>;
/** A pointer event with its samples of the frame and its predicted ones (both optional: older browsers). */
export type InkEvent = InkSample & { getCoalescedEvents?: () => InkEvent[]; getPredictedEvents?: () => InkEvent[] };

/** The canvases cover the visible part of the image plus this margin (px). */
const CLIP_MARGIN_PX = 48;
/** Backing pixels per canvas at most (iOS refuses canvases over ~16.7 M pixels; two of these stay far below). */
const MAX_CANVAS_PIXELS = 6_000_000;
/** How fast the drawn pressure follows the pen's (1 = at once): raw pressure flickers from sample to sample. */
const PRESSURE_FOLLOW = 0.5;
/** Predicted samples drawn at most (a longer prediction overshoots at turns). */
const MAX_PREDICTED = 3;
/**
 * How far a stored point follows the pen's sample from the stored point before it (1 = the sample itself): a steadier
 * hand. The tail is drawn to where the pen really is, so the line does not lag; the release adds the pen's last place.
 */
const STEADY = 0.6;

/** The stored point for a sample: eased towards it from the stored point before it (the first as it is). */
export function steadied(previous: { x: number; y: number } | null, sample: { x: number; y: number }): { x: number; y: number } {
  if (!previous) return { x: sample.x, y: sample.y };
  return { x: previous.x + (sample.x - previous.x) * STEADY, y: previous.y + (sample.y - previous.y) * STEADY };
}

/** The pressure a stroke stores for a raw sample: eased towards it from the previous sample's (the first as it is). */
export function easedPressure(previous: number | null, raw: number): number {
  return previous === null ? raw : previous + (raw - previous) * PRESSURE_FOLLOW;
}

export class LiveInk {
  /** On the image (0..1), with the (eased) pressure. */
  readonly points: InkPoint[] = [];
  /** The image's size in px at the press (the aspect a stroke is measured in). */
  readonly w: number;
  readonly h: number;
  private readonly ink: HTMLCanvasElement;
  private readonly tail: HTMLCanvasElement;
  private readonly inkCtx: CanvasRenderingContext2D | null;
  private readonly tailCtx: CanvasRenderingContext2D | null;
  /** Pieces of the curve on the `ink` canvas so far (piece i is centred on point i). */
  private pieces = 0;
  private pressure: number | null = null;
  /** Where the pen really is (the points are steadied: they trail it a little), on the image. */
  private pen: { x: number; y: number } | null = null;
  /** The samples as they came — x, y in tenths of a px of the image, pressure in hundredths, ms since the first — for the debug log. */
  private readonly raw: number[] = [];
  private readonly began = performance.now();

  constructor(
    private readonly box: HTMLElement,
    private readonly frame: Frame,
    private readonly pointerType: string,
    readonly color: AnnotationColor,
    readonly width: number,
  ) {
    const boxRect = box.getBoundingClientRect();
    const size = framePixels(boxRect, frame);
    this.w = Math.max(1, size.width);
    this.h = Math.max(1, size.height);
    // The visible part of the image (a zoomed slide is far bigger than the screen), in client px.
    const imageLeft = boxRect.left + frame.x * boxRect.width;
    const imageTop = boxRect.top + frame.y * boxRect.height;
    const view = box.closest('.viewer-scroll')?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    let left = Math.max(imageLeft, view.left - CLIP_MARGIN_PX);
    let top = Math.max(imageTop, view.top - CLIP_MARGIN_PX);
    let right = Math.min(imageLeft + this.w, view.right + CLIP_MARGIN_PX);
    let bottom = Math.min(imageTop + this.h, view.bottom + CLIP_MARGIN_PX);
    if (!(right > left) || !(bottom > top)) [left, top, right, bottom] = [imageLeft, imageTop, imageLeft + this.w, imageTop + this.h];
    const cssW = right - left;
    const cssH = bottom - top;
    const scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)));
    const ink = getComputedStyle(box).getPropertyValue(`--ink-${color}`).trim() || '#1c2230';
    const make = (): [HTMLCanvasElement, CanvasRenderingContext2D | null] => {
      const canvas = document.createElement('canvas');
      canvas.className = 'annot-ink-live';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.width = Math.max(1, Math.round(cssW * scale));
      canvas.height = Math.max(1, Math.round(cssH * scale));
      Object.assign(canvas.style, {
        left: `${left - boxRect.left}px`,
        top: `${top - boxRect.top}px`,
        width: `${cssW}px`,
        height: `${cssH}px`,
      });
      const ctx = canvas.getContext('2d', { desynchronized: true });
      if (ctx) {
        // Drawn in px of the image: the canvas starts at (left − imageLeft, top − imageTop) of it.
        ctx.setTransform(scale, 0, 0, scale, -(left - imageLeft) * scale, -(top - imageTop) * scale);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;
      }
      box.appendChild(canvas);
      return [canvas, ctx];
    };
    [this.ink, this.inkCtx] = make();
    [this.tail, this.tailCtx] = make();
  }

  /** The image's width / height (inkPieces). */
  get aspect(): number {
    return this.w / this.h;
  }

  /**
   * Takes a pointer event of the stroke — every sample of its frame (a sample where the last one was only raises its
   * pressure) — and draws at once: the finished pieces, then the tail with the predicted samples. Returns the samples.
   */
  push(event: InkEvent): InkEvent[] {
    const rect = this.box.getBoundingClientRect();
    const samples = inkSamples(event);
    for (const s of samples) {
      const at = toImagePoint(s.clientX, s.clientY, rect, this.frame);
      if (inkDebug.on) this.raw.push(Math.round(at.x * this.w * 10), Math.round(at.y * this.h * 10), Math.round(s.pressure * 100), Math.round(performance.now() - this.began));
      this.pressure = easedPressure(this.pressure, inkPressure(this.pointerType, s.pressure));
      const last = this.points[this.points.length - 1];
      if (this.pen && this.pen.x === at.x && this.pen.y === at.y) {
        // The pen rests: only its pressure counts.
        if (last) last.p = Math.max(last.p, this.pressure);
        continue;
      }
      this.pen = at;
      const next = steadied(last ?? null, at);
      this.points.push({ x: next.x, y: next.y, p: this.pressure });
    }
    this.commit();
    const predicted = typeof event.getPredictedEvents === 'function' ? event.getPredictedEvents().slice(0, MAX_PREDICTED) : [];
    this.drawTail(predicted.map((s) => toImagePoint(s.clientX, s.clientY, rect, this.frame)));
    return samples;
  }

  /**
   * The pen left: the stroke ends where the pen was (the steadied points trail it), and the tail is drawn without a
   * prediction (the canvases stay until remove()).
   */
  end(): void {
    const last = this.points[this.points.length - 1];
    if (last && this.pen && (last.x !== this.pen.x || last.y !== this.pen.y)) this.points.push({ x: this.pen.x, y: this.pen.y, p: last.p });
    this.pen = null;
    this.commit();
    this.drawTail([]);
    if (inkDebug.on && this.raw.length > 0) inkDebug.raw(`raw ${Math.round(this.w)}x${Math.round(this.h)} w${this.width} ${this.pointerType} ${this.raw.join(',')}`);
  }

  remove(): void {
    this.ink.remove();
    this.tail.remove();
  }

  private x(i: number): number {
    return this.points[i].x * this.w;
  }

  private y(i: number): number {
    return this.points[i].y * this.h;
  }

  /** The line width at point i: the stored stroke's (shared/ink.ts inkOutline). */
  private lineWidth(i: number): number {
    return Math.max(0.6, this.width * this.h * inkPressureScale(this.points[i].p));
  }

  /**
   * Draws the pieces that can no longer change: piece 0 from the first point to the first midpoint, piece i from the
   * midpoint before point i to the one after it, bending at the point (it needs point i + 1).
   */
  private commit(): void {
    const ctx = this.inkCtx;
    const n = this.points.length;
    if (!ctx) return;
    for (; this.pieces <= n - 2; this.pieces++) {
      const i = this.pieces;
      const midX = (this.x(i) + this.x(i + 1)) / 2;
      const midY = (this.y(i) + this.y(i + 1)) / 2;
      ctx.lineWidth = this.lineWidth(i);
      ctx.beginPath();
      if (i === 0) {
        ctx.moveTo(this.x(0), this.y(0));
        ctx.lineTo(midX, midY);
      } else {
        ctx.moveTo((this.x(i - 1) + this.x(i)) / 2, (this.y(i - 1) + this.y(i)) / 2);
        ctx.quadraticCurveTo(this.x(i), this.y(i), midX, midY);
      }
      ctx.stroke();
    }
  }

  /** The part that can still change: from the last midpoint to the pen, then through the predicted points. */
  private drawTail(predicted: readonly { x: number; y: number }[]): void {
    const ctx = this.tailCtx;
    const n = this.points.length;
    if (!ctx || n === 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.tail.width, this.tail.height);
    ctx.restore();
    const last = n - 1;
    ctx.lineWidth = this.lineWidth(last);
    ctx.beginPath();
    if (n === 1) ctx.moveTo(this.x(0), this.y(0));
    else ctx.moveTo((this.x(last - 1) + this.x(last)) / 2, (this.y(last - 1) + this.y(last)) / 2);
    // A lone point is a dot: a zero-length line with round caps.
    ctx.lineTo(this.x(last), this.y(last));
    // On to where the pen really is (the points trail it), then where it is predicted to go.
    if (this.pen) ctx.lineTo(this.pen.x * this.w, this.pen.y * this.h);
    for (const p of predicted) ctx.lineTo(p.x * this.w, p.y * this.h);
    ctx.stroke();
  }
}
