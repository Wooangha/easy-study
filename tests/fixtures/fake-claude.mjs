#!/usr/bin/env node
// Fake `claude` CLI for tests (pointed to by CLAUDE_BIN). It never talks to any service.
//
// - `--version` prints a version line.
// - Otherwise it reads stdin until EOF, records { argv, stdin, cwd, pid, env } as JSON to the file
//   named by $FAKE_CLI_RECORD, then behaves according to $FAKE_CLI_MODE:
//     success (default) | no-deltas | is_error | exit1 | hang | hang-ignore-term
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code fake)\n');
  process.exit(0);
}

const mode = process.env.FAKE_CLI_MODE || 'success';
if (mode === 'hang-ignore-term') process.on('SIGTERM', () => {});

const valueAfter = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  main().catch((err) => {
    process.stderr.write(String(err?.stack || err));
    process.exitCode = 2;
    return;
  });
});

async function main() {
  if (process.env.FAKE_CLI_RECORD) {
    fs.writeFileSync(
      process.env.FAKE_CLI_RECORD,
      JSON.stringify({
        argv,
        stdin,
        cwd: process.cwd(),
        pid: process.pid,
        env: {
          CLAUDECODE: process.env.CLAUDECODE ?? null,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
        },
      }),
    );
  }

  const resumeId = valueAfter('--resume');
  const sessionId = valueAfter('--session-id');
  // On resume the real CLI may report a different session id; the adapter must use the reported one.
  const reportedId = resumeId ? `${resumeId}-next` : sessionId;
  const cwd = process.cwd();

  emit({ type: 'system', subtype: 'init', session_id: reportedId, tools: ['Read', 'Glob', 'Grep'] });
  process.stdout.write('this line is not JSON and must be ignored\n');

  if (mode === 'exit1') {
    process.stderr.write('fatal: something went badly wrong\n');
    process.exitCode = 1;
    return;
  }

  if (mode === 'is_error') {
    emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Invalid API key · Please run /login',
      session_id: reportedId,
    });
    process.exitCode = 1;
    return;
  }

  if (mode === 'no-deltas') {
    emit({ type: 'result', subtype: 'success', is_error: false, result: '최종 답변', session_id: reportedId });
    return;
  }

  emit({ type: 'stream_event', event: { type: 'message_start', message: {} } });

  if (mode === 'hang' || mode === 'hang-ignore-term') {
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '부분 답변' } } });
    setInterval(() => {}, 1000); // never finishes on its own
    return;
  }

  // --- success ---
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET THOUGHTS' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });

  // One JSON line split across two writes: the adapter must buffer partial lines.
  const split = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '안녕 ' } },
  });
  process.stdout.write(split.slice(0, 25));
  await sleep(30);
  process.stdout.write(`${split.slice(25)}\n`);

  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '세계' } } });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: '안녕 세계' }] } });

  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${cwd}/slides/012.png` } };
  emit({ type: 'assistant', message: { content: [toolUse] } });
  emit({ type: 'assistant', message: { content: [toolUse] } }); // duplicate snapshot: one status only
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });

  emit({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '두 번째 블록' } } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: '두 번째 블록', session_id: reportedId });
}
