#!/usr/bin/env node
// Fake `codex` CLI for tests (pointed to by CODEX_BIN). It never talks to any service.
//
// - `--version` prints a version line.
// - `debug models [--bundled]` prints a small model catalog (the live one, or with --bundled the "bundled" one) and
//   appends its argv as a JSON line to $FAKE_CODEX_CATALOG_LOG, if set. $FAKE_CODEX_CATALOG:
//     live (default) | live-fails (the live read exits 1; --bundled works) | live-hangs (the live read never ends)
//     | unsupported (both fail like a CLI without `debug models`) | garbage (both print something that is not JSON)
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
//
// Token usage (DESIGN §23): turn.completed carries it in the shape of codex-cli 0.154 — the turn's usage on a new
// thread, the thread's running total on a resumed one (as `codex exec` may report it). With $FAKE_CODEX_ROLLOUT=1 and
// $CODEX_HOME set (never the real ~/.codex), a non-ephemeral run gets a UUIDv7 thread id and writes the thread's
// rollout like the real CLI: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl, a resumed turn
// appended, each turn ending with token_usage_record (turn and thread usage), token_count with the plan's
// rate_limits (5 hours 12 %, a week 9 %; $FAKE_CODEX_RATE_LIMITS = JSON replaces them) followed by one of a model
// bucket, and task_complete.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 9.9.9\n');
  process.exit(0);
}

function level(effort) {
  return { effort, description: `${effort} reasoning` };
}

function debugModels(bundled) {
  if (process.env.FAKE_CODEX_CATALOG_LOG) fs.appendFileSync(process.env.FAKE_CODEX_CATALOG_LOG, `${JSON.stringify(argv)}\n`);
  const mode = process.env.FAKE_CODEX_CATALOG || 'live';
  if (mode === 'unsupported') {
    process.stderr.write("error: unrecognized subcommand 'models'\n");
    process.exit(2);
  }
  if (mode === 'garbage') {
    process.stdout.write('not a catalog\n');
    process.exit(0);
  }
  if (!bundled && mode === 'live-fails') {
    process.stderr.write('Error: failed to refresh the model catalog\n');
    process.exit(1);
  }
  if (!bundled && mode === 'live-hangs') {
    setInterval(() => {}, 1000);
    return;
  }
  const models = bundled
    ? [{ slug: 'gpt-fake-bundled', display_name: 'GPT-Fake-Bundled', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'high'].map(level) }]
    : [
        // Listed after gpt-fake-small (priority), described, with every level.
        {
          slug: 'gpt-fake-big',
          display_name: 'GPT-Fake-Big',
          description: 'Big fake model.',
          visibility: 'list',
          priority: 5,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level),
          base_instructions: 'x'.repeat(200_000),
        },
        { slug: 'gpt-fake-hidden', display_name: 'GPT-Fake-Hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: [level('minimal')] },
        { slug: 'gpt-fake-small', display_name: 'GPT-Fake-Small', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high'].map(level) },
        // Not usable as a model name: skipped.
        { slug: '--evil', display_name: 'Evil', visibility: 'list', priority: 1, supported_reasoning_levels: [] },
      ];
  process.stdout.write(`${JSON.stringify({ models }, null, 2)}\n`);
}

const mode = process.env.FAKE_CLI_MODE || 'success';
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

/** Usage of one successful turn (codex-cli 0.154 field names). */
const TURN_USAGE = { input_tokens: 8595, cached_input_tokens: 3072, cache_write_input_tokens: 0, output_tokens: 520, reasoning_output_tokens: 128 };
const USAGE_KEYS = Object.keys(TURN_USAGE);

const pad2 = (n) => String(n).padStart(2, '0');

