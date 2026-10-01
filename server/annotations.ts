// Slide annotations (DESIGN §25): the per-slide store (library/<docId>/annotations/NNN.json, SlideAnnotations),
// its validation (whitelists per item type, caps, the byte cap), optimistic concurrency (rev / baseRev, a 409 that
// carries the current document), the per-lecture index (annotations/index.json, AnnotationSummary: rewritten after
// every write, coalesced, rebuilt from the slide files when missing), the SSE hub per document (AnnotationEvent:
// the ops of a PATCH, the document after a PUT, summary / qa nudges, pings), the library-wide tag list, and the
// memos the tutor reads ("학생의 메모", memosForTutor → chat.ts), and the remap of all of it when a new version of the
// deck replaces it (DESIGN §28: slide files renumbered, the 빠진 슬라이드 archive, memo links, the `deck` event).
//
// Nothing here runs PDFium or a worker; a write touches one small JSON file and the index. Question markers are
// never stored (they are derived from sessions on the client); only hidden ones are, by key.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ANNOTATION_COLORS,
  ANNOTATION_ID_RE,
  ATTACHMENT_ID_RE,
  DOC_ID_RE,
  MAX_ANNOTATION_ITEMS,
  MAX_ANNOTATION_OPS,
  MAX_ANNOTATION_TEXT_CHARS,
  MAX_HIDDEN_MARKERS,
  MAX_MEMO_LINKS,
  MAX_MEMO_SUMMARY_CHARS,
  MAX_MEMO_TAGS,
  MAX_SLIDE_ANNOTATION_BYTES,
  MAX_TAG_CHARS,
  MAX_TEXT_HIGHLIGHT_RECTS,
  MAX_TEXT_SIZE_PT,
  MESSAGE_ID_RE,
  MIN_TEXT_SIZE_PT,
  RECORDING_ID_RE,
  SESSION_ID_RE,
  SLIDE_PT_HEIGHT,
  TEXT_FONTS,
} from '../shared/types.ts';
import type {
  AnnotationColor,
  AnnotationEvent,
  AnnotationItem,
  AnnotationOp,
  AnnotationSummary,
  AnnotationTagsResponse,
  MarkerKey,
  MemoItem,
  MemoLink,
  MemoSummary,
  RecordedAt,
  RegionRect,
  RemovedSlide,
  SlideAnnotations,
  TextFont,
} from '../shared/types.ts';
import { HttpError } from './config.ts';
import { smsg } from './i18n.ts';
import { MAX_MEMO_CHARS, MAX_TUTOR_MEMOS, truncateText } from './context.ts';
import type { DeckMap, StudentMemo } from './internal-types.ts';
import {
  checkDeckRev,
  createKeyedQueue,
  docPaths,
  isDocSwapping,
  isNotFound,
  listStoredDocs,
  readJsonFile,
  readStoredDoc,
  rmWithRetry,
  withFsRetry,
  writeJsonAtomic,
} from './library.ts';
import type { StoredDocMeta } from './library.ts';
import { annotationFileName, pageBaseName } from './pageNames.ts';
import { EventHub, RECORDING_PING_MS } from './recordings/events.ts';
import type { SseTarget } from './recordings/events.ts';
import { currentLiveRecording } from './recordings/service.ts';
import { onSessionsChanged } from './sessions.ts';

/** The texts of this store's errors, in the request's language (DESIGN §27). */
const texts = () => smsg().library.annotations;
/** Longest accepted TextHighlightItem.engine. */
const MAX_ENGINE_CHARS = 32;
/** Decimals a stored coordinate keeps (the client sends 4; clamping must not add floating-point noise). */
const COORD_DECIMALS = 1e4;
const INDEX_FILE = 'index.json';
/** A slide file under annotations/ (any padding); index.json, deck.json and the subfolders never match. */
const SLIDE_FILE_RE = /^(\d+)\.json$/;
/** Characters of a request shown in a 400 (the putMarkers style). */
const SNIPPET_CHARS = 100;

/** Fields an `update` op may change per item type (never id, type, createdAt, recordedAt; `updatedAt` is replaced). */
const PATCHABLE_FIELDS: Readonly<Record<AnnotationItem['type'], readonly string[]>> = {
  highlight: ['color', 'rect'],
  rect: ['color', 'rect'],
  ellipse: ['color', 'rect'],
  textHighlight: ['color', 'rects', 'chars', 'engine', 'text'],
  text: ['color', 'rect', 'text', 'size', 'font', 'bold'],
  memo: ['color', 'at', 'text', 'tags', 'collapsed', 'tutor', 'links', 'size'],
};
const ITEM_TYPES: ReadonlySet<string> = new Set(Object.keys(PATCHABLE_FIELDS));

export interface AnnotationsConfig {
  /** SSE ping interval of the annotation streams. */
  pingMs: number;
  /** How long index.json writes are coalesced after a slide write. */
  indexDebounceMs: number;
  /** How long a failed index rebuild is remembered (repeated GETs do not re-read every slide file meanwhile). */
  rebuildFailureTtlMs: number;
  /**
   * The live recording of a document and its clock (DESIGN §25 "Recording timeline"): an `add` without `recordedAt`
   * is stamped with it. Default: recordings/service.ts (`durationSec` of the live recording when it is this
   * document's); tests inject a fake.
   */
  liveRecording: (docId: string) => Promise<RecordedAt | null>;
}

async function defaultLiveRecording(docId: string): Promise<RecordedAt | null> {
  try {
    const live = await currentLiveRecording();
    if (!live || live.docId !== docId || (live.status !== 'recording' && live.status !== 'paused')) return null;
    return { rid: live.id, t: round3(Math.max(0, live.durationSec)) };
  } catch (err) {
    console.warn(`[annotations] live recording of ${docId} unknown: ${errorText(err)}`);
    return null;
  }
}

const DEFAULT_CONFIG: Readonly<AnnotationsConfig> = Object.freeze({
  pingMs: RECORDING_PING_MS,
  indexDebounceMs: 300,
  rebuildFailureTtlMs: 10_000,
  liveRecording: defaultLiveRecording,
});
const config: AnnotationsConfig = { ...DEFAULT_CONFIG };

/** Replaces the configuration (tests): unnamed fields go back to their defaults. */
export function configureAnnotations(partial: Partial<AnnotationsConfig> = {}): void {
  Object.assign(config, DEFAULT_CONFIG, partial);
}

/**
 * Serializes the writes of one slide (`docId/slide`), of one index (`docId/index`) and the deck remaps of a lecture's
 * slide files (`docId/deck`: remapDocAnnotations, and remapAnnotationLinks while it changes that lecture's memos).
 */
const queue = createKeyedQueue();
/** Slides of each document with writes queued or running (drainAnnotations waits for them). */
const busySlides = new Map<string, Map<number, number>>();

/** Runs a write of one slide under its queue, counted in busySlides while it waits or runs. */
function slideQueue<T>(docId: string, slide: number, task: () => Promise<T>): Promise<T> {
  let slides = busySlides.get(docId);
  if (!slides) busySlides.set(docId, (slides = new Map()));
  const counts = slides;
  counts.set(slide, (counts.get(slide) ?? 0) + 1);
  return queue(`${docId}/${slide}`, task).finally(() => {
    const left = (counts.get(slide) ?? 1) - 1;
    if (left > 0) counts.set(slide, left);
    else counts.delete(slide);
    if (counts.size === 0 && busySlides.get(docId) === counts) busySlides.delete(docId);
  });
}

/** 409 of a write while the lecture's deck is being swapped (DESIGN §28). */
function swappingError(): HttpError {
  return new HttpError(409, smsg().library.versions.swapping);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Clamped to 0..1 and rounded to 4 decimals. */
function coord(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 1) * COORD_DECIMALS) / COORD_DECIMALS;
}

function snippet(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return json.length > SNIPPET_CHARS ? `${json.slice(0, SNIPPET_CHARS)}…` : json;
}

/** HttpError 400 with a short JSON snippet of what was wrong (the putMarkers style). */
function bad(message: string, value: unknown): HttpError {
  return new HttpError(400, `${message}: ${snippet(value)}`);
}

// ---------------------------------------------------------------------------
// Validation (whitelists per item type)
// ---------------------------------------------------------------------------

function normalizeRect(raw: unknown, context: unknown): RegionRect {
  const rect = raw as Partial<RegionRect> | null;
  if (!isObject(rect) || ![rect.x, rect.y, rect.w, rect.h].every(isFiniteNumber)) {
    throw bad(texts().rectInvalid, context);
  }
  const x = coord(rect.x as number);
  const y = coord(rect.y as number);
  const w = coord(coord((rect.x as number) + (rect.w as number)) - x);
  const h = coord(coord((rect.y as number) + (rect.h as number)) - y);
  if (!(w > 0 && h > 0)) throw bad(texts().rectOutside, context);
  return { x, y, w, h };
}

