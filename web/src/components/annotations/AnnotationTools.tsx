// The annotation toolbar (DESIGN §25) in the viewer's toolbar: the default state 선택·첨부 (no drawing tool: a drag
// on empty area attaches that region to the next question, a click on an item selects it), 범위 선택 (a drag on
// empty area selects every item it crosses; Shift+click adds / removes one), 펜 and 지우개 (§29) and the drawing tools
// (형광펜 · 텍스트 형광 · 사각형 · 동그라미 · 텍스트 · 메모 — clicking the active one turns it off again), the four
// colors (under 펜: the ink colors and the three widths), 손가락으로도 쓰기 and 되돌리기 / 다시 실행 under 펜 / 지우개
// (a tablet has no ⌘Z), and the ⋯ 필기 menu (필기 보기/숨기기, 표시 있는 슬라이드만, a tag filter, 질문 표시 보기, 그때
// 필기 재생). When the toolbar has no room for them (measured: foldTools) the tools and colors fold into one button
// showing the active tool and color, so the toolbar keeps one row.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, Mic } from 'lucide-react';
import { ANNOTATION_COLORS, INK_COLORS, INK_WIDTHS, type AnnotationColor } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';
import { ANNOTATION_TOOLS, CLICK_TOOLS, isInkTool, type AnnotationTool } from '../../lib/annotations/geometry.ts';
import { FingerIcon, ToolIcon, UndoIcon } from './icons.tsx';

export interface SlideFilter {
  /** 표시 있는 슬라이드만. */
  onlyAnnotated: boolean;
  /** Only slides with a memo carrying this tag (implies onlyAnnotated). */
  tag: string | null;
}

export const NO_FILTER: SlideFilter = { onlyAnnotated: false, tag: null };

/** The one-line hint of the viewer's toolbar for the state (hidden on narrow panes; the titles say the same). */
export function toolHint(tool: AnnotationTool, fingerInk = false): string {
  const m = msg().viewer.tools;
  if (tool === 'select') return m.hintSelect;
  if (tool === 'marquee') return m.hintMarquee;
  if (tool === 'pen') return m.hintPen(fingerInk);
  if (tool === 'eraser') return m.hintEraser;
  return m.hintDraw(m.labels[tool], CLICK_TOOLS.has(tool));
}

/**
 * The three 펜 widths (INK_WIDTHS: 가늘게 · 보통 · 굵게) as chips, each showing a line of its width; with `labels`
 * (the folded popover) their names too. The toolbar's and the item menu's.
 */
export function InkWidthChips({ value, onChange, disabled = false, labels = false }: { value: number | null; onChange: (width: number) => void; disabled?: boolean; labels?: boolean }) {
  const m = msg().viewer.tools;
  return (
    <span className="annot-width-chips" role="group" aria-label={m.inkWidthGroup}>
      {INK_WIDTHS.map((w, i) => (
        <button
          key={w}
          type="button"
          className={`annot-width-chip${w === value ? ' is-active' : ''}`}
          aria-pressed={w === value}
          aria-label={m.inkWidths[i]}
          title={m.inkWidthTitle(m.inkWidths[i])}
          disabled={disabled}
          onClick={() => onChange(w)}
        >
          <span className="annot-width-line" style={{ height: `${Math.max(1, Math.round(w * 560))}px` }} aria-hidden />
          {labels && <span className="annot-tool-label">{m.inkWidths[i]}</span>}
        </button>
      ))}
    </span>
  );
}

/**
 * Whether the toolbar's tools are folded into one button (measured from the real toolbar, DESIGN §29: under 펜 it
 * holds more than under the other tools, in another language other words): `need` = the width the wide toolbar
 * needed when it last did not fit, 0 when unknown.
 */
export interface ToolsFold {
  fold: boolean;
  need: number;
}

/** The wide toolbar comes back only with this much more room than it needed (no flapping at the edge). */
export const TOOLS_FOLD_SLACK_PX = 24;

