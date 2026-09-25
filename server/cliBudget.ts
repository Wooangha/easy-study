// Process budget for LLM CLI children (DESIGN §15). Every claude / codex run is a separate process of
// ~150-250 MB, and a chat turn next to two digest batches used to mean three of them at once. At most
// EASY_STUDY_MAX_CLI_PROCS (default 2) run at a time across the whole server, and the student comes first:
//
// - a chat turn starts as long as fewer than `limit` CHAT turns run: digest batches never hold it back
//   (when digests fill the budget, the turn starts anyway and the digests wait until the total is back
//   under the limit);
// - a digest batch starts only when the total is under the limit and no chat turn is waiting.
//
// API providers spawn no process and take no slot.
import { maxCliProcs } from './config.ts';

export type CliSlotKind = 'chat' | 'digest';

/**
 * Waits for a CLI slot; resolves with its release function (idempotent). Rejects with the signal's reason
 * when `signal` aborts first. `onWait` is called (synchronously) when the call has to queue.
 */
export type AcquireCliSlot = (kind: CliSlotKind, signal: AbortSignal, onWait?: () => void) => Promise<() => void>;

export interface CliBudget {
  acquire: AcquireCliSlot;
  /** Slots in use and calls waiting, per kind (tests and diagnostics). */
  usage(): { chat: number; digest: number; waitingChat: number; waitingDigest: number };
}

interface Waiter {
  kind: CliSlotKind;
  grant: () => void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('중단되었습니다');
}

/** A budget of `limit()` CLI processes (read on every decision, so the environment may change). */
export function createCliBudget(limit: () => number = maxCliProcs): CliBudget {
  const running = { chat: 0, digest: 0 };
  const waiting: Waiter[] = [];
  const max = () => Math.max(1, Math.floor(limit()) || 1);

  const canStart = (kind: CliSlotKind): boolean => {
    if (kind === 'chat') return running.chat < max();
    return running.chat + running.digest < max() && !waiting.some((waiter) => waiter.kind === 'chat');
  };

  const pump = () => {
    // Chat turns first, then digest batches, each in arrival order.
    for (const kind of ['chat', 'digest'] as const) {
      for (let i = 0; i < waiting.length; ) {
        const waiter = waiting[i];
        if (waiter.kind === kind && canStart(kind)) {
          waiting.splice(i, 1);
          waiter.grant();
        } else {
          i++;
        }
      }
    }
  };

  const take = (kind: CliSlotKind): (() => void) => {
    running[kind]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running[kind]--;
      pump();
    };
  };

  const acquire: AcquireCliSlot = (kind, signal, onWait) => {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const queuedAhead = waiting.some((waiter) => waiter.kind === kind);
    if (!queuedAhead && canStart(kind)) return Promise.resolve(take(kind));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = waiting.indexOf(waiter);
        if (index !== -1) waiting.splice(index, 1);
        reject(abortReason(signal));
        pump(); // a waiting chat turn may have been what held the digests back
      };
      const waiter: Waiter = {
        kind,
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(take(kind));
        },
      };
      waiting.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      onWait?.();
    });
  };

  return {
    acquire,
    usage: () => ({
      chat: running.chat,
      digest: running.digest,
      waitingChat: waiting.filter((waiter) => waiter.kind === 'chat').length,
      waitingDigest: waiting.filter((waiter) => waiter.kind === 'digest').length,
    }),
  };
}

/** The server-wide budget (EASY_STUDY_MAX_CLI_PROCS). */
export const cliBudget: CliBudget = createCliBudget();

export const acquireCliSlot: AcquireCliSlot = (kind, signal, onWait) => cliBudget.acquire(kind, signal, onWait);
