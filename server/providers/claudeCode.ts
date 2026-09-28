// claude-code provider: the user's Claude subscription through the Claude Code CLI (DESIGN §6).
//
//   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
//          --system-prompt <prompt> --tools (Read,Glob,Grep | "") --strict-mcp-config [--add-dir <dir> ...]
//          [--model <model>] [--effort <level>] (--session-id <new uuid> | --resume <cliSessionId> | --no-session-persistence)
//
// The user turn (text + base64 images, re-encoded as compact JPEGs: the CLI resends the whole
// conversation to the Messages API, which has a 32 MB request limit) is written to stdin as one
// stream-json line. The read-only tools let the model open slide files and, with `--add-dir`, other
// lectures of the same course; calls that need no tools (ProviderRunInput.allowTools === false, e.g.
// digest batches) get none. One-shot (ephemeral) calls do not persist a CLI session. The reasoning effort
// (CLAUDE_EFFORTS, as `claude --help` lists them) is passed on every call, resumed ones included.
//
// Failures are classified (ProviderError): a --resume whose CLI session no longer exists is
// 'resume_invalid', "Prompt is too long" / "Request too large" is 'context_overflow', login problems
// are 'auth', an unknown model or a CLI too old for it is 'model_unavailable'.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  Part,
  Provider,
  ProviderAvailability,
  ProviderErrorKind,
  ProviderRunInput,
  ProviderRunResult,
} from './types.ts';
import { ProviderError, effortOption } from './types.ts';
import {
  childEnv,
  describeExit,
  loadInlineImage,
  probeVersion,
  resolveBin,
  runJsonlProcess,
  stderrSuffix,
} from './proc.ts';
import type { CliBinSpec, JsonObject } from './proc.ts';

/** Read-only tools the CLI may use (to open slide PNGs it has not been shown). */
export const CLAUDE_TOOLS = 'Read,Glob,Grep';

/** `claude --effort <level>` levels (claude 2.1.x), weakest first. */
export const CLAUDE_EFFORTS = [
  effortOption('low', '빠르게, 가볍게 생각해요'),
  effortOption('medium', '속도와 깊이의 균형'),
  effortOption('high', '복잡한 내용을 더 깊이 생각해요'),
  effortOption('xhigh', '더 깊이 생각해요 (느려지고 사용량이 늘어요)'),
  effortOption('max', '가장 깊이 생각해요 (가장 느리고 사용량이 가장 많아요)'),
];

export interface ClaudeArgsInput {
  systemPrompt: string;
  model: string;
  /** '' / omitted = the CLI's default effort. */
  effort?: string;
  /** New conversation: the session id we pick. */
  sessionId?: string;
  /** Continued conversation: the CLI session id to resume. */
  resumeId?: string;
  /** One-shot call: --no-session-persistence and no --session-id. */
  ephemeral?: boolean;
  /** Extra readable directories (one --add-dir each; ignored without tools). */
  addDirs?: string[];
  /** false = no tools at all (`--tools ""`). Defaults to true (CLAUDE_TOOLS). */
  allowTools?: boolean;
}

export function claudeArgs(input: ClaudeArgsInput): string[] {
  const tools = input.allowTools !== false;
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--system-prompt',
    input.systemPrompt,
    '--tools',
    tools ? CLAUDE_TOOLS : '',
    '--strict-mcp-config',
  ];
  // --add-dir is variadic in the CLI: every value is followed by another option, never a positional.
  if (tools) for (const dir of uniqueDirs(input.addDirs)) args.push('--add-dir', dir);
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.ephemeral) args.push('--no-session-persistence');
  if (input.resumeId) args.push('--resume', input.resumeId);
  else if (!input.ephemeral) args.push('--session-id', input.sessionId ?? randomUUID());
  return args;
}

function uniqueDirs(dirs: string[] | undefined): string[] {
  return [...new Set((dirs ?? []).filter((dir) => typeof dir === 'string' && dir.trim() !== ''))];
}

