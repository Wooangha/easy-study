// Playback speed of the 녹음 tab player (DESIGN §22): a 0.5×–3× slider whose dragged thumb follows the pointer and
// is drawn onto its tick marks, arrow keys in 0.05 steps, a typed rate, and the stored value. Pure helpers, no DOM.

export const MIN_RATE = 0.5;
export const MAX_RATE = 3;
/** The slider's step: arrow keys, and the rate a dragged thumb sets between the tick marks. */
export const RATE_STEP = 0.05;
/** The slider's tick marks: they draw a dragged thumb onto them; PageUp / PageDown jump between them. */
export const SNAP_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
/**
 * How far (in ×, on either side) a tick mark holds a dragged thumb on it: about 3.5 px of the bubble's slider.
 */
export const MAGNET_HOLD = 0.04;
/**
 * How far (in ×, on either side) a tick mark's pull reaches, about 9 px: between it and MAGNET_HOLD the thumb moves
 * faster than the pointer, so it slides onto the mark and off it again without a jump. Under half the 0.25 between
 * two marks, so the thumb follows the pointer freely in between.
 */
export const MAGNET_REACH = 0.1;

// Rates are handled in hundredths so 0.05 steps do not drift (0.1 + 0.2).
const cents = (rate: number): number => Math.round(rate * 100);
const STEP_CENTS = cents(RATE_STEP);

/** A stored rate (localStorage): any number in range, not only the tick marks. */
export const isPlaybackRate = (v: unknown): v is number => typeof v === 'number' && v >= MIN_RATE && v <= MAX_RATE;

/** Into [MIN_RATE, MAX_RATE] (a typed 9 → 3). */
export function clampRate(rate: number): number {
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/** A fraction of the slider's travel (0 at its left end … 1 at its right end) → the rate there, not clamped. */
export function rateAt(fraction: number): number {
  return MIN_RATE + fraction * (MAX_RATE - MIN_RATE);
}

/**
 * Where a dragged thumb is drawn for the pointer's rate `raw`: under the pointer, except near a tick mark, which
 * holds it within MAGNET_HOLD and draws it in from MAGNET_REACH (the thumb catches up with the pointer at the edge
 * of the reach, so the mapping has no jumps). Not rounded: the thumb moves as smoothly as the pointer.
 */
export function pullToMark(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const r = clampRate(raw);
  let mark: number = SNAP_RATES[0];
  for (const m of SNAP_RATES) if (Math.abs(r - m) < Math.abs(r - mark)) mark = m;
  const off = Math.abs(r - mark);
  if (off <= MAGNET_HOLD) return mark;
  if (off >= MAGNET_REACH) return r;
  return mark + (Math.sign(r - mark) * (off - MAGNET_HOLD) * MAGNET_REACH) / (MAGNET_REACH - MAGNET_HOLD);
}

/** The rate a thumb drawn at `pos` sets: the nearest 0.05 step (a tick mark the thumb is held on is one). */
export function dragRate(pos: number): number {
  if (!Number.isFinite(pos)) return 1;
  return (Math.round(cents(clampRate(pos)) / STEP_CENTS) * STEP_CENTS) / 100;
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
