// Attachments of a question (DESIGN §21): selection geometry on the slides, what a drop / paste / pick contains,
// the composer's chips, and the API calls. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { MAX_ATTACHMENTS, type Attachment, type ContextInfo } from '../../shared/types.ts';
import { attachmentUrl, createRegion, deleteAttachment, missingAttachmentsOf, sendMessage, uploadAttachment } from '../src/api.ts';
import {
  attachErrorMessage,
  attachmentLabel,
  attachmentTitle,
  chipsReducer,
  classifyDragTypes,
  classifyFiles,
  clipboardImages,
  defaultQuestion,
  dropOverlayCopy,
  FULL_FRAME,
  framePixels,
  freeSlots,
  imageContentType,
  imageFrame,
  isGenericPastedName,
  isUploading,
  limitMessage,
  menuPlacement,
  MIN_REGION_PX,
  missingAttachmentsMessage,
  movedBeyond,
  percentStyle,
  planDrop,
  readyAttachments,
  rectInBox,
  regionFromPoints,
  roundRect,
  toImagePoint,
  withoutAttachments,
  type Box,
  type Chip,
  type ChipState,
  type Frame,
} from '../src/lib/attachments.ts';
import { applyAuthStatus, resetAuthForTests } from '../src/lib/auth.ts';
import { describeContext } from '../src/lib/format.ts';

/** Drag on a slide box from (fx0, fy0) to (fx1, fy1) — fractions of the image — as the viewer does. */
function drag(box: Box, frame: Frame, from: [number, number], to: [number, number], minPx = MIN_REGION_PX) {
  const client = ([fx, fy]: [number, number]) => [
    box.left + (frame.x + fx * frame.w) * box.width,
    box.top + (frame.y + fy * frame.h) * box.height,
  ];
  const [x0, y0] = client(from);
  const [x1, y1] = client(to);
  const a = toImagePoint(x0, y0, box, frame);
  const b = toImagePoint(x1, y1, box, frame);
  return regionFromPoints(a, b, framePixels(box, frame), minPx);
}

