import { EFFORT_LABELS } from '../../../shared/types.ts';
import type { ContextInfo, MessageStatus, ProviderId, ProviderInfo } from '../../../shared/types.ts';

const FALLBACK_PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'anthropic-api': 'Claude API',
  'openai-api': 'OpenAI API',
};

export function providerLabel(providers: ProviderInfo[] | undefined, id: ProviderId): string {
  return providers?.find((p) => p.id === id)?.label ?? FALLBACK_PROVIDER_LABELS[id] ?? id;
}

/** Korean name of a reasoning-effort level ("높음"), as the provider lists it; the id when unknown. */
export function effortName(providers: ProviderInfo[] | undefined, id: ProviderId, effort: string): string {
  return providers?.find((p) => p.id === id)?.efforts?.find((e) => e.id === effort)?.label ?? EFFORT_LABELS[effort] ?? effort;
}

/** "Claude Code · sonnet · 추론 높음" (model and effort omitted when they are the defaults ''). */
export function providerWithModel(providers: ProviderInfo[] | undefined, id: ProviderId, model?: string, effort?: string): string {
  const parts = [providerLabel(providers, id)];
  if (model) parts.push(model);
  if (effort) parts.push(`추론 ${effortName(providers, id, effort)}`);
  return parts.join(' · ');
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "15:42" for today, "9/21 15:42" otherwise. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay(d, new Date()) ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}초`;
  const m = Math.floor(s / 60);
  return `${m}분 ${Math.round(s - m * 60)}초`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "p.12·13·14" (ascending, as given). */
export function pageList(slides: number[]): string {
  return slides.length === 0 ? '' : `p.${slides.join('·')}`;
}

export type ContextChipKind =
  | 'recovered'
  | 'rollover'
  | 'primed'
  | 'overview'
  | 'attached'
  | 'reused'
  | 'attachments';

export interface ContextChip {
  kind: ContextChipKind;
  text: string;
  /** Longer explanation (tooltip). */
  title?: string;
}

const RECOVERED_CHIPS: Record<NonNullable<ContextInfo['recoveredFrom']>, { text: string; title: string }> = {
  resume_invalid: {
    text: '🔄 이전 대화를 잃어 새 대화로 다시 전달',
    title:
      'LLM 쪽 이전 대화를 이어갈 수 없어서(만료·삭제 등) 새 대화를 시작하고, 슬라이드와 최근 대화 요약을 다시 전달한 뒤 답했어요.',
  },
  context_overflow: {
    text: '🔄 대화가 길어져 새 대화로 전달',
    title: 'LLM 대화가 너무 길어져서 새 대화를 시작하고, 슬라이드와 최근 대화 요약을 다시 전달한 뒤 답했어요.',
  },
};

/** Human-readable description of what was sent to the LLM for a turn (one entry per chip). */
export function describeContext(ctx: ContextInfo | undefined): ContextChip[] {
  if (!ctx) return [];
  const out: ContextChip[] = [];
  const recovered = ctx.recoveredFrom ? RECOVERED_CHIPS[ctx.recoveredFrom] : undefined;
  // A recovery is a forced rollover: its chip replaces the plain "new conversation" one.
  if (recovered) out.push({ kind: 'recovered', ...recovered });
  else if (ctx.rollover) out.push({ kind: 'rollover', text: '🔄 새 대화로 이어감' });
  if (ctx.primed) out.push({ kind: 'primed', text: '📚 전체 슬라이드 전달' });
  if (ctx.overviewImages > 0) out.push({ kind: 'overview', text: `개요 이미지 ${ctx.overviewImages}장` });
  const attached = [...(ctx.attachedSlides ?? [])].sort((a, b) => a - b);
  const reused = [...(ctx.reusedSlides ?? [])].sort((a, b) => a - b);
  if (attached.length > 0) out.push({ kind: 'attached', text: `🖼 ${pageList(attached)} 첨부` });
  if (reused.length > 0) out.push({ kind: 'reused', text: `↺ ${pageList(reused)} 이미 전달됨` });
  const extra = ctx.attachments ?? 0;
  if (extra > 0) {
    out.push({
      kind: 'attachments',
      text: `📎 첨부 ${extra}개`,
      title: '질문과 함께 보낸 선택 영역·이미지 (선택 영역은 그 안의 텍스트도 함께 전달돼요)',
    });
  }
  return out;
}

/** Title and style of a priming card, from the status of its answer (the deck only counts as delivered once the model answered). */
export function primeCardState(
  pageCount: number,
  pending: boolean,
  answerStatus: MessageStatus | undefined,
): { title: string; tone: 'normal' | 'failed' | 'aborted'; delivered: boolean } {
  const deck = `전체 슬라이드 ${pageCount}장`;
  if (pending || answerStatus === 'streaming') {
    return { title: `📚 ${deck}을 LLM에게 전달하는 중…`, tone: 'normal', delivered: false };
  }
  switch (answerStatus) {
    case 'complete':
      return { title: `📚 ${deck}을 LLM에게 전달했어요`, tone: 'normal', delivered: true };
    case 'error':
      return { title: `⚠️ ${deck}을 LLM에게 전달하지 못했어요`, tone: 'failed', delivered: false };
    case 'aborted':
      return { title: `⏹ ${deck} 전달이 중단됐어요`, tone: 'aborted', delivered: false };
    default:
      // No answer saved (e.g. an interrupted server): nothing says the deck arrived.
      return { title: `📚 ${deck} 전달 (결과를 알 수 없어요)`, tone: 'aborted', delivered: false };
  }
}

export function firstLine(text: string, max = 120): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * `sizes` attribute for a slide rendered `width` CSS px wide (zoom included): rounded up to 50 px, so a
 * divider drag does not re-render every slide on each pixel, and a little generous rather than blurry.
 * Null while the width is unknown (the image is then not rendered yet).
 */
export function slideSizes(width: number): string | null {
  if (!Number.isFinite(width) || width <= 0) return null;
  return `${Math.ceil(width / 50) * 50}px`;
}
