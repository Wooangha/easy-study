// 펜 strokes (DESIGN §29): the point encoding of InkItem.pts, simplification, the filled outline a stroke is drawn as
// (its width follows the pen pressure) and hit testing. Shared by the web client (live drawing, rendering, the eraser,
// selection) and the image worker (a 📎 of handwriting draws the strokes into the crop). No dependencies.
//
// Geometry: points are normalised 0..1 to the slide image like every annotation; the outline and every distance are
// computed in pixels of a box `w` × `h` with the image's aspect (a stroke must not be squashed by a non-square image).
import { MAX_INK_POINTS, type InkItem, type RegionRect } from './types.ts';

/** One sample: x, y on the image (0..1) and the pen pressure (0..1; NO_PRESSURE for a mouse or a finger). */
export interface InkPoint {
  x: number;
  y: number;
  p: number;
}

/** The pressure of input without one (a mouse, a finger, a pen that reports none): a stroke of the nominal width. */
export const NO_PRESSURE = 0.5;
/** Characters per point in InkItem.pts. */
export const INK_POINT_CHARS = 5;
/** InkItem.pts: one or more points of 5 base64url characters. */
export const INK_PTS_RE = /^(?:[A-Za-z0-9_-]{5})+$/;
/** The box height the points are simplified in (px); the width follows the image's aspect. */
export const INK_SIMPLIFY_HEIGHT = 1000;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();
const COORD_MAX = 4095;
const PRESSURE_MAX = 63;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Encodes points (image coordinates) relative to `rect` (InkItem.pts). Points outside the rect are clamped to it. */
export function encodeInkPoints(points: readonly InkPoint[], rect: RegionRect): string {
  let out = '';
  for (const pt of points) {
    const qx = Math.round(clamp01(rect.w > 0 ? (pt.x - rect.x) / rect.w : 0) * COORD_MAX);
    const qy = Math.round(clamp01(rect.h > 0 ? (pt.y - rect.y) / rect.h : 0) * COORD_MAX);
    const qp = Math.round(clamp01(pt.p) * PRESSURE_MAX);
    out += ALPHABET[qx >> 6] + ALPHABET[qx & 63] + ALPHABET[qy >> 6] + ALPHABET[qy & 63] + ALPHABET[qp];
  }
  return out;
}

/** The points of InkItem.pts in image coordinates ([] when `pts` is not a valid encoding). */
export function decodeInkPoints(pts: string, rect: RegionRect): InkPoint[] {
  if (!INK_PTS_RE.test(pts)) return [];
  const points: InkPoint[] = [];
  for (let i = 0; i < pts.length; i += INK_POINT_CHARS) {
    const v = (k: number) => VALUE[pts.charCodeAt(i + k)];
    const qx = (v(0) << 6) | v(1);
    const qy = (v(2) << 6) | v(3);
    points.push({ x: rect.x + (qx / COORD_MAX) * rect.w, y: rect.y + (qy / COORD_MAX) * rect.h, p: v(4) / PRESSURE_MAX });
  }
  return points;
}

/** The decoded points of a stored stroke, cached per item object (items are replaced, never mutated). */
const decoded = new WeakMap<object, InkPoint[]>();
export function inkPointsOf(item: Pick<InkItem, 'rect' | 'pts'>): InkPoint[] {
  let points = decoded.get(item);
  if (!points) {
    points = decodeInkPoints(item.pts, item.rect);
    decoded.set(item, points);
  }
  return points;
}

/**
 * The width factor of a pressure: 0.7 … 1.3 times the nominal width, 1 at NO_PRESSURE. A gentle range: handwriting
 * presses anywhere from 0.1 to 0.7, and a wider range makes notes look blotchy.
 */
export function inkPressureScale(p: number): number {
  return 0.7 + 0.6 * clamp01(p);
}

/** The stroke's radius in px at full pressure, for a box `h` px tall. */
export function inkMaxRadius(width: number, h: number): number {
  return (width * h * inkPressureScale(1)) / 2;
}

/**
 * The stored rect of a stroke: the points' bounding box padded by its widest half width (`aspect` = the image's width /
 * height), clamped to the image, at least 0.001 wide and tall, on the 4-decimal grid (rounded outwards).
 */
