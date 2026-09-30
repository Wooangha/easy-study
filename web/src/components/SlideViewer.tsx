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
import { createPortal } from 'react-dom';
import type { AnnotationItem, AnnotationOp, DocMeta, MarkerKey, MemoItem, NotesResponse, Patchable, RegionRect, SlideAnnotations } from '../../../shared/types.ts';
import { viewSrcSet, viewUrl } from '../api.ts';
import { useAnnotations } from '../hooks/useAnnotations.ts';
import { useLoginEpoch } from '../hooks/useAuth.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { useTextLayout } from '../hooks/useTextLayout.ts';
import {
  itemBounds,
  memoAt,
  moveItems,
  newAnnotationId,
  newHighlight,
  newMemo,
  newShape,
  newTextBox,
  newTextHighlight,
  rectFromPoints,
  recordedAtFor,
  replayVisible,
  resizeRect,
  snapBand,
  textBoxFromDrag,
  type AnnotationTool,
  type Handle,
  unionRects,
} from '../lib/annotations/geometry.ts';
import { hitTestItems, marqueeSelect, outlineOnly, pressPlan, slopFor, toggleId, unionIds, type PressTarget } from '../lib/annotations/gesture.ts';
import { deriveMarkers, questionsOnItem, type QuestionMarker } from '../lib/annotations/markers.ts';
import { useAnnotColor, useAnnotLayer, useQuestionMarkers, useReplayAnnotations } from '../lib/annotations/settings.ts';
import { reanchorTextHighlight, textHighlightFromDrag } from '../lib/annotations/textSelect.ts';
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
import { confirmDialog } from '../lib/confirm.ts';
import { clamp, firstLine, slideSizes } from '../lib/format.ts';
import { usePlayhead } from '../lib/recording/playhead.ts';
import { recorder } from '../lib/recording/recorder.ts';
import { isNumber, readStorage, storageKeys, writeStorage } from '../lib/storage.ts';
import { toast } from '../lib/toast.ts';
import { AnnotationLayer, type Draft, type DragPreview } from './annotations/AnnotationLayer.tsx';
import { AnnotationTools, NO_FILTER, toolHint, useMediaQuery, type SlideFilter } from './annotations/AnnotationTools.tsx';
import { LayerContext, type LayerActions, type LayerEnv } from './annotations/context.ts';
import { ChatIcon } from './annotations/icons.tsx';
import { ItemMenu } from './annotations/ItemMenu.tsx';
import { MemoCard } from './annotations/MemoCard.tsx';
import { SlideImage } from './SlideImage.tsx';

