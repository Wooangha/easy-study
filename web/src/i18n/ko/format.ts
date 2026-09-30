// Korean (the reference language) — namespace `format`: dates, times, sizes, durations and relative times (formatted with Intl in the current language, see intlLocale).
//
// Korean keeps its own compact forms ("9/21 15:42", "2026.9.21", "12.3초", "4.7만"); the other languages use Intl.

const pad2 = (n: number): string => String(n).padStart(2, '0');
const hm = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const oneDecimal = (n: number): string => n.toFixed(1).replace(/\.0$/, '');

export const format = {
  /** A time of today: "15:42". */
  time: (d: Date) => hm(d),
  /** A time of another day: "9/21 15:42". */
  dayTime: (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`,
  /** A date: "2026.9.21". */
  date: (d: Date) => `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`,
  /** A duration under a minute (`seconds` with one decimal): "12.3초". */
  seconds: (seconds: string) => `${seconds}초`,
  /** A longer duration: "2분 5초". */
  minutesSeconds: (minutes: number, seconds: number) => `${minutes}분 ${seconds}초`,
  /** A count with separators: "47,213". */
  count: (n: number) => n.toLocaleString('ko-KR'),
  /** A compact token count (a whole number ≥ 0): "820", "9,876", "4.7만", "123만", "1.2억". */
  tokens: (n: number) => {
    if (n < 10_000) return n.toLocaleString('ko-KR');
    if (n < 100_000_000) {
      const man = n / 10_000;
      return `${man >= 99.95 ? Math.round(man).toLocaleString('ko-KR') : oneDecimal(man)}만`;
    }
    return `${oneDecimal(n / 100_000_000)}억`;
  },
};
