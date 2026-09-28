// Token usage and subscription limits as the providers report them (DESIGN §23), turned into TokenUsage /
// UsageLimits (shared/types.ts):
// - Claude (claude-code stream-json, anthropic-api): every model call starts with a `usage` object on message_start,
//   and message_delta repeats it with the call's cumulative counts. input_tokens leave out the prompt cache, so the
//   input is input_tokens + cache_creation_input_tokens + cache_read_input_tokens; output_tokens include thinking
//   (output_tokens_details.thinking_tokens). Claude Code's `result` carries the total of all calls of the run.
// - OpenAI (codex exec --json turn.completed, Codex rollouts, the Responses API): input_tokens include the cached part
//   (cached_input_tokens / input_tokens_details.cached_tokens), output_tokens the reasoning part
//   (reasoning_output_tokens / output_tokens_details.reasoning_tokens).
// - Limits: Claude Code's rate_limit_event (claude.ai subscriptions: utilization fractions, reset times in Unix
//   seconds) and the rate_limits of Codex's token_count rollout events (used_percent 0–100, window_minutes,
//   resets_at in Unix seconds).
import { addUsage, tokenCount } from '../../shared/usage.ts';
import type { LimitWindow, TokenUsage, UsageLimits } from '../../shared/types.ts';
import type { JsonObject } from './proc.ts';

