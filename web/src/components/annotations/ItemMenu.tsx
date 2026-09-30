// The floating menu of the selected annotation item(s) (DESIGN §25), like the region menu: the four colors, the text
// look of a text box (size in points with a slider, the font, bold) or the text size of a memo — inline on a wide
// pane, in a small popover on a narrow one —, 첨부 (a chip in the composer, sent with the next question — nothing
// is sent now), 삭제, for a memo the eye of 튜터에게 보이기 and 접기/펴기 (on a narrow pane / touch, where the card
// is always a pill, 펴기 opens the bottom sheet instead), and how many questions were asked with the item. With
// several items selected the colors, 첨부 and 삭제 act on all of them at once (one write, one undo step).
//
// Placed by itself (lib/annotations/menu.ts placeItemMenu) from the items' ACTUAL boxes as drawn — a memo card is
// clamped inside the slide by CSS, so its anchor is not where the card is —, below them when the visible viewer has
// room, else above, never over a memo card, inside the slide sideways; measured again when the items, the slide's
// size (zoom) or the menu's own size change. Rendered in `.slide` outside the slide box.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Paperclip, Trash, X } from 'lucide-react';
import {
  ANNOTATION_COLORS,
  MAX_TEXT_SIZE_PT,
  MIN_TEXT_SIZE_PT,
  TEXT_FONTS,
  type AnnotationItem,
  type MemoItem,
  type Patchable,
  type TextFont,
  type TextItem,
} from '../../../../shared/types.ts';
import { useLatest } from '../../hooks/useLatest.ts';
import { msg } from '../../i18n/index.ts';
import { menuMaxWidth, placeItemMenu, unionPx, type MenuSide, type PxRect } from '../../lib/annotations/menu.ts';
import { clampPt, memoSizePt, ptToSize, sizeToPt, textSizeOf, type MemoShown } from '../../lib/annotations/text.ts';
import { useLayerEnv } from './context.ts';
import { Floating } from './Floating.tsx';
import { ChatIcon, EyeIcon } from './icons.tsx';

interface ItemMenuProps {
  slide: number;
  /** The selected items, in z-order (at least one). */
  items: readonly AnnotationItem[];
  /** Questions asked with the item (question markers pointing at it), for a single selection. */
  questions: number;
}

interface Placed {
  side: MenuSide;
  left: number;
  top: number;
  maxWidth: number;
}

/** The px box of an element relative to `origin`'s top-left. */
const relative = (r: DOMRect, origin: DOMRect): PxRect => ({ left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top });

