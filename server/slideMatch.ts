// Matching the slides of a lecture's old PDF to the slides of its new version (the professor re-posted the deck):
// which new slide each old slide became, so that everything the student made on a slide follows it.
//
// Pure: works on per-slide features (the extracted text, the word boxes and a small grayscale picture), no files.
// - Comparable text: the slide's words without the margin's noise (found by their boxes in the top or bottom margin: the
//   decks' header / footer words, a footer line of only those and numbers — "Sep 11, 2026 · 3 / 35" —, and the slide's
//   own printed number), case folded, without whitespace (the text file and the word boxes space CJK differently).
// - Text similarity: TF-IDF weighted character trigrams over both decks (the course name, footers and other
//   boilerplate on every slide weigh almost nothing), cosine.
// - Image similarity: the weighted Jaccard of the two slides' "ink" (32 x 24 cells, distance from the background), after
//   the decks' common template (each cell's median ink over every slide) is taken out.
// - Assignment: a monotonic DP (like a diff) over confident pairs gives the deck's skeleton; every other old slide
//   is expected in the gap of new slides between its skeleton neighbours. Then one optimal assignment (Hungarian)
//   matches old to new slides: a pair inside its gap needs NEAR_MIN, a pair anywhere else (a moved slide) FAR_MIN.
// - Each new slide is 'same' (comparable text identical and at most SAME_PIXELS_MAX of the picture differs outside
//   the slide numbers), 'changed' (matched, but different) or 'new'; an old slide that matched nothing is removed.
import type { LayoutBox, SlideTextLayout } from '../shared/types.ts';

/** Size of the grayscale picture of a slide the matcher gets (stretched to 4:3 whatever the slide's shape). */
export const THUMB_W = 128;
export const THUMB_H = 96;
/** The similarity compares COARSE x COARSE averages (32 x 24); the same / changed decision every pixel. */
const COARSE = 4;

export interface SlideFeatures {
  /** The slide's extracted text (text/NNN.txt). */
  text: string;
  /** The slide's word boxes (text/NNN.layout.json) when known: the slide number is found by its position. */
  layout?: SlideTextLayout['lines'] | null;
  /** THUMB_W x THUMB_H grayscale pixels (0..255), row after row. */
  thumb: Uint8Array;
}

export type SlideChange = 'same' | 'changed' | 'new';

export interface SlideMatchEntry {
  /** 1-based slide of the new deck. */
  slide: number;
  /** The 1-based old slide it continues, or null for a new slide. */
  from: number | null;
  change: SlideChange;
  /** Similarity of the pair (0..1), 0 for a new slide. */
  score: number;
  /** True when the old slide was elsewhere in the order. */
  moved?: boolean;
}

export interface SlideMatch {
  /** One entry per new slide, in order. */
  slides: SlideMatchEntry[];
  /** 1-based old slides that matched nothing. */
  removed: number[];
  /** oldToNew[old - 1] = the new slide (1-based) or null. */
  oldToNew: (number | null)[];
}

/** Pairs at least this similar form the skeleton of the order. */
export const ANCHOR_MIN = 0.7;
/** A pair in the gap the order predicts needs this similarity (an edited slide where it was). */
export const NEAR_MIN = 0.4;
/** A pair anywhere else needs this similarity (a slide moved elsewhere in the deck). */
export const FAR_MIN = 0.65;
/** A matched pair is 'same' when the texts are equal and at most this share of the pixels differs. */
export const SAME_PIXELS_MAX = 0.002;
/** Two pixels differ when their gray levels are more than this apart. */
const PIXEL_DIFF = 24;
/** Below this many characters (comparable text) a slide counts as having no text; only the picture compares. */
const MIN_TEXT_CHARS = 10;
/** The Hungarian method is O(n² (n + m)); bigger decks fall back to the DP and a greedy pass. */
const ASSIGNMENT_MAX_WORK = 2e8;

