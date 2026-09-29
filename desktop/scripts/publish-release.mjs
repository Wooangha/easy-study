#!/usr/bin/env node
// Publishes a desktop release (DESIGN §24; docs/HANDOFF.md "Git / release workflow"): CI's draft in the private repo
// Wooangha/easy-study becomes a signed release with latest.json in the public Wooangha/easy-study-releases, where the
// in-app updater (tauri.conf.json plugins.updater) and the README's download links find it. Run on the maintainer's
// Mac, and for real only on the user's word:
//   node desktop/scripts/publish-release.mjs --tag v0.5.0                        dry run (the default; --dry-run too)
//   node desktop/scripts/publish-release.mjs --tag v0.5.0 --publish --commit <reviewed sha> --notes <notes.md>
//        [--key ~/.tauri/easy-study-updater.key] [--work .cache/publish/v0.5.0] [--skip-private] [--not-latest]
//
// The dry run reads only (git, the GitHub API with the user's gh login, the draft's tiny PKGBUILD): it never touches
// the key and writes nothing on GitHub. It prints every check, the asset table, the planned latest.json and the steps
// a real run would take, and exits with 1 when a real run would refuse.
//
// Checks before anything is signed (any failure aborts; there is no override):
// - the tag's commit is the same locally and on GitHub, is an ancestor of main (origin/main and GitHub's), and is
//   the one the user reviewed (--commit); package.json at the tag has the tag's version; tauri.conf.json at the tag
//   has the updater key (id UPDATER_KEY_ID), endpoint and requireSignedVersion;
// - the draft and every asset were uploaded by github-actions[bot] during a successful desktop run of that commit and
//   tag, every asset is complete and has GitHub's sha256 digest, and every name is in release-assets.mjs's allowlist
//   (nothing else is ever made public) with all required assets present;
// - the PKGBUILD downloads from the public repo, for this version, with the draft's .deb checksums;
// - after the download: sha256 = GitHub's digest; the macOS archives have one top folder, no hard link or "._" file
//   and Info.plist's version; the Windows installer's version resource (ProductVersion) is the version (the AppImages
//   are squashfs images: they are only checked by name, CI run and digest); every signature verifies with the key the installed apps trust (the tag's, and the
//   public latest release's), names its file and version (trusted comment file:/version:).
// Signing: `tauri signer sign -f <key> --app-version <v>`. The script passes the key's path to the
// Tauri CLI and never reads, prints or copies the key itself.
// Publishing: a DRAFT public release gets every allowlisted asset, SHA256SUMS.txt and latest.json (last); only then
// is it published. A published release is never changed: when a re-run finds a published asset that differs, it
// stops ("cut a new patch version"). Every step looks at GitHub's state first, so a re-run resumes where the last one
// stopped (the downloads and signatures are kept in --work). Then latest.json and every asset URL are checked
// without auth, and the private draft is published (unless --skip-private).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePublicKey, verify, verifyTrusted } from './minisign.mjs';
import {
  CI_WORKFLOW,
  PRIVATE_REPO,
  PUBLIC_REPO,
  UPDATER_ENDPOINT,
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
  sha256sums,
  versionInfoString,
} from './release-assets.mjs';
import { CACHE_DIR, DESKTOP_DIR, REPO_DIR } from './targets.mjs';

export const DEFAULT_KEY = '~/.tauri/easy-study-updater.key';

/** The options of `argv` (process.argv.slice(2)); a dry run unless --publish. Throws a usage error. */
export function parseOptions(argv) {
  const flags = new Set(['dry-run', 'publish', 'skip-private', 'not-latest']);
  const values = new Set(['tag', 'commit', 'notes', 'key', 'work']);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !(flags.has(name) || values.has(name))) throw new Error(`unknown argument ${argv[i]}`);
    if (flags.has(name)) o[name] = true;
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${name} needs a value`);
    else o[name] = argv[++i];
  }
  if (!/^v\d+\.\d+\.\d+$/.test(o.tag ?? '')) throw new Error('--tag vX.Y.Z is required');
  if (o.publish && o['dry-run']) throw new Error('--publish and --dry-run exclude each other');
  const dryRun = !o.publish;
  if (!dryRun && !o.commit) throw new Error('--publish needs --commit <sha>: the commit the user reviewed (a dry run prints it)');
  if (!dryRun && !o.notes) throw new Error('--publish needs --notes <file.md>: the public release notes the user approved');
  if (o.commit && !/^[0-9a-f]{7,40}$/.test(o.commit)) throw new Error('--commit: 7 to 40 hex digits');
  return {
    tag: o.tag,
    version: o.tag.slice(1),
    dryRun,
    commit: o.commit ?? null,
    notes: o.notes ?? null,
    key: expandHome(o.key ?? DEFAULT_KEY),
    work: path.resolve(o.work ?? path.join(CACHE_DIR, 'publish', o.tag)),
    skipPrivate: o['skip-private'] === true,
    notLatest: o['not-latest'] === true,
  };
}

const expandHome = (p) => p.replace(/^~(?=$|[/\\])/, os.homedir());
const mb = (n) => (n < 1e5 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(1)} MB`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, cwd: REPO_DIR, ...opts });
  if (r.error) throw r.error;
  return r;
}

