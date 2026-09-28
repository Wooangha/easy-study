// Speech recognition on the server (GET /api/asr, DESIGN §22): engine, models, downloads. Loaded while `enabled`;
// polled every second while a model downloads.
import { useCallback, useEffect, useState } from 'react';
import type { AsrStatus } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { toast } from '../lib/toast.ts';

const DOWNLOAD_POLL_MS = 1000;

export function useAsrStatus(enabled: boolean) {
  const [status, setStatus] = useState<AsrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getAsrStatus());
      setError(null);
    } catch (e) {
      setError(api.recordingErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const downloading = !!status?.models.some((m) => m.downloading);
  useEffect(() => {
    if (!enabled || !downloading) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(tick, DOWNLOAD_POLL_MS);
    };
    timer = window.setTimeout(tick, DOWNLOAD_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, downloading, refresh]);

  const download = useCallback(
    async (modelId: string) => {
      setPending(modelId);
      try {
        await api.downloadAsrModel(modelId);
      } catch (e) {
        toast(`음성 인식 모델을 내려받지 못했어요: ${api.recordingErrorMessage(e)}`, 'error');
      } finally {
        setPending(null);
      }
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (modelId: string) => {
      setPending(modelId);
      try {
        await api.deleteAsrModel(modelId);
        toast('음성 인식 모델을 지웠어요.', 'success');
      } catch (e) {
        toast(`모델을 지우지 못했어요: ${api.recordingErrorMessage(e)}`, 'error');
      } finally {
        setPending(null);
      }
      await refresh();
    },
    [refresh],
  );

  return { status, error, pending, refresh, download, remove };
}

export type AsrState = ReturnType<typeof useAsrStatus>;