export function ItemMenu({ slide, items, questions }: ItemMenuProps) {
  const { actions, compact } = useLayerEnv();
  const firstRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  /** The slide image's rendered height in px (the layer's): what a memo without a size renders 13 px against. */
  const [slideH, setSlideH] = useState(0);
  const ids = items.map((it) => it.id);
  const idsKey = ids.join(',');
  const single = items.length === 1 ? items[0] : null;
  const memo = single?.type === 'memo' ? single : null;
  const textBox = single?.type === 'text' ? single : null;

  useEffect(() => {
    // Focus only when nothing is being typed (a new memo opens with its textarea focused).
    if (!(document.activeElement instanceof HTMLTextAreaElement)) firstRef.current?.focus({ preventScroll: true });
  }, [idsKey]);

  /**
   * Where the menu goes: measured from the DOM — the selected items' elements inside the slide box (the memo card
   * where CSS put it), the box, the viewer's visible area and the menu's own size at the width the pane allows.
   */
  const measure = useCallback(() => {
    const el = menuRef.current;
    const parent = el?.offsetParent instanceof HTMLElement ? el.offsetParent : el?.parentElement;
    const box = parent?.querySelector<HTMLElement>('.slide-box');
    const scroller = parent?.closest<HTMLElement>('.viewer-scroll');
    if (!el || !parent || !box) return;
    const origin = parent.getBoundingClientRect();
    const boxes: PxRect[] = [];
    for (const id of ids) {
      const target = box.querySelector<Element>(`[data-annot="item"][data-id="${id}"], [data-annot="memo"][data-id="${id}"]`);
      if (target) boxes.push(relative(target.getBoundingClientRect(), origin));
    }
    const item = unionPx(boxes);
    if (!item) return;
    const slideBox = relative(box.getBoundingClientRect(), origin);
    const view = scroller ? relative(scroller.getBoundingClientRect(), origin) : slideBox;
    setSlideH(Math.round(box.querySelector<HTMLElement>('.annot-layer')?.getBoundingClientRect().height ?? 0));
    const maxWidth = menuMaxWidth(slideBox, view);
    el.style.maxWidth = `${maxWidth}px`;
    const place = placeItemMenu({
      item,
      slide: slideBox,
      view,
      menu: { width: el.offsetWidth, height: el.offsetHeight },
      outside: items.some((it) => it.type === 'memo'),
    });
    const next = { ...place, maxWidth };
    setPlaced((prev) => (prev && prev.side === next.side && prev.left === next.left && prev.top === next.top && prev.maxWidth === next.maxWidth ? prev : next));
    // `ids` and `items` are derived from the props this render; the effects below re-run on their key.
  }, [idsKey, items]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // The items' elements (a memo card grows as its text is typed), the slide box (zoom) and the menu itself (its
  // buttons change) are watched for size changes; the position follows the items on every render already.
  const measureRef = useLatest(measure);
  useEffect(() => {
    const el = menuRef.current;
    const parent = el?.offsetParent instanceof HTMLElement ? el.offsetParent : el?.parentElement;
    const box = parent?.querySelector<HTMLElement>('.slide-box');
    if (!el || !box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureRef.current());
    ro.observe(el);
    ro.observe(box);
    for (const id of idsKey.split(',')) {
      const target = box.querySelector<Element>(`[data-annot="item"][data-id="${id}"], [data-annot="memo"][data-id="${id}"]`);
      if (target) ro.observe(target);
    }
    return () => ro.disconnect();
  }, [idsKey, measureRef]);

  const style: CSSProperties = placed
    ? { left: `${placed.left}px`, top: `${placed.top}px`, maxWidth: `${placed.maxWidth}px` }
    : { left: 0, top: 0, visibility: 'hidden' };
  const commonColor = items.every((it) => it.color === items[0].color) ? items[0].color : null;
  const update = (patch: Patchable<AnnotationItem>) => (single ? actions.update(slide, single.id, patch) : actions.updateMany(slide, ids, patch));
  const many = items.length > 1;
  const m = msg().viewer.itemMenu;
  const memoTexts = msg().viewer.memo;
  const colorNames = msg().viewer.colorNames;

  return (
    <div
      ref={menuRef}
      className={`region-menu annot-item-menu is-${placed?.side ?? 'below'}${compact ? ' is-compact' : ''}`}
      style={style}
      role="toolbar"
      aria-label={many ? m.labelMany(slide, items.length) : m.label(slide)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {many && <span className="annot-menu-count">{m.count(items.length)}</span>}
      <span className="annot-color-dots" role="group" aria-label={m.colors}>
        {ANNOTATION_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`annot-dot is-${color}${commonColor === color ? ' is-active' : ''}`}
            aria-pressed={commonColor === color}
            aria-label={colorNames[color]}
            title={many ? m.colorAllTitle(colorNames[color]) : colorNames[color]}
            onClick={() => update({ color })}
          />
        ))}
      </span>
      {textBox && <TextStyleControls item={textBox} compact={compact} onChange={(patch) => actions.update(slide, textBox.id, patch)} />}
      {memo && <MemoSizeControls item={memo} compact={compact} shown={compact ? { sheet: true } : { slideH }} onChange={(patch) => actions.update(slide, memo.id, patch)} />}
      <button
        ref={firstRef}
        type="button"
        className="region-menu-btn"
        onClick={() => (single ? actions.attach(slide, single.id) : actions.attachMany(slide, ids))}
        title={many ? m.attachManyTitle : m.attachTitle}
      >
        <Paperclip /> {m.attach}
      </button>
      {memo && (
        <>
          <button
            type="button"
            className={memo.tutor ? 'region-menu-btn is-icon' : 'region-menu-btn is-icon is-off'}
            aria-pressed={memo.tutor}
            aria-label={memoTexts.tutorShow}
            onClick={() => actions.update(slide, memo.id, { tutor: !memo.tutor })}
            title={memo.tutor ? memoTexts.tutorShownTitle : memoTexts.tutorHiddenTitle}
          >
            <EyeIcon off={!memo.tutor} />
          </button>
          {compact ? (
            <button type="button" className="region-menu-btn" onClick={() => actions.openSheet(slide, memo.id)} title={m.expandSheetTitle}>
              {m.expand}
            </button>
          ) : (
            <button
              type="button"
              className="region-menu-btn"
              onClick={() => actions.update(slide, memo.id, { collapsed: !memo.collapsed })}
              title={memo.collapsed ? m.expandTitle : m.collapseTitle}
            >
              {memo.collapsed ? m.expand : m.collapse}
            </button>
          )}
        </>
      )}
      <button
        type="button"
        className="region-menu-btn is-danger"
        onClick={() => (single ? actions.remove(slide, single.id) : actions.removeMany(slide, ids))}
        title={many ? m.deleteManyTitle(items.length) : m.deleteTitle}
      >
        <Trash /> {msg().common.delete}
      </button>
      {!many && questions > 0 && (
        <span className="annot-menu-note" role="img" aria-label={m.questions(questions)} title={m.questionsTitle(questions)}>
          <ChatIcon className="annot-menu-note-icon" />
          {questions}
        </span>
      )}
      <button type="button" className="region-menu-btn is-close" onClick={() => actions.select(slide, null)} aria-label={m.deselect} title={m.deselectTitle}>
        <X />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The text look: size (points on the slide), font, bold
// ---------------------------------------------------------------------------

/**
 * A number field for a size in points (MIN_TEXT_SIZE_PT–MAX_TEXT_SIZE_PT) between − and + buttons (0.6.4 dropped the
 * slider: the user found it fiddly). Typing commits as soon as the number is valid (so "24" is applied when the 4 lands,
 * not "2" clamped); blur / Enter clamps what is left; ↑ / ↓ in the field step by one like the buttons.
 */
function SizeField({ pt, label, decrease, increase, onPt }: { pt: number; label: string; decrease: string; increase: string; onPt: (pt: number) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? String(pt);
  const commit = (raw: string, clampIt: boolean) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    if (clampIt) {
      const c = clampPt(n);
      setTyped(null);
      if (c !== pt) onPt(c);
      return;
    }
    if (n >= MIN_TEXT_SIZE_PT && n <= MAX_TEXT_SIZE_PT && n !== pt) onPt(n);
  };
  const step = (by: number) => {
    setTyped(null);
    const next = clampPt(pt + by);
    if (next !== pt) onPt(next);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.currentTarget.value, true);
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTyped(null);
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1);
    }
  };
  return (
    <span className="annot-size" role="group" aria-label={label}>
      <button
        type="button"
        className="annot-size-step"
        onClick={() => step(-1)}
        disabled={pt <= MIN_TEXT_SIZE_PT}
        aria-label={decrease}
        title={decrease}
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        className="annot-size-input"
        value={shown}
        aria-label={`${label} (pt)`}
        title={msg().viewer.textStyle.sizeTitle(label, MIN_TEXT_SIZE_PT, MAX_TEXT_SIZE_PT)}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const raw = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
          setTyped(raw);
          commit(raw, false);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value, true)}
        onKeyDown={onKey}
      />
      <button
        type="button"
        className="annot-size-step"
        onClick={() => step(1)}
        disabled={pt >= MAX_TEXT_SIZE_PT}
        aria-label={increase}
        title={increase}
      >
        +
      </button>
    </span>
  );
}

