#!/usr/bin/env node
// whisper.cpp's `whisper-cli` for the desktop app (DESIGN §22; the asr spike chose version and flags). Built from the
// pinned source for one target and cached in <repo>/.cache/whisper/<rust triple>/; reused while the source and the
// flags stay the same (stamp.json):
//   node desktop/scripts/whisper.mjs [--target <rust triple, default: this machine>] [--force] [--require-vulkan]
//   node desktop/scripts/whisper.mjs --web     this machine's build, installed where web mode (`npm start`) looks:
//                                              <repo>/.cache/whisper/bin/ (what `npm run setup:whisper` needs)
//   node desktop/scripts/whisper.mjs --install-vulkan-sdk
//                                              LunarG's Vulkan SDK (VULKAN_SDK below, SHA-256 checked) for this
//                                              machine's build, in <repo>/.cache/vulkan-sdk/ (found there by itself);
//                                              in GitHub Actions also VULKAN_SDK and its bin folder for later steps
// Result in .cache/whisper/<triple>/bin/:
//   macOS arm64    whisper-cli: Metal (shaders embedded, compiled on first use) + Accelerate, one file
//   macOS x64      whisper-cli: CPU (AVX2: every Intel Mac that runs macOS 13.5) + Accelerate, one file
//   Linux          whisper-cli: CPU, one file (x64: AVX2), only glibc and libstdc++ (no OpenMP): the app ships it
//                  as the externalBin es-whisper
//   Linux x64      + whisper-cli-vulkan: the same with ggml's Vulkan backend (GPU), which also links the system's
//                  Vulkan loader libvulkan.so.1 (a computer without it cannot start this one and uses the CPU
//                  build): the externalBin es-whisper-vulkan
//   Windows x64    whisper-cli.exe + whisper.dll, ggml*.dll and one ggml-cpu-<level>.dll per x86-64 level (loaded at
//                  run time for the CPU at hand, as whisper.cpp's own releases do), static C runtime (no Visual
//                  C++ Redistributable needed), OpenMP with MSVC's vcomp140.dll shipped next to them, and ggml's
//                  Vulkan backend as es-ggml-vulkan.dll: renamed so that ggml never loads it by itself (it loads
//                  ggml-vulkan.dll / ggml-vulkan-*.dll from the exe's folder); the server asks for it per run
//                  (GGML_BACKEND_PATH), only on a computer where it found a GPU. It needs the GPU driver's
//                  vulkan-1.dll, never shipped.
//   Windows arm64  like x64 without the CPU variants and without Vulkan
// plus LICENSE (whisper.cpp, MIT). Needs cmake and the C/C++ compiler of the Rust toolchain (Xcode command line
// tools, Visual Studio C++ Build Tools, build-essential), and for the Vulkan part of Windows x64 and Linux x64 the
// Vulkan SDK (--install-vulkan-sdk, or VULKAN_SDK set; on Linux the distribution's glslc and Vulkan/SPIR-V headers
// also do, Ubuntu 24.04 or newer). Without it those two are built CPU-only, with a warning (stamp.json says so: a
// later build with the SDK rebuilds), unless Vulkan is required (vulkanRequired: CI, --require-vulkan,
// EASY_STUDY_REQUIRE_VULKAN=1, prepare.mjs --require-tools), which fails instead. A Mac builds both macOS targets;
// Windows and Linux build their own.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBinary, elfInfo } from './binaries.mjs';
import { CACHE_DIR, arg, download, ensureCacheDir, exeName, hasCommand, hostTarget, run, targetInfo, textSha256, untar } from './targets.mjs';

export const WHISPER = {
  version: '1.9.4',
  commit: '927cfce34f31707e17f2bff35c349632fb9e2c3a',
  url: 'https://github.com/ggml-org/whisper.cpp/archive/927cfce34f31707e17f2bff35c349632fb9e2c3a.tar.gz',
  sha256: '41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde',
};

/**
 * LunarG's Vulkan SDK for building ggml's Vulkan backend (targets with `vulkan`, targets.mjs): the Vulkan and
 * Vulkan-Hpp headers, SPIRV-Headers (with its CMake package), glslc for the compute shaders and the loader to link
 * against. Only the build machine installs it; nothing of it ships (the backend uses the user's Vulkan loader).
 * Pinned here, so the CI cache key (a hash of this file) and stamp.json follow it.
 */
