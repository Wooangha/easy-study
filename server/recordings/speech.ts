// Lecture speech for the tutor (DESIGN §22 "Tutor context"), resolved by chat.ts into BuildTurnInput.lectureSpeech:
// per slide of the focus window what the professor said on it (from every recording of the document with a
// transcript, newest recording first; capped 1500 characters per slide and 4000 in total, the focused slide first),
// and while a live recording of the document runs, the last minutes of speech (capped 3000, the latest kept).
import type { TranscriptSegment } from '../../shared/types.ts';
import type { BuildTurnInput } from '../internal-types.ts';
import { recordingsForSpeech } from './service.ts';

export const SPEECH_SLIDE_CHARS = 1_500;
export const SPEECH_TOTAL_CHARS = 4_000;
export const RECENT_SPEECH_CHARS = 3_000;
export const RECENT_SPEECH_MINUTES = 3;

type LectureSpeech = NonNullable<BuildTurnInput['lectureSpeech']>;

function joinText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first `max` characters (whole code points), with "…" when cut. */
export function capStart(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** The last `max` characters, with "…" in front when cut (recent speech keeps its end). */
export function capEnd(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `…${chars.slice(chars.length - Math.max(0, max - 1)).join('').trimStart()}`;
}

/**
 * Lecture speech for a turn on `slide` with the focus window `windowSlides`. undefined when the document has no
 * transcribed recording (the tutor is then not told about recordings at all).
 */
export async function lectureSpeechFor(docId: string, slide: number, windowSlides: number[]): Promise<LectureSpeech | undefined> {
  const recordings = (await recordingsForSpeech(docId))
    .filter((r) => r.segments.length > 0 && r.meta.status !== 'error')
    .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
  if (recordings.length === 0) return undefined;

  // Focused slide first, then the neighbours nearest first, share the total.
  const order = [...new Set(windowSlides)].sort((a, b) => Math.abs(a - slide) - Math.abs(b - slide) || a - b);
  let budget = SPEECH_TOTAL_CHARS;
  const bySlide: LectureSpeech['bySlide'] = [];
  for (const s of order) {
    if (budget <= 0) break;
    const parts = recordings.map((r) => joinText(r.segments.filter((seg) => seg.slide === s))).filter(Boolean);
    if (parts.length === 0) continue;
    const text = capStart(parts.join(' … '), Math.min(SPEECH_SLIDE_CHARS, budget));
    budget -= [...text].length;
    bySlide.push({ slide: s, text });
  }
  bySlide.sort((a, b) => a.slide - b.slide);

  const speech: LectureSpeech = { bySlide };
  const live = recordings.find((r) => r.live);
  if (live) {
    const end = Math.max(live.durationSec, ...live.segments.map((s) => s.end));
    const minutes = Math.max(1, Math.min(RECENT_SPEECH_MINUTES, Math.ceil(end / 60)));
    const from = end - RECENT_SPEECH_MINUTES * 60;
    const text = joinText(live.segments.filter((s) => s.end > from).sort((a, b) => a.start - b.start));
    if (text) speech.recent = { text: capEnd(text, RECENT_SPEECH_CHARS), minutes };
  }
  return speech;
}
