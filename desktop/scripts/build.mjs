#!/usr/bin/env node
// Builds the desktop app for one target (default: this machine), or runs it in development:
//   node desktop/scripts/build.mjs [--target <rust triple>] [--bundles app,dmg] [--skip-prepare] [--skip-build]
//                                  [--require-tools] [--debug]
//   node desktop/scripts/build.mjs --dev
// (npm run desktop:build / npm run desktop:dev in the repo.) Steps: npm ci in desktop/ when the Tauri CLI is
// missing → prepare.mjs (repo build + resources for the target, including the recording tools whisper-cli and
// ffmpeg, built into <repo>/.cache when missing; --require-tools: fail instead of leaving one out) →
// `tauri build --target <t> --bundles <b>` → Linux: appimage.mjs removes the libraries the AppImage must take
// from the user's system (needs squashfs-tools).
// Output: desktop/src-tauri/target/<triple>/release/bundle/<kind>/…
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripAppImage } from './appimage.mjs';
import { prepare } from './prepare.mjs';
import { DESKTOP_DIR, RESOURCES_DIR, arg, externalBinOverride, hostTarget, runNpm, targetInfo, tauriEnv } from './targets.mjs';

const dev = arg('dev') === true;
const target = typeof arg('target') === 'string' ? arg('target') : hostTarget();
const info = targetInfo(target);
const bundles = typeof arg('bundles') === 'string' ? arg('bundles') : info.bundles.join(',');

const cli = path.join(DESKTOP_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!fs.existsSync(cli)) {
  console.log('== npm ci (desktop)');
  runNpm(['ci', '--no-audit', '--no-fund'], DESKTOP_DIR);
}

let stamp;
if (arg('skip-prepare') === true) {
  stamp = JSON.parse(fs.readFileSync(path.join(RESOURCES_DIR, 'target.json'), 'utf8'));
  if (stamp.target !== target) throw new Error(`desktop/resources was prepared for ${stamp.target}, not ${target}: drop --skip-prepare`);
  if (arg('require-tools') === true && !Object.values(stamp.tools ?? {}).every(Boolean)) {
    throw new Error(`desktop/resources has no ${Object.keys(stamp.tools ?? {}).filter((k) => !stamp.tools[k]).join(', ') || 'recording tools'}`);
  }
} else {
  stamp = await prepare({ target, skipBuild: arg('skip-build') === true, requireTools: arg('require-tools') === true });
}

const tauriArgs = dev ? ['dev'] : ['build', '--target', target, '--bundles', bundles, ...(arg('debug') === true ? ['--debug'] : [])];
tauriArgs.push(...externalBinOverride(info, stamp.tools));
console.log(`== tauri ${tauriArgs.join(' ')}`);
const env = tauriEnv();
const ignored = Object.keys(process.env).filter((key) => !(key in env));
if (ignored.length > 0) console.log(`   (ignored because empty: ${ignored.join(', ')})`);
execFileSync(process.execPath, [cli, ...tauriArgs], { cwd: DESKTOP_DIR, stdio: 'inherit', env });
if (!dev) {
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(DESKTOP_DIR, 'src-tauri', 'target');
  const out = path.join(targetDir, target, arg('debug') === true ? 'debug' : 'release', 'bundle');
  if (info.os === 'linux' && bundles.split(',').includes('appimage')) {
    console.log('== AppImage: libraries from the system (appimage.mjs)');
    const dir = path.join(out, 'appimage');
    const images = fs.readdirSync(dir).filter((f) => f.endsWith('.AppImage'));
    if (images.length === 0) throw new Error(`no AppImage in ${dir}`);
    for (const f of images) stripAppImage(path.join(dir, f));
  }
  console.log(`\nbundles: ${out}`);
}
