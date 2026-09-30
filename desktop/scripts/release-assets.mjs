// Release assets of the desktop app and the Linux server CLI (DESIGN §24, §26): which files of CI's draft release
// (private repo) may go public, which updater platform key each one serves, the latest.json the in-app updater (and
// `easy-study update`) reads, and the checks the publish script runs on a draft before it signs anything (who
// uploaded it, from which run, what is inside). Pure helpers (plus readTarGz) for publish-release.mjs,
// update-e2e.mjs and server-tarball.mjs; tested in desktop.test.mjs.
import fs from 'node:fs';
import zlib from 'node:zlib';

/** CI builds and drafts here (private). */
export const PRIVATE_REPO = 'Wooangha/easy-study';
/** Installers and updates are published here (public, no source). */
export const PUBLIC_REPO = 'Wooangha/easy-study-releases';
/** The one endpoint compiled into the app (tauri.conf.json plugins.updater.endpoints). */
export const UPDATER_ENDPOINT = `https://github.com/${PUBLIC_REPO}/releases/latest/download/latest.json`;
/** Where a version's assets are downloaded from. */
export const releaseDownloadUrl = (tag) => `https://github.com/${PUBLIC_REPO}/releases/download/${tag}`;
/** The key id of the updater's public key (~/.tauri/easy-study-updater.key.pub, backed up offline). */
export const UPDATER_KEY_ID = '8428B81A03E58D53';
/** Who uploads a genuine draft: the desktop workflow's GITHUB_TOKEN. */
export const CI_UPLOADER = 'github-actions[bot]';
export const CI_WORKFLOW = '.github/workflows/desktop.yml';

/** The one top folder of the Linux server tarball, the same for every version and arch (an in-place update keeps it). */
export const SERVER_TOP_DIR = 'easy-study-server';

/** The Linux server tarball of `version` for `cpu` (process.arch, targets.mjs `cpu`: x64 or arm64). */
export function serverTarballName(version, cpu) {
  if (cpu !== 'x64' && cpu !== 'arm64') throw new Error(`no Linux server build for cpu "${cpu}" (x64 or arm64)`);
  return `${SERVER_TOP_DIR}-${version}-linux-${cpu}.tar.gz`;
}

/** The first release with the Linux server tarballs: 0.6.5 and earlier were published without them. */
export const SERVER_SINCE = '0.6.6';

/**
 * The updater artifacts: the file name of a version → the platform keys it serves in latest.json, and `since`: the
 * first version that has it (none: every version; see updaterArtifacts).
 * The app's keys are tauri-plugin-updater's (`{os}-{arch}[-{installer}]`). Never a bare "linux-x86_64" /
 * "linux-aarch64": the plugin falls back to it for deb/rpm installs, which would then try to install an AppImage.
 * deb, rpm and Arch installs are check-only through the appimage key (update.rs).
 * The server tarballs' `linux-<arch>-server` keys are read by `easy-study update` (server/selfUpdate.ts) only: the
 * plugin looks up `{os}-{arch}-{installer}` and then `{os}-{arch}`, and the app always asks for
 * `linux-<arch>-appimage`, so it never selects them (and parses the extra keys fine).
 */
export const UPDATER_ARTIFACTS = [
  { name: (v) => `easy-study_${v}_aarch64.app.tar.gz`, keys: ['darwin-aarch64'] },
  { name: (v) => `easy-study_${v}_x64.app.tar.gz`, keys: ['darwin-x86_64'] },
  // The NSIS installer itself (the plugin runs non-zip bytes as the installer).
  { name: (v) => `easy-study_${v}_x64-setup.exe`, keys: ['windows-x86_64-nsis', 'windows-x86_64'] },
  { name: (v) => `easy-study_${v}_amd64.AppImage`, keys: ['linux-x86_64-appimage'] },
  { name: (v) => `easy-study_${v}_aarch64.AppImage`, keys: ['linux-aarch64-appimage'] },
  // The Linux server CLI (server-tarball.mjs), updated in place by `easy-study update`.
  { name: (v) => serverTarballName(v, 'x64'), keys: ['linux-x86_64-server'], since: SERVER_SINCE },
  { name: (v) => serverTarballName(v, 'arm64'), keys: ['linux-aarch64-server'], since: SERVER_SINCE },
];

