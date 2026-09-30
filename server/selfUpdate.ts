// `easy-study update` of the Linux server build (DESIGN §26): reads the desktop app's latest.json, downloads this
// computer's server tarball, verifies its minisign signature with the key the app's updater trusts, and swaps the
// install folder for the new one (two renames in the install's parent folder). The library and the models live
// outside the install (server/cli.ts dataDir) and are never read or written here.
// It refuses while this install's server runs or the install folder holds anything the tarball does not, flushes the
// new tree to disk before the swap, and on Ctrl+C / SIGTERM / SIGHUP cleans up and stops (exit 130), holding those
// signals during the two renames.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { verify } from './minisign.ts';

/** The one update endpoint (tauri.conf.json plugins.updater.endpoints[0], release-assets.mjs UPDATER_ENDPOINT). */
export const UPDATER_ENDPOINT = 'https://github.com/Wooangha/easy-study-releases/releases/latest/download/latest.json';
/** The updater's public key (tauri.conf.json plugins.updater.pubkey; key id 8428B81A03E58D53). */
export const UPDATER_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg0MjhCODFBMDNFNThENTMKUldSVGplVURHcmdvaEpxYjVGSXpWL3NaRG1TVG5TbHVrWWttVXNmb1NtWDBLOG1ic3BsZTJHWnMK';
/** Where a version's assets are downloaded from (release-assets.mjs releaseDownloadUrl without the tag). */
export const RELEASE_BASE = 'https://github.com/Wooangha/easy-study-releases/releases/download';
/** The one folder inside every server tarball (the same for every version: an update keeps the install's name). */
export const SERVER_TOP_DIR = 'easy-study-server';

/**
 * Whether `root` is an installed server tarball: VERSION, bin/easy-study and node/bin/node all exist. The same rule as
 * server/cli.ts isServerInstall (not imported from there: the CLI loads this module lazily, and a static import back
 * would be a cycle through the CLI's top-level await).
 */
export function isServerInstall(root: string, exists: (file: string) => boolean = existsSync): boolean {
  return ['VERSION', path.join('bin', 'easy-study'), path.join('node', 'bin', 'node')].every((marker) => exists(path.join(root, marker)));
}

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const LATEST_JSON_TIMEOUT_MS = 30_000;
const MAX_LATEST_JSON_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const SELF_CHECK_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 120_000;
/** The signals that stop an update (Ctrl+C, `kill`, a closed terminal or SSH session). */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/** What an interrupted update may leave in the install's parent folder: its staging and old-install folders. */
const LEFTOVER_RE = /^\.easy-study-(update|old)-[0-9a-f]{12}$/;

/**
 * The top-level entries of an install: the tarball's layout (desktop/scripts/server-tarball.mjs). An update replaces
 * the folder as a whole, so anything else in it (a TLS key, a start script, data) stops the update.
 */
export const INSTALL_ENTRIES: readonly string[] = [
  'VERSION',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'dist-server',
  'web',
  'node_modules',
  'bin',
  'node',
  'whisper',
  'ffmpeg',
];

/** The server tarball of `version` for `arch` (x64 | arm64). */
export function serverTarballName(version: string, arch: string): string {
  return `easy-study-server-${version}-linux-${arch}.tar.gz`;
}

/** latest.json's platform key of the server tarball for `arch` (Node's process.arch). */
export function serverPlatformKey(arch: string): string {
  if (arch === 'x64') return 'linux-x86_64-server';
  if (arch === 'arm64') return 'linux-aarch64-server';
  throw new Error(`no server build for ${arch}`);
}

/** Semantic version precedence (the same as release-assets.mjs compareVersions): < 0, 0 or > 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
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

/** A reason `easy-study update` stops (exit 1); the message is for the user. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

/** `easy-study update` stopped by Ctrl+C, SIGTERM or SIGHUP, after its cleanup (exit 130). */
export class UpdateInterrupted extends UpdateError {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateInterrupted';
  }
}

