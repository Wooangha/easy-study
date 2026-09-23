#!/usr/bin/env node
// Fake `claude` CLI for tests (pointed to by CLAUDE_BIN). It never talks to any service.
//
// - `--version` prints a version line.
// - Otherwise it reads stdin until EOF, records { argv, stdin, cwd, pid, env } as JSON to the file
//   named by $FAKE_CLI_RECORD, then behaves according to $FAKE_CLI_MODE:
//     success (default) | no-deltas | is_error | exit1 | hang | hang-ignore-term | no-session-id
//     | resume-missing (a --resume of an unknown session, as the real CLI reports it: an is_error result)
//     | resume-missing-stderr (the same, on stderr only) | prompt-too-long | request-too-large
//     | model-unavailable | model-needs-update
// Like the real CLI, a run without --session-id / --resume (e.g. --no-session-persistence) still
// reports a session id of its own (except in mode no-session-id).
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
  const reportedId =
    mode === 'no-session-id' ? undefined : resumeId ? `${resumeId}-next` : (sessionId ?? 'fake-ephemeral-session');
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

  const errorResults = {
    'resume-missing': `No conversation found with session ID: ${resumeId ?? '(none)'}`,
    'prompt-too-long': 'Prompt is too long',
    'request-too-large':
      'Request too large (max 32 MB). Accumulated images and attachments in the conversation pushed the request over the limit.',
    'model-unavailable':
      "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it. Run /model to pick a different model.",
    'model-needs-update': "API Error: 400 This version of Claude Code does not support this model. Run 'claude update' to update.",
  };
  if (mode in errorResults) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: errorResults[mode], session_id: reportedId });
    process.exitCode = 1;
    return;
  }
  if (mode === 'resume-missing-stderr') {
    process.stderr.write(`No conversation found with session ID: ${resumeId ?? '(none)'}\n`);
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
