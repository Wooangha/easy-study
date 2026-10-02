// Fingers on the slides under 펜 / 지우개 (DESIGN §29), the pure part. In that mode the browser does nothing of its own
// with a touch over the slides (`touch-action: none`): a palm resting next to the pen must not start a native scroll,
// which would swallow the pen's touches for as long as it tracks. The viewer handles fingers itself (SlideViewer's
// touch listeners): one finger pans the scroller, with some inertia after it lifts; two pinch (lib/zoom.ts); and the
// hand that holds the pen is told from a finger that means it (PalmGuard) — what it scrolled just before the pen
// landed is undone (undoneByPen).
//
// No DOM here (unit-tested, web/tests/touch-pan.test.ts): the viewer listens and scrolls, these decide.
import type { Point } from './attachments.ts';

// ---- Palm rejection ---------------------------------------------------------------------------------------------

/**
 * A finger that lands this soon (ms) after the pen last touched the slides or lifted belongs to the hand that holds
 * it. Not after a hover: the pen is held over the slide all the while one writes, and a finger of the other hand (or
 * of the same one) that lands then scrolls.
 */
export const PEN_QUIET_MS = 400;
/**
 * A contact this large (Touch.radiusX / radiusY, CSS px) is a palm or the side of a hand. A fingertip reports about
 * 20, the flat pad of a finger about 30 (iPadOS steps of ~10), a palm 50 and more: 40 keeps both ways of scrolling.
 */
export const PALM_RADIUS_PX = 40;
/**
 * The pen counts as down for this long (ms) after its last event without a release: a pen held still sends nothing,
 * but neither does one whose pointerup was lost — fingers must not stay ignored for good. Its next event with
 * contact brings it back (and turns the fingers that landed meanwhile into the palm).
 */
export const PEN_DOWN_STALE_MS = 3000;

/**
 * When the pen lands, what fingers scrolled or pinched up to this long (ms) before is undone: the hand was settling
 * down. A finger that scrolled earlier and has rested since meant it — it stops scrolling, the slides stay.
 */
export const PALM_UNDO_MS = 1000;

/** Whether a pan / pinch whose fingers last moved at `movedAt` is undone by the pen landing at `now`. */
export const undoneByPen = (movedAt: number, now: number): boolean => now - movedAt <= PALM_UNDO_MS;

/**
 * A finger counts as moving once it is this far (CSS px) from where it last did: one that rests on the glass still
 * sends moves of a pixel or less, and those must not keep its scroll "just made" (undoneByPen).
 */
export const PAN_REST_PX = 3;

/** What a finger on the slides does: 'pan' scrolls and pinches, 'palm' is ignored until it lifts. */
export type FingerRole = 'pan' | 'palm';

/**
 * Which fingers are the palm. A finger keeps the role it got when it landed, except that 'pan' turns 'palm' (never
 * back) when the pen lands or its contact grows large:
 * - it landed while the pen was down, or within PEN_QUIET_MS after the pen's last contact or release (a hover says
 *   nothing: the viewer does not report it);
 * - it was down at any moment while the pen was down;
 * - its contact is PALM_RADIUS_PX or larger — when it lands, or before it has moved the slides: a finger that scrolls
 *   or pinches already (`began`) is not a palm because its pad flattens on the way.
 * Times are any monotonic clock in ms (performance.now()).
 */
export class PalmGuard {
  private readonly roles = new Map<number, FingerRole>();
  /** The fingers whose pan or pinch has begun: their size no longer tells. */
  private readonly moving = new Set<number>();
  private down = false;
  private seenAt = Number.NEGATIVE_INFINITY;

  /** Whether the pen is on the glass, as far as its events say (not for longer than PEN_DOWN_STALE_MS without one). */
  penIsDown(now: number): boolean {
    return this.down && now - this.seenAt < PEN_DOWN_STALE_MS;
  }

  /**
   * An event of the pen that is not a hover; `contact` = it touches the slides (a press, a move with a button or
   * pressure), else it lifts or is at work elsewhere. True when it has just landed: every finger that scrolled is
   * the palm from now on, and what its pan or pinch did is to be undone.
   */
  pen(now: number, contact: boolean): boolean {
    const landed = contact && !this.penIsDown(now);
    this.down = contact;
    this.seenAt = now;
    if (landed) for (const [id, role] of this.roles) if (role === 'pan') this.roles.set(id, 'palm');
    return landed;
  }

  /**
   * The pen is up, whatever became of its pointerup: the touches on the glass show no stylus any more, or it hovers.
   * The quiet time is not touched (it runs from the pen's last contact or release).
   */
  penLifted(): void {
    this.down = false;
  }

  /** A finger landed (`radius`: the larger of its radiusX / radiusY, 0 when unknown). */
  start(id: number, now: number, radius = 0): FingerRole {
    const palm = this.penIsDown(now) || now - this.seenAt < PEN_QUIET_MS || radius >= PALM_RADIUS_PX;
    const role: FingerRole = palm ? 'palm' : 'pan';
    this.roles.set(id, role);
    return role;
  }