/** The directories that exist (a lecture removed from disk must not make the CLI call fail). */
async function existingDirs(dirs: string[] | undefined): Promise<string[]> {
  const candidates = uniqueDirs(dirs);
  const exists = await Promise.all(
    candidates.map((dir) =>
      stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      ),
    ),
  );
  return candidates.filter((_, i) => exists[i]);
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** The stream-json stdin line for one user turn (without the trailing newline). */
export async function claudeUserMessage(parts: Part[]): Promise<string> {
  const content: ClaudeContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) content.push({ type: 'text', text: part.text });
    } else {
      const image = await loadInlineImage(part.path);
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
    }
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

export interface ClaudeResultEvent {
  isError: boolean;
  subtype: string;
  text: string;
  sessionId?: string;
}

/**
 * Stateful interpreter of the CLI's stream-json events. Text deltas are forwarded as they arrive
 * (thinking is not); separate text blocks are joined with a blank line.
 */
export class ClaudeStreamState {
  text = '';
  sawDelta = false;
  result: ClaudeResultEvent | null = null;

  private readonly cwd: string;
  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;
  private messageSeq = 0;
  private lastTextBlock: string | null = null;
  private readonly seenTools = new Set<string>();

  constructor(cwd: string, onDelta: (text: string) => void, onStatus: (text: string) => void) {
    this.cwd = cwd;
    this.onDelta = onDelta;
    this.onStatus = onStatus;
  }

  handle(event: JsonObject): void {
    switch (event.type) {
      case 'stream_event':
        this.handleStreamEvent(asObject(event.event));
        break;
      case 'assistant':
        this.handleAssistant(asObject(event.message));
        break;
      case 'result':
        this.result = {
          isError: event.is_error === true,
          subtype: typeof event.subtype === 'string' ? event.subtype : '',
          text: typeof event.result === 'string' ? event.result : '',
          sessionId: typeof event.session_id === 'string' && event.session_id ? event.session_id : undefined,
        };
        break;
      default:
        break;
    }
  }

  private handleStreamEvent(e: JsonObject): void {
    if (e.type === 'message_start') {
      this.messageSeq += 1;
      return;
    }
    if (e.type === 'content_block_start') {
      const block = asObject(e.content_block);
      if (block.type === 'thinking' || block.type === 'redacted_thinking') this.onStatus('생각하는 중…');
      return;
    }
    if (e.type !== 'content_block_delta') return;
    const delta = asObject(e.delta);
    if (delta.type !== 'text_delta' || typeof delta.text !== 'string' || !delta.text) return;

    // A new (message, block index) pair means a new text block: separate it from the previous one.
    const key = `${this.messageSeq}:${typeof e.index === 'number' ? e.index : 0}`;
    let chunk = delta.text;
    if (this.lastTextBlock !== null && key !== this.lastTextBlock && this.text) {
      chunk = blockSeparator(this.text) + chunk;
    }
    this.lastTextBlock = key;
    this.text += chunk;
    this.sawDelta = true;
    this.onDelta(chunk);
  }

  private handleAssistant(message: JsonObject): void {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const block = asObject(raw);
      if (block.type !== 'tool_use') continue;
      const id = typeof block.id === 'string' ? block.id : JSON.stringify(block);
      if (this.seenTools.has(id)) continue;
      this.seenTools.add(id);
      this.onStatus(toolStatus(String(block.name ?? ''), asObject(block.input), this.cwd));
    }
  }
}

/** Status line for a tool call, e.g. "파일 읽는 중: slides/012.png". */
export function toolStatus(name: string, input: JsonObject, cwd: string): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read':
      return `파일 읽는 중: ${displayPath(str(input.file_path) || str(input.path), cwd)}`;
    case 'Glob':
      return `파일 찾는 중: ${str(input.pattern)}`;
    case 'Grep':
      return `텍스트 검색 중: ${str(input.pattern)}`;
    default:
      return `도구 사용 중: ${name || '알 수 없음'}`;
  }
}

/** Path relative to the doc dir when it is inside it or in a sibling doc dir (another lecture). */
function displayPath(file: string, cwd: string): string {
  if (!file) return '(알 수 없음)';
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file).split(path.sep).join('/');
  if (!rel || path.isAbsolute(rel)) return file;
  const levelsUp = rel.split('/').filter((segment) => segment === '..').length;
  return levelsUp <= 1 ? rel : file;
}

