// Command line of the Linux server build (DESIGN §26): the tarball's bin/easy-study runs the bundled Node on this file
// (compiled: dist-server/server/cli.js).
//
//   easy-study server [--port <n>] [--host <addr> | --local] [--library <dir>] [--models <dir>] [--reset-access-code]
//   easy-study update [--check]
//   easy-study version
//
// Only config.ts and node builtins are imported up front: `version` and `help` answer without loading the server, and
// the server (server/index.ts) is loaded only for `server`, the updater (server/selfUpdate.ts) only for `update`.
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './config.ts';
import type { RestartCommand } from './index.ts';

/** The port `easy-study server` opens without --port (the desktop app's port too). */
export const DEFAULT_SERVER_PORT = 5350;

/** Files that make a directory an installed server tarball (not the repository). */
export const SERVER_INSTALL_MARKERS: readonly string[] = ['VERSION', path.join('bin', 'easy-study'), path.join('node', 'bin', 'node')];

/**
 * Whether `root` is an installed server tarball: VERSION, bin/easy-study and node/bin/node all exist (the same rule
 * as server/selfUpdate.ts isServerInstall, which cannot import this module: see there).
 */
export function isServerInstall(root: string, exists: (file: string) => boolean = existsSync): boolean {
  return SERVER_INSTALL_MARKERS.every((marker) => exists(path.join(root, marker)));
}

/** A wrong command line: help goes to stderr and the exit code is 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The flags of `easy-study server` (paths with a leading ~ already expanded, not yet resolved). */
export interface ServerFlags {
  port?: number;
  host?: string;
  local: boolean;
  library?: string;
  models?: string;
  resetAccessCode: boolean;
}

export type Command =
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'update'; check: boolean }
  | { command: 'server'; flags: ServerFlags };

/** The help text, with the default folders dataDir(env) gives (under HOME shown as ~). */
export function helpText(env: NodeJS.ProcessEnv = process.env): string {
  const data = dataDir(env);
  const home = env.HOME?.trim() || os.homedir();
  const shown = (dir: string) => (dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir);
  return `easy-study — 강의 PDF 공부 서버 (리눅스)

사용법:
  easy-study server [옵션]       서버를 엽니다: 다른 기기(태블릿, 노트북)에서 접속할 주소와 접속 코드가 여기 나와요
  easy-study update [--check]    최신 버전으로 업데이트합니다 (--check: 확인만)
  easy-study version             버전을 출력합니다
  easy-study help                이 도움말

server 옵션:
  --port <번호>           포트 (기본 ${DEFAULT_SERVER_PORT})
  --host <주소>           이 주소에서만 엽니다 (예: 127.0.0.1 — tailscale serve 같은 리버스 프록시 뒤). 로그인은 그대로 필요해요
  --local                 이 컴퓨터에서만(127.0.0.1), 로그인 없이 엽니다
  --library <폴더>        라이브러리 폴더 (기본 ${shown(path.join(data, 'library'))})
  --models <폴더>         받아쓰기 모델 폴더 (기본 ${shown(path.join(data, 'models'))})
  --reset-access-code     접속 코드를 새로 만들고 모든 로그인을 끊어요

터미널을 닫으면 서버도 꺼져요 (계속 켜 두려면 tmux 또는 systemd 사용자 유닛).
`;
}

/** `~` or `~/…` at the start of a path, expanded with HOME. */
export function expandHome(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (value !== '~' && !value.startsWith('~/')) return value;
  const home = env.HOME?.trim() || os.homedir();
  return value === '~' ? home : path.join(home, value.slice(2));
}

