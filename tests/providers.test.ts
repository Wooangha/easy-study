// Tests for the provider adapters. Never runs the real CLIs or APIs:
// - CLI providers run fake CLIs from tests/fixtures (via CLAUDE_BIN / CODEX_BIN),
// - API providers talk to a local mock HTTP server (via ANTHROPIC_BASE_URL / OPENAI_BASE_URL).
// Run: node --test tests/providers.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Part, Provider, ProviderRunInput, ProviderRunResult } from '../server/providers/types.ts';
import { claudeArgs, claudeCodeProvider, toolStatus } from '../server/providers/claudeCode.ts';
import { CodexStreamState, codexArgs, codexPrompt, codexProvider } from '../server/providers/codex.ts';
import { anthropicApiProvider, buildAnthropicRequest } from '../server/providers/anthropicApi.ts';
import { buildOpenAIRequest, openaiApiProvider } from '../server/providers/openaiApi.ts';
import { clearProviderInfoCache, getProvider, listProviders, providerInfos } from '../server/providers/index.ts';
import { JsonlParser, runJsonlProcess } from '../server/providers/proc.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.mjs');
fs.chmodSync(FAKE_CLAUDE, 0o755);
fs.chmodSync(FAKE_CODEX, 0o755);

// A 1x1 PNG; the adapters only need readable bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const ENV_KEYS = [
  'CLAUDE_BIN',
  'CODEX_BIN',
  'FAKE_CLI_MODE',
  'FAKE_CLI_RECORD',
  'CLAUDECODE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'EASY_STUDY_ANTHROPIC_MODEL',
  'EASY_STUDY_ANTHROPIC_FALLBACKS',
  'EASY_STUDY_CLAUDE_USE_API_KEY',
];
let savedEnv: Record<string, string | undefined> = {};
let workDir = '';
let recordFile = '';
let sheetPng = '';
let slidePng = '';

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // realpath: the fake CLI reports process.cwd() (e.g. /private/var/... on macOS).
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-study-providers-')));
  fs.mkdirSync(path.join(workDir, 'slides'));
  fs.mkdirSync(path.join(workDir, 'sheets'));
  slidePng = path.join(workDir, 'slides', '003.png');
  sheetPng = path.join(workDir, 'sheets', 'sheet-01.png');
  fs.writeFileSync(slidePng, PNG);
  fs.writeFileSync(sheetPng, Buffer.concat([PNG, Buffer.from('sheet')]));
  recordFile = path.join(workDir, 'record.json');
  process.env.FAKE_CLI_RECORD = recordFile;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});

function parts(): Part[] {
  return [
    { type: 'text', text: 'Overview image: slides 1–4' },
    { type: 'image', path: sheetPng, detail: 'low', label: 'Slides 1–4 overview' },
    { type: 'text', text: 'Full-resolution image of slide 3:' },
    { type: 'image', path: slidePng, detail: 'high', label: 'Slide 3' },
    { type: 'text', text: "Student's question (about slide 3):\n이게 뭐야?" },
  ];
}

interface RunOutcome {
  result?: ProviderRunResult;
  error?: Error;
  deltas: string[];
  statuses: string[];
}

async function run(
  provider: Provider,
  overrides: Partial<ProviderRunInput> = {},
  onDelta?: (text: string, controller: AbortController) => void,
  onStatus?: (text: string, controller: AbortController) => void,
): Promise<RunOutcome> {
  const controller = new AbortController();
  const deltas: string[] = [];
  const statuses: string[] = [];
  try {
    const result = await provider.run({
      cwd: workDir,
      systemPrompt: 'SYSTEM PROMPT',
      parts: parts(),
      resume: null,
      history: [],
      model: '',
      signal: controller.signal,
      onDelta: (t) => {
        deltas.push(t);
        onDelta?.(t, controller);
      },
      onStatus: (t) => {
        statuses.push(t);
        onStatus?.(t, controller);
      },
      ...overrides,
    });
    return { result, deltas, statuses };
  } catch (error) {
    return { error: error as Error, deltas, statuses };
  }
}

function record(): { argv: string[]; stdin: string; pid: number; env?: Record<string, string | null> } {
  return JSON.parse(fs.readFileSync(recordFile, 'utf8'));
}

function assertDead(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (err: NodeJS.ErrnoException) => err.code === 'ESRCH');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// proc.ts
// ---------------------------------------------------------------------------