describe('selection geometry', () => {
  // The same 16:9 slide at "맞춤" in a narrow pane, zoomed out to 50 %, and zoomed in to 300 % (scrolled far).
  const boxes: Box[] = [
    { left: 100, top: 50, width: 800, height: 450 },
    { left: 300, top: 120, width: 400, height: 225 },
    { left: -900, top: -2600, width: 2400, height: 1350 },
  ];

  test('the rectangle is normalised: the same selection at every zoom level gives the same rect', () => {
    const rects = boxes.map((box) => drag(box, FULL_FRAME, [0.25, 0.3], [0.6, 0.72]));
    assert.deepEqual(rects[0], { x: 0.25, y: 0.3, w: 0.35, h: 0.42 });
    for (const r of rects) assert.deepEqual(r, rects[0]);
  });

  test('any drag direction gives the same rectangle', () => {
    const box = boxes[0];
    const down = drag(box, FULL_FRAME, [0.1, 0.2], [0.5, 0.6]);
    assert.deepEqual(drag(box, FULL_FRAME, [0.5, 0.6], [0.1, 0.2]), down);
    assert.deepEqual(drag(box, FULL_FRAME, [0.1, 0.6], [0.5, 0.2]), down);
  });

  test('a drag past the edge of the slide stops at the edge', () => {
    const box = boxes[0];
    const a = toImagePoint(box.left + 400, box.top + 200, box);
    const b = toImagePoint(box.left + box.width + 300, box.top - 80, box);
    assert.deepEqual(b, { x: 1, y: 0 });
    const r = regionFromPoints(a, b, framePixels(box));
    assert.equal(r.x + r.w, 1);
    assert.equal(r.y, 0);
  });

  test('a page shaped unlike page 1 is letterboxed: the rect is relative to the image, not the box', () => {
    // A 4:3 page in a 16:9 box: bands left and right.
    const frame = imageFrame(16 / 9, 4 / 3);
    assert.equal(frame.y, 0);
    assert.equal(frame.h, 1);
    assert.ok(Math.abs(frame.w - 0.75) < 1e-9);
    assert.ok(Math.abs(frame.x - 0.125) < 1e-9);
    const rects = boxes.map((box) => drag(box, frame, [0, 0], [1, 1], 0));
    for (const r of rects) assert.deepEqual(r, { x: 0, y: 0, w: 1, h: 1 });
    // A press on the band left of the image lands on the image's left edge.
    assert.equal(toImagePoint(boxes[0].left + 10, boxes[0].top + 100, boxes[0], frame).x, 0);
    // A wide page in a 4:3 box: bands above and below.
    const wide = imageFrame(4 / 3, 16 / 9);
    assert.equal(wide.x, 0);
    assert.ok(Math.abs(wide.h - 0.75) < 1e-9);
    // Where to draw a rect inside the box (and its CSS).
    assert.deepEqual(rectInBox({ x: 0, y: 0, w: 1, h: 1 }, frame), frame);
    assert.deepEqual(percentStyle({ x: 0.125, y: 0, w: 0.75, h: 1 }), {
      left: '12.500%',
      top: '0.000%',
      width: '75.000%',
      height: '100.000%',
    });
  });

  test('the image frame ignores tiny differences and unknown sizes', () => {
    assert.deepEqual(imageFrame(16 / 9, null), FULL_FRAME);
    assert.deepEqual(imageFrame(16 / 9, 1600 / 901), FULL_FRAME); // rounding of the rendered PNG
    assert.deepEqual(imageFrame(0, 1.5), FULL_FRAME);
    assert.deepEqual(imageFrame(1.5, Number.NaN), FULL_FRAME);
  });

  test('a thin drag (along one line of text) grows to a minimum size on screen, centered, inside the image', () => {
    const box = boxes[0]; // 800 × 450
    const r = drag(box, FULL_FRAME, [0.2, 0.5], [0.7, 0.5]);
    assert.equal(r.w, 0.5);
    assert.ok(Math.abs(r.h * 450 - MIN_REGION_PX) < 0.1, `height ${r.h * 450}px`);
    assert.ok(Math.abs(r.y + r.h / 2 - 0.5) < 1e-3);
    // At the bottom edge it grows upwards instead of leaving the image.
    const edge = drag(box, FULL_FRAME, [0.2, 1], [0.7, 1]);
    assert.ok(edge.y + edge.h <= 1);
    assert.ok(edge.h * 450 >= MIN_REGION_PX - 0.1);
    // Zoomed in, the same minimum is fewer percent of the slide.
    const zoomed = drag(boxes[2], FULL_FRAME, [0.2, 0.5], [0.7, 0.5]);
    assert.ok(zoomed.h < r.h);
  });

  test('rounded rects never leave the image and never collapse', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      const x = rand();
      const y = rand();
      const r = roundRect({ x, y, w: rand() * (1 - x), h: rand() * (1 - y) });
      assert.ok(r.x >= 0 && r.y >= 0, JSON.stringify(r));
      assert.ok(r.w > 0 && r.h > 0, JSON.stringify(r));
      assert.ok(r.x + r.w <= 1 && r.y + r.h <= 1, JSON.stringify(r));
      for (const v of [r.x, r.y, r.w, r.h]) assert.equal(Math.round(v * 1e4) / 1e4, v);
    }
    assert.deepEqual(roundRect({ x: 1, y: 1, w: 0, h: 0 }), { x: 0.9999, y: 0.9999, w: 0.0001, h: 0.0001 });
    assert.deepEqual(roundRect({ x: 0.7, y: 0, w: 0.30000001, h: 1 }), { x: 0.7, y: 0, w: 0.3, h: 1 });
  });

  test('drag threshold and the menu placement', () => {
    assert.equal(movedBeyond({ x: 10, y: 10 }, { x: 14, y: 13 }, 6), false); // 5 px: still a click
    assert.equal(movedBeyond({ x: 10, y: 10 }, { x: 16, y: 10 }, 6), true);
    // The viewer shows 100..900 (client px); the selection's top and bottom.
    const view = { top: 100, bottom: 900 };
    assert.equal(menuPlacement({ top: 200, bottom: 400 }, view), 'below');
    assert.equal(menuPlacement({ top: 300, bottom: 880 }, view), 'above');
    assert.equal(menuPlacement({ top: 120, bottom: 880 }, view), 'inside', 'only when the viewer has no room at all');
    // Zoomed out to 50 %: a selection filling most of a small slide (slide 400..625, gaps between slides) gets its
    // menu below the slide, not over the selected content.
    assert.equal(menuPlacement({ top: 445, bottom: 580 }, view), 'below');
    // Zoomed in: the selection reaches the bottom of the viewer, the room is above it.
    assert.equal(menuPlacement({ top: 500, bottom: 1400 }, view), 'above');
    assert.equal(menuPlacement({ top: 852, bottom: 860 }, view, 40), 'above', 'needs the menu height + 8 px');
    assert.equal(menuPlacement({ top: 200, bottom: 852 }, view, 40), 'below');
  });
});

