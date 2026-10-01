// 새 버전 올리기 (DESIGN §28): the lecture menus ask App (NewVersionContext) to pick a PDF for a lecture; App then
// shows this dialog, which uploads it (progress), follows its conversion (GET …/versions/next every 800 ms) and shows
// the plan — what stays, what changed, what is new, what is dropped and what sits on it — until the student switches
// to the new version (apply; a 409 says why and keeps the dialog) or cancels (the new version is dropped; also when the
// page goes away with it still staged). While the login screen is up (App suspended) the modal is closed, not unmounted.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, FileUp, TriangleAlert } from 'lucide-react';
import type { DocMeta, NextVersionInfo, VersionPlan } from '../../../shared/types.ts';
import {
  ApiError,
  applyNextVersion,
  dropNextVersion,
  dropNextVersionOnLeave,
  getNextVersion,
  isAbortError,
  nextThumbUrl,
  thumbUrl,
  uploadNextVersion,
  versionErrorMessage,
} from '../api.ts';
import { msg } from '../i18n/index.ts';
import { oldToNewOf, planView } from '../lib/versionPlan.ts';
import { ProgressBar } from './organize/parts.tsx';

/** Opens the PDF picker for a new version of this lecture (null where it is not offered). */
export const NewVersionContext = createContext<((doc: DocMeta) => void) | null>(null);

export function useNewVersionPicker(): ((doc: DocMeta) => void) | null {
  return useContext(NewVersionContext);
}

const POLL_MS = 800;

type Phase =
  | { kind: 'uploading'; fraction: number }
  | { kind: 'processing'; info: NextVersionInfo | null }
  | { kind: 'ready'; info: NextVersionInfo; plan: VersionPlan }
  | { kind: 'failed'; message: string };

/** Where an answer of the server leaves the dialog. */
function phaseOf(info: NextVersionInfo): Phase {
  if (info.status === 'ready' && info.plan) return { kind: 'ready', info, plan: info.plan };
  if (info.status === 'error') return { kind: 'failed', message: msg().versions.dialog.failed(info.error ?? msg().common.unknownError) };
  return { kind: 'processing', info };
}

/**
 * A click on the backdrop cancels — only when the press started there too: a drag that starts in the card (selecting
 * a file name, say) and ends over the backdrop is not a cancel (the click then targets the <dialog>).
 */
export function backdropGuard(): { press: (onBackdrop: boolean) => void; click: (onBackdrop: boolean) => boolean } {
  let pressed = false;
  return {
    press: (onBackdrop) => {
      pressed = onBackdrop;
    },
    click: (onBackdrop) => {
      const cancel = pressed && onBackdrop;
      pressed = false;
      return cancel;
    },
  };
}

/** What syncModal needs of a <dialog> (a fake in tests). */
export interface ModalLike {
  readonly open: boolean;
  showModal?: () => void;
  close: () => void;
  setAttribute: (name: string, value: string) => void;
}

/**
 * The dialog shown as a modal — except under the login screen (App suspended), which it must not cover: closed then
 * (close() does not fire `cancel`, so the new version is kept) and shown again after the login.
 */
