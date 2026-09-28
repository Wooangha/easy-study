// The recordings of the open lecture (DESIGN §22): loaded with the lecture, reloaded when something changes (a
// recording started / stopped here, an upload finished), and polled while one is in progress and the 녹음 tab is
// shown. The feeds of the recordings get every fresh RecordingInfo.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingInfo } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { onRecordingsChanged } from '../lib/recording/bus.ts';
import { updateFeedInfo } from '../lib/recording/feeds.ts';
import { isInProgress } from '../lib/recording/labels.ts';
import { useLatest } from './useLatest.ts';

const POLL_MS = 3000;

export function useRecordings(docId: string | null, active: boolean) {
  const [state, setState] = useState<{ docId: string; list: RecordingInfo[] } | null>(null);
  const [error, setError] = useState<{ docId: string; message: string } | null>(null);
  const docIdRef = useLatest(docId);
  const seq = useRef(0);

  const refresh = useCallback(
    async (forDoc?: string) => {
      const target = forDoc ?? docIdRef.current;
      if (!target) return;
      const mine = ++seq.current;
      try {
        const list = await api.listRecordings(target);
        if (docIdRef.current !== target || mine !== seq.current) return;
        setState({ docId: target, list });
        setError(null);
        for (const info of list) updateFeedInfo(info);
      } catch (e) {
        if (docIdRef.current === target) setError({ docId: target, message: api.recordingErrorMessage(e) });
      }
    },
    [docIdRef],
  );

  useEffect(() => {
    if (docId) void refresh(docId);
  }, [docId, refresh]);

  useEffect(
    () =>
      onRecordingsChanged((changed) => {
        if (changed === docIdRef.current) void refresh(changed);
      }),
    [docIdRef, refresh],
  );

  const list = state && state.docId === docId ? state.list : null;
  const busy = !!list?.some(isInProgress);

  useEffect(() => {
    if (!docId || !active || !busy) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      await refresh(docId);
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [docId, active, busy, refresh]);

  /** Replace one recording in the list (rename, a status event). */
  const patch = useCallback((info: RecordingInfo) => {
    setState((s) => (s && s.docId === info.docId ? { ...s, list: s.list.map((r) => (r.id === info.id ? info : r)) } : s));
  }, []);

  const removeLocally = useCallback((rid: string) => {
    setState((s) => (s ? { ...s, list: s.list.filter((r) => r.id !== rid) } : s));
  }, []);

  return {
    list,
    error: error && error.docId === docId ? error.message : null,
    refresh,
    patch,
    removeLocally,
  };
}

export type RecordingsState = ReturnType<typeof useRecordings>;
