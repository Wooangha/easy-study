// react-markdown pipeline shared by every Markdown surface (chat answers, 정리본, notes). Kept free of
// JSX so tests can render with exactly this configuration (web/tests/markdown.test.ts).
//
// Everything rendered here is LLM output, which a prompt-injected slide can steer. Raw HTML is never
// enabled and link URLs go through react-markdown's defaultUrlTransform. Images are the one thing a
// browser fetches without a click, so only same-origin `/api/…` images (slides) and `data:` images
// are loaded. Any other image becomes a plain link that the student has to click.
//
// Math is rendered by KaTeX as HTML only (no hidden MathML copy: that copy was ~40% of the KaTeX DOM,
// DESIGN §15). Each formula keeps its TeX source as role="math" + aria-label, so screen readers still get
// something to read.
import type { Element, ElementContent, Root, RootContent } from 'hast';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import haskell from 'highlight.js/lib/languages/haskell';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import llvm from 'highlight.js/lib/languages/llvm';
import makefile from 'highlight.js/lib/languages/makefile';
import ocaml from 'highlight.js/lib/languages/ocaml';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import x86asm from 'highlight.js/lib/languages/x86asm';
import yaml from 'highlight.js/lib/languages/yaml';
import { defaultUrlTransform, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** Origin used to resolve relative image URLs outside a browser (tests). */
const FALLBACK_ORIGIN = 'http://easy-study.invalid';

function currentOrigin(): string {
  const origin = globalThis.location?.origin;
  return origin && origin !== 'null' ? origin : FALLBACK_ORIGIN;
}

/**
 * Whether an image source may be loaded automatically: a `data:image/…` URL, or a URL on this origin
 * under `/api/` (slide images). Everything else — other hosts, protocol-relative `//host/…`, other
 * paths or schemes — is refused.
 */
export function isAllowedImageSrc(src: string, origin: string = currentOrigin()): boolean {
  const value = src.trim();
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) return true;
  let url: URL;
  try {
    url = new URL(value, `${origin}/`);
  } catch {
    return false;
  }
  return url.origin === origin && url.pathname.startsWith('/api/');
}

/** Text shown instead of an image that is not loaded automatically. */
function blockedImageLabel(alt: string, url: URL | null): string {
  const name = alt.trim() || '외부 이미지';
  return url ? `🖼 ${name} (${url.host})` : `🖼 ${name}`;
}

/** Replace an `<img>` whose source is not allowed with a link (http/https) or plain text. */
function blockedImage(img: Element): ElementContent {
  const src = String(img.properties.src ?? '').trim();
  const alt = String(img.properties.alt ?? '');
  let url: URL | null = null;
  try {
    const parsed = new URL(src);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed;
  } catch {
    /* relative or malformed: no link */
  }
  const text: ElementContent = { type: 'text', value: blockedImageLabel(alt, url) };
  if (!url) return { type: 'element', tagName: 'span', properties: { className: ['md-blocked-image'] }, children: [text] };
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      href: url.href,
      className: ['md-blocked-image'],
      title: `외부 이미지는 자동으로 불러오지 않아요 — 클릭하면 새 탭에서 열려요: ${url.href}`,
    },
    children: [text],
  };
}

/** rehype plugin: images from anywhere but this app's API (or data: URLs) are turned into links. */
export function rehypeBlockRemoteImages() {
  const visit = (node: Root | Element) => {
    node.children = node.children.map((child: RootContent) => {
      if (child.type !== 'element') return child;
      if (child.tagName === 'img' && !isAllowedImageSrc(String(child.properties.src ?? ''))) {
        return blockedImage(child);
      }
      visit(child);
      return child;
    }) as typeof node.children;
  };
  return (tree: Root) => visit(tree);
}

/** Like react-markdown's default, but image sources must pass isAllowedImageSrc (and may be data: URLs). */
export const urlTransform: NonNullable<Options['urlTransform']> = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img') return isAllowedImageSrc(url) ? url.trim() : '';
  return defaultUrlTransform(url);
};

// ---------------------------------------------------------------------------
// TeX source of rendered formulas
// ---------------------------------------------------------------------------

