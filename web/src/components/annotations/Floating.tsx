// A small panel floated next to an anchor element (a memo's link picker, the tag suggestions), rendered in <body>
// with fixed positioning like the library's PopoverMenu — a memo card sits inside the slide box, which clips its
// overflow, so a panel opened from a card near an edge would be cut off. Below the anchor when there is room, else
// above; kept inside the window sideways. It closes when the page scrolls (its anchor moves).
import { useLayoutEffect, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 8;
const GAP = 4;

interface FloatingProps {
  anchor: HTMLElement | null;
  width: number;
  /** How tall the panel may get (decides below / above). */
  height?: number;
  className: string;
  children: ReactNode;
  role?: string;
  label?: string;
  ref?: Ref<HTMLDivElement>;
  onScrollAway?: () => void;
  /** Handlers on the panel itself (a hover-opened panel stays while the pointer is on it; Esc / focus leaving it). */
  onPointerEnter?: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLDivElement>) => void;
  /** React delivers a portal's events along the React tree: a panel opened inside a memo card stops its presses here. */
  onPointerDown?: (e: PointerEvent<HTMLDivElement>) => void;
  onBlur?: (e: FocusEvent<HTMLDivElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export function Floating({ anchor, width, height = 240, className, children, role, label, ref, onScrollAway, onPointerEnter, onPointerLeave, onPointerDown, onBlur, onKeyDown }: FloatingProps) {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - width - MARGIN));
      const below = window.innerHeight - r.bottom - MARGIN;
      const above = r.top - MARGIN;
      const downwards = below >= Math.min(height, 160) || below >= above;
      setStyle(
        downwards
          ? { position: 'fixed', left, top: r.bottom + GAP, width, maxHeight: Math.max(120, below) }
          : { position: 'fixed', left, bottom: window.innerHeight - r.top + GAP, width, maxHeight: Math.max(120, above) },
      );
    };
    place();
    // Only a scroll that moves the anchor (one of its scrolling ancestors, or the page) counts.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || (t instanceof Node && t.contains(anchor))) onScrollAway?.();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, width, height, onScrollAway]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={className}
      style={style ?? { position: 'fixed', top: 0, left: 0, width, visibility: 'hidden' }}
      role={role}
      aria-label={label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
