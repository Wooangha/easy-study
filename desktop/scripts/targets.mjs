// Build targets of the desktop app (DESIGN §19): Rust target triple → the Node runtime to ship and the
// platform whose production node_modules (sharp's @img/sharp-<os>-<cpu> + libvips) go into the bundle.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.dirname(DESKTOP_DIR);
/**
 * Generated and git-ignored: node/, server/, whisper/, ffmpeg/, bin/ (Linux externalBins), .cache/ (downloads),
 * target.json.
 */
export const RESOURCES_DIR = path.join(DESKTOP_DIR, 'resources');
/**
 * The repo's build cache (never committed): whisper/<triple>/ and ffmpeg/<triple>/ (the recording tools the app
 * ships, DESIGN §22) with their sources, asr-smoke/ (the models of the CI's ASR check).
 */
export const CACHE_DIR = path.join(REPO_DIR, '.cache');

/**
 * node: the nodejs.org dist name. os/cpu/libc: what `npm ci --os --cpu --libc` installs for.
 * nodeAs: 'resource' = resources/node/bin/node or node\node.exe inside the bundle (macOS, Windows);
 *         'externalBin' = /usr/bin/es-node next to the app binary (Linux: never "node", which would clash
 *         with the distribution's nodejs package in deb/rpm). whisper-cli and ffmpeg ship the same way
 *         (resources/whisper/, resources/ffmpeg/ or /usr/bin/es-whisper, /usr/bin/es-ffmpeg).
 * vulkan: whisper-cli also transcribes on the GPU through Vulkan (whisper.mjs; the Vulkan SDK there): Windows
 *         whisper\es-ggml-vulkan.dll, loaded only on request; Linux a second whisper-cli, /usr/bin/es-whisper-vulkan.
 *         The CPU build always ships too (alone from a local build without the Vulkan SDK). No SDK for Linux arm64;
 *         Windows arm64 stays as it is.
 */
export const TARGETS = {
  'aarch64-apple-darwin': { node: 'darwin-arm64', os: 'darwin', cpu: 'arm64', nodeAs: 'resource', bundles: ['app', 'dmg'] },
  'x86_64-apple-darwin': { node: 'darwin-x64', os: 'darwin', cpu: 'x64', nodeAs: 'resource', bundles: ['app', 'dmg'] },
  'x86_64-pc-windows-msvc': { node: 'win-x64', os: 'win32', cpu: 'x64', nodeAs: 'resource', bundles: ['nsis'], vulkan: true },
  'aarch64-pc-windows-msvc': { node: 'win-arm64', os: 'win32', cpu: 'arm64', nodeAs: 'resource', bundles: ['nsis'] },
  'x86_64-unknown-linux-gnu': { node: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc', nodeAs: 'externalBin', bundles: ['deb', 'rpm', 'appimage'], vulkan: true },
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

/**
 * Linux: the externalBins (resources/bin/<name>-<triple> → /usr/bin/<name>) of a build of `info` with the recording
 * tools `tools` (prepare.mjs: `tools` of target.json; a tool left out has no file). whisper brings its Vulkan build
 * (es-whisper-vulkan) only on the targets that have one (x86_64) and only when prepare.mjs placed it
 * (tools['whisper-vulkan']: not without the Vulkan SDK).
 */
export function linuxExternalBins(info, tools = {}) {
  const bins = ['es-node'];
  if (tools.whisper !== false) bins.push('es-whisper', ...(info.vulkan && tools['whisper-vulkan'] === true ? ['es-whisper-vulkan'] : []));
  if (tools.ffmpeg !== false) bins.push('es-ffmpeg');
  return bins;
}

/**
 * The externalBin names in tauri.linux.conf.json: what every Linux build has (never es-whisper-vulkan, which aarch64
 * and a build without the Vulkan SDK lack: `cd desktop && npm run dev` and a plain cargo build take this list).
 */
export const LINUX_EXTERNAL_BINS = ['es-node', 'es-whisper', 'es-ffmpeg'];

/**
 * tauri.linux.conf.json lists the externalBins every complete Linux build has (es-node, es-whisper, es-ffmpeg).
 * build.mjs overrides the list (`tauri build|dev --config`) where the build differs: x86_64 adds es-whisper-vulkan
 * when prepare.mjs placed it, and a local build that left a recording tool out drops it.
 */
export function externalBinOverride(info, tools = {}) {
  if (info.os !== 'linux') return [];
  const bins = linuxExternalBins(info, tools);
  if (bins.join() === LINUX_EXTERNAL_BINS.join()) return [];
  return ['--config', JSON.stringify({ bundle: { externalBin: bins.map((b) => `../resources/bin/${b}`) } })];
}

/** `name` as an executable file name of `os` (name.exe on Windows). */
export function exeName(name, os) {
  return os === 'win32' ? `${name}.exe` : name;
}

/** Keeps <repo>/.cache out of git whatever the repo's .gitignore says (it holds builds and downloads). */
export function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const ignore = path.join(CACHE_DIR, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# build and download cache (desktop/scripts, server): never committed\n*\n');
  return CACHE_DIR;
}

/** SHA-256 of a file or buffer, hex. */
export function sha256(data) {
  return createHash('sha256').update(typeof data === 'string' ? fs.readFileSync(data) : data).digest('hex');
}

/**
 * SHA-256 of a text file with line endings normalised to LF, for build stamps: a Windows checkout may have CRLF, and a
 * stamp must match the one computed on another OS (e.g. a build artifact made on Linux and reused on Windows).
 */
export function textSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

/** Downloads `url` to `file` (through a temporary file) and checks its SHA-256. Reuses a file that matches. */
export async function download(url, file, want) {
  if (fs.existsSync(file) && sha256(file) === want) return file;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`sha256 mismatch for ${url}: ${got} != ${want}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Unpacks a .tar.gz/.tar.xz `archive` into `dir`. Windows: its own bsdtar (System32\tar.exe) — Git's GNU tar,
 * often first on PATH, takes "C:\…" for a remote host.
 */
export function untar(archive, dir) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', dir], { stdio: 'inherit' });
}

/** Runs a program with inherited output; throws with its name on failure. */
export function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

/** Whether `cmd` can be run (`cmd --version` or the given probe arguments). */
export function hasCommand(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
