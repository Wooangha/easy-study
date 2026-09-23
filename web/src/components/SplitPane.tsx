import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { clamp } from '../lib/format.ts';
import { isNumber, readStorage, storageKeys, writeStorage } from '../lib/storage.ts';

const DEFAULT_RATIO = 0.58;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.8;

/** Horizontal split with a draggable divider; the ratio is persisted. Stacks vertically on narrow screens (CSS). */
export function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [ratio, setRatio] = useState(() =>
    clamp(readStorage(storageKeys.split, DEFAULT_RATIO, isNumber), MIN_RATIO, MAX_RATIO),
  );
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist once the user lets go (not on every pointer move).
  useEffect(() => {
    if (!dragging) writeStorage(storageKeys.split, Math.round(ratio * 1000) / 1000);
  }, [ratio, dragging]);

  const updateFromPointer = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setRatio(clamp((clientX - rect.left) / rect.width, MIN_RATIO, MAX_RATIO));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) updateFromPointer(e.clientX);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.08 : 0.02;
    if (e.key === 'ArrowLeft') setRatio((r) => clamp(r - step, MIN_RATIO, MAX_RATIO));
    else if (e.key === 'ArrowRight') setRatio((r) => clamp(r + step, MIN_RATIO, MAX_RATIO));
    else if (e.key === 'Home' || e.key === 'Enter') setRatio(DEFAULT_RATIO);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={containerRef}
      className={dragging ? 'split is-dragging' : 'split'}
      style={{ '--split': ratio } as CSSProperties}
    >
      <div className="split-pane split-left">{left}</div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="패널 크기 조절"
        aria-valuemin={MIN_RATIO * 100}
        aria-valuemax={MAX_RATIO * 100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        title="드래그해서 크기 조절 · 더블클릭하면 기본값"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setRatio(DEFAULT_RATIO)}
        onKeyDown={onKeyDown}
      />
      <div className="split-pane split-right">{right}</div>
    </div>
  );
}
