import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { answerConfirm, cancelAllConfirms, getConfirmRequest, subscribeConfirm } from '../lib/confirm.ts';

/**
 * Shows the requests of `confirmDialog()` (web/src/lib/confirm.ts) as a modal <dialog>: Esc or "취소" answers
 * false, the confirm button true. Focus returns to where it was.
 */
export function ConfirmHost({ suspended = false }: { suspended?: boolean }) {
  const request = useSyncExternalStore(subscribeConfirm, getConfirmRequest);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // The login screen covers the app (DESIGN §16): a question asked before cannot be answered there.
  useEffect(() => {
    if (suspended) cancelAllConfirms();
  }, [suspended, request]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !request) return;
    if (!returnFocus.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    (request.danger ? cancelRef.current : confirmRef.current)?.focus();
  }, [request]);

  // A layout effect: the modal dialog makes the rest of the page inert, so it must be closed before the effects
  // of the answer run — e.g. the library focusing the next card after a delete (the 🗑 that had the focus is gone).
  useLayoutEffect(() => {
    if (request) return;
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }, [request]);

  const paragraphs = (request?.message ?? '').split(/\n+/).filter((p) => p.trim() !== '');
  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby={paragraphs.length > 0 ? 'confirm-message' : undefined}
      onCancel={(e) => {
        e.preventDefault(); // closed by the effect once answered
        if (request) answerConfirm(request.id, false);
      }}
      onClick={(e) => {
        // A click on the backdrop (outside the card) cancels.
        if (e.target === e.currentTarget && request) answerConfirm(request.id, false);
      }}
    >
      {request && (
        <div className="confirm-card">
          <h2 id="confirm-title" className="confirm-title">
            {request.title}
          </h2>
          {paragraphs.length > 0 && (
            <div id="confirm-message" className="confirm-message">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          <div className="confirm-actions">
            {!request.alert && (
              <button
                ref={cancelRef}
                type="button"
                className="ghost-btn"
                onClick={() => answerConfirm(request.id, false)}
              >
                {request.cancelLabel ?? '취소'}
              </button>
            )}
            <button
              ref={confirmRef}
              type="button"
              className={request.danger ? 'primary-btn is-danger' : 'primary-btn'}
              onClick={() => answerConfirm(request.id, true)}
            >
              {request.confirmLabel ?? '확인'}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
