// English — namespace `format` (the Korean reference: ../ko/format.ts).
import type { format as ko } from '../ko/format.ts';

// Made once (a formatter is costly to create; lists format a time per row).
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY_TIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const format = {
  time: (d) => TIME.format(d),
  dayTime: (d) => DAY_TIME.format(d),
  date: (d) => DATE.format(d),
  seconds: (seconds) => `${seconds}s`,
  minutesSeconds: (minutes, seconds) => `${minutes}m ${seconds}s`,
  count: (n) => n.toLocaleString('en-US'),
  /** "820", "9,876", "47.2K", "123K", "1.2M", "1.2B". */
  tokens: (n) => (n < 10_000 ? n.toLocaleString('en-US') : COMPACT.format(n)),
} satisfies typeof ko;
