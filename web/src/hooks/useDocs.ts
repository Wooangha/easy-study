import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocMeta } from '../../../shared/types.ts';
import { errorMessage, getDoc, listDocs, uploadPdf } from '../api.ts';
import { toast } from '../lib/toast.ts';

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

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** Library documents: list, upload (with progress) and polling of docs that are still processing. */
export function useDocs() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setDocs(await listDocs());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
      setDocs((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      setDocs((prev) => prev && prev.map((d) => byId.get(d.id) ?? d));
      for (const d of byId.values()) {
        if (d.status === 'error') toast(`"${d.title}" 처리 실패: ${d.error ?? '알 수 없는 오류'}`, 'error');
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [processingIds]);

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
          toast(`PDF 파일만 올릴 수 있어요: ${file.name}`, 'error');
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
          toast(`업로드 실패 (${file.name}): ${errorMessage(e)}`, 'error');
        } finally {
          setUploads((u) => u.filter((x) => x.id !== id));
        }
      }
      return created;
    },
    [],
  );

  /** Locally patch one document (e.g. its digest status) without waiting for the next refresh. */
  const patchDoc = useCallback((docId: string, patch: Partial<DocMeta>) => {
    setDocs((prev) => prev && prev.map((d) => (d.id === docId ? { ...d, ...patch } : d)));
  }, []);

  return { docs, loadError, uploads, refresh, upload, patchDoc };
}
