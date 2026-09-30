// What the record buttons do (the top bar's and the 녹음 tab's): explain an insecure origin, show the one-time
// notice about recording rules, then start (inside the click: the microphone and AudioContext need the gesture).
import type { RecordingInfo } from '../../../../shared/types.ts';
import { finishRecordingOnServer, getAsrStatus, recordingErrorMessage } from '../../api.ts';
import { confirmDialog } from '../confirm.ts';
import { toast } from '../toast.ts';
import { peekRecordingFeed } from './feeds.ts';
import { notifyRecordingsChanged } from './bus.ts';
import { updateFeedInfo } from './feeds.ts';
import { CONSENT_NOTICE, transcriptionBlocker } from './labels.ts';
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
  const ok = await confirmDialog({
    title: blocking ? '다른 녹음이 아직 진행 중인 것으로 되어 있어요' : `‘${info.title}’ 녹음을 여기서 끝낼까요?`,
    message:
      `‘${info.title}’ 녹음이 다른 기기(또는 브라우저)에서 진행 중인 것으로 되어 있어요 — 서버에는 ${formatClock(info.durationSec)}까지 올라와 있어요. ` +
      '그 기기에서 아직 녹음하고 있다면 거기서 멈춰 주세요. 그 기기를 더 쓸 수 없다면 여기서 끝낼 수 있어요: 서버에 올라온 부분으로 녹음을 마치고 받아쓰기와 슬라이드 정렬을 끝내요. ' +
      '그 기기에서 아직 올리지 못한 부분은 사라져요.' +
      (blocking ? ' 끝낸 뒤에 새 녹음을 시작할 수 있어요.' : ''),
    confirmLabel: '그 녹음 끝내기',
    danger: true,
  });
  if (!ok) return null;
  try {
    const next = await finishRecordingOnServer(info.docId, info.id);
    updateFeedInfo(next);
    notifyRecordingsChanged(info.docId);
    toast(
      blocking
        ? `‘${info.title}’ 녹음을 끝냈어요. 이제 녹음 시작을 다시 누르세요.`
        : `‘${info.title}’ 녹음을 끝냈어요. 남은 받아쓰기와 슬라이드 정렬이 끝나면 다시 들을 수 있어요.`,
      'success',
      8000,
    );
    return next;
  } catch (e) {
    toast(`녹음을 끝내지 못했어요: ${recordingErrorMessage(e)}`, 'error');
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
    toast(`녹음을 멈추지 못했어요: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}
