// The command line of the Linux server build (server/cli.ts, DESIGN §26): argument parsing, the data folder, the
// server's environment (flags, then the environment, then the defaults), the commands it prints, and two real runs of
// `node server/cli.ts server` on a free port with a temporary library (never the default port or library).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_SERVER_PORT,
  UsageError,
  checkDataOutsideInstall,
  createDataDirs,
  dataDir,
  expandHome,
  helpText,
  parseCommandLine,
  prepareServer,
  restartCommandFor,
} from '../server/cli.ts';
import type { ServerFlags } from '../server/cli.ts';
import { repoRoot } from '../server/config.ts';
import { SERVER_LOCK_FILE_NAME } from '../server/library.ts';

const CLI = path.join(repoRoot(), 'server', 'cli.ts');
const FIXTURES = path.join(repoRoot(), 'tests', 'fixtures');
const VERSION = (JSON.parse(readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { version: string }).version;
const HOME = '/home/test';
const flags = (partial: Partial<ServerFlags> = {}): ServerFlags => ({ local: false, resetAccessCode: false, ...partial });

const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix = 'easy-study-cli-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function usage(argv: string[], message?: RegExp): void {
  assert.throws(
    () => parseCommandLine(argv, { HOME }),
    (err: unknown) => err instanceof UsageError && (!message || message.test(err.message)),
    argv.join(' '),
  );
}

describe('command line parsing', () => {
  test('help, version and update', () => {
    for (const argv of [[], ['help'], ['-h'], ['--help'], ['server', '--help'], ['server', '--port', '6000', '-h'], ['update', '--help']]) {
      assert.deepEqual(parseCommandLine(argv, { HOME }), { command: 'help' }, argv.join(' '));
    }
    for (const argv of [['version'], ['--version'], ['-v']]) assert.deepEqual(parseCommandLine(argv, { HOME }), { command: 'version' });
    assert.deepEqual(parseCommandLine(['update'], { HOME }), { command: 'update', check: false });
    assert.deepEqual(parseCommandLine(['update', '--check'], { HOME }), { command: 'update', check: true });
    usage(['version', 'extra']);
    usage(['update', '--force'], /알 수 없는 옵션: --force/);
    usage(['serve'], /알 수 없는 명령: serve/);
    usage(['--port', '6000'], /알 수 없는 명령/);
  });

  test('server flags: --flag value and --flag=value', () => {
    const spaced = parseCommandLine(['server', '--port', '6000', '--host', '127.0.0.1', '--library', '/data/lib', '--models', '/data/models', '--reset-access-code'], { HOME });
    const joined = parseCommandLine(['server', '--port=6000', '--host=127.0.0.1', '--library=/data/lib', '--models=/data/models', '--reset-access-code'], { HOME });
    const expected = { command: 'server', flags: flags({ port: 6000, host: '127.0.0.1', library: '/data/lib', models: '/data/models', resetAccessCode: true }) };
    assert.deepEqual(spaced, expected);
    assert.deepEqual(joined, expected);
    assert.deepEqual(parseCommandLine(['server'], { HOME }), { command: 'server', flags: flags() });
    assert.deepEqual(parseCommandLine(['server', '--local'], { HOME }), { command: 'server', flags: flags({ local: true }) });
  });

  test('a leading ~ is expanded with HOME', () => {
    assert.deepEqual(parseCommandLine(['server', '--library', '~/notes', '--models=~'], { HOME }), {
      command: 'server',
      flags: flags({ library: '/home/test/notes', models: '/home/test' }),
    });
    assert.equal(expandHome('~other/x', { HOME }), '~other/x');
    assert.equal(expandHome('/abs/~/x', { HOME }), '/abs/~/x');
    assert.equal(expandHome('rel', { HOME }), 'rel');
  });

  test('unknown flags, missing values and values that look like flags are usage errors', () => {
    usage(['server', '--verbose'], /알 수 없는 옵션: --verbose/);
    usage(['server', '-p', '6000'], /알 수 없는 옵션: -p/);
    usage(['server', 'extra'], /알 수 없는 옵션: extra/);
    usage(['server', '--port'], /--port 에 값이 필요해요/);
    usage(['server', '--library='], /--library 에 값이 필요해요/);
    usage(['server', '--library', '--local'], /--library 에 값이 필요해요/);
    usage(['server', '--host=--local']);
    usage(['server', '--local=yes'], /--local 에는 값을 줄 수 없어요/);
  });

  test('--local cannot be combined with --host', () => {
    usage(['server', '--local', '--host', '0.0.0.0'], /--local 과 --host 는 함께 쓸 수 없어요/);
    usage(['server', '--host=127.0.0.1', '--local'], /함께 쓸 수 없어요/);
  });

  test('the port is 1-65535', () => {
    for (const port of ['1', '65535', '5350']) {
      const parsed = parseCommandLine(['server', '--port', port], { HOME });
      assert.equal(parsed.command === 'server' && parsed.flags.port, Number(port));
    }
    for (const port of ['0', '65536', '99999', 'abc', '-1', '80.5', '1e3', ' 80']) usage(['server', `--port=${port}`], /--port 값이 올바르지 않아요/);
  });
});

