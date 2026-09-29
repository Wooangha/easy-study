// The annotation layer of one slide (DESIGN §25), inside the slide box over the image: an SVG for the highlights and
// shapes (a 0..1000 viewBox stretched over the image, so the stored 0..1 geometry maps directly), HTML for the
// text boxes (their font scales with the slide), the memo cards (UI-sized), the selection handles, the draft being
// drawn, and the question markers. The layer itself takes no pointer events; its interactive children do and carry
// `data-annot`, so the viewer's scroller knows what was pressed.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AnnotationItem, RegionRect, SlideAnnotations, TextItem } from '../../../../shared/types.ts';
import {
  ALL_HANDLES,
  bandHandles,
  capText,
  replayVisible,
  type AnnotationTool,
  type Handle,
} from '../../lib/annotations/geometry.ts';
import type { QuestionMarker } from '../../lib/annotations/markers.ts';
import { percentStyle, type Frame, type Point } from '../../lib/attachments.ts';
import { useLatest } from '../../hooks/useLatest.ts';
import { useLayerEnv } from './context.ts';
import { MemoCard } from './MemoCard.tsx';
import { QuestionMarkers } from './QuestionMarkers.tsx';

/** A shape being drawn on this slide (a dashed preview of what the release will make). */
export interface Draft {
  tool: AnnotationTool;
  rect: RegionRect;
  /** 텍스트 형광 with the slide's layout at hand: the word-fitted rects, one per line (`rect` is their union). */
  rects?: RegionRect[];
}

/** An item being moved or resized on this slide (drawn at the new place; one PATCH on pointer-up). */
export interface DragPreview {
  id: string;
  rect?: RegionRect;
  at?: Point;
}

interface AnnotationLayerProps {
  slide: number;
  frame: Frame;
  /** The slide's document (null while not loaded: only a draft can show). */
  doc: SlideAnnotations | null;
  markers: readonly QuestionMarker[] | null;
  selectedId: string | null;
  /** The text box / memo opened for editing. */
  editingId: string | null;
  draft: Draft | null;
  drag: DragPreview | null;
  tool: AnnotationTool;
  /** 그때 필기 재생: only items made by this moment of this recording show. */
  replay: { rid: string; t: number } | null;
}

const K = 1000;
const n = (v: number) => (v * K).toFixed(1);

export function AnnotationLayer({ slide, frame, doc, markers, selectedId, editingId, draft, drag, tool, replay }: AnnotationLayerProps) {
  const items = doc?.items ?? [];
  const rectOf = (item: AnnotationItem & { rect: RegionRect }) => (drag?.id === item.id && drag.rect ? drag.rect : item.rect);
  const shapes: AnnotationItem[] = [];
  const texts: TextItem[] = [];
  const memos: Extract<AnnotationItem, { type: 'memo' }>[] = [];
  for (const item of items) {
    if (!replayVisible(item, replay)) continue;
    if (item.type === 'text') texts.push(item);
    else if (item.type === 'memo') memos.push(item);
    else shapes.push(item);
  }
  const selected = selectedId ? (items.find((it) => it.id === selectedId) ?? null) : null;
  const handles = selected && selected.type !== 'memo' && selected.type !== 'textHighlight' ? handlesOf(selected, drag) : null;

  return (
    <div className={`annot-layer tool-${tool}`} style={percentStyle(frame)} data-annot-slide={slide}>
      <svg className="annot-svg" viewBox={`0 0 ${K} ${K}`} preserveAspectRatio="none" aria-hidden>
        {shapes.map((item) => {
          const cls = `annot-shape is-${item.color}${item.id === selectedId ? ' is-selected' : ''}`;
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
            default:
              return null;
          }
        })}
        {draft && draft.tool !== 'memo' && draft.tool !== 'text' && (
          <DraftShape draft={draft} />
        )}
      </svg>
      {texts.map((item) => (
        <TextBox key={item.id} slide={slide} item={item} rect={rectOf(item)} selected={item.id === selectedId} editing={item.id === editingId} />
      ))}
      {draft && draft.tool === 'text' && <div className="annot-text annot-draft" style={percentStyle(draft.rect)} aria-hidden />}
      {memos.map((item) => (
        <MemoCard key={item.id} slide={slide} item={item} selected={item.id === selectedId} editing={item.id === editingId} mode="inline" />
      ))}
      {handles && !drag && handles.map(({ handle, style }) => (
        <div key={handle} className={`annot-handle is-${handle}`} style={style} data-annot="handle" data-handle={handle} data-id={selected!.id} />
      ))}
      {markers && markers.length > 0 && <QuestionMarkers slide={slide} markers={markers} />}
    </div>
  );
}