/** The controls inline, or (a narrow pane) behind one small button that opens them in a popover. */
function StyleControls({ summary, label, compact, children }: { summary: string; label: string; compact: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (button?.contains(t) || document.getElementById(id)?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, button, id]);
  if (!compact) return <span className="annot-style">{children}</span>;
  return (
    <>
      <button ref={setButton} type="button" className={`region-menu-btn annot-style-btn${open ? ' is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined} title={label}>
        {summary}
      </button>
      {open && (
        <Floating
          anchor={button}
          width={232}
          height={120}
          className="annot-style-pop"
          role="group"
          label={label}
          onScrollAway={close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
              button?.focus();
            }
          }}
        >
          <div id={id} className="annot-style is-pop" onPointerDown={(e) => e.stopPropagation()}>
            {children}
          </div>
        </Floating>
      )}
    </>
  );
}

function TextStyleControls({ item, compact, onChange }: { item: TextItem; compact: boolean; onChange: (patch: Patchable<TextItem>) => void }) {
  const pt = sizeToPt(textSizeOf(item));
  const font = item.font ?? 'sans';
  const bold = item.bold === true;
  const m = msg().viewer.textStyle;
  return (
    <StyleControls summary={`${m.summary(pt)}${bold ? ' B' : ''}`} label={m.label} compact={compact}>
      <SizeField pt={pt} label={m.size} decrease={m.sizeDown} increase={m.sizeUp} onPt={(next) => onChange({ size: ptToSize(next) })} />
      <select className="picker small annot-font-select" value={font} aria-label={m.font} title={m.font} onChange={(e) => onChange({ font: e.target.value as TextFont })} onKeyDown={(e) => e.stopPropagation()}>
        {TEXT_FONTS.map((f) => (
          <option key={f} value={f}>
            {m.fonts[f]}
          </option>
        ))}
      </select>
      <button type="button" className={`region-menu-btn annot-bold-btn${bold ? ' is-active' : ''}`} aria-pressed={bold} aria-label={m.bold} title={m.bold} onClick={() => onChange({ bold: !bold })}>
        B
      </button>
    </StyleControls>
  );
}

/** A memo's text size; the field of a memo without one starts at the points its UI-sized text amounts to where it is shown (text.ts memoSizePt). */
function MemoSizeControls({ item, compact, shown, onChange }: { item: MemoItem; compact: boolean; shown: MemoShown; onChange: (patch: Patchable<MemoItem>) => void }) {
  const pt = memoSizePt(item, shown);
  const m = msg().viewer.textStyle;
  return (
    <StyleControls summary={m.summary(pt)} label={m.memoSize} compact={compact}>
      <SizeField pt={pt} label={m.memoSize} decrease={m.memoSizeDown} increase={m.memoSizeUp} onPt={(next) => onChange({ size: ptToSize(next) })} />
    </StyleControls>
  );
}
