import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { MAX_ATTACHMENTS } from '../../../shared/types.ts';
import { useAnnotations } from '../hooks/useAnnotations.ts';
import type { AttachmentsApi } from '../hooks/useAttachments.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { useMemosToTutor } from '../lib/annotations/settings.ts';
import { clipboardImages, defaultQuestion, readyAttachments, type Chip } from '../lib/attachments.ts';
import { toast } from '../lib/toast.ts';
import { AttachmentChips } from './Attachments.tsx';
import { LectureSpeechChip } from './recording/LectureSpeech.tsx';
import { isTypingTarget } from './SlideViewer.tsx';

export const QUICK_PROMPTS = ['이 슬라이드 설명해줘', '핵심만 요약', '예시로 설명', '시험 문제 내줘'] as const;

interface ComposerProps {
  docId: string;
  /** Slide the question will be about. */
  targetSlide: number;
  pageCount: number;
  /** Neighbor slides (±N) sent along with the target slide. */
  neighbors: number;
  pinned: boolean;
  /** A turn (or session creation / priming) is running — sending is disabled. */
  running: boolean;
  /** Stop is possible (a live turn exists and stop was not requested yet). */
  canStop: boolean;
  /** When set, sending is impossible and this explains why. */
  disabledReason: string | null;
  /** Resolves false when the question was not accepted (the text is then restored; the chips come back too). */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onGoToSlide: (slide: number) => void;
  /** Attachments waiting for the next question (chips above the input). */
  attachments: AttachmentsApi;
  /** Attach images (picked / pasted); shows the chat tab. */
  onAttachFiles: (files: File[], options?: { pasted?: boolean }) => void;
  /** A ready chip was clicked: preview it (a region also shows where it is on its slide). */
  onOpenChip: (chip: Chip) => void;
  /** Shown under the input (the session's token usage and limits). */
  footer?: ReactNode;
}

const MAX_TEXTAREA_PX = 220;

/**
 * Sizes the textarea to its content, up to MAX_TEXTAREA_PX. An empty one is as tall as its placeholder: on a
 * narrow panel the placeholder wraps, and scrollHeight only counts the value (the second line was cut in half).
 */
function fitTextarea(el: HTMLTextAreaElement, placeholder: string): void {
  el.style.height = 'auto';
  let height = el.scrollHeight;
  if (el.value === '' && placeholder) {
    // Measured as if it were the value; nothing is lost (it is empty) and no input event fires.
    el.value = placeholder;
    height = el.scrollHeight;
    el.value = '';
  }
  el.style.height = `${Math.min(height, MAX_TEXTAREA_PX)}px`;
}

/**
 * "📝 메모 N개 포함" (DESIGN §25): the memos on the target slide and its neighbours that the next question carries as
 * "학생의 메모" — those with 👁 on, while the device's switch is on. Counted from the annotation summary.
 */
function StudentMemosChip({ docId, targetSlide, neighbors, pageCount }: { docId: string; targetSlide: number; neighbors: number; pageCount: number }) {
  const [enabled] = useMemosToTutor();
  const { snapshot } = useAnnotations(enabled ? docId : null);
  if (!enabled) return null;
  const from = Math.max(1, targetSlide - neighbors);
  const to = Math.min(pageCount, targetSlide + neighbors);
  const count = (snapshot.summary?.memos ?? []).filter((m) => m.tutor && m.slide >= from && m.slide <= to && m.text.trim() !== '').length;
  if (count === 0) return null;
  return (
    <div className="composer-context">
      <span className="speech-chip memo-chip" title="이 슬라이드와 앞뒤 슬라이드의 메모를 튜터에게 함께 보내요 (설정 › 공부에서 끌 수 있어요)">
        📝 메모 {count}개 포함
      </span>
    </div>
  );
}

/** The files of a paste (some browsers only list them as items). */
function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