/**
 * Where the server keeps its data unless told otherwise: `$XDG_DATA_HOME/easy-study` when XDG_DATA_HOME is an
 * absolute path (the XDG spec ignores relative ones), else `$HOME/.local/share/easy-study`. It holds library/ and
 * models/, outside the install, which an update replaces as a whole.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'easy-study');
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.local', 'share', 'easy-study');
}

const VALUE_FLAGS = new Set(['--port', '--host', '--library', '--models']);
const SWITCHES = new Set(['--local', '--reset-access-code']);

function parsePort(value: string): number {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new UsageError(`--port 값이 올바르지 않아요: "${value}" (1-65535)`);
  return port;
}

function parseServerFlags(args: readonly string[], env: NodeJS.ProcessEnv): ServerFlags | 'help' {
  const flags: ServerFlags = { local: false, resetAccessCode: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') return 'help';
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (SWITCHES.has(name)) {
      if (eq > 0) throw new UsageError(`${name} 에는 값을 줄 수 없어요`);
      if (name === '--local') flags.local = true;
      else flags.resetAccessCode = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`알 수 없는 옵션: ${arg}`);
    let value: string | undefined;
    if (eq > 0) value = arg.slice(eq + 1);
    else value = args[++i];
    if (value === undefined || value === '') throw new UsageError(`${name} 에 값이 필요해요`);
    if (value.startsWith('--')) throw new UsageError(`${name} 에 값이 필요해요 (받은 값: ${value})`);
    if (name === '--port') flags.port = parsePort(value);
    else if (name === '--host') flags.host = value;
    else if (name === '--library') flags.library = expandHome(value, env);
    else flags.models = expandHome(value, env);
  }
  if (flags.local && flags.host !== undefined) throw new UsageError('--local 과 --host 는 함께 쓸 수 없어요');
  return flags;
}

/** The command line (process.argv.slice(2)) as a command. Throws UsageError for anything it does not know. */
export function parseCommandLine(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Command {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'help' || first === '-h' || first === '--help') return { command: 'help' };
  if (first === 'version' || first === '--version' || first === '-v') {
    if (rest.length > 0) throw new UsageError(`알 수 없는 인자: ${rest[0]}`);
    return { command: 'version' };
  }
  if (first === 'update') {
    let check = false;
    for (const arg of rest) {
      if (arg === '-h' || arg === '--help') return { command: 'help' };
      if (arg === '--check') check = true;
      else throw new UsageError(`알 수 없는 옵션: ${arg}`);
    }
    return { command: 'update', check };
  }
  if (first === 'server') {
    const flags = parseServerFlags(rest, env);
    return flags === 'help' ? { command: 'help' } : { command: 'server', flags };
  }
  throw new UsageError(`알 수 없는 명령: ${first}`);
}

/** What `easy-study server` hands to the server (server/index.ts serverMain), once the environment is set. */
export interface ServerPlan {
  /** The server's command line flags: ['--remote'] (remote mode) or [] (--local), plus --reset-access-code. */
  serverArgs: string[];
  /** Absolute library folder (EASY_STUDY_LIBRARY). */
  library: string;
  /** Absolute models folder (EASY_STUDY_MODELS_DIR). */
  models: string;
  /** The data folder (dataDir()). */
  dataDir: string;
  /** Whether the library or the models folder is the default one inside the data folder. */
  usesDataDir: boolean;
}

/**
 * Sets the server's environment for `easy-study server` (DESIGN §26): flags first, then the user's environment, then
 * the defaults. Mutates `env` (process.env when run for real).
 */
export function prepareServer(
  flags: ServerFlags,
  { env = process.env, root = repoRoot(), exists = existsSync }: { env?: NodeJS.ProcessEnv; root?: string; exists?: (file: string) => boolean } = {},
): ServerPlan {
  // Not the desktop app's server (DESIGN §19), and not node --watch.
  for (const key of Object.keys(env)) {
    if (key.startsWith('EASY_STUDY_DESKTOP') || key === 'WATCH_REPORT_DEPENDENCIES') delete env[key];
  }
  // The port is part of the command's contract: a PORT left in the environment does not move it.
  env.PORT = String(flags.port ?? DEFAULT_SERVER_PORT);

  const data = dataDir(env);
  const envLibrary = env.EASY_STUDY_LIBRARY?.trim();
  const envModels = env.EASY_STUDY_MODELS_DIR?.trim();
  const library = path.resolve(flags.library ?? (envLibrary || path.join(data, 'library')));
  const models = path.resolve(flags.models ?? (envModels || path.join(data, 'models')));
  const usesDataDir = (flags.library === undefined && !envLibrary) || (flags.models === undefined && !envModels);
  env.EASY_STUDY_LIBRARY = library;
  env.EASY_STUDY_MODELS_DIR = models;

  // The bundled recording tools, unless the user points at others. In the repository there are none: the usual
  // lookup (server/recordings/asr.ts) applies.
  const tools: [string, string][] = [
    ['EASY_STUDY_WHISPER', path.join(root, 'whisper', 'whisper-cli')],
    ['EASY_STUDY_FFMPEG', path.join(root, 'ffmpeg', 'ffmpeg')],
  ];
  for (const [name, bundled] of tools) {
    if (!env[name]?.trim() && exists(bundled)) env[name] = bundled;
  }

  const serverArgs: string[] = [];
  if (flags.local) {
    env.EASY_STUDY_HOST = '127.0.0.1';
    env.EASY_STUDY_AUTH = 'off';
  } else {
    // --remote: 0.0.0.0 with the login on, unless EASY_STUDY_HOST / EASY_STUDY_AUTH say otherwise (serverMain).
    if (flags.host !== undefined) env.EASY_STUDY_HOST = flags.host;
    serverArgs.push('--remote');
  }
  if (flags.resetAccessCode) serverArgs.push('--reset-access-code');
  return { serverArgs, library, models, dataDir: data, usesDataDir };
}

