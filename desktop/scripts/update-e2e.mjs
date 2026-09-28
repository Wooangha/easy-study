#!/usr/bin/env node
// Local end-to-end test of the in-app updater (DESIGN §24) with a THROWAWAY key and an endpoint on 127.0.0.1: the
// shipped app has no runtime override, so the test builds its own apps with a build-time config overlay
// (build.mjs --tauri-config) that has a separate identifier, the throwaway public key and this server's URL.
//   node desktop/scripts/update-e2e.mjs config --version 0.5.0-e2e.1 --pubkey <e2e.key.pub> [--port 8777] --out <e2e-1.json>
//   node desktop/scripts/build.mjs --bundles app --skip-prepare --tauri-config <e2e-1.json>        (and e2e-2)
//   node desktop/scripts/update-e2e.mjs pack --app <…/bundle/macos/easy-study.app> --version 0.5.0-e2e.2 --out-dir <srv>
//   node desktop/scripts/update-e2e.mjs sign --key <e2e.key> --version 0.5.0-e2e.2 <srv>/easy-study_0.5.0-e2e.2_aarch64.app.tar.gz
//   node desktop/scripts/update-e2e.mjs serve --dir <srv> --version 0.5.0-e2e.2 [--port 8777] [--notes <text>]
// pack makes the archive exactly as CI does (.github/workflows/desktop.yml); serve writes <dir>/latest.json with the
// same latestJson() the publish script uses (only the artifacts that have a .sig) and serves that one folder on
// 127.0.0.1 (the files are read per request: edit latest.json for the negative tests while it runs). A throwaway key:
//   node desktop/node_modules/@tauri-apps/cli/tauri.js signer generate --ci -p "" -w <scratch>/e2e.key
// The release key (~/.tauri/easy-study-updater.key, key id UPDATER_KEY_ID) is refused everywhere here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parsePublicKey, verify } from './minisign.mjs';
import { UPDATER_ARTIFACTS, UPDATER_KEY_ID, appArchiveProblems, latestJson, readTarGz } from './release-assets.mjs';
import { DESKTOP_DIR, arg } from './targets.mjs';

/** tar arguments of the macOS updater archive (CI runs the same, with COPYFILE_DISABLE=1: no "._" files). */
export const APP_TAR_ARGS = ['--no-xattrs', '-czf'];

/** The build-time overlay of an e2e app: its own identifier (lock, storage, TCC), version, key and endpoint. */
export function e2eConfig({ version, pubkey, port }) {
  if (parsePublicKey(pubkey).keyId === UPDATER_KEY_ID) throw new Error('the e2e uses a throwaway key, never the release key');
  return {
    identifier: 'dev.easystudy.desktop.e2e',
    version,
    plugins: {
      updater: {
        pubkey: pubkey.trim(),
        endpoints: [`http://127.0.0.1:${port}/latest.json`],
        dangerousInsecureTransportProtocol: true,
        requireSignedVersion: true,
      },
    },
  };
}

/** Writes <dir>/latest.json for the updater artifacts of `version` in `dir` that have a .sig; returns it. */
export function writeLatest({ dir, version, port, notes = `easy-study ${version} (e2e)` }) {
  const artifacts = UPDATER_ARTIFACTS.map(({ suffix }) => `easy-study_${version}${suffix}`)
    .filter((name) => fs.existsSync(path.join(dir, name)) && fs.existsSync(path.join(dir, `${name}.sig`)))
    .map((name) => ({ name, signature: fs.readFileSync(path.join(dir, `${name}.sig`), 'utf8') }));
  if (artifacts.length === 0) throw new Error(`no signed updater artifact of ${version} in ${dir}`);
  const pubDate = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const latest = latestJson({ version, notes, pubDate, baseUrl: `http://127.0.0.1:${port}`, artifacts });
  fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  return latest;
}

