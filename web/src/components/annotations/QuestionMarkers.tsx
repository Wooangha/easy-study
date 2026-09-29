// 질문 표시 (DESIGN §25): a small 💬 pill at the top-right corner of where a question's region attachment was, kept
// inside the image, and — for a marker anchored to a region rather than to an item that is still drawn — the region
// itself, faint, so one sees which part was asked about (stronger while the tip is open or the pill hovered). Hover / focus shows the question's first line and time (several questions on one spot: the
// list); a click jumps to that Q&A; on touch the first tap shows the tip and the second jumps. The tip is floated in
// <body> (Floating, like a memo's link picker): the slide box clips its overflow, so a tip hung on a marker near the
// image's left or top edge would be cut. The tip's × (also a right-click) hides the marker — the Q&A itself stays.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { QuestionMarker } from '../../lib/annotations/markers.ts';
import { formatTime } from '../../lib/format.ts';
import { useLayerEnv } from './context.ts';
import { Floating } from './Floating.tsx';

interface QuestionMarkersProps {
  slide: number;
  markers: readonly QuestionMarker[];
}

const MAX_LISTED = 5;
const TIP_WIDTH = 240;
/** The pointer may cross the gap between the pill and the tip (or leave for a moment) this long. */
const TIP_LEAVE_MS = 200;
/** Rough height of the tip (Floating picks below / above with it): the padding and foot, one row per question. */
const tipHeight = (questions: number): number => 44 + 46 * Math.min(questions, MAX_LISTED) + (questions > MAX_LISTED ? 16 : 0);

export function QuestionMarkers({ slide, markers }: QuestionMarkersProps) {
  return (
    <>
      {markers.map((m) => (
        <Marker key={`${m.key.sessionId}:${m.key.messageId}:${m.key.attachmentId}`} slide={slide} marker={m} />
      ))}
    </>
  );
}

function Marker({ slide, marker }: { slide: number; marker: QuestionMarker }) {
  const { actions } = useLayerEnv();
  const [open, setOpen] = useState(false);
  const [pill, setPill] = useState<HTMLButtonElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef(0);
  const r = marker.rect;
  // The pill sits at the top-right corner, hanging outside the rect when there is room above; near the image's
  // edges it moves inside.
  const style: CSSProperties = {
    left: `${Math.min(r.x + r.w, 0.97) * 100}%`,
    top: `${Math.max(r.y, 0.03) * 100}%`,
  };

  /** Whether a node is the pill or inside the (portaled) tip. */
  const inside = useCallback(
    (node: EventTarget | null): boolean => node instanceof Node && (pill?.contains(node) === true || tipRef.current?.contains(node) === true),
    [pill],
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

  const [hovered, setHovered] = useState(false);
  const lit = open || hovered;
  return (
    <>
      {!marker.itemId && (
        <div
          className={lit ? 'qa-marker-region is-lit' : 'qa-marker-region'}
          style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
          aria-hidden
        />
      )}
      <div className={open ? 'qa-marker-wrap is-open' : 'qa-marker-wrap'} style={style} data-annot="marker">
      <button
        ref={setPill}
        type="button"
        className="qa-marker"
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
        onFocus={show}
        onBlur={(e) => {
          if (!inside(e.relatedTarget)) close();
        }}
        aria-label={`질문 ${marker.count}개: ${marker.label}`}
        title={marker.count > 1 ? `이 부분으로 물어본 질문 ${marker.count}개` : undefined}
      >
        💬{marker.count > 1 ? ` ${marker.count}` : ''}
      </button>
      {open && (
        <Floating
          ref={tipRef}
          anchor={pill}
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
          onBlur={(e) => {
            if (!inside(e.relatedTarget)) close();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close();
            pill?.focus({ preventScroll: true });
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
    </div>
    </>
  );
}