function blockSeparator(previous: string): string {
  if (previous.endsWith('\n\n')) return '';
  return previous.endsWith('\n') ? '\n' : '\n\n';
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * Settings every CLI child gets unless the user's environment sets them (DESIGN §15). Measured with
 * claude 2.1.280: the first two only work as a pair (-27 MB footprint idle, -14 MB on a real turn, and the
 * process exits ~0.7 s sooner without the telemetry flush); the app needs neither the non-essential
 * traffic (telemetry, update checks, feature flags) nor claude.ai connectors (it passes
 * --strict-mcp-config). MIMALLOC_PURGE_DELAY=0 makes the CLI's allocator return freed pages at once
 * (about -30 MB footprint on a resumed 90-image conversation).
 */
export const CLAUDE_CHILD_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  MIMALLOC_PURGE_DELAY: '0',
};

/**
 * Environment for the CLI: CLAUDE_CHILD_ENV_DEFAULTS where not set. ANTHROPIC_API_KEY is removed by
 * default: when it is set, Claude Code bills that API key instead of the user's subscription, which is
 * what this provider is for. Set EASY_STUDY_CLAUDE_USE_API_KEY=1 to keep it.
 */
export function claudeEnv(): NodeJS.ProcessEnv {
  const env = process.env.EASY_STUDY_CLAUDE_USE_API_KEY === '1' ? childEnv() : childEnv(['ANTHROPIC_API_KEY']);
  for (const [key, value] of Object.entries(CLAUDE_CHILD_ENV_DEFAULTS)) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

/**
 * The claude executable (CLAUDE_BIN overrides it). An npm global install on Windows puts a claude.cmd shim
 * next to node_modules; the package's bin is the native bin/claude.exe that its postinstall copies from
 * the platform package (a small stub until then, which resolveBin skips).
 */
export const CLAUDE_BIN_SPEC: CliBinSpec = {
  name: 'claude',
  envVar: 'CLAUDE_BIN',
  npmShimTargets: (shimDir, arch) => {
    const pkg = path.win32.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code');
    const platformPkg = ['@anthropic-ai', `claude-code-win32-${arch === 'arm64' ? 'arm64' : 'x64'}`, 'claude.exe'];
    return [
      path.win32.join(pkg, 'bin', 'claude.exe'),
      path.win32.join(pkg, 'node_modules', ...platformPkg),
      path.win32.join(shimDir, 'node_modules', ...platformPkg),
    ];
  },
};

/** How to install Claude Code: the native installer (on Windows an npm install only gives a .cmd shim). */
export function claudeInstallHint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'Claude Code 설치 (PowerShell): irm https://claude.ai/install.ps1 | iex  또는  winget install Anthropic.ClaudeCode'
    : 'Claude Code 설치: curl -fsSL https://claude.ai/install.sh | bash  (또는 npm install -g @anthropic-ai/claude-code)';
}

function loginHint(message: string): string {
  return /login|log in|api key|auth|credential|401|403/i.test(message)
    ? '\n터미널에서 `claude` 를 실행해 로그인 상태를 확인하세요.'
    : '';
}

/**
 * Kind of a Claude Code failure from its messages (result text, stderr). `resumed` = the call passed
 * --resume, so "No conversation found" means that CLI session is gone (deleted transcripts, a moved
 * library, Claude Code's cleanupPeriodDays).
 */