export function inkRect(points: readonly InkPoint[], width: number, aspect: number): RegionRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pt of points) {
    x0 = Math.min(x0, pt.x);
    y0 = Math.min(y0, pt.y);
    x1 = Math.max(x1, pt.x);
    y1 = Math.max(y1, pt.y);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0.001, h: 0.001 };
  const padY = (width * inkPressureScale(1)) / 2;
  const padX = padY / (aspect > 0 ? aspect : 1);
  const down = (v: number) => Math.floor(clamp01(v) * 1e4) / 1e4;
  const up = (v: number) => Math.ceil(clamp01(v) * 1e4) / 1e4;
  let left = down(x0 - padX);
  let top = down(y0 - padY);
  let right = up(x1 + padX);
  let bottom = up(y1 + padY);
  if (right - left < 0.001) [left, right] = left + 0.001 <= 1 ? [left, left + 0.001] : [right - 0.001, right];
  if (bottom - top < 0.001) [top, bottom] = top + 0.001 <= 1 ? [top, top + 0.001] : [bottom - 0.001, bottom];
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return { x: r4(left), y: r4(top), w: r4(right - left), h: r4(bottom - top) };
}

/**
 * Drops points the stroke does not need (Ramer–Douglas–Peucker in px of a box INK_SIMPLIFY_HEIGHT tall, the pressure
 * counted as a third axis), keeping the ends. `tolerance` in px: tiny, so only points on a straight run go — the
 * stroke is drawn as a curve through its points (inkCurve), and that curve must stay the one the pen drew.
 */
export function simplifyInk(points: readonly InkPoint[], aspect: number, tolerance = 0.08): InkPoint[] {
  if (points.length <= 2) return points.slice();
  const h = INK_SIMPLIFY_HEIGHT;
  const w = h * (aspect > 0 ? aspect : 1);
  const pressureAxis = 6; // px per unit of pressure: a clear change of width is kept
  const xs = points.map((pt) => pt.x * w);
  const ys = points.map((pt) => pt.y * h);
  const ps = points.map((pt) => pt.p * pressureAxis);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bestDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance3(xs[i], ys[i], ps[i], xs[a], ys[a], ps[a], xs[b], ys[b], ps[b]);
      if (d > bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function segmentDistance3(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = dx * dx + dy * dy + dz * dz;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy), pz - (az + t * dz));
}

/**
 * A finished stroke as stored items' geometry: simplified, split into pieces of at most MAX_INK_POINTS (each piece
 * starts where the previous one ended), each with its rect and encoded points. `aspect` = the image's width / height.
 */
