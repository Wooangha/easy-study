// 펜 and 지우개 in the web client (DESIGN §29): which press writes, erases or does nothing under 펜 / 지우개 (a stylus
// and the mouse write over items too, a finger scrolls unless 손가락으로도 쓰기, a pen's eraser end / barrel button
// erases), the pressure of a sample, a stroke hit near its centre line only (not in its box), what an eraser move
// touches, a stroke as items (moved / resized / recolored like a shape, `pts` never patched, counted apart from the
// other items), the rendering (a nested <svg> with the image's aspect; a move shifts it, one box around a group), the
// toolbar (되돌리기 / 다시 실행, folding when it has no room) and the item menu under 펜, the per-device settings, the
// 빠진 슬라이드 row and the dark-mode edge of the ink swatches; which pointer and touch events start, block or keep a
// stroke (a pen that is not the primary pointer, a tap on a control, a cancel right after the press).
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/experimental';
import { inkPieces, inkPointsOf, NO_PRESSURE, type InkPoint } from '../../shared/ink.ts';
import { INK_WIDTHS, MAX_ANNOTATION_ITEMS, type HighlightItem, type InkItem, type RectItem, type SlideAnnotations } from '../../shared/types.ts';
import { applyOps, canAddItems, emptySlideAnnotations, moveItems, newInk, resizeRect } from '../src/lib/annotations/geometry.ts';
import {
  acceptsPress,
  blocksInkTouch,
  eraserHits,
  hitTestItems,
  INK_CANCEL_SLOP_PX,
  itemArea,
  itemHit,
  keepsCancelledStroke,
  marqueeSelect,
  onInkControl,
  pressPlan,
  slopFor,
  unionIds,
  type InkTouch,
  type PressInput,
} from '../src/lib/annotations/gesture.ts';
import { imageAspectOf, inkPathOf, inkPressure, inkSamples } from '../src/lib/annotations/ink.ts';
import { getFingerInk, getInkColor, getInkWidth, setInkColor, setInkWidth } from '../src/lib/annotations/settings.ts';
import { attachmentLabel, FULL_FRAME, imageFrame } from '../src/lib/attachments.ts';
import { removedRows } from '../src/lib/versionPlan.ts';

// The components are .tsx (JSX, which Node's type stripping does not take): transpiled on load like i18n-viewer.test.ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith('.css') ? { url: 'data:text/javascript,', shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    const { code, errors } = transformSync(fileURLToPath(url), fs.readFileSync(new URL(url), 'utf8'), { jsx: { runtime: 'automatic' } });
    if (errors.length > 0) throw new Error(`${url}: ${errors.map((e) => e.message).join('; ')}`);
    return { format: 'module', source: code, shortCircuit: true };
  },
});
const { AnnotationLayer } = await import('../src/components/annotations/AnnotationLayer.tsx');
const { AnnotationTools, foldTools, TOOLS_FOLD_SLACK_PX, toolHint } = await import('../src/components/annotations/AnnotationTools.tsx');
const { ItemMenu } = await import('../src/components/annotations/ItemMenu.tsx');
const { LayerContext } = await import('../src/components/annotations/context.ts');
type LayerEnv = import('../src/components/annotations/context.ts').LayerEnv;

const NOW = '2026-10-02T10:00:00.000Z';
/** A 16:9 slide image rendered 1600 × 900 px. */
const ASPECT = 16 / 9;
const SIZE = { width: 1600, height: 900 };
const WIDTH = INK_WIDTHS[1];

/** A stroke through `points` (image coordinates, no pressure), as the viewer stores it. */
function stroke(id: string, points: Array<[number, number]>, color: InkItem['color'] = 'black'): InkItem {
  const pts: InkPoint[] = points.map(([x, y]) => ({ x, y, p: NO_PRESSURE }));
  const [piece] = inkPieces(pts, WIDTH, ASPECT);
  return newInk({ id, color, createdAt: NOW }, piece, WIDTH);
}
const band = (id: string, x: number, y: number, w: number, h: number): HighlightItem => ({
  id,
  type: 'highlight',
  color: 'yellow',
  createdAt: NOW,
  updatedAt: NOW,
  rect: { x, y, w, h },
});
const rect = (id: string): RectItem => ({ id, type: 'rect', color: 'yellow', createdAt: NOW, updatedAt: NOW, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } });

