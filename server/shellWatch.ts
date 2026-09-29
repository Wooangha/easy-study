// What a child of the desktop app's shell shares (DESIGN §19): the ready line the shell waits for, and the watch on
// the shell that ends the child when the shell is gone. Used by the server in desktop mode (server/desktop.ts) and
// by the loopback proxy (server/proxy.ts), which must not load the server's modules. Nothing here reads a library.

/** First word of the ready line. */
export const READY_PREFIX = 'EASY_STUDY_READY';

/** How often the parent watchdog looks at the parent process. */
const PARENT_CHECK_MS = 2_000;

/** What a shared server adds to its ready line: the addresses other devices can use. */
export interface ReadyShare {
  urls: string[];
}

/**
 * The one line the shell waits for: `EASY_STUDY_READY {"url":"http://127.0.0.1:<port>","port":<port>}`. A server
 * that other devices may reach (desktop share mode) adds `"share":{"urls":[…]}`; the line is byte-identical to
 * before without it.
 */
export function readyLine(url: string, port: number, share?: ReadyShare): string {
  return `${READY_PREFIX} ${JSON.stringify(share ? { url, port, share } : { url, port })}`;
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

/** Signals that stop a child of the shell (SIGHUP: session end; SIGBREAK: Ctrl+Break on Windows). */
export function stopSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (platform === 'win32') signals.push('SIGBREAK');
  return signals;
}
