import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useLatest } from '../hooks/useLatest.ts';
import { msg } from '../i18n/index.ts';
import {
  clampRatio,
  dividerPhase,
  dividerPress,
  grabOffset,
  isDoubleTap,
  isToggleTap,
  onOpenChatPane,
  ratioFromKey,
  ratioFromPointer,
  SPLIT_RANGE,
  STACKED_QUERY,
  type DividerEvent,
  type DividerPhase,
  type DividerPress,
  type SplitLayout,
  type Tap,
} from '../lib/splitPane.ts';
import { isBoolean, isNumber, readStorage, storageKeys, writeStorage } from '../lib/storage.ts';
import { useMediaQuery } from './annotations/AnnotationTools.tsx';

const STORAGE_KEY: Record<SplitLayout, string> = { row: storageKeys.split, stacked: storageKeys.splitStacked };

const readRatio = (layout: SplitLayout): number =>
  clampRatio(layout, readStorage(STORAGE_KEY[layout], SPLIT_RANGE[layout].def, isNumber));

/**
 * Two panes with a draggable divider between them: side by side, or stacked on narrow screens (STACKED_QUERY). Each
 * layout has its own ratio, persisted. The divider works with a mouse, a finger and a pencil, and with the keyboard.
 * Its button folds the second pane (the chat) away: the first one takes everything, the second stays mounted, hidden.
 */
