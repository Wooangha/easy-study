// 텍스트 형광 (DESIGN §25): a drag over the slide's text layer becomes a highlight fitted to the words — the nearest
// word to the drag's start and end in reading order (the layout's line order, then the coordinate along the line's
// direction), the PDFium char range between them, one rect per line. Pure, no DOM. Also the re-anchoring of a stored
// item after the text engine changed (its `chars` may not mean the same glyphs any more: its words are searched).
import type { LayoutBox, RegionRect, SlideTextLayout } from '../../../../shared/types.ts';
import type { Point } from '../attachments.ts';
import { unionRects } from './geometry.ts';

type LayoutLine = SlideTextLayout['lines'][number];
type LayoutWord = LayoutLine['words'][number];

export interface TextFit {
  rects: RegionRect[];
  chars: [number, number];
  text: string;
  engine: string;
}

const boxRect = (r: LayoutBox): RegionRect => ({ x: r[0], y: r[1], w: r[2], h: r[3] });

/** Position of `p` across and along a line's direction, and the line's own extents. */
function project(r: LayoutBox, dir: 'h' | 'v', p: Point) {
  const [x, y, w, h] = r;
  return dir === 'h'
    ? { across: p.y, along: p.x, minor: [y, y + h] as const, major: [x, x + w] as const }
    : { across: p.x, along: p.y, minor: [x, x + w] as const, major: [y, y + h] as const };
}

/** Distance of `v` outside [lo, hi] (0 inside). */
const outside = (v: number, lo: number, hi: number): number => (v < lo ? lo - v : v > hi ? v - hi : 0);

/**
 * The index of the line nearest to `p`: the one containing it across its direction, else the smallest distance
 * across (ties: the one nearer along). −1 for a layout without words.
 */
export function nearestLine(layout: SlideTextLayout, p: Point): number {
  let best = -1;
  let bestAcross = Infinity;
  let bestAlong = Infinity;
  layout.lines.forEach((line, i) => {
    if (line.words.length === 0) return;
    const { across, along, minor, major } = project(line.r, line.dir, p);
    const dAcross = outside(across, minor[0], minor[1]);
    const dAlong = outside(along, major[0], major[1]);
    if (dAcross < bestAcross || (dAcross === bestAcross && dAlong < bestAlong)) {
      best = i;
      bestAcross = dAcross;
      bestAlong = dAlong;
    }
  });
  return best;
}

/** The word of `line` nearest to `p` along the line's direction (before the first → the first, past the last → the last). */
export function nearestWordIndex(line: LayoutLine, p: Point): number {
  let best = 0;
  let bestDistance = Infinity;
  line.words.forEach((word, i) => {
    const { along, major } = project(word.r, line.dir, p);
    const d = outside(along, major[0], major[1]);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

/** Reading-order position of a point: its line and word. Null when the layout has no words. */
export function wordAt(layout: SlideTextLayout, p: Point): { line: number; word: number } | null {
  const line = nearestLine(layout, p);
  if (line === -1) return null;
  return { line, word: nearestWordIndex(layout.lines[line], p) };
}

/** Rects (one per line, the union of the words in the char range), the text and the range of a word span. */
function fitRange(layout: SlideTextLayout, start: number, end: number): TextFit | null {
  const rects: RegionRect[] = [];
  const lines: string[] = [];
  for (const line of layout.lines) {
    const words = line.words.filter((w) => w.c[0] < end && w.c[1] > start);
    if (words.length === 0) continue;
    rects.push(unionRects(words.map((w) => boxRect(w.r))));
    lines.push(words.map((w) => w.t).join(' '));
  }
  if (rects.length === 0) return null;
  return { rects, chars: [start, end], text: lines.join('\n'), engine: layout.engine };
}

/**
 * The text highlight of a drag from `from` to `to`: the words between the nearest word to each end (in reading
 * order), as `chars` = [min start, max end), one rect per line and the words' text. Null when the layout has no
 * words (the caller falls back to a plain band).
 */
export function textHighlightFromDrag(from: Point, to: Point, layout: SlideTextLayout): TextFit | null {
  const a = wordAt(layout, from);
  const b = wordAt(layout, to);
  if (!a || !b) return null;
  const [first, last] = a.line < b.line || (a.line === b.line && a.word <= b.word) ? [a, b] : [b, a];
  const wa: LayoutWord = layout.lines[first.line].words[first.word];
  const wb: LayoutWord = layout.lines[last.line].words[last.word];
  const start = Math.min(wa.c[0], wb.c[0]);
  const end = Math.max(wa.c[1], wb.c[1]);
  return fitRange(layout, start, end);
}

/** The words of `text` as the layout would list them (whitespace-separated). */
const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * A stored text highlight against a layout: when the layout's engine is the one the item's `chars` came from, the
 * item is trusted (null = no change). Otherwise its words are searched in the layout (the first run of words equal
 * to the item's text) and the fit is recomputed there; null too when they are not found (the item keeps its rects).
 */
export function reanchorTextHighlight(
  item: { chars: [number, number]; engine: string; text: string },
  layout: SlideTextLayout,
): TextFit | null {
  if (item.engine === layout.engine) return null;
  const wanted = wordsOf(item.text);
  if (wanted.length === 0) return null;
  const all: LayoutWord[] = layout.lines.flatMap((l) => l.words);
  for (let i = 0; i + wanted.length <= all.length; i++) {
    let ok = true;
    for (let j = 0; j < wanted.length; j++) {
      if (all[i + j].t !== wanted[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = all[i].c[0];
    const end = all[i + wanted.length - 1].c[1];
    return fitRange(layout, Math.min(start, end), Math.max(start, end));
  }
  return null;
}
