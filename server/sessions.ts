// Chat sessions persisted as library/<docId>/sessions/<sessionId>.json, and the review notes
// generated from them (notes/<sessionId>.md + STUDY_NOTES.md, DESIGN §7). Questions with attachments (DESIGN
// §21) show them under the question in both, linked relatively (attachments/<id>.jpg|png).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_ID_RE, SESSION_ID_RE } from '../shared/types.ts';
import type {
  ChatMessage,
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
  return { ...value, id: sessionId, docId };
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
  return {
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

function providerLabel(provider: ProviderId, model: string): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return model ? `${label} (${model})` : label;
}

/** Question/answer pairs of one session in chronological order (prime turns excluded). */
function sessionEntries(record: SessionRecord): NoteEntry[] {
  const entries: NoteEntry[] = [];
  record.messages.forEach((message, index) => {
    if (message.role !== 'user' || message.kind !== 'question') return;
    const next = record.messages[index + 1];
    entries.push({
      sessionId: record.id,
      sessionTitle: record.title,
      provider: record.provider,
      question: message,
      answer: next && next.role === 'assistant' ? next : null,
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
    `- Provider: ${providerLabel(record.provider, record.model)} · Started: ${formatDateTime(record.createdAt)}`,
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
  const providerBySession = new Map(records.map((record) => [record.id, providerLabel(record.provider, record.model)]));
  const lines: string[] = [`# ${doc.title} — study notes`, ''];
  if (slides.length === 0) lines.push('_No questions yet._', '');
  for (const { slide, entries } of slides) {
    lines.push(`## Slide ${slide}`, '', `![slide ${slide}](slides/${slideFileName(slide, doc.pageCount)})`, '');
    for (const entry of entries) {
      const question = entry.question.text.trim();
      const provider = providerBySession.get(entry.sessionId) ?? providerLabel(entry.provider, '');
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
