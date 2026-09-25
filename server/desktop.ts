// Desktop mode (DESIGN §19): the server as the back end of the desktop app. The app's shell starts it with
// EASY_STUDY_DESKTOP=1, EASY_STUDY_LIBRARY (the library folder) and PORT (a remembered port, 0 = any), stdin,
// stdout and stderr piped, as the leader of its own process group (POSIX). Then:
//
// - Local mode only: 127.0.0.1, no login, plain HTTP. EASY_STUDY_HOST / EASY_STUDY_AUTH / EASY_STUDY_TLS_* do
//   not apply (the app opens the page without an access code; §16 remote mode is `npm run serve:remote`).
// - After listening, exactly one machine-readable line on stdout (after the usual banner):
//     EASY_STUDY_READY {"url":"http://127.0.0.1:<port>","port":<port>}
// - The shell holds the write end of the stdin pipe for as long as it lives. EOF (the app quit, crashed or
//   was killed — on every OS the pipe closes with the process) stops the server gracefully, like SIGTERM. A
//   parent watchdog covers a pipe that stays open anyway (an inherited handle).
// - A repeated SIGTERM / SIGHUP / EOF does not cut the graceful stop short (Linux PR_SET_PDEATHSIG delivers
//   SIGTERM once per exiting thread of the shell, 5-11 times were measured); only a second SIGINT forces it.
// - A failure before listening (library locked by `npm start`, port taken, configuration) ends in a short
//   Korean message at the end of stderr — the shell shows the tail of stderr — and exit code 1.
// - Every child process is gone when the server exits, whatever the path (server/children.ts): the graceful
//   stop ends them, the exit hook kills what is left, and on POSIX the process group gets SIGTERM for the
//   grandchildren of the CLIs.
//
// Outside desktop mode none of this applies: stdin is never read (`npm start` in a terminal, or with stdin
// closed), and the banner and signal handling of server/index.ts are unchanged.
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { signalProcessGroupOnExit } from './children.ts';
import { ConfigError, fallbackFontProblem, isLoopbackHost, libraryDir } from './config.ts';
import type { RunningServer, ServerOptions } from './index.ts';
import { LibraryLockedError } from './library.ts';

/** First word of the ready line. */
export const READY_PREFIX = 'EASY_STUDY_READY';

/** How long a graceful stop may take before the server exits anyway (below the shell's own wait). */
export const DESKTOP_SHUTDOWN_TIMEOUT_MS = 5_000;

/** How often the parent watchdog looks at the parent process. */
const PARENT_CHECK_MS = 2_000;

/** The one line the shell waits for: `EASY_STUDY_READY {"url":"http://127.0.0.1:<port>","port":<port>}`. */
export function readyLine(url: string, port: number): string {
  return `${READY_PREFIX} ${JSON.stringify({ url, port })}`;
}

/** PORT in desktop mode: unset = 0 (any free port; the ready line tells which), otherwise 0-65535. */
export function desktopPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT?.trim() ?? '';
  if (raw === '') return 0;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > 65_535) throw new ConfigError(`PORT 값이 올바르지 않습니다: "${raw}" (0~65535)`);
  return value;
}

/** Environment variables of §16 that desktop mode ignores, with values that would have changed something. */
export function ignoredNetworkSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const ignored: string[] = [];
  const hostValue = env.EASY_STUDY_HOST?.trim();
  if (hostValue && !isLoopbackHost(hostValue)) ignored.push('EASY_STUDY_HOST');
  if (['on', '1', 'true', 'yes'].includes(env.EASY_STUDY_AUTH?.trim().toLowerCase() ?? '')) ignored.push('EASY_STUDY_AUTH');
  for (const name of ['EASY_STUDY_TLS_CERT', 'EASY_STUDY_TLS_KEY']) if (env[name]?.trim()) ignored.push(name);
  return ignored;
}

/**
 * startServer options of desktop mode: local mode on 127.0.0.1 and desktopPort(). Throws ConfigError without
 * EASY_STUDY_LIBRARY (the default library inside the installed app is read-only or inside its signature).
 */
