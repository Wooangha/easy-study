// Copying text (the 복사 buttons). navigator.clipboard exists only in a secure context (HTTPS or
// http://localhost / 127.0.0.1); the remote mode is usually opened over plain HTTP from another computer
// (http://192.168.0.10:5180, DESIGN §16), where it is undefined. There the text is copied the old way:
// selected in a hidden <textarea> and copied with document.execCommand('copy'), which browsers still
// allow in a click handler.

/** What copyText uses (the browser's by default; tests pass fakes). */
export interface ClipboardEnv {
  /** navigator.clipboard (undefined outside a secure context). */
  clipboard?: Pick<Clipboard, 'writeText'> | null;
  /** window.isSecureContext. */
  secure: boolean;
  /** The page, for the fallback (absent: no fallback). */
  document?: Pick<Document, 'createElement' | 'body' | 'execCommand' | 'activeElement'> | null;
}

function browserEnv(): ClipboardEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    clipboard: nav?.clipboard,
    secure: typeof window !== 'undefined' && window.isSecureContext === true,
    document: typeof document === 'undefined' ? null : document,
  };
}

/** The hidden-<textarea> copy; false when the browser refused. */
function copyWithSelection(text: string, doc: NonNullable<ClipboardEnv['document']>): boolean {
  if (!doc.body) return false;
  const previous = doc.activeElement as { focus?: (options?: FocusOptions) => void } | null;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', ''); // no on-screen keyboard on phones
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length); // iOS Safari selects nothing with select() alone
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.({ preventScroll: true });
  }
}

/**
 * Copies `text` to the clipboard: the Clipboard API when the page may use it, otherwise (plain HTTP from
 * another computer, or the API refused) the selection fallback. Rejects when nothing could be copied, so
 * callers always show either their success or their failure message.
 */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<void> {
  if (env.secure && env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return;
    } catch {
      // e.g. permission denied or the document lost focus: try the fallback below.
    }
  }
  if (!env.document || !copyWithSelection(text, env.document)) throw new Error('클립보드에 복사할 수 없습니다');
}
