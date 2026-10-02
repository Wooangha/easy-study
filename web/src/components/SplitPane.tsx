import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { msg } from '../i18n/index.ts';
import {
  clampRatio,
  grabOffset,
  isDoubleTap,
  ratioFromKey,
  ratioFromPointer,
  SPLIT_RANGE,
  STACKED_QUERY,
  tapSlop,
  type SplitLayout,
  type Tap,
} from '../lib/splitPane.ts';
import { isNumber, readStorage, storageKeys, writeStorage } from '../lib/storage.ts';
import { useMediaQuery } from './annotations/AnnotationTools.tsx';

const STORAGE_KEY: Record<SplitLayout, string> = { row: storageKeys.split, stacked: storageKeys.splitStacked };

const readRatio = (layout: SplitLayout): number =>
  clampRatio(layout, readStorage(STORAGE_KEY[layout], SPLIT_RANGE[layout].def, isNumber));

/** The press on the divider: its pointer, where it holds the divider and whether it has dragged yet (else a tap). */
interface Press {
  pointerId: number;
  grab: number;
  clientX: number;
  clientY: number;
  dragged: boolean;
}

/**
 * Two panes with a draggable divider between them: side by side, or stacked on narrow screens (STACKED_QUERY). Each
 * layout has its own ratio, persisted. The divider works with a mouse, a finger and a pencil, and with the keyboard.
 */
export function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  const layout: SplitLayout = useMediaQuery(STACKED_QUERY) ? 'stacked' : 'row';
  const [ratios, setRatios] = useState(() => ({ row: readRatio('row'), stacked: readRatio('stacked') }));
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const lastTap = useRef<Tap | null>(null);

  const ratio = ratios[layout];
  const setRatio = (next: number) => setRatios((r) => (r[layout] === next ? r : { ...r, [layout]: next }));
  const reset = () => setRatio(SPLIT_RANGE[layout].def);

  // Persist once the user lets go (not on every pointer move).
  useEffect(() => {
    if (dragging) return;
    for (const l of ['row', 'stacked'] as const) writeStorage(STORAGE_KEY[l], Math.round(ratios[l] * 1000) / 1000);
  }, [ratios, dragging]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    // A new press takes the divider over (a palm resting on it must not keep it from the pencil).
    press.current = {
      pointerId: e.pointerId,
      grab: grabOffset(layout, e, e.currentTarget.getBoundingClientRect()),
      clientX: e.clientX,
      clientY: e.clientY,
      dragged: false,
    };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointerId) return;
    // Not before the pointer really moves: a (double) tap does not resize.
    if (!p.dragged && Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) < tapSlop(e.pointerType)) return;
    p.dragged = true;
    const rect = containerRef.current?.getBoundingClientRect();
    const next = rect ? ratioFromPointer(layout, e, rect, p.grab) : null;
    if (next !== null) setRatio(next);
  };
  const endPress = (e: PointerEvent<HTMLDivElement>, tapped: boolean) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointerId) return;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    // Two taps reset the divider. Counted here: a touch screen does not send dblclick everywhere.
    const tap = tapped && !p.dragged ? { time: e.timeStamp, clientX: e.clientX, clientY: e.clientY } : null;
    if (tap && isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      reset();
    } else {
      lastTap.current = tap;
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = ratioFromKey(layout, e.key, e.shiftKey, ratio);
    if (next === null) return;
    setRatio(next);
    e.preventDefault();
    e.stopPropagation();
  };

  const m = msg().shell.splitPane;
  const { min, max } = SPLIT_RANGE[layout];
  return (
    <div
      ref={containerRef}
      className={`split${layout === 'stacked' ? ' is-stacked' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{ '--split': ratio } as CSSProperties}
    >
      <div className="split-pane split-left">{left}</div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation={layout === 'stacked' ? 'horizontal' : 'vertical'}
        aria-label={m.label}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        title={m.title}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPress(e, true)}
        onPointerCancel={(e) => endPress(e, false)}
        onLostPointerCapture={(e) => endPress(e, false)}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      >
        <span className="split-grip" aria-hidden="true" />
      </div>
      <div className="split-pane split-right">{right}</div>
    </div>
  );
}
