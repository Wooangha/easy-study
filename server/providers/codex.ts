// codex provider: the user's ChatGPT subscription through the Codex CLI (DESIGN §6).
//
//   new:    codex exec --json --skip-git-repo-check [--ephemeral] --sandbox read-only -C <cwd> [-m <model>] [-i <img> ...]
//   resume: codex exec resume <threadId> - --json --skip-git-repo-check -c sandbox_mode="read-only"
//           [-m <model>] [-i <img> ...]
//
// The prompt is read from stdin. Images cannot be interleaved with text, so every image part is
// replaced by a "[Attached image #k: label]" marker and the files are passed with -i in that order.
// The read-only sandbox can read outside the working directory, so other lectures of a course
// (ProviderRunInput.extraReadDirs) need no flag.
//
// Codex may send several agent messages in one turn (e.g. "I'll check the file." before running a
// command, then the answer). Only the LAST one is the answer: earlier ones are shown as status lines.
import type {
  Part,
  Provider,
  ProviderAvailability,
  ProviderRunInput,
  ProviderRunResult,
} from './types.ts';
import { describeExit, probeVersion, resolveBin, runJsonlProcess, stderrSuffix } from './proc.ts';
import type { JsonObject } from './proc.ts';

export interface CodexArgsInput {
  cwd: string;
  model: string;
  /** Thread to continue; undefined = new conversation. */
  threadId?: string;
  /** Image files, in marker order. */
  images: string[];
  /** One-shot call: do not persist the session (--ephemeral; new conversations only). */
  ephemeral?: boolean;
}

export function codexArgs(input: CodexArgsInput): string[] {
  let args: string[];
  if (input.threadId) {
    args = ['exec', 'resume', input.threadId, '-', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"'];
  } else {
    args = ['exec', '--json', '--skip-git-repo-check'];
    if (input.ephemeral) args.push('--ephemeral');
    args.push('--sandbox', 'read-only', '-C', input.cwd);
  }
  if (input.model) args.push('-m', input.model);
  for (const image of input.images) args.push('-i', image);
  return args;
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

  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;
  /** Latest agent message, not emitted as answer text yet. */
  private pending: string | null = null;
  /** `pending` has already been shown as a status line. */
  private pendingShown = false;

  constructor(onDelta: (text: string) => void, onStatus: (text: string) => void) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
  }

  handle(event: JsonObject): void {
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string' && event.thread_id) this.threadId = event.thread_id;
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

async function runCodex(input: ProviderRunInput): Promise<ProviderRunResult> {
  const ephemeral = input.ephemeral === true;
  const threadId = input.resume?.cliSessionId || undefined;
  const { prompt, images } = codexPrompt(input.parts, threadId ? null : input.systemPrompt);
  const args = codexArgs({ cwd: input.cwd, model: input.model, threadId, images, ephemeral });

  const state = new CodexStreamState(input.onDelta, input.onStatus);
  const proc = await runJsonlProcess({
    bin: resolveBin('CODEX_BIN', 'codex'),
    args,
    cwd: input.cwd,
    stdin: prompt,
    signal: input.signal,
    onEvent: (event) => state.handle(event),
  });

  const tail = stderrSuffix(proc.stderrTail);
  if (state.failure) {
    throw new Error(`Codex 오류: ${state.failure}${loginHint(state.failure + proc.stderrTail)}${tail}`);
  }
  if (state.lastError && !state.completed) {
    throw new Error(`Codex 오류: ${state.lastError}${loginHint(state.lastError + proc.stderrTail)}${tail}`);
  }
  if (proc.code !== 0) {
    throw new Error(`Codex가 비정상 종료했습니다 (${describeExit(proc.code, proc.signal)}).${loginHint(proc.stderrTail)}${tail}`);
  }
  state.finish();
  if (!state.completed && !state.text) throw new Error(`Codex가 응답 없이 종료되었습니다.${tail}`);

  const id = state.threadId ?? threadId;
  if (ephemeral) return { text: state.text, resume: id ? { cliSessionId: id } : {} };
  // Without a thread id the next turn could not continue this conversation (and would lack the deck).
  if (!id) throw new Error(`Codex가 thread id를 알려주지 않았습니다.${tail}`);
  return { text: state.text, resume: { cliSessionId: id } };
}

export const codexProvider: Provider = {
  id: 'codex',
  label: 'Codex (ChatGPT 구독)',
  kind: 'cli',
  models: [{ id: '', label: 'Codex 설정 기본값' }],
  defaultModel: '',
  maxImagesPerConversation: 90,
  detect(): Promise<ProviderAvailability> {
    return probeVersion({
      bin: resolveBin('CODEX_BIN', 'codex'),
      displayName: 'codex',
      installHint: 'Codex CLI 설치: npm install -g @openai/codex',
    });
  },
  run: runCodex,
};