/** A horizontal line across the middle, and a diagonal. */
const LINE = stroke('an-00000000000a', [
  [0.2, 0.5],
  [0.6, 0.5],
]);
const DIAGONAL = stroke('an-00000000000b', [
  [0.2, 0.2],
  [0.6, 0.6],
]);

describe('pressPlan under 펜 / 지우개: the kind of pointer decides', () => {
  const press = (patch: Partial<PressInput>) =>
    pressPlan({ tool: 'pen', target: { kind: 'other' }, item: null, selected: false, touch: false, ...patch }).kind;

  test('a stylus or the mouse writes, over existing items too; a finger does nothing (the browser scrolls) unless fingerInk', () => {
    assert.equal(press({ pointerType: 'pen', touch: true }), 'ink');
    assert.equal(press({ pointerType: 'mouse' }), 'ink');
    assert.equal(press({ pointerType: 'pen', touch: true, item: LINE }), 'ink', 'no select / move under the pen');
    assert.equal(press({ pointerType: 'mouse', item: band('an-00000000000c', 0, 0, 1, 1), selected: true, shift: true }), 'ink');
    assert.equal(press({ pointerType: 'touch', touch: true }), 'ignore');
    assert.equal(press({ pointerType: 'touch', touch: true, item: LINE }), 'ignore');
    assert.equal(press({ pointerType: 'touch', touch: true, fingerInk: true }), 'ink');
    // Without a pointer type: touch → a finger.
    assert.equal(press({ touch: true }), 'ignore');
  });

  test("a pen's eraser end (buttons 32) or barrel button (2) erases under 펜; the mouse's buttons do not", () => {
    assert.equal(press({ pointerType: 'pen', touch: true, buttons: 32 }), 'erase');
    assert.equal(press({ pointerType: 'pen', touch: true, buttons: 2 }), 'erase');
    assert.equal(press({ pointerType: 'pen', touch: true, buttons: 1 }), 'ink');
    assert.equal(press({ pointerType: 'mouse', buttons: 2 }), 'ink');
  });

  test('지우개: a stylus or the mouse erases, a finger only with fingerInk', () => {
    assert.equal(press({ tool: 'eraser', pointerType: 'pen', touch: true }), 'erase');
    assert.equal(press({ tool: 'eraser', pointerType: 'mouse', item: LINE }), 'erase');
    assert.equal(press({ tool: 'eraser', pointerType: 'touch', touch: true }), 'ignore');
    assert.equal(press({ tool: 'eraser', pointerType: 'touch', touch: true, fingerInk: true }), 'erase');
  });

  test('handles and markers keep their meaning; the other tools do not care about the pen', () => {
    assert.equal(press({ pointerType: 'pen', touch: true, target: { kind: 'handle', handle: 'se' }, item: LINE }), 'resize');
    assert.equal(press({ pointerType: 'pen', touch: true, target: { kind: 'marker' } }), 'ignore');
    assert.equal(press({ tool: 'rect', pointerType: 'pen', touch: true, item: LINE }), 'select');
    assert.equal(press({ tool: 'select', pointerType: 'pen', touch: true, buttons: 32 }), 'region');
  });
});

describe('a sample of a pointer event', () => {
  test('the pressure only from a pen that reports one, else the nominal width', () => {
    assert.equal(inkPressure('pen', 0.8), 0.8);
    assert.equal(inkPressure('pen', 0), NO_PRESSURE);
    assert.equal(inkPressure('mouse', 0.5), NO_PRESSURE);
    assert.equal(inkPressure('touch', 0.9), NO_PRESSURE);
  });

  test('the coalesced events when there are any, else the event itself', () => {
    type Fake = { id: number; getCoalescedEvents?: () => Fake[] };
    const a: Fake = { id: 1 };
    const b: Fake = { id: 2 };
    assert.deepEqual(inkSamples<Fake>({ id: 0, getCoalescedEvents: () => [a, b] }), [a, b]);
    const plain: Fake = { id: 3 };
    assert.deepEqual(inkSamples(plain), [plain]);
    const empty: Fake = { id: 4, getCoalescedEvents: () => [] };
    assert.deepEqual(inkSamples(empty), [empty]);
  });

  test("the image's aspect through a letterbox frame", () => {
    assert.ok(Math.abs(imageAspectOf(4 / 3, FULL_FRAME) - 4 / 3) < 1e-9);
    assert.ok(Math.abs(imageAspectOf(4 / 3, imageFrame(4 / 3, ASPECT)) - ASPECT) < 1e-9);
  });
});

