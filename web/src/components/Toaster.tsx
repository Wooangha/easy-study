import { useSyncExternalStore } from 'react';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { msg } from '../i18n/index.ts';
import { dismissToast, getToasts, subscribeToasts } from '../lib/toast.ts';

const ICONS = { info: Info, success: CircleCheck, error: TriangleAlert } as const;

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  if (toasts.length === 0) return null;
  const close = msg().common.close;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)} title={close}>
            <span className="toast-icon" aria-hidden>
              <Icon />
            </span>
            <span className="toast-message">{t.message}</span>
          </button>
        );
      })}
    </div>
  );
}
