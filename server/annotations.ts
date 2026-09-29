// Slide annotations (DESIGN §25): the per-slide store (library/<docId>/annotations/NNN.json, SlideAnnotations),
// its validation (whitelists per item type, caps, the byte cap), optimistic concurrency (rev / baseRev, a 409 that
// carries the current document), the per-lecture index (annotations/index.json, AnnotationSummary: rewritten after
// every write, coalesced, rebuilt from the slide files when missing), the SSE hub per document (AnnotationEvent:
// the ops of a PATCH, the document after a PUT, summary / qa nudges, pings), the library-wide tag list, and the
// memos the tutor reads ("학생의 메모", memosForTutor → chat.ts).
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
  MESSAGE_ID_RE,
  RECORDING_ID_RE,
  SESSION_ID_RE,
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
  SlideAnnotations,
} from '../shared/types.ts';
import { HttpError } from './config.ts';
import { MAX_MEMO_CHARS, MAX_TUTOR_MEMOS, truncateText } from './context.ts';
import type { StudentMemo } from './internal-types.ts';
import { createKeyedQueue, docPaths, isNotFound, listStoredDocs, readJsonFile, readStoredDoc, withFsRetry, writeJsonAtomic } from './library.ts';
import type { StoredDocMeta } from './library.ts';
import { annotationFileName } from './pageNames.ts';
import { EventHub, RECORDING_PING_MS } from './recordings/events.ts';
import type { SseTarget } from './recordings/events.ts';
import { currentLiveRecording } from './recordings/service.ts';
import { onSessionsChanged } from './sessions.ts';

const NOT_FOUND_DOC = '문서를 찾을 수 없습니다';
const NOT_FOUND_SLIDE = '슬라이드를 찾을 수 없습니다';
/** 409 of PUT / PATCH when `baseRev` is not the stored rev (or an op names an id the document does not have). */
export const ANNOTATION_CONFLICT = '다른 곳에서 이 슬라이드의 필기가 바뀌었습니다. 새로 불러온 뒤 다시 시도해 주세요';
/** 400 when the JSON of the slide document after a write would exceed MAX_SLIDE_ANNOTATION_BYTES. */
export const ANNOTATIONS_TOO_LARGE = '이 슬라이드의 필기가 너무 많아요 (일부를 지워 주세요)';
/** Longest accepted TextHighlightItem.engine. */
const MAX_ENGINE_CHARS = 32;
/** Decimals a stored coordinate keeps (the client sends 4; clamping must not add floating-point noise). */
const COORD_DECIMALS = 1e4;
const INDEX_FILE = 'index.json';
/** Characters of a request shown in a 400 (the putMarkers style). */
const SNIPPET_CHARS = 100;

/** Fields an `update` op may change per item type (never id, type, createdAt, recordedAt; `updatedAt` is replaced). */
const PATCHABLE_FIELDS: Readonly<Record<AnnotationItem['type'], readonly string[]>> = {
  highlight: ['color', 'rect'],
  rect: ['color', 'rect'],
  ellipse: ['color', 'rect'],
  textHighlight: ['color', 'rects', 'chars', 'engine', 'text'],
  text: ['color', 'rect', 'text'],
  memo: ['color', 'at', 'text', 'tags', 'collapsed', 'tutor', 'links'],
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

/** Serializes the writes of one slide (`docId/slide`) and of one index (`docId/index`). */
const queue = createKeyedQueue();

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
    throw bad('필기의 위치(rect: x, y, w, h)가 올바르지 않습니다', context);
  }
  const x = coord(rect.x as number);
  const y = coord(rect.y as number);
  const w = coord(coord((rect.x as number) + (rect.w as number)) - x);
  const h = coord(coord((rect.y as number) + (rect.h as number)) - y);
  if (!(w > 0 && h > 0)) throw bad('필기는 슬라이드 안(0–1)에 있고 넓이가 있어야 합니다', context);
  return { x, y, w, h };
}

