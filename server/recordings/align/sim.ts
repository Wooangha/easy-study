// Lexical similarity between transcript segments and slides (DESIGN §22; the alignment spike's sim.ts, "tfidf-z"
// configuration): TF-IDF cosine (sublinear tf, IDF over the slides) per channel — Hangul n-grams, Latin/digit
// n-grams, consonant skeleton — summed with weights 1/1/1, and every query n-gram multiplied by its
// speech-specificity log(1 + Nseg/df_seg) / log(1 + Nseg) over the recording's own segments (generic speech that
// occurs everywhere counts less). Pure functions.
import { features } from './text.ts';
import type { Feat } from './text.ts';

export interface LexIndex {
  idfRaw: Map<string, number>;
  idfSkel: Map<string, number>;
  /** Per slide: normalised TF-IDF vectors of the Hangul, Latin/digit and skeleton channels. */
  slides: Array<{ h: Map<string, number>; l: Map<string, number>; s: Map<string, number> }>;
}

function idfOf(docs: Feat[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const k of d.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [k, v] of df) idf.set(k, Math.log(1 + (n - v + 0.5) / (v + 0.5)));
  return idf;
}

function tfidf(f: Feat, idf: Map<string, number>): Map<string, number> {
  const v = new Map<string, number>();
  let norm = 0;
  for (const [k, c] of f) {
    const w = idf.get(k);
    if (w === undefined) continue;
    const x = (c >= 1 ? 1 + Math.log(c) : c) * w;
    v.set(k, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [k, x] of v) v.set(k, x / norm);
  return v;
}

const isHangulGram = (k: string) => k.startsWith('H:');

function part(f: Feat, hangul: boolean): Feat {
  const out: Feat = new Map();
  for (const [k, v] of f) if (isHangulGram(k) === hangul) out.set(k, v);
  return out;
}

/** Index over the slide documents (one text per slide, in slide order). */
export function buildIndex(slideTexts: string[]): LexIndex {
  const docs = slideTexts.map((t) => features(t, { skelLatinOnly: true }));
  const idfRaw = idfOf(docs.map((d) => d.raw));
  const idfSkel = idfOf(docs.map((d) => d.skel));
  return {
    idfRaw,
    idfSkel,
    slides: docs.map((d) => ({ h: tfidf(part(d.raw, true), idfRaw), l: tfidf(part(d.raw, false), idfRaw), s: tfidf(d.skel, idfSkel) })),
  };
}

function dot(q: Map<string, number>, d: Map<string, number>): number {
  let sum = 0;
  for (const [k, x] of q) {
    const y = d.get(k);
    if (y !== undefined) sum += x * y;
  }
  return sum;
}

/** similarity[segment][slide] (0-based slide index). */
export function simMatrix(index: LexIndex, segmentTexts: string[]): number[][] {
  const queries = segmentTexts.map((q) => features(q, { stripJosa: true }));
  // Speech specificity over this recording's segments.
  const df = new Map<string, number>();
  const nq = queries.length;
  for (const f of queries) for (const m of [f.raw, f.skel]) for (const k of m.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const denom = Math.log(1 + nq) || 1;
  for (const f of queries) {
    for (const m of [f.raw, f.skel]) for (const [k, v] of m) m.set(k, v * (Math.log(1 + nq / (df.get(k) ?? 1)) / denom));
  }
  return queries.map((f) => {
    const qh = tfidf(part(f.raw, true), index.idfRaw);
    const ql = tfidf(part(f.raw, false), index.idfRaw);
    const qs = tfidf(f.skel, index.idfSkel);
    return index.slides.map((d) => dot(qh, d.h) + dot(ql, d.l) + dot(qs, d.s));
  });
}
