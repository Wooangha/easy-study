// Matching a lecture's old slides to the slides of its new version (server/slideMatch.ts, DESIGN §28): synthetic
// decks of text + word boxes + small pictures — removed, inserted, moved, edited and renumbered slides, step-by-step
// builds, an unrelated deck, and the Hungarian assignment against brute force.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SlideTextLayout } from '../shared/types.ts';
import { assign, changedPixels, comparableText, matchSlides, slideNumberBoxes, THUMB_H, THUMB_W, type SlideFeatures } from '../server/slideMatch.ts';

const WORDS = (
  'parser grammar token lookahead production terminal symbol derivation recursive descent table stack first follow ' +
  'ambiguity precedence associativity expression factor term goal start rule left right sentential form handle shift ' +
  'reduce item closure state automaton lexer scanner regular language context free leftmost rightmost tree node'
).split(' ');

/** Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  lines: string[];
  /** The slide number printed in the bottom margin. */
  number?: number;
  /** Seed of the picture's blocks. */
  picture: number;
}

/** A slide's features as the server builds them: text lines, word boxes (number in the bottom margin) and a picture. */
function slide(spec: Spec): SlideFeatures {
  const layout: SlideTextLayout['lines'] = spec.lines.map((line, i) => ({
    r: [0.1, 0.15 + i * 0.08, 0.8, 0.05],
    dir: 'h',
    words: line.split(' ').map((t, k) => ({ r: [0.1 + k * 0.08, 0.15 + i * 0.08, 0.07, 0.05], t, c: [k, k + 1] as [number, number] })),
  }));
  if (spec.number !== undefined) {
    layout.push({ r: [0.92, 0.94, 0.04, 0.03], dir: 'h', words: [{ r: [0.92, 0.94, 0.04, 0.03], t: String(spec.number), c: [0, 1] }] });
  }
  const thumb = new Uint8Array(THUMB_W * THUMB_H).fill(250);
  const r = rng(spec.picture);
  // Text lines as dark bars, then a few blocks for the picture.
  spec.lines.forEach((line, i) => {
    const y = Math.floor((0.15 + i * 0.08) * THUMB_H);
    for (let x = 12; x < 12 + Math.min(100, line.length); x++) thumb[y * THUMB_W + x] = 40;
  });
  for (let k = 0; k < 4; k++) {
    const x0 = Math.floor(r() * (THUMB_W - 20));
    const y0 = Math.floor(THUMB_H * 0.5 + r() * (THUMB_H * 0.3));
    const shade = Math.floor(r() * 200);
    for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 16; x++) thumb[y * THUMB_W + x] = shade;
  }
  if (spec.number !== undefined) {
    // The slide number's glyphs.
    const y = Math.floor(0.95 * THUMB_H);
    for (let x = 118; x < 118 + String(spec.number).length * 2; x++) thumb[y * THUMB_W + x] = 30 + ((spec.number * 37) % 100);
  }
  const text = [...spec.lines, ...(spec.number !== undefined ? [String(spec.number)] : [])].join('\n');
  return { text, layout, thumb };
}

/** A deck of `count` distinct slides with the same title bar and footer (boilerplate on every slide). */
function deck(count: number, seed = 1): Spec[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => ({
    lines: [
      `Compilers lecture ${seed}`,
      ...Array.from({ length: 4 }, () =>
        Array.from({ length: 6 }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' '),
      ),
      'Department of Computer Science',
    ],
    number: i + 1,
    picture: seed * 1000 + i,
  }));
}

const renumber = (specs: Spec[]) => specs.map((s, i) => ({ ...s, number: i + 1 }));
const features = (specs: Spec[]) => specs.map(slide);