export function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  const layout: SplitLayout = useMediaQuery(STACKED_QUERY) ? 'stacked' : 'row';
  const [ratios, setRatios] = useState(() => ({ row: readRatio('row'), stacked: readRatio('stacked') }));
  const [collapsed, setCollapsed] = useState(() => readStorage(storageKeys.chatCollapsed, false, isBoolean));
  const [phase, setPhase] = useState<DividerPhase>('idle');
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const press = useRef<DividerPress | null>(null);
  const lastTap = useRef<Tap | null>(null);
  const togglePress = useRef<{ time: number; pointerType: string } | null>(null);
  const paneId = useId();

  const ratio = ratios[layout];
  const dragging = phase === 'dragging';
  const setRatio = (next: number) => setRatios((r) => (r[layout] === next ? r : { ...r, [layout]: next }));
  const reset = () => setRatio(SPLIT_RANGE[layout].def);

  // Persist once the user lets go (not on every pointer move).
  useEffect(() => {
    if (dragging) return;
    for (const l of ['row', 'stacked'] as const) writeStorage(STORAGE_KEY[l], Math.round(ratios[l] * 1000) / 1000);
  }, [ratios, dragging]);
  useEffect(() => writeStorage(storageKeys.chatCollapsed, collapsed), [collapsed]);
  useEffect(() => onOpenChatPane(() => setCollapsed(false)), []);

  /** Tells the press what happened (lib/splitPane.ts dividerPress). Gives the press this ended, if it ended one. */
  const feed = (event: DividerEvent): DividerPress | null => {
    const prev = press.current;
    const next = dividerPress(prev, event);
    if (next === prev) return null;
    press.current = next;
    setPhase(dividerPhase(next));
    if (!prev || next) return null;
    try {
      const handle = handleRef.current;
      if (handle?.hasPointerCapture(prev.pointerId)) handle.releasePointerCapture(prev.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    return prev;
  };
  /** After a press ended (`tap`: where it was let go, if it was). */
  const finish = (ended: DividerPress | null, tap: Tap | null) => {
    if (!ended) return;
    // Two taps reset the divider. Counted here: a touch screen does not send dblclick everywhere.
    const done = ended.dragged ? null : tap;
    if (done && isDoubleTap(lastTap.current, done)) {
      lastTap.current = null;
      reset();
    } else {
      lastTap.current = done;
    }
  };

  // What ends a press besides the events of the divider itself: the window sees the pointer wherever it went (also
  // when the capture failed), a press anywhere else, and the page losing the focus or being hidden.
  const live = useLatest({ feed, finish });
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && handleRef.current?.contains(e.target)) return;
      live.current.finish(live.current.feed({ type: 'outside' }), null);
    };
    const onUp = (e: PointerEvent) =>
      live.current.finish(live.current.feed({ type: 'up', pointerId: e.pointerId }), { time: e.timeStamp, clientX: e.clientX, clientY: e.clientY });
    const onCancel = (e: PointerEvent) => live.current.finish(live.current.feed({ type: 'cancel', pointerId: e.pointerId }), null);
    const onBlur = () => live.current.finish(live.current.feed({ type: 'blur' }), null);
    const onVisibility = () => {
      if (document.hidden) live.current.finish(live.current.feed({ type: 'hidden' }), null);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [live]);
  // Nor does a press go on over another divider (the layout changed, the chat was folded).
  useEffect(() => {
    live.current.finish(live.current.feed({ type: 'layout' }), null);
  }, [live, layout, collapsed]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || collapsed) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    feed({
      type: 'down',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      clientX: e.clientX,
      clientY: e.clientY,
      grab: grabOffset(layout, e, e.currentTarget.getBoundingClientRect()),
    });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    finish(feed({ type: 'move', pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, buttons: e.buttons }), null);
    const p = press.current;
    if (!p?.dragged || p.pointerId !== e.pointerId) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const next = rect ? ratioFromPointer(layout, e, rect, p.grab) : null;
    if (next !== null) setRatio(next);
  };
  // A touch screen may end a touch without the pointerup of its pointer: the touches left on the divider tell.
  const onTouchEnd = (e: ReactTouchEvent<HTMLDivElement>, tapped: boolean) => {
    const handle = e.currentTarget;
    const remaining = Array.from(e.touches).filter((t) => t.target instanceof Node && handle.contains(t.target)).length;
    const at = e.changedTouches[0];
    finish(feed({ type: 'touchend', remaining }), tapped && at ? { time: e.timeStamp, clientX: at.clientX, clientY: at.clientY } : null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = ratioFromKey(layout, e.key, e.shiftKey, ratio);
    if (next === null) return;
    setRatio(next);
    e.preventDefault();
    e.stopPropagation();
  };
  const onToggle = (e: MouseEvent<HTMLButtonElement>) => {
    const down = togglePress.current;
    togglePress.current = null;
    // The keyboard (detail 0) always; a finger or a pencil with a tap, not with the palm that rested on the button.
    if (e.detail !== 0 && down && !isToggleTap(down.pointerType, e.timeStamp - down.time)) return;
    setCollapsed((c) => !c);
  };

  const m = msg().shell.splitPane;
  const { min, max } = SPLIT_RANGE[layout];
  const stacked = layout === 'stacked';
  // Open: toward the chat, where it goes. Collapsed: toward the slides, where it comes back.
  const Chevron = stacked ? (collapsed ? ChevronUp : ChevronDown) : collapsed ? ChevronLeft : ChevronRight;
  const toggleLabel = collapsed ? m.expand : m.collapse;
  return (
    <div
      ref={containerRef}
      className={`split${stacked ? ' is-stacked' : ''}${dragging ? ' is-dragging' : ''}${collapsed ? ' is-collapsed' : ''}`}
      style={{ '--split': ratio } as CSSProperties}
    >
      <div className="split-pane split-left">{left}</div>
      <div className="split-divider">
        <div
          ref={handleRef}
          className={`split-handle${phase === 'idle' ? '' : ' is-pressed'}`}
          role="separator"
          aria-orientation={stacked ? 'horizontal' : 'vertical'}
          aria-label={m.label}
          aria-valuemin={Math.round(min * 100)}
          aria-valuemax={Math.round(max * 100)}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
          title={m.title}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onLostPointerCapture={(e) => finish(feed({ type: 'lost', pointerId: e.pointerId }), null)}
          onTouchEnd={(e) => onTouchEnd(e, true)}
          onTouchCancel={(e) => onTouchEnd(e, false)}
          onDoubleClick={reset}
          onKeyDown={onKeyDown}
        >
          <span className="split-grip" aria-hidden="true" />
        </div>
        {/* Beside the separator, not in it: a press on the button never reaches the drag of the divider. */}
        <button
          type="button"
          className="split-toggle"
          aria-expanded={!collapsed}
          aria-controls={paneId}
          aria-label={toggleLabel}
          title={toggleLabel}
          onPointerDown={(e) => {
            togglePress.current = { time: e.timeStamp, pointerType: e.pointerType };
          }}
          onClick={onToggle}
        >
          <Chevron aria-hidden="true" />
        </button>
      </div>
      <div id={paneId} className="split-pane split-right" inert={collapsed}>
        {right}
      </div>
    </div>
  );
}