/** Minutes of a week: Claude's seven_day windows, Codex's window_minutes 10080. */
const WEEK_MINUTES = 7 * 24 * 60;

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** Unix seconds → ISO (undefined for anything else). */
function isoFromSeconds(value: unknown): string | undefined {
  const seconds = tokenCount(value);
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

/** TokenUsage of an Anthropic `usage` object (message_start / message_delta / result / final message), or undefined. */
export function anthropicUsage(value: unknown): TokenUsage | undefined {
  const raw = asObject(value);
  const input = tokenCount(raw.input_tokens);
  const write = tokenCount(raw.cache_creation_input_tokens);
  const read = tokenCount(raw.cache_read_input_tokens);
  const output = tokenCount(raw.output_tokens);
  if (input === null && write === null && read === null && output === null) return undefined;
  const usage: TokenUsage = { input: (input ?? 0) + (write ?? 0) + (read ?? 0), output: output ?? 0 };
  if (read) usage.cachedInput = read;
  if (write) usage.cacheWrite = write;
  const thinking = tokenCount(asObject(raw.output_tokens_details).thinking_tokens);
  if (thinking) usage.reasoning = thinking;
  return usage;
}

/**
 * The running total of an Anthropic stream's model calls: message_start opens a call, message_delta updates its
 * cumulative counts (null fields keep the earlier value). One Claude Code run makes several calls when the model
 * uses tools.
 */
export class AnthropicUsageTracker {
  private readonly calls: JsonObject[] = [];

  /** message_start (its message.usage): a new model call. Returns the running total. */
  start(usage: unknown): TokenUsage | undefined {
    this.calls.push({ ...asObject(usage) });
    return this.total();
  }

  /** message_delta (its usage): the current call's counts so far. Returns the running total. */
  update(usage: unknown): TokenUsage | undefined {
    if (this.calls.length === 0) this.calls.push({});
    const call = this.calls[this.calls.length - 1];
    for (const [key, value] of Object.entries(asObject(usage))) {
      if (value !== null && value !== undefined) call[key] = value;
    }
    return this.total();
  }

  total(): TokenUsage | undefined {
    let sum: TokenUsage | undefined;
    for (const call of this.calls) sum = addUsage(sum, anthropicUsage(call));
    return sum;
  }
}

/** TokenUsage of an OpenAI-style `usage` object (Codex turn.completed / rollout, Responses API), or undefined. */
export function openaiUsage(value: unknown): TokenUsage | undefined {
  const raw = asObject(value);
  const input = tokenCount(raw.input_tokens);
  const output = tokenCount(raw.output_tokens);
  if (input === null && output === null) return undefined;
  const inputDetails = asObject(raw.input_tokens_details);
  const outputDetails = asObject(raw.output_tokens_details);
  const usage: TokenUsage = { input: input ?? 0, output: output ?? 0 };
  const cached = tokenCount(raw.cached_input_tokens) ?? tokenCount(inputDetails.cached_tokens);
  const write = tokenCount(raw.cache_write_input_tokens) ?? tokenCount(inputDetails.cache_write_tokens);
  const reasoning = tokenCount(raw.reasoning_output_tokens) ?? tokenCount(outputDetails.reasoning_tokens);
  if (cached) usage.cachedInput = cached;
  if (write) usage.cacheWrite = write;
  if (reasoning) usage.reasoning = reasoning;
  return usage;
}

/** Claude's limit types (rateLimitType / unifiedWindows keys) shown as windows; others (overage) are left out. */
const CLAUDE_WINDOWS: Readonly<Record<string, { minutes: number; label?: string }>> = {
  five_hour: { minutes: 300 },
  seven_day: { minutes: WEEK_MINUTES },
  seven_day_opus: { minutes: WEEK_MINUTES, label: 'Opus' },
  seven_day_sonnet: { minutes: WEEK_MINUTES, label: 'Sonnet' },
};

const CLAUDE_STATUS: Readonly<Record<string, UsageLimits['status']>> = {
  allowed: 'ok',
  allowed_warning: 'warning',
  rejected: 'reached',
};

function byLength(a: LimitWindow, b: LimitWindow): number {
  return a.minutes - b.minutes || (a.label ?? '').localeCompare(b.label ?? '');
}

/**
 * UsageLimits of Claude Code's rate_limit_event (its `rate_limit_info`), or undefined when it says nothing useful
 * (an API-key session: no windows, status 'allowed'). The per-window bars are `unifiedWindows` (utilization is a
 * fraction); the top-level utilization / rateLimitType describe the binding window (the one the status is about),
 * added when not listed there.
 */
export function claudeRateLimits(value: unknown, at: string): UsageLimits | undefined {
  const info = asObject(value);
  const status = (typeof info.status === 'string' ? CLAUDE_STATUS[info.status] : undefined) ?? 'ok';
  const windows = new Map<string, LimitWindow>();
  const add = (type: string, utilization: unknown, resetsAt: unknown) => {
    const kind = CLAUDE_WINDOWS[type];
    if (!kind || windows.has(type) || typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
    const window: LimitWindow = { minutes: kind.minutes, usedPercent: Math.round(utilization * 1000) / 10 };
    const resets = isoFromSeconds(resetsAt);
    if (resets) window.resetsAt = resets;
    if (kind.label) window.label = kind.label;
    windows.set(type, window);
  };
  for (const [type, raw] of Object.entries(asObject(info.unifiedWindows))) {
    const entry = asObject(raw);
    add(type, entry.utilization, entry.resetsAt);
  }
  if (typeof info.rateLimitType === 'string') {
    add(info.rateLimitType, info.utilization, info.resetsAt);
    const binding = windows.get(info.rateLimitType);
    if (binding && status !== 'ok') binding.binding = true;
  }
  if (windows.size === 0 && status === 'ok') return undefined;
  return { at, status, windows: [...windows.values()].sort(byLength) };
}

function codexWindow(value: unknown, label: string | undefined): LimitWindow | null {
  const raw = asObject(value);
  const minutes = tokenCount(raw.window_minutes);
  const used = raw.used_percent;
  if (!minutes || typeof used !== 'number' || !Number.isFinite(used)) return null;
  const window: LimitWindow = { minutes, usedPercent: used };
  const resets = isoFromSeconds(raw.resets_at);
  if (resets) window.resetsAt = resets;
  if (label) window.label = label;
  return window;
}

/** Whether Codex rate_limits describe the plan's general limit (limit_id "codex", or none on older CLIs). */
export function isGeneralCodexLimit(value: unknown): boolean {
  const id = asObject(value).limit_id;
  return id === undefined || id === null || id === 'codex';
}

/**
 * UsageLimits of the `rate_limits` of a Codex token_count event, or undefined without windows. Windows are told
 * apart by their length (window_minutes), never by primary / secondary: plans differ in which they have. A model
 * bucket (another limit_id, e.g. a Spark model) is labelled with its limit_name.
 */
export function codexRateLimits(value: unknown, at: string): UsageLimits | undefined {
  const raw = asObject(value);
  const label = !isGeneralCodexLimit(raw) && typeof raw.limit_name === 'string' && raw.limit_name ? raw.limit_name : undefined;
  const windows = [raw.primary, raw.secondary]
    .map((window) => codexWindow(window, label))
    .filter((window): window is LimitWindow => window !== null);
  const reached = typeof raw.rate_limit_reached_type === 'string' && raw.rate_limit_reached_type !== '';
  if (windows.length === 0 && !reached) return undefined;
  return { at, status: reached ? 'reached' : 'ok', windows: windows.sort(byLength) };
}
