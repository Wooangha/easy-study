// codex provider: the user's ChatGPT subscription through the Codex CLI (DESIGN §6).
//
//   new:    codex exec --json --skip-git-repo-check [--ephemeral] -C <cwd> <policy -c ...>
//           <hardening -c ...> [-m <model>] [-c model_reasoning_effort="<level>"] [-i <img> ...]
//   resume: codex exec resume <threadId> - --json --skip-git-repo-check <policy -c ...>
//           <hardening -c ...> [-m <model>] [-c model_reasoning_effort="<level>"] [-i <img> ...]
//
// The models and effort levels offered come from the CLI's model catalog (codexCatalog.ts, read by detect()).
//
// The prompt is read from stdin. Images cannot be interleaved with text, so every image part is
// replaced by a "[Attached image #k: label]" marker and the files are passed with -i in that order.
//
// Read confinement (-c overrides, verified against codex-cli 0.154 with `codex sandbox` and
// `codex debug prompt-input`): the legacy read-only sandbox (`--sandbox read-only`) lets the model read
// ANY file the user can read (~/.ssh, ~/.codex/auth.json, other projects), so every call selects its own
// permissions profile instead:
//   -c default_permissions="easy_study_readonly"
//   -c permissions.easy_study_readonly.filesystem={":minimal"="read", "<cwd>"="read", "<other lecture>"="read", …}
// i.e. the platform's minimal system paths plus the document directory and the course's other lectures
// (ProviderRunInput.extraReadDirs); nothing is writable (Codex itself still lets commands use /tmp) and
// the network stays off. A `default_permissions` override outranks `sandbox_mode` in the same layer, so
// `-c sandbox_mode="read-only"` is passed as well: a CLI without permission profiles ignores the profile
// keys and still runs read-only. With profiles, three more settings keep the confinement working:
//   - Codex is spawned by its real path (codexExecutable): the CLI re-executes itself inside the sandbox
//     to read AGENTS.md, and exec'ing it through a symlink outside the readable roots (Homebrew's
//     /opt/homebrew/bin/codex) fails, which aborts the session;
//   - project_root_markers=[]: otherwise Codex looks for AGENTS.md in every directory up to the
//     repository root (the library may live inside one) and an unreadable one aborts the session. The
//     tutor has no use for a repository's coding-agent instructions anyway;
//   - approval_policy="never" + approvals_reviewer="user": with `approvals_reviewer = "auto_review"`
//     (or its alias "guardian_subagent") in the user's config.toml, `codex exec` drops its headless
//     "never" policy, so the model could ask to run commands OUTSIDE the sandbox and a reviewer agent
//     would decide. Escalations are simply rejected now.
// EASY_STUDY_CODEX_CONFINE=0 (and Windows) falls back to the legacy read-only sandbox without the
// profile (the whole disk is readable again), for a Codex version that cannot start with the profile.
//
// Hardening (-c config overrides; unknown feature names are ignored by the CLI): integrations that
// run OUTSIDE the sandbox are always off — the `notify` program of the user's config.toml (run after
// every turn; measured: a 10-15 MB Computer Use client per turn), plugins, apps, browser / computer use
// and the MCP servers of the user's config.toml (each disabled by name). Calls that need no tools
// (ProviderRunInput.allowTools === false, e.g. digest batches that attach every image) also lose the
// shell, view_image, code mode, sub-agents and image generation. Note: the shell is removed by `features.shell_tool=false`, which
// makes Codex skip registering its shell tools altogether (exec_command / write_stdin included).
// `features.unified_exec=false` is passed too but codex-cli 0.154 ignores it (`codex features list`
// still shows unified_exec on), so never drop shell_tool from the list. Tutoring keeps the shell and
// view_image because the model opens slide PNGs and other lectures' files with them — inside the
// confined read roots above.
//
// Codex may send several agent messages in one turn (e.g. "I'll check the file." before running a
// command, then the answer). Only the LAST one is the answer: earlier ones are shown as status lines.
//
// Failures are classified (ProviderError). Resuming a thread whose rollout is gone either fails
// ("thread not found", "no rollout found", …) or silently starts a new thread (thread.started with
// another id, and no deck in it): both are 'resume_invalid'.
//
// Token usage (DESIGN §23): turn.completed carries it, but `codex exec --json` has no usage limits, and for a
// resumed thread its usage may be the thread's running total. So once a non-ephemeral run has ended (stopped ones
// too: the model calls that finished are recorded), what it appended to the thread's rollout is read (codexRollout.ts,
// bounded by ROLLOUT_READ_TIMEOUT_MS) for the turn's own usage and the limits; a new thread's turn.completed usage is
// reported right away, a resumed one's only from the rollout.
import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TokenUsage, UsageLimits } from '../../shared/types.ts';
import type {
  Part,
  Provider,
  ProviderAvailability,
  ProviderErrorKind,
  ProviderRunInput,
  ProviderRunResult,
} from './types.ts';
import { ProviderError } from './types.ts';
import { describeExit, probeVersion, resolveBin, runJsonlProcess, stderrSuffix } from './proc.ts';
import type { CliBinSpec, JsonlProcessResult, JsonObject } from './proc.ts';
import { CODEX_DEFAULT_MODEL_LABEL, codexCatalog, codexConfigModel, codexModelChoices, readCodexConfig } from './codexCatalog.ts';
import { codexRolloutSize, readCodexRolloutTurn } from './codexRollout.ts';
import type { CodexRolloutTurn } from './codexRollout.ts';
import { openaiUsage } from './usage.ts';

