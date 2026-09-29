// Desktop mode (DESIGN §19): the server as the back end of the desktop app. The app's shell starts it with
// EASY_STUDY_DESKTOP=1, EASY_STUDY_LIBRARY (the library folder) and PORT (a remembered port, 0 = any), stdin,
// stdout and stderr piped, as the leader of its own process group (POSIX). Then:
//
// - Local mode by default: 127.0.0.1, no login, plain HTTP. EASY_STUDY_DESKTOP_SHARE=1 ("다른 기기에서 접속 허용",
//   set only by the shell) = remote mode on 0.0.0.0 with the generated access code of `<library>/.auth.json` and the
//   login on (§16); the code is never printed on stdout (the shell copies stdout into server.log) — the shell reads it
//   from the file. EASY_STUDY_DESKTOP_RESET_CODE=1 makes a new code at this start and ends every login
//   (--reset-access-code). The user's EASY_STUDY_HOST / EASY_STUDY_AUTH / EASY_STUDY_TLS_* do not apply (§16 remote
//   mode from a terminal is `npm run serve:remote`).
// - After listening, exactly one machine-readable line on stdout (after the usual banner):
//     EASY_STUDY_READY {"url":"http://127.0.0.1:<port>","port":<port>}
//   With sharing on it gains one key, `"share":{"urls":["http://192.168.0.10:<port>",…]}` (server/shellWatch.ts
//   readyLine): the addresses other devices can use, physical adapters first, the host name last.
// - The shell holds the write end of the stdin pipe for as long as it lives. EOF (the app quit, crashed or
//   was killed — on every OS the pipe closes with the process) stops the server gracefully, like SIGTERM. A
//   parent watchdog covers a pipe that stays open anyway (an inherited handle).
// - A repeated SIGTERM / SIGHUP / EOF does not cut the graceful stop short (Linux PR_SET_PDEATHSIG delivers
//   SIGTERM once per exiting thread of the shell, 5-11 times were measured); only a second SIGINT forces it.
// - A failure before listening (library locked by `npm start`, port taken, configuration) ends in a short
//   Korean message at the end of stderr — the shell shows the tail of stderr — and exit code 1; a port that
//   another program holds exits with EXIT_PORT_IN_USE (3), so the shell can try another port.
// - Every child process is gone when the server exits, whatever the path (server/children.ts): the graceful
//   stop ends them, the exit hook kills what is left, and on POSIX the process group gets SIGTERM for the
//   grandchildren of the CLIs.
// - `GET /api/desktop/busy` (DESIGN §24) tells the shell what a restart would interrupt before it installs an
//   update or restarts the server for a setting: registered only in desktop mode (`desktop: true` in the
//   options), 404 otherwise. With sharing on it is behind the login like every /api route (the shell sends
//   `Authorization: Bearer <code>` over loopback).
//
// The loopback proxy the shell runs for plain-http remotes is a separate entry (server/proxy.ts). Outside desktop
// mode none of this applies: stdin is never read (`npm start` in a terminal, or with stdin closed), and the banner
// and signal handling of server/index.ts are unchanged.
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DesktopBusyResponse } from '../shared/types.ts';
import { runningTurnCount } from './chat.ts';
import { signalProcessGroupOnExit } from './children.ts';
import { ConfigError, fallbackFontProblem, isLoopbackHost, libraryDir } from './config.ts';
import { digestCallsInFlight } from './digest.ts';
import type { RunningServer, ServerOptions } from './index.ts';
import { LibraryLockedError, readStoredDoc } from './library.ts';
import { currentLiveRecording, queueState, recordingsConfig } from './recordings/service.ts';
import { readyLine, stopSignals, watchShell } from './shellWatch.ts';

// The helpers the shell's children share live in shellWatch.ts (the proxy imports them without the server).
export { READY_PREFIX, readyLine, shellAlive, watchShell } from './shellWatch.ts';
export type { ReadyShare, ShellWatchOptions } from './shellWatch.ts';

/**
 * Path prefix of the desktop app's page actions (DESIGN §24): a page in the app's window navigates to
 * `<origin>/__easy-study-desktop/<action>`, and the shell cancels that navigation and acts. The server answers the
 * prefix with 204 in every mode, so a navigation that ever gets through leaves the page where it is.
 */
