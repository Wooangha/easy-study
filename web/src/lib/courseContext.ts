// What the LLM really gets about the earlier lectures of a course (DESIGN §12): the lecture summary of
// each earlier lecture whose 정리본 (digest) is finished, only the title of the others. CLI providers can
// also open the other lectures' files. The UI copy is built from this instead of promising summaries.
import type { Course, DocMeta, ProviderId, ProviderInfo } from '../../../shared/types.ts';

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
  const files = opensFiles ? ' 필요하면 이전 강의 파일(정리본·슬라이드)도 열어 봐요.' : '';
  if (earlier.total === 0) return `${courseTitle}의 ${index}강이에요.`;
  if (earlier.withSummary === earlier.total) {
    return `${courseTitle}의 ${index}강이라서 이전 강의 ${earlier.total}개의 요약도 함께 전달해요.${files}`;
  }
  const running = earlier.running > 0 ? ` (${earlier.running}개는 정리본을 만드는 중)` : '';
  const summaries =
    earlier.withSummary === 0
      ? `이전 강의 ${earlier.total}개 중 요약이 있는 강의가 아직 없어서 제목만 전달해요${running}.`
      : `이전 강의 ${earlier.total}개 중 요약이 있는 ${earlier.withSummary}개만 요약을 전달하고, 나머지는 제목만 전달해요${running}.`;
  return `${courseTitle}의 ${index}강 — ${summaries} 강의 요약은 그 강의의 정리본이 완성되면 생겨요.${files}`;
}

/** Tooltip of the course badge in the chat header. */
export function courseBadgeTitle(courseTitle: string, index: number, earlier: EarlierLectures): string {
  const base = `과목 ‘${courseTitle}’의 ${index}번째 강의`;
  if (earlier.total === 0) return `${base} (클릭하면 COURSE.md)`;
  return `${base} — 이전 강의 ${earlier.total}개 중 요약(정리본)이 있는 ${earlier.withSummary}개의 요약을 LLM에게 함께 전달해요 (클릭하면 COURSE.md)`;
}