export interface UpdateOptions {
  /** The install folder (server/config.ts repoRoot() of the running CLI). */
  root: string;
  /** Test overrides only: the shipped CLI never passes these. */
  endpoint?: string;
  publicKey?: string;
  releaseBase?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Progress and warnings (default console.log). */
  log?: (line: string) => void;
  /** Where the running processes are listed (default /proc). */
  procDir?: string;
  /** Where SIGINT, SIGTERM and SIGHUP arrive (default process). */
  signals?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
  hooks?: {
    /** Runs between moving the old install aside and moving the new one in (tests: a failing swap). */
    afterMoveAside?(): void | Promise<void>;
  };
}

export interface UpdateCheck {
  current: string;
  latest: string;
  /** Whether `latest` is newer than `current`. */
  available: boolean;
  /** What to print. */
  message: string;
  /** latest.json's entry for this computer. */
  entry: { url: string; signature: string };
}

export interface UpdateResult {
  from: string;
  to: string;
  updated: boolean;
  message: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  );
}

/** This computer's arch when there is a server build for it (linux x64 / arm64). */
function supportedArch(opts: UpdateOptions): string {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new UpdateError(`easy-study update 는 리눅스(x64, arm64) 서버 설치본에서만 돼요 (이 컴퓨터: ${platform}-${arch})`);
  }
  return arch;
}