/**
 * The updater artifacts of a release of `version` (x.y.z[-pre]): those without `since`, and those whose `since` is at
 * most the version's x.y.z (a prerelease such as 0.6.6-e2e.1 is built by the same workflow as 0.6.6). The publish
 * script run again for an older tag (a retry of 0.6.5) then asks only for what that tag's CI built.
 */
export function updaterArtifacts(version) {
  const core = String(version).replace(/^v/, '').replace(/-.*$/, '');
  return UPDATER_ARTIFACTS.filter((a) => !a.since || compareVersions(core, a.since) >= 0);
}

/** The platform keys a complete latest.json of `version` has. */
export function updaterKeys(version) {
  return updaterArtifacts(version).flatMap((a) => a.keys);
}

/** Files the publish script makes itself (never taken from a draft). latest.json goes up last. */
export const GENERATED_ASSETS = ['SHA256SUMS.txt', 'latest.json'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The assets of a version's draft: [label, pattern, required]. Every draft asset must match one: anything else
 * makes the publish fail, so nothing unexpected is ever made public.
 */
function allowlist(version) {
  const v = escape(version);
  return [
    ...updaterArtifacts(version).map((a) => [`updater ${a.keys[0]}`, new RegExp(`^${escape(a.name(version))}$`), true]),
    ['macOS dmg (Apple silicon)', new RegExp(`^easy-study_${v}_aarch64\\.dmg$`), true],
    ['macOS dmg (Intel)', new RegExp(`^easy-study_${v}_x64\\.dmg$`), true],
    ['deb (x86_64)', new RegExp(`^easy-study_${v}_amd64\\.deb$`), true],
    ['deb (arm64)', new RegExp(`^easy-study_${v}_arm64\\.deb$`), true],
    ['rpm (x86_64)', new RegExp(`^easy-study-${v}-\\d+\\.x86_64\\.rpm$`), true],
    ['rpm (aarch64)', new RegExp(`^easy-study-${v}-\\d+\\.aarch64\\.rpm$`), true],
    ['Arch package', new RegExp(`^easy-study-bin-${v}-\\d+-x86_64\\.pkg\\.tar\\.zst$`), true],
    ['PKGBUILD', /^PKGBUILD$/, true],
    // LGPL: the complete corresponding source of the FFmpeg the binaries ship, named after FFmpeg's version.
    ['FFmpeg source (LGPL)', /^easy-study-ffmpeg-[0-9.]+-source\.tar$/, true],
    ['libvips source (LGPL)', /^easy-study-libvips-[0-9.]+-source\.tar\.gz$/, false],
  ];
}

/**
 * What a draft asset is: { name, label, keys } (keys: the updater platform keys it serves, [] for the rest).
 * Throws for a name that is not in the allowlist of `version` (another version's file, a .sig, a latest.json…).
 */
export function classifyAsset(name, version) {
  const hit = allowlist(version).find(([, re]) => re.test(name));
  if (!hit) throw new Error(`unexpected asset "${name}" in the draft of ${version} (not in release-assets.mjs's allowlist)`);
  const updater = updaterArtifacts(version).find((a) => name === a.name(version));
  return { name, label: hit[0], keys: updater ? [...updater.keys] : [] };
}

/** The allowlisted assets `names` lacks: [label]. */
export function missingAssets(names, version) {
  return allowlist(version)
    .filter(([, re, required]) => required && !names.some((n) => re.test(n)))
    .map(([label]) => label);
}

/** The assets of the public release in upload order: the draft's files, then SHA256SUMS.txt, latest.json last. */
export function publicAssetList(names) {
  return [...[...names].sort(), ...GENERATED_ASSETS];
}

/** SHA256SUMS.txt of [{ name, sha256 }] (sha256sum -c format, sorted by name). */
export function sha256sums(files) {
  return [...files].sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => `${f.sha256}  ${f.name}\n`).join('');
}

/**
 * latest.json for tauri-plugin-updater ("static" format): { version, notes, pub_date, platforms: { key: { url,
 * signature } } }. `artifacts`: [{ name, signature }] (signature: the .sig file's text), each an updater artifact
 * of `version`; url = `${baseUrl}/${name}`.
 */
