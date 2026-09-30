// Recording settings of this device (DESIGN §22): which speech-recognition model, which language, and whether a
// live recording is transcribed while it runs. Used for new live recordings and uploads. A tiny shared store
// (the 녹음 tab's settings and the record button read the same values).
import type { RecordingLanguage } from '../../../../shared/types.ts';
import { getLang, subscribeLang, type Lang } from '../../i18n/index.ts';
import { isBoolean, readStorage, storageKeys, writeStorage } from '../storage.ts';

export interface RecordingSettings {
  /** Whisper model id; null = the server's recommended model. */
  model: string | null;
  language: RecordingLanguage;
  liveTranscribe: boolean;
}

/** What this device stored. `language: null` = never chosen: it follows the UI language when read. */
interface StoredRecordingSettings extends Omit<RecordingSettings, 'language'> {
  language: RecordingLanguage | null;
}

const LANGUAGES: readonly RecordingLanguage[] = ['ko', 'en', 'auto'];

/** The lecture language of a UI language: a Korean UI records Korean lectures, an English UI English ones. */
const LECTURE_LANGUAGE: Record<Lang, RecordingLanguage> = { ko: 'ko', en: 'en' };

/** The lecture language when none was chosen on this device: the UI's, read now (it can change while the page is open). */
export function defaultRecordingLanguage(lang: Lang = getLang()): RecordingLanguage {
  return LECTURE_LANGUAGE[lang];
}

function parseStored(value: unknown): StoredRecordingSettings {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    model: typeof v.model === 'string' && v.model.length > 0 && v.model.length <= 100 ? v.model : null,
    language: LANGUAGES.includes(v.language as RecordingLanguage) ? (v.language as RecordingLanguage) : null,
    liveTranscribe: typeof v.liveTranscribe === 'boolean' ? v.liveTranscribe : true,
  };
}

/**
 * Stored settings with every field checked (anything malformed falls back to the default; a missing language to
 * the one of `lang`, the UI language).
 */
export function parseRecordingSettings(value: unknown, lang: Lang = getLang()): RecordingSettings {
  const stored = parseStored(value);
  return { ...stored, language: stored.language ?? defaultRecordingLanguage(lang) };
}

let stored: StoredRecordingSettings | null = null;
/** The last answer of getRecordingSettings (the same object while neither the settings nor the UI language change). */
let resolved: { from: StoredRecordingSettings; lang: Lang; settings: RecordingSettings } | null = null;
const listeners = new Set<() => void>();

function storedSettings(): StoredRecordingSettings {
  stored ??= parseStored(readStorage<unknown>(storageKeys.recordingSettings, null));
  return stored;
}

export function getRecordingSettings(): RecordingSettings {
  const from = storedSettings();
  const lang = getLang();
  if (resolved?.from !== from || resolved.lang !== lang) {
    resolved = { from, lang, settings: { ...from, language: from.language ?? defaultRecordingLanguage(lang) } };
  }
  return resolved.settings;
}

/** Changes the settings of this device. Only a language chosen here is stored (otherwise it keeps following the UI). */
export function setRecordingSettings(patch: Partial<RecordingSettings>): void {
  stored = { ...storedSettings(), ...patch };
  writeStorage(storageKeys.recordingSettings, stored);
  for (const l of listeners) l();
}

/** Called on a change of the settings or of the UI language (which moves a language not chosen here). */
export function subscribeRecordingSettings(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeLang = subscribeLang(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeLang();
  };
}

/** The one-time notice about the professor's / school's recording rules was confirmed on this device. */
export function hasRecordingConsent(): boolean {
  return readStorage(storageKeys.recordingConsent, false, isBoolean);
}

export function setRecordingConsent(): void {
  writeStorage(storageKeys.recordingConsent, true);
}
