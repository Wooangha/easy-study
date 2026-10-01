// The viewer's banner after a lecture's deck was swapped (DESIGN §28): "새 버전으로 바꿨어요 · 수정 6 · 새로 1 · 빠짐 1"
// (or "이전 버전으로 되돌렸어요"), ‹ › through the changed and added slides, 되돌리기 while the last apply can be undone, ×
// (dismissed in this browser: localStorage deckSeen:<docId>).
import { ChevronLeft, ChevronRight, FileUp, Undo2, X } from 'lucide-react';
import type { DeckChange } from '../../../shared/types.ts';
import { msg } from '../i18n/index.ts';
import { changeSlides, stepSlide } from '../lib/versionPlan.ts';

interface DeckBannerProps {
  change: DeckChange;
  focused: number;
  onGoToSlide: (slide: number) => void;
  /** 되돌리기 (absent: not offered here). */
  onUndo?: () => void;
  onDismiss: () => void;
}

export function DeckBanner({ change, focused, onGoToSlide, onUndo, onDismiss }: DeckBannerProps) {
  const m = msg().versions.banner;
  const slides = changeSlides(change);
  const counts = [
    change.changed.length > 0 ? m.changed(change.changed.length) : null,
    change.added.length > 0 ? m.added(change.added.length) : null,
    change.removed.length > 0 ? m.removed(change.removed.length) : null,
  ].filter((t): t is string => t !== null);
  const step = (dir: 1 | -1) => {
    const target = stepSlide(slides, focused, dir);
    if (target !== null) onGoToSlide(target);
  };
  const apply = change.kind === 'apply';
  return (
    <div className="deck-banner" role="status">
      <span className="deck-banner-text">
        <FileUp /> {apply ? m.applied : m.undone}
        {apply && counts.length > 0 && <span className="deck-banner-counts"> · {counts.join(' · ')}</span>}
      </span>
      {slides.length > 0 && (
        <span className="deck-banner-steps">
          <button type="button" className="icon-btn small" onClick={() => step(-1)} title={m.prev} aria-label={m.prev}>
            <ChevronLeft />
          </button>
          <button type="button" className="icon-btn small" onClick={() => step(1)} title={m.next} aria-label={m.next}>
            <ChevronRight />
          </button>
        </span>
      )}
      <span className="spacer" />
      {apply && change.undoable && onUndo && (
        <button type="button" className="ghost-btn small" onClick={onUndo}>
          <Undo2 /> {m.undo}
        </button>
      )}
      <button type="button" className="icon-btn small" onClick={onDismiss} title={m.dismiss} aria-label={m.dismiss}>
        <X />
      </button>
    </div>
  );
}