function DraftShape({ draft }: { draft: Draft }) {
  const r = draft.rect;
  if (draft.tool === 'ellipse') {
    return <ellipse className="annot-draft-shape" cx={n(r.x + r.w / 2)} cy={n(r.y + r.h / 2)} rx={n(r.w / 2)} ry={n(r.h / 2)} />;
  }
  const cls = draft.tool === 'highlight' || draft.tool === 'textHighlight' ? 'annot-draft-shape is-band' : 'annot-draft-shape';
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
function handlesOf(item: AnnotationItem & { rect?: RegionRect }, drag: DragPreview | null): Array<{ handle: Handle; style: CSSProperties }> {
  if (!item.rect) return [];
  const r = drag?.id === item.id && drag.rect ? drag.rect : item.rect;
  const list = item.type === 'highlight' ? bandHandles(r) : ALL_HANDLES;
  return list.map((handle) => {
    const x = handle.includes('w') ? r.x : handle.includes('e') ? r.x + r.w : r.x + r.w / 2;
    const y = handle.includes('n') ? r.y : handle.includes('s') ? r.y + r.h : r.y + r.h / 2;
    return { handle, style: { left: `${(x * 100).toFixed(3)}%`, top: `${(y * 100).toFixed(3)}%` } };
  });
}

/**
 * A text box: typed text drawn on the slide; editing swaps in a textarea in the same box, committed on blur / Esc /
 * ⌘Enter — and when the box goes away while typing (the layer hidden, the slide filtered out, the lecture closed):
 * WebKit sends no blur to a textarea removed while focused.
 */
function TextBox({ slide, item, rect, selected, editing }: { slide: number; item: TextItem; rect: RegionRect; selected: boolean; editing: boolean }) {
  const { actions } = useLayerEnv();
  const [text, setText] = useState(item.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Typed but not committed yet. */
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (editing) setText(item.text);
  }, [editing, item.text]);
  useLayoutEffect(() => {
    if (editing) ref.current?.focus({ preventScroll: true });
  }, [editing]);

  const commit = (value: string) => {
    pending.current = null;
    const capped = capText(value);
    if (capped.trim() === '' && item.text.trim() === '') {
      // A box left empty (just made, or emptied): gone.
      actions.remove(slide, item.id);
      return;
    }
    const patch: { text?: string; rect?: RegionRect } = {};
    if (capped !== item.text) patch.text = capped;
    // The laid-out height becomes the box's height, so it looks the same on another device.
    const layer = boxRef.current?.parentElement;
    const el = ref.current;
    if (el && layer && layer.clientHeight > 0) {
      const h = Math.min(1 - rect.y, Math.max(0.02, Math.round((el.scrollHeight / layer.clientHeight) * 1e4) / 1e4));
      if (Math.abs(h - rect.h) > 0.002) patch.rect = { ...rect, h };
    }
    if (patch.text !== undefined || patch.rect) actions.update(slide, item.id, patch);
    actions.edit(slide, null);
  };
  const commitRef = useLatest(commit);
  // A layout effect: its cleanup runs while the textarea is still in the DOM (the height is measured).
  useLayoutEffect(() => {
    if (!editing) return;
    return () => {
      const value = pending.current;
      pending.current = null;
      if (value !== null) commitRef.current(value);
    };
  }, [editing, commitRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
      e.preventDefault();
      commit(e.currentTarget.value);
    }
  };

  const cls = ['annot-text', `is-${item.color}`, selected && 'is-selected', editing && 'is-editing'].filter(Boolean).join(' ');
  return (
    <div ref={boxRef} className={cls} style={percentStyle(rect)} data-annot="item" data-id={item.id}>
      {editing ? (
        <textarea
          ref={ref}
          className="annot-text-input"
          value={text}
          placeholder="텍스트…"
          aria-label="텍스트 상자"
          onChange={(e) => {
            setText(e.target.value);
            pending.current = e.target.value;
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="annot-text-body">{item.text || <span className="annot-text-empty">텍스트…</span>}</div>
      )}
    </div>
  );
}
