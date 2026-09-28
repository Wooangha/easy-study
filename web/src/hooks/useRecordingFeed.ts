// One recording's transcript and live status (lib/recording/feeds.ts), for React. null `rid` → null.
import { useCallback, useSyncExternalStore } from 'react';
import type { RecordingInfo } from '../../../shared/types.ts';
import { peekRecordingFeed, recordingFeed, type FeedSnapshot } from '../lib/recording/feeds.ts';

const NOT_LOADED: FeedSnapshot = {
  info: null,
  segments: [],
  loaded: false,
  error: null,
  connection: 'stopped',
  aligning: false,
};

/** `info` (what the list knows) seeds a feed that is created now; later infos arrive through updateFeedInfo. */
export function useRecordingFeed(docId: string | null, rid: string | null, info?: RecordingInfo | null): FeedSnapshot | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!docId || !rid) return () => {};
      const unsubscribe = recordingFeed(docId, rid, { info }).subscribe(listener);
      listener(); // the feed may have been created just now
      return unsubscribe;
    },
    [docId, rid],
  );
  const get = useCallback(
    () => (docId && rid ? (peekRecordingFeed(docId, rid)?.snapshot ?? NOT_LOADED) : null),
    [docId, rid],
  );
  return useSyncExternalStore(subscribe, get);
}
