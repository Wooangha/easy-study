// Transcript → slide alignment (DESIGN §22 "Alignment"), pure:
// - lexical evidence: TF-IDF of character n-grams + Hangul-transliteration skeleton against each slide's material
//   (digest + extracted text), z-scored per segment (sim.ts, dp.ts);
// - live recordings: the slide the student viewed (SlideViewEvent timeline, filtered by the dwell rule of the live
//   spike) is a prior: its slide gets PRIOR_BONUS, so the lexical DP overrides it only with strong evidence;
// - optional LLM labels (AI 정밀 정렬) are soft votes (+LLM_BONUS), fused into the same Viterbi;
// - user markers ("여기부터 p.N") are hard constraints. A marker is "slide N starts here" (the frontier moves to N, the
//   speech before it stays below N) only when N is beyond every earlier start marker and not well behind where the
//   lecture had already got to; otherwise it marks a jump back to an earlier slide (that sentence is pinned, nothing
//   before it moves). In live recordings a marker also replaces the timeline prior until the student's view changes.
import type { AlignmentMarker, SlideViewEvent } from '../../../shared/types.ts';
import { DEFAULT_DP, DEFAULT_EMIT, emissions, viterbi } from './dp.ts';
import type { Constraint, Label } from './dp.ts';
import { buildIndex, simMatrix } from './sim.ts';

export type { Label } from './dp.ts';

/** Bonus of the slide the student was looking at (live timeline prior). */
export const PRIOR_BONUS = 3;
/** Bonus of the slide the LLM chose (spike: β = 2, never below the DP alone). */
export const LLM_BONUS = 2;

export interface AlignSegment {
  start: number;
  end: number;
  text: string;
}

export interface AlignInput {
  /** Material per slide (index 0 = slide 1): title, digest and extracted text. */
  slideTexts: string[];
  segments: AlignSegment[];
  /** Live recordings: the slide the student viewed at each segment's midpoint (null = unknown). */
  prior?: Array<number | null>;
  markers?: AlignmentMarker[];
  /** AI alignment: per segment the LLM's slide (null = off-slide, undefined = no vote). */
  llm?: Array<Label | undefined>;
}

const midpoint = (s: AlignSegment) => (s.start + s.end) / 2;

/**
 * A marker whose slide is at least this many slides behind the furthest slide the lecture had reached before it (by
 * the alignment without slide markers) is a jump back, not a new start. Chosen on the recording fixtures: 2 turned
 * real starts after a small overshoot of the DP into jump backs, 3–5 were equal.
 */
export const JUMP_BACK_MARGIN = 3;

/**
 * Constraints from markers: "slide N from t on" pins the first segment at/after t; null pins every segment until the
 * next marker. `reached(t)`: the furthest slide the lecture had reached before t (for telling a start from a jump back).
 */
export function markerConstraints(
  segments: AlignSegment[],
  markers: AlignmentMarker[],
  pageCount: number,
  reached?: (t: number) => number,
): Constraint[] {
  const sorted = [...markers].filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
  const out: Constraint[] = [];
  let maxStart = 0;
  sorted.forEach((marker, group) => {
    const next = sorted[group + 1]?.t ?? Infinity;
    if (marker.slide === null) {
      segments.forEach((s, seg) => {
        const mid = midpoint(s);
        if (mid >= marker.t && mid < next) out.push({ seg, label: null, group });
      });
      return;
    }
    if (!Number.isInteger(marker.slide) || marker.slide < 1 || marker.slide > pageCount) return;
    const seg = segments.findIndex((s) => midpoint(s) >= marker.t);
    if (seg < 0 || midpoint(segments[seg]) >= next) return;
    // "slide N starts here" only for a slide beyond every earlier start marker and not far behind the lecture's
    // progress; otherwise the professor went back to an earlier slide (a revisit: no frontier reset).
    const front = marker.slide > maxStart && (!reached || marker.slide > reached(marker.t) - JUMP_BACK_MARGIN);
    if (front) maxStart = marker.slide;
    out.push({ seg, label: marker.slide, front, group });
  });
  return out;
}