function git(...args) {
  const r = run('git', args);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** `gh api` (GET unless `method`); null for a 404 when `allow404`. */
function api(endpoint, { paginate = false, method, body, allow404 = false } = {}) {
  const r = run(
    'gh',
    ['api', ...(method ? ['--method', method] : []), ...(paginate ? ['--paginate', '--slurp'] : []), ...(body ? ['--input', '-'] : []), endpoint],
    body ? { input: JSON.stringify(body) } : {},
  );
  if (r.status !== 0) {
    if (allow404 && /HTTP 404/.test(r.stderr)) return null;
    throw new Error(`gh api ${endpoint}: ${r.stderr.trim()}`);
  }
  const data = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return paginate ? data.flat() : data;
}

function gh(args) {
  const r = run('gh', args);
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The one release of `repo` for `tag` (drafts included), or null. */
function releaseByTag(repo, tag) {
  const hits = api(`repos/${repo}/releases?per_page=100`, { paginate: true }).filter((r) => r.tag_name === tag);
  if (hits.length > 1) throw new Error(`${repo} has ${hits.length} releases for ${tag}: clean that up by hand first`);
  return hits[0] ?? null;
}

const releaseAssets = (repo, id) => api(`repos/${repo}/releases/${id}/assets?per_page=100`, { paginate: true });

/** The commit a tag of `repo` points at on GitHub (annotated tags peeled), or null. */
function remoteTagCommit(repo, tag) {
  let obj = api(`repos/${repo}/git/ref/tags/${tag}`, { allow404: true })?.object;
  while (obj?.type === 'tag') obj = api(`repos/${repo}/git/tags/${obj.sha}`).object;
  return obj?.type === 'commit' ? obj.sha : null;
}

/** Downloads a release asset by its id (the exact asset that was checked, not whatever a tag resolves to). */
function downloadAsset(repo, asset, file) {
  const tmp = `${file}.part`;
  const fd = fs.openSync(tmp, 'w');
  let r;
  try {
    r = spawnSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], {
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
    });
  } finally {
    fs.closeSync(fd);
  }
  if (r.status !== 0) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`download of ${asset.name}: ${r.stderr?.trim() || r.error}`);
  }
  fs.renameSync(tmp, file);
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const digestHex = (asset) => asset.digest?.replace(/^sha256:/, '') ?? null;

/** The updater config at `ref`: { pubkey, keyId, problems }. */
function updaterConfigAt(ref) {
  const text = git('show', `${ref}:desktop/src-tauri/tauri.conf.json`);
  if (!text) return { problems: [`no desktop/src-tauri/tauri.conf.json at ${ref}`] };
  const updater = JSON.parse(text).plugins?.updater;
  if (!updater) return { problems: [`tauri.conf.json at ${ref} has no plugins.updater (a version without the updater cannot be published this way)`] };
  const problems = [];
  let keyId = null;
  try {
    keyId = parsePublicKey(updater.pubkey).keyId;
  } catch (e) {
    problems.push(`plugins.updater.pubkey at ${ref}: ${e.message}`);
  }
  if (keyId && keyId !== UPDATER_KEY_ID) problems.push(`plugins.updater.pubkey at ${ref} is key ${keyId}, not ${UPDATER_KEY_ID}`);
  if (JSON.stringify(updater.endpoints) !== JSON.stringify([UPDATER_ENDPOINT])) problems.push(`plugins.updater.endpoints at ${ref}: ${JSON.stringify(updater.endpoints)}`);
  if (updater.requireSignedVersion !== true) problems.push(`plugins.updater.requireSignedVersion at ${ref} is not true`);
  return { pubkey: updater.pubkey, keyId, problems };
}

function printTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(`    ${r.map((c, i) => String(c).padEnd(widths[i])).join('  ')}`.trimEnd());
}