describe('slide matching', () => {
  test('the same deck again: every slide is the same, nothing removed or moved', () => {
    const specs = deck(30);
    const result = matchSlides(features(specs), features(specs));
    assert.deepEqual(
      result.slides.map((s) => [s.from, s.change, s.moved ?? false]),
      specs.map((_, i) => [i + 1, 'same', false]),
    );
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.oldToNew, specs.map((_, i) => i + 1));
  });

  test('removed, inserted, moved and edited slides; slide numbers renumbered everywhere', () => {
    const old = deck(30);
    const next = old.map((s) => ({ ...s }));
    // Remove old 8 and old 21; insert two slides of another deck; move old 4 behind old 25; edit old 12 and 17.
    next.splice(20, 1);
    next.splice(7, 1);
    const extra = deck(5, 7);
    next.splice(10, 0, extra[1]);
    next.splice(26, 0, extra[3]);
    const [moved] = next.splice(3, 1);
    next.splice(next.findIndex((s) => s.picture === 1000 + 24) + 1, 0, moved);
    for (const k of [11, 16]) {
      const at = next.findIndex((s) => s.picture === 1000 + k);
      next[at] = { ...next[at], lines: next[at].lines.map((l, i) => (i === 2 ? `${l} revised example` : l)) };
    }
    const result = matchSlides(features(old), features(renumber(next)));

    const want = next.map((s) => (s.picture >= 7000 ? null : s.picture - 1000 + 1));
    assert.deepEqual(
      result.slides.map((s) => s.from),
      want,
    );
    assert.deepEqual(result.removed, [8, 21]);
    const byOld = new Map(result.slides.filter((s) => s.from).map((s) => [s.from, s]));
    assert.equal(byOld.get(12)?.change, 'changed');
    assert.equal(byOld.get(17)?.change, 'changed');
    assert.equal(byOld.get(4)?.moved, true);
    // Renumbering alone (every slide after the first change has a new number) is not a change.
    const changed = result.slides.filter((s) => s.change === 'changed').map((s) => s.from);
    assert.deepEqual(changed.sort((a, b) => a! - b!), [12, 17]);
    assert.equal(result.slides.filter((s) => s.change === 'new').length, 2);
  });

  test('a picture change on an otherwise identical slide is a change; the slide number is not', () => {
    const old = deck(6);
    const next = old.map((s) => ({ ...s }));
    next[2] = { ...next[2], picture: 99 };
    const a = features(old);
    const b = features(next.map((s, i) => ({ ...s, number: i + 11 })));
    const result = matchSlides(a, b);
    assert.deepEqual(
      result.slides.map((s) => s.change),
      ['same', 'same', 'changed', 'same', 'same', 'same'],
    );
  });

  test('step-by-step builds (near-duplicate slides) keep their order', () => {
    const base = deck(1)[0];
    const builds: Spec[] = Array.from({ length: 5 }, (_, k) => ({
      lines: [...base.lines.slice(0, 2 + k)],
      number: k + 1,
      picture: 500,
    }));
    const old = [...deck(3, 3), ...builds, ...deck(3, 4)].map((s, i) => ({ ...s, number: i + 1 }));
    const next = old.filter((_, i) => i !== 1);
    const result = matchSlides(features(old), features(renumber(next)));
    assert.deepEqual(
      result.slides.map((s) => s.from),
      old.map((_, i) => i + 1).filter((n) => n !== 2),
    );
    assert.deepEqual(result.removed, [2]);
  });

  test('an unrelated deck matches (almost) nothing', () => {
    const result = matchSlides(features(deck(20, 1)), features(deck(20, 2)));
    assert.ok(result.slides.filter((s) => s.from !== null).length <= 2, JSON.stringify(result.slides.map((s) => s.from)));
  });

  test('slides without text compare by their picture', () => {
    const pic = (picture: number): Spec => ({ lines: [], picture });
    const old = [pic(1), pic(2), pic(3), pic(4)];
    const result = matchSlides(features(old), features([pic(1), pic(3), pic(4), pic(9)]));
    assert.deepEqual(
      result.slides.map((s) => s.from),
      [1, 3, 4, null],
    );
    assert.deepEqual(result.removed, [2]);
  });

  test('empty decks', () => {
    assert.deepEqual(matchSlides([], []), { slides: [], removed: [], oldToNew: [] });
    const one = features(deck(1));
    assert.deepEqual(matchSlides(one, []).removed, [1]);
    assert.deepEqual(
      matchSlides([], one).slides.map((s) => s.change),
      ['new'],
    );
  });

  test('a deck too big for the assignment falls back to the alignment and still matches', () => {
    const old = deck(520, 5);
    const next = old.filter((_, i) => i % 50 !== 7);
    const result = matchSlides(features(old), features(renumber(next)));
    assert.deepEqual(
      result.removed,
      old.map((_, i) => i + 1).filter((n) => (n - 1) % 50 === 7),
    );
    assert.ok(result.slides.every((s) => s.change === 'same'));
  });
});

describe('comparable text and slide numbers', () => {
  test('the slide number is found by its box in the margin, other numbers stay', () => {
    const s = slide({ lines: ['Rule 4 applies', 'x = 2 * y'], number: 13, picture: 1 });
    assert.deepEqual(slideNumberBoxes(s.layout), [[0.92, 0.94, 0.04, 0.03]]);
    assert.equal(comparableText(s), 'rule4appliesx=2*y');
  });

  test('without word boxes, lines that are only a page number are dropped', () => {
    assert.equal(comparableText({ text: 'Title\n12\nBody text 3\nslide 4 of 40', layout: null }), 'titlebodytext3');
  });

  test('changed pixels ignore the given boxes', () => {
    const a = new Uint8Array(THUMB_W * THUMB_H).fill(255);
    const b = a.slice();
    for (let x = 100; x < 110; x++) b[90 * THUMB_W + x] = 0;
    assert.ok(changedPixels(a, b) > 0);
    assert.equal(changedPixels(a, b, [[100 / THUMB_W, 90 / THUMB_H, 10 / THUMB_W, 1 / THUMB_H]]), 0);
  });
});

describe('assignment (Hungarian method)', () => {
  function brute(cost: number[][]): number {
    const n = cost.length;
    const m = cost[0].length;
    let best = Infinity;
    const used = new Array<boolean>(m).fill(false);
    const go = (i: number, sum: number) => {
      if (i === n) return void (best = Math.min(best, sum));
      for (let j = 0; j < m; j++) {
        if (used[j]) continue;
        used[j] = true;
        go(i + 1, sum + cost[i][j]);
        used[j] = false;
      }
    };
    go(0, 0);
    return best;
  }

  test('finds a minimum-cost assignment', () => {
    const r = rng(42);
    for (let round = 0; round < 40; round++) {
      const n = 1 + Math.floor(r() * 5);
      const m = n + Math.floor(r() * 3);
      const cost = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.round(r() * 20 - 10)));
      const cols = assign(cost);
      assert.equal(new Set(cols).size, n, 'distinct columns');
      assert.equal(
        cols.reduce((sum, j, i) => sum + cost[i][j], 0),
        brute(cost),
        JSON.stringify(cost),
      );
    }
  });
});
