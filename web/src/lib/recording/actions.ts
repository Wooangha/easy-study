// What the record buttons do (the top bar's and the 녹음 tab's): explain an insecure origin, show the one-time
// notice about recording rules, then start (inside the click: the microphone and AudioContext need the gesture).
import { getAsrStatus } from '../../api.ts';
import { confirmDialog } from '../confirm.ts';
import { toast } from '../toast.ts';
import { peekRecordingFeed } from './feeds.ts';
import { CONSENT_NOTICE, transcriptionBlocker } from './labels.ts';
import { recorder } from './recorder.ts';
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
  await confirmDialog({ title: '이 연결에서는 녹음할 수 없어요', message: reason, confirmLabel: '확인', alert: true });
}

/** The record button: start recording `docId` (the viewer shows `slide`). */
export async function startRecording(docId: string, slide: number | null): Promise<void> {
  const unavailable = recorder.unavailableReason();
  if (unavailable) {
    await explainUnavailable(unavailable);
    return;
  }
  if (!hasRecordingConsent()) {
    const ok = await confirmDialog({
      title: CONSENT_NOTICE.title,
      message: CONSENT_NOTICE.message,
      confirmLabel: CONSENT_NOTICE.confirmLabel,
    });
    if (!ok) return;
    setRecordingConsent();
  }
  try {
    await recorder.start(docId, slide);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error', 12000);
    return;
  }
  void warnIfNotTranscribing();
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
    toast(`녹음을 멈추지 못했어요: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}
