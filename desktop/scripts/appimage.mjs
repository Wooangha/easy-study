#!/usr/bin/env node
// Finishes the Linux AppImage (DESIGN §19); build.mjs runs it after `tauri build`:
//   node desktop/scripts/appimage.mjs <file.AppImage>…          remove HOST_LIBRARIES from the image
//   node desktop/scripts/appimage.mjs --check <file.AppImage>…  fail if an image still carries one (CI)
//
// Why: Tauri 2.11's AppImage bundler runs a linuxdeploy from mid-2024, and that version's excludelist does not
// have libwayland-client.so.0 yet. Upstream added it in Nov 2024 (AppImageCommunity/pkg2appimage#559, mesa
// issue 11316). So the image carries the build host's libwayland-client (Ubuntu 22.04: 1.20), and that copy
// shadows the user's. Mesa always comes from the user's system (libEGL, libGL and libgbm are on the excludelist)
// and needs a libwayland-client at least as new as itself. On Arch (mesa 26.2, wayland 1.26), libEGL_mesa then
// fails to load: undefined wl_fixes_interface, wl_display_create_queue_with_name and
// wl_display_dispatch_queue_timeout. WebKitWebProcess aborts ("Could not create default EGL display:
// EGL_BAD_PARAMETER") and the window stays blank. Mesa links libwayland-client only (libEGL_mesa), so the image
// keeps libwayland-cursor, -egl and -server for its own GTK and WebKit (as upstream's excludelist does).
// The same for the Vulkan loader, libvulkan.so.1 (x86_64: es-whisper-vulkan, whisper.cpp's GPU build, links it): it
// must be the user's, which finds the user's GPU drivers (ICDs) and is as new as they are; linuxdeploy would copy
// the build host's (Ubuntu 22.04) into the image.
//
// How: an AppImage is its runtime (an ELF executable) followed by a squashfs image, which starts where the
// ELF's section header table ends (that is how the runtime finds it). The image is unpacked with unsquashfs, the
// libraries are removed, and a new squashfs with the same compression and block size goes after the same
// runtime. The runtime's .digest_md5 section holds a digest of the old file (read only by AppImage validation
// tools), so it is cleared. Nothing is re-signed: these AppImages carry no signature or update information.
// Needs squashfs-tools 4.4 or later (unsquashfs, mksquashfs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Libraries that must come from the user's system, not the image's usr/lib (see above). */
export const HOST_LIBRARIES = ['libwayland-client.so.0', 'libvulkan.so.1'];

/** A file name in usr/lib that is one of `libs`, or a versioned file of one (libwayland-client.so.0.20.0). */
export function isHostLibrary(name, libs = HOST_LIBRARIES) {
  return libs.some((lib) => name === lib || name.startsWith(`${lib}.`));
}

/**
 * The ELF header fields of the AppImage runtime (little-endian ELF64: x86_64 and aarch64). `end` is where the
 * section header table ends, which is where the squashfs image starts.
 */
export function elfHeader(buf) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file');
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error('not a little-endian ELF64 file');
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);
  const shstrndx = buf.readUInt16LE(0x3e);
  return { shoff, shentsize, shnum, shstrndx, end: shoff + shentsize * shnum };
}

/** Name, file offset and size of every section of the runtime (`buf` holds at least the whole runtime). */
export function elfSections(buf) {
  const { shoff, shentsize, shnum, shstrndx, end } = elfHeader(buf);
  if (buf.length < end) throw new Error('the section header table is past the end of the buffer');
  const at = (i) => {
    const b = shoff + i * shentsize;
    return { nameAt: buf.readUInt32LE(b), offset: Number(buf.readBigUInt64LE(b + 0x18)), size: Number(buf.readBigUInt64LE(b + 0x20)) };
  };
  const names = at(shstrndx);
  return Array.from({ length: shnum }, (_, i) => {
    const s = at(i);
    const start = names.offset + s.nameAt;
    return { name: buf.toString('latin1', start, buf.indexOf(0, start)), offset: s.offset, size: s.size };
  });
}

/** The runtime's bytes and the squashfs image's offset in `file`. */
export function readRuntime(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    const { end } = elfHeader(head);
    const runtime = Buffer.alloc(end + 4);
    fs.readSync(fd, runtime, 0, runtime.length, 0);
    if (runtime.toString('latin1', end, end + 4) !== 'hsqs') throw new Error(`${file}: no squashfs image at offset ${end}`);
    return { runtime: runtime.subarray(0, end), offset: end };
  } finally {
    fs.closeSync(fd);
  }
}