function uuidV7(ms) {
  const time = ms.toString(16).padStart(12, '0');
  const rand = crypto.randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${rand.slice(0, 3)}-${'89ab'[Number.parseInt(rand[3], 16) & 3]}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

/** Where the real CLI keeps a thread's rollout (named after its creation in local time), or null for other ids. */
function rolloutPath(threadId) {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7/.exec(threadId);
  if (!m) return null;
  const d = new Date(Number.parseInt(m[1] + m[2], 16));
  const day = [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())];
  const time = `${day.join('-')}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  return path.join(process.env.CODEX_HOME, 'sessions', ...day.map(String), `rollout-${time}-${threadId}.jsonl`);
}

/** The thread's usage so far (its last token_usage_record), zeros when there is none. */
function threadUsage(file) {
  let last = null;
  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.includes('"token_usage_record"')) last = JSON.parse(line).payload.thread_token_usage;
    }
  }
  return last ?? Object.fromEntries([...USAGE_KEYS, 'total_tokens'].map((key) => [key, 0]));
}

function addUsage(a, b) {
  const sum = Object.fromEntries(USAGE_KEYS.map((key) => [key, (a[key] ?? 0) + (b[key] ?? 0)]));
  return { ...sum, total_tokens: sum.input_tokens + sum.output_tokens };
}

/** Appends one turn's closing entries to the thread's rollout (see the top of the file). */
function writeRolloutTurn(file, threadId, answer, fresh) {
  const now = Math.floor(Date.now() / 1000);
  const line = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
  const turn = { ...TURN_USAGE, total_tokens: TURN_USAGE.input_tokens + TURN_USAGE.output_tokens };
  const thread = addUsage(threadUsage(file), TURN_USAGE);
  const rateLimits = process.env.FAKE_CODEX_RATE_LIMITS
    ? JSON.parse(process.env.FAKE_CODEX_RATE_LIMITS)
    : {
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: 12, window_minutes: 300, resets_at: now + 2 * 3600 },
        secondary: { used_percent: 9, window_minutes: 10080, resets_at: now + 4 * 86400 },
        credits: null,
        plan_type: 'plus',
        rate_limit_reached_type: null,
      };
  const bucket = {
    limit_id: 'codex_bengalfox',
    limit_name: 'GPT-5.3-Codex-Spark',
    primary: { used_percent: 1, window_minutes: 300, resets_at: now + 3600 },
    secondary: null,
    plan_type: 'plus',
    rate_limit_reached_type: null,
  };
  const info = { total_token_usage: thread, last_token_usage: turn, model_context_window: 258400 };
  let text = '';
  if (fresh) text += line('session_meta', { id: threadId, cwd: process.cwd(), originator: 'codex_exec' });
  text += line('event_msg', { type: 'task_started', turn_id: 'turn-fake' });
  text += line('token_usage_record', { thread_id: threadId, turn_id: 'turn-fake', usage: turn, turn_token_usage: turn, thread_token_usage: thread });
  text += line('event_msg', { type: 'token_count', info, rate_limits: rateLimits });
  text += line('event_msg', { type: 'token_count', info, rate_limits: bucket });
  text += line('event_msg', { type: 'task_complete', turn_id: 'turn-fake', last_agent_message: answer });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
  return thread;
}

let stdin = '';
if (argv[0] === 'debug' && argv[1] === 'models') {
  debugModels(argv.includes('--bundled'));
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', main);
}

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
  const rollouts = process.env.FAKE_CODEX_ROLLOUT === '1' && !!process.env.CODEX_HOME && !argv.includes('--ephemeral');
  const threadId = resuming && mode !== 'resume-new-thread' ? argv[2] : rollouts ? uuidV7(Date.now()) : 'thread-new-1';

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
  const file = rollouts ? rolloutPath(threadId) : null;
  const thread = file ? writeRolloutTurn(file, threadId, '최종 답변입니다.', !resuming) : null;
  // A resumed thread reports the thread's running total (without a rollout: a made-up large one).
  const usage = !resuming ? TURN_USAGE : (thread ?? { ...TURN_USAGE, input_tokens: 999_999, output_tokens: 9_999 });
  emit({ type: 'turn.completed', usage: Object.fromEntries(USAGE_KEYS.map((key) => [key, usage[key]])) });
}
