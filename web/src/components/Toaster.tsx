import { useSyncExternalStore } from 'react';
import { dismissToast, getToasts, subscribeToasts } from '../lib/toast.ts';

const ICONS = { info: 'ℹ️', success: '✅', error: '⚠️' } as const;

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)} title="닫기">
          <span className="toast-icon" aria-hidden>
            {ICONS[t.kind]}
          </span>
          <span className="toast-message">{t.message}</span>
        </button>
      ))}
    </div>
  );
}