describe('hit testing a stroke', () => {
  const slop = slopFor(SIZE, false); // 4 px; the stroke's widest half width is 0.005 × 900 × 1.5 / 2 ≈ 3.4 px

  test('near its centre line (slack + half width), never in the rest of its box', () => {
    assert.equal(itemHit(LINE, { x: 0.4, y: 0.5 }, slop), true);
    assert.equal(itemHit(LINE, { x: 0.4, y: 0.5 + 6 / 900 }, slop), true);
    assert.equal(itemHit(LINE, { x: 0.4, y: 0.5 + 10 / 900 }, slop), false);
    assert.equal(itemHit(DIAGONAL, { x: 0.4, y: 0.4 }, slop), true);
    assert.equal(itemHit(DIAGONAL, { x: 0.55, y: 0.25 }, slop), false, 'inside its bounding box, far from the line');
    assert.equal(itemHit(DIAGONAL, { x: 0.55, y: 0.25 }, slop, false), false, 'selected or not');
  });

  test('a stroke beats the band under it (it covers almost nothing); off the line the band is hit', () => {
    const under = band('an-00000000000c', 0.1, 0.45, 0.6, 0.1);
    assert.equal(itemArea(LINE), 0);
    assert.equal(hitTestItems([LINE, under], { x: 0.4, y: 0.5 }, slop)?.id, LINE.id);
    assert.equal(hitTestItems([under, LINE], { x: 0.4, y: 0.5 }, slop)?.id, LINE.id);
    assert.equal(hitTestItems([LINE, under], { x: 0.4, y: 0.53 }, slop)?.id, under.id);
  });

  test('the marquee takes a stroke by its box', () => {
    // Far from the diagonal's line but inside its box: taken.
    assert.deepEqual(marqueeSelect([LINE, DIAGONAL], { x: 0.5, y: 0.22, w: 0.05, h: 0.05 }), [DIAGONAL.id]);
    assert.deepEqual(marqueeSelect([LINE, DIAGONAL], { x: 0.5, y: 0.49, w: 0.05, h: 0.02 }), [LINE.id, DIAGONAL.id]);
    assert.deepEqual(marqueeSelect([LINE, DIAGONAL], { x: 0.7, y: 0.7, w: 0.05, h: 0.05 }), []);
  });
});

describe('지우개: the strokes a move touches', () => {
  const box = { w: SIZE.width, h: SIZE.height };
  const under = band('an-00000000000c', 0.1, 0.45, 0.6, 0.1);

  test('a move across a stroke erases it; only strokes are erased', () => {
    assert.deepEqual(eraserHits([LINE, under, DIAGONAL], { x: 0.3, y: 0.45 }, { x: 0.3, y: 0.55 }, box), [LINE.id]);
    assert.deepEqual(eraserHits([LINE, DIAGONAL], { x: 0.25, y: 0.1 }, { x: 0.45, y: 0.6 }, box), [LINE.id, DIAGONAL.id]);
    assert.deepEqual(eraserHits([LINE, under], { x: 0.3, y: 0.4 }, { x: 0.35, y: 0.45 }, box), []);
  });

  test('a tap within the eraser radius (8 px) plus the half width', () => {
    assert.deepEqual(eraserHits([LINE], { x: 0.4, y: 0.5 + 10 / 900 }, { x: 0.4, y: 0.5 + 10 / 900 }, box), [LINE.id]);
    assert.deepEqual(eraserHits([LINE], { x: 0.4, y: 0.5 + 14 / 900 }, { x: 0.4, y: 0.5 + 14 / 900 }, box), []);
  });

  test('strokes erased already and strokes not drawn now (replay) are left out', () => {
    const a = { x: 0.3, y: 0.45 };
    const b = { x: 0.3, y: 0.55 };
    assert.deepEqual(eraserHits([LINE], a, b, box, { skip: new Set([LINE.id]) }), []);
    assert.deepEqual(eraserHits([LINE], a, b, box, { visible: () => false }), []);
  });
});

