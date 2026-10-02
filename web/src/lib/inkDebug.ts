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

/** While nothing moves, an "idle" line this often (ms). */
const IDLE_LINE_MS = 5000;
const MARK_LABEL = '방금 먹통이었음';

/** How many log lines are kept for the server (when it listens: EASY_STUDY_INK_DEBUG=1) between two sends. */
const SHIP_MAX_LINES = 400;

/**
 * The overlay itself: one per page, attached to the viewer while it is mounted. Above the event lines a status line
 * that is rewritten in place four times a second — a clock (the page is alive), frames per second, how many pen hover
 * moves, pen moves and touch moves arrived in the last second, the touches down, what has the focus — so a recording
 * of a dead period shows whether anything at all reaches the page. Besides the viewer's own lines it logs what arrives
 * at the window (every press, release and cancel of any pointer, touch starts and ends, mouse buttons, Safari's
 * gesture events, focus and visibility changes, selection, context menu, drag): what the viewer never saw is there.
 * With a server started with EASY_STUDY_INK_DEBUG=1 the lines are also sent to it once a second (its log shows them).
 * Above the panel a button, "방금 먹통이었음", that writes a MARK line: pressed after a dead period, it tells the period
 * from a pause.
 */
class InkDebugPanel {
  /** Whether the overlay is shown: callers guard what is costly to format with it. */
  on = false;
  private el: HTMLElement | null = null;
  private lines = new InkDebugLines();
  private frame = 0;
  private status = '';
  private counts = { frames: 0, hover: 0, pm: 0, tm: 0 };
  private touches = 0;
  private penDown = false;
  private outbox: string[] = [];
  private ship = true;

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
    // A mark for the log, pressed right after the input was dead for a while: a dead period and a pause look the
    // same in the log (nothing arrives in either), the mark says which one the lines before it were.
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'ink-debug-mark';
    mark.textContent = MARK_LABEL;
    let markTimer = 0;
    mark.addEventListener('click', () => {
      this.log('MARK: the input was dead just now');
      mark.textContent = '기록됨 ✓';
      window.clearTimeout(markTimer);
      markTimer = window.setTimeout(() => (mark.textContent = MARK_LABEL), 1500);
    });
    document.body.appendChild(mark);
    this.el = el;
    this.on = true;
    this.lines = new InkDebugLines(performance.now());
    // Fixed over the viewer's bottom left corner (measured now and then: the divider moves it), the mark above it.
    const place = () => {
      const box = host.getBoundingClientRect();
      const bottom = Math.round(Math.max(0, window.innerHeight - box.bottom) + 8);
      el.style.left = mark.style.left = `${Math.round(box.left + 8)}px`;
      el.style.bottom = `${bottom}px`;
      mark.style.bottom = `${bottom + el.offsetHeight + 6}px`;
    };
    place();
    let last = performance.now();
    let frames = 0;
    const beat = (now: number) => {
      // A hidden page gets no frames: that is not a stall.
      if (now - last > INK_DEBUG_STALL_MS && document.visibilityState === 'visible') this.log(`stall ${Math.round(now - last)}ms`);
      last = now;
      this.counts.frames += 1;
      if (++frames % 60 === 0) place();
      this.frame = requestAnimationFrame(beat);
    };
    const onVisible = () => {
      last = performance.now();
      this.log(`visibility ${document.visibilityState}`);
    };
    this.frame = requestAnimationFrame(beat);
    document.addEventListener('visibilitychange', onVisible);

