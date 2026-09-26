import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import type { DocMeta, RegionRect } from '../../../shared/types.ts';
import { viewSrcSet, viewUrl } from '../api.ts';
import { useLoginEpoch } from '../hooks/useAuth.ts';
import { useLatest } from '../hooks/useLatest.ts';
import {
  DRAG_THRESHOLD_PX,
  FULL_FRAME,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  MIN_DRAG_PX,
  MIN_REGION_PX,
  framePixels,
  imageFrame,
  menuPlacement,
  movedBeyond,
  percentStyle,
  rectInBox,
  regionFromPoints,
  toImagePoint,
  type Box,
  type Frame,
  type MenuPlacement,
  type Point,
} from '../lib/attachments.ts';
import { clamp, slideSizes } from '../lib/format.ts';
import { isNumber, readStorage, storageKeys, writeStorage } from '../lib/storage.ts';
import { toast } from '../lib/toast.ts';
import { SlideImage } from './SlideImage.tsx';

export interface SlideViewerHandle {
  /** Scroll so that the slide sits in the vertical center of the viewer. */
  scrollToSlide: (slide: number, behavior?: ScrollBehavior) => void;
  /** Scroll a region of a slide to the center of the viewer and flash its outline (an attachment was opened). */
  showRegion: (slide: number, rect: RegionRect) => void;
}

/** A region being dragged out on a slide, or a finished one waiting for the floating menu's answer. */
interface Selection {
  slide: number;
  /** Normalised to the slide image. */
  rect: RegionRect;
  phase: 'drag' | 'menu';
  placement: MenuPlacement;
}

interface Flash {
  slide: number;
  rect: RegionRect;
  seq: number;
}

/** A pointer pressed on a slide that may become a selection. */
interface Gesture {
  pointerId: number;
  /** Touch or pen: a long press starts the selection (a drag right away scrolls). */
  touch: boolean;
  slide: number;
  box: HTMLElement;
  frame: Frame;
  /** Where it was pressed, on the image (normalised). */
  start: Point;
  startClient: Point;
  active: boolean;
  timer: number;
}

/** Actions of the floating menu (stable: SlideItem is memoized). */
interface MenuActions {
  attach: () => void;
  ask: () => void;
  cancel: () => void;
}

const FLASH_MS = 2200;
/** Rough width of the floating menu, to keep it inside the slide. */
const MENU_WIDTH_PX = 250;

/** Where the slide image is drawn in its box (a page shaped unlike page 1 is letterboxed). */
function frameOf(box: HTMLElement, rect: Box): Frame {
  const img = box.querySelector('img');
  const imageAspect = img && img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null;
  return rect.height > 0 ? imageFrame(rect.width / rect.height, imageAspect) : FULL_FRAME;
}

interface SlideViewerProps {
  doc: DocMeta;
  /** Saved Q&A count per slide (badge). */
  qaCounts: Map<number, number>;
  pinnedSlide: number | null;
  onFocusChange: (slide: number) => void;
  /** Badge click → open the Notes tab filtered to that slide. */
  onOpenNotes: (slide: number) => void;
  /** "📎 첨부" on a selected region: attach it to the next question. */
  onAttachRegion: (slide: number, rect: RegionRect) => void;
  /** "💬 이 부분 설명해줘": attach the region and ask about it right away. */
  onAskRegion: (slide: number, rect: RegionRect) => void;
  /** Why a question cannot be sent right now (the 💬 action is then disabled), or null. */
  askDisabledReason: string | null;
  ref?: Ref<SlideViewerHandle>;
}

/** Zoom factors relative to "fit width" (1). */
const ZOOM_LEVELS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** The right pane (chat / 정리본 / notes) scrolls with the keyboard on its own. */
const OTHER_PANE_SELECTOR = '.split-right';

/** Keys with a native scrolling meaning; they move slides only while the keyboard "belongs" to the viewer. */
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']);

function inOtherPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OTHER_PANE_SELECTOR) !== null;
}

/** Esc inside a modal <dialog> (a confirmation) belongs to that dialog. */
export function inDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('dialog') !== null;
}

export function SlideViewer({
  doc,
  qaCounts,
  pinnedSlide,
  onFocusChange,
  onOpenNotes,
  onAttachRegion,
  onAskRegion,
  askDisabledReason,
  ref,
}: SlideViewerProps) {
  const pageCount = Math.max(0, doc.pageCount);
  const aspect = Number.isFinite(doc.aspectRatio) && doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** The last pointer press was in the right pane: its scroll keys (↑↓, PageUp/Down, Home/End) stay native. */
  const pointerInOtherPaneRef = useRef(false);
  const slideEls = useRef<(HTMLDivElement | null)[]>([]);
  const [focused, setFocused] = useState(() =>
    clamp(Math.round(readStorage(storageKeys.slide(doc.id), 1, isNumber)), 1, Math.max(1, pageCount)),
  );
  const focusedRef = useRef(focused);
  const [zoom, setZoom] = useState(() => {
    const z = readStorage(storageKeys.zoom, 1, isNumber);
    return ZOOM_LEVELS.includes(z) ? z : 1;
  });
  const onFocusChangeRef = useLatest(onFocusChange);
  /** Where the center line sits inside the focused slide (0..1) — restored after resize / zoom. */
  const anchorRef = useRef<{ index: number; frac: number } | null>(null);
  /** Last keyboard navigation target, so rapid key presses advance past an in-flight smooth scroll. */
  const navRef = useRef<{ target: number; at: number } | null>(null);

  const registerSlide = useCallback((index: number, el: HTMLDivElement | null) => {
    slideEls.current[index] = el;
  }, []);

  /** Focused slide = the slide crossing the vertical center line (fallback: the more visible neighbour). */
  const computeFocus = useCallback(() => {
    const scroller = scrollerRef.current;
    const els = slideEls.current;
    if (!scroller || pageCount === 0) return;
    const box = scroller.getBoundingClientRect();
    const centerY = box.top + scroller.clientHeight / 2;

    // Slides are stacked vertically in order → binary search the first one whose bottom reaches the center.
    let lo = 0;
    let hi = pageCount - 1;
    let idx = pageCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = els[mid]?.getBoundingClientRect();
      if (!r) return;
      if (r.bottom >= centerY) {
        idx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const visible = (i: number) => {
      const r = els[i]?.getBoundingClientRect();
      return r ? Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)) : -1;
    };
    let best = idx;
    const rect = els[idx]?.getBoundingClientRect();
    if (rect && rect.top > centerY && idx > 0 && visible(idx - 1) > visible(idx)) best = idx - 1;
    // No special case at the ends: the track's padding (styles.css) makes the first slide cross the center
    // line at the top and lets every other slide scroll to it, even when zoomed out.

    const bestRect = els[best]?.getBoundingClientRect();
    if (bestRect && bestRect.height > 0) {
      anchorRef.current = { index: best, frac: clamp((centerY - bestRect.top) / bestRect.height, 0, 1) };
    }
    const slide = best + 1;
    if (slide !== focusedRef.current) {
      focusedRef.current = slide;
      setFocused(slide);
      onFocusChangeRef.current(slide);
    }
  }, [pageCount, onFocusChangeRef]);

  const rafRef = useRef(0);
  const scheduleFocus = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      computeFocus();
    });
  }, [computeFocus]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const scrollToSlide = useCallback(
    (slide: number, behavior: ScrollBehavior = 'smooth') => {
      const scroller = scrollerRef.current;
      const el = slideEls.current[clamp(slide, 1, pageCount) - 1];
      if (!scroller || !el) return;
      const sr = scroller.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const viewH = scroller.clientHeight;
      // Center the slide; if it is taller than the viewport (zoomed in), align its top instead.
      const delta = er.height > viewH ? er.top - sr.top - 12 : er.top + er.height / 2 - (sr.top + viewH / 2);
      scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
    },
    [pageCount],
  );

  // ---- Region selection (DESIGN §21) -------------------------------------------------------------
  // Mouse: press and drag (≥ 6 px; a plain click keeps its meaning). Touch: hold still ~350 ms, then drag
  // (a drag right away scrolls), or turn on "✂ 영역" first. Esc cancels. The rectangle is kept normalised to
  // the slide image, so it does not depend on the zoom level or on which rendition is shown.
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const setSelection = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  const [regionMode, setRegionMode] = useState(false);
  const regionModeRef = useLatest(regionMode);
  const gestureRef = useRef<Gesture | null>(null);
  const dragFrame = useRef(0);
  const onAttachRegionRef = useLatest(onAttachRegion);
  const onAskRegionRef = useLatest(onAskRegion);

  const cancelGesture = useCallback(() => {
    const g = gestureRef.current;
    if (g) window.clearTimeout(g.timer);
    gestureRef.current = null;
    cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
  }, []);
  useEffect(() => cancelGesture, [cancelGesture]);

  const beginSelection = useCallback(
    (g: Gesture) => {
      g.active = true;
      setSelection({ slide: g.slide, rect: { x: g.start.x, y: g.start.y, w: 0, h: 0 }, phase: 'drag', placement: 'below' });
    },
    [setSelection],
  );

  const capture = (e: ReactPointerEvent<HTMLElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('.region-menu')) return;
    // Pressing anywhere else dismisses a finished selection's menu.
    if (selectionRef.current?.phase === 'menu') setSelection(null);
    if (gestureRef.current) {
      // A second finger (pinch zoom): not a selection.
      if (!gestureRef.current.active) cancelGesture();
      return;
    }
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (target.closest('button, a, input, select, textarea')) return;
    const box = target.closest<HTMLElement>('.slide-box');
    const slide = Number(box?.closest<HTMLElement>('.slide')?.dataset.slide);
    if (!box || !Number.isInteger(slide) || slide < 1) return;
    const rect = box.getBoundingClientRect();
    const frame = frameOf(box, rect);
    const g: Gesture = {
      pointerId: e.pointerId,
      touch: e.pointerType !== 'mouse',
      slide,
      box,
      frame,
      start: toImagePoint(e.clientX, e.clientY, rect, frame),
      startClient: { x: e.clientX, y: e.clientY },
      active: false,
      timer: 0,
    };
    gestureRef.current = g;
    if (regionModeRef.current) {
      capture(e);
      beginSelection(g);
    } else if (g.touch) {
      g.timer = window.setTimeout(() => {
        if (gestureRef.current !== g) return;
        beginSelection(g);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const client = { x: e.clientX, y: e.clientY };
    if (!g.active) {
      if (g.touch) {
        // Moved before the long press: the student is scrolling.
        if (movedBeyond(g.startClient, client, LONG_PRESS_SLOP_PX)) cancelGesture();
        return;
      }
      if (!movedBeyond(g.startClient, client, DRAG_THRESHOLD_PX)) return;
      capture(e);
      window.getSelection()?.removeAllRanges();
      beginSelection(g);
    }
    e.preventDefault();
    if (dragFrame.current) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      if (gestureRef.current !== g) return;
      // Measured now: the slide may have scrolled since the press (wheel while dragging).
      const box = g.box.getBoundingClientRect();
      const point = toImagePoint(client.x, client.y, box, g.frame);
      const rect = regionFromPoints(g.start, point, framePixels(box, g.frame));
      setSelection({ slide: g.slide, rect, phase: 'drag', placement: 'below' });
    });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    cancelGesture();
    if (!g.active) return; // a plain click / tap
    const box = g.box.getBoundingClientRect();
    const size = framePixels(box, g.frame);
    const point = toImagePoint(e.clientX, e.clientY, box, g.frame);
    if (Math.abs(point.x - g.start.x) * size.width < MIN_DRAG_PX && Math.abs(point.y - g.start.y) * size.height < MIN_DRAG_PX) {
      setSelection(null);
      if (g.touch) toast('길게 누른 채로 끌어서 영역을 선택하세요', 'info', 2500);
      return;
    }
    const rect = regionFromPoints(g.start, point, size, MIN_REGION_PX);
    // The menu goes where the viewer shows room for it, over the slide's edge if need be (not over the selection).
    const inBox = rectInBox(rect, g.frame);
    const top = box.top + inBox.y * box.height;
    const view = scrollerRef.current?.getBoundingClientRect() ?? box;
    const placement = menuPlacement({ top, bottom: top + inBox.h * box.height }, { top: view.top, bottom: view.bottom });
    setSelection({ slide: g.slide, rect, phase: 'menu', placement });
    setRegionMode(false);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    cancelGesture();
    if (selectionRef.current?.phase === 'drag') setSelection(null);
  };

  // Touch: once a selection started, the finger must not scroll the viewer (and a long press must not open the
  // image's context menu). Needs a non-passive listener; registered only where touch is possible.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onTouchMove = (e: TouchEvent) => {
      if (gestureRef.current?.active && e.cancelable) e.preventDefault();
    };
    const onContextMenu = (e: Event) => {
      if (gestureRef.current?.touch || (selectionRef.current && selectionRef.current.phase === 'drag')) e.preventDefault();
    };
    const touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    if (touch) scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    scroller.addEventListener('contextmenu', onContextMenu);
    return () => {
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  // Esc cancels a selection (being drawn or waiting in its menu) and the ✂ mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || inDialog(e.target)) return;
      if (!selectionRef.current && !regionModeRef.current && !gestureRef.current) return;
      e.preventDefault();
      cancelGesture();
      setSelection(null);
      setRegionMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelGesture, setSelection, regionModeRef]);

  const menuActions = useMemo<MenuActions>(
    () => ({
      attach: () => {
        const s = selectionRef.current;
        if (!s) return;
        setSelection(null);
        onAttachRegionRef.current(s.slide, s.rect);
      },
      ask: () => {
        const s = selectionRef.current;
        if (!s) return;
        setSelection(null);
        onAskRegionRef.current(s.slide, s.rect);
      },
      cancel: () => setSelection(null),
    }),
    [setSelection, onAttachRegionRef, onAskRegionRef],
  );

  // ---- Showing a region (an attachment was opened) -----------------------------------------------
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const showRegion = useCallback(
    (slide: number, rect: RegionRect) => {
      const scroller = scrollerRef.current;
      const n = clamp(slide, 1, pageCount);
      const el = slideEls.current[n - 1];
      if (!scroller || !el) return;
      const box = el.querySelector<HTMLElement>('.slide-box') ?? el;
      const br = box.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const r = rectInBox(rect, frameOf(box, br));
      const cy = br.top + (r.y + r.h / 2) * br.height;
      const cx = br.left + (r.x + r.w / 2) * br.width;
      const wide = scroller.scrollWidth > scroller.clientWidth + 1;
      scroller.scrollTo({
        top: scroller.scrollTop + cy - (sr.top + scroller.clientHeight / 2),
        left: wide ? scroller.scrollLeft + cx - (sr.left + scroller.clientWidth / 2) : scroller.scrollLeft,
        behavior: 'smooth',
      });
      setFlash((prev) => ({ slide: n, rect, seq: (prev?.seq ?? 0) + 1 }));
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
    },
    [pageCount],
  );

  useImperativeHandle(ref, () => ({ scrollToSlide, showRegion }), [scrollToSlide, showRegion]);

  /** Keep the same point of the focused slide under the center line after the layout changes size. */
  const restoreAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    const el = anchor ? slideEls.current[anchor.index] : null;
    if (!scroller || !anchor || !el) return;
    const sr = scroller.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const delta = er.top + anchor.frac * er.height - (sr.top + scroller.clientHeight / 2);
    if (Math.abs(delta) > 1) scroller.scrollTop += delta;
  }, []);

  // Restore the last viewed slide of this doc on mount and report the initial focus.
  useLayoutEffect(() => {
    scrollToSlide(focusedRef.current, 'auto');
    onFocusChangeRef.current(focusedRef.current);
    computeFocus();
    // Mount-only: the component is keyed by doc id.
  }, []);

  // Re-anchor when the viewer is resized (split divider, window resize).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      restoreAnchor();
      scheduleFocus();
    });
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [restoreAnchor, scheduleFocus]);

  // Zoom changes every slide's height: keep the focused point in place.
  const firstZoom = useRef(true);
  useLayoutEffect(() => {
    if (firstZoom.current) {
      firstZoom.current = false;
      return;
    }
    restoreAnchor();
    computeFocus();
    writeStorage(storageKeys.zoom, zoom);
  }, [zoom, restoreAnchor, computeFocus]);

  // The browser picks a WebP rendition (srcset) from the width a slide really has on screen: the viewer's
  // width times the zoom, which is the track's width. Measured before the first paint, so no image is
  // requested at a wrong size.
  const [sizes, setSizes] = useState<string | null>(null);
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const next = slideSizes(track.getBoundingClientRect().width);
      if (next) setSizes(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  }, []);

  // Remember the position per doc.
  useEffect(() => {
    writeStorage(storageKeys.slide(doc.id), focused);
  }, [doc.id, focused]);

  // Keyboard navigation (ignored while typing). j/k work anywhere else. The scroll keys belong to what the
  // student last clicked: in the chat, 정리본 or notes pane they scroll that pane natively instead of
  // moving the slides (which would also silently change the slide the next question is about).
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      pointerInOtherPaneRef.current = inOtherPane(e.target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (SCROLL_KEYS.has(e.key)) {
        const target = e.target instanceof Element ? e.target : null;
        const unfocused = !target || target === document.body || target === document.documentElement;
        if (inOtherPane(target) || (unfocused && pointerInOtherPaneRef.current)) return;
      }
      let target: number;
      const now = performance.now();
      const base = navRef.current && now - navRef.current.at < 700 ? navRef.current.target : focusedRef.current;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
        case 'PageDown':
          target = base + 1;
          break;
        case 'k':
        case 'ArrowUp':
        case 'PageUp':
          target = base - 1;
          break;
        case 'Home':
          target = 1;
          break;
        case 'End':
          target = pageCount;
          break;
        default:
          return;
      }
      e.preventDefault();
      target = clamp(target, 1, pageCount);
      navRef.current = { target, at: now };
      scrollToSlide(target, 'smooth');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [pageCount, scrollToSlide]);

  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const stepZoom = (dir: 1 | -1) =>
    setZoom((z) => ZOOM_LEVELS[clamp(ZOOM_LEVELS.indexOf(z) + dir, 0, ZOOM_LEVELS.length - 1)]);
  const [jumpValue, setJumpValue] = useState('');

  const slides = [];
  for (let n = 1; n <= pageCount; n++) {
    slides.push(
      <SlideItem
        key={n}
        docId={doc.id}
        slide={n}
        aspect={aspect}
        sizes={sizes}
        focused={n === focused}
        pinned={n === pinnedSlide}
        qaCount={qaCounts.get(n) ?? 0}
        register={registerSlide}
        onOpenNotes={onOpenNotes}
        selection={selection?.slide === n ? selection : null}
        flash={flash?.slide === n ? flash : null}
        menu={menuActions}
        askDisabledReason={selection?.slide === n ? askDisabledReason : null}
      />,
    );
  }

  const viewerCls = ['viewer', regionMode && 'is-region-mode', selection?.phase === 'drag' && 'is-selecting']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={viewerCls}>
      <div className="viewer-toolbar">
        <form
          className="page-jump"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number.parseInt(jumpValue, 10);
            if (Number.isFinite(n)) scrollToSlide(clamp(n, 1, pageCount));
            setJumpValue('');
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <input
            className="page-jump-input"
            inputMode="numeric"
            aria-label="이동할 슬라이드 번호"
            placeholder={String(focused)}
            value={jumpValue}
            onChange={(e) => setJumpValue(e.target.value.replace(/[^0-9]/g, ''))}
          />
          <span className="page-jump-total">/ {pageCount}</span>
        </form>
        <span
          className="viewer-hint"
          title="키보드: j/k 또는 ↑/↓ 로 슬라이드 이동 · 슬라이드에서 끌면 그 영역을 질문에 첨부해요"
        >
          j/k · ↑/↓ · 끌어서 영역 선택
        </span>
        <button
          type="button"
          className={regionMode ? 'region-toggle is-active' : 'region-toggle'}
          aria-pressed={regionMode}
          onClick={() => {
            setSelection(null);
            setRegionMode((on) => !on);
          }}
          title={
            regionMode
              ? '영역 선택 중 — 슬라이드에서 끌어서 선택하세요 (Esc 취소)'
              : '영역 선택: 슬라이드에서 끌어서 선택하면 질문에 첨부해요 (마우스는 그냥 끌어도 되고, 터치는 길게 누른 뒤 끌어도 돼요)'
          }
        >
          ✂ 영역
        </button>
        <div className="zoom-controls" role="group" aria-label="확대/축소">
          <button
            type="button"
            className="icon-btn"
            onClick={() => stepZoom(-1)}
            disabled={zoomIndex <= 0}
            title="축소"
          >
            −
          </button>
          <button
            type="button"
            className="zoom-label"
            onClick={() => setZoom(1)}
            title="너비에 맞춤"
            aria-pressed={zoom === 1}
          >
            {zoom === 1 ? '맞춤' : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => stepZoom(1)}
            disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
            title="확대"
          >
            ＋
          </button>
        </div>
      </div>
      <div
        className="viewer-scroll"
        ref={scrollerRef}
        onScroll={scheduleFocus}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        tabIndex={0}
        aria-label="슬라이드 (j/k 또는 ↑/↓ 로 이동, 끌어서 영역 선택)"
      >
        <div
          className="slides-track"
          ref={trackRef}
          style={{ '--zoom': zoom, '--aspect': aspect } as CSSProperties}
        >
          {slides}
        </div>
      </div>
    </div>
  );
}

