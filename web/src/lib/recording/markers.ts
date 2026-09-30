// "여기부터 p.N" markers (DESIGN §22): manual corrections of the slide alignment. A marker says "from recording
// time t on, the lecture is on slide N" (null = off-slide); the server re-aligns with them as hard constraints
// (PUT …/markers answers the re-aligned transcript). The list is edited here and always sent whole. Pure helpers.
import type { AlignmentMarker, TranscriptSegment } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';

/** Two markers closer than this (seconds) are the same place: the newer one replaces the older. */
export const MARKER_SAME_PLACE_SEC = 0.5;

/** Marker times are stored to the centisecond (no floating-point dust in markers.json). */
function roundT(t: number): number {
  return Math.round(Math.max(0, t) * 100) / 100;
}

function validSlide(slide: number | null, pageCount: number | null): boolean {
  if (slide === null) return true;
  if (!Number.isInteger(slide) || slide < 1) return false;
  return pageCount === null || slide <= pageCount;
}

/**
 * Sorted by time, times rounded, invalid entries dropped, and of two markers at the same place the later one in
 * the input kept (the input is in edit order).
 */
export function normalizeMarkers(markers: readonly AlignmentMarker[], pageCount: number | null = null): AlignmentMarker[] {
  const out: AlignmentMarker[] = [];
  for (const m of markers) {
    if (!m || typeof m.t !== 'number' || !Number.isFinite(m.t)) continue;
    const slide = m.slide === null ? null : typeof m.slide === 'number' ? m.slide : NaN;
    if (!validSlide(slide as number | null, pageCount)) continue;
    const t = roundT(m.t);
    const same = out.findIndex((o) => Math.abs(o.t - t) < MARKER_SAME_PLACE_SEC);
    if (same >= 0) out.splice(same, 1);
    out.push({ t, slide: slide as number | null });
  }
  return out.sort((a, b) => a.t - b.t);
}

export type MarkerAction =
  /** Replace the whole list (loaded, or answered by the server). */
  | { type: 'set'; markers: readonly AlignmentMarker[] }
  /** "여기부터 p.N" (slide null: "여기부터 슬라이드 밖"). */
  | { type: 'add'; t: number; slide: number | null }
  /** Remove the marker at (about) `t`. */
  | { type: 'remove'; t: number }
  | { type: 'clear' };

/** The marker editing reducer: each action gives the complete, normalised list to PUT. */
export function markersReducer(
  state: readonly AlignmentMarker[],
  action: MarkerAction,
  pageCount: number | null = null,
): AlignmentMarker[] {
  switch (action.type) {
    case 'set':
      return normalizeMarkers(action.markers, pageCount);
    case 'add': {
      if (!Number.isFinite(action.t) || !validSlide(action.slide, pageCount)) return normalizeMarkers(state, pageCount);
      return normalizeMarkers([...state, { t: action.t, slide: action.slide }], pageCount);
    }
    case 'remove': {
      const t = roundT(action.t);
      return normalizeMarkers(
        state.filter((m) => Math.abs(m.t - t) >= MARKER_SAME_PLACE_SEC),
        pageCount,
      );
    }
    case 'clear':
      return [];
  }
}

/** Same markers (order and values)? — to skip a PUT that would change nothing. */
export function sameMarkers(a: readonly AlignmentMarker[], b: readonly AlignmentMarker[]): boolean {
  return a.length === b.length && a.every((m, i) => m.t === b[i].t && m.slide === b[i].slide);
}

/** The marker that starts at (about) this segment, if any. */
export function markerAtSegment(markers: readonly AlignmentMarker[], segment: TranscriptSegment): AlignmentMarker | null {
  return markers.find((m) => Math.abs(m.t - segment.start) < MARKER_SAME_PLACE_SEC) ?? null;
}

/** "여기부터 p.7" / "여기부터 슬라이드 밖" for a marker. */
export function markerLabel(marker: AlignmentMarker): string {
  const m = msg().recording.markers;
  return marker.slide === null ? m.fromHereOff : m.fromSlide(marker.slide);
}

/** "→ p.7" / "→ 슬라이드 밖": the short form on a marker chip. */
export function markerShortLabel(marker: AlignmentMarker): string {
  const m = msg().recording.markers;
  return marker.slide === null ? m.toOff : m.toSlide(marker.slide);
}

/**
 * A preview shown while the PUT runs: only the segment each marker points at takes the marker's slide. The
 * segments after it are left alone, because the server decides where the following slide begins.
 */
export function previewMarkers(
  segments: readonly TranscriptSegment[],
  markers: readonly AlignmentMarker[],
): TranscriptSegment[] {
  if (markers.length === 0) return [...segments];
  return segments.map((s) => {
    const m = markerAtSegment(markers, s);
    return m && m.slide !== s.slide ? { ...s, slide: m.slide } : s;
  });
}

/** Parses markers kept in localStorage (anything malformed → []). */
export function parseStoredMarkers(value: unknown): AlignmentMarker[] {
  if (!Array.isArray(value)) return [];
  return normalizeMarkers(
    value.filter(
      (m): m is AlignmentMarker =>
        !!m && typeof m === 'object' && typeof (m as AlignmentMarker).t === 'number' &&
        ((m as AlignmentMarker).slide === null || typeof (m as AlignmentMarker).slide === 'number'),
    ),
  );
}