describe('data folder', () => {
  test('$XDG_DATA_HOME/easy-study when it is absolute, else ~/.local/share/easy-study', () => {
    assert.equal(dataDir({ HOME, XDG_DATA_HOME: '/xdg/data' }), '/xdg/data/easy-study');
    assert.equal(dataDir({ HOME, XDG_DATA_HOME: 'relative/data' }), '/home/test/.local/share/easy-study');
    assert.equal(dataDir({ HOME, XDG_DATA_HOME: '' }), '/home/test/.local/share/easy-study');
    assert.equal(dataDir({ HOME }), '/home/test/.local/share/easy-study');
  });

  test('the help names the default folders the server really uses', () => {
    const lines = (env: NodeJS.ProcessEnv) => helpText(env).split('\n').filter((l) => /^ {2}--(library|models) /.test(l));
    assert.deepEqual(lines({ HOME }), [
      '  --library <폴더>        라이브러리 폴더 (기본 ~/.local/share/easy-study/library)',
      '  --models <폴더>         받아쓰기 모델 폴더 (기본 ~/.local/share/easy-study/models)',
    ]);
    assert.deepEqual(lines({ HOME, XDG_DATA_HOME: '/data' }), [
      '  --library <폴더>        라이브러리 폴더 (기본 /data/easy-study/library)',
      '  --models <폴더>         받아쓰기 모델 폴더 (기본 /data/easy-study/models)',
    ]);
    assert.match(helpText({ HOME, XDG_DATA_HOME: 'relative' }), /\(기본 ~\/\.local\/share\/easy-study\/library\)/);
    assert.match(helpText({ HOME: '/home/test2', XDG_DATA_HOME: '/home/test2/xdg' }), /\(기본 ~\/xdg\/easy-study\/models\)/);
    assert.match(helpText({ HOME }), /--port <번호> +포트 \(기본 5350\)/);
  });

  test('the data folder is created for the user only when a default path is used', async () => {
    const dir = await tempDir();
    const env: NodeJS.ProcessEnv = { HOME, XDG_DATA_HOME: dir };
    const plan = prepareServer(flags(), { env, root: dir, exists: () => false });
    assert.equal(plan.usesDataDir, true);
    createDataDirs(plan);
    assert.equal(statSync(path.join(dir, 'easy-study')).mode & 0o777, 0o700);
    assert.ok(statSync(path.join(dir, 'easy-study', 'library')).isDirectory());
    assert.ok(statSync(path.join(dir, 'easy-study', 'models')).isDirectory());

    const other = await tempDir();
    const explicit = prepareServer(flags({ library: path.join(other, 'lib'), models: path.join(other, 'm') }), {
      env: { HOME, XDG_DATA_HOME: path.join(other, 'xdg') },
      root: other,
      exists: () => false,
    });
    assert.equal(explicit.usesDataDir, false);
    createDataDirs(explicit);
    assert.deepEqual((await fs.readdir(other)).sort(), ['lib', 'm'], 'no data folder when both paths are given');
  });
});