interface SlideItemProps {
  docId: string;
  slide: number;
  aspect: number;
  /** `sizes` of the slide image (its rendered width); null until measured. */
  sizes: string | null;
  focused: boolean;
  pinned: boolean;
  qaCount: number;
  register: (index: number, el: HTMLDivElement | null) => void;
  onOpenNotes: (slide: number) => void;
  /** The selection on this slide (null when it is elsewhere). */
  selection: Selection | null;
  /** A region of this slide being shown (an attachment was opened). */
  flash: Flash | null;
  menu: MenuActions;
  askDisabledReason: string | null;
}

const SlideItem = memo(function SlideItem({
  docId,
  slide,
  aspect,
  sizes,
  focused,
  pinned,
  qaCount,
  register,
  onOpenNotes,
  selection,
  flash,
  menu,
  askDisabledReason,
}: SlideItemProps) {
  // Tagged with the login epoch: images that failed while the session had ended load again after a login.
  const epoch = useLoginEpoch();
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const failed = failedAt === epoch;
  // The image's own shape: a page shaped unlike page 1 is letterboxed in the box, and regions are relative to it.
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const onImageLoad = useCallback((img: HTMLImageElement) => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) setImageAspect(img.naturalWidth / img.naturalHeight);
  }, []);
  const frame = imageFrame(aspect, imageAspect);
  const setRef = useCallback((el: HTMLDivElement | null) => register(slide - 1, el), [register, slide]);
  const cls = ['slide', focused && 'is-focused', pinned && 'is-pinned'].filter(Boolean).join(' ');
  return (
    <div ref={setRef} className={cls} data-slide={slide} aria-current={focused ? 'true' : undefined}>
      <div className="slide-box" style={{ aspectRatio: aspect }}>
        {failed ? (
          <div className="slide-error">슬라이드 {slide} 이미지를 불러오지 못했어요</div>
        ) : (
          sizes && (
            <SlideImage
              docId={docId}
              slide={slide}
              src={viewUrl(docId, slide, 1000)}
              srcSet={viewSrcSet(docId, slide)}
              sizes={sizes}
              alt={`슬라이드 ${slide}`}
              draggable={false}
              onFail={() => setFailedAt(epoch)}
              onLoad={onImageLoad}
            />
          )
        )}
        {(selection || flash) && (
          <div className="region-layer" style={percentStyle(frame)} aria-hidden>
            {/* Drawn from the first moment (a zero-size start point after a long press): the dimmed slide shows
                that a selection has begun. */}
            {selection && <div className={`region-select is-${selection.phase}`} style={percentStyle(selection.rect)} />}
            {flash && <div key={flash.seq} className="region-flash" style={percentStyle(flash.rect)} />}
          </div>
        )}
        <span className="slide-label">
          {pinned && <span aria-label="고정됨">📌 </span>}
          {slide}
        </span>
        {qaCount > 0 && (
          <button
            type="button"
            className="qa-badge"
            onClick={() => onOpenNotes(slide)}
            title={`이 슬라이드의 Q&A ${qaCount}개 보기`}
          >
            💬 {qaCount}
          </button>
        )}
      </div>
      {selection?.phase === 'menu' && (
        <RegionMenu
          slide={slide}
          boxRect={rectInBox(selection.rect, frame)}
          placement={selection.placement}
          menu={menu}
          askDisabledReason={askDisabledReason}
        />
      )}
    </div>
  );
});