describe('proc', () => {
  test('JsonlParser buffers partial lines and ignores non-JSON lines', () => {
    const seen: unknown[] = [];
    const parser = new JsonlParser((o) => seen.push(o));
    parser.push('{"a":');
    parser.push('1}\nnot json\n\n[1,2]\n{"b":2}\n{"broken":');
    parser.push('\n{"c":3}');
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
    parser.flush();
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test('a missing binary rejects with a readable error', async () => {
    await assert.rejects(
      runJsonlProcess({
        bin: path.join(workDir, 'does-not-exist'),
        args: [],
        cwd: workDir,
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
      /찾을 수 없습니다/,
    );
  });

  test('an already-aborted signal rejects without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runJsonlProcess({ bin: FAKE_CLAUDE, args: [], cwd: workDir, signal: controller.signal, onEvent: () => {} }),
      { name: 'AbortError' },
    );
    assert.equal(fs.existsSync(recordFile), false);
  });
});

// ---------------------------------------------------------------------------
// claude-code
// ---------------------------------------------------------------------------

describe('claude-code provider', () => {
  beforeEach(() => {
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
  });

  test('new conversation: exact argv, stdin message with base64 images, streamed text', async () => {
    process.env.CLAUDECODE = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    const out = await run(claudeCodeProvider, { model: 'sonnet' });
    assert.ifError(out.error);

    const rec = record();
    const sessionId = rec.argv[rec.argv.length - 1];
    assert.match(sessionId, UUID_RE);
    assert.deepEqual(rec.argv, [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--system-prompt',
      'SYSTEM PROMPT',
      '--tools',
      'Read,Glob,Grep',
      '--strict-mcp-config',
      '--model',
      'sonnet',
      '--session-id',
      sessionId,
    ]);
    assert.equal(rec.env?.CLAUDECODE, null, 'CLAUDECODE is removed from the child env');
    assert.equal(rec.env?.ANTHROPIC_API_KEY, null, 'the subscription is used, not an API key');

    assert.ok(rec.stdin.endsWith('\n'));
    const lines = rec.stdin.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Overview image: slides 1–4' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(sheetPng).toString('base64') } },
          { type: 'text', text: 'Full-resolution image of slide 3:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
          { type: 'text', text: "Student's question (about slide 3):\n이게 뭐야?" },
        ],
      },
    });

    assert.deepEqual(out.deltas, ['안녕 ', '세계', '\n\n두 번째 블록']);
    assert.equal(out.result?.text, '안녕 세계\n\n두 번째 블록');
    assert.equal(out.result?.text, out.deltas.join(''));
    assert.doesNotMatch(out.result!.text, /SECRET/, 'thinking is not forwarded');
    assert.deepEqual(out.statuses, ['생각하는 중…', '파일 읽는 중: slides/012.png']);
    assert.deepEqual(out.result?.resume, { cliSessionId: sessionId });
  });

  test('resume: --resume <id>, no --model when the model is empty, reported session id wins', async () => {
    const out = await run(claudeCodeProvider, { resume: { cliSessionId: 'sess-123' } });
    assert.ifError(out.error);
    const rec = record();
    assert.deepEqual(rec.argv.slice(-2), ['--resume', 'sess-123']);
    assert.ok(!rec.argv.includes('--model'));
    assert.ok(!rec.argv.includes('--session-id'));
    assert.deepEqual(out.result?.resume, { cliSessionId: 'sess-123-next' });
  });

  test('falls back to result.result when no deltas were streamed', async () => {
    process.env.FAKE_CLI_MODE = 'no-deltas';
    const out = await run(claudeCodeProvider);
    assert.ifError(out.error);
    assert.equal(out.result?.text, '최종 답변');
    assert.deepEqual(out.deltas, ['최종 답변']);
  });

  test('is_error result rejects with the CLI message', async () => {
    process.env.FAKE_CLI_MODE = 'is_error';
    const out = await run(claudeCodeProvider);
    assert.ok(out.error);
    assert.match(out.error.message, /Invalid API key/);
    assert.match(out.error.message, /로그인/);
  });

  test('non-zero exit rejects with the stderr tail', async () => {
    process.env.FAKE_CLI_MODE = 'exit1';
    const out = await run(claudeCodeProvider);
    assert.ok(out.error);
    assert.match(out.error.message, /exit code 1/);
    assert.match(out.error.message, /fatal: something went badly wrong/);
  });

  test('abort kills the child and rejects with AbortError', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const out = await run(claudeCodeProvider, {}, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
    assert.deepEqual(out.deltas, ['부분 답변']);
    assertDead(record().pid);
  });

  test('abort escalates to SIGKILL when SIGTERM is ignored', async () => {
    process.env.FAKE_CLI_MODE = 'hang-ignore-term';
    const started = Date.now();
    const out = await run(claudeCodeProvider, {}, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
    assert.ok(Date.now() - started >= 2_900, 'waited for the grace period');
    assertDead(record().pid);
  });

  test('detect reports the version, or unavailability', async () => {
    assert.deepEqual(await claudeCodeProvider.detect(), { available: true, version: '9.9.9 (Claude Code fake)' });
    process.env.CLAUDE_BIN = path.join(workDir, 'missing-claude');
    const missing = await claudeCodeProvider.detect();
    assert.equal(missing.available, false);
    assert.match(missing.reason ?? '', /찾을 수 없습니다/);
  });

  test('claudeArgs generates a session id when none is given', () => {
    const args = claudeArgs({ systemPrompt: 's', model: '' });
    assert.equal(args[args.length - 2], '--session-id');
    assert.match(args[args.length - 1], UUID_RE);
  });

  test('ephemeral: --no-session-persistence without --session-id; the reported session id is returned', async () => {
    const out = await run(claudeCodeProvider, { ephemeral: true, model: 'haiku' });
    assert.ifError(out.error);
    const rec = record();
    assert.deepEqual(rec.argv.slice(-3), ['--model', 'haiku', '--no-session-persistence']);
    assert.ok(!rec.argv.includes('--session-id'));
    assert.ok(!rec.argv.includes('--resume'));
    assert.deepEqual(out.result?.resume, { cliSessionId: 'fake-ephemeral-session' });
    assert.equal(out.result?.text, '안녕 세계\n\n두 번째 블록');
  });

  test('ephemeral without a reported session id resolves with an empty resume handle', async () => {
    process.env.FAKE_CLI_MODE = 'no-session-id';
    const out = await run(claudeCodeProvider, { ephemeral: true });
    assert.ifError(out.error);
    assert.deepEqual(out.result?.resume, {});
  });

  test('extraReadDirs: one --add-dir per existing directory (deduplicated), before the session flags', async () => {
    const other = path.join(workDir, 'lectures', 'l6-parsing-2');
    const third = path.join(workDir, 'lectures', 'l8-bottom-up');
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(third, { recursive: true });
    const out = await run(claudeCodeProvider, {
      extraReadDirs: [other, '', path.join(workDir, 'lectures', 'deleted'), third, other],
      resume: { cliSessionId: 'sess-9' },
      model: 'opus',
    });
    assert.ifError(out.error);
    const argv = record().argv;
    const at = argv.indexOf('--strict-mcp-config');
    assert.deepEqual(argv.slice(at + 1), ['--add-dir', other, '--add-dir', third, '--model', 'opus', '--resume', 'sess-9']);
  });

  test('claudeArgs: ephemeral + resume keeps --resume; no extra dirs means no --add-dir', () => {
    const args = claudeArgs({ systemPrompt: 's', model: '', resumeId: 'r1', ephemeral: true, addDirs: [] });
    assert.deepEqual(args.slice(-3), ['--no-session-persistence', '--resume', 'r1']);
    assert.ok(!args.includes('--add-dir'));
    assert.ok(!args.includes('--session-id'));
  });

  test('tool status shows paths relative to the doc dir, including other lectures', () => {
    const cwd = '/library/l7-parsing-abc123';
    assert.equal(toolStatus('Read', { file_path: `${cwd}/slides/012.png` }, cwd), '파일 읽는 중: slides/012.png');
    assert.equal(
      toolStatus('Read', { file_path: '/library/l6-parsing-def456/DIGEST.md' }, cwd),
      '파일 읽는 중: ../l6-parsing-def456/DIGEST.md',
    );
    assert.equal(toolStatus('Read', { file_path: '/etc/hosts' }, cwd), '파일 읽는 중: /etc/hosts');
  });
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

describe('codex provider', () => {
  beforeEach(() => {
    process.env.CODEX_BIN = FAKE_CODEX;
  });

  test('new conversation: exact argv, instructions + image markers on stdin', async () => {
    const out = await run(codexProvider, { model: 'gpt-5-codex' });
    assert.ifError(out.error);
    const rec = record();
    assert.deepEqual(rec.argv, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      workDir,
      '-m',
      'gpt-5-codex',
      '-i',
      sheetPng,
      '-i',
      slidePng,
    ]);
    assert.ok(rec.stdin.startsWith('<instructions>\nSYSTEM PROMPT\n</instructions>\n\n'));
    const first = rec.stdin.indexOf('[Attached image #1: Slides 1–4 overview]');
    const second = rec.stdin.indexOf('[Attached image #2: Slide 3]');
    assert.ok(first > rec.stdin.indexOf('Overview image: slides 1–4'));
    assert.ok(second > first && second > rec.stdin.indexOf('Full-resolution image of slide 3:'));
    assert.ok(rec.stdin.trimEnd().endsWith('이게 뭐야?'));

    // Only the last agent message is the answer; earlier ones become status lines.
    assert.deepEqual(out.deltas, ['최종 답변입니다.']);
    assert.equal(out.result?.text, '최종 답변입니다.');
    assert.deepEqual(out.result?.resume, { cliSessionId: 'thread-new-1' });
    assert.deepEqual(out.statuses, [
      '생각하는 중…',
      '요청한 파일을 확인할게요.',
      "명령 실행 중: bash -lc 'ls slides'",
      '중간 메시지',
    ]);
  });

  test("resume: 'exec resume <id> -', sandbox via -c, no -C, no -m, no instructions", async () => {
    const out = await run(codexProvider, {
      resume: { cliSessionId: 'thread-42' },
      parts: [
        { type: 'text', text: 'Full-resolution image of slide 3:' },
        { type: 'image', path: slidePng, detail: 'high', label: 'Slide 3' },
        { type: 'text', text: 'Q' },
      ],
    });
    assert.ifError(out.error);
    const rec = record();
    assert.deepEqual(rec.argv, [
      'exec',
      'resume',
      'thread-42',
      '-',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="read-only"',
      '-i',
      slidePng,
    ]);
    assert.doesNotMatch(rec.stdin, /<instructions>/);
    assert.match(rec.stdin, /\[Attached image #1: Slide 3\]/);
    assert.deepEqual(out.result?.resume, { cliSessionId: 'thread-42' });
  });

  test('turn.failed rejects', async () => {
    process.env.FAKE_CLI_MODE = 'turn-failed';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /stream disconnected before completion/);
  });

  test('an error event without a completed turn rejects', async () => {
    process.env.FAKE_CLI_MODE = 'error';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /401 Unauthorized/);
    assert.match(out.error?.message ?? '', /codex login/);
  });

  test('an error event followed by a completed turn is not fatal', async () => {
    process.env.FAKE_CLI_MODE = 'error-recovered';
    const out = await run(codexProvider);
    assert.ifError(out.error);
    assert.equal(out.result?.text, '최종 답변입니다.');
  });

  test('a stream that ends without turn.completed still delivers the last message', async () => {
    process.env.FAKE_CLI_MODE = 'no-turn-completed';
    const out = await run(codexProvider);
    assert.ifError(out.error);
    assert.deepEqual(out.deltas, ['끝 이벤트 없는 답변']);
    assert.equal(out.result?.text, '끝 이벤트 없는 답변');
  });

  test('non-zero exit rejects with the stderr tail', async () => {
    process.env.FAKE_CLI_MODE = 'exit1';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /fatal config error/);
  });

  test('a new conversation without a thread id is an error', async () => {
    process.env.FAKE_CLI_MODE = 'no-thread';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /thread id/);
  });

  test('abort kills the child and rejects with AbortError', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const out = await run(codexProvider, {}, undefined, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
    assert.deepEqual(out.deltas, [], 'an unconfirmed message is never streamed as the answer');
    assert.equal(out.statuses[0], '부분');
    assertDead(record().pid);
  });

  test('ephemeral: --ephemeral on a new conversation; extraReadDirs adds no flags', async () => {
    const out = await run(codexProvider, { ephemeral: true, extraReadDirs: ['/library/other-lecture'] });
    assert.ifError(out.error);
    assert.deepEqual(record().argv, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '-C',
      workDir,
      '-i',
      sheetPng,
      '-i',
      slidePng,
    ]);
    assert.deepEqual(out.result?.resume, { cliSessionId: 'thread-new-1' });
  });

  test('ephemeral runs do not need a thread id', async () => {
    process.env.FAKE_CLI_MODE = 'no-thread';
    const out = await run(codexProvider, { ephemeral: true });
    assert.ifError(out.error);
    assert.deepEqual(out.result?.resume, {});
    assert.equal(out.result?.text, '최종 답변입니다.');
  });

  test('CodexStreamState: a lone message is the answer; a preamble is shown once as status', () => {
    const deltas: string[] = [];
    const statuses: string[] = [];
    const state = new CodexStreamState((t) => deltas.push(t), (t) => statuses.push(t));
    state.handle({ type: 'item.completed', item: { type: 'agent_message', text: "I'll check the requested file." } });
    state.handle({ type: 'item.started', item: { type: 'command_execution', command: 'cat ../l6/DIGEST.md' } });
    state.handle({ type: 'item.started', item: { type: 'reasoning' } });
    assert.deepEqual(deltas, []);
    assert.deepEqual(statuses, ["I'll check the requested file.", '명령 실행 중: cat ../l6/DIGEST.md', '생각하는 중…']);
    // No later message: the preamble turns out to be the answer after all.
    state.handle({ type: 'turn.completed' });
    assert.deepEqual(deltas, ["I'll check the requested file."]);
    assert.equal(state.text, "I'll check the requested file.");

    const long = new CodexStreamState(() => {}, (t) => statuses.push(t));
    long.handle({ type: 'item.completed', item: { type: 'agent_message', text: `${'가'.repeat(300)}\n둘째 줄` } });
    long.handle({ type: 'item.completed', item: { type: 'agent_message', text: '답' } });
    assert.equal(statuses[statuses.length - 1], `${'가'.repeat(200)}…`);
  });

  test('codexArgs / codexPrompt helpers', () => {
    assert.deepEqual(codexArgs({ cwd: '/d', model: '', images: [] }), [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      '/d',
    ]);
    assert.ok(
      !codexArgs({ cwd: '/d', model: '', images: [], threadId: 't', ephemeral: true }).includes('--ephemeral'),
      '--ephemeral is only passed when starting a conversation',
    );
    const { prompt, images } = codexPrompt([{ type: 'text', text: 'only text' }], null);
    assert.equal(prompt, 'only text');
    assert.deepEqual(images, []);
  });

  test('detect reports the version', async () => {
    assert.deepEqual(await codexProvider.detect(), { available: true, version: 'codex-cli 9.9.9' });
  });
});

