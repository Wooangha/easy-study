import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Attachment, ChatMessage, MessageStatus, ProviderInfo } from '../../../shared/types.ts';
import { PENDING_ASSISTANT_ID, PENDING_USER_ID } from '../hooks/useStudySession.ts';
import { CHAT_WINDOW, chatWindowStart } from '../lib/chatWindow.ts';
import { copyText } from '../lib/clipboard.ts';
import { describeContext, formatDuration, formatTime, primeCardState, providerWithModel } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { AttachmentThumbs } from './Attachments.tsx';
import { Markdown } from './Markdown.tsx';

interface MessageListProps {
  messages: ChatMessage[];
  pageCount: number;
  providers: ProviderInfo[] | undefined;
  /** Id of the assistant message currently streaming in this client (or the pending placeholder). */
  liveAssistantId: string | null;
  liveStatus: string | null;
  stopping: boolean;
  running: boolean;
  /**
   * Changes when the list should jump to the bottom (session switch, message sent). The window of
   * rendered messages then shrinks back to the last CHAT_WINDOW ones.
   */
  scrollKey: string;
  onGoToSlide: (slide: number) => void;
  /** Ask a failed question again (with the attachments it had). */
  onRetry: (text: string, slide: number, attachments?: Attachment[]) => void;
  /**
   * Feed the deck again. Given when the session is not primed and nothing runs; offered on the last
   * priming turn if it failed or was aborted.
   */
  onRetryPrime?: () => void;
  empty?: ReactNode;
}

/** Distance from the bottom (px) under which the list keeps following new content. */
const STICK_THRESHOLD = 80;

