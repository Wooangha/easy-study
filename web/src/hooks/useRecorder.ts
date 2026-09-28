// The page's live recorder (lib/recording/recorder.ts) and the recording settings, for React.
import { useSyncExternalStore } from 'react';
import { recorder, type RecorderSnapshot } from '../lib/recording/recorder.ts';
import { getRecordingSettings, subscribeRecordingSettings, type RecordingSettings } from '../lib/recording/settings.ts';
import { getRecordingUploads, subscribeRecordingUploads, type RecordingUpload } from '../lib/recording/uploads.ts';

export function useRecorder(): RecorderSnapshot {
  return useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
}

/** The input level 0..1 (about ten updates a second while recording): subscribe only where the meter is drawn. */
export function useRecorderLevel(): number {
  return useSyncExternalStore(recorder.subscribeLevel, recorder.getLevel);
}

export function useRecordingSettings(): RecordingSettings {
  return useSyncExternalStore(subscribeRecordingSettings, getRecordingSettings);
}

/** Recording files being uploaded (all lectures). */
export function useRecordingUploads(): RecordingUpload[] {
  return useSyncExternalStore(subscribeRecordingUploads, getRecordingUploads);
}
