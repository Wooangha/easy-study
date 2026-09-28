import { Fragment, useEffect, useReducer } from 'react';
import type { ProviderId, ProviderInfo, SessionUsage, TokenUsage, UsageLimits } from '../../../shared/types.ts';
import { addSessionUsage } from '../../../shared/usage.ts';
import { providerLabel } from '../lib/format.ts';
import { limitItems, limitsAge, limitsTitle, nextLimitsChange, sessionUsageSummary } from '../lib/usage.ts';

interface UsageBarProps {
  provider: ProviderId;
  providers: ProviderInfo[] | undefined;
  /** The session's saved totals. */
  usage: SessionUsage | undefined;
  /** Answers of the session whose tokens are not in `usage` (saved before usage was recorded). */
  unrecorded: number;
  /** Tokens of the turn streaming right now (not in `usage` yet). */
  live: TokenUsage | null;
  /** The streaming turn feeds the deck. */
  livePriming: boolean;
  /** The subscription's newest usage limits (the account's, whichever session reported them). */
  limits: UsageLimits | null | undefined;
}

/** Longest timer delay (setTimeout overflows past 2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * "이 세션 12.3만 토큰 · 5시간 한도 12% · 주간 9%" under the composer (DESIGN §23), exact numbers and reset times in the
 * tooltips (and the labels read by screen readers); nothing when neither is known (sessions made before usage was
 * recorded, providers that report none). Re-renders by itself when a window resets.
 */
export function UsageBar({ provider, providers, usage, unrecorded, live, livePriming, limits }: UsageBarProps) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const now = Date.now();
  const next = limits ? nextLimitsChange(limits, now) : null;
  useEffect(() => {
    if (next === null) return;
    const timer = window.setTimeout(rerender, Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now()) + 1_000));
    return () => window.clearTimeout(timer);
  }, [next]);

  const total = addSessionUsage(usage, live ?? undefined, livePriming);
  const items = limitItems(limits, now);
  if (!total && items.length === 0) return null;
  const summary = total ? sessionUsageSummary(total, unrecorded) : null;
  const age = limits && items.length > 0 ? limitsAge(limits, now) : null;
  const title = limits && items.length > 0 ? limitsTitle(limits, now, providerLabel(providers, provider)) : '';
  // Items are inline text: a separator ends the item before it, so a wrapped line never starts with one.
  return (
    <div className="usage-bar">
      {summary && (
        <span className="usage-item usage-total" role="note" title={summary.title} aria-label={summary.title.replaceAll('\n', ', ')}>
          {summary.text}
        </span>
      )}
      {items.length > 0 && (
        <>
          {summary && ' '}
          <span className="usage-limits" role="note" title={title} aria-label={title.replaceAll('\n', ', ')}>
            {items.map((item, i) => (
              <Fragment key={item.text}>
                {i > 0 && ' '}
                <span className={`usage-item usage-limit is-${item.level}`}>{item.text}</span>
              </Fragment>
            ))}
            {age && (
              <>
                {' '}
                <span className="usage-item usage-age">{age}</span>
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
}