function squashfs(tool, args) {
  try {
    return execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${tool} not found: install squashfs-tools (e.g. sudo apt-get install squashfs-tools)`);
    throw new Error(`${tool} ${args.join(' ')} failed: ${(err.stderr || err.stdout || err.message).trim()}`);
  }
}

/** The paths in the image (relative, "usr/lib/…"). */
export function listImage(file, offset = readRuntime(file).offset) {
  return squashfs('unsquashfs', ['-l', '-o', String(offset), file])
    .split('\n')
    .filter((line) => line.startsWith('squashfs-root/'))
    .map((line) => line.slice('squashfs-root/'.length));
}

/** The image's paths that are host libraries: files directly in usr/lib (where linuxdeploy puts libraries). */
export function hostLibrariesIn(paths, libs = HOST_LIBRARIES) {
  return paths.filter((p) => /^usr\/lib\/[^/]+$/.test(p) && isHostLibrary(p.slice('usr/lib/'.length), libs));
}

/** Removes `libs` from the AppImage `file` in place. Returns the removed paths (none: the file is untouched). */
export function stripAppImage(file, libs = HOST_LIBRARIES) {
  const { runtime, offset } = readRuntime(file);
  const before = listImage(file, offset);
  const remove = hostLibrariesIn(before, libs);
  if (remove.length === 0) {
    console.log(`   ${path.basename(file)}: no ${libs.join(', ')} in the image`);
    return [];
  }
  const stat = squashfs('unsquashfs', ['-s', '-o', String(offset), file]);
  const comp = /^Compression (\S+)/m.exec(stat)?.[1];
  const block = /^Block size (\d+)/m.exec(stat)?.[1];
  if (!comp || !block) throw new Error(`${file}: unexpected unsquashfs -s output:\n${stat}`);

  // Next to the file, so the result can be renamed over it.
  const tmp = fs.mkdtempSync(path.join(path.dirname(file), '.appimage-'));
  try {
    const root = path.join(tmp, 'root');
    squashfs('unsquashfs', ['-q', '-n', '-no-xattrs', '-o', String(offset), '-d', root, file]);
    for (const p of remove) fs.rmSync(path.join(root, p));
    const image = path.join(tmp, 'image.squashfs');
    // Like appimagetool: files owned by root, no xattrs, a fixed creation time.
    squashfs('mksquashfs', [root, image, '-comp', comp, '-b', block, '-root-owned', '-noappend', '-no-xattrs', '-mkfs-time', '0', '-quiet', '-no-progress']);

    const head = Buffer.from(runtime);
    const digest = elfSections(head).find((s) => s.name === '.digest_md5');
    if (digest) head.fill(0, digest.offset, digest.offset + digest.size);
    const out = path.join(tmp, path.basename(file));
    fs.writeFileSync(out, head);
    appendFile(out, image);
    fs.chmodSync(out, fs.statSync(file).mode & 0o7777);
    fs.renameSync(out, file);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const after = listImage(file);
  const left = hostLibrariesIn(after, libs);
  if (left.length > 0 || after.length !== before.length - remove.length) {
    throw new Error(`${file}: repacking went wrong (${before.length} -> ${after.length} paths, still there: ${left.join(', ') || 'none'})`);
  }
  console.log(`   ${path.basename(file)}: removed ${remove.join(', ')} (the system's copy is used; ${comp}, ${block}-byte blocks)`);
  return remove;
}

function appendFile(dest, src) {
  const out = fs.openSync(dest, 'a');
  const inp = fs.openSync(src, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (let n; (n = fs.readSync(inp, buf, 0, buf.length, null)) > 0; ) fs.writeSync(out, buf, 0, n);
  } finally {
    fs.closeSync(inp);
    fs.closeSync(out);
  }
}

/** Throws unless no `file` carries a host library. */
export function checkAppImages(files, libs = HOST_LIBRARIES) {
  if (files.length === 0) throw new Error('no AppImage given');
  for (const file of files) {
    const found = hostLibrariesIn(listImage(file), libs);
    if (found.length > 0) throw new Error(`${file} carries ${found.join(', ')}: run node desktop/scripts/appimage.mjs on it`);
    console.log(`${file}: ok (no ${libs.join(', ')})`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const files = check ? args.slice(1) : args;
  if (files.length === 0 || files.some((f) => f.startsWith('--'))) {
    console.error('usage: node desktop/scripts/appimage.mjs [--check] <file.AppImage>…');
    process.exit(2);
  }
  try {
    if (check) checkAppImages(files);
    else for (const file of files) stripAppImage(file);
  } catch (err) {
    console.error(`appimage.mjs: ${err.message}`);
    process.exit(1);
  }
}
