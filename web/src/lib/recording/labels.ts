// Korean copy and small decisions of the recording UI (DESIGN §22): status badges, progress, microphone errors,
// the insecure-origin explanation, which files can be uploaded. Pure helpers, no DOM.
import type {
  AlignmentKind,
  AsrModelInfo,
  AsrStatus,
  ProviderInfo,
  RecordingInfo,
  RecordingLanguage,
} from '../../../../shared/types.ts';
import { MAX_RECORDING_UPLOAD_BYTES } from '../../../../shared/types.ts';
import { formatClock } from './timeline.ts';

export type Tone = 'live' | 'running' | 'ok' | 'warn' | 'error' | 'muted';

/** A live recording that still takes audio. */
export function isLive(info: Pick<RecordingInfo, 'status'>): boolean {
  return info.status === 'recording' || info.status === 'paused';
}

/** Something still happens to it on the server (recording, conversion, transcription). */
export function isInProgress(info: Pick<RecordingInfo, 'status' | 'transcriptStatus'>): boolean {
  return (
    isLive(info) ||
    info.status === 'converting' ||
    info.transcriptStatus === 'queued' ||
    info.transcriptStatus === 'running'
  );
}

/** Share of the audio transcribed (0..1), or null when unknown. */
export function transcriptFraction(info: Pick<RecordingInfo, 'durationSec' | 'transcribedSec'>): number | null {
  if (!(info.durationSec > 0)) return null;
  return Math.min(1, Math.max(0, info.transcribedSec / info.durationSec));
}

/** The status badge of a recording in the list. */
export function recordingStatus(info: RecordingInfo): { text: string; tone: Tone; title?: string } {
  switch (info.status) {
    case 'recording':
      return { text: '● 녹음 중', tone: 'live' };
    case 'paused':
      return { text: '⏸ 일시정지', tone: 'warn' };
    case 'converting':
      return { text: '⏳ 변환 중', tone: 'running', title: '올린 파일에서 소리를 꺼내는 중이에요' };
    case 'error':
      return { text: '⚠️ 오류', tone: 'error', title: info.error };
    case 'ready':
      break;
  }
  switch (info.transcriptStatus) {
    case 'queued':
      return { text: '⏳ 받아쓰기 대기', tone: 'running', title: '다른 녹음을 받아쓰는 중이에요. 차례가 오면 시작해요' };
    case 'running': {
      const f = transcriptFraction(info);
      return { text: f === null ? '⏳ 받아쓰는 중' : `⏳ 받아쓰기 ${Math.round(f * 100)}%`, tone: 'running' };
    }
    case 'ready':
      return { text: '✓ 받아쓰기 완료', tone: 'ok' };
    case 'error':
      return { text: '⚠️ 받아쓰기 실패', tone: 'error', title: info.error };
    case 'none':
      return { text: '받아쓰기 전', tone: 'muted' };
  }
}

/** How the slides were assigned (badge), or null when there is nothing to say. */
export function alignmentLabel(kind: AlignmentKind): { text: string; title: string } | null {
  switch (kind) {
    case 'timeline':
      return { text: '보던 슬라이드 기준', title: '녹음하는 동안 보고 있던 슬라이드를 기준으로 나눴어요 (말의 내용으로 조금 보정)' };
    case 'lexical':
      return { text: '자동 정렬', title: '말한 내용과 슬라이드 글자를 비교해서 나눴어요' };
    case 'llm':
      return { text: 'AI 정렬', title: 'LLM이 말한 내용과 슬라이드를 비교해서 나눴어요' };
    case 'none':
      return null;
  }
}

/**
 * The model "AI 정밀 정렬" runs on with this provider (the request names none, so the server picks it, DESIGN
 * §22): a Haiku model when the provider has one, else the provider's default.
 */
export function aiAlignModelLabel(provider: Pick<ProviderInfo, 'models' | 'defaultModel'>): string {
  const haiku = provider.models.find((m) => /haiku/i.test(m.id));
  if (haiku) return haiku.label;
  const fallback = provider.models.find((m) => m.id === provider.defaultModel);
  return fallback && fallback.id !== '' ? fallback.label : '기본 모델';
}

/** "12:34 · 받아쓰기 11:50까지" for a live recording, "1:02:03" otherwise. */
export function durationLine(info: RecordingInfo): string {
  const total = formatClock(info.durationSec);
  if (isLive(info) && info.liveTranscribe && info.transcriptStatus !== 'none') {
    return `${total} · 받아쓰기 ${formatClock(info.transcribedSec)}까지`;
  }
  return total;
}

