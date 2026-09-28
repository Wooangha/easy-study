#!/usr/bin/env node
// Builds whisper.cpp's `whisper-cli` (v1.9.4, the engine of DESIGN §22) for this computer into
// <repo>/.cache/whisper/bin/, where the server finds it (after EASY_STUDY_WHISPER and a bundled desktop sidecar,
// before PATH). Models are not part of this: the app downloads them on first use (GET /api/asr, "모델 받기").
//
//   npm run setup:whisper                       download the pinned source (sha256 checked) and build
//   npm run setup:whisper -- --source <dir>     build an existing whisper.cpp checkout instead
//   npm run setup:whisper -- --force            rebuild even when a working binary is there
//
// Needs CMake and a C/C++ compiler: macOS `xcode-select --install` + `brew install cmake`; Debian/Ubuntu
// `sudo apt install build-essential cmake`; Arch `sudo pacman -S base-devel cmake`; Windows: Visual Studio Build Tools
// (C++) + CMake. Flags as in the ASR spike: static, Release, Metal with the shader library embedded on Apple Silicon,
// CPU elsewhere with OpenMP off (no libgomp needed at run time), tuned for this machine's CPU.
// Works in .cache/whisper/setup/ (the desktop build's per-target folders next to it are left alone).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const VERSION = '1.9.4';
const COMMIT = '927cfce34f31707e17f2bff35c349632fb9e2c3a';
const TARBALL_URL = `https://github.com/ggml-org/whisper.cpp/archive/${COMMIT}.tar.gz`;
const TARBALL_SHA256 = '41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'whisper');
const work = path.join(cache, 'setup');
const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const target = path.join(cache, 'bin', exe);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(message) {
  console.error(`\nsetup:whisper 실패: ${message}`);
  process.exit(1);
}

function run(file, argv) {
  console.log(`$ ${[file, ...argv].join(' ')}`);
  const result = spawnSync(file, argv, { stdio: 'inherit' });
  if (result.error) fail(`${file}을(를) 실행할 수 없습니다: ${result.error.message}`);
  if (result.status !== 0) fail(`${file} ${argv[0] ?? ''} 이(가) 실패했습니다 (exit ${result.status})`);
}

function has(file, versionArg = '--version') {
  const result = spawnSync(file, [versionArg], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/** `whisper-cli --version` → "1.9.4…" or null. */
function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    return /whisper\.cpp version:\s*(\S+)/.exec(out)?.[1] ?? null;
  } catch (err) {
    return /whisper\.cpp version:\s*(\S+)/.exec(`${err.stdout ?? ''}${err.stderr ?? ''}`)?.[1] ?? null;
  }
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** The pinned source tarball (downloaded once; a copy the desktop build already fetched is reused). */
async function tarball() {
  const name = `whisper.cpp-${COMMIT}.tar.gz`;
  for (const candidate of [path.join(work, name), path.join(cache, 'src', name)]) {
    if (existsSync(candidate) && (await sha256Of(candidate)) === TARBALL_SHA256) return candidate;
  }
  const file = path.join(work, name);
  console.log(`downloading ${TARBALL_URL}`);
  let res;
  try {
    res = await fetch(TARBALL_URL, { redirect: 'follow' });
  } catch (err) {
    fail(`소스를 내려받을 수 없습니다 (${err.message}). 인터넷 연결을 확인하거나 --source <whisper.cpp 폴더>를 지정하세요.`);
  }
  if (!res.ok) fail(`소스를 내려받을 수 없습니다: HTTP ${res.status} (${TARBALL_URL})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== TARBALL_SHA256) fail(`내려받은 소스의 sha256이 다릅니다: ${digest} (expected ${TARBALL_SHA256})`);
  writeFileSync(file, bytes);
  return file;
}

if (existsSync(target) && !flag('--force')) {
  const version = versionOf(target);
  if (version?.startsWith(VERSION)) {
    console.log(`whisper-cli ${version} is already built: ${path.relative(root, target)} (--force to rebuild)`);
    process.exit(0);
  }
}

if (!has('cmake')) {
  fail(
    'CMake가 없습니다. macOS: `brew install cmake` (+ `xcode-select --install`), Ubuntu: `sudo apt install build-essential cmake`, ' +
      'Arch: `sudo pacman -S base-devel cmake`, Windows: Visual Studio Build Tools(C++) + CMake 를 설치하세요.',
  );
}

mkdirSync(work, { recursive: true });

// --- source ------------------------------------------------------------------------------------------------------
let source = option('--source');
if (source) {
  source = path.resolve(source);
  if (!existsSync(path.join(source, 'CMakeLists.txt'))) fail(`${source} 에 whisper.cpp 소스(CMakeLists.txt)가 없습니다`);
} else {
  source = path.join(work, `whisper.cpp-${COMMIT}`);
  if (!existsSync(path.join(source, 'CMakeLists.txt'))) {
    const file = await tarball();
    if (!has('tar')) fail('tar가 없습니다 (소스 압축을 풀 수 없습니다). --source <whisper.cpp 폴더>를 지정하세요.');
    rmSync(source, { recursive: true, force: true });
    run('tar', ['-xzf', file, '-C', work]);
    if (!existsSync(path.join(source, 'CMakeLists.txt'))) fail(`압축을 풀었지만 ${source} 가 없습니다`);
  }
}

// --- configure + build ---------------------------------------------------------------------------------------------
const build = path.join(work, `build-${process.platform}-${process.arch}`);
const flags = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_BUILD_IS_DEV=OFF',
  '-DWHISPER_CURL=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DGGML_OPENMP=OFF',
];
if (process.platform === 'darwin' && process.arch === 'arm64') flags.push('-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON');
else if (process.platform === 'darwin') flags.push('-DGGML_METAL=OFF');
if (process.platform === 'win32') flags.push('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
if (flag('--force')) rmSync(build, { recursive: true, force: true });
run('cmake', ['-S', source, '-B', build, ...flags]);
const jobs = Number(option('--jobs')) || Math.max(1, os.availableParallelism());
run('cmake', ['--build', build, '--config', 'Release', '-j', String(jobs), '--target', 'whisper-cli']);

// --- install --------------------------------------------------------------------------------------------------------
function findBuilt(dir) {
  for (const candidate of [path.join(dir, 'bin', exe), path.join(dir, 'bin', 'Release', exe)]) if (existsSync(candidate)) return candidate;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findBuilt(path.join(dir, entry.name));
    if (found) return found;
  }
  return null;
}
const built = findBuilt(build);
if (!built) fail(`빌드는 끝났지만 ${exe} 을(를) 찾을 수 없습니다 (${build})`);
if (!versionOf(built)) fail(`${built} 이(가) 실행되지 않습니다`);
mkdirSync(path.dirname(target), { recursive: true });
// Replaced in one step (a running server may look for it at any time).
const tmp = `${target}.${process.pid}.tmp`;
copyFileSync(built, tmp);
if (process.platform !== 'win32') chmodSync(tmp, 0o755);
renameSync(tmp, target);
if (existsSync(path.join(source, 'LICENSE'))) copyFileSync(path.join(source, 'LICENSE'), path.join(path.dirname(target), 'LICENSE'));
const version = versionOf(target);
if (!version) fail(`${target} 이(가) 실행되지 않습니다`);
const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`\nwhisper-cli ${version} → ${path.relative(root, target)} (${mb} MB)`);
console.log('The server finds it by itself (GET /api/asr). Models are downloaded from the app on first use.');
