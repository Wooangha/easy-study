// The units of typed text on a slide (DESIGN §25 0.6.2, lib/annotations/text.ts): "pt on the slide" ↔ the stored
// fraction of the slide height, the 8–72 pt clamp, the defaults of items without the fields, the font stacks and the
// CSS variables a text box / memo renders with. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_MEMO_TEXT_SIZE_PT, DEFAULT_TEXT_SIZE_PT, MAX_TEXT_SIZE_PT, MIN_TEXT_SIZE_PT, SLIDE_PT_HEIGHT } from '../../shared/types.ts';
import {
  DEFAULT_MEMO_TEXT_SIZE,
  DEFAULT_TEXT_SIZE,
  MEMO_UI_FONT_PX,
  clampPt,
  clampSize,
  fontFamilyOf,
  isTextFont,
  memoFontSize,
  memoSheetFontSize,
  memoSizePt,
  ptToSize,
  sizeToPt,
  textBoxVars,
  textSizeOf,
} from '../src/lib/annotations/text.ts';

describe('units', () => {
  test('a size is pt / 540 (4 decimals); back to whole points; the range is 8–72 pt', () => {
    assert.equal(ptToSize(16), Math.round((16 / SLIDE_PT_HEIGHT) * 1e4) / 1e4);
    assert.equal(ptToSize(16), 0.0296);
    assert.equal(sizeToPt(0.0296), 16);
    assert.equal(sizeToPt(ptToSize(24)), 24);
    assert.equal(sizeToPt(ptToSize(72)), 72);
    assert.equal(sizeToPt(ptToSize(8)), 8);
    for (let pt = MIN_TEXT_SIZE_PT; pt <= MAX_TEXT_SIZE_PT; pt++) assert.equal(sizeToPt(ptToSize(pt)), pt, `${pt} pt survives the round trip`);
  });

  test('clamping: points below 8 or above 72 (and fractions) are pulled in; sizes the same way', () => {
    assert.equal(clampPt(2), MIN_TEXT_SIZE_PT);
    assert.equal(clampPt(500), MAX_TEXT_SIZE_PT);
    assert.equal(clampPt(23.6), 24);
    assert.equal(ptToSize(1000), Math.round((MAX_TEXT_SIZE_PT / SLIDE_PT_HEIGHT) * 1e4) / 1e4);
    assert.equal(sizeToPt(0.5), MAX_TEXT_SIZE_PT);
    assert.equal(sizeToPt(0), MIN_TEXT_SIZE_PT);
    assert.equal(clampSize(0.001), Math.round((MIN_TEXT_SIZE_PT / SLIDE_PT_HEIGHT) * 1e4) / 1e4);
    assert.equal(clampSize(1), Math.round((MAX_TEXT_SIZE_PT / SLIDE_PT_HEIGHT) * 1e4) / 1e4);
    assert.equal(clampSize(0.05), 0.05);
  });

  test('defaults: a text box without a size is 16 pt, a memo’s field starts at 12 pt while its text stays UI-sized', () => {
    assert.equal(DEFAULT_TEXT_SIZE, ptToSize(DEFAULT_TEXT_SIZE_PT));
    assert.equal(DEFAULT_MEMO_TEXT_SIZE, ptToSize(DEFAULT_MEMO_TEXT_SIZE_PT));
    assert.equal(textSizeOf({}), DEFAULT_TEXT_SIZE);
    assert.equal(textSizeOf({ size: Number.NaN }), DEFAULT_TEXT_SIZE);
    assert.equal(textSizeOf({ size: ptToSize(30) }), ptToSize(30));
    assert.equal(textSizeOf({ size: 9 }), clampSize(9), 'an out-of-range stored size is clamped, not replaced');
    assert.equal(memoSizePt({}), DEFAULT_MEMO_TEXT_SIZE_PT);
    assert.equal(memoSizePt({ size: ptToSize(20) }), 20);
    assert.equal(memoSizePt({ size: ptToSize(20) }, { slideH: 400 }), 20, 'a memo with a size shows it wherever it is');
    assert.equal(memoSizePt({ size: ptToSize(20) }, { sheet: true }), 20);
    assert.equal(memoFontSize({}), null);
    assert.equal(memoFontSize({ size: ptToSize(20) }), `calc(${ptToSize(20)} * var(--slide-h, 600) * 1px)`);
    assert.equal(memoSheetFontSize({}), null);
    assert.equal(memoSheetFontSize({ size: ptToSize(20) }), '20pt');
  });

  test('a memo without a size: the field starts at the points its 13 px text amounts to where it is shown, so the first + step grows it', () => {
    assert.equal(MEMO_UI_FONT_PX, 13);
    // Inline: 13 px of a 400-px slide = 17.55 → 18 pt of a 540-pt slide; the next step, 19 pt, renders 14.1 px there (no shrink).
    assert.equal(memoSizePt({}, { slideH: 400 }), 18);
    assert.ok((19 / SLIDE_PT_HEIGHT) * 400 > MEMO_UI_FONT_PX);
    assert.equal(memoSizePt({}, { slideH: 540 }), 13);
    assert.equal(memoSizePt({}, { slideH: 1080 }), 7, 'a big zoom: 13 px = 6.5 pt, rounded');
    assert.equal(memoSizePt({}, { slideH: 2160 }), MIN_TEXT_SIZE_PT, 'clamped to the range on a bigger zoom (13 px would be 3.25 pt)');
    assert.equal(memoSizePt({}, { slideH: 90 }), 72);
    assert.equal(memoSizePt({}, { slideH: 0 }), DEFAULT_MEMO_TEXT_SIZE_PT, 'nothing measured yet');
    // The bottom sheet renders CSS points: 13 px = 9.75 → 10 pt.
    assert.equal(memoSizePt({}, { sheet: true }), 10);
    assert.equal(memoSizePt({}, null), DEFAULT_MEMO_TEXT_SIZE_PT);
  });
});

describe('fonts and the CSS variables', () => {
  test('the three fonts; sans inherits the app font, mono the app token, serif a Korean-capable stack', () => {
    assert.equal(isTextFont('serif'), true);
    assert.equal(isTextFont('comic'), false);
    assert.equal(fontFamilyOf(undefined), 'inherit');
    assert.equal(fontFamilyOf('sans'), 'inherit');
    assert.equal(fontFamilyOf('mono'), 'var(--mono)');
    assert.match(fontFamilyOf('serif'), /Noto Serif KR/);
    assert.match(fontFamilyOf('serif'), /serif$/);
  });

  test('textBoxVars: size, font stack and weight; bold = 700', () => {
    assert.deepEqual(textBoxVars({}), { '--annot-size': String(DEFAULT_TEXT_SIZE), '--annot-font': 'inherit', '--annot-weight': '400' });
    assert.deepEqual(textBoxVars({ size: ptToSize(24), font: 'mono', bold: true }), { '--annot-size': String(ptToSize(24)), '--annot-font': 'var(--mono)', '--annot-weight': '700' });
    assert.equal(textBoxVars({ bold: false })['--annot-weight'], '400');
  });
});
