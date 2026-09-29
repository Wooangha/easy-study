// Regions made from a 필기 (DESIGN §25 "📎 첨부"): POST …/regions with `annotationId` snapshots the item into
// Attachment.annotation (id, type, text), the turn labels it for the tutor and adds the note's words after the
// selection text, the saved user message and the notes carry the snapshot, and the memos of the focus window reach
// the tutor unless `memos: false` or the memo's 👁 is off — checked on what the real Claude Code adapter writes to the
// fake CLI's stdin (tests/fixtures/fake-claude.mjs). The image worker is the real one.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import type { Attachment, NotesResponse, ProviderInfo, Session, SlideAnnotations, StreamEvent } from '../shared/types.ts';
import { ANNOTATION_NOT_FOUND } from '../server/attachments.ts';
import { defaultChatDeps } from '../server/chat.ts';
import type { ChatDeps } from '../server/chat.ts';
import { repoRoot } from '../server/config.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import { docPaths, slideFileName, textFileName } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';

const PAGES = 4;
const DOC = 'note-deck-aaa111';
const ENV_KEYS = ['CLAUDE_BIN', 'CODEX_BIN', 'FAKE_CLI_RECORD', 'FAKE_CLI_MODE', 'CODEX_HOME'] as const;

let tmpRoot = '';
let recordFile = '';
let savedEnv: Record<string, string | undefined> = {};

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-annot-att-'));
  process.env.EASY_STUDY_LIBRARY = path.join(tmpRoot, 'library');
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
  const fixtures = path.join(repoRoot(), 'tests', 'fixtures');
  recordFile = path.join(tmpRoot, 'claude.json');
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.CLAUDE_BIN = path.join(fixtures, 'fake-claude.mjs');
  process.env.CODEX_BIN = path.join(fixtures, 'fake-codex.mjs');
  process.env.FAKE_CLI_RECORD = recordFile;
  process.env.CODEX_HOME = path.join(tmpRoot, 'codex-home'); // never the user's ~/.codex
  delete process.env.FAKE_CLI_MODE;
});

after(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A ready document with texts and small slide PNGs (the region job crops them; no source.pdf: the selection text is ''). */
async function makeDoc(docId: string): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.textDir, { recursive: true });
  await fs.mkdir(paths.slidesDir, { recursive: true });
  const meta: StoredDocMeta = { id: docId, title: 'Notes Deck', fileName: 'Notes Deck.pdf', pageCount: PAGES, aspectRatio: 16 / 9, status: 'ready', progress: PAGES, createdAt: new Date().toISOString() };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
  for (let n = 1; n <= PAGES; n++) {
    await fs.writeFile(path.join(paths.textDir, textFileName(n, PAGES)), `Slide ${n} text`);
    const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 40 * n, g: 120, b: 200 } } }).png().toBuffer();
    await fs.writeFile(path.join(paths.slidesDir, slideFileName(n, PAGES)), png);
  }
}

interface CliRecord {
  argv: string[];
  stdin: string;
}

/** The text parts of the user message the adapter wrote to the fake CLI's stdin (one stream-json line). */
async function recordedText(): Promise<string> {
  const record = JSON.parse(await fs.readFile(recordFile, 'utf8')) as CliRecord;
  const lines = record.stdin.trim().split('\n');
  const message = JSON.parse(lines[lines.length - 1]) as { message: { content: Array<{ type: string; text?: string }> } };
  return message.message.content.map((part) => (part.type === 'text' ? part.text : `<image>`)).join('\n');
}

function parseSse(raw: string): Array<{ event: string; data: StreamEvent }> {
  return raw
    .split('\n\n')
    .filter((frame) => frame.trim() && !frame.startsWith(':'))
    .map((frame) => ({
      event: /^event: (.+)$/m.exec(frame)?.[1] ?? '',
      data: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? 'null') as StreamEvent,
    }));
}

let counter = 0;
const id = () => `an-${(++counter).toString(16).padStart(12, '0')}`;

