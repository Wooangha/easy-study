// Transcript ↔ time ↔ slide mapping for the 녹음 tab (DESIGN §22): which segment is playing, which slide is
// being discussed (for "슬라이드 따라가기"), the transcript grouped under slide headers, and clock labels.
// Pure helpers, no DOM.
import type { TranscriptSegment } from '../../../../shared/types.ts';

/** "0:05", "12:34", "1:02:03" (seconds, floored). */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "3분 12초", "45초", "1시간 2분" — for sentences. */
export function formatSpan(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  if (s < 60) return `${s}초`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  const rest = s % 60;
  return rest > 0 ? `${m}분 ${rest}초` : `${m}분`;
}

/** Segments in time order (ids are increasing, but a re-transcription may deliver them out of order). */
export function sortSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((a, b) => a.start - b.start || a.id - b.id);
}

/**
 * Index of the segment playing at `t` (seconds): the last segment that started at or before `t` — during a pause
 * between two segments that is the earlier one, so the highlight does not flicker. −1 before the first one.
 * `segments` must be in time order.
 */
export function segmentIndexAt(segments: readonly TranscriptSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The slide being discussed at `t`, for "슬라이드 따라가기": the slide of the segment playing then; an off-slide
 * segment (slide null: an announcement, a tangent) keeps the slide said before it; null when nothing is known yet.
 */
export function slideAtTime(segments: readonly TranscriptSegment[], t: number): number | null {
  for (let i = segmentIndexAt(segments, t); i >= 0; i--) {
    const slide = segments[i].slide;
    if (slide !== null) return slide;
  }
  // Before the first segment: the first slide that will be discussed.
  for (const s of segments) if (s.slide !== null) return s.slide;
  return null;
}

/** A run of consecutive segments said on the same slide (null = off-slide), for the slide headers. */
export interface TranscriptGroup {
  slide: number | null;
  /** Time of the first segment. */
  start: number;
  segments: TranscriptSegment[];
}

/** The transcript as runs of consecutive segments with the same slide (time order in, time order out). */
export function groupBySlide(segments: readonly TranscriptSegment[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    if (last && last.slide === seg.slide) last.segments.push(seg);
    else groups.push({ slide: seg.slide, start: seg.start, segments: [seg] });
  }
  return groups;
}

/**
 * The runs said on `slide` ("현재 슬라이드" mode): a slide can be discussed more than once (the professor came
 * back to it), so the runs are kept apart and shown with their start time.
 */
export function groupsOfSlide(segments: readonly TranscriptSegment[], slide: number): TranscriptGroup[] {
  return groupBySlide(segments).filter((g) => g.slide === slide);
}

/** Seconds of speech per slide (the list's "p.7 · 2분 10초"), from segment durations. */
export function speechSecondsBySlide(segments: readonly TranscriptSegment[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of segments) {
    if (s.slide === null) continue;
    out.set(s.slide, (out.get(s.slide) ?? 0) + Math.max(0, s.end - s.start));
  }
  return out;
}

/**
 * Minutes of recent speech the tutor gets while a live recording of the document runs (DESIGN §22: "The last N
 * minutes of the lecture", the composer chip "🎙 최근 3분 포함"): the elapsed recording time, rounded up, capped.
 */
export function recentMinutes(elapsedSeconds: number, cap = 3): number {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 0;
  return Math.min(cap, Math.max(1, Math.ceil(elapsedSeconds / 60)));
}

/** How far the live transcript is behind the recording (seconds, never negative). */
export function transcriptLag(recordedSec: number, transcribedSec: number): number {
  return Math.max(0, recordedSec - transcribedSec);
}

/**
 * A playback target past what the player loaded: a live recording's WAV has the length it had when it was loaded,
 * so the player is reloaded before seeking there (`loadedSec`: the element's duration, NaN before the metadata).
 */
export function pastLoadedEnd(loadedSec: number, t: number): boolean {
  const loaded = Number.isFinite(loadedSec) ? loadedSec : 0;
  return t > loaded - 0.25;
}