export const VULKAN_SDK = {
  version: '1.4.363.0',
  downloads: {
    // A .tar.xz with 1.4.363.0/x86_64/{bin,include,lib,share}; the loader only in lib/VulkanLoader/lib.
    linux: {
      url: 'https://sdk.lunarg.com/sdk/download/1.4.363.0/linux/vulkansdk-linux-x86_64-1.4.363.0.tar.xz',
      sha256: '197962f5cbf80baf2775a03336a01cee7c8745686c65aaa70d3f751ade4d7e43',
      bytes: 366564872,
    },
    // A Qt installer, run without questions (--root <dir> … install).
    win32: {
      url: 'https://sdk.lunarg.com/sdk/download/1.4.363.0/windows/vulkansdk-windows-X64-1.4.363.0.exe',
      sha256: '94a82d378f7a5e3e54c9db7d2fb7016af136e14ac0a18dbf0f2f67a36352d141',
      bytes: 303082720,
    },
  },
};

/** The Vulkan file of a build next to whisper-cli: Windows ggml's backend module, Linux the second whisper-cli. */
export const VULKAN_FILES = { win32: 'es-ggml-vulkan.dll', linux: 'whisper-cli-vulkan' };

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
  // No OpenMP on macOS and Linux: libgomp is not on every Linux (the official Linux build fails on a clean Ubuntu
  // without it); ggml's own thread pool is used instead. Windows turns it on (whisperFlags).
  '-DGGML_OPENMP=OFF',
  '-DGGML_CCACHE=OFF',
];

/**
 * x86-64-v3 (Haswell, 2013, and later; AMD since 2015) for the one-file x64 builds: ggml's defaults for a portable
 * build, set explicitly because a cross build or SOURCE_DATE_EPOCH would turn them all off.
 */
const X64_V3 = ['-DGGML_SSE42=ON', '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_BMI2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON'];

/**
 * The CMake flags for `target` (a Rust triple). `vulkan: false`: without the Vulkan backend of a target that has one
 * (a build without the Vulkan SDK).
 */