/** `p` with symbolic links of its existing part resolved (the rest may not exist yet). */
function realish(p: string): string {
  const rest: string[] = [];
  let dir = path.resolve(p);
  for (;;) {
    try {
      return path.join(realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(p);
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Refuses a library or models folder inside an installed server tarball: `easy-study update` replaces the install
 * folder as a whole, and the data would go with it.
 */
export function checkDataOutsideInstall(plan: ServerPlan, root: string = repoRoot(), exists: (file: string) => boolean = existsSync): void {
  if (!isServerInstall(root, exists)) return;
  const install = realish(root);
  for (const [what, dir] of [
    ['라이브러리', plan.library],
    ['모델', plan.models],
  ] as const) {
    if (isInside(realish(dir), install)) {
      throw new UsageError(`${what} 폴더(${dir})가 설치 폴더(${root}) 안에 있어요: 업데이트하면 지워지니 다른 폴더를 지정하세요`);
    }
  }
}

/** Creates the data folder (only for the user: 0700) when a default path is used, then the library and models folders. */
export function createDataDirs(plan: ServerPlan): void {
  if (plan.usesDataDir) mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(plan.library, { recursive: true });
  mkdirSync(plan.models, { recursive: true });
}

function quote(value: string): string {
  return /[\s<>'"$&|;]/.test(value) ? `'${value}'` : value;
}

/**
 * The command line that starts the server again with `change` applied: `easy-study server` plus the flags the user
 * gave (for the startup banner's reset hint and the "port in use" / "library in use" messages of serverMain).
 */
export function restartCommandFor(flags: ServerFlags): RestartCommand {
  return (change) => {
    const parts = ['easy-study', 'server'];
    const port = change.port ?? flags.port;
    if (port !== undefined) parts.push('--port', String(port));
    if (flags.host !== undefined) parts.push('--host', quote(flags.host));
    if (flags.local) parts.push('--local');
    const library = change.library ?? flags.library;
    if (library !== undefined) parts.push('--library', quote(library));
    if (flags.models !== undefined) parts.push('--models', quote(flags.models));
    if (flags.resetAccessCode || change.resetAccessCode) parts.push('--reset-access-code');
    return parts.join(' ');
  };
}

/** The version of this install (package.json). */
export function installedVersion(root: string = repoRoot()): string {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error(`${path.join(root, 'package.json')}: no version`);
  return pkg.version;
}

async function serverCommand(flags: ServerFlags): Promise<void> {
  const root = repoRoot();
  const plan = prepareServer(flags, { root });
  try {
    checkDataOutsideInstall(plan, root);
  } catch (err) {
    console.error(`설정 오류: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  try {
    createDataDirs(plan);
  } catch (err) {
    console.error(`폴더를 만들 수 없어요: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  // Every reader of process.argv.slice(2) (desktopMode among them) sees only the server's flags.
  process.argv.splice(2, Infinity, ...plan.serverArgs);
  const { serverMain } = await import('./index.ts');
  await serverMain(plan.serverArgs, restartCommandFor(flags));
}

/** `easy-study update [--check]`: 0, 1 (refused or failed) or 130 (stopped by Ctrl+C, SIGTERM or SIGHUP). */
async function updateCommand(check: boolean): Promise<number> {
  const { UpdateError, UpdateInterrupted, checkForUpdate, runUpdate } = await import('./selfUpdate.ts');
  try {
    const result = check ? await checkForUpdate({ root: repoRoot() }) : await runUpdate({ root: repoRoot() });
    console.log(result.message);
    return 0;
  } catch (err) {
    console.error(err instanceof UpdateError ? err.message : `업데이트하지 못했어요: ${(err as Error).message ?? String(err)}`);
    return err instanceof UpdateInterrupted ? 130 : 1;
  }
}

/** Runs the command line `argv` (process.argv.slice(2)); sets process.exitCode. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let command: Command;
  try {
    command = parseCommandLine(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\n\n${helpText()}`);
    process.exitCode = 2;
    return;
  }
  switch (command.command) {
    case 'help':
      process.stdout.write(helpText());
      return;
    case 'version':
      process.stdout.write(`${installedVersion()}\n`);
      return;
    case 'update':
      process.exitCode = await updateCommand(command.check);
      return;
    case 'server':
      await serverCommand(command.flags);
      return;
  }
}

if (import.meta.main) {
  await main();
}
