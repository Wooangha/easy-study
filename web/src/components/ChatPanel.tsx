import { useCallback, type ReactNode } from 'react';
import type { DocMeta, ProviderInfo } from '../../../shared/types.ts';
import type { ProviderChoice } from '../hooks/useProviderChoice.ts';
import { PENDING_ASSISTANT_ID, type StudySession } from '../hooks/useStudySession.ts';
import { providerLabel, providerWithModel } from '../lib/format.ts';
import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';

export type PanelTab = 'chat' | 'notes';

interface ChatPanelProps {
  doc: DocMeta;
  providers: ProviderInfo[] | undefined;
  /** Why no provider can be used (health failed / none available), or null. */
  providerProblem: string | null;
  choice: ProviderChoice | null;
  study: StudySession;
  focusedSlide: number;
  pinnedSlide: number | null;
  onTogglePin: () => void;
  onGoToSlide: (slide: number) => void;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  notesCount: number;
  notes: ReactNode;
}

export function ChatPanel({
  doc,
  providers,
  providerProblem,
  choice,
  study,
  focusedSlide,
  pinnedSlide,
  onTogglePin,
  onGoToSlide,
  tab,
  onTabChange,
  notesCount,
  notes,
}: ChatPanelProps) {
  const { session, messages, liveTurn, running, creating } = study;
  const targetSlide = pinnedSlide ?? focusedSlide;

  // `ask` is stable while streaming, so memoized message items do not re-render on every delta.
  const { ask } = study;
  const onSend = useCallback((text: string) => ask(text, targetSlide), [ask, targetSlide]);
  const onRetry = useCallback((text: string, slide: number) => void ask(text, slide), [ask]);

  // Without a session a question creates one, which needs an available provider.
  const disabledReason = !session && !running && !choice ? (providerProblem ?? '사용 가능한 LLM이 없어요') : null;

  const liveAssistantId = liveTurn
    ? liveTurn.phase === 'pending' || !liveTurn.assistantMessage
      ? PENDING_ASSISTANT_ID
      : liveTurn.assistantMessage.id
    : null;

  const empty = creating ? (
    <div className="chat-empty">
      <div className="spinner" aria-hidden />
      <p>새 세션을 만드는 중…</p>
    </div>
  ) : !study.sessionId ? (
    <div className="chat-empty">
      <div className="chat-empty-icon" aria-hidden>
        🎓
      </div>
      <h3>무엇이든 물어보세요</h3>
      <p>
        질문을 보내면 {choice ? <b>{providerWithModel(providers, choice.provider, choice.model)}</b> : 'LLM'}(으)로 새
        세션을 만들고, <b>전체 슬라이드 {doc.pageCount}장</b>을 먼저 전달한 뒤 지금 보고 있는 슬라이드를 기준으로
        설명해요.
      </p>
      {choice ? (
        <button type="button" className="primary-btn" onClick={() => void study.newSession(targetSlide)}>
          ＋ 새 세션 시작 (슬라이드 전달)
        </button>
      ) : (
        <p className="warn-text">⚠️ {providerProblem ?? '사용 가능한 LLM이 없어요.'}</p>
      )}
      <ul className="tips">
        <li>
          <kbd>j</kbd>/<kbd>k</kbd> 또는 <kbd>↑</kbd>/<kbd>↓</kbd> 로 슬라이드 이동, <kbd>/</kbd> 로 입력창 포커스
        </li>
        <li>📌 고정하면 스크롤해도 같은 슬라이드에 대해 계속 질문해요</li>
        <li>모든 Q&amp;A는 파일로 저장되고 ‘노트’ 탭에서 슬라이드별로 다시 볼 수 있어요</li>
      </ul>
    </div>
  ) : !session ? (
    <div className="chat-empty">
      <div className="spinner" aria-hidden />
      <p>세션을 불러오는 중…</p>
    </div>
  ) : !session.primed && !running ? (
    <div className="chat-empty">
      <div className="chat-empty-icon" aria-hidden>
        📚
      </div>
      <p>이 세션은 아직 슬라이드를 전달받지 않았어요.</p>
      <button type="button" className="primary-btn" onClick={() => void study.primeCurrent(targetSlide)}>
        📚 전체 슬라이드 전달하기
      </button>
      <p className="muted small">바로 질문해도 괜찮아요 — 첫 질문과 함께 전달돼요.</p>
    </div>
  ) : (
    <div className="chat-empty">
      <p className="muted">질문을 입력해 보세요.</p>
    </div>
  );

  return (
    <section className="chat-panel">
      <div className="panel-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={tab === 'chat' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('chat')}
        >
          채팅
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notes'}
          className={tab === 'notes' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('notes')}
        >
          노트{notesCount > 0 && <span className="tab-count">{notesCount}</span>}
        </button>
      </div>

      <div className="chat-view" hidden={tab !== 'chat'}>
        <div className="chat-header">
          <button
            type="button"
            className="page-indicator"
            onClick={() => onGoToSlide(focusedSlide)}
            title="보고 있는 슬라이드"
          >
            p.{focusedSlide} <span className="muted">/ {doc.pageCount}</span>
          </button>
          <button
            type="button"
            className={pinnedSlide !== null ? 'pin-btn is-active' : 'pin-btn'}
            onClick={onTogglePin}
            aria-pressed={pinnedSlide !== null}
            title={
              pinnedSlide !== null
                ? '고정 해제 — 다시 보고 있는 슬라이드에 대해 질문해요'
                : '지금 슬라이드를 고정 — 스크롤해도 이 슬라이드에 대해 질문해요'
            }
          >
            📌 {pinnedSlide !== null ? `p.${pinnedSlide} 고정됨` : '고정'}
          </button>
          <span className="spacer" />
          {session && (
            <span
              className="provider-badge"
              title={`이 세션의 LLM: ${providerLabel(providers, session.provider)}${session.model ? ` (${session.model})` : ''}`}
            >
              {providerWithModel(providers, session.provider, session.model)}
            </span>
          )}
        </div>

        <MessageList
          messages={messages}
          pageCount={doc.pageCount}
          providers={providers}
          liveAssistantId={liveAssistantId}
          liveStatus={study.liveStatus}
          stopping={study.stopping}
          running={running}
          scrollKey={`${study.sessionId ?? ''}:${liveTurn?.seq ?? ''}`}
          onGoToSlide={onGoToSlide}
          onRetry={onRetry}
          empty={empty}
        />

        <Composer
          targetSlide={targetSlide}
          pinned={pinnedSlide !== null}
          running={running}
          canStop={liveTurn !== null && !study.stopping}
          disabledReason={disabledReason}
          onSend={onSend}
          onStop={study.stop}
          onGoToSlide={onGoToSlide}
        />
      </div>

      <div className="notes-view" hidden={tab !== 'notes'}>
        {notes}
      </div>
    </section>
  );
}