function normalizePoint(raw: unknown, context: unknown): { x: number; y: number } {
  const point = raw as { x?: unknown; y?: unknown } | null;
  if (!isObject(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) throw bad('메모의 위치(at: x, y)가 올바르지 않습니다', context);
  return { x: coord(point.x), y: coord(point.y) };
}

/** Control characters (but tabs and newlines) never make it into a text shown on the slide or given to the tutor. */
function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

function normalizeText(raw: unknown, context: unknown): string {
  if (typeof raw !== 'string') throw bad('필기의 글(text)이 올바르지 않습니다', context);
  const text = cleanText(raw);
  if (text.length > MAX_ANNOTATION_TEXT_CHARS) throw bad(`필기의 글이 너무 깁니다 (최대 ${MAX_ANNOTATION_TEXT_CHARS}자)`, context);
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
  if (!Array.isArray(raw) || !raw.every((tag) => typeof tag === 'string')) throw bad('메모의 태그(tags)는 문자열 배열이어야 합니다', context);
  const tags: string[] = [];
  for (const value of raw as string[]) {
    const tag = normalizeTag(value);
    if (!tag || tags.includes(tag)) continue;
    if (tag.length > MAX_TAG_CHARS) throw bad(`태그가 너무 깁니다 (최대 ${MAX_TAG_CHARS}자)`, context);
    tags.push(tag);
  }
  if (tags.length > MAX_MEMO_TAGS) throw bad(`태그는 메모마다 최대 ${MAX_MEMO_TAGS}개까지 붙일 수 있습니다`, context);
  return tags;
}

function normalizeLink(raw: unknown, pageCount: number, context: unknown): MemoLink {
  const link = raw as { kind?: unknown; slide?: unknown; docId?: unknown; rid?: unknown; t?: unknown } | null;
  if (!isObject(link)) throw bad('메모의 연결(links)이 올바르지 않습니다', context);
  switch (link.kind) {
    case 'slide':
      if (!Number.isInteger(link.slide) || (link.slide as number) < 1 || (link.slide as number) > pageCount) {
        throw bad(`연결한 슬라이드 번호가 올바르지 않습니다 (1–${pageCount})`, context);
      }
      return { kind: 'slide', slide: link.slide as number };
    case 'doc': {
      if (typeof link.docId !== 'string' || !DOC_ID_RE.test(link.docId)) throw bad('연결한 강의 id가 올바르지 않습니다', context);
      if (link.slide === undefined) return { kind: 'doc', docId: link.docId };
      if (!Number.isInteger(link.slide) || (link.slide as number) < 1) throw bad('연결한 슬라이드 번호가 올바르지 않습니다', context);
      return { kind: 'doc', docId: link.docId, slide: link.slide as number };
    }
    case 'recording':
      if (typeof link.rid !== 'string' || !RECORDING_ID_RE.test(link.rid) || !isFiniteNumber(link.t) || link.t < 0) {
        throw bad('연결한 녹음 시점이 올바르지 않습니다', context);
      }
      return { kind: 'recording', rid: link.rid, t: round3(link.t) };
    default:
      throw bad('메모의 연결(links)이 올바르지 않습니다', context);
  }
}

function normalizeLinks(raw: unknown, pageCount: number, context: unknown): MemoLink[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw bad('메모의 연결(links)은 배열이어야 합니다', context);
  if (raw.length > MAX_MEMO_LINKS) throw bad(`연결은 메모마다 최대 ${MAX_MEMO_LINKS}개까지 둘 수 있습니다`, context);
  return raw.map((link) => normalizeLink(link, pageCount, context));
}

function normalizeRecordedAt(raw: unknown, context: unknown): RecordedAt {
  const stamp = raw as { rid?: unknown; t?: unknown } | null;
  if (!isObject(stamp) || typeof stamp.rid !== 'string' || !RECORDING_ID_RE.test(stamp.rid) || !isFiniteNumber(stamp.t) || stamp.t < 0) {
    throw bad('녹음 시점(recordedAt)이 올바르지 않습니다', context);
  }
  return { rid: stamp.rid, t: round3(stamp.t) };
}

function normalizeBoolean(raw: unknown, fallback: boolean, what: string, context: unknown): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') throw bad(`${what}은(는) true/false여야 합니다`, context);
  return raw;
}

