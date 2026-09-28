// The playback speed of the 녹음 tab player (DESIGN §22): a 0.5×–3× slider whose tick marks a dragged value sticks
// to, arrow keys in 0.05 steps (PageUp / PageDown: the next mark, Home / End, double-click: 1×), and a box to type
// any rate. The rules are in lib/recording/rate.ts.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import {
  MAX_RATE,
  MIN_RATE,
  SNAP_RATES,
  clampRate,
  formatRate,
  nextSnapRate,
  parseRate,
  rateFraction,
  snapDraggedRate,
  snapThreshold,
  stepRate,
} from '../../lib/recording/rate.ts';
import { toast } from '../../lib/toast.ts';

/** The slider thumb's width (--thumb in styles.css): the thumb's center travels the slider's width less this. */
const THUMB_PX = 14;

export function PlaybackRate({ rate, onChange }: { rate: number; onChange: (rate: number) => void }) {
  // A pointer is pressed on the slider: its positions stick to the tick marks (SNAP_PX of this slider's track).
  // Other changes of the (fine, 0.01) value — assistive technology — take a whole step, so they never get stuck on
  // a mark.
  const dragging = useRef(false);
  const threshold = useRef(0);
  const onPointerDown = (e: PointerEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    dragging.current = true;
    threshold.current = snapThreshold(input.getBoundingClientRect().width - THUMB_PX);
    const end = (ev: Event) => {
      dragging.current = false;
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      // WebKit on the Mac does not focus a clicked slider, so the arrow keys would go nowhere.
      if (ev.type === 'pointerup' && document.activeElement !== input) input.focus({ preventScroll: true });
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const onSlide = (raw: number) => {
    if (dragging.current) onChange(snapDraggedRate(raw, threshold.current));
    else if (raw !== rate) onChange(stepRate(rate, raw > rate ? 1 : -1));
  };
  const onSliderKey = (e: KeyboardEvent<HTMLInputElement>) => {
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
    onChange(next);
  };

  // The typed rate: applied on Enter or when the box loses focus, as typed (no snapping). Out of range → the nearest
  // end; not a number → the rate stays; Escape (or an emptied box) → the rate stays.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    setDraft(null);
    if (text.trim() === '') return;
    const typed = parseRate(text);
    if (typed === null) {
      toast('재생 속도는 숫자로 입력해 주세요 (예: 1.25).', 'info', 3000);
      return;
    }
    const next = clampRate(typed);
    if (next !== typed) {
      toast(`재생 속도는 ${formatRate(MIN_RATE)}×부터 ${formatRate(MAX_RATE)}×까지예요. ${formatRate(next)}×로 맞췄어요.`, 'info', 3000);
    }
    if (next !== rate) onChange(next);
  };
  // Focusing the box selects its text, so typing replaces the rate. WebKit drops that selection on the mouseup of
  // the click that focused it: that one mouseup keeps it.
  const selectOnUp = useRef(false);
  const onBoxMouseUp = (e: MouseEvent<HTMLInputElement>) => {
    if (!selectOnUp.current) return;
    selectOnUp.current = false;
    e.preventDefault();
    e.currentTarget.select();
  };
  const onBoxKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setDraft(null);
      onChange(stepRate(clampRate(parseRate(e.currentTarget.value) ?? rate), e.key === 'ArrowUp' ? 1 : -1));
    }
  };

  return (
    <div className="rec-rate" role="group" aria-label="재생 속도">
      <span className="rec-rate-slider" style={{ '--fill': rateFraction(rate) } as CSSProperties}>
        <input
          type="range"
          min={MIN_RATE}
          max={MAX_RATE}
          step={0.01}
          value={rate}
          onPointerDown={onPointerDown}
          onChange={(e) => onSlide(Number(e.target.value))}
          onKeyDown={onSliderKey}
          onDoubleClick={() => onChange(1)}
          aria-label="재생 속도"
          aria-valuetext={`${formatRate(rate)}배속`}
          title="재생 속도 · 끌면 눈금에 달라붙어요 · ←→ 0.05씩 · 더블클릭하면 1×"
        />
        <span className="rec-rate-ticks" aria-hidden>
          {SNAP_RATES.map((mark) => (
            <span
              key={mark}
              className={`rec-rate-tick${mark === 1 ? ' is-one' : ''}`}
              style={{ left: `${rateFraction(mark) * 100}%` }}
            />
          ))}
        </span>
      </span>
      <label className="rec-rate-num" title="재생 속도 직접 입력 (0.5~3, Enter로 적용 · Esc로 취소)">
        <input
          type="text"
          inputMode="decimal"
          className="rec-rate-input"
          value={draft ?? formatRate(rate)}
          maxLength={6}
          autoComplete="off"
          spellCheck={false}
          aria-label="재생 속도 직접 입력 (배)"
          onMouseDown={(e) => {
            selectOnUp.current = document.activeElement !== e.currentTarget;
          }}
          onMouseUp={onBoxMouseUp}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onBoxKey}
          onBlur={() => {
            selectOnUp.current = false;
            if (draft !== null) commit(draft);
          }}
        />
        <span aria-hidden>×</span>
      </label>
    </div>
  );
}