export function whisperFlags(target, { vulkan = true } = {}) {
  const info = targetInfo(target);
  if (info.os === 'darwin') {
    const mac = [`-DCMAKE_OSX_ARCHITECTURES=${info.cpu === 'arm64' ? 'arm64' : 'x86_64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.5', '-DBUILD_SHARED_LIBS=OFF'];
    return info.cpu === 'arm64'
      ? [...COMMON, ...mac, '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON']
      : [...COMMON, ...mac, '-DGGML_METAL=OFF', ...X64_V3];
  }
  if (info.os === 'win32') {
    return [
      // OpenMP, as whisper.cpp's own Windows releases: with MSVC, ggml's own thread pool waits in a busy loop
      // (no pause), and more threads than free CPUs never finish. The Silero VAD always uses 4 threads, so on a
      // 2-CPU computer (GitHub's Windows runner) every transcription hung; OpenMP's threads sleep instead.
      ...COMMON.map((f) => (f === '-DGGML_OPENMP=OFF' ? '-DGGML_OPENMP=ON' : f)),
      '-A',
      info.cpu === 'arm64' ? 'ARM64' : 'x64',
      '-DBUILD_SHARED_LIBS=ON',
      '-DGGML_BACKEND_DL=ON',
      ...(info.cpu === 'x64' ? ['-DGGML_CPU_ALL_VARIANTS=ON'] : []),
      // One more backend module, ggml-vulkan.dll (shipped renamed: VULKAN_FILES).
      ...(info.vulkan && vulkan ? ['-DGGML_VULKAN=ON'] : []),
      // The static C runtime (/MT) in every file; whisper.cpp's root CMakeLists (minimum 3.5) needs the policy.
      '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
      '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
    ];
  }
  return [...COMMON, '-DBUILD_SHARED_LIBS=OFF', ...(info.cpu === 'arm64' ? ['-DGGML_CPU_ARM_ARCH=armv8-a'] : X64_V3)];
}

/**
 * Linux x64: the CMake flags of the second, Vulkan build of whisper-cli (whisper-cli-vulkan), or null. The CPU build's
 * flags plus the backend; no RPATH, since the file ships from the build tree and would otherwise point at the build
 * machine's SDK (the Vulkan loader comes from the system's library path). The SDK's own paths are added at configure
 * time (buildWhisper). `vulkan: false` (no Vulkan SDK): null, no second build.
 */
export function whisperVulkanFlags(target, { vulkan = true } = {}) {
  const info = targetInfo(target);
  if (!info.vulkan || !vulkan || info.os !== 'linux') return null;
  return [...whisperFlags(target), '-DGGML_VULKAN=ON', '-DCMAKE_SKIP_BUILD_RPATH=ON'];
}

export function whisperDir(target, cacheDir = ensureCacheDir()) {
  return path.join(cacheDir, 'whisper', target);
}

/**
 * Windows: MSVC's OpenMP runtime, vcomp140.dll (Visual Studio's redistributable files, VC\Redist\MSVC\<version>\
 * <cpu>\Microsoft.VC<toolset>.OpenMP\), from the newest Visual Studio found by vswhere. It needs only KERNEL32, so
 * shipped next to whisper-cli.exe it spares the user the Visual C++ Redistributable.
 */
export function findVcomp(cpu) {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) throw new Error(`vswhere.exe가 없어요 (${vswhere}): Visual Studio (C++ 빌드 도구)를 설치하세요`);
  const out = execFileSync(vswhere, ['-latest', '-products', '*', '-find', `VC\\Redist\\MSVC\\**\\${cpu}\\Microsoft.VC*.OpenMP\\vcomp140.dll`], { encoding: 'utf8' });
  const found = pickVcomp(out.split(/\r?\n/), cpu);
  if (!found) throw new Error(`vcomp140.dll (${cpu})이 Visual Studio의 VC\\Redist 폴더에 없어요`);
  return found;
}

/** The desktop (not onecore, not spectre) vcomp140.dll of `cpu` with the highest MSVC version among `paths`. */
export function pickVcomp(paths, cpu) {
  const re = new RegExp(`\\\\MSVC\\\\(\\d+)\\.(\\d+)\\.(\\d+)\\\\${cpu}\\\\Microsoft\\.VC\\d+\\.OpenMP\\\\vcomp140\\.dll$`, 'i');
  let best = null;
  for (const p of paths.map((x) => x.trim())) {
    const m = re.exec(p);
    const key = m ? (Number(m[1]) * 1e5 + Number(m[2])) * 1e5 + Number(m[3]) : -1;
    if (m && (!best || key > best.key)) best = { p, key };
  }
  return best?.p ?? null;
}

/**
 * What a cached build must match: the sources, the flags (and the Vulkan SDK where it is used), this script. A target
 * with Vulkan also records whether the build has it (`vulkan: false`: built without the SDK, CPU only).
 */
export function stampOf(target, { vulkan = true } = {}) {
  const info = targetInfo(target);
  const withVulkan = Boolean(info.vulkan && vulkan);
  const vulkanFlags = whisperVulkanFlags(target, { vulkan });
  return {
    version: WHISPER.version,
    commit: WHISPER.commit,
    flags: whisperFlags(target, { vulkan }),
    ...(vulkanFlags ? { vulkanFlags } : {}),
    ...(info.vulkan ? { vulkan: withVulkan } : {}),
    ...(withVulkan ? { vulkanSdk: VULKAN_SDK.version } : {}),
    script: textSha256(fileURLToPath(import.meta.url)),
  };
}

/** The Vulkan file `target`'s build has next to whisper-cli (VULKAN_FILES), or null (also for a build without it). */
export function vulkanFile(target, { vulkan = true } = {}) {
  const info = targetInfo(target);
  return info.vulkan && vulkan ? VULKAN_FILES[info.os] : null;
}

/**
 * The files to ship (absolute paths; `vulkan`: the Vulkan file among them, or null: a target without one, or a build
 * made without the Vulkan SDK), or null when the cache has no build of these sources and flags.
 */
export function cachedWhisper(target, cacheDir) {
  const dir = whisperDir(target, cacheDir);
  const bin = path.join(dir, 'bin');
  const exe = path.join(bin, exeName('whisper-cli', targetInfo(target).os));
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(dir, 'stamp.json'), 'utf8'));
  } catch {
    return null;
  }
  // The stamp of a build with Vulkan (where the target has it), or of one without it (stamp.vulkan false).
  const built = { vulkan: stamp?.vulkan !== false };
  const vulkan = vulkanFile(target, built) && path.join(bin, vulkanFile(target, built));
  if (JSON.stringify(stamp) !== JSON.stringify(stampOf(target, built)) || !fs.existsSync(exe) || (vulkan && !fs.existsSync(vulkan))) return null;
  return { dir: bin, exe, vulkan, files: fs.readdirSync(bin).map((f) => path.join(bin, f)) };
}

/** Where --install-vulkan-sdk puts the SDK: <cache>/vulkan-sdk/<version>/ (the SDK itself: Linux its x86_64/). */
export function vulkanSdkRoot(cacheDir = CACHE_DIR) {
  return path.join(cacheDir, 'vulkan-sdk', VULKAN_SDK.version);
}

/**
 * The Vulkan SDK of this machine for `os`: VULKAN_SDK, else the one --install-vulkan-sdk installed; {dir, bin, glslc}
 * or null.
 */
export function findVulkanSdk(os, { env = process.env, cacheDir = CACHE_DIR } = {}) {
  if (env.VULKAN_SDK) return sdkAt(env.VULKAN_SDK, os);
  const root = vulkanSdkRoot(cacheDir);
  if (!fs.existsSync(`${root}.installed`)) return null;
  return sdkAt(os === 'win32' ? root : path.join(root, 'x86_64'), os);
}

function sdkAt(dir, os) {
  const bin = path.join(dir, os === 'win32' ? 'Bin' : 'bin');
  return { dir, bin, glslc: path.join(bin, exeName('glslc', os)) };
}

/** Why this machine lacks what `target`'s Vulkan build needs, or null (also for a target without one). */
export function vulkanSdkProblem(target, { env = process.env, cacheDir = CACHE_DIR, glslcOnPath = () => hasCommand('glslc') } = {}) {
  const info = targetInfo(target);
  if (!info.vulkan) return null;
  const sdk = findVulkanSdk(info.os, { env, cacheDir });
  if (sdk ? fs.existsSync(sdk.glslc) : info.os === 'linux' && glslcOnPath()) return null;
  return (
    `Vulkan SDK가 없어요 (GPU 받아쓰기 빌드에 필요${sdk ? `, VULKAN_SDK=${sdk.dir}에 glslc가 없어요` : ''}): ` +
    'node desktop/scripts/whisper.mjs --install-vulkan-sdk 로 설치하거나 VULKAN_SDK를 설정하세요' +
    (info.os === 'linux' ? ' (Ubuntu 24.04 이상: sudo apt install libvulkan-dev glslc spirv-headers)' : '')
  );
}

/**
 * Whether a build must have the Vulkan backend where the target has one, failing without the Vulkan SDK instead of
 * building CPU-only: in CI (CI=true), with --require-vulkan or EASY_STUDY_REQUIRE_VULKAN=1 (prepare.mjs
 * --require-tools asks for it too).
 */
export function vulkanRequired({ env = process.env, argv = process.argv } = {}) {
  return /^(true|1)$/i.test(env.CI ?? '') || env.EASY_STUDY_REQUIRE_VULKAN === '1' || argv.includes('--require-vulkan');
}

/** Why this machine cannot build `target`, or null. The Vulkan SDK is vulkanSdkProblem's (buildWhisper). */
export function cannotBuildWhisper(target) {
  const info = targetInfo(target);
  const host = targetInfo(hostTarget());
  if (info.os !== host.os) return `${target}는 ${info.os === 'win32' ? 'Windows' : info.os === 'darwin' ? 'macOS' : 'Linux'}에서 빌드해야 해요`;
  if (info.os !== 'darwin' && info.cpu !== host.cpu) return `${target}는 ${info.cpu} 컴퓨터에서 빌드해야 해요`;
  if (!hasCommand('cmake')) return 'cmake가 없어요 (macOS: brew install cmake, Ubuntu: sudo apt install cmake, Windows: Visual Studio의 C++ CMake 도구)';
  return null;
}

/** `env` with `value` appended to its variable `name` (found case-insensitively, as Windows does), `sep` between. */
function appendEnv(env, name, value, sep) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name) ?? name;
  return { ...env, [key]: [env[key], value].filter(Boolean).join(sep) };
}

/** `env` with the SDK for CMake: VULKAN_SDK (SPIRV-Headers' CMake package), glslc on PATH, its libraries (Linux). */
function vulkanBuildEnv(sdk, os, env) {
  const prepend = (name, dir) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name) ?? name;
    return { [key]: [dir, env[key]].filter(Boolean).join(path.delimiter) };
  };
  return { ...env, VULKAN_SDK: sdk.dir, ...prepend('PATH', sdk.bin), ...(os === 'linux' ? prepend('LD_LIBRARY_PATH', path.join(sdk.dir, 'lib')) : {}) };
}

/** Runs a built program (it must exit 0); returns its stderr. */
function runCheck(file, args, env = process.env) {
  const r = spawnSync(file, args, { encoding: 'utf8', env, timeout: 60_000, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(`${path.basename(file)} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`}):\n${(r.stderr || '').trim().split('\n').slice(-10).join('\n')}`);
  }
  return r.stderr || '';
}

