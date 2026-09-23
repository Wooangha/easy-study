// claude-code provider: the user's Claude subscription through the Claude Code CLI (DESIGN §6).
//
//   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
//          --system-prompt <prompt> --tools Read,Glob,Grep --strict-mcp-config [--add-dir <dir> ...]
//          [--model <model>] (--session-id <new uuid> | --resume <cliSessionId> | --no-session-persistence)
//
// The user turn (text + base64 images) is written to stdin as one stream-json line. `--add-dir`
// lets the read-only tools open other lectures of the same course; one-shot (ephemeral) calls such
// as digest batches do not persist a CLI session.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  Part,
  Provider,
  ProviderAvailability,
  ProviderRunInput,
  ProviderRunResult,
} from './types.ts';
import {
  childEnv,
  describeExit,
  loadImageBase64,
  probeVersion,
  resolveBin,
  runJsonlProcess,
  stderrSuffix,
} from './proc.ts';
import type { JsonObject } from './proc.ts';

/** Read-only tools the CLI may use (to open slide PNGs it has not been shown). */
export const CLAUDE_TOOLS = 'Read,Glob,Grep';

export interface ClaudeArgsInput {
  systemPrompt: string;
  model: string;
  /** New conversation: the session id we pick. */
  sessionId?: string;
  /** Continued conversation: the CLI session id to resume. */
  resumeId?: string;
  /** One-shot call: --no-session-persistence and no --session-id. */
  ephemeral?: boolean;
  /** Extra readable directories (one --add-dir each). */
  addDirs?: string[];
}

export function claudeArgs(input: ClaudeArgsInput): string[] {
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
    CLAUDE_TOOLS,
    '--strict-mcp-config',
  ];
  // --add-dir is variadic in the CLI: every value is followed by another option, never a positional.
  for (const dir of uniqueDirs(input.addDirs)) args.push('--add-dir', dir);
  if (input.model) args.push('--model', input.model);
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
      const image = await loadImageBase64(part.path);
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
 * Environment for the CLI. ANTHROPIC_API_KEY is removed by default: when it is set, Claude Code
 * bills that API key instead of the user's subscription, which is what this provider is for.
 * Set EASY_STUDY_CLAUDE_USE_API_KEY=1 to keep it.
 */
function claudeEnv(): NodeJS.ProcessEnv {
  return process.env.EASY_STUDY_CLAUDE_USE_API_KEY === '1' ? childEnv() : childEnv(['ANTHROPIC_API_KEY']);
}

function loginHint(message: string): string {
  return /login|log in|api key|auth|credential|401|403/i.test(message)
    ? '\n터미널에서 `claude` 를 실행해 로그인 상태를 확인하세요.'
    : '';
}

async function runClaude(input: ProviderRunInput): Promise<ProviderRunResult> {
  const ephemeral = input.ephemeral === true;
  const resumeId = input.resume?.cliSessionId || undefined;
  const sessionId = resumeId || ephemeral ? undefined : randomUUID();
  const args = claudeArgs({
    systemPrompt: input.systemPrompt,
    model: input.model,
    sessionId,
    resumeId,
    ephemeral,
    addDirs: await existingDirs(input.extraReadDirs),
  });
  const stdin = `${await claudeUserMessage(input.parts)}\n`;

  const state = new ClaudeStreamState(input.cwd, input.onDelta, input.onStatus);
  const proc = await runJsonlProcess({
    bin: resolveBin('CLAUDE_BIN', 'claude'),
    args,
    cwd: input.cwd,
    stdin,
    signal: input.signal,
    env: claudeEnv(),
    onEvent: (event) => state.handle(event),
  });

  const result = state.result;
  const tail = stderrSuffix(proc.stderrTail);
  if (result?.isError) {
    const message = result.text || result.subtype || 'unknown error';
    throw new Error(`Claude Code 오류: ${message}${loginHint(message + proc.stderrTail)}${tail}`);
  }
  if (proc.code !== 0) {
    throw new Error(
      `Claude Code가 비정상 종료했습니다 (${describeExit(proc.code, proc.signal)}).${loginHint(proc.stderrTail)}${tail}`,
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
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ],
  defaultModel: '',
  maxImagesPerConversation: 90,
  detect(): Promise<ProviderAvailability> {
    return probeVersion({
      bin: resolveBin('CLAUDE_BIN', 'claude'),
      displayName: 'claude',
      installHint: 'Claude Code 설치: npm install -g @anthropic-ai/claude-code',
      env: claudeEnv(),
    });
  },
  run: runClaude,
};
