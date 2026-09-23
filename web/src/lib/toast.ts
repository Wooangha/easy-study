// Minimal global toast store (subscribe with useSyncExternalStore in <Toaster/>).

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type Listener = () => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function toast(message: string, kind: ToastKind = 'info', timeoutMs?: number): number {
  const id = nextId++;
  // Collapse identical consecutive messages instead of stacking duplicates.
  toasts = [...toasts.filter((t) => t.message !== message), { id, kind, message }].slice(-5);
  emit();
  const ms = timeoutMs ?? (kind === 'error' ? 8000 : 4000);
  window.setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): Toast[] {
  return toasts;
}
