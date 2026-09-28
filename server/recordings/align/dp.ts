// Monotonic-with-excursions Viterbi over slides (DESIGN §22; the alignment spike's dp.ts with its tuned defaults).
//
// State (s, f): the lecture is on slide s while the furthest slide reached so far (the "frontier") is f, s <= f;
// plus an off-slide state null(f) (announcements, tangents) that remembers the frontier.
//  - advancing the frontier f → f' (> f) costs fwd, plus skip1 for the first skipped slide and skip for each further one;
//  - going back to an earlier slide (s < f) costs back; moving between earlier slides costs backMove (half for s-1 → s);
//  - returning from an excursion to the frontier costs ret; entering null costs nullIn, leaving it to the frontier is free;
//  - starting on a slide other than slide 1 costs startOff.
// Hard constraints (user markers) pin a segment to a slide (optionally "slide N starts here": the frontier is reset
// to N there, and the segments before it, back to the previous such marker, stay below N) or to null.
// Live recordings: where the timeline adopted a back-visit by its speech (`free`), entering that slide costs nothing
// instead of back / backMove: only the prior bonus has to be outweighed by the lexical evidence to undo it.
//
// Large decks: excursions are limited to `band` slides behind the frontier (all of them for decks of up to
// FULL_BAND_MAX_SLIDES slides), which keeps memory at T × N × (band + 2) back-pointers.
// Complexity O(T · N · band). Pure functions.

export interface DpParams {
  fwd: number;
  skip: number;
  skip1: number;
  back: number;
  backMove: number;
  ret: number;
  nullIn: number;
  startOff: number;
}

export interface EmitParams {
  nullZ: number;
  zClip: number;
  lenRef: number;
  wMin: number;
  wMax: number;
  sigmaFloor: number;
  nullQ: number;
}

/** Tuned on the spike's simulated Korean lecture (out/final_tfidf-z_ko-mixed.json); transfers to English. */
export const DEFAULT_DP: Readonly<DpParams> = Object.freeze({ fwd: 0.1, skip: 3, skip1: 0.8, back: 8, backMove: 8, ret: 1, nullIn: 5, startOff: 3 });
export const DEFAULT_EMIT: Readonly<EmitParams> = Object.freeze({ nullZ: -1.5, zClip: 3, lenRef: 30, wMin: 0.3, wMax: 2, sigmaFloor: 0.5, nullQ: 0.1 });

export const FULL_BAND_MAX_SLIDES = 64;
const LARGE_DECK_BAND = 16;

/** Slide label: 1-based slide number, or null (not about a slide). */
export type Label = number | null;

/**
 * A hard constraint on segment `seg`: its label must be `label`. `front`: "slide N starts here" (frontier reset,
 * must be at the frontier, earlier segments back to the previous front constraint stay below N).
 * `group`: constraints of one marker share a group; contradictory markers are dropped group by group, oldest first.
 */
export interface Constraint {
  seg: number;
  label: Label;
  front?: boolean;
  group?: number;
}

const NEG = -1e18;

/**
 * Emission scores from a similarity matrix (z-score mode): per segment the z-score of each slide's similarity
 * (clipped at zClip), weighted by the segment's length w = clamp(sqrt(chars / lenRef), wMin, wMax); the null
 * emission is w · (q + nullZ) where q is the nullQ-quantile of the segments' best z (recording-adaptive).
 */
