// Token usage and subscription limits in the chat (DESIGN §23): compact Korean counts ("4.7만"), the exact numbers
// for tooltips, and the limit windows with a warning level. Limits are the account's, not a session's: the newest
// report of each provider is shown, whichever session it came from.
import type { ChatMessage, LimitWindow, ProviderId, SessionUsage, TokenUsage, UsageLimits } from '../../../shared/types.ts';
import { readUsageLimits, totalTokens } from '../../../shared/usage.ts';
import { formatTime } from './format.ts';

/** From this share of a window on, it is shown as a warning. */
export const LIMIT_WARN_PERCENT = 80;
/** A limits report this old shows when it was made ("14:30 기준"): the account may have been used elsewhere since. */
export const LIMITS_AGED_MS = 60 * 60_000;
/** A 'warning' / 'reached' status without any window counts this long after its report. */
const STATUS_ONLY_MS = 24 * 60 * 60_000;

function count(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function oneDecimal(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/** A compact token count: "820", "9,876", "4.7만", "123만", "1.2억". */
export function formatTokens(n: number): string {
  const value = count(n);
  if (value < 10_000) return value.toLocaleString('ko-KR');
  if (value < 100_000_000) {
    const man = value / 10_000;
    return `${man >= 99.95 ? Math.round(man).toLocaleString('ko-KR') : oneDecimal(man)}만`;
  }
  return `${oneDecimal(value / 100_000_000)}억`;
}

/** The exact count with separators: "47,213". */
export function exactTokens(n: number | undefined): string {
  return count(n).toLocaleString('ko-KR');
}

/** The muted line under an answer: "입력 4.7만 (캐시 4.1만) · 출력 820". */
export function usageLine(usage: TokenUsage): string {
  const cached = count(usage.cachedInput);
  return `입력 ${formatTokens(usage.input)}${cached > 0 ? ` (캐시 ${formatTokens(cached)})` : ''} · 출력 ${formatTokens(usage.output)}`;
}

/** The exact numbers (tooltip), one per line, headed by `heading`. */
export function usageTitle(usage: TokenUsage, heading = '이 답변에 쓴 토큰'): string {
  const lines = [heading, `입력 ${exactTokens(usage.input)}`];
  if (count(usage.cachedInput) > 0) lines.push(`  캐시에서 읽음 ${exactTokens(usage.cachedInput)}`);
  if (count(usage.cacheWrite) > 0) lines.push(`  캐시에 저장 ${exactTokens(usage.cacheWrite)}`);
  lines.push(`출력 ${exactTokens(usage.output)}`);
  if (count(usage.reasoning) > 0) lines.push(`  추론 ${exactTokens(usage.reasoning)}`);
  lines.push(`합계 ${exactTokens(totalTokens(usage))}`);
  return lines.join('\n');
}

/**
 * Answers of a session whose tokens are not in its totals: saved before usage was recorded (or not reported by the
 * provider).
 */
export function unrecordedAnswers(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.role === 'assistant' && m.status === 'complete' && !m.usage).length;
}

/** The session's total ("이 세션 12.3만 토큰") and its tooltip, which names the answers left out (`unrecorded`). */
export function sessionUsageSummary(usage: SessionUsage, unrecorded = 0): { text: string; title: string } {
  const title = [usageTitle(usage.total, '이 세션에서 쓴 토큰 (슬라이드 전달, 실패·중단된 답변 포함)')];
  if (usage.priming) title.push(`그중 슬라이드 전달 ${exactTokens(totalTokens(usage.priming))}`);
  if (unrecorded > 0) title.push(`토큰이 기록되지 않은 답변 ${unrecorded}개는 빠져 있어요 (기록 전에 만든 답변 등)`);
  return { text: `이 세션 ${formatTokens(totalTokens(usage.total))} 토큰`, title: title.join('\n') };
}

export type LimitLevel = 'ok' | 'warn' | 'danger';

export interface LimitItem {
  text: string;
  level: LimitLevel;
}

/** "5시간", "주간", "3일", "2시간", "90분"; a model family's own limit gets its name: "주간(Opus)". */
export function windowName(window: Pick<LimitWindow, 'minutes' | 'label'>): string {
  const { minutes } = window;
  let name: string;
  if (minutes === 7 * 24 * 60) name = '주간';
  else if (minutes % (24 * 60) === 0) name = `${minutes / (24 * 60)}일`;
  else if (minutes % 60 === 0) name = `${minutes / 60}시간`;
  else name = `${minutes}분`;
  return window.label ? `${name}(${window.label})` : name;
}

/**
 * The windows that still say something at `now`: one whose reset time has passed started over (its share is gone),
 * and one without a reset time counts only for its own length after the report.
 */
export function currentWindows(limits: UsageLimits, now: number): LimitWindow[] {
  const reportedAt = Date.parse(limits.at);
  return limits.windows.filter((window) => {
    if (!Number.isFinite(window.usedPercent) || !(window.minutes > 0)) return false;
    const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!Number.isNaN(resets)) return resets > now;
    return Number.isFinite(reportedAt) && reportedAt + window.minutes * 60_000 > now;
  });
}

