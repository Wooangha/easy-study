// 질문 표시 (DESIGN §25). A question asked with a slide region leaves the region itself, faint (a light tint), with a
// thin color bar just outside its left edge and a small "Q" label (with the count when several questions share the
// region) left of the bar — the bar and the tint blend by multiply, so the slide's text under them stays readable.
// A question asked with a drawn item (형광펜, a box, a text box) leaves a small dot at the item's top-right corner (a
// number when several); a memo shows its dot in its own header (MemoCard; a static dot in the collapsed pill). The tint and the bar are drawn under the
// items (QuestionRegions, first in the layer); the labels and dots over them (QuestionMarkers, last), but under the
// memo cards, so a marker never covers a memo. Hover / focus on a label or dot shows the questions' first lines and
// times and lights the region; a click jumps to that Q&A; on touch the first tap shows the tip and the second jumps.
// Keyboard: focus shows the tip, ↓ moves into it, Esc closes it (and does not reopen it when focus returns).
// The tip is floated in <body> (Floating, like a memo's link picker): the slide box clips its overflow, so a tip hung
// on a marker near the image's left or top edge would be cut. The tip's × (also a right-click) hides the marker —
// the Q&A itself stays.
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { markerId, regionLabelPlace, type QuestionMarker } from '../../lib/annotations/markers.ts';
import { percentStyle, type Frame } from '../../lib/attachments.ts';
import { formatTime } from '../../lib/format.ts';
import { useLatest } from '../../hooks/useLatest.ts';
import { useLayerEnv } from './context.ts';
import { Floating } from './Floating.tsx';

const MAX_LISTED = 5;
const TIP_WIDTH = 240;
/** The pointer may cross the gap between the label and the tip (or leave for a moment) this long. */
const TIP_LEAVE_MS = 200;
/** Rough height of the tip (Floating picks below / above with it): the padding and foot, one row per question. */
const tipHeight = (questions: number): number => 44 + 46 * Math.min(questions, MAX_LISTED) + (questions > MAX_LISTED ? 16 : 0);
const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/** A marker turns lit (hovered, focused or its tip open) or unlit, by `markerId`. Several can be lit at once. */
export type LightMarker = (id: string, on: boolean) => void;

/** The regions of the region markers: a faint tint and the bar left of it. Drawn first, under the items. */
export function QuestionRegions({ markers, lit }: { markers: readonly QuestionMarker[]; lit: ReadonlySet<string> }) {
  return (
    <>
      {markers.map((m) => {
        if (m.itemId) return null;
        const id = markerId(m);
        const on = lit.has(id) ? ' is-lit' : '';
        const r = m.rect;
        return (
          <Fragment key={id}>
            <div className={`qa-region${on}`} style={percentStyle(r)} aria-hidden />
            <div className={`qa-region-bar${on}`} style={{ left: `max(0px, calc(${pct(r.x)} - 5px))`, top: pct(r.y), height: pct(r.h) }} aria-hidden />
          </Fragment>
        );
      })}
    </>
  );
}

interface QuestionMarkersProps {
  slide: number;
  markers: readonly QuestionMarker[];
  /** The image inside the slide box, and the box's aspect ratio: with the track's width, the image's size in px. */
  frame: Frame;
  aspect: number;
  /** Items whose dot is left out: the selected ones (their handles sit on the corner; the item menu shows the count). */
  skipItems: readonly string[] | null;
  onLit: LightMarker;
}

/** The labels of the region markers and the dots of the item markers (a memo's dot is on its card). */
export function QuestionMarkers({ slide, markers, frame, aspect, skipItems, onLit }: QuestionMarkersProps) {
  // Read here, not in the layer: the context changes with the focused slide, and only the markers need the width.
  const { trackWidth } = useLayerEnv();
  const size = { width: trackWidth * frame.w, height: (trackWidth / aspect) * frame.h };
  return (
    <>
      {markers.map((m) => {
        const id = markerId(m);
        const light = (on: boolean) => onLit(id, on);
        if (m.itemId) {
          if (m.itemType === 'memo' || skipItems?.includes(m.itemId)) return null;
          const style: CSSProperties = { left: pct(Math.min(m.rect.x + m.rect.w, 0.99)), top: pct(Math.max(m.rect.y, 0.01)) };
          return (
            <MarkerButton key={id} slide={slide} marker={m} className="qa-dot" style={style} onLit={light}>
              <QuestionDot count={m.count} />
            </MarkerButton>
          );
        }
        const r = m.rect;
        const place = regionLabelPlace(r, m.count, size.width, size.height);
        const style: CSSProperties =
          place === 'left'
            ? { left: `calc(${pct(r.x)} - 8px)`, top: pct(r.y) }
            : place === 'above'
              ? { left: `max(0px, calc(${pct(r.x)} - 5px))`, top: pct(r.y) }
              : { left: `calc(${pct(r.x)} + 4px)`, top: `calc(${pct(r.y)} + 3px)` };
        return (
          <MarkerButton key={id} slide={slide} marker={m} className={`qa-q is-${place}`} style={style} onLit={light}>
            Q{m.count > 1 && <span className="qa-q-n">{m.count}</span>}
          </MarkerButton>
        );
      })}
    </>
  );
}

