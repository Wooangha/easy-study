// What the record buttons do (the top bar's and the 녹음 tab's): explain an insecure origin, show the one-time
// notice about recording rules, then start (inside the click: the microphone and AudioContext need the gesture).
import type { RecordingInfo } from '../../../../shared/types.ts';
import { finishRecordingOnServer, getAsrStatus, recordingErrorMessage } from '../../api.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../confirm.ts';
import { toast } from '../toast.ts';
import { peekRecordingFeed } from './feeds.ts';
import { notifyRecordingsChanged } from './bus.ts';
import { updateFeedInfo } from './feeds.ts';
import { transcriptionBlocker } from './labels.ts';
import { RecordingBusyError, recorder } from './recorder.ts';
import { formatClock } from './timeline.ts';
import { hasRecordingConsent, setRecordingConsent } from './settings.ts';

/** Right after a start: say so when the recording cannot be transcribed yet (engine or model missing). */
async function warnIfNotTranscribing(): Promise<void> {
  const s = recorder.getSnapshot();
  if (!s.docId || !s.recordingId) return;
  const info = peekRecordingFeed(s.docId, s.recordingId)?.snapshot.info ?? null;
  try {
    const problem = transcriptionBlocker(await getAsrStatus(), info?.model ?? null);
    if (problem) toast(problem, 'info', 12000);
  } catch {
    /* the 녹음 tab shows the engine state */
  }
}

/** Why this page cannot record, as a dialog. */
export async function explainUnavailable(reason: string): Promise<void> {
  await confirmDialog({ title: msg().recording.actions.unavailableTitle, message: reason, confirmLabel: msg().common.ok, alert: true });
}

/** The record button: start recording `docId` (the viewer shows `slide`). */
export async function startRecording(docId: string, slide: number | null): Promise<void> {
  const unavailable = recorder.unavailableReason();
  if (unavailable) {
    await explainUnavailable(unavailable);
    return;
  }
  if (!hasRecordingConsent()) {
    // One-time notice before the first recording (DESIGN §22).
    const notice = msg().recording.consent;
    const ok = await confirmDialog({
      title: notice.title,
      message: notice.message,
      confirmLabel: notice.confirmLabel,
    });
    if (!ok) return;
    setRecordingConsent();
  }
  try {
    await recorder.start(docId, slide);
  } catch (e) {
    if (e instanceof RecordingBusyError && !recordedHere(e.recording.id)) {
      // Maybe a recording whose device is gone (another computer, a cleared browser): it can be ended from here.
      await finishRecordingElsewhere(e.recording, true);
      return;
    }
    toast(e instanceof Error ? e.message : String(e), 'error', 12000);
    return;
  }
  void warnIfNotTranscribing();
}

/** This page records or keeps (interrupted) the recording `id`. */
export function recordedHere(id: string): boolean {
  const s = recorder.getSnapshot();
  return s.recordingId === id || s.interrupted.some((r) => r.id === id);
}

/**
 * "녹음 끝내기" of a live recording another device (or browser) was making: after a confirmation, the server ends it
 * with the audio it has. `blocking`: asked because it keeps a new recording from starting. Resolves with the ended
 * recording, or null (not confirmed, or failed — said in a toast).
 */
export async function finishRecordingElsewhere(info: RecordingInfo, blocking = false): Promise<RecordingInfo | null> {
  const m = msg().recording.actions;
  const d = m.finishElsewhere;
  const message = d.message(info.title, formatClock(info.durationSec));
  const ok = await confirmDialog({
    title: blocking ? d.titleBlocking : d.title(info.title),
    message: blocking ? `${message} ${d.blockingNote}` : message,
    confirmLabel: d.confirmLabel,
    danger: true,
  });
  if (!ok) return null;
  try {
    const next = await finishRecordingOnServer(info.docId, info.id);
    updateFeedInfo(next);
    notifyRecordingsChanged(info.docId);
    toast(blocking ? m.finishedBlocking(info.title) : m.finished(info.title), 'success', 8000);
    return next;
  } catch (e) {
    toast(m.finishFailed(recordingErrorMessage(e)), 'error');
    return null;
  }
}

/** "이어서 녹음" of a recording a reload interrupted. */
export async function continueRecording(id: string): Promise<void> {
  const unavailable = recorder.unavailableReason();
  if (unavailable) {
    await explainUnavailable(unavailable);
    return;
  }
  try {
    await recorder.continueInterrupted(id);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error', 12000);
    return;
  }
  void warnIfNotTranscribing();
}

export async function resumeRecording(): Promise<void> {
  try {
    await recorder.resume();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error', 12000);
  }
}

export async function stopRecording(): Promise<void> {
  try {
    await recorder.stop();
  } catch (e) {
    toast(msg().recording.actions.stopFailed(e instanceof Error ? e.message : String(e)), 'error');
  }
}