describe('the server environment (prepareServer)', () => {
  const root = '/opt/easy-study-server';
  const none = () => false;

  test('library and models: the flag, then the environment, then the data folder; always absolute', () => {
    const data = '/xdg/easy-study';
    const defaults: NodeJS.ProcessEnv = { HOME, XDG_DATA_HOME: '/xdg' };
    let env = { ...defaults };
    let plan = prepareServer(flags(), { env, root, exists: none });
    assert.deepEqual([env.EASY_STUDY_LIBRARY, env.EASY_STUDY_MODELS_DIR], [`${data}/library`, `${data}/models`]);
    assert.deepEqual([plan.library, plan.models, plan.dataDir], [`${data}/library`, `${data}/models`, data]);

    env = { ...defaults, EASY_STUDY_LIBRARY: '/env/lib', EASY_STUDY_MODELS_DIR: '/env/models' };
    prepareServer(flags(), { env, root, exists: none });
    assert.deepEqual([env.EASY_STUDY_LIBRARY, env.EASY_STUDY_MODELS_DIR], ['/env/lib', '/env/models']);

    env = { ...defaults, EASY_STUDY_LIBRARY: '/env/lib', EASY_STUDY_MODELS_DIR: '/env/models' };
    prepareServer(flags({ library: '/flag/lib', models: '/flag/models' }), { env, root, exists: none });
    assert.deepEqual([env.EASY_STUDY_LIBRARY, env.EASY_STUDY_MODELS_DIR], ['/flag/lib', '/flag/models']);

    // The models folder never follows the library.
    env = { ...defaults, EASY_STUDY_LIBRARY: '  ', EASY_STUDY_MODELS_DIR: '' };
    plan = prepareServer(flags({ library: '/flag/lib' }), { env, root, exists: none });
    assert.deepEqual([env.EASY_STUDY_LIBRARY, env.EASY_STUDY_MODELS_DIR, plan.usesDataDir], ['/flag/lib', `${data}/models`, true]);

    env = { ...defaults };
    prepareServer(flags({ library: 'rel/lib' }), { env, root, exists: none });
    assert.equal(env.EASY_STUDY_LIBRARY, path.resolve('rel/lib'));
  });

  test('PORT is always set: --port or 5350, whatever the environment says', () => {
    const env: NodeJS.ProcessEnv = { HOME, PORT: '1234' };
    prepareServer(flags(), { env, root, exists: none });
    assert.equal(env.PORT, String(DEFAULT_SERVER_PORT));
    assert.equal(DEFAULT_SERVER_PORT, 5350);
    prepareServer(flags({ port: 6000 }), { env, root, exists: none });
    assert.equal(env.PORT, '6000');
  });

  test('the bundled whisper and ffmpeg only when they exist, and never over the user’s own', () => {
    const bundled = new Set([`${root}/whisper/whisper-cli`, `${root}/ffmpeg/ffmpeg`]);
    let env: NodeJS.ProcessEnv = { HOME };
    prepareServer(flags(), { env, root, exists: (file) => bundled.has(file) });
    assert.equal(env.EASY_STUDY_WHISPER, `${root}/whisper/whisper-cli`);
    assert.equal(env.EASY_STUDY_FFMPEG, `${root}/ffmpeg/ffmpeg`);

    env = { HOME };
    prepareServer(flags(), { env, root, exists: none });
    assert.equal('EASY_STUDY_WHISPER' in env, false, 'the repository: the usual lookup');
    assert.equal('EASY_STUDY_FFMPEG' in env, false);

    env = { HOME, EASY_STUDY_WHISPER: '/usr/local/bin/whisper-cli', EASY_STUDY_FFMPEG: '/usr/bin/ffmpeg' };
    prepareServer(flags(), { env, root, exists: (file) => bundled.has(file) });
    assert.equal(env.EASY_STUDY_WHISPER, '/usr/local/bin/whisper-cli');
    assert.equal(env.EASY_STUDY_FFMPEG, '/usr/bin/ffmpeg');

    env = { HOME, EASY_STUDY_WHISPER: ' ' };
    prepareServer(flags(), { env, root, exists: (file) => bundled.has(file) });
    assert.equal(env.EASY_STUDY_WHISPER, `${root}/whisper/whisper-cli`, 'an empty value counts as unset');
  });

  test('host and login: remote by default, --host keeps the login, --local is loopback without one', () => {
    let env: NodeJS.ProcessEnv = { HOME };
    assert.deepEqual(prepareServer(flags(), { env, root, exists: none }).serverArgs, ['--remote']);
    assert.equal(env.EASY_STUDY_HOST, undefined);
    assert.equal(env.EASY_STUDY_AUTH, undefined);

    // The user's own settings stay (serverMain honors them with --remote), as with npm run serve:remote.
    env = { HOME, EASY_STUDY_HOST: '127.0.0.1', EASY_STUDY_PASSWORD: 'long enough secret' };
    assert.deepEqual(prepareServer(flags(), { env, root, exists: none }).serverArgs, ['--remote']);
    assert.equal(env.EASY_STUDY_HOST, '127.0.0.1');
    assert.equal(env.EASY_STUDY_PASSWORD, 'long enough secret');

    env = { HOME, EASY_STUDY_HOST: '0.0.0.0' };
    assert.deepEqual(prepareServer(flags({ host: '100.64.0.1' }), { env, root, exists: none }).serverArgs, ['--remote']);
    assert.equal(env.EASY_STUDY_HOST, '100.64.0.1');
    assert.equal(env.EASY_STUDY_AUTH, undefined);

    env = { HOME, EASY_STUDY_HOST: '0.0.0.0', EASY_STUDY_AUTH: 'on' };
    assert.deepEqual(prepareServer(flags({ local: true }), { env, root, exists: none }).serverArgs, []);
    assert.equal(env.EASY_STUDY_HOST, '127.0.0.1');
    assert.equal(env.EASY_STUDY_AUTH, 'off');

    assert.deepEqual(prepareServer(flags({ resetAccessCode: true }), { env: { HOME }, root, exists: none }).serverArgs, ['--remote', '--reset-access-code']);
    assert.deepEqual(prepareServer(flags({ local: true, resetAccessCode: true }), { env: { HOME }, root, exists: none }).serverArgs, ['--reset-access-code']);
  });

  test('never the desktop app’s server, never node --watch', () => {
    const env: NodeJS.ProcessEnv = {
      HOME,
      EASY_STUDY_DESKTOP: '1',
      EASY_STUDY_DESKTOP_SHELL_PID: '123',
      EASY_STUDY_DESKTOPX: 'x',
      WATCH_REPORT_DEPENDENCIES: '1',
      EASY_STUDY_MAX_CLI_PROCS: '3',
    };
    prepareServer(flags(), { env, root, exists: none });
    assert.deepEqual(
      Object.keys(env).filter((key) => key.startsWith('EASY_STUDY_DESKTOP') || key === 'WATCH_REPORT_DEPENDENCIES'),
      [],
    );
    assert.equal(env.EASY_STUDY_MAX_CLI_PROCS, '3');
  });
});