const MARGIN_TOP = 0.12;
const MARGIN_BOTTOM = 0.86;
/** A word that can be a printed slide number: "12", "p.4", "#7", "3/12", "(3/12)", "[3]", "3쪽" (group 1 = the number). */
const SLIDE_NUMBER_WORD = /^[([]?(?:p\.?|#)?(\d{1,4})(?:\/\d{1,4})?(?:쪽|페이지|p)?[)\]]?$/i;
/** A number or date piece, or a separator: "11,", "2026", "2026.09.11", "9/11", "(3/12)", "/", "|", "·", "–", "of". */
const NUMBER_PIECE = /^[([]?[\d.,:/\-–]*\d[\d.,:/\-–]*(?:쪽|페이지|p)?[)\]]?$|^[/|·–—-]$|^of$/i;
/** A printed slide number is at most this far from the slide's position (a title slide not counted, and so on). */
const SLIDE_NUMBER_SLACK = 3;
const PAGE_NUMBER_LINE = /^\s*(?:p\.?\s*|page\s+|slide\s+|-\s*)?[([]?\d{1,4}(?:\s*(?:\/|of)\s*\d{1,4})?(?:쪽|페이지)?[)\]]?(?:\s*-)?\s*$/i;
/** A margin word on at least this share of a deck's slides is its header / footer (course name, lecture date). */
const BOILERPLATE_SHARE = 0.5;

type LayoutLine = NonNullable<SlideFeatures['layout']>[number];

function inMargin(r: LayoutBox): boolean {
  return r[1] + r[3] <= MARGIN_TOP || r[1] >= MARGIN_BOTTOM;
}

function foldWord(word: string): string {
  return word.normalize('NFC').toLowerCase().trim();
}

/**
 * The header / footer words of a deck: words in the top or bottom margin of at least half of its slides (e.g. the
 * course name, the lecture's date "Sep 11, 2026" on every slide — it changes with every re-post). Empty under 4 slides.
 */
export function marginBoilerplate(slides: Pick<SlideFeatures, 'layout'>[]): Set<string> {
  const counts = new Map<string, number>();
  for (const slide of slides) {
    const seen = new Set<string>();
    for (const line of slide.layout ?? []) for (const w of line.words) if (inMargin(w.r)) seen.add(foldWord(w.t));
    for (const word of seen) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const out = new Set<string>();
  if (slides.length < 4) return out;
  for (const [word, n] of counts) if (n >= slides.length * BOILERPLATE_SHARE) out.add(word);
  return out;
}

/**
 * Which words of a layout line are no content, only in the top / bottom margin: a line made only of number pieces and
 * header / footer words (a footer "Database Lab · Sep 11, 2026 · 3 / 35"), else the header / footer words and the slide's
 * own number (within SLIDE_NUMBER_SLACK of its 1-based `position`, with a following "/ N" or "of N"). Any other number
 * stays: "Average waiting time = 17 ms" or "Midterm on 10/15" near the edge is content.
 */
function marginNoise(line: LayoutLine, boilerplate: ReadonlySet<string>, position?: number): boolean[] {
  const words = line.words.map((w) => foldWord(w.t));
  const margin = line.words.map((w) => inMargin(w.r));
  if (words.length > 0 && words.every((t, k) => margin[k] && (NUMBER_PIECE.test(t) || boilerplate.has(t)))) return words.map(() => true);
  const noise = words.map((t, k) => margin[k] && boilerplate.has(t));
  if (position === undefined) return noise;
  words.forEach((t, k) => {
    const number = margin[k] ? SLIDE_NUMBER_WORD.exec(t) : null;
    if (!number || Math.abs(Number(number[1]) - position) > SLIDE_NUMBER_SLACK) return;
    noise[k] = true;
    if ((words[k + 1] === '/' || words[k + 1] === 'of') && /^\d{1,4}\)?$/.test(words[k + 2] ?? '')) noise[k + 1] = noise[k + 2] = true;
  });
  return noise;
}

/** Boxes of the margin words that are no content (see marginNoise): ignored by the pixel comparison too. */
export function slideNumberBoxes(layout: SlideFeatures['layout'], boilerplate: ReadonlySet<string> = new Set(), position?: number): LayoutBox[] {
  if (!layout) return [];
  const boxes: LayoutBox[] = [];
  for (const line of layout) {
    const noise = marginNoise(line, boilerplate, position);
    line.words.forEach((word, k) => {
      if (noise[k]) boxes.push(word.r);
    });
  }
  return boxes;
}

function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

/**
 * The text a slide is compared by: without the margin's noise (see marginNoise; `position` = the slide's 1-based place
 * in its deck), case folded, without whitespace. Without word boxes, lines that are only a page number are dropped.
 */
export function comparableText(
  slide: Pick<SlideFeatures, 'text' | 'layout'>,
  boilerplate: ReadonlySet<string> = new Set(),
  position?: number,
): string {
  if (slide.layout && slide.layout.length) {
    return fold(
      slide.layout
        .map((line) => {
          const noise = marginNoise(line, boilerplate, position);
          return line.words.filter((_, k) => !noise[k]).map((w) => w.t).join(' ');
        })
        .join('\n'),
    );
  }
  return fold(
    slide.text
      .split('\n')
      .filter((line) => !PAGE_NUMBER_LINE.test(line))
      .join('\n'),
  );
}

function trigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const chars = Array.from(text);
  for (let i = 0; i + 3 <= chars.length; i++) {
    const gram = chars[i] + chars[i + 1] + chars[i + 2];
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

interface TextVector {
  weights: Map<string, number>;
  norm: number;
  hasText: boolean;
  text: string;
}

function textVectors(texts: string[]): TextVector[] {
  const grams = texts.map(trigrams);
  const df = new Map<string, number>();
  for (const g of grams) for (const key of g.keys()) df.set(key, (df.get(key) ?? 0) + 1);
  const n = texts.length;
  return grams.map((g, i) => {
    const weights = new Map<string, number>();
    let sum = 0;
    for (const [key, tf] of g) {
      const w = (1 + Math.log(tf)) * Math.log((n + 1) / ((df.get(key) ?? 0) + 0.5));
      if (w <= 0) continue;
      weights.set(key, w);
      sum += w * w;
    }
    return { weights, norm: Math.sqrt(sum), hasText: Array.from(texts[i]).length >= MIN_TEXT_CHARS, text: texts[i] };
  });
}

function cosine(a: TextVector, b: TextVector): number {
  if (!a.norm || !b.norm) return 0;
  const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [key, w] of small.weights) {
    const other = large.weights.get(key);
    if (other) dot += w * other;
  }
  return Math.min(1, dot / (a.norm * b.norm));
}

/**
 * The slide's "ink": how far each COARSE x COARSE cell's average is from the slide's background (its median gray
 * level), so a dark theme compares like a light one and a blank slide has almost none.
 */
function ink(thumb: Uint8Array): Float32Array {
  const w = THUMB_W / COARSE;
  const h = THUMB_H / COARSE;
  const out = new Float32Array(w * h);
  if (thumb.length !== THUMB_W * THUMB_H) return out;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < thumb.length; i++) histogram[thumb[i]]++;
  let background = 0;
  for (let seen = 0; background < 255; background++) {
    seen += histogram[background];
    if (seen * 2 >= thumb.length) break;
  }
  for (let y = 0; y < THUMB_H; y++) {
    for (let x = 0; x < THUMB_W; x++) out[Math.floor(y / COARSE) * w + Math.floor(x / COARSE)] += thumb[y * THUMB_W + x];
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.abs(out[i] / (COARSE * COARSE) - background);
  return out;
}

/**
 * Similarity of two slides' ink (weighted Jaccard: Σ min / Σ max): 1 for the same picture, near 0 for different
 * content on a blank background, in between for the same template with other content. Two blank slides: 1.
 */
function inkSimilarity(a: Float32Array, b: Float32Array): number {
  let min = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    min += Math.min(a[i], b[i]);
    max += Math.max(a[i], b[i]);
  }
  return max < 1 ? 1 : min / max;
}

/**
 * Takes the decks' common template out of every slide's ink (in place): each cell's median ink over all slides of both
 * decks (the title band, logo and footer every slide has). Two different figure slides of one template then share
 * almost nothing, so a picture-only slide does not pair with any other one. Needs 4 slides or more.
 */
function removeTemplate(pics: Float32Array[]): void {
  if (pics.length < 4) return;
  const cells = pics[0].length;
  const column = new Float32Array(pics.length);
  for (let c = 0; c < cells; c++) {
    for (let k = 0; k < pics.length; k++) column[k] = pics[k][c];
    column.sort();
    const template = column[column.length >> 1];
    if (template <= 0) continue;
    for (const pic of pics) pic[c] = Math.max(0, pic[c] - template);
  }
}

/** Share of the pixels that differ between two thumbnails, outside the given boxes (the slide numbers). */
export function changedPixels(a: Uint8Array, b: Uint8Array, ignore: LayoutBox[] = []): number {
  if (a.length !== b.length || a.length !== THUMB_W * THUMB_H) return 1;
  const mask = new Uint8Array(a.length);
  for (const [x, y, w, h] of ignore) {
    const x0 = Math.max(0, Math.floor(x * THUMB_W) - 2);
    const x1 = Math.min(THUMB_W, Math.ceil((x + w) * THUMB_W) + 2);
    const y0 = Math.max(0, Math.floor(y * THUMB_H) - 2);
    const y1 = Math.min(THUMB_H, Math.ceil((y + h) * THUMB_H) + 2);
    for (let yy = y0; yy < y1; yy++) mask.fill(1, yy * THUMB_W + x0, yy * THUMB_W + x1);
  }
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (!mask[i] && Math.abs(a[i] - b[i]) > PIXEL_DIFF) changed++;
  return changed / a.length;
}

export interface PairScore {
  score: number;
  text: number;
  image: number;
}

interface Prepared {
  scores: PairScore[][];
  oldText: string[];
  newText: string[];
  boilerplate: Set<string>;
}

function prepare(oldSlides: SlideFeatures[], newSlides: SlideFeatures[]): Prepared {
  // One header / footer for both versions: a word that is boilerplate in one deck only (a 4-slide deck losing a slide,
  // a title word on exactly half of the slides) would otherwise be dropped from one side only.
  const boilerplate = new Set([...marginBoilerplate(oldSlides), ...marginBoilerplate(newSlides)]);
  const oldText = oldSlides.map((slide, i) => comparableText(slide, boilerplate, i + 1));
  const newText = newSlides.map((slide, j) => comparableText(slide, boilerplate, j + 1));
  const vectors = textVectors([...oldText, ...newText]);
  const oldVec = vectors.slice(0, oldSlides.length);
  const newVec = vectors.slice(oldSlides.length);
  const oldPic = oldSlides.map((s) => ink(s.thumb));
  const newPic = newSlides.map((s) => ink(s.thumb));
  // Picture-only slides compare without the decks' common template; text slides keep it (their text decides, and
  // the template keeps an edited slide's picture close to its old one).
  const oldBare = oldPic.map((p) => p.slice());
  const newBare = newPic.map((p) => p.slice());
  removeTemplate([...oldBare, ...newBare]);
  const scores = oldSlides.map((_, i) =>
    newSlides.map((_, j) => {
      const a = oldVec[i];
      const b = newVec[j];
      let text = 0;
      let image: number;
      let score: number;
      if (a.hasText && b.hasText) {
        image = inkSimilarity(oldPic[i], newPic[j]);
        text = a.text === b.text ? 1 : cosine(a, b);
        score = 0.75 * text + 0.25 * image;
      } else if (!a.hasText && !b.hasText) {
        image = inkSimilarity(oldBare[i], newBare[j]);
        score = image;
      } else {
        // Text on one side only: text was added to (or taken off) a picture slide, or they are unrelated.
        image = inkSimilarity(oldBare[i], newBare[j]);
        score = 0.6 * image;
      }
      return { score, text, image };
    }),
  );
  return { scores, oldText, newText, boilerplate };
}

/** Similarity matrix (old x new). */
export function scoreSlides(oldSlides: SlideFeatures[], newSlides: SlideFeatures[]): PairScore[][] {
  return prepare(oldSlides, newSlides).scores;
}

/** The monotonic alignment maximising the summed (score − min) of its pairs: newOf[i] = j or -1. */
function monotonic(scores: PairScore[][], n: number, m: number, min: number): number[] {
  const width = m + 1;
  const best = new Float64Array((n + 1) * width);
  const step = new Uint8Array((n + 1) * width); // 1 = skip old, 2 = skip new, 3 = match
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      let value = -Infinity;
      let how = 0;
      if (i > 0 && best[(i - 1) * width + j] > value) {
        value = best[(i - 1) * width + j];
        how = 1;
      }
      if (j > 0 && best[i * width + j - 1] > value) {
        value = best[i * width + j - 1];
        how = 2;
      }
      if (i > 0 && j > 0) {
        const g = scores[i - 1][j - 1].score - min;
        if (g > 0 && best[(i - 1) * width + j - 1] + g > value) {
          value = best[(i - 1) * width + j - 1] + g;
          how = 3;
        }
      }
      best[i * width + j] = value;
      step[i * width + j] = how;
    }
  }
  const newOf = Array<number>(n).fill(-1);
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const how = step[i * width + j];
    if (how === 3) {
      newOf[i - 1] = j - 1;
      i--;
      j--;
    } else if (how === 1) i--;
    else j--;
  }
  return newOf;
}

