#!/usr/bin/env node
// Builds the repo and prepares desktop/resources for one target (DESIGN §19):
//   node desktop/scripts/prepare.mjs [--target <rust triple, default: this machine>] [--skip-build]
//
//   1. `npm run build` in the repo (web/dist + dist-server), unless --skip-build;
//   2. the official Node runtime for the target (SHASUMS256-checked, cached in resources/.cache):
//        macOS / Windows → resources/node/bin/node | resources/node/node.exe   (bundle resource "node/")
//        Linux           → resources/bin/es-node-<triple>                      (externalBin → /usr/bin/es-node)
//      plus resources/node/LICENSE;
//   3. the packed server → resources/server (dist-server, web/dist, production node_modules for the target);
//   4. resources/target.json, checked by build.mjs so a bundle never mixes targets.
import fs from 'node:fs';
import path from 'node:path';
import { fetchNode } from './fetch-node.mjs';
import { packServer } from './pack-server.mjs';
import { REPO_DIR, RESOURCES_DIR, arg, hostTarget, runNpm, shippedNodeVersion, targetInfo } from './targets.mjs';

export async function prepare({ target = hostTarget(), skipBuild = false } = {}) {
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

  const stamp = { target, nodeVersion, os: info.os, cpu: info.cpu, preparedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(RESOURCES_DIR, 'target.json'), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`== resources ready for ${target}`);
  return stamp;
}

if (import.meta.main) {
  await prepare({ target: typeof arg('target') === 'string' ? arg('target') : hostTarget(), skipBuild: arg('skip-build') === true });
}
