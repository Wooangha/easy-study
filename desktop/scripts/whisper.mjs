#!/usr/bin/env node
// whisper.cpp's `whisper-cli` for the desktop app (DESIGN §22; the asr spike chose version and flags). Built from the
// pinned source for one target and cached in <repo>/.cache/whisper/<rust triple>/; reused while the source and the
// flags stay the same (stamp.json):
//   node desktop/scripts/whisper.mjs [--target <rust triple, default: this machine>] [--force]
//   node desktop/scripts/whisper.mjs --web     this machine's build, installed where web mode (`npm start`) looks:
//                                              <repo>/.cache/whisper/bin/ (what `npm run setup:whisper` needs)
// Result in .cache/whisper/<triple>/bin/:
//   macOS arm64    whisper-cli: Metal (shaders embedded, compiled on first use) + Accelerate, one file
//   macOS x64      whisper-cli: CPU (AVX2: every Intel Mac that runs macOS 13.5) + Accelerate, one file
//   Linux          whisper-cli: CPU, one file (x64: AVX2), only glibc and libstdc++ (no OpenMP): the app ships it
//                  as the externalBin es-whisper
//   Windows x64    whisper-cli.exe + whisper.dll, ggml*.dll and one ggml-cpu-<level>.dll per x86-64 level (loaded at
//                  run time for the CPU at hand, as whisper.cpp's own releases do), static C runtime (no Visual
//                  C++ Redistributable needed)
// plus LICENSE (whisper.cpp, MIT). Needs cmake and the C/C++ compiler of the Rust toolchain (Xcode command line
// tools, Visual Studio C++ Build Tools, build-essential). A Mac builds both macOS targets; Windows and Linux build
// their own.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBinary } from './binaries.mjs';
import { arg, download, ensureCacheDir, exeName, hasCommand, hostTarget, run, targetInfo, textSha256, untar } from './targets.mjs';

export const WHISPER = {
  version: '1.9.4',
  commit: '927cfce34f31707e17f2bff35c349632fb9e2c3a',
  url: 'https://github.com/ggml-org/whisper.cpp/archive/927cfce34f31707e17f2bff35c349632fb9e2c3a.tar.gz',
  sha256: '41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde',
};

const COMMON = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON', // whisper-cli is an example
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_BUILD_IS_DEV=OFF',
  '-DWHISPER_CURL=OFF',
  '-DWHISPER_SDL2=OFF',
  // Portable: never -march=native of the build machine (the x86-64 level is set below).
  '-DGGML_NATIVE=OFF',
  // No OpenMP: libgomp is not on every Linux (the official Linux build fails on a clean Ubuntu without it) and
  // VCOMP140.DLL is part of the Visual C++ runtime. ggml's own thread pool is used instead.
  '-DGGML_OPENMP=OFF',
  '-DGGML_CCACHE=OFF',
];

/**
 * x86-64-v3 (Haswell, 2013, and later; AMD since 2015) for the one-file x64 builds: ggml's defaults for a portable
 * build, set explicitly because a cross build or SOURCE_DATE_EPOCH would turn them all off.
 */
const X64_V3 = ['-DGGML_SSE42=ON', '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_BMI2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON'];

