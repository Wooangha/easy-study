// The annotation toolbar (DESIGN §25) in the viewer's toolbar: the default state 선택·첨부 (no drawing tool: a drag
// on empty area attaches that region to the next question, a click on an item selects it), 범위 선택 (a drag on
// empty area selects every item it crosses; Shift+click adds / removes one) and the drawing tools
// (형광펜 · 텍스트 형광 · 사각형 · 동그라미 · 텍스트 · 메모 — clicking the active one turns it off again), the four
// colors, and the ⋯ 필기 menu (필기 보기/숨기기, 표시 있는 슬라이드만, a tag filter, 질문 표시 보기, 그때 필기 재생). On a
// narrow pane the tools and colors fold into one button showing the active tool and color, so the toolbar keeps one row.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, Mic } from 'lucide-react';
import { ANNOTATION_COLORS, type AnnotationColor } from '../../../../shared/types.ts';
import { ANNOTATION_TOOLS, CLICK_TOOLS, type AnnotationTool } from '../../lib/annotations/geometry.ts';
import { ToolIcon } from './icons.tsx';
import { COLOR_NAMES } from './ItemMenu.tsx';

export interface SlideFilter {
  /** 표시 있는 슬라이드만. */
  onlyAnnotated: boolean;
  /** Only slides with a memo carrying this tag (implies onlyAnnotated). */
  tag: string | null;
}

export const NO_FILTER: SlideFilter = { onlyAnnotated: false, tag: null };

export const TOOL_LABELS: Record<AnnotationTool, string> = {
  select: '선택·첨부',
  marquee: '범위 선택',
  highlight: '형광펜',
  textHighlight: '텍스트 형광',
  rect: '사각형',
  ellipse: '동그라미',
  text: '텍스트',
  memo: '메모',
};

const OFF_HINT = '(다시 누르거나 Esc로 끔)';

const TOOL_TITLES: Record<AnnotationTool, string> = {
  select: '선택·첨부: 필기를 클릭해 옮기거나 지우고, 빈 곳을 끌면 그 영역을 질문에 첨부해요',
  marquee: `범위 선택: 빈 곳에서 끌어 여러 필기를 한꺼번에 골라요 · Shift+클릭으로 더하고 빼요 ${OFF_HINT}`,
  highlight: `형광펜: 글줄 위에서 끌면 그 줄에 맞춰 칠해요 ${OFF_HINT}`,
  textHighlight: `텍스트 형광: 글자 위에서 끌면 단어에 맞춰 칠하고, 칠한 글 위를 다시 끌면 범위가 바뀌어요 ${OFF_HINT}`,
  rect: `사각형: 끌어서 그려요 ${OFF_HINT}`,
  ellipse: `동그라미: 끌어서 그려요 ${OFF_HINT}`,
  text: `텍스트 상자: 클릭하거나 끌어서 만들고 글을 써요 ${OFF_HINT}`,
  memo: `메모: 클릭한 자리에 스티커 메모를 붙여요 ${OFF_HINT}`,
};