// ---------------------------------------------------------------------------
// Mock HTTP server for the API providers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

type MockHandler = (req: CapturedRequest, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl = '';
let handler: MockHandler = (_req, res) => res.writeHead(500).end();
const requests: CapturedRequest[] = [];
const openSockets = new Set<import('node:net').Socket>();

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  server.on('connection', (s) => {
    openSockets.add(s);
    s.on('close', () => openSockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of openSockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

function sse(res: http.ServerResponse, events: Array<[string, unknown]>, keepOpen = false): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (!keepOpen) res.end();
}

// ---------------------------------------------------------------------------
// anthropic-api
// ---------------------------------------------------------------------------

function anthropicEvents(stopReason = 'end_turn', text = ['안녕', '하세요']): Array<[string, unknown]> {
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ...text.map((t): [string, unknown] => [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } },
    ]),
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopReason === 'refusal' ? { type: 'refusal', category: 'cyber', explanation: null } : null },
        usage: { output_tokens: 5 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
}

describe('anthropic-api provider', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = baseUrl;
  });

  test('streams a turn: request shape (history, base64 images, cache breakpoints, fallbacks)', async () => {
    handler = (_req, res) => sse(res, anthropicEvents());
    const history: ProviderRunInput['history'] = [
      { role: 'user', parts: [{ type: 'text', text: 'deck' }, { type: 'image', path: sheetPng, detail: 'low', label: 'Slides 1–4 overview' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '개요' }] },
    ];
    const out = await run(anthropicApiProvider, { history, resume: {} });
    assert.ifError(out.error);

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.method, 'POST');
    assert.match(req.url, /^\/v1\/messages/);
    assert.equal(req.headers['x-api-key'], 'test-key');
    assert.match(String(req.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);

    const body = req.body;
    assert.equal(body.model, 'claude-opus-5');
    assert.equal(body.stream, true);
    assert.equal(body.system, 'SYSTEM PROMPT');
    assert.equal(body.max_tokens, 64000);
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.betas, undefined, 'betas travel as a header, not in the body');
    assert.deepEqual(
      body.messages.map((m: any) => m.role),
      ['user', 'assistant', 'user'],
    );
    const [first, second, current] = body.messages;
    assert.deepEqual(first.content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(sheetPng).toString('base64') },
      cache_control: { type: 'ephemeral' },
    });
    assert.equal(first.content[0].cache_control, undefined);
    assert.deepEqual(second.content, [{ type: 'text', text: '개요' }]);
    assert.equal(current.content.length, 5);
    assert.deepEqual(current.content[3].source.data, PNG.toString('base64'));
    assert.deepEqual(current.content[4], {
      type: 'text',
      text: "Student's question (about slide 3):\n이게 뭐야?",
      cache_control: { type: 'ephemeral' },
    });
    assert.equal(
      body.messages.flatMap((m: any) => m.content).filter((b: any) => b.cache_control).length,
      2,
      'exactly two cache breakpoints',
    );

    assert.deepEqual(out.deltas, ['안녕', '하세요']);
    assert.equal(out.result?.text, '안녕하세요');
    assert.deepEqual(out.result?.resume, {});
    assert.deepEqual(out.statuses, ['생각하는 중…']);
  });

  test('first turn has a single breakpoint; non-Opus models get no fallbacks', async () => {
    const params = await buildAnthropicRequest({ systemPrompt: 's', parts: parts(), history: [], model: 'claude-haiku-4-5' });
    assert.equal(params.messages.length, 1);
    const content = params.messages[0].content as any[];
    assert.deepEqual(content.map((b) => Boolean(b.cache_control)), [false, false, false, false, true]);
    assert.equal(params.fallbacks, undefined);
    assert.equal(params.betas, undefined);
  });

  test('a refusal rejects', async () => {
    handler = (_req, res) => sse(res, anthropicEvents('refusal', ['부분']));
    const out = await run(anthropicApiProvider);
    assert.match(out.error?.message ?? '', /거절/);
  });

  test('HTTP errors become readable errors', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    };
    const out = await run(anthropicApiProvider);
    assert.match(out.error?.message ?? '', /ANTHROPIC_API_KEY/);
    assert.notEqual(out.error?.name, 'AbortError');
  });

  test('abort rejects with AbortError', async () => {
    handler = (_req, res) => sse(res, anthropicEvents().slice(0, 5), true);
    const out = await run(anthropicApiProvider, {}, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
  });

  test('unavailable without an API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const detected = await anthropicApiProvider.detect();
    assert.equal(detected.available, false);
    assert.match(detected.reason ?? '', /ANTHROPIC_API_KEY/);
    const out = await run(anthropicApiProvider);
    assert.match(out.error?.message ?? '', /ANTHROPIC_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// openai-api
// ---------------------------------------------------------------------------

function openaiEvents(id = 'resp_2'): Array<[string, unknown]> {
  const response = { id, object: 'response', status: 'in_progress', output: [] };
  return [
    ['response.created', { type: 'response.created', sequence_number: 0, response }],
    [
      'response.output_item.added',
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    ],
    [
      'response.output_text.delta',
      { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hel', logprobs: [] },
    ],
    [
      'response.output_text.delta',
      { type: 'response.output_text.delta', sequence_number: 3, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'lo', logprobs: [] },
    ],
    ['response.completed', { type: 'response.completed', sequence_number: 4, response: { ...response, status: 'completed' } }],
  ];
}

describe('openai-api provider', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `${baseUrl}/v1`;
  });

  test('streams a turn: request shape and previous_response_id continuation', async () => {
    handler = (_req, res) => sse(res, openaiEvents());
    const out = await run(openaiApiProvider, { resume: { previousResponseId: 'resp_1' } });
    assert.ifError(out.error);

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    const body = req.body;
    assert.equal(body.model, 'gpt-5');
    assert.equal(body.instructions, 'SYSTEM PROMPT');
    assert.equal(body.previous_response_id, 'resp_1');
    assert.equal(body.store, true);
    assert.equal(body.stream, true);
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, 'user');
    assert.deepEqual(body.input[0].content[0], { type: 'input_text', text: 'Overview image: slides 1–4' });
    assert.deepEqual(body.input[0].content[1], {
      type: 'input_image',
      image_url: `data:image/png;base64,${fs.readFileSync(sheetPng).toString('base64')}`,
      detail: 'low',
    });
    assert.equal(body.input[0].content[3].detail, 'high');

    assert.deepEqual(out.deltas, ['Hel', 'lo']);
    assert.equal(out.result?.text, 'Hello');
    assert.deepEqual(out.result?.resume, { previousResponseId: 'resp_2' });
    assert.deepEqual(out.statuses, ['생각하는 중…']);
  });

  test('a new conversation has no previous_response_id; OPENAI_MODEL sets the default model', async () => {
    process.env.OPENAI_MODEL = 'gpt-test';
    const params = await buildOpenAIRequest({ systemPrompt: 's', parts: parts(), resume: null, model: '' });
    assert.equal(params.previous_response_id, undefined);
    assert.equal(params.model, 'gpt-test');
    assert.equal(params.store, true);
    assert.equal(openaiApiProvider.defaultModel, 'gpt-test');
  });

  test('ephemeral runs are not stored; extraReadDirs is ignored', async () => {
    handler = (_req, res) => sse(res, openaiEvents('resp_9'));
    const out = await run(openaiApiProvider, { ephemeral: true, extraReadDirs: ['/library/other'] });
    assert.ifError(out.error);
    assert.equal(requests[0].body.store, false);
    assert.equal(JSON.stringify(requests[0].body).includes('/library/other'), false);
    assert.deepEqual(out.result?.resume, { previousResponseId: 'resp_9' });
  });

  test('response.failed rejects', async () => {
    handler = (_req, res) =>
      sse(res, [
        openaiEvents()[0],
        ['response.failed', { type: 'response.failed', sequence_number: 1, response: { id: 'resp_2', status: 'failed', error: { code: 'server_error', message: 'model exploded' } } }],
      ]);
    const out = await run(openaiApiProvider);
    assert.match(out.error?.message ?? '', /model exploded/);
  });

  test('an error event rejects', async () => {
    handler = (_req, res) => sse(res, [openaiEvents()[0], ['error', { type: 'error', sequence_number: 1, code: 'boom', message: 'stream broke', param: null }]]);
    const out = await run(openaiApiProvider);
    assert.match(out.error?.message ?? '', /stream broke/);
  });

  test('abort rejects with AbortError', async () => {
    handler = (_req, res) => sse(res, openaiEvents().slice(0, 3), true);
    const out = await run(openaiApiProvider, {}, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('provider registry', () => {
  test('lists the four providers and their availability (never throws)', async () => {
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.CODEX_BIN = path.join(workDir, 'no-codex-here');
    process.env.OPENAI_API_KEY = 'k';
    clearProviderInfoCache();

    assert.deepEqual(listProviders().map((p) => p.id), ['claude-code', 'codex', 'anthropic-api', 'openai-api']);
    assert.equal(getProvider('codex'), codexProvider);
    assert.equal(getProvider('nope' as any), undefined);

    const infos = await providerInfos();
    const byId = Object.fromEntries(infos.map((i) => [i.id, i]));
    assert.equal(byId['claude-code'].available, true);
    assert.equal(byId['claude-code'].version, '9.9.9 (Claude Code fake)');
    assert.equal(byId['claude-code'].kind, 'cli');
    assert.equal(byId['codex'].available, false);
    assert.match(byId['codex'].reason ?? '', /codex/);
    assert.equal(byId['anthropic-api'].available, false);
    assert.equal(byId['openai-api'].available, true);
    assert.equal(byId['anthropic-api'].defaultModel, 'claude-opus-5');
    assert.ok(byId['claude-code'].models.some((m) => m.id === 'sonnet'));

    // Cached: a changed environment is not re-detected within the TTL.
    delete process.env.OPENAI_API_KEY;
    const again = await providerInfos();
    assert.equal(again.find((i) => i.id === 'openai-api')?.available, true);
    clearProviderInfoCache();
    const fresh = await providerInfos();
    assert.equal(fresh.find((i) => i.id === 'openai-api')?.available, false);
    clearProviderInfoCache();
  });
});