/** The floating menu of a finished selection: attach it, ask about it right away, or cancel. */
function RegionMenu({
  slide,
  boxRect,
  placement,
  menu,
  askDisabledReason,
}: {
  slide: number;
  boxRect: RegionRect;
  placement: MenuPlacement;
  menu: MenuActions;
  askDisabledReason: string | null;
}) {
  const attachRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    attachRef.current?.focus({ preventScroll: true });
  }, []);
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  const style: CSSProperties = {
    left: `clamp(0px, ${pct(boxRect.x)}, calc(100% - ${MENU_WIDTH_PX}px))`,
    top:
      placement === 'below'
        ? `calc(${pct(boxRect.y + boxRect.h)} + 8px)`
        : placement === 'above'
          ? `calc(${pct(boxRect.y)} - 8px)`
          : `calc(${pct(boxRect.y + boxRect.h)} - 8px)`,
  };
  return (
    <div
      className={`region-menu is-${placement}`}
      style={style}
      role="toolbar"
      aria-label={`슬라이드 ${slide}에서 선택한 영역`}
    >
      <button ref={attachRef} type="button" className="region-menu-btn" onClick={menu.attach} title="질문에 첨부해요 (입력창 위에 표시돼요)">
        📎 첨부
      </button>
      <button
        type="button"
        className="region-menu-btn is-primary"
        onClick={menu.ask}
        disabled={askDisabledReason !== null}
        title={askDisabledReason ?? '이 영역을 첨부해서 “이 부분 설명해줘”라고 바로 질문해요'}
      >
        💬 이 부분 설명해줘
      </button>
      <button type="button" className="region-menu-btn is-close" onClick={menu.cancel} aria-label="선택 취소" title="선택 취소 (Esc)">
        ✕
      </button>
    </div>
  );
}
