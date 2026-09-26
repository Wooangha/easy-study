// Tests for the provider adapters. Never runs the real CLIs or APIs:
// - CLI providers run fake CLIs from tests/fixtures (via CLAUDE_BIN / CODEX_BIN),
// - API providers talk to a local mock HTTP server (via ANTHROPIC_BASE_URL / OPENAI_BASE_URL).
// Run: node --test tests/providers.test.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { inlinePathFor } from '../server/assets.ts';
import type { Part, Provider, ProviderRunInput, ProviderRunResult } from '../server/providers/types.ts';
import { ProviderError, providerErrorKind } from '../server/providers/types.ts';
import {
  CLAUDE_BIN_SPEC,
  CLAUDE_CHILD_ENV_DEFAULTS,
  CLAUDE_TOOLS,
  claudeArgs,
  claudeCodeProvider,
  claudeEnv,
  claudeInstallHint,
  classifyClaudeFailure,
  toolStatus,
} from '../server/providers/claudeCode.ts';
import {
  CODEX_BIN_SPEC,
  CODEX_DISABLED_INTEGRATIONS,
  CODEX_DISABLED_TOOLS,
  CODEX_PERMISSION_PROFILE,
  CONFINEMENT_HINT,
  CodexStreamState,
  classifyCodexFailure,
  codexArgs,
  codexConfinementEnabled,
  codexExecutable,
  codexInstallHint,
  codexMcpServerNames,
  codexPrompt,
  codexProvider,
  codexReadRootsToml,
  tomlString,
} from '../server/providers/codex.ts';
import {
  AnthropicStreamState,
  MAX_REQUEST_BYTES,
  anthropicApiProvider,
  anthropicContextWindow,
  buildAnthropicRequest,
  checkAnthropicRequest,
  classifyAnthropicError,
  estimateAnthropicInputTokens,
} from '../server/providers/anthropicApi.ts';
import { buildOpenAIRequest, classifyOpenAIError, openaiApiProvider } from '../server/providers/openaiApi.ts';
import { clearProviderInfoCache, getProvider, listProviders, providerInfos } from '../server/providers/index.ts';
import {
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_EDGE,
  JsonlParser,
  clearInlineImageCache,
  loadInlineImage,
  resolveBin,
  runJsonlProcess,
  stopProcess,
  taskkillPath,
} from '../server/providers/proc.ts';
import type { ExecFileLike } from '../server/providers/proc.ts';

const execFileAsync = promisify(execFile);

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.mjs');
fs.chmodSync(FAKE_CLAUDE, 0o755);
fs.chmodSync(FAKE_CODEX, 0o755);

/**
 * Tests that execute the fake CLIs (or rely on POSIX symlinks and exec bits). The providers spawn the CLI
 * without a shell, and Windows cannot start a .mjs script that way (it only runs .exe / .com files).
 */
const FAKE_CLI = {
  skip: process.platform === 'win32' ? 'the fake CLIs are .mjs scripts, which Windows cannot spawn without a shell' : false,
};

// A 1x1 PNG (slide) and a small red PNG (overview sheet), created in `before`.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
let SHEET_PNG = Buffer.alloc(0);
before(async () => {
  SHEET_PNG = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#ff0000' } }).png().toBuffer();
});

/** How an image file is embedded by the adapters that send images inline (JPEG, see loadInlineImage). */
async function inline(file: string): Promise<{ type: 'base64'; media_type: string; data: string }> {
  const image = await loadInlineImage(file);
  return { type: 'base64', media_type: image.mediaType, data: image.data };
}

/** The hardening overrides every codex call carries (no MCP servers configured in the test CODEX_HOME). */
const CODEX_HARDENING = ['-c', 'notify=[]', ...CODEX_DISABLED_INTEGRATIONS.flatMap((f) => ['-c', `features.${f}=false`])];
/** Overrides every codex call carries whether or not reads are confined. */
const CODEX_NO_ESCALATION = ['-c', 'approval_policy="never"', '-c', 'approvals_reviewer="user"', '-c', 'project_root_markers=[]'];

/** The -c overrides that confine a codex call's reads to `dirs` (see the top of server/providers/codex.ts). */
function codexConfined(...dirs: string[]): string[] {
  const table = [':minimal', ...dirs].map((dir) => `"${dir}"="read"`).join(',');
  return [
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    `default_permissions="${CODEX_PERMISSION_PROFILE}"`,
    '-c',
    `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={${table}}`,
    ...CODEX_NO_ESCALATION,
  ];
}

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
  'EASY_STUDY_CODEX_CONFINE',
  'CODEX_HOME',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'MIMALLOC_PURGE_DELAY',
  'EASY_STUDY_PASSWORD',
  'EASY_STUDY_TLS_KEY',
  'EASY_STUDY_TLS_CERT',
];

/** The server's secrets (remote mode, DESIGN §16), set while a CLI runs: none of them may reach it. */
function setServerSecrets(): void {
  process.env.EASY_STUDY_PASSWORD = 'secret-access-password';
  process.env.EASY_STUDY_TLS_KEY = '/etc/easy-study/server.key';
  process.env.EASY_STUDY_TLS_CERT = '/etc/easy-study/server.crt';
}

function assertNoServerSecrets(env: Record<string, string | null> | undefined): void {
  assert.ok(env, 'the fake CLI recorded its environment');
  assert.equal(env.EASY_STUDY_PASSWORD, null, 'the access password stays in the server');
  assert.equal(env.EASY_STUDY_TLS_KEY, null);
  assert.equal(env.EASY_STUDY_TLS_CERT, null);
}
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
  fs.writeFileSync(sheetPng, SHEET_PNG);
  recordFile = path.join(workDir, 'record.json');
  process.env.FAKE_CLI_RECORD = recordFile;
  // Never read the user's real Codex config (its MCP servers would change the argv).
  process.env.CODEX_HOME = path.join(workDir, 'codex-home');
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