export function Composer({
  docId,
  targetSlide,
  pageCount,
  neighbors,
  pinned,
  running,
  canStop,
  disabledReason,
  onSend,
  onStop,
  onGoToSlide,
  attachments,
  onAttachFiles,
  onOpenChip,
  footer,
}: ComposerProps) {
  const [text, setText] = useState('');
  // A touch screen has no Enter / Shift+Enter to explain, and its narrow composer wraps every extra word.
  const [touch] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blocked = running || disabledReason !== null;
  const chips = attachments.items;
  const ready = readyAttachments(chips);
  const uploading = attachments.uploading;
  const full = chips.length >= MAX_ATTACHMENTS;

  // "/" focuses the composer (when not already typing somewhere).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      textareaRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // An image pasted while no text field has the focus (e.g. after clicking a slide) is attached as well.
  const attachRef = useLatest(disabledReason === null ? onAttachFiles : null);
  useEffect(() => {
    const onPaste = (e: globalThis.ClipboardEvent) => {
      const attach = attachRef.current;
      if (!attach || e.defaultPrevented || !e.clipboardData || isTypingTarget(e.target)) return;
      const images = clipboardImages(e.clipboardData.getData('text/plain'), clipboardFiles(e.clipboardData));
      if (images.length === 0) return;
      e.preventDefault();
      attach(images, { pasted: true });
      textareaRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [attachRef]);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = clipboardImages(e.clipboardData.getData('text/plain'), clipboardFiles(e.clipboardData));
    if (images.length === 0) return; // an ordinary text paste
    e.preventDefault();
    onAttachFiles(images, { pasted: true });
  };

  const send = async (value: string, fromComposer: boolean) => {
    if (blocked) return;
    if (uploading) {
      toast('첨부한 이미지를 올리는 중이에요. 끝나면 보내 주세요.', 'info', 3000);
      return;
    }
    // Only attachments: ask about them.
    const question = value.trim() || (fromComposer && ready.length > 0 ? defaultQuestion(ready) : '');
    if (!question) return;
    if (fromComposer) setText('');
    const accepted = await onSend(question);
    // Put the question back if it never reached the server (keeps anything typed meanwhile).
    if (!accepted && fromComposer) setText((current) => current || value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // IME (Korean) composition: the Enter that commits a syllable must not send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send(text, true);
  };

  const from = Math.max(1, targetSlide - neighbors);
  const to = Math.min(pageCount, targetSlide + neighbors);
  const withNeighbors = to > from ? ` (p.${from}–${to}도 함께 전달)` : '';

  const placeholder = disabledReason
    ? disabledReason
    : running
      ? '답변을 기다리는 중… (다음 질문을 미리 써 둘 수 있어요)'
      : chips.length > 0
        ? `첨부 ${chips.length}개 · 비워 두면 “${defaultQuestion(chips)}”`
        : touch
          ? `p.${targetSlide}에 대해 질문하세요`
          : `p.${targetSlide}에 대해 질문하세요 · Enter 전송 · Shift+Enter 줄바꿈`;

  // Auto-grow the textarea up to a max height: with its text, its placeholder, and when its width changes.
  useLayoutEffect(() => {
    if (textareaRef.current) fitTextarea(textareaRef.current, placeholder);
  }, [text, placeholder]);
  const placeholderRef = useLatest(placeholder);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // its own height change
      width = el.clientWidth;
      fitTextarea(el, placeholderRef.current);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [placeholderRef]);

  return (
    <div className="composer">
      <div className="quick-prompts" role="group" aria-label="빠른 질문">
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q}
            type="button"
            className="quick-prompt"
            disabled={blocked}
            onClick={() => void send(q, false)}
            title={chips.length > 0 ? `첨부 ${chips.length}개와 함께 보내요` : undefined}
          >
            {q}
          </button>
        ))}
      </div>
      <AttachmentChips
        docId={docId}
        chips={chips}
        onOpen={onOpenChip}
        onRemove={attachments.remove}
      />
      <LectureSpeechChip docId={docId} />
      <StudentMemosChip docId={docId} targetSlide={targetSlide} neighbors={neighbors} pageCount={pageCount} />
      <div className={blocked ? 'composer-box is-blocked' : 'composer-box'}>
        <button
          type="button"
          className="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabledReason !== null || full}
          aria-label="이미지 첨부"
          title={
            full
              ? `한 질문에 최대 ${MAX_ATTACHMENTS}개까지 첨부할 수 있어요`
              : '이미지 첨부 — 붙여넣기(⌘/Ctrl+V)나 끌어다 놓기도 돼요. 슬라이드에서 끌면 그 영역을 첨부해요'
          }
        >
          📎
        </button>
        <button
          type="button"
          className={pinned ? 'target-chip is-pinned' : 'target-chip'}
          onClick={() => onGoToSlide(targetSlide)}
          title={
            (pinned ? '고정된 슬라이드에 대해 질문해요 (클릭하면 이동)' : '보고 있는 슬라이드에 대해 질문해요') +
            withNeighbors
          }
        >
          {pinned ? '📌' : '📄'} p.{targetSlide}
          {to > from && <span className="target-neighbors">±{neighbors}</span>}
        </button>
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="질문 입력"
          disabled={disabledReason !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {running ? (
          <button type="button" className="send-btn stop" onClick={onStop} disabled={!canStop} title="답변 중지">
            ■ 중지
          </button>
        ) : (
          <button
            type="button"
            className="send-btn"
            onClick={() => void send(text, true)}
            disabled={blocked || uploading || (text.trim() === '' && ready.length === 0)}
            title={uploading ? '첨부한 이미지를 올리는 중…' : '전송 (Enter)'}
          >
            {uploading ? '첨부 중…' : '전송'}
          </button>
        )}
      </div>
      {footer}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // allow picking the same file again
          if (files.length > 0) onAttachFiles(files);
        }}
      />
    </div>
  );
}
