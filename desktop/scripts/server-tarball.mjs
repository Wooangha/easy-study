#!/usr/bin/env node
// The Linux server tarball (DESIGN §26): `easy-study server` and `easy-study update` without the desktop shell, from
// what prepare.mjs left in desktop/resources for a Linux target (run it for that target first, --require-tools):
//   node desktop/scripts/server-tarball.mjs --target <x86_64|aarch64>-unknown-linux-gnu --out <dir> [--resources desktop/resources]
// → <out>/easy-study-server-<version>-linux-<x64|arm64>.tar.gz with one top folder, easy-study-server/ (the same for
// every version: `easy-study update` swaps the folder in place):
//   VERSION, package.json, dist-server/, web/dist/, node_modules/ (no .bin links)   the packed server
//   bin/easy-study                                                                   packaging/server/easy-study
//   node/bin/node, node/LICENSE                                                      the official Node
//   whisper/whisper-cli (+ whisper-cli-vulkan on x64), whisper/LICENSE               the recording tools (DESIGN §22)
//   ffmpeg/ffmpeg and its licenses
// No GUI library, no symbolic or hard link; folders 0755, files 0755 or 0644, owner 0:0, entries sorted by name.
// GNU tar (Linux) makes the archive; it is read back and checked the way the publish script checks it.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_TOP_DIR, readTarGz, serverArchiveProblems, serverTarballName } from './release-assets.mjs';
import { REPO_DIR, RESOURCES_DIR, arg, targetInfo } from './targets.mjs';

/** The launcher that becomes <top>/bin/easy-study (POSIX sh; git mode 100755). */
export const LAUNCHER = path.join(REPO_DIR, 'packaging', 'server', 'easy-study');

/** The programs of the tarball: always 0755 whatever the source's mode says (serverArchiveProblems requires it). */
const PROGRAMS = ['bin/easy-study', 'node/bin/node', 'whisper/whisper-cli', 'whisper/whisper-cli-vulkan', 'ffmpeg/ffmpeg'];

/**
 * Copies the files directly inside `src` (a folder of licenses) into `dest`, except `skip`; a subfolder is copied
 * whole.
 */
function copyFolder(src, dest, skip = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    fs.cpSync(path.join(src, e.name), path.join(dest, e.name), { recursive: true });
  }
}

function copyFile(src, dest) {
  if (!fs.statSync(src, { throwIfNoEntry: false })?.isFile()) throw new Error(`${src} missing: run prepare.mjs for this target with --require-tools`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Every path under `dir` (lstat: links are not followed), folders before what they hold. */
function walk(dir, visit) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = fs.lstatSync(p);
    visit(p, st);
    if (st.isDirectory()) walk(p, visit);
  }
}

/**
 * Assembles the tarball's tree for `target` from `resources` under `stage`/easy-study-server and normalizes it.
 * Returns { top, version, info }. Throws when the resources are not a complete prepare.mjs run for this Linux target
 * or the tree holds a link.
 */
