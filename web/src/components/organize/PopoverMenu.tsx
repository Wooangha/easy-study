import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Ellipsis, type LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  key: string;
  label: string;
  /** Drawn before the label (the label itself is plain text: no emoji). */
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  /** Shown after the label, dimmed (e.g. the group of a course). */
  hint?: string;
}

export interface MenuSection {
  heading?: string;
  items: MenuItem[];
}

interface Position {
  top: number;
  left: number;
  maxHeight: number;
}

const GAP = 4;
const MARGIN = 8;

/**
 * "⋯" (Ellipsis icon) button with a small menu (role="menu"): ↑/↓/Home/End move between items, Enter selects, Esc or a click
 * outside closes it and focus returns to the button. Rendered in <body> with fixed positioning, so it is never
 * clipped by the library's scroll area.
 */
export function PopoverMenu({ label, sections }: { label: string; sections: MenuSection[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const hasItems = sections.some((s) => s.items.length > 0);

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    setPos(null);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  // Place the menu below the button (above when there is more room there), right-aligned with it. It follows
  // the button when the page scrolls or resizes, and closes once the button is off screen.
  const place = useCallback(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;
    const b = button.getBoundingClientRect();
    if (b.bottom < 0 || b.top > window.innerHeight) {
      close(false);
      return;
    }
    const width = menu.offsetWidth;
    const height = menu.scrollHeight;
    const below = window.innerHeight - b.bottom - GAP - MARGIN;
    const above = b.top - GAP - MARGIN;
    const downwards = below >= Math.min(height, 240) || below >= above;
    const maxHeight = Math.max(120, downwards ? below : above);
    const shown = Math.min(height, maxHeight);
    const left = Math.min(window.innerWidth - width - MARGIN, Math.max(MARGIN, b.right - width));
    const next = { top: downwards ? b.bottom + GAP : b.top - GAP - shown, left, maxHeight };
    setPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight ? prev : next,
    );
  }, [close]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  const focused = useRef(false);
  useEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    if (!pos || focused.current) return;
    focused.current = true;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return; // scrolling the menu itself
      place();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, close, place]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === 'Tab') {
      close(false);
      return;
    }
    if (next >= 0 && items[next]) {
      e.preventDefault();
      items[next].focus();
    }
  };

  if (!hasItems) return null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn small menu-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Ellipsis />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className="popover-menu"
            style={
              pos
                ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
            onKeyDown={onMenuKeyDown}
          >
            {sections.map((section, si) =>
              section.items.length === 0 ? null : (
                <div key={si} role="group" aria-label={section.heading} className="popover-section">
                  {section.heading && (
                    <div className="popover-heading" aria-hidden>
                      {section.heading}
                    </div>
                  )}
                  {section.items.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={item.danger ? 'popover-item is-danger' : 'popover-item'}
                      onClick={() => {
                        close(true);
                        item.onSelect();
                      }}
                    >
                      <span className="popover-item-label">
                        {item.icon ? (
                          <>
                            <item.icon /> {item.label}
                          </>
                        ) : (
                          item.label
                        )}
                      </span>
                      {item.hint && <span className="popover-item-hint">{item.hint}</span>}
                    </button>
                  ))}
                </div>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