describe('a stroke as items', () => {
  const doc = (items: SlideAnnotations['items']): SlideAnnotations => ({ ...emptySlideAnnotations(1), items });

  test('moved, resized, recolored and re-widthed by update; its points are never patched', () => {
    let d = doc([LINE]);
    const moved = moveItems([LINE], 0.1, -0.1)[LINE.id].rect!;
    d = applyOps(d, [{ op: 'update', id: LINE.id, patch: { rect: moved, color: 'red', width: INK_WIDTHS[2], pts: 'AAAAA' } as never }]);
    const item = d.items[0] as InkItem;
    assert.deepEqual(item.rect, moved);
    assert.equal(item.color, 'red');
    assert.equal(item.width, INK_WIDTHS[2]);
    assert.equal(item.pts, LINE.pts);
    // The points follow the rect.
    assert.ok(Math.abs(inkPointsOf(item)[0].x - (inkPointsOf(LINE)[0].x + 0.1)) < 1e-3);
    const resized = resizeRect(item.rect, 'se', 0.1, 0.1);
    assert.ok(resized.w > item.rect.w);
  });

  test('strokes are counted apart from MAX_ANNOTATION_ITEMS', () => {
    const rects = Array.from({ length: MAX_ANNOTATION_ITEMS }, (_, i) => rect(`an-${String(i).padStart(12, '0')}`));
    const full = doc(rects);
    assert.equal(canAddItems(full, [{ op: 'add', item: LINE }]), true);
    assert.equal(canAddItems(doc([...rects, LINE]), [{ op: 'add', item: rect('an-ffffffffffff') }]), false);
    assert.equal(canAddItems(doc([...rects, LINE]), [{ op: 'remove', id: LINE.id }, { op: 'add', item: rect('an-ffffffffffff') }]), false);
  });

  test('a 📎 of handwriting is labelled as such', () => {
    assert.equal(attachmentLabel({ kind: 'region', slide: 12, annotation: { id: LINE.id, type: 'ink' } }), 'p.12 손글씨');
  });

  test('빠진 슬라이드: a slide’s strokes are one row', () => {
    const rows = removedRows([LINE, band('an-00000000000c', 0, 0, 0.1, 0.1), DIAGONAL]);
    assert.deepEqual(
      rows.map((r) => [r.text, r.color, r.ink]),
      [
        ['형광', 'yellow', false],
        ['손글씨 2획', 'black', true],
      ],
    );
  });
});