/** Everything that is read before anything is written; `problems` lists what makes a real run refuse. */
async function preflight(opt) {
  const problems = [];
  const check = (ok, label, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `: ${detail}` : ''}`);
    if (!ok) problems.push(detail ? `${label}: ${detail}` : label);
    return ok;
  };
  const { tag, version } = opt;
  const ctx = { problems };

  console.log('\n== GitHub login');
  const auth = run('gh', ['auth', 'status']);
  if (!check(auth.status === 0, 'gh auth status', auth.status === 0 ? '' : (auth.stderr || auth.stdout).trim())) return ctx;

  console.log(`\n== ${tag}: source`);
  const commit = git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`);
  if (!check(Boolean(commit), `local tag ${tag}`, commit ?? 'missing (git fetch --tags)')) return ctx;
  ctx.commit = commit;
  console.log(`    ${git('log', '-1', '--format=%h %cI %s', commit)}`);
  const remote = remoteTagCommit(PRIVATE_REPO, tag);
  check(remote === commit, `tag on GitHub (${PRIVATE_REPO}) = local tag`, remote ?? 'missing');
  const ancestor = run('git', ['merge-base', '--is-ancestor', commit, 'origin/main']).status === 0;
  check(ancestor, 'ancestor of origin/main', ancestor ? '' : 'no (git fetch origin, then retry)');
  const cmp = api(`repos/${PRIVATE_REPO}/compare/main...${commit}`, { allow404: true });
  check(['behind', 'identical'].includes(cmp?.status), `ancestor of GitHub's main`, cmp?.status ?? 'unknown commit');
  if (opt.commit) check(commit.startsWith(opt.commit), '--commit is the tag commit', `${opt.commit} vs ${commit.slice(0, 12)}`);
  else console.log(`    (a real run needs --commit ${commit.slice(0, 12)} once the user has reviewed it)`);
  const pkg = git('show', `${tag}:package.json`);
  check(pkg && JSON.parse(pkg).version === version, `package.json at ${tag}`, pkg ? `version ${JSON.parse(pkg).version}` : 'missing');
  const conf = updaterConfigAt(tag);
  if (conf.problems.length) for (const p of conf.problems) check(false, 'updater config', p);
  else check(true, `updater config at ${tag}`, `key ${conf.keyId}, ${UPDATER_ENDPOINT}, requireSignedVersion`);
  ctx.pubkey = conf.pubkey;

  console.log(`\n== ${tag}: CI draft (${PRIVATE_REPO})`);
  const release = releaseByTag(PRIVATE_REPO, tag);
  if (!check(Boolean(release), `release ${tag}`, release ? `${release.draft ? 'draft' : 'published'}, id ${release.id}` : 'missing (did CI finish?)')) return ctx;
  ctx.release = release;
  const assets = releaseAssets(PRIVATE_REPO, release.id);
  ctx.assets = assets;
  const runs = api(`repos/${PRIVATE_REPO}/actions/workflows/desktop.yml/runs?head_sha=${commit}&status=success&per_page=100`).workflow_runs;
  const prov = provenanceProblems({ release, assets, runs, tag, commit });
  for (const p of prov) check(false, 'provenance', p);
  const good = runs.filter((r) => r.conclusion === 'success' && r.head_branch === tag && r.path === CI_WORKFLOW);
  if (prov.length === 0) check(true, 'provenance', `${assets.length} assets uploaded by github-actions[bot] during run ${good.map((r) => r.id).join(', ')} (${good[0]?.html_url})`);
  const rows = [['asset', 'size', 'sha256', 'updater keys']];
  ctx.classified = [];
  for (const a of assets) {
    try {
      const c = classifyAsset(a.name, version);
      ctx.classified.push({ ...c, asset: a });
      rows.push([a.name, mb(a.size), (digestHex(a) ?? '-').slice(0, 12), c.keys.join(', ') || `- (${c.label})`]);
    } catch (e) {
      check(false, 'allowlist', e.message);
      rows.push([a.name, mb(a.size), (digestHex(a) ?? '-').slice(0, 12), 'NOT ALLOWED']);
    }
  }
  printTable(rows);
  const missing = missingAssets(assets.map((a) => a.name), version);
  check(missing.length === 0, 'required assets', missing.length ? `missing: ${missing.join('; ')}` : 'all present');

  const pkgbuild = assets.find((a) => a.name === 'PKGBUILD');
  if (pkgbuild) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-publish-'));
    try {
      const file = path.join(tmp, 'PKGBUILD');
      downloadAsset(PRIVATE_REPO, pkgbuild, file);
      const sum = await fileSha256(file);
      check(sum === digestHex(pkgbuild), 'PKGBUILD downloads by asset id, sha256 = digest', sum.slice(0, 12));
      const debs = Object.fromEntries(['amd64', 'arm64'].map((d) => [d, digestHex(assets.find((a) => a.name === `easy-study_${version}_${d}.deb`) ?? {})]));
      const pp = pkgbuildProblems(fs.readFileSync(file, 'utf8'), { version, debs });
      if (pp.length) for (const p of pp) check(false, 'PKGBUILD', p);
      else check(true, 'PKGBUILD', `public sources, pkgver ${version}, the draft's .deb checksums`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log(`\n== public repo (${PUBLIC_REPO})`);
  const repo = api(`repos/${PUBLIC_REPO}`, { allow404: true });
  if (!check(Boolean(repo), 'exists', repo ? '' : 'missing')) return ctx;
  check(repo.visibility === 'public', 'public', repo.visibility);
  check(repo.permissions?.push === true, 'gh login may push');
  const branches = api(`repos/${PUBLIC_REPO}/branches`) ?? [];
  if (!check(branches.length > 0, 'has a commit (README)', branches.length ? repo.default_branch : 'empty')) {
    console.log(
      `    One-time step, only with the user's consent: add the public README to ${PUBLIC_REPO} (downloads per OS,\n` +
        '    first-open notes for macOS and Windows, the FFmpeg LGPL source note), e.g. with\n' +
        `    "Add a README" on https://github.com/${PUBLIC_REPO}. Then run this again.`,
    );
  }
  const pub = releaseByTag(PUBLIC_REPO, tag);
  ctx.publicRelease = pub;
  console.log(`    release ${tag}: ${pub ? `${pub.draft ? 'draft' : 'PUBLISHED'} (id ${pub.id}, ${pub.assets.length} assets)` : 'none yet'}`);
  const latest = api(`repos/${PUBLIC_REPO}/releases/latest`, { allow404: true });
  console.log(`    latest: ${latest?.tag_name ?? 'none'}`);
  ctx.previousKeyId = null;
  if (latest && latest.tag_name !== tag) {
    const older = compareVersions(version, latest.tag_name) < 0;
    check(!older || opt.notLatest, 'newer than the public latest', older ? `${version} < ${latest.tag_name} (--not-latest to publish an older line)` : `${version} > ${latest.tag_name}`);
    // The key the installed apps trust: the one compiled into the public latest version.
    const prev = updaterConfigAt(latest.tag_name);
    check(prev.keyId === conf.keyId, `same updater key as ${latest.tag_name}`, prev.keyId ?? prev.problems.join('; '));
  }

  console.log('\n== notes');
  if (opt.notes) {
    const text = fs.existsSync(opt.notes) ? fs.readFileSync(opt.notes, 'utf8') : '';
    ctx.notesText = text;
    check(text.trim().length > 0, `--notes ${opt.notes}`, text ? `${text.length} chars` : 'missing or empty');
    // The private draft's generated notes list private commit titles and link the private repo: never copied.
    check(!/github\.com\/Wooangha\/easy-study(?!-releases)\b|Full Changelog/i.test(text), 'no private links or generated changelog');
    ctx.notes = notesSummary(text);
    console.log(`    latest.json notes (${[...ctx.notes].length} chars):\n${ctx.notes.replace(/^/gm, '      ')}`);
  } else {
    console.log('    (none given: a real run needs --notes <file.md>, approved by the user)');
  }

  console.log('\n== signing key');
  if (opt.dryRun) {
    console.log(`    dry run: the key is not touched (a real run passes ${opt.key} to tauri signer sign)`);
  } else {
    const st = fs.statSync(opt.key, { throwIfNoEntry: false });
    if (check(st?.isFile() === true, 'key file', st ? opt.key : `${opt.key} missing`) && (st.mode & 0o077) !== 0) {
      console.log(`    warning: ${opt.key} is readable by others (chmod 600 it)`);
    }
  }
  return ctx;
}

/** Signs `file` for `version` with the Tauri CLI (writes <file>.sig). The key stays a path. */
function signFile(key, file, version) {
  const cli = path.join(DESKTOP_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!fs.existsSync(cli)) throw new Error('no Tauri CLI: npm ci in desktop/');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TAURI_SIGNING_')));
  const r = run(process.execPath, [cli, 'signer', 'sign', '-f', key, '-p', '', '--app-version', version, file], { env });
  if (r.status !== 0) throw new Error(`tauri signer sign ${path.basename(file)}: ${r.stderr.trim()}`);
}

/** The ProductVersion of a Windows program's version resource (the NSIS installer's is the app version). */
function exeProductVersion(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (offset, length) => {
      const buf = Buffer.alloc(length);
      return buf.subarray(0, fs.readSync(fd, buf, 0, length, offset));
    };
    const range = peResourceRange(read(0, 64 * 1024));
    if (!range || range.size > 64 * 1024 * 1024) return null;
    return versionInfoString(read(range.offset, range.size), 'ProductVersion');
  } finally {
    fs.closeSync(fd);
  }
}

