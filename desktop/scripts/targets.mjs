// Build targets of the desktop app (DESIGN §19): Rust target triple → the Node runtime to ship and the
// platform whose production node_modules (sharp's @img/sharp-<os>-<cpu> + libvips) go into the bundle.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.dirname(DESKTOP_DIR);
/** Generated and git-ignored: node/, server/, bin/ (Linux externalBin), .cache/ (downloads), target.json. */
export const RESOURCES_DIR = path.join(DESKTOP_DIR, 'resources');

/**
 * node: the nodejs.org dist name. os/cpu/libc: what `npm ci --os --cpu --libc` installs for.
 * nodeAs: 'resource' = resources/node/bin/node or node\node.exe inside the bundle (macOS, Windows);
 *         'externalBin' = /usr/bin/es-node next to the app binary (Linux: never "node", which would clash
 *         with the distribution's nodejs package in deb/rpm).
 */
export const TARGETS = {
  'aarch64-apple-darwin': { node: 'darwin-arm64', os: 'darwin', cpu: 'arm64', nodeAs: 'resource', bundles: ['app', 'dmg'] },
  'x86_64-apple-darwin': { node: 'darwin-x64', os: 'darwin', cpu: 'x64', nodeAs: 'resource', bundles: ['app', 'dmg'] },
  'x86_64-pc-windows-msvc': { node: 'win-x64', os: 'win32', cpu: 'x64', nodeAs: 'resource', bundles: ['nsis'] },
  'aarch64-pc-windows-msvc': { node: 'win-arm64', os: 'win32', cpu: 'arm64', nodeAs: 'resource', bundles: ['nsis'] },
  'x86_64-unknown-linux-gnu': { node: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc', nodeAs: 'externalBin', bundles: ['deb', 'rpm', 'appimage'] },
  'aarch64-unknown-linux-gnu': { node: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc', nodeAs: 'externalBin', bundles: ['deb', 'rpm', 'appimage'] },
};

/** The Rust target triple of this machine. */
export function hostTarget() {
  const key = `${process.platform}-${process.arch}`;
  const triple = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  }[key];
  if (!triple) throw new Error(`no desktop build target for ${key}`);
  return triple;
}

export function targetInfo(triple) {
  const info = TARGETS[triple];
  if (!info) throw new Error(`unknown target "${triple}" (one of: ${Object.keys(TARGETS).join(', ')})`);
  return info;
}

/** The Node version shipped inside the app: desktop/package.json "easyStudy.nodeVersion". */
export function shippedNodeVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'));
  const version = pkg.easyStudy?.nodeVersion;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('desktop/package.json: easyStudy.nodeVersion missing');
  return version;
}

/**
 * The environment for the Tauri CLI: `env` without its EMPTY APPLE_* variables. GitHub Actions passes a secret
 * that is not configured as an empty string, and the CLI would take an empty APPLE_SIGNING_IDENTITY over
 * bundle.macOS.signingIdentity "-" (`codesign -s ""`: "no identity found") and empty APPLE_ID / APPLE_PASSWORD /
 * APPLE_TEAM_ID as notarization credentials. Without them an unsigned build is ad-hoc signed and not notarized.
 */
export function tauriEnv(env = process.env) {
  const out = { ...env };
  for (const [key, value] of Object.entries(out)) {
    if (key.toUpperCase().startsWith('APPLE_') && !value?.trim()) delete out[key];
  }
  return out;
}

/** `--name value` from argv (or the fallback); `--name` alone → true. */
export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

/**
 * Runs npm with `args` in `cwd`, output inherited. Uses npm's own JS entry with this Node when known (npm sets
 * npm_execpath for scripts): Windows cannot spawn npm.cmd without a shell.
 */
export function runNpm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/.test(cli)) {
    execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    execFileSync(`npm ${args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a}"` : a)).join(' ')}`, { cwd, stdio: 'inherit', shell: true });
  } else {
    execFileSync('npm', args, { cwd, stdio: 'inherit' });
  }
}
