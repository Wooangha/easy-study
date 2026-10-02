// The slide viewer in English (DESIGN §27): the annotation toolbar, the item menu, question markers, the memo list's
// blank line and the annotation store's toasts follow the language; Korean stays the reference, byte for byte.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/experimental';
import type { Attachment, ChatMessage, MemoItem, NotesResponse, TextItem } from '../../shared/types.ts';
import { hangulIn, shapeProblems } from '../../tests/i18nParity.ts';
import { en } from '../src/i18n/en/index.ts';
import { msg, setLang } from '../src/i18n/index.ts';
import { ko } from '../src/i18n/ko/index.ts';
import { emptySlideAnnotations } from '../src/lib/annotations/geometry.ts';
import { deriveMarkers, noTextLabel } from '../src/lib/annotations/markers.ts';
import { memoLines } from '../src/lib/annotations/memoList.ts';
import { conflictReloaded, tooManyHidden, tooManyItems } from '../src/lib/annotations/store.ts';
import { FULL_FRAME } from '../src/lib/attachments.ts';

// The components are .tsx (JSX, which Node's type stripping does not take): transpiled on load like markdown.test.ts.
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
const { AnnotationTools, NO_FILTER, toolHint } = await import('../src/components/annotations/AnnotationTools.tsx');
const { ItemMenu } = await import('../src/components/annotations/ItemMenu.tsx');
const { QuestionMarkers } = await import('../src/components/annotations/QuestionMarkers.tsx');
const { LayerContext } = await import('../src/components/annotations/context.ts');
type LayerEnv = import('../src/components/annotations/context.ts').LayerEnv;

const HANGUL = /[가-힯]/;

/** A layer context whose actions do nothing (the pieces only need to render). */
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

const toolbar = () =>
  renderToStaticMarkup(
    createElement(AnnotationTools, {
      tool: 'highlight',
      onTool: () => {},
      color: 'yellow',
      onColor: () => {},
      layerShown: true,
      onLayerShown: () => {},
      markersShown: true,
      onMarkersShown: () => {},
      filter: { onlyAnnotated: true, tag: null },
      onFilter: () => {},
      tags: [],
      shownCount: 3,
      pageCount: 10,
      replayAvailable: true,
      replayOn: true,
      onReplayOn: () => {},
      replaying: true,
      compact: false,
      inkColor: 'black',
      onInkColor: () => {},
      inkWidth: 0.005,
      onInkWidth: () => {},
      fingerInk: false,
      onFingerInk: () => {},
    }),
  );

const NOW = '2026-09-29T08:00:00.000Z';
const memo: MemoItem = { id: 'an-000000000001', type: 'memo', color: 'pink', createdAt: NOW, updatedAt: NOW, at: { x: 0.1, y: 0.1 }, text: '', tags: [], collapsed: false, tutor: false, links: [] };
const textBox: TextItem = { id: 'an-000000000002', type: 'text', color: 'blue', createdAt: NOW, updatedAt: NOW, rect: { x: 0.1, y: 0.5, w: 0.2, h: 0.1 }, text: 'x' };

const region = (id: string): Attachment => ({ id, kind: 'region', slide: 3, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, width: 100, height: 60, text: '', createdAt: NOW });
const question = (id: string, text: string, createdAt: string): ChatMessage => ({
  id,
  role: 'user',
  text,
  slide: 3,
  kind: 'question',
  createdAt,
  status: 'complete',
  attachments: [region(`a-${id}`)],
});
const notes = (questions: ChatMessage[]): NotesResponse => ({
  docId: 'doc-1',
  markdownPath: '/x/STUDY_NOTES.md',
  slides: [{ slide: 3, entries: questions.map((q) => ({ sessionId: 's1', sessionTitle: 'S', provider: 'claude-code' as const, question: q, answer: null })) }],
});
const docFor = (slide: number) => (slide === 3 ? emptySlideAnnotations(3) : undefined);