/**
 * Builds whisper-cli for `target` into the cache (or reuses it) and returns what cachedWhisper returns. Without the
 * Vulkan SDK a target with Vulkan is built without it (a warning), unless `requireVulkan` (vulkanRequired).
 */
export async function buildWhisper({ target = hostTarget(), force = false, cacheDir, requireVulkan = vulkanRequired() } = {}) {
  const info = targetInfo(target);
  if (!force) {
    const cached = cachedWhisper(target, cacheDir);
    // A build with Vulkan is reused without the SDK (nothing of it ships); one without it only while the SDK is still
    // missing here and Vulkan is not required.
    if (cached && (cached.vulkan || !info.vulkan || (!requireVulkan && vulkanSdkProblem(target)))) {
      console.log(`whisper-cli ${WHISPER.version} for ${target}: reusing ${cached.dir}${info.vulkan && !cached.vulkan ? ' (CPU only: no Vulkan SDK)' : ''}`);
      return cached;
    }
  }
  const why = cannotBuildWhisper(target);
  if (why) throw new Error(`whisper-cli를 빌드할 수 없어요: ${why}`);
  const sdkProblem = vulkanSdkProblem(target);
  if (sdkProblem && requireVulkan) throw new Error(`whisper-cli를 빌드할 수 없어요: ${sdkProblem}`);
  if (sdkProblem) {
    console.warn(
      `!! whisper-cli: ${sdkProblem}\n` +
        `!! GPU(Vulkan) 없이 CPU용만 빌드해요 (${vulkanFile(target)} 없음). SDK를 설치하고 다시 실행하면 GPU용까지 빌드해요.`,
    );
  }
  // With the Vulkan backend where the target has one and this machine can build it.
  const withVulkan = Boolean(info.vulkan) && !sdkProblem;

  const root = path.join(ensureCacheDir(), 'whisper');
  const archive = await download(WHISPER.url, path.join(root, 'src', `whisper.cpp-${WHISPER.commit}.tar.gz`), WHISPER.sha256);
  const src = path.join(root, 'src', `whisper.cpp-${WHISPER.commit}`);
  if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
    fs.rmSync(src, { recursive: true, force: true });
    untar(archive, path.dirname(src));
  }

  const dir = path.resolve(whisperDir(target, cacheDir));
  const build = path.join(dir, 'build');
  const vulkanBuild = path.join(dir, 'build-vulkan');
  const bin = path.join(dir, 'bin');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  const t = Date.now();
  console.log(`== whisper.cpp ${WHISPER.version} (${WHISPER.commit.slice(0, 7)}) for ${target}`);
  // The Vulkan SDK (null on Linux with the distribution's headers and glslc).
  const sdk = withVulkan ? findVulkanSdk(info.os) : null;
  if (sdk) console.log(`   Vulkan SDK: ${sdk.dir}`);
  // The source sits inside this repo's .cache: git must not report easy-study's commit (and dirty state) as ggml's.
  const env = { ...(sdk ? vulkanBuildEnv(sdk, info.os, process.env) : process.env), GIT_CEILING_DIRECTORIES: path.dirname(src) };
  const commit = `-DWHISPER_BUILD_COMMIT=${WHISPER.commit.slice(0, 7)}`;
  // One job per CPU: a bare --parallel is `make -j` without a limit, and each of the Vulkan backend's ~150 shader
  // files runs up to 16 glslc processes.
  const jobs = String(os.availableParallelism());
  // MSVC: /bigobj, for ggml-vulkan.cpp may pass the default object format's section limit (C1128); harmless
  // elsewhere. Through CXXFLAGS, which CMake puts before its own defaults (/EHsc…) on a first configure;
  // -DCMAKE_CXX_FLAGS would replace them.
  const configureEnv = info.os === 'win32' ? appendEnv(env, 'CXXFLAGS', '/bigobj', ' ') : env;
  run('cmake', ['-S', src, '-B', build, ...whisperFlags(target, { vulkan: withVulkan }), commit], { env: configureEnv });
  // whisper-cli and what it loads (with GGML_BACKEND_DL the CPU and Vulkan backends are separate modules: target ggml).
  run('cmake', ['--build', build, '--config', 'Release', '--parallel', jobs, '--target', 'whisper-cli', 'ggml'], { env });

  const exe = exeName('whisper-cli', info.os);
  const built = findFile(path.join(build, 'bin'), exe);
  if (!built) throw new Error(`${exe} not found under ${build}`);
  const libs = info.os === 'win32' ? fs.readdirSync(path.dirname(built)).filter((f) => f.toLowerCase().endsWith('.dll')) : [];
  for (const f of [exe, ...libs]) fs.copyFileSync(path.join(path.dirname(built), f), path.join(bin, f));
  if (info.os === 'win32') {
    fs.copyFileSync(findVcomp(info.cpu), path.join(bin, 'vcomp140.dll'));
    libs.push('vcomp140.dll');
  }
  if (info.os === 'win32' && withVulkan) {
    // ggml loads ggml-vulkan.dll from the exe's folder on every run by itself: under another name, only when asked.
    const i = libs.findIndex((f) => f.toLowerCase() === 'ggml-vulkan.dll');
    if (i < 0) throw new Error('ggml-vulkan.dll was not built (GGML_VULKAN)');
    fs.renameSync(path.join(bin, libs[i]), path.join(bin, VULKAN_FILES.win32));
    libs[i] = VULKAN_FILES.win32;
    const autoloaded = libs.filter((f) => /^ggml-vulkan(-.*)?\.dll$/i.test(f));
    if (autoloaded.length > 0) throw new Error(`${autoloaded.join(', ')}: ggml would load it on every run`);
    // The Vulkan loader is the GPU driver's (System32), as new as the driver: never one of ours.
    if (libs.some((f) => /^vulkan-1\.dll$/i.test(f))) throw new Error('vulkan-1.dll must not ship (the GPU driver installs it)');
  }
  // Linux x64: the same whisper-cli with the Vulkan backend, a second build (one file each: the CPU build must still
  // start where there is no Vulkan loader).
  const vulkanFlags = whisperVulkanFlags(target, { vulkan: withVulkan });
  const loaderDir = sdk && path.join(sdk.dir, 'lib', 'VulkanLoader', 'lib');
  if (vulkanFlags) {
    // CMake's FindVulkan looks for the loader in $VULKAN_SDK/lib; LunarG's Linux SDK has it one folder down.
    const loader = loaderDir && path.join(loaderDir, 'libvulkan.so');
    run('cmake', ['-S', src, '-B', vulkanBuild, ...vulkanFlags, ...(loader && fs.existsSync(loader) ? [`-DVulkan_LIBRARY=${loader}`] : []), commit], { env });
    run('cmake', ['--build', vulkanBuild, '--config', 'Release', '--parallel', jobs, '--target', 'whisper-cli'], { env });
    const vulkanBuilt = findFile(path.join(vulkanBuild, 'bin'), exe);
    if (!vulkanBuilt) throw new Error(`${exe} not found under ${vulkanBuild}`);
    fs.copyFileSync(vulkanBuilt, path.join(bin, VULKAN_FILES.linux));
  }
  const programs = [exe, ...(vulkanFlags ? [VULKAN_FILES.linux] : [])];
  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(bin, 'LICENSE'));
  if (info.os !== 'win32') for (const f of programs) fs.chmodSync(path.join(bin, f), 0o755);
  if (info.os === 'darwin') {
    // Stripped and re-signed ad hoc (Apple silicon runs only signed code; a release build signs it again).
    run('strip', ['-x', path.join(bin, exe)]);
    run('codesign', ['--force', '--sign', '-', path.join(bin, exe)]);
  } else if (info.os === 'linux') {
    for (const f of programs) run('strip', [path.join(bin, f)]);
  }

  let openmp = false;
  for (const f of [...programs, ...libs]) {
    // The Linux Vulkan build needs the system's Vulkan loader (the packages recommend or depend on it).
    const vulkan = f === VULKAN_FILES.linux;
    const deps = checkBinary(path.join(bin, f), { os: info.os, cpu: info.cpu, own: libs, allow: vulkan ? ['libvulkan.so.1'] : [] });
    if (programs.includes(f)) console.log(`   ${f} links: ${deps.join(', ') || '(nothing: static)'}`);
    if (deps.some((d) => /^vcomp140\.dll$/i.test(d))) openmp = true;
    if (vulkan && !deps.includes('libvulkan.so.1')) throw new Error(`${f} does not link libvulkan.so.1: built without Vulkan (GGML_VULKAN)`);
    if (f === VULKAN_FILES.win32 && !deps.some((d) => /^vulkan-1\.dll$/i.test(d))) throw new Error(`${f} does not import vulkan-1.dll`);
    // Shipped from the build tree: a run path would be the build machine's (the SDK's loader folder).
    if (info.os === 'linux' && elfInfo(fs.readFileSync(path.join(bin, f))).runpath.length > 0) throw new Error(`${f} has an RPATH/RUNPATH`);
  }
  // CMake quietly builds without OpenMP when it finds none.
  if (info.os === 'win32' && !openmp) throw new Error('no DLL uses vcomp140.dll: OpenMP was not found (GGML_OPENMP)');
  if (info.os === 'win32' && info.cpu === 'x64' && !libs.some((f) => /^ggml-cpu-.+\.dll$/i.test(f))) {
    throw new Error('no ggml-cpu-*.dll was built (GGML_CPU_ALL_VARIANTS)');
  }
  if (target === hostTarget()) {
    // Runs here: a missing library or an instruction this CPU lacks would show now. (-h exits 0.)
    execFileSync(path.join(bin, exe), ['-h'], { stdio: 'ignore' });
    if (withVulkan) {
      // The GPU program must start (exit 0) and set up Vulkan, which lists this machine's devices (none is fine: the
      // CPU goes on). Windows: whisper-cli with the renamed module named by GGML_BACKEND_PATH, as the server's GPU
      // runs. Linux: whisper-cli-vulkan has Vulkan built in, which ggml sets up only when asked (by a model;
      // --version alone lists nothing): GGML_BACKEND_PATH asks, here with a file it cannot load (one error line);
      // with the SDK's loader, since the build machine need not have one.
      const gpu =
        info.os === 'win32'
          ? { file: path.join(bin, exe), env: { ...process.env, GGML_BACKEND_PATH: path.join(bin, VULKAN_FILES.win32) } }
          : {
              file: path.join(bin, VULKAN_FILES.linux),
              env: {
                ...process.env,
                GGML_BACKEND_PATH: '/dev/null',
                ...(loaderDir && fs.existsSync(loaderDir) ? { LD_LIBRARY_PATH: [loaderDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : {}),
              },
            };
      const stderr = runCheck(gpu.file, ['--version'], gpu.env);
      for (const line of stderr.split('\n').filter((l) => /vulkan/i.test(l)).slice(0, 6)) console.log(`   ${line.trim()}`);
    }
  }
  fs.rmSync(build, { recursive: true, force: true });
  fs.rmSync(vulkanBuild, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'stamp.json'), `${JSON.stringify(stampOf(target, { vulkan: withVulkan }), null, 2)}\n`);
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
 * machine's build, copied there (with its Vulkan file when the build has one). Returns the program's path.
 */
export async function installForWeb({ force = false, requireVulkan = vulkanRequired() } = {}) {
  const built = await buildWhisper({ target: hostTarget(), force, requireVulkan });
  const bin = path.join(ensureCacheDir(), 'whisper', 'bin');
  fs.rmSync(bin, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const f of built.files) {
    const dest = path.join(bin, path.basename(f));
    fs.copyFileSync(f, dest);
    fs.chmodSync(dest, f === built.exe || f === built.vulkan || /\.dll$/i.test(f) ? 0o755 : 0o644);
  }
  const exe = path.join(bin, path.basename(built.exe));
  console.log(`whisper-cli for web mode: ${exe}${built.vulkan ? ` (GPU: ${path.basename(built.vulkan)})` : ''}`);
  return exe;
}

/**
 * Installs VULKAN_SDK on this machine into <cache>/vulkan-sdk/<version>/, where findVulkanSdk finds it: Linux x64 the
 * tarball unpacked, Windows x64 the installer run without questions (it accepts LunarG's license terms). In GitHub
 * Actions (GITHUB_ENV, GITHUB_PATH) the later steps get VULKAN_SDK and the SDK's bin folder. Returns the SDK.
 */
export async function installVulkanSdk({ target = hostTarget(), cacheDir = ensureCacheDir(), env = process.env } = {}) {
  const info = targetInfo(target);
  const pin = VULKAN_SDK.downloads[info.os];
  if (!info.vulkan || !pin) throw new Error(`${target}에는 Vulkan 빌드가 없어요 (Windows x64, Linux x64만)`);
  if (target !== hostTarget()) throw new Error(`${target}의 Vulkan SDK는 그 컴퓨터에 설치해야 해요`);
  const root = vulkanSdkRoot(cacheDir);
  const sdk = sdkAt(info.os === 'win32' ? root : path.join(root, 'x86_64'), info.os);
  if (!fs.existsSync(`${root}.installed`)) {
    console.log(`== Vulkan SDK ${VULKAN_SDK.version} (${(pin.bytes / 1e6).toFixed(0)} MB)`);
    const file = await download(pin.url, path.join(path.dirname(root), path.basename(new URL(pin.url).pathname)), pin.sha256);
    fs.rmSync(root, { recursive: true, force: true });
    if (info.os === 'win32') {
      run(file, ['--root', root, '--accept-licenses', '--default-answer', '--confirm-command', 'install']);
    } else {
      // Unpacked beside it, then moved into place: a half-unpacked SDK is never taken for one.
      const tmp = fs.mkdtempSync(path.join(path.dirname(root), '.unpack-'));
      untar(file, tmp);
      fs.renameSync(path.join(tmp, VULKAN_SDK.version), root);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (!fs.existsSync(sdk.glslc)) throw new Error(`${sdk.glslc}가 없어요: Vulkan SDK 설치가 끝나지 않았어요`);
    fs.writeFileSync(`${root}.installed`, `${VULKAN_SDK.version}\n`);
    try {
      fs.rmSync(file, { force: true }); // the download is not needed any more (hundreds of MB)
    } catch {}
  }
  console.log(`Vulkan SDK ${VULKAN_SDK.version}: ${sdk.dir}`);
  if (env.GITHUB_ENV) fs.appendFileSync(env.GITHUB_ENV, `VULKAN_SDK=${sdk.dir}\n`);
  if (env.GITHUB_PATH) fs.appendFileSync(env.GITHUB_PATH, `${sdk.bin}\n`);
  if (!env.GITHUB_ENV) {
    console.log('whisper.mjs finds it there by itself. For other tools:');
    console.log(info.os === 'win32' ? `  $env:VULKAN_SDK = "${sdk.dir}"; $env:PATH = "${sdk.bin};$env:PATH"` : `  export VULKAN_SDK="${sdk.dir}" PATH="${sdk.bin}:$PATH"`);
  }
  return sdk;
}

if (import.meta.main) {
  if (arg('install-vulkan-sdk') === true) {
    await installVulkanSdk();
  } else if (arg('web') === true) {
    await installForWeb({ force: arg('force') === true });
  } else {
    const target = typeof arg('target') === 'string' ? arg('target') : hostTarget();
    await buildWhisper({ target, force: arg('force') === true });
  }
}
