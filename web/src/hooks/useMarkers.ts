// "여기부터 p.N" markers of one recording (DESIGN §22). The list is edited with markersReducer and PUT whole; the
// answer (the transcript re-aligned with the markers as hard constraints) replaces the feed's transcript. The list
// the server stores comes with the transcript (RecordingTranscript.markers, DESIGN §28: renumbered when a new version
// of the PDF is applied) and is the one shown; a server that does not send it leaves the list sent last from this
// device (remembered here).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlignmentMarker } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { msg } from '../i18n/index.ts';
import { recordingFeed } from '../lib/recording/feeds.ts';
import { markersReducer, parseStoredMarkers, sameMarkers, type MarkerAction } from '../lib/recording/markers.ts';
import { readStorage, storageKeys, writeStorage } from '../lib/storage.ts';
import { toast } from '../lib/toast.ts';

function load(rid: string | null, server: readonly AlignmentMarker[] | null): AlignmentMarker[] {
  if (server) return parseStoredMarkers(server);
  return rid ? parseStoredMarkers(readStorage<unknown>(storageKeys.recordingMarkers(rid), [])) : [];
}

/** `serverMarkers`: the feed's (FeedSnapshot.markers), null while unknown. */
export function useMarkers(
  docId: string,
  rid: string | null,
  pageCount: number,
  onSaved?: () => void,
  serverMarkers: AlignmentMarker[] | null = null,
) {
  const [state, setState] = useState<{ rid: string | null; markers: AlignmentMarker[] }>(() => ({ rid, markers: load(rid, serverMarkers) }));
  const [pending, setPending] = useState(false);
  const markers = state.rid === rid ? state.markers : load(rid, serverMarkers);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  /** Edits are sent one after another (each PUT carries the whole list). */
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    setState({ rid, markers: load(rid, null) });
  }, [rid]);

  // The server's list (loaded, or answered by a PUT) replaces what this device remembers.
  useEffect(() => {
    if (!rid || !serverMarkers) return;
    const next = parseStoredMarkers(serverMarkers);
    setState({ rid, markers: next });
    markersRef.current = next;
    writeStorage(storageKeys.recordingMarkers(rid), next.length > 0 ? next : null);
  }, [rid, serverMarkers]);

  const apply = useCallback(
    (action: MarkerAction): Promise<boolean> => {
      if (!rid) return Promise.resolve(false);
      const run = async (): Promise<boolean> => {
        const before = markersRef.current;
        const next = markersReducer(before, action, pageCount);
        if (sameMarkers(before, next)) return true;
        setState({ rid, markers: next });
        markersRef.current = next;
        setPending(true);
        try {
          const transcript = await api.putRecordingMarkers(docId, rid, next);
          recordingFeed(docId, rid).setTranscript(transcript);
          writeStorage(storageKeys.recordingMarkers(rid), next.length > 0 ? next : null);
          onSaved?.();
          return true;
        } catch (e) {
          setState({ rid, markers: before });
          markersRef.current = before;
          toast(msg().recording.markers.saveFailed(api.recordingErrorMessage(e)), 'error');
          return false;
        } finally {
          setPending(false);
        }
      };
      const result = chain.current.then(run, run);
      chain.current = result;
      return result;
    },
    [docId, rid, pageCount, onSaved],
  );

  return { markers, pending, apply };
}
