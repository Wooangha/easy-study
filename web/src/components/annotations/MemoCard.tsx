// A sticky memo on a slide (DESIGN §25): UI-sized (not scaled with the slide), dragged by its header, collapsible
// to a pill, free text (debounced 600 ms, committed at once on blur / ⌘Enter / when the card goes away), tags with autocomplete, links to a
// slide, another lecture or a recording moment (chips that navigate), and the eye toggle of "튜터에게 보이기". On a
// narrow pane or a touch screen the memo stays a pill and expands in the bottom sheet (`mode: 'sheet'`). Its text
// is rendered as plain text only, in the memo's own text size when one is set (a fraction of the slide height, like
// a text box; UI-sized 13 px otherwise). As part of a group selection (`group`) the card does not drag itself: the
// press goes through to the viewer, which moves every selected item together.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { MemoItem, MemoLink } from '../../../../shared/types.ts';
import { capText, memoPreview, movePoint, withLink } from '../../lib/annotations/geometry.ts';
import { memoFontSize, memoSheetFontSize } from '../../lib/annotations/text.ts';
import { movedBeyond, type Point } from '../../lib/attachments.ts';
import { formatClock } from '../../lib/recording/timeline.ts';
import { usePlayhead } from '../../lib/recording/playhead.ts';
import { toast } from '../../lib/toast.ts';
import { PopoverMenu, type MenuSection } from '../organize/PopoverMenu.tsx';
import { useLayerEnv } from './context.ts';
import { EyeIcon } from './icons.tsx';
import { LinkPicker } from './LinkPicker.tsx';
import { TagInput } from './TagInput.tsx';

/** Typing pauses this long before the text is saved (blur / ⌘Enter save at once). */
export const TEXT_DEBOUNCE_MS = 600;
/** A press on the header that moves this far drags the memo (less is a click). */
const DRAG_SLOP_PX = 4;
const MAX_TEXTAREA_PX = 220;

interface MemoCardProps {
  slide: number;
  item: MemoItem;
  selected: boolean;
  /** Opened for editing just now (the textarea takes the focus). */
  editing: boolean;
  /** 'inline' on the slide (positioned, draggable); 'sheet' in the bottom sheet (the editor only). */
  mode: 'inline' | 'sheet';
  /** Part of a multi-selection: presses on the card go to the viewer (a drag moves the whole group). */
  group?: boolean;
}

