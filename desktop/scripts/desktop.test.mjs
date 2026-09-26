// Invariants of the desktop app's configuration (DESIGN §19). Run: node --test desktop/scripts/*.test.mjs
// (npm run desktop:test). The shell's own logic has Rust unit tests: cargo test in desktop/src-tauri.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HOST_LIBRARIES, elfHeader, elfSections, hostLibrariesIn, isHostLibrary } from './appimage.mjs';
import { DESKTOP_DIR, REPO_DIR, TARGETS, hostTarget, shippedNodeVersion, targetInfo, tauriEnv } from './targets.mjs';

const tauriDir = path.join(DESKTOP_DIR, 'src-tauri');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(tauriDir, file), 'utf8'));
const mainRs = fs.readFileSync(path.join(tauriDir, 'src', 'main.rs'), 'utf8');

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
  const resources = { '../resources/node/': 'node/', '../resources/server/': 'server/' };
  for (const b of [mac, win, linux]) assert.deepEqual(b.resources, resources);
  assert.deepEqual(mac.targets, ['app', 'dmg']);
  assert.equal(mac.macOS.signingIdentity, '-');
  assert.deepEqual(win.targets, ['nsis']);
  assert.equal(win.windows.nsis.installMode, 'currentUser');
  assert.equal(win.windows.webviewInstallMode.type, 'downloadBootstrapper');
  // Linux: Node is an externalBin named es-node (/usr/bin/node would clash with the distribution's nodejs).
  assert.deepEqual(linux.externalBin, ['../resources/bin/es-node']);
  assert.ok(linux.linux.deb.depends.includes('libatomic1'));
  assert.ok(linux.linux.deb.recommends.includes('fonts-noto-cjk'));
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

test('CI workflow: pinned actions, release assets are files, smoke tests cover the chooser and a dot-folder library', () => {
  const workflow = fs.readFileSync(path.join(REPO_DIR, '.github', 'workflows', 'desktop.yml'), 'utf8');
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 5);
  for (const ref of uses) assert.match(ref, /@(v\d+(\.\d+)*|[0-9a-f]{40})$/, `${ref}: a version tag or a commit, not a branch`);
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
  assert.deepEqual(HOST_LIBRARIES, ['libwayland-client.so.0']);
  assert.ok(isHostLibrary('libwayland-client.so.0'));
  assert.ok(isHostLibrary('libwayland-client.so.0.20.0'));
  for (const name of ['libwayland-cursor.so.0', 'libwayland-egl.so.1', 'libwayland-server.so.0', 'libwayland-client.so.00']) {
    assert.ok(!isHostLibrary(name), name);
  }
  const paths = [
    'usr/lib/libwayland-client.so.0',
    'usr/lib/libwayland-cursor.so.0',
    'usr/lib/easy-study/server/libwayland-client.so.0',
    'usr/share/doc/libwayland-client0/copyright',
  ];
  assert.deepEqual(hostLibrariesIn(paths), ['usr/lib/libwayland-client.so.0']);
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
  assert.match(workflow, /release:\n[^\n]*\n\s+needs: \[build, arch\]/);
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
});
