import type { ContextInfo, LlmSwitch, MessageStatus, ProviderId, ProviderInfo } from '../../../shared/types.ts';
import { msg } from '../i18n/index.ts';

const FALLBACK_PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'anthropic-api': 'Claude API',
  'openai-api': 'OpenAI API',
};

export function providerLabel(providers: ProviderInfo[] | undefined, id: ProviderId): string {
  return providers?.find((p) => p.id === id)?.label ?? FALLBACK_PROVIDER_LABELS[id] ?? id;
}

/**
 * Name of a reasoning-effort level in the current language ("높음" / "high"); a level this client does not know
 * keeps the provider's label, else its id. (A known level is named here rather than by the provider's label, which
 * is in the language of the request that listed the providers.)
 */
export function effortName(providers: ProviderInfo[] | undefined, id: ProviderId, effort: string): string {
  const names = msg().chat.llm.effortNames;
  if (Object.hasOwn(names, effort)) return names[effort];
  return providers?.find((p) => p.id === id)?.efforts?.find((e) => e.id === effort)?.label ?? effort;
}

/** "Claude Code · sonnet · 추론 높음" (model and effort omitted when they are the defaults ''). */
export function providerWithModel(providers: ProviderInfo[] | undefined, id: ProviderId, model?: string, effort?: string): string {
  const parts = [providerLabel(providers, id)];
  if (model) parts.push(model);
  if (effort) parts.push(msg().chat.llm.reasoning(effortName(providers, id, effort)));
  return parts.join(' · ');
}

/**
 * "여기부터 Codex · gpt-5.5 · 추론 높음": the marker between the messages where the session's LLM changed (the
 * message list draws a shuffle icon before it).
 */
export function switchMarkerText(providers: ProviderInfo[] | undefined, change: LlmSwitch): string {
  return msg().chat.llm.switchMarker(providerWithModel(providers, change.to.provider, change.to.model, change.to.effort));
}

/** The marker's tooltip: when, from what to what, and that the new LLM got the slides and a recap first. */
export function switchMarkerTitle(providers: ProviderInfo[] | undefined, change: LlmSwitch): string {
  const from = providerWithModel(providers, change.from.provider, change.from.model, change.from.effort);
  const to = providerWithModel(providers, change.to.provider, change.to.model, change.to.effort);
  return msg().chat.llm.switchMarkerTitle(formatTime(change.at), from, to);
}

/** The one-line notice shown in the chat after its LLM was changed (`name` = providerWithModel of the new one). */
export function llmSwitchNotice(name: string): string {
  return msg().chat.llm.switchNotice(name);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "15:42" for today, "9/21 15:42" otherwise (in English "3:42 PM", "Sep 21, 3:42 PM"). */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const f = msg().format;
  return sameDay(d, new Date()) ? f.time(d) : f.dayTime(d);
}

/** "2026.9.21" (in English "Sep 21, 2026"). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return msg().format.date(d);
}

/** "12.3초", "2분 5초" (in English "12.3s", "2m 5s"). */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const f = msg().format;
  const s = ms / 1000;
  if (s < 60) return f.seconds(s.toFixed(1));
  const m = Math.floor(s / 60);
  return f.minutesSeconds(m, Math.round(s - m * 60));
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
  | 'switched'
  | 'deckUpdated'
  | 'rollover'
  | 'primed'
  | 'overview'
  | 'attached'
  | 'reused'
  | 'attachments'
  | 'memos';

/** One chip of the context line. Its text is plain (no emoji): the message list draws the icon of its `kind`. */
export interface ContextChip {
  kind: ContextChipKind;
  text: string;
  /** Longer explanation (tooltip). */
  title?: string;
}

/** The chip of a recovered turn: why a new conversation was started. */
function recoveredChip(from: NonNullable<ContextInfo['recoveredFrom']>): { text: string; title: string } | undefined {
  const m = msg().chat.context;
  switch (from) {
    case 'resume_invalid':
      return { text: m.resumeInvalid, title: m.resumeInvalidTitle };
    case 'context_overflow':
      return { text: m.contextOverflow, title: m.contextOverflowTitle };
    default:
      return undefined;
  }
}

/** Human-readable description of what was sent to the LLM for a turn (one entry per chip). */
export function describeContext(ctx: ContextInfo | undefined): ContextChip[] {
  if (!ctx) return [];
  const m = msg().chat.context;
  const out: ContextChip[] = [];
  const recovered = ctx.recoveredFrom ? recoveredChip(ctx.recoveredFrom) : undefined;
  // A recovery, an LLM switch or a new version of the PDF (DESIGN §28) is a forced rollover: its chip replaces the
  // plain "new conversation" one.
  if (recovered) out.push({ kind: 'recovered', ...recovered });
  else if (ctx.switched || ctx.deckUpdated) {
    if (ctx.deckUpdated) out.push({ kind: 'deckUpdated', text: m.deckUpdated, title: m.deckUpdatedTitle });
    if (ctx.switched) out.push({ kind: 'switched', text: m.switched, title: m.switchedTitle });
  } else if (ctx.rollover) out.push({ kind: 'rollover', text: m.rollover });
  if (ctx.primed) out.push({ kind: 'primed', text: m.primed });
  if (ctx.overviewImages > 0) out.push({ kind: 'overview', text: m.overviewImages(ctx.overviewImages) });
  const attached = [...(ctx.attachedSlides ?? [])].sort((a, b) => a - b);
  const reused = [...(ctx.reusedSlides ?? [])].sort((a, b) => a - b);
  if (attached.length > 0) out.push({ kind: 'attached', text: m.attached(pageList(attached)) });
  if (reused.length > 0) out.push({ kind: 'reused', text: m.reused(pageList(reused)) });
  const extra = ctx.attachments ?? 0;
  if (extra > 0) out.push({ kind: 'attachments', text: m.attachments(extra), title: m.attachmentsTitle });
  const memos = ctx.memos ?? 0;
  if (memos > 0) out.push({ kind: 'memos', text: m.memos(memos), title: m.memosTitle });
  return out;
}

/** The icon before a priming card's title (the message list draws it): the deck, a warning, a stop. */
export type PrimeCardIcon = 'deck' | 'failed' | 'stopped';

/** Title and style of a priming card, from the status of its answer (the deck only counts as delivered once the model answered). */
export function primeCardState(
  pageCount: number,
  pending: boolean,
  answerStatus: MessageStatus | undefined,
): { title: string; icon: PrimeCardIcon; tone: 'normal' | 'failed' | 'aborted'; delivered: boolean } {
  const m = msg().chat.primeCard;
  if (pending || answerStatus === 'streaming') {
    return { title: m.sending(pageCount), icon: 'deck', tone: 'normal', delivered: false };
  }
  switch (answerStatus) {
    case 'complete':
      return { title: m.sent(pageCount), icon: 'deck', tone: 'normal', delivered: true };
    case 'error':
      return { title: m.failed(pageCount), icon: 'failed', tone: 'failed', delivered: false };
    case 'aborted':
      return { title: m.aborted(pageCount), icon: 'stopped', tone: 'aborted', delivered: false };
    default:
      // No answer saved (e.g. an interrupted server): nothing says the deck arrived.
      return { title: m.unknown(pageCount), icon: 'deck', tone: 'aborted', delivered: false };
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