export const DESKTOP_ACTION_PATH = '/__easy-study-desktop';

/** How long a graceful stop may take before the server exits anyway (below the shell's own wait). */
export const DESKTOP_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Exit code when the port is held by another program (the shell may retry with another port). */
export const EXIT_PORT_IN_USE = 3;

const ON_VALUES = ['1', 'true', 'on', 'yes'];

/** PORT in desktop mode: unset = 0 (any free port; the ready line tells which), otherwise 0-65535. */
export function desktopPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT?.trim() ?? '';
  if (raw === '') return 0;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > 65_535) throw new ConfigError(`PORT 값이 올바르지 않습니다: "${raw}" (0~65535)`);
  return value;
}

/** EASY_STUDY_DESKTOP_SHARE=1|true|on|yes: "다른 기기에서 접속 허용" — the server binds every interface with the login on. */
export function desktopShare(env: NodeJS.ProcessEnv = process.env): boolean {
  return ON_VALUES.includes(env.EASY_STUDY_DESKTOP_SHARE?.trim().toLowerCase() ?? '');
}

/** EASY_STUDY_DESKTOP_RESET_CODE=1: "접속 코드 새로 만들기" — a new generated code at this start, every login ended. */
export function desktopResetCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return ON_VALUES.includes(env.EASY_STUDY_DESKTOP_RESET_CODE?.trim().toLowerCase() ?? '');
}

/** Environment variables of §16 that desktop mode ignores, with values that would have changed something. */
export function ignoredNetworkSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const ignored: string[] = [];
  const hostValue = env.EASY_STUDY_HOST?.trim();
  if (hostValue && !isLoopbackHost(hostValue)) ignored.push('EASY_STUDY_HOST');
  if (ON_VALUES.includes(env.EASY_STUDY_AUTH?.trim().toLowerCase() ?? '')) ignored.push('EASY_STUDY_AUTH');
  for (const name of ['EASY_STUDY_TLS_CERT', 'EASY_STUDY_TLS_KEY']) if (env[name]?.trim()) ignored.push(name);
  return ignored;
}

/**
 * startServer options of desktop mode: local mode on 127.0.0.1 and desktopPort() with the desktop-only routes, or
 * with EASY_STUDY_DESKTOP_SHARE remote mode on every interface (auth 'on', a generated code: `password: null`).
 * Throws ConfigError without EASY_STUDY_LIBRARY (the default library inside the installed app is read-only or inside
 * its signature).
 */
export function desktopServerOptions(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  if (!env.EASY_STUDY_LIBRARY?.trim()) {
    throw new ConfigError('데스크톱 모드에는 라이브러리 폴더가 필요합니다 (EASY_STUDY_LIBRARY).');
  }
  const share = desktopShare(env);
  return {
    port: desktopPort(env),
    host: share ? '0.0.0.0' : '127.0.0.1',
    auth: share ? 'on' : 'off',
    password: null,
    tls: null,
    desktop: true,
    ...(desktopResetCode(env) ? { resetAccessCode: true } : {}),
  };
}

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

/**
 * 0 = a physical adapter (Wi‑Fi, Ethernet), 2 = a tunnel, bridge or virtual adapter (VPN, Tailscale, Docker, VMs,
 * Apple's awdl/llw/anpi/ap), 1 = unknown. The interface order of the OS is kept within a rank.
 */
export function interfaceRank(name: string): number {
  const n = name.toLowerCase();
  if (/^(utun|tun|tap|wg|tailscale|ts\d|zt|bridge|br-|docker|veth|virbr|vmnet|vboxnet|anpi|awdl|llw|ap\d|gif|stf|ppp|ipsec|lo)/.test(n)) return 2;
  if (/(vethernet|virtual|hyper-v|vpn|tailscale|docker|wsl|vmware|virtualbox|bluetooth|loopback)/.test(n)) return 2;
  if (/^(en|eth|eno|ens|enp|enx|wlan|wlp|wlx|wl\d)/.test(n) || /(wi-fi|wifi|ethernet|이더넷|무선)/.test(n)) return 0;
  return 1;
}

/**
 * The addresses other devices can use for a shared desktop server (the ready line's `share.urls`, shown in the
 * chooser and in ⚙ 설정): every non-internal IPv4 address except link-local ones, physical adapters first, then
 * the host name last — it resolves only on networks with mDNS/DNS for it, so it is left out on Windows without a
 * domain suffix (a bare `DESKTOP-XXXX` name). IPv4 only: the server binds 0.0.0.0.
 */
