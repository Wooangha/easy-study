// Session persistence and the generated review notes (DESIGN §7).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { SESSION_ID_RE } from '../shared/types.ts';
import type { ChatMessage, DocMeta } from '../shared/types.ts';
import { HttpError } from '../server/config.ts';
import { initialProviderState } from '../server/context.ts';
import type { SessionRecord } from '../server/internal-types.ts';
import { docPaths } from '../server/library.ts';
import {
  buildNotes,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  newSessionId,
  recoverInterruptedSessions,
  saveSession,
  toSession,
  toSummary,
  writeNotes,
} from '../server/sessions.ts';

const DOC_ID = 'os-lecture-abc123';
let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-sessions-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A ready document without rendered assets is enough for sessions and notes. */
async function makeDoc(docId: string, title = '운영체제 5강'): Promise<void> {
  const paths = docPaths(docId);
  await fs.rm(paths.dir, { recursive: true, force: true });
  await fs.mkdir(paths.dir, { recursive: true });
  const meta: DocMeta = {
    id: docId,
    title,
    fileName: `${title}.pdf`,
    pageCount: 9,
    aspectRatio: 16 / 9,
    status: 'ready',
    progress: 9,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
}

let seq = 0;
/** Local-time ISO string for 2026-09-23 hh:mm (so the rendered times are predictable). */
function at(hh: number, mm: number): string {
  return new Date(2026, 8, 23, hh, mm, 0, seq++ % 1000).toISOString();
}

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'slide'>): ChatMessage {
  return {
    id: `m${seq++}`,
    text: '',
    kind: 'question',
    createdAt: at(15, 40),
    status: 'complete',
    ...partial,
  };
}

function qa(slide: number, question: string, answer: Partial<ChatMessage>, time: [number, number]): ChatMessage[] {
  const createdAt = at(...time);
  return [
    message({ role: 'user', slide, text: question, createdAt }),
    message({ role: 'assistant', slide, createdAt, provider: 'claude-code', model: 'sonnet', ...answer }),
  ];
}

