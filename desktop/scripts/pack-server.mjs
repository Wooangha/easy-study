#!/usr/bin/env node
// Packs the built easy-study server for the desktop bundle (run `npm run build` in the repo first):
//   node desktop/scripts/pack-server.mjs [--repo .] [--out desktop/resources/server]
//                                        [--os darwin|win32|linux] [--cpu arm64|x64] [--libc glibc]
// Layout (what server/config.ts expects: package.json at the root, web/dist and node_modules beside it):
//   <out>/package.json, package-lock.json, THIRD_PARTY_NOTICES.md, dist-server/, web/dist/,
//   node_modules/ (production dependencies for the TARGET platform: `npm ci --omit=dev --os --cpu`).
import fs from 'node:fs';
import path from 'node:path';
import { REPO_DIR, RESOURCES_DIR, arg, runNpm } from './targets.mjs';

const JUNK = /(^|\/)(README|CHANGELOG|HISTORY|AUTHORS|CONTRIBUTING)(\.[a-z]+)?$|\.(d\.ts|d\.mts|d\.cts|map|md|markdown)$/i;

export function packServer({ repo = REPO_DIR, out, os = process.platform, cpu = process.arch, libc }) {
  for (const need of ['dist-server/server/index.js', 'dist-server/server/imageWorker.js', 'web/dist/index.html']) {
    if (!fs.existsSync(path.join(repo, need))) throw new Error(`${need} missing: run npm run build in ${repo} first`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'web'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md']) {
    if (fs.existsSync(path.join(repo, f))) fs.copyFileSync(path.join(repo, f), path.join(out, f));
  }
  fs.cpSync(path.join(repo, 'dist-server'), path.join(out, 'dist-server'), { recursive: true });
  fs.cpSync(path.join(repo, 'web', 'dist'), path.join(out, 'web', 'dist'), { recursive: true });

  // Production dependencies for the target platform. --ignore-scripts: none of them needs an install script,
  // and scripts of another platform's packages must not run here.
  const flags = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${os}`, `--cpu=${cpu}`];
  if (libc) flags.push(`--libc=${libc}`);
  runNpm(flags, out);

  // sharp-wasm32 (+ @emnapi) declare no os/cpu, so npm always installs them; they are only sharp's fallback
  // when the native @img/sharp-<os>-<cpu> is missing (~9 MB).
  const nm = path.join(out, 'node_modules');
  if (!fs.existsSync(path.join(nm, '@img', `sharp-${os}-${cpu}`))) throw new Error(`@img/sharp-${os}-${cpu} was not installed`);
  for (const p of ['@img/sharp-wasm32', '@emnapi']) fs.rmSync(path.join(nm, p), { recursive: true, force: true });
  if (!fs.existsSync(path.join(nm, '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm'))) throw new Error('@embedpdf/pdfium/dist/pdfium.wasm missing');

  // Files the runtime never reads (licenses stay).
  let removed = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (JUNK.test(p.replaceAll('\\', '/')) && !/licen[cs]e|notice/i.test(e.name)) {
        fs.rmSync(p);
        removed++;
      }
    }
  };
  walk(nm);
  console.log(`server packed -> ${out} (${os}-${cpu}${libc ? `-${libc}` : ''}); removed ${removed} doc/type/map files`);
}

if (import.meta.main) {
  const str = (name, fallback) => (typeof arg(name) === 'string' ? arg(name) : fallback);
  packServer({
    repo: path.resolve(str('repo', REPO_DIR)),
    out: path.resolve(str('out', path.join(RESOURCES_DIR, 'server'))),
    os: str('os', process.platform),
    cpu: str('cpu', process.arch),
    libc: str('libc', undefined),
  });
}