export function shareUrls(
  port: number,
  interfaces: NetworkInterfaces = os.networkInterfaces(),
  hostname: string = os.hostname(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const ranked: Array<{ rank: number; url: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== 'IPv4' && family !== 4) || isIP(entry.address) !== 4 || entry.address.startsWith('169.254.')) continue;
      const url = `http://${entry.address}:${port}`;
      if (!ranked.some((r) => r.url === url)) ranked.push({ rank: interfaceRank(name), url });
    }
  }
  const urls = ranked.sort((a, b) => a.rank - b.rank).map((r) => r.url); // Array.prototype.sort is stable
  const name = hostname.trim();
  if (/^[a-z0-9][a-z0-9.-]*$/i.test(name) && isIP(name) === 0 && !(platform === 'win32' && !name.includes('.'))) {
    urls.push(`http://${name.toLowerCase()}:${port}`);
  }
  return urls;
}

/**
 * GET /api/desktop/busy: what stopping this server would interrupt. The shell asks before it installs an update (the
 * server is stopped first) and turns the answer into a warning; the page in the window answers for itself
 * (`window.__easyStudyBusy`), this covers browser tabs opened with "브라우저에서 열기" too. Cheap and without side
 * effects: no version probes (asrStatus() would run whisper-cli and ffmpeg and start queued transcriptions).
 */
export async function desktopBusy(): Promise<DesktopBusyResponse> {
  const live = await currentLiveRecording();
  const queue = queueState();
  const { models } = recordingsConfig();
  const doc = live ? await readStoredDoc(live.docId).catch(() => null) : null;
  return {
    recording: live ? { id: live.id, docId: live.docId, status: live.status, title: live.title, docTitle: doc?.title ?? null } : null,
    transcriptions: queue.queued + (queue.running ? 1 : 0),
    digests: digestCallsInFlight(),
    chatTurns: runningTurnCount(),
    modelDownloads: models.catalog.models.filter((m) => models.isDownloading(m.id)).length,
  };
}

/** File system errors on the library folder itself (the first thing startup writes is its lock file). */
const LIBRARY_PROBLEMS: Record<string, string> = {
  EACCES: '라이브러리 폴더에 쓸 권한이 없습니다',
  EPERM: '라이브러리 폴더에 쓸 권한이 없습니다',
  EROFS: '라이브러리 폴더가 읽기 전용입니다',
  EEXIST: '라이브러리 폴더 자리에 폴더가 아닌 파일이 있습니다',
  ENOTDIR: '라이브러리 폴더 경로에 폴더가 아닌 파일이 있습니다',
  EISDIR: '라이브러리 폴더를 쓸 수 없습니다',
  ENOENT: '라이브러리 폴더를 찾을 수 없습니다',
  ENOSPC: '디스크 공간이 부족해서 라이브러리 폴더에 쓸 수 없습니다',
};

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why desktop mode could not start, in Korean, for the shell's error screen (it shows the tail of stderr, so
 * the message is short and names what the user can do in the app). `known` is false for unexpected errors,
 * whose stack trace is worth logging before the message. `exitCode` is EXIT_PORT_IN_USE for a taken port, 1 otherwise.
 */
