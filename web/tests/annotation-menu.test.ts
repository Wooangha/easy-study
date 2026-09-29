// Where the item menu goes (DESIGN §25 0.6.2, lib/annotations/menu.ts placeItemMenu): from the items' boxes as drawn
// (a memo card clamped to the slide's bottom edge), below when the visible viewer has room, else above, never over a
// memo card, inside the visible part of the slide sideways, inside the bottom edge of a shape taller than the view.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MENU_GAP_PX, menuMaxWidth, overlapsPx, placeItemMenu, unionPx, type PxRect } from '../src/lib/annotations/menu.ts';

/** A 1000 × 600 slide whose whole height is visible, in a viewer 1040 px wide. */
const slide: PxRect = { left: 0, top: 0, right: 1000, bottom: 600 };
const view: PxRect = { left: -20, top: -10, right: 1020, bottom: 610 };
const menu = { width: 300, height: 40 };
const box = (left: number, top: number, w: number, h: number): PxRect => ({ left, top, right: left + w, bottom: top + h });
const menuBox = (p: { left: number; top: number }): PxRect => box(p.left, p.top, menu.width, menu.height);

describe('placeItemMenu', () => {
  test('below the item, 8 px under it, starting at its left edge', () => {
    const item = box(100, 100, 200, 50);
    const p = placeItemMenu({ item, slide, view, menu });
    assert.deepEqual(p, { side: 'below', left: 100, top: 150 + MENU_GAP_PX });
    assert.equal(overlapsPx(menuBox(p), item), false);
  });

  test('a memo card dragged to the bottom edge (clamped there by CSS): the menu flips above it and never covers it', () => {
    // The card's anchor may say y = 0.98, but the card is drawn 170 px tall ending at the slide's bottom.
    const card = box(700, 430, 240, 170);
    const p = placeItemMenu({ item: card, slide, view, menu, outside: true });
    assert.equal(p.side, 'above');
    assert.equal(p.top, 430 - MENU_GAP_PX - menu.height);
    assert.equal(overlapsPx(menuBox(p), card), false);
    // And it stays inside the slide sideways: the card's left (700) + 300 would run past the right edge.
    assert.equal(p.left, 700);
    const wide = placeItemMenu({ item: box(850, 430, 140, 170), slide, view, menu, outside: true });
    assert.equal(wide.left, 1000 - menu.width);
  });

  test('no room below and none above: a shape sits inside its bottom edge, a memo takes the side with more room (never covered)', () => {
    const tall = box(100, -100, 300, 800); // taller than the whole view
    const shape = placeItemMenu({ item: tall, slide, view, menu });
    assert.equal(shape.side, 'inside');
    assert.equal(shape.top, 700 - MENU_GAP_PX - menu.height);
    const card = box(100, 20, 240, 560); // a card as tall as the view, 30 px from the top, 30 px from the bottom
    const memo = placeItemMenu({ item: card, slide, view, menu, outside: true });
    assert.equal(memo.side, 'below');
    assert.equal(memo.top, 580 + MENU_GAP_PX);
    assert.equal(overlapsPx(menuBox(memo), card), false);
    const nearBottom = placeItemMenu({ item: box(100, 60, 240, 550), slide, view, menu, outside: true });
    assert.equal(nearBottom.side, 'above');
    assert.equal(overlapsPx(menuBox(nearBottom), box(100, 60, 240, 550)), false);
  });

  test('the visible part of the viewer decides too: an item at the bottom of a scrolled-in slide still gets its menu above', () => {
    const scrolled: PxRect = { left: -20, top: 200, right: 1020, bottom: 560 }; // the view shows the slide's middle
    const p = placeItemMenu({ item: box(100, 540, 200, 40), slide, view: scrolled, menu });
    assert.equal(p.side, 'above');
    const top = placeItemMenu({ item: box(100, 210, 200, 40), slide, view: scrolled, menu });
    assert.equal(top.side, 'below');
  });

  test('inside the slide first: an item at the slide’s bottom edge gets its menu above even when the viewer shows the gap below; a slide too small for either hangs the menu over its edge', () => {
    // The viewer shows 200 px of gap / next slide under this slide: the menu still stays on the slide, above the item.
    const tall: PxRect = { left: -20, top: -10, right: 1020, bottom: 810 };
    const p = placeItemMenu({ item: box(100, 550, 200, 40), slide, view: tall, menu });
    assert.equal(p.side, 'above');
    // A memo card clipped by the slide's bottom edge (its box runs past it): above as well, never in the gap.
    const clipped = placeItemMenu({ item: box(100, 505, 240, 185), slide, view: tall, menu, outside: true });
    assert.deepEqual([clipped.side, clipped.top], ['above', 505 - MENU_GAP_PX - menu.height]);
    // A zoomed-out slide 60 px tall with an item filling it: no room inside the slide either way → below by the viewer.
    const tiny: PxRect = { left: 0, top: 300, right: 100, bottom: 360 };
    const over = placeItemMenu({ item: box(5, 305, 90, 50), slide: tiny, view: tall, menu });
    assert.deepEqual([over.side, over.top], ['below', 355 + MENU_GAP_PX]);
  });

  test('sideways: clamped to the visible part of the slide (a zoomed-in slide wider than the viewer)', () => {
    const zoomed: PxRect = { left: -400, top: 0, right: 1600, bottom: 600 }; // the slide is 2000 px wide
    const bigSlide: PxRect = { left: 0, top: 0, right: 2000, bottom: 600 };
    // An item left of the visible part: the menu starts at the view's left edge.
    assert.equal(placeItemMenu({ item: box(-800, 100, 100, 40), slide: bigSlide, view: zoomed, menu }).left, 0);
    assert.equal(placeItemMenu({ item: box(-100, 100, 100, 40), slide: bigSlide, view: { ...zoomed, left: -300 }, menu }).left, 0);
    assert.equal(placeItemMenu({ item: box(300, 100, 100, 40), slide: bigSlide, view: { ...zoomed, left: 200 }, menu }).left, 300);
    // An item near the right edge of the view: pulled in so the menu stays visible.
    assert.equal(placeItemMenu({ item: box(1500, 100, 100, 40), slide: bigSlide, view: zoomed, menu }).left, 1600 - menu.width);
    // A pane narrower than the menu: the menu starts at the left and is given the visible width to wrap in.
    const narrow: PxRect = { left: 0, top: 0, right: 250, bottom: 400 };
    assert.equal(placeItemMenu({ item: box(100, 100, 100, 40), slide: narrow, view: narrow, menu }).left, 0);
    assert.equal(menuMaxWidth(narrow, narrow), 250);
    assert.equal(menuMaxWidth(slide, view), 1000);
    assert.equal(menuMaxWidth(bigSlide, zoomed), 1600);
  });

  test('unionPx / overlapsPx', () => {
    assert.equal(unionPx([]), null);
    assert.deepEqual(unionPx([box(10, 20, 30, 40), box(0, 50, 100, 5)]), { left: 0, top: 20, right: 100, bottom: 60 });
    assert.equal(overlapsPx(box(0, 0, 10, 10), box(10, 0, 10, 10)), false);
    assert.equal(overlapsPx(box(0, 0, 10, 10), box(9, 9, 10, 10)), true);
  });
});
