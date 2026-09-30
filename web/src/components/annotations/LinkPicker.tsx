// "연결" of a memo (DESIGN §25): a small panel to link a slide of this lecture (a number, the focused slide by
// default) or another lecture of the library (a select, with an optional slide). Emits a MemoLink; never a URL.
// Floated next to its button (a memo card near an edge would clip it).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DocMeta, MemoLink } from '../../../../shared/types.ts';
import { clamp } from '../../lib/format.ts';
import { useLayerEnv } from './context.ts';
import { Floating } from './Floating.tsx';

interface LinkPickerProps {
  /** The button it opens from. */
  anchor: HTMLElement | null;
  onPick: (link: MemoLink) => void;
  onClose: () => void;
}

export const LINK_PICKER_WIDTH = 280;

export function LinkPicker({ anchor, onPick, onClose }: LinkPickerProps) {
  const { docId, docs, focusedSlide, pageCount } = useLayerEnv();
  const [kind, setKind] = useState<'slide' | 'doc'>('slide');
  const [slide, setSlide] = useState(String(focusedSlide));
  const [otherId, setOtherId] = useState('');
  const [otherSlide, setOtherSlide] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const others = (docs ?? []).filter((d) => d.id !== docId && d.status === 'ready');

  // Esc or a press outside (the button itself included: it toggles) closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose, anchor]);
  const scrolled = useCallback(() => onClose(), [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'slide') {
      const n = Number.parseInt(slide, 10);
      if (!Number.isFinite(n)) return;
      onPick({ kind: 'slide', slide: clamp(n, 1, Math.max(1, pageCount)) });
    } else {
      const target: DocMeta | undefined = others.find((d) => d.id === otherId);
      if (!target) return;
      const n = Number.parseInt(otherSlide, 10);
      onPick(Number.isFinite(n) && n >= 1 ? { kind: 'doc', docId: target.id, slide: clamp(n, 1, Math.max(1, target.pageCount)) } : { kind: 'doc', docId: target.id });
    }
    onClose();
  };

  return (
    <Floating ref={rootRef} anchor={anchor} width={LINK_PICKER_WIDTH} className="link-picker" role="dialog" label="메모에 연결할 슬라이드" onScrollAway={scrolled}>
      <form onSubmit={submit} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <label className="link-picker-row">
          <input type="radio" name="link-kind" checked={kind === 'slide'} onChange={() => setKind('slide')} />
          <span>이 강의</span>
          <span className="link-picker-p">p.</span>
          <input
            className="page-jump-input"
            inputMode="numeric"
            value={slide}
            autoFocus
            onFocus={() => setKind('slide')}
            onChange={(e) => setSlide(e.target.value.replace(/[^0-9]/g, ''))}
            aria-label="이 강의의 슬라이드 번호"
          />
        </label>
        <label className="link-picker-row">
          <input type="radio" name="link-kind" checked={kind === 'doc'} onChange={() => setKind('doc')} disabled={others.length === 0} />
          <span>다른 강의</span>
          <select
            className="picker small"
            value={otherId}
            disabled={others.length === 0}
            onFocus={() => setKind('doc')}
            onChange={(e) => {
              setOtherId(e.target.value);
              setKind('doc');
            }}
            aria-label="다른 강의"
          >
            <option value="">{others.length === 0 ? '(다른 강의 없음)' : '강의 선택…'}</option>
            {others.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
          <span className="link-picker-p">p.</span>
          <input
            className="page-jump-input"
            inputMode="numeric"
            value={otherSlide}
            placeholder="—"
            disabled={others.length === 0}
            onFocus={() => setKind('doc')}
            onChange={(e) => setOtherSlide(e.target.value.replace(/[^0-9]/g, ''))}
            aria-label="다른 강의의 슬라이드 번호 (선택)"
          />
        </label>
        <div className="link-picker-actions">
          <button type="button" className="ghost-btn small" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary-btn small" disabled={kind === 'doc' && otherId === ''}>
            연결
          </button>
        </div>
      </form>
    </Floating>
  );
}
