// The floating menu of a selected annotation item (DESIGN §25), like the region menu: the four colors, 📎 첨부 (a chip
// in the composer, sent with the next question — nothing is sent now), 🗑 삭제, for memos 👁 튜터에게 보이기 and
// 접기/펴기 (on a narrow pane / touch, where the card is always a pill, 펴기 opens the bottom sheet instead), and how
// many questions were asked with the item. Rendered in `.slide` outside the slide box.
import { useEffect, useRef, type CSSProperties } from 'react';
import { ANNOTATION_COLORS, type AnnotationItem, type RegionRect } from '../../../../shared/types.ts';
import type { MenuPlacement } from '../../lib/attachments.ts';
import { useLayerEnv } from './context.ts';

export const COLOR_NAMES: Record<(typeof ANNOTATION_COLORS)[number], string> = {
  yellow: '노랑',
  green: '초록',
  pink: '분홍',
  blue: '파랑',
};

/** Rough width of the menu, to keep it inside the slide. */
const MENU_WIDTH_PX = 300;

interface ItemMenuProps {
  slide: number;
  item: AnnotationItem;
  /** The item's bounds as fractions of the slide box. */
  boxRect: RegionRect;
  placement: MenuPlacement;
  /** Questions asked with this item (question markers pointing at it). */
  questions: number;
}

export function ItemMenu({ slide, item, boxRect, placement, questions }: ItemMenuProps) {
  const { actions, compact } = useLayerEnv();
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus only when nothing is being typed (a new memo opens with its textarea focused).
    if (!(document.activeElement instanceof HTMLTextAreaElement)) firstRef.current?.focus({ preventScroll: true });
  }, [item.id]);
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  const top =
    placement === 'below'
      ? `calc(${pct(boxRect.y + boxRect.h)} + 8px)`
      : placement === 'above'
        ? `calc(${pct(boxRect.y)} - 8px)`
        : `calc(${pct(boxRect.y + boxRect.h)} - 8px)`;
  // A narrow slide cannot fit the menu beside the item: centred, wrapping.
  const style: CSSProperties = compact ? { left: '50%', top } : { left: `clamp(0px, ${pct(boxRect.x)}, calc(100% - ${MENU_WIDTH_PX}px))`, top };
  const memo = item.type === 'memo' ? item : null;
  return (
    <div
      className={`region-menu annot-item-menu is-${placement}${compact ? ' is-centered' : ''}`}
      style={style}
      role="toolbar"
      aria-label={`슬라이드 ${slide}의 선택한 필기`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="annot-color-dots" role="group" aria-label="색">
        {ANNOTATION_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`annot-dot is-${color}${item.color === color ? ' is-active' : ''}`}
            aria-pressed={item.color === color}
            aria-label={COLOR_NAMES[color]}
            title={COLOR_NAMES[color]}
            onClick={() => actions.update(slide, item.id, { color })}
          />
        ))}
      </span>
      <button
        ref={firstRef}
        type="button"
        className="region-menu-btn"
        onClick={() => actions.attach(slide, item.id)}
        title="이 필기를 질문에 첨부해요 (입력창 위에 표시돼요)"
      >
        📎 첨부
      </button>
      {memo && (
        <>
          <button
            type="button"
            className={memo.tutor ? 'region-menu-btn is-on' : 'region-menu-btn is-off'}
            aria-pressed={memo.tutor}
            onClick={() => actions.update(slide, item.id, { tutor: !memo.tutor })}
            title={memo.tutor ? '튜터에게 보이기: 켜짐 — 이 메모가 질문과 함께 전달돼요 (클릭하면 끔)' : '튜터에게 보이기: 꺼짐 — 이 메모는 튜터가 보지 않아요 (클릭하면 켬)'}
          >
            {memo.tutor ? '👁' : '🙈'}
          </button>
          {compact ? (
            <button type="button" className="region-menu-btn" onClick={() => actions.openSheet(slide, item.id)} title="메모 펴기 (아래 시트에서 편집)">
              펴기
            </button>
          ) : (
            <button
              type="button"
              className="region-menu-btn"
              onClick={() => actions.update(slide, item.id, { collapsed: !memo.collapsed })}
              title={memo.collapsed ? '메모 펴기' : '메모 접기'}
            >
              {memo.collapsed ? '펴기' : '접기'}
            </button>
          )}
        </>
      )}
      <button type="button" className="region-menu-btn is-danger" onClick={() => actions.remove(slide, item.id)} title="이 필기 삭제 (Delete)">
        🗑 삭제
      </button>
      {questions > 0 && (
        <span className="annot-menu-note" title="이 필기를 첨부해서 물어본 질문 (슬라이드의 💬 표시)">
          💬 {questions}
        </span>
      )}
      <button type="button" className="region-menu-btn is-close" onClick={() => actions.select(slide, null)} aria-label="선택 해제" title="선택 해제 (Esc)">
        ✕
      </button>
    </div>
  );
}