async function currentVersion(root: string): Promise<string> {
  if (!isServerInstall(root)) {
    throw new UpdateError(`서버 설치본에서만 돼요: ${root} 에 VERSION, bin/easy-study, node/bin/node 가 없어요`);
  }
  let version: unknown;
  try {
    version = (JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
  } catch (err) {
    throw new UpdateError(`설치된 버전을 읽을 수 없어요 (${path.join(root, 'package.json')}: ${errorText(err)})`);
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new UpdateError(`설치된 버전을 읽을 수 없어요 (${String(version)})`);
  return version;
}

/** Reads a response body of at most `max` bytes. */
async function readLimited(res: Response, max: number, what: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) throw new UpdateError(`${what}이(가) 너무 커요 (${max} 바이트 초과)`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fetchLatest(opts: UpdateOptions, current: string, arch: string, cancel?: AbortSignal) {
  const endpoint = opts.endpoint ?? UPDATER_ENDPOINT;
  let json: unknown;
  try {
    const timeout = AbortSignal.timeout(LATEST_JSON_TIMEOUT_MS);
    const res = await fetch(endpoint, {
      cache: 'no-store',
      headers: { 'User-Agent': `easy-study-server/${current}` },
      signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
    });
    if (!res.ok) throw new UpdateError(`HTTP ${res.status}`);
    json = JSON.parse((await readLimited(res, MAX_LATEST_JSON_BYTES, 'latest.json')).toString('utf8'));
  } catch (err) {
    throw new UpdateError(`업데이트 정보를 받지 못했어요 (${endpoint}): ${errorText(err)}`);
  }
  const latest = (json as { version?: unknown } | null)?.version;
  if (typeof latest !== 'string' || !VERSION_RE.test(latest)) throw new UpdateError(`업데이트 정보의 버전이 올바르지 않아요: ${String(latest)}`);
  const platforms = (json as { platforms?: unknown }).platforms;
  const raw = platforms && typeof platforms === 'object' ? (platforms as Record<string, unknown>)[serverPlatformKey(arch)] : undefined;
  const entry = raw as { url?: unknown; signature?: unknown } | undefined;
  if (!entry || typeof entry.url !== 'string' || typeof entry.signature !== 'string') {
    throw new UpdateError(`최신 버전 ${latest}에는 이 컴퓨터(linux-${arch})용 서버 빌드가 없어요`);
  }
  return { latest, entry: { url: entry.url, signature: entry.signature } };
}

/**
 * `easy-study update --check`: the installed and the latest version. Throws UpdateError when this is not a server
 * install on Linux x64/arm64 or latest.json cannot be read or has no build for this computer.
 */
export async function checkForUpdate(opts: UpdateOptions): Promise<UpdateCheck> {
  const arch = supportedArch(opts);
  const current = await currentVersion(opts.root);
  const { latest, entry } = await fetchLatest(opts, current, arch);
  const available = compareVersions(latest, current) > 0;
  return {
    current,
    latest,
    available,
    entry,
    message: available ? `지금 ${current} · 최신 ${latest} — easy-study update 로 업데이트하세요` : `최신 버전이에요 (${current})`,
  };
}

/**
 * Downloads `url` to `file`: at most MAX_DOWNLOAD_BYTES, aborted after DOWNLOAD_IDLE_MS without a byte or when
 * `cancel` aborts (a signal).
 */
async function download(url: string, file: string, current: string, cancel: AbortSignal): Promise<void> {
  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error(`${DOWNLOAD_IDLE_MS / 1000}초 동안 받은 데이터가 없어요`)), DOWNLOAD_IDLE_MS);
  };
  const progress = process.stdout.isTTY === true;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  touch();
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      // The bytes exactly as signed: no transparent decompression.
      headers: { 'User-Agent': `easy-study-server/${current}`, 'Accept-Encoding': 'identity' },
      signal: AbortSignal.any([controller.signal, cancel]),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 너무 커요 (${mb(length)} MB)`);
    const total = Number.isFinite(length) && length > 0 ? ` / ${mb(length)}` : '';
    let received = 0;
    let shown = 0;
    const out = createWriteStream(file, { mode: 0o600 });
    const body = res.body;
    await pipeline(
      (async function* () {
        for await (const chunk of body) {
          touch();
          received += chunk.byteLength;
          if (received > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 너무 커요 (${mb(MAX_DOWNLOAD_BYTES)} MB 초과)`);
          if (progress && received - shown >= 256 * 1024) {
            shown = received;
            process.stdout.write(`\r  받는 중 ${mb(received)}${total} MB`);
          }
          yield chunk;
        }
      })(),
      out,
    );
    if (progress) process.stdout.write(`\r  받는 중 ${mb(received)}${total} MB\n`);
  } catch (err) {
    if (progress) process.stdout.write('\n');
    const reason = controller.signal.aborted ? errorText(controller.signal.reason) : errorText(err);
    throw new UpdateError(`업데이트 파일을 받지 못했어요 (${url}): ${reason}`);
  } finally {
    clearTimeout(idle);
  }
}

/**
 * Unpacks a verified tarball with the system tar (gunzip in Node: no gzip binary needed): owned by this user, modes
 * thinned by the umask also for root (settleTree then gives the tarball's modes). `cancel` stops tar.
 */
