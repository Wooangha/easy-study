// Child processes of the server (DESIGN §15, §19): the LLM CLIs of chat turns and digests, their version
// probes, and the short-lived PDF/image workers. Each one is registered here while it runs, so that no way
// out of the server leaves one behind:
//
// - a graceful stop (SIGTERM, Ctrl+C, the desktop shell closing stdin) aborts turns and digests and stops the
//   workers first, each with its own grace period (runJsonlProcess: SIGTERM, then SIGKILL);
// - whatever still runs when the process exits (a forced exit such as a second Ctrl+C or the shutdown
//   timeout, a failed startup, an uncaught exception) is killed synchronously from process.on('exit'):
//   SIGKILL on POSIX; on Windows TerminateProcess, and for a CLI first `taskkill /T /F` of its whole tree
//   (Claude Code's rg.exe, Codex's shells and sandbox helpers).
//
// Grandchildren on POSIX (processes a CLI started itself) are still in the server's process group. In desktop
// mode the shell starts the server as the leader of its own group, and signalProcessGroupOnExit() makes the
// exit hook send SIGTERM to that group as well — with the server's own SIGTERM caught, so the group signal
// cannot replace the server's exit code by "killed by a signal" (the shell reports that code).
// Nothing survives a SIGKILL of the server itself; the desktop shell covers that case (DESIGN §19), and
// the workers exit by themselves when their IPC channel closes (imageWorker.ts childMain).
import { spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncOptions } from 'node:child_process';
import path from 'node:path';

export interface TrackOptions {
  /**
   * The child may start processes of its own (the CLIs). On Windows the exit hook kills its whole tree with
   * taskkill; on POSIX its descendants are reached through the process group (signalProcessGroupOnExit).
   */
  tree?: boolean;
}

/** Running children → whether to kill their whole tree. */
const running = new Map<ChildProcess, boolean>();
let exitHookInstalled = false;
let signalGroupOnExit = false;

/** taskkill.exe of the Windows system directory (not whatever `taskkill` the working directory offers). */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  return root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Registers a child the server just started (spawn/fork/execFile return it with its pid synchronously) until
 * it exits. A child that could not be started (no pid) is not registered. Returns `child`.
 */
export function trackChild<T extends ChildProcess>(child: T, options: TrackOptions = {}): T {
  if (child.pid === undefined || hasExited(child)) return child;
  running.set(child, options.tree ?? false);
  child.once('exit', () => running.delete(child));
  installExitHook();
  return child;
}

/** Number of registered children that are still running (tests). */
export function runningChildCount(): number {
  let count = 0;
  for (const child of running.keys()) if (!hasExited(child)) count++;
  return count;
}

/** spawnSync as killRunningChildren uses it (injectable for tests). */
export type SpawnSyncLike = (file: string, args: string[], options: SpawnSyncOptions) => unknown;

/**
 * Kills every registered child that still runs, synchronously (it runs from process.on('exit')), and
 * forgets them. Returns how many were running.
 */
export function killRunningChildren(platform: NodeJS.Platform = process.platform, runSync: SpawnSyncLike = spawnSync): number {
  let count = 0;
  for (const [child, tree] of [...running]) {
    running.delete(child);
    if (child.pid === undefined || hasExited(child)) continue;
    count++;
    if (platform === 'win32' && tree) {
      try {
        runSync(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
      } catch {
        // taskkill could not run: the child alone is terminated below.
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  return count;
}

/**
 * Desktop mode (DESIGN §19), POSIX: at exit, also send SIGTERM to the process group this process leads (the
 * shell starts the server with its own group), which reaches the grandchildren of the CLIs. Without a group
 * of its own (npm start from a terminal) there is nothing to signal and nothing happens.
 */
export function signalProcessGroupOnExit(): void {
  signalGroupOnExit = true;
  installExitHook();
}

function signalOwnProcessGroup(): void {
  // The signal reaches this process too: a listener keeps its default action (terminate) away, so the exit
  // code stays the one the server chose. Listening starts synchronously, so this works inside 'exit'.
  process.on('SIGTERM', () => {});
  try {
    // Only a group this process leads has our pid as its id; otherwise ESRCH.
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    // Not a group leader.
  }
}

function onExit(): void {
  killRunningChildren();
  if (signalGroupOnExit && process.platform !== 'win32') signalOwnProcessGroup();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', onExit);
}