export function inkPieces(points: readonly InkPoint[], width: number, aspect: number): { rect: RegionRect; pts: string }[] {
  const simple = simplifyInk(points, aspect);
  const pieces: { rect: RegionRect; pts: string }[] = [];
  for (let start = 0; start < simple.length; start += MAX_INK_POINTS - 1) {
    const part = simple.slice(start, start + MAX_INK_POINTS);
    if (part.length === 0 || (start > 0 && part.length < 2)) break;
    const rect = inkRect(part, width, aspect);
    pieces.push({ rect, pts: encodeInkPoints(part, rect) });
  }
  return pieces;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
/** inkOutline samples the centre line so neighbours are at most this far apart (px). */
const CURVE_STEP_PX = 2.5;

/**
 * The centre line of a stroke in px of a `w` × `h` box, with the half width at each sample: the curve the live canvas
 * draws (components/annotations/liveInk.ts) — from the first point straight to the first midpoint, then from midpoint
 * to midpoint bending at each point (a quadratic B-spline: smooth where the pen moved fast and the samples are far
 * apart, tight where it slowed down for a corner), then straight to the last point — sampled every CURVE_STEP_PX.
 */
function inkCurve(points: readonly InkPoint[], width: number, w: number, h: number): { xs: number[]; ys: number[]; rs: number[]; peak: number } {
  const base = (width * h) / 2;
  // To pixels, without points closer than 0.25 px to the previous one.
  const px: number[] = [];
  const py: number[] = [];
  const pr: number[] = [];
  for (const pt of points) {
    const x = pt.x * w;
    const y = pt.y * h;
    const r = Math.max(0.3, base * inkPressureScale(pt.p));
    const n = px.length;
    if (n > 0 && Math.hypot(x - px[n - 1], y - py[n - 1]) < 0.25) {
      pr[n - 1] = Math.max(pr[n - 1], r);
      continue;
    }
    px.push(x);
    py.push(y);
    pr.push(r);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  const rs: number[] = [];
  const n = px.length;
  // The widest the pen pressed (the curve's own half widths are blended between the points).
  const peak = pr.reduce((max, r) => Math.max(max, r), 0);
  if (n === 0) return { xs, ys, rs, peak };
  xs.push(px[0]);
  ys.push(py[0]);
  rs.push(pr[0]);
  if (n === 1) return { xs, ys, rs, peak };
  const line = (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) => {
    const steps = Math.min(400, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / CURVE_STEP_PX)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      xs.push(x0 + (x1 - x0) * t);
      ys.push(y0 + (y1 - y0) * t);
      rs.push(r0 + (r1 - r0) * t);
    }
  };
  const mid = (i: number) => [(px[i] + px[i + 1]) / 2, (py[i] + py[i + 1]) / 2, (pr[i] + pr[i + 1]) / 2] as const;
  let [mx, my, mr] = mid(0);
  line(px[0], py[0], pr[0], mx, my, mr);
  for (let i = 1; i <= n - 2; i++) {
    const [nx, ny, nr] = mid(i);
    const steps = Math.min(400, Math.max(1, Math.ceil((Math.hypot(px[i] - mx, py[i] - my) + Math.hypot(nx - px[i], ny - py[i])) / CURVE_STEP_PX)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const a = (1 - t) * (1 - t);
      const b = 2 * t * (1 - t);
      const c = t * t;
      xs.push(a * mx + b * px[i] + c * nx);
      ys.push(a * my + b * py[i] + c * ny);
      rs.push(a * mr + b * pr[i] + c * nr);
    }
    [mx, my, mr] = [nx, ny, nr];
  }
  line(mx, my, mr, px[n - 1], py[n - 1], pr[n - 1]);
  return { xs, ys, rs, peak };
}

/**
 * The filled outline of a stroke as an SVG path in a box of `w` × `h` px: a ribbon along the stroke's curve (inkCurve)
 * whose half width follows the pressure (`width` = InkItem.width, a fraction of `h`), with round ends; a tap is a dot.
 */
export function inkOutline(points: readonly InkPoint[], width: number, w: number, h: number): string {
  const { xs, ys, rs, peak } = inkCurve(points, width, w, h);
  const n = xs.length;
  if (n === 0) return '';
  // A tap (the whole stroke inside its widest disc: a few samples while the pressure ramps up) is a dot of the widest
  // size, not a ribbon between two discs of different sizes.
  let widest = 0;
  let spread = 0;
  for (let i = 0; i < n; i++) {
    if (rs[i] > rs[widest]) widest = i;
    spread = Math.max(spread, Math.hypot(xs[i] - xs[0], ys[i] - ys[0]));
  }
  if (n === 1 || spread <= peak) return circle(xs[widest], ys[widest], peak, false);
  const lx: number[] = [];
  const ly: number[] = [];
  const rx: number[] = [];
  const ry: number[] = [];
  let tx = 1;
  let ty = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      tx = dx / len;
      ty = dy / len;
    }
    // The normal to the left of the direction of travel (y down: rotated +90°).
    const nx = -ty;
    const ny = tx;
    lx.push(xs[i] + nx * rs[i]);
    ly.push(ys[i] + ny * rs[i]);
    rx.push(xs[i] - nx * rs[i]);
    ry.push(ys[i] - ny * rs[i]);
  }
  const side = (px: number[], py: number[], order: number[]) => {
    let d = '';
    for (let k = 1; k < order.length - 1; k++) {
      const i = order[k];
      const j = order[k + 1];
      d += `Q${fmt(px[i])} ${fmt(py[i])} ${fmt((px[i] + px[j]) / 2)} ${fmt((py[i] + py[j]) / 2)}`;
    }
    const last = order[order.length - 1];
    return d + `L${fmt(px[last])} ${fmt(py[last])}`;
  };
  const forward = Array.from({ length: n }, (_, i) => i);
  const backward = forward.slice().reverse();
  const end = n - 1;
  const ribbon =
    `M${fmt(lx[0])} ${fmt(ly[0])}` +
    side(lx, ly, forward) +
    // Round end: from the left edge to the right edge around the front.
    `A${fmt(rs[end])} ${fmt(rs[end])} 0 0 0 ${fmt(rx[end])} ${fmt(ry[end])}` +
    side(rx, ry, backward) +
    // Round start, around the back.
    `A${fmt(rs[0])} ${fmt(rs[0])} 0 0 0 ${fmt(lx[0])} ${fmt(ly[0])}Z`;
  // A sharp turn (a V, an N, a ㅅ written fast) loses its round tip in the ribbon: a disc at the sharpest point of each
  // turn puts it back, wound like the ribbon so the nonzero fill does not cut a hole where they overlap.
  const turns = sharpTurns(xs, ys);
  if (turns.length === 0) return ribbon;
  let area = 0;
  const ring = [...forward.map((i) => [lx[i], ly[i]]), ...backward.map((i) => [rx[i], ry[i]])];
  for (let k = 0; k < ring.length; k++) {
    const [x0, y0] = ring[k];
    const [x1, y1] = ring[(k + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  return ribbon + turns.map((i) => circle(xs[i], ys[i], rs[i], area > 0)).join('');
}

/** A circle subpath; `clockwise` (on screen, y down) picks its winding. */
function circle(x: number, y: number, r: number, clockwise: boolean): string {
  const sweep = clockwise ? 1 : 0;
  return `M${fmt(x - r)} ${fmt(y)}a${fmt(r)} ${fmt(r)} 0 1 ${sweep} ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 ${sweep} ${fmt(-2 * r)} 0Z`;
}

/** Points of a centre line (every ~2.5 px) where it turns by more than ~100° within ±3 points: the sharpest of each turn. */
function sharpTurns(xs: readonly number[], ys: readonly number[]): number[] {
  const k = 3;
  const n = xs.length;
  const cos = new Float64Array(n).fill(1);
  for (let i = k; i < n - k; i++) {
    const ax = xs[i] - xs[i - k];
    const ay = ys[i] - ys[i - k];
    const bx = xs[i + k] - xs[i];
    const by = ys[i + k] - ys[i];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la > 1e-6 && lb > 1e-6) cos[i] = (ax * bx + ay * by) / (la * lb);
  }
  const out: number[] = [];
  for (let i = k; i < n - k; i++) {
    if (cos[i] > -0.17) continue;
    let sharpest = true;
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) if (cos[j] < cos[i] || (cos[j] === cos[i] && j < i)) sharpest = false;
    if (sharpest) out.push(i);
  }
  return out;
}

/** The distance in px (box `w` × `h`) from a point (image coordinates) to a stroke's centre line. */
export function inkDistance(points: readonly InkPoint[], x: number, y: number, w: number, h: number): number {
  if (points.length === 0) return Infinity;
  const px = x * w;
  const py = y * h;
  let best = Math.hypot(points[0].x * w - px, points[0].y * h - py);
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, pointSegment(px, py, points[i - 1].x * w, points[i - 1].y * h, points[i].x * w, points[i].y * h));
  }
  return best;
}

