// Recording files being uploaded ("녹음 파일 올리기", DESIGN §22), from the library's lecture menu or the 녹음 tab.
// A small shared store: the lecture row and the 녹음 tab both show the progress, and the upload goes on while the
// user moves around the app.
import type { RecordingInfo } from '../../../../shared/types.ts';
import { ApiError, isAbortError, recordingErrorMessage, uploadRecording } from '../../api.ts';
import { toast } from '../toast.ts';
import { recordingFileProblem, titleFromFileName } from './labels.ts';
import { notifyRecordingsChanged } from './bus.ts';
import { getRecordingSettings } from './settings.ts';

export interface RecordingUpload {
  id: number;
  docId: string;
  name: string;
  size: number;
  /** 0..1 */
  fraction: number;
}

let uploads: RecordingUpload[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const controllers = new Map<number, AbortController>();

function emit(): void {
  for (const l of listeners) l();
}

function patch(id: number, p: Partial<RecordingUpload>): void {
  uploads = uploads.map((u) => (u.id === id ? { ...u, ...p } : u));
  emit();
}

export function getRecordingUploads(): RecordingUpload[] {
  return uploads;
}

export function subscribeRecordingUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Cancel an upload in progress. */
export function cancelRecordingUpload(id: number): void {
  controllers.get(id)?.abort();
}

/**
 * Upload recording files of a lecture, one after another (they are large). Files that are not audio/video or too
 * large are refused at once with a toast. Resolves with the recordings the server created.
 */
export async function uploadRecordingFiles(docId: string, docTitle: string, files: File[]): Promise<RecordingInfo[]> {
  const accepted: File[] = [];
  for (const file of files) {
    const problem = recordingFileProblem(file);
    if (problem) toast(problem, 'error');
    else accepted.push(file);
  }
  const items = accepted.map((file) => {
    const item: RecordingUpload = { id: nextId++, docId, name: file.name, size: file.size, fraction: 0 };
    return { file, item };
  });
  if (items.length === 0) return [];
  uploads = [...uploads, ...items.map((x) => x.item)];
  emit();
  const created: RecordingInfo[] = [];
  for (const { file, item } of items) {
    const controller = new AbortController();
    controllers.set(item.id, controller);
    const settings = getRecordingSettings();
    try {
      const info = await uploadRecording(docId, file, {
        name: file.name,
        language: settings.language,
        model: settings.model ?? undefined,
        onProgress: (fraction) => patch(item.id, { fraction }),
        signal: controller.signal,
      });
      created.push(info);
      toast(
        `‘${titleFromFileName(file.name)}’ 녹음을 ‘${docTitle}’에 올렸어요. 변환과 받아쓰기가 끝나면 녹음 탭에서 볼 수 있어요.`,
        'success',
        6000,
      );
      notifyRecordingsChanged(docId);
    } catch (e) {
      if (isAbortError(e)) {
        toast(`‘${file.name}’ 올리기를 취소했어요.`, 'info');
      } else if (e instanceof ApiError && e.status === 413) {
        toast(`‘${file.name}’이(가) 너무 커서 올리지 못했어요.`, 'error');
      } else {
        toast(`‘${file.name}’을(를) 올리지 못했어요: ${recordingErrorMessage(e)}`, 'error');
      }
    } finally {
      controllers.delete(item.id);
      uploads = uploads.filter((u) => u.id !== item.id);
      emit();
    }
  }
  return created;
}
