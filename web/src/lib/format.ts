import type { ContextInfo, ProviderId, ProviderInfo } from '../../../shared/types.ts';

const FALLBACK_PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'anthropic-api': 'Claude API',
  'openai-api': 'OpenAI API',
};

export function providerLabel(providers: ProviderInfo[] | undefined, id: ProviderId): string {
  return providers?.find((p) => p.id === id)?.label ?? FALLBACK_PROVIDER_LABELS[id] ?? id;
}

/** "Claude Code · sonnet" (model omitted when it is the provider default ''). */
export function providerWithModel(providers: ProviderInfo[] | undefined, id: ProviderId, model?: string): string {
  const label = providerLabel(providers, id);
  return model ? `${label} · ${model}` : label;
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

export function pageList(slides: number[]): string {
  return slides.map((n) => `p.${n}`).join(', ');
}

/** Human-readable description of what was sent to the LLM for a turn (one entry per chip). */
export function describeContext(ctx: ContextInfo | undefined): string[] {
  if (!ctx) return [];
  const out: string[] = [];
  if (ctx.rollover) out.push('🔄 새 대화로 이어감');
  if (ctx.primed) out.push('📚 전체 슬라이드 전달');
  if (ctx.overviewImages > 0) out.push(`개요 이미지 ${ctx.overviewImages}장`);
  if (ctx.attachedSlides.length > 0) out.push(`🖼 ${pageList(ctx.attachedSlides)} 이미지 첨부`);
  if (ctx.reusedSlides.length > 0) out.push(`↺ ${pageList(ctx.reusedSlides)} 이미 전달됨`);
  return out;
}

export function firstLine(text: string, max = 120): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
