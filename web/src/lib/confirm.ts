// In-page confirmation dialogs (replaces window.confirm(), which does nothing inside the desktop app's web
// view). `confirmDialog()` resolves true/false; <ConfirmHost/> shows one request at a time, in order.

export interface ConfirmOptions {
  title: string;
  /** Longer explanation; line breaks start new paragraphs. */
  message?: string;
  /** Button that confirms (default "확인"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: red confirm button, and the cancel button gets the initial focus. */
  danger?: boolean;
  /** Only an explanation: one button (the confirm label, default "확인"); resolves true when closed with it. */
  alert?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  id: number;
}

interface Waiting {
  request: ConfirmRequest;
  resolve: (ok: boolean) => void;
}

let queue: Waiting[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Asks the user; resolves false when there is nowhere to ask (no <ConfirmHost/> mounted). */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    queue = [...queue, { request: { ...options, id: nextId++ }, resolve }];
    emit();
  });
}

/** The request being shown (the oldest one), or null. */
export function getConfirmRequest(): ConfirmRequest | null {
  return queue[0]?.request ?? null;
}

export function answerConfirm(id: number, ok: boolean): void {
  const waiting = queue.find((w) => w.request.id === id);
  if (!waiting) return;
  queue = queue.filter((w) => w !== waiting);
  waiting.resolve(ok);
  emit();
}

/** Cancels every open request (e.g. when the login screen covers the app). */
export function cancelAllConfirms(): void {
  const all = queue;
  if (all.length === 0) return;
  queue = [];
  for (const w of all) w.resolve(false);
  emit();
}

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