describe('rendering a stroke (AnnotationLayer)', () => {
  const layer = (props: { aspect?: number; frame?: typeof FULL_FRAME; selectedIds?: string[] | null; drag?: Record<string, { rect: InkItem['rect'] }> | null }) =>
    renderToStaticMarkup(
      createElement(AnnotationLayer, {
        slide: 1,
        frame: props.frame ?? FULL_FRAME,
        aspect: props.aspect ?? ASPECT,
        doc: { ...emptySlideAnnotations(1), items: [LINE] },
        markers: null,
        selectedIds: props.selectedIds ?? null,
        editingId: null,
        draft: null,
        drag: props.drag ?? null,
        tool: 'select',
        replay: null,
      }),
    );

  test('a filled path in a nested <svg> whose viewBox has the image’s aspect', () => {
    const html = layer({});
    assert.match(html, /<svg x="0" y="0" width="1000" height="1000" viewBox="0 0 1777\.8 1000" preserveAspectRatio="none"/);
    assert.match(html, new RegExp(`<path class="annot-shape kind-ink is-black" data-annot="item" data-id="${LINE.id}" d="M[^"]+Z"`));
    assert.equal(html.includes(`d="${inkPathOf(LINE, LINE.rect, 1777.8, 1000)}"`), true);
    // A 4:3 box: the image fills it; a 16:9 page letterboxed in it keeps 16:9.
    assert.match(layer({ aspect: 4 / 3 }), /viewBox="0 0 1333\.3 1000"/);
    assert.match(layer({ aspect: 4 / 3, frame: imageFrame(4 / 3, ASPECT) }), /viewBox="0 0 1777\.8 1000"/);
  });

  test('a move preview shifts the stroke’s <svg> (its outline is not computed again); a resize preview scales it', () => {
    const moved = { ...LINE.rect, x: LINE.rect.x + 0.2, y: LINE.rect.y - 0.1 };
    const html = layer({ drag: { [LINE.id]: { rect: moved } } });
    assert.match(html, /<svg x="200" y="-100" width="1000" height="1000" viewBox="0 0 1777\.8 1000"/);
    assert.equal(html.includes(`d="${inkPathOf(LINE, LINE.rect, 1777.8, 1000)}"`), true, 'the outline at its own place');
    const resized = { ...LINE.rect, w: LINE.rect.w * 1.5 };
    const scaled = layer({ drag: { [LINE.id]: { rect: resized } } });
    assert.match(scaled, /<svg x="0" y="0" width="1000"/);
    assert.equal(scaled.includes(`d="${inkPathOf(LINE, resized, 1777.8, 1000)}"`), true);
    assert.notEqual(inkPathOf(LINE, resized, 1777.8, 1000), inkPathOf(LINE, LINE.rect, 1777.8, 1000));
  });

  test('one stroke selected: its box; several: ONE dashed box around all of them, not one per stroke', () => {
    const many = (selectedIds: string[] | null, drag: Record<string, { rect: InkItem['rect'] }> | null = null) =>
      renderToStaticMarkup(
        createElement(AnnotationLayer, {
          slide: 1,
          frame: FULL_FRAME,
          aspect: ASPECT,
          doc: { ...emptySlideAnnotations(1), items: [LINE, DIAGONAL] },
          markers: null,
          selectedIds,
          editingId: null,
          draft: null,
          drag,
          tool: 'select',
          replay: null,
        }),
      );
    const boxes = (html: string) => [...html.matchAll(/<rect class="annot-ink-box" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)].map((m) => m.slice(1).map(Number));
    assert.deepEqual(boxes(many(null)), []);
    const r = LINE.rect;
    assert.deepEqual(boxes(many([LINE.id])), [[r.x, r.y, r.w, r.h].map((v) => Number((v * 1000).toFixed(1)))]);
    const both = boxes(many([LINE.id, DIAGONAL.id]));
    assert.equal(both.length, 1);
    const x0 = Math.min(LINE.rect.x, DIAGONAL.rect.x);
    const y0 = Math.min(LINE.rect.y, DIAGONAL.rect.y);
    const x1 = Math.max(LINE.rect.x + LINE.rect.w, DIAGONAL.rect.x + DIAGONAL.rect.w);
    const y1 = Math.max(LINE.rect.y + LINE.rect.h, DIAGONAL.rect.y + DIAGONAL.rect.h);
    assert.ok(Math.abs(both[0][0] - x0 * 1000) < 0.2 && Math.abs(both[0][1] - y0 * 1000) < 0.2);
    assert.ok(Math.abs(both[0][2] - (x1 - x0) * 1000) < 0.2 && Math.abs(both[0][3] - (y1 - y0) * 1000) < 0.2);
    // Moved together: the box follows the preview.
    const moved = boxes(many([LINE.id, DIAGONAL.id], { [LINE.id]: { rect: { ...LINE.rect, x: LINE.rect.x + 0.1 } }, [DIAGONAL.id]: { rect: { ...DIAGONAL.rect, x: DIAGONAL.rect.x + 0.1 } } }));
    assert.ok(Math.abs(moved[0][0] - (x0 + 0.1) * 1000) < 0.2);
  });

  test('a marquee over thousands of strokes: the selection union (a Set) keeps the order, without duplicates', () => {
    const ids = Array.from({ length: 3000 }, (_, i) => `an-${String(i).padStart(12, '0')}`);
    assert.deepEqual(unionIds(ids.slice(0, 1500), ids), ids);
    assert.deepEqual(unionIds(['b', 'a'], ['a', 'c', 'c']), ['b', 'a', 'c']);
  });
});