describe('viewer texts', () => {
  afterEach(() => setLang('system'));

  test('the English namespace matches the Korean one and has no Korean left', () => {
    assert.deepEqual(shapeProblems(ko.viewer, en.viewer), []);
    assert.deepEqual(hangulIn(en.viewer), []);
  });

  test('Korean by default, unchanged', () => {
    assert.equal(toolHint('select'), 'j/k · ↑/↓ · 빈 곳을 끌면 영역 첨부');
    assert.equal(toolHint('rect'), '사각형: 빈 곳에서 끌기 · 필기는 클릭해 옮기기 · Esc');
    assert.equal(toolHint('memo'), '메모: 빈 곳에서 클릭 · 필기는 클릭해 옮기기 · Esc');
    assert.equal(noTextLabel(), '(첨부만 보냄)');
    assert.deepEqual(memoLines(' \n '), ['(빈 메모)', null]);
    assert.equal(tooManyItems(), '이 슬라이드에는 필기를 더 넣을 수 없어요 (최대 200개)');
    assert.equal(msg().viewer.memo.pillLabel('LL(1)', true, 2), '메모: LL(1) · 튜터에게 숨김 · 질문 2개');
    assert.equal(msg().viewer.memo.tooManyLinks(8), '메모 하나에는 연결을 8개까지 넣을 수 있어요');
    assert.equal(msg().viewer.regionMenu.askTitle('이 부분 설명해줘'), '이 영역을 첨부해서 “이 부분 설명해줘”라고 바로 질문해요');
    const html = toolbar();
    assert.ok(html.includes('형광펜: 글줄 위에서 끌면 그 줄에 맞춰 칠해요 (다시 누르거나 Esc로 끔)'));
    assert.ok(html.includes('표시 3/10'));
    assert.ok(html.includes('그때 필기 재생 중'));
  });

  test('English: the toolbar, its hint and menu button, the filter count and the replay badge', () => {
    setLang('en');
    assert.equal(toolHint('select'), 'j/k · ↑/↓ · drag on an empty area to attach it');
    assert.equal(toolHint('rect'), 'Rectangle: drag on an empty area · click an annotation to move it · Esc');
    assert.equal(toolHint('text'), 'Text: click on an empty area · click an annotation to move it · Esc');
    const html = toolbar();
    assert.doesNotMatch(html, HANGUL);
    assert.ok(html.includes('aria-label="Annotation tools"'));
    assert.ok(html.includes('title="Highlighter: drag over a line of text to highlight along it (press again or Esc to turn off)"'));
    assert.ok(html.includes('title="Color for new annotations: Yellow"'));
    assert.ok(html.includes('Showing 3/10'));
    assert.ok(html.includes('Replaying annotations'));
    assert.ok(html.includes('>Annotations</span>'));
  });

  test('English: the item menu of a memo, of a text box and of a group', () => {
    setLang('en');
    const one = inLayer(createElement(ItemMenu, { slide: 4, items: [memo], questions: 2 }));
    assert.doesNotMatch(one, HANGUL);
    assert.ok(one.includes('aria-label="Selected annotation on slide 4"'));
    assert.ok(one.includes("title=\"Hidden from tutor — the tutor doesn&#x27;t see this memo (click to show)\""));
    assert.ok(one.includes('aria-label="2 questions"'));
    assert.ok(one.includes('aria-label="Increase memo text size"'));
    assert.ok(one.includes('Collapse'));
    assert.ok(one.includes('Delete'));
    const text = inLayer(createElement(ItemMenu, { slide: 4, items: [textBox], questions: 0 }));
    assert.doesNotMatch(text, HANGUL);
    assert.ok(text.includes('>Monospace</option>'));
    assert.ok(text.includes('title="Text size: 4–72 pt (at slide scale)"'));
    const group = inLayer(createElement(ItemMenu, { slide: 4, items: [memo, textBox], questions: 0 }));
    assert.ok(group.includes('aria-label="2 selected annotations on slide 4"'));
    assert.ok(group.includes('>2 selected</span>'));
    assert.ok(group.includes('title="Delete 2 selected annotations (Delete)"'));
  });

  test('English: question markers, a question sent without text, and the store toasts', () => {
    setLang('en');
    const n = notes([question('q1', 'What is this?', '2026-09-29T10:00:00.000Z'), question('q2', '', '2026-09-29T11:00:00.000Z')]);
    const markers = deriveMarkers(n, docFor).get(3)!;
    assert.equal(markers[0].label, '(Attachments only)', 'the newest question had no text');
    const html = inLayer(createElement(QuestionMarkers, { slide: 3, markers, frame: FULL_FRAME, aspect: 4 / 3, skipItems: null, onLit: () => {} }));
    assert.ok(html.includes('aria-label="2 questions: (Attachments only)"'));
    assert.ok(html.includes('title="2 questions asked about this part"'));
    assert.deepEqual(memoLines(''), ['(Empty memo)', null]);
    assert.equal(conflictReloaded(), 'The annotations changed elsewhere, so they were reloaded');
    assert.equal(tooManyHidden(), 'Too many hidden question markers');
    assert.equal(tooManyItems(), "This slide can't take more annotations (up to 200)");
    setLang('ko');
    assert.equal(deriveMarkers(n, docFor).get(3)![0].label, '(첨부만 보냄)', 'derived again, in the new language');
  });
});
