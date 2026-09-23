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
}

const POLL_MS = 800;

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

  /** Uploads PDFs one by one. Resolves with the last successfully created doc (or null). */
  const upload = useCallback(async (files: File[]): Promise<DocMeta | null> => {
    let last: DocMeta | null = null;
    for (const file of files) {
      if (!isPdfFile(file)) {
        toast(`PDF 파일만 올릴 수 있어요: ${file.name}`, 'error');
        continue;
      }
      const id = ++uploadSeq.current;
      setUploads((u) => [...u, { id, name: file.name, size: file.size, fraction: 0 }]);
      try {
        const doc = await uploadPdf(file, (fraction) =>
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, fraction } : x))),
        );
        setDocs((prev) => [doc, ...(prev ?? []).filter((d) => d.id !== doc.id)]);
        last = doc;
      } catch (e) {
        toast(`업로드 실패 (${file.name}): ${errorMessage(e)}`, 'error');
      } finally {
        setUploads((u) => u.filter((x) => x.id !== id));
      }
    }
    return last;
  }, []);

  return { docs, loadError, uploads, refresh, upload };
}
