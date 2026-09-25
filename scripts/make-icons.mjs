#!/usr/bin/env node
// Draws the app icon (an open book with a slide — a small chart — on its right page) and writes the PWA / favicon files
// into web/public (DESIGN §16). The generated files are committed; run this again only to change the icon.
//
//   node scripts/make-icons.mjs
//
// Outputs:
//   favicon.svg, favicon-32.png           browser tab
//   apple-touch-icon.png (180)            Safari "Add to Dock" / iOS home screen (full-bleed, iOS rounds it)
//   icons/icon-192.png, icon-512.png      manifest "any": rounded square with a margin (macOS icon grid)
//   icons/icon-maskable-512.png           manifest "maskable": full bleed, glyph inside the 80% safe zone
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'web', 'public');

const ACCENT_LIGHT = '#6282ff';
const ACCENT_DARK = '#3252dc';
const INK = '#3656e0';

/** The glyph, drawn around (256, 268) in a 512 box; `scale` shrinks it around the canvas center. */
function glyph(scale) {
  return `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -268)">
    <path d="M100 166 V372 C168 362 222 372 256 396 C290 372 344 362 412 372 V166 Z" fill="#fff" fill-opacity="0.32"/>
    <path d="M250 178 C218 156 168 146 118 152 V354 C168 348 218 358 250 380 Z" fill="#fff"/>
    <path d="M262 178 C294 156 344 146 394 152 V354 C344 348 294 358 262 380 Z" fill="#fff"/>
    <g stroke="${INK}" stroke-width="11" stroke-linecap="round" stroke-opacity="0.38">
      <path d="M146 204 H224"/>
      <path d="M146 236 H224"/>
      <path d="M146 268 H210"/>
      <path d="M146 300 H224"/>
      <path d="M146 332 H196"/>
      <path d="M290 300 H366"/>
      <path d="M290 332 H340"/>
    </g>
    <rect x="286" y="190" width="84" height="80" rx="9" fill="${INK}"/>
    <g fill="#fff">
      <rect x="302" y="232" width="12" height="24" rx="2"/>
      <rect x="322" y="218" width="12" height="38" rx="2"/>
      <rect x="342" y="204" width="12" height="52" rx="2"/>
    </g>
  </g>`;
}

const gradient = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ACCENT_LIGHT}"/>
      <stop offset="1" stop-color="${ACCENT_DARK}"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="#0b1440" flood-opacity="0.28"/>
    </filter>
  </defs>`;

/** Rounded square with a transparent margin (the macOS icon grid: 412 of 512, radius 92). */
const anySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${gradient}
  <rect x="50" y="46" width="412" height="412" rx="92" fill="url(#bg)" filter="url(#shadow)"/>
  ${glyph(0.86)}
</svg>`;

/** Full bleed; the glyph stays inside the maskable safe zone (a circle of 40% radius). */
const fullBleedSvg = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${gradient}
  <rect width="512" height="512" fill="url(#bg)"/>
  ${glyph(scale)}
</svg>`;

/** Favicon: the rounded square without margin or shadow (tabs are tiny). */
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${gradient}
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  ${glyph(0.98)}
</svg>`;

async function png(svg, size, file) {
  const target = path.join(out, file);
  mkdirSync(path.dirname(target), { recursive: true });
  await sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size) / 512) * 2) })
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(target);
  console.log(`wrote ${path.relative(root, target)} (${size}×${size})`);
}

/** apple-touch-icon must not be transparent (iOS shows black there). */
async function opaquePng(svg, size, file) {
  const target = path.join(out, file);
  await sharp(Buffer.from(svg), { density: 144 })
    .resize(size, size)
    .flatten({ background: ACCENT_DARK })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(target);
  console.log(`wrote ${path.relative(root, target)} (${size}×${size})`);
}

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'favicon.svg'), `${faviconSvg.replace(/\n\s*/g, '')}\n`);
console.log('wrote web/public/favicon.svg');
await png(faviconSvg, 32, 'favicon-32.png');
await png(anySvg, 192, 'icons/icon-192.png');
await png(anySvg, 512, 'icons/icon-512.png');
await png(fullBleedSvg(0.8), 512, 'icons/icon-maskable-512.png');
await opaquePng(fullBleedSvg(0.84), 180, 'apple-touch-icon.png');
