// Chat sessions persisted as library/<docId>/sessions/<sessionId>.json, and the review notes
// generated from them (notes/<sessionId>.md + STUDY_NOTES.md, DESIGN §7). Questions with attachments (DESIGN
// §21) show them under the question in both, linked relatively (attachments/<id>.jpg|png). When a new version of the
// lecture's deck replaces it (DESIGN §28), remapSessionSlides moves every message to its slide in the new deck.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_ID_RE, EFFORT_ID_RE, SESSION_ID_RE } from '../shared/types.ts';
import { readSessionUsage, readUsageLimits } from '../shared/usage.ts';
import type {
  ChatMessage,
  ContextInfo,
  LlmChoice,
  LlmSwitch,
  NoteEntry,
  NotesResponse,
  ProviderId,
  RemovedFrom,
  Session,
  SessionSummary,
  SlideNotes,
} from '../shared/types.ts';
import { ATTACHMENTS_DIR } from './assets.ts';
import { attachmentFileNames, removeUnreferencedAttachments } from './attachments.ts';
import { HttpError } from './config.ts';
import { initialProviderState } from './context.ts';
import { isLang, slang, smsg } from './i18n.ts';
import type { Lang } from './i18n.ts';
import type { DeckMap, ProviderState, SessionChange, SessionRecord } from './internal-types.ts';
import {
  createKeyedQueue,
  demoteHeadings,
  docPaths,
  isNotFound,
  listStoredDocs,
  readJsonFile,
  readStoredDoc,
  rmWithRetry,
  slideFileName,
  writeFileAtomic,
  writeJsonAtomic,
} from './library.ts';
import type { StoredDocMeta } from './library.ts';

/** Display names used in the notes (kept here so notes do not depend on provider modules). */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'anthropic-api': 'Claude API',
  'openai-api': 'OpenAI API',
};

const MAX_TITLE_CHARS = 120;
const MAX_HEADING_QUESTION_CHARS = 120;

/**
 * A session record with the deck mark of DESIGN §28: the DocMeta.deckRev its slide numbers are in (absent = 0, or a
 * session made before decks were swapped). remapSessionSlides does nothing to a record that already has its toRev.
 */
type DeckRecord = SessionRecord & { deckRev?: number };

/** Serializes writes of one session file (key: docId/sessionId). */
const sessionQueue = createKeyedQueue();
/** Serializes notes regeneration of one document (key: docId). */
const notesQueue = createKeyedQueue();

// ---------------------------------------------------------------------------
// Session changes the annotations' question markers care about (DESIGN §25)
// ---------------------------------------------------------------------------

const sessionListeners = new Set<(change: SessionChange) => void>();

/**
 * Registers a listener for SessionChange (a turn finished, a session was deleted); returns the unsubscribe.
 * annotations.ts forwards the changes to the document's SSE subscribers as AnnotationEvent 'qa'.
 */
