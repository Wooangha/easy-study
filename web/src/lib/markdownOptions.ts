// react-markdown pipeline shared by every Markdown surface (chat answers, 정리본, notes). Kept free of
// JSX so tests can render with exactly this configuration (web/tests/markdown.test.ts).
//
// Everything rendered here is LLM output, which a prompt-injected slide can steer. Raw HTML is never
// enabled and link URLs go through react-markdown's defaultUrlTransform. Images are the one thing a
// browser fetches without a click, so only same-origin `/api/…` images (slides) and `data:` images
// are loaded. Any other image becomes a plain link that the student has to click.
import type { Element, ElementContent, Root, RootContent } from 'hast';
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

export const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];

export const rehypePlugins: Options['rehypePlugins'] = [
  // KaTeX must run before highlight.js so math code nodes are never treated as code.
  [rehypeKatex, { strict: 'ignore', errorColor: 'var(--danger)' }],
  [rehypeHighlight, { detect: false }],
  // Last, so it also sees anything an earlier plugin produced.
  rehypeBlockRemoteImages,
];