async function extract(file: string, dir: string, cancel: AbortSignal): Promise<void> {
  await fs.mkdir(dir);
  const tar = spawn('tar', ['-x', '--no-same-owner', '--no-same-permissions', '-f', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
  const stop = () => tar.kill('SIGTERM');
  cancel.addEventListener('abort', stop, { once: true });
  let stderr = '';
  tar.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    tar.once('error', reject);
    tar.once('close', (code) => resolve(code));
  });
  const timer = setTimeout(() => tar.kill('SIGKILL'), EXTRACT_TIMEOUT_MS);
  try {
    const piped = pipeline(createReadStream(file), createGunzip(), tar.stdin, { signal: cancel });
    const [pipeResult, code] = await Promise.allSettled([piped, exited]);
    if (code.status === 'rejected') throw new Error(`tar를 실행할 수 없어요: ${errorText(code.reason)}`);
    if (code.value !== 0) throw new Error(`tar 종료 코드 ${code.value}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    if (pipeResult.status === 'rejected') throw pipeResult.reason;
  } catch (err) {
    throw new UpdateError(`업데이트 파일을 풀지 못했어요: ${errorText(err)}`);
  } finally {
    clearTimeout(timer);
    cancel.removeEventListener('abort', stop);
  }
}

/**
 * Gives the unpacked tree under `dir` the tarball's modes and, when `owner` is set (an update run as root), the
 * install's owner. tar left this user's files with modes thinned by the umask; the tarball has only folders 0755 and
 * files 0755 or 0644 (server-tarball.mjs), which the x bits tar kept tell apart. Links are never followed.
 */
async function settleTree(dir: string, owner: { uid: number; gid: number } | null): Promise<void> {
  const visit = async (p: string): Promise<void> => {
    const st = await fs.lstat(p);
    if (owner) await fs.lchown(p, owner.uid, owner.gid);
    if (st.isSymbolicLink()) return;
    const mode = st.isDirectory() || st.mode & 0o111 ? 0o755 : 0o644;
    if ((st.mode & 0o7777) !== mode) await fs.chmod(p, mode);
    if (st.isDirectory()) for (const name of await fs.readdir(p)) await visit(path.join(p, name));
  };
  for (const name of await fs.readdir(dir)) await visit(path.join(dir, name));
}

/** Runs `cmd` with no output; its exit code, or null when it could not run, was killed or took over `timeoutMs`. */
function runQuiet(cmd: string, args: string[], cancel: AbortSignal, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', signal: cancel });
    const timer = setTimeout(() => {
      child.unref();
      resolve(null);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Flushes the unpacked tree to disk before it replaces the install, so that a crash or power loss right after the
 * update cannot leave empty files in place of the new install (the old one is deleted then). `sync -f` flushes only
 * the filesystem of `dir` (GNU coreutils); plain `sync` where -f is unknown. A failure only warns.
 */
async function flushTree(dir: string, cancel: AbortSignal, log: (line: string) => void): Promise<void> {
  const code = await runQuiet('sync', ['-f', dir], cancel, SYNC_TIMEOUT_MS);
  if (code === 0 || cancel.aborted) return;
  if (code !== null && (await runQuiet('sync', [], cancel, SYNC_TIMEOUT_MS)) === 0) return;
  log('경고: 새 버전을 디스크에 쓰는 것(sync)을 확인하지 못했어요 — 계속합니다');
}

/** fsync of a folder: its renamed entries reach the disk. A failure only warns. */
async function syncFolder(dir: string, log: (line: string) => void): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    log(`경고: ${dir} 를 디스크에 쓰지 못했어요 (${errorText(err)}) — 계속합니다`);
  }
}

/**
 * The processes other than this one that run this install's Node (`easy-study server`, its workers, another
 * `easy-study update`): their pids, from <procDir>/<pid>/exe (" (deleted)" when the file was replaced since).
 * Processes this user may not inspect are skipped; no procDir (not Linux) gives [].
 */
export async function installProcesses(root: string, procDir = '/proc', self = process.pid): Promise<number[]> {
  const node = path.join(root, 'node', 'bin', 'node');
  const targets = new Set([node, await fs.realpath(node).catch(() => node)]);
  let names: string[];
  try {
    names = await fs.readdir(procDir);
  } catch {
    return [];
  }
  const pids = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name) && Number(name) !== self)
      .map((name) =>
        fs.readlink(path.join(procDir, name, 'exe')).then(
          (exe) => (targets.has(exe.replace(/ \(deleted\)$/, '')) ? Number(name) : null),
          () => null,
        ),
      ),
  );
  return pids.filter((pid): pid is number => pid !== null).sort((a, b) => a - b);
}

/**
 * Removes what an update that was killed (or lost power) left in `parent`: folders named like its staging and
 * old-install folders, owned by this user. Nothing else, and no link, is touched.
 */
async function removeLeftovers(parent: string, log: (line: string) => void): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let names: string[];
  try {
    names = await fs.readdir(parent);
  } catch {
    return;
  }
  for (const name of names.filter((n) => LEFTOVER_RE.test(n)).sort()) {
    const dir = path.join(parent, name);
    const st = await fs.lstat(dir).catch(() => null);
    if (!st?.isDirectory() || st.uid !== uid) continue;
    try {
      await fs.rm(dir, { recursive: true, force: true });
      log(`지난번에 중단된 업데이트가 남긴 폴더를 지웠어요: ${dir}`);
    } catch (err) {
      log(`경고: 지난번에 중단된 업데이트가 남긴 폴더를 지우지 못했어요 (${dir}): ${errorText(err)}`);
    }
  }
}

/** After SIGHUP the terminal is gone: a failed write to it must not crash the cleanup. */
function ignoreTerminalErrors(): void {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.listenerCount('error') === 0) stream.on('error', () => {});
  }
}

/** Runs `<dir>/bin/easy-study version`: the new Node runs on this computer and says the expected version. */
function runVersion(launcher: string, cancel: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, ['version'], { stdio: ['ignore', 'pipe', 'pipe'], signal: cancel });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), SELF_CHECK_TIMEOUT_MS);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${signal ? `signal ${signal}` : `exit ${code}`}${err.trim() ? `: ${err.trim().slice(-500)}` : ''}`));
    });
  });
}

