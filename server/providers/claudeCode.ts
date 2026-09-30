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
//
// Token usage (DESIGN §23) is reported live from each model call's message_start / message_delta and replaced by the
// run's total from `result`; a subscription's usage limits come with rate_limit_event (after the last call).
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { EffortOption, ModelOption, TokenUsage, UsageLimits } from '../../shared/types.ts';
import type {
  Part,
  Provider,
  ProviderAvailability,
  ProviderErrorKind,
  ProviderRunInput,
  ProviderRunResult,
} from './types.ts';
import { ProviderError, effortOption } from './types.ts';
import { slang, smsg } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import {
  childEnv,
  describeExit,
  loadInlineImage,
  resolveBin,
  runJsonlProcess,
  stderrSuffix,
  versionCheck,
} from './proc.ts';
import type { CliBinSpec, JsonObject, LocalizedAvailability } from './proc.ts';
import { AnthropicUsageTracker, anthropicUsage, claudeRateLimits } from './usage.ts';

/** Read-only tools the CLI may use (to open slide PNGs it has not been shown). */
export const CLAUDE_TOOLS = 'Read,Glob,Grep';

/** The static choices of the provider per language (built once each). */
const staticChoices = new Map<Lang, { models: ModelOption[]; efforts: EffortOption[] }>();

/** `claude --effort <level>` levels (claude 2.1.x), weakest first, and the models, with their texts in `lang`. */
function claudeChoices(lang: Lang): { models: ModelOption[]; efforts: EffortOption[] } {
  let choices = staticChoices.get(lang);
  if (!choices) {
    const m = smsg(lang).chat.providers;
    choices = {
      models: [
        { id: '', label: m.claudeDefaultModel },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
        // Haiku (4.5) takes no effort level.
        { id: 'haiku', label: 'Haiku', efforts: [] },
        { id: 'fable', label: 'Fable' },
      ],
      efforts: (['low', 'medium', 'high', 'xhigh', 'max'] as const).map((id) => effortOption(id, m.claudeEffort[id], lang)),
    };
    staticChoices.set(lang, choices);
  }
  return choices;
}

/** The `claude --effort` levels in `lang` (default: the request's). */
export function claudeEfforts(lang: Lang = slang()): EffortOption[] {
  return claudeChoices(lang).efforts;
}

/** The `claude --effort` levels with their Korean texts (the reference). */
export const CLAUDE_EFFORTS = claudeEfforts('ko');

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

/** Where ClaudeStreamState reports token usage and usage limits (ProviderRunInput.onUsage / onLimits). */
export interface UsageReporters {
  onUsage?: (usage: TokenUsage) => void;
  onLimits?: (limits: UsageLimits) => void;
}

/**
 * Stateful interpreter of the CLI's stream-json events. Text deltas are forwarded as they arrive
 * (thinking is not); separate text blocks are joined with a blank line. Token usage is summed over the
 * run's model calls as they stream (the `assistant` snapshots repeat it per content block and are not
 * counted), then replaced by the total of `result`; the last rate_limit_event gives the limits.
 */
export class ClaudeStreamState {
  text = '';
  sawDelta = false;
  result: ClaudeResultEvent | null = null;
  /** Tokens of the run so far (undefined until the CLI reported any). */
  usage: TokenUsage | undefined;
  /** The subscription's usage limits of the last rate_limit_event, if any. */
  limits: UsageLimits | undefined;

  private readonly cwd: string;
  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;
  private readonly reporters: UsageReporters;
  private readonly calls = new AnthropicUsageTracker();
  private messageSeq = 0;
  private lastTextBlock: string | null = null;
  private readonly seenTools = new Set<string>();

  constructor(cwd: string, onDelta: (text: string) => void, onStatus: (text: string) => void, reporters: UsageReporters = {}) {
    this.cwd = cwd;
    this.onDelta = onDelta;
    this.onStatus = onStatus;
    this.reporters = reporters;
  }

  handle(event: JsonObject): void {
    switch (event.type) {
      case 'stream_event':
        this.handleStreamEvent(asObject(event.event));
        break;
      case 'assistant':
        this.handleAssistant(asObject(event.message));
        break;
      case 'rate_limit_event': {
        const limits = claudeRateLimits(event.rate_limit_info, new Date().toISOString());
        if (limits) {
          this.limits = limits;
          this.reporters.onLimits?.(limits);
        }
        break;
      }
      case 'result':
        this.result = {
          isError: event.is_error === true,
          subtype: typeof event.subtype === 'string' ? event.subtype : '',
          text: typeof event.result === 'string' ? event.result : '',
          sessionId: typeof event.session_id === 'string' && event.session_id ? event.session_id : undefined,
        };
        // The total of every model call of the run (authoritative; the streamed counts may miss a retried call).
        this.reportUsage(anthropicUsage(event.usage));
        break;
      default:
        break;
    }
  }

