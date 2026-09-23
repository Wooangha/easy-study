// Digest ("정리본") of the current document: load, poll while the job runs, start / resume / redo, abort.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DigestInfo, DigestStatus } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { toast } from '../lib/toast.ts';
import { useLatest } from './useLatest.ts';
import type { ProviderChoice } from './useProviderChoice.ts';

/** Poll GET digest this often while the job is running. */
const POLL_MS = 2000;

/** `docId` = ready document currently shown (null = none). */
export function useDigest(docId: string | null) {
  // Tagged with its document so switching docs never shows another doc's digest.
  const [state, setState] = useState<{ docId: string; info: DigestInfo } | null>(null);
  const [error, setError] = useState<{ docId: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  /** A start / abort request is in flight. */
  const [pending, setPending] = useState<'start' | 'abort' | null>(null);

  const docIdRef = useLatest(docId);
  /** Last status seen per document, to notice transitions (running → ready, …). */
  const lastStatus = useRef(new Map<string, DigestStatus>());

  const accept = useCallback(
    (forDoc: string, info: DigestInfo) => {
      const prev = lastStatus.current.get(forDoc);
      lastStatus.current.set(forDoc, info.status);
      if (docIdRef.current === forDoc) {
        setState({ docId: forDoc, info });
        setError(null);
      }
      // Tell the user when a job they watched finishes.
      if (prev !== 'running' || info.status === 'running') return;
      if (info.status === 'ready') {
        const failed = info.slides.filter((s) => s.failed).length;
        toast(
          failed > 0 ? `정리본을 만들었어요 (슬라이드 ${failed}장은 실패)` : '정리본이 완성됐어요 ✓',
          failed > 0 ? 'info' : 'success',
        );
      } else if (info.status === 'error') {
        toast(`정리본을 만들지 못했어요: ${info.error ?? '알 수 없는 오류'}`, 'error');
      }
    },
    [docIdRef],
  );

  /** Reload the digest. `silent` (polling) does not flag `loading`, so the refresh button does not flicker. */
  const refresh = useCallback(
    async (forDoc?: string, silent = false) => {
      const target = forDoc ?? docIdRef.current;
      if (!target) return;
      if (!silent) setLoading(true);
      try {
        accept(target, await api.getDigest(target));
      } catch (e) {
        if (docIdRef.current === target) setError({ docId: target, message: api.errorMessage(e) });
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [accept, docIdRef],
  );

  useEffect(() => {
    if (docId) void refresh(docId);
  }, [docId, refresh]);

  const info = state && state.docId === docId ? state.info : null;
  const running = info?.status === 'running';

  // Poll while the job runs (chained timeouts: never two requests in flight).
  useEffect(() => {
    if (!docId || !running) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      await refresh(docId, true);
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [docId, running, refresh]);

  /** Start the job with the given provider: missing/failed slides only, or everything with `force`. */
  const start = useCallback(
    async (choice: ProviderChoice | null, force: boolean): Promise<boolean> => {
      const target = docIdRef.current;
      if (!target) return false;
      if (!choice) {
        toast('사용할 수 있는 LLM이 없어요. 상단의 모델 선택을 확인해 주세요.', 'error');
        return false;
      }
      setPending('start');
      try {
        const next = await api.startDigest(target, {
          provider: choice.provider,
          model: choice.model || undefined,
          force: force || undefined,
        });
        accept(target, next);
        return true;
      } catch (e) {
        if (e instanceof api.ApiError && e.status === 409) {
          toast('이미 정리본을 만들고 있어요.', 'info');
          void refresh(target);
        } else {
          toast(`정리본 만들기를 시작하지 못했어요: ${api.errorMessage(e)}`, 'error');
        }
        return false;
      } finally {
        setPending(null);
      }
    },
    [accept, docIdRef, refresh],
  );

  const abort = useCallback(async () => {
    const target = docIdRef.current;
    if (!target) return;
    setPending('abort');
    try {
      await api.abortDigest(target);
    } catch (e) {
      toast(`정리를 중지하지 못했어요: ${api.errorMessage(e)}`, 'error');
    } finally {
      setPending(null);
    }
    await refresh(target);
  }, [docIdRef, refresh]);

  return {
    info,
    error: error && error.docId === docId ? error.message : null,
    loading,
    pending,
    refresh,
    start,
    abort,
  };
}

export type DigestState = ReturnType<typeof useDigest>;
