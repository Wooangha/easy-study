// `easy-study update` (server/selfUpdate.ts, DESIGN §26) against a fake release: an HTTP server on 127.0.0.1 serves
// latest.json and a server tarball signed with a throwaway key (tests/minisignFixtures.ts). The install is a fake one
// in a temporary folder (VERSION, package.json, stub node and bin/easy-study); the system tar unpacks the tarball.
// Signals come from an EventEmitter handed to runUpdate, running processes from a fake /proc.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import {
  INSTALL_ENTRIES,
  RELEASE_BASE,
  SERVER_TOP_DIR,
  UpdateError,
  UpdateInterrupted,
  checkForUpdate,
  compareVersions,
  installProcesses,
  isServerInstall,
  runUpdate,
  serverPlatformKey,
  serverTarballName,
} from '../server/selfUpdate.ts';
import type { UpdateOptions } from '../server/selfUpdate.ts';
import { isServerInstall as cliIsServerInstall } from '../server/cli.ts';
import { makeTestKey, signTest } from './minisignFixtures.ts';
import type { TestKey } from './minisignFixtures.ts';

const run = promisify(execFile);
const CURRENT = '0.6.5';
const LATEST = '0.7.0';
const ARCH = 'x64';
const NAME = serverTarballName(LATEST, ARCH);
const IS_ROOT = process.getuid?.() === 0;