export interface SlideViewerHandle {
  /** Scroll so that the slide sits in the vertical center of the viewer. */
  scrollToSlide: (slide: number, behavior?: ScrollBehavior) => void;
  /** Scroll a region of a slide to the center of the viewer and flash its outline (an attachment was opened). */
  showRegion: (slide: number, rect: RegionRect) => void;
  /** Scroll to an annotation item, select it and expand it (a memo of the 메모 tab). */
  showItem: (slide: number, id: string) => void;
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

/** The selected annotation items of one slide (one, or several after a marquee / Shift+click); the menu places itself. */
interface ItemSelection {
  slide: number;
  /** In z-order, at least one. */
  ids: readonly string[];
}

/**
 * A pointer pressed on a slide (lib/annotations/gesture.ts pressPlan): on an item it selects and moves it (every
 * selected item, when it is part of a group), on a handle it resizes, on empty area it draws with the active tool
 * (DESIGN §25), drags a marquee with 범위 선택, or, without a tool, becomes a region selection (§21). A text highlight
 * under 텍스트 형광 is re-dragged: a draw that replaces that item's words.
 */
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
  mode: 'region' | 'draw' | 'move' | 'resize' | 'marquee';
  tool: AnnotationTool;
  /** move / resize: the item and its geometry at the press; draw (텍스트 형광): the text highlight being re-dragged. */
  itemId?: string;
  item?: AnnotationItem;
  /** move: every item moved together (the pressed one, or the whole selection it belongs to). */
  items?: AnnotationItem[];
  handle?: Handle;
  wasSelected?: boolean;
  /** marquee: the selection to add to (Shift+drag), else empty. */
  base?: readonly string[];
  /** marquee: the memo cards as drawn (memoBoxesOf), by id. */
  memoBoxes?: Record<string, RegionRect>;
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
/** A layout that takes longer than this to arrive does not hold a highlight back (a plain band is drawn). */
const LAYOUT_WAIT_MS = 1500;
/** Below this viewer width the annotation tools fold into one button. */
const COMPACT_TOOLS_PX = 640;

/** Where the slide image is drawn in its box (a page shaped unlike page 1 is letterboxed). */
function frameOf(box: HTMLElement, rect: Box): Frame {
  const img = box.querySelector('img');
  const imageAspect = img && img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null;
  return rect.height > 0 ? imageFrame(rect.width / rect.height, imageAspect) : FULL_FRAME;
}

/**
 * The memo cards of a slide as drawn (a card is clamped inside the slide by CSS, so it is not where its anchor
 * says), as fractions of the image: what a marquee crosses. Measured once at the press — cards do not move during
 * a marquee.
 */
function memoBoxesOf(box: HTMLElement): Record<string, RegionRect> {
  const out: Record<string, RegionRect> = {};
  const layer = box.querySelector<HTMLElement>('.annot-layer')?.getBoundingClientRect();
  if (!layer || layer.width <= 0 || layer.height <= 0) return out;
  for (const el of box.querySelectorAll<HTMLElement>('[data-annot="memo"][data-id]')) {
    const r = el.getBoundingClientRect();
    out[el.dataset.id!] = { x: (r.left - layer.left) / layer.width, y: (r.top - layer.top) / layer.height, w: r.width / layer.width, h: r.height / layer.height };
  }
  return out;
}

/** The index in `list` (ascending slides) of `slide`, or of the nearest slide shown. */
function nearestIndex(list: readonly number[], slide: number): number {
  if (list.length === 0) return 0;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < slide) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(list[lo - 1] - slide) < Math.abs(list[lo] - slide)) return lo - 1;
  return lo;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      () => {
        window.clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
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
  /** "이 부분 설명해줘": attach the region and ask about it right away. */
  onAskRegion: (slide: number, rect: RegionRect) => void;
  /** Why a question cannot be sent right now (이 부분 설명해줘 is then disabled), or null. */
  askDisabledReason: string | null;
  /** 📎 첨부 of an annotation item (DESIGN §25): a chip for the next question. */
  onAttachItem?: (slide: number, item: AnnotationItem) => void;
  /** 📎 첨부 of several selected items at once (the free slots counted once, one toast). */
  onAttachItems?: (slide: number, items: AnnotationItem[]) => void;
  /** A question marker was clicked: show that Q&A. */
  onOpenQa?: (sessionId: string, messageId: string) => void;
  /** A memo's 🎙 chip: play that moment in the 녹음 tab. */
  onPlayRecording?: (rid: string, t: number) => void;
  /** A memo's link to another lecture. */
  onOpenDoc?: (docId: string, slide?: number) => void;
  /** The notes (every Q&A of the document): question markers are derived from them. */
  notes?: NotesResponse | null;
  /** 그때 필기 재생: the recording playing in the 녹음 tab and its playhead, or null. */
  replay?: { rid: string; t: number } | null;
  /** The library's lectures (memo links). */
  docs?: DocMeta[] | null;
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

const NO_TAGS: ReadonlyArray<{ tag: string; count: number }> = [];

export function SlideViewer({
  doc,
  qaCounts,
  pinnedSlide,
  onFocusChange,
  onOpenNotes,
  onAttachRegion,
  onAskRegion,
  askDisabledReason,
  onAttachItem,
  onAttachItems,
  onOpenQa,
  onPlayRecording,
  onOpenDoc,
  notes = null,
  replay = null,
  docs = null,
  ref,
}: SlideViewerProps) {
  const pageCount = Math.max(0, doc.pageCount);
  const aspect = Number.isFinite(doc.aspectRatio) && doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** The last pointer press was in the right pane: its scroll keys (↑↓, PageUp/Down, Home/End) stay native. */
  const pointerInOtherPaneRef = useRef(false);
  /** Slide elements by their index among the shown slides (every slide, or the filtered list). */
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

  // ---- Annotations (DESIGN §25): the store, the tools, the settings, the filter --------------------------------
  const { store, snapshot } = useAnnotations(doc.id);
  const storeRef = useLatest(store);
  const [tool, setToolState] = useState<AnnotationTool>('select');
  const toolRef = useLatest(tool);
  const [color, setColor] = useAnnotColor();
  const colorRef = useLatest(color);
  const [layerShown, setLayerShown] = useAnnotLayer();
  const [markersShown, setMarkersShown] = useQuestionMarkers();
  const [replayOn, setReplayOn] = useReplayAnnotations();
  const playhead = usePlayhead();
  const replayAvailable = playhead !== null && playhead.docId === doc.id;
  // 그때 필기 재생: the moment given by the app, else the player's own playhead (only the viewer re-renders with it).
  const replayNow = replayOn && playhead && playhead.docId === doc.id ? (replay ?? { rid: playhead.rid, t: playhead.t }) : null;
  const replayRef = useLatest(replayNow);
  const [filter, setFilterState] = useState<SlideFilter>(NO_FILTER);
  const [itemSelection, setItemSelectionState] = useState<ItemSelection | null>(null);
  const itemSelectionRef = useRef<ItemSelection | null>(null);
  const setItemSelection = useCallback((next: ItemSelection | null) => {
    itemSelectionRef.current = next;
    setItemSelectionState(next);
  }, []);
  const [editing, setEditing] = useState<{ slide: number; id: string } | null>(null);
  const [draft, setDraft] = useState<{ slide: number; draft: Draft } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ slide: number; drag: DragPreview } | null>(null);
  // The `sizes` of the slide images and the track's width (`--track-w`, which sizes typed text): measured below.
  const [sizes, setSizes] = useState<string | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [sheet, setSheet] = useState<{ slide: number; id: string } | null>(null);
  const sheetRef = useLatest(sheet);
  const [viewerWidth, setViewerWidth] = useState(1000);
  const shortScreen = useMediaQuery('(max-height: 640px)');
  const coarse = useMediaQuery('(pointer: coarse)');
  const compactTools = viewerWidth < COMPACT_TOOLS_PX || shortScreen;
  const compactMemos = compactTools || coarse;
  const { ensure: loadLayout, peek: peekLayout } = useTextLayout(doc.id);
  const summary = snapshot.summary;

  /** The slides shown: every slide, or (표시 있는 슬라이드만 / a tag) the summary's slides with items. */
  const shown = useMemo<number[]>(() => {
    if (!filter.onlyAnnotated && filter.tag === null) return Array.from({ length: pageCount }, (_, i) => i + 1);
    return (summary?.slides ?? [])
      .filter((s) => s.items > 0 && s.slide >= 1 && s.slide <= pageCount && (filter.tag === null || s.tags.includes(filter.tag)))
      .map((s) => s.slide);
  }, [filter, summary, pageCount]);
  const shownRef = useLatest(shown);
  const filtering = filter.onlyAnnotated || filter.tag !== null;

  const setTool = useCallback(
    (next: AnnotationTool) => {
      setToolState(next);
      if (next !== 'select') setItemSelection(null);
    },
    [setItemSelection],
  );

  const registerSlide = useCallback((index: number, el: HTMLDivElement | null) => {
    slideEls.current[index] = el;
  }, []);

  /** Focused slide = the slide crossing the vertical center line (fallback: the more visible neighbour). */
  const computeFocus = useCallback(() => {
    const scroller = scrollerRef.current;
    const els = slideEls.current;
    const list = shownRef.current;
    if (!scroller || list.length === 0) return;
    const box = scroller.getBoundingClientRect();
    const centerY = box.top + scroller.clientHeight / 2;

    // Slides are stacked vertically in order → binary search the first one whose bottom reaches the center.
    let lo = 0;
    let hi = list.length - 1;
    let idx = list.length - 1;
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
    const slide = list[best];
    if (slide !== focusedRef.current) {
      focusedRef.current = slide;
      setFocused(slide);
      onFocusChangeRef.current(slide);
    }
  }, [onFocusChangeRef, shownRef]);

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
      const el = slideEls.current[nearestIndex(shownRef.current, clamp(slide, 1, pageCount))];
      if (!scroller || !el) return;
      const sr = scroller.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const viewH = scroller.clientHeight;
      // Center the slide; if it is taller than the viewport (zoomed in), align its top instead.
      const delta = er.height > viewH ? er.top - sr.top - 12 : er.top + er.height / 2 - (sr.top + viewH / 2);
      scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
    },
    [pageCount, shownRef],
  );

  // ---- Region selection (DESIGN §21) -------------------------------------------------------------
  // The default state (no drawing tool). Mouse: press on empty area and drag (≥ 6 px; a plain click keeps its
  // meaning). Touch: hold still ~350 ms, then drag (a drag right away scrolls). Esc cancels. The rectangle is kept
  // normalised to the slide image, so it does not depend on the zoom level or on which rendition is shown.
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const setSelection = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  const gestureRef = useRef<Gesture | null>(null);
  const dragFrame = useRef(0);
  const onAttachRegionRef = useLatest(onAttachRegion);
  const onAskRegionRef = useLatest(onAskRegion);
  const onAttachItemRef = useLatest(onAttachItem);
  const onAttachItemsRef = useLatest(onAttachItems);
  const onOpenQaRef = useLatest(onOpenQa);
  const onPlayRecordingRef = useLatest(onPlayRecording);
  const onOpenDocRef = useLatest(onOpenDoc);
  const onOpenNotesRef = useLatest(onOpenNotes);

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

  // ---- Annotation editing: mutations, selection, deletion ---------------------------------------------------
  const mutate = useCallback(
    (slide: number, ops: Parameters<NonNullable<typeof store>['mutate']>[1], options?: { undoable?: boolean }) =>
      storeRef.current?.mutate(slide, ops, options) ?? false,
    [storeRef],
  );

  const itemOf = useCallback(
    (slide: number, id: string): AnnotationItem | null => storeRef.current?.snapshot.slides.get(slide)?.items.find((it) => it.id === id) ?? null,
    [storeRef],
  );
  const itemsOf = useCallback((slide: number): readonly AnnotationItem[] => storeRef.current?.snapshot.slides.get(slide)?.items ?? [], [storeRef]);

  /**
   * A slide's text layout (useTextLayout), and the moment its 텍스트 형광 made with another text engine are
   * re-anchored (textSelect.ts reanchorTextHighlight): their words are searched in this layout and the new fit is
   * written back (rects, chars, engine, text — not an undo step); one whose words are not found keeps its rects.
   * Until a layout is loaded the layer draws the stored rects.
   */
  const ensureLayout = useCallback(
    async (slide: number) => {
      const result = await loadLayout(slide);
      const layout = result.layout;
      const annotations = layout ? storeRef.current?.snapshot.slides.get(slide) : undefined;
      if (!layout || !annotations) return result;
      const ops: AnnotationOp[] = [];
      for (const item of annotations.items) {
        if (item.type !== 'textHighlight' || item.engine === layout.engine) continue;
        const fit = reanchorTextHighlight(item, layout);
        if (fit) ops.push({ op: 'update', id: item.id, patch: { rects: fit.rects, chars: fit.chars, engine: fit.engine, text: fit.text } });
      }
      if (ops.length > 0) mutate(slide, ops, { undoable: false });
      return result;
    },
    [loadLayout, storeRef, mutate],
  );

  /** Select these items (in z-order; nothing when none of them exists). The item menu places itself from their boxes. */
  const selectItems = useCallback(
    (slide: number, ids: readonly string[]) => {
      const known = itemsOf(slide);
      const order = known.filter((it) => ids.includes(it.id)).map((it) => it.id);
      if (order.length === 0) {
        setItemSelection(null);
        return;
      }
      setSelection(null);
      setItemSelection({ slide, ids: order });
    },
    [itemsOf, setItemSelection, setSelection],
  );

  const selectItem = useCallback(
    (slide: number, id: string | null) => {
      if (!id) {
        setItemSelection(null);
        return;
      }
      if (itemOf(slide, id)) selectItems(slide, [id]);
    },
    [itemOf, selectItems, setItemSelection],
  );

  /** Shift+click: the item joins the selection of its slide, or leaves it (a selection on another slide starts over). */
  const toggleSelect = useCallback(
    (slide: number, id: string) => {
      const current = itemSelectionRef.current;
      selectItems(slide, toggleId(current?.slide === slide ? current.ids : [], id));
    },
    [selectItems],
  );

  /** Delete items together (one write, one undo step); a memo with text asks first (once for the group). */
  const removeItems = useCallback(
    async (slide: number, ids: readonly string[]) => {
      const items = itemsOf(slide).filter((it) => ids.includes(it.id));
      if (items.length === 0) return;
      const memos = items.filter((it): it is MemoItem => it.type === 'memo' && it.text.trim() !== '');
      if (memos.length > 0) {
        const one = items.length === 1;
        const ok = await confirmDialog({
          title: one ? '메모를 지울까요?' : `필기 ${items.length}개를 지울까요?`,
          message: one ? firstLine(memos[0].text, 80) : `글이 있는 메모 ${memos.length}개가 함께 지워져요`,
          confirmLabel: '삭제',
          danger: true,
        });
        if (!ok) return;
      }
      const gone = new Set(items.map((it) => it.id));
      const current = itemSelectionRef.current;
      if (current?.slide === slide && current.ids.some((id) => gone.has(id))) {
        const left = current.ids.filter((id) => !gone.has(id));
        setItemSelection(left.length > 0 ? { slide, ids: left } : null);
      }
      setEditing((e) => (e && gone.has(e.id) ? null : e));
      setSheet((s) => (s && gone.has(s.id) ? null : s));
      mutate(
        slide,
        items.map((it) => ({ op: 'remove', id: it.id })),
      );
    },
    [itemsOf, mutate, setItemSelection],
  );

  const actions = useMemo<LayerActions>(
    () => ({
      select: selectItem,
      toggleSelect,
      edit: (slide, id) => setEditing(id ? { slide, id } : null),
      update: (slide, id, patch: Patchable<AnnotationItem>, options) => void mutate(slide, [{ op: 'update', id, patch }], options),
      updateMany: (slide, ids, patch: Patchable<AnnotationItem>) =>
        void mutate(
          slide,
          ids.map((id) => ({ op: 'update', id, patch })),
        ),
      remove: (slide, id) => void removeItems(slide, [id]),
      removeMany: (slide, ids) => void removeItems(slide, ids),
      attach: (slide, id) => {
        const item = itemOf(slide, id);
        if (item) onAttachItemRef.current?.(slide, item);
      },
      attachMany: (slide, ids) => {
        const items = itemsOf(slide).filter((it) => ids.includes(it.id));
        if (items.length === 0) return;
        if (onAttachItemsRef.current) onAttachItemsRef.current(slide, items);
        else for (const item of items) onAttachItemRef.current?.(slide, item);
      },
      hideMarkers: (slide, keys: MarkerKey[]) => void mutate(slide, keys.map((key) => ({ op: 'hideMarker', key }))),
      openQa: (sessionId, messageId) => onOpenQaRef.current?.(sessionId, messageId),
      openNotes: (slide) => onOpenNotesRef.current(slide),
      goToSlide: (slide) => scrollToSlide(slide),
      openDoc: (docId, slide) => onOpenDocRef.current?.(docId, slide),
      playRecording: (rid, t) => onPlayRecordingRef.current?.(rid, t),
      openSheet: (slide, id) => {
        selectItem(slide, id);
        setSheet({ slide, id });
      },
    }),
    [selectItem, toggleSelect, mutate, removeItems, itemOf, itemsOf, onAttachItemRef, onAttachItemsRef, onOpenQaRef, onOpenNotesRef, scrollToSlide, onOpenDocRef, onPlayRecordingRef],
  );

  const env = useMemo<LayerEnv>(
    () => ({ docId: doc.id, actions, docs, focusedSlide: focused, pageCount, tags: summary?.tags ?? NO_TAGS, compact: compactMemos, trackWidth }),
    [doc.id, actions, docs, focused, pageCount, summary, compactMemos, trackWidth],
  );

  /** Finish a drawing gesture: the item the drag (or click) makes, added and selected. */
  const finishDraw = useCallback(
    async (g: Gesture, point: Point, moved: boolean) => {
      const slide = g.slide;
      const seed = () => ({
        id: newAnnotationId(),
        color: colorRef.current,
        createdAt: new Date().toISOString(),
        recordedAt: recordedAtFor(recorder.getSnapshot(), recorder.clock(), doc.id),
      });
      let item: AnnotationItem | null = null;
      switch (g.tool) {
        case 'highlight': {
          if (!moved) return;
          const result = await withTimeout(ensureLayout(slide), LAYOUT_WAIT_MS, { layout: null, pending: true } as const);
          item = newHighlight(seed(), snapBand(g.start, point, result.layout));
          break;
        }
        case 'textHighlight': {
          if (!moved) return; // a click on the text highlight being re-dragged only selected it (on the press)
          const result = await withTimeout(ensureLayout(slide), LAYOUT_WAIT_MS, { layout: null, pending: true } as const);
          const fit = result.layout ? textHighlightFromDrag(g.start, point, result.layout) : null;
          if (g.itemId) {
            // Re-drag: the existing item takes the new words (its id, color and history stay); without a layout it is left alone.
            if (!fit) {
              toast(result.pending ? '이 슬라이드의 글자 위치를 준비하는 중이에요 — 잠시 뒤 다시 해 보세요' : '이 슬라이드에서는 글자를 찾지 못했어요', 'info');
              return;
            }
            if (mutate(slide, [{ op: 'update', id: g.itemId, patch: { rects: fit.rects, chars: fit.chars, engine: fit.engine, text: fit.text } }])) {
              selectItem(slide, g.itemId);
            }
            return;
          }
          if (fit) {
            item = newTextHighlight(seed(), fit);
          } else {
            if (!result.layout && result.pending) toast('이 슬라이드의 글자 위치를 준비하는 중이에요 — 잠시 뒤 다시 해 보세요', 'info');
            item = newHighlight(seed(), snapBand(g.start, point, result.layout));
          }
          break;
        }
        case 'rect':
        case 'ellipse':
          if (!moved) return;
          item = newShape(seed(), g.tool, rectFromPoints(g.start, point));
          break;
        case 'text':
          item = newTextBox(seed(), textBoxFromDrag(g.start, point));
          break;
        case 'memo':
          item = newMemo(seed(), memoAt(g.start));
          break;
        default:
          return;
      }
      if (!item || !mutate(slide, [{ op: 'add', item }])) return;
      selectItem(slide, item.id);
      if (item.type === 'text' || item.type === 'memo') {
        setEditing({ slide, id: item.id });
        if (item.type === 'memo' && compactMemos) setSheet({ slide, id: item.id });
      }
    },
    [colorRef, doc.id, ensureLayout, mutate, selectItem, compactMemos],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('.region-menu, .annot-pop, .link-picker, .popover-menu')) return;
    // Pressing anywhere else dismisses a finished selection's menu.
    if (selectionRef.current?.phase === 'menu') setSelection(null);
    if (gestureRef.current) {
      // A second finger (pinch zoom): not a selection.
      if (!gestureRef.current.active) cancelGesture();
      return;
    }
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const annot = target.closest<HTMLElement>('.annot-layer [data-annot]');
    if (!annot && target.closest('button, a, input, select, textarea')) return;
    const box = target.closest<HTMLElement>('.slide-box');
    const slide = Number(box?.closest<HTMLElement>('.slide')?.dataset.slide);
    if (!box || !Number.isInteger(slide) || slide < 1) return;
    const rect = box.getBoundingClientRect();
    const frame = frameOf(box, rect);
    const touch = e.pointerType !== 'mouse';
    const start = toImagePoint(e.clientX, e.clientY, rect, frame);
    const activeTool = layerShown ? toolRef.current : 'select';
    // What was pressed: a handle or a marker by the DOM; otherwise the slide's items are hit-tested (the SVG's own
    // target is not enough — a big rectangle drawn later covers a small highlight — and thin bands get some slack;
    // an unselected rect / ellipse counts on its outline only, so a box's inside passes through to what is under it).
    // Memo cards handle their own presses (they stop propagation) and get here only as part of a group selection,
    // when a press on the card (not on a control inside it) moves the whole group.
    const kind = annot?.dataset.annot;
    const handle = annot?.dataset.handle as Handle | undefined;
    const pressed: PressTarget = kind === 'marker' ? { kind: 'marker' } : kind === 'handle' && handle ? { kind: 'handle', handle } : { kind: 'other' };
    const selectedIds = itemSelectionRef.current?.slide === slide ? itemSelectionRef.current.ids : null;
    if (kind === 'memo') {
      const control = target.closest('button, a, input, select, textarea, .tag-input');
      if (control && control !== annot) return;
    }
    const item =
      pressed.kind === 'handle' || kind === 'memo'
        ? annot?.dataset.id
          ? itemOf(slide, annot.dataset.id)
          : null
        : layerShown
          ? hitTestItems(itemsOf(slide), start, slopFor(framePixels(rect, frame), touch), {
              visible: (it) => replayVisible(it, replayRef.current),
              outline: outlineOnly(selectedIds),
            })
          : null;
    const wasSelected = item !== null && (selectedIds?.includes(item.id) ?? false);
    const plan = pressPlan({ tool: activeTool, target: pressed, item, selected: wasSelected, touch, shift: e.shiftKey });
    if (plan.kind === 'ignore') return;
    const g: Gesture = {
      pointerId: e.pointerId,
      touch,
      slide,
      box,
      frame,
      start,
      startClient: { x: e.clientX, y: e.clientY },
      active: false,
      timer: 0,
      mode: 'region',
      tool: activeTool,
    };
    switch (plan.kind) {
      case 'resize':
        g.mode = 'resize';
        g.itemId = plan.item.id;
        g.item = plan.item;
        g.handle = plan.handle;
        g.active = true;
        gestureRef.current = g;
        capture(e);
        e.preventDefault();
        return;
      case 'select': {
        // An existing item, with any tool: select it; a drag moves it (its handles resize it) right away — and,
        // when it belongs to a group selection, moves every selected item with it.
        if (!wasSelected) selectItem(slide, plan.item.id);
        if (!plan.move) return;
        const group = wasSelected && selectedIds && selectedIds.length > 1 ? itemsOf(slide).filter((it) => selectedIds.includes(it.id) && it.type !== 'textHighlight') : [plan.item];
        g.mode = 'move';
        g.itemId = plan.item.id;
        g.item = plan.item;
        g.items = group;
        g.wasSelected = wasSelected;
        gestureRef.current = g;
        return;
      }
      case 'toggle':
        // Shift+click: in or out of the selection; nothing is moved.
        toggleSelect(slide, plan.item.id);
        return;
      case 'marquee':
        // 범위 선택 on empty area: a drag selects what it crosses (Shift: on top of the selection).
        g.mode = 'marquee';
        g.base = plan.add && selectedIds ? selectedIds : [];
        g.memoBoxes = memoBoxesOf(box);
        gestureRef.current = g;
        if (!plan.add && itemSelectionRef.current) setItemSelection(null);
        capture(e);
        if (plan.immediate) g.active = true;
        return;
      case 'draw':
        // Empty area with a tool: touch draws at once (the slide box takes no touch scrolling then).
        g.mode = 'draw';
        g.tool = plan.tool;
        gestureRef.current = g;
        if (itemSelectionRef.current) setItemSelection(null);
        if (plan.tool === 'highlight' || plan.tool === 'textHighlight') void ensureLayout(slide);
        capture(e);
        if (plan.immediate) g.active = true;
        return;
      case 'redraw':
        // 텍스트 형광 on a text highlight: a drag re-fits that item's words (finishDraw updates it), a click selects it.
        g.mode = 'draw';
        g.tool = 'textHighlight';
        g.itemId = plan.item.id;
        g.item = plan.item;
        gestureRef.current = g;
        if (!wasSelected) selectItem(slide, plan.item.id);
        void ensureLayout(slide);
        capture(e);
        if (plan.immediate) g.active = true;
        return;
      case 'region':
        // Empty area, no tool: the region gesture (a mouse drag; touch after a long press).
        if (itemSelectionRef.current) setItemSelection(null);
        gestureRef.current = g;
        if (g.touch) {
          g.timer = window.setTimeout(() => {
            if (gestureRef.current !== g) return;
            beginSelection(g);
            navigator.vibrate?.(10);
          }, LONG_PRESS_MS);
        }
        return;
    }
  };

  /**
   * The dashed preview of a drawing gesture: what the release will make. The highlight tools use the slide's layout
   * as soon as it is there (asked for on pointerdown, so usually cached by the first move): the band snapped to its
   * text line, or the word-fitted rects; a plain band until then (and, on release, when it never comes).
   */
  const previewOf = (g: Gesture, point: Point): Draft => {
    switch (g.tool) {
      case 'highlight':
        return { tool: g.tool, rect: snapBand(g.start, point, peekLayout(g.slide)) };
      case 'textHighlight': {
        const layout = peekLayout(g.slide);
        const fit = layout ? textHighlightFromDrag(g.start, point, layout) : null;
        return fit ? { tool: g.tool, rect: unionRects(fit.rects), rects: fit.rects } : { tool: g.tool, rect: snapBand(g.start, point, layout) };
      }
      case 'text':
        return { tool: g.tool, rect: textBoxFromDrag(g.start, point) };
      default:
        return { tool: g.tool, rect: rectFromPoints(g.start, point) };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const client = { x: e.clientX, y: e.clientY };
    if (g.mode === 'draw' || g.mode === 'move' || g.mode === 'resize' || g.mode === 'marquee') {
      if (!g.active) {
        if (!movedBeyond(g.startClient, client, DRAG_THRESHOLD_PX)) return;
        g.active = true;
        capture(e);
        window.getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      if (dragFrame.current) cancelAnimationFrame(dragFrame.current);
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = 0;
        if (gestureRef.current !== g) return;
        const box = g.box.getBoundingClientRect();
        const size = framePixels(box, g.frame);
        const point = toImagePoint(client.x, client.y, box, g.frame);
        if (g.mode === 'draw') {
          setDraft({ slide: g.slide, draft: previewOf(g, point) });
          return;
        }
        if (g.mode === 'marquee') {
          // The dashed rectangle, and the items it crosses selected as it goes.
          const rect = rectFromPoints(g.start, point, 0);
          setDraft({ slide: g.slide, draft: { tool: 'marquee', rect } });
          selectItems(g.slide, unionIds(g.base ?? [], marqueeSelect(itemsOf(g.slide), rect, { visible: (it) => replayVisible(it, replayRef.current), boxOf: (it) => g.memoBoxes?.[it.id] })));
          return;
        }
        const item = g.item!;
        const dx = (client.x - g.startClient.x) / size.width;
        const dy = (client.y - g.startClient.y) / size.height;
        if (g.mode === 'move') {
          setDragPreview({ slide: g.slide, drag: moveItems(g.items ?? [item], dx, dy) });
        } else if ('rect' in item && g.handle) {
          setDragPreview({ slide: g.slide, drag: { [item.id]: { rect: resizeRect(item.rect, g.handle, dx, dy) } } });
        }
      });
      return;
    }
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
    const box = g.box.getBoundingClientRect();
    const size = framePixels(box, g.frame);
    const point = toImagePoint(e.clientX, e.clientY, box, g.frame);
    const moved = Math.abs(point.x - g.start.x) * size.width >= MIN_DRAG_PX || Math.abs(point.y - g.start.y) * size.height >= MIN_DRAG_PX;
    if (g.mode === 'draw') {
      setDraft(null);
      // A drag only once the gesture activated (a mouse moved ≥ DRAG_THRESHOLD_PX): a press that jitters a few pixels
      // is a click, which the drag tools ignore and the click tools place.
      void finishDraw(g, point, g.active && moved);
      return;
    }
    if (g.mode === 'marquee') {
      setDraft(null);
      if (!g.active || !moved) {
        // A click: the selection is cleared (or kept, with Shift).
        if (!g.base?.length) setItemSelection(null);
        return;
      }
      const rect = rectFromPoints(g.start, point, 0);
      selectItems(g.slide, unionIds(g.base ?? [], marqueeSelect(itemsOf(g.slide), rect, { visible: (it) => replayVisible(it, replayRef.current), boxOf: (it) => g.memoBoxes?.[it.id] })));
      return;
    }
    if (g.mode === 'move' || g.mode === 'resize') {
      setDragPreview(null);
      const item = g.item!;
      if (!g.active || !moved) {
        // A click on an already selected text box (alone) opens it for editing.
        if (g.mode === 'move' && g.wasSelected && item.type === 'text' && itemSelectionRef.current?.ids.length === 1) setEditing({ slide: g.slide, id: item.id });
        return;
      }
      const dx = (e.clientX - g.startClient.x) / size.width;
      const dy = (e.clientY - g.startClient.y) / size.height;
      if (g.mode === 'move') {
        // Every moved item in one write (one undo step for the group), by one common delta (the group stops at an edge as one).
        const moves = moveItems(g.items ?? [item], dx, dy);
        mutate(
          g.slide,
          Object.entries(moves).map(([id, m]) => ({ op: 'update', id, patch: m.at ? { at: m.at } : { rect: m.rect! } })),
        );
      } else if ('rect' in item && g.handle) {
        mutate(g.slide, [{ op: 'update', id: item.id, patch: { rect: resizeRect(item.rect, g.handle, dx, dy) } }]);
      }
      return;
    }
    if (!g.active) return; // a plain click / tap
    if (!moved) {
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
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    cancelGesture();
    if (selectionRef.current?.phase === 'drag') setSelection(null);
    setDraft(null);
    setDragPreview(null);
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

  // Esc closes the memo sheet (first; its memo stays selected), else cancels a selection (being drawn or waiting in
  // its menu), the annotation tool (back to the default 선택·첨부 state) and the item selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || inDialog(e.target)) return;
      const annotating = toolRef.current !== 'select' || itemSelectionRef.current !== null || sheetRef.current !== null;
      if (!selectionRef.current && !gestureRef.current && !annotating) return;
      if (isTypingTarget(e.target)) return; // a memo's textarea handles its own Esc
      e.preventDefault();
      if (sheetRef.current) {
        setSheet(null);
        return;
      }
      cancelGesture();
      setSelection(null);
      setDraft(null);
      setDragPreview(null);
      setToolState('select');
      setItemSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelGesture, setSelection, toolRef, setItemSelection, sheetRef]);

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
      const el = slideEls.current[nearestIndex(shownRef.current, n)];
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
    [pageCount, shownRef],
  );

  /** A memo of the 메모 tab: bring its slide in view, select and expand it. */
  const showItem = useCallback(
    (slide: number, id: string) => {
      const s = storeRef.current;
      if (!s) return;
      void s.ensureSlide(slide).then((loaded) => {
        const item = loaded?.items.find((it) => it.id === id);
        if (!item) {
          toast('그 메모를 찾을 수 없어요', 'info');
          return;
        }
        if (shownRef.current.indexOf(slide) === -1) setFilterState(NO_FILTER);
        requestAnimationFrame(() => {
          scrollToSlide(slide, 'auto');
          showRegion(slide, itemBounds(item));
          selectItem(slide, id);
          if (item.type === 'memo') {
            if (compactMemos) setSheet({ slide, id });
            else if (item.collapsed) mutate(slide, [{ op: 'update', id, patch: { collapsed: false } }]);
          }
        });
      });
    },
    [storeRef, shownRef, scrollToSlide, showRegion, selectItem, compactMemos, mutate],
  );

  useImperativeHandle(ref, () => ({ scrollToSlide, showRegion, showItem }), [scrollToSlide, showRegion, showItem]);

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

  // The slide filter changed: the elements are indexed anew; stay on the focused slide (or the nearest shown).
  const shownKey = shown.join(',');
  const firstShown = useRef(true);
  useLayoutEffect(() => {
    if (firstShown.current) {
      firstShown.current = false;
      return;
    }
    slideEls.current.length = shown.length;
    anchorRef.current = null;
    if (shown.length > 0) scrollToSlide(focusedRef.current, 'auto');
    computeFocus();
    // Re-run only when the set of shown slides changes.
  }, [shownKey]);

  // Re-anchor when the viewer is resized (split divider, window resize); the toolbar folds on a narrow pane.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    let first = true;
    const ro = new ResizeObserver(() => {
      setViewerWidth(scroller.clientWidth);
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
  // requested at a wrong size. The same width (`--track-w`) gives the layers their rendered slide height, which
  // sizes typed text (a text size is a fraction of the slide height).
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const width = track.getBoundingClientRect().width;
      setTrackWidth(Math.round(width));
      const next = slideSizes(width);
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

  // The annotation store loads the slides around the focus (and drops those far away).
  useEffect(() => {
    store?.setWindow(focused, zoom, pageCount);
  }, [store, focused, zoom, pageCount]);

  // The layer hidden: no tool, no selection.
  useEffect(() => {
    if (layerShown) return;
    setToolState('select');
    setItemSelection(null);
    setEditing(null);
    setSheet(null);
  }, [layerShown, setItemSelection]);

  /** Undo / redo the last edit of this document, wherever it is; a quiet word, and the slide scrolled in view. */
  const undoRedo = useCallback(
    (direction: 'undo' | 'redo') => {
      const s = storeRef.current;
      if (!s) return;
      const result = direction === 'undo' ? s.undo() : s.redo();
      if (!result) return;
      toast(direction === 'undo' ? '되돌렸어요' : '다시 실행했어요', 'info', 1200);
      setItemSelection(null);
      if (result.slide !== focusedRef.current) scrollToSlide(result.slide);
    },
    [storeRef, scrollToSlide, setItemSelection],
  );
  const undoRedoRef = useLatest(undoRedo);
  const removeItemsRef = useLatest(removeItems);

  // Keyboard navigation (ignored while typing). j/k work anywhere else. The scroll keys belong to what the
  // student last clicked: in the chat, 정리본 or notes pane they scroll that pane natively instead of
  // moving the slides (which would also silently change the slide the next question is about).
  // ⌘Z / Ctrl+Z undo and ⌘⇧Z / Ctrl+Y redo the last annotation edit; Delete removes the selected one.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      pointerInOtherPaneRef.current = inOtherPane(e.target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || inDialog(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (inOtherPane(e.target) || pointerInOtherPaneRef.current) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          undoRedoRef.current('undo');
        } else if ((key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.metaKey)) {
          e.preventDefault();
          undoRedoRef.current('redo');
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && itemSelectionRef.current) {
        e.preventDefault();
        const s = itemSelectionRef.current;
        void removeItemsRef.current(s.slide, s.ids);
        return;
      }
      if (SCROLL_KEYS.has(e.key)) {
        const target = e.target instanceof Element ? e.target : null;
        const unfocused = !target || target === document.body || target === document.documentElement;
        if (inOtherPane(target) || (unfocused && pointerInOtherPaneRef.current)) return;
      }
      const list = shownRef.current;
      if (list.length === 0) return;
      let index: number;
      const now = performance.now();
      const base = navRef.current && now - navRef.current.at < 700 ? navRef.current.target : focusedRef.current;
      const at = nearestIndex(list, base);
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
        case 'PageDown':
          index = at + 1;
          break;
        case 'k':
        case 'ArrowUp':
        case 'PageUp':
          index = at - 1;
          break;
        case 'Home':
          index = 0;
          break;
        case 'End':
          index = list.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      const target = list[clamp(index, 0, list.length - 1)];
      navRef.current = { target, at: now };
      scrollToSlide(target, 'smooth');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [scrollToSlide, shownRef, undoRedoRef, removeItemsRef]);

  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const stepZoom = (dir: 1 | -1) =>
    setZoom((z) => ZOOM_LEVELS[clamp(ZOOM_LEVELS.indexOf(z) + dir, 0, ZOOM_LEVELS.length - 1)]);
  const [jumpValue, setJumpValue] = useState('');

  // Question markers (DESIGN §25): derived from the notes and the loaded slide documents.
  const markers = useMemo(
    () => deriveMarkers(notes, (s) => snapshot.slides.get(s), markersShown && layerShown),
    [notes, snapshot.slides, markersShown, layerShown],
  );
  // Selected items that vanished (deleted elsewhere, undone) leave the selection; none left → no menu.
  const selectedIdsKey = itemSelection ? itemSelection.ids.join(',') : '';
  useEffect(() => {
    if (!itemSelection) return;
    const items = snapshot.slides.get(itemSelection.slide)?.items ?? [];
    const left = itemSelection.ids.filter((id) => items.some((it) => it.id === id));
    if (left.length !== itemSelection.ids.length) setItemSelection(left.length > 0 ? { slide: itemSelection.slide, ids: left } : null);
    // Keyed by the ids and the slide documents.
  }, [selectedIdsKey, snapshot.slides, setItemSelection]);
  const sheetItem = sheet ? (snapshot.slides.get(sheet.slide)?.items.find((it) => it.id === sheet.id) ?? null) : null;

  const slides = [];
  for (let i = 0; i < shown.length; i++) {
    const n = shown[i];
    const annotations = layerShown ? (snapshot.slides.get(n) ?? null) : null;
    slides.push(
      <SlideItem
        key={n}
        docId={doc.id}
        slide={n}
        index={i}
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
        annotations={annotations}
        markers={annotations ? (markers.get(n) ?? null) : null}
        selectedIds={itemSelection?.slide === n ? itemSelection.ids : null}
        editingId={editing?.slide === n ? editing.id : null}
        draft={draft?.slide === n ? draft.draft : null}
        drag={dragPreview?.slide === n ? dragPreview.drag : null}
        tool={layerShown ? tool : 'select'}
        replay={annotations ? replayNow : null}
        layerShown={layerShown}
        unsaved={snapshot.unsaved.has(n)}
      />,
    );
  }

  const viewerCls = [
    'viewer',
    (selection?.phase === 'drag' || draft) && 'is-selecting',
    layerShown && tool !== 'select' && 'is-annot-tool',
    !layerShown && 'is-annot-hidden',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <LayerContext.Provider value={env}>
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
          <AnnotationTools
            tool={tool}
            onTool={setTool}
            color={color}
            onColor={setColor}
            layerShown={layerShown}
            onLayerShown={setLayerShown}
            markersShown={markersShown}
            onMarkersShown={setMarkersShown}
            filter={filter}
            onFilter={setFilterState}
            tags={summary?.tags ?? NO_TAGS}
            shownCount={filtering ? shown.length : null}
            pageCount={pageCount}
            replayAvailable={replayAvailable}
            replayOn={replayOn}
            onReplayOn={setReplayOn}
            replaying={replayNow !== null}
            compact={compactTools}
          />
          {/* After the tools, taking the leftover width: the buttons never move when the hint changes with the state. */}
          <span
            className="viewer-hint"
            title="키보드: j/k 또는 ↑/↓ 로 슬라이드 이동 · 도구 없이 빈 곳을 끌면 그 영역을 질문에 첨부해요 · 필기는 어느 도구에서든 클릭해서 옮기거나 지워요 (Shift+클릭으로 여러 개, 범위 선택 도구로 끌어서 여러 개) · ⌘Z/Ctrl+Z 되돌리기"
          >
            {toolHint(layerShown ? tool : 'select')}
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
        <div
          className="viewer-scroll"
          ref={scrollerRef}
          onScroll={scheduleFocus}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          tabIndex={0}
          aria-label="슬라이드 (j/k 또는 ↑/↓ 로 이동, 빈 곳을 끌어서 영역 첨부)"
        >
          <div
            className="slides-track"
            ref={trackRef}
            style={{ '--zoom': zoom, '--aspect': aspect, '--track-w': trackWidth > 0 ? trackWidth : undefined } as CSSProperties}
          >
            {slides}
            {filtering && shown.length === 0 && (
              <div className="annot-filter-empty">
                <p>{filter.tag ? `#${filter.tag} 태그가 붙은 슬라이드가 없어요.` : '표시가 있는 슬라이드가 아직 없어요.'}</p>
                <button type="button" className="ghost-btn small" onClick={() => setFilterState(NO_FILTER)}>
                  모든 슬라이드 보기
                </button>
              </div>
            )}
          </div>
        </div>
        {sheet &&
          sheetItem &&
          sheetItem.type === 'memo' &&
          createPortal(
            <div
              className="memo-sheet-backdrop"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) setSheet(null);
              }}
            >
              <div className="memo-sheet" role="dialog" aria-label={`슬라이드 ${sheet.slide}의 메모`}>
                <div className="memo-sheet-head">
                  <span className="slide-chip">p.{sheet.slide}</span>
                  <span className="spacer" />
                  <button type="button" className="icon-btn small" onClick={() => setSheet(null)} aria-label="닫기" title="닫기">
                    ✕
                  </button>
                </div>
                <MemoCard
                  slide={sheet.slide}
                  item={sheetItem}
                  selected
                  editing={editing?.id === sheetItem.id}
                  mode="sheet"
                  marker={markers.get(sheet.slide)?.find((m) => m.itemId === sheetItem.id)}
                />
              </div>
            </div>,
            document.body,
          )}
      </div>
    </LayerContext.Provider>
  );
}

