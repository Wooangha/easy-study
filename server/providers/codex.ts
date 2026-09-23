// codex provider: the user's ChatGPT subscription through the Codex CLI (DESIGN §6).
//
//   new:    codex exec --json --skip-git-repo-check --sandbox read-only -C <cwd> [-m <model>] [-i <img> ...]
//   resume: codex exec resume <threadId> - --json --skip-git-repo-check -c sandbox_mode="read-only"
//           [-m <model>] [-i <img> ...]
//
// The prompt is read from stdin. Images cannot be interleaved with text, so every image part is
// replaced by a "[Attached image #k: label]" marker and the files are passed with -i in that order.
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
}

export function codexArgs(input: CodexArgsInput): string[] {
  const args = input.threadId
    ? ['exec', 'resume', input.threadId, '-', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"']
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', input.cwd];
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

/** Stateful interpreter of `codex exec --json` events. */
export class CodexStreamState {
  text = '';
  threadId: string | undefined;
  completed = false;
  failure: string | null = null;
  lastError: string | null = null;

  private readonly onDelta: (text: string) => void;
  private readonly onStatus: (text: string) => void;

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

  private itemStarted(item: JsonObject): void {
    switch (item.type) {
      case 'reasoning':
        this.onStatus('생각하는 중…');
        break;
      case 'command_execution':
        this.onStatus(`명령 실행 중: ${clip(String(item.command ?? ''), 100)}`);
        break;
      case 'web_search':
        this.onStatus('웹 검색 중…');
        break;
      case 'mcp_tool_call':
        this.onStatus(`도구 사용 중: ${String(item.tool ?? '')}`);
        break;
      default:
        break;
    }
  }

  private itemCompleted(item: JsonObject): void {
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      const chunk = this.text ? `\n\n${item.text}` : item.text;
      this.text += chunk;
      this.onDelta(chunk);
    } else if (item.type === 'error' && typeof item.message === 'string') {
      this.onStatus(`경고: ${clip(item.message, 120)}`);
    }
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
  const threadId = input.resume?.cliSessionId || undefined;
  const { prompt, images } = codexPrompt(input.parts, threadId ? null : input.systemPrompt);
  const args = codexArgs({ cwd: input.cwd, model: input.model, threadId, images });

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
  if (!state.completed && !state.text) throw new Error(`Codex가 응답 없이 종료되었습니다.${tail}`);

  const id = state.threadId ?? threadId;
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