function record(): { argv: string[]; stdin: string; pid: number; script?: string; env?: Record<string, string | null> } {
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

  test('loadInlineImage: downscaled JPEG within the byte target, cached; small images are not enlarged', async () => {
    clearInlineImageCache();
    const big = path.join(workDir, 'big.png');
    await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#3366cc' } }).png().toFile(big);
    const image = await loadInlineImage(big);
    assert.equal(image.mediaType, 'image/jpeg');
    const bytes = Buffer.from(image.data, 'base64');
    const meta = await sharp(bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', INLINE_IMAGE_MAX_EDGE, 882]);
    assert.ok(bytes.length <= INLINE_IMAGE_MAX_BYTES);
    assert.equal(await loadInlineImage(big), image, 'the second load comes from the cache');

    const small = await sharp(Buffer.from((await loadInlineImage(slidePng)).data, 'base64')).metadata();
    assert.deepEqual([small.format, small.width, small.height], ['jpeg', 1, 1]);
  });

  test('loadInlineImage: a noise-like picture still ends up under the byte target', async () => {
    const noisy = path.join(workDir, 'noisy.png');
    const pixels = Buffer.alloc(1600 * 900 * 3);
    let x = 12345;
    for (let i = 0; i < pixels.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      pixels[i] = x >>> 24;
    }
    await sharp(pixels, { raw: { width: 1600, height: 900, channels: 3 } }).png().toFile(noisy);
    const bytes = Buffer.from((await loadInlineImage(noisy)).data, 'base64');
    assert.ok(bytes.length <= INLINE_IMAGE_MAX_BYTES, `${bytes.length} bytes`);
  });

  test('loadInlineImage: an undecodable file is sent unchanged; a missing file rejects', async () => {
    const bogus = path.join(workDir, 'bogus.png');
    fs.writeFileSync(bogus, 'not a png');
    assert.deepEqual(await loadInlineImage(bogus), { mediaType: 'image/png', data: Buffer.from('not a png').toString('base64') });
    await assert.rejects(loadInlineImage(path.join(workDir, 'missing.png')), /슬라이드 이미지를 읽을 수 없습니다/);
  });

  test("loadInlineImage: the image worker's JPEG is sent as it is (never cached); an empty or stale one is ignored", async () => {
    clearInlineImageCache();
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const jpeg = inlinePathFor(slidePng)!;
    assert.equal(jpeg, path.join(workDir, 'inline', 'slides-003.jpg'));
    fs.mkdirSync(path.dirname(jpeg));
    fs.writeFileSync(jpeg, 'pre-encoded v1');
    assert.deepEqual(await loadInlineImage(slidePng), { mediaType: 'image/jpeg', data: b64('pre-encoded v1') });
    fs.writeFileSync(jpeg, 'pre-encoded v2');
    assert.deepEqual(await loadInlineImage(slidePng), { mediaType: 'image/jpeg', data: b64('pre-encoded v2') });

    const isJpeg = async (data: string) => (await sharp(Buffer.from(data, 'base64')).metadata()).format === 'jpeg';
    // Empty (e.g. being written): encoded here instead.
    fs.writeFileSync(jpeg, '');
    const fallback = await loadInlineImage(slidePng);
    assert.equal(fallback.mediaType, 'image/jpeg');
    assert.ok(await isJpeg(fallback.data));
    // Older than the PNG (the slide was re-rendered): encoded here instead.
    fs.writeFileSync(jpeg, 'pre-encoded v3');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(slidePng, later, later);
    const fresh = await loadInlineImage(slidePng);
    assert.notEqual(fresh.data, b64('pre-encoded v3'));
    assert.ok(await isJpeg(fresh.data));
  });

  test('the SDKs and sharp are only loaded when needed (idle memory)', async () => {
    const jpeg = inlinePathFor(slidePng)!;
    fs.mkdirSync(path.dirname(jpeg));
    fs.writeFileSync(jpeg, 'pre-encoded');
    const url = (file: string) => JSON.stringify(pathToFileURL(path.join(FIXTURES, '..', '..', 'server', 'providers', file)).href);
    // Records every bare import of the watched packages, then reports after each step.
    const script = `
      import { registerHooks } from 'node:module';
      const watched = ['@anthropic-ai/sdk', 'openai', 'sharp'];
      const loaded = new Set();
      registerHooks({
        resolve(specifier, context, next) {
          for (const name of watched) if (specifier === name || specifier.startsWith(name + '/')) loaded.add(name);
          return next(specifier, context);
        },
      });
      const steps = {};
      const report = (step) => (steps[step] = [...loaded].sort());
      await import(${url('index.ts')});
      report('import');
      const proc = await import(${url('proc.ts')});
      await proc.loadInlineImage(${JSON.stringify(slidePng)});
      report('preEncoded');
      await proc.loadInlineImage(${JSON.stringify(sheetPng)});
      report('encoded');
      console.log(JSON.stringify(steps));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: workDir });
    assert.deepEqual(JSON.parse(stdout), { import: [], preEncoded: [], encoded: ['sharp'] });
  });
});

describe('resolveBin', () => {
  const NPM = 'C:\\Users\\hong\\AppData\\Roaming\\npm';
  const LOCAL = 'C:\\Users\\hong\\.local\\bin';
  const CLAUDE_PKG = `${NPM}\\node_modules\\@anthropic-ai\\claude-code`;
  const CODEX_PKG = `${NPM}\\node_modules\\@openai\\codex`;
  /** Size of a native CLI binary (anything ≥ 4 KB counts as real). */
  const BIG = 200_000_000;

  function disk(files: Record<string, number>): (file: string) => Promise<number | null> {
    return async (file) => (Object.hasOwn(files, file) ? files[file] : null);
  }

  function win(env: NodeJS.ProcessEnv, files: Record<string, number>, arch = 'x64') {
    return { platform: 'win32' as const, arch, env: { PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env }, fileSize: disk(files) };
  }

  test('POSIX: the override or the bare name, without looking at the disk', async () => {
    const fileSize = async (): Promise<number | null> => {
      throw new Error('no lookup expected');
    };
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, { platform: 'darwin', env: { PATH: '/usr/bin' }, fileSize }), 'claude');
    assert.equal(await resolveBin(CODEX_BIN_SPEC, { platform: 'linux', env: { CODEX_BIN: ' /opt/codex ' }, fileSize }), '/opt/codex');
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, { platform: 'darwin', env: { CLAUDE_BIN: 'x.cmd' }, fileSize }), 'x.cmd');
  });

  test('Windows: a native .exe anywhere on PATH wins over an npm .cmd shim earlier on PATH', async () => {
    const files = { [`${NPM}\\claude.cmd`]: 300, [`${CLAUDE_PKG}\\bin\\claude.exe`]: BIG, [`${LOCAL}\\claude.exe`]: BIG };
    // "Path" is the usual spelling; quoted, relative and empty entries are tolerated.
    const env = { Path: `${NPM};relative\\bin;;"${LOCAL}"` };
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win(env, files)), `${LOCAL}\\claude.exe`);
    // .com / .exe in PATHEXT order within a directory; other PATHEXT entries are never spawned.
    const both = { [`${LOCAL}\\claude.com`]: BIG, [`${LOCAL}\\claude.exe`]: BIG, [`${LOCAL}\\claude.bat`]: 10 };
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win({ PATH: LOCAL }, both)), `${LOCAL}\\claude.com`);
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win({ PATH: LOCAL, PATHEXT: '.EXE;.COM;.BAT' }, both)), `${LOCAL}\\claude.exe`);
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win({ PATH: LOCAL }, { [`${LOCAL}\\claude.bat`]: 10 })), 'claude');
  });

  test("Windows: an npm claude.cmd shim maps to the package's native claude.exe (not its pre-postinstall stub)", async () => {
    const env = { PATH: `${NPM};${LOCAL}` };
    const shim = { [`${NPM}\\claude.cmd`]: 300 };
    assert.equal(
      await resolveBin(CLAUDE_BIN_SPEC, win(env, { ...shim, [`${CLAUDE_PKG}\\bin\\claude.exe`]: BIG })),
      `${CLAUDE_PKG}\\bin\\claude.exe`,
    );
    const nested = `${CLAUDE_PKG}\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win(env, { ...shim, [`${CLAUDE_PKG}\\bin\\claude.exe`]: 500, [nested]: BIG })), nested);
    const hoisted = `${NPM}\\node_modules\\@anthropic-ai\\claude-code-win32-arm64\\claude.exe`;
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win(env, { ...shim, [hoisted]: BIG }, 'arm64')), hoisted);
    // A shim whose target is missing: the bare name, which spawn reports as not found.
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win(env, shim)), 'claude');
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, win(env, {})), 'claude');
  });

  test('Windows: an npm codex.cmd shim maps to the vendored codex.exe that bin/codex.js would spawn', async () => {
    const env = { PATH: NPM };
    const shim = { [`${NPM}\\codex.cmd`]: 400 };
    const x64 = `@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
    const nested = `${CODEX_PKG}\\node_modules\\${x64}`;
    const hoisted = `${NPM}\\node_modules\\${x64}`;
    assert.equal(await resolveBin(CODEX_BIN_SPEC, win(env, { ...shim, [nested]: BIG, [hoisted]: BIG })), nested);
    assert.equal(await resolveBin(CODEX_BIN_SPEC, win(env, { ...shim, [hoisted]: BIG })), hoisted);
    const legacy = `${CODEX_PKG}\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe`;
    assert.equal(await resolveBin(CODEX_BIN_SPEC, win(env, { ...shim, [legacy]: BIG }, 'arm64')), legacy);
    assert.equal(await resolveBin(CODEX_BIN_SPEC, win(env, { ...shim, [hoisted]: BIG }, 'arm64')), 'codex', 'wrong architecture');
  });

  test('Windows overrides: a .cmd path is mapped, other paths are kept, a bare name is searched on PATH', async () => {
    const files = {
      [`${NPM}\\claude.cmd`]: 300,
      [`${CLAUDE_PKG}\\bin\\claude.exe`]: BIG,
      [`${LOCAL}\\codex-beta.exe`]: BIG,
    };
    const env = (vars: NodeJS.ProcessEnv) => win({ PATH: `${NPM};${LOCAL}`, ...vars }, files);
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, env({ CLAUDE_BIN: `${NPM}\\claude.cmd` })), `${CLAUDE_PKG}\\bin\\claude.exe`);
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, env({ CLAUDE_BIN: 'D:\\tools\\claude.exe' })), 'D:\\tools\\claude.exe');
    // Not mappable: kept, and spawning it fails with a message about batch files.
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, env({ CLAUDE_BIN: 'D:\\tools\\claude.cmd' })), 'D:\\tools\\claude.cmd');
    assert.equal(await resolveBin(CODEX_BIN_SPEC, env({ CODEX_BIN: 'codex-beta' })), `${LOCAL}\\codex-beta.exe`);
    assert.equal(await resolveBin(CODEX_BIN_SPEC, env({ CODEX_BIN: 'codex-gone' })), 'codex-gone');
    assert.equal(await resolveBin(CLAUDE_BIN_SPEC, env({ CLAUDE_BIN: 'claude.cmd' })), `${CLAUDE_PKG}\\bin\\claude.exe`);
  });

  test('install hints recommend the native installers on Windows', () => {
    assert.match(claudeInstallHint('win32'), /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
    assert.match(claudeInstallHint('win32'), /winget install Anthropic\.ClaudeCode/);
    assert.match(codexInstallHint('win32'), /irm https:\/\/chatgpt\.com\/codex\/install\.ps1 \| iex/);
    for (const hint of [claudeInstallHint('win32'), codexInstallHint('win32')]) assert.doesNotMatch(hint, /npm/);
    assert.match(claudeInstallHint('darwin'), /install\.sh/);
    assert.match(codexInstallHint('linux'), /install\.sh/);
  });
});

describe('stopProcess', () => {
  test('POSIX: SIGTERM; Windows: taskkill of the whole process tree, the child alone if taskkill fails', () => {
    const kills: string[] = [];
    const child = {
      pid: 4321,
      kill: (signal?: NodeJS.Signals | number) => {
        kills.push(String(signal ?? 'default'));
        return true;
      },
    };
    const calls: unknown[][] = [];
    const record: ExecFileLike = (file, args, options, callback) => {
      calls.push([file, args, options]);
      callback(null);
    };
    stopProcess(child, 'darwin', record);
    assert.deepEqual(kills, ['SIGTERM']);
    assert.deepEqual(calls, []);

    kills.length = 0;
    stopProcess(child, 'win32', record);
    assert.deepEqual(calls, [[taskkillPath(), ['/PID', '4321', '/T', '/F'], { windowsHide: true }]]);
    assert.deepEqual(kills, []);
    stopProcess(child, 'win32', (_file, _args, _options, callback) => callback(new Error('taskkill: access denied')));
    assert.deepEqual(kills, ['default']);
    stopProcess(child, 'win32', () => {
      throw new Error('spawn EPERM');
    });
    assert.deepEqual(kills, ['default', 'default']);

    assert.equal(taskkillPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\taskkill.exe');
    assert.equal(taskkillPath({}), 'taskkill.exe');
  });
});

// ---------------------------------------------------------------------------
// claude-code
// ---------------------------------------------------------------------------

describe('claude-code provider', () => {
  beforeEach(() => {
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
  });

  test('new conversation: exact argv, stdin message with base64 images, streamed text', FAKE_CLI, async () => {
    process.env.CLAUDECODE = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    setServerSecrets();
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
    assert.equal(rec.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(rec.env?.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(rec.env?.MIMALLOC_PURGE_DELAY, '0');
    assertNoServerSecrets(rec.env);

    assert.ok(rec.stdin.endsWith('\n'));
    const lines = rec.stdin.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Overview image: slides 1–4' },
          { type: 'image', source: await inline(sheetPng) },
          { type: 'text', text: 'Full-resolution image of slide 3:' },
          { type: 'image', source: await inline(slidePng) },
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

  test('resume: --resume <id>, no --model when the model is empty, reported session id wins', FAKE_CLI, async () => {
    const out = await run(claudeCodeProvider, { resume: { cliSessionId: 'sess-123' } });
    assert.ifError(out.error);
    const rec = record();
    assert.deepEqual(rec.argv.slice(-2), ['--resume', 'sess-123']);
    assert.ok(!rec.argv.includes('--model'));
    assert.ok(!rec.argv.includes('--session-id'));
    assert.deepEqual(out.result?.resume, { cliSessionId: 'sess-123-next' });
  });

  test('falls back to result.result when no deltas were streamed', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'no-deltas';
    const out = await run(claudeCodeProvider);
    assert.ifError(out.error);
    assert.equal(out.result?.text, '최종 답변');
    assert.deepEqual(out.deltas, ['최종 답변']);
  });

  test('is_error result rejects with the CLI message', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'is_error';
    const out = await run(claudeCodeProvider);
    assert.ok(out.error);
    assert.match(out.error.message, /Invalid API key/);
    assert.match(out.error.message, /로그인/);
  });

  test('non-zero exit rejects with the stderr tail', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'exit1';
    const out = await run(claudeCodeProvider);
    assert.ok(out.error);
    assert.match(out.error.message, /exit code 1/);
    assert.match(out.error.message, /fatal: something went badly wrong/);
  });

  test('abort kills the child and rejects with AbortError', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const out = await run(claudeCodeProvider, {}, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
    assert.deepEqual(out.deltas, ['부분 답변']);
    assertDead(record().pid);
  });

  test('abort escalates to SIGKILL when SIGTERM is ignored', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'hang-ignore-term';
    const started = Date.now();
    const out = await run(claudeCodeProvider, {}, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
    assert.ok(Date.now() - started >= 2_900, 'waited for the grace period');
    assertDead(record().pid);
  });

  test('detect reports the version, or unavailability', FAKE_CLI, async () => {
    assert.deepEqual(await claudeCodeProvider.detect(), { available: true, version: '9.9.9 (Claude Code fake)' });
    process.env.CLAUDE_BIN = path.join(workDir, 'missing-claude');
    const missing = await claudeCodeProvider.detect();
    assert.equal(missing.available, false);
    assert.match(missing.reason ?? '', /찾을 수 없습니다/);
  });

  test('claudeEnv: memory-saving defaults unless the user set them; no CLAUDECODE, no API key', () => {
    assert.deepEqual(CLAUDE_CHILD_ENV_DEFAULTS, {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      MIMALLOC_PURGE_DELAY: '0',
    });
    process.env.CLAUDECODE = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    let env = claudeEnv();
    for (const [key, value] of Object.entries(CLAUDE_CHILD_ENV_DEFAULTS)) assert.equal(env[key], value, key);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    process.env.MIMALLOC_PURGE_DELAY = '500';
    process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '';
    process.env.EASY_STUDY_CLAUDE_USE_API_KEY = '1';
    env = claudeEnv();
    assert.equal(env.MIMALLOC_PURGE_DELAY, '500', "the user's value wins");
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, '', 'an empty value is still a setting of the user');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
    // Every image stays in the CLI conversation and is resent each turn: roll over sooner than the API providers.
    assert.equal(claudeCodeProvider.maxImagesPerConversation, 48);
  });

  test('claudeArgs generates a session id when none is given', () => {
    const args = claudeArgs({ systemPrompt: 's', model: '' });
    assert.equal(args[args.length - 2], '--session-id');
    assert.match(args[args.length - 1], UUID_RE);
  });

  test('ephemeral: --no-session-persistence without --session-id; the reported session id is returned', FAKE_CLI, async () => {
    const out = await run(claudeCodeProvider, { ephemeral: true, model: 'haiku' });
    assert.ifError(out.error);
    const rec = record();
    assert.deepEqual(rec.argv.slice(-3), ['--model', 'haiku', '--no-session-persistence']);
    assert.ok(!rec.argv.includes('--session-id'));
    assert.ok(!rec.argv.includes('--resume'));
    assert.deepEqual(out.result?.resume, { cliSessionId: 'fake-ephemeral-session' });
    assert.equal(out.result?.text, '안녕 세계\n\n두 번째 블록');
  });

  test('ephemeral without a reported session id resolves with an empty resume handle', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'no-session-id';
    const out = await run(claudeCodeProvider, { ephemeral: true });
    assert.ifError(out.error);
    assert.deepEqual(out.result?.resume, {});
  });

  test('extraReadDirs: one --add-dir per existing directory (deduplicated), before the session flags', FAKE_CLI, async () => {
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

  test('allowTools: false runs without any tool (--tools "") and without --add-dir', FAKE_CLI, async () => {
    const other = path.join(workDir, 'lectures', 'l6');
    fs.mkdirSync(other, { recursive: true });
    const out = await run(claudeCodeProvider, { allowTools: false, ephemeral: true, extraReadDirs: [other] });
    assert.ifError(out.error);
    const argv = record().argv;
    const at = argv.indexOf('--tools');
    assert.deepEqual(argv.slice(at, at + 3), ['--tools', '', '--strict-mcp-config']);
    assert.ok(!argv.includes('--add-dir'));
    // Tutoring keeps the read-only tools.
    const tutor = claudeArgs({ systemPrompt: 's', model: '' });
    assert.deepEqual(tutor.slice(tutor.indexOf('--tools'), tutor.indexOf('--tools') + 2), ['--tools', CLAUDE_TOOLS]);
  });

  test('a --resume of a CLI session that no longer exists is resume_invalid (result event or stderr)', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'resume-missing';
    let out = await run(claudeCodeProvider, { resume: { cliSessionId: 'gone-1' } });
    assert.ok(out.error instanceof ProviderError);
    assert.equal(providerErrorKind(out.error), 'resume_invalid');
    assert.match(out.error.message, /No conversation found with session ID: gone-1/);
    assert.match(out.error.message, /새 대화/);
    assert.deepEqual(out.deltas, []);

    process.env.FAKE_CLI_MODE = 'resume-missing-stderr';
    out = await run(claudeCodeProvider, { resume: { cliSessionId: 'gone-2' } });
    assert.equal(providerErrorKind(out.error), 'resume_invalid');
    assert.match(out.error?.message ?? '', /exit code 1/);
    assert.match(out.error?.message ?? '', /gone-2/);
  });

  test('size, model and login failures are classified', FAKE_CLI, async () => {
    const failure = async (mode: string) => {
      process.env.FAKE_CLI_MODE = mode;
      const out = await run(claudeCodeProvider, { resume: { cliSessionId: 's-1' } });
      return { kind: providerErrorKind(out.error), message: out.error?.message ?? '' };
    };
    let f = await failure('prompt-too-long');
    assert.equal(f.kind, 'context_overflow');
    assert.match(f.message, /Prompt is too long/);
    assert.equal((await failure('request-too-large')).kind, 'context_overflow');
    f = await failure('model-unavailable');
    assert.equal(f.kind, 'model_unavailable');
    assert.match(f.message, /claude update/);
    assert.equal((await failure('model-needs-update')).kind, 'model_unavailable');
    f = await failure('is_error');
    assert.equal(f.kind, 'auth');
    assert.match(f.message, /로그인/);
    assert.equal((await failure('exit1')).kind, 'other');
  });

  test('classifyClaudeFailure: "No conversation found" only means a lost session when resuming', () => {
    assert.equal(classifyClaudeFailure('No conversation found with session ID: x', true), 'resume_invalid');
    assert.equal(classifyClaudeFailure('No conversation found with session ID: x', false), 'other');
    assert.equal(
      classifyClaudeFailure('API Error: 400 input length and `max_tokens` exceed context limit: 190000 + 64000 > 200000', false),
      'context_overflow',
    );
    assert.equal(classifyClaudeFailure('Not logged in · Please run /login', false), 'auth');
    assert.equal(classifyClaudeFailure('Credit balance is too low', false), 'other');
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

  test('new conversation: exact argv (reads confined to the document), instructions + image markers on stdin', FAKE_CLI, async () => {
    setServerSecrets();
    const out = await run(codexProvider, { model: 'gpt-5-codex' });
    assert.ifError(out.error);
    const rec = record();
    assertNoServerSecrets(rec.env);
    assert.deepEqual(rec.argv, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      workDir,
      ...codexConfined(workDir),
      ...CODEX_HARDENING,
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

  test("resume: 'exec resume <id> -', sandbox and profile via -c, no -C, no -m, no instructions", FAKE_CLI, async () => {
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
      ...codexConfined(workDir),
      ...CODEX_HARDENING,
      '-i',
      slidePng,
    ]);
    assert.doesNotMatch(rec.stdin, /<instructions>/);
    assert.match(rec.stdin, /\[Attached image #1: Slide 3\]/);
    assert.deepEqual(out.result?.resume, { cliSessionId: 'thread-42' });
  });

  test('turn.failed rejects', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'turn-failed';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /stream disconnected before completion/);
  });

  test('an error event without a completed turn rejects', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'error';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /401 Unauthorized/);
    assert.match(out.error?.message ?? '', /codex login/);
  });

  test('an error event followed by a completed turn is not fatal', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'error-recovered';
    const out = await run(codexProvider);
    assert.ifError(out.error);
    assert.equal(out.result?.text, '최종 답변입니다.');
  });

  test('a stream that ends without turn.completed still delivers the last message', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'no-turn-completed';
    const out = await run(codexProvider);
    assert.ifError(out.error);
    assert.deepEqual(out.deltas, ['끝 이벤트 없는 답변']);
    assert.equal(out.result?.text, '끝 이벤트 없는 답변');
  });

  test('non-zero exit rejects with the stderr tail', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'exit1';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /fatal config error/);
  });

  test('a new conversation without a thread id is an error', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'no-thread';
    const out = await run(codexProvider);
    assert.match(out.error?.message ?? '', /thread id/);
  });

  test('abort kills the child and rejects with AbortError', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const out = await run(codexProvider, {}, undefined, (_t, controller) => controller.abort());
    assert.equal(out.error?.name, 'AbortError');
    assert.deepEqual(out.deltas, [], 'an unconfirmed message is never streamed as the answer');
    assert.equal(out.statuses[0], '부분');
    assertDead(record().pid);
  });

  test('ephemeral: --ephemeral on a new conversation; extraReadDirs become read roots of the profile', FAKE_CLI, async () => {
    const out = await run(codexProvider, { ephemeral: true, extraReadDirs: ['/library/other-lecture'] });
    assert.ifError(out.error);
    assert.deepEqual(record().argv, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C',
      workDir,
      ...codexConfined(workDir, '/library/other-lecture'),
      ...CODEX_HARDENING,
      '-i',
      sheetPng,
      '-i',
      slidePng,
    ]);
    assert.deepEqual(out.result?.resume, { cliSessionId: 'thread-new-1' });
  });

  test('ephemeral runs do not need a thread id', FAKE_CLI, async () => {
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
      '-C',
      '/d',
      ...codexConfined('/d'),
      ...CODEX_HARDENING,
    ]);
    assert.ok(
      !codexArgs({ cwd: '/d', model: '', images: [], threadId: 't', ephemeral: true }).includes('--ephemeral'),
      '--ephemeral is only passed when starting a conversation',
    );
    const { prompt, images } = codexPrompt([{ type: 'text', text: 'only text' }], null);
    assert.equal(prompt, 'only text');
    assert.deepEqual(images, []);
  });

  test('detect reports the version', FAKE_CLI, async () => {
    assert.deepEqual(await codexProvider.detect(), { available: true, version: 'codex-cli 9.9.9' });
  });

  test('allowTools: false also disables the shell and the other tools; tutoring keeps the shell', () => {
    const digest = codexArgs({ cwd: '/d', model: '', images: [], allowTools: false, ephemeral: true });
    for (const feature of [...CODEX_DISABLED_INTEGRATIONS, ...CODEX_DISABLED_TOOLS]) {
      const at = digest.indexOf(`features.${feature}=false`);
      assert.ok(at > 0 && digest[at - 1] === '-c', feature);
    }
    for (const feature of ['shell_tool', 'unified_exec', 'view_image']) assert.ok(CODEX_DISABLED_TOOLS.includes(feature));
    for (const feature of ['plugins', 'apps', 'computer_use']) assert.ok(CODEX_DISABLED_INTEGRATIONS.includes(feature));
    const tutor = codexArgs({ cwd: '/d', model: '', images: [], threadId: 't-1' });
    assert.ok(!tutor.includes('features.shell_tool=false'));
    assert.ok(tutor.includes('features.plugins=false'));
  });

  test('read confinement: the profile lists :minimal, cwd and the other lectures (absolute, deduplicated), never with --sandbox', () => {
    const args = codexArgs({
      cwd: '/lib/doc',
      model: '',
      images: [],
      readDirs: ['/lib/l5', '/lib/l5/', 'relative/dir', '/lib/doc', ''],
    });
    assert.ok(!args.includes('--sandbox'), 'the --sandbox flag would override the profile');
    const at = args.indexOf(`default_permissions="${CODEX_PERMISSION_PROFILE}"`);
    assert.ok(at > 0 && args[at - 1] === '-c');
    assert.equal(args[at + 1], '-c');
    assert.equal(
      args[at + 2],
      `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={":minimal"="read","/lib/doc"="read","/lib/l5"="read"}`,
    );
    // Kept as the fallback for a CLI without permission profiles; no escalation either way.
    for (const override of ['sandbox_mode="read-only"', 'approval_policy="never"', 'approvals_reviewer="user"', 'project_root_markers=[]']) {
      const i = args.indexOf(override);
      assert.ok(i > 0 && args[i - 1] === '-c', override);
    }
    // The digest (no tools) is confined the same way.
    const digest = codexArgs({ cwd: '/lib/doc', model: '', images: [], allowTools: false, ephemeral: true });
    assert.ok(digest.includes(`permissions.${CODEX_PERMISSION_PROFILE}.filesystem={":minimal"="read","/lib/doc"="read"}`));
  });

  test('EASY_STUDY_CODEX_CONFINE=0: the legacy read-only sandbox without the profile, still without escalation', FAKE_CLI, async () => {
    assert.equal(codexConfinementEnabled(), process.platform !== 'win32');
    for (const off of ['0', 'off', 'false']) {
      process.env.EASY_STUDY_CODEX_CONFINE = off;
      assert.equal(codexConfinementEnabled(), false, off);
    }
    process.env.EASY_STUDY_CODEX_CONFINE = '0';
    const fresh = await run(codexProvider, { extraReadDirs: ['/library/other-lecture'] });
    assert.ifError(fresh.error);
    assert.deepEqual(record().argv, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      workDir,
      ...CODEX_NO_ESCALATION,
      ...CODEX_HARDENING,
      '-i',
      sheetPng,
      '-i',
      slidePng,
    ]);
    const resumed = await run(codexProvider, { resume: { cliSessionId: 'thread-7' }, parts: [{ type: 'text', text: 'Q' }] });
    assert.ifError(resumed.error);
    assert.deepEqual(record().argv, [
      'exec',
      'resume',
      'thread-7',
      '-',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="read-only"',
      ...CODEX_NO_ESCALATION,
      ...CODEX_HARDENING,
    ]);
  });

  test('tomlString / codexReadRootsToml write valid TOML basic strings for any path', () => {
    // For these escapes a TOML basic string is also a JSON string, so JSON.parse checks the round trip.
    for (const text of ['/a/b', 'with "quotes"', 'back\\slash', 'tab\tnew\nline', '\u0000\u001f\u007f', '/강의/자료 1', '😀 emoji']) {
      const toml = tomlString(text);
      assert.equal(JSON.parse(toml), text, text);
      assert.doesNotMatch(toml, /[\u0000-\u001f\u007f]/, 'no raw control characters');
    }
    assert.equal(tomlString('bad \ud800 surrogate'), '"bad \ufffd surrogate"');
    assert.equal(codexReadRootsToml(['/lib/a"b']), '{":minimal"="read","/lib/a\\"b"="read"}');
    assert.equal(codexReadRootsToml([]), '{":minimal"="read"}');
  });

  test('codexExecutable: the real path of the CLI (PATH lookup like the OS, symlinks resolved)', FAKE_CLI, async () => {
    const real = fs.realpathSync(FAKE_CODEX);
    const binDir = path.join(workDir, 'bin');
    const shadowDir = path.join(workDir, 'shadow');
    fs.mkdirSync(binDir);
    fs.mkdirSync(shadowDir);
    fs.symlinkSync(FAKE_CODEX, path.join(binDir, 'codex'));
    fs.writeFileSync(path.join(shadowDir, 'codex'), 'not executable');
    fs.chmodSync(path.join(shadowDir, 'codex'), 0o644);
    fs.mkdirSync(path.join(shadowDir, 'codex-dir-only'));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = [shadowDir, binDir, savedPath].join(path.delimiter);
      assert.equal(await codexExecutable('codex'), real, 'skips a non-executable file earlier on PATH');
      assert.equal(await codexExecutable('codex-dir-only'), 'codex-dir-only', 'a directory is not an executable');
      assert.equal(await codexExecutable('no-such-codex-here'), 'no-such-codex-here');
      assert.equal(await codexExecutable(path.join(binDir, 'codex')), real);
      assert.equal(await codexExecutable(path.join(workDir, 'missing', 'codex')), path.join(workDir, 'missing', 'codex'));
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test('the CLI is spawned by its real path, not through a symlink (Codex re-executes itself inside the sandbox)', FAKE_CLI, async () => {
    const link = path.join(workDir, 'codex-link');
    fs.symlinkSync(FAKE_CODEX, link);
    process.env.CODEX_BIN = link;
    const out = await run(codexProvider);
    assert.ifError(out.error);
    assert.equal(record().script, fs.realpathSync(FAKE_CODEX));
  });

  test('a session that cannot start under the permissions profile says how to turn the confinement off', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'sandbox-init-failed';
    const confined = await run(codexProvider);
    assert.ok(confined.error instanceof ProviderError);
    assert.equal(providerErrorKind(confined.error), 'other');
    assert.ok(confined.error.message.includes(CONFINEMENT_HINT), confined.error.message);
    assert.match(confined.error.message, /EASY_STUDY_CODEX_CONFINE=0/);
    assert.match(confined.error.message, /failed to load AGENTS\.md/);
    process.env.EASY_STUDY_CODEX_CONFINE = '0';
    const legacy = await run(codexProvider);
    assert.ok(legacy.error);
    assert.ok(!legacy.error.message.includes(CONFINEMENT_HINT));
    // Ordinary failures of a confined run get no such hint.
    delete process.env.EASY_STUDY_CODEX_CONFINE;
    process.env.FAKE_CLI_MODE = 'exit1';
    const other = await run(codexProvider);
    assert.ok(other.error && !other.error.message.includes(CONFINEMENT_HINT));
  });

  test("the MCP servers of the user's config.toml are disabled by name", FAKE_CLI, async () => {
    const home = process.env.CODEX_HOME!;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.node_repl]\ncommand = "node"\n\n[mcp_servers.node_repl.env]\nA = "1"\n\n[mcp_servers."computer-use"]\ncommand = "x"\n',
    );
    const out = await run(codexProvider, { allowTools: false, ephemeral: true });
    assert.ifError(out.error);
    const argv = record().argv;
    for (const override of ['mcp_servers.node_repl.enabled=false', 'mcp_servers.computer-use.enabled=false', 'features.shell_tool=false']) {
      const at = argv.indexOf(override);
      assert.ok(at > 0 && argv[at - 1] === '-c', override);
    }
    assert.equal(argv.filter((a) => a.startsWith('mcp_servers.')).length, 2);
  });

  test('codexMcpServerNames: tables, [mcp_servers] keys and dotted keys; not strings, comments or other tables', () => {
    const toml = [
      'mcp_servers.root_one.command = "a"',
      'notes = """',
      '[mcp_servers.inside_string]',
      '"""',
      '[mcp_servers]',
      'inline = { command = "b" }',
      '"quoted".command = "c"',
      '[mcp_servers.table-one]',
      'command = "d"',
      '[mcp_servers.table-one.env]',
      'KEY = "v"',
      '[profiles.p]',
      'mcp_servers = 1',
      '# [mcp_servers.commented]',
      '[mcp_servers."has.dot"]',
      '[[mcp_servers.array]]',
    ].join('\n');
    assert.deepEqual(codexMcpServerNames(toml).sort(), ['inline', 'quoted', 'root_one', 'table-one']);
    assert.deepEqual(codexMcpServerNames(''), []);
  });

  test('a resume that silently starts a new thread is resume_invalid, and nothing is streamed', FAKE_CLI, async () => {
    process.env.FAKE_CLI_MODE = 'resume-new-thread';
    const out = await run(codexProvider, { resume: { cliSessionId: 'thread-old' } });
    assert.ok(out.error instanceof ProviderError);
    assert.equal(providerErrorKind(out.error), 'resume_invalid');
    assert.match(out.error.message, /thread-old/);
    assert.deepEqual(out.deltas, []);
    // A new conversation may report any thread id.
    const fresh = await run(codexProvider);
    assert.ifError(fresh.error);
    assert.deepEqual(fresh.result?.resume, { cliSessionId: 'thread-new-1' });
  });

  test('a missing thread, context overflow, login and model errors are classified', FAKE_CLI, async () => {
    const failure = async (mode: string, resume: string | null) => {
      process.env.FAKE_CLI_MODE = mode;
      const out = await run(codexProvider, { resume: resume ? { cliSessionId: resume } : null });
      return { kind: providerErrorKind(out.error), message: out.error?.message ?? '' };
    };
    let f = await failure('resume-missing', 'thread-gone');
    assert.equal(f.kind, 'resume_invalid');
    assert.match(f.message, /thread not found: thread-gone/);
    assert.equal((await failure('resume-missing', null)).kind, 'other', 'only a resumed call can lose its thread');
    f = await failure('context-overflow', 'thread-1');
    assert.equal(f.kind, 'context_overflow');
    assert.match(f.message, /ran out of room/);
    f = await failure('error', 'thread-1');
    assert.equal(f.kind, 'auth');
    assert.match(f.message, /codex login/);
    assert.equal((await failure('model-unsupported', null)).kind, 'model_unavailable');
    assert.equal((await failure('turn-failed', 'thread-1')).kind, 'other');
  });

  test('classifyCodexFailure', () => {
    assert.equal(classifyCodexFailure('no rollout found for thread id 0199', true), 'resume_invalid');
    assert.equal(classifyCodexFailure('No saved session found with ID 0199.', true), 'resume_invalid');
    assert.equal(classifyCodexFailure('stream error: context_length_exceeded', false), 'context_overflow');
    assert.equal(classifyCodexFailure('Your access token could not be refreshed. Please log out and sign in again.', false), 'auth');
    assert.equal(classifyCodexFailure('This model requires a newer version of Codex.', false), 'model_unavailable');
    assert.equal(classifyCodexFailure('stream disconnected before completion', true), 'other');
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
      source: await inline(sheetPng),
      cache_control: { type: 'ephemeral' },
    });
    assert.equal(first.content[1].source.media_type, 'image/jpeg', 'images are re-encoded as JPEG');
    assert.equal(first.content[0].cache_control, undefined);
    assert.deepEqual(second.content, [{ type: 'text', text: '개요' }]);
    assert.equal(current.content.length, 5);
    assert.deepEqual(current.content[3].source, await inline(slidePng));
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

  test('a server-side fallback keeps the partial answer, which the fallback model continues', () => {
    const deltas: string[] = [];
    const statuses: string[] = [];
    const state = new AnthropicStreamState((t) => deltas.push(t), (t) => statuses.push(t));
    const events: any[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First half of the explanation, ' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'second half.' } },
      { type: 'content_block_stop', index: 2 },
      // A later text block of the same model is still a new paragraph.
      { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'P.S.' } },
    ];
    for (const event of events) state.handle(event);
    assert.equal(state.text, 'First half of the explanation, second half.\n\nP.S.');
    assert.equal(deltas.join(''), state.text, 'the saved text equals what was streamed');
    assert.deepEqual(statuses, ['다른 모델이 이어서 답변하는 중…']);
  });

  test('API errors are classified: 413 / prompt too long → context_overflow, unknown model, login', async () => {
    const respond = (status: number, type: string, message: string) => {
      handler = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type, message } }));
      };
    };
    const history: ProviderRunInput['history'] = [
      { role: 'user', parts: [{ type: 'text', text: 'deck' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '개요' }] },
    ];
    const failure = async () => {
      const out = await run(anthropicApiProvider, { history, resume: {} });
      return { kind: providerErrorKind(out.error), message: out.error?.message ?? '' };
    };
    respond(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.');
    assert.equal((await failure()).kind, 'context_overflow');
    respond(400, 'invalid_request_error', 'prompt is too long: 212000 tokens > 200000 maximum');
    const f = await failure();
    assert.equal(f.kind, 'context_overflow');
    assert.match(f.message, /prompt is too long/);
    respond(404, 'not_found_error', 'model: claude-nope');
    assert.equal((await failure()).kind, 'model_unavailable');
    respond(401, 'authentication_error', 'invalid x-api-key');
    assert.equal((await failure()).kind, 'auth');
    respond(400, 'invalid_request_error', 'messages: roles must alternate between "user" and "assistant"');
    assert.equal((await failure()).kind, 'other');
    assert.equal(classifyAnthropicError(400, 'input length and `max_tokens` exceed context limit'), 'context_overflow');
    assert.equal(classifyAnthropicError(403, 'Access to this model requires an access grant'), 'model_unavailable');
  });

  test('a continued conversation too large for the model fails before calling the API', async () => {
    handler = (_req, res) => sse(res, anthropicEvents());
    const history: ProviderRunInput['history'] = [
      { role: 'user', parts: [{ type: 'text', text: 'x'.repeat(700_000) }] }, // ~200K tokens
      { role: 'assistant', parts: [{ type: 'text', text: '개요' }] },
    ];
    const out = await run(anthropicApiProvider, { history, resume: {}, model: 'claude-haiku-4-5' });
    assert.equal(providerErrorKind(out.error), 'context_overflow');
    assert.match(out.error?.message ?? '', /200K/);
    assert.equal(requests.length, 0, 'nothing was sent');
    // The same conversation fits a model with a 1M-token window.
    const ok = await run(anthropicApiProvider, { history, resume: {}, model: 'claude-opus-5' });
    assert.ifError(ok.error);
    assert.equal(requests.length, 1);
  });

  test('checkAnthropicRequest: bytes are always checked, the token estimate only for a continued conversation', () => {
    const params = (content: any[], model = 'claude-haiku-4-5') =>
      ({ model, max_tokens: 10, system: 's', messages: [{ role: 'user', content }] }) as any;
    const text = (n: number) => [{ type: 'text', text: 'x'.repeat(n) }];
    const isOverflow = (err: unknown) => providerErrorKind(err) === 'context_overflow';
    assert.doesNotThrow(() => checkAnthropicRequest(params(text(10)), true));
    assert.doesNotThrow(() => checkAnthropicRequest(params(text(700_000)), false), 'a first turn is left to the API');
    assert.throws(() => checkAnthropicRequest(params(text(700_000)), true), isOverflow);
    assert.doesNotThrow(() => checkAnthropicRequest(params(text(700_000), 'claude-sonnet-5'), true));
    const images = (n: number) => Array.from({ length: n }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AA' } }));
    assert.doesNotThrow(() => checkAnthropicRequest(params(images(90)), true));
    assert.throws(() => checkAnthropicRequest(params(images(120)), true), isOverflow);
    assert.throws(
      () => checkAnthropicRequest(params(text(MAX_REQUEST_BYTES + 1), 'claude-opus-5'), false),
      (err: Error) => isOverflow(err) && /32 MB/.test(err.message),
    );
    assert.equal(anthropicContextWindow('claude-haiku-4-5'), 200_000);
    assert.equal(anthropicContextWindow('claude-opus-5'), 1_000_000);
    assert.equal(anthropicContextWindow('claude-opus-4-8'), 1_000_000);
    assert.equal(anthropicContextWindow('some-gateway-model'), 200_000);
  });

  test('stop_reason model_context_window_exceeded: context_overflow without an answer, else the partial answer', async () => {
    const history: ProviderRunInput['history'] = [
      { role: 'user', parts: [{ type: 'text', text: 'deck' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '개요' }] },
    ];
    handler = (_req, res) => sse(res, anthropicEvents('model_context_window_exceeded', []));
    const empty = await run(anthropicApiProvider, { history, resume: {} });
    assert.equal(providerErrorKind(empty.error), 'context_overflow');
    handler = (_req, res) => sse(res, anthropicEvents('model_context_window_exceeded', ['부분']));
    const partial = await run(anthropicApiProvider, { history, resume: {} });
    assert.ifError(partial.error);
    assert.equal(partial.result?.text, '부분');
    assert.ok(partial.statuses.some((s) => /컨텍스트/.test(s)));
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
    const sheet = await inline(sheetPng);
    assert.deepEqual(body.input[0].content[1], {
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${sheet.data}`,
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

  test('an expired previous_response_id is resume_invalid (400 or 404); overflow, model and login errors', async () => {
    const respond = (status: number, error: Record<string, unknown>) => {
      handler = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', param: null, code: null, ...error } }));
      };
    };
    const failure = async (resume: string | null) => {
      const out = await run(openaiApiProvider, { resume: resume ? { previousResponseId: resume } : null });
      assert.ok(out.error instanceof ProviderError, String(out.error));
      return { kind: providerErrorKind(out.error), message: out.error.message };
    };
    respond(400, { message: "Previous response with id 'resp_1' not found.", param: 'previous_response_id', code: 'previous_response_not_found' });
    let f = await failure('resp_1');
    assert.equal(f.kind, 'resume_invalid');
    assert.match(f.message, /만료/);
    respond(404, { message: "Previous response with id 'resp_1' not found." });
    assert.equal((await failure('resp_1')).kind, 'resume_invalid');
    respond(400, {
      message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
      param: 'input',
      code: 'context_length_exceeded',
    });
    assert.equal((await failure('resp_1')).kind, 'context_overflow');
    respond(404, { message: 'The model `gpt-nope` does not exist or you do not have access to it.', code: 'model_not_found' });
    f = await failure(null);
    assert.equal(f.kind, 'model_unavailable');
    respond(401, { message: 'Incorrect API key provided.', code: 'invalid_api_key' });
    f = await failure(null);
    assert.equal(f.kind, 'auth');
    assert.match(f.message, /OPENAI_API_KEY/);
    respond(400, { message: 'Invalid value for temperature.' });
    assert.equal((await failure(null)).kind, 'other');
  });

  test('a response.failed event with context_length_exceeded is context_overflow', async () => {
    handler = (_req, res) =>
      sse(res, [
        openaiEvents()[0],
        [
          'response.failed',
          {
            type: 'response.failed',
            sequence_number: 1,
            response: { id: 'resp_2', status: 'failed', error: { code: 'context_length_exceeded', message: 'Input too long.' } },
          },
        ],
      ]);
    const out = await run(openaiApiProvider, { resume: { previousResponseId: 'resp_1' } });
    assert.equal(providerErrorKind(out.error), 'context_overflow');
  });

  test('classifyOpenAIError: a previous-response error only means a lost conversation when continuing one', () => {
    const lost = { status: 404, message: "Previous response with id 'resp_1' not found." };
    assert.equal(classifyOpenAIError(lost, true), 'resume_invalid');
    assert.notEqual(classifyOpenAIError(lost, false), 'resume_invalid');
    assert.equal(classifyOpenAIError({ status: 413, message: 'Request Entity Too Large' }, true), 'context_overflow');
    assert.equal(classifyOpenAIError({ status: 429, message: 'Rate limit reached' }, true), 'other');
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('provider registry', () => {
  test('lists the four providers and their availability (never throws)', FAKE_CLI, async () => {
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

describe('attachments in provider requests (DESIGN §21)', () => {
  let attachDir = '';
  before(() => {
    attachDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-study-attach-provider-')), 'doc-abc123', 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
  });
  after(() => fs.rmSync(path.dirname(path.dirname(attachDir)), { recursive: true, force: true }));

  test('loadInlineImage sends an attachment as stored, with its own media type (never re-encoded)', async () => {
    clearInlineImageCache();
    // Larger than the inline limits on purpose: re-encoding would have made a downscaled JPEG of it.
    const wide = await sharp({ create: { width: 2000, height: 20, channels: 3, background: '#224466' } }).png().toBuffer();
    const pngFile = path.join(attachDir, 'att-00000000000000a1.png');
    const jpgFile = path.join(attachDir, 'att-00000000000000b2.jpg');
    fs.writeFileSync(pngFile, wide);
    fs.writeFileSync(jpgFile, 'stored jpeg bytes');
    assert.deepEqual(await loadInlineImage(pngFile), { mediaType: 'image/png', data: wide.toString('base64') });
    assert.deepEqual(await loadInlineImage(jpgFile), { mediaType: 'image/jpeg', data: Buffer.from('stored jpeg bytes').toString('base64') });
    await assert.rejects(loadInlineImage(path.join(attachDir, 'att-00000000000000ff.png')), /읽을 수 없습니다/);
  });

  test('anthropic-api: attachments are image blocks, and the preflight counts each of them', async () => {
    const pngFile = path.join(attachDir, 'att-00000000000000a1.png');
    const jpgFile = path.join(attachDir, 'att-00000000000000b2.jpg');
    const text: Part = { type: 'text', text: 'The student attached 2 images to this question:' };
    const withAttachments = await buildAnthropicRequest({
      systemPrompt: 's',
      parts: [
        text,
        { type: 'image', path: pngFile, detail: 'high', label: 'Attachment 1: the region of slide 3 the student selected' },
        { type: 'image', path: jpgFile, detail: 'high', label: 'Attachment 2: an image from the student' },
      ],
      history: [],
      model: 'claude-haiku-4-5',
    });
    const blocks = withAttachments.messages[0].content as any[];
    assert.deepEqual(
      blocks.filter((b) => b.type === 'image').map((b) => b.source.media_type),
      ['image/png', 'image/jpeg'],
    );
    const without = await buildAnthropicRequest({ systemPrompt: 's', parts: [text], history: [], model: 'claude-haiku-4-5' });
    assert.equal(estimateAnthropicInputTokens(withAttachments) - estimateAnthropicInputTokens(without), 2 * 1_600);
  });
});
