import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NotesResponse } from '../../../shared/types.ts';
import { errorMessage, getNotes } from '../api.ts';
import { useLatest } from './useLatest.ts';

/** GET /api/docs/:id/notes for the current doc, plus per-slide Q&A counts for the viewer badges. */
export function useNotes(docId: string | null) {
  const [state, setState] = useState<{ docId: string; notes: NotesResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const docIdRef = useLatest(docId);

  const refresh = useCallback(
    async (forDoc?: string) => {
      const target = forDoc ?? docIdRef.current;
      if (!target) return;
      setLoading(true);
      try {
        const notes = await getNotes(target);
        // Ignore responses for a doc the user already left.
        if (docIdRef.current === target) {
          setState({ docId: target, notes });
          setError(null);
        }
      } catch (e) {
        if (docIdRef.current === target) setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [docIdRef],
  );

  useEffect(() => {
    setError(null);
    if (docId) void refresh(docId);
  }, [docId, refresh]);

  const notes = state && state.docId === docId ? state.notes : null;

  const qaCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of notes?.slides ?? []) counts.set(s.slide, s.entries.length);
    return counts;
  }, [notes]);

  return { notes, qaCounts, error, loading, refresh };
}