/**
 * The next fold from a measurement of the toolbar: its `width`, and how far its last item ends past its content box
 * (`overflow`; of the wide toolbar when `state.fold` is false). Wide: it folds when its items do not fit, remembering
 * the width they needed. Folded: it tries the wide toolbar again once the toolbar is TOOLS_FOLD_SLACK_PX wider than
 * that — or right away when what it holds changed (`need` 0) — and folds again at the next measurement if it still
 * does not fit (measured in a layout effect: nothing is painted in between).
 */
export function foldTools(state: ToolsFold, measured: { width: number; overflow: number }): ToolsFold {
  if (!state.fold) return measured.overflow > 0.5 ? { fold: true, need: Math.ceil(measured.width + measured.overflow) } : state;
  return measured.width >= state.need + TOOLS_FOLD_SLACK_PX ? { fold: false, need: state.need } : state;
}

/** 되돌리기 / 다시 실행 (the viewer's undo / redo of the annotation history): shown under 펜 / 지우개. */
export interface ToolsHistory {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

interface AnnotationToolsProps {
  tool: AnnotationTool;
  onTool: (tool: AnnotationTool) => void;
  color: AnnotationColor;
  onColor: (color: AnnotationColor) => void;
  layerShown: boolean;
  onLayerShown: (on: boolean) => void;
  markersShown: boolean;
  onMarkersShown: (on: boolean) => void;
  filter: SlideFilter;
  onFilter: (filter: SlideFilter) => void;
  /** This lecture's tags (the summary's), for the tag filter. */
  tags: ReadonlyArray<{ tag: string; count: number }>;
  /** Slides shown / of the deck while a filter is on (null = every slide). */
  shownCount: number | null;
  pageCount: number;
  /** A recording of this lecture is selected in the 녹음 tab: 그때 필기 재생 can be turned on. */
  replayAvailable: boolean;
  replayOn: boolean;
  onReplayOn: (on: boolean) => void;
  /** Replaying right now (the badge). */
  replaying: boolean;
  /** Fold the tools into one button (a narrow pane). */
  compact: boolean;
  /** 펜 (DESIGN §29): the color (INK_COLORS) and width (INK_WIDTHS) of new strokes, and 손가락으로도 쓰기. */
  inkColor: AnnotationColor;
  onInkColor: (color: AnnotationColor) => void;
  inkWidth: number;
  onInkWidth: (width: number) => void;
  fingerInk: boolean;
  onFingerInk: (on: boolean) => void;
  /** 되돌리기 / 다시 실행 under 펜 / 지우개 (none without it). */
  history?: ToolsHistory;
}

export function AnnotationTools(props: AnnotationToolsProps) {
  const { tool, onTool, color, onColor, layerShown, onLayerShown, markersShown, onMarkersShown, filter, onFilter, tags, shownCount, pageCount } = props;
  const { replayAvailable, replayOn, onReplayOn, replaying, compact, inkColor, onInkColor, inkWidth, onInkWidth, fingerInk, onFingerInk, history } = props;
  const disabled = !layerShown;
  // Under 펜 the dots are the ink colors and the widths follow; 손가락으로도 쓰기 under 펜 and 지우개.
  const pen = tool === 'pen';
  const shownColor = pen ? inkColor : color;
  const m = msg().viewer;
  const labels = m.tools.labels;
  const colorNames = m.colorNames;
  const menu = m.layerMenu;

  // The default state is a quiet "raised" segment, a drawing tool the accent: at a glance, is something being drawn?
  const tools = (vertical: boolean) => (
    <div className={vertical ? 'annot-tools is-vertical' : 'annot-tools'} role="group" aria-label={m.tools.group}>
      {ANNOTATION_TOOLS.map((t) => (
        <button
          key={t}
          type="button"
          className={['annot-tool', t === 'select' && 'is-default', t === tool && 'is-active'].filter(Boolean).join(' ')}
          aria-pressed={t === tool}
          disabled={disabled && t !== 'select'}
          onClick={() => onTool(t === tool ? 'select' : t)}
          title={disabled && t !== 'select' ? m.tools.hiddenTitle : m.tools.titles[t]}
        >
          <span className="annot-tool-icon" aria-hidden>
            <ToolIcon tool={t} />
          </span>
          {vertical && <span className="annot-tool-label">{labels[t]}</span>}
        </button>
      ))}
    </div>
  );

  const dots = (
    <span className="annot-color-dots" role="group" aria-label={pen ? m.tools.inkColorGroup : m.tools.colorGroup}>
      {(pen ? INK_COLORS : ANNOTATION_COLORS).map((c) => (
        <button
          key={c}
          type="button"
          className={`annot-dot${pen ? ' is-ink' : ''} is-${c}${c === shownColor ? ' is-active' : ''}`}
          aria-pressed={c === shownColor}
          disabled={disabled}
          onClick={() => (pen ? onInkColor(c) : onColor(c))}
          aria-label={colorNames[c]}
          title={pen ? m.tools.inkColorTitle(colorNames[c]) : m.tools.colorTitle(colorNames[c])}
        />
      ))}
    </span>
  );

  const finger = (vertical: boolean) => (
    <button
      type="button"
      className={`annot-tool annot-finger${fingerInk ? ' is-active' : ''}`}
      aria-pressed={fingerInk}
      aria-label={m.tools.fingerInk}
      disabled={disabled}
      onClick={() => onFingerInk(!fingerInk)}
      title={m.tools.fingerInkTitle(fingerInk)}
    >
      <span className="annot-tool-icon" aria-hidden>
        <FingerIcon />
      </span>
      {vertical && <span className="annot-tool-label">{m.tools.fingerInk}</span>}
    </button>
  );
  // A tablet has no keyboard for ⌘Z: under 펜 / 지우개 the last strokes are undone (and redone) here.
  const undoButton = (redo: boolean, vertical: boolean) => {
    const label = redo ? m.tools.redo : m.tools.undo;
    return (
      <button
        type="button"
        className="annot-tool annot-undo"
        aria-label={label}
        disabled={disabled || !(redo ? history?.canRedo : history?.canUndo)}
        onClick={redo ? history?.onRedo : history?.onUndo}
        title={redo ? m.tools.redoTitle : m.tools.undoTitle}
      >
        <span className="annot-tool-icon" aria-hidden>
          <UndoIcon redo={redo} />
        </span>
        {vertical && <span className="annot-tool-label">{label}</span>}
      </button>
    );
  };
  const inkOptions = (vertical: boolean) => (
    <>
      {pen && <InkWidthChips value={inkWidth} onChange={onInkWidth} disabled={disabled} />}
      {isInkTool(tool) && finger(vertical)}
      {isInkTool(tool) && history && (
        <span className={vertical ? 'annot-history is-vertical' : 'annot-history'} role="group" aria-label={m.tools.historyGroup}>
          {undoButton(false, vertical)}
          {undoButton(true, vertical)}
        </span>
      )}
    </>
  );

  const filterOn = filter.onlyAnnotated || filter.tag !== null;

  return (
    <>
      {compact ? (
        <ToolPopover
          className={tool === 'select' ? 'annot-tools-compact' : 'annot-tools-compact is-drawing'}
          label={m.tools.group}
          button={
            <>
              <span className="annot-tool-icon" aria-hidden>
                <ToolIcon tool={tool} />
              </span>
              <span className={`annot-dot${pen ? ' is-ink' : ''} is-${shownColor} is-mini`} aria-hidden />
            </>
          }
          title={m.tools.compactTitle(labels[tool], colorNames[shownColor])}
        >
          {tools(true)}
          {tool !== 'eraser' && <div className="annot-pop-dots">{dots}</div>}
          {isInkTool(tool) && <div className="annot-pop-ink">{inkOptions(true)}</div>}
        </ToolPopover>
      ) : (
        <>
          {tools(false)}
          {tool !== 'eraser' && dots}
          {inkOptions(false)}
        </>
      )}
      <ToolPopover
        className={filterOn || !layerShown ? 'annot-menu-btn is-active' : 'annot-menu-btn'}
        label={menu.label}
        button={
          <>
            <Ellipsis />
            <span className="annot-menu-text">{layerShown ? menu.button : menu.buttonHidden}</span>
          </>
        }
        title={menu.title}
      >
        <label className="annot-menu-row">
          <input type="checkbox" checked={layerShown} onChange={(e) => onLayerShown(e.target.checked)} />
          <span>{menu.showLayer}</span>
        </label>
        <label className="annot-menu-row">
          <input type="checkbox" checked={filter.onlyAnnotated || filter.tag !== null} onChange={(e) => onFilter({ onlyAnnotated: e.target.checked, tag: e.target.checked ? filter.tag : null })} />
          <span>{menu.onlyMarked}</span>
        </label>
        <label className="annot-menu-row">
          <span>{menu.tag}</span>
          <select
            className="picker small"
            value={filter.tag ?? ''}
            onChange={(e) => {
              const tag = e.target.value || null;
              onFilter({ onlyAnnotated: tag !== null || filter.onlyAnnotated, tag });
            }}
            aria-label={menu.tagFilter}
          >
            <option value="">{menu.allTags}</option>
            {tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                #{t.tag} ({t.count})
              </option>
            ))}
          </select>
        </label>
        <label className="annot-menu-row">
          <input type="checkbox" checked={markersShown} onChange={(e) => onMarkersShown(e.target.checked)} />
          <span>{menu.showMarkers}</span>
        </label>
        {replayAvailable && (
          <label className="annot-menu-row" title={menu.replayTitle}>
            <input type="checkbox" checked={replayOn} onChange={(e) => onReplayOn(e.target.checked)} />
            <span>{menu.replay}</span>
          </label>
        )}
        {filterOn && shownCount !== null && (
          <div className="annot-menu-note">
            {menu.shownCount(shownCount, pageCount)}
            <button type="button" className="ghost-btn tiny" onClick={() => onFilter(NO_FILTER)}>
              {menu.showAll}
            </button>
          </div>
        )}
      </ToolPopover>
      {filterOn && shownCount !== null && (
        <span className="annot-shown-count" title={menu.shownCountTitle}>
          {menu.shownCount(shownCount, pageCount)}
        </span>
      )}
      {replaying && (
        <span className="annot-replay-badge" title={menu.replayingTitle}>
          <Mic /> {menu.replaying}
        </span>
      )}
    </>
  );
}

/**
 * A button with a small panel under it (checkboxes, a select, a tool list); Esc or a press outside closes it. The
 * panel is moved left as far as it would pass the toolbar's right edge (the toolbar clips what overflows it).
 */
function ToolPopover({ className, label, title, button, children }: { className: string; label: string; title?: string; button: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!open || !pop) return;
    pop.style.left = '';
    const bound = pop.closest('.viewer-toolbar')?.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    const over = bound ? r.right - bound.right : 0;
    if (bound && over > 0) pop.style.left = `${-Math.max(0, Math.min(over, r.left - bound.left))}px`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <span ref={wrapRef} className="annot-pop-wrap">
      <button
        type="button"
        className={`${className} annot-pop-btn${open ? ' is-open' : ''}`}
        aria-label={label}
        title={title ?? label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open && (
        <div ref={popRef} id={id} className="annot-pop" role="group" aria-label={label}>
          {children}
        </div>
      )}
    </span>
  );
}

/** Whether a media query matches (re-rendering when it changes). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
