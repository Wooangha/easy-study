import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '../../../shared/types.ts';
import { errorMessage, getHealth } from '../api.ts';

/** GET /api/health — provider availability + library dir. */
export function useHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setHealth(await getHealth());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { health, error, loading, reload };
}