export function stageServerTree({ target, resources = RESOURCES_DIR, stage }) {
  const info = targetInfo(target);
  if (info.os !== 'linux') throw new Error(`${target}: the server tarball is for Linux targets only`);
  const stampFile = path.join(resources, 'target.json');
  const stamp = fs.existsSync(stampFile) ? JSON.parse(fs.readFileSync(stampFile, 'utf8')) : null;
  if (stamp?.target !== target) throw new Error(`${resources} is prepared for ${stamp?.target ?? 'nothing'}, not ${target}: node desktop/scripts/prepare.mjs --target ${target} --require-tools`);
  const tools = stamp.tools ?? {};
  const need = ['whisper', 'ffmpeg', ...(info.vulkan ? ['whisper-vulkan'] : [])];
  const lacking = need.filter((t) => tools[t] !== true);
  if (lacking.length) throw new Error(`${resources} has no ${lacking.join(', ')} (target.json tools): the server tarball ships the recording tools (prepare.mjs --require-tools)`);
  const version = JSON.parse(fs.readFileSync(path.join(resources, 'server', 'package.json'), 'utf8')).version;
  const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8')).version;
  if (version !== repoVersion) throw new Error(`${resources}/server is version ${version}, the repo ${repoVersion}: prepare it again`);

  const top = path.join(stage, SERVER_TOP_DIR);
  fs.rmSync(top, { recursive: true, force: true });
  fs.cpSync(path.join(resources, 'server'), top, { recursive: true, verbatimSymlinks: true });
  const bin = (name) => path.join(resources, 'bin', `${name}-${target}`);
  copyFile(bin('es-node'), path.join(top, 'node', 'bin', 'node'));
  copyFile(path.join(resources, 'node', 'LICENSE'), path.join(top, 'node', 'LICENSE'));
  copyFolder(path.join(resources, 'whisper'), path.join(top, 'whisper'), ['NOT-BUNDLED.txt']);
  copyFile(bin('es-whisper'), path.join(top, 'whisper', 'whisper-cli'));
  // The server finds it beside whisper-cli (server/recordings/asr.ts gpuCommandFor: <whisper-cli>-vulkan).
  if (info.vulkan) copyFile(bin('es-whisper-vulkan'), path.join(top, 'whisper', 'whisper-cli-vulkan'));
  copyFolder(path.join(resources, 'ffmpeg'), path.join(top, 'ffmpeg'), ['NOT-BUNDLED.txt']);
  copyFile(bin('es-ffmpeg'), path.join(top, 'ffmpeg', 'ffmpeg'));
  copyFile(LAUNCHER, path.join(top, 'bin', 'easy-study'));
  fs.writeFileSync(path.join(top, 'VERSION'), `${version}\n`);

  // npm's node_modules/.bin links (the server runs no package's command line).
  const dotBins = [];
  walk(top, (p, st) => {
    if (st.isDirectory() && path.basename(p) === '.bin' && p.split(path.sep).includes('node_modules')) dotBins.push(p);
  });
  for (const d of dotBins) fs.rmSync(d, { recursive: true, force: true });
  const problems = [];
  walk(top, (p, st) => {
    const rel = path.relative(stage, p);
    if (st.isSymbolicLink()) problems.push(`${rel}: symbolic link`);
    else if (st.isFile() && st.nlink > 1) problems.push(`${rel}: hard link (${st.nlink} names)`);
    else if (!st.isFile() && !st.isDirectory()) problems.push(`${rel}: neither a file nor a folder`);
  });
  if (!fs.existsSync(path.join(top, 'dist-server', 'server', 'cli.js'))) problems.push(`${SERVER_TOP_DIR}/dist-server/server/cli.js missing (npm run build)`);
  if (problems.length) throw new Error(`server tarball: ${problems.join('; ')}`);

  // Modes: folders 0755, files 0755 when the source was executable by its owner, else 0644; the programs 0755.
  fs.chmodSync(top, 0o755);
  walk(top, (p, st) => fs.chmodSync(p, st.isDirectory() || st.mode & 0o100 ? 0o755 : 0o644));
  for (const rel of PROGRAMS) {
    const p = path.join(top, rel);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }
  return { top, version, info };
}

/** `tar` or `gtar`, whichever is GNU tar (--sort=name, --owner=0); null when there is none. */
export function gnuTar() {
  for (const cmd of ['tar', 'gtar']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /GNU tar/.test(r.stdout)) return cmd;
  }
  return null;
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Builds <out>/easy-study-server-<version>-linux-<cpu>.tar.gz for `target` from `resources`. `selfCheck`: on a
 * Linux host of the target's CPU, the staged `bin/easy-study version` must print the version (the bundled Node runs
 * the CLI). Returns { file, name, bytes, sha256 }.
 */
export async function serverTarball({ target, resources = RESOURCES_DIR, out, selfCheck = true }) {
  if (!out) throw new Error('--out <dir> is required');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'es-server-tarball-'));
  try {
    const { top, version, info } = stageServerTree({ target, resources, stage });
    if (selfCheck && process.platform === 'linux' && process.arch === info.cpu) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EASY_STUDY_')));
      const r = spawnSync(path.join(top, 'bin', 'easy-study'), ['version'], { encoding: 'utf8', timeout: 60_000, env });
      if (r.status !== 0 || r.stdout !== `${version}\n`) {
        throw new Error(`bin/easy-study version: exit ${r.status ?? r.signal ?? r.error?.message}, printed ${JSON.stringify(r.stdout)} (expected ${version})\n${r.stderr ?? ''}`);
      }
      console.log(`   bin/easy-study version → ${version}`);
    }
    const tar = gnuTar();
    if (!tar) throw new Error('GNU tar is required (--sort=name, --owner=0): build the server tarball on Linux');
    const name = serverTarballName(version, info.cpu);
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(path.resolve(out), name);
    fs.rmSync(file, { force: true });
    execFileSync(tar, ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', file, '-C', stage, SERVER_TOP_DIR], { stdio: 'inherit' });
    const problems = serverArchiveProblems(await readTarGz(file, [`${SERVER_TOP_DIR}/VERSION`, `${SERVER_TOP_DIR}/package.json`]), version, info.cpu);
    if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
    const bytes = fs.statSync(file).size;
    const sha256 = await fileSha256(file);
    console.log(`server tarball -> ${file}\n   ${(bytes / 1e6).toFixed(1)} MB, sha256 ${sha256}`);
    return { file, name, bytes, sha256 };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const target = arg('target');
  const out = arg('out');
  if (typeof target !== 'string' || typeof out !== 'string') {
    console.error('usage: node desktop/scripts/server-tarball.mjs --target <x86_64|aarch64>-unknown-linux-gnu --out <dir> [--resources desktop/resources]');
    process.exit(2);
  }
  const resources = typeof arg('resources') === 'string' ? path.resolve(arg('resources')) : RESOURCES_DIR;
  serverTarball({ target, resources, out: path.resolve(out) }).catch((e) => {
    console.error(`server-tarball: ${e.message}`);
    process.exit(1);
  });
}