/** The visible dot of an item marker: a small circle, or a number when several questions were asked with the item. */
export function QuestionDot({ count }: { count: number }) {
  return <span className={count > 1 ? 'qa-dot-mark has-count' : 'qa-dot-mark'}>{count > 1 ? count : null}</span>;
}

interface MarkerButtonProps {
  slide: number;
  marker: QuestionMarker;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
  /** Called with true while the marker is hovered, focused or its tip open, and false after. */
  onLit?: (on: boolean) => void;
}

/** A marker's button and its tip (the questions, 노트에서 보기, 이 표시 지우기). */
export function MarkerButton({ slide, marker, className, style, children, onLit }: MarkerButtonProps) {
  const { actions } = useLayerEnv();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef(0);
  /** Esc in the tip gives the focus back to the button: that focus must not open the tip again. */
  const refocusing = useRef(false);
  const lit = open || hovered;
  const onLitRef = useLatest(onLit);
  useEffect(() => {
    onLitRef.current?.(lit);
    return () => {
      if (lit) onLitRef.current?.(false);
    };
  }, [lit, onLitRef]);

  /** Whether a node is the button or inside the (portaled) tip. */
  const inside = useCallback(
    (node: EventTarget | null): boolean => node instanceof Node && (button?.contains(node) === true || tipRef.current?.contains(node) === true),
    [button],
  );
  const show = () => {
    window.clearTimeout(leaveTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setOpen(false), TIP_LEAVE_MS);
  };
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, inside]);

  const hide = () => actions.hideMarkers(slide, marker.questions.map((q) => q.key));

  return (
    <>
      <button
        ref={setButton}
        type="button"
        className={lit ? `${className} is-lit` : className}
        style={style}
        data-annot="marker"
        onClick={(e) => {
          // A touch: the first tap shows the tip, the second jumps.
          if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === 'touch' && !open) {
            setOpen(true);
            return;
          }
          actions.openQa(marker.sessionId, marker.messageId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          hide();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerEnter={(e) => {
          setHovered(true);
          if (e.pointerType !== 'touch') show();
        }}
        onPointerLeave={(e) => {
          setHovered(false);
          if (e.pointerType !== 'touch') hideSoon();
        }}
        onFocus={() => {
          if (refocusing.current) refocusing.current = false;
          else show();
        }}
        onBlur={(e) => {
          refocusing.current = false;
          if (!inside(e.relatedTarget)) close();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            close();
          } else if (e.key === 'ArrowDown' && open) {
            e.preventDefault();
            tipRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}
        aria-label={`질문 ${marker.count}개: ${marker.label}`}
        title={marker.count > 1 ? `이 부분으로 물어본 질문 ${marker.count}개` : undefined}
      >
        {children}
      </button>
      {open && (
        <Floating
          ref={tipRef}
          anchor={button}
          width={TIP_WIDTH}
          height={tipHeight(marker.questions.length)}
          className="qa-marker-tip"
          role="group"
          label="이 부분으로 물어본 질문"
          onScrollAway={close}
          onPointerEnter={(e) => {
            if (e.pointerType !== 'touch') show();
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== 'touch') hideSoon();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            if (!inside(e.relatedTarget)) close();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close();
            refocusing.current = true;
            button?.focus({ preventScroll: true });
          }}
        >
          {marker.questions.slice(0, MAX_LISTED).map((q) => (
            <button
              key={`${q.key.sessionId}:${q.key.messageId}:${q.key.attachmentId}`}
              type="button"
              className="qa-marker-q"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => actions.openQa(q.sessionId, q.messageId)}
              title="이 질문으로 이동"
            >
              <span className="qa-marker-q-text">{q.label}</span>
              <span className="qa-marker-q-time">{formatTime(q.createdAt)}</span>
            </button>
          ))}
          {marker.questions.length > MAX_LISTED && <div className="qa-marker-more muted">외 {marker.questions.length - MAX_LISTED}개</div>}
          <div className="qa-marker-tip-foot">
            <button type="button" className="ghost-btn tiny" onPointerDown={(e) => e.stopPropagation()} onClick={() => actions.openNotes(slide)}>
              노트에서 보기
            </button>
            <span className="spacer" />
            <button type="button" className="ghost-btn tiny" onPointerDown={(e) => e.stopPropagation()} onClick={hide} title="이 표시를 슬라이드에서 지워요 (질문과 답은 그대로예요)">
              ✕ 이 표시 지우기
            </button>
          </div>
        </Floating>
      )}
    </>
  );
}