export function latestJson({ version, notes, pubDate, baseUrl, artifacts }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`version "${version}": x.y.z without "v"`);
  if (Number.isNaN(Date.parse(pubDate)) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(pubDate)) throw new Error(`pub_date "${pubDate}": RFC 3339 in UTC`);
  const platforms = {};
  const ofVersion = updaterArtifacts(version);
  for (const { name: nameOf, keys } of ofVersion) {
    const name = nameOf(version);
    const a = artifacts.find((x) => x.name === name);
    if (!a) continue;
    const signature = String(a.signature).trim();
    if (!signature || /\s/.test(signature)) throw new Error(`${name}: signature must be the .sig file's one-line text`);
    for (const key of keys) platforms[key] = { url: `${baseUrl}/${name}`, signature };
  }
  for (const a of artifacts) {
    if (!ofVersion.some(({ name }) => a.name === name(version))) throw new Error(`${a.name} is not an updater artifact of ${version}`);
  }
  return { version, notes: String(notes ?? ''), pub_date: pubDate, platforms };
}

/** Every updater platform key (a version from SERVER_SINCE on has them all; updaterKeys(version) for one version). */
export const UPDATER_KEYS = UPDATER_ARTIFACTS.flatMap((a) => a.keys);

/**
 * Problems of a latest.json about to be published (or read back): the version, exactly the platform keys of
 * updaterKeys(version), every url https and naming an updater asset of this version under `baseUrl` that is in
 * `uploaded` (names of the release's assets).
 */
export function latestJsonProblems(json, { version, baseUrl, uploaded }) {
  const problems = [];
  if (json?.version !== version) problems.push(`version ${JSON.stringify(json?.version)}, expected ${version}`);
  if (typeof json?.notes !== 'string') problems.push('notes is not a string');
  if (Number.isNaN(Date.parse(json?.pub_date))) problems.push(`pub_date ${JSON.stringify(json?.pub_date)}`);
  const expected = updaterKeys(version);
  const keys = Object.keys(json?.platforms ?? {});
  const extra = keys.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !keys.includes(k));
  if (extra.length) problems.push(`unexpected platform keys ${extra.join(', ')}`);
  if (missing.length) problems.push(`missing platform keys ${missing.join(', ')}`);
  for (const { name: nameOf, keys: group } of updaterArtifacts(version)) {
    const name = nameOf(version);
    for (const key of group) {
      const p = json?.platforms?.[key];
      if (!p) continue;
      if (p.url !== `${baseUrl}/${name}`) problems.push(`${key}: url ${p.url}, expected ${baseUrl}/${name}`);
      if (!/^https:\/\//.test(p.url ?? '')) problems.push(`${key}: not https`);
      if (!uploaded.includes(name)) problems.push(`${key}: ${name} is not among the release's assets`);
      if (typeof p.signature !== 'string' || !p.signature) problems.push(`${key}: no signature`);
    }
  }
  return problems;
}

/**
 * The plain-text notes latest.json carries (the app shows them as text, never as Markdown): the first paragraph
 * of the release notes file that is not a heading, with Markdown emphasis, code marks and link targets dropped,
 * at most `max` characters.
 */
export function notesSummary(markdown, max = 1000) {
  const paragraphs = markdown.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split(/\n[ \t]*\n/);
  for (const p of paragraphs) {
    const lines = p.split('\n').map((l) => l.trim()).filter((l) => l && !/^#{1,6}(\s|$)/.test(l));
    if (lines.length === 0) continue;
    const text = lines.map((l) => l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '')).join('\n');
    const chars = [...text];
    return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
  }
  return '';
}

/** Compares two x.y.z[-pre] versions (semver precedence): <0, 0, >0. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
    if (!m) throw new Error(`not a version: ${v}`);
    return { nums: m.slice(1, 4).map(Number), pre: m[4]?.split('.') ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) + (y.pre ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const within = (t, from, to) => Date.parse(t) >= Date.parse(from) && Date.parse(t) <= Date.parse(to);

/**
 * Where a draft came from (DESIGN §24, the publish script's supply-chain checks). `release` and `assets` are the
 * REST API's objects (repos/…/releases, …/releases/<id>/assets); `runs` the desktop workflow's runs for the tag's
 * commit. Problems when: the draft or an asset was not uploaded by CI's GITHUB_TOKEN, an asset is incomplete or has
 * no digest, or no successful desktop run of that commit and tag covers every asset's upload time.
 */
