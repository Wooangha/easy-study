// 화면 테마 (DESIGN §24): the stylesheet's two dark token blocks, the highlight.js colors as tokens, theme-boot.js
// before the first paint (run in node:vm) and applyTheme. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { storageItemName, storageKeys } from '../src/lib/storage.ts';
import { THEME_COLORS, applyTheme } from '../src/lib/theme.ts';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(web, 'src', 'styles.css'), 'utf8');
const html = readFileSync(path.join(web, 'index.html'), 'utf8');
const bootFile = path.join(web, 'public', 'theme-boot.js');
const hljsStyles = path.join(web, '..', 'node_modules', 'highlight.js', 'styles');

/** The body of the block whose '{' is at `open`. */
function blockAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

/** Bodies of every rule written exactly as `<selector> {`, in order. */
function rules(selector: string, text = css): string[] {
  const out: string[] = [];
  const needle = `${selector} {`;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    // Only at the start of a line (not the tail of a longer selector).
    if (i > 0 && !/\s/.test(text[i - 1])) continue;
    out.push(blockAt(text, i + needle.length - 1));
  }
  return out;
}

/** "name: value" declarations of a rule body, comments dropped, whitespace normalized. */
function declarations(body: string): string[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

const tokenMap = (body: string) => new Map(declarations(body).map((d) => [d.slice(0, d.indexOf(':')), d.slice(d.indexOf(':') + 1).trim()]));

const DARK_MEDIA = '@media (prefers-color-scheme: dark)';
const UNLESS_LIGHT = ":root:not([data-theme='light'])";
const FORCED_DARK = ":root[data-theme='dark']";

describe('styles.css: dark tokens by the system or by data-theme', () => {
  const media = rules(DARK_MEDIA);
  const inMedia = media.map((body) => {
    assert.doesNotMatch(body, /(^|\s):root \{/, 'a dark block that data-theme="light" cannot turn off');
    const inner = rules(UNLESS_LIGHT, body);
    assert.equal(inner.length, 1, 'one :root:not([data-theme=light]) rule per media block');
    return inner[0];
  });
  const forced = rules(FORCED_DARK).filter((body) => body.includes('--'));

  test('the tokens and the recording colors each have a media block and a data-theme="dark" block', () => {
    assert.equal(media.length, 2, 'the tokens and --rec');
    assert.equal(forced.length, 2);
    assert.ok(tokenMap(inMedia[0]).has('--surface'));
    assert.ok(tokenMap(inMedia[1]).has('--rec'));
  });

  test('both blocks declare exactly the same, in the same order', () => {
    for (let i = 0; i < 2; i++) assert.deepEqual(declarations(forced[i]), declarations(inMedia[i]), `block ${i}`);
  });

  test('every dark token overrides a light one', () => {
    const light = rules(':root').map(tokenMap);
    const all = new Map(light.flatMap((m) => [...m]));
    for (const body of inMedia) for (const name of tokenMap(body).keys()) assert.ok(all.has(name), `${name} has a light value`);
  });

  test('a forced theme sets color-scheme (native controls follow)', () => {
    assert.ok(rules(":root[data-theme='light']").some((b) => declarations(b).includes('color-scheme: light')));
    assert.ok(rules(FORCED_DARK).some((b) => declarations(b).includes('color-scheme: dark')));
    assert.ok(declarations(rules(':root')[0]).includes('color-scheme: light dark'));
  });
});

describe('styles.css: highlight.js colors as tokens', () => {
  const light = tokenMap(rules(':root')[0]);
  const dark = tokenMap(rules(UNLESS_LIGHT, rules(DARK_MEDIA)[0])[0]);
  const hl = (m: Map<string, string>) => [...m.keys()].filter((k) => k.startsWith('--hl-')).sort();

  test('every --hl-* token exists in light and dark, and every one used is defined', () => {
    assert.ok(hl(light).length >= 14);
    assert.deepEqual(hl(dark), hl(light));
    for (const [, name] of css.matchAll(/var\((--hl-[a-z-]+)\)/g)) assert.ok(light.has(name), `${name} is defined`);
    assert.doesNotMatch(css, /@import[^;]*highlight\.js/, 'the media-conditioned theme files are gone');
  });

  test('the values are those of highlight.js github.css / github-dark.css, with the attribution', () => {
    /** color (or another property) of the rule whose selector list has `selector`. */
    const themeValue = (file: string, selector: string, property = 'color') => {
      const text = readFileSync(path.join(hljsStyles, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selectors, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selectors.split(',').map((s) => s.trim()).includes(selector)) continue;
        const value = tokenMap(body).get(property);
        if (value) return value;
      }
      throw new Error(`${file}: ${selector} ${property}`);
    };
    const sources: Record<string, [string, string?]> = {
      '--hl-text': ['.hljs'],
      '--hl-keyword': ['.hljs-keyword'],
      '--hl-title': ['.hljs-title'],
      '--hl-attr': ['.hljs-attr'],
      '--hl-string': ['.hljs-string'],
      '--hl-built-in': ['.hljs-built_in'],
      '--hl-comment': ['.hljs-comment'],
      '--hl-name': ['.hljs-name'],
      '--hl-section': ['.hljs-section'],
      '--hl-bullet': ['.hljs-bullet'],
      '--hl-addition': ['.hljs-addition'],
      '--hl-addition-bg': ['.hljs-addition', 'background-color'],
      '--hl-deletion': ['.hljs-deletion'],
      '--hl-deletion-bg': ['.hljs-deletion', 'background-color'],
    };
    assert.deepEqual(Object.keys(sources).sort(), hl(light));
    for (const [token, [selector, property]] of Object.entries(sources)) {
      assert.equal(light.get(token), themeValue('github.css', selector, property), `${token} light`);
      assert.equal(dark.get(token), themeValue('github-dark.css', selector, property), `${token} dark`);
    }
    assert.match(css, /highlight\.js[\s\S]{0,80}BSD-3-Clause/);
    assert.ok(readFileSync(path.join(web, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8').includes('highlight.js'), 'named in THIRD_PARTY_NOTICES.md');
  });
});

describe('index.html and theme-boot.js: no flash of the other theme', () => {
  test('a classic, synchronous /theme-boot.js comes before the colors, the stylesheet and the app', () => {
    assert.ok(existsSync(bootFile));
    const tag = html.match(/<script\b[^>]*src="\/theme-boot\.js"[^>]*><\/script>/);
    assert.ok(tag, 'theme-boot.js is loaded');
    assert.doesNotMatch(tag[0], /\b(type|async|defer)\b/);
    const at = html.indexOf(tag[0]);
    assert.ok(at < html.search(/<meta name="theme-color"/));
    assert.ok(at < html.search(/<link rel="manifest"/));
    assert.ok(at < html.search(/<script type="module"/));
    assert.ok(at < html.indexOf('</head>'));
  });

  const boot = readFileSync(bootFile, 'utf8');
  /** Runs theme-boot.js with a fake window/document; what it did to <html>. */
  function runBoot(stored: string | null, options: { desktop?: unknown; storageThrows?: boolean } = {}) {
    const attributes = new Map<string, string>();
    const style = { colorScheme: '' };
    const context = {
      window: {
        __EASY_STUDY_DESKTOP__: options.desktop,
        localStorage: {
          getItem(key: string) {
            if (options.storageThrows) throw new Error('SecurityError');
            return key === 'easy-study:theme' ? stored : null;
          },
        },
      },
      document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value), style } },
    };
    vm.runInNewContext(boot, context);
    return { theme: attributes.get('data-theme') ?? null, colorScheme: style.colorScheme };
  }

  test('reads the item storage.ts writes (JSON: quoted), and a bare value', () => {
    assert.equal(storageItemName(storageKeys.theme), 'easy-study:theme');
    assert.ok(boot.includes(`'${storageItemName(storageKeys.theme)}'`), 'the same item name');
    assert.deepEqual(runBoot(JSON.stringify('dark')), { theme: 'dark', colorScheme: 'dark' });
    assert.deepEqual(runBoot(JSON.stringify('light')), { theme: 'light', colorScheme: 'light' });
    assert.deepEqual(runBoot('dark'), { theme: 'dark', colorScheme: 'dark' });
  });

  test('nothing for 시스템 설정, anything else, or no storage', () => {
    for (const stored of [null, '"system"', '"purple"', '{', '1', '"DARK"']) {
      assert.deepEqual(runBoot(stored), { theme: null, colorScheme: '' }, String(stored));
    }
    assert.deepEqual(runBoot('"dark"', { storageThrows: true }), { theme: null, colorScheme: '' });
  });

  test('inside the desktop app only on Linux (macOS / Windows windows already have the shell’s theme)', () => {
    assert.deepEqual(runBoot('"dark"', { desktop: { v: 1, version: '0.5.0', os: 'macos' } }), { theme: null, colorScheme: '' });
    assert.deepEqual(runBoot('"dark"', { desktop: { v: 1, version: '0.5.0', os: 'windows' } }), { theme: null, colorScheme: '' });
    assert.deepEqual(runBoot('"dark"', { desktop: { v: 1, version: '0.5.0', os: 'linux' } }), { theme: 'dark', colorScheme: 'dark' });
  });
});

describe('applyTheme', () => {
  function fakeDocument() {
    const attributes = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      style: { colorScheme: '' },
    };
    const metas = [
      { content: '#ffffff', dataset: {} as DOMStringMap },
      { content: '#161920', dataset: {} as DOMStringMap },
    ];
    const doc = { documentElement: root, querySelectorAll: () => metas } as unknown as Document;
    return { doc, attributes, root, metas };
  }

  test('forced: data-theme, color-scheme and the window color; 시스템 설정 undoes all three', () => {
    const { doc, attributes, root, metas } = fakeDocument();
    applyTheme('dark', doc);
    assert.equal(attributes.get('data-theme'), 'dark');
    assert.equal(root.style.colorScheme, 'dark');
    assert.deepEqual(metas.map((m) => m.content), [THEME_COLORS.dark, THEME_COLORS.dark]);
    applyTheme('light', doc);
    assert.equal(attributes.get('data-theme'), 'light');
    assert.deepEqual(metas.map((m) => m.content), [THEME_COLORS.light, THEME_COLORS.light]);
    applyTheme('system', doc);
    assert.equal(attributes.has('data-theme'), false);
    assert.equal(root.style.colorScheme, '');
    assert.deepEqual(metas.map((m) => m.content), ['#ffffff', '#161920']);
  });

  test('the forced window colors are the top bar of each theme (and index.html’s)', () => {
    assert.equal(tokenMap(rules(':root')[0]).get('--surface'), THEME_COLORS.light);
    assert.equal(tokenMap(rules(FORCED_DARK).find((b) => b.includes('--surface'))!).get('--surface'), THEME_COLORS.dark);
    assert.ok(html.includes(`content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)"`));
    assert.ok(html.includes(`content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)"`));
  });
});
