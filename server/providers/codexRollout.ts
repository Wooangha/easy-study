// Token usage and usage limits of a Codex thread's latest turn, from the thread's rollout file (DESIGN §23).
//
// `codex exec --json` reports a turn's tokens in turn.completed but no usage limits at all, and on a resumed thread
// that usage may be the thread's running total rather than the turn's (the session's total token usage carries over
// when a thread is resumed). The rollout the CLI keeps for every non-ephemeral thread has both:
//
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-mm-ss-<thread id>.jsonl
//
// named after the thread's creation in local time; the thread id is a UUIDv7, whose first 48 bits are that time in
// Unix ms. A resumed turn is appended to the thread's original file. After each model call of a turn (codex-cli 0.154):
//
//   {"timestamp":"…","type":"token_usage_record","payload":{"thread_id":"…","turn_token_usage":{…},"thread_token_usage":{…},…}}
//   {"timestamp":"…","type":"event_msg","payload":{"type":"token_count","info":{…},"rate_limits":{"limit_id":"codex",
//     "primary":{"used_percent":6,"window_minutes":10080,"resets_at":1791049157},"secondary":null,…}}}
//
// turn_token_usage adds up the turn's model calls so far, so the turn's last record is the whole turn. The format is
// the CLI's internal one and is read defensively: only what the run appended (from the file's size before a resumed
// run; timestamps would not do: the previous turn's records can be milliseconds older), only the tail of that
// (rollouts with images grow to tens of MB), and anything unexpected yields nothing.
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TokenUsage, UsageLimits } from '../../shared/types.ts';
import { codexHome } from './codexCatalog.ts';
import type { JsonObject } from './proc.ts';
import { codexRateLimits, isGeneralCodexLimit, openaiUsage } from './usage.ts';

/** Bytes read from the end of a rollout: a turn's records come last (only task_complete follows them). */
export const ROLLOUT_TAIL_BYTES = 256 * 1024;

const UUID_V7_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

export interface CodexRolloutTurn {
  /** Tokens of the latest turn (its last token_usage_record's turn_token_usage). */
  usage?: TokenUsage;
  /** Usage limits of the latest token_count event (the plan's general limit preferred over a model bucket). */
  limits?: UsageLimits;
}

/** Creation time (Unix ms) of a UUIDv7 thread id, or null for any other id. */
export function uuidV7Time(id: string): number | null {
  const m = UUID_V7_RE.exec(id);
  return m ? Number.parseInt(m[1] + m[2], 16) : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** The rollout file of a thread, or null: in the date folder of its creation (local time), else the days around it. */
export async function findCodexRollout(threadId: string, home = codexHome()): Promise<string | null> {
  const created = uuidV7Time(threadId);
  if (created === null) return null;
  const suffix = `-${threadId}.jsonl`;
  for (const offset of [0, -1, 1]) {
    const day = new Date(created + offset * DAY_MS);
    const dir = path.join(home, 'sessions', String(day.getFullYear()), pad2(day.getMonth() + 1), pad2(day.getDate()));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const name = names.find((candidate) => candidate.startsWith('rollout-') && candidate.endsWith(suffix));
    if (name) return path.join(dir, name);
  }
  return null;
}

/**
 * The size of a thread's rollout in bytes, or null when it has none: where the entries of a run that resumes the
 * thread will start. Never throws.
 */
export async function codexRolloutSize(threadId: string, home = codexHome()): Promise<number | null> {
  try {
    const file = await findCodexRollout(threadId, home);
    return file ? (await stat(file)).size : null;
  } catch {
    return null;
  }
}

/** What a file got after its first `from` bytes, at most its last `bytes`, from its first complete line on. */
async function readAppended(file: string, from: number, bytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= from) return '';
    const start = Math.max(from, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === from) return text;
    // The first line is cut (possibly inside a UTF-8 character): skip it.
    const newline = text.indexOf('\n');
    return newline === -1 ? '' : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

/**
 * The latest turn's usage and limits in rollout entries (JSONL) that one run appended: a run that recorded nothing
 * yields nothing.
 */
export function parseCodexRolloutTail(text: string, threadId: string): CodexRolloutTurn {
  const out: CodexRolloutTurn = {};
  let bucketLimits: UsageLimits | undefined;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && (!out.usage || !out.limits); i--) {
    const line = lines[i];
    // Cheap filter: most lines (messages, tool output, images) are neither.
    if (!line.includes('"token_usage_record"') && !line.includes('"token_count"')) continue;
    let entry: JsonObject;
    try {
      entry = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isNaN(at)) continue;
    const payload = asObject(entry.payload);
    if (entry.type === 'token_usage_record') {
      if (!out.usage && (payload.thread_id === undefined || payload.thread_id === threadId)) out.usage = openaiUsage(payload.turn_token_usage);
    } else if (entry.type === 'event_msg' && payload.type === 'token_count' && !out.limits) {
      const limits = codexRateLimits(payload.rate_limits, new Date(at).toISOString());
      if (!limits) continue;
      if (isGeneralCodexLimit(payload.rate_limits)) out.limits = limits;
      else bucketLimits ??= limits;
    }
  }
  if (!out.limits && bucketLimits) out.limits = bucketLimits;
  return out;
}

/**
 * Usage and limits of a thread's latest turn from what its rollout got after its first `from` bytes (0 for a new
 * thread, codexRolloutSize before the run for a resumed one). Never throws: an id that is not a UUIDv7, a missing or
 * unreadable file, or an unknown format give `{}`.
 */
export async function readCodexRolloutTurn(threadId: string, from: number, home = codexHome()): Promise<CodexRolloutTurn> {
  try {
    const file = await findCodexRollout(threadId, home);
    if (!file) return {};
    return parseCodexRolloutTail(await readAppended(file, from, ROLLOUT_TAIL_BYTES), threadId);
  } catch {
    return {};
  }
}