export function MemoCard({ slide, item, selected, editing, mode, group = false }: MemoCardProps) {
  const { actions, compact, docs, docId, tags: lectureTags, trackWidth } = useLayerEnv();
  const inline = mode === 'inline';
  // Narrow panes / touch: the inline card is always the pill; the sheet is the editor.
  const collapsed = inline && (item.collapsed || compact);

  // ---- dragging by the header (inline) ---------------------------------------------------------------------------
  const [dragAt, setDragAt] = useState<Point | null>(null);
  const drag = useRef<{ pointerId: number; start: Point; startAt: Point; layer: DOMRect; moved: boolean; frame: number } | null>(null);
  const endDrag = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    setDragAt(null);
    if (commit && d.moved && dragAt) actions.update(slide, item.id, { at: dragAt });
  };
  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!inline || group || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target as Element;
    // A control inside the header (⋯, ▾) keeps its click; the collapsed pill is itself a button and does drag.
    const control = target.closest('button, input, select, textarea, a');
    if (control && control !== e.currentTarget) return;
    const layer = e.currentTarget.closest<HTMLElement>('.annot-layer')?.getBoundingClientRect();
    if (!layer || layer.width <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, startAt: item.at, layer, moved: false, frame: 0 };
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const client = { x: e.clientX, y: e.clientY };
    if (!d.moved) {
      if (!movedBeyond(d.start, client, DRAG_SLOP_PX)) return;
      d.moved = true;
    }
    e.preventDefault();
    cancelAnimationFrame(d.frame);
    d.frame = requestAnimationFrame(() => {
      if (drag.current !== d) return;
      setDragAt(movePoint(d.startAt, (client.x - d.start.x) / d.layer.width, (client.y - d.start.y) / d.layer.height));
    });
  };
  const onHeaderPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const moved = d.moved;
    endDrag(true);
    if (!moved && collapsed) {
      // A tap / click on the pill: expand (inline), or open the sheet on a narrow pane.
      if (compact) actions.openSheet(slide, item.id);
      else actions.update(slide, item.id, { collapsed: false });
    }
  };
  useEffect(() => () => cancelAnimationFrame(drag.current?.frame ?? 0), []);

  // ---- the text -----------------------------------------------------------------------------------------------------
  const [text, setText] = useState(item.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusedRef = useRef(false);
  const timer = useRef(0);
  const lastSent = useRef(item.text);
  /** Text typed but not saved yet (the debounce is running). */
  const pending = useRef<string | null>(null);
  // Another device's edit (or the server's normalised form) while not typing here.
  useEffect(() => {
    if (!focusedRef.current && item.text !== lastSent.current) {
      lastSent.current = item.text;
      setText(item.text);
    }
  }, [item.text]);
  const flush = useCallback(
    (value: string) => {
      window.clearTimeout(timer.current);
      pending.current = null;
      const capped = capText(value);
      if (capped === lastSent.current) return;
      lastSent.current = capped;
      actions.update(slide, item.id, { text: capped });
    },
    [actions, slide, item.id],
  );
  // The card goes away while the debounce runs (the sheet closed by a tap on its backdrop, the layer hidden, the slide
  // filtered out, the sheet shown another memo): the text is saved, not dropped. WebKit sends no blur to a textarea
  // removed while focused, so the blur cannot be relied on; a layout effect, so it runs before the DOM (and the
  // store) are gone.
  useLayoutEffect(
    () => () => {
      if (pending.current !== null) flush(pending.current);
      else window.clearTimeout(timer.current);
    },
    [flush],
  );
  // The textarea fits its text: measured again when the text, the card's state or the rendered font changes — the
  // memo's own size is a fraction of the slide height, so the zoom / the pane (`trackWidth`, the viewer's `--track-w`
  // that the font is computed from; a layout effect, so it runs once the new width is in the DOM) change it too.
  const fontSize = inline ? memoFontSize(item) : memoSheetFontSize(item);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text, collapsed, fontSize, trackWidth]);
  useEffect(() => {
    if (editing && !collapsed) textareaRef.current?.focus({ preventScroll: true });
  }, [editing, collapsed]);
  const onTextKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
      e.preventDefault();
      e.stopPropagation();
      flush(e.currentTarget.value);
      e.currentTarget.blur();
    }
  };

  // ---- links ------------------------------------------------------------------------------------------------------
  const [linking, setLinking] = useState(false);
  const [linkButton, setLinkButton] = useState<HTMLButtonElement | null>(null);
  const closeLinking = useCallback(() => setLinking(false), []);
  const playhead = usePlayhead();
  const addLink = (link: MemoLink) => {
    const links = withLink(item.links, link);
    if (!links) {
      toast('메모 하나에는 연결을 8개까지 넣을 수 있어요', 'error');
      return;
    }
    if (links.length !== item.links.length) actions.update(slide, item.id, { links });
  };
  const removeLink = (index: number) => actions.update(slide, item.id, { links: item.links.filter((_, i) => i !== index) });
  const linkLabel = (link: MemoLink): { text: string; title: string; go: (() => void) | null } => {
    switch (link.kind) {
      case 'slide':
        return { text: `p.${link.slide}`, title: `슬라이드 ${link.slide}로 이동`, go: () => actions.goToSlide(link.slide) };
      case 'doc': {
        const target = docs?.find((d) => d.id === link.docId);
        const title = target ? target.title : docs ? '지워진 강의' : '…';
        const page = link.slide ? ` · p.${link.slide}` : '';
        return {
          text: `📘 ${title}${page}`,
          title: target ? `‘${target.title}’ 열기${page}` : '이 강의는 지워졌어요',
          go: target ? () => actions.openDoc(link.docId, link.slide) : null,
        };
      }
      case 'recording':
        return { text: `🎙 ${formatClock(link.t)}`, title: '녹음의 이 순간 듣기 (녹음 탭)', go: () => actions.playRecording(link.rid, link.t) };
    }
  };
  const nowPlaying = playhead && playhead.docId === docId ? playhead : null;

  const preview = memoPreview(item.text) || '메모';
  const menu: MenuSection[] = [
    {
      items: [
        { key: 'attach', label: '📎 질문에 첨부', hint: '다음 질문과 함께', onSelect: () => actions.attach(slide, item.id) },
        { key: 'link', label: '🔗 슬라이드·강의 연결', onSelect: () => setLinking(true) },
        ...(nowPlaying ? [{ key: 'now', label: `🎙 지금 재생 위치 연결 (${formatClock(nowPlaying.t)})`, onSelect: () => addLink({ kind: 'recording', rid: nowPlaying.rid, t: Math.round(nowPlaying.t * 1000) / 1000 }) }] : []),
        { key: 'tutor', label: item.tutor ? '튜터에게 숨기기' : '튜터에게 보이기', onSelect: () => actions.update(slide, item.id, { tutor: !item.tutor }) },
        ...(inline ? [{ key: 'collapse', label: '접기', onSelect: () => actions.update(slide, item.id, { collapsed: true }) }] : []),
        { key: 'delete', label: '메모 삭제', danger: true, onSelect: () => actions.remove(slide, item.id) },
      ],
    },
  ];

  /**
   * The press that selects the card (and starts its drag): Shift adds it to / takes it out of the selection instead;
   * in a group the press is left to the viewer (no stopPropagation), which moves every selected item together.
   */
  const onCardPointerDown = (e: ReactPointerEvent<HTMLElement>): boolean => {
    if (group && !e.shiftKey) return false;
    e.stopPropagation();
    if (e.shiftKey) {
      actions.toggleSelect(slide, item.id);
      return false;
    }
    if (!selected) actions.select(slide, item.id);
    return true;
  };
  const textStyle: CSSProperties | undefined = fontSize ? { fontSize } : undefined;

  const at = dragAt ?? item.at;
  // Kept inside the slide box (which clips its overflow): a card near the right or bottom edge moves in.
  const style: CSSProperties | undefined = inline
    ? {
        left: `clamp(0px, ${(at.x * 100).toFixed(3)}%, calc(100% - ${collapsed ? '200px' : 'min(320px, max(160px, 24%))'}))`,
        top: `clamp(0px, ${(at.y * 100).toFixed(3)}%, calc(100% - ${collapsed ? '26px' : '170px'}))`,
      }
    : undefined;
  const cls = ['memo-card', `is-${item.color}`, selected && 'is-selected', collapsed && 'is-collapsed', dragAt && 'is-dragging', inline ? 'is-inline' : 'is-sheet']
    .filter(Boolean)
    .join(' ');

  if (collapsed) {
    return (
      <button
        type="button"
        className={cls}
        style={style}
        data-annot="memo"
        data-id={item.id}
        onPointerDown={(e) => {
          if (onCardPointerDown(e)) onHeaderPointerDown(e);
        }}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={() => endDrag(false)}
        title={item.text.trim() ? `${item.text.trim().slice(0, 200)}${item.text.length > 200 ? '…' : ''}` : '메모 (클릭해서 펴기)'}
        aria-label={item.tutor ? `메모: ${preview}` : `메모: ${preview} · 튜터에게 숨김`}
      >
        <span className="memo-dot" aria-hidden />
        <span className="memo-pill-text">{preview}</span>
        {item.tags.length > 0 && <span className="memo-pill-tags">#{item.tags.length}</span>}
        {!item.tutor && (
          <span className="memo-pill-hidden" title="튜터에게 숨김" aria-hidden>
            <EyeIcon off />
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      className={cls}
      style={style}
      data-annot="memo"
      data-id={item.id}
      onPointerDown={onCardPointerDown}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="memo-head"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={() => endDrag(false)}
        title={inline ? '끌어서 옮기기' : undefined}
      >
        <span className="memo-dot" aria-hidden />
        {inline && (
          <button type="button" className="memo-toggle" onClick={() => actions.update(slide, item.id, { collapsed: true })} aria-label="메모 접기" title="접기">
            ▾
          </button>
        )}
        <span className="memo-head-title">{preview}</span>
        {!item.tutor && (
          <span className="memo-head-hidden" role="img" title="튜터에게 숨김" aria-label="튜터에게 숨김">
            <EyeIcon off />
          </span>
        )}
        <PopoverMenu label="메모 메뉴" sections={menu} />
      </div>
      <textarea
        ref={textareaRef}
        className="memo-text"
        style={textStyle}
        value={text}
        placeholder="메모…"
        aria-label="메모 내용"
        rows={2}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          pending.current = value;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => flush(value), TEXT_DEBOUNCE_MS);
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={(e) => {
          focusedRef.current = false;
          flush(e.currentTarget.value);
          if (editing) actions.edit(slide, null);
        }}
        onKeyDown={onTextKeyDown}
      />
      <TagInput tags={item.tags} onChange={(tags) => actions.update(slide, item.id, { tags })} lectureTags={lectureTags} />
      <div className="memo-links">
        {item.links.map((link, i) => {
          const { text: label, title, go } = linkLabel(link);
          return (
            <span key={`${link.kind}:${i}`} className="memo-link">
              <button type="button" className="memo-link-go" onClick={go ?? undefined} disabled={!go} title={title}>
                {label}
              </button>
              <button type="button" className="memo-link-x" onClick={() => removeLink(i)} aria-label={`연결 ${label} 빼기`} title="연결 빼기">
                ×
              </button>
            </span>
          );
        })}
        <span className="memo-link-add">
          <button ref={setLinkButton} type="button" className="ghost-btn tiny" onClick={() => setLinking((v) => !v)} aria-expanded={linking} title="슬라이드나 다른 강의에 연결">
            🔗 연결
          </button>
          {linking && <LinkPicker anchor={linkButton} onPick={addLink} onClose={closeLinking} />}
        </span>
      </div>
      <div className="memo-foot">
        <button
          type="button"
          className={item.tutor ? 'memo-eye is-on' : 'memo-eye is-off'}
          aria-pressed={item.tutor}
          onClick={() => actions.update(slide, item.id, { tutor: !item.tutor })}
          title={item.tutor ? '튜터에게 보이기 — 질문할 때 이 메모도 함께 가요 (클릭하면 숨김)' : '튜터에게 숨김 — 이 메모는 튜터가 보지 않아요 (클릭하면 보이기)'}
        >
          <EyeIcon off={!item.tutor} />
          튜터에게 보이기
        </button>
        <span className="spacer" />
        <button type="button" className="ghost-btn tiny" onClick={() => actions.attach(slide, item.id)} title="이 메모를 질문에 첨부해요 (입력창 위에 표시돼요)">
          📎 첨부
        </button>
      </div>
    </div>
  );
}