export function syncModal(dialog: ModalLike, suspended: boolean): void {
  if (suspended) {
    if (dialog.open) dialog.close();
    return;
  }
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

interface NewVersionDialogProps {
  doc: DocMeta;
  file: File;
  /** The login screen is shown over the app (DESIGN §16): the modal steps aside until the login, keeping its state. */
  suspended?: boolean;
  onClose: () => void;
  /** Switched: the swapped lecture and where its old slides went (oldToNew[old - 1]). */
  onApplied: (meta: DocMeta, oldToNew: (number | null)[]) => void;
}

/** Mounted while open: one upload per mount. */
export function NewVersionDialog({ doc, file, suspended = false, onClose, onApplied }: NewVersionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'uploading', fraction: 0 });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  /** The server holds the new version (uploaded, not applied nor dropped): dropped when the page goes away. */
  const stagedRef = useRef(false);
  const applyingRef = useRef(false);
  const [backdrop] = useState(backdropGuard);
  const docId = doc.id;

  // Like LlmSwitchDialog: a modal <dialog> (the rest of the page is inert), focus returns where it was.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    return () => {
      if (dialog?.open) dialog.close();
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected) target.focus();
    };
  }, []);
  // Shown as a modal, but not over the login screen (syncModal).
  useLayoutEffect(() => {
    if (dialogRef.current) syncModal(dialogRef.current, suspended);
  }, [suspended]);

  // The page goes away with the new version still staged (closed, reloaded): drop it, like 취소. Back from the
  // back-forward cache, the dialog says it is gone.
  useEffect(() => {
    let dropped = false;
    const onHide = () => {
      if ((!stagedRef.current && !uploadRef.current) || applyingRef.current) return;
      stagedRef.current = false;
      dropped = true;
      dropNextVersionOnLeave(docId);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted || !dropped) return;
      dropped = false;
      setPhase({ kind: 'failed', message: msg().versions.dialog.gone });
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, [docId]);

  // Upload, then follow the conversion until the plan (or an error) is there.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const controller = new AbortController();
    uploadRef.current = controller;
    const poll = async () => {
      try {
        const info = await getNextVersion(docId);
        if (cancelled) return;
        const next = phaseOf(info);
        setPhase(next);
        if (next.kind === 'processing') timer = window.setTimeout(() => void poll(), POLL_MS);
      } catch (e) {
        if (cancelled) return;
        // Offline for a moment: keep asking. Gone (dropped elsewhere, the lecture deleted): say so.
        if (e instanceof ApiError && e.status === 0) timer = window.setTimeout(() => void poll(), POLL_MS);
        else setPhase({ kind: 'failed', message: e instanceof ApiError && e.status === 404 ? msg().versions.dialog.gone : versionErrorMessage(e) });
      }
    };
    uploadNextVersion(docId, file, {
      signal: controller.signal,
      onProgress: (fraction) => {
        if (!cancelled) setPhase((p) => (p.kind === 'uploading' ? { kind: 'uploading', fraction } : p));
      },
    })
      .then((info) => {
        if (cancelled) return;
        uploadRef.current = null;
        stagedRef.current = true;
        const next = phaseOf(info);
        setPhase(next);
        if (next.kind === 'processing') timer = window.setTimeout(() => void poll(), POLL_MS);
      })
      .catch((e: unknown) => {
        if (cancelled || isAbortError(e)) return;
        uploadRef.current = null;
        setPhase({ kind: 'failed', message: msg().versions.dialog.failed(versionErrorMessage(e)) });
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [docId, file]);

  /** 취소 / 닫기: the new version is dropped (its conversion stops on the server). */
  const cancel = useCallback(() => {
    if (applying) return;
    uploadRef.current?.abort();
    uploadRef.current = null;
    stagedRef.current = false;
    dropNextVersion(docId).catch(() => {
      /* idempotent; nothing to drop when the upload never arrived */
    });
    onClose();
  }, [applying, docId, onClose]);

  const apply = async () => {
    if (phase.kind !== 'ready' || applying) return;
    setApplying(true);
    applyingRef.current = true;
    setApplyError(null);
    try {
      const meta = await applyNextVersion(docId);
      stagedRef.current = false;
      onApplied(meta, oldToNewOf(phase.plan));
      onClose();
    } catch (e) {
      setApplyError(versionErrorMessage(e));
      setApplying(false);
    } finally {
      applyingRef.current = false;
    }
  };

  const m = msg().versions.dialog;
  return (
    <dialog
      ref={dialogRef}
      className="version-dialog"
      aria-labelledby="version-dialog-title"
      onCancel={(e) => {
        e.preventDefault(); // closed by unmounting
        cancel();
      }}
      onPointerDown={(e) => backdrop.press(e.target === e.currentTarget)}
      onClick={(e) => {
        // A click on the backdrop (outside the card) cancels — a press that started there too (backdropGuard).
        if (backdrop.click(e.target === e.currentTarget)) cancel();
      }}
    >
      <div className="version-card">
        <div className="version-head">
          <h2 id="version-dialog-title" className="confirm-title">
            <FileUp /> {m.title}
          </h2>
          <p className="version-file" title={file.name}>
            {doc.title} · {file.name}
          </p>
        </div>
        <div className="version-body">
          {phase.kind === 'uploading' && <Progress fraction={phase.fraction} text={m.uploading(Math.round(phase.fraction * 100))} />}
          {phase.kind === 'processing' && <Conversion info={phase.info} />}
          {phase.kind === 'failed' && (
            <div className="inline-error" role="alert">
              <TriangleAlert /> {phase.message}
            </div>
          )}
          {phase.kind === 'ready' && <PlanSections doc={doc} plan={phase.plan} createdAt={phase.info.createdAt} />}
        </div>
        {applyError && (
          <div className="inline-error version-apply-error" role="alert">
            <TriangleAlert /> {applyError}
          </div>
        )}
        <div className="confirm-actions">
          <button type="button" className="ghost-btn" onClick={cancel} disabled={applying}>
            {phase.kind === 'failed' ? msg().common.close : msg().common.cancel}
          </button>
          {phase.kind !== 'failed' && (
            <button type="button" className="primary-btn" onClick={() => void apply()} disabled={phase.kind !== 'ready' || applying}>
              {applying ? m.applying : m.apply}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function Progress({ fraction, text }: { fraction: number | null; text: string }) {
  return (
    <div className="doc-progress">
      <ProgressBar fraction={fraction} />
      <span className="doc-progress-text">{text}</span>
    </div>
  );
}

function Conversion({ info }: { info: NextVersionInfo | null }) {
  const m = msg().versions.dialog;
  if (!info || info.pageCount <= 0) return <Progress fraction={null} text={m.analyzing} />;
  return <Progress fraction={Math.min(1, info.progress / info.pageCount)} text={m.converting(Math.min(info.progress, info.pageCount), info.pageCount)} />;
}

/** The plan: the chips, the warnings and lines, the changed / new / removed slides. */
export function PlanSections({ doc, plan, createdAt }: { doc: DocMeta; plan: VersionPlan; createdAt: string }) {
  const m = msg().versions.dialog;
  const view = planView(plan);
  const aspect = doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9;
  const oldThumb = (n: number) => <Thumb src={thumbUrl(doc.id, n)} alt={m.oldAlt(n)} aspect={aspect} />;
  const newThumb = (n: number) => <Thumb src={nextThumbUrl(doc.id, n, createdAt)} alt={m.newAlt(n)} aspect={aspect} />;
  return (
    <>
      <div className="version-chips">
        <span className="version-chip">{m.same(view.counts.same)}</span>
        <span className="version-chip is-changed">{m.changed(view.counts.changed)}</span>
        <span className="version-chip is-added">{m.added(view.counts.added)}</span>
        <span className="version-chip is-removed">{m.removed(view.counts.removed)}</span>
      </div>
      {view.unrelated && (
        <div className="version-warn" role="alert">
          <TriangleAlert /> {m.unrelated}
        </div>
      )}
      {view.unchanged && <p className="version-note">{m.unchanged}</p>}
      {(view.keptOnRemoved || view.questionsMoved > 0) && (
        <ul className="version-notes">
          {view.keptOnRemoved && <li>{m.keptOnRemoved(view.keptOnRemoved.items, view.keptOnRemoved.memos)}</li>}
          {view.questionsMoved > 0 && <li>{m.questionsMoved(view.questionsMoved)}</li>}
        </ul>
      )}
      {view.changed.length > 0 && (
        <section className="version-section">
          <h3 className="version-heading">{m.changedHeading}</h3>
          <ul className="version-changes">
            {view.changed.map((c) => (
              <li key={c.slide} className="version-change">
                <figure className="version-fig">
                  {oldThumb(c.from)}
                  <figcaption>{m.page(c.from)}</figcaption>
                </figure>
                <ArrowRight className="version-arrow" aria-hidden />
                <figure className="version-fig">
                  {newThumb(c.slide)}
                  <figcaption>
                    {m.page(c.slide)}
                    {c.moved && <span className="version-tag">{m.moved}</span>}
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.added.length > 0 && (
        <section className="version-section">
          <h3 className="version-heading">{m.addedHeading}</h3>
          <ul className="version-grid">
            {view.added.map((n) => (
              <li key={n} className="version-fig">
                {newThumb(n)}
                <span className="version-caption">{m.page(n)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.removed.length > 0 && (
        <section className="version-section">
          <h3 className="version-heading">{m.removedHeading}</h3>
          <ul className="version-grid">
            {view.removed.map((n) => (
              <li key={n} className="version-fig is-removed">
                {oldThumb(n)}
                <span className="version-caption">{m.page(n)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Thumb({ src, alt, aspect }: { src: string; alt: string; aspect: number }) {
  return (
    <span className="version-thumb" style={{ aspectRatio: aspect }}>
      <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} />
    </span>
  );
}