/**
 * An item as the store keeps it: every field checked and whitelisted for its type (unknown fields dropped, like
 * attachments), coordinates clamped and rounded, texts capped. `createdAt` and `updatedAt` are kept when they are
 * valid ISO strings, else `now` (the write path stamps `updatedAt` itself for the items it touches). Throws
 * HttpError 400 (Korean, with a snippet) for anything wrong.
 */
export function normalizeItem(raw: unknown, pageCount: number, now: string): AnnotationItem {
  if (!isObject(raw)) throw bad('필기 항목이 올바르지 않습니다', raw);
  const id = raw.id;
  if (typeof id !== 'string' || !ANNOTATION_ID_RE.test(id)) throw bad('필기 id가 올바르지 않습니다', raw);
  const color = raw.color;
  if (typeof color !== 'string' || !ANNOTATION_COLORS.includes(color as AnnotationColor)) throw bad('필기 색이 올바르지 않습니다', raw);
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
      return { ...base, type: 'text', rect: normalizeRect(raw.rect, raw), text: normalizeText(raw.text, raw) };
    case 'textHighlight': {
      if (!Array.isArray(raw.rects) || raw.rects.length === 0) throw bad('텍스트 형광의 위치(rects)가 올바르지 않습니다', raw);
      if (raw.rects.length > MAX_TEXT_HIGHLIGHT_RECTS) throw bad(`텍스트 형광이 너무 큽니다 (최대 ${MAX_TEXT_HIGHLIGHT_RECTS}줄)`, raw);
      const chars = raw.chars as unknown[];
      if (!Array.isArray(chars) || chars.length !== 2 || !Number.isInteger(chars[0]) || !Number.isInteger(chars[1]) || (chars[0] as number) < 0 || (chars[0] as number) >= (chars[1] as number)) {
        throw bad('텍스트 형광의 글자 범위(chars)가 올바르지 않습니다', raw);
      }
      if (typeof raw.engine !== 'string' || !raw.engine.trim() || raw.engine.length > MAX_ENGINE_CHARS) throw bad('텍스트 형광의 engine이 올바르지 않습니다', raw);
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
      };
    default:
      throw bad('알 수 없는 필기 종류입니다', raw);
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
    throw bad('질문 표시 키가 올바르지 않습니다', raw);
  }
  return { sessionId: key.sessionId, messageId: key.messageId, attachmentId: key.attachmentId };
}

function sameKey(a: MarkerKey, b: MarkerKey): boolean {
  return a.sessionId === b.sessionId && a.messageId === b.messageId && a.attachmentId === b.attachmentId;
}

function normalizeMarkerKeys(raw: unknown, context: unknown): MarkerKey[] {
  if (!Array.isArray(raw)) throw bad('hiddenMarkers는 배열이어야 합니다', context);
  const keys: MarkerKey[] = [];
  for (const value of raw) {
    const key = normalizeMarkerKey(value);
    if (!keys.some((known) => sameKey(known, key))) keys.push(key);
  }
  if (keys.length > MAX_HIDDEN_MARKERS) throw bad(`숨긴 질문 표시는 슬라이드마다 최대 ${MAX_HIDDEN_MARKERS}개까지입니다`, context);
  return keys;
}

/** JSON bytes of the document as stored (the cap of MAX_SLIDE_ANNOTATION_BYTES). */
export function annotationBytes(doc: SlideAnnotations): number {
  return Buffer.byteLength(JSON.stringify(doc));
}

