// Checks for the programs the desktop app ships next to Node (DESIGN §22: whisper-cli, ffmpeg): built for the right
// CPU, and linked only against what every user's system has. A build host can hide a missing library (Homebrew's
// dylibs, the Visual C++ runtime on a CI runner, libgomp), so the files are read, not run: Mach-O load commands,
// ELF DT_NEEDED entries and PE import tables, parsed here without external tools.
import fs from 'node:fs';
import { elfSections } from './appimage.mjs';

const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64' };
const ELF_MACHINE = { 62: 'x64', 183: 'arm64' };
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64' };

/** Mach-O (thin, 64-bit): the CPU and the dylibs it loads. */
export function machoInfo(buf) {
  if (buf.length < 32) throw new Error('not a Mach-O file');
  const magic = buf.readUInt32LE(0);
  if (magic === 0xbebafeca || buf.readUInt32BE(0) === 0xcafebabe) throw new Error('a universal (fat) Mach-O file: expected one architecture');
  if (magic !== 0xfeedfacf) throw new Error('not a 64-bit Mach-O file');
  const cpu = MACHO_CPU[buf.readUInt32LE(4)] ?? `cputype 0x${buf.readUInt32LE(4).toString(16)}`;
  const ncmds = buf.readUInt32LE(16);
  const dylibs = [];
  let at = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(at);
    const size = buf.readUInt32LE(at + 4);
    // LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LAZY_LOAD_DYLIB, LC_LOAD_UPWARD_DYLIB
    if ([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023].includes(cmd)) {
      const name = at + buf.readUInt32LE(at + 8);
      dylibs.push(buf.toString('utf8', name, buf.indexOf(0, name)));
    }
    if (size < 8) throw new Error('broken Mach-O load command');
    at += size;
  }
  return { cpu, dylibs };
}

/**
 * ELF64 little-endian: the CPU, the shared libraries it needs (none for a static binary) and its library search
 * paths (DT_RPATH, DT_RUNPATH).
 */
export function elfInfo(buf) {
  const machine = buf.readUInt16LE(0x12);
  const cpu = ELF_MACHINE[machine] ?? `e_machine ${machine}`;
  const sections = elfSections(buf);
  const dynamic = sections.find((s) => s.name === '.dynamic');
  const dynstr = sections.find((s) => s.name === '.dynstr');
  const needed = [];
  const runpath = [];
  if (dynamic && dynstr) {
    for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size; at += 16) {
      const tag = buf.readBigInt64LE(at);
      if (tag === 0n) break;
      if (tag === 1n || tag === 15n || tag === 29n) {
        const name = dynstr.offset + Number(buf.readBigUInt64LE(at + 8));
        (tag === 1n ? needed : runpath).push(buf.toString('utf8', name, buf.indexOf(0, name)));
      }
    }
  }
  return { cpu, needed, runpath };
}

/** PE32+ (64-bit Windows): the CPU and the DLLs it imports. */
export function peInfo(buf) {
  if (buf.length < 64 || buf.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a PE file');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const coff = pe + 4;
  const cpu = PE_MACHINE[buf.readUInt16LE(coff)] ?? `machine 0x${buf.readUInt16LE(coff).toString(16)}`;
  const nsections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  if (buf.readUInt16LE(opt) !== 0x20b) throw new Error('not a 64-bit (PE32+) file');
  const sections = Array.from({ length: nsections }, (_, i) => {
    const s = opt + optSize + i * 40;
    return { va: buf.readUInt32LE(s + 12), vsize: buf.readUInt32LE(s + 8), raw: buf.readUInt32LE(s + 20), rawSize: buf.readUInt32LE(s + 16) };
  });
  const offset = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize));
    if (!s) throw new Error(`RVA 0x${rva.toString(16)} is in no section`);
    return s.raw + (rva - s.va);
  };
  const imports = [];
  const importRva = buf.readUInt32LE(opt + 120); // data directory 1 (import table)
  if (importRva !== 0) {
    for (let at = offset(importRva); ; at += 20) {
      const nameRva = buf.readUInt32LE(at + 12);
      if (nameRva === 0) break;
      const name = offset(nameRva);
      imports.push(buf.toString('latin1', name, buf.indexOf(0, name)));
    }
  }
  return { cpu, imports };
}

/** Libraries a shipped program may use: the OS's own. */
const ALLOWED = {
  darwin: (lib) => lib.startsWith('/usr/lib/') || lib.startsWith('/System/Library/'),
  // glibc (libc, libm, libpthread, libdl, librt, the loader) and GCC's runtime, which every distribution has
  // (Arch: gcc-libs). Not libgomp (OpenMP is off) and nothing else.
  linux: (lib) => /^(libc|libm|libpthread|libdl|librt|libgcc_s|libstdc\+\+)\.so\.\d+$|^ld-linux-(x86-64|aarch64)\.so\.\d+$/.test(lib),
  // Windows' own DLLs. Never the Visual C++ runtime (VCRUNTIME140, MSVCP140, VCOMP140, the api-ms-win-crt-*
  // forwarders of a /MD build): a user's computer need not have it (whisper-cli ships its vcomp140.dll: `own`).
  // Also no MinGW runtime DLLs.
  win32: (lib) => !/^(vcruntime|msvcp|vcomp|concrt|api-ms-win-crt-|libgcc|libstdc\+\+|libwinpthread|libgomp)/i.test(lib),
};

/**
 * Checks that `file` runs on `cpu` ('x64' | 'arm64') of `os` ('darwin' | 'linux' | 'win32') and loads only the OS's
 * libraries, plus `own` (file names shipped next to it, e.g. whisper.dll) and `allow` (system libraries this one
 * file may need because the packages declare them, e.g. libvulkan.so.1 for the Linux Vulkan build of whisper-cli,
 * which a computer without the Vulkan loader simply cannot start: the CPU build is used there). Returns the file's
 * libraries.
 */
export function checkBinary(file, { os, cpu, own = [], allow = [] }) {
  const buf = fs.readFileSync(file);
  const info = os === 'darwin' ? machoInfo(buf) : os === 'linux' ? elfInfo(buf) : peInfo(buf);
  if (info.cpu !== cpu) throw new Error(`${file}: built for ${info.cpu}, not ${cpu}`);
  const libs = info.dylibs ?? info.needed ?? info.imports;
  const ownSet = new Set([...own, ...allow].map((n) => n.toLowerCase()));
  const foreign = libs.filter((lib) => !ownSet.has(lib.toLowerCase()) && !ALLOWED[os](lib));
  if (foreign.length > 0) throw new Error(`${file}: links libraries a user's computer may not have: ${foreign.join(', ')}`);
  return libs;
}
