import { useCallback, useState, type ReactNode } from 'react';
import type { Attachment, DigestInfo, DocMeta, ProviderInfo, SessionSummary } from '../../../shared/types.ts';
import { courseSummaryUrl } from '../api.ts';
import type { AttachmentsApi } from '../hooks/useAttachments.ts';
import type { CourseMembership } from '../hooks/useCourses.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { NEIGHBOR_OPTIONS } from '../hooks/useNeighbors.ts';
import type { ProviderChoice } from '../hooks/useProviderChoice.ts';
import { PENDING_ASSISTANT_ID, type StudySession } from '../hooks/useStudySession.ts';
import type { Chip } from '../lib/attachments.ts';
import { canOpenFiles, courseBadgeTitle, courseContextSentence, type EarlierLectures } from '../lib/courseContext.ts';
import { effortName, llmSwitchNotice, providerLabel, providerWithModel } from '../lib/format.ts';
import { sessionChoice } from '../lib/providerChoice.ts';
import { unrecordedAnswers } from '../lib/usage.ts';
import { Composer } from './Composer.tsx';
import { LlmSwitchDialog } from './LlmSwitchDialog.tsx';
import { MessageList } from './MessageList.tsx';
import { RecordingTabBadge } from './recording/LectureSpeech.tsx';
import { UsageBar } from './UsageBar.tsx';

export type PanelTab = 'chat' | 'digest' | 'notes' | 'memos' | 'recordings';

/** A jump to a Q&A (a question marker, DESIGN §25): the message to scroll into view. */
export interface ScrollRequest {
  sessionId: string;
  messageId: string;
  seq: number;
  /** When it was asked for (the list gives up after a while when the session never shows the message). */
  at: number;
}

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
  /** Content of the 노트 tab: mounted the first time the tab is opened, then kept. */
  notes: ReactNode;
  /** Content of the 정리본 tab: mounted only while the tab is shown (its 전체 list can hold dozens of entries). */
  digest: ReactNode;
  /** Digest of this document (for the tab badge and the empty-state copy); null while unknown. */
  digestInfo: DigestInfo | null;
  /** Course this lecture belongs to, or null. */
  course: CourseMembership | null;
  /** Earlier lectures of the course and whether their summaries exist (null when not in a course). */
  earlier: EarlierLectures | null;
  /** Start the digests of these lectures (with the provider chosen for new sessions). */
  onDigestLectures: (docs: DocMeta[]) => void;
  /** Neighbor slides (±N) fed with every question. */
  neighbors: number;
  onNeighborsChange: (n: number) => void;
  /** Attachments waiting for the next question (composer chips). */
  attachments: AttachmentsApi;
  /** Attach images (picked / pasted in the composer). */
  onAttachFiles: (files: File[], options?: { pasted?: boolean }) => void;
  /** Send a question about `slide` with the composer's attachments (they come back if it is not accepted). */
  onSendQuestion: (text: string, slide: number) => Promise<boolean>;
  /** Preview an attachment (a region also shows where it is on its slide). */
  onOpenAttachment: (attachment: Attachment) => void;
  /** Shown over the whole panel (the attachment preview). */
  overlay?: ReactNode;
  /** Content of the 녹음 tab (DESIGN §22): mounted the first time the tab is opened, then kept (its player plays on). */
  recordings: ReactNode;
  /** Recordings of this lecture (tab badge), null while unknown. */
  recordingCount: number | null;
  /** Content of the 메모 tab (DESIGN §25): mounted the first time the tab is opened, then kept. */
  memos: ReactNode;
  memoCount: number;
  /** Scroll the chat to a message (a question marker was clicked). */
  scrollTo?: ScrollRequest | null;
}

/** "Codex (gpt-5.5, 추론 높음)" for the session badge's tooltip. */
function sessionLlmDetails(providers: ProviderInfo[] | undefined, session: SessionSummary): string {
  const details = [session.model, session.effort ? `추론 ${effortName(providers, session.provider, session.effort)}` : ''];
  const shown = details.filter(Boolean);
  return `${providerLabel(providers, session.provider)}${shown.length > 0 ? ` (${shown.join(', ')})` : ''}`;
}