describe('regions made from a 필기 (fake Claude Code CLI)', () => {
  let server: RunningServer;
  let base = '';
  const infos: ProviderInfo[] = [{ id: 'claude-code', label: 'Claude Code', kind: 'cli', available: true, models: [{ id: '', label: 'default' }], defaultModel: '' }];
  // The real provider registry (the Claude Code adapter runs CLAUDE_BIN = the fake CLI); availability is not probed.
  const deps: ChatDeps = { ...defaultChatDeps(), checkProvider: async () => ({ available: true }), cliSlot: undefined };

  const api = (p: string, init?: RequestInit) => fetch(`${base}/api${p}`, init);
  const send = (method: string, p: string, body: unknown) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  let memoId = '';
  let rectId = '';
  let sessionId = '';

  before(async () => {
    await makeDoc(DOC);
    server = await startServer({ port: 0, log: false, resumeIngests: false, sweepAttachments: false, providerInfos: async () => infos, chatDeps: deps });
    base = server.url;
    memoId = id();
    rectId = id();
    const res = await send('PUT', `/docs/${DOC}/annotations/2`, {
      baseRev: 0,
      items: [
        { id: memoId, type: 'memo', color: 'pink', createdAt: '2026-09-29T10:00:00.000Z', at: { x: 0.6, y: 0.3 }, text: '  여기가\n\n헷갈림  ', tags: ['시험'], collapsed: false, tutor: true, links: [] },
        { id: rectId, type: 'rect', color: 'blue', createdAt: '2026-09-29T10:00:00.000Z', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
      ],
      hiddenMarkers: [],
    });
    assert.equal(res.status, 200, await res.clone().text());
    sessionId = (await json<Session>(await send('POST', `/docs/${DOC}/sessions`, { provider: 'claude-code' }))).id;
  });

  after(async () => {
    await server?.close();
  });

  async function ask(body: Record<string, unknown>): Promise<Extract<StreamEvent, { type: 'done' }>> {
    const res = await send('POST', `/docs/${DOC}/sessions/${sessionId}/messages`, { text: '이 부분 설명해줘', slide: 2, ...body });
    assert.equal(res.status, 200, await res.clone().text());
    const frames = parseSse(await res.text());
    const done = frames.at(-1)?.data;
    assert.ok(done?.type === 'done', JSON.stringify(frames.at(-1)));
    assert.equal(done.assistantMessage.status, 'complete', done.assistantMessage.error ?? '');
    return done;
  }

  test('POST …/regions with annotationId snapshots the item (id, type, text); unknown or malformed ids are 400', async () => {
    const res = await send('POST', `/docs/${DOC}/regions`, { slide: 2, rect: { x: 0.6, y: 0.3, w: 0.12, h: 0.08 }, annotationId: memoId });
    assert.equal(res.status, 201, await res.clone().text());
    const attachment = await json<Attachment>(res);
    assert.deepEqual(attachment.annotation, { id: memoId, type: 'memo', text: '여기가\n\n헷갈림' });
    assert.equal(attachment.kind, 'region');
    assert.deepEqual([attachment.slide, attachment.text], [2, '']);
    const stored = JSON.parse(await fs.readFile(path.join(docPaths(DOC).dir, 'attachments', `${attachment.id}.json`), 'utf8')) as Attachment;
    assert.deepEqual(stored.annotation, attachment.annotation);
    assert.equal((await api(`/docs/${DOC}/attachments/${attachment.id}`)).status, 200);

    const shape = await json<Attachment>(await send('POST', `/docs/${DOC}/regions`, { slide: 2, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, annotationId: rectId }));
    assert.deepEqual(shape.annotation, { id: rectId, type: 'rect' }, 'a shape has no text');

    const missing = await send('POST', `/docs/${DOC}/regions`, { slide: 3, rect: { x: 0.6, y: 0.3, w: 0.12, h: 0.08 }, annotationId: memoId });
    assert.equal(missing.status, 400);
    assert.equal((await json<{ error: string }>(missing)).error, ANNOTATION_NOT_FOUND, 'the item is on slide 2, not 3');
    const malformed = await send('POST', `/docs/${DOC}/regions`, { slide: 2, rect: { x: 0.6, y: 0.3, w: 0.12, h: 0.08 }, annotationId: 'an-nope' });
    assert.equal(malformed.status, 400);
    assert.equal((await json<{ error: string }>(malformed)).error, ANNOTATION_NOT_FOUND);
    const plain = await json<Attachment>(await send('POST', `/docs/${DOC}/regions`, { slide: 2, rect: { x: 0.6, y: 0.3, w: 0.12, h: 0.08 } }));
    assert.equal(plain.annotation, undefined);
  });

  test('a question with the attachment: the label names the note, its words follow the selection text, the message keeps the snapshot', async () => {
    const attachment = await json<Attachment>(await send('POST', `/docs/${DOC}/regions`, { slide: 2, rect: { x: 0.6, y: 0.3, w: 0.12, h: 0.08 }, annotationId: memoId }));
    const done = await ask({ attachments: [attachment.id] });
    const text = await recordedText();
    assert.ok(text.includes('[Attachment 1: the part of slide 2 where the student stuck a note]'), text);
    assert.ok(text.includes("The student's note there:\n여기가\n\n헷갈림"), text);
    assert.ok(text.indexOf('Text inside the selection:') < text.indexOf("The student's note there:"));
    assert.ok(text.includes("The student's own notes on slide 2"), 'the memo of the window is also given');
    assert.ok(text.includes('- [tags: 시험] 여기가 헷갈림'));

    // `done` carries the whole session (chat.ts), typed as its summary.
    const user = (done.session as Session).messages.at(-2)!;
    assert.deepEqual(user.attachments?.[0]?.annotation, { id: memoId, type: 'memo', text: '여기가\n\n헷갈림' });
    assert.equal(user.context?.attachments, 1);
    assert.equal(user.context?.memos, 1);
    const saved = await json<Session>(await api(`/docs/${DOC}/sessions/${sessionId}`));
    assert.deepEqual(saved.messages.at(-2)?.attachments?.[0]?.annotation, user.attachments?.[0]?.annotation);
    const notes = await json<NotesResponse>(await api(`/docs/${DOC}/notes`));
    assert.deepEqual(notes.slides[0]?.entries[0]?.question.attachments?.[0]?.annotation, { id: memoId, type: 'memo', text: '여기가\n\n헷갈림' });
  });

  test('`memos: false` and a memo with 👁 off keep the notes from the tutor; the text box and highlight labels', async () => {
    await ask({ memos: false });
    assert.ok(!(await recordedText()).includes("The student's own notes"));

    const doc = await json<SlideAnnotations>(await api(`/docs/${DOC}/annotations/2`));
    await send('PATCH', `/docs/${DOC}/annotations/2`, { baseRev: doc.rev, ops: [{ op: 'update', id: memoId, patch: { tutor: false } }] });
    const hidden = await ask({});
    assert.ok(!(await recordedText()).includes("The student's own notes"));
    assert.equal((hidden.session as Session).messages.at(-2)?.context?.memos, undefined);

    const textId = id();
    const hlId = id();
    const next = await json<SlideAnnotations>(await api(`/docs/${DOC}/annotations/2`));
    await send('PATCH', `/docs/${DOC}/annotations/2`, {
      baseRev: next.rev,
      ops: [
        { op: 'add', item: { id: textId, type: 'text', color: 'green', createdAt: '2026-09-29T10:00:00.000Z', rect: { x: 0.2, y: 0.5, w: 0.3, h: 0.1 }, text: '박스 글' } },
        { op: 'add', item: { id: hlId, type: 'textHighlight', color: 'yellow', createdAt: '2026-09-29T10:00:00.000Z', rects: [{ x: 0.2, y: 0.7, w: 0.3, h: 0.05 }], chars: [0, 9], engine: 'pdfium-3', text: 'FIRST set' } },
      ],
    });
    const box = await json<Attachment>(await send('POST', `/docs/${DOC}/regions`, { slide: 2, rect: { x: 0.2, y: 0.5, w: 0.3, h: 0.1 }, annotationId: textId }));
    const highlight = await json<Attachment>(await send('POST', `/docs/${DOC}/regions`, { slide: 2, rect: { x: 0.2, y: 0.7, w: 0.3, h: 0.05 }, annotationId: hlId }));
    await ask({ attachments: [box.id, highlight.id] });
    const text = await recordedText();
    assert.ok(text.includes('[Attachment 1: the part of slide 2 where the student put a text box]'), text);
    assert.ok(text.includes("The student's note there:\n박스 글"));
    assert.ok(text.includes('[Attachment 2: the part of slide 2 the student highlighted]'));
    assert.ok(text.includes('The highlighted words:\nFIRST set'));
  });
});
