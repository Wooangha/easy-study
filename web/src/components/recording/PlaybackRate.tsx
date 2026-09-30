// The playback speed of the 녹음 tab player (DESIGN §22): a small button with the rate ("1.25×") that opens a speech
// bubble coming out of it, with a 0.5×–3× slider and a box to type any rate. The slider's thumb follows the pointer
// and is drawn onto the tick marks near it; arrow keys move in 0.05 steps (PageUp / PageDown: the next mark,
// Home / End, double-click: 1×). The rules are in lib/recording/rate.ts.
import { RotateCcw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { msg } from '../../i18n/index.ts';
import {
  MAX_RATE,
  MIN_RATE,
  SNAP_RATES,
  clampRate,
  dragRate,
  formatRate,
  nextSnapRate,
  parseRate,
  pullToMark,
  rateAt,
  rateFraction,
  stepRate,
} from '../../lib/recording/rate.ts';
import { toast } from '../../lib/toast.ts';

/** Between the button and the bubble: room for the tail (styles.css draws it 8px out of the bubble). */
const GAP = 10;
/** The bubble keeps this far from the window's edges. */
const MARGIN = 8;
/** The tail stays this far from the bubble's ends (its rounded corners). */
const TAIL_INSET = 16;
/** The slider thumb's width (--thumb in styles.css): a press this close to its center picks it up where it is. */
const THUMB_PX = 16;
/**
 * How far (px, sideways) a pressed mouse moves before the press becomes a drag; a finger or a pen gets more. A tap
 * wobbles (a trackpad click, a finger): under this it changes nothing.
 */
const MOUSE_SLOP = 3;
const TOUCH_SLOP = 6;
/** The tick marks with a number under them. */
const LABELLED_RATES: readonly number[] = [0.5, 1, 1.5, 2, 2.5, 3];

interface Placement {
  top: number;
  left: number;
  /** Where the tail points (the button's center), from the bubble's left edge. */
  tail: number;
  /** Below the button: there was no room above it. */
  below: boolean;
}

export function PlaybackRate({ rate, onChange }: { rate: number; onChange: (rate: number) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const bubbleId = useId();
  const m = msg().recording.rate;

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    setPos(null);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  // Above the button (the player sits at the bottom of the pane), below it only when there is more room there;
  // centered on it, kept inside the window, with the tail pointing at the button. It follows the button when the
  // page scrolls or resizes, and closes once the button is off screen.
  const place = useCallback(() => {
    const button = buttonRef.current;
    const bubble = bubbleRef.current;
    if (!button || !bubble) return;
    const b = button.getBoundingClientRect();
    const viewW = document.documentElement.clientWidth;
    const viewH = window.innerHeight;
    if (b.bottom < 0 || b.top > viewH) {
      close(false);
      return;
    }
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const roomAbove = b.top - GAP - MARGIN;
    const roomBelow = viewH - b.bottom - GAP - MARGIN;
    const below = roomAbove < height && roomBelow > roomAbove;
    const top = below ? Math.min(b.bottom + GAP, viewH - MARGIN - height) : Math.max(MARGIN, b.top - GAP - height);
    const center = b.left + b.width / 2;
    const left = Math.max(MARGIN, Math.min(viewW - MARGIN - width, center - width / 2));
    const tail = Math.max(TAIL_INSET, Math.min(width - TAIL_INSET, center - left));
    const next = { top, left, tail, below };
    setPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.tail === next.tail && prev.below === next.below
        ? prev
        : next,
    );
  }, [close]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Opening puts the keyboard on the slider (the arrow keys change the rate right away).
  const focused = useRef(false);
  useEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    if (!pos || focused.current) return;
    focused.current = true;
    sliderRef.current?.focus({ preventScroll: true });
  }, [open, pos]);

  // A press outside the button and the bubble closes it (a rate typed in the box is applied: see RateBox). The
  // player row reflowing under it (an error line, a wider time pushing the rest onto a second line, the pane
  // resized) moves the button: the bubble follows.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: globalThis.PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const row = wrapRef.current?.parentElement;
    const reflow = row && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null;
    if (row) reflow?.observe(row);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      reflow?.disconnect();
    };
  }, [open, close, place]);

  // A Tab key being handled: focus that leaves the page during it (WebKit's Tab skips buttons and checkboxes by
  // default, so from the slider it can leave the page) is the keyboard leaving the bubble too.
  const tabbing = useRef(false);

  return (
    <span
      ref={wrapRef}
      className="rec-rate"
      // Escape closes the bubble (after the box has dropped a typed rate: RateBox takes that Escape) and gives the
      // keyboard back to the button; Tab out of it closes it too.
      onKeyDown={(e) => {
        if (!open || e.defaultPrevented) return;
        if (e.key === 'Tab') {
          tabbing.current = true;
          window.setTimeout(() => {
            tabbing.current = false;
          }, 0);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close(true);
        }
      }}
      onBlur={(e) => {
        if (!open) return;
        // Focus that goes nowhere otherwise (a click on nothing, another app) leaves the bubble open.
        const to = e.relatedTarget;
        if (to instanceof Node ? !e.currentTarget.contains(to) : tabbing.current) close(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="rec-rate-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? bubbleId : undefined}
        aria-label={m.button(formatRate(rate))}
        title={m.title}
        onClick={() => {
          if (!open) setOpen(true);
          // The keyboard was in the bubble: it comes back to the button, not to the page.
          else close(!!bubbleRef.current?.contains(document.activeElement));
        }}
      >
        {formatRate(rate)}×
      </button>
      {open && (
        // Not in a portal: in the page's order right after the button, Tab goes from the bubble on to the rest of
        // the player. Fixed positioning keeps it out of the row and unclipped.
        <div
          ref={bubbleRef}
          id={bubbleId}
          role="dialog"
          aria-label={m.title}
          tabIndex={-1}
          className={`rec-rate-pop${pos?.below ? ' is-below' : ''}`}
          style={
            pos
              ? ({ top: pos.top, left: pos.left, '--tail': `${pos.tail}px` } as CSSProperties)
              : { top: 0, left: 0, visibility: 'hidden' }
          }
        >
          <div className="rec-rate-head">
            <span className="rec-rate-title" aria-hidden>
              {m.title}
            </span>
            <RateBox rate={rate} onChange={onChange} />
            <button
              type="button"
              className="rec-rate-reset"
              disabled={rate === 1}
              aria-label={m.reset}
              title={m.resetTitle}
              onClick={() => {
                onChange(1);
                sliderRef.current?.focus({ preventScroll: true });
              }}
            >
              <RotateCcw /> 1×
            </button>
          </div>
          <RateSlider rate={rate} onChange={onChange} sliderRef={sliderRef} />
        </div>
      )}
    </span>
  );
}

/**
 * The slider (role="slider"), drawn here: the thumb follows a dragging pointer continuously and is drawn onto the
 * tick marks near it (pullToMark); the rate follows it in 0.05 steps (dragRate) and applies at once. A press on
 * the thumb picks it up where it is (a tap on it changes nothing); a press elsewhere on the track brings it there.
 * Without a pointer dragging it the thumb glides to its rate (a pressed track, the release of a drag, a key, a
 * typed rate).
 */
function RateSlider({
  rate,
  onChange,
  sliderRef,
}: {
  rate: number;
  onChange: (rate: number) => void;
  sliderRef: RefObject<HTMLDivElement | null>;
}) {
  const railRef = useRef<HTMLSpanElement>(null);
  const m = msg().recording.rate;
  // While a pointer holds the thumb: where the thumb is drawn, and whether the press has become a drag yet (until
  // then the thumb glides to the pressed place instead of jumping).
  const [drag, setDrag] = useState<{ pos: number; moving: boolean } | null>(null);
  // The pointer holding the thumb: where it was pressed and how far it may wobble there (MOUSE_SLOP / TOUCH_SLOP),
  // the rate between it and the thumb's center (picked up off-center), the rate last applied, and once it is a drag,
  // the px the thumb keeps behind it (the slop, so the thumb sets off from where it is instead of jumping).
  const grip = useRef<{
    pointer: number;
    x: number;
    slop: number;
    offset: number;
    sent: number;
    lag: number | null;
  } | null>(null);

  const rateAtX = (clientX: number): number => {
    const r = railRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? rateAt((clientX - r.left) / r.width) : rate;
  };
  const drawAt = (pos: number, moving: boolean) => {
    setDrag({ pos, moving });
    const g = grip.current;
    const next = dragRate(pos);
    if (g && next !== g.sent) {
      g.sent = next;
      onChange(next);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (grip.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const slider = e.currentTarget;
    // No text selection or native drag; focus by hand (WebKit on the Mac does not focus a clicked element).
    e.preventDefault();
    slider.focus({ preventScroll: true });
    slider.setPointerCapture(e.pointerId);
    const raw = rateAtX(e.clientX);
    const rail = railRef.current?.getBoundingClientRect();
    const thumbX = rail ? rail.left + rateFraction(rate) * rail.width : Number.NaN;
    const onThumb = Math.abs(e.clientX - thumbX) <= THUMB_PX / 2 + 2;
    grip.current = {
      pointer: e.pointerId,
      x: e.clientX,
      slop: e.pointerType === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP,
      offset: onThumb ? rate - raw : 0,
      sent: rate,
      lag: null,
    };
    if (onThumb) setDrag({ pos: rate, moving: false });
    else drawAt(pullToMark(raw), false);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (!g || e.pointerId !== g.pointer) return;
    if (g.lag === null) {
      // Still a press: a typed rate (1.33) under a tapped thumb stays as it is, and a thumb gliding to a pressed
      // place on the track gets there.
      const dx = e.clientX - g.x;
      if (Math.abs(dx) < g.slop) return;
      g.lag = Math.sign(dx) * g.slop;
    }
    drawAt(pullToMark(rateAtX(e.clientX - g.lag) + g.offset), true);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (grip.current?.pointer !== e.pointerId) return;
    grip.current = null;
    setDrag(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = stepRate(rate, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = stepRate(rate, -1);
        break;
      case 'PageUp':
        next = nextSnapRate(rate, 1);
        break;
      case 'PageDown':
        next = nextSnapRate(rate, -1);
        break;
      case 'Home':
        next = MIN_RATE;
        break;
      case 'End':
        next = MAX_RATE;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next !== rate) onChange(next);
  };

  const shown = drag ? drag.pos : rate;
  // Held on a tick mark (pullToMark returns the mark itself): the thumb swells a little and the mark lights up.
  const caught = drag !== null && (SNAP_RATES as readonly number[]).includes(drag.pos);
  return (
    <div
      ref={sliderRef}
      className={`rec-rate-slider${drag?.moving ? ' is-dragging' : ''}${caught ? ' is-caught' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={m.title}
      aria-orientation="horizontal"
      aria-valuemin={MIN_RATE}
      aria-valuemax={MAX_RATE}
      aria-valuenow={rate}
      aria-valuetext={m.valueText(formatRate(rate))}
      title={m.sliderTitle}
      style={{ '--at': rateFraction(shown) } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(1)}
    >
      <span ref={railRef} className="rec-rate-rail" aria-hidden>
        <span className="rec-rate-fill" />
        {SNAP_RATES.map((mark) => (
          <span
            key={mark}
            className={`rec-rate-tick${LABELLED_RATES.includes(mark) ? ' is-major' : ''}${mark === shown ? ' is-on' : ''}`}
            style={{ left: `${rateFraction(mark) * 100}%` }}
          />
        ))}
        {LABELLED_RATES.map((mark) => (
          <span
            key={mark}
            className={`rec-rate-label${mark === shown ? ' is-on' : ''}`}
            style={{ left: `${rateFraction(mark) * 100}%` }}
          >
            {formatRate(mark)}
          </span>
        ))}
        <span className="rec-rate-thumb" />
      </span>
    </div>
  );
}

/**
 * The typed rate: applied on Enter, when the box loses focus or when the bubble closes, as typed (no snapping). Out
 * of range → the nearest end; not a number → the rate stays; Escape (or an emptied box) → the rate stays.
 */
function RateBox({ rate, onChange }: { rate: number; onChange: (rate: number) => void }) {
  const [draft, setDraftState] = useState<string | null>(null);
  // Also read when the bubble closes under a typed rate (the box is gone before any blur).
  const draftRef = useRef<string | null>(null);
  const setDraft = (text: string | null) => {
    draftRef.current = text;
    setDraftState(text);
  };
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const commit = (text: string) => {
    setDraft(null);
    if (text.trim() === '') return;
    const typed = parseRate(text);
    if (typed === null) {
      toast(msg().recording.rate.notANumber, 'info', 3000);
      return;
    }
    const next = clampRate(typed);
    if (next !== typed) {
      toast(msg().recording.rate.clamped(formatRate(MIN_RATE), formatRate(MAX_RATE), formatRate(next)), 'info', 3000);
    }
    if (next !== rateRef.current) onChangeRef.current(next);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      if (draftRef.current !== null) commitRef.current(draftRef.current);
    },
    [],
  );

  // Focusing the box selects its text, so typing replaces the rate. WebKit drops that selection on the mouseup of
  // the click that focused it: that one mouseup keeps it.
  const selectOnUp = useRef(false);
  const onMouseUp = (e: MouseEvent<HTMLInputElement>) => {
    if (!selectOnUp.current) return;
    selectOnUp.current = false;
    e.preventDefault();
    e.currentTarget.select();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      // Drops what was typed; with nothing typed, Escape closes the bubble (PlaybackRate).
      if (draft === null) return;
      e.preventDefault();
      setDraft(null);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setDraft(null);
      onChange(stepRate(clampRate(parseRate(e.currentTarget.value) ?? rate), e.key === 'ArrowUp' ? 1 : -1));
    }
  };

  return (
    <label className="rec-rate-num" title={msg().recording.rate.boxTitle}>
      <input
        type="text"
        inputMode="decimal"
        className="rec-rate-input"
        value={draft ?? formatRate(rate)}
        maxLength={6}
        autoComplete="off"
        spellCheck={false}
        aria-label={msg().recording.rate.boxLabel}
        onMouseDown={(e) => {
          selectOnUp.current = document.activeElement !== e.currentTarget;
        }}
        onMouseUp={onMouseUp}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          selectOnUp.current = false;
          if (draftRef.current !== null) commit(draftRef.current);
        }}
      />
      <span aria-hidden>×</span>
    </label>
  );
}