export function desktopServerOptions(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  if (!env.EASY_STUDY_LIBRARY?.trim()) {
    throw new ConfigError('데스크톱 모드에는 라이브러리 폴더가 필요합니다 (EASY_STUDY_LIBRARY).');
  }
  return { port: desktopPort(env), host: '127.0.0.1', auth: 'off', password: null, tls: null };
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
 * whose stack trace is worth logging before the message.
 */
export function startupFailureMessage(err: unknown, port: number): { message: string; known: boolean } {
  if (err instanceof ConfigError) return { message: `설정 오류: ${err.message}`, known: true };
  if (err instanceof LibraryLockedError) {
    const { holder } = err;
    return {
      known: true,
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
      message: `포트 ${port}을(를) 다른 프로그램이 이미 쓰고 있어서 서버를 시작하지 못했습니다. 앱을 다시 실행해 보세요.`,
    };
  }
  const code = errno?.code ?? '';
  if (Object.hasOwn(LIBRARY_PROBLEMS, code) && typeof errno?.path === 'string' && isInside(errno.path, libraryDir())) {
    return {
      known: true,
      message: `${LIBRARY_PROBLEMS[code]} (${code}): ${libraryDir()}\n  다른 라이브러리 폴더를 고르거나, 이 폴더를 확인해 주세요.`,
    };
  }
  return { known: false, message: `서버를 시작하지 못했습니다: ${describe(err)}` };
}

export interface ShellWatchOptions {
  /** Default process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Whether the shell still runs (default: see shellAlive). */
  parentAlive?: () => boolean;
  /** Default 2 s. */
  intervalMs?: number;
}

/**
 * Whether the process that started the server still runs. POSIX: an orphan is re-parented, so the parent pid
 * changes. Windows keeps the original parent pid: it must still exist (the Job Object of the shell kills the
 * server anyway when the shell ends).
 */
export function shellAlive(parentPid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (parentPid <= 1) return true; // started by init/launchd itself: nothing to watch
  if (platform !== 'win32') return process.ppid === parentPid;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Calls `onGone` once when the shell is gone: stdin ends (EOF), fails, or the parent process is no longer
 * there. What the shell writes to stdin is ignored. Returns a function that stops watching (tests).
 */
export function watchShell(onGone: (reason: string) => void, options: ShellWatchOptions = {}): () => void {
  const stdin: NodeJS.ReadableStream = options.stdin ?? process.stdin;
  const parentPid = process.ppid;
  const parentAlive = options.parentAlive ?? (() => shellAlive(parentPid));
  let done = false;
  const onEnd = () => fire('stdin EOF');
  const onError = () => fire('stdin error');
  const ignore = () => {};
  const timer = setInterval(() => {
    if (!parentAlive()) fire(`parent ${parentPid} is gone`);
  }, options.intervalMs ?? PARENT_CHECK_MS);
  timer.unref();
  const stop = () => {
    done = true;
    clearInterval(timer);
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
    stdin.off('data', ignore);
    // The 'error' listener stays: a late pipe error must not become an uncaught exception.
  };
  function fire(reason: string): void {
    if (done) return;
    stop();
    onGone(reason);
  }
  stdin.on('end', onEnd);
  stdin.on('close', onEnd);
  stdin.on('error', onError);
  stdin.on('data', ignore);
  stdin.resume();
  return stop;
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

/** Signals that stop the server (SIGHUP: session end; SIGBREAK: Ctrl+Break on Windows). */
function stopSignals(): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  return signals;
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
      console.warn(`[desktop] ${ignored.join(', ')} 설정은 데스크톱 앱에서 쓰지 않습니다 (이 컴퓨터에서만, 로그인 없이 열립니다).`);
    }
    running = await start(options);
  } catch (err) {
    const { message, known } = startupFailureMessage(err, port);
    if (!known) console.error(err);
    console.error(message);
    exitAfterOutput(1);
    return;
  }

  if (stopReason !== null) {
    shutdown(running, stopReason);
    return;
  }
  const actualPort = (running.server.address() as AddressInfo).port;
  console.log(`\n  easy-study (desktop)  →  ${running.url}`);
  console.log(`  library     →  ${libraryDir()}\n`);
  const fontProblem = fallbackFontProblem();
  if (fontProblem) console.warn(`  ${fontProblem}\n`);
  console.log(readyLine(running.url, actualPort));
}