export function emissions(sim: number[][], texts: string[], ep: EmitParams = DEFAULT_EMIT): { E: number[][]; En: number[] } {
  const T = sim.length;
  if (T === 0) return { E: [], En: [] };
  const N = sim[0].length;
  const stats = sim.map((row) => {
    const mean = row.reduce((a, b) => a + b, 0) / N;
    const sd = Math.sqrt(row.reduce((a, b) => a + (b - mean) ** 2, 0) / N);
    return { mean, sd };
  });
  const sds = stats.map((s) => s.sd).sort((a, b) => a - b);
  const med = sds[Math.floor(T / 2)] || 1e-9;
  const sdOf = (i: number) => Math.max(stats[i].sd, med * ep.sigmaFloor, 1e-9);
  const bestZ = sim
    .map((row, i) => Math.min(ep.zClip, (Math.max(...row) - stats[i].mean) / sdOf(i)))
    .sort((a, b) => a - b);
  const nullBase = bestZ[Math.min(T - 1, Math.floor(ep.nullQ * T))];
  const E: number[][] = [];
  const En: number[] = [];
  for (let i = 0; i < T; i++) {
    const { mean } = stats[i];
    const sd = sdOf(i);
    const len = (texts[i] ?? '').replace(/\s/g, '').length;
    const w = Math.min(ep.wMax, Math.max(ep.wMin, Math.sqrt(len / ep.lenRef)));
    E.push(sim[i].map((v) => w * Math.min(ep.zClip, (v - mean) / sd)));
    En.push(w * (nullBase + ep.nullZ));
  }
  return { E, En };
}

interface Layout {
  N: number;
  band: number;
  /** First state index of frontier f (states (lo(f)..f, f)). */
  offset: Int32Array;
  lo: Int32Array;
  /** Index of null(0); null(f) = nullBase + f. */
  nullBase: number;
  size: number;
}

function layout(N: number, band: number): Layout {
  const offset = new Int32Array(N);
  const lo = new Int32Array(N);
  let size = 0;
  for (let f = 0; f < N; f++) {
    lo[f] = Math.max(0, f - band);
    offset[f] = size;
    size += f - lo[f] + 1;
  }
  return { N, band, offset, lo, nullBase: size, size: size + N };
}

/**
 * Viterbi labels (1-based slides or null) for every segment. Contradictory constraints are dropped oldest group first.
 * `free[t]`: a 0-based slide the live timeline adopted as a back-visit at segment t (-1 = none); entering it there
 * (from the frontier, from null or from another earlier slide) costs nothing.
 */
export function viterbi(E: number[][], En: number[], p: DpParams = DEFAULT_DP, constraints: Constraint[] = [], free?: Int32Array): Label[] {
  const T = E.length;
  if (T === 0) return [];
  const N = E[0].length;
  if (N === 0) return new Array<Label>(T).fill(null);
  const L = layout(N, N <= FULL_BAND_MAX_SLIDES ? N - 1 : LARGE_DECK_BAND);
  const result = solve(E, En, p, constraints, L, free);
  if (result) return result;
  // Contradictory markers: drop the oldest group and try again.
  const groups = [...new Set(constraints.map((c) => c.group ?? c.seg))];
  if (groups.length === 0) return new Array<Label>(T).fill(null);
  const drop = groups[0];
  return viterbi(
    E,
    En,
    p,
    constraints.filter((c) => (c.group ?? c.seg) !== drop),
    free,
  );
}

