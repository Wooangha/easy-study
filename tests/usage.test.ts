// Token usage and subscription limits (DESIGN §23): the providers' usage / limit shapes (as claude 2.1.280 and
// codex-cli 0.154 print them), the shared arithmetic, and reading a Codex rollout. No CLI or API is run.
// Run: node --test tests/usage.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { TokenUsage } from '../shared/types.ts';
import { addSessionUsage, addUsage, readSessionUsage, readTokenUsage, readUsageLimits, totalTokens } from '../shared/usage.ts';
import {
  ROLLOUT_TAIL_BYTES,
  codexRolloutSize,
  findCodexRollout,
  parseCodexRolloutTail,
  readCodexRolloutTurn,
  uuidV7Time,
} from '../server/providers/codexRollout.ts';
import { AnthropicUsageTracker, anthropicUsage, claudeRateLimits, codexRateLimits, openaiUsage } from '../server/providers/usage.ts';

const AT = '2026-09-29T00:00:00.000Z';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

describe('shared usage arithmetic', () => {
  test('addUsage adds count by count, keeps parts above zero, never mutates', () => {
    const a: TokenUsage = { input: 100, cachedInput: 60, output: 10 };
    const b: TokenUsage = { input: 50, cacheWrite: 5, output: 7, reasoning: 3 };
    assert.deepEqual(addUsage(a, b), { input: 150, output: 17, cachedInput: 60, cacheWrite: 5, reasoning: 3 });
    assert.deepEqual(a, { input: 100, cachedInput: 60, output: 10 });
    assert.deepEqual(addUsage(undefined, b), b);
    assert.notEqual(addUsage(undefined, b), b, 'a copy');
    assert.equal(addUsage(undefined, undefined), undefined);
    assert.equal(totalTokens(a), 110);
  });

  test('addSessionUsage: every turn adds to the total, priming turns to the priming cost too', () => {
    const prime: TokenUsage = { input: 40_000, cacheWrite: 38_000, output: 900 };
    const question: TokenUsage = { input: 42_000, cachedInput: 38_000, output: 500 };
    let session = addSessionUsage(undefined, prime, true);
    assert.deepEqual(session, { total: prime, priming: prime });
    session = addSessionUsage(session, question, false);
    assert.deepEqual(session, {
      total: { input: 82_000, cachedInput: 38_000, cacheWrite: 38_000, output: 1_400 },
      priming: prime,
    });
    assert.equal(addSessionUsage(session, undefined, false), session, 'a turn without usage changes nothing');
    assert.deepEqual(addSessionUsage(undefined, question, false), { total: question });
  });

  test('stored usage and limits are read defensively (old sessions have none)', () => {
    assert.deepEqual(readTokenUsage({ input: 10.4, output: 2, cachedInput: 0, reasoning: -1, extra: 'x' }), { input: 10, output: 2 });
    for (const bad of [undefined, null, 'x', {}, { input: 1 }, { input: '1', output: 2 }, { input: Number.NaN, output: 1 }]) {
      assert.equal(readTokenUsage(bad), undefined);
    }
    assert.deepEqual(readSessionUsage({ total: { input: 5, output: 1 }, priming: 'x' }), { total: { input: 5, output: 1 } });
    assert.equal(readSessionUsage({ priming: { input: 5, output: 1 } }), undefined);

    const limits = { at: AT, status: 'warning', windows: [{ minutes: 300, usedPercent: 81.5, resetsAt: AT, label: 'Opus', binding: true }, { minutes: 'x' }] };
    assert.deepEqual(readUsageLimits(limits), { at: AT, status: 'warning', windows: [limits.windows[0]] });
    assert.equal(readUsageLimits({ ...limits, windows: [{ minutes: 300, usedPercent: 1, binding: 'yes' }] })?.windows[0].binding, undefined);
    assert.equal(readUsageLimits({ ...limits, status: 'weird' })?.status, 'ok');
    assert.equal(readUsageLimits({ at: 'not a date', status: 'ok', windows: [] }), undefined);
    assert.equal(readUsageLimits({ at: AT, status: 'ok' }), undefined);
  });
});