/** Features that reach outside the sandbox; always disabled. */
export const CODEX_DISABLED_INTEGRATIONS = ['plugins', 'apps', 'browser_use', 'computer_use', 'in_app_browser'];
/**
 * Tool features disabled when a call needs no tools (ProviderRunInput.allowTools === false). shell_tool is
 * the one that removes the shell on codex-cli 0.154 (unified_exec cannot be switched off there).
 */
export const CODEX_DISABLED_TOOLS = ['shell_tool', 'unified_exec', 'view_image', 'code_mode_host', 'multi_agent', 'image_generation'];
/** Name of the permissions profile every confined call defines and selects (see the top of this file). */
export const CODEX_PERMISSION_PROFILE = 'easy_study_readonly';

export interface CodexArgsInput {
  cwd: string;
  model: string;
  /** Reasoning effort; '' / omitted = the config's (or the model's) default. */
  effort?: string;
  /** Thread to continue; undefined = new conversation. */
  threadId?: string;
  /** Image files, in marker order. */
  images: string[];
  /** One-shot call: do not persist the session (--ephemeral; new conversations only). */
  ephemeral?: boolean;
  /** false = disable the shell and other tools too (CODEX_DISABLED_TOOLS). Defaults to true. */
  allowTools?: boolean;
  /** MCP servers configured in the user's config.toml, to disable by name (see codexMcpServerNames). */
  mcpServers?: string[];
  /** Absolute directories the model may read besides `cwd` (other lectures of the course). */
  readDirs?: string[];
  /**
   * true (default) = reads are confined to `cwd` + `readDirs` by a permissions profile; false = the
   * legacy read-only sandbox, which can read the whole disk (EASY_STUDY_CODEX_CONFINE=0).
   */
  confine?: boolean;
}

export function codexArgs(input: CodexArgsInput): string[] {
  const confine = input.confine !== false;
  let args: string[];
  if (input.threadId) {
    args = ['exec', 'resume', input.threadId, '-', '--json', '--skip-git-repo-check'];
  } else {
    args = ['exec', '--json', '--skip-git-repo-check'];
    if (input.ephemeral) args.push('--ephemeral');
    // The --sandbox flag would override a permissions profile, so it is only used without one.
    if (!confine) args.push('--sandbox', 'read-only');
    args.push('-C', input.cwd);
  }
  // Without a profile a new conversation has --sandbox above (resumed ones take no such flag). With a
  // profile this is the fallback for CLIs that do not know permission profiles: the profile wins where
  // it is supported.
  if (confine || input.threadId) args.push('-c', 'sandbox_mode="read-only"');
  if (confine) {
    args.push(
      '-c',
      `default_permissions="${CODEX_PERMISSION_PROFILE}"`,
      '-c',
      `permissions.${CODEX_PERMISSION_PROFILE}.filesystem=${codexReadRootsToml([input.cwd, ...(input.readDirs ?? [])])}`,
    );
  }
  args.push('-c', 'approval_policy="never"', '-c', 'approvals_reviewer="user"', '-c', 'project_root_markers=[]');
  args.push('-c', 'notify=[]');
  const features = [...CODEX_DISABLED_INTEGRATIONS, ...(input.allowTools === false ? CODEX_DISABLED_TOOLS : [])];
  for (const feature of features) args.push('-c', `features.${feature}=false`);
  for (const server of input.mcpServers ?? []) {
    if (BARE_KEY_RE.test(server)) args.push('-c', `mcp_servers.${server}.enabled=false`);
  }
  if (input.model) args.push('-m', input.model);
  if (input.effort) args.push('-c', `model_reasoning_effort=${tomlString(input.effort)}`);
  for (const image of input.images) args.push('-i', image);
  return args;
}