function levelOf(percent: number): LimitLevel {
  return percent >= 100 ? 'danger' : percent >= LIMIT_WARN_PERCENT ? 'warn' : 'ok';
}

/** The window a 'warning' / 'reached' status is about: the one the provider named, else the fullest one. */
function statusWindow(limits: UsageLimits): LimitWindow | undefined {
  const named = limits.windows.find((window) => window.binding);
  if (named) return named;
  let fullest: LimitWindow | undefined;
  for (const window of limits.windows) {
    if (!fullest || window.usedPercent > fullest.usedPercent) fullest = window;
  }
  return fullest;
}

/**
 * Whether the report's 'warning' / 'reached' status still holds at `now`: while the window it is about lasts (once
 * that window started over, so did the status), or for a day when the report has no windows.
 */
export function statusHolds(limits: UsageLimits, now: number): boolean {
  if (limits.status === 'ok') return false;
  const about = statusWindow(limits);
  if (!about) return Date.parse(limits.at) + STATUS_ONLY_MS >= now;
  return currentWindows(limits, now).includes(about);
}

/**
 * The limit line: "5시간 한도 12%", "주간 9%" (the first names the limit), each with its level; a window at the
 * warning level or over it also says when it starts over ("5시간 한도 100% (14:30 초기화)"). A provider's own warning
 * or "reached" marks the window it is about while it holds (see statusHolds; on its own when the report has no
 * windows). Empty = nothing to show.
 */
export function limitItems(limits: UsageLimits | null | undefined, now: number): LimitItem[] {
  if (!limits) return [];
  const windows = currentWindows(limits, now);
  const levels = windows.map((window) => levelOf(Math.round(window.usedPercent)));
  if (statusHolds(limits, now)) {
    const level: LimitLevel = limits.status === 'reached' ? 'danger' : 'warn';
    const about = statusWindow(limits);
    if (!about) return [{ text: limits.status === 'reached' ? '사용 한도 도달' : '사용 한도 임박', level }];
    const i = windows.indexOf(about);
    if (levels[i] !== 'danger') levels[i] = level;
  }
  return windows.map((window, i) => {
    const resets = levels[i] !== 'ok' && window.resetsAt ? ` (${formatTime(window.resetsAt)} 초기화)` : '';
    return { text: `${windowName(window)}${i === 0 ? ' 한도' : ''} ${Math.round(window.usedPercent)}%${resets}`, level: levels[i] };
  });
}

/** "14:30 기준" when the report is LIMITS_AGED_MS old or older, else null. */
export function limitsAge(limits: UsageLimits, now: number): string | null {
  const at = Date.parse(limits.at);
  return Number.isFinite(at) && now - at >= LIMITS_AGED_MS ? `${formatTime(limits.at)} 기준` : null;
}

/** The next moment (Unix ms) after `now` at which the limit line changes by itself (a window resets, …), or null. */
export function nextLimitsChange(limits: UsageLimits, now: number): number | null {
  const at = Date.parse(limits.at);
  const times = [at + LIMITS_AGED_MS, at + STATUS_ONLY_MS];
  for (const window of limits.windows) {
    const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    times.push(Number.isNaN(resets) ? at + window.minutes * 60_000 : resets);
  }
  const next = times.filter((time) => Number.isFinite(time) && time > now);
  return next.length > 0 ? Math.min(...next) : null;
}

/** Tooltip of the limit line: when it was reported and when each window starts over. */
export function limitsTitle(limits: UsageLimits, now: number, providerName: string): string {
  const lines = [`${providerName} 사용 한도 (${formatTime(limits.at)} 기준)`];
  for (const window of currentWindows(limits, now)) {
    const resets = window.resetsAt ? ` · ${formatTime(window.resetsAt)}에 초기화` : '';
    lines.push(`${windowName(window)}: ${Math.round(window.usedPercent)}% 사용${resets}`);
  }
  if (statusHolds(limits, now)) {
    lines.push(limits.status === 'reached' ? '한도에 도달했어요. 초기화될 때까지 답변을 받지 못할 수 있어요.' : '한도에 가까워졌어요.');
  }
  return lines.join('\n');
}

/** The newest limits report of each provider (see the top of the file). */
export type LatestLimits = Partial<Record<ProviderId, UsageLimits>>;

/** The later of two reports (by `at`); `a` when they are equally old. */
export function newerLimits(a: UsageLimits | null | undefined, b: UsageLimits | null | undefined): UsageLimits | null {
  if (!a || !b) return a ?? b ?? null;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

/** `latest` with `limits` of `provider` when they are newer than what it has (else `latest` itself). */
export function withLatestLimits(latest: LatestLimits, provider: ProviderId, limits: UsageLimits | null | undefined): LatestLimits {
  if (!limits || newerLimits(latest[provider], limits) !== limits || latest[provider] === limits) return latest;
  return { ...latest, [provider]: limits };
}

/** LatestLimits read from storage (well-formed reports only). */
export function readLatestLimits(value: unknown): LatestLimits {
  const latest: LatestLimits = {};
  if (typeof value !== 'object' || value === null) return latest;
  for (const [provider, raw] of Object.entries(value)) {
    const limits = readUsageLimits(raw);
    if (limits) latest[provider as ProviderId] = limits;
  }
  return latest;
}
