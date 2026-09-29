// Chat sessions persisted as library/<docId>/sessions/<sessionId>.json, and the review notes
// generated from them (notes/<sessionId>.md + STUDY_NOTES.md, DESIGN §7). Questions with attachments (DESIGN
// §21) show them under the question in both, linked relatively (attachments/<id>.jpg|png).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_ID_RE, EFFORT_ID_RE, SESSION_ID_RE } from '../shared/types.ts';
import { readSessionUsage, readUsageLimits } from '../shared/usage.ts';
import type {
  ChatMessage,
  LlmChoice,
  LlmSwitch,
  NoteEntry,
  NotesResponse,
  ProviderId,
  Session,
  SessionSummary,
  SlideNotes,
} from '../shared/types.ts';
import { ATTACHMENTS_DIR } from './assets.ts';
import { attachmentFileNames, removeUnreferencedAttachments } from './attachments.ts';
import { HttpError } from './config.ts';
import { initialProviderState } from './context.ts';
import type { SessionRecord } from './internal-types.ts';
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

/** Serializes writes of one session file (key: docId/sessionId). */
const sessionQueue = createKeyedQueue();
/** Serializes notes regeneration of one document (key: docId). */
const notesQueue = createKeyedQueue();

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
  if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(404, '세션을 찾을 수 없습니다');
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
  if (!doc) throw new HttpError(404, '문서를 찾을 수 없습니다');
  await fs.mkdir(docPaths(docId).sessionsDir, { recursive: true });

  const now = new Date();
  let id = newSessionId(now);
  // Two sessions created in the same second collide with probability 1/65536; just retry.
  while (await fileExists(sessionFile(docId, id))) id = newSessionId(now);

  const createdAt = now.toISOString();
  const record: SessionRecord = {
    version: 1,
    id,
    docId,
    title: cleanTitle(input.title) || `세션 ${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${formatTime(createdAt)}`,
    provider: input.provider,
    model: input.model,
    createdAt,
    updatedAt: createdAt,
    providerState: initialProviderState(),
    messages: [],
  };
  if (input.effort) record.effort = input.effort;
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
  const record: SessionRecord = { ...value, id: sessionId, docId };
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
  if (!record) throw new HttpError(404, '세션을 찾을 수 없습니다');
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

async function loadRecords(docId: string): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(docPaths(docId).sessionsDir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const ids = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => SESSION_ID_RE.test(id));
  const records = await Promise.all(ids.map((id) => readRecord(docId, id)));
  return records.filter((record): record is SessionRecord => record !== null);
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
 * Marks assistant messages stuck in 'streaming' (the server stopped mid-turn) as aborted.
 * Only call when no turn of this session is running. Returns true when something changed.
 */
export function repairInterruptedMessages(record: SessionRecord): boolean {
  let changed = false;
  for (const message of record.messages) {
    if (message.status === 'streaming') {
      message.status = 'aborted';
      message.error ??= '서버가 중단되어 답변이 완료되지 않았습니다';
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
    for (const record of await loadRecords(doc.id)) {
      if (repairInterruptedMessages(record)) {
        await writeRecord(record);
        repaired++;
        docChanged = true;
      }
    }
    if (docChanged) await writeNotes(doc.id);
  }
  return repaired;
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
 * stored file names.
 */
function attachmentsMarkdown(question: ChatMessage, files: ReadonlyMap<string, string>, prefix: string): string {
  if (!Array.isArray(question.attachments)) return '';
  return question.attachments
    .filter((attachment) => typeof attachment?.id === 'string' && ATTACHMENT_ID_RE.test(attachment.id))
    .map((attachment) => {
      const alt = attachment.kind === 'region' ? `p.${attachment.slide ?? question.slide} 영역` : '이미지';
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
  if ((await readStoredDoc(docId)) === null) throw new HttpError(404, '문서를 찾을 수 없습니다');
  const paths = docPaths(docId);
  try {
    await fs.access(paths.studyNotes);
  } catch {
    await writeNotes(docId);
  }
  return { docId, slides: groupBySlide(await loadRecords(docId)), markdownPath: paths.studyNotes };
}