export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: RecordingLanguage; label: string }> = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: '영어' },
  { value: 'auto', label: '자동 감지' },
];

export function languageLabel(language: RecordingLanguage): string {
  return LANGUAGE_OPTIONS.find((o) => o.value === language)?.label ?? language;
}

const DETECTED_NAMES: Readonly<Record<string, string>> = { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' };

/** The language of a recording: "한국어", or for 'auto' what whisper found — "자동 감지 (영어)" — once it did. */
export function recordingLanguageLabel(info: Pick<RecordingInfo, 'language' | 'detectedLanguage'>): string {
  if (info.language !== 'auto' || !info.detectedLanguage) return languageLabel(info.language);
  return `${languageLabel('auto')} (${DETECTED_NAMES[info.detectedLanguage] ?? info.detectedLanguage})`;
}

/** "574 MB", "1.2 GB" (decimal, like download sizes are quoted). */
export function formatSize(bytes: number): string {
  if (!(bytes > 0)) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** The model a new recording will use: the chosen one if the server knows it, else the recommended one. */
export function effectiveModel(status: AsrStatus | null, chosen: string | null): AsrModelInfo | null {
  if (!status) return null;
  return (
    status.models.find((m) => m.id === chosen) ??
    status.models.find((m) => m.recommended) ??
    status.models.find((m) => m.installed) ??
    status.models[0] ??
    null
  );
}

/** Download progress of a model (0..1), or null when not downloading. */
export function downloadFraction(model: AsrModelInfo): number | null {
  const d = model.downloading;
  if (!d) return null;
  return d.totalBytes > 0 ? Math.min(1, d.receivedBytes / d.totalBytes) : 0;
}

/** Why transcription cannot run right now (shown above the list), or null when it can. */
export function asrProblem(status: AsrStatus | null, model: AsrModelInfo | null): string | null {
  if (!status) return null;
  if (!status.engineAvailable) return status.reason ?? '음성 인식 엔진(whisper.cpp)을 찾지 못했어요.';
  if (!model) return '사용할 수 있는 음성 인식 모델이 없어요.';
  return null;
}

/**
 * Why a recording that just started will not be transcribed yet (the recording itself goes on), or null: the
 * engine is missing, or the model the recording uses is not installed (DESIGN §22: models are downloaded on first
 * use; the transcription waits for them).
 */
export function transcriptionBlocker(status: AsrStatus, modelId: string | null): string | null {
  if (!status.engineAvailable) {
    return `녹음은 저장되지만 아직 받아쓸 수 없어요: ${status.reason ?? '음성 인식 엔진(whisper.cpp)을 찾지 못했어요.'}`;
  }
  const model = status.models.find((m) => m.id === modelId);
  if (model && !model.installed) {
    return (
      `받아쓰기에 필요한 음성 인식 모델이 아직 없어요: ${model.label} (${formatSize(model.sizeBytes)}). ` +
      '녹음 탭에서 내려받으면 그때부터 받아써요 — 녹음은 그대로 계속돼요.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------------------------------------------

export type MicPlatform = 'mac' | 'windows' | 'linux' | 'ios' | 'android' | 'other';

export function detectPlatform(userAgent: string, maxTouchPoints = 0): MicPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'mac';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return 'other';
}

const PRIVACY_SETTING: Record<MicPlatform, string> = {
  mac: '시스템 설정 › 개인정보 보호 및 보안 › 마이크',
  windows: '설정 › 개인 정보 및 보안 › 마이크 (‘데스크톱 앱이 마이크에 액세스하도록 허용’도 켜기)',
  linux: '시스템의 소리 설정',
  ios: '설정 › 개인정보 보호 및 보안 › 마이크',
  android: '설정 › 앱 › 권한 › 마이크',
  other: '운영체제의 개인정보(마이크) 설정',
};

/** A getUserMedia / AudioContext failure as a clear Korean message. */
export function micErrorMessage(error: unknown, platform: MicPlatform = 'other'): string {
  const name = error instanceof Error || (error && typeof error === 'object' && 'name' in error) ? String((error as { name: unknown }).name) : '';
  const detail = error instanceof Error ? error.message : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return (
        '마이크 사용이 허용되지 않았어요. 주소창의 마이크(🔒) 아이콘에서 이 사이트의 마이크를 허용하고, ' +
        `${PRIVACY_SETTING[platform]}에서 이 앱(또는 브라우저)이 켜져 있는지 확인해 주세요.` +
        // macOS keeps the permission per signature: after an update of the desktop app (signed without a developer
        // ID) the switch can show "on" and still deny (DESIGN §24).
        (platform === 'mac' ? ' 켜져 있는데도 안 되면 껐다가 다시 켜 주세요 (앱을 업데이트한 뒤에 그럴 수 있어요).' : '')
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return platform === 'linux'
        ? '마이크를 찾지 못했어요. 마이크가 연결되어 있는지, 오디오 서버(PipeWire 또는 PulseAudio)가 실행 중인지 확인해 주세요.'
        : '마이크를 찾지 못했어요. 마이크가 연결되어 있는지 확인해 주세요.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return '마이크를 열 수 없어요. 다른 앱(화상 회의 등)이 마이크를 쓰고 있지 않은지 확인하고 다시 시도해 주세요.';
    case 'NotSupportedError':
      return '이 브라우저는 16 kHz 녹음을 지원하지 않아요. 최신 Chrome·Edge·Safari 또는 easy-study 앱을 써 주세요.';
    default:
      return `마이크를 시작하지 못했어요${detail ? `: ${detail}` : ''}`;
  }
}

/**
 * Why this page cannot record at all, or null. Browsers hide the microphone (and AudioWorklet) from pages that
 * are not a secure context: plain http:// on another computer's address (DESIGN §16/§22).
 */
export function recordingUnavailableReason(env: {
  isSecureContext: boolean;
  hasMediaDevices: boolean;
  hasAudioWorklet: boolean;
  origin: string;
}): string | null {
  if (!env.isSecureContext) {
    return (
      `이 주소(${env.origin})는 보안 연결(HTTPS)이 아니라서 브라우저가 마이크를 막아요. ` +
      '녹음하려면 서버 컴퓨터에서 easy-study 앱이나 http://127.0.0.1 주소로 열거나, ' +
      'easy-study 앱으로 그 컴퓨터에 연결하거나(앱 안에서는 http 주소여도 녹음돼요), ' +
      'HTTPS로 접속해 주세요 (예: tailscale serve, 또는 EASY_STUDY_TLS_CERT/KEY). 녹음 파일 올리기는 여기서도 돼요.'
    );
  }
  if (!env.hasMediaDevices) {
    return '이 브라우저(또는 앱 창)에서는 마이크를 쓸 수 없어요. 최신 Chrome·Edge·Safari 또는 easy-study 앱을 써 주세요.';
  }
  if (!env.hasAudioWorklet) {
    return '이 브라우저는 녹음에 필요한 기능(AudioWorklet)이 없어요. 최신 Chrome·Edge·Safari 또는 easy-study 앱을 써 주세요.';
  }
  return null;
}

/** One-time notice before the first recording (DESIGN §22). */
export const CONSENT_NOTICE = {
  title: '수업을 녹음하기 전에',
  message:
    '교수님과 학교의 녹음 규정을 먼저 확인해 주세요. 수업 녹음을 허락받지 않았다면 녹음하지 마세요.\n' +
    '녹음은 이 컴퓨터(또는 연결한 easy-study 서버)에만 저장되고, 받아쓰기도 그 컴퓨터에서 해요. ' +
    '녹음 파일과 받아쓴 글은 녹음 탭에서 언제든 지울 수 있어요.',
  confirmLabel: '확인했어요, 녹음하기',
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------------------------------------------

const RECORDING_EXTENSIONS = /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac|webm|weba|mp4|m4v|mov|mkv|avi|wma|caf|aiff?|amr|3gp)$/i;

/** `accept` of the recording file picker. */
export const RECORDING_ACCEPT = 'audio/*,video/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.flac,.webm,.mp4,.mov,.mkv,.caf,.aiff';

/** Is this an audio or video file the server can take (by MIME type, or by extension when the type is empty)? */
export function isRecordingFile(file: { name: string; type: string }): boolean {
  if (/^(audio|video)\//i.test(file.type)) return true;
  return RECORDING_EXTENSIONS.test(file.name);
}

/** Why a picked file is refused before uploading, or null. */
export function recordingFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (!isRecordingFile(file)) return `‘${file.name}’은(는) 오디오·동영상 파일이 아니에요.`;
  if (file.size <= 0) return `‘${file.name}’은(는) 빈 파일이에요.`;
  if (file.size > MAX_RECORDING_UPLOAD_BYTES) {
    return `‘${file.name}’이(가) 너무 커요 (최대 ${formatSize(MAX_RECORDING_UPLOAD_BYTES)}).`;
  }
  return null;
}

/** The title of an uploaded recording before the server answers: the file name without its extension. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return base || name;
}
