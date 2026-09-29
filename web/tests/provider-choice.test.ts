// The LLM choice of the top bar: models, reasoning effort, stored choices (web/src/lib/providerChoice.ts) and how a
// session's LLM is named (format.ts). Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProviderInfo } from '../../shared/types.ts';
import { effortName, providerWithModel } from '../src/lib/format.ts';
import {
  effectiveChoice,
  effortOptions,
  parseStoredChoice,
  sameChoice,
  sessionChoice,
  storedChoice,
  supportedEffort,
  withModel,
} from '../src/lib/providerChoice.ts';
import type { ProviderChoice } from '../src/lib/providerChoice.ts';

const codex: ProviderInfo = {
  id: 'codex',
  label: 'Codex',
  kind: 'cli',
  available: true,
  models: [
    { id: '', label: 'Codex 설정 기본값 (GPT-Big)', efforts: ['low', 'medium', 'high', 'ultra'] },
    { id: 'gpt-big', label: 'GPT-Big', efforts: ['low', 'medium', 'high', 'ultra'] },
    { id: 'gpt-small', label: 'GPT-Small', efforts: ['low', 'medium'] },
    { id: 'gpt-none', label: 'GPT-None', efforts: [] },
  ],
  defaultModel: '',
  efforts: [
    { id: 'low', label: '낮음' },
    { id: 'medium', label: '보통' },
    { id: 'high', label: '높음' },
    { id: 'ultra', label: '울트라', description: 'Maximum reasoning' },
  ],
};
const claude: ProviderInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'cli',
  available: true,
  models: [
    { id: '', label: 'CLI 기본값' },
    { id: 'haiku', label: 'Haiku', efforts: [] },
  ],
  defaultModel: '',
  efforts: [
    { id: 'high', label: '높음' },
    { id: 'max', label: '최대' },
  ],
};
const api: ProviderInfo = { id: 'openai-api', label: 'OpenAI API', kind: 'api', available: true, models: [], defaultModel: 'gpt-5' };

describe('effort options', () => {
  test("a listed model offers the levels it supports, a typed-in one all of the provider's, an API provider none", () => {
    assert.deepEqual(effortOptions(codex, 'gpt-small').map((e) => e.id), ['low', 'medium']);
    assert.deepEqual(effortOptions(codex, '').map((e) => e.id), ['low', 'medium', 'high', 'ultra']);
    assert.deepEqual(effortOptions(codex, 'gpt-none'), []);
    assert.deepEqual(effortOptions(codex, 'my-model').map((e) => e.id), ['low', 'medium', 'high', 'ultra']);
    assert.deepEqual(effortOptions(claude, '').map((e) => e.id), ['high', 'max'], 'no list on the model = every level');
    assert.deepEqual(effortOptions(claude, 'haiku'), []);
    assert.deepEqual(effortOptions(api, 'gpt-5'), []);
    assert.deepEqual(effortOptions(undefined, ''), []);
  });

  test('changing the model keeps the effort when the new model supports it, else 기본값', () => {
    const choice = { provider: 'codex' as const, model: 'gpt-big', effort: 'ultra' };
    assert.deepEqual(withModel(codex, choice, 'gpt-small'), { provider: 'codex', model: 'gpt-small', effort: '' });
    const medium = { ...choice, effort: 'medium' };
    assert.deepEqual(withModel(codex, medium, 'gpt-small'), { provider: 'codex', model: 'gpt-small', effort: 'medium' });
    assert.deepEqual(withModel(codex, choice, 'typed-model'), { provider: 'codex', model: 'typed-model', effort: 'ultra' });
    assert.equal(supportedEffort(codex, 'gpt-none', 'low'), '');
    assert.equal(supportedEffort(codex, 'gpt-big', ''), '');
  });

  test('typing a model keeps the picked effort, even through a prefix that is a listed model without it', () => {
    // The text box stores every keystroke (useProviderChoice): 'gpt-small' lacks ultra, 'gpt-small-2' is typed in.
    let stored: ProviderChoice = { provider: 'codex', model: 'gpt-big', effort: 'ultra' };
    const shown: string[] = [];
    for (let i = 1; i <= 'gpt-small-2'.length; i++) {
      stored = storedChoice(stored, { provider: 'codex', model: 'gpt-small-2'.slice(0, i) });
      shown.push(effectiveChoice([codex], stored)?.effort ?? '');
    }
    assert.equal(shown[8], '', "'gpt-small' shows (and sends) 기본값");
    assert.deepEqual(effectiveChoice([codex], stored), { provider: 'codex', model: 'gpt-small-2', effort: 'ultra' });
    // A picked effort is stored as is; another provider starts at 기본값.
    assert.deepEqual(storedChoice(stored, { provider: 'codex', model: 'x', effort: 'low' }), { provider: 'codex', model: 'x', effort: 'low' });
    assert.deepEqual(storedChoice(stored, { provider: 'claude-code', model: 'opus-x' }), { provider: 'claude-code', model: 'opus-x', effort: '' });
    assert.deepEqual(storedChoice(null, { provider: 'codex', model: 'x' }), { provider: 'codex', model: 'x', effort: '' });
  });
});