function DigestTabBadge({ info }: { info: DigestInfo | null }) {
  if (!info) return null;
  switch (info.status) {
    case 'running':
      return (
        <span className="tab-count is-running">
          ⏳ {info.done}/{info.total}
        </span>
      );
    case 'ready':
      return <span className="tab-count is-ok">✓</span>;
    case 'aborted':
    case 'error':
      return info.slides.length > 0 ? <span className="tab-count is-warn">일부</span> : null;
    default:
      return null;
  }
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
  digest,
  digestInfo,
  course,
  earlier,
  onDigestLectures,
  neighbors,
  onNeighborsChange,
  attachments,
  onAttachFiles,
  onSendQuestion,
  onOpenAttachment,
  overlay,
  recordings,
  recordingCount,
  memos,
  memoCount,
  scrollTo = null,
}: ChatPanelProps) {
  const { session, messages, liveTurn, running, creating } = study;
  const targetSlide = pinnedSlide ?? focusedSlide;
  const targetRef = useLatest(targetSlide);
  const digestReady = digestInfo?.status === 'ready';
  // Hidden tabs cost memory even with display:none (DOM + React trees stay): the notes mount the first
  // time they are opened for this lecture (their cards start collapsed), the 정리본 only while it is
  // shown — it scrolls back to the focused slide's entry when it comes back.
  const [notesOpenedFor, setNotesOpenedFor] = useState<string | null>(null);
  if (tab === 'notes' && notesOpenedFor !== doc.id) setNotesOpenedFor(doc.id);
  const notesMounted = notesOpenedFor === doc.id;
  const [recordingsOpenedFor, setRecordingsOpenedFor] = useState<string | null>(null);
  if (tab === 'recordings' && recordingsOpenedFor !== doc.id) setRecordingsOpenedFor(doc.id);
  const recordingsMounted = recordingsOpenedFor === doc.id;
  const [memosOpenedFor, setMemosOpenedFor] = useState<string | null>(null);
  if (tab === 'memos' && memosOpenedFor !== doc.id) setMemosOpenedFor(doc.id);
  const memosMounted = memosOpenedFor === doc.id;

  // `ask` / `primeCurrent` are stable while streaming, so memoized message items do not re-render on every delta.
  const { ask, primeCurrent } = study;
  const onSend = useCallback((text: string) => onSendQuestion(text, targetSlide), [onSendQuestion, targetSlide]);
  // A retry sends the failed question's attachments again (the server still has them: a message uses them).
  const onRetry = useCallback(
    (text: string, slide: number, attachments?: Attachment[]) => void ask(text, slide, attachments ?? []),
    [ask],
  );
  const onOpenChip = useCallback(
    (chip: Chip) => {
      if (chip.attachment) onOpenAttachment(chip.attachment);
    },
    [onOpenAttachment],
  );
  const retryPrime = useCallback(() => void primeCurrent(targetRef.current), [primeCurrent, targetRef]);
  // A priming turn that failed or was aborted leaves the session unprimed: offer to feed the deck again.
  const onRetryPrime = session && !session.primed && !running ? retryPrime : undefined;

  // "LLM 바꾸기" (DESIGN §5 "LLM switch"): the header badge opens the dialog. The notice stays until the next turn
  // starts or another session is shown (scrollKey changes then); the message list shows where the switch happened.
  const [switchOpen, setSwitchOpen] = useState(false);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const { switchLlm, scrollKey } = study;
  const applySwitch = useCallback(
    async (next: ProviderChoice) => {
      const updated = await switchLlm(next);
      if (!updated) return false;
      setNotice({ key: scrollKey, text: llmSwitchNotice(providerWithModel(providers, updated.provider, updated.model, updated.effort)) });
      return true;
    },
    [switchLlm, scrollKey, providers],
  );

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
        질문을 보내면 {choice ? <b>{providerWithModel(providers, choice.provider, choice.model, choice.effort)}</b> : 'LLM'}(으)로 새
        세션을 만들고, <b>전체 슬라이드 {doc.pageCount}장</b>
        {digestReady ? '(정리본 텍스트)' : ''}을 먼저 전달한 뒤 지금 보고 있는 슬라이드
        {neighbors > 0 ? `(앞뒤 ${neighbors}장 포함)` : ''}를 기준으로 설명해요.
      </p>
      {course && earlier && earlier.total > 0 && (
        <div className="course-context-note">
          <p className="muted small">
            {courseContextSentence(
              course.course.title,
              course.index,
              earlier,
              choice ? canOpenFiles(providers, choice.provider) : false,
            )}
          </p>
          {earlier.missing.length > 0 && choice && (
            <button type="button" className="ghost-btn small" onClick={() => onDigestLectures(earlier.missing)}>
              📝 이전 강의 {earlier.missing.length}개 정리본 만들기
            </button>
          )}
        </div>
      )}
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
        <li>‘정리본’ 탭에서 LLM이 슬라이드를 옮겨 적고 설명한 정리본을 슬라이드별로 읽을 수 있어요</li>
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
          aria-selected={tab === 'digest'}
          className={tab === 'digest' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('digest')}
        >
          정리본
          <DigestTabBadge info={digestInfo} />
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'memos'}
          className={tab === 'memos' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('memos')}
          title="슬라이드에 붙인 메모"
        >
          메모{memoCount > 0 && <span className="tab-count">{memoCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'recordings'}
          className={tab === 'recordings' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('recordings')}
          title="강의 녹음과 받아쓴 글"
        >
          녹음
          <RecordingTabBadge docId={doc.id} count={recordingCount} />
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
          <label
            className="neighbor-picker"
            title="질문할 때 지금 슬라이드와 함께 앞뒤 슬라이드도 LLM에게 전달해요 (슬라이드 내용이 여러 장에 이어질 때 유용해요)"
          >
            <span className="neighbor-label">앞뒤</span>
            <select
              className="picker small"
              aria-label="함께 전달할 앞뒤 슬라이드 수"
              value={neighbors}
              onChange={(e) => onNeighborsChange(Number(e.target.value))}
            >
              {NEIGHBOR_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  ±{n}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {course && (
            <a
              className="course-badge"
              href={courseSummaryUrl(course.course.id)}
              target="_blank"
              rel="noreferrer"
              title={
                earlier
                  ? courseBadgeTitle(course.course.title, course.index, earlier)
                  : `과목 ‘${course.course.title}’의 ${course.index}번째 강의 (클릭하면 COURSE.md)`
              }
            >
              📁 {course.course.title} · {course.index}/{course.total}강
            </a>
          )}
          {session && (
            <button
              type="button"
              className="provider-badge"
              disabled={running}
              onClick={() => setSwitchOpen(true)}
              aria-label={`LLM 바꾸기 (지금: ${sessionLlmDetails(providers, session)})`}
              title={
                running
                  ? `이 세션의 LLM: ${sessionLlmDetails(providers, session)} — 답변이 끝난 뒤에 바꿀 수 있어요`
                  : `이 세션의 LLM: ${sessionLlmDetails(providers, session)} — 클릭하면 다른 LLM으로 바꿀 수 있어요`
              }
            >
              {providerWithModel(providers, session.provider, session.model, session.effort)}
              <span className="provider-badge-caret" aria-hidden>
                ▾
              </span>
            </button>
          )}
        </div>

        {notice && notice.key === scrollKey && (
          <div className="chat-notice" role="status">
            <span>{notice.text}</span>
            <button type="button" className="ghost-btn tiny" onClick={() => setNotice(null)} aria-label="알림 닫기">
              ✕
            </button>
          </div>
        )}

        <MessageList
          messages={messages}
          pageCount={doc.pageCount}
          providers={providers}
          switches={session?.switches}
          liveAssistantId={liveAssistantId}
          liveStatus={study.liveStatus}
          stopping={study.stopping}
          running={running}
          scrollKey={study.scrollKey}
          onGoToSlide={onGoToSlide}
          onRetry={onRetry}
          onRetryPrime={onRetryPrime}
          empty={empty}
          scrollTo={scrollTo && scrollTo.sessionId === study.sessionId ? scrollTo : null}
        />

        <Composer
          docId={doc.id}
          targetSlide={targetSlide}
          pageCount={doc.pageCount}
          neighbors={neighbors}
          pinned={pinnedSlide !== null}
          running={running}
          canStop={liveTurn !== null && !study.stopping}
          disabledReason={disabledReason}
          onSend={onSend}
          onStop={study.stop}
          onGoToSlide={onGoToSlide}
          attachments={attachments}
          onAttachFiles={onAttachFiles}
          onOpenChip={onOpenChip}
          footer={
            session && (
              <UsageBar
                provider={session.provider}
                providers={providers}
                usage={session.usage}
                unrecorded={unrecordedAnswers(session.messages)}
                live={study.liveUsage}
                livePriming={liveTurn?.kind === 'prime'}
                limits={study.usageLimits}
              />
            )
          }
        />
      </div>

      <div className="digest-view" hidden={tab !== 'digest'}>
        {tab === 'digest' && digest}
      </div>

      <div className="notes-view" hidden={tab !== 'notes'}>
        {notesMounted && notes}
      </div>

      <div className="notes-view memos-view" hidden={tab !== 'memos'}>
        {memosMounted && memos}
      </div>

      <div className="recordings-view" hidden={tab !== 'recordings'}>
        {recordingsMounted && recordings}
      </div>

      {overlay}
      {switchOpen && session && (
        <LlmSwitchDialog
          onClose={() => setSwitchOpen(false)}
          providers={providers}
          current={sessionChoice(session)}
          onApply={applySwitch}
        />
      )}
    </section>
  );
}