interface SlideItemProps {
  docId: string;
  slide: number;
  /** Its index among the shown slides (the element registry). */
  index: number;
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
  /** The slide's annotations (null: not loaded, or the layer hidden). */
  annotations: SlideAnnotations | null;
  markers: readonly QuestionMarker[] | null;
  /** The selected items of this slide (null: the selection is elsewhere). */
  selectedIds: readonly string[] | null;
  editingId: string | null;
  draft: Draft | null;
  drag: DragPreview | null;
  tool: AnnotationTool;
  replay: { rid: string; t: number } | null;
  layerShown: boolean;
  /** The last write of this slide failed ("저장 안 됨"). */
  unsaved: boolean;
}

const SlideItem = memo(function SlideItem({
  docId,
  slide,
  index,
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
  annotations,
  markers,
  selectedIds,
  editingId,
  draft,
  drag,
  tool,
  replay,
  layerShown,
  unsaved,
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
  const setRef = useCallback((el: HTMLDivElement | null) => register(index, el), [register, index]);
  const cls = ['slide', focused && 'is-focused', pinned && 'is-pinned'].filter(Boolean).join(' ');
  const selectedItems = selectedIds && annotations ? annotations.items.filter((it) => selectedIds.includes(it.id)) : [];
  const questions = selectedItems.length === 1 ? questionsOnItem(markers ?? undefined, selectedItems[0].id) : 0;
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
        {layerShown && (annotations || draft) && (
          <AnnotationLayer
            slide={slide}
            frame={frame}
            aspect={aspect}
            doc={annotations}
            markers={markers}
            selectedIds={selectedIds}
            editingId={editingId}
            draft={draft}
            drag={drag}
            tool={tool}
            replay={replay}
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
            aria-label={`이 슬라이드의 Q&A ${qaCount}개 보기`}
          >
            <ChatIcon className="qa-badge-icon" />
            {qaCount}
          </button>
        )}
        {unsaved && (
          <span className="annot-unsaved" title="이 슬라이드의 필기를 서버에 저장하지 못했어요. 연결되면 다음 수정과 함께 다시 저장해요.">
            저장 안 됨
          </span>
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
      {selectedItems.length > 0 && !drag && !draft && <ItemMenu slide={slide} items={selectedItems} questions={questions} />}
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
        <ChatIcon className="region-menu-icon" />
        이 부분 설명해줘
      </button>
      <button type="button" className="region-menu-btn is-close" onClick={menu.cancel} aria-label="선택 취소" title="선택 취소 (Esc)">
        ✕
      </button>
    </div>
  );
}
