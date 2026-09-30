// Invariants of the desktop app's configuration (DESIGN §19). Run: node --test desktop/scripts/*.test.mjs
// (npm run desktop:test). The shell's own logic has Rust unit tests: cargo test in desktop/src-tauri.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HOST_LIBRARIES, elfHeader, elfSections, hostLibrariesIn, isHostLibrary } from './appimage.mjs';
import { BACKEND_LINES, SMOKE_MODELS, asrSmoke, mp4Boxes, readWav, toneWav } from './asr-smoke.mjs';
import { checkBinary, elfInfo, machoInfo, peInfo } from './binaries.mjs';
import { FFMPEG, OPUS, ffmpegBuildPlan } from './ffmpeg.mjs';
import { parsePublicKey, parseSignature, trustedFields, verify, verifyTrusted } from './minisign.mjs';
import { RECORDING_TOOLS, placeTool } from './prepare.mjs';
import { DEFAULT_KEY, parseOptions } from './publish-release.mjs';
import {
  CI_UPLOADER,
  CI_WORKFLOW,
  PUBLIC_REPO,
  SERVER_TOP_DIR,
  SERVER_SINCE,
  UPDATER_ARTIFACTS,
  UPDATER_ENDPOINT,
  UPDATER_KEYS,
  UPDATER_KEY_ID,
  appArchiveProblems,
  classifyAsset,
  compareVersions,
  latestJson,
  latestJsonProblems,
  missingAssets,
  notesSummary,
  peResourceRange,
  pkgbuildProblems,
  provenanceProblems,
  publicAssetList,
  readTarGz,
  releaseDownloadUrl,
  serverArchiveProblems,
  serverTarballName,
  sha256sums,
  updaterKeys,
  versionInfoString,
} from './release-assets.mjs';
import { LAUNCHER, gnuTar, serverTarball, stageServerTree } from './server-tarball.mjs';
import { INSTALL_ENTRIES } from '../../server/selfUpdate.ts';
import {
  DESKTOP_DIR,
  LINUX_EXTERNAL_BINS,
  REPO_DIR,
  TARGETS,
  externalBinOverride,
  hostTarget,
  linuxExternalBins,
  shippedNodeVersion,
  targetInfo,
  tauriEnv,
  textSha256,
} from './targets.mjs';
import { APP_TAR_ARGS, e2eConfig, packApp, serveDir, writeLatest } from './update-e2e.mjs';
import {
  VULKAN_FILES,
  VULKAN_SDK,
  WHISPER,
  buildWhisper,
  cachedWhisper,
  findVulkanSdk,
  installVulkanSdk,
  pickVcomp,
  stampOf,
  vulkanFile,
  vulkanRequired,
  vulkanSdkProblem,
  vulkanSdkRoot,
  whisperDir,
  whisperFlags,
  whisperVulkanFlags,
} from './whisper.mjs';

const tauriDir = path.join(DESKTOP_DIR, 'src-tauri');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(tauriDir, file), 'utf8'));
const mainRs = fs.readFileSync(path.join(tauriDir, 'src', 'main.rs'), 'utf8');
const shareRs = fs.readFileSync(path.join(tauriDir, 'src', 'share.rs'), 'utf8');

test('only the bundled chooser page gets IPC: no capability has a `remote` key or other windows', () => {
  const dir = path.join(tauriDir, 'capabilities');
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['chooser.json']);
  for (const file of files) {
    const cap = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(cap.remote, undefined, `${file} must not open IPC to http(s) pages`);
    assert.deepEqual(cap.windows, ['main']);
    // The chooser calls only the app's own commands (allowed for the app's origin without any permission):
    // no core or plugin permission (menus, tray, events, paths, window getters…) is handed out.
    assert.deepEqual(cap.permissions, []);
  }
  const conf = readJson('tauri.conf.json');
  assert.equal(conf.app.withGlobalTauri, false);
  assert.deepEqual(conf.app.windows, [], 'the main window is created in code (drag-drop off, navigation guard)');
  assert.match(conf.app.security.csp, /default-src 'self'/);
  assert.match(conf.app.security.csp, /connect-src ipc: http:\/\/ipc\.localhost/);
});

test('the app identifier stays the same (it names the data, config and WebView storage folders)', () => {
  const conf = readJson('tauri.conf.json');
  assert.equal(conf.identifier, 'dev.easystudy.desktop');
  assert.equal(conf.productName, 'easy-study');
  assert.equal(conf.mainBinaryName, 'easy-study');
  assert.equal(conf.version, '../../package.json');
});

test('per-platform bundles use the resources prepare.mjs writes', () => {
  const mac = readJson('tauri.macos.conf.json').bundle;
  const win = readJson('tauri.windows.conf.json').bundle;
  const linux = readJson('tauri.linux.conf.json').bundle;
  const resources = {
    '../resources/node/': 'node/',
    '../resources/server/': 'server/',
    // The recording tools (DESIGN §22): the programs themselves on macOS/Windows, their licenses everywhere.
    '../resources/whisper/': 'whisper/',
    '../resources/ffmpeg/': 'ffmpeg/',
  };
  for (const b of [mac, win, linux]) assert.deepEqual(b.resources, resources);
  assert.deepEqual(RECORDING_TOOLS.map((t) => t.name), ['whisper', 'ffmpeg']);
  assert.deepEqual(mac.targets, ['app', 'dmg']);
  assert.equal(mac.macOS.signingIdentity, '-');
  assert.deepEqual(win.targets, ['nsis']);
  assert.equal(win.windows.nsis.installMode, 'currentUser');
  assert.equal(win.windows.webviewInstallMode.type, 'downloadBootstrapper');
  // Linux: Node is an externalBin named es-node (/usr/bin/node would clash with the distribution's nodejs); the
  // recording tools the same way (/usr/bin/es-whisper, /usr/bin/es-ffmpeg: never a distribution's ffmpeg). Only what
  // every Linux build has: x86_64's es-whisper-vulkan comes from build.mjs when prepared (externalBinOverride), so
  // `cd desktop && npm run dev` (prepare.mjs + tauri dev) and a plain cargo build work on aarch64 and without the SDK.
  assert.deepEqual(linux.externalBin, ['../resources/bin/es-node', '../resources/bin/es-whisper', '../resources/bin/es-ffmpeg']);
  assert.deepEqual(linux.externalBin, LINUX_EXTERNAL_BINS.map((b) => `../resources/bin/${b}`));
  for (const [triple, info] of Object.entries(TARGETS).filter(([, t]) => t.os === 'linux')) {
    assert.deepEqual(linuxExternalBins(info, { whisper: true, ffmpeg: true }), LINUX_EXTERNAL_BINS, triple);
  }
  assert.equal(readJson('../package.json').scripts.dev, 'node scripts/prepare.mjs && tauri dev');
  assert.ok(linux.linux.deb.depends.includes('libatomic1'));
  assert.ok(linux.linux.deb.recommends.includes('fonts-noto-cjk'));
  // The Vulkan loader for es-whisper-vulkan: recommended, never required (without it the CPU build transcribes).
  assert.ok(linux.linux.deb.recommends.includes('libvulkan1'));
  assert.ok(linux.linux.rpm.recommends.includes('vulkan-loader'));
  for (const kind of ['deb', 'rpm']) assert.ok(!linux.linux[kind].depends.some((d) => /vulkan/.test(d)), kind);
  // xdg-open: external links, "브라우저에서 열기" and "라이브러리 폴더 열기" (tauri-plugin-opener).
  assert.ok(linux.linux.deb.recommends.includes('xdg-utils'));
  assert.ok(linux.linux.rpm.recommends.includes('xdg-utils'));
  assert.deepEqual(linux.targets, ['deb', 'rpm', 'appimage']);
  for (const [triple, info] of Object.entries(TARGETS)) {
    assert.deepEqual(info.bundles, { darwin: mac.targets, win32: win.targets, linux: linux.targets }[info.os], triple);
  }
});