/**
 * The filesystem table of the permissions profile as a TOML inline table: the platform's minimal
 * system paths plus each (absolute, deduplicated) directory, read-only.
 */
export function codexReadRootsToml(dirs: string[]): string {
  const roots = [...new Set(dirs.filter((dir) => typeof dir === 'string' && path.isAbsolute(dir)).map((dir) => path.resolve(dir)))];
  return `{${[':minimal', ...roots].map((root) => `${tomlString(root)}="read"`).join(',')}}`;
}

/** A TOML basic string. Lone surrogates cannot be written in TOML; they become U+FFFD (a path that does not exist). */
export function tomlString(text: string): string {
  let out = '"';
  for (const char of text.toWellFormed()) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/** Whether calls confine Codex's reads with the permissions profile (EASY_STUDY_CODEX_CONFINE=0 turns it off). */
export function codexConfinementEnabled(): boolean {
  if (process.platform === 'win32') return false;
  const raw = process.env.EASY_STUDY_CODEX_CONFINE?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * The codex executable (CODEX_BIN overrides it). An npm global install puts a codex.cmd shim next to
 * node_modules that runs `node @openai/codex/bin/codex.js`, which spawns the native binary of the platform
 * package: `<@openai/codex-win32-<arch>>/vendor/<triple>/bin/codex.exe` (resolved from @openai/codex, else
 * `@openai/codex/vendor/…`), per codex.js of @openai/codex 0.154. The binary is spawned directly: killing
 * a node wrapper would leave codex.exe running.
 */
export const CODEX_BIN_SPEC: CliBinSpec = {
  name: 'codex',
  envVar: 'CODEX_BIN',
  npmShimTargets: (shimDir, arch) => {
    const arm = arch === 'arm64';
    const exe = ['vendor', arm ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'];
    const platformPkg = ['@openai', arm ? 'codex-win32-arm64' : 'codex-win32-x64'];
    const pkg = path.win32.join(shimDir, 'node_modules', '@openai', 'codex');
    return [
      path.win32.join(pkg, 'node_modules', ...platformPkg, ...exe),
      path.win32.join(shimDir, 'node_modules', ...platformPkg, ...exe),
      path.win32.join(pkg, ...exe),
    ];
  },
};

/** How to install Codex: the standalone installer (on Windows an npm install only gives a .cmd shim). */
export function codexInstallHint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'Codex CLI 설치 (PowerShell): powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
    : 'Codex CLI 설치: curl -fsSL https://chatgpt.com/codex/install.sh | sh  (또는 npm install -g @openai/codex)';
}

/**
 * The real path of the Codex executable (`bin` as given, or found on PATH like the OS would, symlinks
 * resolved); `bin` unchanged when it cannot be found (the spawn then reports it). See the top of the file.
 * On Windows resolveBin already returns the executable's path.
 */
export async function codexExecutable(bin: string): Promise<string> {
  if (process.platform === 'win32') return bin;
  const candidates = bin.includes('/')
    ? [path.resolve(bin)]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        // A relative entry would be resolved in the child's working directory: leave those to spawn.
        .filter((dir) => path.isAbsolute(dir))
        .map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch {
      // not here
    }
  }
  return bin;
}

/** A TOML bare key: the only server names a `-c mcp_servers.<name>.enabled=false` override can address. */
const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Names of the MCP servers defined in a Codex config.toml ([mcp_servers.<name>] tables, keys of a
 * [mcp_servers] table, or top-level dotted keys). Only bare-key names are returned: overriding a
 * server that is not configured makes the CLI refuse its configuration, so this errs on the side of
 * returning fewer names.
 */
export function codexMcpServerNames(configToml: string): string[] {
  const names = new Set<string>();
  const name = String.raw`(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))`;
  const tableRe = new RegExp(String.raw`^\[\s*mcp_servers\s*\.\s*${name}\s*(?:\.|\])`);
  const keyRe = new RegExp(String.raw`^${name}\s*[.=]`);
  const rootKeyRe = new RegExp(String.raw`^mcp_servers\s*\.\s*${name}\s*[.=]`);
  const pick = (m: RegExpExecArray) => m[1] ?? m[2] ?? m[3];
  let table: string | null = null; // null = root table
  let multiline: string | null = null; // open multi-line string delimiter
  for (const raw of configToml.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (multiline) {
      if (countOf(line, multiline) % 2 === 1) multiline = null;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      table = line.startsWith('[[') ? '[[array]]' : line.replace(/^\[\s*|\s*\](\s*#.*)?$/g, '');
      const m = tableRe.exec(line);
      if (m && !line.startsWith('[[')) names.add(pick(m));
      continue;
    }
    const m = table === null ? rootKeyRe.exec(line) : table === 'mcp_servers' ? keyRe.exec(line) : null;
    if (m) names.add(pick(m));
    for (const delimiter of ['"""', "'''"]) {
      if (countOf(line, delimiter) % 2 === 1) {
        multiline = delimiter;
        break;
      }
    }
  }
  return [...names];
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** MCP servers of the user's Codex config ($CODEX_HOME/config.toml, default ~/.codex); [] when unreadable. */
async function configuredMcpServers(): Promise<string[]> {
  return codexMcpServerNames(await readCodexConfig());
}

export function imageMarker(index: number, label: string): string {
  return `[Attached image #${index}: ${label}]`;
}

/**
 * Flattens parts into the stdin prompt + ordered image list. The system prompt is prepended only
 * when starting a new conversation (Codex has no separate system prompt channel here).
 */
export function codexPrompt(parts: Part[], systemPrompt: string | null): { prompt: string; images: string[] } {
  const images: string[] = [];
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) pieces.push(part.text);
    } else {
      images.push(part.path);
      pieces.push(imageMarker(images.length, part.label));
    }
  }
  const sections: string[] = [];
  if (systemPrompt) sections.push(`<instructions>\n${systemPrompt}\n</instructions>`);
  if (images.length > 0) {
    sections.push(
      `(${images.length} image${images.length === 1 ? ' is' : 's are'} attached to this message in order; ` +
        '"[Attached image #k: …]" marks where image #k belongs in the text.)',
    );
  }
  sections.push(pieces.join('\n\n'));
  return { prompt: sections.join('\n\n'), images };
}

/** Max characters of an intermediate agent message shown as a status line. */
const STATUS_MESSAGE_CHARS = 200;

/**
 * Stateful interpreter of `codex exec --json` events.
 *
 * Agent messages are buffered, because a message is only known to be the final answer when the
 * turn completes. A buffered message is shown through onStatus as soon as more work starts (a
 * command, reasoning, …) or a newer message replaces it; the last one is emitted through onDelta at
 * turn.completed (or by finish() if the stream ends without it). So `text` is the final answer only.
 */
export class CodexStreamState {
  text = '';
  threadId: string | undefined;
  completed = false;
  failure: string | null = null;
  lastError: string | null = null;
  /**
   * turn.completed's usage: the turn's tokens on a new thread (reported through onUsage at once); on a resumed
   * thread possibly the whole thread's, so it is not reported (see the top of the file).
   */
  usage: TokenUsage | undefined;

  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;
  private readonly onUsage: ((usage: TokenUsage) => void) | undefined;
  /** Thread being resumed (undefined for a new conversation). */
  private readonly resumedThread: string | undefined;
  /** Latest agent message, not emitted as answer text yet. */
  private pending: string | null = null;
  /** `pending` has already been shown as a status line. */
  private pendingShown = false;

  constructor(
    onDelta: (text: string) => void,
    onStatus: (text: string) => void,
    resumedThread?: string,
    onUsage?: (usage: TokenUsage) => void,
  ) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
    this.resumedThread = resumedThread;
    this.onUsage = onUsage;
  }

  /** Throws a ProviderError('resume_invalid') when a resumed run reports another thread (see top of file). */
  handle(event: JsonObject): void {
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string' && event.thread_id) {
          if (this.resumedThread && event.thread_id !== this.resumedThread) {
            throw new ProviderError(
              `Codex가 이전 대화(thread ${this.resumedThread})를 찾지 못해 새 대화(thread ${event.thread_id})를 시작했습니다.`,
              'resume_invalid',
            );
          }
          this.threadId = event.thread_id;
        }
        break;
      case 'item.started':
        this.itemStarted(asObject(event.item));
        break;
      case 'item.completed':
        this.itemCompleted(asObject(event.item));
        break;
      case 'turn.completed':
        this.completed = true;
        this.flushAnswer();
        this.usage = openaiUsage(event.usage);
        if (this.usage && !this.resumedThread) this.onUsage?.(this.usage);
        break;
      case 'turn.failed':
        this.failure = messageOf(asObject(event.error)) || 'turn failed';
        break;
      case 'error':
        // Recorded, not thrown: it is fatal only if the turn does not complete afterwards.
        this.lastError = messageOf(event) || 'unknown error';
        break;
      default:
        break;
    }
  }

  /** Call once the stream has ended: emits a buffered answer that no turn.completed confirmed. */
  finish(): void {
    if (!this.failure) this.flushAnswer();
  }

  private itemStarted(item: JsonObject): void {
    if (item.type === 'agent_message') return;
    // More work follows the buffered message, so it is a progress note for now (it still becomes
    // the answer if no other message follows).
    this.showPendingAsStatus();
    const status = startedItemStatus(item);
    if (status) this.onStatus(status);
  }

  private itemCompleted(item: JsonObject): void {
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
      this.showPendingAsStatus(); // superseded by a newer message
      this.pending = item.text;
      this.pendingShown = false;
    } else if (item.type === 'error' && typeof item.message === 'string') {
      this.onStatus(`경고: ${clip(item.message, 120)}`);
    }
  }

  private showPendingAsStatus(): void {
    if (this.pending === null || this.pendingShown) return;
    this.pendingShown = true;
    this.onStatus(clip(this.pending, STATUS_MESSAGE_CHARS));
  }

  private flushAnswer(): void {
    if (this.pending === null) return;
    const chunk = this.text ? `\n\n${this.pending}` : this.pending;
    this.pending = null;
    this.text += chunk;
    this.onDelta(chunk);
  }
}