describe('Claude usage (claude-code stream-json, anthropic-api)', () => {
  test("anthropicUsage: the cache is added to the input, thinking is part of the output", () => {
    // message_start of the probe (a new conversation: nothing cached yet).
    const start = {
      input_tokens: 428,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      output_tokens: 4,
      service_tier: 'standard',
    };
    assert.deepEqual(anthropicUsage(start), { input: 428, output: 4 });
    // A continued conversation: most of the input is read from the cache.
    assert.deepEqual(
      anthropicUsage({
        input_tokens: 6,
        cache_creation_input_tokens: 1_500,
        cache_read_input_tokens: 41_000,
        output_tokens: 820,
        output_tokens_details: { thinking_tokens: 300 },
      }),
      { input: 42_506, output: 820, cachedInput: 41_000, cacheWrite: 1_500, reasoning: 300 },
    );
    assert.equal(anthropicUsage({}), undefined);
    assert.equal(anthropicUsage(null), undefined);
  });

  test('AnthropicUsageTracker: message_delta replaces a call’s counts (null keeps them); calls add up', () => {
    const tracker = new AnthropicUsageTracker();
    assert.deepEqual(tracker.start({ input_tokens: 428, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 }), {
      input: 428,
      output: 4,
    });
    // The probe's message_delta: cumulative for that call.
    const delta = { input_tokens: 428, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 37, output_tokens_details: { thinking_tokens: 30 } };
    assert.deepEqual(tracker.update(delta), { input: 428, output: 37, reasoning: 30 });
    assert.deepEqual(tracker.update(delta), { input: 428, output: 37, reasoning: 30 }, 'repeating it changes nothing');
    tracker.start({ input_tokens: 10, cache_read_input_tokens: 400, output_tokens: 1 });
    assert.deepEqual(tracker.update({ input_tokens: null, cache_read_input_tokens: null, output_tokens: 12 }), {
      input: 838,
      output: 49,
      cachedInput: 400,
      reasoning: 30,
    });
    assert.deepEqual(new AnthropicUsageTracker().update({ output_tokens: 3 }), { input: 0, output: 3 }, 'a delta without a start');
  });

  test('claudeRateLimits: the probe’s rate_limit_event (utilization fractions, reset times in Unix seconds)', () => {
    const info = {
      status: 'allowed',
      resetsAt: 1790634600,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.05, resetsAt: 1790634600 },
        seven_day: { utilization: 0.28, resetsAt: 1790982000 },
      },
    };
    assert.deepEqual(claudeRateLimits(info, AT), {
      at: AT,
      status: 'ok',
      windows: [
        { minutes: 300, usedPercent: 5, resetsAt: '2026-09-28T22:30:00.000Z' },
        { minutes: 10_080, usedPercent: 28, resetsAt: '2026-10-02T23:00:00.000Z' },
      ],
    });
  });

  test('claudeRateLimits: warnings, model-family and overage windows, API-key sessions', () => {
    const warning = claudeRateLimits(
      {
        status: 'allowed_warning',
        rateLimitType: 'seven_day_sonnet',
        utilization: 0.8,
        resetsAt: 1790982000,
        unifiedWindows: { seven_day_overage_included: { utilization: 0.5, resetsAt: 1790982000 }, five_hour: { utilization: 1.2, resetsAt: 1790634600 } },
      },
      AT,
    );
    assert.equal(warning?.status, 'warning');
    assert.deepEqual(
      warning?.windows.map((w) => [w.minutes, w.usedPercent, w.label, w.binding]),
      [
        [300, 120, undefined, undefined], // utilization can go over 1
        [10_080, 80, 'Sonnet', true], // the one the warning is about
      ],
    );
    // The binding window is already a unified one: not listed twice.
    const same = claudeRateLimits({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, unifiedWindows: { five_hour: { utilization: 0.91 } } }, AT);
    assert.deepEqual(same?.windows, [{ minutes: 300, usedPercent: 91, binding: true }]);
    assert.deepEqual(claudeRateLimits({ status: 'rejected', rateLimitType: 'overage' }, AT), { at: AT, status: 'reached', windows: [] });
    // An API-key (or Bedrock / Vertex) session: no windows, nothing to show.
    assert.equal(claudeRateLimits({ status: 'allowed' }, AT), undefined);
    assert.equal(claudeRateLimits(undefined, AT), undefined);
  });
});