  /**
   * A finger moved: one whose contact grew large before it moved the slides (a hand settling down) is the palm from
   * then on.
   */
  move(id: number, radius = 0): FingerRole | undefined {
    const role = this.roles.get(id);
    if (role === 'pan' && radius >= PALM_RADIUS_PX && !this.moving.has(id)) {
      this.roles.set(id, 'palm');
      return 'palm';
    }
    return role;
  }

  /** The finger's pan or pinch has begun (it moves the slides): from now on only the pen landing makes it the palm. */
  began(id: number): void {
    if (this.roles.get(id) === 'pan') this.moving.add(id);
  }

  end(id: number): void {
    this.roles.delete(id);
    this.moving.delete(id);
  }

  /** The role of a finger on the slides; undefined for a touch that is not one (a stylus, a touch on a control). */
  role(id: number): FingerRole | undefined {
    return this.roles.get(id);
  }

  /** Forgets the fingers that are not on the glass any more (a touchend that never arrived). */
  keep(ids: ReadonlySet<number>): void {
    for (const id of this.roles.keys()) if (!ids.has(id)) this.end(id);
  }
}

// ---- One finger pans --------------------------------------------------------------------------------------------

/** A finger must move this far (CSS px) before it scrolls (a resting finger jitters; a tap is not a scroll). */
export const PAN_SLOP_PX = 8;
/** The velocity of a release is measured over this long (ms) before it. */
export const PAN_VELOCITY_MS = 100;
/** A release slower than this (px/ms) just stops. */
export const INERTIA_MIN_SPEED = 0.15;
/** No release is faster than this (px/ms): one late sample must not throw the slides away. */
export const INERTIA_MAX_SPEED = 4;
/** The time constant (ms) of the decay: the speed falls to 1/e in this long; a fling travels speed × this in all. */
export const INERTIA_DECAY_MS = 325;
/** The inertia ends below this speed (px/ms). */
export const INERTIA_STOP_SPEED = 0.02;

/** Where a finger was (client px) at a time (ms, the touch event's timeStamp). */
export interface PanSample {
  t: number;
  x: number;
  y: number;
}

const NO_VELOCITY: Point = { x: 0, y: 0 };

/**
 * The finger's velocity (px/ms) when it lifts at `now`: from its oldest sample of the last PAN_VELOCITY_MS to its
 * newest, over the time up to the release — a finger that stopped before lifting has none. Capped at
 * INERTIA_MAX_SPEED.
 */
export function panVelocity(samples: readonly PanSample[], now: number): Point {
  const recent = samples.filter((s) => now - s.t <= PAN_VELOCITY_MS && s.t <= now);
  if (recent.length < 2) return NO_VELOCITY;
  const from = recent[0];
  const to = recent[recent.length - 1];
  const dt = now - from.t;
  if (!(dt > 0)) return NO_VELOCITY;
  const vx = (to.x - from.x) / dt;
  const vy = (to.y - from.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (!(speed > 0)) return NO_VELOCITY;
  const k = Math.min(1, INERTIA_MAX_SPEED / speed);
  return { x: vx * k, y: vy * k };
}

/** Whether a release at this velocity glides on. */
export const startsInertia = (v: Point): boolean => Math.hypot(v.x, v.y) >= INERTIA_MIN_SPEED;

/** How far (px) a glide released at `v` has travelled after `elapsed` ms: v × τ × (1 − e^(−t/τ)). */
export function inertiaTravel(v: Point, elapsed: number): Point {
  const k = INERTIA_DECAY_MS * (1 - Math.exp(-Math.max(0, elapsed) / INERTIA_DECAY_MS));
  return { x: v.x * k, y: v.y * k };
}

/** Whether the glide is over: its speed fell below INERTIA_STOP_SPEED. */
export function inertiaDone(v: Point, elapsed: number): boolean {
  return Math.hypot(v.x, v.y) * Math.exp(-Math.max(0, elapsed) / INERTIA_DECAY_MS) < INERTIA_STOP_SPEED;
}

/**
 * Whether a glide has nothing left to do: it is slow (inertiaDone), or each axis is either `blocked` (the scroller did
 * not take the position: an end of the scroll, or no scroll that way at all) or has less than a pixel left to go. A
 * fling that reached the top must not keep its frames running because the slides cannot move sideways either.
 */
export function glideOver(v: Point, elapsed: number, blocked: { x: boolean; y: boolean }): boolean {
  if (inertiaDone(v, elapsed)) return true;
  const left = INERTIA_DECAY_MS * Math.exp(-Math.max(0, elapsed) / INERTIA_DECAY_MS);
  return (blocked.x || Math.abs(v.x) * left < 1) && (blocked.y || Math.abs(v.y) * left < 1);
}
