#!/usr/bin/env node
// Generates desktop/src-tauri/icons from the web app's icon (web/public/favicon.svg) with `tauri icon`.
//   node desktop/scripts/make-icons.mjs        (npm run icons in desktop/; the generated files are committed)
// macOS/Linux icons get Apple's grid margin (an 824 px body on a 1024 px canvas) so the icon sits like the
// others in the Dock; the Windows .ico stays full-bleed (legible at 16–32 px). 256x256.png is 128x128@2x.png
// under a plain name for Linux (tauri.linux.conf.json): Tauri installs an "@2x" file into hicolor/256x256@2,
// the folder for 512 px images at scale 2, so desktops would not find a 256 px icon.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_DIR, REPO_DIR, runNpm } from './targets.mjs';

const KEEP = new Set(['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', '256x256.png', 'icon.png', 'icon.icns', 'icon.ico']);

const cli = path.join(DESKTOP_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!fs.existsSync(cli)) runNpm(['ci', '--no-audit', '--no-fund'], DESKTOP_DIR);

const svg = fs.readFileSync(path.join(REPO_DIR, 'web', 'public', 'favicon.svg'), 'utf8');
const match = /^<svg[^>]*viewBox="0 0 512 512"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg.trim());
if (!match) throw new Error('web/public/favicon.svg: expected a 512x512 viewBox');
const wrap = (offset, scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(${offset} ${offset}) scale(${scale})">${match[1]}</g></svg>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-icons-'));
const iconsDir = path.join(DESKTOP_DIR, 'src-tauri', 'icons');
try {
  fs.writeFileSync(path.join(tmp, 'padded.svg'), wrap(100, 824 / 512));
  fs.writeFileSync(path.join(tmp, 'full.svg'), wrap(0, 2));
  const icon = (src, out) => execFileSync(process.execPath, [cli, 'icon', src, '--output', out], { cwd: DESKTOP_DIR, stdio: 'inherit' });
  fs.rmSync(iconsDir, { recursive: true, force: true });
  icon(path.join(tmp, 'padded.svg'), iconsDir);
  icon(path.join(tmp, 'full.svg'), path.join(tmp, 'full'));
  fs.copyFileSync(path.join(tmp, 'full', 'icon.ico'), path.join(iconsDir, 'icon.ico'));
  fs.copyFileSync(path.join(iconsDir, '128x128@2x.png'), path.join(iconsDir, '256x256.png'));
  for (const e of fs.readdirSync(iconsDir)) {
    if (!KEEP.has(e)) fs.rmSync(path.join(iconsDir, e), { recursive: true, force: true });
  }
  console.log(`icons -> ${iconsDir}: ${[...fs.readdirSync(iconsDir)].sort().join(', ')}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