/** reached(t): the highest slide label among the segments whose midpoint is before t (0 when none). */
export function furthestBefore(segments: AlignSegment[], labels: Label[]): (t: number) => number {
  const order = segments.map((s, i) => ({ mid: midpoint(s), label: labels[i] })).sort((a, b) => a.mid - b.mid);
  const mids = order.map((o) => o.mid);
  const best = new Int32Array(order.length);
  let run = 0;
  order.forEach((o, i) => {
    if (typeof o.label === 'number' && o.label > run) run = o.label;
    best[i] = run;
  });
  return (t) => {
    // the number of midpoints < t
    let lo = 0;
    let hi = mids.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (mids[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo === 0 ? 0 : best[lo - 1];
  };
}

/**
 * Live recordings: a slide marker overrides the timeline prior from its segment on, for as long as the student kept
 * viewing the same slide (the run of equal prior values) and until the next marker — "from here on p.N" then moves
 * the following sentences too, not only the one it pins. An off-slide marker clears the prior until the next marker.
 */
export function priorWithMarkers(segments: AlignSegment[], prior: Array<number | null>, markers: AlignmentMarker[]): Array<number | null> {
  const out = [...prior];
  const sorted = [...markers].filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
  sorted.forEach((marker, k) => {
    const next = sorted[k + 1]?.t ?? Infinity;
    const first = segments.findIndex((s) => midpoint(s) >= marker.t);
    if (first < 0) return;
    const viewed = prior[first];
    for (let i = first; i < segments.length; i++) {
      if (midpoint(segments[i]) >= next) break;
      if (marker.slide !== null && prior[i] !== viewed) break;
      out[i] = marker.slide;
    }
  });
  return out;
}

/** Slide labels (1-based or null) for every segment. */
export function alignSegments(input: AlignInput): Label[] {
  const T = input.segments.length;
  const N = input.slideTexts.length;
  if (T === 0) return [];
  if (N === 0) return new Array<Label>(T).fill(null);
  const markers = input.markers ?? [];
  const prior = input.prior ? priorWithMarkers(input.segments, input.prior, markers) : undefined;
  const hasPrior = prior?.some((p) => typeof p === 'number') ?? false;
  let E: number[][];
  let En: number[];
  let params = DEFAULT_DP;
  if (input.slideTexts.every((t) => !/[\p{L}\p{N}]/u.test(t))) {
    // No slide material at all (no text layer, no digest): nothing to align by but the timeline and the markers.
    E = input.segments.map((_, i) => Array.from({ length: N }, (_, s) => (prior?.[i] === s + 1 ? PRIOR_BONUS : 0)));
    En = input.segments.map((_, i) => (typeof prior?.[i] === 'number' ? 0 : 1));
    params = { ...DEFAULT_DP, startOff: 0 };
  } else {
    const index = buildIndex(input.slideTexts);
    const texts = input.segments.map((s) => s.text);
    ({ E, En } = emissions(simMatrix(index, texts), texts, DEFAULT_EMIT));
    for (let i = 0; i < T; i++) {
      const p = prior?.[i];
      if (typeof p === 'number' && p >= 1 && p <= N) E[i][p - 1] += PRIOR_BONUS;
      const vote = input.llm?.[i];
      if (vote === null) En[i] += LLM_BONUS;
      else if (typeof vote === 'number' && vote >= 1 && vote <= N) E[i][vote - 1] += LLM_BONUS;
    }
    // With a timeline, the student's first view says where the lecture starts: no penalty for not starting at slide 1.
    if (hasPrior) params = { ...DEFAULT_DP, startOff: 0 };
  }
  // How far the lecture had got before each slide marker: the alignment with only the off-slide markers.
  let reached: ((t: number) => number) | undefined;
  if (markers.some((m) => m.slide !== null)) {
    const free = viterbi(E, En, params, markerConstraints(input.segments, markers.filter((m) => m.slide === null), N));
    reached = furthestBefore(input.segments, free);
  }
  return viterbi(E, En, params, markerConstraints(input.segments, markers, N, reached));
}

// ---------------------------------------------------------------------------------------------------------------
// Live timeline prior
// ---------------------------------------------------------------------------------------------------------------

export interface LectureSpan {
  slide: number;
  from: number;
  to: number;
}

/**
 * Views within this many seconds of the first one replace it as the start: the viewer was still settling when the
 * recording began (a smooth scroll after a page jump passes the slides in between; the student turns to the right
 * slide right after pressing record). Without it the dwell rule would need 30 s on the real slide to go "back" to it.
 */
export const START_SETTLE_SEC = 2;

/**
 * The slide the lecture was on, derived from the student's slide views (live spike, asymmetric dwell rule): a view
 * becomes the lecture slide from the moment the student arrived when it lasts ≥ 5 s (next slide), ≥ 15 s (a jump
 * ahead by 2+) or ≥ 30 s (going back); shorter visits (a look back, a peek ahead) are excursions of the student.
 * The first view (after START_SETTLE_SEC of settling) defines the start. Times in seconds on the recording clock.
 */
export function lectureSpans(events: SlideViewEvent[], endSec: number): LectureSpan[] {
  const valid = events.filter((e) => Number.isFinite(e.t) && Number.isInteger(e.slide)).sort((a, b) => a.t - b.t);
  let settled = 0;
  while (settled + 1 < valid.length && valid[settled + 1].t - valid[0].t <= START_SETTLE_SEC) settled++;
  const sorted = valid.length > 0 ? [{ t: valid[0].t, slide: valid[settled].slide }, ...valid.slice(settled + 1)] : [];
  const need = (from: number, to: number) => (to < from ? 30 : to > from + 1 ? 15 : 5);
  const spans: LectureSpan[] = [];
  let current: { slide: number; from: number } | null = null;
  const switchTo = (slide: number, at: number) => {
    if (current && current.slide === slide) return;
    if (current) spans.push({ slide: current.slide, from: current.from, to: at });
    current = { slide, from: at };
  };
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const until = i + 1 < sorted.length ? sorted[i + 1].t : Math.max(endSec, e.t);
    const cur = current as { slide: number; from: number } | null;
    if (!cur) switchTo(e.slide, e.t);
    else if (until - e.t >= need(cur.slide, e.slide)) switchTo(e.slide, e.t);
  }
  const last = current as { slide: number; from: number } | null;
  if (last) spans.push({ slide: last.slide, from: last.from, to: Math.max(endSec, last.from) });
  if (spans.length > 0 && spans[0].from > 0) spans[0].from = 0;
  return spans.filter((s) => s.to >= s.from);
}

/** The lecture slide at time t (null when there is no view before or at t). */
export function slideAt(spans: LectureSpan[], t: number): number | null {
  let found: number | null = null;
  for (const s of spans) {
    if (s.from <= t) found = s.slide;
    else break;
  }
  return found;
}

/** Timeline prior of every segment (the lecture slide at its midpoint). */
export function timelinePrior(segments: AlignSegment[], events: SlideViewEvent[], endSec: number): Array<number | null> {
  if (events.length === 0) return segments.map(() => null);
  const spans = lectureSpans(events, endSec);
  return segments.map((s) => slideAt(spans, midpoint(s)));
}