describe('session records', () => {
  beforeEach(() => makeDoc(DOC_ID));

  test('session ids are YYYYMMDD-HHMMSS-xxxx', () => {
    const id = newSessionId(new Date(2026, 8, 23, 15, 4, 5));
    assert.match(id, /^20260923-150405-[0-9a-f]{4}$/);
    assert.match(id, SESSION_ID_RE);
  });

  test('createSession persists an unprimed session', async () => {
    const record = await createSession(DOC_ID, { provider: 'claude-code', model: 'sonnet', title: '  1회차\n복습 ' });
    assert.match(record.id, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.equal(record.version, 1);
    assert.equal(record.docId, DOC_ID);
    assert.equal(record.title, '1회차 복습');
    assert.deepEqual(record.providerState, initialProviderState());
    assert.deepEqual(record.messages, []);

    const onDisk = JSON.parse(await fs.readFile(path.join(docPaths(DOC_ID).sessionsDir, `${record.id}.json`), 'utf8'));
    assert.deepEqual(onDisk, record);
    assert.deepEqual(await getSession(DOC_ID, record.id), record);

    const summary = toSummary(record);
    assert.deepEqual(summary, {
      id: record.id,
      docId: DOC_ID,
      title: '1회차 복습',
      provider: 'claude-code',
      model: 'sonnet',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: 0,
      primed: false,
    });
    assert.deepEqual(toSession(record), { ...summary, messages: [] });
  });

  test('default title and 404 for unknown docs', async () => {
    const record = await createSession(DOC_ID, { provider: 'codex', model: '' });
    assert.match(record.title, /^세션 \d{2}\/\d{2} \d{2}:\d{2}$/);
    await assert.rejects(
      createSession('missing-doc-000000', { provider: 'codex', model: '' }),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });

  test('getSession returns null for invalid or unknown ids', async () => {
    assert.equal(await getSession(DOC_ID, '../../etc/passwd'), null);
    assert.equal(await getSession(DOC_ID, '20260101-000000-0000'), null);
    assert.equal(await getSession('BAD ID', '20260101-000000-0000'), null);
  });

  test('saveSession bumps updatedAt; listSessions is most recently active first', async () => {
    const older = await createSession(DOC_ID, { provider: 'claude-code', model: '' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await createSession(DOC_ID, { provider: 'codex', model: '' });
    let list = await listSessions(DOC_ID);
    assert.deepEqual(
      list.map((s) => s.id),
      [newer.id, older.id],
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    older.messages.push(...qa(2, 'q', { text: 'a' }, [10, 0]));
    const before = older.updatedAt;
    await saveSession(older);
    assert.ok(older.updatedAt > before);
    list = await listSessions(DOC_ID);
    assert.deepEqual(
      list.map((s) => s.id),
      [older.id, newer.id],
    );
    assert.equal(list[0].messageCount, 2);
  });

  test('concurrent saves are serialized and the last one wins', async () => {
    const record = await createSession(DOC_ID, { provider: 'claude-code', model: '' });
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      record.messages.push(message({ role: 'user', slide: 1, text: `q${i}` }));
      saves.push(saveSession(record));
    }
    await Promise.all(saves);
    const stored = await getSession(DOC_ID, record.id);
    assert.equal(stored?.messages.length, 25);
    const leftovers = (await fs.readdir(docPaths(DOC_ID).sessionsDir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('recoverInterruptedSessions marks stuck streaming answers as aborted', async () => {
    const record = await createSession(DOC_ID, { provider: 'claude-code', model: '' });
    record.messages.push(...qa(4, '질문', { text: '부분 답변', status: 'streaming' }, [11, 0]));
    await saveSession(record);
    assert.equal(await recoverInterruptedSessions(), 1);
    const stored = await getSession(DOC_ID, record.id);
    assert.equal(stored?.messages[1].status, 'aborted');
    assert.equal(stored?.messages[1].text, '부분 답변');
    assert.ok(stored?.messages[1].error);
    assert.equal(await recoverInterruptedSessions(), 0);
  });
});

describe('notes', () => {
  const NOTES_DOC = 'notes-doc-def456';
  let first: SessionRecord;
  let second: SessionRecord;

  before(async () => {
    await makeDoc(NOTES_DOC, 'CPU Scheduling');
    first = await createSession(NOTES_DOC, { provider: 'claude-code', model: 'sonnet', title: '1회차' });
    first.createdAt = at(15, 40);
    first.messages.push(
      // Prime turns never show up in the notes.
      message({ role: 'user', slide: 1, kind: 'prime', createdAt: at(15, 40) }),
      message({ role: 'assistant', slide: 1, kind: 'prime', text: 'DECK OVERVIEW', createdAt: at(15, 40) }),
      ...qa(7, '이 간트 차트의 time quantum은?', { text: '## 풀이\n\nq = 4 입니다 (p.7).\n\n```\n# not a heading\n```' }, [15, 42]),
      ...qa(7, '그럼 평균 대기 시간은?', { text: '계산하면 ...' }, [15, 45]),
      ...qa(3, '첫 줄 질문\n둘째 줄 세부사항', { text: '', status: 'error', error: 'claude exited with code 1' }, [15, 50]),
    );
    await saveSession(first);

    second = await createSession(NOTES_DOC, { provider: 'codex', model: '', title: '2회차' });
    second.createdAt = at(16, 0);
    second.messages.push(...qa(7, 'RR의 단점?', { text: '문맥 교환 오버헤드', provider: 'codex', model: '' }, [16, 1]));
    second.messages.push(...qa(5, '중단된 질문', { text: '부분', status: 'aborted', error: '사용자가 중단함' }, [16, 2]));
    await saveSession(second);
    await writeNotes(NOTES_DOC);
  });

  test('notes/<sid>.md per session', async () => {
    const md = await fs.readFile(path.join(docPaths(NOTES_DOC).notesDir, `${first.id}.md`), 'utf8');
    const expected = [
      '# CPU Scheduling — 1회차',
      '- Provider: Claude Code (sonnet) · Started: 2026-09-23 15:40',
      '',
      '---',
      '',
      '## p.7 · 15:42',
      '![slide 7](../slides/007.png)',
      '',
      '**Q.** 이 간트 차트의 time quantum은?',
      '',
      '#### 풀이',
      '',
      'q = 4 입니다 (p.7).',
      '',
      '```',
      '# not a heading',
      '```',
      '',
      '## p.7 · 15:45',
      '',
      '**Q.** 그럼 평균 대기 시간은?',
      '',
      '계산하면 ...',
      '',
      '## p.3 · 15:50',
      '![slide 3](../slides/003.png)',
      '',
      '**Q.** 첫 줄 질문  ',
      '둘째 줄 세부사항',
      '',
      '_(answer failed: claude exited with code 1)_',
      '',
    ].join('\n');
    assert.equal(md, expected);
    assert.ok(!md.includes('DECK OVERVIEW'));

    const other = await fs.readFile(path.join(docPaths(NOTES_DOC).notesDir, `${second.id}.md`), 'utf8');
    assert.match(other, /^# CPU Scheduling — 2회차\n- Provider: Codex · Started: 2026-09-23 16:00\n/);
    assert.match(other, /부분\n\n_\(answer failed: 사용자가 중단함\)_/);
  });

  test('STUDY_NOTES.md groups every session by slide', async () => {
    const md = await fs.readFile(docPaths(NOTES_DOC).studyNotes, 'utf8');
    assert.ok(md.startsWith('# CPU Scheduling — study notes\n'));
    const slide3 = md.indexOf('## Slide 3');
    const slide5 = md.indexOf('## Slide 5');
    const slide7 = md.indexOf('## Slide 7');
    assert.ok(slide3 > 0 && slide3 < slide5 && slide5 < slide7, 'slides ascending');
    assert.ok(!md.includes('## Slide 1\n'), 'prime turns excluded');
    assert.ok(md.includes('![slide 7](slides/007.png)'));
    assert.ok(md.includes('### Q. 첫 줄 질문\n> 1회차 · Claude Code (sonnet) · 2026-09-23 15:50\n\n첫 줄 질문  \n둘째 줄 세부사항\n'));
    assert.ok(md.includes('### Q. 이 간트 차트의 time quantum은?\n> 1회차 · Claude Code (sonnet) · 2026-09-23 15:42\n\n##### 풀이'));
    assert.ok(md.includes('### Q. RR의 단점?\n> 2회차 · Codex · 2026-09-23 16:01\n\n문맥 교환 오버헤드'));
    assert.ok(md.includes('_(answer failed: claude exited with code 1)_'));
    // Entries of one slide are chronological across sessions.
    const order = ['time quantum은?', '평균 대기 시간은?', 'RR의 단점?'].map((q) => md.indexOf(q, slide7));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  test('buildNotes returns the same grouping', async () => {
    const notes = await buildNotes(NOTES_DOC);
    assert.equal(notes.docId, NOTES_DOC);
    assert.equal(notes.markdownPath, docPaths(NOTES_DOC).studyNotes);
    assert.ok(path.isAbsolute(notes.markdownPath));
    assert.deepEqual(
      notes.slides.map((s) => [s.slide, s.entries.length]),
      [
        [3, 1],
        [5, 1],
        [7, 3],
      ],
    );
    const [entry] = notes.slides[0].entries;
    assert.equal(entry.sessionId, first.id);
    assert.equal(entry.sessionTitle, '1회차');
    assert.equal(entry.provider, 'claude-code');
    assert.equal(entry.question.text, '첫 줄 질문\n둘째 줄 세부사항');
    assert.equal(entry.answer?.status, 'error');
    await assert.rejects(buildNotes('missing-doc-000000'), (err: unknown) => err instanceof HttpError && err.status === 404);
  });

  test('deleteSession removes its file and notes and regenerates STUDY_NOTES.md', async () => {
    assert.equal(await deleteSession(NOTES_DOC, second.id), true);
    assert.equal(await getSession(NOTES_DOC, second.id), null);
    await assert.rejects(fs.access(path.join(docPaths(NOTES_DOC).notesDir, `${second.id}.md`)));
    const md = await fs.readFile(docPaths(NOTES_DOC).studyNotes, 'utf8');
    assert.ok(!md.includes('RR의 단점?'));
    assert.ok(!md.includes('## Slide 5'));
    assert.ok(md.includes('## Slide 7'));
    assert.equal(await deleteSession(NOTES_DOC, second.id), false);
  });

  test('an empty document still gets a STUDY_NOTES.md', async () => {
    await makeDoc('empty-doc-000111', 'Empty');
    const notes = await buildNotes('empty-doc-000111');
    assert.deepEqual(notes.slides, []);
    assert.equal(await fs.readFile(notes.markdownPath, 'utf8'), '# Empty — study notes\n\n_No questions yet._\n');
  });
});