function normalizePoint(raw: unknown, context: unknown): { x: number; y: number } {
  const point = raw as { x?: unknown; y?: unknown } | null;
  if (!isObject(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) throw bad(texts().pointInvalid, context);
  return { x: coord(point.x), y: coord(point.y) };
}

/** Control characters (but tabs and newlines) never make it into a text shown on the slide or given to the tutor. */
function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

function normalizeText(raw: unknown, context: unknown): string {
  if (typeof raw !== 'string') throw bad(texts().textInvalid, context);
  const text = cleanText(raw);
  if (text.length > MAX_ANNOTATION_TEXT_CHARS) throw bad(texts().textTooLong(MAX_ANNOTATION_TEXT_CHARS), context);
  return text;
}

/** Bidi controls (LRM/RLM, embeddings, overrides, isolates): a tag is a short label and never carries them. */
const BIDI_CONTROLS_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * One tag as stored: control characters (cleanText) and bidi controls removed, trimmed, inner whitespace squeezed to
 * one space, no leading '#'. '' when nothing is left.
 */
export function normalizeTag(raw: string): string {
  return cleanText(raw).replace(BIDI_CONTROLS_RE, '').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').trim();
}

function normalizeTags(raw: unknown, context: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((tag) => typeof tag === 'string')) throw bad(texts().tagsInvalid, context);
  const tags: string[] = [];
  for (const value of raw as string[]) {
    const tag = normalizeTag(value);
    if (!tag || tags.includes(tag)) continue;
    if (tag.length > MAX_TAG_CHARS) throw bad(texts().tagTooLong(MAX_TAG_CHARS), context);
    tags.push(tag);
  }
  if (tags.length > MAX_MEMO_TAGS) throw bad(texts().tooManyTags(MAX_MEMO_TAGS), context);
  return tags;
}

function normalizeLink(raw: unknown, pageCount: number, context: unknown): MemoLink {
  const link = raw as { kind?: unknown; slide?: unknown; docId?: unknown; rid?: unknown; t?: unknown } | null;
  if (!isObject(link)) throw bad(texts().linkInvalid, context);
  switch (link.kind) {
    case 'slide':
      if (!Number.isInteger(link.slide) || (link.slide as number) < 1 || (link.slide as number) > pageCount) {
        throw bad(texts().linkSlideOutOfRange(pageCount), context);
      }
      return { kind: 'slide', slide: link.slide as number };
    case 'doc': {
      if (typeof link.docId !== 'string' || !DOC_ID_RE.test(link.docId)) throw bad(texts().linkDocInvalid, context);
      if (link.slide === undefined) return { kind: 'doc', docId: link.docId };
      if (!Number.isInteger(link.slide) || (link.slide as number) < 1) throw bad(texts().linkSlideInvalid, context);
      return { kind: 'doc', docId: link.docId, slide: link.slide as number };
    }
    case 'recording':
      if (typeof link.rid !== 'string' || !RECORDING_ID_RE.test(link.rid) || !isFiniteNumber(link.t) || link.t < 0) {
        throw bad(texts().linkRecordingInvalid, context);
      }
      return { kind: 'recording', rid: link.rid, t: round3(link.t) };
    default:
      throw bad(texts().linkInvalid, context);
  }
}

function normalizeLinks(raw: unknown, pageCount: number, context: unknown): MemoLink[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw bad(texts().linksNotArray, context);
  if (raw.length > MAX_MEMO_LINKS) throw bad(texts().tooManyLinks(MAX_MEMO_LINKS), context);
  return raw.map((link) => normalizeLink(link, pageCount, context));
}

function normalizeRecordedAt(raw: unknown, context: unknown): RecordedAt {
  const stamp = raw as { rid?: unknown; t?: unknown } | null;
  if (!isObject(stamp) || typeof stamp.rid !== 'string' || !RECORDING_ID_RE.test(stamp.rid) || !isFiniteNumber(stamp.t) || stamp.t < 0) {
    throw bad(texts().recordedAtInvalid, context);
  }
  return { rid: stamp.rid, t: round3(stamp.t) };
}

function normalizeBoolean(raw: unknown, fallback: boolean, what: string, context: unknown): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') throw bad(texts().notBoolean(what), context);
  return raw;
}

/** The smallest / largest stored text size (fractions of the slide height, TextItem.size). */
const MIN_TEXT_SIZE = MIN_TEXT_SIZE_PT / SLIDE_PT_HEIGHT;
const MAX_TEXT_SIZE = MAX_TEXT_SIZE_PT / SLIDE_PT_HEIGHT;

/**
 * A text size (a fraction of the slide height): absent stays absent (the default), a number is capped to
 * MIN_TEXT_SIZE_PT … MAX_TEXT_SIZE_PT (4 decimals), anything else is 400.
 */
function normalizeSize(raw: unknown, context: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isFiniteNumber(raw)) throw bad(texts().sizeInvalid, context);
  return coord(Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, raw)));
}

function normalizeFont(raw: unknown, context: unknown): TextFont | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !TEXT_FONTS.includes(raw as TextFont)) throw bad(texts().fontInvalid, context);
  return raw as TextFont;
}

function optionalBoolean(raw: unknown, what: string, context: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  return normalizeBoolean(raw, false, what, context);
}

/** The optional fields of a type as stored: absent ones are left out of the item (old files stay as they are). */
function defined<T extends Record<string, unknown>>(fields: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out as { [K in keyof T]?: NonNullable<T[K]> };
}

/**
 * An item as the store keeps it: every field checked and whitelisted for its type (unknown fields dropped, like
 * attachments), coordinates clamped and rounded, texts capped. `createdAt` and `updatedAt` are kept when they are
 * valid ISO strings, else `now` (the write path stamps `updatedAt` itself for the items it touches). Throws
 * HttpError 400 (Korean, with a snippet) for anything wrong.
 */