export function startupFailureMessage(err: unknown, port: number): { message: string; known: boolean; exitCode: number } {
  if (err instanceof ConfigError) return { message: `설정 오류: ${err.message}`, known: true, exitCode: 1 };
  if (err instanceof LibraryLockedError) {
    const { holder } = err;
    return {
      known: true,
      exitCode: 1,
      message: [
        `이 라이브러리 폴더는 다른 easy-study가 이미 쓰고 있습니다 (pid ${holder.pid}, 포트 ${holder.port}).`,
        `  라이브러리: ${libraryDir()}`,
        '  같은 폴더를 두 서버가 함께 쓰면 서로의 작업을 망가뜨리므로 시작하지 않았습니다.',
        '  그 easy-study(예: 터미널에서 실행한 npm start)를 끄거나, 다른 라이브러리 폴더를 고르세요.',
        `  실행 중인 easy-study가 없는데도 이 메시지가 나오면 잠금 파일을 지우세요: ${err.lockFile}`,
      ].join('\n'),
    };
  }
  const errno = err as NodeJS.ErrnoException | null;
  if (errno?.code === 'EADDRINUSE') {
    return {
      known: true,
      exitCode: EXIT_PORT_IN_USE,
      message: `포트 ${port}을(를) 다른 프로그램이 이미 쓰고 있어서 서버를 시작하지 못했습니다. 앱을 다시 실행해 보세요.`,
    };
  }
  const code = errno?.code ?? '';
  if (Object.hasOwn(LIBRARY_PROBLEMS, code) && typeof errno?.path === 'string' && isInside(errno.path, libraryDir())) {
    return {
      known: true,
      exitCode: 1,
      message: `${LIBRARY_PROBLEMS[code]} (${code}): ${libraryDir()}\n  다른 라이브러리 폴더를 고르거나, 이 폴더를 확인해 주세요.`,
    };
  }
  return { known: false, exitCode: 1, message: `서버를 시작하지 못했습니다: ${describe(err)}` };
}

/** Exits with `code` once what was written to stdout and stderr is out (pipes may be asynchronous). */
function exitAfterOutput(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
  setTimeout(() => process.exit(code), 2_000).unref();
}

/** main() of server/index.ts in desktop mode. */
export async function runDesktopServer(start: (options: ServerOptions) => Promise<RunningServer>): Promise<void> {
  // The output goes to pipes of the shell: once the shell is gone, a write must not crash the server (EPIPE).
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  signalProcessGroupOnExit();

  let running: RunningServer | null = null;
  let stopReason: string | null = null;

  const shutdown = (server: RunningServer, reason: string) => {
    console.log(`\n[desktop] ${reason}: 종료하는 중…`);
    setTimeout(() => process.exit(0), DESKTOP_SHUTDOWN_TIMEOUT_MS).unref();
    server
      .close()
      .catch((err: unknown) => console.error('종료 중 오류:', err))
      .finally(() => process.exit(0));
  };
  const requestStop = (reason: string) => {
    if (stopReason !== null) return; // already stopping: let the graceful stop finish
    stopReason = reason;
    if (running) shutdown(running, reason);
    // Still starting: stopped as soon as it has started (below).
  };
  // Registered before starting, so that an early signal or EOF is a stop, not a crash.
  for (const signal of stopSignals()) {
    process.on(signal, () => {
      if (signal === 'SIGINT' && stopReason !== null) {
        console.log('[desktop] SIGINT: 바로 종료합니다');
        process.exit(1);
      }
      requestStop(signal);
    });
  }
  watchShell(requestStop);

  let port = 0;
  try {
    const options = desktopServerOptions();
    port = options.port ?? 0;
    const ignored = ignoredNetworkSettings();
    if (ignored.length > 0) {
      const how = desktopShare() ? '공유 여부는 앱 설정이 정합니다' : '이 컴퓨터에서만, 로그인 없이 열립니다';
      console.warn(`[desktop] ${ignored.join(', ')} 설정은 데스크톱 앱에서 쓰지 않습니다 (${how}).`);
    }
    running = await start(options);
  } catch (err) {
    const { message, known, exitCode } = startupFailureMessage(err, port);
    if (!known) console.error(err);
    console.error(message);
    exitAfterOutput(exitCode);
    return;
  }

  if (stopReason !== null) {
    shutdown(running, stopReason);
    return;
  }
  const actualPort = (running.server.address() as AddressInfo).port;
  console.log(`\n  easy-study (desktop)  →  ${running.url}`);
  // Shared: the addresses, never the code (stdout ends up in server.log; the shell reads the code from .auth.json).
  const share = running.access ? { urls: shareUrls(actualPort) } : undefined;
  if (share) {
    console.log('  다른 기기에서   →  ' + (share.urls.length > 0 ? share.urls.join('  ') : '(네트워크 주소를 찾지 못했습니다)'));
    if (running.access?.sessionsRevoked) console.log('  이전 로그인은 모두 끊었습니다 (접속 코드가 바뀌었습니다).');
  }
  console.log(`  library     →  ${libraryDir()}\n`);
  const fontProblem = fallbackFontProblem();
  if (fontProblem) console.warn(`  ${fontProblem}\n`);
  console.log(readyLine(running.url, actualPort, share));
}
