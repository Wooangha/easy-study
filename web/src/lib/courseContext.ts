// What the LLM really gets about the earlier lectures of a course (DESIGN §12): the lecture summary of
// each earlier lecture whose 정리본 (digest) is finished, only the title of the others. CLI providers can
// also open the other lectures' files. The UI copy is built from this instead of promising summaries.
import type { Course, DocMeta, ProviderId, ProviderInfo } from '../../../shared/types.ts';
import { msg } from '../i18n/index.ts';

export interface EarlierLectures {
  /** Lectures before this one in the course. */
  total: number;
  /** Earlier lectures with a finished digest (their summary is sent). */
  withSummary: number;
  /** Earlier lectures whose digest is being made right now. */
  running: number;
  /** Earlier ready lectures without a finished digest that could be digested now. */
  missing: DocMeta[];
}

/** Earlier lectures of `course` before position `index` (1-based) and the state of their summaries. */
export function earlierLectures(course: Course, index: number, docs: DocMeta[] | null): EarlierLectures {
  const byId = new Map((docs ?? []).map((d) => [d.id, d]));
  const earlier = course.docIds.slice(0, Math.max(0, index - 1));
  let withSummary = 0;
  let running = 0;
  const missing: DocMeta[] = [];
  for (const id of earlier) {
    const d = byId.get(id);
    if (!d) continue;
    if (d.digestStatus === 'ready') withSummary++;
    else if (d.digestStatus === 'running') running++;
    else if (d.status === 'ready') missing.push(d);
  }
  return { total: earlier.length, withSummary, running, missing };
}

/** Whether the provider can open files (the CLI agents); API providers only get the text we send. */
export function canOpenFiles(providers: ProviderInfo[] | undefined, id: ProviderId): boolean {
  const kind = providers?.find((p) => p.id === id)?.kind;
  return kind ? kind === 'cli' : id === 'claude-code' || id === 'codex';
}

/** One sentence about the course context of lecture `index` of `courseTitle`, for the chat empty state (after a folder icon). */
export function courseContextSentence(
  courseTitle: string,
  index: number,
  earlier: EarlierLectures,
  opensFiles: boolean,
): string {
  const m = msg().chat.course;
  const files = opensFiles ? m.opensFiles : '';
  if (earlier.total === 0) return m.first(courseTitle, index);
  if (earlier.withSummary === earlier.total) return `${m.allSummaries(courseTitle, index, earlier.total)}${files}`;
  const summaries =
    earlier.withSummary === 0
      ? m.noSummaries(courseTitle, index, earlier.total, earlier.running)
      : m.someSummaries(courseTitle, index, earlier.total, earlier.withSummary, earlier.running);
  return `${summaries}${m.summariesLater}${files}`;
}

/** Tooltip of the course badge in the chat header. */
export function courseBadgeTitle(courseTitle: string, index: number, earlier: EarlierLectures): string {
  const m = msg().chat.course;
  if (earlier.total === 0) return m.badgeTitle(courseTitle, index);
  return m.badgeTitleSummaries(courseTitle, index, earlier.total, earlier.withSummary);
}
