#!/usr/bin/env node
// Downloads the official Node.js runtime (nodejs.org) for a target and keeps only the executable + LICENSE.
//   node desktop/scripts/fetch-node.mjs --target darwin-arm64|darwin-x64|win-x64|win-arm64|linux-x64|linux-arm64
//                                       [--version 26.10.0] [--out desktop/resources/node]
// Result: <out>/bin/node (macOS, Linux) or <out>/node.exe (Windows), plus <out>/LICENSE.
// The archive is checked against SHASUMS256.txt of that release and cached in desktop/resources/.cache.
// Never Homebrew's node: it links ~20 /opt/homebrew dylibs and does not run on other Macs (DESIGN §19).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESOURCES_DIR, arg, shippedNodeVersion } from './targets.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** bsdtar reads zip archives (Windows 10+ ships it as System32\tar.exe; macOS tar is bsdtar); else unzip. */
function extract(archive, dir, members) {
  if (archive.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', archive, '-C', dir, ...members]);
    return;
  }
  const systemTar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  try {
    execFileSync(systemTar, ['-xf', archive, '-C', dir, ...members]);
  } catch {
    execFileSync('unzip', ['-q', '-o', archive, ...members, '-d', dir]);
  }
}

/**
 * Fetches Node `version` for `target` (nodejs.org dist name, e.g. darwin-arm64) into `out`.
 * Returns the path of the executable.
 */
export async function fetchNode({ version, target, out, cacheDir = path.join(RESOURCES_DIR, '.cache') }) {
  const base = `https://nodejs.org/dist/v${version}`;
  const windows = target.startsWith('win-');
  const inner = `node-v${version}-${target}`;
  const file = windows ? `${inner}.zip` : `${inner}.tar.gz`;
  fs.mkdirSync(cacheDir, { recursive: true });
  const sumsFile = path.join(cacheDir, `SHASUMS256-v${version}.txt`);
  if (!fs.existsSync(sumsFile)) fs.writeFileSync(sumsFile, await download(`${base}/SHASUMS256.txt`));
  const want = fs
    .readFileSync(sumsFile, 'utf8')
    .split('\n')
    .find((line) => line.trim().endsWith(`  ${file}`))
    ?.split(/\s+/)[0];
  if (!want) throw new Error(`no ${file} in SHASUMS256.txt of v${version}`);

  const archive = path.join(cacheDir, file);
  if (!fs.existsSync(archive) || sha256(fs.readFileSync(archive)) !== want) {
    console.log(`downloading ${base}/${file}`);
    const buf = await download(`${base}/${file}`);
    const got = sha256(buf);
    if (got !== want) throw new Error(`sha256 mismatch for ${file}: ${got} != ${want}`);
    fs.writeFileSync(archive, buf);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-node-'));
  try {
    const exe = windows ? 'node.exe' : 'bin/node';
    extract(archive, tmp, [`${inner}/${exe}`, `${inner}/LICENSE`]);
    fs.rmSync(out, { recursive: true, force: true });
    const dest = path.join(out, ...exe.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(tmp, inner, ...exe.split('/')), dest);
    fs.chmodSync(dest, 0o755);
    fs.copyFileSync(path.join(tmp, inner, 'LICENSE'), path.join(out, 'LICENSE'));
    console.log(`node v${version} ${target} -> ${dest} (sha256 ok)`);
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const target = arg('target');
  if (typeof target !== 'string') throw new Error('--target <darwin-arm64|darwin-x64|win-x64|win-arm64|linux-x64|linux-arm64> is required');
  const version = typeof arg('version') === 'string' ? arg('version') : shippedNodeVersion();
  const out = path.resolve(typeof arg('out') === 'string' ? arg('out') : path.join(RESOURCES_DIR, 'node'));
  await fetchNode({ version, target, out });
}