/** Serves the files directly inside `dir` (GET/HEAD, no subfolders, no dot files) on 127.0.0.1:`port`. */
export function serveDir(dir, port, log = () => {}) {
  const server = http.createServer((req, res) => {
    let name = '';
    try {
      name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1));
    } catch {}
    const file = path.join(dir, name);
    const st = /^[^/\\.][^/\\]*$/.test(name) && ['GET', 'HEAD'].includes(req.method) ? fs.statSync(file, { throwIfNoEntry: false }) : null;
    if (!st?.isFile()) {
      res.writeHead(404).end();
      log(`${req.method} ${req.url} 404`);
      return;
    }
    res.writeHead(200, { 'content-length': st.size, 'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    log(`${req.method} /${name} 200 (${st.size} bytes)`);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Packs an easy-study.app as CI does; checks the archive the way the publish script does. Returns its path. */
export async function packApp({ app, version, outDir, arch = process.arch === 'arm64' ? 'aarch64' : 'x64' }) {
  if (path.basename(app) !== 'easy-study.app') throw new Error(`${app}: the bundle must be named easy-study.app (the updater drops the top folder)`);
  const out = path.join(outDir, `easy-study_${version}_${arch}.app.tar.gz`);
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync('tar', [...APP_TAR_ARGS, out, '-C', path.dirname(app), 'easy-study.app'], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (r.status !== 0) throw new Error(`tar failed (${r.status})`);
  const problems = appArchiveProblems(await readTarGz(out, ['easy-study.app/Contents/Info.plist']), version);
  if (problems.length) throw new Error(`${out}: ${problems.join('; ')}`);
  return out;
}

/** Signs `file` with a throwaway key for `version` and checks the result with <key>.pub. */
export async function signE2e({ key, version, file }) {
  const release = path.join(os.homedir(), '.tauri', 'easy-study-updater.key');
  if (path.resolve(key) === release) throw new Error('the e2e never signs with the release key');
  const pub = fs.readFileSync(`${key}.pub`, 'utf8');
  if (parsePublicKey(pub).keyId === UPDATER_KEY_ID) throw new Error('the e2e never signs with the release key');
  const cli = path.join(DESKTOP_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TAURI_SIGNING_')));
  const r = spawnSync(process.execPath, [cli, 'signer', 'sign', '-f', key, '-p', '', '--app-version', version, file], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tauri signer sign: ${r.stderr.trim()}`);
  return verify(pub, fs.readFileSync(`${file}.sig`, 'utf8'), { file });
}

async function main() {
  const cmd = process.argv[2];
  const need = (name) => {
    const v = arg(name);
    if (typeof v !== 'string') throw new Error(`${cmd}: --${name} is required`);
    return v;
  };
  const port = Number(arg('port', '8777'));
  if (cmd === 'config') {
    const config = e2eConfig({ version: need('version'), pubkey: fs.readFileSync(need('pubkey'), 'utf8'), port });
    fs.writeFileSync(need('out'), `${JSON.stringify(config, null, 2)}\n`);
    console.log(`wrote ${need('out')} (${config.identifier} ${config.version}, http://127.0.0.1:${port}/latest.json)`);
  } else if (cmd === 'pack') {
    console.log(await packApp({ app: path.resolve(need('app')), version: need('version'), outDir: path.resolve(need('out-dir')), arch: arg('arch') }));
  } else if (cmd === 'sign') {
    const file = process.argv.at(-1);
    console.log(await signE2e({ key: path.resolve(need('key')), version: need('version'), file: path.resolve(file) }));
  } else if (cmd === 'serve') {
    const dir = path.resolve(need('dir'));
    const latest = writeLatest({ dir, version: need('version'), port, notes: typeof arg('notes') === 'string' ? arg('notes') : undefined });
    await serveDir(dir, port, (line) => console.log(`${new Date().toISOString()} ${line}`));
    console.log(`serving ${dir} on http://127.0.0.1:${port}/ (latest.json: ${latest.version}, ${Object.keys(latest.platforms).join(', ')}); Ctrl+C to stop`);
  } else {
    console.error('usage: update-e2e.mjs config|pack|sign|serve … (see the comment at the top)');
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`update-e2e: ${e.message}`);
    process.exit(1);
  });
}
