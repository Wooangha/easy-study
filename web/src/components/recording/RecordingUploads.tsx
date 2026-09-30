// "녹음 파일 올리기" from the library (DESIGN §22): the lecture menus ask App to pick files for a lecture through this
// context, and show the lecture's recording uploads in progress.
import { Mic } from 'lucide-react';
import { createContext, useContext } from 'react';
import type { DocMeta } from '../../../../shared/types.ts';
import { useRecordingUploads } from '../../hooks/useRecorder.ts';

/** Opens the file picker for recordings of this lecture (null where uploading is not offered). */
export const RecordingUploadContext = createContext<((doc: DocMeta) => void) | null>(null);

export function useRecordingUploadPicker(): ((doc: DocMeta) => void) | null {
  return useContext(RecordingUploadContext);
}

/** "녹음 올리는 중 42%" (with a microphone) on a lecture while its recording files upload. */
export function RecordingUploadBadge({ docId }: { docId: string }) {
  const uploads = useRecordingUploads().filter((u) => u.docId === docId);
  if (uploads.length === 0) return null;
  const size = uploads.reduce((n, u) => n + u.size, 0);
  const done = uploads.reduce((n, u) => n + u.fraction * u.size, 0);
  const pct = size > 0 ? Math.round((done / size) * 100) : 0;
  return (
    <span className="digest-badge is-running" title={uploads.map((u) => u.name).join('\n')}>
      <Mic /> 녹음 올리는 중 {pct}%
    </span>
  );
}