export function onSessionsChanged(listener: (change: SessionChange) => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

/**
 * Tells the listeners that a session of a document changed: chat.ts calls it once per turn, after the turn's final
 * save (not on the saves at its start or per delta); deleteSession calls it with `updatedAt: null`. A failing
 * listener is logged, never thrown at the caller.
 */
export function notifySessionsChanged(change: SessionChange): void {
  for (const listener of [...sessionListeners]) {
    try {
      listener(change);
    } catch (err) {
      console.error('[sessions] change listener failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Time helpers (local time — the notes are read by the person who studied)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatDateTime(iso: string): string {
  return `${formatDate(new Date(iso))} ${formatTime(iso)}`;
}

// ---------------------------------------------------------------------------
// Session records
// ---------------------------------------------------------------------------

/** `YYYYMMDD-HHMMSS-` + 4 random hex (local time, sortable). */
export function newSessionId(now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

function sessionFile(docId: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(404, smsg().common.notFound.session);
  return path.join(docPaths(docId).sessionsDir, `${sessionId}.json`);
}

function cleanTitle(title: string | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

export interface CreateSessionInput {
  provider: ProviderId;
  /** Resolved model ('' = provider default). */
  model: string;
  /** Reasoning effort ('' / omitted = the CLI's default). */
  effort?: string;
  title?: string;
}

/** Creates and persists an empty session. Throws HttpError 404 when the document does not exist. */
export async function createSession(docId: string, input: CreateSessionInput): Promise<SessionRecord> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  await fs.mkdir(docPaths(docId).sessionsDir, { recursive: true });

  const now = new Date();
  let id = newSessionId(now);
  // Two sessions created in the same second collide with probability 1/65536; just retry.
  while (await fileExists(sessionFile(docId, id))) id = newSessionId(now);

  const createdAt = now.toISOString();
  const record: DeckRecord = {
    version: 1,
    id,
    docId,
    // "세션 09/30 11:36" / "Session Sep 30, 11:36 AM", in the request's language (DESIGN §27).
    title:
      cleanTitle(input.title) ||
      smsg().chat.sessions.defaultTitle(`${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`, formatTime(createdAt), now),
    provider: input.provider,
    model: input.model,
    createdAt,
    updatedAt: createdAt,
    providerState: initialProviderState(),
    messages: [],
  };
  if (input.effort) record.effort = input.effort;
  // Its slide numbers are the current deck's (DESIGN §28).
  if (doc.deckRev) record.deckRev = doc.deckRev;
  await writeRecord(record);
  return record;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  const record = value as SessionRecord | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    record.version === 1 &&
    typeof record.provider === 'string' &&
    Array.isArray(record.messages) &&
    typeof record.providerState === 'object' &&
    record.providerState !== null
  );
}

/** Reads a session file of a document known to exist (null when missing or malformed). */
async function readRecord(docId: string, sessionId: string): Promise<SessionRecord | null> {
  const value = await readJsonFile<unknown>(sessionFile(docId, sessionId));
  if (!isSessionRecord(value)) return null;
  // The file location is authoritative for the ids.
  const record: DeckRecord = { ...value, id: sessionId, docId };
  // The effort reaches a CLI's arguments: anything but a valid level means the default.
  if (record.effort !== undefined && (typeof record.effort !== 'string' || !EFFORT_ID_RE.test(record.effort))) delete record.effort;
  // Totals are added to: only well-formed ones are kept (absent in sessions made before usage was recorded).
  const usage = readSessionUsage(record.usage);
  if (usage) record.usage = usage;
  else delete record.usage;
  const limits = readUsageLimits(record.limits);
  if (limits) record.limits = limits;
  else delete record.limits;
  // Shown between the messages and in the notes: only well-formed changes are kept (absent in sessions saved before).
  const switches = readSwitches(record.switches);
  if (switches) record.switches = switches;
  else delete record.switches;
  if (!isLang(record.lang)) delete record.lang;
  if (record.deckRev !== undefined && !(Number.isInteger(record.deckRev) && record.deckRev >= 0)) delete record.deckRev;
  return record;
}

/** A saved LlmChoice ('' model = the provider's default; the effort only when it is a level), or null. */
function readLlmChoice(value: unknown): LlmChoice | null {
  const raw = value as Partial<LlmChoice> | null;
  if (typeof raw !== 'object' || raw === null || typeof raw.provider !== 'string' || typeof raw.model !== 'string') return null;
  const choice: LlmChoice = { provider: raw.provider, model: raw.model };
  if (typeof raw.effort === 'string' && EFFORT_ID_RE.test(raw.effort)) choice.effort = raw.effort;
  return choice;
}

/** The well-formed entries of a saved `switches` list; null when there are none. */
function readSwitches(value: unknown): LlmSwitch[] | null {
  if (!Array.isArray(value)) return null;
  const switches: LlmSwitch[] = [];
  for (const raw of value as Array<Partial<LlmSwitch> | null>) {
    if (typeof raw !== 'object' || raw === null || typeof raw.at !== 'string') continue;
    if (raw.afterMessageId !== null && typeof raw.afterMessageId !== 'string') continue;
    const from = readLlmChoice(raw.from);
    const to = readLlmChoice(raw.to);
    if (from && to) switches.push({ at: raw.at, afterMessageId: raw.afterMessageId, from, to });
  }
  return switches.length > 0 ? switches : null;
}

/** The LLM a session runs on (SessionRecord.provider / model / effort). */
function llmOf(record: SessionRecord): LlmChoice {
  const choice: LlmChoice = { provider: record.provider, model: record.model };
  if (record.effort) choice.effort = record.effort;
  return choice;
}

function sameLlm(a: LlmChoice, b: LlmChoice): boolean {
  return a.provider === b.provider && a.model === b.model && (a.effort ?? '') === (b.effort ?? '');
}

/**
 * Changes the LLM the session runs on (DESIGN §5 "LLM switch"): the provider conversation it has is dropped, so the
 * next turn starts a new one on the new LLM (the deck fed again, the latest Q&A recapped, the tutor told they came
 * from another model), and the change is kept in `switches` for the history and the notes. `changed` is false, and
 * nothing is written, when provider, model and effort are the ones the session already has. Throws HttpError 404.
 * The caller keeps turns off the session meanwhile (chat.ts withSessionReserved).
 */
export async function switchSessionLlm(docId: string, sessionId: string, to: LlmChoice): Promise<{ record: SessionRecord; changed: boolean }> {
  const record = await getSession(docId, sessionId);
  if (!record) throw new HttpError(404, smsg().common.notFound.session);
  const from = llmOf(record);
  const next: LlmChoice = { provider: to.provider, model: to.model };
  if (to.effort) next.effort = to.effort;
  if (sameLlm(from, next)) return { record, changed: false };

  record.provider = next.provider;
  record.model = next.model;
  if (next.effort) record.effort = next.effort;
  else delete record.effort;
  // The usage limits are the old provider's report: the new one reports its own on its first turn (the web keeps
  // the newest report per provider, so nothing is lost).
  if (from.provider !== next.provider) delete record.limits;
  // A conversation the old LLM holds cannot go on with the new one: the next turn starts afresh, as a forced
  // rollover (ProviderState.switched). A session that was never primed has nothing to drop.
  const state = record.providerState;
  if (state.primed || state.resume !== null) {
    record.providerState = { ...initialProviderState(), generation: state.generation, switched: true };
  }
  const afterMessageId = record.messages.at(-1)?.id ?? null;
  record.switches = [...(record.switches ?? []), { at: new Date().toISOString(), afterMessageId, from, to: next }];
  await saveSession(record);
  await writeNotes(docId);
  return { record, changed: true };
}

/** The session, or null when an id is invalid or the session does not exist. */
export async function getSession(docId: string, sessionId: string): Promise<SessionRecord | null> {
  if (!SESSION_ID_RE.test(sessionId) || (await readStoredDoc(docId)) === null) return null;
  return readRecord(docId, sessionId);
}

function writeRecord(record: SessionRecord): Promise<void> {
  const file = sessionFile(record.docId, record.id);
  // Serialized per session; the record is stringified when the write actually runs, so the
  // last queued write always persists the latest state.
  return sessionQueue(`${record.docId}/${record.id}`, () => writeJsonAtomic(file, record));
}

/** Persists the session and bumps `updatedAt`. */
export async function saveSession(record: SessionRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await writeRecord(record);
}

/** Ids of the session files of a document. */
async function sessionIds(docId: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(docPaths(docId).sessionsDir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => SESSION_ID_RE.test(id));
}

async function loadRecords(docId: string): Promise<SessionRecord[]> {
  const records = await Promise.all((await sessionIds(docId)).map((id) => readRecord(docId, id)));
  return records.filter((record): record is SessionRecord => record !== null);
}

/**
 * Read-modify-write of one session file inside its queue, so it cannot interleave with other writes of the session;
 * `change` returns whether it changed the record (only then is it written, `updatedAt` as it is). A session deleted
 * meanwhile (or malformed) is left alone, never written again. Returns whether the record was written.
 */
function updateRecord(docId: string, sessionId: string, change: (record: DeckRecord) => boolean): Promise<boolean> {
  return sessionQueue(`${docId}/${sessionId}`, async () => {
    const record = await readRecord(docId, sessionId);
    if (!record || !change(record)) return false;
    await writeJsonAtomic(sessionFile(docId, sessionId), record);
    return true;
  });
}

/** Sessions of a document, most recently active first. */
export async function listSessions(docId: string): Promise<SessionSummary[]> {
  const records = await loadRecords(docId);
  return records
    .map(toSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}

/**
 * Deletes the session file and its notes, and the attachments only its messages referred to (DESIGN §21), then
 * regenerates STUDY_NOTES.md. False when missing.
 */
export async function deleteSession(docId: string, sessionId: string): Promise<boolean> {
  const record = await getSession(docId, sessionId);
  if (record === null) return false;
  const file = sessionFile(docId, sessionId);
  // Queue behind pending writes so a late save cannot resurrect the file.
  await sessionQueue(`${docId}/${sessionId}`, () => rmWithRetry(file, { force: true }));
  await rmWithRetry(path.join(docPaths(docId).notesDir, `${sessionId}.md`), { force: true });
  try {
    await removeUnreferencedAttachments(docId, messageAttachmentIds(record.messages), referencedAttachmentIds);
  } catch (err) {
    // They are unreferenced now: the sweep removes them within a day.
    console.warn(`[sessions] could not remove the attachments of ${sessionId}: ${(err as Error).message}`);
  }
  await writeNotes(docId);
  notifySessionsChanged({ docId, sessionId, updatedAt: null });
  return true;
}

/** Ids of the attachments messages refer to (ChatMessage.attachments), in order, without duplicates. */
export function messageAttachmentIds(messages: ChatMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message?.attachments)) continue;
    for (const attachment of message.attachments) if (typeof attachment?.id === 'string') ids.add(attachment.id);
  }
  return [...ids];
}

/** Every attachment id a message of any session of the document refers to (DESIGN §21 cleanup). */
export async function referencedAttachmentIds(docId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const record of await loadRecords(docId)) for (const id of messageAttachmentIds(record.messages)) ids.add(id);
  return ids;
}

export function toSummary(record: SessionRecord): SessionSummary {
  const summary: SessionSummary = {
    id: record.id,
    docId: record.docId,
    title: record.title,
    provider: record.provider,
    model: record.model,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
    primed: record.providerState.primed,
  };
  if (record.effort) summary.effort = record.effort;
  if (record.usage) summary.usage = record.usage;
  if (record.limits) summary.limits = record.limits;
  if (record.switches?.length) summary.switches = record.switches;
  return summary;
}

export function toSession(record: SessionRecord): Session {
  return { ...toSummary(record), messages: record.messages };
}

/**
 * Marks assistant messages stuck in 'streaming' (the server stopped mid-turn) as aborted, with the reason in `lang`.
 * Only call when no turn of this session is running. Returns true when something changed.
 */
export function repairInterruptedMessages(record: SessionRecord, lang: Lang = slang()): boolean {
  let changed = false;
  for (const message of record.messages) {
    if (message.status === 'streaming') {
      message.status = 'aborted';
      message.error ??= smsg(lang).chat.turns.interrupted;
      changed = true;
    }
  }
  return changed;
}

/** Startup sweep over the whole library (see repairInterruptedMessages). */
export async function recoverInterruptedSessions(): Promise<number> {
  let repaired = 0;
  for (const doc of await listStoredDocs()) {
    let docChanged = false;
    for (const id of await sessionIds(doc.id)) {
      // No request at startup: the language of the turn that was stopped.
      if (await updateRecord(doc.id, id, (record) => repairInterruptedMessages(record, record.lang ?? 'ko'))) {
        repaired++;
        docChanged = true;
      }
    }
    if (docChanged) await writeNotes(doc.id);
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// A new version of the deck (DESIGN §28)
// ---------------------------------------------------------------------------

/**
 * Moves every session of the lecture from the old deck's slide numbers to the new deck's (DESIGN §28 "Remaps ›
 * Sessions"), each inside its session queue: the slide of every message and of its region attachments (a dropped slide
 * → the nearest kept one, with `removedFrom`; an undo puts back what the apply from `restoreRev` moved), the slides
 * of the turns' ContextInfo, and a provider conversation made with the old deck dropped (the next turn starts a new
 * one with the new deck: ProviderState.deckUpdated). `updatedAt` is kept. Idempotent: a record that already has
 * `map.toRev` is left alone. Called by the orchestrator while the lecture's turns are held off (chat.reserveDocTurns).
 */
export async function remapSessionSlides(docId: string, map: DeckMap): Promise<void> {
  for (const id of await sessionIds(docId)) {
    await updateRecord(docId, id, (record) => {
      if ((record.deckRev ?? 0) >= map.toRev) return false;
      for (const message of record.messages) remapMessage(message, map);
      record.providerState = deckUpdatedState(record.providerState);
      record.deckRev = map.toRev;
      return true;
    });
  }
}

/** How many questions of the lecture's sessions are about one of `slides` (VersionPlan.onRemoved.questions). */
export async function questionCountOnSlides(docId: string, slides: number[]): Promise<number> {
  const wanted = new Set(slides);
  if (wanted.size === 0) return 0;
  let count = 0;
  for (const record of await loadRecords(docId)) {
    for (const message of record.messages) {
      if (message?.role === 'user' && message.kind === 'question' && wanted.has(message.slide)) count++;
    }
  }
  return count;
}

function remapMessage(message: ChatMessage, map: DeckMap): void {
  if (!message || typeof message !== 'object') return;
  remapSlideRef(message, map);
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (attachment?.kind === 'region' && typeof attachment.slide === 'number') remapSlideRef(attachment, map);
    }
  }
  const context = message.context;
  if (context && typeof context === 'object') {
    context.attachedSlides = remapSlideList(context.attachedSlides, map);
    context.reusedSlides = remapSlideList(context.reusedSlides, map);
  }
}

/**
 * Moves a message or a region attachment to the new deck. A slide the new deck dropped → the nearest kept slide and
 * `removedFrom` {fromRev, old slide}; on an undo, what the apply from `restoreRev` moved goes back to its slide.
 */
function remapSlideRef(item: { slide?: number; removedFrom?: RemovedFrom }, map: DeckMap): void {
  if (map.restoreRev !== undefined && item.removedFrom?.rev === map.restoreRev) {
    item.slide = clampSlide(item.removedFrom.slide, map.newPageCount);
    delete item.removedFrom;
    return;
  }
  const old = clampSlide(item.slide, map.oldPageCount);
  const next = newSlideOf(map, old);
  if (next !== null) {
    item.slide = next;
    return;
  }
  item.slide = nearestKeptSlide(map, old);
  item.removedFrom = { rev: map.fromRev, slide: old };
}

/** ContextInfo slide lists: mapped, the dropped slides left out. */
function remapSlideList(slides: ContextInfo['attachedSlides'], map: DeckMap): number[] {
  const out: number[] = [];
  for (const slide of Array.isArray(slides) ? slides : []) {
    if (!Number.isInteger(slide) || slide < 1 || slide > map.oldPageCount) continue;
    const next = newSlideOf(map, slide);
    if (next !== null) out.push(next);
  }
  return out;
}

/** The old slide's number in the new deck, or null when the new deck dropped it. */
function newSlideOf(map: DeckMap, old: number): number | null {
  const next = map.oldToNew[old - 1];
  return typeof next === 'number' ? next : null;
}

/** Where a dropped slide's things go: the closest preceding old slide that was kept, else the closest following, else 1. */
function nearestKeptSlide(map: DeckMap, old: number): number {
  for (let slide = old - 1; slide >= 1; slide--) {
    const next = newSlideOf(map, slide);
    if (next !== null) return next;
  }
  for (let slide = old + 1; slide <= map.oldPageCount; slide++) {
    const next = newSlideOf(map, slide);
    if (next !== null) return next;
  }
  return 1;
}

function clampSlide(slide: unknown, pageCount: number): number {
  const n = typeof slide === 'number' && Number.isFinite(slide) ? Math.round(slide) : 1;
  return Math.min(Math.max(n, 1), Math.max(1, pageCount));
}

/**
 * The provider state after the deck changed: a conversation made with the old deck (primed, resumable, with history,
 * or dropped by an LLM switch or an earlier swap and not restarted yet) is dropped and the next turn starts a new one
 * with the new deck as a forced rollover (`deckUpdated`; `switched` kept); otherwise a fresh state. The generation stays.
 */
function deckUpdatedState(state: ProviderState): ProviderState {
  const generation = Number.isInteger(state.generation) && state.generation >= 0 ? state.generation : 0;
  const next: ProviderState = { ...initialProviderState(), generation };
  if (state.switched === true) next.switched = true;
  const hadConversation =
    state.primed === true ||
    (state.resume ?? null) !== null ||
    (Array.isArray(state.history) && state.history.length > 0) ||
    state.switched === true ||
    state.deckUpdated === true;
  if (hadConversation) next.deckUpdated = true;
  return next;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** "Codex (gpt-5.5, effort high)"; the model and effort are left out when they are the defaults. */
function providerLabel(provider: ProviderId, model: string, effort?: string): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  const details = [model, effort ? `effort ${effort}` : ''].filter(Boolean);
  return details.length > 0 ? `${label} (${details.join(', ')})` : label;
}

/** "Claude Code (sonnet)", or "Claude Code (sonnet) → Codex (gpt-5.5, effort high)" when the session's LLM changed. */
function sessionProviderLine(record: SessionRecord): string {
  const switches = record.switches ?? [];
  const first = switches[0]?.from ?? llmOf(record);
  return [first, ...switches.map((change) => change.to)].map((llm) => providerLabel(llm.provider, llm.model, llm.effort)).join(' → ');
}

/** What answered an entry ("Codex (gpt-5.5, effort high)"): the answer's LLM; without an answer, the session's. */
function entryProviderLabel(entry: NoteEntry, record: SessionRecord | undefined): string {
  const answer = entry.answer;
  if (answer?.provider) return providerLabel(answer.provider, answer.model ?? '', answer.effort);
  return record ? providerLabel(record.provider, record.model, record.effort) : providerLabel(entry.provider, '');
}

/** Question/answer pairs of one session in chronological order (prime turns excluded). */
function sessionEntries(record: SessionRecord): NoteEntry[] {
  const entries: NoteEntry[] = [];
  record.messages.forEach((message, index) => {
    if (message.role !== 'user' || message.kind !== 'question') return;
    const next = record.messages[index + 1];
    const answer = next && next.role === 'assistant' ? next : null;
    entries.push({
      sessionId: record.id,
      sessionTitle: record.title,
      // The answer names the LLM that gave it (the session's can change, see switches); without one, the session's.
      provider: answer?.provider ?? record.provider,
      question: message,
      answer,
    });
  });
  return entries;
}

/** Keeps the student's line breaks when rendered (Markdown would join single newlines). */
function withHardBreaks(text: string): string {
  return text.trim().split('\n').join('  \n');
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')?.trim() ?? '';
  if (!line) return '(empty question)';
  return line.length > MAX_HEADING_QUESTION_CHARS ? `${line.slice(0, MAX_HEADING_QUESTION_CHARS)}…` : line;
}

function answerMarkdown(answer: ChatMessage | null, headingLevels: number): string {
  if (!answer) return '_(no answer)_';
  const text = demoteHeadings(answer.text.trim(), headingLevels);
  switch (answer.status) {
    case 'complete':
      return text || '_(empty answer)_';
    case 'streaming':
      return [text, '_(answer in progress…)_'].filter(Boolean).join('\n\n');
    case 'error':
    case 'aborted': {
      const reason = answer.error || (answer.status === 'aborted' ? 'aborted' : 'unknown error');
      return [text, `_(answer failed: ${reason.replace(/\s+/g, ' ').trim()})_`].filter(Boolean).join('\n\n');
    }
  }
}

/**
 * The attachments of a question as Markdown images (DESIGN §21), one line: `![p.12 영역](<prefix><id>.png)` for a
 * selected region, `![이미지](<prefix><id>.jpg)` for an image; '' without attachments. `files` maps ids to the
 * stored file names. The alt texts are in the language of the request that rewrote the notes.
 */
function attachmentsMarkdown(question: ChatMessage, files: ReadonlyMap<string, string>, prefix: string): string {
  if (!Array.isArray(question.attachments)) return '';
  const m = smsg().chat.sessions;
  return question.attachments
    .filter((attachment) => typeof attachment?.id === 'string' && ATTACHMENT_ID_RE.test(attachment.id))
    .map((attachment) => {
      const alt = attachment.kind === 'region' ? m.regionAlt(attachment.slide ?? question.slide) : m.imageAlt;
      return `![${alt}](${prefix}${files.get(attachment.id) ?? `${attachment.id}.jpg`})`;
    })
    .join(' ');
}

function sessionNotesMarkdown(doc: StoredDocMeta, record: SessionRecord, files: ReadonlyMap<string, string>): string {
  const lines: string[] = [
    `# ${doc.title} — ${record.title}`,
    `- Provider: ${sessionProviderLine(record)} · Started: ${formatDateTime(record.createdAt)}`,
    '',
    '---',
    '',
  ];
  const shownSlides = new Set<number>();
  for (const entry of sessionEntries(record)) {
    const slide = entry.question.slide;
    lines.push(`## p.${slide} · ${formatTime(entry.question.createdAt)}`);
    if (!shownSlides.has(slide)) {
      shownSlides.add(slide);
      lines.push(`![slide ${slide}](../slides/${slideFileName(slide, doc.pageCount)})`);
    }
    lines.push('', `**Q.** ${withHardBreaks(entry.question.text)}`, '');
    const attached = attachmentsMarkdown(entry.question, files, `../${ATTACHMENTS_DIR}/`);
    if (attached) lines.push(attached, '');
    lines.push(answerMarkdown(entry.answer, 2), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** All entries of all sessions grouped by slide (ascending), entries chronological. */
function groupBySlide(records: SessionRecord[]): SlideNotes[] {
  const bySlide = new Map<number, NoteEntry[]>();
  for (const entry of records.flatMap(sessionEntries)) {
    const list = bySlide.get(entry.question.slide) ?? [];
    list.push(entry);
    bySlide.set(entry.question.slide, list);
  }
  return [...bySlide.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slide, entries]) => ({
      slide,
      entries: entries.sort((a, b) => a.question.createdAt.localeCompare(b.question.createdAt)),
    }));
}

function studyNotesMarkdown(doc: StoredDocMeta, records: SessionRecord[], slides: SlideNotes[], files: ReadonlyMap<string, string>): string {
  const recordById = new Map(records.map((record) => [record.id, record]));
  const lines: string[] = [`# ${doc.title} — study notes`, ''];
  if (slides.length === 0) lines.push('_No questions yet._', '');
  for (const { slide, entries } of slides) {
    lines.push(`## Slide ${slide}`, '', `![slide ${slide}](slides/${slideFileName(slide, doc.pageCount)})`, '');
    for (const entry of entries) {
      const question = entry.question.text.trim();
      const provider = entryProviderLabel(entry, recordById.get(entry.sessionId));
      lines.push(
        `### Q. ${firstLine(question)}`,
        `> ${entry.sessionTitle} · ${provider} · ${formatDateTime(entry.question.createdAt)}`,
        '',
      );
      // The heading only holds the (possibly shortened) first line: add the full question whenever the
      // heading does not already show all of it, so the review file never loses question text.
      if (question.includes('\n') || firstLine(question) !== question) lines.push(withHardBreaks(question), '');
      const attached = attachmentsMarkdown(entry.question, files, `${ATTACHMENTS_DIR}/`);
      if (attached) lines.push(attached, '');
      lines.push(answerMarkdown(entry.answer, 3), '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function regenerateNotes(docId: string): Promise<void> {
  const doc = await readStoredDoc(docId);
  if (!doc) return;
  const paths = docPaths(docId);
  const records = (await loadRecords(docId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await fs.mkdir(paths.notesDir, { recursive: true });
  const files = await attachmentFileNames(docId, records.flatMap((record) => messageAttachmentIds(record.messages)));

  const current = new Set<string>();
  for (const record of records) {
    const name = `${record.id}.md`;
    current.add(name);
    await writeFileAtomic(path.join(paths.notesDir, name), sessionNotesMarkdown(doc, record, files));
  }
  // Drop notes of sessions that no longer exist.
  for (const name of await fs.readdir(paths.notesDir)) {
    if (name.endsWith('.md') && !current.has(name) && SESSION_ID_RE.test(name.slice(0, -'.md'.length))) {
      await rmWithRetry(path.join(paths.notesDir, name), { force: true });
    }
  }
  await writeFileAtomic(paths.studyNotes, studyNotesMarkdown(doc, records, groupBySlide(records), files));
}

/** Regenerates notes/<sid>.md for every session of the document and STUDY_NOTES.md. */
export function writeNotes(docId: string): Promise<void> {
  return notesQueue(docId, () => regenerateNotes(docId));
}

/** All Q&A of a document grouped by slide (also makes sure STUDY_NOTES.md exists). */
export async function buildNotes(docId: string): Promise<NotesResponse> {
  if ((await readStoredDoc(docId)) === null) throw new HttpError(404, smsg().common.notFound.doc);
  const paths = docPaths(docId);
  try {
    await fs.access(paths.studyNotes);
  } catch {
    await writeNotes(docId);
  }
  return { docId, slides: groupBySlide(await loadRecords(docId)), markdownPath: paths.studyNotes };
}
