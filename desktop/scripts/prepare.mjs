#!/usr/bin/env node
// Builds the repo and prepares desktop/resources for one target (DESIGN §19, §22):
//   node desktop/scripts/prepare.mjs [--target <rust triple, default: this machine>] [--skip-build] [--require-tools]
//
//   1. `npm run build` in the repo (web/dist + dist-server), unless --skip-build;
//   2. the official Node runtime for the target (SHASUMS256-checked, cached in resources/.cache):
//        macOS / Windows → resources/node/bin/node | resources/node/node.exe   (bundle resource "node/")
//        Linux           → resources/bin/es-node-<triple>                      (externalBin → /usr/bin/es-node)
//      plus resources/node/LICENSE;
//   3. the packed server → resources/server (dist-server, web/dist, production node_modules for the target);
//   4. the recording tools (DESIGN §22), from <repo>/.cache, built there when missing (whisper.mjs, ffmpeg.mjs):
//        macOS / Windows → resources/whisper/whisper-cli[.exe] (+ its DLLs), resources/ffmpeg/ffmpeg[.exe]
//        Linux           → resources/bin/es-whisper-<triple>, resources/bin/es-ffmpeg-<triple> (externalBins)
//      plus their licenses in resources/whisper/ and resources/ffmpeg/ (ffmpeg: LGPL text, BUILD.txt). A tool that
//      cannot be built here is left out with a warning (the app's server then looks for it on PATH, e.g.
//      Homebrew's ffmpeg), unless --require-tools (CI, releases);
//   5. resources/target.json, checked by build.mjs so a bundle never mixes targets.
import fs from 'node:fs';
import path from 'node:path';
import { buildFfmpeg } from './ffmpeg.mjs';
import { fetchNode } from './fetch-node.mjs';
import { packServer } from './pack-server.mjs';
import { REPO_DIR, RESOURCES_DIR, arg, exeName, hostTarget, runNpm, shippedNodeVersion, targetInfo } from './targets.mjs';
import { buildWhisper } from './whisper.mjs';

/**
 * The recording tools: `name` is the resources folder and, on Linux, the externalBin es-<name>; `exe` the program
 * file; `build` returns {files} (the program first or anywhere, its libraries and licenses) from the cache.
 */
export const RECORDING_TOOLS = [
  { name: 'whisper', exe: 'whisper-cli', label: 'whisper-cli (받아쓰기)', build: (target) => buildWhisper({ target }) },
  { name: 'ffmpeg', exe: 'ffmpeg', label: 'ffmpeg (녹음 파일 변환)', build: (target) => buildFfmpeg({ target }) },
];

/**
 * Copies a tool's files into the resources for `info`'s platform: everything into resources/<name>/, except on
 * Linux, where the program becomes resources/bin/es-<name>-<triple> and the folder keeps the licenses.
 */
export function placeTool({ tool, files, target, info, resources = RESOURCES_DIR }) {
  const dir = path.join(resources, tool.name);
  const exe = exeName(tool.exe, info.os);
  if (!files.some((f) => path.basename(f) === exe)) throw new Error(`${tool.name}: ${exe} missing`);
  const placed = [];
  for (const f of files) {
    const base = path.basename(f);
    const program = base === exe || /\.dll$/i.test(base);
    const dest = info.nodeAs === 'externalBin' && base === exe ? path.join(resources, 'bin', `es-${tool.name}-${target}`) : path.join(dir, base);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
    fs.chmodSync(dest, program ? 0o755 : 0o644);
    placed.push(path.relative(resources, dest).split(path.sep).join('/'));
  }
  return placed;
}

async function recordingTools({ target, info, required }) {
  const found = {};
  for (const tool of RECORDING_TOOLS) {
    const dir = path.join(RESOURCES_DIR, tool.name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let built = null;
    try {
      built = await tool.build(target);
    } catch (e) {
      if (required) throw e;
      console.warn(`!! ${tool.label}: ${e.message}\n!! 이 빌드에는 넣지 않아요: 앱의 서버가 PATH에서 찾아요 (DESIGN §22).`);
    }
    if (!built) {
      // Tauri needs the resource folder; it says why it is empty.
      fs.writeFileSync(
        path.join(dir, 'NOT-BUNDLED.txt'),
        `This build of easy-study does not include ${tool.exe}: the server looks for it on PATH (DESIGN §22).\n` +
          `이 빌드에는 ${tool.exe}가 들어 있지 않아요. 서버가 PATH에서 찾아요.\n`,
      );
      found[tool.name] = false;
      continue;
    }
    const placed = placeTool({ tool, files: built.files, target, info });
    console.log(`   ${tool.label}: ${placed.join(', ')}`);
    found[tool.name] = true;
  }
  return found;
}

export async function prepare({ target = hostTarget(), skipBuild = false, requireTools = false } = {}) {
  const info = targetInfo(target);
  const nodeVersion = shippedNodeVersion();
  if (!skipBuild) {
    console.log('== npm run build (repo)');
    runNpm(['run', 'build'], REPO_DIR);
  }
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });
  fs.rmSync(path.join(RESOURCES_DIR, 'target.json'), { force: true });

  console.log(`== Node v${nodeVersion} for ${target}`);
  const nodeDir = path.join(RESOURCES_DIR, 'node');
  const exe = await fetchNode({ version: nodeVersion, target: info.node, out: nodeDir });
  const binDir = path.join(RESOURCES_DIR, 'bin');
  fs.rmSync(binDir, { recursive: true, force: true });
  if (info.nodeAs === 'externalBin') {
    fs.mkdirSync(binDir, { recursive: true });
    const sidecar = path.join(binDir, `es-node-${target}`);
    fs.renameSync(exe, sidecar);
    fs.chmodSync(sidecar, 0o755);
    fs.rmSync(path.join(nodeDir, 'bin'), { recursive: true, force: true }); // resources/node keeps only LICENSE
    console.log(`   -> ${sidecar}`);
  }

  console.log(`== server for ${info.os}-${info.cpu}`);
  packServer({ repo: REPO_DIR, out: path.join(RESOURCES_DIR, 'server'), os: info.os, cpu: info.cpu, libc: info.libc });

  console.log(`== recording tools for ${target}`);
  const tools = await recordingTools({ target, info, required: requireTools });

  const stamp = { target, nodeVersion, os: info.os, cpu: info.cpu, tools, preparedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(RESOURCES_DIR, 'target.json'), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`== resources ready for ${target}`);
  return stamp;
}

if (import.meta.main) {
  await prepare({
    target: typeof arg('target') === 'string' ? arg('target') : hostTarget(),
    skipBuild: arg('skip-build') === true,
    requireTools: arg('require-tools') === true,
  });
}
