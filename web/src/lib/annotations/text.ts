// The look of typed text on a slide (DESIGN §25, 0.6.2), pure: the "pt on the slide" units of a text box's / memo's
// size (stored as a fraction of the slide image's height so the zoom scales it, shown in points of a
// SLIDE_PT_HEIGHT-pt-tall slide), the clamps, the defaults of items written before the fields existed, the font
// stacks, and the CSS variables a text box renders with. No DOM.
import {
  DEFAULT_MEMO_TEXT_SIZE_PT,
  DEFAULT_TEXT_SIZE_PT,
  MAX_TEXT_SIZE_PT,
  MIN_TEXT_SIZE_PT,
  SLIDE_PT_HEIGHT,
  TEXT_FONTS,
  type MemoItem,
  type TextFont,
  type TextItem,
} from '../../../../shared/types.ts';
import { round4 } from './geometry.ts';

/** Points, clamped to the allowed range and rounded to whole points. */
export const clampPt = (pt: number): number => Math.min(MAX_TEXT_SIZE_PT, Math.max(MIN_TEXT_SIZE_PT, Math.round(pt)));

/** The stored size (a fraction of the slide height, 4 decimals) of a size in points. */
export const ptToSize = (pt: number): number => round4(clampPt(pt) / SLIDE_PT_HEIGHT);

/** A stored size back in whole points (the number field), clamped. */
export const sizeToPt = (size: number): number => clampPt(size * SLIDE_PT_HEIGHT);

/** A stored size kept inside the allowed range (the server caps the same way). */
export const clampSize = (size: number): number => round4(Math.min(MAX_TEXT_SIZE_PT / SLIDE_PT_HEIGHT, Math.max(MIN_TEXT_SIZE_PT / SLIDE_PT_HEIGHT, size)));

export const DEFAULT_TEXT_SIZE = ptToSize(DEFAULT_TEXT_SIZE_PT);
export const DEFAULT_MEMO_TEXT_SIZE = ptToSize(DEFAULT_MEMO_TEXT_SIZE_PT);

/** The size a text box renders with (its own, or the default of an item without one). */
export const textSizeOf = (item: Pick<TextItem, 'size'>): number => (typeof item.size === 'number' && Number.isFinite(item.size) ? clampSize(item.size) : DEFAULT_TEXT_SIZE);

/** The UI font size (px) of a memo's text without `size` (styles.css `.memo-text`, 0.6.1). */
export const MEMO_UI_FONT_PX = 13;

/** Where a memo's text is shown: inline on a slide `slideH` px tall, or in the bottom sheet (CSS points). */
export type MemoShown = { slideH: number } | { sheet: true };

/**
 * The points shown in a memo's size field: its own size — or, for a memo without one (its text renders UI-sized,
 * MEMO_UI_FONT_PX), the points that 13 px amount to where it is shown right now: against the slide's rendered
 * height inline (13 px of a 400-px slide = 18 pt of a 540-pt one), or CSS points in the bottom sheet (10 pt), so
 * the field starts at "today's size" and its first ▲ step grows the text a little instead of shrinking it (the
 * field's value then follows the zoom until a size is set). DEFAULT_MEMO_TEXT_SIZE_PT when nothing is known.
 */
export function memoSizePt(item: Pick<MemoItem, 'size'>, shown?: MemoShown | null): number {
  if (typeof item.size === 'number' && Number.isFinite(item.size)) return sizeToPt(item.size);
  if (!shown) return DEFAULT_MEMO_TEXT_SIZE_PT;
  if ('sheet' in shown) return clampPt(MEMO_UI_FONT_PX * 0.75);
  return shown.slideH > 0 ? clampPt((MEMO_UI_FONT_PX / shown.slideH) * SLIDE_PT_HEIGHT) : DEFAULT_MEMO_TEXT_SIZE_PT;
}

export const isTextFont = (v: unknown): v is TextFont => (TEXT_FONTS as readonly unknown[]).includes(v);

export const FONT_LABELS: Record<TextFont, string> = { sans: '기본', serif: '명조', mono: '고정폭' };

/** The CSS font stack of a font choice ('sans' = the app's own font, so `inherit`). */
export function fontFamilyOf(font: TextFont | undefined): string {
  switch (font) {
    case 'serif':
      return '"Noto Serif KR", "Noto Serif CJK KR", "Apple Myungjo", "Nanum Myeongjo", "Batang", "Songti SC", Georgia, serif';
    case 'mono':
      return 'var(--mono)';
    default:
      return 'inherit';
  }
}

/**
 * The CSS custom properties a text box's element carries: its size (the layer turns it into px with the slide's
 * rendered height), font stack and weight. The layer's `--slide-h` is in px.
 */
export function textBoxVars(item: Pick<TextItem, 'size' | 'font' | 'bold'>): Record<'--annot-size' | '--annot-font' | '--annot-weight', string> {
  return {
    '--annot-size': String(textSizeOf(item)),
    '--annot-font': fontFamilyOf(item.font),
    '--annot-weight': item.bold ? '700' : '400',
  };
}

/** The font-size of a memo's text on the slide (its stored size against the layer's `--slide-h`), or null for the UI-sized default. */
export function memoFontSize(item: Pick<MemoItem, 'size'>): string | null {
  if (typeof item.size !== 'number' || !Number.isFinite(item.size)) return null;
  return `calc(${clampSize(item.size)} * var(--slide-h, 600) * 1px)`;
}

/** The same memo's text size in the bottom sheet (outside the slide, no slide height to scale with): CSS points. */
export function memoSheetFontSize(item: Pick<MemoItem, 'size'>): string | null {
  if (typeof item.size !== 'number' || !Number.isFinite(item.size)) return null;
  return `${sizeToPt(item.size)}pt`;
}
