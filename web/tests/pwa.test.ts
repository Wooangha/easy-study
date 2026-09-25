// Installable app (DESIGN §16): the manifest, its icons and the links in index.html.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(web, 'public');

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

/** Width, height and whether the PNG has an alpha channel, from its IHDR chunk. */
function pngInfo(file: string): { width: number; height: number; alpha: boolean } {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  const colorType = buf[25];
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
}

const publicFile = (url: string) => path.join(pub, url.replace(/^\//, ''));

describe('web app manifest', () => {
  const manifest = JSON.parse(readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8')) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: ManifestIcon[];
  };

  test('installable: name, start_url "/", standalone, colors of the light theme', () => {
    assert.equal(manifest.name, 'easy-study');
    assert.ok(manifest.short_name && manifest.short_name.length <= 12);
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    const css = readFileSync(path.join(web, 'src', 'styles.css'), 'utf8');
    const light = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
    assert.match(light, new RegExp(`--surface: ${manifest.theme_color};`)); // the top bar
    assert.match(light, new RegExp(`--bg: ${manifest.background_color};`));
  });

  test('icons 192 and 512 ("any") and a maskable 512, with files of those sizes', () => {
    const find = (sizes: string, purpose: string) =>
      manifest.icons.find((i) => i.sizes === sizes && (i.purpose ?? 'any').split(/\s+/).includes(purpose));
    for (const [sizes, purpose] of [
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ] as const) {
      const icon = find(sizes, purpose);
      assert.ok(icon, `${purpose} ${sizes} icon`);
      assert.equal(icon.type, 'image/png');
      const { width, height } = pngInfo(publicFile(icon.src));
      assert.equal(`${width}x${height}`, sizes, icon.src);
    }
  });
});

describe('index.html', () => {
  const html = readFileSync(path.join(web, 'index.html'), 'utf8');

  test('links the manifest, the icons and a theme color for light and dark', () => {
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)"/);
    assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)"/);
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.includes('/apple-touch-icon.png'));
    for (const href of hrefs) assert.ok(existsSync(publicFile(href)), `${href} exists in web/public`);
  });

  test('apple-touch-icon is 180×180 and opaque (iOS shows transparency as black)', () => {
    const info = pngInfo(path.join(pub, 'apple-touch-icon.png'));
    assert.deepEqual([info.width, info.height, info.alpha], [180, 180, false]);
  });

  test('the dark theme color is the dark top bar', () => {
    const css = readFileSync(path.join(web, 'src', 'styles.css'), 'utf8');
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const color = html.match(/<meta name="theme-color" content="(#[0-9a-f]{6})" media="\(prefers-color-scheme: dark\)"/)?.[1];
    assert.match(dark, new RegExp(`--surface: ${color};`));
  });
});