/** Checks a signature: the tag's key, this file and version. Returns the .sig text. */
async function checkSignature(pubkey, name, version, sigText, file) {
  let fields;
  try {
    fields = file ? await verify(pubkey, sigText, { file }) : verifyTrusted(pubkey, sigText);
  } catch (e) {
    throw new Error(`${name}: ${e.message}`);
  }
  if (fields.file !== name) throw new Error(`${name}: the signature names file ${fields.file}`);
  if (fields.version !== version) throw new Error(`${name}: the signature names version ${fields.version}`);
  return sigText.trim();
}

/** Waits for GitHub to have computed the digests of a release's assets (it does so after the upload). */
async function settledAssets(repo, id) {
  for (let i = 0; ; i++) {
    const assets = releaseAssets(repo, id);
    if (i >= 10 || assets.every((a) => a.state === 'uploaded' && a.digest)) return assets;
    await sleep(3000);
  }
}

/** The public draft must still be the draft `id` (never touch a published release). */
function assertPublicDraft(tag, id) {
  // By id: the list endpoint lags behind a just-created draft.
  const r = api(`repos/${PUBLIC_REPO}/releases/${id}`, { allow404: true });
  if (!r || r.tag_name !== tag || !r.draft) throw new Error(`the public release ${tag} is no longer the draft ${id}: nothing more is changed; run again`);
}

