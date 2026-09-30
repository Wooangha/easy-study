import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { FileText, ImageIcon, Scissors, X } from 'lucide-react';
import type { Attachment } from '../../../shared/types.ts';
import { attachmentUrl, checkSessionSoon } from '../api.ts';
import { useLoginEpoch } from '../hooks/useAuth.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { msg } from '../i18n/index.ts';
import { attachmentLabel, attachmentTitle, type Chip } from '../lib/attachments.ts';
import { inDialog } from './SlideViewer.tsx';

/** What attachment thumbnails need: the document they belong to and what a click does (preview / jump). */
export interface AttachmentActions {
  docId: string;
  open: (attachment: Attachment) => void;
}

export const AttachmentContext = createContext<AttachmentActions | null>(null);

/** The stored image of an attachment; after a failure (e.g. the session ended) it is tried again after a login. */
export function AttachmentImage({
  docId,
  attachment,
  eager = false,
}: {
  docId: string;
  attachment: Attachment;
  eager?: boolean;
}) {
  const epoch = useLoginEpoch();
  const [failedAt, setFailedAt] = useState<number | null>(null);
  if (failedAt === epoch) {
    return (
      <span className="att-img-missing" role="img" aria-label={msg().chat.attachments.imageLoadFailed}>
        <ImageIcon />
      </span>
    );
  }
  return (
    <img
      key={epoch}
      src={attachmentUrl(docId, attachment.id)}
      alt={attachmentTitle(attachment)}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onError={() => {
        checkSessionSoon();
        setFailedAt(epoch);
      }}
    />
  );
}

/** Thumbnails of a question's attachments (chat history and notes); click → preview, a region also → the slide. */
export function AttachmentThumbs({ attachments, className }: { attachments?: Attachment[]; className?: string }) {
  const actions = useContext(AttachmentContext);
  if (!actions || !attachments || attachments.length === 0) return null;
  const m = msg().chat.attachments;
  return (
    <div className={className ? `att-thumbs ${className}` : 'att-thumbs'}>
      {attachments.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`att-thumb kind-${a.kind}`}
          onClick={() => actions.open(a)}
          title={a.kind === 'region' ? m.openRegionTitle(attachmentTitle(a)) : m.openImageTitle(attachmentTitle(a))}
        >
          <AttachmentImage docId={actions.docId} attachment={a} />
          <span className="att-thumb-label">{attachmentLabel(a)}</span>
        </button>
      ))}
    </div>
  );
}

/** The composer's chips: attachments waiting for the next question. */
export function AttachmentChips({
  docId,
  chips,
  onOpen,
  onRemove,
}: {
  docId: string;
  chips: Chip[];
  onOpen: (chip: Chip) => void;
  onRemove: (key: string) => void;
}) {
  if (chips.length === 0) return null;
  const m = msg().chat.attachments;
  return (
    <ul className="att-chips" aria-label={m.chipsLabel}>
      {chips.map((c) => {
        const ready = c.status === 'ready' && c.attachment;
        return (
          <li key={c.key} className={`att-chip kind-${c.kind} is-${c.status}`}>
            <button
              type="button"
              className="att-chip-main"
              onClick={() => onOpen(c)}
              disabled={!ready}
              title={
                ready
                  ? c.kind === 'region'
                    ? m.openRegionTitle(c.title)
                    : m.openImageTitle(c.title)
                  : c.kind === 'region'
                    ? m.cropping
                    : m.uploading(Math.round(c.progress * 100))
              }
            >
              <span className="att-chip-thumb" aria-hidden>
                {ready && c.attachment ? (
                  <AttachmentImage docId={docId} attachment={c.attachment} eager />
                ) : c.localUrl ? (
                  <img src={c.localUrl} alt="" draggable={false} />
                ) : (
                  <span className="att-chip-icon">{c.kind === 'region' ? <Scissors /> : <ImageIcon />}</span>
                )}
                {!ready && (
                  <span
                    className="att-chip-progress"
                    style={{ '--p': c.kind === 'region' ? 0.25 : c.progress } as CSSProperties}
                    data-indeterminate={c.kind === 'region' || undefined}
                  />
                )}
              </span>
              <span className="att-chip-label">{c.label}</span>
            </button>
            <button
              type="button"
              className="att-chip-remove"
              onClick={() => onRemove(c.key)}
              aria-label={m.removeLabel(c.label)}
              title={m.removeTitle}
            >
              <X size="1em" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A larger view of an attachment over the right pane (the slides stay visible, so a region's flash on its slide
 * can be seen at the same time). Esc, the close button or a click beside the card closes it.
 */
export function AttachmentPreview({
  docId,
  attachment,
  onClose,
  onShowOnSlide,
}: {
  docId: string;
  attachment: Attachment;
  onClose: () => void;
  onShowOnSlide: (attachment: Attachment) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useLatest(onClose);

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || inDialog(e.target)) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [attachment.id, onCloseRef]);

  const m = msg().chat.attachments;
  const region = attachment.kind === 'region';
  const text = region ? (attachment.text ?? '').trim() : '';
  return (
    <div
      className="att-preview"
      role="dialog"
      aria-label={attachmentTitle(attachment)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="att-preview-card">
        <div className="att-preview-head">
          <span className="att-preview-title">{attachmentLabel(attachment)}</span>
          {attachment.width > 0 && (
            <span className="att-preview-size muted">
              {attachment.width}×{attachment.height}
            </span>
          )}
          <span className="spacer" />
          {region && attachment.slide !== undefined && (
            <button type="button" className="ghost-btn small" onClick={() => onShowOnSlide(attachment)}>
              <FileText /> {m.showOnSlide(attachment.slide)}
            </button>
          )}
          <button ref={closeRef} type="button" className="icon-btn small" onClick={onClose} aria-label={msg().common.close} title={m.closeTitle}>
            <X />
          </button>
        </div>
        <div className="att-preview-body">
          <AttachmentImage docId={docId} attachment={attachment} eager />
        </div>
        {region && (
          <details className="att-preview-text">
            <summary>{m.regionText(!text)}</summary>
            {text ? (
              <pre>{text}</pre>
            ) : (
              <p className="muted small">{m.noPdfText}</p>
            )}
          </details>
        )}
      </div>
    </div>
  );
}
