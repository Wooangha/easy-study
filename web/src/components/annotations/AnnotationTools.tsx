// The annotation toolbar (DESIGN §25) in the viewer's toolbar: the default state 선택·첨부 (no drawing tool: a drag
// on empty area attaches that region to the next question, a click on an item selects it), 범위 선택 (a drag on
// empty area selects every item it crosses; Shift+click adds / removes one) and the drawing tools
// (형광펜 · 텍스트 형광 · 사각형 · 동그라미 · 텍스트 · 메모 — clicking the active one turns it off again), the four
// colors, and the ⋯ 필기 menu (필기 보기/숨기기, 표시 있는 슬라이드만, a tag filter, 질문 표시 보기, 그때 필기 재생). On a
// narrow pane the tools and colors fold into one button showing the active tool and color, so the toolbar keeps one row.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, Mic } from 'lucide-react';
import { ANNOTATION_COLORS, type AnnotationColor } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';
import { ANNOTATION_TOOLS, CLICK_TOOLS, type AnnotationTool } from '../../lib/annotations/geometry.ts';
import { ToolIcon } from './icons.tsx';

export interface SlideFilter {
  /** 표시 있는 슬라이드만. */
  onlyAnnotated: boolean;
  /** Only slides with a memo carrying this tag (implies onlyAnnotated). */
  tag: string | null;
}

export const NO_FILTER: SlideFilter = { onlyAnnotated: false, tag: null };

/** The one-line hint of the viewer's toolbar for the state (hidden on narrow panes; the titles say the same). */
export function toolHint(tool: AnnotationTool): string {
  const m = msg().viewer.tools;
  if (tool === 'select') return m.hintSelect;
  if (tool === 'marquee') return m.hintMarquee;
  return m.hintDraw(m.labels[tool], CLICK_TOOLS.has(tool));
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
}

export function AnnotationTools(props: AnnotationToolsProps) {
  const { tool, onTool, color, onColor, layerShown, onLayerShown, markersShown, onMarkersShown, filter, onFilter, tags, shownCount, pageCount } = props;
  const { replayAvailable, replayOn, onReplayOn, replaying, compact } = props;
  const disabled = !layerShown;
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
    <span className="annot-color-dots" role="group" aria-label={m.tools.colorGroup}>
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`annot-dot is-${c}${c === color ? ' is-active' : ''}`}
          aria-pressed={c === color}
          disabled={disabled}
          onClick={() => onColor(c)}
          aria-label={colorNames[c]}
          title={m.tools.colorTitle(colorNames[c])}
        />
      ))}
    </span>
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
              <span className={`annot-dot is-${color} is-mini`} aria-hidden />
            </>
          }
          title={m.tools.compactTitle(labels[tool], colorNames[color])}
        >
          {tools(true)}
          <div className="annot-pop-dots">{dots}</div>
        </ToolPopover>
      ) : (
        <>
          {tools(false)}
          {dots}
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

/** A button with a small panel under it (checkboxes, a select, a tool list); Esc or a press outside closes it. */
function ToolPopover({ className, label, title, button, children }: { className: string; label: string; title?: string; button: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const id = useId();
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
        <div id={id} className="annot-pop" role="group" aria-label={label}>
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