describe('names and versions', () => {
  test('tarball names and platform keys', () => {
    assert.equal(serverTarballName('0.7.0', 'x64'), 'easy-study-server-0.7.0-linux-x64.tar.gz');
    assert.equal(serverTarballName('0.7.0', 'arm64'), 'easy-study-server-0.7.0-linux-arm64.tar.gz');
    assert.equal(serverPlatformKey('x64'), 'linux-x86_64-server');
    assert.equal(serverPlatformKey('arm64'), 'linux-aarch64-server');
    assert.throws(() => serverPlatformKey('ia32'));
    assert.equal(SERVER_TOP_DIR, 'easy-study-server');
    assert.equal(RELEASE_BASE, 'https://github.com/Wooangha/easy-study-releases/releases/download');
  });

  test('semver precedence', () => {
    assert.ok(compareVersions('0.7.0', '0.6.5') > 0);
    assert.ok(compareVersions('0.6.10', '0.6.9') > 0);
    assert.equal(compareVersions('0.6.5', 'v0.6.5'), 0);
    assert.ok(compareVersions('0.7.0-beta.1', '0.7.0') < 0);
    assert.ok(compareVersions('0.7.0-beta.2', '0.7.0-beta.10') < 0);
    assert.ok(compareVersions('0.7.0-alpha', '0.7.0-1') > 0);
    assert.ok(compareVersions('0.7.0-rc', '0.7.0-rc.1') < 0);
    assert.throws(() => compareVersions('0.7', '0.7.0'), /not a version/);
  });

  test('install marker: the same rule in the CLI and the updater', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-marker-'));
    try {
      assert.equal(isServerInstall(dir), false);
      await fs.writeFile(path.join(dir, 'VERSION'), '1.0.0\n');
      await fs.mkdir(path.join(dir, 'bin'));
      await fs.writeFile(path.join(dir, 'bin', 'easy-study'), '');
      assert.equal(isServerInstall(dir), false);
      assert.equal(cliIsServerInstall(dir), false);
      await fs.mkdir(path.join(dir, 'node', 'bin'), { recursive: true });
      await fs.writeFile(path.join(dir, 'node', 'bin', 'node'), '');
      assert.equal(isServerInstall(dir), true);
      assert.equal(cliIsServerInstall(dir), true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

interface TarballSpec {
  version?: string;
  /** VERSION file content (default `${version}\n`). */
  versionFile?: string;
  /** What bin/easy-study version prints (default version). */
  prints?: string;
  /** The top folder (default easy-study-server). */
  top?: string;
}

/** A server tarball (built with the system tar) with stub programs. */
async function makeTarball(dir: string, spec: TarballSpec = {}): Promise<Buffer> {
  const version = spec.version ?? LATEST;
  const stage = await fs.mkdtemp(path.join(dir, 'stage-'));
  const top = path.join(stage, spec.top ?? SERVER_TOP_DIR);
  await writeInstall(top, { version, versionFile: spec.versionFile, prints: spec.prints ?? version, marker: `new ${version}` });
  const out = path.join(dir, `tarball-${path.basename(stage)}.tar.gz`);
  // COPYFILE_DISABLE: no macOS ._ metadata entries (bsdtar).
  await run('tar', ['-czf', out, '-C', stage, spec.top ?? SERVER_TOP_DIR], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await fs.readFile(out);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.rm(out);
  return bytes;
}

/** A fake install: VERSION, package.json, stub node and launcher, and a marker file. */
async function writeInstall(root: string, { version, versionFile, prints, marker }: { version: string; versionFile?: string; prints: string; marker: string }) {
  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'node', 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist-server', 'server'), { recursive: true });
  await fs.writeFile(path.join(root, 'VERSION'), versionFile ?? `${version}\n`);
  await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'easy-study', version }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'node', 'bin', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'bin', 'easy-study'), `#!/bin/sh\necho ${prints}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'dist-server', 'server', 'marker.txt'), `${marker}\n`);
}

/** Every entry under `dir` with its type, mode and content hash: equal snapshots = byte-identical trees. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      const rel = path.relative(dir, p);
      const stat = await fs.lstat(p);
      const mode = (stat.mode & 0o777).toString(8);
      if (entry.isDirectory()) {
        out[rel] = `dir ${mode}`;
        await walk(p);
      } else {
        out[rel] = `file ${mode} ${createHash('sha256').update(await fs.readFile(p)).digest('hex')}`;
      }
    }
  };
  await walk(dir);
  return out;
}

interface FakeRelease {
  base: string;
  requests: string[];
  latest: unknown;
  files: Map<string, Buffer>;
  /** When set, a download sends half the file and then waits (a slow link); called with each such response. */
  stall: ((res: http.ServerResponse) => void) | null;
}

describe('easy-study update (server/selfUpdate.ts)', { skip: process.platform === 'win32' ? 'the server build is Linux only (POSIX sh, tar)' : false }, () => {
  const key: TestKey = makeTestKey();
  const release: FakeRelease = { base: '', requests: [], latest: null, files: new Map(), stall: null };
  let server: http.Server;
  const tmpDirs: string[] = [];
  let goodTarball: Buffer;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      release.requests.push(url);
      if (url === '/latest.json') {
        if (release.latest === null) return void res.writeHead(404).end();
        res.setHeader('Content-Type', 'application/json');
        return void res.end(typeof release.latest === 'string' ? release.latest : JSON.stringify(release.latest));
      }
      const file = release.files.get(url);
      if (!file) return void res.writeHead(404).end();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(file.length));
      if (release.stall) {
        res.write(file.subarray(0, file.length >> 1));
        return void release.stall(res);
      }
      res.end(file);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    release.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = await tempDir();
    goodTarball = await makeTarball(dir);
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of tmpDirs) {
      await fs.chmod(dir, 0o755).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-update-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  const releaseBase = () => `${release.base}/download`;
  const assetPath = (version = LATEST, name = serverTarballName(version, ARCH)) => `/download/v${version}/${name}`;

  /** Publishes `tarball` as the latest release, signed as `sign` says (the right key, file and version by default). */
  function publish(
    tarball: Buffer,
    {
      version = LATEST,
      signKey = key,
      signedFile = NAME,
      signedVersion = version,
      url = `${releaseBase()}/v${version}/${serverTarballName(version, ARCH)}`,
      platformKey = serverPlatformKey(ARCH),
    }: { version?: string; signKey?: TestKey; signedFile?: string; signedVersion?: string; url?: string; platformKey?: string } = {},
  ) {
    release.files.clear();
    release.files.set(assetPath(version), tarball);
    release.latest = {
      version,
      notes: '',
      pub_date: '2026-09-30T00:00:00Z',
      platforms: {
        'linux-x86_64-appimage': { url: `${releaseBase()}/v${version}/easy-study_${version}_amd64.AppImage`, signature: 'x' },
        [platformKey]: { url, signature: signTest(signKey, tarball, { file: signedFile, version: signedVersion }) },
      },
    };
    release.requests.length = 0;
  }

  /** A fake install of CURRENT in a fresh folder; returns its root and parent. */
  async function install(): Promise<{ root: string; parent: string; logs: string[]; opts: UpdateOptions }> {
    const parent = await tempDir();
    const root = path.join(parent, SERVER_TOP_DIR);
    await writeInstall(root, { version: CURRENT, prints: CURRENT, marker: 'old' });
    const logs: string[] = [];
    return {
      root,
      parent,
      logs,
      opts: {
        root,
        endpoint: `${release.base}/latest.json`,
        publicKey: key.publicKey,
        releaseBase: releaseBase(),
        platform: 'linux',
        arch: ARCH,
        log: (line) => logs.push(line),
      },
    };
  }

  const leftovers = async (parent: string) => (await fs.readdir(parent)).filter((name) => name.startsWith('.easy-study-'));

  /** runUpdate must refuse with `message` and leave the install exactly as it was; returns the error. */
  async function refused(opts: UpdateOptions, message: RegExp): Promise<UpdateError> {
    const before = await snapshot(opts.root);
    let error: UpdateError | undefined;
    await assert.rejects(runUpdate(opts), (err: unknown) => {
      assert.ok(err instanceof UpdateError, String(err));
      assert.match(err.message, message);
      error = err;
      return true;
    });
    assert.deepEqual(await snapshot(opts.root), before, 'the install is untouched');
    assert.deepEqual(await leftovers(path.dirname(opts.root)), [], 'no staging or old folder is left');
    assert.ok(error);
    return error;
  }

  const listening = (signals: EventEmitter) => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => signals.listenerCount(s)).reduce((a, b) => a + b);

  test('a newer version replaces the install; the old install and the staging folder are gone', async () => {
    const { root, parent, logs, opts } = await install();
    publish(goodTarball);
    const result = await runUpdate(opts);
    assert.deepEqual(
      { from: result.from, to: result.to, updated: result.updated },
      { from: CURRENT, to: LATEST, updated: true },
    );
    assert.equal(result.message, `easy-study ${CURRENT} → ${LATEST} 업데이트했어요. 서버가 켜져 있었다면 다시 시작하세요 (Ctrl+C 후 easy-study server)`);
    assert.equal(await fs.readFile(path.join(root, 'VERSION'), 'utf8'), `${LATEST}\n`);
    assert.equal(await fs.readFile(path.join(root, 'dist-server', 'server', 'marker.txt'), 'utf8'), `new ${LATEST}\n`);
    assert.equal((await run(path.join(root, 'bin', 'easy-study'), ['version'])).stdout, `${LATEST}\n`);
    assert.deepEqual(await fs.readdir(parent), [SERVER_TOP_DIR]);
    assert.deepEqual(release.requests, ['/latest.json', assetPath()]);
    assert.ok(logs.some((line) => line.includes(NAME)), logs.join('\n'));
    // Flushed to disk (sync, the parent folder's fsync) without a warning.
    assert.deepEqual(logs.filter((line) => line.startsWith('경고')), []);
  });

  test('the same or an older version changes nothing and downloads nothing', async () => {
    for (const version of [CURRENT, '0.6.4', `${CURRENT}-beta.1`]) {
      const { opts } = await install();
      publish(goodTarball, { version });
      const before = await snapshot(opts.root);
      const result = await runUpdate(opts);
      assert.equal(result.updated, false);
      assert.equal(result.message, `최신 버전이에요 (${CURRENT})`);
      assert.deepEqual(await snapshot(opts.root), before);
      assert.deepEqual(release.requests, ['/latest.json'], version);
    }
  });

  test('--check says whether there is a newer version and downloads nothing', async () => {
    const { opts } = await install();
    const before = await snapshot(opts.root);
    publish(goodTarball);
    const check = await checkForUpdate(opts);
    assert.deepEqual(
      { current: check.current, latest: check.latest, available: check.available, message: check.message },
      { current: CURRENT, latest: LATEST, available: true, message: `지금 ${CURRENT} · 최신 ${LATEST} — easy-study update 로 업데이트하세요` },
    );
    assert.deepEqual(release.requests, ['/latest.json']);
    publish(goodTarball, { version: CURRENT });
    const upToDate = await checkForUpdate(opts);
    assert.equal(upToDate.available, false);
    assert.equal(upToDate.message, `최신 버전이에요 (${CURRENT})`);
    assert.deepEqual(await snapshot(opts.root), before);
  });

  test('a release without a build for this computer is refused', async () => {
    const { opts } = await install();
    publish(goodTarball, { platformKey: 'linux-aarch64-server' });
    await refused(opts, /최신 버전 0\.7\.0에는 이 컴퓨터\(linux-x64\)용 서버 빌드가 없어요/);
    await assert.rejects(checkForUpdate(opts), /서버 빌드가 없어요/);
  });

  test('a download URL off the release base is refused before anything is downloaded', async () => {
    for (const url of [
      `http://127.0.0.1:1/download/v${LATEST}/${NAME}`,
      `${releaseBase()}/v${LATEST}/easy-study-server-${LATEST}-linux-arm64.tar.gz`,
      `${releaseBase()}/v0.6.9/${NAME}`,
    ]) {
      const { opts } = await install();
      publish(goodTarball, { url });
      await refused(opts, /업데이트 주소가 예상과 달라요/);
      assert.deepEqual(release.requests, ['/latest.json']);
    }
  });

  test('a bad signature, a signature of another file or another version: refused, the install byte-identical', async () => {
    const cases: [Parameters<typeof publish>[1], RegExp][] = [
      [{ signKey: makeTestKey() }, /서명이 맞지 않아요: signed with key/],
      [{ signKey: makeTestKey(key.idBytes) }, /서명이 맞지 않아요/],
      [{ signedFile: `easy-study-server-${LATEST}-linux-arm64.tar.gz` }, /서명된 파일 이름/],
      [{ signedVersion: '0.6.9' }, /서명된 버전\(0\.6\.9\)/],
    ];
    for (const [options, message] of cases) {
      const { opts } = await install();
      publish(goodTarball, options);
      await refused(opts, message);
      assert.deepEqual(release.requests, ['/latest.json', assetPath()]);
    }
    // A tarball that is not the signed one.
    const { opts } = await install();
    publish(goodTarball);
    const tampered = Buffer.from(goodTarball);
    tampered[tampered.length - 20] ^= 0xff;
    release.files.set(assetPath(), tampered);
    await refused(opts, /서명이 맞지 않아요: the file does not match its signature/);
  });

  test('a tarball with another top folder, the wrong VERSION or a launcher printing another version is refused', async () => {
    const dir = await tempDir();
    const cases: [TarballSpec, RegExp][] = [
      [{ top: `easy-study-server-${LATEST}` }, /easy-study-server\/ 하나만 있어야/],
      [{ versionFile: '0.6.9\n' }, /VERSION\(0\.6\.9\)/],
      [{ prints: '0.6.9' }, /bin\/easy-study version 이 0\.7\.0 대신 "0\.6\.9"/],
    ];
    for (const [spec, message] of cases) {
      const { opts } = await install();
      publish(await makeTarball(dir, spec));
      await refused(opts, message);
    }
  });

  test('a failure after the old install was moved aside is rolled back', async () => {
    const { opts } = await install();
    publish(goodTarball);
    await refused({ ...opts, hooks: { afterMoveAside: () => Promise.reject(new Error('disk full (test)')) } }, /이전 버전으로 되돌렸어요: disk full \(test\)/);
    // The next attempt works.
    publish(goodTarball);
    assert.equal((await runUpdate(opts)).updated, true);
  });

  test('an install folder this user cannot replace is refused before anything is downloaded', { skip: IS_ROOT ? 'root can write anywhere' : false }, async () => {
    const { parent, opts } = await install();
    publish(goodTarball);
    await fs.chmod(parent, 0o555);
    try {
      await assert.rejects(runUpdate(opts), /설치 폴더에 쓸 수 없어요 .*설치한 사용자로\(또는 sudo로\) 실행하세요/);
      assert.deepEqual(release.requests, []);
    } finally {
      await fs.chmod(parent, 0o755);
    }
    assert.deepEqual(await leftovers(parent), []);
  });

  test('data inside the install (library/, .cache/) is refused before anything is downloaded', async () => {
    for (const name of ['library', '.cache']) {
      const { root, opts } = await install();
      await fs.mkdir(path.join(root, name));
      publish(goodTarball);
      await refused(opts, /설치 폴더 안에 데이터가 있어요/);
      assert.deepEqual(release.requests, []);
    }
  });

  test("files in the install folder that are not the tarball's are refused before anything is downloaded", async () => {
    const { root, opts } = await install();
    await fs.writeFile(path.join(root, 'start.sh'), '#!/bin/sh\n');
    await fs.mkdir(path.join(root, 'certs'));
    await fs.writeFile(path.join(root, '.env'), 'X=1\n');
    publish(goodTarball);
    await refused(opts, /설치 폴더\(.+\)에 설치본에 없는 항목이 있어요: \.env, certs, start\.sh — 업데이트하면 설치 폴더를 통째로 바꾸므로 함께 지워져요/);
    assert.deepEqual(release.requests, []);
    // Every entry of the tarball's layout is fine.
    for (const name of ['start.sh', 'certs', '.env']) await fs.rm(path.join(root, name), { recursive: true });
    for (const name of INSTALL_ENTRIES) {
      if (/\.(json|md)$|^[A-Z]+$/.test(name)) await fs.writeFile(path.join(root, name), '', { flag: 'a' });
      else await fs.mkdir(path.join(root, name), { recursive: true });
    }
    assert.deepEqual((await fs.readdir(root)).sort(), [...INSTALL_ENTRIES].sort());
    assert.equal((await runUpdate(opts)).updated, true);
  });

  test('a running server of this install is refused before anything is downloaded', async () => {
    const { root, opts } = await install();
    publish(goodTarball);
    // A fake /proc: <pid>/exe links to the program each process runs (the real path, as Linux shows it).
    const proc = await tempDir();
    const node = await fs.realpath(path.join(root, 'node', 'bin', 'node'));
    const processes: [string, string | null][] = [
      ['4242', node], // easy-study server
      ['4243', `${node} (deleted)`], // its image worker, the program file replaced under it since
      ['100', '/usr/bin/node'], // another Node
      ['101', null], // a process this user may not inspect
      [String(process.pid), node], // this update itself
      ['self', node], // not a pid
    ];
    for (const [pid, exe] of processes) {
      await fs.mkdir(path.join(proc, pid));
      if (exe) await fs.symlink(exe, path.join(proc, pid, 'exe'));
    }
    await refused(
      { ...opts, procDir: proc },
      /^easy-study 서버가 실행 중이에요 \(pid 4242, 4243\): 먼저 서버를 끄고 다시 실행하세요 \(서버를 연 터미널에서 Ctrl\+C, systemd 사용자 유닛이면 systemctl --user stop <유닛 이름>\)$/,
    );
    assert.deepEqual(release.requests, ['/latest.json']);
    // The install reached through a symbolic link; no /proc at all.
    const link = path.join(await tempDir(), 'link');
    await fs.symlink(root, link);
    assert.deepEqual(await installProcesses(link, proc), [4242, 4243]);
    assert.deepEqual(await installProcesses(root, path.join(proc, 'missing')), []);
    // Once the server is stopped, the update goes ahead.
    for (const pid of ['4242', '4243']) await fs.rm(path.join(proc, pid), { recursive: true });
    publish(goodTarball);
    assert.equal((await runUpdate({ ...opts, procDir: proc })).updated, true);
  });

  test('folders an interrupted update left behind are removed first; nothing else is touched', async () => {
    const { parent, logs, opts } = await install();
    const staleUpdate = path.join(parent, '.easy-study-update-0123456789ab');
    const staleOld = path.join(parent, '.easy-study-old-abcdef012345');
    await fs.mkdir(path.join(staleUpdate, 'extract'), { recursive: true });
    await fs.writeFile(path.join(staleUpdate, 'download.tar.gz'), 'partial');
    await fs.mkdir(path.join(staleOld, 'bin'), { recursive: true });
    // Not an update's folders: other names, a file, a symbolic link (its target stays).
    const elsewhere = await tempDir();
    await fs.writeFile(path.join(elsewhere, 'keep.txt'), 'keep');
    const kept = ['.easy-study-update-xyz', '.easy-study-update-0123456789abc', '.easy-study-old-ABCDEF999999', 'easy-study-update-0123456789ab', 'notes'];
    for (const name of kept) await fs.mkdir(path.join(parent, name));
    await fs.writeFile(path.join(parent, '.easy-study-old-111111111111'), 'a file');
    await fs.symlink(elsewhere, path.join(parent, '.easy-study-update-222222222222'));
    publish(goodTarball);
    assert.equal((await runUpdate(opts)).updated, true);
    assert.deepEqual((await fs.readdir(parent)).sort(), [...kept, '.easy-study-old-111111111111', '.easy-study-update-222222222222', SERVER_TOP_DIR].sort());
    assert.equal(await fs.readFile(path.join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
    for (const dir of [staleUpdate, staleOld]) assert.ok(logs.some((line) => line.includes(dir)), logs.join('\n'));
  });

  test('Ctrl+C during the download: the download stops, the staging folder is removed, exit 130', async () => {
    const { opts } = await install();
    const signals = new EventEmitter();
    publish(goodTarball);
    const stalled: http.ServerResponse[] = [];
    release.stall = (res) => {
      stalled.push(res);
      setTimeout(() => signals.emit('SIGINT', 'SIGINT'), 50);
    };
    try {
      const err = await refused({ ...opts, signals }, /^업데이트를 멈췄어요 \(SIGINT\) — 설치는 그대로예요$/);
      assert.ok(err instanceof UpdateInterrupted);
    } finally {
      release.stall = null;
      for (const res of stalled) res.destroy();
    }
    assert.equal(stalled.length, 1);
    assert.deepEqual(release.requests, ['/latest.json', assetPath()]);
    assert.equal(listening(signals), 0, 'the signal handlers are gone');
  });

  test('a signal during the swap is held until the new install (or the rollback) is in place, then exit 130', async () => {
    const signals = new EventEmitter();
    const { root, parent, opts } = await install();
    publish(goodTarball);
    await assert.rejects(runUpdate({ ...opts, signals, hooks: { afterMoveAside: () => void signals.emit('SIGTERM', 'SIGTERM') } }), (err: unknown) => {
      assert.ok(err instanceof UpdateInterrupted, String(err));
      assert.match(err.message, /^SIGTERM 을\(를\) 받았지만 업데이트는 이미 끝났어요: easy-study 0\.6\.5 → 0\.7\.0\. /);
      return true;
    });
    assert.equal(await fs.readFile(path.join(root, 'VERSION'), 'utf8'), `${LATEST}\n`);
    assert.deepEqual(await fs.readdir(parent), [SERVER_TOP_DIR], 'the old install and the staging folder are gone');
    // A failed swap with a signal: rolled back, its message, exit 130.
    const second = await install();
    publish(goodTarball);
    const afterMoveAside = () => {
      signals.emit('SIGINT', 'SIGINT');
      throw new Error('disk full (test)');
    };
    const err = await refused({ ...second.opts, signals, hooks: { afterMoveAside } }, /^설치를 바꾸지 못해 이전 버전으로 되돌렸어요: disk full \(test\)$/);
    assert.ok(err instanceof UpdateInterrupted);
    assert.equal(listening(signals), 0);
  });

  test("the new install has the tarball's modes whatever the umask", async () => {
    const { root, opts } = await install();
    publish(goodTarball);
    const umask = process.umask(0o077);
    try {
      assert.equal((await runUpdate(opts)).updated, true);
    } finally {
      process.umask(umask);
    }
    const modes = Object.fromEntries(Object.entries(await snapshot(root)).map(([rel, entry]) => [rel, entry.split(' ').slice(0, 2).join(' ')]));
    assert.deepEqual(modes, {
      VERSION: 'file 644',
      bin: 'dir 755',
      [path.join('bin', 'easy-study')]: 'file 755',
      'dist-server': 'dir 755',
      [path.join('dist-server', 'server')]: 'dir 755',
      [path.join('dist-server', 'server', 'marker.txt')]: 'file 644',
      node: 'dir 755',
      [path.join('node', 'bin')]: 'dir 755',
      [path.join('node', 'bin', 'node')]: 'file 755',
      'package.json': 'file 644',
    });
    assert.equal((await fs.stat(root)).mode & 0o777, 0o755);
  });

  test('only a server install on Linux x64/arm64', async () => {
    const { root, opts } = await install();
    publish(goodTarball);
    await refused({ ...opts, platform: 'darwin' }, /리눅스\(x64, arm64\) 서버 설치본에서만 돼요 \(이 컴퓨터: darwin-x64\)/);
    await refused({ ...opts, arch: 'ia32' }, /리눅스\(x64, arm64\)/);
    await assert.rejects(checkForUpdate({ ...opts, platform: 'win32' }), /리눅스/);
    await fs.rm(path.join(root, 'VERSION'));
    await refused(opts, /서버 설치본에서만 돼요/);
    assert.deepEqual(release.requests, []);
  });

  test('an unreadable or invalid latest.json is refused', async () => {
    const { opts } = await install();
    release.latest = null;
    release.requests.length = 0;
    await refused(opts, /업데이트 정보를 받지 못했어요 .*HTTP 404/);
    release.latest = '{ not json';
    await refused(opts, /업데이트 정보를 받지 못했어요/);
    release.latest = { version: '../0.7.0', platforms: {} };
    await refused(opts, /업데이트 정보의 버전이 올바르지 않아요/);
  });
});
