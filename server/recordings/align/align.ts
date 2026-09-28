// Transcript → slide alignment (DESIGN §22 "Alignment"), pure:
// - lexical evidence: TF-IDF of character n-grams + Hangul-transliteration skeleton against each slide's material
//   (digest + extracted text), z-scored per segment (sim.ts, dp.ts);
// - live recordings: the slide the lecture was on, derived from the student's views (SlideViewEvent timeline, the
//   dwell rule of the live spike), is a prior: its slide gets PRIOR_BONUS, so the lexical DP overrides it only with
//   strong evidence. A look back to an earlier slide is the lecture's (the professor went back and the student
//   followed) when the speech during it supports it or does not contradict it, or after BACK_SEC; otherwise it is
//   the student's own excursion. The DP enters a back-visit the speech adopted for free (dp.ts `free`); one adopted
//   only for lasting BACK_SEC keeps the cost of going back, so clear speech about the lecture slide still wins;
// - optional LLM labels (AI 정밀 정렬) are soft votes (+LLM_BONUS), fused into the same Viterbi;
// - user markers ("여기부터 p.N") are hard constraints. A marker is "slide N starts here" (the frontier moves to N, the
//   speech before it stays below N) only when N is beyond every earlier start marker and not well behind where the
//   lecture had already got to (in live recordings: beyond the timeline's furthest slide); otherwise it marks a jump
//   back to an earlier slide (that sentence is pinned, nothing before it moves). In live recordings a marker also
//   replaces the timeline prior until the student's view changes.
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
  /** Live recordings: the slide-view timeline; the prior (back-visits gated by the lexical evidence) is derived inside, and wins over `prior`. */
  timeline?: { events: SlideViewEvent[]; endSec: number };
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
 * `timeline(t)` (live recordings): the furthest slide of the lecture timeline before t. The student saw where the
 * lecture was, so a marker for a slide not beyond it is a jump back, however close behind (1–2 slides back would
 * be within JUMP_BACK_MARGIN).
 */
