import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react';
import type { DocMeta } from '../../../shared/types.ts';
import { slideUrl } from '../api.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { clamp } from '../lib/format.ts';
import { isNumber, readStorage, storageKeys, writeStorage } from '../lib/storage.ts';

export interface SlideViewerHandle {
  /** Scroll so that the slide sits in the vertical center of the viewer. */
  scrollToSlide: (slide: number, behavior?: ScrollBehavior) => void;
}

interface SlideViewerProps {
  doc: DocMeta;
  /** Saved Q&A count per slide (badge). */
  qaCounts: Map<number, number>;
  pinnedSlide: number | null;
  onFocusChange: (slide: number) => void;
  /** Badge click → open the Notes tab filtered to that slide. */
  onOpenNotes: (slide: number) => void;
  ref?: Ref<SlideViewerHandle>;
}

/** Zoom factors relative to "fit width" (1). */
const ZOOM_LEVELS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function SlideViewer({ doc, qaCounts, pinnedSlide, onFocusChange, onOpenNotes, ref }: SlideViewerProps) {
  const pageCount = Math.max(0, doc.pageCount);
  const aspect = Number.isFinite(doc.aspectRatio) && doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9;

  const scrollerRef = useRef<HTMLDivElement>(null);
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
    // At the very top the first slide is what the user is looking at, even when zoomed out.
    if (scroller.scrollTop < 4) best = 0;

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

  useImperativeHandle(ref, () => ({ scrollToSlide }), [scrollToSlide]);

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

  // Remember the position per doc.
  useEffect(() => {
    writeStorage(storageKeys.slide(doc.id), focused);
  }, [doc.id, focused]);

  // Keyboard navigation (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
        focused={n === focused}
        pinned={n === pinnedSlide}
        qaCount={qaCounts.get(n) ?? 0}
        register={registerSlide}
        onOpenNotes={onOpenNotes}
      />,
    );
  }

  return (
    <div className="viewer">
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
        <span className="viewer-hint" title="키보드: j/k 또는 ↑/↓ 로 슬라이드 이동">
          j/k · ↑/↓
        </span>
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
      <div className="viewer-scroll" ref={scrollerRef} onScroll={scheduleFocus}>
        <div className="slides-track" style={{ '--zoom': zoom } as CSSProperties}>
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
  focused: boolean;
  pinned: boolean;
  qaCount: number;
  register: (index: number, el: HTMLDivElement | null) => void;
  onOpenNotes: (slide: number) => void;
}

const SlideItem = memo(function SlideItem({
  docId,
  slide,
  aspect,
  focused,
  pinned,
  qaCount,
  register,
  onOpenNotes,
}: SlideItemProps) {
  const [failed, setFailed] = useState(false);
  const setRef = useCallback((el: HTMLDivElement | null) => register(slide - 1, el), [register, slide]);
  const cls = ['slide', focused && 'is-focused', pinned && 'is-pinned'].filter(Boolean).join(' ');
  return (
    <div ref={setRef} className={cls} data-slide={slide} aria-current={focused ? 'true' : undefined}>
      <div className="slide-box" style={{ aspectRatio: aspect }}>
        {failed ? (
          <div className="slide-error">슬라이드 {slide} 이미지를 불러오지 못했어요</div>
        ) : (
          <img
            src={slideUrl(docId, slide)}
            alt={`슬라이드 ${slide}`}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
          />
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
    </div>
  );
});
