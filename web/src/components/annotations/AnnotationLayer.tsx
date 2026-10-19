// The annotation layer of one slide (DESIGN §25), inside the slide box over the image: an SVG for the highlights and
// shapes (a 0..1000 viewBox stretched over the image, so the stored 0..1 geometry maps directly) and the 펜 strokes
// (§29: each a filled path in a nested <svg> whose viewBox has the image's aspect, so a stroke is not stretched; the
// selected strokes get one dashed box around them all), HTML for the
// text boxes (their font scales with the slide: a size stored as a fraction of the slide height × the layer's
// rendered height, `--slide-h`), the memo cards (UI-sized), the selection handles, the draft being drawn (or the
// marquee of 범위 선택), and the question markers (the asked-about regions under the items, their labels and the items'
// dots over them, a memo's dot on its card). The layer itself takes no pointer events; its interactive children
// do and carry `data-annot`, so the viewer's scroller knows what was pressed.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AnnotationColor, AnnotationItem, InkItem, RegionRect, SlideAnnotations, TextItem } from '../../../../shared/types.ts';
import {
  ALL_HANDLES,
  bandHandles,
  capText,
  replayVisible,
  unionRects,
  type AnnotationTool,
  type Handle,
} from '../../lib/annotations/geometry.ts';
import { imageAspectOf, inkPathOf } from '../../lib/annotations/ink.ts';
import type { QuestionMarker } from '../../lib/annotations/markers.ts';
import { textBoxVars } from '../../lib/annotations/text.ts';
import { percentStyle, type Frame, type Point } from '../../lib/attachments.ts';
import { useLatest } from '../../hooks/useLatest.ts';
import { msg } from '../../i18n/index.ts';
import { useLayerEnv } from './context.ts';
import { TEXT_LOOK_CONTROLS } from './ItemMenu.tsx';
import { MemoCard } from './MemoCard.tsx';
import { QuestionMarkers, QuestionRegions, type LightMarker } from './QuestionMarkers.tsx';

/** A shape being drawn on this slide (a dashed preview of what the release will make), or the marquee of 범위 선택. */
export interface Draft {
  tool: AnnotationTool;
  rect: RegionRect;
  /** 텍스트 형광 with the slide's layout at hand: the word-fitted rects, one per line (`rect` is their union). */
  rects?: RegionRect[];
  /** 형광펜 / 텍스트 형광: the color the band will have. */
  color?: AnnotationColor;
}

/** Items being moved or resized on this slide, by id (drawn at the new place; one PATCH on pointer-up). */
export type DragPreview = Readonly<Record<string, { rect?: RegionRect; at?: Point }>>;

interface AnnotationLayerProps {
  slide: number;
  frame: Frame;
  /** The slide box's aspect ratio (width / height): with the track's width, the image's size in px. */
  aspect: number;
  /** The slide's document (null while not loaded: only a draft can show). */
  doc: SlideAnnotations | null;
  markers: readonly QuestionMarker[] | null;
  /** The selected items (several after a marquee / Shift+click); null when the selection is elsewhere. */
  selectedIds: readonly string[] | null;
  /** The text box / memo opened for editing. */
  editingId: string | null;
  draft: Draft | null;
  drag: DragPreview | null;
  tool: AnnotationTool;
  /** 그때 필기 재생: only items made by this moment of this recording show. */
  replay: { rid: string; t: number } | null;
}

const K = 1000;
const NO_LIT: ReadonlySet<string> = new Set();
const n = (v: number) => (v * K).toFixed(1);