export function classifyClaudeFailure(text: string, resumed: boolean): ProviderErrorKind {
  if (resumed && /No conversation found|No message found with message\.uuid/i.test(text)) return 'resume_invalid';
  if (
    /prompt is too long|input is too long for requested model|request too large|request_too_large|exceed context limit|context window exceeded|model_context_window_exceeded/i.test(
      text,
    )
  ) {
    return 'context_overflow';
  }
  if (
    /issue with the selected model|model_not_found|may not exist or you may not have access|is not available on your .{0,40}deployment|does not support (?:this|the) model|(?:requires|needs) a newer version of Claude Code|not_found_error.{0,40}model/i.test(
      text,
    )
  ) {
    return 'model_unavailable';
  }
  if (
    /not logged in|please run \/login|invalid api key|invalid auth token|failed to authenticate|authentication_error|oauth token|oauth authentication|api error:?\s*40[13]\b/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  return 'other';
}

const KIND_HINTS: Partial<Record<ProviderErrorKind, string>> = {
  resume_invalid: '\n이전 Claude Code 대화(세션)를 더 이상 찾을 수 없습니다. 새 대화로 다시 시작해야 합니다.',
  context_overflow: '\n대화가 모델이 한 번에 받을 수 있는 크기를 넘었습니다. 새 대화로 이어가야 합니다.',
  model_unavailable:
    '\n선택한 모델을 이 Claude Code에서 사용할 수 없습니다. 다른 모델을 고르거나 터미널에서 `claude update` 로 CLI를 업데이트하세요.',
};

/** ProviderError for a failed run: `base` + a hint for its kind (a login hint for 'auth') + the stderr tail. */
function claudeFailure(base: string, evidence: string, resumed: boolean, stderrTail: string): ProviderError {
  const kind = classifyClaudeFailure(evidence, resumed);
  const hint = kind === 'auth' ? loginHint(evidence) || loginHint('login') : (KIND_HINTS[kind] ?? loginHint(evidence));
  return new ProviderError(`${base}${hint}${stderrSuffix(stderrTail)}`, kind);
}

async function runClaude(input: ProviderRunInput): Promise<ProviderRunResult> {
  const ephemeral = input.ephemeral === true;
  const allowTools = input.allowTools !== false;
  const resumeId = input.resume?.cliSessionId || undefined;
  const sessionId = resumeId || ephemeral ? undefined : randomUUID();
  const args = claudeArgs({
    systemPrompt: input.systemPrompt,
    model: input.model,
    effort: input.effort,
    sessionId,
    resumeId,
    ephemeral,
    allowTools,
    addDirs: allowTools ? await existingDirs(input.extraReadDirs) : [],
  });
  const stdin = `${await claudeUserMessage(input.parts)}\n`;

  const state = new ClaudeStreamState(input.cwd, input.onDelta, input.onStatus);
  const proc = await runJsonlProcess({
    bin: await resolveBin(CLAUDE_BIN_SPEC),
    args,
    cwd: input.cwd,
    stdin,
    signal: input.signal,
    env: claudeEnv(),
    onEvent: (event) => state.handle(event),
  });

  const result = state.result;
  const tail = stderrSuffix(proc.stderrTail);
  const resumed = resumeId !== undefined;
  if (result?.isError) {
    const message = result.text || result.subtype || 'unknown error';
    throw claudeFailure(`Claude Code 오류: ${message}`, `${message}\n${proc.stderrTail}`, resumed, proc.stderrTail);
  }
  if (proc.code !== 0) {
    throw claudeFailure(
      `Claude Code가 비정상 종료했습니다 (${describeExit(proc.code, proc.signal)}).`,
      proc.stderrTail,
      resumed,
      proc.stderrTail,
    );
  }
  if (!result) throw new Error(`Claude Code가 결과 없이 종료되었습니다.${tail}`);

  let text = state.text;
  if (!state.sawDelta && result.text) {
    // No partial messages were streamed (older CLI?): deliver the final text in one piece.
    text = result.text;
    input.onDelta(text);
  }
  // An ephemeral run has no session of ours; still hand back what the CLI reported, if anything.
  const cliSessionId = result.sessionId ?? resumeId ?? sessionId;
  return { text, resume: cliSessionId ? { cliSessionId } : {} };
}

export const claudeCodeProvider: Provider = {
  id: 'claude-code',
  label: 'Claude Code (구독)',
  kind: 'cli',
  models: [
    { id: '', label: 'CLI 기본값' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    // Haiku (4.5) takes no effort level.
    { id: 'haiku', label: 'Haiku', efforts: [] },
    { id: 'fable', label: 'Fable' },
  ],
  defaultModel: '',
  efforts: CLAUDE_EFFORTS,
  // Each image stays in the CLI's conversation and is resent with every turn: a resumed 90-image conversation
  // measured ~330 MB RSS in the claude process, so conversations roll over (re-prime + recap) earlier.
  maxImagesPerConversation: 48,
  async detect(): Promise<ProviderAvailability> {
    return probeVersion({
      bin: await resolveBin(CLAUDE_BIN_SPEC),
      displayName: 'claude',
      installHint: claudeInstallHint(),
      env: claudeEnv(),
    });
  },
  run: runClaude,
};
