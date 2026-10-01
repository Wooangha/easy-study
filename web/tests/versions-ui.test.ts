// 새 버전 올리기 (DESIGN §28) rendered: the 새 버전 확인 dialog's plan and the viewer's banner, in Korean and English.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/experimental';
import type { DeckChange, DocMeta, VersionPlan } from '../../shared/types.ts';
import { setLang } from '../src/i18n/index.ts';

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
const { PlanSections } = await import('../src/components/NewVersionDialog.tsx');
const { DeckBanner } = await import('../src/components/DeckBanner.tsx');

const NOW = '2026-10-02T10:00:00.000Z';
const doc: DocMeta = {
  id: 'lec-ui',
  title: 'L7',
  fileName: 'L7.pdf',
  pageCount: 5,
  aspectRatio: 4 / 3,
  status: 'ready',
  progress: 5,
  createdAt: NOW,
  courseId: null,
  digestStatus: 'none',
};
const plan: VersionPlan = {
  fromRev: 0,
  oldPageCount: 5,
  newPageCount: 5,
  slides: [
    { slide: 1, from: 1, change: 'same' },
    { slide: 2, from: 2, change: 'changed' },
    { slide: 3, from: null, change: 'new' },
    { slide: 4, from: 5, change: 'same' },
    { slide: 5, from: 4, change: 'changed', moved: true },
  ],
  removed: [3],
  unrelated: true,
  onRemoved: { items: 2, memos: 1, questions: 3 },
};
const change: DeckChange = { rev: 1, at: NOW, kind: 'apply', fromFileName: 'L7.pdf', changed: [2, 5], added: [3], removed: [3], undoable: true };

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const plain = (node: Parameters<typeof renderToStaticMarkup>[0]) => text(renderToStaticMarkup(node));

describe('the 새 버전 확인 dialog and the banner, rendered', () => {
  afterEach(() => setLang('system'));

  test('the plan: chips, the warning, the lines on removed slides, old → new thumbs with 이동, new and removed thumbs', () => {
    const html = renderToStaticMarkup(createElement(PlanSections, { doc, plan, createdAt: NOW }));
    const t = text(html);
    for (const part of ['그대로 2', '수정 2', '새로 1', '빠짐 1', '이 강의와 많이 달라요', '빠지는 장의 필기 2개·메모 1개는 메모 탭 › 빠진 슬라이드에 보관돼요', '질문 3개는 가까운 장으로 옮겨져요', '이동']) {
      assert.ok(t.includes(part), part);
    }
    assert.ok(!t.includes('바뀐 장이 없어요'));
    assert.ok(html.includes('src="/api/docs/lec-ui/thumbs/4.webp"'), 'the old slide 4 (moved to 5)');
    assert.ok(html.includes(`src="/api/docs/lec-ui/versions/next/thumbs/5.webp?t=${encodeURIComponent(NOW)}"`));
    assert.ok(html.includes('src="/api/docs/lec-ui/thumbs/3.webp"'), 'the removed old slide 3');
  });

  test('the same PDF again says so; English', () => {
    const same: VersionPlan = { ...plan, slides: plan.slides.map((s, i) => ({ slide: i + 1, from: i + 1, change: 'same' as const })), removed: [], unrelated: false, onRemoved: { items: 0, memos: 0, questions: 0 } };
    assert.ok(plain(createElement(PlanSections, { doc, plan: same, createdAt: NOW })).includes('바뀐 장이 없어요'));
    setLang('en');
    const t = plain(createElement(PlanSections, { doc, plan, createdAt: NOW }));
    assert.ok(t.includes('Changed 2') && t.includes('2 annotations and 1 memo on the removed slides'), t);
  });

  test('the banner: the counts, ‹ ›, 되돌리기 only for an undoable apply', () => {
    const props = { change, focused: 1, onGoToSlide: () => {}, onUndo: () => {}, onDismiss: () => {} };
    const t = plain(createElement(DeckBanner, props));
    assert.ok(t.includes('새 버전으로 바꿨어요 · 수정 2 · 새로 1 · 빠짐 1'), t);
    assert.ok(t.includes('되돌리기'));
    const undone = plain(createElement(DeckBanner, { ...props, change: { ...change, kind: 'undo', undoable: false } }));
    assert.ok(undone.includes('이전 버전으로 되돌렸어요') && !undone.includes('되돌리기 '), undone);
  });
});
