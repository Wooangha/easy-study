#!/usr/bin/env node
// Fake `codex` CLI for tests (pointed to by CODEX_BIN). It never talks to any service.
//
// - `--version` prints a version line.
// - Otherwise it reads stdin until EOF, records { argv, stdin, cwd, pid, script, env } as JSON to the file
//   named by $FAKE_CLI_RECORD (script = the path it was executed by, symlinks not resolved), then
//   behaves according to $FAKE_CLI_MODE:
//     success (default) | turn-failed | error | error-recovered | exit1 | no-thread | hang | no-turn-completed
//     | resume-new-thread (a resume that silently starts a new thread, like a CLI that lost the rollout)
//     | resume-missing (a resume that fails: "thread not found") | context-overflow | model-unsupported
//     | sandbox-init-failed (the session cannot start under the permissions profile, as codex-cli 0.154
//       reports it when an AGENTS.md on the way to the project root is unreadable)
// Like the real CLI, success sends a preamble agent message before running a command, then more
// agent messages; only the last one is the answer.
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
      JSON.stringify({
        argv,
        stdin,
        cwd: process.cwd(),
        pid: process.pid,
        script: process.argv[1],
        // The server's secrets must never reach a CLI (server/config.ts SERVER_SECRET_ENV).
        env: {
          EASY_STUDY_PASSWORD: process.env.EASY_STUDY_PASSWORD ?? null,
          EASY_STUDY_TLS_KEY: process.env.EASY_STUDY_TLS_KEY ?? null,
          EASY_STUDY_TLS_CERT: process.env.EASY_STUDY_TLS_CERT ?? null,
        },
      }),
    );
  }

  const resuming = argv[0] === 'exec' && argv[1] === 'resume';
  const threadId = resuming && mode !== 'resume-new-thread' ? argv[2] : 'thread-new-1';

  if (mode === 'resume-missing') {
    process.stderr.write(`Error: thread not found: ${argv[2]}\n`);
    process.exitCode = 1;
    return;
  }

  if (mode === 'sandbox-init-failed') {
    process.stderr.write(
      'Error: Fatal error: Failed to initialize session: failed to load AGENTS.md instructions for environment `local`: Operation not permitted (os error 1)\n',
    );
    process.exitCode = 1;
    return;
  }

  if (mode !== 'no-thread') emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  process.stdout.write('WARN not json\n');

  if (mode === 'context-overflow') {
    emit({
      type: 'turn.failed',
      error: {
        message:
          "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      },
    });
    process.exitCode = 1;
    return;
  }
  if (mode === 'model-unsupported') {
    emit({ type: 'error', message: "The 'gpt-nope' model is not supported when using Codex with a ChatGPT account." });
    process.exitCode = 1;
    return;
  }
  if (mode === 'resume-new-thread') {
    // Would answer without the deck: the adapter must stop at thread.started.
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '덱을 모르는 답변' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    return;
  }
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
    emit({ type: 'item.started', item: { id: 'item_1', type: 'reasoning', text: '' } });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'no-turn-completed') {
    // Older CLIs: the stream ends after the message without a turn.completed event.
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '끝 이벤트 없는 답변' } });
    return;
  }
  if (mode === 'error-recovered') {
    emit({ type: 'error', message: 'Reconnecting... 1/5' });
  }

  emit({ type: 'item.started', item: { id: 'item_0', type: 'reasoning', text: '' } });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reading the slide**' } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '요청한 파일을 확인할게요.' } });
  emit({
    type: 'item.started',
    item: { id: 'item_2', type: 'command_execution', command: "bash -lc 'ls slides'", status: 'in_progress' },
  });
  emit({
    type: 'item.completed',
    item: { id: 'item_2', type: 'command_execution', command: "bash -lc 'ls slides'", exit_code: 0, status: 'completed' },
  });
  emit({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '중간 메시지' } });
  emit({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: '최종 답변입니다.' } });
  // A trailing non-message item must not demote the final answer.
  emit({ type: 'item.completed', item: { id: 'item_5', type: 'todo_list', items: [] } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
}
