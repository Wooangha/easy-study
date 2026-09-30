import { useCallback, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Folder, GraduationCap, Hourglass, Library, NotebookPen, Pin, TriangleAlert, X } from 'lucide-react';
import type { Attachment, DigestInfo, DocMeta, ProviderInfo, SessionSummary } from '../../../shared/types.ts';
import { courseSummaryUrl } from '../api.ts';
import type { AttachmentsApi } from '../hooks/useAttachments.ts';
import type { CourseMembership } from '../hooks/useCourses.ts';
import { useLatest } from '../hooks/useLatest.ts';
import { NEIGHBOR_OPTIONS } from '../hooks/useNeighbors.ts';
import type { ProviderChoice } from '../hooks/useProviderChoice.ts';
import { PENDING_ASSISTANT_ID, type StudySession } from '../hooks/useStudySession.ts';
import type { Chip } from '../lib/attachments.ts';
import { msg } from '../i18n/index.ts';
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
  const details = [session.model, session.effort ? msg().chat.llm.reasoning(effortName(providers, session.provider, session.effort)) : ''];
  const shown = details.filter(Boolean);
  return `${providerLabel(providers, session.provider)}${shown.length > 0 ? ` (${shown.join(', ')})` : ''}`;
}

function DigestTabBadge({ info }: { info: DigestInfo | null }) {
  if (!info) return null;
  const m = msg().chat.panel.tabs;
  switch (info.status) {
    case 'running':
      return (
        <span className="tab-count is-running">
          <Hourglass /> {info.done}/{info.total}
        </span>
      );
    case 'ready':
      return (
        <span className="tab-count is-ok" role="img" aria-label={m.digestDone}>
          <Check />
        </span>
      );
    case 'aborted':
    case 'error':
      return info.slides.length > 0 ? <span className="tab-count is-warn">{m.digestPartial}</span> : null;
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
  const m = msg().chat.panel;
  const shared = msg().chat.shared;
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
  // It keeps the new LLM, not its text, so it follows a change of the language.
  const [switchOpen, setSwitchOpen] = useState(false);
  const [notice, setNotice] = useState<{ key: string; llm: ProviderChoice } | null>(null);
  const { switchLlm, scrollKey } = study;
  const applySwitch = useCallback(
    async (next: ProviderChoice) => {
      const updated = await switchLlm(next);
      if (!updated) return false;
      setNotice({ key: scrollKey, llm: sessionChoice(updated) });
      return true;
    },
    [switchLlm, scrollKey],
  );

  // Without a session a question creates one, which needs an available provider.
  const disabledReason = !session && !running && !choice ? (providerProblem ?? shared.noLlm) : null;

  const liveAssistantId = liveTurn
    ? liveTurn.phase === 'pending' || !liveTurn.assistantMessage
      ? PENDING_ASSISTANT_ID
      : liveTurn.assistantMessage.id
    : null;

  const empty = creating ? (
    <div className="chat-empty">
      <div className="spinner" aria-hidden />
      <p>{m.creating}</p>
    </div>
  ) : !study.sessionId ? (
    <div className="chat-empty">
      <div className="chat-empty-icon" aria-hidden>
        <GraduationCap strokeWidth={1.5} />
      </div>
      <h3>{m.emptyTitle}</h3>
      <p>
        {m.emptyIntro(
          choice ? <b>{providerWithModel(providers, choice.provider, choice.model, choice.effort)}</b> : m.llmFallback,
          <b>{m.deck(doc.pageCount)}</b>,
          digestReady,
          neighbors,
        )}
      </p>
      {course && earlier && earlier.total > 0 && (
        <div className="course-context-note">
          <p className="muted small">
            <Folder />{' '}
            {courseContextSentence(
              course.course.title,
              course.index,
              earlier,
              choice ? canOpenFiles(providers, choice.provider) : false,
            )}
          </p>
          {earlier.missing.length > 0 && choice && (
            <button type="button" className="ghost-btn small" onClick={() => onDigestLectures(earlier.missing)}>
              <NotebookPen /> {m.digestEarlier(earlier.missing.length)}
            </button>
          )}
        </div>
      )}
      {choice ? (
        <button type="button" className="primary-btn" onClick={() => void study.newSession(targetSlide)}>
          {m.startSession}
        </button>
      ) : (
        <p className="warn-text">
          <TriangleAlert /> {providerProblem ?? shared.noLlmSentence}
        </p>
      )}
      <ul className="tips">
        <li>{m.tipKeys(<kbd>j</kbd>, <kbd>k</kbd>, <kbd>↑</kbd>, <kbd>↓</kbd>, <kbd>/</kbd>)}</li>
        <li>
          <Pin /> {m.tipPin}
        </li>
        <li>{m.tipNotes}</li>
        <li>{m.tipDigest}</li>
      </ul>
    </div>
  ) : !session ? (
    <div className="chat-empty">
      <div className="spinner" aria-hidden />
      <p>{m.loadingSession}</p>
    </div>
  ) : !session.primed && !running ? (
    <div className="chat-empty">
      <div className="chat-empty-icon" aria-hidden>
        <Library strokeWidth={1.5} />
      </div>
      <p>{m.notPrimed}</p>
      <button type="button" className="primary-btn" onClick={() => void study.primeCurrent(targetSlide)}>
        <Library /> {m.primeAll}
      </button>
      <p className="muted small">{m.primeLater}</p>
    </div>
  ) : (
    <div className="chat-empty">
      <p className="muted">{m.typeQuestion}</p>
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
          {m.tabs.chat}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'digest'}
          className={tab === 'digest' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('digest')}
        >
          {m.tabs.digest}
          <DigestTabBadge info={digestInfo} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notes'}
          className={tab === 'notes' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('notes')}
        >
          {m.tabs.notes}
          {notesCount > 0 && <span className="tab-count">{notesCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'memos'}
          className={tab === 'memos' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('memos')}
          title={m.tabs.memosTitle}
        >
          {m.tabs.memos}
          {memoCount > 0 && <span className="tab-count">{memoCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'recordings'}
          className={tab === 'recordings' ? 'panel-tab is-active' : 'panel-tab'}
          onClick={() => onTabChange('recordings')}
          title={m.tabs.recordingsTitle}
        >
          {m.tabs.recordings}
          <RecordingTabBadge docId={doc.id} count={recordingCount} />
        </button>
      </div>

      <div className="chat-view" hidden={tab !== 'chat'}>
        <div className="chat-header">
          <button
            type="button"
            className="page-indicator"
            onClick={() => onGoToSlide(focusedSlide)}
            title={m.viewedSlide}
          >
            p.{focusedSlide} <span className="muted">/ {doc.pageCount}</span>
          </button>
          <button
            type="button"
            className={pinnedSlide !== null ? 'pin-btn is-active' : 'pin-btn'}
            onClick={onTogglePin}
            aria-pressed={pinnedSlide !== null}
            title={pinnedSlide !== null ? m.unpinTitle : m.pinTitle}
          >
            <Pin /> {pinnedSlide !== null ? m.pinned(pinnedSlide) : m.pin}
          </button>
          <label className="neighbor-picker" title={m.neighborsTitle}>
            <span className="neighbor-label">{m.neighbors}</span>
            <select
              className="picker small"
              aria-label={m.neighborsLabel}
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
                  : msg().chat.course.badgeTitle(course.course.title, course.index)
              }
            >
              <Folder /> {course.course.title} · {msg().chat.course.badge(course.index, course.total)}
            </a>
          )}
          {session && (
            <button
              type="button"
              className="provider-badge"
              disabled={running}
              onClick={() => setSwitchOpen(true)}
              aria-label={m.switchLabel(sessionLlmDetails(providers, session))}
              title={
                running
                  ? m.switchTitleRunning(sessionLlmDetails(providers, session))
                  : m.switchTitle(sessionLlmDetails(providers, session))
              }
            >
              {providerWithModel(providers, session.provider, session.model, session.effort)}
              <span className="provider-badge-caret" aria-hidden>
                <ChevronDown />
              </span>
            </button>
          )}
        </div>

        {notice && notice.key === scrollKey && (
          <div className="chat-notice" role="status">
            <span>{llmSwitchNotice(providerWithModel(providers, notice.llm.provider, notice.llm.model, notice.llm.effort))}</span>
            <button type="button" className="ghost-btn tiny" onClick={() => setNotice(null)} aria-label={m.closeNotice} title={m.closeNotice}>
              <X />
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