/** Checks the unpacked install before it replaces the current one. */
async function sanityCheck(extractDir: string, latest: string, cancel: AbortSignal): Promise<string> {
  const names = await fs.readdir(extractDir);
  if (names.length !== 1 || names[0] !== SERVER_TOP_DIR) {
    throw new UpdateError(`업데이트 파일의 내용이 예상과 달라요: ${SERVER_TOP_DIR}/ 하나만 있어야 하는데 ${names.join(', ') || '(비어 있음)'}`);
  }
  const top = path.join(extractDir, SERVER_TOP_DIR);
  if (!(await fs.lstat(top)).isDirectory()) throw new UpdateError(`업데이트 파일의 ${SERVER_TOP_DIR} 이(가) 폴더가 아니에요`);
  const read = (name: string) =>
    fs.readFile(path.join(top, name), 'utf8').catch((err: unknown) => {
      throw new UpdateError(`업데이트 파일에 ${name} 이(가) 없어요 (${errorText(err)})`);
    });
  const version = (await read('VERSION')).trim();
  if (version !== latest) throw new UpdateError(`업데이트 파일의 VERSION(${version})이 ${latest}이(가) 아니에요`);
  let pkgVersion: unknown;
  try {
    pkgVersion = (JSON.parse(await read('package.json')) as { version?: unknown }).version;
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    throw new UpdateError(`업데이트 파일의 package.json을 읽을 수 없어요 (${errorText(err)})`);
  }
  if (pkgVersion !== latest) throw new UpdateError(`업데이트 파일의 package.json 버전(${String(pkgVersion)})이 ${latest}이(가) 아니에요`);
  const launcher = path.join(top, 'bin', 'easy-study');
  const stat = await fs.lstat(launcher).catch(() => null);
  const runnable = stat?.isFile() === true && (await fs.access(launcher, constants.X_OK).then(() => true, () => false));
  if (!runnable) throw new UpdateError('업데이트 파일의 bin/easy-study 가 실행 파일이 아니에요');
  let printed: string;
  try {
    printed = await runVersion(launcher, cancel);
  } catch (err) {
    throw new UpdateError(`새 버전이 이 컴퓨터에서 실행되지 않아요 (bin/easy-study version: ${errorText(err)})`);
  }
  if (printed !== latest) throw new UpdateError(`새 버전의 bin/easy-study version 이 ${latest} 대신 "${printed}" 을(를) 출력했어요`);
  return top;
}

/**
 * What must hold before anything is downloaded: data outside the install, the install replaceable by this user, and
 * nothing in it but the tarball's entries (INSTALL_ENTRIES), since the update replaces the folder as a whole.
 */