    // What arrives at the window, whatever the viewer makes of it.
    const name = (target: EventTarget | null) => {
      const node = target instanceof Element ? target : null;
      if (!node) return '?';
      const cls = typeof node.className === 'string' ? node.className.split(' ')[0] : '';
      return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    const options = { capture: true, passive: true } as const;
    const listeners: [EventTarget, string, EventListener][] = [];
    const listen = (target: EventTarget, type: string, handler: (e: Event) => void) => {
      target.addEventListener(type, handler, options);
      listeners.push([target, type, handler]);
    };
    let hovering = false;
    let hoverAt = 0;
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
      listen(window, type, (e) => {
        const p = e as PointerEvent;
        if (p.pointerType === 'pen' && (type === 'pointerdown' || type === 'pointerup' || type === 'pointercancel')) this.penDown = type === 'pointerdown';
        this.log(`w:${type.replace('pointer', 'p-')} ${p.pointerType} id${p.pointerId} prim${p.isPrimary ? 1 : 0} btn${p.buttons} p${p.pressure.toFixed(2)} @${name(p.target)}`);
      });
    }
    listen(window, 'pointermove', (e) => {
      const p = e as PointerEvent;
      if (p.pointerType !== 'pen') return;
      if (p.buttons === 0) {
        this.counts.hover += 1;
        hoverAt = performance.now();
        if (!hovering) {
          hovering = true;
          this.log('w:hover start');
        }
      } else this.counts.pm += 1;
    });
    for (const type of ['touchstart', 'touchend', 'touchcancel']) {
      listen(window, type, (e) => {
        const t = e as TouchEvent;
        this.touches = t.touches.length;
        const kinds = Array.from(t.changedTouches, (touch) => ((touch as Touch & { touchType?: string }).touchType === 'stylus' ? 'S' : 'F')).join('');
        this.log(`w:${type.replace('touch', 't-')} ${kinds} → ${t.touches.length} down${t.cancelable ? '' : ' (uncancelable)'} @${name(t.target)}`);
      });
    }
    listen(window, 'touchmove', () => {
      this.counts.tm += 1;
    });
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'dragstart', 'gesturestart', 'gestureend', 'focusin', 'focusout', 'blur', 'focus', 'pagehide', 'pageshow']) {
      listen(window, type, (e) => this.log(`w:${type} @${name(e.target)}`));
    }
    let selectionAt = 0;
    listen(document, 'selectionchange', () => {
      const now = performance.now();
      if (now - selectionAt < 500) return;
      selectionAt = now;
      this.log(`w:selectionchange "${String(document.getSelection() ?? '').slice(0, 12)}"`);
    });

    let idleSince = performance.now();
    const tick = window.setInterval(() => {
      const now = performance.now();
      if (hovering && now - hoverAt > 400) {
        hovering = false;
        this.log('w:hover end');
      }
      const c = this.counts;
      const active = document.activeElement;
      this.status =
        `alive ${new Date().toTimeString().slice(3, 8)} · ${c.frames * 4}fps · hover ${c.hover * 4}/s · pen ${c.pm * 4}/s · touch ${c.tm * 4}/s · ` +
        `${this.touches} down${this.penDown ? ' · PEN DOWN' : ''}${hovering ? ' · hovering' : ''} · focus ${name(active)}`;
      // A summary for the server when something moved; while nothing does, a line now and then (the page is alive,
      // what it believes of the focus and the touches): a silent stretch of the log is a pause or a dead period.
      if (c.hover || c.pm || c.tm) {
        idleSince = now;
        if (this.outbox.length < SHIP_MAX_LINES) this.outbox.push(`      ~ hover ${c.hover} pen ${c.pm} touch ${c.tm} frames ${c.frames} (250ms)`);
      } else if (now - idleSince >= IDLE_LINE_MS && document.visibilityState === 'visible') {
        idleSince = now;
        this.log(`idle · ${c.frames * 4}fps · ${this.touches} down${this.penDown ? ' · PEN DOWN' : ''} · focus ${name(active)}${document.hasFocus() ? '' : ' · window not focused'}`);
      }
      this.counts = { frames: 0, hover: 0, pm: 0, tm: 0 };
      this.render();
      // The panel grew or shrank: the mark stays above it.
      place();
    }, 250);
    const shipper = window.setInterval(() => this.send(), 1000);

    this.log(`inkdebug on · touch points ${navigator.maxTouchPoints} · dpr ${window.devicePixelRatio} · ${navigator.userAgent.replace(/^.*?\(([^)]*)\).*?(Version\/[\d.]+)?.*$/, '$1 $2')}`);
    return () => {
      cancelAnimationFrame(this.frame);
      window.clearInterval(tick);
      window.clearInterval(shipper);
      document.removeEventListener('visibilitychange', onVisible);
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, options);
      window.clearTimeout(markTimer);
      el.remove();
      mark.remove();
      if (this.el === el) {
        this.el = null;
        this.on = false;
      }
    };
  }

  log(text: string): void {
    if (!this.on) return;
    this.lines.add(text, performance.now());
    if (this.outbox.length < SHIP_MAX_LINES) this.outbox.push(this.lines.lines[this.lines.lines.length - 1]);
    this.render();
  }

  /** For the server's log only (a stroke's raw samples): not shown in the panel. */
  raw(text: string): void {
    if (this.on && this.outbox.length < SHIP_MAX_LINES) this.outbox.push(text);
  }

  /** A move: counted in the status line (moves would push everything else out of the panel). */
  move(key: string, _coalesced = 0, _predicted = 0): void {
    if (!this.on) return;
    if (key === 'hover while down') this.log(key);
  }

  /** How long something took on the main thread, since `since` (performance.now()): "commit 12ms". */
  took(label: string, since: number): void {
    if (this.on) this.log(`${label} ${ms(performance.now() - since)}`);
  }

  private render(): void {
    if (this.el) this.el.textContent = `${this.status}\n${this.lines.lines.join('\n')}`;
  }

  /** Sends the lines since the last send to the server (it shows them only when started for it; a 404 ends the sending). */
  private send(): void {
    if (!this.ship || this.outbox.length === 0) return;
    const body = this.outbox.join('\n');
    this.outbox = [];
    fetch('/api/debug/ink', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true }).then(
      (res) => {
        if (res.status === 404) this.ship = false;
      },
      () => {},
    );
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