/** Status line for a started work item ('' for item types without one). */
function startedItemStatus(item: JsonObject): string {
  switch (item.type) {
    case 'reasoning':
      return '생각하는 중…';
    case 'command_execution':
      return `명령 실행 중: ${clip(String(item.command ?? ''), 100)}`;
    case 'web_search':
      return '웹 검색 중…';
    case 'mcp_tool_call':
      return `도구 사용 중: ${String(item.tool ?? '')}`;
    default:
      return '';
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function messageOf(obj: JsonObject): string {
  return typeof obj.message === 'string' ? obj.message : '';
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function loginHint(message: string): string {
  return /login|log in|unauthori[sz]ed|401|403|auth/i.test(message)
    ? '\n터미널에서 `codex login` 으로 로그인 상태를 확인하세요.'
    : '';
}

/**
 * Kind of a Codex failure from its messages (turn.failed / error events, stderr). `resumed` = the call
 * resumed a thread, so "not found" errors mean that thread is gone.
 */
export function classifyCodexFailure(text: string, resumed: boolean): ProviderErrorKind {
  if (
    resumed &&
    /thread not found|session not found|no saved session found|no rollout found|conversation not found|invalid thread id|failed to resolve rollout path|thread not loaded/i.test(
      text,
    )
  ) {
    return 'resume_invalid';
  }
  if (
    /ran out of room in the model's context window|context_length_exceeded|contextwindowexceeded|context window exceeded|exceeds the context window|maximum context length|prompt is too long/i.test(
      text,
    )
  ) {
    return 'context_overflow';
  }
  if (
    /model_not_found|model .{0,80}does not exist|does not exist or you do not have access|not supported when using codex|not supported with (?:a )?chatgpt account|unsupported model|unknown model|requires a newer version of codex|upgrade to the latest (?:app or )?cli/i.test(
      text,
    )
  ) {
    return 'model_unavailable';
  }
  if (
    /\b401\b|unauthori[sz]ed|not logged in|not signed in|codex login|access token could not be refreshed|sign in again|authentication required|refresh token/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  return 'other';
}

const KIND_HINTS: Partial<Record<ProviderErrorKind, string>> = {
  resume_invalid: '\n이전 Codex 대화(thread)를 더 이상 이어갈 수 없습니다. 새 대화로 다시 시작해야 합니다.',
  context_overflow: '\n대화가 모델의 컨텍스트 한도를 넘었습니다. 새 대화로 이어가야 합니다.',
  model_unavailable:
    '\n선택한 모델을 이 Codex에서 사용할 수 없습니다. 다른 모델을 설정하거나 Codex CLI를 업데이트하세요.',
};

/** Codex could not start (or run a command) under the read-confining permissions profile. */
const CONFINEMENT_FAILURE_RE =
  /default_permissions|permissions profile|\[permissions\]|fs sandbox helper|sandbox-exec|failed to load AGENTS\.md|failed to initialize session/i;

export const CONFINEMENT_HINT =
  '\nCodex가 읽기 제한(이 강의와 같은 과목 강의 폴더만 읽기)을 적용한 채로 시작하지 못했을 수 있습니다. ' +
  'Codex CLI를 업데이트해 보고, 그래도 안 되면 EASY_STUDY_CODEX_CONFINE=0 으로 서버를 다시 시작하세요 ' +
  '(이 경우 Codex가 컴퓨터의 모든 파일을 읽을 수 있습니다).';

/**
 * ProviderError for a failed run: `base` + a hint for its kind (a login hint for 'auth'; for other failures of a
 * confined run that look like the permissions profile's doing, how to turn it off) + the stderr tail.
 */
function codexFailure(base: string, evidence: string, resumed: boolean, stderrTail: string, confined: boolean): ProviderError {
  const kind = classifyCodexFailure(evidence, resumed);
  let hint = kind === 'auth' ? loginHint(evidence) || loginHint('login') : (KIND_HINTS[kind] ?? loginHint(evidence));
  if (!hint && confined && kind === 'other' && CONFINEMENT_FAILURE_RE.test(evidence)) hint = CONFINEMENT_HINT;
  return new ProviderError(`${base}${hint}${stderrSuffix(stderrTail)}`, kind);
}

/**
 * How long a run waits for its thread's rollout (codexRollout.ts): its size before a resumed run starts, what the run
 * appended once it has ended. After that the usage of a resumed thread and the limits are left out rather than
 * holding back the turn.
 */
export const ROLLOUT_READ_TIMEOUT_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * The run's token usage and the subscription's usage limits (see the top of the file): from what the run appended to
 * the thread's rollout (after its first `rolloutStart` bytes; null = not read: an ephemeral run keeps no rollout, and
 * a resumed thread's could not be found before the run) when it has them, else a new thread's turn.completed usage.
 */
async function codexRunUsage(
  state: CodexStreamState,
  threadId: string | undefined,
  resumed: boolean,
  rolloutStart: number | null,
): Promise<{ usage?: TokenUsage; limits?: UsageLimits }> {
  let rollout: CodexRolloutTurn = {};
  if (threadId && rolloutStart !== null) {
    rollout = await withTimeout(readCodexRolloutTurn(threadId, rolloutStart), ROLLOUT_READ_TIMEOUT_MS, {});
  }
  const usage = rollout.usage ?? (resumed ? undefined : state.usage);
  return { ...(usage ? { usage } : {}), ...(rollout.limits ? { limits: rollout.limits } : {}) };
}

let warnedUnconfined = false;

async function runCodex(input: ProviderRunInput): Promise<ProviderRunResult> {
  const ephemeral = input.ephemeral === true;
  const threadId = input.resume?.cliSessionId || undefined;
  const resumed = threadId !== undefined;
  const { prompt, images } = codexPrompt(input.parts, threadId ? null : input.systemPrompt);
  const confine = codexConfinementEnabled();
  if (!confine && !warnedUnconfined) {
    warnedUnconfined = true;
    console.warn('[codex] reads are NOT confined (EASY_STUDY_CODEX_CONFINE=0 or Windows): Codex can read any file of this user');
  }
  const args = codexArgs({
    cwd: input.cwd,
    model: input.model,
    effort: input.effort,
    threadId,
    images,
    ephemeral,
    allowTools: input.allowTools !== false,
    mcpServers: await configuredMcpServers(),
    readDirs: input.extraReadDirs ?? [],
    confine,
  });

  const state = new CodexStreamState(input.onDelta, input.onStatus, threadId, input.onUsage);
  // Where this run's rollout entries will start: a new thread's file is its own, a resumed one's is appended to.
  let rolloutStart: number | null = null;
  if (!ephemeral) rolloutStart = threadId ? await withTimeout(codexRolloutSize(threadId), ROLLOUT_READ_TIMEOUT_MS, null) : 0;
  /** Reports the run's usage and limits (see codexRunUsage), a failed or stopped run's too: it may have used tokens. */
  const reportUsage = async () => {
    const found = await codexRunUsage(state, state.threadId ?? threadId, resumed, rolloutStart);
    // A new thread's turn.completed usage was reported already (the rollout normally says the same).
    const reported = resumed ? undefined : state.usage;
    if (found.usage && JSON.stringify(found.usage) !== JSON.stringify(reported)) input.onUsage?.(found.usage);
    if (found.limits) input.onLimits?.(found.limits);
    return found;
  };
  let proc: JsonlProcessResult;
  try {
    proc = await runJsonlProcess({
      // The real path, not a symlink on PATH: see the top of the file.
      bin: await codexExecutable(await resolveBin(CODEX_BIN_SPEC)),
      args,
      cwd: input.cwd,
      stdin: prompt,
      signal: input.signal,
      onEvent: (event) => state.handle(event),
    });
  } catch (err) {
    // Stopped: the CLI has exited, and the model calls it finished are in the rollout.
    if (input.signal.aborted) await reportUsage();
    throw err;
  }

  const { usage, limits } = await reportUsage();

  const tail = stderrSuffix(proc.stderrTail);
  if (state.failure) {
    throw codexFailure(`Codex 오류: ${state.failure}`, `${state.failure}\n${proc.stderrTail}`, resumed, proc.stderrTail, confine);
  }
  if (state.lastError && !state.completed) {
    throw codexFailure(`Codex 오류: ${state.lastError}`, `${state.lastError}\n${proc.stderrTail}`, resumed, proc.stderrTail, confine);
  }
  if (proc.code !== 0) {
    throw codexFailure(
      `Codex가 비정상 종료했습니다 (${describeExit(proc.code, proc.signal)}).`,
      proc.stderrTail,
      resumed,
      proc.stderrTail,
      confine,
    );
  }
  state.finish();
  if (!state.completed && !state.text) throw new Error(`Codex가 응답 없이 종료되었습니다.${tail}`);

  const id = state.threadId ?? threadId;
  // Without a thread id the next turn could not continue this conversation (and would lack the deck).
  if (!ephemeral && !id) throw new Error(`Codex가 thread id를 알려주지 않았습니다.${tail}`);
  const out: ProviderRunResult = { text: state.text, resume: id ? { cliSessionId: id } : {} };
  if (usage) out.usage = usage;
  if (limits) out.limits = limits;
  return out;
}

export const codexProvider: Provider = {
  id: 'codex',
  label: 'Codex (ChatGPT 구독)',
  kind: 'cli',
  // Until detect() has read the model catalog.
  models: [{ id: '', label: CODEX_DEFAULT_MODEL_LABEL }],
  defaultModel: '',
  maxImagesPerConversation: 90,
  async detect(): Promise<ProviderAvailability> {
    const bin = await resolveBin(CODEX_BIN_SPEC);
    const availability = await probeVersion({ bin, displayName: 'codex', installHint: codexInstallHint() });
    if (!availability.available) return availability;
    const [catalog, config] = await Promise.all([codexCatalog(bin, availability.version), readCodexConfig()]);
    return { ...availability, ...codexModelChoices(catalog, codexConfigModel(config)) };
  },
  run: runCodex,
};