export function markerConstraints(
  segments: AlignSegment[],
  markers: AlignmentMarker[],
  pageCount: number,
  reached?: (t: number) => number,
  timeline?: (t: number) => number,
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
    // progress (live: beyond the timeline); otherwise the professor went back to an earlier slide (a revisit: no
    // frontier reset).
    const front =
      marker.slide > maxStart &&
      (!reached || marker.slide > reached(marker.t) - JUMP_BACK_MARGIN) &&
      (!timeline || marker.slide > timeline(marker.t));
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

/** Some slide has material to align by (a text layer or a digest); otherwise there is no lexical evidence at all. */
export function hasSlideText(slideTexts: string[]): boolean {
  return slideTexts.some((t) => /[\p{L}\p{N}]/u.test(t));
}

/** Slide labels (1-based or null) for every segment. */
export function alignSegments(input: AlignInput): Label[] {
  const T = input.segments.length;
  const N = input.slideTexts.length;
  if (T === 0) return [];
  if (N === 0) return new Array<Label>(T).fill(null);
  const markers = input.markers ?? [];
  const noText = !hasSlideText(input.slideTexts);
  let E: number[][] = [];
  let En: number[] = [];
  if (!noText) {
    const index = buildIndex(input.slideTexts);
    const texts = input.segments.map((s) => s.text);
    ({ E, En } = emissions(simMatrix(index, texts), texts, DEFAULT_EMIT));
  }
  // Live: the lecture timeline, its back-visits gated by the lexical evidence (before any bonus is added to it).
  const tl = input.timeline ? timelineOf(input.segments, input.timeline.events, input.timeline.endSec, noText ? undefined : () => E) : undefined;
  const rawPrior = tl ? tl.prior : input.prior;
  const prior = rawPrior ? priorWithMarkers(input.segments, rawPrior, markers) : undefined;
  const free = tl?.free;
  // Where a marker replaced the prior, the back-visit is not the timeline's any more.
  if (free && prior && rawPrior) for (let i = 0; i < T; i++) if (prior[i] !== rawPrior[i]) free[i] = -1;
  const hasPrior = prior?.some((p) => typeof p === 'number') ?? false;
  let params = DEFAULT_DP;
  if (noText) {
    // No slide material at all (no text layer, no digest): nothing to align by but the timeline and the markers.
    E = input.segments.map((_, i) => Array.from({ length: N }, (_, s) => (prior?.[i] === s + 1 ? PRIOR_BONUS : 0)));
    En = input.segments.map((_, i) => (typeof prior?.[i] === 'number' ? 0 : 1));
    params = { ...DEFAULT_DP, startOff: 0 };
  } else {
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
  // How far the lecture had got before each slide marker: the alignment with only the off-slide markers, and in live
  // recordings the timeline (without the markers).
  let reached: ((t: number) => number) | undefined;
  if (markers.some((m) => m.slide !== null)) {
    const unmarked = viterbi(E, En, params, markerConstraints(input.segments, markers.filter((m) => m.slide === null), N), free);
    reached = furthestBefore(input.segments, unmarked);
  }
  const timelineReached = rawPrior?.some(Number.isInteger) ? furthestBefore(input.segments, rawPrior) : undefined;
  return viterbi(E, En, params, markerConstraints(input.segments, markers, N, reached, timelineReached), free);
}

// ---------------------------------------------------------------------------------------------------------------
// Live timeline prior
// ---------------------------------------------------------------------------------------------------------------

export interface LectureSpan {
  slide: number;
  from: number;
  to: number;
  /**
   * An adopted back-visit (the lecture went back below its furthest slide), and the rule that adopted it: 'long' when
   * its length (≥ BACK_SEC) did but its speech did not.
   */
  back?: 'lexical' | 'weak' | 'long';
}

/**
 * Views within this many seconds of the first one replace it as the start: the viewer was still settling when the
 * recording began (a smooth scroll after a page jump passes the slides in between; the student turns to the right
 * slide right after pressing record). Without it the dwell rule would need 30 s on the real slide to go "back" to it.
 */
export const START_SETTLE_SEC = 2;

/**
 * The student follows the lecture's screen 1–4 s late: a segment's timeline slide is the lecture span at its
 * midpoint + FOLLOW_LAG_SEC (the spans keep the student's arrival times).
 */
export const FOLLOW_LAG_SEC = 2;

/**
 * Views of other slides lasting less than this in total, between two views of one slide, do not end that slide's run
 * (the viewer's centre line crossing a neighbour while scrolling would otherwise restart the dwell).
 */
export const WOBBLE_SEC = 2;

/** Going forward to a slide the lecture had already reached (the end of a back-visit) counts after this dwell. */
export const RETURN_SEC = 2;

/**
 * A back-visit this long is the lecture's whatever was said (the live spike's dwell rule for going back); unless its
 * speech adopts it too, the DP still pays for going back there.
 */
export const BACK_SEC = 30;

/**
 * A back-visit of ≥ `sec` s is the lecture's when its speech prefers the visited slide to every rival (the lecture
 * slide, the next one, up to the slide the student returned to) by ≥ `margin`: summed weighted z-scores (dp.ts).
 */
export const BACK_LEXICAL = { sec: 3, margin: 2 };

/**
 * A back-visit of ≥ `sec` s whose speech does not contradict it (weak speech: filler, a question) is the lecture's:
 * ≥ `minSegments` segments said during it, no rival ahead of the visited slide in the summed evidence (margin ≥ 0),
 * and at most `maxHitShare` of its segments clearly about a rival (the rival scores ≥ hitZ and within hitGap of the
 * segment's best slide). Otherwise the professor went on while the student read an old slide. No tolerance below 0:
 * Korean transcripts write English terms in Hangul, so the professor's sentences about the lecture slide often score
 * only a little above the visited one (real whisper transcripts of the L7 fixtures: a tolerance took 20–50 % of the
 * student's own 15–25 s looks for the lecture's).
 */
export const BACK_WEAK = { sec: 6, minSegments: 2, hitZ: 2, hitGap: 0.5, maxHitShare: 0.15 };

/** The lexical evidence of the back-visit rules: dp.ts emissions of the segments said meanwhile. */
export interface BackEvidence {
  /** Segment midpoints. */
  mids: number[];
  /** dp.ts `emissions().E` rows parallel to `mids`, before any bonus; called at most once, and only when a back-visit has speech. */
  E: () => number[][];
}

type BackRule = NonNullable<LectureSpan['back']>;

interface ViewRun {
  slide: number;
  from: number;
  to: number;
}

/** The student's views as runs of one slide: settled start (START_SETTLE_SEC), wobbles (< WOBBLE_SEC) absorbed. */
function viewRuns(events: SlideViewEvent[], endSec: number): ViewRun[] {
  const valid = events.filter((e) => Number.isFinite(e.t) && Number.isInteger(e.slide)).sort((a, b) => a.t - b.t);
  let settled = 0;
  while (settled + 1 < valid.length && valid[settled + 1].t - valid[0].t <= START_SETTLE_SEC) settled++;
  const sorted = valid.length > 0 ? [{ t: valid[0].t, slide: valid[settled].slide }, ...valid.slice(settled + 1)] : [];
  const runs: ViewRun[] = [];
  sorted.forEach((e, i) => {
    const to = i + 1 < sorted.length ? sorted[i + 1].t : Math.max(endSec, e.t);
    // Back over the views since this slide's last run, as long as they add up to less than WOBBLE_SEC.
    let j = runs.length - 1;
    let gap = 0;
    while (j >= 0 && runs[j].slide !== e.slide && gap + (runs[j].to - runs[j].from) < WOBBLE_SEC) {
      gap += runs[j].to - runs[j].from;
      j--;
    }
    if (j >= 0 && runs[j].slide === e.slide) {
      runs.length = j + 1;
      runs[j].to = to;
    } else runs.push({ slide: e.slide, from: e.t, to });
  });
  return runs;
}

/**
 * The slide the lecture was on, derived from the student's slide views (live spike, asymmetric dwell rule, measured
 * over runs of one slide): a view becomes the lecture slide from the moment the student arrived when it lasts ≥ 5 s
 * (the next slide after the furthest one the lecture had reached, also straight from a back-visit), ≥ 15 s (a jump
 * ahead by 2+) or ≥ RETURN_SEC (forward to a slide the lecture had already reached).
 * Going back (a back-visit) is the lecture's by the speech during it (`evidence`: BACK_LEXICAL, BACK_WEAK) or after
 * BACK_SEC; without evidence only after BACK_SEC. Other visits (a look back, a peek ahead) are excursions of the
 * student. The first view (after START_SETTLE_SEC of settling) defines the start. Times in seconds on the recording
 * clock.
 */
export function lectureSpans(events: SlideViewEvent[], endSec: number, evidence?: BackEvidence): LectureSpan[] {
  const runs = viewRuns(events, endSec);
  let E: number[][] | undefined;
  // Is the look back `run` (the lecture on slide x; the student went on to `next`) the lecture's, and by which rule?
  const backRule = (run: ViewRun, x: number, next: number | null): BackRule | null => {
    const d = run.to - run.from;
    // After BACK_SEC it is the lecture's anyway; the rules below still tell whether the speech supports it.
    const long = d >= BACK_SEC ? 'long' : null;
    if (!evidence) return long;
    // The segments said during the look (read FOLLOW_LAG_SEC late, like the prior).
    const ks: number[] = [];
    evidence.mids.forEach((m, k) => {
      if (m + FOLLOW_LAG_SEC >= run.from && m + FOLLOW_LAG_SEC < run.to) ks.push(k);
    });
    // Nothing said yet (or a pause): nothing contradicts it.
    if (ks.length === 0) return d >= BACK_WEAK.sec ? 'weak' : null;
    E ??= evidence.E();
    const N = E[ks[0]]?.length ?? 0;
    if (run.slide < 1 || run.slide > N) return long;
    const rivals: number[] = [];
    for (let s = x; s <= Math.min(N, Math.max(x + 1, next ?? 0)); s++) if (s !== run.slide) rivals.push(s);
    let sY = 0;
    const sR = rivals.map(() => 0);
    let hits = 0;
    for (const k of ks) {
      const row = E[k];
      const best = Math.max(...row);
      sY += row[run.slide - 1];
      let hit = false;
      rivals.forEach((s, r) => {
        const v = row[s - 1];
        sR[r] += v;
        if (v >= BACK_WEAK.hitZ && v >= best - BACK_WEAK.hitGap) hit = true;
      });
      if (hit) hits++;
    }
    const margin = sY - Math.max(...sR);
    if (d >= BACK_LEXICAL.sec && margin >= BACK_LEXICAL.margin) return 'lexical';
    const weak = d >= BACK_WEAK.sec && ks.length >= BACK_WEAK.minSegments && margin >= 0 && hits <= BACK_WEAK.maxHitShare * ks.length;
    return weak ? 'weak' : long;
  };
  const spans: LectureSpan[] = [];
  let cur: LectureSpan | null = null;
  // The furthest slide the lecture went forward to (adopted back-visits do not move it).
  let frontier = 0;
  const switchTo = (slide: number, at: number, back?: BackRule) => {
    if (cur) spans.push({ ...cur, to: at });
    cur = back ? { slide, from: at, to: at, back } : { slide, from: at, to: at };
    if (!back) frontier = Math.max(frontier, slide);
  };
  runs.forEach((run, i) => {
    const c = cur as LectureSpan | null;
    if (!c) {
      switchTo(run.slide, run.from);
      return;
    }
    if (run.slide === c.slide) return;
    if (run.slide > c.slide) {
      // A new slide is measured from the frontier, also when coming back from a back-visit.
      const need = run.slide <= frontier ? RETURN_SEC : run.slide > frontier + 1 ? 15 : 5;
      if (run.to - run.from >= need) switchTo(run.slide, run.from);
      return;
    }
    const rule = backRule(run, c.slide, runs[i + 1]?.slide ?? null);
    if (rule) switchTo(run.slide, run.from, rule);
  });
  const last = cur as LectureSpan | null;
  if (last) spans.push({ ...last, to: Math.max(endSec, last.from) });
  if (spans.length > 0 && spans[0].from > 0) spans[0].from = 0;
  return spans.filter((s) => s.to >= s.from);
}

/** Index of the span holding time t (-1 when there is no view before or at t). */
function spanAt(spans: LectureSpan[], t: number): number {
  let found = -1;
  for (let k = 0; k < spans.length && spans[k].from <= t; k++) found = k;
  return found;
}

/** The lecture slide at time t (null when there is no view before or at t). */
export function slideAt(spans: LectureSpan[], t: number): number | null {
  const k = spanAt(spans, t);
  return k < 0 ? null : spans[k].slide;
}

/**
 * The timeline prior of every segment (the lecture slide at its midpoint + FOLLOW_LAG_SEC) and `free`: per segment the
 * 0-based slide of the back-visit its speech adopted ('lexical', 'weak') it falls in, also for the segment just before
 * a back-visit's first one (-1 = none; dp.ts enters it without the cost of going back).
 */
function timelineOf(
  segments: AlignSegment[],
  events: SlideViewEvent[],
  endSec: number,
  evidence?: () => number[][],
): { prior: Array<number | null>; free: Int32Array } {
  const free = new Int32Array(segments.length).fill(-1);
  if (events.length === 0) return { prior: segments.map(() => null), free };
  const mids = segments.map(midpoint);
  const spans = lectureSpans(events, endSec, evidence ? { mids, E: evidence } : undefined);
  const at = mids.map((m) => spanAt(spans, m + FOLLOW_LAG_SEC));
  const entered = new Set<number>();
  at.forEach((k, i) => {
    const slide = k >= 0 && (spans[k].back === 'lexical' || spans[k].back === 'weak') ? spans[k].slide - 1 : -1;
    if (slide < 0) return;
    free[i] = slide;
    if (!entered.has(k) && i > 0) free[i - 1] = slide;
    entered.add(k);
  });
  return { prior: at.map((k) => (k < 0 ? null : spans[k].slide)), free };
}

/**
 * Timeline prior of every segment (the lecture slide at its midpoint + FOLLOW_LAG_SEC). `evidence`: dp.ts emissions of
 * the segments (before any bonus) for the back-visit rules; without it a look back needs BACK_SEC.
 */
export function timelinePrior(segments: AlignSegment[], events: SlideViewEvent[], endSec: number, evidence?: () => number[][]): Array<number | null> {
  return timelineOf(segments, events, endSec, evidence).prior;
}