export function provenanceProblems({ release, assets, runs, tag, commit }) {
  const problems = [];
  if (release.tag_name !== tag) problems.push(`the release is for ${release.tag_name}, not ${tag}`);
  if (release.author?.login !== CI_UPLOADER) problems.push(`the release was created by ${release.author?.login}, not ${CI_UPLOADER}`);
  for (const a of assets) {
    if (a.uploader?.login !== CI_UPLOADER) problems.push(`${a.name}: uploaded by ${a.uploader?.login}, not ${CI_UPLOADER}`);
    if (a.state !== 'uploaded') problems.push(`${a.name}: state ${a.state}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(a.digest ?? '')) problems.push(`${a.name}: no sha256 digest from GitHub`);
  }
  const good = runs.filter(
    (r) => r.conclusion === 'success' && r.head_sha === commit && r.head_branch === tag && r.path === CI_WORKFLOW,
  );
  if (good.length === 0) {
    problems.push(`no successful ${CI_WORKFLOW} run for ${tag} at ${commit.slice(0, 12)}`);
  } else {
    for (const a of assets) {
      if (!good.some((r) => within(a.created_at, r.created_at, r.updated_at))) problems.push(`${a.name}: uploaded at ${a.created_at}, outside the desktop run(s) of ${tag}`);
    }
  }
  return problems;
}

/** A string value of an XML property list (Tauri writes Info.plist as XML). */
export function plistString(xml, key) {
  return new RegExp(`<key>${escape(key)}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1] ?? null;
}

/**
 * Problems of a macOS updater archive, from readTarGz(): the plugin unpacks it by dropping the first path segment
 * of every entry (one top folder), and tar-rs resolves hard-link targets against the process's working folder (a
 * hard link breaks every install). No AppleDouble "._" files; Info.plist names `version`.
 */
export function appArchiveProblems({ entries, files }, version) {
  const problems = [];
  if (entries.length === 0) problems.push('empty archive');
  for (const e of entries) {
    const name = e.name.replace(/\/$/, '');
    const parts = name.split('/');
    if (parts[0] !== 'easy-study.app') problems.push(`${e.name}: not under easy-study.app/`);
    if (parts.some((p) => p.startsWith('._'))) problems.push(`${e.name}: AppleDouble file`);
    if (parts.includes('..') || name.startsWith('/')) problems.push(`${e.name}: path leaves the folder`);
    if (e.type === 'hardlink') problems.push(`${e.name}: hard link`);
  }
  if (!entries.some((e) => e.name === 'easy-study.app/Contents/MacOS/easy-study' && e.type === 'file')) problems.push('no easy-study.app/Contents/MacOS/easy-study');
  const plist = files['easy-study.app/Contents/Info.plist']?.toString('utf8');
  if (!plist) problems.push('no easy-study.app/Contents/Info.plist');
  else if (plistString(plist, 'CFBundleShortVersionString') !== version) problems.push(`Info.plist CFBundleShortVersionString ${plistString(plist, 'CFBundleShortVersionString')}, expected ${version}`);
  return problems;
}

/**
 * Problems of a Linux server tarball (server-tarball.mjs), from readTarGz() with SERVER_TOP_DIR/VERSION and
 * SERVER_TOP_DIR/package.json: `easy-study update` (server/selfUpdate.ts) swaps the one top folder in for the
 * install, so everything lies under easy-study-server/, as plain files and folders (no symbolic or hard link, which
 * could point out of the install), with the version in VERSION and package.json and the programs executable.
 * `arch`: x64 or arm64 (x64 also has whisper-cli's Vulkan build).
 */
export function serverArchiveProblems({ entries, files }, version, arch) {
  const problems = [];
  const top = SERVER_TOP_DIR;
  if (arch !== 'x64' && arch !== 'arm64') problems.push(`arch ${arch}: expected x64 or arm64`);
  if (entries.length === 0) problems.push('empty archive');
  for (const e of entries) {
    const name = e.name.replace(/\/$/, '');
    if (name !== top && !name.startsWith(`${top}/`)) problems.push(`${e.name}: not under ${top}/`);
    if (e.name.startsWith('/') || name.split('/').some((p) => p === '..' || p === '.' || p === '')) problems.push(`${e.name}: path leaves the folder`);
    if (e.type === 'symlink') problems.push(`${e.name}: symbolic link (to ${e.link})`);
    else if (e.type === 'hardlink') problems.push(`${e.name}: hard link (to ${e.link})`);
    else if (e.type !== 'file' && e.type !== 'dir') problems.push(`${e.name}: neither a file nor a folder`);
    else if (name === top && e.type !== 'dir') problems.push(`${e.name}: not a folder`);
  }
  const file = (rel) => entries.find((e) => e.name === `${top}/${rel}` && e.type === 'file');
  const programs = ['bin/easy-study', 'node/bin/node', 'whisper/whisper-cli', ...(arch === 'x64' ? ['whisper/whisper-cli-vulkan'] : []), 'ffmpeg/ffmpeg'];
  for (const rel of programs) {
    const e = file(rel);
    if (!e) problems.push(`no ${top}/${rel}`);
    else if (!(e.mode & 0o100)) problems.push(`${top}/${rel} is not executable (mode ${e.mode.toString(8)})`);
  }
  const plain = ['VERSION', 'package.json', 'dist-server/server/cli.js', 'dist-server/server/index.js', 'web/dist/index.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'node/LICENSE', 'whisper/LICENSE'];
  for (const rel of plain) if (!file(rel)) problems.push(`no ${top}/${rel}`);
  const versionFile = files[`${top}/VERSION`]?.toString('utf8');
  if (versionFile !== undefined && versionFile !== `${version}\n`) problems.push(`VERSION ${JSON.stringify(versionFile)}, expected ${JSON.stringify(`${version}\n`)}`);
  const pkg = files[`${top}/package.json`];
  if (pkg !== undefined) {
    let found;
    try {
      found = JSON.parse(pkg.toString('utf8')).version;
    } catch {
      found = '(not JSON)';
    }
    if (found !== version) problems.push(`package.json version ${found}, expected ${version}`);
  }
  if (file('VERSION') && versionFile === undefined) problems.push(`${top}/VERSION was not read`);
  if (file('package.json') && pkg === undefined) problems.push(`${top}/package.json was not read`);
  return problems;
}

/**
 * Where the resources of a Windows program (PE) are in the file: the .rsrc section of the section table. `head`: the
 * first bytes of the file (the headers; 64 KiB is plenty). null for anything but a PE file with resources.
 */
export function peResourceRange(head) {
  if (head.length < 64 || head.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = head.readUInt32LE(0x3c);
  if (pe + 24 > head.length || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
  const sections = head.readUInt16LE(pe + 6);
  const table = pe + 24 + head.readUInt16LE(pe + 20);
  for (let i = 0; i < sections && table + (i + 1) * 40 <= head.length; i++) {
    const at = table + i * 40;
    if (head.toString('latin1', at, at + 8).replace(/\0+$/, '') === '.rsrc') {
      return { offset: head.readUInt32LE(at + 20), size: head.readUInt32LE(at + 16) };
    }
  }
  return null;
}

/**
 * A value of a program's version resource (VS_VERSIONINFO, UTF-16LE: the key, NUL, NUL padding, the value, NUL).
 * Tauri's NSIS installer sets "ProductVersion" to the app's version (installer.nsi VIAddVersionKey). null if absent.
 */
export function versionInfoString(rsrc, key) {
  const needle = Buffer.from(`${key}\0`, 'utf16le');
  let at = rsrc.indexOf(needle);
  while (at !== -1 && at % 2 !== 0) at = rsrc.indexOf(needle, at + 1);
  if (at === -1) return null;
  let start = at + needle.length;
  while (start + 1 < rsrc.length && rsrc.readUInt16LE(start) === 0) start += 2;
  let end = start;
  while (end + 1 < rsrc.length && rsrc.readUInt16LE(end) !== 0) end += 2;
  return end > start ? rsrc.toString('utf16le', start, end) : null;
}

/**
 * Problems of the release's PKGBUILD: it downloads the .deb files from the PUBLIC repo, for this version, with the
 * checksums of the draft's own .deb files (`debs`: { amd64, arm64 } sha256).
 */
export function pkgbuildProblems(text, { version, debs }) {
  const problems = [];
  const value = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim();
  const url = value('url')?.replace(/^'(.*)'$/, '$1');
  if (url !== `https://github.com/${PUBLIC_REPO}`) problems.push(`url=${url}: the sources must come from https://github.com/${PUBLIC_REPO}`);
  if (value('pkgver') !== version) problems.push(`pkgver=${value('pkgver')}, expected ${version}`);
  for (const [arch, deb] of [['x86_64', 'amd64'], ['aarch64', 'arm64']]) {
    const sum = /^\('([0-9a-f]{64})'\)$/.exec(value(`sha256sums_${arch}`) ?? '')?.[1];
    if (sum !== debs[deb]) problems.push(`sha256sums_${arch} ${sum ?? '(none)'} is not the draft's ${deb}.deb (${debs[deb] ?? 'missing'})`);
  }
  return problems;
}

/** Tar header field as text (NUL-terminated). */
const field = (h, at, len) => h.toString('utf8', at, at + len).replace(/\0.*$/s, '');

function octal(h, at, len) {
  if (h[at] & 0x80) {
    let n = 0;
    for (let i = at + 1; i < at + len; i++) n = n * 256 + h[i];
    return n;
  }
  const s = field(h, at, len).trim();
  return s ? parseInt(s, 8) : 0;
}

const TAR_TYPES = { 0: 'file', '': 'file', 7: 'file', 1: 'hardlink', 2: 'symlink', 5: 'dir' };

/**
 * Reads a .tar.gz (ustar, pax and GNU long names) in one streamed pass: every entry's { name, type, size, link, mode },
 * and the contents of the entries named in `want` as files[name]. Type: file, dir, symlink, hardlink or other.
 */
export async function readTarGz(file, want = []) {
  const entries = [];
  const files = {};
  let pending = Buffer.alloc(0);
  let entry = null; // the entry whose data is being read: { left, pad, chunks|null, header, done() }
  let next = {}; // pax / GNU long-name overrides for the next header
  let ended = false;
  for await (const chunk of fs.createReadStream(file).pipe(zlib.createGunzip())) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    while (!ended) {
      if (entry) {
        const n = Math.min(entry.left, pending.length - at);
        if (entry.chunks) entry.chunks.push(pending.subarray(at, at + n));
        at += n;
        entry.left -= n;
        if (entry.left > 0) break;
        const skip = Math.min(entry.pad, pending.length - at);
        at += skip;
        entry.pad -= skip;
        if (entry.pad > 0) break;
        entry.done(entry.chunks ? Buffer.concat(entry.chunks) : null);
        entry = null;
        continue;
      }
      if (pending.length - at < 512) break;
      const h = pending.subarray(at, at + 512);
      at += 512;
      if (h.every((b) => b === 0)) {
        ended = true;
        break;
      }
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      if (sum !== octal(h, 148, 8)) throw new Error(`${file}: broken tar header`);
      const flag = String.fromCharCode(h[156]).replace('\0', '');
      const size = octal(h, 124, 12);
      const prefix = field(h, 257, 6) === 'ustar' ? field(h, 345, 155) : '';
      const header = {
        name: next.path ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100)),
        type: TAR_TYPES[flag] ?? 'other',
        size: next.size ?? size,
        link: next.linkpath ?? field(h, 157, 100),
        mode: octal(h, 100, 8),
      };
      const data = header.size;
      let done;
      if (flag === 'x' || flag === 'L' || flag === 'K') {
        done = (buf) => {
          if (flag === 'L') next.path = buf.toString('utf8').replace(/\0.*$/s, '');
          else if (flag === 'K') next.linkpath = buf.toString('utf8').replace(/\0.*$/s, '');
          else next = { ...next, ...paxRecords(buf) };
        };
      } else if (flag === 'g') {
        done = () => {};
      } else {
        next = {};
        entries.push(header);
        done = want.includes(header.name) ? (buf) => (files[header.name] = buf) : () => {};
      }
      const keep = flag === 'x' || flag === 'L' || flag === 'K' || want.includes(header.name);
      const hasData = header.type === 'file' || header.type === 'other' || 'xLKg'.includes(flag);
      const len = hasData ? data : 0;
      entry = { left: len, pad: (512 - (len % 512)) % 512, chunks: keep ? [] : null, done };
    }
    pending = pending.subarray(at);
  }
  if (!ended && (entry || pending.length)) throw new Error(`${file}: truncated tar`);
  return { entries, files };
}

/** pax extended header records ("<len> key=value\n") → { path, linkpath, size }. */
function paxRecords(buf) {
  const out = {};
  let at = 0;
  while (at < buf.length) {
    const space = buf.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number(buf.toString('latin1', at, space));
    if (!len) break;
    const record = buf.toString('utf8', space + 1, at + len - 1);
    const eq = record.indexOf('=');
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (key === 'path' || key === 'linkpath') out[key] = value;
    if (key === 'size') out.size = Number(value);
    at += len;
  }
  return out;
}
