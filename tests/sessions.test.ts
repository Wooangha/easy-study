// Session persistence and the generated review notes (DESIGN §7).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { SESSION_ID_RE } from '../shared/types.ts';
import type { ChatMessage, UsageLimits } from '../shared/types.ts';
import { HttpError } from '../server/config.ts';
import { initialProviderState } from '../server/context.ts';
import type { SessionRecord } from '../server/internal-types.ts';
import { docPaths } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import {
  buildNotes,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  newSessionId,
  recoverInterruptedSessions,
  saveSession,
  switchSessionLlm,
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
  const meta: StoredDocMeta = {
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

  test('the reasoning effort is stored with the session; a file without one (older versions) reads as the default', async () => {
    const record = await createSession(DOC_ID, { provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
    assert.equal(record.effort, 'xhigh');
    const file = path.join(docPaths(DOC_ID).sessionsDir, `${record.id}.json`);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).effort, 'xhigh');
    assert.equal((await getSession(DOC_ID, record.id))?.effort, 'xhigh');
    assert.equal(toSummary(record).effort, 'xhigh');

    const plain = await createSession(DOC_ID, { provider: 'codex', model: '', effort: '' });
    const plainFile = path.join(docPaths(DOC_ID).sessionsDir, `${plain.id}.json`);
    assert.ok(!('effort' in JSON.parse(await fs.readFile(plainFile, 'utf8'))), 'nothing is written for the default');
    const legacy = { ...JSON.parse(await fs.readFile(file, 'utf8')) };
    delete legacy.effort;
    await fs.writeFile(file, JSON.stringify(legacy));
    const read = await getSession(DOC_ID, record.id);
    assert.equal(read?.effort, undefined);
    assert.ok(!('effort' in toSummary(read!)));
    // A level that is not one (edited by hand) is the default too: it would reach the CLI's arguments.
    for (const effort of ['--model', 7, '']) {
      await fs.writeFile(file, JSON.stringify({ ...legacy, effort }));
      assert.ok(!('effort' in (await getSession(DOC_ID, record.id))!), String(effort));
    }
    await deleteSession(DOC_ID, record.id);
    await deleteSession(DOC_ID, plain.id);
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

describe('LLM switch (switchSessionLlm, DESIGN §5)', () => {
  const SWITCH_DOC = 'switch-doc-000333';
  /** A session that has talked to its provider: something to drop on a switch. */
  const primed = (): SessionRecord['providerState'] => ({
    resume: { cliSessionId: 'cli-1' },
    primed: true,
    imagesSent: 5,
    recentSlides: [2],
    generation: 1,
    history: [],
  });

  before(() => makeDoc(SWITCH_DOC, 'Paging'));

  test('changes provider, model and effort, drops the provider conversation (a forced rollover next) and records the change', async () => {
    const record = await createSession(SWITCH_DOC, { provider: 'claude-code', model: 'sonnet', effort: 'high', title: '전환' });
    record.messages.push(...qa(2, '첫 질문', { text: '첫 답' }, [10, 0]));
    record.providerState = primed();
    await saveSession(record);

    const { record: switched, changed } = await switchSessionLlm(SWITCH_DOC, record.id, { provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
    assert.equal(changed, true);
    assert.equal(switched.provider, 'codex');
    assert.equal(switched.model, 'gpt-5.5');
    assert.equal(switched.effort, 'xhigh');
    assert.deepEqual(switched.providerState, { ...initialProviderState(), generation: 1, switched: true });
    assert.equal(switched.switches?.length, 1);
    const change = switched.switches![0];
    assert.deepEqual(change.from, { provider: 'claude-code', model: 'sonnet', effort: 'high' });
    assert.deepEqual(change.to, { provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
    assert.equal(change.afterMessageId, record.messages.at(-1)!.id);
    assert.ok(Date.parse(change.at) > 0);
    const stored = await getSession(SWITCH_DOC, record.id);
    assert.deepEqual(stored, switched);
    assert.deepEqual(toSummary(stored!).switches, switched.switches);
    assert.equal(toSummary(stored!).provider, 'codex');

    // Back to a CLI-default effort: the field goes away. Nothing talked to Codex yet: still marked for the next turn.
    const { record: again } = await switchSessionLlm(SWITCH_DOC, record.id, { provider: 'claude-code', model: '' });
    assert.ok(!('effort' in again));
    assert.equal(again.switches?.length, 2);
    assert.deepEqual(again.switches![1].from, { provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
    assert.deepEqual(again.switches![1].to, { provider: 'claude-code', model: '' });
    assert.deepEqual(again.providerState, { ...initialProviderState(), generation: 1, switched: true });

    // The same LLM once more: nothing changes, nothing is written ('' effort = none).
    const before = again.updatedAt;
    const noop = await switchSessionLlm(SWITCH_DOC, record.id, { provider: 'claude-code', model: '', effort: '' });
    assert.equal(noop.changed, false);
    assert.equal(noop.record.switches?.length, 2);
    assert.equal((await getSession(SWITCH_DOC, record.id))?.updatedAt, before);

    await assert.rejects(
      switchSessionLlm(SWITCH_DOC, '20200101-000000-0000', { provider: 'codex', model: '' }),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });

  test('the usage limits go with the provider that reported them: kept for a model change, dropped with the provider', async () => {
    const LIMITS: UsageLimits = { at: '2026-09-29T00:00:00.000Z', status: 'ok', windows: [{ minutes: 300, usedPercent: 42 }] };
    const record = await createSession(SWITCH_DOC, { provider: 'claude-code', model: 'sonnet' });
    record.limits = LIMITS;
    await saveSession(record);
    const { record: sameProvider } = await switchSessionLlm(SWITCH_DOC, record.id, { provider: 'claude-code', model: 'opus', effort: 'max' });
    assert.deepEqual(sameProvider.limits, LIMITS);
    const { record: other } = await switchSessionLlm(SWITCH_DOC, record.id, { provider: 'codex', model: '' });
    assert.ok(!('limits' in other), "Claude's report is not Codex's");
    assert.ok(!('limits' in toSummary((await getSession(SWITCH_DOC, record.id))!)));
  });

  test('a session that never talked to its provider keeps its state (nothing to drop); the change is still recorded', async () => {
    const fresh = await createSession(SWITCH_DOC, { provider: 'claude-code', model: '' });
    const { record: moved } = await switchSessionLlm(SWITCH_DOC, fresh.id, { provider: 'codex', model: '' });
    assert.deepEqual(moved.providerState, initialProviderState());
    assert.equal(moved.switches?.[0]?.afterMessageId, null);
    assert.deepEqual(moved.switches?.[0]?.from, { provider: 'claude-code', model: '' });
  });

  test('sessions saved before switches existed load unchanged; malformed switches are dropped', async () => {
    const record = await createSession(SWITCH_DOC, { provider: 'codex', model: '' });
    const file = path.join(docPaths(SWITCH_DOC).sessionsDir, `${record.id}.json`);
    const legacy = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.ok(!('switches' in legacy), 'nothing is written for a session that never changed');
    const read = await getSession(SWITCH_DOC, record.id);
    assert.ok(!('switches' in read!));
    assert.ok(!('switches' in toSummary(read!)));

    const good = {
      at: '2026-09-23T06:00:00.000Z',
      afterMessageId: null,
      from: { provider: 'codex', model: '' },
      to: { provider: 'claude-code', model: 'opus', effort: 'max' },
    };
    const junk = [{ at: 5 }, { ...good, afterMessageId: 7 }, { ...good, to: { provider: 'x' } }, 'junk', null];
    // A level that is not one (edited by hand) reads as the default, like SessionRecord.effort.
    const badEffort = { ...good, to: { ...good.to, effort: '--model' } };
    await fs.writeFile(file, JSON.stringify({ ...legacy, switches: [good, ...junk, badEffort] }));
    const cleaned = await getSession(SWITCH_DOC, record.id);
    assert.deepEqual(cleaned?.switches, [good, { ...good, to: { provider: 'claude-code', model: 'opus' } }]);
    await fs.writeFile(file, JSON.stringify({ ...legacy, switches: 'nope' }));
    assert.ok(!('switches' in (await getSession(SWITCH_DOC, record.id))!));
  });

  test("the notes name the LLM of each answer and the session's changes", async () => {
    const record = await createSession(SWITCH_DOC, { provider: 'claude-code', model: 'sonnet', title: '바꾼 세션' });
    record.createdAt = at(9, 0);
    record.messages.push(...qa(4, '전환 전 질문', { text: '소넷의 답' }, [9, 1]));
    record.providerState = primed();
    await saveSession(record);
    await switchSessionLlm(SWITCH_DOC, record.id, { provider: 'codex', model: 'gpt-5.5', effort: 'high' });
    const after = (await getSession(SWITCH_DOC, record.id))!;
    after.messages.push(...qa(4, '전환 후 질문', { text: '코덱스의 답', provider: 'codex', model: 'gpt-5.5', effort: 'high' }, [9, 5]));
    await saveSession(after);
    await writeNotes(SWITCH_DOC);

    const own = await fs.readFile(path.join(docPaths(SWITCH_DOC).notesDir, `${record.id}.md`), 'utf8');
    assert.match(own, /^- Provider: Claude Code \(sonnet\) → Codex \(gpt-5\.5, effort high\) · Started: 2026-09-23 09:00$/m);
    const md = await fs.readFile(docPaths(SWITCH_DOC).studyNotes, 'utf8');
    assert.ok(md.includes('### Q. 전환 전 질문\n> 바꾼 세션 · Claude Code (sonnet) · 2026-09-23 09:01\n\n소넷의 답\n'));
    assert.ok(md.includes('### Q. 전환 후 질문\n> 바꾼 세션 · Codex (gpt-5.5, effort high) · 2026-09-23 09:05\n\n코덱스의 답\n'));
    const notes = await buildNotes(SWITCH_DOC);
    const entries = notes.slides.find((s) => s.slide === 4)!.entries.filter((e) => e.sessionId === record.id);
    assert.deepEqual(entries.map((e) => e.provider), ['claude-code', 'codex']);
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

  test('a long single-line question is written in full below its shortened heading', async () => {
    const docId = 'long-question-000222';
    await makeDoc(docId, 'Long');
    const question = `${'이 슬라이드의 예제에서 각 프로세스의 대기 시간을 어떻게 계산하는지 단계별로 알려 주세요. '.repeat(3)}END-MARKER`;
    assert.ok(question.length > 120 && !question.includes('\n'));
    const record = await createSession(docId, { provider: 'claude-code', model: '', title: '긴 질문' });
    record.messages.push(...qa(2, question, { text: '답변' }, [17, 0]), ...qa(2, '짧은 질문', { text: '짧은 답' }, [17, 5]));
    await saveSession(record);
    await writeNotes(docId);

    const md = await fs.readFile(docPaths(docId).studyNotes, 'utf8');
    assert.ok(md.includes(`### Q. ${question.slice(0, 120)}…\n`), 'the heading stays short');
    assert.ok(md.includes(`\n\n${question}\n\n답변\n`), 'the full question follows the heading');
    // A question that fits in the heading is not repeated (the entry names the answer's LLM: qa() answers with sonnet).
    assert.ok(md.includes('### Q. 짧은 질문\n> 긴 질문 · Claude Code (sonnet) · 2026-09-23 17:05\n\n짧은 답\n'));
  });

  test('an empty document still gets a STUDY_NOTES.md', async () => {
    await makeDoc('empty-doc-000111', 'Empty');
    const notes = await buildNotes('empty-doc-000111');
    assert.deepEqual(notes.slides, []);
    assert.equal(await fs.readFile(notes.markdownPath, 'utf8'), '# Empty — study notes\n\n_No questions yet._\n');
  });
});
