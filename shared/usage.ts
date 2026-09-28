// Token usage arithmetic (DESIGN §23), shared by the server (turn and session totals, digest runs, stored files)
// and the web client (a streaming turn added to its session's totals).
import type { LimitWindow, SessionUsage, TokenUsage, UsageLimits } from './types.ts';

/** The optional parts of a TokenUsage (kept only when above zero). */
const USAGE_PARTS = ['cachedInput', 'cacheWrite', 'reasoning'] as const;

/** A token count: a finite number ≥ 0 (rounded), else null. */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** a + b, count by count; undefined when both are. Never modifies its arguments. */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a || !b) {
    const only = a ?? b;
    return only ? { ...only } : undefined;
  }
  const sum: TokenUsage = { input: a.input + b.input, output: a.output + b.output };
  for (const key of USAGE_PARTS) {
    const value = (a[key] ?? 0) + (b[key] ?? 0);
    if (value > 0) sum[key] = value;
  }
  return sum;
}

/** Input + output tokens. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output;
}

/** The session's totals after a turn that used `usage` (a priming turn also counts as priming). */
export function addSessionUsage(session: SessionUsage | undefined, usage: TokenUsage | undefined, priming: boolean): SessionUsage | undefined {
  if (!usage) return session;
  const next: SessionUsage = { total: addUsage(session?.total, usage) ?? usage };
  const primingUsage = priming ? addUsage(session?.priming, usage) : session?.priming;
  if (primingUsage) next.priming = primingUsage;
  return next;
}

/** A TokenUsage read from stored JSON (a session or digest file), or undefined when it is not one. */
export function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const input = tokenCount(raw.input);
  const output = tokenCount(raw.output);
  if (input === null || output === null) return undefined;
  const usage: TokenUsage = { input, output };
  for (const key of USAGE_PARTS) {
    const part = tokenCount(raw[key]);
    if (part) usage[key] = part;
  }
  return usage;
}

/** SessionUsage read from stored JSON, or undefined. */
export function readSessionUsage(value: unknown): SessionUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const total = readTokenUsage(raw.total);
  if (!total) return undefined;
  const priming = readTokenUsage(raw.priming);
  return priming ? { total, priming } : { total };
}

function readLimitWindow(value: unknown): LimitWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const minutes = tokenCount(raw.minutes);
  const usedPercent = typeof raw.usedPercent === 'number' && Number.isFinite(raw.usedPercent) ? raw.usedPercent : null;
  if (!minutes || usedPercent === null) return null;
  const window: LimitWindow = { minutes, usedPercent };
  if (typeof raw.resetsAt === 'string' && !Number.isNaN(Date.parse(raw.resetsAt))) window.resetsAt = raw.resetsAt;
  if (typeof raw.label === 'string' && raw.label) window.label = raw.label;
  if (raw.binding === true) window.binding = true;
  return window;
}

/** UsageLimits read from stored JSON, or undefined. */
export function readUsageLimits(value: unknown): UsageLimits | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at)) || !Array.isArray(raw.windows)) return undefined;
  const status = raw.status === 'warning' || raw.status === 'reached' ? raw.status : 'ok';
  const windows = raw.windows.map(readLimitWindow).filter((window): window is LimitWindow => window !== null);
  return { at: raw.at, status, windows };
}
