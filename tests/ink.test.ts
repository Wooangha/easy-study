// 펜 strokes (shared/ink.ts, DESIGN §29): the point encoding, the stored rect, simplification, splitting, the outline
// and hit testing.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeInkPoints,
  encodeInkPoints,
  inkDistance,
  inkOutline,
  inkPieces,
  inkRect,
  inkTouches,
  INK_PTS_RE,
  NO_PRESSURE,
  simplifyInk,
  type InkPoint,
} from '../shared/ink.ts';
import { MAX_INK_POINTS } from '../shared/types.ts';

const ASPECT = 16 / 9;
const line = (n: number, from: [number, number], to: [number, number], p = NO_PRESSURE): InkPoint[] =>
  Array.from({ length: n }, (_, i) => ({ x: from[0] + ((to[0] - from[0]) * i) / (n - 1), y: from[1] + ((to[1] - from[1]) * i) / (n - 1), p }));

describe('ink points', () => {
  test('encode → decode keeps every point within a 4096th of the rect and the pressure within a 63rd', () => {
    const points: InkPoint[] = [
      { x: 0.1, y: 0.2, p: 0 },
      { x: 0.25, y: 0.27, p: 0.5 },
      { x: 0.4, y: 0.21, p: 1 },
    ];
    const rect = inkRect(points, 0.005, ASPECT);
    const pts = encodeInkPoints(points, rect);
    assert.match(pts, INK_PTS_RE);
    assert.equal(pts.length, 15);
    const back = decodeInkPoints(pts, rect);
    points.forEach((pt, i) => {
      assert.ok(Math.abs(back[i].x - pt.x) <= rect.w / 4095 + 1e-9);
      assert.ok(Math.abs(back[i].y - pt.y) <= rect.h / 4095 + 1e-9);
      assert.ok(Math.abs(back[i].p - pt.p) <= 1 / 63 / 2 + 1e-9);
    });
  });

  test('invalid encodings decode to nothing', () => {
    for (const bad of ['', 'abcd', 'abcd!', 'abcdef']) assert.deepEqual(decodeInkPoints(bad, { x: 0, y: 0, w: 1, h: 1 }), []);
  });

  test('the rect is padded by the widest half width, never empty, inside the image, on the 4-decimal grid', () => {
    const dot = inkRect([{ x: 0.5, y: 0.5, p: 1 }], 0.005, ASPECT);
    assert.ok(dot.w > 0 && dot.h > 0);
    // Half width at full pressure: 0.005 * 1.5 / 2 of the height; the x padding divided by the aspect.
    assert.ok(Math.abs(dot.h - 0.0075) < 2e-4, JSON.stringify(dot));
    assert.ok(Math.abs(dot.w - 0.0075 / ASPECT) < 2e-4, JSON.stringify(dot));
    const flat = inkRect(line(10, [0.1, 0.3], [0.6, 0.3]), 0.001, ASPECT);
    assert.ok(flat.h >= 0.001);
    const corner = inkRect([{ x: 0, y: 0, p: 1 }], 0.05, ASPECT);
    assert.deepEqual([corner.x, corner.y], [0, 0]);
    for (const r of [dot, flat, corner]) for (const v of [r.x, r.y, r.w, r.h]) assert.equal(Math.round(v * 1e4) / 1e4, v);
  });

  test('simplification keeps the shape and the ends, drops collinear points', () => {
    const straight = line(200, [0.1, 0.1], [0.9, 0.1]);
    const simple = simplifyInk(straight, ASPECT);
    assert.equal(simple.length, 2);
    assert.deepEqual(simple[0], straight[0]);
    assert.deepEqual(simple[1], straight[199]);
    const arc = Array.from({ length: 300 }, (_, i) => ({ x: 0.5 + 0.2 * Math.cos(i / 47), y: 0.5 + 0.2 * Math.sin(i / 47), p: 0.5 }));
    const kept = simplifyInk(arc, ASPECT);
    assert.ok(kept.length > 10 && kept.length < 150, String(kept.length));
  });

  test('a long stroke is split into pieces of at most MAX_INK_POINTS that join', () => {
    const zigzag = Array.from({ length: 5000 }, (_, i) => ({ x: (i % 2) * 0.5 + 0.1, y: i / 5000, p: 0.5 }));
    const pieces = inkPieces(zigzag, 0.005, ASPECT);
    assert.ok(pieces.length >= 3);
    for (const piece of pieces) assert.ok(piece.pts.length / 5 <= MAX_INK_POINTS);
    const ends = pieces.map((piece) => decodeInkPoints(piece.pts, piece.rect));
    for (let k = 1; k < ends.length; k++) {
      const last = ends[k - 1][ends[k - 1].length - 1];
      const first = ends[k][0];
      assert.ok(Math.hypot(last.x - first.x, last.y - first.y) < 1e-3);
    }
  });
});

describe('ink outline and hit testing', () => {
  test('the outline is a closed path; a dot is a circle; widths follow the pressure', () => {
    const d = inkOutline(line(20, [0.1, 0.5], [0.5, 0.5]), 0.005, 1778, 1000);
    assert.match(d, /^M[\d.\- ]+.*Z$/);
    assert.match(inkOutline([{ x: 0.5, y: 0.5, p: 0.5 }], 0.005, 1778, 1000), /^M.*a.*a.*Z$/);
    assert.equal(inkOutline([], 0.005, 100, 100), '');
    // The path starts on the left edge of the ribbon: its distance from the centre line is the half width.
    const halfWidth = (path: string) => Math.abs(Number(/^M[\d.\-]+ ([\d.\-]+)/.exec(path)![1]) - 500);
    const light = halfWidth(inkOutline(line(20, [0.1, 0.5], [0.5, 0.5], 0), 0.01, 1000, 1000));
    const heavy = halfWidth(inkOutline(line(20, [0.1, 0.5], [0.5, 0.5], 1), 0.01, 1000, 1000));
    assert.equal(light, 2.5);
    assert.equal(heavy, 7.5);
  });

  test('distance and eraser touches are measured in pixels of the image', () => {
    const stroke = line(5, [0.1, 0.5], [0.5, 0.5]);
    assert.ok(inkDistance(stroke, 0.3, 0.5, 1000, 1000) < 1e-9);
    assert.ok(Math.abs(inkDistance(stroke, 0.3, 0.52, 1000, 1000) - 20) < 1e-6);
    // An eraser move crossing the stroke touches it; one passing 30 px away with a 5 px radius does not.
    assert.equal(inkTouches(stroke, 0.005, { x: 0.3, y: 0.4 }, { x: 0.3, y: 0.6 }, 1000, 1000, 5), true);
    assert.equal(inkTouches(stroke, 0.005, { x: 0.3, y: 0.53 }, { x: 0.4, y: 0.53 }, 1000, 1000, 5), false);
    assert.equal(inkTouches(stroke, 0.005, { x: 0.3, y: 0.508 }, { x: 0.4, y: 0.508 }, 1000, 1000, 5), true);
  });
});