describe('data inside an installed server tarball is refused', () => {
  test('library or models inside the install folder', async () => {
    const parent = await tempDir();
    const root = path.join(parent, 'easy-study-server');
    await fs.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.mkdir(path.join(root, 'node', 'bin'), { recursive: true });
    await fs.writeFile(path.join(root, 'VERSION'), '0.7.0\n');
    await fs.writeFile(path.join(root, 'bin', 'easy-study'), '');
    const plan = (library: string, models: string) =>
      prepareServer(flags({ library, models }), { env: { HOME }, root, exists: () => false });
    const outside = path.join(parent, 'data');

    // Not an install yet (no node/bin/node): the repository may keep its library inside.
    checkDataOutsideInstall(plan(path.join(root, 'library'), outside), root);
    await fs.writeFile(path.join(root, 'node', 'bin', 'node'), '');

    checkDataOutsideInstall(plan(path.join(outside, 'library'), path.join(outside, 'models')), root);
    checkDataOutsideInstall(plan(path.join(parent, 'easy-study-server-data'), outside), root);
    for (const [library, models] of [
      [path.join(root, 'library'), outside],
      [root, outside],
      [outside, path.join(root, '.cache', 'models')],
    ]) {
      assert.throws(() => checkDataOutsideInstall(plan(library, models), root), (err: unknown) => err instanceof UsageError && /설치 폴더.*안에 있어요/.test(err.message));
    }
    // Through a symbolic link into the install.
    await fs.symlink(root, path.join(parent, 'link'));
    assert.throws(() => checkDataOutsideInstall(plan(path.join(parent, 'link', 'library'), outside), root), UsageError);
  });
});