test('build targets map to matching Node downloads and npm platforms', () => {
  for (const [triple, info] of Object.entries(TARGETS)) {
    const nodeOs = { darwin: 'darwin', win32: 'win', linux: 'linux' }[info.os];
    assert.equal(info.node, `${nodeOs}-${info.cpu}`, triple);
    assert.equal(info.nodeAs, info.os === 'linux' ? 'externalBin' : 'resource', triple);
    assert.equal(info.libc, info.os === 'linux' ? 'glibc' : undefined, triple);
    assert.ok(triple.startsWith(info.cpu === 'x64' ? 'x86_64-' : 'aarch64-'), triple);
    // Vulkan (whisper-cli on the GPU): Windows x64 and Linux x64 only (no Linux arm64 SDK; macOS has Metal).
    assert.equal(info.vulkan === true, ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'].includes(triple), triple);
  }
  assert.equal(targetInfo(hostTarget()).os, process.platform);
  assert.throws(() => targetInfo('mips-unknown-linux-gnu'), /unknown target/);
  assert.match(shippedNodeVersion(), /^26\.\d+\.\d+$/);
});

test('the chooser only calls commands the shell registers', () => {
  const handler = /generate_handler!\[([^\]]*)\]/.exec(mainRs);
  assert.ok(handler, 'generate_handler! not found');
  const registered = new Set(handler[1].split(',').map((s) => s.trim()).filter(Boolean));
  const chooser = fs.readFileSync(path.join(DESKTOP_DIR, 'ui', 'chooser.js'), 'utf8');
  const called = new Set([...chooser.matchAll(/invoke\('([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(called.size >= 5);
  for (const cmd of called) assert.ok(registered.has(cmd), `chooser calls unregistered command ${cmd}`);
});

test('macOS: plain http to dotted host names is allowed in the web content (Tailscale MagicDNS, nip.io)', () => {
  const plist = fs.readFileSync(path.join(tauriDir, 'Info.plist'), 'utf8');
  assert.match(plist, /<key>NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/);
});

test('empty APPLE_* variables (GitHub secrets that are not configured) never reach the Tauri CLI', () => {
  const env = tauriEnv({
    PATH: '/usr/bin',
    APPLE_SIGNING_IDENTITY: '',
    APPLE_ID: '  ',
    APPLE_PASSWORD: '',
    APPLE_TEAM_ID: '',
    APPLE_CERTIFICATE: 'base64…',
    EMPTY_OTHER: '',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', APPLE_CERTIFICATE: 'base64…', EMPTY_OTHER: '' });
  const signed = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: X (TEAM123456)', APPLE_TEAM_ID: 'TEAM123456' };
  assert.deepEqual(tauriEnv(signed), signed);
  assert.match(fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'build.mjs'), 'utf8'), /execFileSync\(process\.execPath, \[cli, \.\.\.tauriArgs\], \{[^}]*\benv\b/);
});

test('CI workflow: actions pinned by commit, release assets are files, smoke tests cover the chooser and a dot-folder library', () => {
  const workflow = fs.readFileSync(path.join(REPO_DIR, '.github', 'workflows', 'desktop.yml'), 'utf8');
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(.*)$/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 5);
  // A tag can be moved (the build job gets the APPLE_* secrets, the release job a write token): a full commit, with
  // its tag as a comment for the reader.
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${ref}: owner/repo@<commit> # vX.Y.Z`);
  const pins = new Map();
  for (const ref of uses) {
    const [action, sha] = ref.split(' ')[0].split('@');
    assert.equal(pins.get(action) ?? sha, sha, `${action}: one commit everywhere`);
    pins.set(action, sha);
  }
  // download-artifact puts every bundle kind in its own folder (dist/dmg, dist/deb…): gh wants files.
  assert.match(workflow, /find dist -type f/);
  assert.doesNotMatch(workflow, /gh release create[^\n]*dist\/\*/);
  for (const mode of ['chooser-local', '1']) assert.match(workflow, new RegExp(`EASY_STUDY_DESKTOP_SMOKE=${mode} `), mode);
  // The Linux default library is under ~/.local/share and the AppImage runs from /tmp/.mount_…: dot folders.
  assert.match(workflow, /EASY_STUDY_DESKTOP_LIBRARY="\$RUNNER_TEMP\/\.[^"/]+\/library"/);
  assert.match(workflow, /--appimage-extract/);
});

test('Linux icons: plain NxN files only (an "@2x" file lands in hicolor/<N>x<N>@2, the folder for images twice that size)', () => {
  const linux = readJson('tauri.linux.conf.json').bundle.icon;
  assert.deepEqual(linux, ['icons/32x32.png', 'icons/64x64.png', 'icons/128x128.png', 'icons/256x256.png', 'icons/icon.png']);
  const size = (file) => {
    const png = fs.readFileSync(path.join(tauriDir, file));
    assert.equal(png.toString('latin1', 12, 16), 'IHDR', file);
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };
  for (const file of linux.filter((f) => /\/\d+x\d+\.png$/.test(f))) {
    const n = Number(/(\d+)x\d+\.png$/.exec(file)[1]);
    assert.deepEqual(size(file), [n, n], file);
  }
  assert.deepEqual(size('icons/icon.png'), [512, 512]);
});

test("AppImage: the libraries the user's system must provide are found, and only those", () => {
  // The Vulkan loader too (es-whisper-vulkan): the user's finds the user's GPU drivers.
  assert.deepEqual(HOST_LIBRARIES, ['libwayland-client.so.0', 'libvulkan.so.1']);
  assert.ok(isHostLibrary('libwayland-client.so.0'));
  assert.ok(isHostLibrary('libwayland-client.so.0.20.0'));
  assert.ok(isHostLibrary('libvulkan.so.1'));
  assert.ok(isHostLibrary('libvulkan.so.1.3.204'));
  for (const name of ['libwayland-cursor.so.0', 'libwayland-egl.so.1', 'libwayland-server.so.0', 'libwayland-client.so.00', 'libvulkan.so.10', 'libvulkan_lvp.so']) {
    assert.ok(!isHostLibrary(name), name);
  }
  const paths = [
    'usr/lib/libwayland-client.so.0',
    'usr/lib/libwayland-cursor.so.0',
    'usr/lib/libvulkan.so.1',
    'usr/lib/easy-study/server/libwayland-client.so.0',
    'usr/share/doc/libwayland-client0/copyright',
  ];
  assert.deepEqual(hostLibrariesIn(paths), ['usr/lib/libwayland-client.so.0', 'usr/lib/libvulkan.so.1']);
});

test('AppImage: the squashfs image starts where the runtime ELF section header table ends', () => {
  // A minimal ELF64: sections null, .shstrtab, .digest_md5, then the section header table.
  const strtab = Buffer.from('\0.shstrtab\0.digest_md5\0', 'latin1');
  const shoff = 0x80;
  const buf = Buffer.alloc(shoff + 3 * 64);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2; // ELF64
  buf[5] = 1; // little-endian
  buf.writeBigUInt64LE(BigInt(shoff), 0x28);
  buf.writeUInt16LE(64, 0x3a);
  buf.writeUInt16LE(3, 0x3c);
  buf.writeUInt16LE(1, 0x3e);
  strtab.copy(buf, 0x40);
  const section = (i, nameAt, offset, size) => {
    const b = shoff + i * 64;
    buf.writeUInt32LE(nameAt, b);
    buf.writeBigUInt64LE(BigInt(offset), b + 0x18);
    buf.writeBigUInt64LE(BigInt(size), b + 0x20);
  };
  section(1, 1, 0x40, strtab.length);
  section(2, 11, 0x60, 16);
  assert.equal(elfHeader(buf).end, shoff + 3 * 64);
  assert.deepEqual(elfSections(buf).map((s) => [s.name, s.offset, s.size]), [
    ['', 0, 0],
    ['.shstrtab', 0x40, strtab.length],
    ['.digest_md5', 0x60, 16],
  ]);
  assert.throws(() => elfHeader(Buffer.from('#!/bin/sh\n'.padEnd(64))), /not an ELF file/);
  const elf32 = Buffer.from(buf);
  elf32[4] = 1;
  assert.throws(() => elfHeader(elf32), /ELF64/);
});

test('Linux builds finish the AppImage (appimage.mjs) and CI checks it and runs the bundles on Arch Linux', () => {
  const build = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'build.mjs'), 'utf8');
  assert.match(build, /info\.os === 'linux' && bundles\.split\(','\)\.includes\('appimage'\)/);
  assert.match(build, /stripAppImage\(/);
  const workflow = fs.readFileSync(path.join(REPO_DIR, '.github', 'workflows', 'desktop.yml'), 'utf8');
  assert.match(workflow, /apt-get install[^\n]*\n[^\n]*squashfs-tools/);
  assert.match(workflow, /node desktop\/scripts\/appimage\.mjs --check "\$BUNDLE"\/appimage\/\*\.AppImage/);
  const arch = /\n {2}arch:\n([\s\S]*?)\n {2}release:/.exec(workflow)?.[1];
  assert.ok(arch, 'job arch');
  assert.match(arch, /container: archlinux:latest/);
  assert.match(arch, /--appimage-extract-and-run/);
  for (const mode of ['chooser-local', '1']) assert.match(arch, new RegExp(`for mode in [^\\n]*\\b${mode}\\b`));
  assert.match(arch, /updpkgsums/);
  assert.match(arch, /makepkg -f/);
  assert.match(arch, /pacman -U --noconfirm/);
  assert.match(arch, /pacman -R --noconfirm easy-study-bin/);
  assert.match(workflow, /release:\n[^\n]*\n\s+needs: \[test, build, arch\]/);
});

test('packaging/arch/PKGBUILD installs the .deb of the version CI sets', () => {
  const pkgbuild = fs.readFileSync(path.join(REPO_DIR, 'packaging', 'arch', 'PKGBUILD'), 'utf8');
  assert.match(pkgbuild, /^pkgver=\d+\.\d+\.\d+$/m);
  assert.match(pkgbuild, /^pkgrel=\d+$/m);
  // The names Tauri gives the .deb files (CI copies them next to the PKGBUILD).
  assert.match(pkgbuild, /^source_x86_64=\("\$\{_pkgname\}_\$\{pkgver\}_amd64\.deb::/m);
  assert.match(pkgbuild, /^source_aarch64=\("\$\{_pkgname\}_\$\{pkgver\}_arm64\.deb::/m);
  assert.match(pkgbuild, /^sha256sums_x86_64=\('[0-9a-f]{64}'\)$/m);
  assert.match(pkgbuild, /^sha256sums_aarch64=\('[0-9a-f]{64}'\)$/m);
  assert.match(pkgbuild, /^_pkgname=easy-study$/m);
  // x86_64: es-whisper-vulkan links libvulkan.so.1 (namcap: a dependency); a GPU driver stays optional.
  assert.match(pkgbuild, /^depends_x86_64=\('vulkan-icd-loader'\)$/m);
  assert.match(pkgbuild, /^optdepends_x86_64=\('vulkan-driver: [^']+'\)$/m);
  assert.doesNotMatch(pkgbuild, /^depends=[^)]*vulkan/m);
  const srcinfo = fs.readFileSync(path.join(REPO_DIR, 'packaging', 'arch', '.SRCINFO'), 'utf8');
  assert.match(srcinfo, /\tsource_x86_64 = [^\n]+\n\tdepends_x86_64 = vulkan-icd-loader\n\toptdepends_x86_64 = vulkan-driver: [^\n]+\n\tsha256sums_x86_64 = /);
});

// ---------------------------------------------------------------------------------------------------------------
// Lecture recordings (DESIGN §22): microphone, recording tools, CI
// ---------------------------------------------------------------------------------------------------------------

const mediaRs = fs.readFileSync(path.join(tauriDir, 'src', 'media.rs'), 'utf8');
const serverRs = fs.readFileSync(path.join(tauriDir, 'src', 'server.rs'), 'utf8');
const workflow = () => fs.readFileSync(path.join(REPO_DIR, '.github', 'workflows', 'desktop.yml'), 'utf8');

test('macOS: the microphone is described (Korean and English) and entitled under the hardened runtime', () => {
  const plist = fs.readFileSync(path.join(tauriDir, 'Info.plist'), 'utf8');
  const text = /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  assert.ok(text, 'NSMicrophoneUsageDescription (without it WKWebView has no navigator.mediaDevices)');
  assert.match(text, /[가-힣]/);
  assert.match(text, /microphone/i);
  const mac = readJson('tauri.macos.conf.json').bundle.macOS;
  assert.equal(mac.entitlements, './app.entitlements');
  assert.equal(mac.hardenedRuntime, undefined, 'the hardened runtime stays on (the default)');
  const entitlements = fs.readFileSync(path.join(tauriDir, 'app.entitlements'), 'utf8');
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]);
  // Only the microphone: no JIT, no library validation off, no get-task-allow (notarization) for the app itself.
  assert.deepEqual(keys, [['com.apple.security.device.audio-input', 'true']]);
});

test('Linux and Windows: audio capture only for the local server and a chosen https server', () => {
  // The policy is one function, unit-tested in media.rs (cargo test); here: it is wired to both WebViews.
  assert.match(mediaRs, /pub fn audio_capture_allowed\(page: &str, allowed_origin: Option<&str>, local_server: Option<&str>\) -> bool/);
  assert.match(mediaRs, /local \|\| url\.scheme\(\) == "https"/);
  assert.match(mediaRs, /set_enable_media_stream\(true\)/);
  assert.match(mediaRs, /connect_permission_request/);
  assert.match(mediaRs, /is_for_audio_device\(\) && !media\.is_for_video_device\(\) && !display/);
  assert.match(mediaRs, /add_PermissionRequested/);
  assert.match(mediaRs, /COREWEBVIEW2_PERMISSION_KIND_MICROPHONE/);
  assert.match(mediaRs, /COREWEBVIEW2_PERMISSION_KIND_CAMERA\s*\{\s*unsafe \{ args\.SetState\(COREWEBVIEW2_PERMISSION_STATE_DENY\)/);
  assert.match(mainRs, /media::install\(&h, &window\)/);
  // Recording goes on while the window is minimized or covered (WKWebView would suspend the page).
  assert.match(mainRs, /\.background_throttling\(BackgroundThrottlingPolicy::Disabled\)/);
  const cargo = fs.readFileSync(path.join(tauriDir, 'Cargo.toml'), 'utf8');
  assert.match(cargo, /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]\nwebkit2gtk = \{ version = "2\.0", features = \["v2_40"\] \}/);
  assert.match(cargo, /webview2-com = "0\.38"\nwindows-core = "0\.61"/);
  // The same versions wry links (one copy of each in Cargo.lock).
  const lock = fs.readFileSync(path.join(tauriDir, 'Cargo.lock'), 'utf8');
  for (const [name, re] of [['webkit2gtk', /^2\.0\./], ['webview2-com', /^0\.38\./]]) {
    const versions = [...lock.matchAll(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1]);
    assert.equal(versions.length, 1, name);
    assert.match(versions[0], re, name);
  }
});

test('the shell hands the recording tools and the models folder to the server', () => {
  for (const key of ['EASY_STUDY_WHISPER', 'EASY_STUDY_FFMPEG', 'EASY_STUDY_MODELS_DIR']) assert.ok(serverRs.includes(`"${key}"`), key);
  assert.match(serverRs, /bundled_tool\(res, "whisper", "whisper-cli"\)/);
  assert.match(serverRs, /bundled_tool\(res, "ffmpeg", "ffmpeg"\)/);
  assert.match(serverRs, /beside_app\(&format!\("es-\{dir\}"\)\)/);
  assert.match(serverRs, /config::data_dir\(app\)\.join\("models"\)/);
  assert.match(serverRs, /"EASY_STUDY_DESKTOP_SMOKE_ASR",/);
  // The smoke run asks the server what it found.
  assert.match(mainRs, /fetch\('\/api\/asr'\)/);
  assert.match(mainRs, /a\.engineAvailable === true && a\.ffmpegAvailable === true/);
  // … and checks, without opening the microphone, that the page could record: a secure context with getUserMedia
  // (macOS: only with NSMicrophoneUsageDescription; Linux: enable-media-stream) and AudioWorklet.
  assert.match(mainRs, /s\.recorder = \{ secure: window\.isSecureContext === true, mediaDevices: typeof navigator\.mediaDevices\?\.getUserMedia === 'function',/);
  // … on this computer's server and on a remote server shown through the loopback relay (proxy.rs).
  assert.match(mainRs, /let recorder = !\(local \|\| proxied\) \|\| \["secure", "mediaDevices", "worklet"\]\.iter\(\)\.all/);
  assert.ok(!/getUserMedia\(/.test(mainRs), 'the smoke run never asks for the microphone');
});

// ---------------------------------------------------------------------------------------------------------------
// Sharing with other devices and the loopback relay (DESIGN §16, §19): share.rs, proxy.rs
// ---------------------------------------------------------------------------------------------------------------

const proxyRs = fs.readFileSync(path.join(tauriDir, 'src', 'proxy.rs'), 'utf8');
const bridgeRs = fs.readFileSync(path.join(tauriDir, 'src', 'bridge.rs'), 'utf8');

test('sharing: one dedicated variable the user cannot set, the code never in a log line, the relay is the packed proxy.js', () => {
  // The shell strips what would let the user's environment share the server, make smoke runs write, or force the relay.
  const strip = /pub\(crate\) const STRIP_ENV: &\[&str\] = &\[([^\]]*)\]/.exec(serverRs)?.[1] ?? '';
  for (const key of ['EASY_STUDY_DESKTOP_SHARE', 'EASY_STUDY_DESKTOP_RESET_CODE', 'EASY_STUDY_DESKTOP_FORCE_PROXY', 'EASY_STUDY_DESKTOP_SMOKE_WRITE', 'EASY_STUDY_HOST', 'EASY_STUDY_AUTH']) {
    assert.ok(strip.includes(`"${key}"`), `${key} in STRIP_ENV`);
  }
  // EASY_STUDY_HOST stays loopback in every mode: sharing is EASY_STUDY_DESKTOP_SHARE=1 (server/desktop.ts).
  assert.match(serverRs, /\.env\("EASY_STUDY_HOST", "127\.0\.0\.1"\)/);
  assert.match(serverRs, /const ENV_SHARE: &str = "EASY_STUDY_DESKTOP_SHARE";/);
  assert.match(serverRs, /const ENV_RESET_CODE: &str = "EASY_STUDY_DESKTOP_RESET_CODE";/);
  // The code comes from the library's .auth.json on demand and the shell logs its own window in through /login?code=.
  assert.match(serverRs, /library\.join\("\.auth\.json"\)/);
  assert.match(serverRs, /fn page_url\(app: &AppHandle, url: &str, shared: bool\) -> String \{\n\s+match shared\.then\(\|\| access_code\(app\)\)\.flatten\(\) \{\n\s+Some\(code\) => remote::login_url\(url, &code\)/);
  assert.match(serverRs, /config::log\(app, &format!\("server ready \{url\}\{\}\{\}"/);
  // A change made in the chooser while the server runs: the chooser stays when the server is back (the addresses and
  // the code are there); "연결" opens the page, logged in.
  assert.match(serverRs, /let stay = st\.stay_on_chooser\.load\(SeqCst\);/);
  assert.match(serverRs, /let shared = lock\(&st\.share_urls\)\.is_some\(\);\n\s+crate::go_to\(app, &page_url\(app, &url, shared\)\);/);
  assert.match(shareRs, /st\.stay_on_chooser\.store\(matches!\(from, From::Chooser\), SeqCst\);\n\s+if let Err\(e\) = server::start\(app\)/);
  // A page's share/on and share/reveal go through a native dialog (the page's own session must not be enough).
  assert.match(shareRs, /if let \(Some\(origin\), Change::Share\(true\)\) = \(&page, change\) \{[\s\S]*?bridge::confirm\(app, m\.share\.confirm_on, m\.share\.allow, m\.common\.cancel\)/);
  assert.match(bridgeRs, /fn reveal_code\(app: &AppHandle, origin: &str\) \{[\s\S]*?let ok = confirm\(app, m\.page\.confirm_reveal, m\.page\.reveal, m\.common\.cancel\);/);
  // Page URLs in the log without their query (the login link carries the code).
  assert.match(mainRs, /"page loaded \{\}", without_query\(payload\.url\(\)\)/);
  // The pushed state carries sharing only into this computer's own page, and the code only after share/reveal.
  assert.match(bridgeRs, /let share = local\.then\(\|\| \{\n\s+let urls = lock\(&st\.share_urls\)\.clone\(\);\n\s+ShareState \{/);
  assert.match(bridgeRs, /"share\/on" => Action::Share\(true\)/);
  assert.match(bridgeRs, /"share\/reveal" => Action::ShareReveal/);
  // The relay: the packed server's proxy.js, loopback only, started for one remote origin.
  assert.match(proxyRs, /join\("dist-server"\)\.join\("server"\)\.join\("proxy\.js"\)/);
  assert.match(proxyRs, /\.arg\("--to"\)/);
  assert.match(proxyRs, /cmd\.env\("PORT", port\.to_string\(\)\)/);
  assert.ok(!/EASY_STUDY_DESKTOP"|EASY_STUDY_LIBRARY/.test(proxyRs), 'the relay gets no library and no desktop-mode variable');
  // The microphone policy trusts the relay's origin like the local server's (media.rs allowed()).
  assert.match(mediaRs, /lock\(&st\.server_url\)\.clone\(\)\.or_else\(\|\| lock\(&st\.proxy_url\)\.clone\(\)\)/);
  // The chooser's share block and its commands.
  const html = fs.readFileSync(path.join(DESKTOP_DIR, 'ui', 'index.html'), 'utf8');
  for (const id of ['share', 'share-off', 'share-idle', 'share-info', 'share-urls', 'share-code', 'share-copy', 'share-reset']) assert.match(html, new RegExp(`id="${id}"`), id);
  const chooser = fs.readFileSync(path.join(DESKTOP_DIR, 'ui', 'chooser.js'), 'utf8');
  assert.match(chooser, /invoke\('set_share', \{ on: \$\('share'\)\.checked \}\)/);
  assert.match(chooser, /invoke\('reset_share_code'\)/);
  assert.match(chooser, /navigator\.clipboard\?\.writeText\(text\)/);
  assert.match(chooser, /document\.execCommand\('copy'\)/);
});

test('whisper.cpp: the pinned release, portable flags per target, OpenMP only on Windows', () => {
  assert.equal(WHISPER.version, '1.9.4');
  assert.match(WHISPER.commit, /^927cfce[0-9a-f]{33}$/);
  assert.ok(WHISPER.url.includes(WHISPER.commit));
  assert.match(WHISPER.sha256, /^[0-9a-f]{64}$/);
  for (const triple of Object.keys(TARGETS)) {
    const flags = whisperFlags(triple);
    const info = targetInfo(triple);
    assert.ok(flags.includes('-DGGML_NATIVE=OFF'), triple);
    // Windows: ggml's own thread pool never finishes with more threads than free CPUs (the VAD's fixed 4 on a 2-CPU
    // runner); elsewhere no libgomp.
    assert.equal(flags.includes('-DGGML_OPENMP=ON'), info.os === 'win32', triple);
    assert.equal(flags.includes('-DGGML_OPENMP=OFF'), info.os !== 'win32', triple);
    assert.ok(flags.includes('-DWHISPER_CURL=OFF') && flags.includes('-DWHISPER_SDL2=OFF'), triple);
    const metal = triple === 'aarch64-apple-darwin';
    assert.equal(flags.includes('-DGGML_METAL=ON'), metal, triple);
    if (metal) assert.ok(flags.includes('-DGGML_METAL_EMBED_LIBRARY=ON'));
    if (info.os === 'win32') {
      // DLLs next to the exe (resources/whisper/), the CPU backend chosen at run time, the static C runtime.
      for (const f of ['-DBUILD_SHARED_LIBS=ON', '-DGGML_BACKEND_DL=ON', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW']) {
        assert.ok(flags.includes(f), `${triple} ${f}`);
      }
      assert.equal(flags.includes('-DGGML_CPU_ALL_VARIANTS=ON'), info.cpu === 'x64', triple);
    } else {
      // One file (Linux: an externalBin).
      assert.ok(flags.includes('-DBUILD_SHARED_LIBS=OFF'), triple);
      assert.equal(flags.includes('-DGGML_AVX2=ON'), info.cpu === 'x64', triple);
    }
    // Vulkan: in the Windows x64 build (one more backend module); on Linux x64 a second build (a static file that
    // links the system's Vulkan loader, so the CPU build stays loader-free); nowhere else.
    assert.equal(flags.includes('-DGGML_VULKAN=ON'), triple === 'x86_64-pc-windows-msvc', triple);
    // Without the Vulkan SDK (a local build): the CPU build alone, the same flags otherwise.
    assert.deepEqual(whisperFlags(triple, { vulkan: false }), flags.filter((f) => f !== '-DGGML_VULKAN=ON'), triple);
    assert.equal(whisperVulkanFlags(triple, { vulkan: false }), null, triple);
    // /bigobj (MSVC) comes through CXXFLAGS (buildWhisper): -DCMAKE_CXX_FLAGS would drop CMake's defaults (/EHsc).
    assert.ok(!flags.some((f) => /CMAKE_CXX_FLAGS/.test(f)), triple);
    const vulkan = whisperVulkanFlags(triple);
    if (triple === 'x86_64-unknown-linux-gnu') {
      assert.deepEqual(vulkan, [...flags, '-DGGML_VULKAN=ON', '-DCMAKE_SKIP_BUILD_RPATH=ON']);
      for (const f of ['-DBUILD_SHARED_LIBS=OFF', '-DGGML_AVX2=ON', '-DGGML_OPENMP=OFF']) assert.ok(vulkan.includes(f), f);
    } else {
      assert.equal(vulkan, null, triple);
    }
    assert.ok(!flags.some((f) => /GGML_(CUDA|HIP|SYCL)=ON|GGML_BACKEND_DIR/.test(f)), triple);
  }
});

test('whisper.cpp with Vulkan: the SDK pin, the shipped file names, the cache stamp', () => {
  assert.match(VULKAN_SDK.version, /^1\.\d+\.\d+\.\d+$/);
  // One SDK per OS of the Vulkan targets, from LunarG, for exactly this version, SHA-256 checked.
  const vulkanOs = [...new Set(Object.values(TARGETS).filter((t) => t.vulkan).map((t) => t.os))].sort();
  assert.deepEqual(Object.keys(VULKAN_SDK.downloads).sort(), vulkanOs);
  assert.deepEqual(vulkanOs, ['linux', 'win32']);
  for (const [os_, d] of Object.entries(VULKAN_SDK.downloads)) {
    assert.ok(d.url.startsWith(`https://sdk.lunarg.com/sdk/download/${VULKAN_SDK.version}/${os_ === 'win32' ? 'windows' : 'linux'}/`), d.url);
    assert.ok(d.url.endsWith(os_ === 'win32' ? `-X64-${VULKAN_SDK.version}.exe` : `-x86_64-${VULKAN_SDK.version}.tar.xz`), d.url);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(d.bytes) && d.bytes > 100e6, os_);
  }
  // Windows: never ggml's own names, which it loads from the exe's folder on every run (ggml-vulkan.dll,
  // ggml-vulkan-*.dll); the server asks for this one with GGML_BACKEND_PATH. Linux: <whisper-cli>-vulkan, which the
  // server looks for beside the CPU build (es-whisper → es-whisper-vulkan).
  assert.deepEqual(VULKAN_FILES, { win32: 'es-ggml-vulkan.dll', linux: 'whisper-cli-vulkan' });
  assert.doesNotMatch(VULKAN_FILES.win32, /^ggml-vulkan(-.*)?\.dll$/i);
  for (const triple of Object.keys(TARGETS)) {
    const info = targetInfo(triple);
    assert.equal(vulkanFile(triple), info.vulkan ? VULKAN_FILES[info.os] : null, triple);
    // The stamp names the SDK version where it is used (a new SDK rebuilds), and the second build's flags.
    const stamp = stampOf(triple);
    assert.equal(stamp.vulkanSdk, info.vulkan ? VULKAN_SDK.version : undefined, triple);
    assert.equal(stamp.vulkan, info.vulkan ? true : undefined, triple);
    assert.deepEqual(stamp.vulkanFlags, whisperVulkanFlags(triple) ?? undefined, triple);
    assert.deepEqual(stamp.flags, whisperFlags(triple));
    assert.match(stamp.script, /^[0-9a-f]{64}$/);
    // A build without the Vulkan SDK says so (a later build with it rebuilds); targets without Vulkan are unaffected.
    const cpu = stampOf(triple, { vulkan: false });
    assert.equal(vulkanFile(triple, { vulkan: false }), null, triple);
    if (info.vulkan) {
      assert.deepEqual(cpu, { version: stamp.version, commit: stamp.commit, flags: whisperFlags(triple, { vulkan: false }), vulkan: false, script: stamp.script }, triple);
    } else {
      assert.deepEqual(cpu, stamp, triple);
    }
  }
  const src = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'whisper.mjs'), 'utf8');
  // The rename and the checks of what ships.
  assert.match(src, /fs\.renameSync\(path\.join\(bin, libs\[i\]\), path\.join\(bin, VULKAN_FILES\.win32\)\)/);
  assert.match(src, /if \(libs\.some\(\(f\) => \/\^vulkan-1\\\.dll\$\/i\.test\(f\)\)\) throw/);
  assert.match(src, /allow: vulkan \? \['libvulkan\.so\.1'\] : \[\]/);
  assert.match(src, /GGML_BACKEND_PATH: path\.join\(bin, VULKAN_FILES\.win32\)/);
  // Linux: Vulkan is built in and set up only when asked (a model, or GGML_BACKEND_PATH): --version alone lists nothing.
  assert.match(src, /GGML_BACKEND_PATH: '\/dev\/null'/);
  assert.match(src, /runCheck\(gpu\.file, \['--version'\], gpu\.env\)/);
  assert.match(src, /arg\('install-vulkan-sdk'\) === true/);
  // Without the SDK: CPU only with a warning, or the old failure where Vulkan is required.
  assert.match(src, /if \(sdkProblem && requireVulkan\) throw new Error\(`whisper-cli를 빌드할 수 없어요: \$\{sdkProblem\}`\);/);
  // MSVC's /bigobj through the environment of the Windows configure, after any CXXFLAGS already set.
  assert.match(src, /const configureEnv = info\.os === 'win32' \? appendEnv\(env, 'CXXFLAGS', '\/bigobj', ' '\) : env;/);
  assert.doesNotMatch(src, /'-DCMAKE_CXX_FLAGS/);
  // prepare.mjs --require-tools requires the Vulkan part too, and records whether it is there.
  const prep = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'prepare.mjs'), 'utf8');
  assert.match(prep, /buildWhisper\(\{ target, requireVulkan: required \|\| vulkanRequired\(\) \}\)/);
  assert.match(prep, /if \(tool\.name === 'whisper' && info\.vulkan\) found\['whisper-vulkan'\] = Boolean\(built\?\.vulkan\);/);
});

test('whisper.cpp with Vulkan: required in CI and on request, else a build without the SDK is kept CPU only', async () => {
  // Required: CI (GitHub sets CI=true), --require-vulkan, EASY_STUDY_REQUIRE_VULKAN=1 (and prepare.mjs --require-tools).
  assert.equal(vulkanRequired({ env: {}, argv: ['node', 'whisper.mjs'] }), false);
  assert.equal(vulkanRequired({ env: { CI: 'true' }, argv: [] }), true);
  assert.equal(vulkanRequired({ env: { CI: '1' }, argv: [] }), true);
  assert.equal(vulkanRequired({ env: { CI: 'false' }, argv: [] }), false);
  assert.equal(vulkanRequired({ env: { EASY_STUDY_REQUIRE_VULKAN: '1' }, argv: [] }), true);
  assert.equal(vulkanRequired({ env: {}, argv: ['node', 'whisper.mjs', '--target', 'x86_64-unknown-linux-gnu', '--require-vulkan'] }), true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-whcache-'));
  try {
    // A cached build (fake files) for each Vulkan target, as buildWhisper leaves it.
    const cache = (triple, vulkan, files) => {
      const dir = whisperDir(triple, tmp);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, 'bin', f), f);
      fs.writeFileSync(path.join(dir, 'stamp.json'), `${JSON.stringify(stampOf(triple, { vulkan }), null, 2)}\n`);
      return path.join(dir, 'bin');
    };
    for (const triple of Object.keys(TARGETS).filter((t) => TARGETS[t].vulkan)) {
      const exe = triple.includes('windows') ? 'whisper-cli.exe' : 'whisper-cli';
      // Without the SDK: no Vulkan file, and prepare.mjs / --web get none.
      let bin = cache(triple, false, [exe, 'LICENSE']);
      const cpu = cachedWhisper(triple, tmp);
      assert.deepEqual({ ...cpu, files: cpu.files.sort() }, { dir: bin, exe: path.join(bin, exe), vulkan: null, files: ['LICENSE', exe].sort().map((f) => path.join(bin, f)) }, triple);
      // With it: the Vulkan file must be there.
      bin = cache(triple, true, [exe, 'LICENSE']);
      assert.equal(cachedWhisper(triple, tmp), null, triple);
      bin = cache(triple, true, [exe, vulkanFile(triple), 'LICENSE']);
      assert.equal(cachedWhisper(triple, tmp).vulkan, path.join(bin, vulkanFile(triple)), triple);
      // Vulkan required: a build with it is reused without the SDK (CI's cache hit skips the SDK step)…
      assert.equal((await buildWhisper({ target: triple, cacheDir: tmp, requireVulkan: true })).vulkan, path.join(bin, vulkanFile(triple)), triple);
      // …one without it never: another machine's target fails before downloading anything (this machine's would be
      // rebuilt, so it is left out here).
      if (triple !== hostTarget()) {
        cache(triple, false, [exe, 'LICENSE']);
        await assert.rejects(buildWhisper({ target: triple, cacheDir: tmp, requireVulkan: true }), /whisper-cli를 빌드할 수 없어요/, triple);
      }
      // A stamp of other flags is no build of these.
      cache(triple, false, [exe, 'LICENSE']);
      const stampFile = path.join(whisperDir(triple, tmp), 'stamp.json');
      const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
      fs.writeFileSync(stampFile, JSON.stringify({ ...stamp, flags: [...stamp.flags, '-DGGML_CUDA=ON'] }));
      assert.equal(cachedWhisper(triple, tmp), null, triple);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('whisper.cpp with Vulkan: the SDK is found (VULKAN_SDK, --install-vulkan-sdk, Linux packages) or its absence explained', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-vksdk-'));
  try {
    const none = { env: {}, cacheDir: tmp, glslcOnPath: () => false };
    for (const triple of ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']) {
      assert.match(vulkanSdkProblem(triple, none), /^Vulkan SDK가 없어요 .*node desktop\/scripts\/whisper\.mjs --install-vulkan-sdk/, triple);
    }
    for (const triple of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-pc-windows-msvc', 'aarch64-unknown-linux-gnu']) {
      assert.equal(vulkanSdkProblem(triple, none), null, triple);
    }
    // Linux: the distribution's glslc (and headers) will do; Windows needs the SDK.
    assert.equal(vulkanSdkProblem('x86_64-unknown-linux-gnu', { ...none, glslcOnPath: () => true }), null);
    assert.match(vulkanSdkProblem('x86_64-pc-windows-msvc', { ...none, glslcOnPath: () => true }), /Vulkan SDK가 없어요/);
    // VULKAN_SDK without glslc in it: said so.
    const sdk = path.join(tmp, 'sdk');
    assert.match(vulkanSdkProblem('x86_64-unknown-linux-gnu', { ...none, env: { VULKAN_SDK: sdk } }), /glslc가 없어요/);
    fs.mkdirSync(path.join(sdk, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'bin', 'glslc'), '');
    assert.equal(vulkanSdkProblem('x86_64-unknown-linux-gnu', { ...none, env: { VULKAN_SDK: sdk } }), null);
    assert.deepEqual(findVulkanSdk('win32', { env: { VULKAN_SDK: sdk }, cacheDir: tmp }), { dir: sdk, bin: path.join(sdk, 'Bin'), glslc: path.join(sdk, 'Bin', 'glslc.exe') });
    // --install-vulkan-sdk's folder, used once the install finished (its marker).
    const root = vulkanSdkRoot(tmp);
    assert.equal(root, path.join(tmp, 'vulkan-sdk', VULKAN_SDK.version));
    assert.equal(findVulkanSdk('linux', { env: {}, cacheDir: tmp }), null);
    fs.mkdirSync(path.join(root, 'x86_64', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'x86_64', 'bin', 'glslc'), '');
    assert.equal(findVulkanSdk('linux', { env: {}, cacheDir: tmp }), null, 'not before the install finished');
    fs.writeFileSync(`${root}.installed`, `${VULKAN_SDK.version}\n`);
    assert.equal(findVulkanSdk('linux', { env: {}, cacheDir: tmp }).dir, path.join(root, 'x86_64'));
    assert.equal(findVulkanSdk('win32', { env: {}, cacheDir: tmp }).glslc, path.join(root, 'Bin', 'glslc.exe'));
    assert.equal(vulkanSdkProblem('x86_64-unknown-linux-gnu', { ...none }), null);
    // The installer refuses targets without Vulkan and other machines' targets before downloading anything.
    await assert.rejects(installVulkanSdk({ target: 'aarch64-unknown-linux-gnu', cacheDir: tmp, env: {} }), /Vulkan 빌드가 없어요/);
    const other = hostTarget() === 'x86_64-unknown-linux-gnu' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
    await assert.rejects(installVulkanSdk({ target: other, cacheDir: tmp, env: {} }), /그 컴퓨터에 설치해야/);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'vulkan-sdk')).sort(), [VULKAN_SDK.version, `${VULKAN_SDK.version}.installed`]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('whisper.cpp on Windows: vcomp140.dll from the newest desktop Redist of the CPU', () => {
  const r = 'C:\\VS\\18\\Enterprise\\VC\\Redist\\MSVC\\';
  const paths = [
    `${r}14.29.30133\\x64\\Microsoft.VC142.OpenMP\\vcomp140.dll`,
    `${r}14.51.36231\\onecore\\x64\\Microsoft.VC145.OpenMP\\vcomp140.dll`,
    `${r}14.51.36231\\spectre\\x64\\Microsoft.VC145.OpenMP\\vcomp140.dll`,
    `${r}14.51.36231\\x64\\Microsoft.VC145.OpenMP\\vcomp140.dll\r`,
    `${r}14.44.35112\\x64\\Microsoft.VC143.OpenMP\\vcomp140.dll`,
    `${r}14.44.35112\\arm64\\Microsoft.VC143.OpenMP\\vcomp140.dll`,
    '',
  ];
  assert.equal(pickVcomp(paths, 'x64'), `${r}14.51.36231\\x64\\Microsoft.VC145.OpenMP\\vcomp140.dll`);
  assert.equal(pickVcomp(paths, 'arm64'), `${r}14.44.35112\\arm64\\Microsoft.VC143.OpenMP\\vcomp140.dll`);
  assert.equal(pickVcomp(paths.slice(1, 3), 'x64'), null);
});

test('ffmpeg: the minimal LGPL build of the audio spike', () => {
  const lines = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'ffmpeg-min.flags'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const f of ['--disable-everything', '--disable-autodetect', '--disable-network', '--enable-libopus', '--disable-avdevice']) assert.ok(lines.includes(f), f);
  assert.ok(!lines.some((l) => /--enable-(gpl|nonfree|version3)/.test(l)), 'LGPL 2.1+ only');
  const list = (name) => lines.find((l) => l.startsWith(`--enable-${name}=`)).split('=')[1].split(',');
  // What the server's upload pass needs: any lecture container in, a 16 kHz WAV and an AAC .m4a (+faststart) out.
  for (const d of ['mov', 'matroska', 'mp3', 'wav', 'ogg', 'flac', 'aac']) assert.ok(list('demuxer').includes(d), d);
  for (const d of ['aac', 'opus', 'mp3', 'flac', 'vorbis']) assert.ok(list('decoder').includes(d), d);
  assert.deepEqual(list('encoder'), ['pcm_s16le', 'aac', 'libopus']);
  for (const m of ['wav', 'ipod']) assert.ok(list('muxer').includes(m), m);
  assert.ok(list('filter').includes('aresample'));
  const script = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'build-ffmpeg.sh'), 'utf8');
  assert.match(script, /grep -q '\^License: LGPL version 2\.1 or later'/);
  assert.match(script, /PKG_CONFIG_LIBDIR="\$WORK\/prefix\/lib\/pkgconfig"/);
  assert.equal(FFMPEG.version, '8.1');
  assert.equal(OPUS.version, '1.5.2');
  for (const src of [FFMPEG, OPUS]) {
    assert.match(src.sha256, /^[0-9a-f]{64}$/);
    assert.ok(src.url.startsWith('https://') && src.url.includes(src.version));
  }
});

test('ffmpeg builds where it can: macOS here, Linux in alpine, Windows with mingw-w64', () => {
  const mac = 'aarch64-apple-darwin';
  const linuxArm = 'aarch64-unknown-linux-gnu';
  const linuxX64 = 'x86_64-unknown-linux-gnu';
  const win = 'x86_64-pc-windows-msvc';
  assert.deepEqual(ffmpegBuildPlan(mac, { host: mac }), { how: 'here' });
  assert.deepEqual(ffmpegBuildPlan('x86_64-apple-darwin', { host: mac }), { how: 'here' });
  assert.match(ffmpegBuildPlan(mac, { host: linuxX64 }).error, /macOS/);
  assert.deepEqual(ffmpegBuildPlan(linuxArm, { host: linuxArm, alpine: true }), { how: 'here' });
  const inDocker = ffmpegBuildPlan(linuxX64, { host: mac, docker: true });
  assert.equal(inDocker.how, 'docker');
  assert.equal(inDocker.image, 'alpine:3.22');
  assert.equal(inDocker.platform, 'linux/amd64');
  assert.match(inDocker.setup, /apk add --no-cache build-base nasm cmake pkgconf linux-headers/);
  assert.match(ffmpegBuildPlan(linuxX64, { host: linuxX64, alpine: false, docker: false }).error, /docker/);
  assert.deepEqual(ffmpegBuildPlan(win, { host: linuxX64, mingw: true }), { how: 'here' });
  const winDocker = ffmpegBuildPlan(win, { host: mac, mingw: false, docker: true });
  assert.equal(winDocker.image, 'ubuntu:22.04');
  assert.match(winDocker.setup, /mingw-w64/);
});

test('recording tools land where the shell looks for them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-place-'));
  try {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    const file = (name) => {
      fs.writeFileSync(path.join(src, name), name);
      return path.join(src, name);
    };
    const whisper = RECORDING_TOOLS.find((t) => t.name === 'whisper');
    const ffmpeg = RECORDING_TOOLS.find((t) => t.name === 'ffmpeg');
    const place = (tool, files, triple) => {
      const resources = path.join(tmp, triple);
      return placeTool({ tool, files, target: triple, info: targetInfo(triple), resources });
    };
    // macOS / Windows: resources/<tool>/ (server.rs bundled_tool: <resources>/whisper/whisper-cli[.exe]).
    assert.deepEqual(place(whisper, [file('whisper-cli'), file('LICENSE')], 'aarch64-apple-darwin'), ['whisper/whisper-cli', 'whisper/LICENSE']);
    assert.equal(fs.statSync(path.join(tmp, 'aarch64-apple-darwin', 'whisper', 'whisper-cli')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(tmp, 'aarch64-apple-darwin', 'whisper', 'LICENSE')).mode & 0o777, 0o644);
    assert.deepEqual(place(whisper, [file('whisper-cli.exe'), file('whisper.dll'), file('ggml-cpu-haswell.dll'), file('es-ggml-vulkan.dll'), file('LICENSE')], 'x86_64-pc-windows-msvc'), [
      'whisper/whisper-cli.exe',
      'whisper/whisper.dll',
      'whisper/ggml-cpu-haswell.dll',
      'whisper/es-ggml-vulkan.dll',
      'whisper/LICENSE',
    ]);
    assert.equal(fs.statSync(path.join(tmp, 'x86_64-pc-windows-msvc', 'whisper', 'es-ggml-vulkan.dll')).mode & 0o777, 0o755);
    // Linux x64: whisper-cli's Vulkan build is the externalBin es-whisper-vulkan (→ /usr/bin, beside es-whisper).
    assert.deepEqual(place(whisper, [file('whisper-cli'), file('whisper-cli-vulkan'), file('LICENSE')], 'x86_64-unknown-linux-gnu'), [
      'bin/es-whisper-x86_64-unknown-linux-gnu',
      'bin/es-whisper-vulkan-x86_64-unknown-linux-gnu',
      'whisper/LICENSE',
    ]);
    for (const f of ['es-whisper-x86_64-unknown-linux-gnu', 'es-whisper-vulkan-x86_64-unknown-linux-gnu']) {
      assert.equal(fs.statSync(path.join(tmp, 'x86_64-unknown-linux-gnu', 'bin', f)).mode & 0o777, 0o755, f);
    }
    assert.deepEqual(place(whisper, [file('whisper-cli'), file('LICENSE')], 'aarch64-unknown-linux-gnu'), ['bin/es-whisper-aarch64-unknown-linux-gnu', 'whisper/LICENSE']);
    // Linux: the externalBin es-<tool>-<triple> (→ /usr/bin/es-<tool>), licenses in resources/<tool>/.
    assert.deepEqual(place(ffmpeg, [file('ffmpeg'), file('COPYING.LGPLv2.1'), file('BUILD.txt')], 'x86_64-unknown-linux-gnu'), [
      'bin/es-ffmpeg-x86_64-unknown-linux-gnu',
      'ffmpeg/COPYING.LGPLv2.1',
      'ffmpeg/BUILD.txt',
    ]);
    assert.throws(() => place(ffmpeg, [file('BUILD.txt')], 'aarch64-apple-darwin'), /ffmpeg missing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The config lists what every Linux build has; x86_64 adds es-whisper-vulkan only when prepare.mjs placed it
  // (target.json's tools), and a local build without a tool drops it from the externalBin list.
  const linux = targetInfo('x86_64-unknown-linux-gnu');
  const arm = targetInfo('aarch64-unknown-linux-gnu');
  const override = (info, tools) => {
    const args = externalBinOverride(info, tools);
    if (args.length === 0) return null;
    assert.equal(args[0], '--config');
    return JSON.parse(args[1]).bundle.externalBin.map((b) => b.replace('../resources/bin/', ''));
  };
  assert.deepEqual(LINUX_EXTERNAL_BINS, ['es-node', 'es-whisper', 'es-ffmpeg']);
  const full = { whisper: true, 'whisper-vulkan': true, ffmpeg: true };
  assert.deepEqual(override(linux, full), ['es-node', 'es-whisper', 'es-whisper-vulkan', 'es-ffmpeg']);
  // x86_64 without the Vulkan SDK (tools['whisper-vulkan'] false), or a target.json that does not say: none.
  assert.equal(override(linux, { ...full, 'whisper-vulkan': false }), null);
  assert.equal(override(linux, { whisper: true, ffmpeg: true }), null);
  assert.equal(override(arm, { whisper: true, ffmpeg: true }), null);
  assert.equal(override(arm, full), null, 'never on aarch64');
  assert.equal(override(targetInfo('aarch64-apple-darwin'), { whisper: false, ffmpeg: false }), null);
  assert.equal(override(targetInfo('x86_64-pc-windows-msvc'), full), null);
  assert.deepEqual(override(linux, { ...full, ffmpeg: false }), ['es-node', 'es-whisper', 'es-whisper-vulkan']);
  assert.deepEqual(override(linux, { whisper: false, 'whisper-vulkan': false, ffmpeg: true }), ['es-node', 'es-ffmpeg']);
  assert.deepEqual(override(arm, { whisper: false, ffmpeg: false }), ['es-node']);
  // build.mjs passes it on (with --skip-prepare too: target.json's tools).
  assert.match(fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'build.mjs'), 'utf8'), /tauriArgs\.push\(\.\.\.externalBinOverride\(info, stamp\.tools\)\);/);
});

/** A minimal thin Mach-O 64 with LC_LOAD_DYLIB commands. */
function machO(cputype, dylibs) {
  const cmds = dylibs.map((name) => {
    const str = Buffer.from(`${name}\0`);
    const size = Math.ceil((24 + str.length) / 8) * 8;
    const cmd = Buffer.alloc(size);
    cmd.writeUInt32LE(0xc, 0);
    cmd.writeUInt32LE(size, 4);
    cmd.writeUInt32LE(24, 8);
    str.copy(cmd, 24);
    return cmd;
  });
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cputype, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(cmds.length, 16);
  header.writeUInt32LE(cmds.reduce((n, c) => n + c.length, 0), 20);
  return Buffer.concat([header, ...cmds]);
}

/** A minimal ELF64 with .dynstr, .dynamic (DT_NEEDED entries, then DT_RUNPATH ones) and .shstrtab. */
function elf(machine, needed, runpath = []) {
  const entries = [...needed.map((name) => [1n, name]), ...runpath.map((dir) => [29n, dir])];
  const dynstr = Buffer.from(`\0${entries.map((e) => e[1]).join('\0')}\0`, 'latin1');
  const dynamic = Buffer.alloc((entries.length + 1) * 16);
  let at = 1;
  entries.forEach(([tag, name], i) => {
    dynamic.writeBigInt64LE(tag, i * 16);
    dynamic.writeBigUInt64LE(BigInt(at), i * 16 + 8);
    at += name.length + 1;
  });
  const shstr = Buffer.from('\0.dynstr\0.dynamic\0.shstrtab\0', 'latin1');
  const off = { dynstr: 0x40, dynamic: 0x40 + dynstr.length, shstr: 0x40 + dynstr.length + dynamic.length };
  const shoff = Math.ceil((off.shstr + shstr.length) / 8) * 8;
  const buf = Buffer.alloc(shoff + 4 * 64);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2;
  buf[5] = 1;
  buf.writeUInt16LE(machine, 0x12);
  buf.writeBigUInt64LE(BigInt(shoff), 0x28);
  buf.writeUInt16LE(64, 0x3a);
  buf.writeUInt16LE(4, 0x3c);
  buf.writeUInt16LE(3, 0x3e);
  dynstr.copy(buf, off.dynstr);
  dynamic.copy(buf, off.dynamic);
  shstr.copy(buf, off.shstr);
  const section = (i, nameAt, offset, size) => {
    buf.writeUInt32LE(nameAt, shoff + i * 64);
    buf.writeBigUInt64LE(BigInt(offset), shoff + i * 64 + 0x18);
    buf.writeBigUInt64LE(BigInt(size), shoff + i * 64 + 0x20);
  };
  section(1, 1, off.dynstr, dynstr.length);
  section(2, 9, off.dynamic, dynamic.length);
  section(3, 18, off.shstr, shstr.length);
  return buf;
}

/** A minimal PE32+ with one section holding the import descriptors and DLL names. */
function pe(machine, dlls) {
  const buf = Buffer.alloc(0x400);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x40, 0x3c);
  buf.write('PE\0\0', 0x40, 'latin1');
  const coff = 0x44;
  buf.writeUInt16LE(machine, coff);
  buf.writeUInt16LE(1, coff + 2);
  buf.writeUInt16LE(240, coff + 16);
  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt);
  buf.writeUInt32LE(16, opt + 108);
  buf.writeUInt32LE(0x1000, opt + 120); // import table RVA
  const sec = opt + 240;
  buf.write('.idata', sec, 'latin1');
  buf.writeUInt32LE(0x200, sec + 8); // virtual size
  buf.writeUInt32LE(0x1000, sec + 12); // virtual address
  buf.writeUInt32LE(0x200, sec + 16); // raw size
  buf.writeUInt32LE(0x200, sec + 20); // raw pointer
  let names = 0x200 + (dlls.length + 1) * 20;
  dlls.forEach((dll, i) => {
    buf.writeUInt32LE(0x1000 + (names - 0x200), 0x200 + i * 20 + 12);
    buf.write(`${dll}\0`, names, 'latin1');
    names += dll.length + 1;
  });
  return buf;
}

test('shipped programs: right CPU, only the OS libraries', () => {
  assert.deepEqual(machoInfo(machO(0x0100000c, ['/usr/lib/libSystem.B.dylib', '/opt/homebrew/lib/libopus.0.dylib'])), {
    cpu: 'arm64',
    dylibs: ['/usr/lib/libSystem.B.dylib', '/opt/homebrew/lib/libopus.0.dylib'],
  });
  assert.equal(machoInfo(machO(0x01000007, [])).cpu, 'x64');
  assert.throws(() => machoInfo(Buffer.from('cafebabe00000002'.padEnd(64, '0'), 'hex')), /universal/);
  assert.deepEqual(elfInfo(elf(62, ['libstdc++.so.6', 'libgomp.so.1', 'libc.so.6'])), { cpu: 'x64', needed: ['libstdc++.so.6', 'libgomp.so.1', 'libc.so.6'], runpath: [] });
  assert.deepEqual(elfInfo(elf(183, [])), { cpu: 'arm64', needed: [], runpath: [] });
  // A run path (whisper.mjs refuses one: it would be the build machine's).
  assert.deepEqual(elfInfo(elf(62, ['libvulkan.so.1'], ['/home/runner/sdk/lib'])), { cpu: 'x64', needed: ['libvulkan.so.1'], runpath: ['/home/runner/sdk/lib'] });
  assert.deepEqual(peInfo(pe(0x8664, ['whisper.dll', 'KERNEL32.dll', 'VCRUNTIME140.dll'])), { cpu: 'x64', imports: ['whisper.dll', 'KERNEL32.dll', 'VCRUNTIME140.dll'] });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-bin-'));
  try {
    const check = (buf, opts) => {
      const f = path.join(tmp, 'x');
      fs.writeFileSync(f, buf);
      return checkBinary(f, opts);
    };
    assert.deepEqual(check(machO(0x0100000c, ['/usr/lib/libc++.1.dylib', '/System/Library/Frameworks/Metal.framework/Versions/A/Metal']), { os: 'darwin', cpu: 'arm64' }).length, 2);
    // Homebrew's dylibs are only on the build machine.
    assert.throws(() => check(machO(0x0100000c, ['/opt/homebrew/lib/libopus.0.dylib']), { os: 'darwin', cpu: 'arm64' }), /libopus/);
    assert.throws(() => check(machO(0x01000007, []), { os: 'darwin', cpu: 'arm64' }), /built for x64, not arm64/);
    assert.deepEqual(check(elf(183, []), { os: 'linux', cpu: 'arm64' }), []);
    check(elf(62, ['libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libc.so.6', 'ld-linux-x86-64.so.2']), { os: 'linux', cpu: 'x64' });
    // OpenMP's runtime is not on every Linux (the official whisper.cpp build fails on a clean Ubuntu).
    assert.throws(() => check(elf(62, ['libgomp.so.1', 'libc.so.6']), { os: 'linux', cpu: 'x64' }), /libgomp/);
    // The Vulkan loader only where the call allows it (whisper-cli-vulkan; the packages recommend or depend on it).
    const vulkan = elf(62, ['libvulkan.so.1', 'libstdc++.so.6', 'libc.so.6']);
    assert.throws(() => check(vulkan, { os: 'linux', cpu: 'x64' }), /libvulkan\.so\.1/);
    assert.deepEqual(check(vulkan, { os: 'linux', cpu: 'x64', allow: ['libvulkan.so.1'] }), ['libvulkan.so.1', 'libstdc++.so.6', 'libc.so.6']);
    assert.throws(() => check(vulkan, { os: 'linux', cpu: 'x64' }), /libvulkan\.so\.1/, 'not remembered between calls');
    assert.throws(() => check(elf(62, ['libvulkan.so.1', 'libgomp.so.1']), { os: 'linux', cpu: 'x64', allow: ['libvulkan.so.1'] }), /libgomp/);
    // Windows: ggml's Vulkan module imports the GPU driver's vulkan-1.dll (never shipped): an OS library.
    check(pe(0x8664, ['vulkan-1.dll', 'ggml-base.dll', 'KERNEL32.dll']), { os: 'win32', cpu: 'x64', own: ['ggml-base.dll'] });
    check(pe(0x8664, ['whisper.dll', 'ggml.dll', 'KERNEL32.dll', 'ADVAPI32.dll', 'msvcrt.dll']), { os: 'win32', cpu: 'x64', own: ['whisper.dll', 'ggml.dll'] });
    // Not the Visual C++ runtime (a user need not have it), and no DLL that is neither Windows' nor shipped.
    assert.throws(() => check(pe(0x8664, ['VCRUNTIME140.dll', 'KERNEL32.dll']), { os: 'win32', cpu: 'x64' }), /VCRUNTIME140/);
    assert.throws(() => check(pe(0x8664, ['api-ms-win-crt-heap-l1-1-0.dll']), { os: 'win32', cpu: 'x64' }), /api-ms-win-crt/);
    assert.throws(() => check(pe(0x8664, ['libwinpthread-1.dll']), { os: 'win32', cpu: 'x64' }), /libwinpthread/);
    // MSVC's OpenMP runtime only when it ships next to the file (whisper-cli on Windows).
    assert.throws(() => check(pe(0x8664, ['VCOMP140.DLL', 'KERNEL32.dll']), { os: 'win32', cpu: 'x64' }), /VCOMP140/);
    check(pe(0x8664, ['VCOMP140.DLL', 'KERNEL32.dll']), { os: 'win32', cpu: 'x64', own: ['vcomp140.dll'] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ASR smoke: WAV and MP4 readers, and the whole check with fake tools (no network, no microphone)', { skip: process.platform === 'win32' && 'the fake tools are Node scripts with a #! line' }, async () => {
  const wav = readWav(toneWav(3, 44100, 2));
  assert.deepEqual(wav, { format: 1, channels: 2, rate: 44100, bits: 16, seconds: 3 });
  const box = (type, size) => {
    const b = Buffer.alloc(size);
    b.writeUInt32BE(size, 0);
    b.write(type, 4, 'latin1');
    return b;
  };
  assert.deepEqual(mp4Boxes(Buffer.concat([box('ftyp', 24), box('moov', 100), box('free', 8), box('mdat', 64)])), ['ftyp', 'moov', 'free', 'mdat']);
  assert.throws(() => mp4Boxes(Buffer.from([0, 0, 0, 4, 0x66, 0x74, 0x79, 0x70])), /broken MP4 box/);
  for (const m of Object.values(SMOKE_MODELS)) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.match(m.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//, 'a pinned revision');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-asr-'));
  try {
    const script = (name, body) => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, `#!${process.execPath}\n${body}`, { mode: 0o755 });
      return f;
    };
    // ffmpeg: writes each output (WAV: 16 kHz mono s16 of the input's length; .m4a: ftyp moov mdat).
    const ffmpeg = script('ffmpeg', `
      const fs = require('fs');
      const args = process.argv.slice(2);
      const outs = args.filter((a, i) => /\\.(wav|m4a)$/.test(a) && args[i - 1] !== '-i');
      for (const out of outs) {
        if (out.endsWith('.wav')) {
          const data = Buffer.alloc(16000 * 2 * 3);
          const h = Buffer.alloc(44);
          h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
          h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
          h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
          fs.writeFileSync(out, Buffer.concat([h, data]));
        } else {
          const box = (t, n) => { const b = Buffer.alloc(n); b.writeUInt32BE(n, 0); b.write(t, 4); return b; };
          fs.writeFileSync(out, Buffer.concat([box('ftyp', 24), box('moov', 64), box('mdat', 128)]));
        }
      }
      if (args.includes('pipe:1')) process.stdout.write('out_time_us=3000000\\nprogress=end\\n');
    `);
    const whisper = script('whisper-cli', `
      const fs = require('fs');
      const args = process.argv.slice(2);
      const at = (flag) => args[args.indexOf(flag) + 1];
      for (const flag of ['-m', '-f', '-l', '-vm', '-of']) if (!args.includes(flag)) { console.error('missing ' + flag); process.exit(2); }
      if (!args.includes('--vad') || !args.includes('-ojf')) process.exit(3);
      fs.writeFileSync(at('-of') + '.json', JSON.stringify({ result: { language: at('-l') }, transcription: [{ text: ' (tone)' }] }));
    `);
    const model = path.join(tmp, 'model.bin');
    fs.writeFileSync(model, 'fake');
    const result = await asrSmoke({ whisper, ffmpeg, model, vad: model, speechMode: 'none' });
    assert.deepEqual(result, { spoken: false, text: '(tone)', segments: 1 });
    await assert.rejects(asrSmoke({ whisper: path.join(tmp, 'nope'), ffmpeg, model, vad: model, speechMode: 'none' }), /--whisper: no such file/);
    const broken = script('whisper-broken', 'process.exit(1);');
    await assert.rejects(asrSmoke({ whisper: broken, ffmpeg, model, vad: model, speechMode: 'none' }), /exited with 1/);
    // --expect-backend vulkan: whisper-cli's own line, from a run that gets this process's environment (CI:
    // GGML_VK_VISIBLE_DEVICES=0 puts it on Mesa's software device).
    const gpu = script('whisper-gpu', `
      if (process.env.GGML_VK_VISIBLE_DEVICES === '0') console.error('whisper_backend_init_gpu: using Vulkan0 backend');
      ${fs.readFileSync(whisper, 'utf8').split('\n').slice(1).join('\n')}
    `);
    assert.equal(BACKEND_LINES.vulkan, 'using Vulkan0 backend');
    await assert.rejects(asrSmoke({ whisper: gpu, ffmpeg, model, vad: model, speechMode: 'none', expectBackend: 'vulkan' }), /did not run on vulkan: no "using Vulkan0 backend"/);
    process.env.GGML_VK_VISIBLE_DEVICES = '0';
    try {
      assert.deepEqual(await asrSmoke({ whisper: gpu, ffmpeg, model, vad: model, speechMode: 'none', expectBackend: 'vulkan' }), { spoken: false, text: '(tone)', segments: 1 });
    } finally {
      delete process.env.GGML_VK_VISIBLE_DEVICES;
    }
    await assert.rejects(asrSmoke({ whisper: gpu, ffmpeg, model, vad: model, speechMode: 'none', expectBackend: 'cuda' }), /--expect-backend: one of vulkan/);
    await assert.rejects(asrSmoke({ whisper: gpu, ffmpeg, model, vad: model, speechMode: 'none', expectBackend: '' }), /--expect-backend/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CI builds the recording tools for every target, ships them and checks them in the app', () => {
  const wf = workflow();
  // ffmpeg: its own job per target (Windows cross-built with mingw-w64 on Linux), cached, handed over as an artifact.
  const ff = /\n {2}ffmpeg:\n([\s\S]*?)\n {2}build:/.exec(wf)?.[1];
  assert.ok(ff, 'job ffmpeg');
  for (const triple of Object.keys(TARGETS).filter((t) => t !== 'aarch64-pc-windows-msvc')) assert.ok(ff.includes(`target: ${triple}`), triple);
  assert.match(ff, /actions\/cache@[0-9a-f]{40} # v[5-9]\./);
  assert.match(ff, /hashFiles\('desktop\/scripts\/build-ffmpeg\.sh', 'desktop\/scripts\/ffmpeg-min\.flags', 'desktop\/scripts\/ffmpeg\.mjs'/);
  assert.match(ff, /node desktop\/scripts\/ffmpeg\.mjs --target \$\{\{ matrix\.target \}\}/);
  assert.match(ff, /name: ffmpeg-\$\{\{ matrix\.target \}\}/);
  // upload-artifact leaves out hidden files and folders unless told (.cache is one).
  assert.match(ff, /path: \.cache\/ffmpeg\/\$\{\{ matrix\.target \}\}\n\s+include-hidden-files: true/);
  // LGPL: FFmpeg's source goes into the release; the release takes only easy-study-* artifacts (not ffmpeg-<target>).
  assert.match(ff, /ffmpeg\.mjs --source-bundle/);
  assert.match(ff, /name: easy-study-ffmpeg-source/);
  assert.match(wf, /release:[\s\S]*download-artifact@[0-9a-f]{40} # v[4-9][.\d]*\n\s+with:\n\s+pattern: easy-study-\*/);
  const build = /\n {2}build:\n([\s\S]*?)\n {2}arch:/.exec(wf)?.[1];
  assert.ok(build, 'job build');
  assert.match(build, /needs: \[ffmpeg\]/);
  assert.match(build, /name: ffmpeg-\$\{\{ matrix\.target \}\}\n\s+path: \.cache\/ffmpeg\/\$\{\{ matrix\.target \}\}/);
  // targets.mjs too: the stamp follows its `vulkan` (a changed target must not hit the old cache and skip the SDK).
  assert.match(build, /hashFiles\('desktop\/scripts\/whisper\.mjs', 'desktop\/scripts\/binaries\.mjs', 'desktop\/scripts\/targets\.mjs'\)/);
  // The Vulkan part is required there (no CPU-only build for lack of the SDK).
  assert.match(build, /run: node desktop\/scripts\/whisper\.mjs --target \$\{\{ matrix\.target \}\} --require-vulkan\n/);
  // A release never goes out without them.
  assert.match(build, /node desktop\/scripts\/prepare\.mjs --target \$\{\{ matrix\.target \}\} --require-tools/);
  // macOS: the microphone key and entitlement in the built app; the tools signed with the app's identity.
  assert.match(build, /codesign -d --entitlements - "\$app" > "\$RUNNER_TEMP\/entitlements\.txt"\n\s+grep com\.apple\.security\.device\.audio-input/);
  assert.match(build, /plutil -extract NSMicrophoneUsageDescription raw "\$app\/Contents\/Info\.plist"/);
  assert.match(build, /desktop\/resources\/whisper\/whisper-cli desktop\/resources\/ffmpeg\/ffmpeg/);
  // The bundled tools really transcribe (a small model, speech from the runner's text-to-speech).
  for (const where of ['$res/whisper/whisper-cli', '/usr/bin/es-whisper', 'squashfs-root/usr/bin/es-whisper', '$release\\whisper\\whisper-cli.exe']) {
    assert.ok(build.includes(where), where);
  }
  assert.match(build, /espeak-ng/);
  // 4 CPU runs, the Linux x64 Vulkan build on lavapipe and Windows with the Vulkan backend requested.
  assert.equal((build.match(/desktop\/scripts\/asr-smoke\.mjs"? --whisper/g) ?? []).length, 6);
  // Arch: the package carries them too (from the .deb) and removes them again.
  const arch = /\n {2}arch:\n([\s\S]*?)\n {2}release:/.exec(wf)?.[1];
  assert.match(arch, /node desktop\/scripts\/asr-smoke\.mjs --whisper \/usr\/bin\/es-whisper --ffmpeg \/usr\/bin\/es-ffmpeg/);
  // The loader (the AppImage's check runs before the package is installed; namcap then requires the dependency) and
  // lavapipe. es-whisper-vulkan has Vulkan built in: --version lists devices only with GGML_BACKEND_PATH set.
  assert.match(arch, /pacman -Syu [^\n]*\\\n[^\n]*\bvulkan-icd-loader vulkan-swrast\b/);
  assert.match(arch, /GGML_VK_VISIBLE_DEVICES=0 GGML_BACKEND_PATH=\/dev\/null \/usr\/bin\/es-whisper-vulkan --version 2> \/tmp\/vulkan\.txt\n\s+cat \/tmp\/vulkan\.txt\n\s+grep -q '\^ggml_vulkan: 0 = ' \/tmp\/vulkan\.txt\n/);
  assert.match(arch, /GGML_VK_VISIBLE_DEVICES=0 GGML_BACKEND_PATH=\/dev\/null squashfs-root\/usr\/bin\/es-whisper-vulkan --version/);
  // Every such check in the workflow (build job, AppImage and package here) sets it.
  assert.equal((wf.match(/es-whisper-vulkan"? --version/g) ?? []).length, 3);
  assert.equal((wf.match(/GGML_BACKEND_PATH=\/dev\/null/g) ?? []).length, 3);
  assert.match(arch, /test ! -e \/usr\/bin\/es-whisper && test ! -e \/usr\/bin\/es-whisper-vulkan && test ! -e \/usr\/bin\/es-ffmpeg/);
});

test('CI builds whisper-cli with Vulkan on Windows x64 and Linux x64 and runs it', () => {
  const wf = workflow();
  const build = /\n {2}build:\n([\s\S]*?)\n {2}arch:/.exec(wf)?.[1];
  const vulkanTargets = Object.keys(TARGETS).filter((t) => TARGETS[t].vulkan);
  // The SDK only when whisper-cli is built (its cache missed), for exactly the Vulkan targets, before the build.
  const sdkStep = /- name: Vulkan SDK \(whisper-cli's GPU build\)\n\s+if: ([^\n]+)\n\s+run: ([^\n]+)\n/.exec(build);
  assert.ok(sdkStep, 'step "Vulkan SDK"');
  assert.match(sdkStep[1], /^steps\.whisper-cache\.outputs\.cache-hit != 'true' && \(/);
  assert.deepEqual([...sdkStep[1].matchAll(/matrix\.target == '([^']+)'/g)].map((m) => m[1]).sort(), vulkanTargets.sort());
  assert.equal(sdkStep[2], 'node desktop/scripts/whisper.mjs --install-vulkan-sdk');
  assert.match(build, /actions\/cache@[0-9a-f]{40} # v[\d.]+\n\s+id: whisper-cache\n\s+with:\n\s+path: \|\n\s+\.cache\/whisper\//);
  assert.ok(build.indexOf('id: whisper-cache') < build.indexOf("Vulkan SDK (whisper-cli's GPU build)"));
  assert.ok(build.indexOf("Vulkan SDK (whisper-cli's GPU build)") < build.indexOf('- name: whisper.cpp (whisper-cli)'));
  // Linux x64: the loader (the AppImage bundler resolves es-whisper-vulkan's libraries) and lavapipe.
  assert.match(build, /if: matrix\.target == 'x86_64-unknown-linux-gnu'\n\s+run: sudo apt-get install -y libvulkan1 mesa-vulkan-drivers\n/);
  // The Vulkan code path on lavapipe (forced: ggml skips CPU-type devices), the AppImage's copy on the system's loader.
  const lavapipe = /- name: Smoke test \(Linux x64, Vulkan on lavapipe\)\n\s+if: ([^\n]+)\n\s+run: \|\n([\s\S]*?)\n\n/.exec(build);
  assert.ok(lavapipe, 'step "Smoke test (Linux x64, Vulkan on lavapipe)"');
  assert.equal(lavapipe[1], "matrix.smoke && matrix.target == 'x86_64-unknown-linux-gnu'");
  assert.match(lavapipe[2], /GGML_VK_VISIBLE_DEVICES=0 node desktop\/scripts\/asr-smoke\.mjs --whisper \/usr\/bin\/es-whisper-vulkan \\\n\s+--ffmpeg \/usr\/bin\/es-ffmpeg --expect-backend vulkan/);
  assert.match(lavapipe[2], /GGML_VK_VISIBLE_DEVICES=0 GGML_BACKEND_PATH=\/dev\/null \\\n\s+"\$RUNNER_TEMP\/\.mount_easy-study\/squashfs-root\/usr\/bin\/es-whisper-vulkan" --version/);
  assert.match(lavapipe[2], /grep -q '\^ggml_vulkan: 0 = '/);
  // The server's own probe (server/recordings/asr.ts) as it runs on Linux: an empty model, no GGML_BACKEND_PATH;
  // exit 3 after the device list, at the model's "bad magic".
  assert.match(lavapipe[2], /empty=\$\(mktemp\)\n/);
  assert.match(
    lavapipe[2],
    /\n\s+GGML_VK_VISIBLE_DEVICES=0 timeout \d+ \/usr\/bin\/es-whisper-vulkan -m "\$empty" -f "\$empty" > "\$RUNNER_TEMP\/probe\.txt" 2>&1 \|\| code=\$\?\n/,
  );
  assert.match(lavapipe[2], /if \[ "\$code" != 3 \]; then [^\n]*exit 1; fi\n\s+grep -q '\^ggml_vulkan: 0 = ' "\$RUNNER_TEMP\/probe\.txt"\n\s+grep -q 'bad magic' "\$RUNNER_TEMP\/probe\.txt"/);
  assert.ok(build.indexOf('Smoke test (Linux, AppImage from a dot folder)') < build.indexOf('Smoke test (Linux x64, Vulkan on lavapipe)'));
  // Windows: the same transcription with the Vulkan backend requested (no GPU on the runner: the CPU goes on), and
  // never a ggml-vulkan.dll that would load on every run.
  const win = /- name: Smoke test \(Windows\)\n[\s\S]*?\n\n/.exec(build)?.[0] ?? '';
  assert.match(win, /Test-Path "\$release\\whisper\\ggml-vulkan\.dll"\) \{ throw/);
  assert.match(win, /\$env:GGML_BACKEND_PATH = \(Resolve-Path "\$release\\whisper\\es-ggml-vulkan\.dll"\)\.Path\n\s+node desktop\/scripts\/asr-smoke\.mjs --whisper "\$release\\whisper\\whisper-cli\.exe"/);
  assert.equal((win.match(/asr-smoke\.mjs --whisper/g) ?? []).length, 2);
  assert.equal((win.match(/if \(\$LASTEXITCODE -ne 0\)/g) ?? []).length, 2);
  // The server's probe with GGML_BACKEND_PATH still set: no GPU on the runner, so it only has to end (0 or 3) in time.
  const probe = win.slice(win.indexOf('$env:GGML_BACKEND_PATH ='));
  assert.match(probe, /Start-Process -FilePath "\$release\\whisper\\whisper-cli\.exe" -ArgumentList @\('-m', "`"\$empty`"", '-f', "`"\$empty`""\)/);
  assert.match(probe, /if \(-not \$probe\.WaitForExit\(\d+\)\) \{ \$probe\.Kill\(\); throw/);
  assert.match(probe, /if \(\$probe\.ExitCode -notin 0, 3\) \{ throw/);
});

test('build stamps hash script text with LF line endings (a CRLF Windows checkout reuses a Linux-built artifact)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-stamp-'));
  try {
    const lf = path.join(dir, 'lf.sh');
    const crlf = path.join(dir, 'crlf.sh');
    fs.writeFileSync(lf, '#!/bin/sh\necho one\necho two\n');
    fs.writeFileSync(crlf, '#!/bin/sh\r\necho one\r\necho two\r\n');
    assert.equal(textSha256(crlf), textSha256(lf));
    fs.writeFileSync(crlf, '#!/bin/sh\r\necho one\r\necho three\r\n');
    assert.notEqual(textSha256(crlf), textSha256(lf));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('libopus is built and installed as Release (multi-config generators such as Visual Studio default to Debug)', () => {
  const script = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'build-ffmpeg.sh'), 'utf8');
  assert.match(script, /cmake --build "\$WORK\/opus" --config Release/);
  assert.match(script, /cmake --install "\$WORK\/opus" --config Release/);
});

test('.gitattributes checks text files out with LF on every OS', () => {
  const attrs = fs.readFileSync(path.join(REPO_DIR, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\* text=auto eol=lf$/m);
});

// ---------------------------------------------------------------------------------------------------------------
// In-app updates and public releases (DESIGN §24): updater config, CI's updater archive, the publish script
// ---------------------------------------------------------------------------------------------------------------

test('updater: tauri.conf.json compiles in the release key, the public endpoint and requireSignedVersion, nothing dangerous', () => {
  const updater = readJson('tauri.conf.json').plugins?.updater;
  assert.ok(updater, 'plugins.updater');
  assert.deepEqual(Object.keys(updater).sort(), ['endpoints', 'pubkey', 'requireSignedVersion', 'windows']);
  // ~/.tauri/easy-study-updater.key.pub (the private key is never in the repo or CI; its loss ends in-app updates).
  assert.equal(parsePublicKey(updater.pubkey).keyId, UPDATER_KEY_ID);
  assert.deepEqual(updater.endpoints, [UPDATER_ENDPOINT]);
  assert.equal(UPDATER_ENDPOINT, 'https://github.com/Wooangha/easy-study-releases/releases/latest/download/latest.json');
  assert.equal(updater.requireSignedVersion, true);
  assert.deepEqual(updater.windows, { installMode: 'passive' });
  // No insecure transport, no downgrades; no updater artifacts built by CI (they would need the private key there).
  for (const file of ['tauri.conf.json', 'tauri.macos.conf.json', 'tauri.windows.conf.json', 'tauri.linux.conf.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(tauriDir, file), 'utf8'), /dangerous|allowDowngrades|createUpdaterArtifacts/, file);
  }
  // The plugin's JS commands stay denied: the only capability grants nothing (see the first test).
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tauriDir, 'capabilities', 'chooser.json'), 'utf8')).permissions, []);
});

test('links: the opener plugin injects no click script (it would swallow every target=_blank click into denied IPC)', () => {
  // tauri-plugin-opener's default init script catches clicks on <a target="_blank"> to http(s)/mailto/tel, cancels
  // them and calls plugin:opener|open_url over IPC, which no page may use: the banner's release page, notes.md and
  // links in answers did nothing. The shell handles the clicks itself (allow_main_navigation / new_window).
  assert.match(mainRs, /tauri_plugin_opener::Builder::new\(\)\s*\.open_js_links_on_click\(false\)\s*\.build\(\)/);
  assert.doesNotMatch(mainRs, /tauri_plugin_opener::init\(\)/);
});

test('updater: the page marker is main-frame only, static, and gives pages no IPC', () => {
  const src = fs.readdirSync(path.join(tauriDir, 'src')).filter((f) => f.endsWith('.rs')).map((f) => fs.readFileSync(path.join(tauriDir, 'src', f), 'utf8')).join('\n');
  const script = /pub const INIT_SCRIPT: &str =\s*"((?:[^"\\]|\\.)*)";/.exec(src)?.[1];
  assert.ok(script, 'pub const INIT_SCRIPT');
  assert.match(script, /^window\.__EASY_STUDY_DESKTOP__ = Object\.freeze\(\{ v: 1, /);
  assert.doesNotMatch(script, /__TAURI|invoke|ipc/i);
  // The version comes from the app at run time (package_info), never a literal.
  assert.doesNotMatch(script, /\d+\.\d+\.\d+/);
  assert.match(src, /package_info\(\)\s*\.version/);
  assert.match(src, /\.initialization_script\(/);
  assert.doesNotMatch(src, /initialization_script_for_all_frames/);
  assert.equal(readJson('tauri.conf.json').app.withGlobalTauri, false);
});

test('CI: macOS updater archive with one top folder, no signing key, no config overlay, no negated checks', () => {
  const wf = workflow();
  const build = /\n {2}build:\n([\s\S]*?)\n {2}arch:/.exec(wf)?.[1];
  const step = /- name: Updater archive \(macOS\)\n\s+if: runner\.os == 'macOS'\n\s+run: \|\n([\s\S]*?)\n\n/.exec(build)?.[1];
  assert.ok(step, 'step "Updater archive (macOS)"');
  assert.ok(build.indexOf('Microphone description and entitlement (macOS)') < build.indexOf('Updater archive (macOS)'));
  assert.ok(build.indexOf('Updater archive (macOS)') < build.indexOf('upload-artifact'));
  // The names release-assets.mjs expects (easy-study_<v>_aarch64|x64.app.tar.gz), the version the app carries.
  assert.match(step, /v=\$\(node -p "require\('\.\/package\.json'\)\.version"\)/);
  assert.match(step, /aarch64-\*\) a=aarch64 ;; \*\) a=x64 ;;/);
  assert.match(step, /out="\$BUNDLE\/macos\/easy-study_\$\{v\}_\$\{a\}\.app\.tar\.gz"/);
  assert.match(step, /test "\$\(plutil -extract CFBundleShortVersionString raw "\$app\/Contents\/Info\.plist"\)" = "\$v"/);
  // The same tar as update-e2e.mjs pack; the folder itself, never "-C dir ." (a "./" breaks the updater's skip(1)).
  assert.ok(step.includes(`COPYFILE_DISABLE=1 tar ${APP_TAR_ARGS.join(' ')} "$out" -C "$BUNDLE/macos" easy-study.app`));
  assert.match(step, /find "\$app" -type f -links \+1/);
  assert.match(step, /tar -tzf "\$out" > "\$RUNNER_TEMP\/applist\.txt"/);
  assert.match(step, /grep -qv '\^easy-study\\\.app\/' "\$RUNNER_TEMP\/applist\.txt"/);
  assert.match(step, /grep -q -e '\/\\\._' -e '\^\\\._'/);
  // bash -e never stops on `! cmd` (only the step's last command would count): no such line anywhere.
  assert.doesNotMatch(wf, /^\s*!\s/m);
  assert.match(build, /path: \|\n(\s+\$\{\{ env\.BUNDLE \}\}\/[^\n]+\n)*\s+\$\{\{ env\.BUNDLE \}\}\/macos\/\*\.app\.tar\.gz\n/);
  // The key never reaches CI: nothing is signed for the updater there, and the e2e overlay is local only.
  for (const re of [/TAURI_SIGNING/, /createUpdaterArtifacts/, /--tauri-config/, /--config\b/, /--no-sign/, /signer/]) assert.doesNotMatch(wf, re);
  const buildMjs = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'build.mjs'), 'utf8');
  assert.match(buildMjs, /if \(typeof arg\('tauri-config'\) === 'string'\) tauriArgs\.push\('--config', path\.resolve\(arg\('tauri-config'\)\)\);/);
});

test('PKGBUILD: the sources come from the public releases repo', () => {
  const pkgbuild = fs.readFileSync(path.join(REPO_DIR, 'packaging', 'arch', 'PKGBUILD'), 'utf8');
  assert.match(pkgbuild, /^url='https:\/\/github\.com\/Wooangha\/easy-study-releases'$/m);
  assert.match(pkgbuild, /^source_x86_64=\("[^"]*::\$url\/releases\/download\/v\$pkgver\/\$\{_pkgname\}_\$\{pkgver\}_amd64\.deb"\)$/m);
  const srcinfo = fs.readFileSync(path.join(REPO_DIR, 'packaging', 'arch', '.SRCINFO'), 'utf8');
  assert.match(srcinfo, /^\turl = https:\/\/github\.com\/Wooangha\/easy-study-releases$/m);
  assert.doesNotMatch(srcinfo, /github\.com\/Wooangha\/easy-study\//);
  // The publish script's check of a release's PKGBUILD (url, pkgver, the draft's .deb checksums).
  const version = /^pkgver=(.*)$/m.exec(pkgbuild)[1];
  const sum = (arch) => new RegExp(`^sha256sums_${arch}=\\('([0-9a-f]{64})'\\)$`, 'm').exec(pkgbuild)[1];
  const debs = { amd64: sum('x86_64'), arm64: sum('aarch64') };
  assert.deepEqual(pkgbuildProblems(pkgbuild, { version, debs }), []);
  assert.match(pkgbuildProblems(pkgbuild, { version: '9.9.9', debs }).join(), /pkgver/);
  assert.match(pkgbuildProblems(pkgbuild, { version, debs: { ...debs, arm64: 'f'.repeat(64) } }).join(), /sha256sums_aarch64/);
  const private_ = pkgbuild.replace(/^url=.*$/m, "url='https://github.com/Wooangha/easy-study'");
  assert.match(pkgbuildProblems(private_, { version, debs }).join(), /must come from https:\/\/github\.com\/Wooangha\/easy-study-releases/);
});

// The asset names of CI's v0.4.2 draft plus the Linux server tarballs (from 0.6.6 on) and the macOS updater archives
// of later drafts.
const draftNames = (v, { server = compareVersions(v, '0.6.6') >= 0 } = {}) => [
  `easy-study-${v}-1.aarch64.rpm`,
  `easy-study-${v}-1.x86_64.rpm`,
  `easy-study-bin-${v}-1-x86_64.pkg.tar.zst`,
  'easy-study-ffmpeg-8.1-source.tar',
  `easy-study_${v}_aarch64.AppImage`,
  `easy-study_${v}_aarch64.dmg`,
  `easy-study_${v}_amd64.AppImage`,
  `easy-study_${v}_amd64.deb`,
  `easy-study_${v}_arm64.deb`,
  `easy-study_${v}_x64-setup.exe`,
  `easy-study_${v}_x64.dmg`,
  'PKGBUILD',
  ...(server ? [`easy-study-server-${v}-linux-x64.tar.gz`, `easy-study-server-${v}-linux-arm64.tar.gz`] : []),
  `easy-study_${v}_aarch64.app.tar.gz`,
  `easy-study_${v}_x64.app.tar.gz`,
];

test('release assets: an allowlist (nothing unexpected goes public), updater keys, no bare linux key', () => {
  const names = draftNames('0.5.0');
  const keys = Object.fromEntries(names.map((n) => [n, classifyAsset(n, '0.5.0').keys]));
  assert.deepEqual(keys['easy-study_0.5.0_aarch64.app.tar.gz'], ['darwin-aarch64']);
  assert.deepEqual(keys['easy-study_0.5.0_x64.app.tar.gz'], ['darwin-x86_64']);
  assert.deepEqual(keys['easy-study_0.5.0_x64-setup.exe'], ['windows-x86_64-nsis', 'windows-x86_64']);
  assert.deepEqual(keys['easy-study_0.5.0_amd64.AppImage'], ['linux-x86_64-appimage']);
  assert.deepEqual(keys['easy-study_0.5.0_aarch64.AppImage'], ['linux-aarch64-appimage']);
  // The Linux server tarballs (from 0.6.6 on): keys only `easy-study update` reads (the app asks for
  // linux-<arch>-appimage).
  assert.deepEqual(classifyAsset('easy-study-server-0.6.6-linux-x64.tar.gz', '0.6.6').keys, ['linux-x86_64-server']);
  assert.deepEqual(classifyAsset('easy-study-server-0.6.6-linux-arm64.tar.gz', '0.6.6').keys, ['linux-aarch64-server']);
  for (const n of ['easy-study_0.5.0_amd64.deb', 'easy-study-0.5.0-1.x86_64.rpm', 'easy-study_0.5.0_x64.dmg', 'PKGBUILD']) assert.deepEqual(keys[n], [], n);
  assert.deepEqual(UPDATER_KEYS, [
    'darwin-aarch64',
    'darwin-x86_64',
    'windows-x86_64-nsis',
    'windows-x86_64',
    'linux-x86_64-appimage',
    'linux-aarch64-appimage',
    'linux-x86_64-server',
    'linux-aarch64-server',
  ]);
  assert.ok(!UPDATER_KEYS.includes('linux-x86_64') && !UPDATER_KEYS.includes('linux-aarch64'), 'deb/rpm would fall back to a bare linux key');
  // The app's names are unchanged; each artifact is its own required allowlist entry.
  assert.deepEqual(UPDATER_ARTIFACTS.map((a) => a.name('0.5.0')), [
    'easy-study_0.5.0_aarch64.app.tar.gz',
    'easy-study_0.5.0_x64.app.tar.gz',
    'easy-study_0.5.0_x64-setup.exe',
    'easy-study_0.5.0_amd64.AppImage',
    'easy-study_0.5.0_aarch64.AppImage',
    'easy-study-server-0.5.0-linux-x64.tar.gz',
    'easy-study-server-0.5.0-linux-arm64.tar.gz',
  ]);
  assert.equal(serverTarballName('0.7.0', 'x64'), 'easy-study-server-0.7.0-linux-x64.tar.gz');
  assert.equal(serverTarballName('0.7.0', 'arm64'), 'easy-study-server-0.7.0-linux-arm64.tar.gz');
  assert.throws(() => serverTarballName('0.7.0', 'aarch64'), /x64 or arm64/);
  assert.equal(SERVER_TOP_DIR, 'easy-study-server');
  assert.deepEqual(missingAssets(draftNames('0.6.6').filter((n) => !n.includes('-linux-arm64')), '0.6.6'), ['updater linux-aarch64-server']);
  for (const bad of ['easy-study-server-0.6.6-linux-x86_64.tar.gz', 'easy-study-server-0.6.7-linux-x64.tar.gz', 'easy-study-server-0.6.6-linux-x64.tgz', 'easy-study-server-0.6.6-linux-x64.tar.gz.sig']) {
    assert.throws(() => classifyAsset(bad, '0.6.6'), /unexpected asset/, bad);
  }
  assert.deepEqual(missingAssets(names, '0.5.0'), []);
  // v0.4.2's draft (before the updater) lacks the macOS archives.
  assert.deepEqual(missingAssets(draftNames('0.4.2').slice(0, -2), '0.4.2'), ['updater darwin-aarch64', 'updater darwin-x86_64']);
  assert.deepEqual(missingAssets(names.filter((n) => !n.includes('ffmpeg')), '0.5.0'), ['FFmpeg source (LGPL)']);
  // Unknown or generated names, other versions, signatures: refused.
  for (const bad of ['latest.json', 'SHA256SUMS.txt', 'easy-study_0.5.0_aarch64.app.tar.gz.sig', 'easy-study_0.4.2_amd64.deb', 'notes.md', 'easy-study_0.5.0_amd64.AppImage.zsync', 'easy-study_0.5.0.1_x64.dmg']) {
    assert.throws(() => classifyAsset(bad, '0.5.0'), /unexpected asset/, bad);
  }
  classifyAsset('easy-study-libvips-8.17.2-source.tar.gz', '0.5.0');
  classifyAsset('easy-study_0.5.0-e2e.2_aarch64.app.tar.gz', '0.5.0-e2e.2');
  const order = publicAssetList(names);
  assert.deepEqual(order.slice(-2), ['SHA256SUMS.txt', 'latest.json']);
  assert.equal(order.length, names.length + 2);
  assert.equal(sha256sums([{ name: 'b', sha256: '2'.repeat(64) }, { name: 'a', sha256: '1'.repeat(64) }]), `${'1'.repeat(64)}  a\n${'2'.repeat(64)}  b\n`);
});

test('release assets: latest.json for tauri-plugin-updater, and its checks before publishing', () => {
  const version = '0.6.6';
  const baseUrl = releaseDownloadUrl('v0.6.6');
  assert.equal(baseUrl, `https://github.com/${PUBLIC_REPO}/releases/download/v0.6.6`);
  const updater = draftNames(version).filter((n) => classifyAsset(n, version).keys.length > 0);
  const artifacts = updater.map((name) => ({ name, signature: `${Buffer.from(`sig of ${name}`).toString('base64')}\n` }));
  const latest = latestJson({ version, notes: '노트', pubDate: '2026-10-05T09:00:00Z', baseUrl, artifacts });
  assert.deepEqual(Object.keys(latest), ['version', 'notes', 'pub_date', 'platforms']);
  assert.deepEqual(Object.keys(latest.platforms), UPDATER_KEYS);
  assert.deepEqual(latest.platforms['darwin-aarch64'], {
    url: `${baseUrl}/easy-study_0.6.6_aarch64.app.tar.gz`,
    signature: Buffer.from('sig of easy-study_0.6.6_aarch64.app.tar.gz').toString('base64'),
  });
  assert.deepEqual(latest.platforms['windows-x86_64'], latest.platforms['windows-x86_64-nsis']);
  assert.equal(latest.platforms['linux-x86_64-server'].url, `${baseUrl}/easy-study-server-0.6.6-linux-x64.tar.gz`);
  assert.equal(latest.platforms['linux-aarch64-server'].url, `${baseUrl}/easy-study-server-0.6.6-linux-arm64.tar.gz`);
  assert.equal(latest.platforms['linux-x86_64-server'].url, `https://github.com/Wooangha/easy-study-releases/releases/download/v0.6.6/${serverTarballName('0.6.6', 'x64')}`);
  assert.equal(latest.platforms['linux-aarch64-server'].signature, Buffer.from('sig of easy-study-server-0.6.6-linux-arm64.tar.gz').toString('base64'));
  assert.deepEqual(latestJsonProblems(latest, { version, baseUrl, uploaded: draftNames(version) }), []);
  // What would make it unsafe or broken.
  const broken = (edit) => {
    const copy = structuredClone(latest);
    edit(copy);
    return latestJsonProblems(copy, { version, baseUrl, uploaded: draftNames(version) }).join('; ');
  };
  assert.match(broken((j) => (j.version = '0.5.1')), /version "0\.5\.1"/);
  assert.match(broken((j) => (j.platforms['linux-x86_64'] = j.platforms['linux-x86_64-appimage'])), /unexpected platform keys linux-x86_64/);
  assert.match(broken((j) => delete j.platforms['darwin-x86_64']), /missing platform keys darwin-x86_64/);
  assert.match(broken((j) => (j.platforms['darwin-aarch64'].url = j.platforms['darwin-x86_64'].url)), /darwin-aarch64: url/);
  assert.match(broken((j) => (j.platforms['linux-aarch64-appimage'].url = j.platforms['linux-aarch64-appimage'].url.replace('https:', 'http:'))), /not https/);
  assert.match(broken((j) => (j.platforms['linux-x86_64-server'].url = j.platforms['linux-aarch64-server'].url)), /linux-x86_64-server: url/);
  assert.match(broken((j) => delete j.platforms['linux-aarch64-server']), /missing platform keys linux-aarch64-server/);
  assert.match(latestJsonProblems(latest, { version, baseUrl, uploaded: [] }).join(), /not among the release's assets/);
  assert.throws(() => latestJson({ version: 'v0.6.6', notes: '', pubDate: '2026-10-05T09:00:00Z', baseUrl, artifacts }), /without "v"/);
  assert.throws(() => latestJson({ version, notes: '', pubDate: '2026-10-05 09:00', baseUrl, artifacts }), /RFC 3339/);
  assert.throws(() => latestJson({ version, notes: '', pubDate: '2026-10-05T09:00:00Z', baseUrl, artifacts: [{ name: 'easy-study_0.6.6_x64.dmg', signature: 'x' }] }), /not an updater artifact/);
  assert.throws(() => latestJson({ version, notes: '', pubDate: '2026-10-05T09:00:00Z', baseUrl, artifacts: [{ ...artifacts[0], signature: 'a b' }] }), /one-line/);
  // Notes: the first paragraph that is not a heading, as plain text.
  assert.equal(notesSummary('# easy-study 0.5.0\n\n<!-- draft -->\n앱 안에서 **업데이트**할 수 있어요.\n[설정](https://x) 화면도 생겼어요.\n\n- 둘째 문단'), '앱 안에서 업데이트할 수 있어요.\n설정 화면도 생겼어요.');
  assert.equal([...notesSummary('가'.repeat(1200))].length, 1000);
  assert.ok(notesSummary('가'.repeat(1200)).endsWith('…'));
  // Versions: the script refuses one older than the public latest.
  assert.ok(compareVersions('0.5.0', '0.4.2') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v0.5.1', '0.5.1') === 0);
  assert.ok(compareVersions('0.5.0-e2e.1', '0.5.0-e2e.2') < 0);
  assert.ok(compareVersions('0.5.0-e2e.2', '0.5.0') < 0);
  assert.ok(compareVersions('0.5.0-e2e.10', '0.5.0-e2e.9') > 0);
});

test('release assets: the server tarballs from 0.6.6 on (0.6.5 was published without them)', () => {
  assert.equal(SERVER_SINCE, '0.6.6');
  const appKeys = UPDATER_KEYS.filter((k) => !k.endsWith('-server'));
  const pubDate = '2026-10-05T09:00:00Z';
  const latestOf = (version, names) => {
    const artifacts = names.filter((n) => classifyAsset(n, version).keys.length > 0).map((name) => ({ name, signature: 'c2ln' }));
    return latestJson({ version, notes: '', pubDate, baseUrl: releaseDownloadUrl(`v${version}`), artifacts });
  };
  // 0.6.5 (published): its draft and latest.json pass again (a retry of the publish script), a server tarball is not
  // one of its assets.
  const old = draftNames('0.6.5');
  assert.ok(!old.some((n) => n.startsWith(`${SERVER_TOP_DIR}-`)));
  assert.deepEqual(missingAssets(old, '0.6.5'), []);
  for (const n of [serverTarballName('0.6.5', 'x64'), serverTarballName('0.6.5', 'arm64')]) assert.throws(() => classifyAsset(n, '0.6.5'), /unexpected asset/, n);
  assert.deepEqual(updaterKeys('0.6.5'), appKeys);
  const latest65 = latestOf('0.6.5', old);
  assert.deepEqual(Object.keys(latest65.platforms), appKeys);
  assert.deepEqual(latestJsonProblems(latest65, { version: '0.6.5', baseUrl: releaseDownloadUrl('v0.6.5'), uploaded: old }), []);
  assert.throws(
    () => latestJson({ version: '0.6.5', notes: '', pubDate, baseUrl: releaseDownloadUrl('v0.6.5'), artifacts: [{ name: serverTarballName('0.6.5', 'x64'), signature: 'c2ln' }] }),
    /not an updater artifact of 0\.6\.5/,
  );
  // 0.6.6: both are required, in the draft and in latest.json.
  const withoutServer = draftNames('0.6.6', { server: false });
  assert.deepEqual(missingAssets(withoutServer, '0.6.6'), ['updater linux-x86_64-server', 'updater linux-aarch64-server']);
  assert.deepEqual(missingAssets(draftNames('0.6.6'), '0.6.6'), []);
  assert.deepEqual(updaterKeys('0.6.6'), UPDATER_KEYS);
  const baseUrl = releaseDownloadUrl('v0.6.6');
  assert.deepEqual(latestJsonProblems(latestOf('0.6.6', draftNames('0.6.6')), { version: '0.6.6', baseUrl, uploaded: draftNames('0.6.6') }), []);
  assert.deepEqual(latestJsonProblems(latestOf('0.6.6', withoutServer), { version: '0.6.6', baseUrl, uploaded: withoutServer }), [
    'missing platform keys linux-x86_64-server, linux-aarch64-server',
  ]);
  // Later versions, and prereleases of 0.6.6 (built by the same workflow), have them too.
  for (const v of ['0.6.6-e2e.1', '0.6.7', '0.7.0', '1.0.0-rc.1']) assert.deepEqual(updaterKeys(v), UPDATER_KEYS, v);
  for (const v of ['0.6.5-e2e.1', '0.6.4', '0.5.0']) assert.deepEqual(updaterKeys(v), appKeys, v);
});

test('release assets: a draft counts only when CI uploaded every file during a successful run of the tag', () => {
  const commit = 'c'.repeat(40);
  const run = { id: 1, conclusion: 'success', head_sha: commit, head_branch: 'v0.5.0', path: CI_WORKFLOW, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:30:00Z' };
  const asset = (name, over = {}) => ({ name, uploader: { login: CI_UPLOADER }, state: 'uploaded', digest: `sha256:${'a'.repeat(64)}`, created_at: '2026-10-01T10:29:00Z', ...over });
  const release = { tag_name: 'v0.5.0', author: { login: CI_UPLOADER } };
  const check = (over = {}) => provenanceProblems({ release, assets: [asset('PKGBUILD')], runs: [run], tag: 'v0.5.0', commit, ...over }).join('; ');
  assert.equal(check(), '');
  assert.match(check({ assets: [asset('PKGBUILD', { uploader: { login: 'Wooangha' } })] }), /uploaded by Wooangha, not github-actions\[bot\]/);
  assert.match(check({ assets: [asset('PKGBUILD', { state: 'starter' })] }), /state starter/);
  assert.match(check({ assets: [asset('PKGBUILD', { digest: null })] }), /no sha256 digest/);
  assert.match(check({ assets: [asset('PKGBUILD', { created_at: '2026-10-01T11:00:00Z' })] }), /outside the desktop run/);
  assert.match(check({ release: { ...release, author: { login: 'someone' } } }), /created by someone/);
  assert.match(check({ runs: [{ ...run, conclusion: 'failure' }] }), /no successful/);
  assert.match(check({ runs: [{ ...run, head_sha: 'd'.repeat(40) }] }), /no successful/);
  assert.match(check({ runs: [{ ...run, head_branch: 'main' }] }), /no successful/);
  assert.match(check({ runs: [{ ...run, path: '.github/workflows/other.yml' }] }), /no successful/);
  assert.match(check({ tag: 'v0.5.1' }), /the release is for v0\.5\.0/);
});

test('minisign: the verifier checks the key id, BLAKE2b-512 of the file and the trusted comment (node:crypto keys)', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const minisignKey = (id) => {
    const text = `untrusted comment: minisign public key: ${Buffer.from(id).reverse().toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`;
    return Buffer.from(text).toString('base64'); // Tauri's wrapping (tauri.conf.json, .key.pub)
  };
  const id = crypto.randomBytes(8);
  const pubkey = minisignKey(id);
  const signText = (data, comment, { algorithm = 'ED', keyId = id, globalComment = comment } = {}) => {
    const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
    const sig = crypto.sign(null, message, privateKey);
    const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(globalComment)]), privateKey);
    const lines = ['untrusted comment: signature from tauri secret key', Buffer.concat([Buffer.from(algorithm), keyId, sig]).toString('base64'), `trusted comment: ${comment}`, global.toString('base64')];
    return Buffer.from(`${lines.join('\n')}\n`).toString('base64');
  };
  const data = Buffer.from('an updater artifact');
  const comment = 'timestamp:1790000000\tfile:easy-study_0.5.0_aarch64.app.tar.gz\tversion:0.5.0';
  const good = signText(data, comment);
  assert.equal(parsePublicKey(pubkey).keyId, Buffer.from(id).reverse().toString('hex').toUpperCase());
  assert.deepEqual(await verify(pubkey, good, data), { timestamp: '1790000000', file: 'easy-study_0.5.0_aarch64.app.tar.gz', version: '0.5.0' });
  assert.deepEqual(verifyTrusted(pubkey, good), trustedFields(comment));
  assert.equal(parseSignature(good).keyId, parsePublicKey(pubkey).keyId);
  await assert.rejects(verify(pubkey, good, Buffer.from('an updater artifacT')), /file does not match/);
  // A version edited into the trusted comment (the global signature covers it).
  await assert.rejects(verify(pubkey, signText(data, comment.replace('0.5.0', '0.5.1'), { globalComment: comment }), data), /trusted comment does not match/);
  await assert.rejects(verify(minisignKey(crypto.randomBytes(8)), good, data), /signed with key/);
  await assert.rejects(verify(pubkey, signText(data, comment, { algorithm: 'Ed' }), data), /prehashed/);
  const other = crypto.generateKeyPairSync('ed25519');
  const otherRaw = Buffer.from(other.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const sameIdOtherKey = Buffer.from(`untrusted comment: x\n${Buffer.concat([Buffer.from('Ed'), id, otherRaw]).toString('base64')}\n`).toString('base64');
  await assert.rejects(verify(sameIdOtherKey, good, data), /does not match/);
  // From a file (streamed), as the publish script checks the 150 MB artifacts.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-minisign-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a'), data);
    assert.equal((await verify(pubkey, good, { file: path.join(tmp, 'a') })).version, '0.5.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.throws(() => parseSignature('not a signature'), /neither minisign text nor base64/);
});

const tauriCli = path.join(DESKTOP_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
test('minisign: verifies what `tauri signer sign --app-version` writes (a throwaway key in a temp folder)', { skip: !fs.existsSync(tauriCli) && 'no Tauri CLI (npm ci in desktop/)' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-signer-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TAURI_SIGNING_')));
    const key = path.join(tmp, 'throwaway.key');
    assert.equal(spawnSync(process.execPath, [tauriCli, 'signer', 'generate', '--ci', '-p', '', '-w', key], { env }).status, 0);
    const file = path.join(tmp, 'easy-study_0.5.0-e2e.2_aarch64.app.tar.gz');
    fs.writeFileSync(file, crypto.randomBytes(100_000));
    assert.equal(spawnSync(process.execPath, [tauriCli, 'signer', 'sign', '-f', key, '-p', '', '--app-version', '0.5.0-e2e.2', file], { env }).status, 0);
    const pub = fs.readFileSync(`${key}.pub`, 'utf8');
    const fields = await verify(pub, fs.readFileSync(`${file}.sig`, 'utf8'), { file });
    assert.equal(fields.file, path.basename(file));
    assert.equal(fields.version, '0.5.0-e2e.2');
    assert.match(fields.timestamp, /^\d+$/);
    fs.appendFileSync(file, 'x');
    await assert.rejects(verify(pub, fs.readFileSync(`${file}.sig`, 'utf8'), { file }), /does not match/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('macOS updater archive: packed as CI does, read back entry by entry (hard links, top folder, Info.plist)', { skip: process.platform === 'win32' && 'tar with hard links' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-apptar-'));
  try {
    const app = path.join(tmp, 'b', 'easy-study.app');
    const deep = path.join(app, 'Contents', 'Resources', 'd'.repeat(60), 'e'.repeat(60));
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(deep, { recursive: true });
    const plist = (v) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key>\n<string>${v}</string>\n</dict></plist>\n`;
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist('0.5.0'));
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'easy-study'), crypto.randomBytes(3000));
    fs.writeFileSync(path.join(deep, `${'f'.repeat(70)}.txt`), 'long path');
    const out = await packApp({ app, version: '0.5.0', outDir: path.join(tmp, 'out'), arch: 'aarch64' });
    assert.equal(path.basename(out), 'easy-study_0.5.0_aarch64.app.tar.gz');
    const archive = await readTarGz(out, ['easy-study.app/Contents/Info.plist']);
    assert.deepEqual(appArchiveProblems(archive, '0.5.0'), []);
    assert.equal(archive.files['easy-study.app/Contents/Info.plist'].toString(), plist('0.5.0'));
    assert.ok(archive.entries.some((e) => e.name.endsWith(`${'e'.repeat(60)}/${'f'.repeat(70)}.txt`) && e.type === 'file' && e.name.length > 200));
    assert.ok(archive.entries.every((e) => e.name.startsWith('easy-study.app/')));
    assert.match(appArchiveProblems(archive, '0.5.1').join(), /CFBundleShortVersionString 0\.5\.0, expected 0\.5\.1/);
    // "-C dir ." gives "./easy-study.app/…" (the updater would unpack a folder named easy-study.app inside the app).
    spawnSync('tar', ['-czf', path.join(tmp, 'dot.tar.gz'), '-C', path.join(tmp, 'b'), '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    assert.match(appArchiveProblems(await readTarGz(path.join(tmp, 'dot.tar.gz'), []), '0.5.0').join(), /not under easy-study\.app\//);
    // A hard link: every macOS install would fail (tar-rs resolves its target against the working folder).
    fs.linkSync(path.join(app, 'Contents', 'MacOS', 'easy-study'), path.join(app, 'Contents', 'MacOS', 'copy'));
    await assert.rejects(packApp({ app, version: '0.5.0', outDir: path.join(tmp, 'out'), arch: 'aarch64' }), /hard link/);
    await assert.rejects(packApp({ app: path.join(tmp, 'b'), version: '0.5.0', outDir: tmp }), /must be named easy-study\.app/);
    fs.writeFileSync(path.join(tmp, 'broken.tar.gz'), (await import('node:zlib')).gzipSync(Buffer.alloc(700, 1)));
    await assert.rejects(readTarGz(path.join(tmp, 'broken.tar.gz')), /broken tar header/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Windows installer: the version resource names the version it installs (read before signing)', () => {
  // A 32-bit PE like NSIS's installer stub: headers, a section table with .text and .rsrc, and in .rsrc a
  // VS_VERSIONINFO string table as makensis writes it (UTF-16LE key, NUL, padding, value, NUL).
  const exe = (strings) => {
    const buf = Buffer.alloc(0x1000);
    buf.write('MZ', 0, 'latin1');
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write('PE\0\0', 0x80, 'latin1');
    buf.writeUInt16LE(0x14c, 0x84); // i386
    buf.writeUInt16LE(2, 0x86); // sections
    buf.writeUInt16LE(0xe0, 0x94); // optional header size (PE32)
    const table = 0x80 + 24 + 0xe0;
    buf.write('.text', table, 'latin1');
    buf.write('.rsrc', table + 40, 'latin1');
    buf.writeUInt32LE(0x800, table + 40 + 16); // size of raw data
    buf.writeUInt32LE(0x600, table + 40 + 20); // pointer to raw data
    let at = 0x600 + 6;
    for (const [key, value] of strings) {
      at += buf.write(`${key}\0`, at, 'utf16le');
      if ((at - 0x600) % 4) at += 2; // align the value to 32 bits
      at += buf.write(`${value}\0`, at, 'utf16le') + 6;
    }
    return buf;
  };
  const read = (buf) => {
    const range = peResourceRange(buf.subarray(0, 0x400));
    return range && versionInfoString(buf.subarray(range.offset, range.offset + range.size), 'ProductVersion');
  };
  assert.deepEqual(peResourceRange(exe([])), { offset: 0x600, size: 0x800 });
  assert.equal(read(exe([['FileVersion', '0.5.0'], ['ProductVersion', '0.5.1'], ['ProductName', 'easy-study']])), '0.5.1');
  assert.equal(read(exe([['Product', '0.5.1'], ['ProductVersion', '0.5.0-e2e.2']])), '0.5.0-e2e.2');
  assert.equal(read(exe([['FileVersion', '0.5.1']])), null);
  assert.equal(peResourceRange(Buffer.from('#!/bin/sh\n'.padEnd(200, ' '))), null);
  assert.equal(peResourceRange(Buffer.from('\x7fELF'.padEnd(200, '\0'), 'latin1')), null);
});

test('tar reader: GNU long names, pax paths, hard links, checksums (as GNU tar on Linux writes them)', async () => {
  const header = (name, { type = '0', size = 0, link = '', magic = 'ustar  \0' } = {}) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write('0000644\0', 100);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    h.write(' '.repeat(8), 148);
    h.write(type, 156);
    h.write(link, 157);
    h.write(magic, 257);
    h.write(`${h.reduce((n, b) => n + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const data = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
  const pax = (key, value) => {
    let len = key.length + value.length + 3;
    while (`${len} ${key}=${value}\n`.length !== len) len = `${len} ${key}=${value}\n`.length;
    return Buffer.from(`${len} ${key}=${value}\n`);
  };
  const longName = `easy-study.app/Contents/Resources/${'x'.repeat(120)}.txt`;
  const paxName = `easy-study.app/Contents/${'p'.repeat(110)}.txt`;
  const record = pax('path', paxName);
  const tar = Buffer.concat([
    header('easy-study.app/', { type: '5' }),
    header('././@LongLink', { type: 'L', size: longName.length + 1 }),
    data(Buffer.from(`${longName}\0`)),
    header(longName.slice(0, 100), { size: 5 }),
    data(Buffer.from('hello')),
    header('pax_global_header', { type: 'g', size: 11, magic: 'ustar\x0000' }),
    data(Buffer.from('9 a=bcde\n\n')),
    header('PaxHeaders/x', { type: 'x', size: record.length, magic: 'ustar\x0000' }),
    data(record),
    header('truncated-by-pax.txt', { size: 3, magic: 'ustar\x0000' }),
    data(Buffer.from('pax')),
    header('easy-study.app/Contents/hl', { type: '1', link: 'easy-study.app/Contents/x' }),
    Buffer.alloc(1024),
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-tar-'));
  try {
    const file = path.join(tmp, 'a.tar.gz');
    fs.writeFileSync(file, (await import('node:zlib')).gzipSync(tar));
    const { entries, files } = await readTarGz(file, [longName, paxName]);
    assert.deepEqual(entries.map((e) => [e.name, e.type]), [
      ['easy-study.app/', 'dir'],
      [longName, 'file'],
      [paxName, 'file'],
      ['easy-study.app/Contents/hl', 'hardlink'],
    ]);
    assert.equal(files[longName].toString(), 'hello');
    assert.equal(files[paxName].toString(), 'pax');
    assert.equal(entries[3].link, 'easy-study.app/Contents/x');
    assert.match(appArchiveProblems({ entries, files }, '0.5.0').join('; '), /hl: hard link/);
    const bad = Buffer.from(tar);
    bad[600] ^= 1; // inside the GNU long-name header
    fs.writeFileSync(file, (await import('node:zlib')).gzipSync(bad));
    await assert.rejects(readTarGz(file), /broken tar header/);
    fs.writeFileSync(file, (await import('node:zlib')).gzipSync(tar.subarray(0, 1536 + 100)));
    await assert.rejects(readTarGz(file), /truncated tar/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('publish-release.mjs: a dry run unless --publish; a real run needs the reviewed commit and approved notes', () => {
  const dry = parseOptions(['--tag', 'v0.5.0']);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.version, '0.5.0');
  assert.equal(dry.key, path.join(os.homedir(), '.tauri', 'easy-study-updater.key'));
  assert.equal(DEFAULT_KEY, '~/.tauri/easy-study-updater.key');
  assert.equal(dry.work, path.join(REPO_DIR, '.cache', 'publish', 'v0.5.0'));
  assert.equal(parseOptions(['--tag', 'v0.5.0', '--dry-run', '--notes', 'n.md']).dryRun, true);
  assert.throws(() => parseOptions(['--tag', 'v0.5.0', '--publish']), /--commit/);
  assert.throws(() => parseOptions(['--tag', 'v0.5.0', '--publish', '--commit', 'abcdef1']), /--notes/);
  assert.throws(() => parseOptions(['--tag', 'v0.5.0', '--publish', '--dry-run', '--commit', 'abcdef1', '--notes', 'n.md']), /exclude/);
  assert.throws(() => parseOptions(['--tag', '0.5.0']), /--tag vX\.Y\.Z/);
  assert.throws(() => parseOptions(['--tag', 'v0.5.0', '--clobber']), /unknown argument/);
  assert.throws(() => parseOptions(['--tag', 'v0.5.0', '--commit', 'main']), /hex/);
  const real = parseOptions(['--tag', 'v0.5.0', '--publish', '--commit', 'abcdef1', '--notes', 'n.md', '--key', '/k', '--skip-private', '--not-latest']);
  assert.deepEqual([real.dryRun, real.key, real.skipPrivate, real.notLatest], [false, '/k', true, true]);
  // The key is only ever a path handed to the Tauri CLI; a published release is never overwritten.
  const src = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'publish-release.mjs'), 'utf8');
  assert.doesNotMatch(src, /(readFileSync|createReadStream|copyFileSync|cpSync)\([^)]*\bkey\b/);
  assert.match(src, /\[cli, 'signer', 'sign', '-f', key, '-p', '', '--app-version', version, file\], \{ env \}/);
  assert.match(src, /filter\(\(\[k\]\) => !k\.startsWith\('TAURI_SIGNING_'\)\)/);
  assert.doesNotMatch(src, /--clobber/);
  assert.match(src, /assertPublicDraft\(tag, pub\.id\);\n\s+if \(current\) api\(`repos\/\$\{PUBLIC_REPO\}\/releases\/assets\/\$\{current\.id\}`, \{ method: 'DELETE' \}\)/);
});

test('update e2e: a throwaway key only, latest.json from the same helper, one folder served on 127.0.0.1', async () => {
  const fakeKey = (id) => Buffer.from(`untrusted comment: k\n${Buffer.concat([Buffer.from('Ed'), Buffer.from(id, 'hex').reverse(), crypto.randomBytes(32)]).toString('base64')}\n`).toString('base64');
  assert.throws(() => e2eConfig({ version: '0.5.0-e2e.1', pubkey: fakeKey(UPDATER_KEY_ID), port: 8777 }), /throwaway key/);
  const config = e2eConfig({ version: '0.5.0-e2e.1', pubkey: fakeKey('0123456789ABCDEF'), port: 8777 });
  assert.equal(config.identifier, 'dev.easystudy.desktop.e2e');
  assert.deepEqual(config.plugins.updater.endpoints, ['http://127.0.0.1:8777/latest.json']);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-e2e-'));
  let server;
  try {
    const name = 'easy-study_0.5.0-e2e.2_aarch64.app.tar.gz';
    fs.writeFileSync(path.join(tmp, name), 'archive');
    fs.writeFileSync(path.join(tmp, `${name}.sig`), `${Buffer.from('sig').toString('base64')}\n`);
    fs.writeFileSync(path.join(tmp, '.hidden'), 'no');
    server = await serveDir(tmp, 0);
    const port = server.address().port;
    const latest = writeLatest({ dir: tmp, version: '0.5.0-e2e.2', port });
    assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64']);
    assert.equal(latest.platforms['darwin-aarch64'].url, `http://127.0.0.1:${port}/${name}`);
    const res = await fetch(`http://127.0.0.1:${port}/latest.json`);
    assert.deepEqual(await res.json(), latest);
    const head = await fetch(`http://127.0.0.1:${port}/${name}`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '7');
    for (const p of ['/.hidden', '/..%2F..%2Fetc%2Fpasswd', '/sub/x', '/']) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 404, p);
    assert.equal((await fetch(`http://127.0.0.1:${port}/latest.json`, { method: 'POST' })).status, 404);
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    server?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The Linux server CLI (DESIGN §26): the tarball, its launcher, its checks, CI
// ---------------------------------------------------------------------------------------------------------------

const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8')).version;
const serverWanted = [`${SERVER_TOP_DIR}/VERSION`, `${SERVER_TOP_DIR}/package.json`];

/** Writes `text` to <root>/<rel> with `mode` (the folders on the way are made). */
function put(root, rel, text, mode = 0o644) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  fs.chmodSync(p, mode);
  return p;
}

/** A server tarball's tree as server-tarball.mjs lays it out (fake files) in <dir>/<top>; returns that folder. */
function fakeServerTree(dir, { version = '0.7.0', vulkan = true, top = SERVER_TOP_DIR } = {}) {
  const root = path.join(dir, top);
  put(root, 'VERSION', `${version}\n`);
  put(root, 'package.json', JSON.stringify({ name: 'easy-study', version }));
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist-server/server/cli.js', 'dist-server/server/index.js', 'web/dist/index.html', 'node/LICENSE', 'whisper/LICENSE', 'ffmpeg/BUILD.txt']) put(root, f, f);
  for (const f of ['bin/easy-study', 'node/bin/node', 'whisper/whisper-cli', 'ffmpeg/ffmpeg', ...(vulkan ? ['whisper/whisper-cli-vulkan'] : [])]) put(root, f, f, 0o755);
  return root;
}

/** <out>.tar.gz of <dir>/<top> with this system's tar (no AppleDouble files on macOS). */
function systemTarGz(dir, out, top = SERVER_TOP_DIR) {
  const r = spawnSync('tar', ['-czf', out, '-C', dir, top], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

/** A desktop/resources tree as `prepare.mjs --target <Linux target> --require-tools` leaves it (fake programs). */
function fakeResources(dir, target, { tools, version = repoVersion } = {}) {
  const info = targetInfo(target);
  put(dir, 'target.json', JSON.stringify({ target, os: info.os, cpu: info.cpu, tools: tools ?? { whisper: true, ffmpeg: true, ...(info.vulkan ? { 'whisper-vulkan': true } : {}) } }));
  put(dir, 'server/package.json', JSON.stringify({ name: 'easy-study', version }));
  put(dir, 'server/package-lock.json', '{}');
  put(dir, 'server/LICENSE', 'MIT');
  put(dir, 'server/THIRD_PARTY_NOTICES.md', 'notices');
  put(dir, 'server/dist-server/server/cli.js', 'cli');
  put(dir, 'server/dist-server/server/index.js', 'index');
  put(dir, 'server/web/dist/index.html', '<!doctype html>');
  put(dir, 'server/web/dist/assets/app.js', 'app', 0o600);
  fs.chmodSync(path.join(dir, 'server/web/dist/assets'), 0o700);
  put(dir, 'server/node_modules/sharp/lib/index.js', 'sharp');
  put(dir, 'server/node_modules/sharp/bin.js', '#!/usr/bin/env node', 0o755);
  put(dir, 'server/node_modules/a/node_modules/b/index.js', 'b');
  // npm's command links (node_modules/.bin, also nested): never shipped.
  fs.mkdirSync(path.join(dir, 'server/node_modules/.bin'));
  fs.symlinkSync('../sharp/bin.js', path.join(dir, 'server/node_modules/.bin/sharp'));
  fs.mkdirSync(path.join(dir, 'server/node_modules/a/node_modules/.bin'));
  fs.symlinkSync('../b/index.js', path.join(dir, 'server/node_modules/a/node_modules/.bin/b'));
  put(dir, `bin/es-node-${target}`, 'node', 0o755);
  put(dir, `bin/es-whisper-${target}`, 'whisper-cli', 0o755);
  if (info.vulkan) put(dir, `bin/es-whisper-vulkan-${target}`, 'whisper-cli-vulkan', 0o755);
  put(dir, `bin/es-ffmpeg-${target}`, 'ffmpeg', 0o755);
  put(dir, 'node/LICENSE', 'node license');
  put(dir, 'whisper/LICENSE', 'whisper license');
  for (const f of ['BUILD.txt', 'COPYING.LGPLv2.1', 'LICENSE.md', 'opus-COPYING']) put(dir, `ffmpeg/${f}`, f);
  return dir;
}

/** "<file|dir|link> <mode>" of every path under `root`, by its path relative to `root`. */
function listTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      out[path.relative(root, p).split(path.sep).join('/')] = `${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'} ${(st.mode & 0o777).toString(8)}`;
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
  return out;
}

/** The tree of the tarball of the fake resources: section 1 of the contract (DESIGN §26). */
const expectedServerTree = (vulkan) => ({
  LICENSE: 'file 644',
  'THIRD_PARTY_NOTICES.md': 'file 644',
  VERSION: 'file 644',
  bin: 'dir 755',
  'bin/easy-study': 'file 755',
  'dist-server': 'dir 755',
  'dist-server/server': 'dir 755',
  'dist-server/server/cli.js': 'file 644',
  'dist-server/server/index.js': 'file 644',
  ffmpeg: 'dir 755',
  'ffmpeg/BUILD.txt': 'file 644',
  'ffmpeg/COPYING.LGPLv2.1': 'file 644',
  'ffmpeg/LICENSE.md': 'file 644',
  'ffmpeg/ffmpeg': 'file 755',
  'ffmpeg/opus-COPYING': 'file 644',
  node: 'dir 755',
  'node/LICENSE': 'file 644',
  'node/bin': 'dir 755',
  'node/bin/node': 'file 755',
  node_modules: 'dir 755',
  'node_modules/a': 'dir 755',
  'node_modules/a/node_modules': 'dir 755',
  'node_modules/a/node_modules/b': 'dir 755',
  'node_modules/a/node_modules/b/index.js': 'file 644',
  'node_modules/sharp': 'dir 755',
  'node_modules/sharp/bin.js': 'file 755',
  'node_modules/sharp/lib': 'dir 755',
  'node_modules/sharp/lib/index.js': 'file 644',
  'package-lock.json': 'file 644',
  'package.json': 'file 644',
  web: 'dir 755',
  'web/dist': 'dir 755',
  'web/dist/assets': 'dir 755',
  'web/dist/assets/app.js': 'file 644',
  'web/dist/index.html': 'file 644',
  whisper: 'dir 755',
  'whisper/LICENSE': 'file 644',
  'whisper/whisper-cli': 'file 755',
  ...(vulkan ? { 'whisper/whisper-cli-vulkan': 'file 755' } : {}),
});

test('server tarball: the launcher runs the bundled Node on the CLI, also through a symbolic link', () => {
  assert.equal(LAUNCHER, path.join(REPO_DIR, 'packaging', 'server', 'easy-study'));
  const text = fs.readFileSync(LAUNCHER, 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\n'));
  assert.match(text, /^set -eu$/m);
  assert.match(text, /^self=\$\(readlink -f -- "\$0"\)$/m);
  assert.match(text, /^root=\$\(dirname -- "\$\(dirname -- "\$self"\)"\)$/m);
  assert.match(text, /^unset NODE_OPTIONS WATCH_REPORT_DEPENDENCIES$/m);
  assert.ok(text.endsWith('\nexec "$root/node/bin/node" --max-semi-space-size=2 "$root/dist-server/server/cli.js" "$@"\n'));
  if (process.platform === 'win32') return;
  const syntax = spawnSync('sh', ['-n', LAUNCHER], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.ok(fs.statSync(LAUNCHER).mode & 0o100, 'executable (git mode 100755)');
  // Installed as the README says (a symbolic link on PATH), with a stand-in for Node that prints what it got.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-launcher-'));
  try {
    const root = path.join(tmp, 'opt', SERVER_TOP_DIR);
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.copyFileSync(LAUNCHER, path.join(root, 'bin', 'easy-study'));
    fs.chmodSync(path.join(root, 'bin', 'easy-study'), 0o755);
    put(root, 'node/bin/node', '#!/bin/sh\nprintf \'%s\\n\' "$0" "$@" "${NODE_OPTIONS-unset}" "${WATCH_REPORT_DEPENDENCIES-unset}"\n', 0o755);
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.symlinkSync(path.join(root, 'bin', 'easy-study'), path.join(tmp, 'bin', 'easy-study'));
    const env = { ...process.env, NODE_OPTIONS: '--require /x.js', WATCH_REPORT_DEPENDENCIES: '1' };
    const r = spawnSync(path.join(tmp, 'bin', 'easy-study'), ['server', '--library', 'a b', '--port=6000'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const real = fs.realpathSync(root);
    assert.deepEqual(r.stdout.split('\n').slice(0, -1), [
      `${real}/node/bin/node`,
      '--max-semi-space-size=2',
      `${real}/dist-server/server/cli.js`,
      'server',
      '--library',
      'a b',
      '--port=6000',
      'unset',
      'unset',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('server tarball: the publish check takes one top folder of files and folders, the version, executable programs', { skip: process.platform === 'win32' && 'tar with symbolic and hard links' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-servertar-'));
  try {
    let n = 0;
    /** The problems of a tarball of the tree `build(dir)` makes (its top folder: SERVER_TOP_DIR unless returned). */
    const check = async (build, { version = '0.7.0', arch = 'x64' } = {}) => {
      const dir = path.join(tmp, `t${++n}`);
      fs.mkdirSync(dir);
      const top = build(dir);
      const file = systemTarGz(dir, path.join(tmp, `t${n}.tar.gz`), typeof top === 'string' && !top.includes(path.sep) ? top : SERVER_TOP_DIR);
      return serverArchiveProblems(await readTarGz(file, serverWanted), version, arch).join('; ');
    };
    assert.equal(await check((d) => fakeServerTree(d)), '');
    // arm64 has no Vulkan build of whisper-cli; x64 must have it.
    assert.equal(await check((d) => fakeServerTree(d, { vulkan: false }), { arch: 'arm64' }), '');
    assert.equal(await check((d) => fakeServerTree(d, { vulkan: false })), 'no easy-study-server/whisper/whisper-cli-vulkan');
    // A versioned top folder: the update keeps the install's folder name, so every version has the same one.
    const versioned = await check((d) => {
      fakeServerTree(d, { top: 'easy-study-server-0.7.0' });
      return 'easy-study-server-0.7.0';
    });
    assert.match(versioned, /^easy-study-server-0\.7\.0\/: not under easy-study-server\//);
    assert.match(versioned, /no easy-study-server\/bin\/easy-study/);
    // Links: a symbolic link could point out of the install, a hard link breaks unpacking into another folder.
    const symlink = await check((d) => {
      const root = fakeServerTree(d);
      fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
      fs.symlinkSync('../../node/bin/node', path.join(root, 'node_modules', '.bin', 'node'));
    });
    assert.equal(symlink, 'easy-study-server/node_modules/.bin/node: symbolic link (to ../../node/bin/node)');
    // Two names of a file the check does not require: tar stores whichever it reads first (the folder's order, which
    // on ext4 depends on the filesystem) as the file and the other as the link, and nothing else is reported.
    const hardlink = await check((d) => {
      const root = fakeServerTree(d);
      fs.linkSync(path.join(root, 'ffmpeg', 'BUILD.txt'), path.join(root, 'ffmpeg', 'BUILD-copy.txt'));
    });
    assert.match(hardlink, /^easy-study-server\/ffmpeg\/BUILD(-copy)?\.txt: hard link \(to easy-study-server\/ffmpeg\/BUILD(-copy)?\.txt\)$/);
    // Another version's files.
    assert.equal(
      await check((d) => fakeServerTree(d, { version: '0.6.9' })),
      'VERSION "0.6.9\\n", expected "0.7.0\\n"; package.json version 0.6.9, expected 0.7.0',
    );
    assert.equal(
      await check((d) => fs.writeFileSync(path.join(fakeServerTree(d), 'VERSION'), '0.7.0')),
      'VERSION "0.7.0", expected "0.7.0\\n"',
    );
    assert.equal(await check((d) => fs.chmodSync(path.join(fakeServerTree(d), 'node', 'bin', 'node'), 0o644)), 'easy-study-server/node/bin/node is not executable (mode 644)');
    assert.equal(await check((d) => fs.rmSync(path.join(fakeServerTree(d), 'dist-server', 'server', 'cli.js'))), 'no easy-study-server/dist-server/server/cli.js');
    // VERSION and package.json must have been read (readTarGz's `want`).
    const plain = path.join(tmp, 'plain');
    fakeServerTree(plain);
    const archive = await readTarGz(systemTarGz(plain, path.join(tmp, 'plain.tar.gz')), []);
    assert.equal(serverArchiveProblems(archive, '0.7.0', 'x64').join('; '), 'easy-study-server/VERSION was not read; easy-study-server/package.json was not read');
    assert.ok(archive.entries.some((e) => e.name === 'easy-study-server/bin/easy-study' && e.mode === 0o755));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Entries no tar here writes.
  const entry = (name, type = 'file') => ({ name, type, size: 0, link: '', mode: 0o644 });
  const problems = (entries, arch = 'x64') => serverArchiveProblems({ entries, files: {} }, '0.7.0', arch).join('; ');
  assert.match(problems([]), /^empty archive; no easy-study-server\/bin\/easy-study/);
  assert.match(problems([entry('easy-study-server/../x')]), /easy-study-server\/\.\.\/x: path leaves the folder/);
  assert.match(problems([entry('/easy-study-server/x')]), /\/easy-study-server\/x: not under easy-study-server\/; \/easy-study-server\/x: path leaves the folder/);
  assert.match(problems([entry('easy-study-server/./x')]), /path leaves the folder/);
  assert.match(problems([entry('easy-study-server/fifo', 'other')]), /easy-study-server\/fifo: neither a file nor a folder/);
  assert.match(problems([entry('easy-study-server')]), /easy-study-server: not a folder/);
  assert.match(problems([], 'aarch64'), /^arch aarch64: expected x64 or arm64/);
});

test('server tarball: the tree comes from prepare.mjs\'s resources of one Linux target (layout, modes, no links)', { skip: process.platform === 'win32' && 'POSIX modes and symbolic links' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-serverstage-'));
  try {
    let n = 0;
    const stage = (target, resources) => {
      const dir = path.join(tmp, `stage${++n}`);
      fs.mkdirSync(dir);
      return stageServerTree({ target, resources, stage: dir });
    };
    for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) {
      const resources = fakeResources(path.join(tmp, target), target);
      // A tool's note when it was left out (prepare.mjs without --require-tools) never ships.
      put(resources, 'whisper/NOT-BUNDLED.txt', 'not bundled');
      const { top, version, info } = stage(target, resources);
      assert.equal(path.basename(top), SERVER_TOP_DIR);
      assert.equal(version, repoVersion);
      assert.equal(info, targetInfo(target));
      assert.deepEqual(listTree(top), expectedServerTree(info.vulkan === true), target);
      // `easy-study update` refuses an install folder holding anything else at its top (server/selfUpdate.ts).
      assert.deepEqual(fs.readdirSync(top).filter((name) => !INSTALL_ENTRIES.includes(name)), [], target);
      assert.equal(fs.statSync(top).mode & 0o777, 0o755);
      assert.equal(fs.readFileSync(path.join(top, 'VERSION'), 'utf8'), `${repoVersion}\n`);
      assert.equal(fs.readFileSync(path.join(top, 'bin', 'easy-study'), 'utf8'), fs.readFileSync(LAUNCHER, 'utf8'));
      for (const [rel, text] of [['node/bin/node', 'node'], ['whisper/whisper-cli', 'whisper-cli'], ['ffmpeg/ffmpeg', 'ffmpeg'], ['node/LICENSE', 'node license']]) {
        assert.equal(fs.readFileSync(path.join(top, rel), 'utf8'), text, rel);
      }
      if (info.vulkan) assert.equal(fs.readFileSync(path.join(top, 'whisper', 'whisper-cli-vulkan'), 'utf8'), 'whisper-cli-vulkan');
    }
    const x64 = 'x86_64-unknown-linux-gnu';
    const fresh = (name, target = x64, opts) => fakeResources(path.join(tmp, name), target, opts);
    assert.throws(() => stage('aarch64-apple-darwin', fresh('mac')), /for Linux targets only/);
    assert.throws(() => stage(x64, fresh('arm', 'aarch64-unknown-linux-gnu')), /prepared for aarch64-unknown-linux-gnu, not x86_64-unknown-linux-gnu/);
    assert.throws(() => stage(x64, fresh('cpu-only', x64, { tools: { whisper: true, ffmpeg: true, 'whisper-vulkan': false } })), /has no whisper-vulkan/);
    assert.throws(() => stage(x64, fresh('no-ffmpeg', x64, { tools: { whisper: true, ffmpeg: false, 'whisper-vulkan': true } })), /has no ffmpeg/);
    assert.throws(() => stage(x64, fresh('old', x64, { version: '0.0.1' })), /version 0\.0\.1, the repo /);
    const linked = fresh('linked');
    fs.symlinkSync('index.html', path.join(linked, 'server', 'web', 'dist', 'start.html'));
    assert.throws(() => stage(x64, linked), /easy-study-server\/web\/dist\/start\.html: symbolic link/);
    const noFfmpeg = fresh('no-es-ffmpeg');
    fs.rmSync(path.join(noFfmpeg, 'bin', `es-ffmpeg-${x64}`));
    assert.throws(() => stage(x64, noFfmpeg), /es-ffmpeg-x86_64-unknown-linux-gnu missing/);
    const noCli = fresh('no-cli');
    fs.rmSync(path.join(noCli, 'server', 'dist-server', 'server', 'cli.js'));
    assert.throws(() => stage(x64, noCli), /dist-server\/server\/cli\.js missing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('server tarball: GNU tar packs easy-study-server/ sorted, owned by 0:0, as the publish check wants it', { skip: process.platform === 'win32' && 'POSIX modes and symbolic links' }, async () => {
  const src = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'server-tarball.mjs'), 'utf8');
  assert.match(src, /\[\s*'--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', file, '-C', stage, SERVER_TOP_DIR\]/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-servertarball-'));
  try {
    const target = 'x86_64-unknown-linux-gnu';
    const resources = fakeResources(path.join(tmp, 'resources'), target);
    const out = path.join(tmp, 'out');
    const tar = gnuTar();
    if (!tar) {
      // macOS (bsdtar): the tree is staged and checked, then the build stops.
      await assert.rejects(serverTarball({ target, resources, out, selfCheck: false }), /GNU tar is required/);
      assert.ok(!fs.existsSync(out));
      return;
    }
    const r = await serverTarball({ target, resources, out, selfCheck: false });
    assert.equal(r.name, serverTarballName(repoVersion, 'x64'));
    assert.equal(r.file, path.join(out, r.name));
    assert.equal(r.bytes, fs.statSync(r.file).size);
    assert.equal(r.sha256, crypto.createHash('sha256').update(fs.readFileSync(r.file)).digest('hex'));
    const archive = await readTarGz(r.file, serverWanted);
    assert.deepEqual(serverArchiveProblems(archive, repoVersion, 'x64'), []);
    // One folder, entries sorted by name within each folder (depth first), the modes of the staged tree.
    const names = archive.entries.map((e) => e.name.replace(/\/$/, ''));
    const bySegments = (a, b) => {
      const [x, y] = [a.split('/'), b.split('/')];
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return x.length - y.length;
    };
    assert.deepEqual(names, [...names].sort(bySegments));
    assert.equal(names[0], SERVER_TOP_DIR);
    const listed = Object.fromEntries(archive.entries.slice(1).map((e) => [e.name.replace(/\/$/, '').slice(SERVER_TOP_DIR.length + 1), `${e.type} ${e.mode.toString(8)}`]));
    assert.deepEqual(listed, expectedServerTree(true));
    assert.equal(archive.entries[0].mode, 0o755);
    const owners = spawnSync(tar, ['--numeric-owner', '-tvzf', r.file], { encoding: 'utf8' });
    assert.equal(owners.status, 0, owners.stderr);
    for (const line of owners.stdout.trim().split('\n')) assert.match(line, /^\S+ 0\/0 /, line);
    // The staging folder is gone.
    assert.deepEqual(fs.readdirSync(out), [r.name]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('server tarball: publish-release.mjs checks it and update-e2e.mjs serves it like the other updater artifacts', () => {
  const src = fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', 'publish-release.mjs'), 'utf8');
  assert.match(src, /for \(const c of updater\.filter\(\(u\) => u\.name\.startsWith\(`\$\{SERVER_TOP_DIR\}-`\)\)\) \{/);
  assert.match(src, /const arch = \/-linux-\(x64\|arm64\)\\\.tar\\\.gz\$\/\.exec\(c\.name\)\?\.\[1\];/);
  assert.match(src, /readTarGz\(path\.join\(work, 'assets', c\.name\), \[`\$\{SERVER_TOP_DIR\}\/VERSION`, `\$\{SERVER_TOP_DIR\}\/package\.json`\]\)/);
  assert.match(src, /serverArchiveProblems\(archive, version, arch\)/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-e2e-server-'));
  try {
    const name = serverTarballName('0.6.6-e2e.2', 'x64');
    fs.writeFileSync(path.join(tmp, name), 'tarball');
    fs.writeFileSync(path.join(tmp, `${name}.sig`), `${Buffer.from('sig').toString('base64')}\n`);
    const latest = writeLatest({ dir: tmp, version: '0.6.6-e2e.2', port: 8777 });
    assert.deepEqual(latest.platforms, { 'linux-x86_64-server': { url: `http://127.0.0.1:8777/${name}`, signature: Buffer.from('sig').toString('base64') } });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CI: the Linux builds pack the server tarball, upload it with the bundles and run it as a user installs it', () => {
  const wf = workflow();
  assert.match(wf.slice(0, wf.indexOf('\nname: desktop\n')), /\n# The Linux builds also pack the server CLI alone \(DESIGN §26\): easy-study-server-<version>-linux-<arch>\.tar\.gz\.\n/);
  const build = /\n {2}build:\n([\s\S]*?)\n {2}arch:/.exec(wf)?.[1];
  const step = /- name: Server tarball \(Linux\)\n\s+if: ([^\n]+)\n\s+run: ([^\n]+)\n/.exec(build);
  assert.ok(step, 'step "Server tarball (Linux)"');
  assert.equal(step[1], "runner.os == 'Linux'");
  assert.equal(step[2], 'node desktop/scripts/server-tarball.mjs --target ${{ matrix.target }} --out "$BUNDLE/server"');
  const at = (s) => {
    assert.ok(build.includes(s), s);
    return build.indexOf(s);
  };
  assert.ok(at('- name: AppImage without host libraries (Linux)') < at('- name: Server tarball (Linux)'));
  assert.ok(at('- name: Server tarball (Linux)') < at('- uses: actions/upload-artifact'));
  // The last path of the bundles' upload: it lands in easy-study-linux-*, where the release job's `find dist -type f`
  // takes it (the arch job looks for dist/deb and *_amd64.AppImage only).
  assert.match(build, /\n {12}\$\{\{ env\.BUNDLE \}\}\/appimage\/\*\.AppImage\n {12}\$\{\{ env\.BUNDLE \}\}\/server\/\*\.tar\.gz\n {10}if-no-files-found: error\n/);
  const smoke = /- name: Smoke test \(Linux, server tarball\)\n {8}if: ([^\n]+)\n {8}run: \|\n((?: {10}[^\n]*\n)+)/.exec(build);
  assert.ok(smoke, 'step "Smoke test (Linux, server tarball)"');
  assert.equal(smoke[1], "matrix.smoke && runner.os == 'Linux'");
  assert.ok(at('- name: Smoke test (Linux, AppImage from a dot folder)') < at('- name: Smoke test (Linux, server tarball)'));
  const lines = smoke[2].split('\n').map((l) => l.trim());
  // Unpacked into a dot folder, run through a symbolic link, the file name server-tarball.mjs gives it.
  assert.ok(lines.includes('case "${{ matrix.target }}" in x86_64-*) a=x64 ;; *) a=arm64 ;; esac'));
  assert.equal(serverTarballName('${v}', 'x64').replace('-x64.', '-${a}.'), 'easy-study-server-${v}-linux-${a}.tar.gz');
  for (const line of [
    'tar -xzf "$BUNDLE/server/easy-study-server-${v}-linux-${a}.tar.gz" -C "$RUNNER_TEMP/.es-server"',
    'root="$RUNNER_TEMP/.es-server/easy-study-server"',
    'ln -s "$root/bin/easy-study" "$RUNNER_TEMP/easy-study"',
    'es="$RUNNER_TEMP/easy-study"',
    'test "$("$es" version)" = "$v"',
    'test "$(cat "$root/VERSION")" = "$v"',
    // One check per line: bash -e does not stop on a failed command inside an && list (only on its last one).
    'test -x "$root/node/bin/node"',
    'test -x "$root/whisper/whisper-cli"',
    'test -x "$root/ffmpeg/ffmpeg"',
    'if [ "$a" = x64 ]; then test -x "$root/whisper/whisper-cli-vulkan"; fi',
    // A free port (never the app's 5350), the data under XDG_DATA_HOME, the access code from the terminal.
    'XDG_DATA_HOME="$RUNNER_TEMP/.es-data" "$es" server --port "$port" > "$RUNNER_TEMP/server.txt" 2>&1 &',
    'pid=$!',
    'for i in $(seq 90); do',
    "if grep -q 'login?code=' \"$RUNNER_TEMP/server.txt\"; then break; fi",
    "code=$(grep -o 'login?code=[0-9A-Za-z-]*' \"$RUNNER_TEMP/server.txt\" | head -n 1 | cut -d= -f2)",
    'test -n "$code"',
    // Login on for other devices; the version and the bundled tools behind it.
    'test "$(curl -s -o /dev/null -w \'%{http_code}\' "http://127.0.0.1:$port/api/health")" = 401',
    'curl -fsS -H "Authorization: Bearer $code" "http://127.0.0.1:$port/api/health" > "$RUNNER_TEMP/health.json"',
    'grep -F "\\"version\\":\\"$v\\"" "$RUNNER_TEMP/health.json"',
    'curl -fsS -H "Authorization: Bearer $code" "http://127.0.0.1:$port/api/asr" > "$RUNNER_TEMP/asr.json"',
    "grep -qF '\"engineAvailable\":true' \"$RUNNER_TEMP/asr.json\"",
    "grep -qF '\"ffmpegAvailable\":true' \"$RUNNER_TEMP/asr.json\"",
    'test -f "$RUNNER_TEMP/.es-data/easy-study/library/.auth.json"',
    // Ctrl+C: exit 0 (bash -e fails the step on `wait`'s status), nothing of the install left running.
    'kill -INT "$pid"',
    'wait "$pid"',
    'if pgrep -af "$root/"; then exit 1; fi',
  ]) {
    assert.ok(lines.includes(line), line);
  }
  assert.match(smoke[2], /port=\$\(node -e "const s = require\('net'\)\.createServer\(\)\.listen\(0, /);
  assert.ok(lines.indexOf('kill -INT "$pid"') + 1 === lines.indexOf('wait "$pid"'));
  // Not another ASR or Vulkan check (their counts are asserted above), no negated command.
  assert.doesNotMatch(smoke[2], /asr-smoke\.mjs"? --whisper|es-whisper-vulkan"? --version|GGML_BACKEND_PATH|--port 5350|5180/);
  assert.doesNotMatch(smoke[2], /^\s*!\s/m);
  assert.doesNotMatch(smoke[2], /&&\s*test /);
  assert.doesNotMatch(wf, /signer/);
});
