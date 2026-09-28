// Playback speed of the 녹음 tab player (DESIGN §22): a 0.5×–3× slider that sticks to its tick marks while
// dragged, arrow keys in 0.05 steps, a typed rate, and the stored value. Pure helpers, no DOM.

export const MIN_RATE = 0.5;
export const MAX_RATE = 3;
/** The slider's step (arrow keys, and where a dragged value lands between the tick marks). */
export const RATE_STEP = 0.05;
/** The slider's tick marks: a dragged value close to one sticks to it; PageUp / PageDown jump between them. */
export const SNAP_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
/**
 * How far a tick mark pulls the dragged thumb, on either side (CSS px of the thumb's travel): a clear "snap" into
 * place, the same feel on a short or a long slider (snapThreshold).
 */
export const SNAP_PX = 5;
/**
 * The most a mark pulls (in ×): marks 0.25 apart still leave the steps halfway between them (1.1, 1.15) to drag to.
 * The steps right next to a mark (1.2, 1.3) are typed in the box.
 */
export const MAX_SNAP = 0.08;
/** The pull before the slider has been measured. */
export const SNAP_THRESHOLD = 0.06;

// Rates are handled in hundredths so 0.05 steps do not drift (0.1 + 0.2).
const cents = (rate: number): number => Math.round(rate * 100);
const STEP_CENTS = cents(RATE_STEP);

/** A stored rate (localStorage): any number in range, not only the tick marks. */
export const isPlaybackRate = (v: unknown): v is number => typeof v === 'number' && v >= MIN_RATE && v <= MAX_RATE;

/** Into [MIN_RATE, MAX_RATE] (a typed 9 → 3). */
export function clampRate(rate: number): number {
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/** The snap threshold (in ×) of a slider whose thumb travels `trackPx`: SNAP_PX of track, at most MAX_SNAP. */
export function snapThreshold(trackPx: number): number {
  if (!(trackPx > 0)) return SNAP_THRESHOLD;
  return Math.min(MAX_SNAP, Math.round((SNAP_PX * cents(MAX_RATE - MIN_RATE)) / trackPx) / 100);
}

/**
 * A position the pointer dragged the slider to (the input's fine value) → the rate: the tick mark within
 * `threshold` of it, else the nearest 0.05 step.
 */
export function snapDraggedRate(raw: number, threshold: number = SNAP_THRESHOLD): number {
  if (!Number.isFinite(raw)) return 1;
  const c = cents(clampRate(raw));
  const reach = cents(threshold);
  for (const mark of SNAP_RATES) if (Math.abs(c - cents(mark)) <= reach) return mark;
  return clampRate((Math.round(c / STEP_CENTS) * STEP_CENTS) / 100);
}

/**
 * One arrow-key step (dir +1 / −1): the next 0.05 step in that direction, with no snapping, so the keys never get
 * stuck on a tick mark. A typed rate between steps (1.33) moves to the step next to it (1.35 / 1.3).
 */
export function stepRate(rate: number, dir: 1 | -1): number {
  const c = cents(clampRate(rate));
  const next = dir > 0 ? (Math.floor(c / STEP_CENTS) + 1) * STEP_CENTS : (Math.ceil(c / STEP_CENTS) - 1) * STEP_CENTS;
  return clampRate(next / 100);
}

/** PageUp / PageDown: the next tick mark in that direction (the end of the range past the last one). */
export function nextSnapRate(rate: number, dir: 1 | -1): number {
  const c = cents(rate);
  if (dir > 0) return SNAP_RATES.find((m) => cents(m) > c) ?? MAX_RATE;
  return [...SNAP_RATES].reverse().find((m) => cents(m) < c) ?? MIN_RATE;
}

/**
 * A typed rate → the number rounded to 2 decimals, not yet clamped; null when it is not a plain positive number.
 * Accepts a trailing ×/x/배 and a decimal comma: "1.25", "1.25×", "1,5", " 2x ", ".75".
 */
export function parseRate(text: string): number | null {
  const t = text
    .trim()
    .replace(/\s*(?:×|x|X|배속?)$/, '')
    .replace(',', '.');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return null;
  // Rounded in decimal ("1.005" → 1.01), not as 1.005 × 100 = 100.49999…
  const n = Math.round(Number(`${t}e2`)) / 100;
  return Number.isFinite(n) ? n : null;
}

/** "1", "1.5", "1.25", "0.75" — the number shown next to "×". */
export function formatRate(rate: number): string {
  return String(cents(rate) / 100);
}

/** Where a rate sits on the slider (0 at MIN_RATE … 1 at MAX_RATE): the tick marks and the filled track. */
export function rateFraction(rate: number): number {
  return (clampRate(rate) - MIN_RATE) / (MAX_RATE - MIN_RATE);
}
