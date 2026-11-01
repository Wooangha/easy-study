// The lecture's chats, right of the panel tabs while the 채팅 tab is shown (0.6.15, DESIGN §13; they were a select in
// the top bar): "대화 기록" lists them (open one, delete one) and "새 대화" picks the LLM and starts one. The LLM it
// picks is the one for new chats and digests (also in 설정 › 공부); the open chat's LLM is changed from the chat header.
import { History, SquarePen, Trash } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ProviderInfo, SessionSummary } from '../../../shared/types.ts';
import type { ProviderChoice, ProviderChoiceUpdate } from '../hooks/useProviderChoice.ts';
import type { StudySession } from '../hooks/useStudySession.ts';
import { msg } from '../i18n/index.ts';
import { confirmDialog } from '../lib/confirm.ts';
import { formatTime, providerWithModel } from '../lib/format.ts';
import { Floating } from './annotations/Floating.tsx';
import { ProviderPicker } from './ProviderPicker.tsx';

interface ChatHistoryProps {
  study: StudySession;
  providers: ProviderInfo[] | undefined;
  providersLoading: boolean;
  /** The LLM for new chats. */
  choice: ProviderChoice | null;
  onChoiceChange: (choice: ProviderChoiceUpdate) => void;
  /** Why no LLM can be used, or null. */
  providerProblem: string | null;
  /** The slide a new chat starts on. */
  targetSlide: number;
}

type Open = 'history' | 'new' | null;

export function ChatHistory({ study, providers, providersLoading, choice, onChoiceChange, providerProblem, targetSlide }: ChatHistoryProps) {
  const [open, setOpen] = useState<Open>(null);
  const [historyButton, setHistoryButton] = useState<HTMLButtonElement | null>(null);
  const [newButton, setNewButton] = useState<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(null), []);
  const anchor = open === 'history' ? historyButton : open === 'new' ? newButton : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (anchor?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, anchor]);

  // Opened from the keyboard (Enter / Space: no pointer, detail 0): the keys go on in the panel.
  const toggle = (which: Exclude<Open, null>) => (e: MouseEvent<HTMLButtonElement>) => {
    const fromKeys = e.detail === 0;
    setOpen((o) => (o === which ? null : which));
    if (fromKeys) requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('button:not(:disabled), select')?.focus());
  };
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
    anchor?.focus({ preventScroll: true });
  };

  const m = msg().chat.history;
  const { sessions, sessionId, running, creating } = study;
  const count = sessions?.length ?? 0;
  const historyTitle = sessions === null ? m.loading : count === 0 ? m.noHistory : m.historyTitle(count);
  const startBlocked = running || creating ? m.startRunning : !choice ? (providerProblem ?? msg().chat.shared.noLlm) : null;

  const remove = (s: SessionSummary) => {
    void confirmDialog({ ...m.deleteConfirm, danger: true }).then((ok) => {
      if (ok) void study.deleteSession(s.id);
    });
  };

  return (
    <div className="chat-history">
      <button
        ref={setHistoryButton}
        type="button"
        className={open === 'history' ? 'chat-tool is-open' : 'chat-tool'}
        aria-haspopup="dialog"
        aria-expanded={open === 'history'}
        aria-label={historyTitle}
        title={historyTitle}
        disabled={count === 0}
        onClick={toggle('history')}
      >
        <History />
        {count > 1 && <span className="chat-tool-count">{count}</span>}
      </button>
      <button
        ref={setNewButton}
        type="button"
        className={open === 'new' ? 'chat-tool is-open' : 'chat-tool'}
        aria-haspopup="dialog"
        aria-expanded={open === 'new'}
        title={m.newChatTitle}
        onClick={toggle('new')}
      >
        <SquarePen />
        <span className="chat-tool-label">{m.newChat}</span>
      </button>

      {open === 'history' && sessions && (
        <Floating
          ref={panelRef}
          anchor={historyButton}
          width={340}
          height={360}
          className="chat-history-pop"
          role="dialog"
          label={m.history}
          onScrollAway={close}
          onKeyDown={onPanelKeyDown}
        >
          <div className="chat-history-head">{m.history}</div>
          <ul className="chat-history-list">
            {sessions.map((s) => {
              const current = s.id === sessionId;
              const when = formatTime(s.createdAt);
              const llm = providerWithModel(providers, s.provider, s.model, s.effort);
              const messages = m.messageCount(s.messageCount);
              const busy = current && running;
              return (
                <li key={s.id} className={current ? 'chat-history-row is-current' : 'chat-history-row'}>
                  <button
                    type="button"
                    className="chat-history-open"
                    aria-current={current || undefined}
                    aria-label={m.rowLabel(when, messages, llm)}
                    title={current ? `${m.current} · ${s.title}` : s.title}
                    onClick={() => {
                      if (!current) study.selectSession(s.id);
                      close();
                    }}
                  >
                    <span className="chat-history-dot" aria-hidden />
                    <span className="chat-history-when">{when}</span>
                    <span className="chat-history-meta">
                      {messages} · {llm}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn small chat-history-delete"
                    aria-label={m.deleteLabel(when)}
                    title={busy ? m.deleteRunning : m.delete}
                    disabled={busy}
                    onClick={() => remove(s)}
                  >
                    <Trash />
                  </button>
                </li>
              );
            })}
          </ul>
        </Floating>
      )}

      {open === 'new' && (
        <Floating
          ref={panelRef}
          anchor={newButton}
          width={300}
          height={280}
          className="llm-pop"
          role="dialog"
          label={m.newChatHead}
          onScrollAway={close}
          onKeyDown={onPanelKeyDown}
        >
          <div className="llm-pop-head">{m.newChatHead}</div>
          <ProviderPicker providers={providers} loading={providersLoading} choice={choice} onChange={onChoiceChange} className="is-stacked" />
          <button
            type="button"
            className="primary-btn"
            disabled={startBlocked !== null}
            title={startBlocked ?? undefined}
            onClick={() => {
              close();
              void study.newSession(targetSlide);
            }}
          >
            {m.start}
          </button>
          <p className="llm-pop-hint">{msg().shell.llm.popHint}</p>
        </Floating>
      )}
    </div>
  );
}
