// Transcript → slide alignment (DESIGN §22 "Alignment"), pure:
// - lexical evidence: TF-IDF of character n-grams + Hangul-transliteration skeleton against each slide's material
//   (digest + extracted text), z-scored per segment (sim.ts, dp.ts);
// - live recordings: the slide the student viewed (SlideViewEvent timeline, filtered by the dwell rule of the live
//   spike) is a prior: its slide gets PRIOR_BONUS, so the lexical DP overrides it only with strong evidence;
// - optional LLM labels (AI 정밀 정렬) are soft votes (+LLM_BONUS), fused into the same Viterbi;
// - user markers ("여기부터 p.N") are hard constraints.
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

/** Constraints from markers: "slide N from t on" pins the first segment at/after t; null pins every segment until the next marker. */
export function markerConstraints(segments: AlignSegment[], markers: AlignmentMarker[], pageCount: number): Constraint[] {
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
    // "slide N starts here" only for a slide beyond every earlier start marker; otherwise a revisit.
    const front = marker.slide > maxStart;
    if (front) maxStart = marker.slide;
    out.push({ seg, label: marker.slide, front, group });
  });
  return out;
}

/** Slide labels (1-based or null) for every segment. */
export function alignSegments(input: AlignInput): Label[] {
  const T = input.segments.length;
  const N = input.slideTexts.length;
  if (T === 0) return [];
  if (N === 0) return new Array<Label>(T).fill(null);
  // No slide material at all (no text layer, no digest): nothing to align by but the timeline and the markers.
  if (input.slideTexts.every((t) => !/[\p{L}\p{N}]/u.test(t))) {
    const E = input.segments.map((_, i) => Array.from({ length: N }, (_, s) => (input.prior?.[i] === s + 1 ? PRIOR_BONUS : 0)));
    const En = input.segments.map((_, i) => (typeof input.prior?.[i] === 'number' ? 0 : 1));
    return viterbi(E, En, { ...DEFAULT_DP, startOff: 0 }, markerConstraints(input.segments, input.markers ?? [], N));
  }
  const index = buildIndex(input.slideTexts);
  const texts = input.segments.map((s) => s.text);
  const { E, En } = emissions(simMatrix(index, texts), texts, DEFAULT_EMIT);
  for (let i = 0; i < T; i++) {
    const prior = input.prior?.[i];
    if (typeof prior === 'number' && prior >= 1 && prior <= N) E[i][prior - 1] += PRIOR_BONUS;
    const vote = input.llm?.[i];
    if (vote === null) En[i] += LLM_BONUS;
    else if (typeof vote === 'number' && vote >= 1 && vote <= N) E[i][vote - 1] += LLM_BONUS;
  }
  const constraints = markerConstraints(input.segments, input.markers ?? [], N);
  // With a timeline, the student's first view says where the lecture starts: no penalty for not starting at slide 1.
  const params = input.prior?.some((p) => typeof p === 'number') ? { ...DEFAULT_DP, startOff: 0 } : DEFAULT_DP;
  return viterbi(E, En, params, constraints);
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
 * The slide the lecture was on, derived from the student's slide views (live spike, asymmetric dwell rule): a view
 * becomes the lecture slide from the moment the student arrived when it lasts ≥ 5 s (next slide), ≥ 15 s (a jump
 * ahead by 2+) or ≥ 30 s (going back); shorter visits (a look back, a peek ahead) are excursions of the student.
 * The first view defines the start. Times in seconds on the recording clock.
 */
export function lectureSpans(events: SlideViewEvent[], endSec: number): LectureSpan[] {
  const sorted = events.filter((e) => Number.isFinite(e.t) && Number.isInteger(e.slide)).sort((a, b) => a.t - b.t);
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