/**
 * Minimum-cost assignment of every row to a distinct column (rows ≤ columns), the Hungarian method with
 * potentials (O(rows² · columns)). Returns the column of each row.
 */
export function assign(cost: number[][]): number[] {
  const n = cost.length;
  const m = n ? cost[0].length : 0;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1); // p[j] = row (1-based) assigned to column j
  const way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const columnOf = Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) columnOf[p[j] - 1] = j - 1;
  return columnOf;
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const prev = Array<number>(values.length).fill(-1);
  for (let k = 0; k < values.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[k]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) keep.add(k);
  return keep;
}

/** Matches the old deck's slides to the new deck's. */
export function matchSlides(oldSlides: SlideFeatures[], newSlides: SlideFeatures[]): SlideMatch {
  const n = oldSlides.length;
  const m = newSlides.length;
  const { scores, oldText, newText, boilerplate } = prepare(oldSlides, newSlides);

  // The skeleton, then for each old slide the gap of new slides it is expected in: (lo, hi) exclusive.
  const anchor = monotonic(scores, n, m, ANCHOR_MIN);
  const lo = Array<number>(n);
  const hi = Array<number>(n);
  for (let i = 0, last = -1; i < n; i++) {
    if (anchor[i] >= 0) last = anchor[i];
    lo[i] = anchor[i] >= 0 ? anchor[i] - 1 : last;
  }
  for (let i = n - 1, next = m; i >= 0; i--) {
    if (anchor[i] >= 0) next = anchor[i];
    hi[i] = anchor[i] >= 0 ? anchor[i] + 1 : next;
  }
  const near = (i: number, j: number) => j > lo[i] && j < hi[i];
  const gain = (i: number, j: number) => {
    const s = scores[i][j].score;
    if (!near(i, j)) return s - FAR_MIN;
    // Inside the gap a pair on the diagonal wins a tie (repeated slides, step-by-step builds).
    const span = hi[i] - lo[i];
    const expected = lo[i] + span / 2;
    return s - NEAR_MIN + 0.01 * (1 - Math.abs(j - expected) / span);
  };

  const newOf = Array<number>(n).fill(-1);
  if (n && m && n * n * (n + m) <= ASSIGNMENT_MAX_WORK) {
    // Rows = old slides, columns = new slides then one "no match" column per old slide (gain 0).
    const cost = Array.from({ length: n }, (_, i) => {
      const row = new Array<number>(m + n).fill(0);
      for (let j = 0; j < m; j++) row[j] = -Math.max(0, gain(i, j));
      return row;
    });
    assign(cost).forEach((j, i) => {
      if (j >= 0 && j < m && gain(i, j) > 0) newOf[i] = j;
    });
  } else {
    // Big decks: the monotonic alignment with NEAR_MIN, then leftovers paired greedily with FAR_MIN.
    monotonic(scores, n, m, NEAR_MIN).forEach((j, i) => (newOf[i] = j));
    const taken = new Set(newOf.filter((j) => j >= 0));
    const leftovers: { i: number; j: number; s: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (newOf[i] >= 0) continue;
      for (let j = 0; j < m; j++) if (!taken.has(j) && scores[i][j].score >= FAR_MIN) leftovers.push({ i, j, s: scores[i][j].score });
    }
    leftovers.sort((a, b) => b.s - a.s || a.j - b.j);
    for (const { i, j } of leftovers) {
      if (newOf[i] >= 0 || taken.has(j)) continue;
      newOf[i] = j;
      taken.add(j);
    }
  }

  const matchedOld = newOf.flatMap((j, i) => (j >= 0 ? [i] : []));
  const inOrder = longestIncreasing(matchedOld.map((i) => newOf[i]));
  const moved = new Set(matchedOld.filter((_, k) => !inOrder.has(k)).map((i) => newOf[i]));
  const oldOf = Array<number>(m).fill(-1);
  newOf.forEach((j, i) => {
    if (j >= 0) oldOf[j] = i;
  });

  const slides: SlideMatchEntry[] = newSlides.map((slide, j) => {
    const i = oldOf[j];
    if (i < 0) return { slide: j + 1, from: null, change: 'new', score: 0 };
    const ignore = [...slideNumberBoxes(oldSlides[i].layout, boilerplate, i + 1), ...slideNumberBoxes(slide.layout, boilerplate, j + 1)];
    const same = oldText[i] === newText[j] && changedPixels(oldSlides[i].thumb, slide.thumb, ignore) <= SAME_PIXELS_MAX;
    return { slide: j + 1, from: i + 1, change: same ? 'same' : 'changed', score: scores[i][j].score, ...(moved.has(j) ? { moved: true } : {}) };
  });
  const removed = newOf.flatMap((j, i) => (j < 0 ? [i + 1] : []));
  return { slides, removed, oldToNew: newOf.map((j) => (j < 0 ? null : j + 1)) };
}
