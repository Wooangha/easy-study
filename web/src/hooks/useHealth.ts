import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthResponse } from '../../../shared/types.ts';
import { errorMessage, getHealth } from '../api.ts';
import { getLang, keepAnswer, useLang, type Lang } from '../i18n/index.ts';

/** GET /api/health — provider availability + library dir. */
export function useHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The labels in it (providers, models, reasoning levels, why one is unavailable) are in the language of the request
  // (DESIGN §27): an answer made for a language no longer shown does not replace the newer one.
  const show = useCallback((next: HealthResponse, asked: Lang) => {
    setHealth((shown) => (keepAnswer(asked, shown) ? next : shown));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const asked = getLang();
    try {
      show(await getHealth(), asked);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [show]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Fetched again, quietly, when the language changes.
  const lang = useLang();
  const shownLang = useRef(lang);
  useEffect(() => {
    if (shownLang.current === lang) return;
    shownLang.current = lang;
    let cancelled = false;
    getHealth().then(
      (next) => {
        if (!cancelled) show(next, lang);
      },
      () => {}, // the labels of the previous language stand
    );
    return () => {
      cancelled = true;
    };
  }, [lang, show]);

  return { health, error, loading, reload };
}