export function AnnotationLayer({ slide, frame, aspect, doc, markers, selectedIds, editingId, draft, drag, tool, replay }: AnnotationLayerProps) {
  const items = doc?.items ?? [];
  // A question marker hovered / focused / opened lights its region (drawn under the items, far from its label).
  const [litMarkers, setLitMarkers] = useState<ReadonlySet<string>>(NO_LIT);
  const lightMarker = useCallback<LightMarker>(
    (id, on) =>
      setLitMarkers((cur) => {
        if (cur.has(id) === on) return cur;
        const next = new Set(cur);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const shownMarkers = markers && markers.length > 0 ? markers : null;
  const rectOf = (item: AnnotationItem & { rect: RegionRect }) => drag?.[item.id]?.rect ?? item.rect;
  // A Set: a marquee may select thousands of 펜 strokes.
  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const isSelected = (id: string) => selected.has(id);
  const shapes: AnnotationItem[] = [];
  const texts: TextItem[] = [];
  const memos: Extract<AnnotationItem, { type: 'memo' }>[] = [];
  /** The selected strokes as drawn (a move preview included): one dashed box around them when there are several. */
  const inkBoxes: RegionRect[] = [];
  for (const item of items) {
    if (!replayVisible(item, replay)) continue;
    if (item.type === 'text') texts.push(item);
    else if (item.type === 'memo') memos.push(item);
    else shapes.push(item);
    if (item.type === 'ink' && selected.has(item.id)) inkBoxes.push(rectOf(item));
  }
  // 펜 strokes are drawn in a box with the image's aspect: K tall, inkW wide.
  const inkW = Math.round(K * imageAspectOf(aspect, frame) * 10) / 10;
  // Handles belong to a single selection; a group is moved by its body.
  const single = selectedIds && selectedIds.length === 1 ? (items.find((it) => it.id === selectedIds[0]) ?? null) : null;
  // The text box being typed in grows with its text before its size is stored: its handles go with it.
  const [live, setLive] = useState<{ id: string; w: number; h: number } | null>(null);
  const onLiveSize = useCallback(
    (id: string, size: { w: number; h: number } | null) =>
      setLive((cur) => {
        if (size === null) return cur?.id === id ? null : cur;
        return cur?.id === id && Math.abs(cur.w - size.w) < 1e-4 && Math.abs(cur.h - size.h) < 1e-4 ? cur : { id, ...size };
      }),
    [],
  );
  const liveRect = single && live?.id === single.id && 'rect' in single ? { ...single.rect, w: live.w, h: live.h } : null;
  const handles = single && single.type !== 'memo' && single.type !== 'textHighlight' ? handlesOf(single, drag, liveRect) : null;
  const group = (selectedIds?.length ?? 0) > 1;
  // One stroke selected: its own box (with the handles); several: one box around all of them, not one per stroke.
  const inkUnion = inkBoxes.length > 1 ? unionRects(inkBoxes) : null;

  return (
    <div className={`annot-layer tool-${tool}`} style={{ ...percentStyle(frame), '--frame-h': frame.h } as CSSProperties} data-annot-slide={slide}>
      {shownMarkers && <QuestionRegions markers={shownMarkers} lit={litMarkers} />}
      <svg className="annot-svg" viewBox={`0 0 ${K} ${K}`} preserveAspectRatio="none" aria-hidden>
        {shapes.map((item) => {
          const cls = `annot-shape is-${item.color}${isSelected(item.id) ? ' is-selected' : ''}`;
          switch (item.type) {
            case 'highlight': {
              const r = rectOf(item);
              return <rect key={item.id} className={`${cls} kind-highlight`} data-annot="item" data-id={item.id} x={n(r.x)} y={n(r.y)} width={n(r.w)} height={n(r.h)} />;
            }
            case 'textHighlight':
              return (
                <g key={item.id} className={`${cls} kind-text-highlight`} data-annot="item" data-id={item.id}>
                  {item.rects.map((r, i) => (
                    <rect key={i} x={n(r.x)} y={n(r.y)} width={n(r.w)} height={n(r.h)} />
                  ))}
                </g>
              );
            case 'rect': {
              const r = rectOf(item);
              return <rect key={item.id} className={`${cls} kind-rect`} data-annot="item" data-id={item.id} x={n(r.x)} y={n(r.y)} width={n(r.w)} height={n(r.h)} />;
            }
            case 'ellipse': {
              const r = rectOf(item);
              return (
                <ellipse key={item.id} className={`${cls} kind-ellipse`} data-annot="item" data-id={item.id} cx={n(r.x + r.w / 2)} cy={n(r.y + r.h / 2)} rx={n(r.w / 2)} ry={n(r.h / 2)} />
              );
            }
            case 'ink':
              return <InkStroke key={item.id} item={item} rect={rectOf(item)} w={inkW} boxed={inkBoxes.length === 1 && selected.has(item.id)} />;
            default:
              return null;
          }
        })}
        {inkUnion && <rect className="annot-ink-box" x={n(inkUnion.x)} y={n(inkUnion.y)} width={n(inkUnion.w)} height={n(inkUnion.h)} />}
        {draft && draft.tool !== 'memo' && draft.tool !== 'text' && (
          <DraftShape draft={draft} />
        )}
      </svg>
      {texts.map((item) => (
        <TextBox
          key={item.id}
          slide={slide}
          item={item}
          rect={rectOf(item)}
          selected={isSelected(item.id)}
          editing={item.id === editingId}
          onLiveSize={onLiveSize}
        />
      ))}
      {draft && draft.tool === 'text' && <div className="annot-text annot-draft" style={percentStyle(draft.rect)} aria-hidden />}
      {memos.map((item) => {
        const at = drag?.[item.id]?.at;
        return (
          <MemoCard
            key={item.id}
            slide={slide}
            item={at ? { ...item, at } : item}
            selected={isSelected(item.id)}
            group={group && isSelected(item.id)}
            editing={item.id === editingId}
            mode="inline"
            marker={shownMarkers?.find((m) => m.itemId === item.id)}
          />
        );
      })}
      {handles && !drag && handles.map(({ handle, style }) => (
        <div key={handle} className={`annot-handle is-${handle}`} style={style} data-annot="handle" data-handle={handle} data-id={single!.id} />
      ))}
      {shownMarkers && (
        <QuestionMarkers
          slide={slide}
          markers={shownMarkers}
          frame={frame}
          aspect={aspect}
          skipItems={selectedIds}
          onLit={lightMarker}
        />
      )}
    </div>
  );
}

interface InkStrokeProps {
  item: InkItem;
  /** Where it is drawn: its rect, or a move / resize preview. */
  rect: RegionRect;
  /** The image's width in the K-tall box. */
  w: number;
  /** The only selected stroke: its rect is drawn dashed. */
  boxed: boolean;
}

const sameRect = (a: RegionRect, b: RegionRect): boolean => a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** By value: a write's answer may bring an equal stroke as a new object (and a rect as a new object every render). */
const sameInkProps = (a: InkStrokeProps, b: InkStrokeProps): boolean =>
  a.item.id === b.item.id &&
  a.item.pts === b.item.pts &&
  a.item.width === b.item.width &&
  a.item.color === b.item.color &&
  sameRect(a.item.rect, b.item.rect) &&
  sameRect(a.rect, b.rect) &&
  a.w === b.w &&
  a.boxed === b.boxed;

/**
 * A 펜 stroke: its filled outline in a nested <svg> over the whole image whose viewBox (`w` × K) has the image's aspect
 * (the layer's SVG is stretched to the image; this undoes it), through `rect`. A move (the same size elsewhere) only
 * shifts the nested <svg>; the outline is computed again only when the stroke's values, its size (a resize preview) or
 * the image's aspect change. The only selected stroke has its rect drawn dashed.
 */
const InkStroke = memo(function InkStroke({ item, rect, w, boxed }: InkStrokeProps) {
  const from = item.rect;
  const moved = rect.w === from.w && rect.h === from.h;
  const shape = moved ? from : rect;
  // Value deps: an equal stroke as a new object (a fetch, a write's answer) keeps its outline.
  const d = useMemo(
    () => inkPathOf(item, shape, w, K),
    [item.pts, item.width, from.x, from.y, from.w, from.h, shape.x, shape.y, shape.w, shape.h, w],
  );
  const dx = moved ? Math.round((rect.x - from.x) * K * 10) / 10 : 0;
  const dy = moved ? Math.round((rect.y - from.y) * K * 10) / 10 : 0;
  return (
    <>
      <svg x={dx} y={dy} width={K} height={K} viewBox={`0 0 ${w} ${K}`} preserveAspectRatio="none" overflow="visible">
        <path className={`annot-shape kind-ink is-${item.color}`} data-annot="item" data-id={item.id} d={d} />
      </svg>
      {boxed && <rect className="annot-ink-box" x={n(rect.x)} y={n(rect.y)} width={n(rect.w)} height={n(rect.h)} />}
    </>
  );
}, sameInkProps);

function DraftShape({ draft }: { draft: Draft }) {
  const r = draft.rect;
  if (draft.tool === 'ellipse') {
    return <ellipse className="annot-draft-shape" cx={n(r.x + r.w / 2)} cy={n(r.y + r.h / 2)} rx={n(r.w / 2)} ry={n(r.h / 2)} />;
  }
  const cls =
    draft.tool === 'highlight' || draft.tool === 'textHighlight'
      ? `annot-draft-shape is-band is-${draft.color ?? 'yellow'}`
      : draft.tool === 'marquee'
        ? 'annot-draft-shape is-marquee'
        : 'annot-draft-shape';
  if (draft.rects) {
    return (
      <>
        {draft.rects.map((b, i) => (
          <rect key={i} className={cls} x={n(b.x)} y={n(b.y)} width={n(b.w)} height={n(b.h)} />
        ))}
      </>
    );
  }
  return <rect className={cls} x={n(r.x)} y={n(r.y)} width={n(r.w)} height={n(r.h)} />;
}

/** Where the handles of the selected item are (as percentages of the layer). */
function handlesOf(item: AnnotationItem & { rect?: RegionRect }, drag: DragPreview | null, live: RegionRect | null = null): Array<{ handle: Handle; style: CSSProperties }> {
  if (!item.rect) return [];
  const r = drag?.[item.id]?.rect ?? live ?? item.rect;
  const list = item.type === 'highlight' ? bandHandles(r) : ALL_HANDLES;
  return list.map((handle) => {
    const x = handle.includes('w') ? r.x : handle.includes('e') ? r.x + r.w : r.x + r.w / 2;
    const y = handle.includes('n') ? r.y : handle.includes('s') ? r.y + r.h : r.y + r.h / 2;
    return { handle, style: { left: `${(x * 100).toFixed(3)}%`, top: `${(y * 100).toFixed(3)}%` } };
  });
}

/**
 * The laid-out height of a text box as a fraction of the layer: its content (`el`, the shown body or the textarea)
 * plus the box's own padding and border — what the box is drawn at, so the stored `rect.h` is the visible box and
 * its bottom handles sit on its bottom edge. Null when nothing can be measured.
 */
/** The laid-out width of a text box as a fraction of the layer (a box as wide as its text, TextItem.autoWidth). */
function laidOutWidth(box: HTMLElement | null, rect: RegionRect): number | null {
  const layer = box?.parentElement;
  if (!box || !layer || layer.clientWidth <= 0) return null;
  return Math.min(1 - rect.x, Math.max(0.02, Math.round((box.offsetWidth / layer.clientWidth) * 1e4) / 1e4));
}

function laidOutHeight(el: HTMLElement | null, box: HTMLElement | null, rect: RegionRect): number | null {
  const layer = box?.parentElement;
  if (!el || !box || !layer || layer.clientHeight <= 0) return null;
  const cs = getComputedStyle(box);
  const chrome = [cs.paddingTop, cs.paddingBottom, cs.borderTopWidth, cs.borderBottomWidth].reduce((sum, v) => sum + (Number.parseFloat(v) || 0), 0);
  return Math.min(1 - rect.y, Math.max(0.02, Math.round(((el.scrollHeight + chrome) / layer.clientHeight) * 1e4) / 1e4));
}

/**
 * A text box: typed text drawn on the slide in its size / font / weight (text.ts textBoxVars); editing swaps in a
 * textarea in the same box, committed on blur / Esc / ⌘Enter — and when the box goes away while typing (the layer
 * hidden, the slide filtered out, the lecture closed): WebKit sends no blur to a textarea removed while focused.
 * The menu's look controls (ItemMenu TEXT_LOOK_CONTROLS) do not end the typing: their buttons keep the focus (or, when
 * a tap took it anyway, give it back), the size field and the font take it and the typing stays open until a press
 * or the focus goes anywhere else — a box just made can get its size before its text.
 * The box is at least its stored height and grows with its content — while typing too, at once: a new line, a line
 * that wraps, a font / weight / size that takes more room (the textarea is sized to its text; the commit stores the
 * height). Shown, when its size, font or weight changes the stored height is re-laid out, and when it was made
 * narrower it grows to fit its lines (a follow-up write, not an undo step of its own).
 * A box made with a click (`autoWidth`) is as wide as its longest line instead: while typing it widens to the right
 * (measured by a hidden copy of its text, up to the slide's right edge, where it wraps), shown it is `max-content`
 * wide; its width is stored like its height. A drag or a side handle gives a box a width it keeps.
 */
function TextBox({
  slide,
  item,
  rect,
  selected,
  editing,
  onLiveSize,
}: {
  slide: number;
  item: TextItem;
  rect: RegionRect;
  selected: boolean;
  editing: boolean;
  /** The size the box being typed in has grown to (fractions of the layer), null when it is its stored one. */
  onLiveSize: (id: string, size: { w: number; h: number } | null) => void;
}) {
  const { actions } = useLayerEnv();
  const [text, setText] = useState(item.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** What the textarea holds (its value when the box goes away while typing). */
  const typed = useRef(item.text);
  /** The text when the editing started (the text typed so far may have been saved since). */
  const startText = useRef(item.text);
  /** The textarea's laid-out height (and the box's width) when last fitted (a commit after it is gone cannot measure it). */
  const measured = useRef<number | null>(null);
  const measuredW = useRef<number | null>(null);
  /** The hidden copy of the text whose width a box as wide as its text takes while typing. */
  const measureRef = useRef<HTMLSpanElement>(null);
  // As wide as its text: made with a click, and not being resized right now (a resize shows the dragged width).
  const auto = item.autoWidth === true && rect.w === item.rect.w;
  const autoRef = useLatest(auto);
  /** This editing was committed (a blur, a press elsewhere and the editing's end can each end it). */
  const done = useRef(false);
  /** The menu's look control the last press while editing was on (null: anywhere else). */
  const lookPress = useRef<Element | null>(null);
  useEffect(() => {
    if (!editing) return;
    // The item's text changed under the typing (⌘Z, another device): the textarea and what a late commit writes follow.
    setText(item.text);
    typed.current = item.text;
  }, [editing, item.text]);
  useLayoutEffect(() => {
    if (!editing) return;
    done.current = false;
    lookPress.current = null;
    typed.current = item.text;
    startText.current = item.text;
    measured.current = null;
    measuredW.current = null;
    ref.current?.focus({ preventScroll: true });
    // Only when the editing starts (`item.text` is what it starts from).
  }, [editing]);

  const commit = (value: string) => {
    if (done.current) return;
    done.current = true;
    const capped = capText(value);
    if (capped.trim() === '' && startText.current.trim() === '') {
      // A box left empty (just made, or emptied): gone.
      actions.remove(slide, item.id);
      return;
    }
    const patch: { text?: string; rect?: RegionRect } = {};
    if (capped !== item.text) patch.text = capped;
    // The laid-out height becomes the box's height (and a box as wide as its text, its width), so it looks the same on
    // another device.
    const h = laidOutHeight(ref.current, boxRef.current, rect) ?? measured.current;
    const w = item.autoWidth ? measuredW.current : null;
    const grownH = h !== null && Math.abs(h - rect.h) > 0.002;
    const grownW = w !== null && Math.abs(w - rect.w) > 0.002;
    if (grownH || grownW) patch.rect = { ...rect, ...(grownH ? { h: h as number } : {}), ...(grownW ? { w: w as number } : {}) };
    // The height alone is not an undo step of its own (the look change before it is).
    if (patch.text !== undefined || patch.rect) actions.update(slide, item.id, patch, patch.text === undefined ? { undoable: false } : undefined);
    // Not edit(null): a commit that comes late (the editing already moved to a box just made) leaves that one open.
    actions.endEdit(slide, item.id);
  };
  const commitRef = useLatest(commit);
  /** The text so far, written without ending the typing (an empty box stays as it is: its commit decides). */
  const save = (value: string) => {
    const capped = capText(value);
    if (capped === item.text || capped.trim() === '') return;
    actions.update(slide, item.id, { text: capped });
  };

  // While editing: a press anywhere but the box and the look controls, or the focus going anywhere but there, ends it
  // when the textarea has given its focus away (else its blur does) — a moment later, after the size field has
  // applied what was typed in it.
  useEffect(() => {
    if (!editing) return;
    const look = (target: EventTarget | null) => (target instanceof Element && target.closest(TEXT_LOOK_CONTROLS) ? target : null);
    // The menu's bare background (padding, gaps, labels) is not elsewhere either; its other buttons are.
    const bare = (target: EventTarget | null) => target instanceof Element && target.closest('.annot-item-menu, .annot-style-pop') !== null && !target.closest('button, a, input, select');
    const elsewhere = (target: EventTarget | null) => !look(target) && !bare(target) && !(target instanceof Node && boxRef.current?.contains(target));
    let timer = 0;
    const end = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => commitRef.current(typed.current));
    };
    const onDown = (e: PointerEvent) => {
      lookPress.current = look(e.target);
      if (elsewhere(e.target) && document.activeElement !== ref.current) end();
    };
    const onFocus = (e: FocusEvent) => {
      if (elsewhere(e.target)) end();
    };
    // The size field (or the font) left with Enter / Esc — the focus goes nowhere: back to the typing, at once (still
    // inside the key press: iOS raises its keyboard only then).
    const onFocusOut = (e: FocusEvent) => {
      if (!lookPress.current || e.relatedTarget !== null || !(e.target instanceof Element && e.target.matches('input, select') && look(e.target))) return;
      if (!done.current) ref.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onFocusOut, true);
      window.clearTimeout(timer);
    };
  }, [editing, commitRef]);
  // When a look control pressed with the pointer has acted (the look or the color changed), the focus goes back to the
  // textarea and the typing goes on: from a button that took it (from the size field, or a tap in WebKit, which
  // focuses nothing), from the font once chosen. Not from the size field while it is in use, nor for the keyboard.
  const lookKey = `${item.size ?? ''}/${item.font ?? ''}/${item.bold ? 1 : 0}/${item.color}`;
  useLayoutEffect(() => {
    const pressed = lookPress.current;
    if (!editing || done.current || !pressed) return;
    const active = document.activeElement;
    const field = pressed.closest('input, select');
    const acted = field ? field instanceof HTMLSelectElement && active === field : !active || active === document.body || active === pressed.closest('button');
    if (acted) ref.current?.focus({ preventScroll: true });
  }, [editing, lookKey]);

  // The editing ended or the box went away before a commit (a press elsewhere that ended it at once, the layer hidden,
  // the slide filtered out, the lecture closed): what was typed is committed — an empty box goes. A moment later: in
  // development StrictMode runs this cleanup once on mount and the effect again at once, which must not end anything.
  const ending = useRef<{ cancelled: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!editing) return;
    if (ending.current) ending.current.cancelled = true;
    ending.current = null;
    return () => {
      const end = { cancelled: false };
      ending.current = end;
      queueMicrotask(() => {
        if (end.cancelled) return;
        ending.current = null;
        commitRef.current(typed.current);
      });
    };
  }, [editing, commitRef]);

  // The look changed (the menu's size / font / bold, here or on another device): the stored height follows the
  // new layout. Not on mount — two devices with different fonts must not keep rewriting each other's height.
  const look = `${item.size ?? ''}/${item.font ?? ''}/${item.bold ? 1 : 0}`;
  const lastLook = useRef(look);
  const rectRef = useLatest(rect);
  useLayoutEffect(() => {
    // While typing it waits (the textarea is never shorter than the box, so it could only grow it): a look changed
    // meanwhile is laid out when the typing ends.
    if (editing || lastLook.current === look) return;
    lastLook.current = look;
    const r = rectRef.current;
    const h = laidOutHeight(bodyRef.current, boxRef.current, r);
    const w = autoRef.current ? laidOutWidth(boxRef.current, r) : null;
    const next = { ...r, ...(h !== null ? { h } : {}), ...(w !== null ? { w } : {}) };
    if (Math.abs(next.h - r.h) > 0.002 || Math.abs(next.w - r.w) > 0.002) actions.update(slide, item.id, { rect: next }, { undoable: false });
  }, [look, editing, actions, slide, item.id, rectRef, autoRef]);

  // Made narrower (its handles, here or on another device): the lines it now needs may not fit — the stored height
  // grows to them. Never shrinks (a height dragged on purpose stays). The stored width, not a resize being dragged.
  const lastW = useRef(item.rect.w);
  useLayoutEffect(() => {
    if (editing || lastW.current === item.rect.w) return;
    lastW.current = item.rect.w;
    const r = item.rect;
    const h = laidOutHeight(bodyRef.current, boxRef.current, r);
    if (h !== null && h > r.h + 0.002) actions.update(slide, item.id, { rect: { ...r, h } }, { undoable: false });
  }, [item.rect, editing, actions, slide, item.id]);

  // While typing: the textarea is as tall as its text (never shorter than the stored box), so the box grows at once —
  // with every line, a wrap, a look change, the slide's zoom; the layer gets the height for the handles.
  const fit = useCallback(() => {
    const el = ref.current;
    const box = boxRef.current;
    const layer = box?.parentElement;
    if (!el || !box || !layer) return;
    const cs = getComputedStyle(box);
    const chrome = [cs.paddingTop, cs.paddingBottom, cs.borderTopWidth, cs.borderBottomWidth].reduce((sum, v) => sum + (Number.parseFloat(v) || 0), 0);
    const r = rectRef.current;
    let w = r.w;
    let natural: number | null = null;
    const copy = measureRef.current;
    if (autoRef.current && copy) {
      // As wide as its longest line (the copy does not wrap), up to the slide's right edge; a little room so the
      // textarea does not wrap a line that just fits. Stored is the text's own width (what the box shown is wide).
      const side = [cs.paddingLeft, cs.paddingRight, cs.borderLeftWidth, cs.borderRightWidth].reduce((sum, v) => sum + (Number.parseFloat(v) || 0), 0);
      const most = Math.max(0, (1 - r.x) * layer.clientWidth);
      const text = copy.getBoundingClientRect().width;
      box.style.width = `${Math.min(most, Math.ceil(text) + 2 + side)}px`;
      w = laidOutWidth(box, r) ?? r.w;
      natural = Math.min(1 - r.x, Math.max(0.02, Math.round(((text + side) / layer.clientWidth) * 1e4) / 1e4));
    }
    const least = Math.max(0, r.h * layer.clientHeight - chrome);
    el.style.height = '0px';
    const need = el.scrollHeight;
    el.style.height = `${Math.max(need, least)}px`;
    const h = laidOutHeight(el, box, r) ?? r.h;
    measured.current = h;
    measuredW.current = natural;
    onLiveSize(item.id, h > r.h + 0.002 || Math.abs(w - r.w) > 0.002 ? { w, h } : null);
  }, [rectRef, autoRef, onLiveSize, item.id]);
  useLayoutEffect(() => {
    if (editing) fit();
  }, [editing, fit, text, look, auto, rect.x, rect.w, rect.h]);
  useEffect(() => {
    const layer = boxRef.current?.parentElement;
    if (!editing || !layer || typeof ResizeObserver === 'undefined') return;
    // The slide's size (zoom, the pane): the font and the stored height are fractions of it.
    const ro = new ResizeObserver(() => fit());
    ro.observe(layer);
    return () => {
      ro.disconnect();
      onLiveSize(item.id, null);
    };
  }, [editing, fit, onLiveSize, item.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    // Typed on: a look control reached later with the keyboard does not send the focus back here.
    lookPress.current = null;
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
      e.preventDefault();
      commit(e.currentTarget.value);
    }
  };

  const cls = ['annot-text', `is-${item.color}`, selected && 'is-selected', editing && 'is-editing'].filter(Boolean).join(' ');
  const box = percentStyle(rect);
  // At least the stored height, growing with the content (a box laid out at another size never clips its text; while
  // typing the textarea sets the height). As wide as its text: up to the slide's right edge — while typing fit() sets
  // the width.
  const style: CSSProperties = auto
    ? { left: box.left, top: box.top, ...(editing ? {} : { width: 'max-content' }), maxWidth: `${((1 - rect.x) * 100).toFixed(3)}%`, minHeight: box.height, ...textBoxVars(item) }
    : { left: box.left, top: box.top, width: box.width, minHeight: box.height, ...textBoxVars(item) };
  return (
    <div ref={boxRef} className={cls} style={style} data-annot="item" data-id={item.id}>
      {editing && auto && (
        <span ref={measureRef} className="annot-text-measure" aria-hidden="true">
          {text || msg().viewer.textBox.placeholder}
        </span>
      )}
      {editing ? (
        <textarea
          ref={ref}
          className="annot-text-input"
          value={text}
          placeholder={msg().viewer.textBox.placeholder}
          aria-label={msg().viewer.textBox.label}
          onChange={(e) => {
            setText(e.target.value);
            typed.current = e.target.value;
            lookPress.current = null;
          }}
          onBlur={(e) => {
            // Into the menu's look controls (the size field, the font; a button pressed in WebKit, which focuses
            // nothing): the typing stays open, what was typed is kept already.
            const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
            if (to ? to.closest(TEXT_LOOK_CONTROLS) : lookPress.current) {
              save(e.currentTarget.value);
              return;
            }
            commit(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div ref={bodyRef} className="annot-text-body">
          {item.text || <span className="annot-text-empty">{msg().viewer.textBox.placeholder}</span>}
        </div>
      )}
    </div>
  );
}
