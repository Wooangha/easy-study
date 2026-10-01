import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocMeta } from '../../../shared/types.ts';
import { ApiError, deleteDoc, errorMessage, getDoc, listDocs, renameDoc, retryDoc, uploadPdf } from '../api.ts';
import { msg } from '../i18n/index.ts';
import { resetAnnotationStore } from '../lib/annotations/store.ts';
import { toast } from '../lib/toast.ts';
import { useLatest } from './useLatest.ts';

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  /** 0..1 upload progress. */
  fraction: number;
  /** Course the file is being uploaded into (null = uncategorized). */
  courseId: string | null;
}

const POLL_MS = 800;
/** While any document's digest is running, refresh the list this often (digest badges in pickers). */
const DIGEST_POLL_MS = 5000;
/** Back to the window (focus, visible again): the list is refreshed, at most this often. */
const FOCUS_REFRESH_MS = 2000;

/**
 * A lecture shown at a newer deck rev than before (DESIGN §28): what is held of its annotations and text layouts is
 * numbered in the old deck. Replaced in the same tick as the new DocMeta, so the viewer remounted for the new rev
 * never sees the old store.
 */
function resetSwappedDecks(before: readonly DocMeta[] | null, after: readonly DocMeta[]): void {
  if (!before) return;
  const revs = new Map(before.map((d) => [d.id, d.deckRev ?? 0]));
  for (const d of after) {
    const was = revs.get(d.id);
    if (was !== undefined && (d.deckRev ?? 0) > was) resetAnnotationStore(d.id);
  }
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** Library documents: list, upload (with progress) and polling of docs that are still processing. */
export function useDocs() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadSeq = useRef(0);
  const docsRef = useLatest(docs);

  const refresh = useCallback(async () => {
    try {
      const list = await listDocs();
      resetSwappedDecks(docsRef.current, list);
      setDocs(list);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
      setDocs((prev) => prev ?? []);
    }
  }, [docsRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Back to the window: another device may have changed a lecture meanwhile (a new version of its PDF, DESIGN §28).
  useEffect(() => {
    let last = Date.now();
    const again = () => {
      if (Date.now() - last < FOCUS_REFRESH_MS) return;
      last = Date.now();
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') again();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  /** Put a lecture's DocMeta as the server answered it (an apply, an undo, a refetch). */
  const replace = useCallback(
    (doc: DocMeta) => {
      resetSwappedDecks(docsRef.current, [doc]);
      setDocs((prev) => prev && prev.map((d) => (d.id === doc.id ? doc : d)));
    },
    [docsRef],
  );

  /** Fetch one lecture again (its deck was swapped elsewhere). Resolves with it, or null when that failed. */
  const refreshDoc = useCallback(
    async (docId: string): Promise<DocMeta | null> => {
      try {
        const doc = await getDoc(docId);
        replace(doc);
        return doc;
      } catch {
        return null;
      }
    },
    [replace],
  );

  // Poll GET /api/docs/:id every 800 ms for every doc that is still processing.
  const processingIds = useMemo(
    () => (docs ?? []).filter((d) => d.status === 'processing').map((d) => d.id).join(','),
    [docs],
  );
  useEffect(() => {
    if (!processingIds) return;
    const ids = processingIds.split(',');
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const results = await Promise.all(ids.map((id) => getDoc(id).catch(() => null)));
      if (cancelled) return;
      const byId = new Map(results.filter((d): d is DocMeta => d !== null).map((d) => [d.id, d]));
      resetSwappedDecks(docsRef.current, [...byId.values()]);
      setDocs((prev) => prev && prev.map((d) => byId.get(d.id) ?? d));
      for (const d of byId.values()) {
        if (d.status === 'error') toast(msg().chat.docs.processingFailed(d.title, d.error ?? msg().common.unknownError), 'error');
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [processingIds, docsRef]);

  // Digest jobs run in the background (possibly for a document that is not open): keep the badges fresh.
  const digestRunning = useMemo(() => (docs ?? []).some((d) => d.digestStatus === 'running'), [docs]);
  useEffect(() => {
    if (!digestRunning) return;
    const timer = window.setInterval(() => void refresh(), DIGEST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [digestRunning, refresh]);

  /**
   * Uploads PDFs one by one (into `courseId` when given). Resolves with the successfully created docs.
   * `onCreated` runs right after each document is created (e.g. to show it in its course immediately).
   */
  const upload = useCallback(
    async (files: File[], courseId: string | null = null, onCreated?: (doc: DocMeta) => void): Promise<DocMeta[]> => {
      const created: DocMeta[] = [];
      for (const file of files) {
        if (!isPdfFile(file)) {
          toast(msg().chat.attachments.pdfOnly(file.name), 'error');
          continue;
        }
        const id = ++uploadSeq.current;
        setUploads((u) => [...u, { id, name: file.name, size: file.size, fraction: 0, courseId }]);
        try {
          const doc = await uploadPdf(
            file,
            (fraction) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, fraction } : x))),
            courseId,
          );
          setDocs((prev) => [doc, ...(prev ?? []).filter((d) => d.id !== doc.id)]);
          created.push(doc);
          onCreated?.(doc);
        } catch (e) {
          toast(msg().chat.docs.uploadFailed(file.name, errorMessage(e)), 'error');
        } finally {
          setUploads((u) => u.filter((x) => x.id !== id));
        }
      }
      return created;
    },
    [],
  );

  /** Re-run the conversion of a failed document. Resolves true when it restarted (the list then polls it). */
  const retry = useCallback(async (docId: string): Promise<boolean> => {
    try {
      const doc = await retryDoc(docId);
      setDocs((prev) => prev && prev.map((d) => (d.id === docId ? doc : d)));
      return true;
    } catch (e) {
      toast(msg().chat.docs.retryFailed(errorMessage(e)), 'error');
      void refresh();
      return false;
    }
  }, [refresh]);

  /** Rename a lecture. Resolves true when the server took the new title. */
  const rename = useCallback(async (docId: string, title: string): Promise<boolean> => {
    try {
      const doc = await renameDoc(docId, title);
      setDocs((prev) => prev && prev.map((d) => (d.id === docId ? doc : d)));
      return true;
    } catch (e) {
      toast(msg().chat.docs.renameFailed(errorMessage(e)), 'error');
      return false;
    }
  }, []);

  /** Delete a document (after the caller confirmed). Resolves true when it is gone. */
  const remove = useCallback(async (docId: string): Promise<boolean> => {
    try {
      await deleteDoc(docId);
    } catch (e) {
      const busy = e instanceof ApiError && e.status === 409;
      toast(busy ? msg().chat.docs.deleteBusy : msg().chat.docs.deleteFailed(errorMessage(e)), 'error');
      return false;
    }
    setDocs((prev) => prev && prev.filter((d) => d.id !== docId));
    return true;
  }, []);

  /** Locally patch one document (e.g. its digest status) without waiting for the next refresh. */
  const patchDoc = useCallback((docId: string, patch: Partial<DocMeta>) => {
    setDocs((prev) => prev && prev.map((d) => (d.id === docId ? { ...d, ...patch } : d)));
  }, []);

  return { docs, loadError, uploads, refresh, refreshDoc, replace, upload, patchDoc, retry, rename, remove };
}