/**
 * Whether the segment a → b (image coordinates; an eraser's move) comes within `radius` px (box `w` × `h`) of a stroke's
 * centre line, or of its own width at that point.
 */
export function inkTouches(
  points: readonly InkPoint[],
  width: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  w: number,
  h: number,
  radius: number,
): boolean {
  const ax = a.x * w;
  const ay = a.y * h;
  const bx = b.x * w;
  const by = b.y * h;
  const reach = radius + (width * h * inkPressureScale(1)) / 2;
  if (points.length === 1) return pointSegment(points[0].x * w, points[0].y * h, ax, ay, bx, by) <= reach;
  for (let i = 1; i < points.length; i++) {
    const d = segmentSegment(points[i - 1].x * w, points[i - 1].y * h, points[i].x * w, points[i].y * h, ax, ay, bx, by);
    if (d <= reach) return true;
  }
  return false;
}

function pointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segmentSegment(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  // Crossing segments are 0 apart; else the nearest endpoint-to-segment distance.
  const cross = (ux: number, uy: number, vx: number, vy: number) => ux * vy - uy * vx;
  const d1 = cross(bx - ax, by - ay, cx - ax, cy - ay);
  const d2 = cross(bx - ax, by - ay, dx - ax, dy - ay);
  const d3 = cross(dx - cx, dy - cy, ax - cx, ay - cy);
  const d4 = cross(dx - cx, dy - cy, bx - cx, by - cy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    pointSegment(ax, ay, cx, cy, dx, dy),
    pointSegment(bx, by, cx, cy, dx, dy),
    pointSegment(cx, cy, ax, ay, bx, by),
    pointSegment(dx, dy, ax, ay, bx, by),
  );
}
