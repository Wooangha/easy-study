// Speech recognition on the server (GET /api/asr, DESIGN §22): engine, models, downloads. Loaded while `enabled`;
// polled every second while a model downloads.
import { useCallback, useEffect, useState } from 'react';
import type { AsrStatus } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { getLang, keepAnswer, msg, useLang } from '../i18n/index.ts';
import { toast } from '../lib/toast.ts';

const DOWNLOAD_POLL_MS = 1000;

export function useAsrStatus(enabled: boolean) {
  const [status, setStatus] = useState<AsrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // An answer made for a language no longer shown (the model labels, the engine's reasons) is dropped once the
  // answer for the new one is there (keepAnswer).
  const refresh = useCallback(async () => {
    const asked = getLang();
    try {
      const next = await api.getAsrStatus();
      setStatus((shown) => (keepAnswer(asked, shown) ? next : shown));
      if (asked === getLang()) setError(null);
    } catch (e) {
      if (asked === getLang()) setError(api.recordingErrorMessage(e));
    }
  }, []);

  // Again when the language changes: the model labels and the engine's reasons are in the request's (DESIGN §27).
  const lang = useLang();
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh, lang]);

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
        toast(msg().recording.asrSettings.modelDownloadFailed(api.recordingErrorMessage(e)), 'error');
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
        toast(msg().recording.asrSettings.modelRemoved, 'success');
      } catch (e) {
        toast(msg().recording.asrSettings.modelRemoveFailed(api.recordingErrorMessage(e)), 'error');
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
