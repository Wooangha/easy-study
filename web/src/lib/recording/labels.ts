// Copy and small decisions of the recording UI (DESIGN §22): status badges, progress, microphone errors, the
// insecure-origin explanation, which files can be uploaded. Pure helpers, no DOM; the texts are the current
// language's (namespace `recording`, web/src/i18n).
import type {
  AlignmentKind,
  AsrModelInfo,
  AsrStatus,
  ProviderInfo,
  RecordingInfo,
  RecordingLanguage,
} from '../../../../shared/types.ts';
import { MAX_RECORDING_UPLOAD_BYTES } from '../../../../shared/types.ts';
import { msg } from '../../i18n/index.ts';
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

/** The icon drawn before a status badge's text (the text itself has none, DESIGN §22). */
export type StatusIcon = 'live' | 'paused' | 'waiting' | 'warning' | 'done';

export interface RecordingStatus {
  text: string;
  tone: Tone;
  icon?: StatusIcon;
  title?: string;
}

/** The status badge of a recording in the list. */
export function recordingStatus(info: RecordingInfo): RecordingStatus {
  const m = msg().recording.status;
  switch (info.status) {
    case 'recording':
      return { text: m.recording, tone: 'live', icon: 'live' };
    case 'paused':
      return { text: m.paused, tone: 'warn', icon: 'paused' };
    case 'converting':
      return { text: m.converting, tone: 'running', icon: 'waiting', title: m.convertingTitle };
    case 'error':
      return { text: m.error, tone: 'error', icon: 'warning', title: info.error };
    case 'ready':
      break;
  }
  switch (info.transcriptStatus) {
    case 'queued':
      return { text: m.queued, tone: 'running', icon: 'waiting', title: m.queuedTitle };
    case 'running': {
      const f = transcriptFraction(info);
      return { text: f === null ? m.transcribing : m.transcribingPercent(Math.round(f * 100)), tone: 'running', icon: 'waiting' };
    }
    case 'ready':
      return { text: m.transcribed, tone: 'ok', icon: 'done' };
    case 'error':
      return { text: m.transcriptFailed, tone: 'error', icon: 'warning', title: info.error };
    case 'none':
      return { text: m.notTranscribed, tone: 'muted' };
  }
}

/** How the slides were assigned (badge), or null when there is nothing to say. */
export function alignmentLabel(kind: AlignmentKind): { text: string; title: string } | null {
  const m = msg().recording.alignment;
  switch (kind) {
    case 'timeline':
      return { text: m.timeline, title: m.timelineTitle };
    case 'lexical':
      return { text: m.lexical, title: m.lexicalTitle };
    case 'llm':
      return { text: m.llm, title: m.llmTitle };
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
  return fallback && fallback.id !== '' ? fallback.label : msg().recording.defaultModel;
}

/** "12:34 · 받아쓰기 11:50까지" for a live recording, "1:02:03" otherwise. */
export function durationLine(info: RecordingInfo): string {
  const total = formatClock(info.durationSec);
  if (isLive(info) && info.liveTranscribe && info.transcriptStatus !== 'none') {
    return msg().recording.durationLive(total, formatClock(info.transcribedSec));
  }
  return total;
}

/** The lecture languages a new recording can use, in the order the settings offer them. */
export const RECORDING_LANGUAGES: readonly RecordingLanguage[] = ['ko', 'en', 'auto'];

export function languageLabel(language: RecordingLanguage): string {
  const labels: Readonly<Record<string, string>> = msg().recording.languages;
  return Object.hasOwn(labels, language) ? labels[language] : language;
}

/** A language whisper reported ("en" → "영어"), or its code when it is not one of the named ones. */
function detectedName(code: string): string {
  const names: Readonly<Record<string, string>> = msg().recording.detectedLanguages;
  return Object.hasOwn(names, code) ? names[code] : code;
}

/** The language of a recording: "한국어", or for 'auto' what whisper found — "자동 감지 (영어)" — once it did. */
export function recordingLanguageLabel(info: Pick<RecordingInfo, 'language' | 'detectedLanguage'>): string {
  if (info.language !== 'auto' || !info.detectedLanguage) return languageLabel(info.language);
  return msg().recording.autoDetected(detectedName(info.detectedLanguage));
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
  const m = msg().recording.asr;
  if (!status.engineAvailable) return status.reason ?? m.engineMissing;
  if (!model) return m.noModel;
  return null;
}

/**
 * Why a recording that just started will not be transcribed yet (the recording itself goes on), or null: the
 * engine is missing, or the model the recording uses is not installed (DESIGN §22: models are downloaded on first
 * use; the transcription waits for them).
 */
export function transcriptionBlocker(status: AsrStatus, modelId: string | null): string | null {
  const m = msg().recording.asr;
  if (!status.engineAvailable) return m.blockedEngine(status.reason ?? m.engineMissing);
  const model = status.models.find((x) => x.id === modelId);
  if (model && !model.installed) return m.blockedModel(model.label, formatSize(model.sizeBytes));
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

/** A getUserMedia / AudioContext failure as a clear message. */
export function micErrorMessage(error: unknown, platform: MicPlatform = 'other'): string {
  const m = msg().recording.mic;
  const name = error instanceof Error || (error && typeof error === 'object' && 'name' in error) ? String((error as { name: unknown }).name) : '';
  const detail = error instanceof Error ? error.message : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError': {
      const denied = m.notAllowed(m.privacySetting[platform]);
      // macOS keeps the permission per signature: after an update of the desktop app (signed without a developer
      // ID) the switch can show "on" and still deny (DESIGN §24).
      return platform === 'mac' ? `${denied} ${m.notAllowedMac}` : denied;
    }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return platform === 'linux' ? m.notFoundLinux : m.notFound;
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return m.notReadable;
    case 'NotSupportedError':
      return m.notSupported;
    default:
      return detail ? m.failedDetail(detail) : m.failed;
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
  const m = msg().recording.unavailable;
  if (!env.isSecureContext) return m.insecure(env.origin);
  if (!env.hasMediaDevices) return m.noMediaDevices;
  if (!env.hasAudioWorklet) return m.noAudioWorklet;
  return null;
}

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
  const m = msg().recording.files;
  if (!isRecordingFile(file)) return m.notAudio(file.name);
  if (file.size <= 0) return m.empty(file.name);
  if (file.size > MAX_RECORDING_UPLOAD_BYTES) return m.tooLarge(file.name, formatSize(MAX_RECORDING_UPLOAD_BYTES));
  return null;
}

/** The title of an uploaded recording before the server answers: the file name without its extension. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return base || name;
}