describe('the pointer and touch events of 펜 / 지우개', () => {
  test('an Apple Pencil after a palm (iPadOS: not the primary pointer) still writes; a second finger or a mouse’s other button does not', () => {
    assert.equal(acceptsPress({ isPrimary: false, pointerType: 'pen', button: 0 }), true);
    assert.equal(acceptsPress({ isPrimary: true, pointerType: 'pen', button: 0 }), true);
    assert.equal(acceptsPress({ isPrimary: false, pointerType: 'touch', button: 0 }), false);
    assert.equal(acceptsPress({ isPrimary: true, pointerType: 'touch', button: 0 }), true);
    assert.equal(acceptsPress({ isPrimary: true, pointerType: 'mouse', button: 0 }), true);
    assert.equal(acceptsPress({ isPrimary: true, pointerType: 'mouse', button: 2 }), false);
  });

  const touch = (patch: Partial<InkTouch>): boolean => blocksInkTouch({ type: 'touchstart', stroke: false, stylus: false, control: false, active: false, ...patch });

  test('a stylus never scrolls the slides, but its tap on a control (badge, marker, memo card, menu) is not swallowed', () => {
    assert.equal(touch({ stylus: true }), true);
    assert.equal(touch({ stylus: true, type: 'touchmove' }), true);
    assert.equal(touch({ stylus: true, control: true }), false, 'the touchstart reaches the button');
    assert.equal(touch({ stylus: true, control: true, type: 'touchmove' }), true);
    // During a stroke every touch is blocked, on a control too (a palm put down meanwhile).
    assert.equal(touch({ stroke: true, control: true }), true);
    assert.equal(touch({ stroke: true, type: 'touchmove' }), true);
    // A finger scrolls, unless a gesture is live.
    assert.equal(touch({}), false);
    assert.equal(touch({ type: 'touchmove' }), false);
    assert.equal(touch({ type: 'touchmove', active: true }), true);
  });

  test('what counts as a control', () => {
    const at = (match: string | null) => ({ closest: (selector: string) => (match !== null && selector.split(',').map((x) => x.trim()).includes(match) ? {} : null) });
    for (const sel of ['button', 'a', 'input', 'textarea', 'select', '[data-annot="memo"]', '[data-annot="marker"]', '.memo-card', '.region-menu', '.annot-pop', '.link-picker', '.popover-menu']) {
      assert.equal(onInkControl(at(sel)), true, sel);
    }
    assert.equal(onInkControl(at(null)), false);
    assert.equal(onInkControl(null), false);
    assert.equal(onInkControl({}), false);
  });

  test('a stroke cancelled before it went 12 px (an S Pen fling Chrome made a scroll) is dropped; a longer one is kept', () => {
    assert.equal(INK_CANCEL_SLOP_PX, 12);
    assert.equal(keepsCancelledStroke(0), false);
    assert.equal(keepsCancelledStroke(11.9), false);
    assert.equal(keepsCancelledStroke(12), true);
    assert.equal(keepsCancelledStroke(80), true);
  });
});

