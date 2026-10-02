// A debug overlay for the tablet input (DESIGN §29), for diagnosis on the device itself — an iPad has no console:
// off by default, turned on with `?inkdebug=1` in the URL (remembered in sessionStorage, so it survives a reload and
// in-app navigation; `?inkdebug=0` turns it off). A small panel at the bottom left of the viewer lists the input
// events and what the viewer decided, one short line each ("pd pen id5 prim0 btn1 → ink", "pm×12 (coalesced 31,
// predicted 2)", "ts 2 (stylus 0) r=52 → palm", "stale gesture finished"), and a heartbeat of the main thread
// ("stall 840ms" when two frames are far apart). Imperative (no React state per event); when off, a call costs one
// comparison. The student screen-records it.
//
// The pure parts (the switch, the lines) are unit-tested: web/tests/touch-pan.test.ts.

const STORAGE_KEY = 'easy-study:inkdebug';
/** Lines shown. */
export const INK_DEBUG_LINES = 16;
/** A frequent event (a move) gets one line per this long (ms), with its count. */
export const INK_DEBUG_MOVE_MS = 250;
/** Two frames farther apart than this (ms) are a stall of the main thread. */
export const INK_DEBUG_STALL_MS = 250;

/** What the URL says: `?inkdebug=1` on, `?inkdebug=0` off, anything else nothing (null: what was remembered stays). */
export function inkDebugSwitch(search: string): boolean | null {
  const value = new URLSearchParams(search).get('inkdebug');
  return value === '1' ? true : value === '0' ? false : null;
}

/**
 * The lines of the overlay: the last INK_DEBUG_LINES, each stamped with the seconds since it was opened. Moves are
 * counted and written once per INK_DEBUG_MOVE_MS ("pm×12 (coalesced 31, predicted 2)") — and before any other line,
 * so the order reads as it happened.
 */
export class InkDebugLines {
  readonly lines: string[] = [];
  private pending: { key: string; since: number; count: number; coalesced: number; predicted: number } | null = null;
  /** When the overlay was opened (performance.now()). */
  private readonly t0: number;

  constructor(t0 = 0) {
    this.t0 = t0;
  }

  add(text: string, now: number): void {
    this.flush();
    this.push(text, now);
  }

  /**
   * A move of kind `key` ('pm', 'tm'); `coalesced` / `predicted`: the samples it carried (0: not said). True when it
   * wrote the line of the moves before it.
   */
  move(key: string, now: number, coalesced = 0, predicted = 0): boolean {
    const p = this.pending;
    const wrote = p !== null && (p.key !== key || now - p.since >= INK_DEBUG_MOVE_MS) && this.flush();
    this.pending ??= { key, since: now, count: 0, coalesced: 0, predicted: 0 };
    this.pending.count += 1;
    this.pending.coalesced += coalesced;
    this.pending.predicted += predicted;
    return wrote;
  }

  /** Writes the moves counted so far; true when there were some. */
  flush(): boolean {
    const p = this.pending;
    if (!p) return false;
    this.pending = null;
    const samples = p.coalesced > 0 || p.predicted > 0 ? ` (coalesced ${p.coalesced}, predicted ${p.predicted})` : '';
    this.push(`${p.key}×${p.count}${samples}`, p.since);
    return true;
  }

  /** Whether moves are waiting that are older than INK_DEBUG_MOVE_MS (the heartbeat writes them). */
  due(now: number): boolean {
    return this.pending !== null && now - this.pending.since >= INK_DEBUG_MOVE_MS;
  }

  private push(text: string, now: number): void {
    const seconds = Math.max(0, (now - this.t0) / 1000) % 1000;
    this.lines.push(`${seconds.toFixed(1).padStart(5)} ${text}`);
    if (this.lines.length > INK_DEBUG_LINES) this.lines.splice(0, this.lines.length - INK_DEBUG_LINES);
  }
}

const ms = (value: number): string => `${value < 10 ? value.toFixed(1) : Math.round(value)}ms`;

/** The overlay itself: one per page, attached to the viewer while it is mounted. */
class InkDebugPanel {
  /** Whether the overlay is shown: callers guard what is costly to format with it. */
  on = false;
  private el: HTMLElement | null = null;
  private lines = new InkDebugLines();
  private frame = 0;

  /**
   * Reads the switch (the URL, then sessionStorage) and, when it is on, shows the panel over `host` (the viewer) and
   * starts the heartbeat. Returns what takes it away again.
   */
  attach(host: HTMLElement): () => void {
    if (!this.enabled()) return () => {};
    const el = document.createElement('pre');
    el.className = 'ink-debug';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this.el = el;
    this.on = true;
    this.lines = new InkDebugLines(performance.now());
    // Fixed over the viewer's bottom left corner (measured now and then: the divider moves it).
    const place = () => {
      const box = host.getBoundingClientRect();
      el.style.left = `${Math.round(box.left + 8)}px`;
      el.style.bottom = `${Math.round(Math.max(0, window.innerHeight - box.bottom) + 8)}px`;
    };
    place();
    let last = performance.now();
    let frames = 0;
    const beat = (now: number) => {
      // A hidden page gets no frames: that is not a stall.
      if (now - last > INK_DEBUG_STALL_MS && document.visibilityState === 'visible') this.log(`stall ${Math.round(now - last)}ms`);
      last = now;
      if (this.lines.due(now) && this.lines.flush()) this.render();
      if (++frames % 60 === 0) place();
      this.frame = requestAnimationFrame(beat);
    };
    const onVisible = () => {
      last = performance.now();
    };
    this.frame = requestAnimationFrame(beat);
    document.addEventListener('visibilitychange', onVisible);
    this.log(`inkdebug on · touch points ${navigator.maxTouchPoints} · dpr ${window.devicePixelRatio}`);
    return () => {
      cancelAnimationFrame(this.frame);
      document.removeEventListener('visibilitychange', onVisible);
      el.remove();
      if (this.el === el) {
        this.el = null;
        this.on = false;
      }
    };
  }

  log(text: string): void {
    if (!this.on) return;
    this.lines.add(text, performance.now());
    this.render();
  }

  /** A move (throttled: one line per INK_DEBUG_MOVE_MS with the count). */
  move(key: string, coalesced = 0, predicted = 0): void {
    if (this.on && this.lines.move(key, performance.now(), coalesced, predicted)) this.render();
  }

  /** How long something took on the main thread, since `since` (performance.now()): "commit 12ms". */
  took(label: string, since: number): void {
    if (this.on) this.log(`${label} ${ms(performance.now() - since)}`);
  }

  private render(): void {
    if (this.el) this.el.textContent = this.lines.lines.join('\n');
  }

  private enabled(): boolean {
    try {
      const wanted = inkDebugSwitch(window.location.search);
      if (wanted === true) window.sessionStorage.setItem(STORAGE_KEY, '1');
      else if (wanted === false) window.sessionStorage.removeItem(STORAGE_KEY);
      return wanted ?? window.sessionStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // No sessionStorage (private mode): the URL alone decides.
      return inkDebugSwitch(window.location.search) === true;
    }
  }
}

export const inkDebug = new InkDebugPanel();