/** The CMake flags for `target` (a Rust triple). */
export function whisperFlags(target) {
  const info = targetInfo(target);
  if (info.os === 'darwin') {
    const mac = [`-DCMAKE_OSX_ARCHITECTURES=${info.cpu === 'arm64' ? 'arm64' : 'x86_64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.5', '-DBUILD_SHARED_LIBS=OFF'];
    return info.cpu === 'arm64'
      ? [...COMMON, ...mac, '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON']
      : [...COMMON, ...mac, '-DGGML_METAL=OFF', ...X64_V3];
  }
  if (info.os === 'win32') {
    return [
      ...COMMON,
      '-A',
      info.cpu === 'arm64' ? 'ARM64' : 'x64',
      '-DBUILD_SHARED_LIBS=ON',
      '-DGGML_BACKEND_DL=ON',
      ...(info.cpu === 'x64' ? ['-DGGML_CPU_ALL_VARIANTS=ON'] : []),
      // The static C runtime (/MT) in every file; whisper.cpp's root CMakeLists (minimum 3.5) needs the policy.
      '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
      '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
    ];
  }
  return [...COMMON, '-DBUILD_SHARED_LIBS=OFF', ...(info.cpu === 'arm64' ? ['-DGGML_CPU_ARM_ARCH=armv8-a'] : X64_V3)];
}

export function whisperDir(target, cacheDir = ensureCacheDir()) {
  return path.join(cacheDir, 'whisper', target);
}

function stampOf(target) {
  return { version: WHISPER.version, commit: WHISPER.commit, flags: whisperFlags(target), script: textSha256(fileURLToPath(import.meta.url)) };
}

/** The files to ship (absolute paths), or null when the cache has no build of these sources and flags. */
export function cachedWhisper(target, cacheDir) {
  const dir = whisperDir(target, cacheDir);
  const bin = path.join(dir, 'bin');
  const exe = path.join(bin, exeName('whisper-cli', targetInfo(target).os));
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'stamp.json'), 'utf8'));
    if (JSON.stringify(stamp) !== JSON.stringify(stampOf(target)) || !fs.existsSync(exe)) return null;
  } catch {
    return null;
  }
  return { dir: bin, exe, files: fs.readdirSync(bin).map((f) => path.join(bin, f)) };
}

/** Why this machine cannot build `target`, or null. */
export function cannotBuildWhisper(target) {
  const info = targetInfo(target);
  const host = targetInfo(hostTarget());
  if (info.os !== host.os) return `${target}는 ${info.os === 'win32' ? 'Windows' : info.os === 'darwin' ? 'macOS' : 'Linux'}에서 빌드해야 해요`;
  if (info.os !== 'darwin' && info.cpu !== host.cpu) return `${target}는 ${info.cpu} 컴퓨터에서 빌드해야 해요`;
  if (!hasCommand('cmake')) return 'cmake가 없어요 (macOS: brew install cmake, Ubuntu: sudo apt install cmake, Windows: Visual Studio의 C++ CMake 도구)';
  return null;
}

/** Builds whisper-cli for `target` into the cache (or reuses it) and returns what cachedWhisper returns. */
export async function buildWhisper({ target = hostTarget(), force = false, cacheDir } = {}) {
  const info = targetInfo(target);
  if (!force) {
    const cached = cachedWhisper(target, cacheDir);
    if (cached) {
      console.log(`whisper-cli ${WHISPER.version} for ${target}: reusing ${cached.dir}`);
      return cached;
    }
  }
  const why = cannotBuildWhisper(target);
  if (why) throw new Error(`whisper-cli를 빌드할 수 없어요: ${why}`);

  const root = path.join(ensureCacheDir(), 'whisper');
  const archive = await download(WHISPER.url, path.join(root, 'src', `whisper.cpp-${WHISPER.commit}.tar.gz`), WHISPER.sha256);
  const src = path.join(root, 'src', `whisper.cpp-${WHISPER.commit}`);
  if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
    fs.rmSync(src, { recursive: true, force: true });
    untar(archive, path.dirname(src));
  }

  const dir = whisperDir(target, cacheDir);
  const build = path.join(dir, 'build');
  const bin = path.join(dir, 'bin');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  const t = Date.now();
  console.log(`== whisper.cpp ${WHISPER.version} (${WHISPER.commit.slice(0, 7)}) for ${target}`);
  // The source sits inside this repo's .cache: git must not report easy-study's commit (and dirty state) as ggml's.
  run('cmake', ['-S', src, '-B', build, ...whisperFlags(target), `-DWHISPER_BUILD_COMMIT=${WHISPER.commit.slice(0, 7)}`], {
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(src) },
  });
  // whisper-cli and what it loads (with GGML_BACKEND_DL the CPU backends are separate modules: target ggml).
  run('cmake', ['--build', build, '--config', 'Release', '--parallel', '--target', 'whisper-cli', 'ggml']);

  const exe = exeName('whisper-cli', info.os);
  const built = findFile(path.join(build, 'bin'), exe);
  if (!built) throw new Error(`${exe} not found under ${build}`);
  const libs = info.os === 'win32' ? fs.readdirSync(path.dirname(built)).filter((f) => f.toLowerCase().endsWith('.dll')) : [];
  for (const f of [exe, ...libs]) fs.copyFileSync(path.join(path.dirname(built), f), path.join(bin, f));
  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(bin, 'LICENSE'));
  if (info.os !== 'win32') fs.chmodSync(path.join(bin, exe), 0o755);
  if (info.os === 'darwin') {
    // Stripped and re-signed ad hoc (Apple silicon runs only signed code; a release build signs it again).
    run('strip', ['-x', path.join(bin, exe)]);
    run('codesign', ['--force', '--sign', '-', path.join(bin, exe)]);
  } else if (info.os === 'linux') {
    run('strip', [path.join(bin, exe)]);
  }

  for (const f of [exe, ...libs]) {
    const deps = checkBinary(path.join(bin, f), { os: info.os, cpu: info.cpu, own: libs });
    if (f === exe) console.log(`   ${exe} links: ${deps.join(', ') || '(nothing: static)'}`);
  }
  if (info.os === 'win32' && info.cpu === 'x64' && !libs.some((f) => /^ggml-cpu-.+\.dll$/i.test(f))) {
    throw new Error('no ggml-cpu-*.dll was built (GGML_CPU_ALL_VARIANTS)');
  }
  if (target === hostTarget()) {
    // Runs here: a missing library or an instruction this CPU lacks would show now. (-h exits 0.)
    execFileSync(path.join(bin, exe), ['-h'], { stdio: 'ignore' });
  }
  fs.rmSync(build, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'stamp.json'), `${JSON.stringify(stampOf(target), null, 2)}\n`);
  const size = fs.readdirSync(bin).reduce((sum, f) => sum + fs.statSync(path.join(bin, f)).size, 0);
  console.log(`   -> ${bin} (${(size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t) / 1000)} s)`);
  return cachedWhisper(target, cacheDir);
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Web mode (DESIGN §22: the server looks for <repo>/.cache/whisper/bin/whisper-cli after EASY_STUDY_WHISPER): this
 * machine's build, copied there. Returns the program's path.
 */
export async function installForWeb({ force = false } = {}) {
  const built = await buildWhisper({ target: hostTarget(), force });
  const bin = path.join(ensureCacheDir(), 'whisper', 'bin');
  fs.rmSync(bin, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const f of built.files) {
    const dest = path.join(bin, path.basename(f));
    fs.copyFileSync(f, dest);
    fs.chmodSync(dest, f === built.exe || /\.dll$/i.test(f) ? 0o755 : 0o644);
  }
  const exe = path.join(bin, path.basename(built.exe));
  console.log(`whisper-cli for web mode: ${exe}`);
  return exe;
}

if (import.meta.main) {
  if (arg('web') === true) {
    await installForWeb({ force: arg('force') === true });
  } else {
    const target = typeof arg('target') === 'string' ? arg('target') : hostTarget();
    await buildWhisper({ target, force: arg('force') === true });
  }
}
