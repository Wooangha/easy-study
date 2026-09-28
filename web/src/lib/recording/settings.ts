// Recording settings of this device (DESIGN §22): which speech-recognition model, which language, and whether a
// live recording is transcribed while it runs. Used for new live recordings and uploads. A tiny shared store
// (the 녹음 tab's settings and the record button read the same values).
import type { RecordingLanguage } from '../../../../shared/types.ts';
import { isBoolean, readStorage, storageKeys, writeStorage } from '../storage.ts';

export interface RecordingSettings {
  /** Whisper model id; null = the server's recommended model. */
  model: string | null;
  language: RecordingLanguage;
  liveTranscribe: boolean;
}

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = { model: null, language: 'ko', liveTranscribe: true };

const LANGUAGES: readonly RecordingLanguage[] = ['ko', 'en', 'auto'];

/** Stored settings with every field checked (anything malformed falls back to the default). */
export function parseRecordingSettings(value: unknown): RecordingSettings {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    model: typeof v.model === 'string' && v.model.length > 0 && v.model.length <= 100 ? v.model : null,
    language: LANGUAGES.includes(v.language as RecordingLanguage) ? (v.language as RecordingLanguage) : 'ko',
    liveTranscribe: typeof v.liveTranscribe === 'boolean' ? v.liveTranscribe : true,
  };
}

let current: RecordingSettings | null = null;
const listeners = new Set<() => void>();

export function getRecordingSettings(): RecordingSettings {
  current ??= parseRecordingSettings(readStorage<unknown>(storageKeys.recordingSettings, null));
  return current;
}

export function setRecordingSettings(patch: Partial<RecordingSettings>): void {
  current = { ...getRecordingSettings(), ...patch };
  writeStorage(storageKeys.recordingSettings, current);
  for (const l of listeners) l();
}

export function subscribeRecordingSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The one-time notice about the professor's / school's recording rules was confirmed on this device. */
export function hasRecordingConsent(): boolean {
  return readStorage(storageKeys.recordingConsent, false, isBoolean);
}

export function setRecordingConsent(): void {
  writeStorage(storageKeys.recordingConsent, true);
}
