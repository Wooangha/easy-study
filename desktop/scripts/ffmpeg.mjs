#!/usr/bin/env node
// The minimal LGPL ffmpeg of the desktop app (DESIGN §22; audio spike): decodes uploaded lecture recordings into the
// ASR WAV and the AAC playback copy. Built for one target into <repo>/.cache/ffmpeg/<rust triple>/ and reused while
// the sources, flags and build script stay the same (stamp.json):
//   node desktop/scripts/ffmpeg.mjs [--target <rust triple, default: this machine>] [--force]
//   node desktop/scripts/ffmpeg.mjs --source-bundle <dir>   the LGPL source for a release (see sourceBundle)
// The sources are downloaded once into .cache/ffmpeg/src and checked against SHA-256. build-ffmpeg.sh does the
// build, here or in a container (docker) when this machine is not the right place for the target:
//   macOS targets    on macOS (Xcode command line tools, cmake, pkg-config; nasm for x86_64)
//   Linux targets    in alpine:3.22 of the target's architecture: a static musl binary (directly when run on alpine)
//   Windows x64      in ubuntu:22.04 with mingw-w64 (directly where x86_64-w64-mingw32-gcc exists)
// CI builds every target this way (.github/workflows/desktop.yml, job ffmpeg) and hands the result to the app build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBinary } from './binaries.mjs';
import { DESKTOP_DIR, REPO_DIR, arg, download, ensureCacheDir, exeName, hasCommand, hostTarget, run, sha256, targetInfo, untar } from './targets.mjs';

export const FFMPEG = {
  version: '8.1',
  url: 'https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz',
  sha256: 'b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a',
};
export const OPUS = {
  version: '1.5.2',
  url: 'https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz',
  sha256: '65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1',
};
const SCRIPT = path.join(DESKTOP_DIR, 'scripts', 'build-ffmpeg.sh');
const FLAGS = path.join(DESKTOP_DIR, 'scripts', 'ffmpeg-min.flags');
/** What a build is made of: a cached build with another stamp is rebuilt. */
function stamp() {
  return { ffmpeg: FFMPEG, opus: OPUS, flags: sha256(FLAGS), script: sha256(SCRIPT), driver: sha256(fileURLToPath(import.meta.url)) };
}

export function ffmpegDir(target, cacheDir = ensureCacheDir()) {
  return path.join(cacheDir, 'ffmpeg', target);
}

/** The build in the cache ({dir, exe, files}), or null when there is none of these sources and flags. */
export function cachedFfmpeg(target, cacheDir) {
  const dir = ffmpegDir(target, cacheDir);
  const exe = path.join(dir, exeName('ffmpeg', targetInfo(target).os));
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'stamp.json'), 'utf8'));
    if (JSON.stringify(saved) !== JSON.stringify(stamp()) || !fs.existsSync(exe)) return null;
  } catch {
    return null;
  }
  const files = fs.readdirSync(dir).filter((f) => f !== 'stamp.json').map((f) => path.join(dir, f));
  return { dir, exe, files };
}

/** How this machine builds `target`: 'here', 'docker' (with the image), or a reason why it cannot. */
export function ffmpegBuildPlan(target, { host = hostTarget(), alpine = fs.existsSync('/etc/alpine-release'), mingw, docker } = {}) {
  const info = targetInfo(target);
  const hostInfo = targetInfo(host);
  const has = (flag, probe) => (flag === undefined ? probe() : flag);
  if (info.os === 'darwin') {
    if (hostInfo.os !== 'darwin') return { error: `${target}는 macOS에서 빌드해야 해요` };
    return { how: 'here' };
  }
  if (info.os === 'linux') {
    if (hostInfo.os === 'linux' && hostInfo.cpu === info.cpu && alpine) return { how: 'here' };
    if (!has(docker, () => hasCommand('docker', ['version']))) return { error: `${target}용 ffmpeg는 alpine 컨테이너에서 빌드해요: docker가 필요해요` };
    return { how: 'docker', platform: `linux/${info.cpu === 'x64' ? 'amd64' : 'arm64'}`, image: 'alpine:3.22', setup: 'apk add --no-cache build-base nasm cmake pkgconf linux-headers >/dev/null' };
  }
  if (info.cpu !== 'x64') return { error: `${target}용 ffmpeg 빌드는 아직 없어요` };
  if (has(mingw, () => hasCommand('x86_64-w64-mingw32-gcc'))) return { how: 'here' };
  if (!has(docker, () => hasCommand('docker', ['version']))) return { error: 'Windows용 ffmpeg는 mingw-w64로 빌드해요: x86_64-w64-mingw32-gcc나 docker가 필요해요' };
  return {
    how: 'docker',
    // The cross compiler runs natively on either architecture.
    image: 'ubuntu:22.04',
    setup: 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends build-essential mingw-w64 nasm cmake pkg-config >/dev/null',
  };
}