/** The one-line hint of the viewer's toolbar for the state (hidden on narrow panes; the titles say the same). */
export function toolHint(tool: AnnotationTool): string {
  if (tool === 'select') return 'j/k · ↑/↓ · 빈 곳을 끌면 영역 첨부';
  if (tool === 'marquee') return '범위 선택: 빈 곳에서 끌어 여러 개 고르기 · Shift+클릭 더하기·빼기 · Esc';
  return `${TOOL_LABELS[tool]}: 빈 곳에서 ${CLICK_TOOLS.has(tool) ? '클릭' : '끌기'} · 필기는 클릭해 옮기기 · Esc`;
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

  // The default state is a quiet "raised" segment, a drawing tool the accent: at a glance, is something being drawn?
  const tools = (vertical: boolean) => (
    <div className={vertical ? 'annot-tools is-vertical' : 'annot-tools'} role="group" aria-label="필기 도구">
      {ANNOTATION_TOOLS.map((t) => (
        <button
          key={t}
          type="button"
          className={['annot-tool', t === 'select' && 'is-default', t === tool && 'is-active'].filter(Boolean).join(' ')}
          aria-pressed={t === tool}
          disabled={disabled && t !== 'select'}
          onClick={() => onTool(t === tool ? 'select' : t)}
          title={disabled && t !== 'select' ? '필기가 숨겨져 있어요 (⋯ 필기 메뉴에서 보이기)' : TOOL_TITLES[t]}
        >
          <span className="annot-tool-icon" aria-hidden>
            <ToolIcon tool={t} />
          </span>
          {vertical && <span className="annot-tool-label">{TOOL_LABELS[t]}</span>}
        </button>
      ))}
    </div>
  );

  const dots = (
    <span className="annot-color-dots" role="group" aria-label="새 필기의 색">
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`annot-dot is-${c}${c === color ? ' is-active' : ''}`}
          aria-pressed={c === color}
          disabled={disabled}
          onClick={() => onColor(c)}
          aria-label={COLOR_NAMES[c]}
          title={`새 필기의 색: ${COLOR_NAMES[c]}`}
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
          label="필기 도구"
          button={
            <>
              <span className="annot-tool-icon" aria-hidden>
                <ToolIcon tool={tool} />
              </span>
              <span className={`annot-dot is-${color} is-mini`} aria-hidden />
            </>
          }
          title={`필기 도구: ${TOOL_LABELS[tool]} · ${COLOR_NAMES[color]}`}
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
        label="필기 메뉴"
        button={
          <>
            <Ellipsis />
            <span className="annot-menu-text">{layerShown ? '필기' : '필기 숨김'}</span>
          </>
        }
        title="필기 보기/숨기기 · 표시 있는 슬라이드만 · 태그 · 질문 표시 · 그때 필기 재생"
      >
        <label className="annot-menu-row">
          <input type="checkbox" checked={layerShown} onChange={(e) => onLayerShown(e.target.checked)} />
          <span>필기 보기</span>
        </label>
        <label className="annot-menu-row">
          <input type="checkbox" checked={filter.onlyAnnotated || filter.tag !== null} onChange={(e) => onFilter({ onlyAnnotated: e.target.checked, tag: e.target.checked ? filter.tag : null })} />
          <span>표시 있는 슬라이드만</span>
        </label>
        <label className="annot-menu-row">
          <span>태그</span>
          <select
            className="picker small"
            value={filter.tag ?? ''}
            onChange={(e) => {
              const tag = e.target.value || null;
              onFilter({ onlyAnnotated: tag !== null || filter.onlyAnnotated, tag });
            }}
            aria-label="태그로 슬라이드 거르기"
          >
            <option value="">모든 태그</option>
            {tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                #{t.tag} ({t.count})
              </option>
            ))}
          </select>
        </label>
        <label className="annot-menu-row">
          <input type="checkbox" checked={markersShown} onChange={(e) => onMarkersShown(e.target.checked)} />
          <span>질문 표시 보기</span>
        </label>
        {replayAvailable && (
          <label className="annot-menu-row" title="녹음 탭에서 재생하는 동안, 그때까지 쓴 필기만 보여요">
            <input type="checkbox" checked={replayOn} onChange={(e) => onReplayOn(e.target.checked)} />
            <span>그때 필기 재생</span>
          </label>
        )}
        {filterOn && shownCount !== null && (
          <div className="annot-menu-note">
            표시 {shownCount}/{pageCount}
            <button type="button" className="ghost-btn tiny" onClick={() => onFilter(NO_FILTER)}>
              모두 보기
            </button>
          </div>
        )}
      </ToolPopover>
      {filterOn && shownCount !== null && (
        <span className="annot-shown-count" title="표시 있는 슬라이드만 보는 중 (⋯ 필기 메뉴에서 해제)">
          표시 {shownCount}/{pageCount}
        </span>
      )}
      {replaying && (
        <span className="annot-replay-badge" title="녹음 탭의 재생 위치까지 쓴 필기만 보여요 (⋯ 필기 메뉴에서 끌 수 있어요)">
          <Mic /> 그때 필기 재생 중
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
