#!/usr/bin/env node
// Fake `codex` CLI for tests (pointed to by CODEX_BIN). It never talks to any service.
//
// - `--version` prints a version line.
// - Otherwise it reads stdin until EOF, records { argv, stdin, cwd, pid } as JSON to the file named
//   by $FAKE_CLI_RECORD, then behaves according to $FAKE_CLI_MODE:
//     success (default) | turn-failed | error | error-recovered | exit1 | no-thread | hang
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 9.9.9\n');
  process.exit(0);
}

const mode = process.env.FAKE_CLI_MODE || 'success';
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', main);

function main() {
  if (process.env.FAKE_CLI_RECORD) {
    fs.writeFileSync(
      process.env.FAKE_CLI_RECORD,
      JSON.stringify({ argv, stdin, cwd: process.cwd(), pid: process.pid }),
    );
  }

  const resuming = argv[0] === 'exec' && argv[1] === 'resume';
  const threadId = resuming ? argv[2] : 'thread-new-1';

  if (mode !== 'no-thread') emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  process.stdout.write('WARN not json\n');

  if (mode === 'turn-failed') {
    emit({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
    process.exitCode = 1;
    return;
  }
  if (mode === 'error') {
    emit({ type: 'error', message: 'unexpected status 401 Unauthorized' });
    process.exitCode = 1;
    return;
  }
  if (mode === 'exit1') {
    process.stderr.write('codex: fatal config error\n');
    process.exitCode = 1;
    return;
  }
  if (mode === 'hang') {
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '부분' } });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'error-recovered') {
    emit({ type: 'error', message: 'Reconnecting... 1/5' });
  }

  emit({ type: 'item.started', item: { id: 'item_0', type: 'reasoning', text: '' } });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reading the slide**' } });
  emit({
    type: 'item.started',
    item: { id: 'item_1', type: 'command_execution', command: "bash -lc 'ls slides'", status: 'in_progress' },
  });
  emit({
    type: 'item.completed',
    item: { id: 'item_1', type: 'command_execution', command: "bash -lc 'ls slides'", exit_code: 0, status: 'completed' },
  });
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '첫 번째 메시지' } });
  emit({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '두 번째 메시지' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
}