export function MessageList({
  messages,
  pageCount,
  providers,
  liveAssistantId,
  liveStatus,
  stopping,
  running,
  scrollKey,
  onGoToSlide,
  onRetry,
  onRetryPrime,
  empty,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Only the last messages are rendered (lib/chatWindow.ts); the window resets whenever scrollKey changes.
  const [win, setWin] = useState({ key: scrollKey, limit: CHAT_WINDOW });
  if (win.key !== scrollKey) setWin({ key: scrollKey, limit: CHAT_WINDOW });
  const limit = win.key === scrollKey ? win.limit : CHAT_WINDOW;
  const start = chatWindowStart(messages, limit);
  const nextStart = chatWindowStart(messages, limit + CHAT_WINDOW);
  /** Distance from the bottom to keep while older messages are added above (null = nothing pending). */
  const keepFromBottomRef = useRef<number | null>(null);
  const showOlder = (all: boolean) => {
    const el = listRef.current;
    if (el) keepFromBottomRef.current = el.scrollHeight - el.scrollTop;
    setWin({ key: scrollKey, limit: all ? messages.length : messages.length - nextStart });
  };
  // Keep what the student was looking at in place when older messages appear above it.
  useLayoutEffect(() => {
    const el = listRef.current;
    const keep = keepFromBottomRef.current;
    keepFromBottomRef.current = null;
    if (!el || keep === null) return;
    el.scrollTop = el.scrollHeight - keep;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  }, [start]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    stickRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickRef.current = true;
    setShowJump(false);
  }, []);

  // Follow new content only when the user is already near the bottom.
  useLayoutEffect(() => {
    if (stickRef.current) scrollToBottom();
    else setShowJump(true);
  }, [messages, liveStatus, scrollToBottom]);

  // Session switch / new question: always jump to the bottom.
  useLayoutEffect(() => {
    scrollToBottom();
  }, [scrollKey, scrollToBottom]);

  // Late layout changes (KaTeX fonts, images) while following: stay pinned to the bottom.
  useEffect(() => {
    const el = listRef.current;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Pair each failed/aborted answer with its question for the retry button, and each priming card with
  // the answer that says whether the deck actually reached the model.
  let lastPrimeAnswer: ChatMessage | undefined;
  for (const m of messages) if (m.role === 'assistant' && m.kind === 'prime') lastPrimeAnswer = m;
  const items: ReactNode[] = [];
  let lastUser: ChatMessage | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') lastUser = m;
    if (i < start) continue;
    const next = messages[i + 1];
    const pairStatus =
      m.role === 'user' && next?.role === 'assistant' && next.kind === m.kind ? next.status : undefined;
    const canRetry =
      !running &&
      m.role === 'assistant' &&
      m.kind === 'question' &&
      (m.status === 'error' || m.status === 'aborted') &&
      lastUser !== null &&
      lastUser.kind === 'question';
    const canRetryPrime =
      onRetryPrime !== undefined && m === lastPrimeAnswer && (m.status === 'error' || m.status === 'aborted');
    items.push(
      <MessageItem
        key={m.id}
        message={m}
        pageCount={pageCount}
        providers={providers}
        live={m.id === liveAssistantId}
        status={m.id === liveAssistantId ? liveStatus : null}
        stopping={m.id === liveAssistantId && stopping}
        pairStatus={pairStatus}
        retryText={canRetry && lastUser ? lastUser.text : null}
        retrySlide={canRetry && lastUser ? lastUser.slide : 0}
        retryAttachments={canRetry && lastUser ? lastUser.attachments : undefined}
        onGoToSlide={onGoToSlide}
        onRetry={onRetry}
        onRetryPrime={canRetryPrime ? onRetryPrime : undefined}
      />,
    );
  }

  return (
    <div className="message-list-wrap">
      <div className="message-list" ref={listRef} onScroll={onScroll}>
        <div className="message-list-inner">
          {start > 0 && (
            <div className="older-messages">
              <button type="button" className="ghost-btn small" onClick={() => showOlder(false)}>
                ↑ 이전 메시지 {start - nextStart}개 보기
              </button>
              {nextStart > 0 && (
                <button type="button" className="ghost-btn small" onClick={() => showOlder(true)}>
                  모두 보기 ({start}개)
                </button>
              )}
            </div>
          )}
          {messages.length === 0 ? empty : items}
        </div>
      </div>
      {showJump && messages.length > 0 && (
        <button type="button" className="jump-bottom" onClick={() => scrollToBottom('smooth')}>
          ↓ 최신 메시지
        </button>
      )}
    </div>
  );
}

interface MessageItemProps {
  message: ChatMessage;
  pageCount: number;
  providers: ProviderInfo[] | undefined;
  live: boolean;
  status: string | null;
  stopping: boolean;
  /** For a user message: status of the answer paired with it (undefined when there is none yet). */
  pairStatus: MessageStatus | undefined;
  retryText: string | null;
  retrySlide: number;
  retryAttachments: Attachment[] | undefined;
  onGoToSlide: (slide: number) => void;
  onRetry: (text: string, slide: number, attachments?: Attachment[]) => void;
  onRetryPrime?: () => void;
}

const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  const { message: m } = props;
  if (m.role === 'user') {
    return m.kind === 'prime' ? <PrimeCard {...props} /> : <UserBubble {...props} />;
  }
  return <AssistantMessage {...props} />;
});