describe('OpenAI usage (codex exec --json, Codex rollouts, the Responses API)', () => {
  test('openaiUsage: cached and reasoning tokens are parts of the counts', () => {
    // The probe's turn.completed.
    assert.deepEqual(
      openaiUsage({ input_tokens: 8595, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }),
      { input: 8595, output: 5 },
    );
    assert.deepEqual(
      openaiUsage({ input_tokens: 16094, cached_input_tokens: 13056, cache_write_input_tokens: 0, output_tokens: 140, reasoning_output_tokens: 16, total_tokens: 16234 }),
      { input: 16094, output: 140, cachedInput: 13056, reasoning: 16 },
    );
    // Responses API ResponseUsage.
    assert.deepEqual(
      openaiUsage({
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 50 },
        output_tokens: 300,
        output_tokens_details: { reasoning_tokens: 200 },
        total_tokens: 1500,
      }),
      { input: 1200, output: 300, cachedInput: 1024, cacheWrite: 50, reasoning: 200 },
    );
    assert.equal(openaiUsage({ total_tokens: 3 }), undefined);
  });

  test('codexRateLimits: windows by length (never by primary / secondary); model buckets; reached; none', () => {
    // A plus plan: 5 hours + a week.
    assert.deepEqual(
      codexRateLimits(
        {
          limit_id: 'codex',
          limit_name: null,
          primary: { used_percent: 49, window_minutes: 300, resets_at: 1778866172 },
          secondary: { used_percent: 73, window_minutes: 10080, resets_at: 1778904561 },
          credits: null,
          plan_type: 'plus',
          rate_limit_reached_type: null,
        },
        AT,
      ),
      {
        at: AT,
        status: 'ok',
        windows: [
          { minutes: 300, usedPercent: 49, resetsAt: iso(1778866172) },
          { minutes: 10_080, usedPercent: 73, resetsAt: iso(1778904561) },
        ],
      },
    );
    // A weekly-only plan (prolite): the week is the primary window.
    assert.deepEqual(
      codexRateLimits({ limit_id: 'codex', primary: { used_percent: 9, window_minutes: 10080, resets_at: 1790453793 }, secondary: null }, AT)?.windows,
      [{ minutes: 10_080, usedPercent: 9, resetsAt: iso(1790453793) }],
    );
    // A model bucket is labelled.
    assert.equal(
      codexRateLimits({ limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark', primary: { used_percent: 1, window_minutes: 300 } }, AT)?.windows[0].label,
      'GPT-5.3-Codex-Spark',
    );
    assert.equal(codexRateLimits({ limit_id: 'premium', primary: null, secondary: null }, AT), undefined);
    assert.deepEqual(codexRateLimits({ limit_id: null, primary: null, secondary: null, rate_limit_reached_type: 'workspace_member_usage_limit_reached' }, AT), {
      at: AT,
      status: 'reached',
      windows: [],
    });
  });
});

describe('Codex rollouts', () => {
  const THREAD = '01a0d965-78fc-7a2b-9c3d-4e5f60718293';
  let home = '';

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-study-rollout-')));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const line = (at: string, type: string, payload: object) => JSON.stringify({ timestamp: at, type, payload });
  const usageRecord = (at: string, turnInput: number, threadId = THREAD) =>
    line(at, 'token_usage_record', {
      thread_id: threadId,
      turn_id: 'turn',
      usage: { input_tokens: turnInput, cached_input_tokens: 0, output_tokens: 10 },
      turn_token_usage: { input_tokens: turnInput, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
      thread_token_usage: { input_tokens: turnInput * 5, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 },
    });
  const tokenCount = (at: string, rateLimits: object | null) =>
    line(at, 'event_msg', { type: 'token_count', info: { total_token_usage: {}, last_token_usage: {}, model_context_window: 258400 }, rate_limits: rateLimits });
  const general = (used: number) => ({ limit_id: 'codex', limit_name: null, primary: { used_percent: used, window_minutes: 10080, resets_at: 1791049157 }, secondary: null });
  const bucket = { limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark', primary: { used_percent: 1, window_minutes: 300, resets_at: 1790634600 }, secondary: null };

  test('uuidV7Time: the creation time of a UUIDv7 thread id', () => {
    assert.equal(new Date(uuidV7Time(THREAD) ?? 0).toISOString(), '2026-09-25T16:28:21.116Z');
    assert.equal(uuidV7Time('thread-new-1'), null);
    assert.equal(uuidV7Time('01a0d965-78fc-4a2b-9c3d-4e5f60718293'), null, 'a UUIDv4');
  });

  test("parseCodexRolloutTail: the turn's last record, the plan's limit over a bucket", () => {
    const tail = [
      line('2026-09-29T00:00:01.000Z', 'response_item', { type: 'message', content: 'mentions "token_count" in passing' }),
      usageRecord('2026-09-29T00:00:02.000Z', 40_000), // an earlier call of this turn
      usageRecord('2026-09-29T00:00:03.000Z', 45_000, 'another-thread'),
      '{"timestamp":"2026-09-29T00:00:03.500Z","type":"token_usage_record", broken',
      usageRecord('2026-09-29T00:00:04.000Z', 90_000), // the whole turn
      tokenCount('2026-09-29T00:00:04.000Z', general(12)),
      tokenCount('2026-09-29T00:00:04.100Z', bucket),
      tokenCount('2026-09-29T00:00:04.200Z', null),
      line('2026-09-29T00:00:04.300Z', 'event_msg', { type: 'task_complete', last_agent_message: 'done' }),
    ].join('\n');
    const turn = parseCodexRolloutTail(tail, THREAD);
    assert.deepEqual(turn.usage, { input: 90_000, output: 10, cachedInput: 1000 });
    assert.deepEqual(turn.limits, {
      at: '2026-09-29T00:00:04.000Z',
      status: 'ok',
      windows: [{ minutes: 10_080, usedPercent: 12, resetsAt: iso(1791049157) }],
    });

    // Only a model bucket was written: it is used, labelled.
    const bucketOnly = parseCodexRolloutTail([usageRecord('2026-09-29T00:00:04.000Z', 5), tokenCount('2026-09-29T00:00:04.000Z', bucket)].join('\n'), THREAD);
    assert.equal(bucketOnly.limits?.windows[0].label, 'GPT-5.3-Codex-Spark');
    assert.deepEqual(parseCodexRolloutTail(tail.split('\n').slice(0, 1).join('\n'), THREAD), {});
    assert.deepEqual(parseCodexRolloutTail('', THREAD), {});
  });

  test("readCodexRolloutTurn: finds the file by the id's local creation date (or a day around it) and reads its tail", async () => {
    const created = new Date(uuidV7Time(THREAD) ?? 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    // Filed under the next day (e.g. a clock change): still found.
    const next = new Date(created.getTime() + 86_400_000);
    const dir = path.join(home, 'sessions', String(next.getFullYear()), pad(next.getMonth() + 1), pad(next.getDate()));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-09-26T01-28-21-${THREAD}.jsonl.tmp`), 'not this one');
    const file = path.join(dir, `rollout-2026-09-26T01-28-21-${THREAD}.jsonl`);
    const now = new Date().toISOString();
    // The previous turn (recorded a moment ago: timestamps cannot tell it from this run's).
    fs.writeFileSync(file, `${usageRecord(now, 1)}\n${tokenCount(now, general(5))}\n`);
    const before = await codexRolloutSize(THREAD, home);
    assert.equal(before, fs.statSync(file).size);
    assert.deepEqual(await readCodexRolloutTurn(THREAD, before ?? 0, home), {}, 'a run that recorded nothing yields nothing');
    // This run: a long message (an image line bigger than the tail), then its records.
    const big = line(now, 'response_item', { type: 'message', content: 'x'.repeat(ROLLOUT_TAIL_BYTES + 10) });
    fs.appendFileSync(file, `${big}\n${usageRecord(now, 7_000)}\n${tokenCount(now, general(33))}\n`);

    assert.equal(await findCodexRollout(THREAD, home), file);
    const turn = await readCodexRolloutTurn(THREAD, before ?? 0, home);
    assert.deepEqual(turn.usage, { input: 7_000, output: 10, cachedInput: 1000 });
    assert.equal(turn.limits?.windows[0].usedPercent, 33);
    // A short run: read from where it started, its first line whole.
    const size = fs.statSync(file).size;
    fs.appendFileSync(file, `${usageRecord(now, 9_000)}\n`);
    assert.deepEqual((await readCodexRolloutTurn(THREAD, size, home)).usage, { input: 9_000, output: 10, cachedInput: 1000 });
    assert.deepEqual(await readCodexRolloutTurn(THREAD, fs.statSync(file).size, home), {}, 'nothing appended');

    assert.equal(await codexRolloutSize('01a0d965-78fc-7a2b-9c3d-000000000000', home), null);
    assert.deepEqual(await readCodexRolloutTurn('01a0d965-78fc-7a2b-9c3d-000000000000', 0, home), {}, 'no rollout');
    assert.deepEqual(await readCodexRolloutTurn('thread-new-1', 0, home), {}, 'not a UUIDv7');
    assert.deepEqual(await readCodexRolloutTurn(THREAD, 0, path.join(home, 'missing')), {});
  });
});
