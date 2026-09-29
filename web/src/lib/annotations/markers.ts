// 질문 표시 (DESIGN §25): where a question with a slide-region attachment was asked. Derived on the client from the
// notes the app already loads per document (every Q&A grouped by slide) and the loaded slide documents (items and
// hidden markers) — nothing is stored for a marker but its hidden key. Pure: one linear pass over the notes.
import type { MarkerKey, NotesResponse, RegionRect, SlideAnnotations } from '../../../../shared/types.ts';
import { firstLine } from '../format.ts';
import { itemBounds, sameMarkerKey } from './geometry.ts';

export interface MarkerQuestion {
  key: MarkerKey;
  /** The question's first line (or "(첨부만 보냄)"). */
  label: string;
  createdAt: string;
  sessionId: string;
  messageId: string;
}

/** One badge on a slide: the questions asked about the same item or the same region, newest first. */
export interface QuestionMarker {
  /** The newest question's key (what the badge opens). */
  key: MarkerKey;
  rect: RegionRect;
  label: string;
  sessionId: string;
  messageId: string;
  createdAt: string;
  /** The item the attachment was made from, when it is still on the slide (the marker then follows it). */
  itemId?: string;
  count: number;
  questions: MarkerQuestion[];
}

export const NO_TEXT_LABEL = '(첨부만 보냄)';
export const MARKER_LABEL_CHARS = 80;

const rectKey = (r: RegionRect) => `${r.x},${r.y},${r.w},${r.h}`;

/**
 * The markers of every loaded slide: for every region attachment of every question in the notes, a marker on the
 * attachment's slide (not the question's — the region may be on another slide), anchored to the item it was made
 * from when that item is still there, else to the attachment's rect; hidden keys (the slide document's
 * `hiddenMarkers`) are left out; questions on one anchor stack into one marker with a count. Slides whose document
 * is not loaded get nothing (their hidden keys are unknown). Empty when the setting is off.
 */
export function deriveMarkers(
  notes: NotesResponse | null,
  docFor: (slide: number) => SlideAnnotations | undefined,
  enabled = true,
): Map<number, QuestionMarker[]> {
  const out = new Map<number, QuestionMarker[]>();
  if (!enabled || !notes) return out;
  const groups = new Map<number, Map<string, QuestionMarker>>();
  for (const group of notes.slides) {
    for (const entry of group.entries) {
      const question = entry.question;
      for (const a of question.attachments ?? []) {
        if (a.kind !== 'region' || !a.slide || !a.rect) continue;
        const doc = docFor(a.slide);
        if (!doc) continue;
        const key: MarkerKey = { sessionId: entry.sessionId, messageId: question.id, attachmentId: a.id };
        if (doc.hiddenMarkers.some((k) => sameMarkerKey(k, key))) continue;
        const item = a.annotation ? doc.items.find((it) => it.id === a.annotation?.id) : undefined;
        const rect = item ? itemBounds(item) : a.rect;
        const anchor = item ? `item:${item.id}` : `rect:${rectKey(rect)}`;
        const q: MarkerQuestion = {
          key,
          label: firstLine(question.text, MARKER_LABEL_CHARS) || NO_TEXT_LABEL,
          createdAt: question.createdAt,
          sessionId: entry.sessionId,
          messageId: question.id,
        };
        let bySlide = groups.get(a.slide);
        if (!bySlide) {
          bySlide = new Map();
          groups.set(a.slide, bySlide);
        }
        const marker = bySlide.get(anchor);
        if (marker) {
          marker.questions.push(q);
        } else {
          bySlide.set(anchor, {
            key,
            rect,
            label: q.label,
            sessionId: q.sessionId,
            messageId: q.messageId,
            createdAt: q.createdAt,
            ...(item ? { itemId: item.id } : {}),
            count: 0,
            questions: [q],
          });
        }
      }
    }
  }
  for (const [slide, bySlide] of groups) {
    const markers: QuestionMarker[] = [];
    for (const marker of bySlide.values()) {
      marker.questions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      const newest = marker.questions[0];
      markers.push({
        ...marker,
        key: newest.key,
        label: newest.label,
        sessionId: newest.sessionId,
        messageId: newest.messageId,
        createdAt: newest.createdAt,
        count: marker.questions.length,
      });
    }
    markers.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    out.set(slide, markers);
  }
  return out;
}

/** The number of questions asked with an item (the item menu's "이 필기로 물어본 질문 N개"). */
export function questionsOnItem(markers: readonly QuestionMarker[] | undefined, itemId: string): number {
  if (!markers) return 0;
  let n = 0;
  for (const m of markers) if (m.itemId === itemId) n += m.count;
  return n;
}