function checkCaps(items: AnnotationItem[], hiddenMarkers: MarkerKey[], doc: SlideAnnotations): void {
  if (items.length > MAX_ANNOTATION_ITEMS) throw new HttpError(400, `필기는 슬라이드마다 최대 ${MAX_ANNOTATION_ITEMS}개까지 둘 수 있습니다`);
  if (hiddenMarkers.length > MAX_HIDDEN_MARKERS) throw new HttpError(400, `숨긴 질문 표시는 슬라이드마다 최대 ${MAX_HIDDEN_MARKERS}개까지입니다`);
  if (annotationBytes(doc) > MAX_SLIDE_ANNOTATION_BYTES) throw new HttpError(400, ANNOTATIONS_TOO_LARGE);
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
  if (!doc) throw new HttpError(404, NOT_FOUND_DOC);
  return doc;
}

function checkSlide(slide: number, pageCount: number): void {
  if (!Number.isInteger(slide) || slide < 1 || slide > pageCount) throw new HttpError(404, NOT_FOUND_SLIDE);
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
    if (isNotFound(err)) throw new HttpError(404, NOT_FOUND_DOC);
    throw err;
  }
  return dir;
}

async function writeSlideFile(docId: string, doc: SlideAnnotations, pageCount: number): Promise<void> {
  const dir = await ensureAnnotationsDir(docId);
  try {
    await writeJsonAtomic(path.join(dir, annotationFileName(doc.slide, pageCount)), doc);
  } catch (err) {
    if (isNotFound(err)) throw new HttpError(404, NOT_FOUND_DOC);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Writes: PUT (replace) and PATCH (ops), under the slide's queue
// ---------------------------------------------------------------------------

function parseBaseRev(body: Record<string, unknown>, current: SlideAnnotations): void {
  const baseRev = body.baseRev;
  if (!Number.isInteger(baseRev) || (baseRev as number) < 0) throw new HttpError(400, 'baseRev(0 이상의 정수)가 필요합니다');
  if (baseRev !== current.rev) throw new HttpError(409, ANNOTATION_CONFLICT, { current });
}

function jsonBody(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(400, '요청 본문이 올바르지 않습니다');
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
  if (!Array.isArray(body.items)) throw new HttpError(400, 'items 배열이 필요합니다');
  if (body.items.length > MAX_ANNOTATION_ITEMS) throw new HttpError(400, `필기는 슬라이드마다 최대 ${MAX_ANNOTATION_ITEMS}개까지 둘 수 있습니다`);
  const before = new Map(current.items.map((item) => [item.id, item]));
  const live = await liveFor(
    docId,
    body.items.some((entry) => isObject(entry) && typeof entry.id === 'string' && !before.has(entry.id) && !entry.recordedAt),
  );
  const items: AnnotationItem[] = [];
  const ids = new Set<string>();
  for (const entry of body.items) {
    let item = normalizeItem(entry, pageCount, now);
    if (ids.has(item.id)) throw bad('필기 id가 겹칩니다', entry);
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
  if (!Array.isArray(ops) || ops.length === 0) throw new HttpError(400, 'ops 배열이 필요합니다');
  if (ops.length > MAX_ANNOTATION_OPS) throw new HttpError(400, `한 번에 최대 ${MAX_ANNOTATION_OPS}개의 작업만 보낼 수 있습니다`);
  const live = await liveFor(
    docId,
    ops.some((op) => isObject(op) && op.op === 'add' && isObject(op.item) && !op.item.recordedAt),
  );
  const items = current.items.slice();
  let hiddenMarkers = current.hiddenMarkers.slice();
  const applied: AnnotationOp[] = [];
  for (const raw of ops) {
    if (!isObject(raw)) throw bad('필기 작업이 올바르지 않습니다', raw);
    switch (raw.op) {
      case 'add': {
        const item = stampRecording({ ...normalizeItem(raw.item, pageCount, now), updatedAt: now }, live);
        if (items.some((known) => known.id === item.id)) throw new HttpError(409, ANNOTATION_CONFLICT, { current });
        items.push(item);
        applied.push({ op: 'add', item });
        break;
      }
      case 'update': {
        if (typeof raw.id !== 'string') throw bad('필기 작업의 id가 올바르지 않습니다', raw);
        const index = items.findIndex((known) => known.id === raw.id);
        if (index < 0) throw new HttpError(409, ANNOTATION_CONFLICT, { current });
        const previous = items[index];
        if (!isObject(raw.patch)) throw bad('필기 작업의 patch가 올바르지 않습니다', raw);
        const allowed = PATCHABLE_FIELDS[previous.type];
        for (const key of Object.keys(raw.patch)) {
          if (key !== 'updatedAt' && !allowed.includes(key)) throw bad(`이 필기에 없는 항목입니다: ${key}`, raw);
        }
        const { updatedAt: _updatedAt, ...changes } = raw.patch;
        const next = { ...normalizeItem({ ...previous, ...changes, id: previous.id, type: previous.type, createdAt: previous.createdAt }, pageCount, now), updatedAt: now };
        if (previous.recordedAt) next.recordedAt = previous.recordedAt;
        else delete next.recordedAt;
        items[index] = next;
        // The accepted patch as stored (normalised), so every client applies the same values.
        const patch: Record<string, unknown> = { updatedAt: now };
        for (const key of Object.keys(changes)) patch[key] = (next as unknown as Record<string, unknown>)[key];
        applied.push({ op: 'update', id: previous.id, patch: patch as Extract<AnnotationOp, { op: 'update' }>['patch'] });
        break;
      }
      case 'remove': {
        if (typeof raw.id !== 'string' || !ANNOTATION_ID_RE.test(raw.id)) throw bad('필기 작업의 id가 올바르지 않습니다', raw);
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
        throw bad('알 수 없는 필기 작업입니다', raw);
    }
  }
  const doc: SlideAnnotations = { version: 1, slide: current.slide, rev: current.rev + 1, updatedAt: now, items, hiddenMarkers };
  checkCaps(items, hiddenMarkers, doc);
  return { doc, events: [{ type: 'slide', slide: doc.slide, rev: doc.rev, updatedAt: now, ops: applied }] };
}

/** The write itself (under the slide's queue): read, check the rev, build, cap, write, index, notify. */
async function writeSlide(
  docId: string,
  slide: number,
  body: unknown,
  client: string | undefined,
  build: (docId: string, current: SlideAnnotations, body: Record<string, unknown>, pageCount: number, now: string) => Promise<WriteOutcome>,
): Promise<SlideAnnotations> {
  const request = jsonBody(body);
  return queue(`${docId}/${slide}`, async () => {
    const meta = await requireDoc(docId);
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
 * current document when `baseRev` is stale; 400 per bad item or over a cap. `client` (the writer's
 * X-Annotation-Client id) is not sent the resulting `slide-reset` event.
 */
export function putSlideAnnotations(docId: string, slide: number, body: unknown, client?: string): Promise<SlideAnnotations> {
  return writeSlide(docId, slide, body, client, buildPut);
}

/**
 * PATCH …/annotations/:slide (PatchSlideAnnotationsRequest): applies the ops in order on the current document
 * (`add` refuses a duplicate id and `update` a missing one with 409 + current; `remove` is idempotent; hide / unhide
 * de-duplicate keys), then the same checks as a PUT. The `slide` event carries the ops as applied.
 */
export function patchSlideAnnotations(docId: string, slide: number, body: unknown, client?: string): Promise<SlideAnnotations> {
  return writeSlide(docId, slide, body, client, buildPatch);
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
      const match = /^(\d+)\.json$/.exec(name);
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
    const error = err instanceof HttpError ? err : new HttpError(500, `필기 목록을 읽지 못했습니다: ${errorText(err)}`);
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