describe('the toolbar and the item menu under 펜', () => {
  const toolbar = (tool: 'pen' | 'eraser' | 'highlight', fingerInk = false, history: { canUndo: boolean; canRedo: boolean } | null = null) =>
    renderToStaticMarkup(
      createElement(AnnotationTools, {
        ...(history ? { history: { ...history, onUndo: () => {}, onRedo: () => {} } } : {}),
        tool,
        onTool: () => {},
        color: 'yellow',
        onColor: () => {},
        layerShown: true,
        onLayerShown: () => {},
        markersShown: true,
        onMarkersShown: () => {},
        filter: { onlyAnnotated: false, tag: null },
        onFilter: () => {},
        tags: [],
        shownCount: null,
        pageCount: 10,
        replayAvailable: false,
        replayOn: false,
        onReplayOn: () => {},
        replaying: false,
        compact: false,
        inkColor: 'red',
        onInkColor: () => {},
        inkWidth: INK_WIDTHS[2],
        onInkWidth: () => {},
        fingerInk,
        onFingerInk: () => {},
      }),
    );

  test('펜 and 지우개 follow 범위 선택; under 펜 the ink colors, the three widths and 손가락으로도 쓰기', () => {
    const html = toolbar('pen');
    const titles = [...html.matchAll(/class="annot-tool[^"]*"[^>]*title="([^"]+?):/g)].map((m) => m[1]);
    assert.deepEqual(titles.slice(0, 4), ['선택·첨부', '범위 선택', '펜', '지우개']);
    assert.ok(html.includes('aria-label="펜 색"'));
    for (const name of ['검정', '파랑', '빨강', '초록']) assert.ok(html.includes(`aria-label="${name}"`), name);
    assert.equal(html.includes('aria-label="노랑"'), false);
    assert.match(html, /class="annot-dot is-ink is-red is-active" aria-pressed="true"/);
    assert.match(html, /aria-pressed="true" aria-label="굵게"/);
    assert.match(html, /aria-pressed="false" aria-label="가늘게"/);
    assert.match(html, /aria-pressed="false" aria-label="손가락으로도 쓰기"/);
    assert.match(toolbar('pen', true), /aria-pressed="true" aria-label="손가락으로도 쓰기"/);
  });

  test('지우개 keeps 손가락으로도 쓰기 (no widths); the other tools keep the highlighter colors', () => {
    const eraser = toolbar('eraser');
    assert.ok(eraser.includes('aria-label="손가락으로도 쓰기"'));
    assert.equal(eraser.includes('aria-label="펜 굵기"'), false);
    const highlight = toolbar('highlight');
    assert.ok(highlight.includes('aria-label="노랑"'));
    assert.equal(highlight.includes('aria-label="검정"'), false);
    assert.equal(highlight.includes('손가락으로도 쓰기'), false);
  });

  test('되돌리기 / 다시 실행 under 펜 and 지우개 (a tablet has no ⌘Z), disabled while there is nothing to undo / redo', () => {
    const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? null;
    const pen = toolbar('pen', false, { canUndo: true, canRedo: false });
    assert.ok(pen.includes('aria-label="되돌리기·다시 실행"'));
    assert.ok(button(pen, '되돌리기'));
    assert.equal(button(pen, '되돌리기')!.includes('disabled'), false);
    assert.equal(button(pen, '다시 실행')!.includes('disabled'), true);
    assert.match(button(pen, '되돌리기')!, /title="되돌리기: [^"]*⌘Z/);
    const eraser = toolbar('eraser', false, { canUndo: false, canRedo: true });
    assert.equal(button(eraser, '되돌리기')!.includes('disabled'), true);
    assert.equal(button(eraser, '다시 실행')!.includes('disabled'), false);
    // Not under the other tools (they have the keyboard's ⌘Z); not without the viewer's history.
    assert.equal(button(toolbar('highlight', false, { canUndo: true, canRedo: true }), '되돌리기'), null);
    assert.equal(button(toolbar('pen'), '되돌리기'), null);
  });

  test('the tools fold when the toolbar has no room for them, and come back only with room to spare', () => {
    let state = { fold: false, need: 0 };
    // Wide and fitting: nothing changes (the same object: no re-render).
    assert.equal(foldTools(state, { width: 900, overflow: -40 }), state);
    // 펜's buttons pass the edge by 60 px at 760 px: folded, remembering the 820 px it needed.
    state = foldTools(state, { width: 760, overflow: 60 });
    assert.deepEqual(state, { fold: true, need: 820 });
    // Folded: not back at 830 px (within the slack) — no flapping at the edge …
    assert.equal(foldTools(state, { width: 830, overflow: -300 }), state);
    // … but with the slack.
    assert.deepEqual(foldTools(state, { width: 820 + TOOLS_FOLD_SLACK_PX, overflow: -300 }), { fold: false, need: 820 });
    // What the toolbar holds changed while folded (need unknown): the wide toolbar is tried again.
    assert.deepEqual(foldTools({ fold: true, need: 0 }, { width: 700, overflow: 0 }), { fold: false, need: 0 });
  });

  test('the hints', () => {
    assert.equal(toolHint('pen'), '펜: Apple Pencil·마우스로 쓰기 · 손가락은 스크롤');
    assert.equal(toolHint('pen', true), '펜: 펜·손가락·마우스로 쓰기 · Esc');
    assert.equal(toolHint('eraser'), '지우개: 지나간 펜 획을 지워요');
  });

  const env: LayerEnv = {
    docId: 'doc-1',
    actions: new Proxy({}, { get: () => () => {} }) as LayerEnv['actions'],
    docs: [],
    focusedSlide: 1,
    pageCount: 10,
    tags: [],
    compact: false,
    trackWidth: 800,
  };
  const inLayer = (node: ReactNode) => renderToStaticMarkup(createElement(LayerContext.Provider, { value: env }, node));

  test('the item menu of strokes: the ink colors and widths, 첨부, 삭제; a mix with other items gets no colors', () => {
    const one = inLayer(createElement(ItemMenu, { slide: 1, items: [LINE], questions: 0 }));
    assert.ok(one.includes('aria-label="검정"'));
    assert.equal(one.includes('aria-label="노랑"'), false);
    assert.match(one, /aria-pressed="true" aria-label="보통"/);
    assert.ok(one.includes('첨부'));
    assert.ok(one.includes('삭제'));
    assert.equal(one.includes('글자 크기'), false);
    const mixed = inLayer(createElement(ItemMenu, { slide: 1, items: [LINE, band('an-00000000000c', 0, 0, 0.1, 0.1)], questions: 0 }));
    assert.equal(mixed.includes('annot-dot'), false);
    assert.equal(mixed.includes('aria-label="펜 굵기"'), false);
  });
});

describe('the per-device 펜 settings', () => {
  test('black, the medium width, fingers scroll — by default; only ink colors and the offered widths are taken', () => {
    assert.equal(getInkColor(), 'black');
    assert.equal(getInkWidth(), INK_WIDTHS[1]);
    assert.equal(getFingerInk(), false);
    setInkColor('yellow');
    setInkWidth(0.004);
    assert.equal(getInkColor(), 'black');
    assert.equal(getInkWidth(), INK_WIDTHS[1]);
    setInkColor('red');
    setInkWidth(INK_WIDTHS[0]);
    assert.equal(getInkColor(), 'red');
    assert.equal(getInkWidth(), INK_WIDTHS[0]);
  });
});

describe('the ink swatches in dark mode', () => {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const tokenBlocks = (text: string) => [...text.matchAll(/--ink-black: #[0-9a-f]+;[\s\S]*?\n\s*\}/g)].map((m) => m[0]);

  test('the black dot and the 손글씨 row’s bar get an edge, light in both dark token blocks; the active ring still wins', () => {
    const blocks = tokenBlocks(css);
    assert.equal(blocks.length, 3, 'light, dark by the system, dark by data-theme');
    assert.match(blocks[0], /--ink-swatch-edge: rgba\(0, 0, 0,/);
    for (const dark of blocks.slice(1)) assert.match(dark, /--ink-swatch-edge: rgba\(255, 255, 255, 0\.[3-9]/);
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      assert.ok(at !== -1, selector);
      return { at, body: css.slice(at, css.indexOf('}', at)) };
    };
    const black = rule('.annot-dot.is-ink.is-black');
    assert.match(black.body, /box-shadow: inset 0 0 0 1px var\(--ink-swatch-edge\)/);
    assert.match(rule('.removed-item.kind-ink.is-black .memo-row-bar').body, /var\(--ink-swatch-edge\)/);
    const active = rule('.annot-dot.is-ink.is-active');
    assert.ok(active.at > black.at, 'the active ring (same specificity) comes later');
    assert.match(active.body, /box-shadow: 0 0 0 2px var\(--text\)/);
  });
});
