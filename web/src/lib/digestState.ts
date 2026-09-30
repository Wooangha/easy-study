// What the 정리본 (digest) panel shows and offers, derived from DigestInfo (DESIGN §11). Pure, so it is
// unit-tested in web/tests.
import type { DigestInfo } from '../../../shared/types.ts';
import { msg } from '../i18n/index.ts';
import { clamp } from './format.ts';

export interface DigestView {
  total: number;
  failed: number;
  done: number;
  hasAny: boolean;
  running: boolean;
  /** Every slide has a usable entry and the job ended normally. */
  complete: boolean;
  /**
   * Every slide is there but the lecture summary still has to be (re)written: there is none, or the last run
   * could not rewrite it. On a 'ready' digest without failed slides the server's only possible note is that
   * summary failure (the record is then `summaryStale` on the server). A plain (non-force) run then only
   * writes the summary, so the panel offers that instead of a full redo.
   */
  summaryPending: boolean;
  /** summaryPending while an older summary is shown: it was written before the slides last changed. */
  summaryOutdated: boolean;
}

export function digestView(info: DigestInfo, pageCount: number): DigestView {
  const total = info.total > 0 ? info.total : pageCount;
  const failed = info.slides.filter((s) => s.failed).length;
  const done = clamp(info.done, 0, total);
  const complete = info.status === 'ready' && failed === 0 && done >= total;
  const summaryPending = complete && (!info.summary || !!info.error);
  return {
    total,
    failed,
    done,
    hasAny: info.slides.length > 0,
    running: info.status === 'running',
    complete,
    summaryPending,
    summaryOutdated: summaryPending && !!info.summary,
  };
}

/** The icon before a digest label (DigestPanel draws it; the texts themselves are plain). */
export type DigestIcon = 'continue' | 'retry' | 'summary' | 'running' | 'ready' | 'paused' | 'error';

export interface DigestLabel {
  icon: DigestIcon | null;
  text: string;
}

/** Label of the non-force start button, or null when there is nothing to continue (only "다시 만들기"). */
export function digestContinueLabel(info: DigestInfo, v: DigestView): DigestLabel | null {
  if (v.running || (v.complete && !v.summaryPending)) return null;
  const m = msg().chat.digest;
  if (v.done < v.total || info.status !== 'ready') return { icon: 'continue', text: m.continue };
  if (v.failed > 0) return { icon: 'retry', text: m.retryFailed };
  return { icon: 'summary', text: v.summaryOutdated ? m.redoSummary : m.makeSummary };
}

/** Status headline; counts are left to the progress bar whenever it is shown (i.e. not complete). */
export function digestStatusLabel(info: DigestInfo, v: DigestView): DigestLabel {
  const m = msg().chat.digest;
  switch (info.status) {
    case 'running':
      return { icon: 'running', text: m.statusRunning };
    case 'ready': {
      let text: string;
      if (v.failed > 0) text = m.statusFailed(v.failed);
      else if (!v.complete) text = m.statusPartial;
      else if (v.summaryOutdated) text = m.statusSummaryOutdated(v.total);
      else text = v.summaryPending ? m.statusNoSummary(v.total) : m.statusComplete(v.total);
      return { icon: 'ready', text };
    }
    case 'aborted':
      return { icon: 'paused', text: m.statusAborted };
    case 'error':
      return { icon: 'error', text: m.statusError };
    default:
      return { icon: null, text: m.statusNone };
  }
}

/**
 * The note under the status line (null for none): the server's message as it is (it is already a full
 * sentence — "슬라이드 N의 정리본을 만들지 못했습니다 …", "강의 요약을 만들지 못했습니다: …", …), plus, when the
 * summary is what is missing, what the summary-only button does. DigestPanel draws a warning icon before it.
 */
export function digestNote(info: DigestInfo, v: DigestView): { message: string; hint: string | null } | null {
  if (!info.error || v.running) return null;
  const m = msg().chat.digest;
  let hint: string | null = null;
  if (v.summaryOutdated) hint = m.hintOutdated;
  else if (v.summaryPending) hint = m.hintMissing;
  return { message: info.error, hint };
}