function ContextLine({ message }: { message: ChatMessage }) {
  const chips = describeContext(message.context);
  if (chips.length === 0) return null;
  return (
    <div className="context-line" title="이 질문과 함께 LLM에게 전달된 내용">
      {chips.map((c) => (
        <span key={c.kind} className={`context-chip chip-${c.kind}`} title={c.title}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

function UserBubble({ message: m, onGoToSlide }: MessageItemProps) {
  const pending = m.id === PENDING_USER_ID;
  return (
    <div className="msg msg-user">
      <div className="msg-user-meta">
        <button type="button" className="slide-chip" onClick={() => onGoToSlide(m.slide)} title="이 슬라이드로 이동">
          p.{m.slide}
        </button>
        <span className="msg-time">{pending ? '보내는 중…' : formatTime(m.createdAt)}</span>
      </div>
      <AttachmentThumbs attachments={m.attachments} className="in-chat" />
      <div className="bubble">{m.text}</div>
      <ContextLine message={m} />
    </div>
  );
}

function PrimeCard({ message: m, pageCount, pairStatus }: MessageItemProps) {
  const state = primeCardState(pageCount, m.id === PENDING_USER_ID || !m.context, pairStatus);
  // What was attached is only worth listing once it actually reached the model.
  const extra = state.delivered
    ? describeContext(m.context)
        .filter((c) => c.kind !== 'primed')
        .map((c) => c.text)
    : [];
  const cls = state.tone === 'normal' ? 'msg system-card' : `msg system-card is-${state.tone}`;
  return (
    <div className={cls}>
      <div className="system-card-title">{state.title}</div>
      {extra.length > 0 && <div className="system-card-detail">{extra.join(' · ')}</div>}
    </div>
  );
}

function AssistantMessage({
  message: m,
  providers,
  live,
  status,
  stopping,
  retryText,
  retrySlide,
  retryAttachments,
  onRetry,
  onRetryPrime,
}: MessageItemProps) {
  const pending = m.id === PENDING_ASSISTANT_ID;
  const streaming = m.status === 'streaming';
  const meta: string[] = [];
  if (m.provider) meta.push(providerWithModel(providers, m.provider, m.model));
  if (m.durationMs !== undefined && !streaming) meta.push(formatDuration(m.durationMs));

  const copy = () => {
    void copyText(m.text)
      .then(() => toast('답변을 복사했어요', 'success', 2000))
      .catch(() => toast('복사하지 못했어요', 'error'));
  };

  return (
    <div className={`msg msg-assistant status-${m.status}`}>
      <div className="msg-assistant-head">
        <span className="assistant-avatar" aria-hidden>
          {m.kind === 'prime' ? '📋' : '🎓'}
        </span>
        <span className="assistant-title">{m.kind === 'prime' ? '슬라이드 개요' : '튜터'}</span>
        {meta.length > 0 && <span className="msg-meta">{meta.join(' · ')}</span>}
        {!streaming && m.text && (
          <button type="button" className="ghost-btn tiny" onClick={copy} title="Markdown 복사">
            복사
          </button>
        )}
      </div>

      {m.text ? (
        <div className={live && streaming ? 'answer is-streaming' : 'answer'}>
          <Markdown text={m.text} />
        </div>
      ) : (
        streaming &&
        live && (
          <div className="thinking">
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {pending ? '요청을 보내는 중…' : m.kind === 'prime' ? '슬라이드를 읽는 중…' : '생각하는 중…'}
          </div>
        )
      )}

      {streaming && live && (status || stopping) && (
        <div className="live-status">⏳ {stopping ? '중지하는 중…' : status}</div>
      )}
      {streaming && !live && (
        <div className="msg-note">⏳ 답변이 아직 완료되지 않았어요 (다른 창에서 진행 중이거나 중단됨)</div>
      )}
      {m.status === 'error' && (
        <div className="msg-error">⚠️ 답변 실패{m.error ? `: ${m.error}` : ''}</div>
      )}
      {m.status === 'aborted' && <div className="msg-note">⏹ 중단된 답변이에요</div>}
      {retryText !== null && (
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => onRetry(retryText, retrySlide, retryAttachments)}
          title={retryAttachments?.length ? `첨부 ${retryAttachments.length}개와 함께 다시 보내요` : undefined}
        >
          ↻ 다시 질문하기
        </button>
      )}
      {onRetryPrime && (
        <button
          type="button"
          className="ghost-btn small"
          onClick={onRetryPrime}
          title="슬라이드를 LLM에게 다시 전달해요 (바로 질문해도 첫 질문과 함께 전달돼요)"
        >
          📚 다시 전달하기
        </button>
      )}
    </div>
  );
}