describe('stored choice', () => {
  test('a choice stored before efforts existed has 기본값; anything else is no choice', () => {
    assert.deepEqual(parseStoredChoice({ provider: 'codex', model: 'gpt-big' }), { provider: 'codex', model: 'gpt-big', effort: '' });
    assert.deepEqual(parseStoredChoice({ provider: 'codex', model: '', effort: 'high' }), { provider: 'codex', model: '', effort: 'high' });
    assert.deepEqual(parseStoredChoice({ provider: 'codex', model: '', effort: 3 }), { provider: 'codex', model: '', effort: '' });
    for (const bad of [null, 'codex', {}, { provider: 'codex' }, { model: '' }, [1]]) assert.equal(parseStoredChoice(bad), null);
  });

  test('the stored choice while its provider is available (an unsupported effort becomes 기본값), else the first available', () => {
    const stored = { provider: 'codex' as const, model: 'gpt-big', effort: 'high' };
    assert.equal(effectiveChoice([claude, codex], stored), stored);
    // The catalog changed: the model no longer supports the stored level.
    const shrunk = { ...codex, models: codex.models.map((m) => (m.id === 'gpt-big' ? { ...m, efforts: ['low'] } : m)) };
    assert.deepEqual(effectiveChoice([shrunk], stored), { provider: 'codex', model: 'gpt-big', effort: '' });
    assert.deepEqual(effectiveChoice([claude, { ...codex, available: false }], stored), { provider: 'claude-code', model: '', effort: '' });
    assert.deepEqual(effectiveChoice([api], null), { provider: 'openai-api', model: 'gpt-5', effort: '' });
    assert.equal(effectiveChoice([{ ...api, available: false }], stored), null);
    assert.equal(effectiveChoice(undefined, stored), null);
  });
});

describe('the LLM switch of a session (LlmSwitchDialog)', () => {
  test("starts from the session's LLM (an absent effort is 기본값) and applies only a different choice", () => {
    assert.deepEqual(sessionChoice({ provider: 'codex', model: 'gpt-big' }), { provider: 'codex', model: 'gpt-big', effort: '' });
    assert.deepEqual(sessionChoice({ provider: 'codex', model: '', effort: 'high' }), { provider: 'codex', model: '', effort: 'high' });
    const current = sessionChoice({ provider: 'codex', model: 'gpt-big', effort: 'high' });
    assert.equal(sameChoice(current, { provider: 'codex', model: 'gpt-big', effort: 'high' }), true);
    assert.equal(sameChoice(current, { provider: 'codex', model: 'gpt-big', effort: '' }), false);
    assert.equal(sameChoice(current, { provider: 'codex', model: 'gpt-small', effort: 'high' }), false);
    assert.equal(sameChoice(current, { provider: 'claude-code', model: 'gpt-big', effort: 'high' }), false);
    // The dialog shows the picker's rules on top: a provider that went away gives way to the first available one (so
    // the session can be moved off it), a level the model lacks reads as 기본값.
    const gone: ProviderInfo = { ...claude, available: false, reason: 'claude not found' };
    assert.deepEqual(effectiveChoice([gone, codex], sessionChoice({ provider: 'claude-code', model: 'opus', effort: 'max' })), {
      provider: 'codex',
      model: '',
      effort: '',
    });
    assert.deepEqual(effectiveChoice([claude, codex], sessionChoice({ provider: 'codex', model: 'gpt-none', effort: 'low' })), {
      provider: 'codex',
      model: 'gpt-none',
      effort: '',
    });
    // Picking a model in the dialog keeps the level as the top bar does (storedChoice).
    assert.deepEqual(storedChoice(current, withModel(codex, current, 'gpt-small')), { provider: 'codex', model: 'gpt-small', effort: '' });
  });
});

describe('LLM names', () => {
  test('model and effort are named when they are not the defaults', () => {
    const providers = [codex, claude];
    assert.equal(providerWithModel(providers, 'codex'), 'Codex');
    assert.equal(providerWithModel(providers, 'codex', 'gpt-big', 'ultra'), 'Codex · gpt-big · 추론 울트라');
    assert.equal(providerWithModel(providers, 'claude-code', '', 'max'), 'Claude Code · 추론 최대');
    // Without provider info (or for a level it does not list): the shared Korean name, else the id.
    assert.equal(effortName(undefined, 'codex', 'xhigh'), '매우 높음');
    assert.equal(effortName(providers, 'codex', 'turbo'), 'turbo');
  });
});
