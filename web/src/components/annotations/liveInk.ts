// The stroke being written with 펜 (DESIGN §29), drawn imperatively — no React state per point: an <svg> over the
// slide image (its viewBox the image's size in px at the press, so the stroke keeps its shape) whose one path is the
// outline of the samples so far, redrawn once per animation frame by the viewer. The slide box's position is measured
// once per frame (the samples of one frame share it). On release the viewer turns `points` into items (inkPieces) and
// removes the overlay a frame later, once the layer draws the stored stroke.
import { inkOutline, type InkPoint } from '../../../../shared/ink.ts';
import type { AnnotationColor } from '../../../../shared/types.ts';
import { inkPressure } from '../../lib/annotations/ink.ts';
import { framePixels, percentStyle, toImagePoint, type Frame } from '../../lib/attachments.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** What a sample needs of a PointerEvent. */
export type InkSample = Pick<PointerEvent, 'clientX' | 'clientY' | 'pressure'>;

export class LiveInk {
  /** On the image (0..1), with the pressure. */
  readonly points: InkPoint[] = [];
  /** The image's size in px at the press: the overlay's viewBox and the outline's box. */
  readonly w: number;
  readonly h: number;
  private readonly svg: SVGSVGElement;
  private readonly path: SVGPathElement;
  private rect: DOMRect | null = null;

  constructor(
    private readonly box: HTMLElement,
    private readonly frame: Frame,
    private readonly pointerType: string,
    readonly color: AnnotationColor,
    readonly width: number,
  ) {
    const size = framePixels(box.getBoundingClientRect(), frame);
    this.w = Math.max(1, size.width);
    this.h = Math.max(1, size.height);
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'annot-ink-live');
    this.svg.setAttribute('viewBox', `0 0 ${this.w} ${this.h}`);
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.setAttribute('aria-hidden', 'true');
    Object.assign(this.svg.style, percentStyle(frame));
    this.path = document.createElementNS(SVG_NS, 'path');
    this.path.setAttribute('class', `kind-ink is-${color}`);
    this.svg.appendChild(this.path);
    box.appendChild(this.svg);
  }

  /** The image's width / height (inkPieces). */
  get aspect(): number {
    return this.w / this.h;
  }

  /** Adds the samples of one pointer event (a sample where the last one was only updates its pressure). */
  add(samples: readonly InkSample[]): void {
    this.rect ??= this.box.getBoundingClientRect();
    for (const s of samples) {
      const at = toImagePoint(s.clientX, s.clientY, this.rect, this.frame);
      const p = inkPressure(this.pointerType, s.pressure);
      const last = this.points[this.points.length - 1];
      if (last && last.x === at.x && last.y === at.y) last.p = Math.max(last.p, p);
      else this.points.push({ x: at.x, y: at.y, p });
    }
  }

  /** Draws the outline of the points so far (once per animation frame); the box is measured again for the next one. */
  draw(): void {
    this.rect = null;
    this.path.setAttribute('d', inkOutline(this.points, this.width, this.w, this.h));
  }

  remove(): void {
    this.svg.remove();
  }
}
