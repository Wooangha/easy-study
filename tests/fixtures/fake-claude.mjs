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
//
// Token usage and limits come in the shapes of claude 2.1.280 (DESIGN §23): every model call's message_start carries
// its usage and a message_delta its final counts; success makes two calls (their total: USAGE_TOTAL below), then one
// rate_limit_event and a result with the run's total. $FAKE_CLAUDE_RATE_LIMIT: unset = a subscription's limits
// (5 hours 12 %, a week 9 %), 'none' = no rate_limit_event (as with an API key), else JSON used as rate_limit_info.
// $FAKE_CLI_DELAY_MS slows a successful run down between its steps (to watch it stream in the UI).
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
const pause = () => sleep(Number(process.env.FAKE_CLI_DELAY_MS) || 0);
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// The two model calls of a successful run (usage as message_start / message_delta report it) and their total.
const CALL_1_START = { input_tokens: 3, cache_creation_input_tokens: 1200, cache_read_input_tokens: 45000, output_tokens: 1 };
const CALL_1_END = { ...CALL_1_START, output_tokens: 120, output_tokens_details: { thinking_tokens: 30 } };
const CALL_2_START = { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 46300, output_tokens: 1 };
const CALL_2_END = { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 60 };
const USAGE_TOTAL = {
  input_tokens: 8,
  cache_creation_input_tokens: 1200,
  cache_read_input_tokens: 91300,
  output_tokens: 180,
  output_tokens_details: { thinking_tokens: 30 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
};

function rateLimitInfo() {
  const raw = process.env.FAKE_CLAUDE_RATE_LIMIT;
  if (raw === 'none') return null;
  if (raw) return JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  return {
    status: 'allowed',
    resetsAt: now + 2 * 3600,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.12, resetsAt: now + 2 * 3600 },
      seven_day: { utilization: 0.09, resetsAt: now + 4 * 86400 },
    },
  };
}

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
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
          ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
          MIMALLOC_PURGE_DELAY: process.env.MIMALLOC_PURGE_DELAY ?? null,
          // The server's secrets must never reach a CLI (server/config.ts SERVER_SECRET_ENV).
          EASY_STUDY_PASSWORD: process.env.EASY_STUDY_PASSWORD ?? null,
          EASY_STUDY_TLS_KEY: process.env.EASY_STUDY_TLS_KEY ?? null,
          EASY_STUDY_TLS_CERT: process.env.EASY_STUDY_TLS_CERT ?? null,
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
    const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 };
    emit({ type: 'result', subtype: 'success', is_error: false, result: '최종 답변', session_id: reportedId, usage });
    return;
  }

  emit({ type: 'stream_event', event: { type: 'message_start', message: { usage: CALL_1_START } } });

  if (mode === 'hang' || mode === 'hang-ignore-term') {
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '부분 답변' } } });
    setInterval(() => {}, 1000); // never finishes on its own
    return;
  }

  // --- success ---
  await pause();
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
  // Snapshots repeat the call's (not final) usage once per content block: it must not be counted again.
  emit({ type: 'assistant', message: { content: [toolUse], usage: CALL_1_START } });
  emit({ type: 'assistant', message: { content: [toolUse], usage: CALL_1_START } }); // duplicate snapshot: one status only
  await pause();
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: CALL_1_END } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });

  await pause();
  emit({ type: 'stream_event', event: { type: 'message_start', message: { usage: CALL_2_START } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '두 번째 블록' } } });
  await pause();
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: CALL_2_END } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  await pause();
  const limits = rateLimitInfo();
  if (limits) emit({ type: 'rate_limit_event', rate_limit_info: limits, uuid: 'fake-uuid', session_id: reportedId });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '두 번째 블록',
    session_id: reportedId,
    total_cost_usd: 0.061,
    usage: USAGE_TOTAL,
  });
}