describe('restart commands (serverMain messages)', () => {
  test('easy-study server plus the flags the user gave, with the change applied', () => {
    const plain = restartCommandFor(flags());
    assert.equal(plain({ resetAccessCode: true }), 'easy-study server --reset-access-code');
    assert.equal(plain({ port: 5351 }), 'easy-study server --port 5351');
    assert.equal(plain({ library: '<다른 폴더>', port: 5351 }), "easy-study server --port 5351 --library '<다른 폴더>'");

    const given = restartCommandFor(flags({ port: 6000, library: '/x', resetAccessCode: true }));
    assert.equal(given({ resetAccessCode: true }), 'easy-study server --port 6000 --library /x --reset-access-code');
    assert.equal(given({ port: 6001 }), 'easy-study server --port 6001 --library /x --reset-access-code');

    const spaced = restartCommandFor(flags({ host: '127.0.0.1', models: '/my models', library: "/it's" }));
    assert.equal(spaced({ port: 5351 }), "easy-study server --port 5351 --host 127.0.0.1 --library '/it's' --models '/my models'");
    assert.equal(spaced({ library: '<다른 폴더>', port: 7000 }), "easy-study server --port 7000 --host 127.0.0.1 --library '<다른 폴더>' --models '/my models'");

    const local = restartCommandFor(flags({ local: true, port: 6000 }));
    assert.equal(local({ resetAccessCode: true }), 'easy-study server --port 6000 --local --reset-access-code');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real runs: node server/cli.ts, a free port, a temporary library/models/data folder, the fixtures' fake LLM CLIs.

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface CliRun {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => { stdout: string; stderr: string };
}

async function runCli(args: string[], env: Record<string, string> = {}, until?: RegExp): Promise<CliRun> {
  const data = await tempDir('easy-study-cli-data-');
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      XDG_DATA_HOME: data,
      CLAUDE_BIN: path.join(FIXTURES, 'fake-claude.mjs'),
      CODEX_BIN: path.join(FIXTURES, 'fake-codex.mjs'),
      CODEX_HOME: path.join(data, 'no-codex-home'),
      EASY_STUDY_AUTO_DIGEST: '0',
      EASY_STUDY_LIBRARY: '',
      EASY_STUDY_MODELS_DIR: '',
      EASY_STUDY_HOST: '',
      EASY_STUDY_AUTH: '',
      EASY_STUDY_PASSWORD: '',
      EASY_STUDY_TLS_CERT: '',
      EASY_STUDY_TLS_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const result = { child, exited, output: () => ({ stdout, stderr }) };
  if (until) {
    const deadline = Date.now() + 30_000;
    while (!until.test(stdout + stderr) && child.exitCode === null && child.signalCode === null) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        assert.fail(`no match for ${until}:\n${stdout}\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return result;
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

async function stop(run: CliRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGINT');
  let timer: NodeJS.Timeout | undefined;
  const exit = await Promise.race([run.exited, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 15_000)))]);
  clearTimeout(timer);
  if (exit === null) run.child.kill('SIGKILL');
  assert.deepEqual(exit, { code: 0, signal: null }, JSON.stringify(run.output()));
}

describe('node server/cli.ts', { skip: process.platform === 'win32' ? 'the server CLI is for Linux (POSIX signals)' : false }, () => {
  test('version prints the package version and nothing else; a wrong command exits 2 with help on stderr', async () => {
    const version = await runCli(['version']);
    assert.deepEqual(await version.exited, { code: 0, signal: null });
    assert.equal(version.output().stdout, `${VERSION}\n`);
    const wrong = await runCli(['serve']);
    assert.deepEqual(await wrong.exited, { code: 2, signal: null });
    assert.equal(wrong.output().stdout, '');
    assert.match(wrong.output().stderr, /알 수 없는 명령: serve\n\neasy-study/);
    assert.match(wrong.output().stderr, /easy-study server \[옵션\]/);
  });

  test('server --local: this computer only, no login', async () => {
    const dir = await tempDir();
    const port = await freePort();
    const library = path.join(dir, 'library');
    const models = path.join(dir, 'models');
    const run = await runCli(['server', '--local', '--port', String(port), '--library', library, '--models', models], {}, /library {5}→/);
    try {
      const { stdout } = run.output();
      assert.ok(stdout.includes(`http://127.0.0.1:${port}`), stdout);
      assert.doesNotMatch(stdout, /접속 코드/);
      const health = await get(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200, health.body);
      assert.equal((JSON.parse(health.body) as { libraryDir: string }).libraryDir, library);
      assert.ok(statSync(models).isDirectory());
    } finally {
      await stop(run);
    }
  });

  test('server: login with the access code of the banner, the reset command names easy-study server', async () => {
    const dir = await tempDir();
    const port = await freePort();
    const library = path.join(dir, 'library');
    const models = path.join(dir, 'models');
    // EASY_STUDY_HOST=127.0.0.1 keeps the test off the network; the login stays on as with 0.0.0.0.
    const run = await runCli(['server', '--port', String(port), '--library', library, '--models', models], { EASY_STUDY_HOST: '127.0.0.1' }, /library {5}→/);
    try {
      const { stdout } = run.output();
      const code = /바로 로그인 → {2}http:\/\/127\.0\.0\.1:\d+\/login\?code=([0-9A-Za-z-]+)/.exec(stdout)?.[1];
      assert.ok(code, stdout);
      assert.ok(stdout.includes(`코드를 바꾸고 모든 로그인을 끊으려면: easy-study server --port ${port} --library ${library} --models ${models} --reset-access-code`), stdout);
      assert.doesNotMatch(stdout, /npm run/);
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await get(`${base}/api/health`)).status, 401);
      const health = await get(`${base}/api/health`, { Authorization: `Bearer ${code}` });
      assert.equal(health.status, 200, health.body);
      assert.equal((JSON.parse(health.body) as { version?: string }).version, VERSION);
      await fs.access(path.join(library, '.auth.json'));
    } finally {
      await stop(run);
    }
  });

  test('a port in use and a library in use: the hints are easy-study server commands', async () => {
    const dir = await tempDir();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    const library = path.join(dir, 'library');
    const models = path.join(dir, 'models');
    try {
      const busy = await runCli(['server', '--local', '--port', String(port), '--library', library, '--models', models]);
      assert.deepEqual(await busy.exited, { code: 1, signal: null });
      assert.ok(
        busy.output().stderr.includes(`다른 포트로 실행하세요: easy-study server --port ${port + 1} --local --library ${library} --models ${models}`),
        busy.output().stderr,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }

    // A live holder (this test process) of the library's lock.
    await fs.writeFile(path.join(library, SERVER_LOCK_FILE_NAME), JSON.stringify({ pid: process.pid, port: 5999, startedAt: new Date().toISOString() }));
    const locked = await runCli(['server', '--local', '--port', String(await freePort()), '--library', library, '--models', models]);
    assert.deepEqual(await locked.exited, { code: 1, signal: null });
    assert.match(locked.output().stderr, /easy-study가 이미 이 라이브러리로 실행 중입니다/);
    assert.ok(
      locked.output().stderr.includes(`다른 라이브러리로 하나 더 띄우려면: easy-study server --port 6000 --local --library '<다른 폴더>' --models ${models}`),
      locked.output().stderr,
    );
  });
});