export function normalizeItem(raw: unknown, pageCount: number, now: string): AnnotationItem {
  if (!isObject(raw)) throw bad(texts().itemInvalid, raw);
  const id = raw.id;
  if (typeof id !== 'string' || !ANNOTATION_ID_RE.test(id)) throw bad(texts().idInvalid, raw);
  const color = raw.color;
  if (typeof color !== 'string' || !ANNOTATION_COLORS.includes(color as AnnotationColor)) throw bad(texts().colorInvalid, raw);
  const base = {
    id,
    color: color as AnnotationColor,
    createdAt: isIso(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : now,
    ...(raw.recordedAt !== undefined && raw.recordedAt !== null ? { recordedAt: normalizeRecordedAt(raw.recordedAt, raw) } : {}),
  };
  switch (raw.type) {
    case 'highlight':
    case 'rect':
    case 'ellipse':
      return { ...base, type: raw.type, rect: normalizeRect(raw.rect, raw) };
    case 'text':
      return {
        ...base,
        type: 'text',
        rect: normalizeRect(raw.rect, raw),
        text: normalizeText(raw.text, raw),
        ...defined({ size: normalizeSize(raw.size, raw), font: normalizeFont(raw.font, raw), bold: optionalBoolean(raw.bold, 'bold', raw) }),
      };
    case 'textHighlight': {
      if (!Array.isArray(raw.rects) || raw.rects.length === 0) throw bad(texts().textHighlightRectsInvalid, raw);
      if (raw.rects.length > MAX_TEXT_HIGHLIGHT_RECTS) throw bad(texts().textHighlightTooLarge(MAX_TEXT_HIGHLIGHT_RECTS), raw);
      const chars = raw.chars as unknown[];
      if (!Array.isArray(chars) || chars.length !== 2 || !Number.isInteger(chars[0]) || !Number.isInteger(chars[1]) || (chars[0] as number) < 0 || (chars[0] as number) >= (chars[1] as number)) {
        throw bad(texts().textHighlightCharsInvalid, raw);
      }
      if (typeof raw.engine !== 'string' || !raw.engine.trim() || raw.engine.length > MAX_ENGINE_CHARS) throw bad(texts().textHighlightEngineInvalid, raw);
      return {
        ...base,
        type: 'textHighlight',
        rects: raw.rects.map((rect) => normalizeRect(rect, raw)),
        chars: [chars[0] as number, chars[1] as number],
        engine: raw.engine,
        text: normalizeText(raw.text, raw),
      };
    }
    case 'memo':
      return {
        ...base,
        type: 'memo',
        at: normalizePoint(raw.at, raw),
        text: normalizeText(raw.text, raw),
        tags: normalizeTags(raw.tags, raw),
        collapsed: normalizeBoolean(raw.collapsed, false, 'collapsed', raw),
        tutor: normalizeBoolean(raw.tutor, true, 'tutor', raw),
        links: normalizeLinks(raw.links, pageCount, raw),
        ...defined({ size: normalizeSize(raw.size, raw) }),
      };
    default:
      throw bad(texts().unknownType, raw);
  }
}

/** A marker key as stored (HttpError 400 when malformed). */
export function normalizeMarkerKey(raw: unknown): MarkerKey {
  const key = raw as Partial<MarkerKey> | null;
  if (
    !isObject(key) ||
    typeof key.sessionId !== 'string' ||
    !SESSION_ID_RE.test(key.sessionId) ||
    typeof key.messageId !== 'string' ||
    !MESSAGE_ID_RE.test(key.messageId) ||
    typeof key.attachmentId !== 'string' ||
    !ATTACHMENT_ID_RE.test(key.attachmentId)
  ) {
    throw bad(texts().markerKeyInvalid, raw);
  }
  return { sessionId: key.sessionId, messageId: key.messageId, attachmentId: key.attachmentId };
}

function sameKey(a: MarkerKey, b: MarkerKey): boolean {
  return a.sessionId === b.sessionId && a.messageId === b.messageId && a.attachmentId === b.attachmentId;
}

function normalizeMarkerKeys(raw: unknown, context: unknown): MarkerKey[] {
  if (!Array.isArray(raw)) throw bad(texts().hiddenMarkersNotArray, context);
  const keys: MarkerKey[] = [];
  for (const value of raw) {
    const key = normalizeMarkerKey(value);
    if (!keys.some((known) => sameKey(known, key))) keys.push(key);
  }
  if (keys.length > MAX_HIDDEN_MARKERS) throw bad(texts().tooManyHiddenMarkers(MAX_HIDDEN_MARKERS), context);
  return keys;
}

/** JSON bytes of the document as stored (the cap of MAX_SLIDE_ANNOTATION_BYTES). */
export function annotationBytes(doc: SlideAnnotations): number {
  return Buffer.byteLength(JSON.stringify(doc));
}

function checkCaps(items: AnnotationItem[], hiddenMarkers: MarkerKey[], doc: SlideAnnotations): void {
  if (items.length > MAX_ANNOTATION_ITEMS) throw new HttpError(400, texts().tooManyItems(MAX_ANNOTATION_ITEMS));
  if (hiddenMarkers.length > MAX_HIDDEN_MARKERS) throw new HttpError(400, texts().tooManyHiddenMarkers(MAX_HIDDEN_MARKERS));
  if (annotationBytes(doc) > MAX_SLIDE_ANNOTATION_BYTES) throw new HttpError(400, texts().tooLarge);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function emptyDoc(slide: number, now: string): SlideAnnotations {
  return { version: 1, slide, rev: 0, updatedAt: now, items: [], hiddenMarkers: [] };
}

/** The document of a slide file as stored, checked; null when the file is malformed (logged: treated as empty). */
function normalizeStoredDoc(value: unknown, slide: number, pageCount: number, file: string): SlideAnnotations | null {
  const raw = value as Partial<SlideAnnotations> | null;
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.items) || !Array.isArray(raw.hiddenMarkers) || !Number.isInteger(raw.rev) || (raw.rev as number) < 0) {
    console.warn(`[annotations] ignoring malformed ${file}`);
    return null;
  }
  const now = new Date().toISOString();
  const items: AnnotationItem[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  for (const entry of raw.items) {
    try {
      const item = normalizeItem(entry, pageCount, now);
      if (ids.has(item.id)) throw new Error('duplicate id');
      ids.add(item.id);
      items.push(item);
    } catch {
      dropped++;
    }
  }
  const hiddenMarkers: MarkerKey[] = [];
  for (const entry of raw.hiddenMarkers) {
    try {
      const key = normalizeMarkerKey(entry);
      if (!hiddenMarkers.some((known) => sameKey(known, key))) hiddenMarkers.push(key);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) console.warn(`[annotations] ${file}: dropped ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'}`);
  return { version: 1, slide, rev: raw.rev as number, updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : now, items, hiddenMarkers: hiddenMarkers.slice(0, MAX_HIDDEN_MARKERS) };
}

/** The slide's file, padded like text/NNN.txt; a file from a rendering with another padding is found too. */
function slideFileCandidates(dir: string, slide: number, pageCount: number): string[] {
  const padded = path.join(dir, annotationFileName(slide, pageCount));
  const plain = path.join(dir, `${slide}.json`);
  return padded === plain ? [padded] : [padded, plain];
}

/** The stored document of a slide, or null when there is none (a malformed file counts as none). Never throws on content. */
async function readSlideFile(docId: string, slide: number, pageCount: number): Promise<SlideAnnotations | null> {
  const dir = docPaths(docId).annotationsDir;
  for (const file of slideFileCandidates(dir, slide, pageCount)) {
    const value = await readJsonFile<unknown>(file);
    if (value === null) continue;
    return normalizeStoredDoc(value, slide, pageCount, file);
  }
  return null;
}

async function requireDoc(docId: string): Promise<StoredDocMeta> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  return doc;
}

function checkSlide(slide: number, pageCount: number): void {
  if (!Number.isInteger(slide) || slide < 1 || slide > pageCount) throw new HttpError(404, smsg().common.notFound.slide);
}

/**
 * GET …/annotations/:slide: the slide's document, or the empty one (rev 0) when it has no file. 404 for an unknown
 * document or a slide past its page count (items on slides past a re-ingest's smaller count are ignored).
 */
export async function readSlideAnnotations(docId: string, slide: number): Promise<SlideAnnotations> {
  const doc = await requireDoc(docId);
  checkSlide(slide, doc.pageCount);
  return (await readSlideFile(docId, slide, doc.pageCount)) ?? emptyDoc(slide, new Date().toISOString());
}

/** Makes library/<docId>/annotations when it is missing — never the document folder itself (a deleted document stays deleted). */
async function ensureAnnotationsDir(docId: string): Promise<string> {
  const dir = docPaths(docId).annotationsDir;
  try {
    await withFsRetry(() => fs.mkdir(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return dir;
    if (isNotFound(err)) throw new HttpError(404, smsg().common.notFound.doc);
    throw err;
  }
  return dir;
}

async function writeSlideFile(docId: string, doc: SlideAnnotations, pageCount: number): Promise<void> {
  const dir = await ensureAnnotationsDir(docId);
  try {
    await writeJsonAtomic(path.join(dir, annotationFileName(doc.slide, pageCount)), doc);
  } catch (err) {
    if (isNotFound(err)) throw new HttpError(404, smsg().common.notFound.doc);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Writes: PUT (replace) and PATCH (ops), under the slide's queue
// ---------------------------------------------------------------------------

function parseBaseRev(body: Record<string, unknown>, current: SlideAnnotations): void {
  const baseRev = body.baseRev;
  if (!Number.isInteger(baseRev) || (baseRev as number) < 0) throw new HttpError(400, texts().baseRevRequired);
  if (baseRev !== current.rev) throw new HttpError(409, texts().conflict, { current });
}

function jsonBody(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(400, smsg().common.http.bodyInvalid);
  return body;
}

/** Everything of an item but its `updatedAt`, for "did it change" comparisons. */
function contentOf(item: AnnotationItem): string {
  const { updatedAt: _updatedAt, ...rest } = item;
  return JSON.stringify(rest);
}

/**
 * The recording stamp of a new item (DESIGN §25 "Recording timeline"): the client's when it sent one, else the
 * server's live recording of the document (the two-device case), else none. A memo gets the matching 🎙 link.
 */
function stampRecording(item: AnnotationItem, live: RecordedAt | null): AnnotationItem {
  if (item.recordedAt || !live || !RECORDING_ID_RE.test(live.rid) || !isFiniteNumber(live.t)) return item;
  const stamp: RecordedAt = { rid: live.rid, t: round3(Math.max(0, live.t)) };
  const stamped: AnnotationItem = { ...item, recordedAt: stamp };
  if (stamped.type === 'memo' && stamped.links.length < MAX_MEMO_LINKS && !stamped.links.some((link) => link.kind === 'recording' && link.rid === stamp.rid)) {
    stamped.links = [...stamped.links, { kind: 'recording', rid: stamp.rid, t: stamp.t }];
  }
  return stamped;
}

interface WriteOutcome {
  doc: SlideAnnotations;
  /** The events to send once the file is written (the writer's own client is skipped). */
  events: AnnotationEvent[];
}

/** Whether `add` ops (or PUT items) without a stamp exist, so the live recording is only looked up when needed. */
async function liveFor(docId: string, wanted: boolean): Promise<RecordedAt | null> {
  if (!wanted) return null;
  try {
    return await config.liveRecording(docId);
  } catch (err) {
    console.warn(`[annotations] live recording of ${docId} unknown: ${errorText(err)}`);
    return null;
  }
}

async function buildPut(docId: string, current: SlideAnnotations, body: Record<string, unknown>, pageCount: number, now: string): Promise<WriteOutcome> {
  if (!Array.isArray(body.items)) throw new HttpError(400, texts().itemsRequired);
  if (body.items.length > MAX_ANNOTATION_ITEMS) throw new HttpError(400, texts().tooManyItems(MAX_ANNOTATION_ITEMS));
  const before = new Map(current.items.map((item) => [item.id, item]));
  const live = await liveFor(
    docId,
    body.items.some((entry) => isObject(entry) && typeof entry.id === 'string' && !before.has(entry.id) && !entry.recordedAt),
  );
  const items: AnnotationItem[] = [];
  const ids = new Set<string>();
  for (const entry of body.items) {
    let item = normalizeItem(entry, pageCount, now);
    if (ids.has(item.id)) throw bad(texts().duplicateId, entry);
    ids.add(item.id);
    const previous = before.get(item.id);
    if (previous) {
      // A creation-only stamp never changes through a PUT; an untouched item keeps its updatedAt.
      item = previous.recordedAt ? { ...item, recordedAt: previous.recordedAt } : item;
      if (!previous.recordedAt) delete item.recordedAt;
      item.updatedAt = contentOf(item) === contentOf(previous) ? previous.updatedAt : now;
    } else {
      item = stampRecording({ ...item, updatedAt: now }, live);
    }
    items.push(item);
  }
  const hiddenMarkers = normalizeMarkerKeys(body.hiddenMarkers ?? [], body);
  const doc: SlideAnnotations = { version: 1, slide: current.slide, rev: current.rev + 1, updatedAt: now, items, hiddenMarkers };
  checkCaps(items, hiddenMarkers, doc);
  return { doc, events: [{ type: 'slide-reset', annotations: doc }] };
}

async function buildPatch(docId: string, current: SlideAnnotations, body: Record<string, unknown>, pageCount: number, now: string): Promise<WriteOutcome> {
  const ops = body.ops;
  if (!Array.isArray(ops) || ops.length === 0) throw new HttpError(400, texts().opsRequired);
  if (ops.length > MAX_ANNOTATION_OPS) throw new HttpError(400, texts().tooManyOps(MAX_ANNOTATION_OPS));
  const live = await liveFor(
    docId,
    ops.some((op) => isObject(op) && op.op === 'add' && isObject(op.item) && !op.item.recordedAt),
  );
  const items = current.items.slice();
  let hiddenMarkers = current.hiddenMarkers.slice();
  const applied: AnnotationOp[] = [];
  for (const raw of ops) {
    if (!isObject(raw)) throw bad(texts().opInvalid, raw);
    switch (raw.op) {
      case 'add': {
        const item = stampRecording({ ...normalizeItem(raw.item, pageCount, now), updatedAt: now }, live);
        if (items.some((known) => known.id === item.id)) throw new HttpError(409, texts().conflict, { current });
        items.push(item);
        applied.push({ op: 'add', item });
        break;
      }
      case 'update': {
        if (typeof raw.id !== 'string') throw bad(texts().opIdInvalid, raw);
        const index = items.findIndex((known) => known.id === raw.id);
        if (index < 0) throw new HttpError(409, texts().conflict, { current });
        const previous = items[index];
        if (!isObject(raw.patch)) throw bad(texts().opPatchInvalid, raw);
        const allowed = PATCHABLE_FIELDS[previous.type];
        for (const key of Object.keys(raw.patch)) {
          if (key !== 'updatedAt' && !allowed.includes(key)) throw bad(texts().unknownField(key), raw);
        }
        const { updatedAt: _updatedAt, ...changes } = raw.patch;
        const next = { ...normalizeItem({ ...previous, ...changes, id: previous.id, type: previous.type, createdAt: previous.createdAt }, pageCount, now), updatedAt: now };
        if (previous.recordedAt) next.recordedAt = previous.recordedAt;
        else delete next.recordedAt;
        items[index] = next;
        // The accepted patch as stored (normalised), so every client applies the same values; a field removed by
        // the patch (an optional one set to null) is echoed as null so every client removes it too.
        const patch: Record<string, unknown> = { updatedAt: now };
        for (const key of Object.keys(changes)) patch[key] = key in next ? (next as unknown as Record<string, unknown>)[key] : null;
        applied.push({ op: 'update', id: previous.id, patch: patch as Extract<AnnotationOp, { op: 'update' }>['patch'] });
        break;
      }
      case 'remove': {
        if (typeof raw.id !== 'string' || !ANNOTATION_ID_RE.test(raw.id)) throw bad(texts().opIdInvalid, raw);
        const index = items.findIndex((known) => known.id === raw.id);
        if (index >= 0) items.splice(index, 1);
        applied.push({ op: 'remove', id: raw.id });
        break;
      }
      case 'hideMarker': {
        const key = normalizeMarkerKey(raw.key);
        if (!hiddenMarkers.some((known) => sameKey(known, key))) hiddenMarkers.push(key);
        applied.push({ op: 'hideMarker', key });
        break;
      }
      case 'unhideMarker': {
        const key = normalizeMarkerKey(raw.key);
        hiddenMarkers = hiddenMarkers.filter((known) => !sameKey(known, key));
        applied.push({ op: 'unhideMarker', key });
        break;
      }
      default:
        throw bad(texts().unknownOp, raw);
    }
  }
  const doc: SlideAnnotations = { version: 1, slide: current.slide, rev: current.rev + 1, updatedAt: now, items, hiddenMarkers };
  checkCaps(items, hiddenMarkers, doc);
  return { doc, events: [{ type: 'slide', slide: doc.slide, rev: doc.rev, updatedAt: now, ops: applied }] };
}

/**
 * The write itself (under the slide's queue): read, check the rev, build, cap, write, index, notify. `deckRev` (the
 * request's DECK_REV_HEADER): the deck its slide number belongs to, 409 deckChanged when it is not the lecture's.
 */
async function writeSlide(
  docId: string,
  slide: number,
  body: unknown,
  client: string | undefined,
  deckRev: number | undefined,
  build: (docId: string, current: SlideAnnotations, body: Record<string, unknown>, pageCount: number, now: string) => Promise<WriteOutcome>,
): Promise<SlideAnnotations> {
  const request = jsonBody(body);
  return slideQueue(docId, slide, async () => {
    // A write queued before a swap began is refused here; drainAnnotations waited for the ones already running.
    if (isDocSwapping(docId)) throw swappingError();
    const meta = await requireDoc(docId);
    // Before the slide is read: slide N of another deck is not this deck's slide N.
    checkDeckRev(meta, deckRev);
    checkSlide(slide, meta.pageCount);
    const now = new Date().toISOString();
    const current = (await readSlideFile(docId, slide, meta.pageCount)) ?? emptyDoc(slide, now);
    parseBaseRev(request, current);
    const { doc, events } = await build(docId, current, request, meta.pageCount, now);
    await writeSlideFile(docId, doc, meta.pageCount);
    const summaryChanged = summaryKey(current) !== summaryKey(doc);
    scheduleIndexUpdate(docId, doc);
    const hub = hubs.get(docId);
    if (hub) {
      for (const event of events) hub.send(event, undefined, client);
      // The nudge reaches the writer too: its summary (memo tab, filters) changed as well.
      if (summaryChanged) hub.send({ type: 'summary' });
    }
    return doc;
  });
}

/**
 * PUT …/annotations/:slide (PutSlideAnnotationsRequest): replaces the slide's items and hidden markers. 409 with the
 * current document when `baseRev` is stale; 409 deckChanged (no document) when `deckRev` is given and is not the
 * lecture's; 400 per bad item or over a cap. `client` (the writer's X-Annotation-Client id) is not sent the resulting
 * `slide-reset` event.
 */
export function putSlideAnnotations(docId: string, slide: number, body: unknown, client?: string, deckRev?: number): Promise<SlideAnnotations> {
  return writeSlide(docId, slide, body, client, deckRev, buildPut);
}

/**
 * PATCH …/annotations/:slide (PatchSlideAnnotationsRequest): applies the ops in order on the current document
 * (`add` refuses a duplicate id and `update` a missing one with 409 + current; `remove` is idempotent; hide / unhide
 * de-duplicate keys), then the same checks as a PUT (the deck too). The `slide` event carries the ops as applied.
 */
export function patchSlideAnnotations(docId: string, slide: number, body: unknown, client?: string, deckRev?: number): Promise<SlideAnnotations> {
  return writeSlide(docId, slide, body, client, deckRev, buildPatch);
}

// ---------------------------------------------------------------------------
// The per-lecture index (annotations/index.json)
// ---------------------------------------------------------------------------

type SlideEntry = AnnotationSummary['slides'][number];

function memoTags(items: AnnotationItem[]): string[] {
  const tags = new Set<string>();
  for (const item of items) if (item.type === 'memo') for (const tag of item.tags) tags.add(tag);
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** The index entry of a slide document, or null when it has no items (the summary lists slides with items only). */
function slideEntryOf(doc: SlideAnnotations): SlideEntry | null {
  if (doc.items.length === 0) return null;
  return {
    slide: doc.slide,
    rev: doc.rev,
    items: doc.items.length,
    memos: doc.items.filter((item) => item.type === 'memo').length,
    tags: memoTags(doc.items),
  };
}

/** The first MAX_MEMO_SUMMARY_CHARS characters of a memo, at most two lines, whitespace squeezed; '…' when cut. */
export function memoSummaryText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const cut = lines.length > 2;
  let out = lines.slice(0, 2).join('\n');
  if (out.length > MAX_MEMO_SUMMARY_CHARS) out = out.slice(0, MAX_MEMO_SUMMARY_CHARS).trimEnd();
  return out.length < lines.join('\n').length || cut ? `${out}…` : out;
}

function memoSummaryOf(memo: MemoItem, slide: number): MemoSummary {
  const summary: MemoSummary = {
    id: memo.id,
    slide,
    color: memo.color,
    text: memoSummaryText(memo.text),
    tags: memo.tags,
    tutor: memo.tutor,
    createdAt: memo.createdAt,
    updatedAt: memo.updatedAt,
    links: memo.links,
  };
  if (memo.recordedAt) summary.recordedAt = memo.recordedAt;
  return summary;
}

function memoSummariesOf(doc: SlideAnnotations): MemoSummary[] {
  return doc.items.filter((item): item is MemoItem => item.type === 'memo').map((memo) => memoSummaryOf(memo, doc.slide));
}

/** What the index holds of one slide but its rev (every write bumps it), for "did the summary change" checks. */
function summaryKey(doc: SlideAnnotations): string {
  const entry = slideEntryOf(doc);
  return JSON.stringify({ entry: entry ? { ...entry, rev: 0 } : null, memos: memoSummariesOf(doc) });
}

function compareMemos(a: MemoSummary, b: MemoSummary): number {
  return a.slide - b.slide || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Tag counts over memos: most used first, then alphabetical. */
function tagCounts(memos: MemoSummary[]): AnnotationSummary['tags'] {
  const counts = new Map<string, number>();
  for (const memo of memos) for (const tag of memo.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function emptySummary(): AnnotationSummary {
  return { version: 1, slides: [], memos: [], tags: [] };
}

/** A summary with the given slides' entries and memos replaced (`null` doc = the slide has nothing). */
function withSlides(summary: AnnotationSummary, docs: Iterable<SlideAnnotations>): AnnotationSummary {
  const slides = new Map(summary.slides.map((entry) => [entry.slide, entry]));
  let memos = summary.memos.slice();
  for (const doc of docs) {
    const entry = slideEntryOf(doc);
    if (entry) slides.set(doc.slide, entry);
    else slides.delete(doc.slide);
    memos = memos.filter((memo) => memo.slide !== doc.slide).concat(memoSummariesOf(doc));
  }
  memos.sort(compareMemos);
  return {
    version: 1,
    slides: [...slides.values()].sort((a, b) => a.slide - b.slide),
    memos,
    tags: tagCounts(memos),
  };
}

function isSummary(value: unknown): value is AnnotationSummary {
  const raw = value as Partial<AnnotationSummary> | null;
  return isObject(raw) && raw.version === 1 && Array.isArray(raw.slides) && Array.isArray(raw.memos) && Array.isArray(raw.tags);
}

function indexFile(docId: string): string {
  return path.join(docPaths(docId).annotationsDir, INDEX_FILE);
}

/** Failed rebuilds, remembered for rebuildFailureTtlMs (repeated GETs do not re-read every slide file). */
const rebuildFailures = new Map<string, { at: number; error: unknown }>();

/**
 * Rebuilds the index from the slide files (readdir annotations/, every `<digits>.json` parsed once; a slide past the
 * page count or a malformed file is skipped) and writes it when the folder exists. The empty summary for a document
 * without an annotations folder (nothing is written then). Under the index queue, so a rebuild and the incremental
 * updates of slide writes are serialized: a rebuild that read a slide before a write can no longer land after that
 * write's update and put the older entry back.
 */
export function rebuildIndex(docId: string): Promise<AnnotationSummary> {
  return queue(`${docId}/index`, () => rebuildIndexNow(docId));
}

/** The rebuild itself — for callers already inside the index queue (runIndexUpdate). */
async function rebuildIndexNow(docId: string): Promise<AnnotationSummary> {
  const meta = await requireDoc(docId);
  const failure = rebuildFailures.get(docId);
  if (failure && Date.now() - failure.at < config.rebuildFailureTtlMs) throw failure.error;
  try {
    const dir = docPaths(docId).annotationsDir;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isNotFound(err)) return emptySummary();
      throw err;
    }
    const docs = new Map<number, SlideAnnotations>();
    for (const name of names) {
      const match = SLIDE_FILE_RE.exec(name);
      if (!match) continue;
      const slide = Number(match[1]);
      if (!Number.isInteger(slide) || slide < 1 || slide > meta.pageCount) continue;
      const value = await readJsonFile<unknown>(path.join(dir, name));
      const doc = value === null ? null : normalizeStoredDoc(value, slide, meta.pageCount, path.join(dir, name));
      if (!doc) continue;
      const known = docs.get(slide);
      if (!known || known.rev < doc.rev) docs.set(slide, doc);
    }
    const summary = withSlides(emptySummary(), docs.values());
    await writeJsonAtomic(indexFile(docId), summary);
    rebuildFailures.delete(docId);
    return summary;
  } catch (err) {
    const error = err instanceof HttpError ? err : new HttpError(500, texts().listUnreadable(errorText(err)));
    rebuildFailures.set(docId, { at: Date.now(), error });
    throw error;
  }
}

interface PendingIndex {
  /** Slide documents written since the last index update, the latest per slide. */
  docs: Map<number, SlideAnnotations>;
  timer: NodeJS.Timeout | null;
  /** Resolves when the pending docs have been written into the index. */
  flushed: Promise<void>;
  flush: () => void;
}

const pendingIndexes = new Map<string, PendingIndex>();
/** Index writes running right now (their pending entry is gone already): flushAnnotationIndex waits for them too. */
const runningIndexes = new Map<string, Promise<void>>();

/** Queues a slide document for the index (coalesced per document over indexDebounceMs). */
function scheduleIndexUpdate(docId: string, doc: SlideAnnotations): void {
  let pending = pendingIndexes.get(docId);
  if (!pending) {
    let flush = () => {};
    const flushed = new Promise<void>((resolve) => {
      flush = resolve;
    });
    pending = { docs: new Map(), timer: null, flushed, flush };
    pendingIndexes.set(docId, pending);
  }
  pending.docs.set(doc.slide, doc);
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    void runIndexUpdate(docId);
  }, config.indexDebounceMs);
  pending.timer.unref?.();
}

/** Writes the pending slide documents of a document into its index (under the index queue). Never throws. */
function runIndexUpdate(docId: string): Promise<void> {
  const pending = pendingIndexes.get(docId);
  if (!pending) return runningIndexes.get(docId) ?? Promise.resolve();
  pendingIndexes.delete(docId);
  if (pending.timer) clearTimeout(pending.timer);
  const previous = runningIndexes.get(docId) ?? Promise.resolve();
  const run = previous
    .then(() =>
      queue(`${docId}/index`, async () => {
        if ((await readStoredDoc(docId)) === null) return; // deleted meanwhile
        const stored = await readJsonFile<unknown>(indexFile(docId));
        // A rebuild reads the slide files, the pending ones included; applying them again is harmless.
        const base = isSummary(stored) ? stored : await rebuildIndexNow(docId).catch(() => emptySummary());
        const summary = withSlides(base, pending.docs.values());
        await ensureAnnotationsDir(docId);
        await writeJsonAtomic(indexFile(docId), summary);
      }),
    )
    .catch((err: unknown) => {
      console.warn(`[annotations] index of ${docId} not updated: ${errorText(err)}`);
    })
    .finally(() => {
      if (runningIndexes.get(docId) === run) runningIndexes.delete(docId);
      pending.flush();
    });
  runningIndexes.set(docId, run);
  return run;
}

/** Resolves once the index writes of a document (or of every document), pending or running, are done (tests, readSummary, shutdown). */
export async function flushAnnotationIndex(docId?: string): Promise<void> {
  const ids = docId === undefined ? [...new Set([...pendingIndexes.keys(), ...runningIndexes.keys()])] : [docId];
  await Promise.all(ids.map((id) => runIndexUpdate(id)));
}

/**
 * GET …/annotations: the per-lecture summary from index.json (after the pending index writes), rebuilt from the
 * slide files when the index is missing or unreadable. 404 for an unknown document.
 */
export async function readSummary(docId: string): Promise<AnnotationSummary> {
  await requireDoc(docId);
  await flushAnnotationIndex(docId);
  const stored = await readJsonFile<unknown>(indexFile(docId));
  return isSummary(stored) ? stored : rebuildIndex(docId);
}

// ---------------------------------------------------------------------------
// Library-wide tags (GET /api/annotations/tags)
// ---------------------------------------------------------------------------

/** docId → tags of its index.json, keyed by the file's identity (inode, size, mtime: it is replaced atomically). */
const tagsCache = new Map<string, { key: string; tags: AnnotationSummary['tags'] }>();

async function docTags(docId: string): Promise<AnnotationSummary['tags']> {
  let stat;
  try {
    stat = await fs.stat(indexFile(docId));
  } catch (err) {
    tagsCache.delete(docId);
    if (!isNotFound(err)) throw err;
    // No index yet: a document without an annotations folder has no tags; one with slide files gets its index built.
    try {
      await fs.access(docPaths(docId).annotationsDir);
    } catch {
      return [];
    }
    return (await readSummary(docId)).tags;
  }
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = tagsCache.get(docId);
  if (cached?.key === key) return cached.tags;
  const tags = (await readSummary(docId)).tags;
  tagsCache.set(docId, { key, tags });
  return tags;
}

/** Every tag of every lecture with its memo count (autocomplete): a few stats per call, the indexes parsed once. */
export async function listAnnotationTags(): Promise<AnnotationTagsResponse> {
  const counts = new Map<string, number>();
  for (const doc of await listStoredDocs()) {
    let tags: AnnotationSummary['tags'];
    try {
      tags = await docTags(doc.id);
    } catch (err) {
      console.warn(`[annotations] tags of ${doc.id} unavailable: ${errorText(err)}`);
      continue;
    }
    for (const { tag, count } of tags) counts.set(tag, (counts.get(tag) ?? 0) + count);
  }
  return {
    tags: [...counts]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

// ---------------------------------------------------------------------------
// SSE hubs (GET …/annotations/events)
// ---------------------------------------------------------------------------

const hubs = new Map<string, EventHub<AnnotationEvent>>();
let forwardingSessions = false;

/** Forwards session changes (a turn finished, a session deleted) to the document's subscribers as `qa`, once. */
function ensureSessionForwarding(): void {
  if (forwardingSessions) return;
  forwardingSessions = true;
  onSessionsChanged((change) => {
    hubs.get(change.docId)?.send({ type: 'qa', sessionId: change.sessionId, updatedAt: change.updatedAt });
  });
}

/**
 * Subscribes an SSE response to a document's annotation events (404 as JSON before the stream opens for an unknown
 * document). `client` (ANNOTATION_CLIENT_ID_RE, from `?client=`) keeps the subscriber's own writes from being echoed.
 * Returns the unsubscribe; an empty hub is dropped.
 */
export async function subscribeAnnotations(docId: string, target: SseTarget, client?: string): Promise<() => void> {
  await requireDoc(docId);
  ensureSessionForwarding();
  let hub = hubs.get(docId);
  if (!hub) {
    hub = new EventHub<AnnotationEvent>(config.pingMs);
    hubs.set(docId, hub);
  }
  const mine = hub;
  target.write('retry: 2000\n\n');
  mine.add(target, client);
  return () => {
    mine.remove(target);
    if (mine.size === 0 && hubs.get(docId) === mine) hubs.delete(docId);
  };
}

/** Subscribers of a document's stream (tests, diagnostics). */
export function annotationSubscribers(docId: string): number {
  return hubs.get(docId)?.size ?? 0;
}

/** A document is being deleted: its streams end, its pending index write and caches are dropped. */
export function forgetDocAnnotations(docId: string): void {
  hubs.get(docId)?.closeAll();
  hubs.delete(docId);
  const pending = pendingIndexes.get(docId);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingIndexes.delete(docId);
    pending.flush();
  }
  tagsCache.delete(docId);
  rebuildFailures.delete(docId);
}

/** Server shutdown: every annotation stream ends and the pending index writes are flushed. */
export async function closeAnnotationStreams(): Promise<void> {
  for (const hub of hubs.values()) hub.closeAll();
  hubs.clear();
  await flushAnnotationIndex();
}

// ---------------------------------------------------------------------------
// The tutor's "학생의 메모" (chat.ts ChatDeps.studentMemos)
// ---------------------------------------------------------------------------

/**
 * The memos of the focus window the tutor may see (DESIGN §25 "학생의 메모"): only the window's slide files are read
 * (missing = none); memos with `tutor !== false` and non-blank text, each `{ slide, text (whitespace squeezed,
 * ≤ MAX_MEMO_CHARS), tags }`, at most MAX_TUTOR_MEMOS — the focused slide's first, then its neighbours nearest first
 * (ties ascending; plain ascending without `slide`), the order context.ts keeps when its caps bite, so a full
 * neighbour never crowds the focused slide out. Never throws (logs and returns []).
 */
export async function memosForTutor(docId: string, windowSlides: number[], slide?: number): Promise<StudentMemo[]> {
  const memos: StudentMemo[] = [];
  try {
    const meta = await readStoredDoc(docId);
    if (!meta) return [];
    const focus = slide ?? 0;
    const slides = [...new Set(windowSlides)]
      .filter((s) => Number.isInteger(s) && s >= 1 && s <= meta.pageCount)
      .sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus) || a - b);
    for (const slide of slides) {
      const doc = await readSlideFile(docId, slide, meta.pageCount);
      if (!doc) continue;
      for (const item of doc.items) {
        if (item.type !== 'memo' || item.tutor === false) continue;
        const text = item.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const memo: StudentMemo = { slide, text: truncateText(text, MAX_MEMO_CHARS) };
        if (item.tags.length > 0) memo.tags = item.tags.slice();
        memos.push(memo);
        if (memos.length >= MAX_TUTOR_MEMOS) return memos;
      }
    }
  } catch (err) {
    console.warn(`[annotations] memos of ${docId} unavailable: ${errorText(err)}`);
    return [];
  }
  return memos;
}

// ---------------------------------------------------------------------------
// A new version of the deck (DESIGN §28): the slide files follow their slides, the 빠진 슬라이드 archive, memo links
// of other lectures, the drain before a swap and the `deck` event after it
// ---------------------------------------------------------------------------

/** annotations/deck.json {rev}: the deckRev the slide files are numbered in (absent = 0). A remap that finds its toRev does nothing. */
const DECK_FILE = 'deck.json';
/** annotations/links.json: the journal of remapAnnotationLinks (LinksJournal). */
const LINKS_FILE = 'links.json';
/** annotations/removed/r<rev>/: the 필기 of the slides a new version dropped (kept for good). */
const REMOVED_DIR = 'removed';
/** TextHighlightItem.engine on a slide the new version changed: no layout has it, so the client re-anchors by the text. */
const MOVED_ENGINE = 'moved';
/** A thumbnail of the archive as requested: `<slide>.webp`, any padding. */
const REMOVED_THUMB_RE = /^(\d{1,6})\.webp$/;

/** What a remap knows of the deck before the swap. */
export interface DeckRemapOptions {
  /** The old deck's thumbnail of an old slide (copied next to its archived 필기), or null. */
  oldThumb?: (oldSlide: number) => string | null;
}

/**
 * The journal of a remap of the slide files (annotations/deck-r<toRev>.json), written before the first slide file
 * changes: a crash in the middle resumes from it instead of renumbering files twice.
 */
interface DeckJournal {
  version: 1;
  toRev: number;
  /** The slide files as they will be: file name (new numbering and padding) → document. */
  files: Record<string, SlideAnnotations>;
  /** Slide files of the old numbering that go away (moved or archived); never one of `files`. */
  remove: string[];
  /** Undo: archived slides that could not go back; their folder is kept. */
  keepRestore: boolean;
}

/** The old slide's number in the new deck, or null when the new deck dropped it (or it was never in the old one). */
function newSlideOf(map: DeckMap, slide: number): number | null {
  if (!Number.isInteger(slide) || slide < 1 || slide > map.oldPageCount) return null;
  const next = map.oldToNew[slide - 1];
  return typeof next === 'number' ? next : null;
}

function removedDir(docId: string, rev: number): string {
  return path.join(docPaths(docId).annotationsDir, REMOVED_DIR, `r${rev}`);
}

function journalFile(docId: string, toRev: number): string {
  return path.join(docPaths(docId).annotationsDir, `deck-r${toRev}.json`);
}

function isJournal(value: unknown, toRev: number): value is DeckJournal {
  const raw = value as Partial<DeckJournal> | null;
  return isObject(raw) && raw.version === 1 && raw.toRev === toRev && isObject(raw.files) && Array.isArray(raw.remove) && typeof raw.keepRestore === 'boolean';
}

/** `rev` of a deck mark ({rev}), 0 when there is none. */
async function readDeckMark(file: string): Promise<number> {
  const value = await readJsonFile<unknown>(file);
  return isObject(value) && Number.isInteger(value.rev) && (value.rev as number) >= 0 ? (value.rev as number) : 0;
}

/** The slide files of a folder with their slide numbers, or null when the folder does not exist. */
async function listSlideFiles(dir: string): Promise<Array<{ name: string; slide: number }> | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const files: Array<{ name: string; slide: number }> = [];
  for (const name of names) {
    const match = SLIDE_FILE_RE.exec(name);
    if (match && Number(match[1]) >= 1) files.push({ name, slide: Number(match[1]) });
  }
  return files;
}

/** mkdir of one level (an existing folder is fine; a missing parent is an error, so a deleted document is never made again). */
async function mkdirOne(dir: string): Promise<void> {
  try {
    await withFsRetry(() => fs.mkdir(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/** A memo's links in the new deck: slide links (and slide links into this lecture) follow; a dropped slide's are dropped. */
function remapLinks(links: MemoLink[], map: DeckMap, docId: string): MemoLink[] {
  const out: MemoLink[] = [];
  for (const link of links) {
    if (link.kind === 'slide') {
      const next = newSlideOf(map, link.slide);
      if (next !== null) out.push({ kind: 'slide', slide: next });
    } else if (link.kind === 'doc' && link.docId === docId && link.slide !== undefined) {
      out.push(remapDocLink(link, map));
    } else {
      out.push(link);
    }
  }
  return out;
}

/** A link into the swapped lecture: its slide follows, or is dropped (the link to the lecture stays). */
function remapDocLink(link: Extract<MemoLink, { kind: 'doc' }>, map: DeckMap): Extract<MemoLink, { kind: 'doc' }> {
  const next = link.slide === undefined ? null : newSlideOf(map, link.slide);
  return next === null ? { kind: 'doc', docId: link.docId } : { kind: 'doc', docId: link.docId, slide: next };
}

function remapItem(item: AnnotationItem, map: DeckMap, docId: string, changed: boolean): AnnotationItem {
  if (item.type === 'textHighlight' && changed) return { ...item, engine: MOVED_ENGINE };
  if (item.type === 'memo') return { ...item, links: remapLinks(item.links, map, docId) };
  return item;
}

/**
 * Writes a dropped slide's document into annotations/removed/r<fromRev>/, padded like the old deck, with its old
 * thumbnail when it has 필기 (a document of hidden markers only is kept for the undo, never listed).
 */
async function archiveSlide(docId: string, map: DeckMap, doc: SlideAnnotations, removedAt: string, oldThumb: DeckRemapOptions['oldThumb']): Promise<void> {
  await mkdirOne(path.join(docPaths(docId).annotationsDir, REMOVED_DIR));
  const dir = removedDir(docId, map.fromRev);
  await mkdirOne(dir);
  const base = pageBaseName(doc.slide, map.oldPageCount);
  await writeJsonAtomic(path.join(dir, `${base}.json`), { ...doc, removedAt });
  const thumb = doc.items.length > 0 ? oldThumb?.(doc.slide) : null;
  if (!thumb) return;
  try {
    await withFsRetry(() => fs.copyFile(thumb, path.join(dir, `${base}.webp`)));
  } catch (err) {
    if (!isNotFound(err)) console.warn(`[annotations] thumbnail of removed slide ${doc.slide} of ${docId} not kept: ${errorText(err)}`);
  }
}

/**
 * Reads the slide files in the old numbering, archives the dropped slides' 필기 and hidden markers and computes the
 * files of the new numbering (the journal). Nothing of the live slide files changes yet.
 */
async function planDeckRemap(docId: string, map: DeckMap, oldThumb: DeckRemapOptions['oldThumb']): Promise<DeckJournal> {
  const dir = docPaths(docId).annotationsDir;
  const files = (await listSlideFiles(dir)) ?? [];
  const now = new Date().toISOString();
  const old = new Map<number, SlideAnnotations>();
  const remove: string[] = [];
  let maxRev = 0;
  for (const { name, slide } of files) {
    // Files past the old deck (or malformed ones) are not part of it: they stay as they are.
    if (slide > map.oldPageCount) continue;
    const value = await readJsonFile<unknown>(path.join(dir, name));
    const doc = value === null ? null : normalizeStoredDoc(value, slide, map.oldPageCount, path.join(dir, name));
    if (!doc) continue;
    remove.push(name);
    maxRev = Math.max(maxRev, doc.rev);
    const known = old.get(slide);
    if (!known || known.rev < doc.rev) old.set(slide, doc);
  }
  // Undo: the 필기 the apply from restoreRev archived goes back to its slides (numbered in the deck coming back).
  const restored: SlideAnnotations[] = [];
  let keepRestore = false;
  if (map.restoreRev !== undefined) {
    const archiveDir = removedDir(docId, map.restoreRev);
    for (const { name, slide } of (await listSlideFiles(archiveDir)) ?? []) {
      const value = await readJsonFile<unknown>(path.join(archiveDir, name));
      const doc = value === null || slide > map.newPageCount ? null : normalizeStoredDoc(value, slide, map.newPageCount, path.join(archiveDir, name));
      if (!doc) {
        keepRestore = true;
        continue;
      }
      maxRev = Math.max(maxRev, doc.rev);
      restored.push(doc);
    }
  }
  // Every rewritten file gets a rev above every old one, so no client's stale baseRev matches.
  const rev = maxRev + 1;
  const targets = new Map<number, SlideAnnotations>();
  for (const doc of old.values()) {
    const next = newSlideOf(map, doc.slide);
    if (next === null) {
      // Hidden markers too: the undo puts them back with the slide.
      if (doc.items.length > 0 || doc.hiddenMarkers.length > 0) await archiveSlide(docId, map, doc, now, oldThumb);
      continue;
    }
    const changed = map.changed.has(next);
    targets.set(next, { ...doc, slide: next, rev, updatedAt: now, items: doc.items.map((item) => remapItem(item, map, docId, changed)) });
  }
  for (const doc of restored) {
    const known = targets.get(doc.slide);
    const items = known ? [...known.items, ...doc.items.filter((item) => !known.items.some((other) => other.id === item.id))] : doc.items;
    const hiddenMarkers = known ? [...known.hiddenMarkers, ...doc.hiddenMarkers.filter((key) => !known.hiddenMarkers.some((other) => sameKey(other, key)))] : doc.hiddenMarkers;
    targets.set(doc.slide, { version: 1, slide: doc.slide, rev, updatedAt: now, items, hiddenMarkers });
  }
  const out: Record<string, SlideAnnotations> = {};
  for (const [slide, doc] of targets) out[annotationFileName(slide, map.newPageCount)] = doc;
  return { version: 1, toRev: map.toRev, files: out, remove: remove.filter((name) => !Object.hasOwn(out, name)), keepRestore };
}

/** Removes what a finished remap leaves: the restored archive (undo) and the journal. Idempotent. */
async function finishDeckJournal(docId: string, map: DeckMap, journal: DeckJournal): Promise<void> {
  if (map.restoreRev !== undefined && !journal.keepRestore) await rmWithRetry(removedDir(docId, map.restoreRev), { recursive: true, force: true });
  await rmWithRetry(journalFile(docId, map.toRev), { force: true });
}

/** Makes the slide files what the journal says (every step idempotent), marks the rev, then rebuilds the index. */
async function applyDeckJournal(docId: string, map: DeckMap, journal: DeckJournal): Promise<void> {
  const dir = docPaths(docId).annotationsDir;
  for (const [name, doc] of Object.entries(journal.files)) {
    if (SLIDE_FILE_RE.test(name)) await writeJsonAtomic(path.join(dir, name), doc);
  }
  for (const name of journal.remove) {
    if (SLIDE_FILE_RE.test(name) && !Object.hasOwn(journal.files, name)) await rmWithRetry(path.join(dir, name), { force: true });
  }
  // The old numbering's index goes before the mark: a crash after it leaves no stale index (readSummary rebuilds it).
  await rmWithRetry(indexFile(docId), { force: true });
  await writeJsonAtomic(path.join(dir, DECK_FILE), { rev: map.toRev });
  await finishDeckJournal(docId, map, journal);
  rebuildFailures.delete(docId);
  tagsCache.delete(docId);
  try {
    await rebuildIndex(docId);
  } catch (err) {
    console.warn(`[annotations] index of ${docId} not rebuilt after the new version: ${errorText(err)}`);
  }
}

/**
 * Before a swap (DESIGN §28 Apply 2): waits for the slide writes of the lecture that are queued or running (the
 * swapping gate refuses the ones that start later) and flushes its debounced index.
 */
export async function drainAnnotations(docId: string): Promise<void> {
  const slides = [...(busySlides.get(docId)?.keys() ?? [])];
  await Promise.all(slides.map((slide) => queue(`${docId}/${slide}`, async () => {})));
  await flushAnnotationIndex(docId);
}

/** Writes the deck mark (annotations/deck.json), making annotations/ when the lecture has none yet. */
async function writeDeckMark(docId: string, rev: number): Promise<void> {
  const dir = docPaths(docId).annotationsDir;
  await mkdirOne(dir);
  await writeJsonAtomic(path.join(dir, DECK_FILE), { rev });
}

/**
 * The slide files follow their slides (DESIGN §28 Remaps › Annotations): old slide k's file becomes the file of
 * map.oldToNew[k − 1] (new padding, `slide` set, rev = the highest old rev + 1), memo links follow (dropped with a
 * dropped slide; a link into this lecture loses only its slide), 텍스트 형광 on changed slides get engine 'moved'. A
 * dropped slide's 필기 goes to annotations/removed/r<fromRev>/ with its old thumbnail (options.oldThumb). On an undo
 * (map.restoreRev) that archive comes back to its slides and is removed. The old numbering is read with
 * map.oldPageCount (doc.json has the new deck by now); the index is rebuilt at the end. Writes directly: the swapping
 * gate does not apply.
 *
 * Only files numbered in map.fromRev are renumbered (annotations/deck.json {rev}, absent = 0); once done the mark is
 * map.toRev and a second run does nothing (a remap that stopped half-way resumes from its journal). An undo that finds
 * the files still in the deck coming back (map.restoreRev: the apply gave the remap up) only marks them map.toRev.
 * Files in any other numbering are left alone. A lecture without annotations/ gets the mark (and the folder), so what
 * is written later counts as numbered in the new deck.
 */
export function remapDocAnnotations(docId: string, map: DeckMap, options: DeckRemapOptions = {}): Promise<void> {
  return queue(`${docId}/deck`, async () => {
    const dir = docPaths(docId).annotationsDir;
    if ((await listSlideFiles(dir)) === null) {
      await writeDeckMark(docId, map.toRev);
      return;
    }
    const mark = await readDeckMark(path.join(dir, DECK_FILE));
    const pending = await readJsonFile<unknown>(journalFile(docId, map.toRev));
    if (mark === map.toRev) {
      if (isJournal(pending, map.toRev)) await finishDeckJournal(docId, map, pending);
      return;
    }
    if (mark !== map.fromRev) {
      if (map.restoreRev !== undefined && mark === map.restoreRev) {
        // The apply never renumbered them: its journal is of no use any more, nothing to bring back.
        await rmWithRetry(journalFile(docId, map.fromRev), { force: true });
        await writeDeckMark(docId, map.toRev);
      }
      return;
    }
    // Index updates of writes from before (or of another lecture's link remap) land before the files move.
    await flushAnnotationIndex(docId);
    const journal = isJournal(pending, map.toRev) ? pending : await planDeckRemap(docId, map, options.oldThumb);
    if (journal !== pending) await writeJsonAtomic(journalFile(docId, map.toRev), journal);
    await applyDeckJournal(docId, map, journal);
  });
}

/** annotations/links.json of the swapped lecture: per other lecture, memo id → its links before and after. */
interface LinksJournal {
  rev: number;
  done: boolean;
  docs: Record<string, Record<string, { from: MemoLink[]; to: MemoLink[] }>>;
}

function isLinksJournal(value: unknown): value is LinksJournal {
  const raw = value as Partial<LinksJournal> | null;
  return isObject(raw) && Number.isInteger(raw.rev) && typeof raw.done === 'boolean' && isObject(raw.docs);
}

/** A slide file as stored, checked just enough to change memo links in it (nothing else of it is touched). */
type RawSlideDoc = Record<string, unknown> & { rev: number; items: unknown[] };

function isRawSlideDoc(value: unknown): value is RawSlideDoc {
  return isObject(value) && value.version === 1 && Array.isArray(value.items) && Number.isInteger(value.rev) && (value.rev as number) >= 0;
}

/** The memo links of another lecture's file that point into `docId`, remapped: memo id → {from, to}. */
function linkChangesOf(raw: RawSlideDoc, docId: string, map: DeckMap): Record<string, { from: MemoLink[]; to: MemoLink[] }> {
  const changes: Record<string, { from: MemoLink[]; to: MemoLink[] }> = {};
  for (const entry of raw.items) {
    if (!isObject(entry) || entry.type !== 'memo' || typeof entry.id !== 'string' || !Array.isArray(entry.links)) continue;
    const from = entry.links as MemoLink[];
    const to = from.map((link) =>
      isObject(link) && link.kind === 'doc' && link.docId === docId && Number.isInteger(link.slide) ? remapDocLink(link, map) : link,
    );
    if (JSON.stringify(to) !== JSON.stringify(from)) changes[entry.id] = { from, to };
  }
  return changes;
}

/** Applies the changes to the memos of another lecture that still have their `from` links, slide by slide, as writes. */
async function applyLinkChanges(otherId: string, changes: LinksJournal['docs'][string]): Promise<void> {
  const dir = docPaths(otherId).annotationsDir;
  for (const { name, slide } of (await listSlideFiles(dir)) ?? []) {
    const file = path.join(dir, name);
    const before = await readJsonFile<unknown>(file);
    if (!isRawSlideDoc(before) || !before.items.some((entry) => isObject(entry) && typeof entry.id === 'string' && Object.hasOwn(changes, entry.id))) continue;
    await slideQueue(otherId, slide, async () => {
      const raw = await readJsonFile<unknown>(file);
      if (!isRawSlideDoc(raw)) return;
      const ops: AnnotationOp[] = [];
      const items = raw.items.map((entry) => {
        if (!isObject(entry) || typeof entry.id !== 'string' || !Object.hasOwn(changes, entry.id)) return entry;
        const change = changes[entry.id];
        if (JSON.stringify(entry.links) !== JSON.stringify(change.from)) return entry; // done before, or edited since
        ops.push({ op: 'update', id: entry.id, patch: { links: change.to } });
        return { ...entry, links: change.to };
      });
      if (ops.length === 0) return;
      const now = new Date().toISOString();
      const doc = { ...raw, rev: raw.rev + 1, updatedAt: now, items } as unknown as SlideAnnotations;
      await writeJsonAtomic(file, doc);
      scheduleIndexUpdate(otherId, { ...doc, slide });
      const hub = hubs.get(otherId);
      if (hub) {
        hub.send({ type: 'slide', slide, rev: doc.rev, updatedAt: now, ops });
        hub.send({ type: 'summary' });
      }
    });
  }
}

/**
 * Memos of other lectures linking into this one ({kind 'doc', docId, slide}) follow the swap (DESIGN §28): the slide
 * is remapped, or dropped with a dropped slide (the link to the lecture stays). Written through each slide's queue
 * with a rev bump and the normal `slide` / `summary` events. Idempotent: the changes are journaled in this lecture's
 * annotations/links.json before they are applied, and a memo changes only while it still has its old links.
 */
export async function remapAnnotationLinks(docId: string, map: DeckMap): Promise<void> {
  const file = path.join(docPaths(docId).annotationsDir, LINKS_FILE);
  const stored = await readJsonFile<unknown>(file);
  if (isLinksJournal(stored) && (stored.rev > map.toRev || (stored.rev === map.toRev && stored.done))) return;
  const journal: LinksJournal = isLinksJournal(stored) && stored.rev === map.toRev ? stored : { rev: map.toRev, done: false, docs: {} };
  let saved = journal === stored;
  for (const other of await listStoredDocs()) {
    if (other.id === docId) continue;
    // Under the other lecture's deck queue: its own swap never moves its files under these writes.
    await queue(`${other.id}/deck`, async () => {
      try {
        let changes = journal.docs[other.id];
        if (!changes) {
          changes = {};
          const dir = docPaths(other.id).annotationsDir;
          for (const { name } of (await listSlideFiles(dir)) ?? []) {
            const raw = await readJsonFile<unknown>(path.join(dir, name));
            if (isRawSlideDoc(raw)) Object.assign(changes, linkChangesOf(raw, docId, map));
          }
          if (Object.keys(changes).length === 0) return;
          journal.docs[other.id] = changes;
          await ensureAnnotationsDir(docId);
          await writeJsonAtomic(file, journal);
          saved = true;
        }
        await applyLinkChanges(other.id, changes);
      } catch (err) {
        if ((await readStoredDoc(other.id)) !== null) throw err; // the other lecture was deleted meanwhile: nothing to keep
      }
    });
  }
  if (saved) await writeJsonAtomic(file, { rev: map.toRev, done: true, docs: {} } satisfies LinksJournal);
}

/**
 * What the student has on these slides of the live deck (VersionPlan.onRemoved): `items` = 필기 other than memos,
 * `memos` = sticky memos. Zero for an unknown lecture.
 */
export async function removedSlideCounts(docId: string, slides: number[]): Promise<{ items: number; memos: number }> {
  const counts = { items: 0, memos: 0 };
  const meta = await readStoredDoc(docId);
  if (!meta) return counts;
  for (const slide of new Set(slides)) {
    if (!Number.isInteger(slide) || slide < 1 || slide > meta.pageCount) continue;
    const doc = await readSlideFile(docId, slide, meta.pageCount);
    for (const item of doc?.items ?? []) {
      if (item.type === 'memo') counts.memos++;
      else counts.items++;
    }
  }
  return counts;
}

/**
 * After a swap (DESIGN §28 Apply 5): the `deck` event to the lecture's subscribers, then its streams end and the hub
 * is forgotten, so every client (an old bundle too) reconnects and loads the lecture again.
 */
export function sendDeckEvent(docId: string, event: { rev: number; kind: 'apply' | 'undo'; oldToNew: (number | null)[] }): void {
  const hub = hubs.get(docId);
  if (!hub) return;
  hubs.delete(docId);
  hub.send({ type: 'deck', rev: event.rev, kind: event.kind, oldToNew: event.oldToNew.slice() });
  hub.closeAll();
}

/**
 * GET …/annotations/removed: the 빠진 슬라이드 archive — the 필기 of every slide a new version dropped, newest rev first,
 * then by slide. 404 for an unknown lecture.
 */
export async function listRemovedSlides(docId: string): Promise<RemovedSlide[]> {
  await requireDoc(docId);
  const root = path.join(docPaths(docId).annotationsDir, REMOVED_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const slides: RemovedSlide[] = [];
  for (const entry of entries) {
    const match = /^r(\d{1,9})$/.exec(entry);
    if (!match) continue;
    const dir = path.join(root, entry);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue; // not a folder
    }
    for (const name of names) {
      const file = SLIDE_FILE_RE.exec(name);
      const slide = Number(file?.[1]);
      if (!file || slide < 1) continue;
      const value = await readJsonFile<unknown>(path.join(dir, name));
      // The archive's slide links point into the deck it came from: no page count to check them against.
      const doc = value === null ? null : normalizeStoredDoc(value, slide, Number.MAX_SAFE_INTEGER, path.join(dir, name));
      if (!doc || doc.items.length === 0) continue;
      const removedAt = isObject(value) && isIso(value.removedAt) ? value.removedAt : doc.updatedAt;
      slides.push({ rev: Number(match[1]), slide, removedAt, thumb: names.includes(`${file[1]}.webp`), items: doc.items });
    }
  }
  return slides.sort((a, b) => b.rev - a.rev || a.slide - b.slide);
}

/** The thumbnail of an archived slide (GET …/annotations/removed/:rev/:file, `file` = `<slide>.webp`), or null. */
export async function removedThumbFile(docId: string, rev: number, file: string): Promise<string | null> {
  const match = REMOVED_THUMB_RE.exec(file);
  if (!match || !Number.isInteger(rev) || rev < 0 || (await readStoredDoc(docId)) === null) return null;
  const slide = Number(match[1]);
  const dir = removedDir(docId, rev);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const name = names.find((candidate) => {
    const found = /^(\d+)\.webp$/.exec(candidate);
    return found !== null && Number(found[1]) === slide;
  });
  return name ? path.join(dir, name) : null;
}