async function checkReplaceable(root: string): Promise<void> {
  for (const name of ['library', '.cache']) {
    const inside = path.join(root, name);
    if (await exists(inside)) {
      throw new UpdateError(`설치 폴더 안에 데이터가 있어요 (${inside}): 업데이트하면 설치 폴더를 통째로 바꾸므로 먼저 다른 곳으로 옮기세요`);
    }
  }
  const parent = path.dirname(root);
  try {
    await fs.access(root, constants.W_OK);
    await fs.access(parent, constants.W_OK | constants.X_OK);
  } catch {
    throw new UpdateError(`설치 폴더에 쓸 수 없어요 (${root}, ${parent}): 설치한 사용자로(또는 sudo로) 실행하세요`);
  }
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (err) {
    throw new UpdateError(`설치 폴더를 읽을 수 없어요 (${root}): ${errorText(err)}`);
  }
  const extra = names.filter((name) => !INSTALL_ENTRIES.includes(name)).sort();
  if (extra.length > 0) {
    throw new UpdateError(
      `설치 폴더(${root})에 설치본에 없는 항목이 있어요: ${extra.join(', ')} — 업데이트하면 설치 폴더를 통째로 바꾸므로 함께 지워져요. ` +
        '설치 폴더 밖으로 옮긴 뒤 다시 실행하세요',
    );
  }
}

/**
 * `easy-study update` (DESIGN §26): downloads the latest server tarball for this computer, verifies its signature,
 * unpacks and checks it, and swaps it for the install at `opts.root`. Throws UpdateError (the install untouched, or
 * restored) when anything is off, UpdateInterrupted after cleaning up when SIGINT, SIGTERM or SIGHUP arrived.
 */