describe('what a drop, a paste or a pick contains', () => {
  const f = (name: string, type = '') => ({ name, type });

  test('PDFs become documents, images attachments, the rest is refused', () => {
    const { pdfs, images, others } = classifyFiles([
      f('lec3.pdf', 'application/pdf'),
      f('Lec4.PDF'),
      f('shot.png', 'image/png'),
      f('photo.HEIC'), // Chrome on macOS leaves the type empty
      f('scan.jpeg', 'application/octet-stream'),
      f('logo.svg', 'image/svg+xml'),
      f('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      f('README'),
      // The server takes PNG, JPEG, WebP, GIF (and HEIC/AVIF when it can): these would only be refused there.
      f('scan.bmp', 'image/bmp'),
      f('fax.tiff', 'image/tiff'),
      f('old.TIF'),
      f('icon.ico', 'image/vnd.microsoft.icon'),
      f('anim.gif', 'image/gif'),
      f('pic.webp', 'image/webp'),
      f('pic.avif', 'image/avif'),
    ]);
    assert.deepEqual(pdfs.map((x) => x.name), ['lec3.pdf', 'Lec4.PDF']);
    assert.deepEqual(images.map((x) => x.name), ['shot.png', 'photo.HEIC', 'scan.jpeg', 'anim.gif', 'pic.webp', 'pic.avif']);
    assert.deepEqual(others.map((x) => x.name), ['logo.svg', 'notes.docx', 'README', 'scan.bmp', 'fax.tiff', 'old.TIF', 'icon.ico']);
  });

  test('a drop: PDFs become lectures, images go to the open lecture’s question, the rest is explained', () => {
    const files = [f('lec5.pdf', 'application/pdf'), f('board.jpg', 'image/jpeg'), f('scan.bmp', 'image/bmp')];
    const open = planDrop(files, true);
    assert.deepEqual(open.pdfs.map((x) => x.name), ['lec5.pdf']);
    assert.deepEqual(open.images.map((x) => x.name), ['board.jpg']);
    assert.deepEqual(open.notices, [{ message: 'PDF(강의 추가)나 이미지(PNG, JPEG, WebP, GIF, 질문에 첨부)만 놓을 수 있어요: scan.bmp', kind: 'error' }]);
    // In the library (no lecture open, e.g. onto its drop zone): the image is explained, not called "not a PDF".
    const library = planDrop(files, false);
    assert.deepEqual(library.pdfs.map((x) => x.name), ['lec5.pdf']);
    assert.deepEqual(library.images, []);
    assert.deepEqual(library.notices, [
      { message: '이미지는 강의를 연 뒤 놓으면 질문에 첨부돼요', kind: 'info' },
      { message: 'PDF 파일만 올릴 수 있어요: scan.bmp', kind: 'error' },
    ]);
    assert.deepEqual(planDrop([f('a.pdf', 'application/pdf')], true).notices, []);
  });

  test('the upload Content-Type comes from the file, or its extension', () => {
    assert.equal(imageContentType(f('a.png', 'image/png')), 'image/png');
    assert.equal(imageContentType(f('a.HEIC')), 'image/heic');
    assert.equal(imageContentType(f('a.jpg', 'application/octet-stream')), 'image/jpeg');
    assert.equal(imageContentType(f('blob')), 'application/octet-stream');
  });

  test('during a drag only the MIME types are known', () => {
    assert.deepEqual(classifyDragTypes(['application/pdf']), { pdf: true, image: false, unknown: false });
    assert.deepEqual(classifyDragTypes(['image/png', 'image/jpeg']), { pdf: false, image: true, unknown: false });
    assert.deepEqual(classifyDragTypes(['image/png', '']), { pdf: false, image: true, unknown: true });
    assert.deepEqual(classifyDragTypes([]), { pdf: false, image: false, unknown: false });
    // Types the server refuses are not announced as attachable.
    assert.deepEqual(classifyDragTypes(['image/bmp']), { pdf: false, image: false, unknown: true });
    assert.deepEqual(classifyDragTypes(['image/tiff', 'image/svg+xml']), { pdf: false, image: false, unknown: true });
  });

  test('the drop overlay says what happens to PDFs and to images', () => {
    const pdf = '📄 PDF를 놓으면 업로드해요';
    const kinds = (types: string[]) => classifyDragTypes(types);
    assert.deepEqual(dropOverlayCopy(kinds(['application/pdf']), pdf, true), { title: pdf, sub: null });
    assert.deepEqual(dropOverlayCopy(kinds(['image/png']), pdf, true), {
      title: '🖼 이미지를 놓으면 질문에 첨부해요',
      sub: null,
    });
    assert.equal(dropOverlayCopy(kinds(['image/png']), pdf, false).title, '🖼 이미지는 강의를 연 뒤 놓으면 질문에 첨부돼요');
    assert.deepEqual(dropOverlayCopy(kinds(['application/pdf', 'image/png']), pdf, true), {
      title: pdf,
      sub: '🖼 이미지를 놓으면 질문에 첨부해요 (PDF는 강의 목록에 추가만 해요)',
    });
    assert.deepEqual(dropOverlayCopy(kinds(['']), pdf, true), { title: pdf, sub: '이미지는 질문에 첨부돼요' });
    assert.deepEqual(dropOverlayCopy(kinds(['']), pdf, false), { title: pdf, sub: null });
  });

  test('a paste with text stays a text paste; a screenshot is attached', () => {
    const shot = f('image.png', 'image/png');
    assert.deepEqual(clipboardImages('', [shot]), [shot]);
    assert.deepEqual(clipboardImages('  ', [shot, f('x.pdf', 'application/pdf')]), [shot]);
    // Slide programs and word processors put a picture of the copied text next to the text.
    assert.deepEqual(clipboardImages('Lemma 3.2', [shot]), []);
    assert.deepEqual(clipboardImages('', []), []);
    assert.equal(isGenericPastedName('image.png'), true);
    assert.equal(isGenericPastedName('Image.JPEG'), true);
    assert.equal(isGenericPastedName(''), true);
    assert.equal(isGenericPastedName('graph.png'), false);
  });
});

describe('labels and messages', () => {
  test('chip / thumbnail labels', () => {
    assert.equal(attachmentLabel({ kind: 'region', slide: 12 }), 'p.12 영역');
    assert.equal(attachmentLabel({ kind: 'image', name: 'graph.png' }), 'graph.png');
    assert.equal(attachmentLabel({ kind: 'image' }), '이미지');
    assert.equal(attachmentLabel({ kind: 'image', name: '  ' }), '이미지');
    assert.equal(attachmentTitle({ kind: 'region', slide: 12 }), '슬라이드 12에서 선택한 영역');
    assert.equal(attachmentTitle({ kind: 'image', name: 'a.png' }), '첨부한 이미지: a.png');
  });

  test('Enter with only attachments asks about them', () => {
    assert.equal(defaultQuestion([{ kind: 'region' }, { kind: 'region' }]), '이 부분 설명해줘');
    assert.equal(defaultQuestion([{ kind: 'region' }, { kind: 'image' }]), '첨부한 이미지 설명해줘');
    assert.equal(defaultQuestion([{ kind: 'image' }]), '첨부한 이미지 설명해줘');
  });

  test('refusals are explained', () => {
    assert.equal(attachErrorMessage(413, 'Payload Too Large'), '이미지가 너무 커요 (최대 10 MB)');
    assert.equal(attachErrorMessage(413, '첨부 실패 (HTTP 413)'), '이미지가 너무 커요 (최대 10 MB)', 'a proxy’s 413');
    // The server says why: too many pixels is not "damaged", nor "over 10 MB".
    const pixels = '이미지 해상도가 너무 커서 처리할 수 없습니다. 스크린샷이나 더 작은 이미지로 올려 주세요';
    assert.equal(attachErrorMessage(413, pixels), pixels);
    assert.equal(attachErrorMessage(413, '이미지가 너무 큽니다 (최대 10 MB)'), '이미지가 너무 큽니다 (최대 10 MB)');
    assert.equal(attachErrorMessage(415, 'HEIC 이미지는 이 컴퓨터에서 읽을 수 없어요'), 'HEIC 이미지는 이 컴퓨터에서 읽을 수 없어요');
    assert.match(attachErrorMessage(415, ''), /지원하지 않는 이미지 형식/);
    assert.equal(attachErrorMessage(409, '문서를 아직 처리하는 중입니다'), '문서를 아직 처리하는 중입니다');
    assert.equal(attachErrorMessage(409, ''), '문서가 아직 준비되지 않았어요');
    assert.equal(attachErrorMessage(0, ''), '서버에 연결할 수 없어요');
    assert.equal(attachErrorMessage(400, '영역이 올바르지 않습니다'), '영역이 올바르지 않습니다');
    assert.equal(limitMessage(0), `한 질문에 최대 ${MAX_ATTACHMENTS}개까지 첨부할 수 있어요`);
    assert.equal(limitMessage(2), `한 질문에 최대 ${MAX_ATTACHMENTS}개까지 첨부할 수 있어요 (2개는 첨부하지 않았어요)`);
  });

  test('the context line counts the attachments sent with a question', () => {
    const ctx: ContextInfo = { primed: false, rollover: false, attachedSlides: [7], reusedSlides: [], overviewImages: 0 };
    assert.deepEqual(
      describeContext({ ...ctx, attachments: 2 }).map((c) => c.text),
      ['🖼 p.7 첨부', '📎 첨부 2개'],
    );
    assert.deepEqual(describeContext({ ...ctx, attachments: 0 }).map((c) => c.kind), ['attached']);
  });
});

describe('composer chips', () => {
  const att = (id: string, patch: Partial<Attachment> = {}): Attachment => ({
    id,
    kind: 'image',
    width: 800,
    height: 600,
    createdAt: '2026-09-26T00:00:00.000Z',
    ...patch,
  });
  const chip = (key: string, patch: Partial<Chip> = {}): Chip => ({
    key,
    kind: 'image',
    label: `${key}.png`,
    title: '',
    status: 'uploading',
    progress: 0,
    ...patch,
  });
  const run = (state: ChipState, ...actions: Parameters<typeof chipsReducer>[1][]) =>
    actions.reduce(chipsReducer, state);
  const empty: ChipState = { docId: 'lec', items: [] };

  test('upload progress, then the server copy', () => {
    let s = run(empty, { type: 'add', item: chip('a', { localUrl: 'blob:a' }) });
    assert.equal(isUploading(s.items), true);
    s = run(s, { type: 'progress', key: 'a', fraction: 0.4 });
    assert.equal(s.items[0].progress, 0.4);
    assert.equal(run(s, { type: 'progress', key: 'a', fraction: 0.4 }), s, 'no change, same state');
    assert.equal(run(s, { type: 'progress', key: 'nope', fraction: 0.9 }), s);
    s = run(s, { type: 'ready', key: 'a', attachment: att('att-1', { name: 'graph.png' }) });
    assert.equal(isUploading(s.items), false);
    assert.equal(s.items[0].status, 'ready');
    assert.equal(s.items[0].localUrl, undefined);
    assert.equal(s.items[0].label, 'graph.png');
    assert.deepEqual(readyAttachments(s.items).map((a) => a.id), ['att-1']);
    // A pasted screenshot has no name: the chip keeps its label.
    const pasted = run(
      empty,
      { type: 'add', item: chip('p', { label: '붙여넣은 이미지' }) },
      { type: 'ready', key: 'p', attachment: att('att-2') },
    );
    assert.equal(pasted.items[0].label, '붙여넣은 이미지');
    // A region gets the server's slide and rect.
    const region = run(
      empty,
      { type: 'add', item: chip('r', { kind: 'region', label: 'p.3 영역' }) },
      {
        type: 'ready',
        key: 'r',
        attachment: att('att-3', { kind: 'region', slide: 3, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, text: 'f(x)' }),
      },
    );
    assert.equal(region.items[0].label, 'p.3 영역');
    assert.equal(region.items[0].slide, 3);
    assert.deepEqual(region.items[0].rect, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  test(`at most ${MAX_ATTACHMENTS} chips`, () => {
    let s = empty;
    for (let i = 0; i < MAX_ATTACHMENTS + 2; i++) s = run(s, { type: 'add', item: chip(`c${i}`) });
    assert.equal(s.items.length, MAX_ATTACHMENTS);
    assert.equal(freeSlots(s.items), 0);
    assert.equal(run(s, { type: 'add', item: chip('c0') }), s, 'the same key is not added twice');
  });

  test('sent chips leave; a question that was not accepted puts them back in front', () => {
    let s = run(
      empty,
      { type: 'add', item: chip('a') },
      { type: 'ready', key: 'a', attachment: att('att-a') },
      { type: 'add', item: chip('b') }, // still uploading: stays when the question is sent
      { type: 'ready', key: 'b', attachment: att('att-b') },
    );
    const taken = s.items.slice(0, 1);
    s = run(s, { type: 'remove', keys: taken.map((c) => c.key) });
    assert.deepEqual(s.items.map((c) => c.key), ['b']);
    s = run(s, { type: 'add', item: chip('c') }); // added while the question was being sent
    s = run(s, { type: 'restore', docId: 'lec', items: taken });
    assert.deepEqual(s.items.map((c) => c.key), ['a', 'b', 'c']);
    assert.equal(run(s, { type: 'restore', docId: 'lec', items: taken }), s, 'already back');
    // Chips of another document are not restored here.
    const other = run({ docId: 'other', items: [] }, { type: 'restore', docId: 'lec', items: taken });
    assert.deepEqual(other.items, []);
    // Restoring beyond the limit keeps the restored ones first.
    let full = empty;
    for (let i = 0; i < MAX_ATTACHMENTS; i++) full = run(full, { type: 'add', item: chip(`n${i}`) });
    const back = run(full, { type: 'restore', docId: 'lec', items: [chip('old')] });
    assert.equal(back.items.length, MAX_ATTACHMENTS);
    assert.equal(back.items[0].key, 'old');
  });

  test('a question refused for attachments the server no longer has: those chips do not come back', () => {
    const ready = (key: string, id: string, extra: Partial<Attachment> = {}) => chip(key, { status: 'ready', attachment: att(id, extra) });
    const chips = [ready('a', 'att-a', { kind: 'region', slide: 12 }), ready('b', 'att-b'), ready('c', 'att-c', { name: 'board.png' })];
    assert.deepEqual(withoutAttachments(chips, ['att-a', 'att-c']).map((c) => c.key), ['b']);
    assert.deepEqual(withoutAttachments(chips, []).map((c) => c.key), ['a', 'b', 'c']);
    const attachments = chips.map((c) => c.attachment!);
    assert.equal(
      missingAttachmentsMessage(attachments, ['att-a', 'att-c']),
      '첨부(p.12 영역, board.png)를 서버에서 찾을 수 없어서 질문을 보내지 않았어요. 질문에 쓰지 않은 첨부는 24시간 뒤에 지워져요 — 그 첨부 없이 다시 보내 주세요.',
    );
    assert.match(missingAttachmentsMessage([], ['att-x']), /^첨부\(1개\)를/);
  });

  test('switching documents drops the chips', () => {
    const s = run(empty, { type: 'add', item: chip('a') });
    const next = run(s, { type: 'reset', docId: 'lec-2' });
    assert.deepEqual(next, { docId: 'lec-2', items: [] });
    assert.equal(run(next, { type: 'reset', docId: 'lec-2' }), next);
    assert.equal(run(s, { type: 'remove', keys: ['zzz'] }), s);
  });
});

describe('attachment API', () => {
  const realFetch = globalThis.fetch;
  const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  let calls: Array<{ path: string; method: string; body: string | null }> = [];

  class FakeXhr {
    static last: FakeXhr | null = null;
    static respond: (xhr: FakeXhr) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
    method = '';
    path = '';
    headers: Record<string, string> = {};
    status = 0;
    responseText = '';
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(method: string, path: string) {
      this.method = method;
      this.path = path;
      FakeXhr.last = this;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    abort() {
      setTimeout(() => this.onabort?.(), 0);
    }
    send(body: { size: number }) {
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: body.size / 2, total: body.size });
        const { status, body: answer } = FakeXhr.respond(this);
        this.status = status;
        this.responseText = JSON.stringify(answer);
        this.onload?.();
      }, 0);
    }
  }

  beforeEach(() => {
    resetAuthForTests();
    applyAuthStatus({ authRequired: false, authenticated: true });
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        path: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({ id: 'att-0123456789abcdef', kind: 'region', slide: 12, rect: { x: 0, y: 0, w: 1, h: 1 }, width: 10, height: 10, text: '', createdAt: '' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = realXhr;
    resetAuthForTests();
  });

  test('URLs and the region request', async () => {
    assert.equal(attachmentUrl('lec-1a', 'att-0123456789abcdef'), '/api/docs/lec-1a/attachments/att-0123456789abcdef');
    const a = await createRegion('lec-1a', { slide: 12, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    assert.equal(a.slide, 12);
    assert.deepEqual(calls, [
      { path: '/api/docs/lec-1a/regions', method: 'POST', body: '{"slide":12,"rect":{"x":0.1,"y":0.2,"w":0.3,"h":0.4}}' },
    ]);
    await deleteAttachment('lec-1a', 'att-0123456789abcdef');
    assert.deepEqual(calls[1], { path: '/api/docs/lec-1a/attachments/att-0123456789abcdef', method: 'DELETE', body: null });
  });

  test('an image upload sends the bytes with its type and name, and reports progress', async () => {
    FakeXhr.respond = () => ({ status: 201, body: { id: 'att-1', kind: 'image', name: '그래프 1.png', width: 5, height: 5, createdAt: '' } });
    const progress: number[] = [];
    const file = Object.assign(new Blob([new Uint8Array(100)]), { name: '그래프 1.HEIC' });
    const a = await uploadAttachment('lec-1a', file, { name: '그래프 1.HEIC', onProgress: (p) => progress.push(p) });
    assert.equal(a.id, 'att-1');
    const xhr = FakeXhr.last!;
    assert.equal(xhr.method, 'POST');
    assert.equal(xhr.path, '/api/docs/lec-1a/attachments');
    assert.equal(xhr.headers['Content-Type'], 'image/heic');
    assert.equal(xhr.headers['X-Filename'], encodeURIComponent('그래프 1.HEIC'));
    assert.deepEqual(progress, [0.5]);
  });

  test('a pasted screenshot has no name; refusals keep their status', async () => {
    FakeXhr.respond = () => ({ status: 413, body: { error: 'too large' } });
    const file = Object.assign(new Blob([new Uint8Array(10)], { type: 'image/png' }), { name: 'image.png' });
    await assert.rejects(uploadAttachment('lec-1a', file), (e: unknown) => {
      assert.equal((e as { status?: number }).status, 413);
      return true;
    });
    assert.equal(FakeXhr.last!.headers['X-Filename'], undefined);
    assert.equal(FakeXhr.last!.headers['Content-Type'], 'image/png');
  });

  test('a question refused for missing attachments says which (missingAttachments of the error body)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: '첨부를 찾을 수 없습니다: att-0000000000000001', missingAttachments: ['att-0000000000000001', 42, 'BAD ID'] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await assert.rejects(sendMessage('lec-1a', 's1', { text: 'x', slide: 1, attachments: ['att-0000000000000001'] }, () => {}), (e: unknown) => {
      assert.equal((e as { status?: number }).status, 400);
      assert.deepEqual(missingAttachmentsOf(e), ['att-0000000000000001']);
      return true;
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: '질문을 입력해 주세요' }), { status: 400 })) as typeof fetch;
    await assert.rejects(sendMessage('lec-1a', 's1', { text: '', slide: 1 }, () => {}), (e: unknown) => {
      assert.deepEqual(missingAttachmentsOf(e), []);
      return true;
    });
    assert.deepEqual(missingAttachmentsOf(new Error('x')), []);
  });

  test('an upload can be cancelled (a chip removed while it uploads)', async () => {
    FakeXhr.respond = () => ({ status: 201, body: { id: 'x' } });
    const controller = new AbortController();
    controller.abort();
    const file = Object.assign(new Blob([new Uint8Array(10)], { type: 'image/png' }), { name: 'a.png' });
    await assert.rejects(uploadAttachment('lec-1a', file, { signal: controller.signal }), { name: 'AbortError' });
  });
});