  private reportUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    this.usage = usage;
    this.reporters.onUsage?.(usage);
  }

  private handleStreamEvent(e: JsonObject): void {
    if (e.type === 'message_start') {
      this.messageSeq += 1;
      this.reportUsage(this.calls.start(asObject(e.message).usage));
      return;
    }
    if (e.type === 'message_delta') {
      if (e.usage !== undefined && e.usage !== null) this.reportUsage(this.calls.update(e.usage));
      return;
    }
    if (e.type === 'content_block_start') {
      const block = asObject(e.content_block);
      if (block.type === 'thinking' || block.type === 'redacted_thinking') this.onStatus(smsg().chat.providers.thinking);
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

/** Status line for a tool call, e.g. "파일 읽는 중: slides/012.png" (in the language of the turn). */
export function toolStatus(name: string, input: JsonObject, cwd: string): string {
  const m = smsg().chat.providers;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read':
      return m.readingFile(displayPath(str(input.file_path) || str(input.path), cwd));
    case 'Glob':
      return m.findingFiles(str(input.pattern));
    case 'Grep':
      return m.searchingText(str(input.pattern));
    default:
      return m.usingTool(name || m.unknownTool);
  }
}

/** Path relative to the doc dir when it is inside it or in a sibling doc dir (another lecture). */
function displayPath(file: string, cwd: string): string {
  if (!file) return smsg().chat.providers.unknownFile;
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
  const m = smsg().chat.providers.claude;
  return platform === 'win32' ? m.installHintWindows : m.installHint;
}

function loginHint(message: string): string {
  return /login|log in|api key|auth|credential|401|403/i.test(message) ? `\n${smsg().chat.providers.claude.loginHint}` : '';
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

/** The hint of a failure kind, on its own line ('' for kinds without one). */
function kindHint(kind: ProviderErrorKind): string {
  const m = smsg().chat.providers.claude;
  const hint = kind === 'resume_invalid' ? m.resumeInvalid : kind === 'context_overflow' ? m.contextOverflow : kind === 'model_unavailable' ? m.modelUnavailable : '';
  return hint ? `\n${hint}` : '';
}

/** ProviderError for a failed run: `base` + a hint for its kind (a login hint for 'auth') + the stderr tail. */
function claudeFailure(base: string, evidence: string, resumed: boolean, stderrTail: string): ProviderError {
  const kind = classifyClaudeFailure(evidence, resumed);
  const hint = kind === 'auth' ? loginHint(evidence) || loginHint('login') : kindHint(kind) || loginHint(evidence);
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

  const state = new ClaudeStreamState(input.cwd, input.onDelta, input.onStatus, { onUsage: input.onUsage, onLimits: input.onLimits });
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
    throw claudeFailure(smsg().chat.providers.claude.error(message), `${message}\n${proc.stderrTail}`, resumed, proc.stderrTail);
  }
  if (proc.code !== 0) {
    throw claudeFailure(smsg().chat.providers.claude.crashed(describeExit(proc.code, proc.signal)), proc.stderrTail, resumed, proc.stderrTail);
  }
  if (!result) throw new Error(`${smsg().chat.providers.claude.noResult}${tail}`);

  let text = state.text;
  if (!state.sawDelta && result.text) {
    // No partial messages were streamed (older CLI?): deliver the final text in one piece.
    text = result.text;
    input.onDelta(text);
  }
  // An ephemeral run has no session of ours; still hand back what the CLI reported, if anything.
  const cliSessionId = result.sessionId ?? resumeId ?? sessionId;
  const out: ProviderRunResult = { text, resume: cliSessionId ? { cliSessionId } : {} };
  if (state.usage) out.usage = state.usage;
  if (state.limits) out.limits = state.limits;
  return out;
}

/** `claude --version`, once for every language (the install hint is worded when the result is). */
async function probeClaude(): Promise<LocalizedAvailability> {
  return versionCheck({
    bin: await resolveBin(CLAUDE_BIN_SPEC),
    displayName: 'claude',
    installHint: () => claudeInstallHint(),
    env: claudeEnv(),
  });
}

export const claudeCodeProvider: Provider = {
  id: 'claude-code',
  // Texts in the request's language (DESIGN §27).
  get label(): string {
    return smsg().chat.providers.label['claude-code'];
  },
  kind: 'cli',
  get models(): ModelOption[] {
    return claudeChoices(slang()).models;
  },
  defaultModel: '',
  get efforts(): EffortOption[] {
    return claudeEfforts();
  },
  // Each image stays in the CLI's conversation and is resent with every turn: a resumed 90-image conversation
  // measured ~330 MB RSS in the claude process, so conversations roll over (re-prime + recap) earlier.
  maxImagesPerConversation: 48,
  async detect(): Promise<ProviderAvailability> {
    return (await probeClaude())();
  },
  probe: probeClaude,
  run: runClaude,
};