async function publishDraft(opt, ctx, state, save) {
  const { tag, version, work } = opt;
  const draftNames = ctx.classified.map((c) => c.name);
  const updater = ctx.classified.filter((c) => c.keys.length > 0);

  console.log(`\n== download (${work}/assets)`);
  fs.mkdirSync(path.join(work, 'assets'), { recursive: true });
  state.assets ??= {};
  for (const { asset } of ctx.classified) {
    const file = path.join(work, 'assets', asset.name);
    const want = digestHex(asset);
    const have = fs.existsSync(file) && fs.statSync(file).size === asset.size && (await fileSha256(file)) === want;
    if (!have) {
      console.log(`  ${asset.name} (${mb(asset.size)})`);
      downloadAsset(PRIVATE_REPO, asset, file);
      const got = await fileSha256(file);
      if (got !== want) {
        fs.rmSync(file);
        throw new Error(`${asset.name}: sha256 ${got} is not GitHub's digest ${want}`);
      }
    }
    state.assets[asset.name] = { size: asset.size, sha256: want };
  }
  save();

  console.log('\n== contents');
  for (const c of updater.filter((u) => u.name.endsWith('.app.tar.gz'))) {
    const problems = appArchiveProblems(await readTarGz(path.join(work, 'assets', c.name), ['easy-study.app/Contents/Info.plist']), version);
    if (problems.length) throw new Error(`${c.name}: ${problems.join('; ')}`);
    console.log(`  ✓ ${c.name}: one top folder, no hard links, Info.plist ${version}`);
  }
  for (const c of updater.filter((u) => u.name.endsWith('-setup.exe'))) {
    const found = exeProductVersion(path.join(work, 'assets', c.name));
    if (found !== version) throw new Error(`${c.name}: ProductVersion ${found ?? '(none)'}, expected ${version}`);
    console.log(`  ✓ ${c.name}: ProductVersion ${version}`);
  }
  for (const c of updater.filter((u) => u.name.endsWith('.AppImage'))) {
    console.log(`  - ${c.name}: not looked into (a squashfs image): name, CI run and digest only`);
  }

  console.log(`\n== sign (${opt.key})`);
  const signed = [];
  for (const c of updater) {
    const file = path.join(work, 'assets', c.name);
    const sigFile = `${file}.sig`;
    let sig = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8') : null;
    if (sig) {
      try {
        await checkSignature(ctx.pubkey, c.name, version, sig, file);
        console.log(`  ${c.name}: signed before (kept: a new signature would change latest.json)`);
      } catch {
        sig = null;
      }
    }
    if (!sig) {
      fs.rmSync(sigFile, { force: true });
      signFile(opt.key, file, version);
      sig = fs.readFileSync(sigFile, 'utf8');
      console.log(`  ${c.name}: signed`);
    }
    signed.push({ name: c.name, signature: await checkSignature(ctx.pubkey, c.name, version, sig, file) });
  }
  console.log(`  ✓ ${signed.length} signatures verify with key ${UPDATER_KEY_ID} and name their file and ${version}`);

  const baseUrl = releaseDownloadUrl(tag);
  const latest = latestJson({ version, notes: ctx.notes, pubDate: state.pubDate, baseUrl, artifacts: signed });
  const lp = latestJsonProblems(latest, { version, baseUrl, uploaded: draftNames });
  if (lp.length) throw new Error(`latest.json: ${lp.join('; ')}`);
  fs.writeFileSync(path.join(work, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  fs.writeFileSync(path.join(work, 'SHA256SUMS.txt'), sha256sums(draftNames.map((name) => ({ name, sha256: state.assets[name].sha256 }))));

  console.log(`\n== public draft (${PUBLIC_REPO})`);
  const notesFile = path.resolve(opt.notes);
  let pub = releaseByTag(PUBLIC_REPO, tag);
  if (!pub) {
    // The created release comes back directly (the list endpoint does not show it right away).
    pub = api(`repos/${PUBLIC_REPO}/releases`, {
      method: 'POST',
      body: { tag_name: tag, target_commitish: 'main', name: `easy-study ${tag}`, body: ctx.notesText, draft: true, prerelease: false },
    });
    console.log(`  created draft ${pub.id}`);
  } else if (pub.body !== ctx.notesText) {
    assertPublicDraft(tag, pub.id);
    gh(['release', 'edit', tag, '--repo', PUBLIC_REPO, '--notes-file', notesFile]);
    console.log('  notes updated');
  }
  state.publicReleaseId = pub.id;
  save();
  const expected = publicAssetList(draftNames);
  const generated = (name) => name === 'latest.json' || name === 'SHA256SUMS.txt';
  const fileOf = (name) => path.join(work, generated(name) ? name : path.join('assets', name));
  const sums = new Map(draftNames.map((name) => [name, state.assets[name].sha256])); // checked at the download
  for (const name of expected.filter(generated)) sums.set(name, await fileSha256(fileOf(name)));
  const uploadedAs = (assets, name) => assets.find((a) => a.name === name && a.state === 'uploaded' && a.digest === `sha256:${sums.get(name)}`);
  const extras = releaseAssets(PUBLIC_REPO, pub.id).filter((a) => !expected.includes(a.name));
  if (extras.length) throw new Error(`the public draft has assets this release does not: ${extras.map((a) => a.name).join(', ')} (remove them by hand)`);
  for (const name of expected) {
    if (name === 'latest.json') {
      // Last: everything it points at must be up, with the right bytes.
      const up = await settledAssets(PUBLIC_REPO, pub.id);
      const bad = expected.slice(0, -1).filter((n) => !uploadedAs(up, n));
      if (bad.length) throw new Error(`not uploaded completely: ${bad.join(', ')}`);
    }
    const current = releaseAssets(PUBLIC_REPO, pub.id).find((a) => a.name === name);
    if (current && uploadedAs([current], name)) {
      console.log(`  ${name}: up already`);
      continue;
    }
    assertPublicDraft(tag, pub.id);
    if (current) api(`repos/${PUBLIC_REPO}/releases/assets/${current.id}`, { method: 'DELETE' }); // a draft's stale or partial upload
    console.log(`  ${name}: uploading`);
    gh(['release', 'upload', tag, fileOf(name), '--repo', PUBLIC_REPO]);
  }
  const final = await settledAssets(PUBLIC_REPO, pub.id);
  const bad = expected.filter((n) => !uploadedAs(final, n));
  if (bad.length || final.length !== expected.length) {
    throw new Error(`the public draft does not hold exactly this release's files (${bad.join(', ') || `${final.length} assets`})`);
  }
  console.log(`  ✓ ${final.length} assets, digests match`);

  console.log('\n== publish');
  assertPublicDraft(tag, pub.id);
  const latestNow = api(`repos/${PUBLIC_REPO}/releases/latest`, { allow404: true });
  if (latestNow && !opt.notLatest && compareVersions(version, latestNow.tag_name) < 0) throw new Error(`${latestNow.tag_name} is newer: --not-latest`);
  gh(['release', 'edit', tag, '--repo', PUBLIC_REPO, '--draft=false', opt.notLatest ? '--latest=false' : '--latest']);
  console.log(`  ✓ published https://github.com/${PUBLIC_REPO}/releases/tag/${tag}`);
  return fs.readFileSync(path.join(work, 'latest.json'), 'utf8');
}

/** A re-run after the public release was published: check it, change nothing. */
async function checkPublished(opt, ctx) {
  const { tag, version, work } = opt;
  console.log(`\n== public release ${tag} is published: checking it (nothing is changed)`);
  const draftNames = ctx.classified.map((c) => c.name);
  const expected = publicAssetList(draftNames);
  const assets = releaseAssets(PUBLIC_REPO, ctx.publicRelease.id);
  const byName = new Map(assets.map((a) => [a.name, a]));
  const newPatch = 'a published release is never changed: cut a new patch version';
  const extras = assets.filter((a) => !expected.includes(a.name)).map((a) => a.name);
  if (extras.length) throw new Error(`unexpected public assets ${extras.join(', ')} (${newPatch})`);
  for (const { asset } of ctx.classified) {
    if (byName.get(asset.name)?.digest !== asset.digest) throw new Error(`${asset.name}: the public copy differs from the draft or is missing (${newPatch})`);
  }
  const sums = sha256sums(ctx.classified.map((c) => ({ name: c.name, sha256: digestHex(c.asset) })));
  if (byName.get('SHA256SUMS.txt')?.digest !== `sha256:${crypto.createHash('sha256').update(sums).digest('hex')}`) throw new Error(`SHA256SUMS.txt differs (${newPatch})`);
  const latestAsset = byName.get('latest.json');
  if (!latestAsset) throw new Error(`no latest.json in the published release (${newPatch})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-publish-'));
  let text;
  try {
    downloadAsset(PUBLIC_REPO, latestAsset, path.join(tmp, 'latest.json'));
    text = fs.readFileSync(path.join(tmp, 'latest.json'), 'utf8');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const json = JSON.parse(text);
  const lp = latestJsonProblems(json, { version, baseUrl: releaseDownloadUrl(tag), uploaded: draftNames });
  if (lp.length) throw new Error(`published latest.json: ${lp.join('; ')} (${newPatch})`);
  for (const c of ctx.classified.filter((x) => x.keys.length)) {
    const file = path.join(work, 'assets', c.name);
    const local = fs.existsSync(file) && (await fileSha256(file)) === digestHex(c.asset) ? file : null;
    for (const key of c.keys) await checkSignature(ctx.pubkey, c.name, version, json.platforms[key].signature, local);
  }
  console.log(`  ✓ ${assets.length} assets as in the draft; latest.json's signatures verify with key ${UPDATER_KEY_ID}`);
  return text;
}

/** Checks what the apps see: latest.json and every asset URL, without auth (CDN propagation: a few tries). */
async function verifyPublic(opt, ctx, latestText) {
  const { tag, version } = opt;
  const url = opt.notLatest ? `${releaseDownloadUrl(tag)}/latest.json` : UPDATER_ENDPOINT;
  console.log(`\n== public check (no auth): ${url}`);
  const names = publicAssetList(ctx.classified.map((c) => c.name));
  let last = '';
  for (let i = 0; i < 8; i++) {
    if (i > 0) await sleep(5000);
    const res = await fetch(url, { redirect: 'follow' }).catch((e) => ({ ok: false, status: e.message }));
    if (!res.ok) {
      last = `HTTP ${res.status}`;
      continue;
    }
    const body = await res.text();
    if (body !== latestText) {
      last = 'a different latest.json (not propagated yet?)';
      continue;
    }
    const bad = [];
    for (const name of names) {
      const r = await fetch(`${releaseDownloadUrl(tag)}/${name}`, { method: 'HEAD', redirect: 'follow' }).catch((e) => ({ ok: false, status: e.message }));
      if (!r.ok) bad.push(`${name} ${r.status}`);
    }
    if (bad.length === 0) {
      console.log(`  ✓ latest.json is ${version}'s; all ${names.length} assets download`);
      return;
    }
    last = bad.join(', ');
  }
  throw new Error(`public check failed: ${last} (run again later: the rest is idempotent)`);
}

async function main() {
  let opt;
  try {
    opt = parseOptions(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node desktop/scripts/publish-release.mjs --tag vX.Y.Z [--dry-run]\n` +
      '       node desktop/scripts/publish-release.mjs --tag vX.Y.Z --publish --commit <sha> --notes <file.md>\n' +
      `            [--key ${DEFAULT_KEY}] [--work <dir>] [--skip-private] [--not-latest]`);
    process.exit(2);
  }
  console.log(opt.dryRun ? `DRY RUN ${opt.tag}: reads only; no key, no GitHub writes (--publish for real)` : `PUBLISH ${opt.tag}`);
  const ctx = await preflight(opt);

  if (opt.dryRun) {
    const updater = (ctx.classified ?? []).filter((c) => c.keys.length > 0);
    if (ctx.release) {
      const latest = latestJson({
        version: opt.version,
        notes: ctx.notes ?? '<the first paragraph of --notes>',
        pubDate: ctx.release.created_at,
        baseUrl: releaseDownloadUrl(opt.tag),
        artifacts: updater.map((c) => ({ name: c.name, signature: '<dry-run>' })),
      });
      console.log(`\n== planned latest.json (${Object.keys(latest.platforms).length} platform keys)\n${JSON.stringify(latest, null, 2).replace(/^/gm, '    ')}`);
      const pub = ctx.publicRelease;
      const n = (ctx.classified ?? []).length;
      const total = (ctx.classified ?? []).reduce((s, c) => s + c.asset.size, 0);
      console.log('\n== a real run (--publish) would');
      const steps = pub && !pub.draft
        ? ['check the published release against the draft (digests, SHA256SUMS.txt, latest.json signatures) and change nothing']
        : [
            `download ${n} assets (${mb(total)}) by asset id to ${opt.work}/assets and compare each sha256 with GitHub's digest`,
            'check both macOS archives (one top folder, no hard links, Info.plist version) and the Windows installer (ProductVersion)',
            `sign ${updater.length} updater artifacts with ${opt.key} (tauri signer sign --app-version ${opt.version}) and verify them with key ${UPDATER_KEY_ID}`,
            'write latest.json and SHA256SUMS.txt',
            `${pub ? `reuse the public draft ${pub.id}` : `create a public draft ${opt.tag} (target main)`} and upload ${n + 2} assets, latest.json last`,
            `publish it (${opt.notLatest ? 'not latest' : 'latest'})`,
          ];
      steps.push('fetch latest.json and HEAD every asset URL without auth');
      steps.push(opt.skipPrivate ? 'leave the private draft as it is (--skip-private)' : `publish the private draft ${opt.tag}`);
      steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
    if (ctx.problems.length) {
      console.log(`\n✗ ${ctx.problems.length} problem(s): a real run would refuse.`);
      for (const p of ctx.problems) console.log(`  - ${p}`);
      process.exit(1);
    }
    console.log('\n✓ dry run clean. Publish only on the user\'s word, with their approved notes and the commit above.');
    return;
  }

  if (ctx.problems.length) throw new Error(`refusing: ${ctx.problems.length} problem(s):\n  - ${ctx.problems.join('\n  - ')}`);
  fs.mkdirSync(opt.work, { recursive: true });
  const stateFile = path.join(opt.work, 'state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  if (state.releaseId && (state.releaseId !== ctx.release.id || state.commit !== ctx.commit)) {
    throw new Error(`${stateFile} belongs to another draft (${state.releaseId}, ${state.commit}): delete ${opt.work} first`);
  }
  // pub_date: the draft's created_at (GitHub: the tag commit's date), frozen so a re-run writes the same latest.json.
  Object.assign(state, { tag: opt.tag, commit: ctx.commit, releaseId: ctx.release.id, pubDate: state.pubDate ?? ctx.release.created_at });
  const save = () => fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  save();

  const latestText = ctx.publicRelease && !ctx.publicRelease.draft ? await checkPublished(opt, ctx) : await publishDraft(opt, ctx, state, save);
  await verifyPublic(opt, ctx, latestText);

  if (opt.skipPrivate) {
    console.log('\n== private draft left as it is (--skip-private)');
  } else {
    const rel = releaseByTag(PRIVATE_REPO, opt.tag);
    if (rel.draft) gh(['release', 'edit', opt.tag, '--repo', PRIVATE_REPO, '--draft=false', opt.notLatest ? '--latest=false' : '--latest']);
    console.log(`\n== private release ${opt.tag}: ${rel.draft ? 'published' : 'was published already'}`);
  }
  console.log(`\n✓ ${opt.tag} is out: https://github.com/${PUBLIC_REPO}/releases/tag/${opt.tag}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  });
}