export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const arch = supportedArch(opts);
  const root = path.resolve(opts.root);
  const current = await currentVersion(root);
  await checkReplaceable(root);

  // A signal stops the step under way (download, tar, the version check); the staging folder is removed and the CLI
  // exits 130. During the swap (the two renames, or the rollback) a signal is held and acted on after it.
  const cancel = new AbortController();
  let holding = false;
  let held: NodeJS.Signals | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signal === 'SIGHUP') ignoreTerminalErrors();
    if (holding) held ??= signal;
    else if (!cancel.signal.aborted) cancel.abort(signal);
  };
  const signals = opts.signals ?? process;
  for (const signal of STOP_SIGNALS) signals.on(signal, onSignal);
  const stopped = () => new UpdateInterrupted(`업데이트를 멈췄어요 (${String(cancel.signal.reason)}) — 설치는 그대로예요`);
  const checkpoint = () => {
    if (cancel.signal.aborted) throw stopped();
  };
  let swapping = false;
  try {
    const { latest, entry } = await fetchLatest(opts, current, arch, cancel.signal);
    if (compareVersions(latest, current) <= 0) return { from: current, to: current, updated: false, message: `최신 버전이에요 (${current})` };

    const name = serverTarballName(latest, arch);
    const expectedUrl = `${opts.releaseBase ?? RELEASE_BASE}/v${latest}/${name}`;
    if (entry.url !== expectedUrl) throw new UpdateError(`업데이트 주소가 예상과 달라요: ${entry.url} (예상: ${expectedUrl})`);

    // The running server would go on with its files replaced under it (workers, native modules, the web client).
    const running = await installProcesses(root, opts.procDir);
    if (running.length > 0) {
      throw new UpdateError(
        `easy-study 서버가 실행 중이에요 (pid ${running.join(', ')}): 먼저 서버를 끄고 다시 실행하세요 ` +
          '(서버를 연 터미널에서 Ctrl+C, systemd 사용자 유닛이면 systemctl --user stop <유닛 이름>)',
      );
    }

    const parent = path.dirname(root);
    await removeLeftovers(parent, log);
    checkpoint();
    const hex = randomBytes(6).toString('hex');
    const staging = path.join(parent, `.easy-study-update-${hex}`);
    const old = path.join(parent, `.easy-study-old-${hex}`);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      checkpoint();
      log(`easy-study ${current} → ${latest}: ${name} 받는 중…`);
      const file = path.join(staging, 'download.tar.gz');
      await download(entry.url, file, current, cancel.signal);
      checkpoint();

      let fields: Record<string, string>;
      try {
        fields = await verify(opts.publicKey ?? UPDATER_PUBKEY, entry.signature, { file });
      } catch (err) {
        throw new UpdateError(`업데이트 파일의 서명이 맞지 않아요: ${errorText(err)} — 설치는 그대로예요`);
      }
      if (fields.file !== name) throw new UpdateError(`서명된 파일 이름(${fields.file ?? '없음'})이 ${name}이(가) 아니에요 — 설치는 그대로예요`);
      if (fields.version !== latest) throw new UpdateError(`서명된 버전(${fields.version ?? '없음'})이 ${latest}이(가) 아니에요 — 설치는 그대로예요`);
      checkpoint();

      const extractDir = path.join(staging, 'extract');
      await extract(file, extractDir, cancel.signal);
      checkpoint();
      // As root (sudo): the install keeps its owner, so that its user can update it again.
      const owned = await fs.lstat(root);
      await settleTree(extractDir, process.getuid?.() === 0 ? { uid: owned.uid, gid: owned.gid } : null);
      const fresh = await sanityCheck(extractDir, latest, cancel.signal);
      checkpoint();
      await flushTree(extractDir, cancel.signal, log);
      checkpoint();

      swapping = true;
      holding = true;
      try {
        try {
          await fs.rename(root, old);
        } catch (err) {
          throw new UpdateError(`설치 폴더를 옮기지 못했어요: ${errorText(err)} — 설치는 그대로예요`);
        }
        try {
          await opts.hooks?.afterMoveAside?.();
          await fs.rename(fresh, root);
        } catch (err) {
          try {
            await fs.rename(old, root);
          } catch (rollbackErr) {
            throw new UpdateError(
              `설치를 바꾸지 못했고 (${errorText(err)}) 되돌리지도 못했어요 (${errorText(rollbackErr)}): 이전 버전은 ${old} 에 있어요. ` +
                `mv '${old}' '${root}' 로 되돌리세요`,
            );
          }
          throw new UpdateError(`설치를 바꾸지 못해 이전 버전으로 되돌렸어요: ${errorText(err)}`);
        }
      } finally {
        holding = false;
        if (held && !cancel.signal.aborted) cancel.abort(held);
      }
      // The renames on disk before the old install is deleted.
      await syncFolder(parent, log);
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch((err: unknown) => {
        log(`경고: 임시 폴더를 지우지 못했어요 (${staging}): ${errorText(err)}`);
      });
    }
    await fs.rm(old, { recursive: true, force: true }).catch((err: unknown) => {
      log(`경고: 이전 버전 폴더를 지우지 못했어요 (${old}): ${errorText(err)}`);
    });
    if (cancel.signal.aborted) {
      throw new UpdateInterrupted(
        `${String(cancel.signal.reason)} 을(를) 받았지만 업데이트는 이미 끝났어요: easy-study ${current} → ${latest}. 서버가 켜져 있었다면 다시 시작하세요`,
      );
    }
    return {
      from: current,
      to: latest,
      updated: true,
      message: `easy-study ${current} → ${latest} 업데이트했어요. 서버가 켜져 있었다면 다시 시작하세요 (Ctrl+C 후 easy-study server)`,
    };
  } catch (err) {
    if (!cancel.signal.aborted || err instanceof UpdateInterrupted) throw err;
    // Stopped by a signal. Once the swap began, its own message says where the install is.
    throw swapping ? new UpdateInterrupted(errorText(err)) : stopped();
  } finally {
    for (const signal of STOP_SIGNALS) signals.off(signal, onSignal);
  }
}