/** Builds ffmpeg for `target` into the cache (or reuses it) and returns what cachedFfmpeg returns. */
export async function buildFfmpeg({ target = hostTarget(), force = false, cacheDir } = {}) {
  const info = targetInfo(target);
  if (!force) {
    const cached = cachedFfmpeg(target, cacheDir);
    if (cached) {
      console.log(`ffmpeg ${FFMPEG.version} for ${target}: reusing ${cached.dir}`);
      return cached;
    }
  }
  const plan = ffmpegBuildPlan(target);
  if (plan.error) throw new Error(`ffmpeg를 빌드할 수 없어요: ${plan.error}`);

  const srcDir = path.join(ensureCacheDir(), 'ffmpeg', 'src');
  const ffArchive = await download(FFMPEG.url, path.join(srcDir, path.basename(FFMPEG.url)), FFMPEG.sha256);
  const opusArchive = await download(OPUS.url, path.join(srcDir, path.basename(OPUS.url)), OPUS.sha256);
  const ffSrc = path.join(srcDir, `ffmpeg-${FFMPEG.version}`);
  const opusSrc = path.join(srcDir, `opus-${OPUS.version}`);
  for (const [archive, dir] of [[ffArchive, ffSrc], [opusArchive, opusSrc]]) {
    if (!fs.existsSync(path.join(dir, '.extracted'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      untar(archive, srcDir);
      fs.writeFileSync(path.join(dir, '.extracted'), '');
    }
  }

  const out = ffmpegDir(target, cacheDir);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const env = { FFMPEG_URL: FFMPEG.url, FFMPEG_SHA256: FFMPEG.sha256, OPUS_URL: OPUS.url, OPUS_SHA256: OPUS.sha256 };
  const t = Date.now();
  console.log(`== ffmpeg ${FFMPEG.version} + libopus ${OPUS.version} for ${target} (${plan.how === 'docker' ? `docker ${plan.image}` : 'here'})`);
  if (plan.how === 'here') {
    run('sh', [SCRIPT, target, ffSrc, opusSrc, out], { env: { ...process.env, ...env } });
  } else {
    // The repo is mounted; the container writes into a folder of its own and hands the files over with this
    // user's ownership (a root-owned cache would be in the way on Linux).
    const rel = (p) => path.relative(REPO_DIR, p).split(path.sep).join('/');
    const owner = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : '';
    const inner = [
      plan.setup,
      `sh /repo/${rel(SCRIPT)} ${target} /repo/${rel(ffSrc)} /repo/${rel(opusSrc)} /tmp/out`,
      `cp -R /tmp/out/. /repo/${rel(out)}/`,
      ...(owner ? [`chown -R ${owner} /repo/${rel(out)}`] : []),
    ].join(' && ');
    run('docker', [
      'run', '--rm', ...(plan.platform ? ['--platform', plan.platform] : []), '-v', `${REPO_DIR}:/repo`,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      plan.image, 'sh', '-c', inner,
    ]);
  }
  const exe = path.join(out, exeName('ffmpeg', info.os));
  if (info.os !== 'win32') fs.chmodSync(exe, 0o755);
  const libs = checkBinary(exe, { os: info.os, cpu: info.cpu });
  console.log(`   ffmpeg links: ${libs.join(', ') || '(nothing: static)'}`);
  fs.writeFileSync(path.join(out, 'stamp.json'), `${JSON.stringify(stamp(), null, 2)}\n`);
  console.log(`   -> ${out} (${(fs.statSync(exe).size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t) / 1000)} s)`);
  return cachedFfmpeg(target, cacheDir);
}

/**
 * The complete corresponding source of the shipped ffmpeg (LGPL-2.1; THIRD_PARTY_NOTICES.md), attached to every
 * release next to the app: <dir>/easy-study-ffmpeg-<version>-source.tar with the unmodified FFmpeg and libopus
 * tarballs and the scripts that build them. Returns the file.
 */
export async function sourceBundle(dir) {
  const srcDir = path.join(ensureCacheDir(), 'ffmpeg', 'src');
  const tarballs = [];
  for (const src of [FFMPEG, OPUS]) tarballs.push(await download(src.url, path.join(srcDir, path.basename(src.url)), src.sha256));
  const name = `easy-study-ffmpeg-${FFMPEG.version}-source`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'es-ffmpeg-source-'));
  try {
    const top = path.join(staging, name);
    fs.mkdirSync(path.join(top, 'desktop', 'scripts'), { recursive: true });
    for (const f of tarballs) fs.copyFileSync(f, path.join(top, path.basename(f)));
    // build-ffmpeg.sh does the build; ffmpeg.mjs (with the modules it imports) fetches, checks and drives it.
    for (const f of ['build-ffmpeg.sh', 'ffmpeg-min.flags', 'ffmpeg.mjs', 'targets.mjs', 'binaries.mjs', 'appimage.mjs']) {
      fs.copyFileSync(path.join(DESKTOP_DIR, 'scripts', f), path.join(top, 'desktop', 'scripts', f));
    }
    fs.writeFileSync(
      path.join(top, 'README.txt'),
      [
        `The source of the ffmpeg program in the easy-study desktop app: FFmpeg ${FFMPEG.version} (LGPL-2.1-or-later) with`,
        `libopus ${OPUS.version} (BSD-3-Clause), both unmodified:`,
        ...[FFMPEG, OPUS].map((src) => `  ${path.basename(src.url)}  sha256 ${src.sha256}  (${src.url})`),
        'desktop/scripts/ holds the build: `sh desktop/scripts/build-ffmpeg.sh <rust target triple> <ffmpeg source dir>',
        '<opus source dir> <out dir>` with the configure flags of ffmpeg-min.flags (ffmpeg.mjs chooses the environment',
        'per target: macOS, alpine:3.22, mingw-w64). Each app bundle has the configure line of its build in',
        'ffmpeg/BUILD.txt next to the program.',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.tar`);
    run('tar', ['-cf', file, '-C', staging, name]);
    console.log(`${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
    return file;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (typeof arg('source-bundle') === 'string') {
    await sourceBundle(path.resolve(arg('source-bundle')));
  } else {
    const target = typeof arg('target') === 'string' ? arg('target') : hostTarget();
    await buildFfmpeg({ target, force: arg('force') === true });
  }
}