/** hast property of the marker span that carries a formula's TeX source between the two plugins below. */
const TEX_SOURCE = 'dataEasyStudyTex';

function classesOf(el: Element): string[] {
  const cls = el.properties.className;
  return Array.isArray(cls) ? cls.map(String) : [];
}

function isMathElement(el: Element): boolean {
  return classesOf(el).some((c) => c === 'language-math' || c === 'math-inline' || c === 'math-display');
}

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  return node.type === 'element' ? node.children.map(textOf).join('') : '';
}

/**
 * rehype plugin, before rehype-katex: wraps every formula (`code.math-inline`, `pre > code.math-display`)
 * in a marker span that remembers its TeX source. rehype-katex replaces the formula inside the marker.
 */
export function rehypeMarkMathSource() {
  const visit = (node: Root | Element) => {
    node.children = node.children.map((child: RootContent) => {
      if (child.type !== 'element') return child;
      const only = child.children.length === 1 ? child.children[0] : null;
      const math =
        isMathElement(child) ||
        (child.tagName === 'pre' && only?.type === 'element' && only.tagName === 'code' && isMathElement(only));
      if (math) {
        return { type: 'element', tagName: 'span', properties: { [TEX_SOURCE]: textOf(child).trim() }, children: [child] };
      }
      visit(child);
      return child;
    }) as typeof node.children;
  };
  return (tree: Root) => visit(tree);
}

/** Give a rendered formula (`.katex`, also inside `.katex-display`) its TeX source as accessible name. */
function labelFormula(el: Element, tex: string) {
  const classes = classesOf(el);
  if (classes.includes('katex')) {
    el.properties.role = 'math';
    el.properties.ariaLabel = tex;
  } else if (classes.includes('katex-display')) {
    for (const child of el.children) if (child.type === 'element') labelFormula(child, tex);
  }
  // Anything else (a `.katex-error`) shows the source as text already.
}

/** rehype plugin, after rehype-katex: unwraps the marker spans and labels each formula with its TeX source. */
export function rehypeLabelMath() {
  const visit = (node: Root | Element) => {
    const out: RootContent[] = [];
    for (const child of node.children) {
      if (child.type === 'element' && typeof child.properties[TEX_SOURCE] === 'string') {
        const tex = child.properties[TEX_SOURCE];
        for (const rendered of child.children) {
          if (rendered.type === 'element') labelFormula(rendered, tex);
          out.push(rendered);
        }
        continue;
      }
      if (child.type === 'element') visit(child);
      out.push(child);
    }
    node.children = out as typeof node.children;
  };
  return (tree: Root) => visit(tree);
}

// ---------------------------------------------------------------------------
// Code highlighting: a small set of languages that CS courses use (lowlight's default `common` set
// is ~37 grammars, 137 KiB minified; web/vite.config.ts keeps it out of the bundle).
// ---------------------------------------------------------------------------

export const highlightLanguages = {
  bash,
  c,
  cpp,
  diff,
  go,
  haskell,
  java,
  javascript,
  json,
  llvm,
  makefile,
  ocaml,
  plaintext,
  python,
  rust,
  sql,
  typescript,
  x86asm,
  yaml,
};

/** Extra fence names LLMs use for these languages (the grammars bring the usual ones: js, ts, py, sh, …). */
const highlightAliases = {
  bash: ['shell', 'console', 'shellsession'],
  x86asm: ['asm', 'nasm', 'assembly', 'x86'],
  llvm: ['ll', 'llvm-ir'],
};

export const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];

export const rehypePlugins: Options['rehypePlugins'] = [
  rehypeMarkMathSource,
  // KaTeX must run before highlight.js so math code nodes are never treated as code.
  [rehypeKatex, { strict: 'ignore', errorColor: 'var(--danger)', output: 'html' }],
  rehypeLabelMath,
  [rehypeHighlight, { detect: false, languages: highlightLanguages, aliases: highlightAliases }],
  // Last, so it also sees anything an earlier plugin produced.
  rehypeBlockRemoteImages,
];