function solve(E: number[][], En: number[], p: DpParams, constraints: Constraint[], L: Layout, free?: Int32Array): Label[] | null {
  const T = E.length;
  const { N, offset, lo, nullBase, size: S } = L;
  const pinned = new Map<number, Label>();
  const frontAt = new Set<number>();
  for (const c of constraints) {
    if (c.seg < 0 || c.seg >= T) continue;
    pinned.set(c.seg, c.label);
    if (c.front && c.label !== null) frontAt.add(c.seg);
  }
  // "slide N starts here" also means: before it (back to the previous such marker) the frontier was below N.
  const maxF = new Int32Array(T).fill(N - 1);
  {
    const fronts = constraints
      .filter((c) => c.front && c.label !== null && c.seg >= 0 && c.seg < T)
      .sort((a, b) => a.seg - b.seg);
    let prev = -1;
    for (const c of fronts) {
      for (let t = prev + 1; t < c.seg; t++) maxF[t] = Math.min(maxF[t], (c.label as number) - 2);
      prev = c.seg;
    }
  }
  const emitSlide = (t: number, s: number, f: number): number => {
    if (f > maxF[t]) return NEG;
    const c = pinned.get(t);
    if (c !== undefined) {
      if (c === null || c - 1 !== s) return NEG;
      if (frontAt.has(t) && f !== s) return NEG;
    }
    return E[t][s];
  };
  const emitNull = (t: number, f: number): number => {
    if (f > maxF[t]) return NEG;
    const c = pinned.get(t);
    if (c !== undefined && c !== null) return NEG;
    return En[t];
  };
  const idx = (s: number, f: number) => offset[f] + (s - lo[f]);

  let V = new Float64Array(S).fill(NEG);
  const back: Int32Array[] = [];
  for (let f = 0; f < N; f++) {
    const start = f === 0 ? 0 : -p.startOff;
    V[idx(f, f)] = start + emitSlide(0, f, f);
    V[nullBase + f] = start - p.nullIn * 0.5 + emitNull(0, f);
  }
  back.push(new Int32Array(S).fill(-1));

  const frontV = new Float64Array(N);
  const nulV = new Float64Array(N);
  const digV = new Float64Array(N);
  const digA = new Int32Array(N);
  const top1 = new Int32Array(N);
  const top2 = new Int32Array(N);
  const srcV = new Float64Array(N);
  const srcA = new Int32Array(N);
  const advV = new Float64Array(N);
  const advA = new Int32Array(N);
  // advancing by k+1 slides (k skipped) costs fwd + (k >= 1 ? skip1 + skip·(k-1) : 0)
  const skipBase = p.fwd + p.skip1 - p.skip;

  for (let t = 1; t < T; t++) {
    const W = new Float64Array(S).fill(NEG);
    const B = new Int32Array(S).fill(-1);
    for (let f = 0; f < N; f++) {
      frontV[f] = V[idx(f, f)];
      nulV[f] = V[nullBase + f];
      digV[f] = NEG;
      digA[f] = -1;
      top1[f] = -1;
      top2[f] = -1;
      for (let s = lo[f]; s < f; s++) {
        const v = V[idx(s, f)];
        if (v > digV[f]) {
          digV[f] = v;
          digA[f] = idx(s, f);
        }
        if (top1[f] < 0 || v > V[idx(top1[f], f)]) {
          top2[f] = top1[f];
          top1[f] = s;
        } else if (top2[f] < 0 || v > V[idx(top2[f], f)]) top2[f] = s;
      }
      // Best state of frontier f to advance from: the frontier itself, an excursion (half a return), or null.
      let bv = frontV[f];
      let ba = idx(f, f);
      if (digA[f] >= 0 && digV[f] - p.ret * 0.5 > bv) {
        bv = digV[f] - p.ret * 0.5;
        ba = digA[f];
      }
      if (nulV[f] > bv) {
        bv = nulV[f];
        ba = nullBase + f;
      }
      srcV[f] = bv;
      srcA[f] = ba;
    }
    // advV[f2] = max over f < f2 of srcV[f] − cost(f2 − f − 1); the linear part via a running prefix maximum.
    let prefV = NEG;
    let prefA = -1;
    for (let f2 = 0; f2 < N; f2++) {
      advV[f2] = NEG;
      advA[f2] = -1;
      if (f2 >= 1) {
        const v = srcV[f2 - 1] - p.fwd;
        if (srcA[f2 - 1] >= 0 && v > advV[f2]) {
          advV[f2] = v;
          advA[f2] = srcA[f2 - 1];
        }
      }
      if (f2 >= 2 && prefA >= 0) {
        const v = prefV - p.skip * (f2 - 1) - skipBase;
        if (v > advV[f2]) {
          advV[f2] = v;
          advA[f2] = prefA;
        }
      }
      // include f = f2 - 1 for the next f2 (it skips at least one slide then)
      if (f2 >= 1) {
        const cand = srcV[f2 - 1] + p.skip * (f2 - 1);
        if (srcA[f2 - 1] >= 0 && cand > prefV) {
          prefV = cand;
          prefA = srcA[f2 - 1];
        }
      }
    }
    let gArg = 0;
    if (frontAt.has(t)) for (let st = 1; st < S; st++) if (V[st] > V[gArg]) gArg = st;

    for (let f = 0; f < N; f++) {
      // frontier state (f, f)
      {
        const st = idx(f, f);
        let best = V[st];
        let arg = st;
        if (frontAt.has(t) && V[gArg] > best) {
          best = V[gArg]; // user marker: frontier reset, free
          arg = gArg;
        }
        if (advV[f] > best) {
          best = advV[f];
          arg = advA[f];
        }
        if (digA[f] >= 0 && digV[f] - p.ret > best) {
          best = digV[f] - p.ret;
          arg = digA[f];
        }
        if (nulV[f] > best) {
          best = nulV[f];
          arg = nullBase + f;
        }
        const e = emitSlide(t, f, f);
        if (e > NEG / 2 && best > NEG / 2) {
          W[st] = best + e;
          B[st] = arg;
        }
      }
      // excursion states (s, f), s < f
      for (let s = lo[f]; s < f; s++) {
        const st = idx(s, f);
        // A back-visit the live timeline adopted: going there is free (only the prior bonus has to be outweighed).
        const entry = free?.[t] === s ? 0 : p.back;
        const move = free?.[t] === s ? 0 : p.backMove;
        let best = V[st];
        let arg = st;
        if (frontV[f] - entry > best) {
          best = frontV[f] - entry;
          arg = idx(f, f);
        }
        if (nulV[f] - entry > best) {
          best = nulV[f] - entry;
          arg = nullBase + f;
        }
        const other = top1[f] === s ? top2[f] : top1[f];
        if (other >= 0) {
          const v = V[idx(other, f)] - move;
          if (v > best) {
            best = v;
            arg = idx(other, f);
          }
        }
        if (s > lo[f]) {
          const v = V[idx(s - 1, f)] - move * 0.5;
          if (v > best) {
            best = v;
            arg = idx(s - 1, f);
          }
        }
        const e = emitSlide(t, s, f);
        if (e > NEG / 2 && best > NEG / 2) {
          W[st] = best + e;
          B[st] = arg;
        }
      }
      // null(f)
      {
        const st = nullBase + f;
        let best = V[st];
        let arg = st;
        if (frontV[f] - p.nullIn > best) {
          best = frontV[f] - p.nullIn;
          arg = idx(f, f);
        }
        if (digA[f] >= 0 && digV[f] - p.nullIn > best) {
          best = digV[f] - p.nullIn;
          arg = digA[f];
        }
        const e = emitNull(t, f);
        if (e > NEG / 2 && best > NEG / 2) {
          W[st] = best + e;
          B[st] = arg;
        }
      }
    }
    V = W;
    back.push(B);
  }
  let arg = 0;
  for (let st = 1; st < S; st++) if (V[st] > V[arg]) arg = st;
  if (V[arg] < NEG / 2) return null;
  const labelOf = (st: number): Label => {
    if (st >= nullBase) return null;
    // find f with offset[f] <= st < offset[f+1]
    let loF = 0;
    let hiF = N - 1;
    while (loF < hiF) {
      const mid = (loF + hiF + 1) >> 1;
      if (offset[mid] <= st) loF = mid;
      else hiF = mid - 1;
    }
    return lo[loF] + (st - offset[loF]) + 1;
  };
  const out = new Array<Label>(T);
  for (let t = T - 1; t >= 0; t--) {
    out[t] = labelOf(arg);
    arg = back[t][arg];
    if (arg < 0 && t > 0) return null;
  }
  return out;
}
