import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocMeta } from '../../shared/types.ts';
import { ApiError, errorMessage, startDigest } from './api.ts';
import { ChatPanel, type PanelTab } from './components/ChatPanel.tsx';
import { DigestPanel, type DigestMode } from './components/DigestPanel.tsx';
import { DocStatusView, LibraryView } from './components/LibraryView.tsx';
import { NotesPanel, type NotesFilter } from './components/NotesPanel.tsx';
import { SlideViewer, type SlideViewerHandle } from './components/SlideViewer.tsx';
import { SplitPane } from './components/SplitPane.tsx';
import { Toaster } from './components/Toaster.tsx';
import { TopBar } from './components/TopBar.tsx';
import { useCourses } from './hooks/useCourses.ts';
import { useDigest } from './hooks/useDigest.ts';
import { useDocs } from './hooks/useDocs.ts';
import { useHealth } from './hooks/useHealth.ts';
import { useLatest } from './hooks/useLatest.ts';
import { useNeighbors } from './hooks/useNeighbors.ts';
import { useNotes } from './hooks/useNotes.ts';
import { useProviderChoice } from './hooks/useProviderChoice.ts';
import { useStudySession } from './hooks/useStudySession.ts';
import { earlierLectures } from './lib/courseContext.ts';
import { providerWithModel } from './lib/format.ts';
import { isString, readStorage, storageKeys, writeStorage } from './lib/storage.ts';
import { toast } from './lib/toast.ts';

const isDigestMode = (v: unknown): v is DigestMode => v === 'current' || v === 'all';

interface AppProps {
  /**
   * The login screen is shown over the app (the session ended while it was in use, DESIGN §16): the app
   * stays mounted so nothing is lost, but ignores input (its API requests wait for the login).
   */
  suspended?: boolean;
  /** The server asks for an access code: offer a logout in the top bar. */
  authRequired?: boolean;
  onLogout?: () => Promise<void> | void;
}

export function App({ suspended = false, authRequired = false, onLogout }: AppProps = {}) {
  const { health, error: healthError, loading: healthLoading, reload: reloadHealth } = useHealth();
  const providers = health?.providers;
  const [choice, setChoice] = useProviderChoice(providers);

  const {
    docs,
    loadError,
    uploads,
    refresh: refreshDocs,
    upload,
    patchDoc,
    retry: retryDoc,
    remove: removeDoc,
  } = useDocs();
  const coursesState = useCourses();
  const { courses, membership } = coursesState;
  const [docId, setDocIdState] = useState<string | null>(() =>
    readStorage<string | null>(storageKeys.lastDoc, null, isString),
  );
  const setDocId = useCallback((id: string | null) => {
    setDocIdState(id);
    writeStorage(storageKeys.lastDoc, id);
  }, []);
  const doc = docs?.find((d) => d.id === docId) ?? null;
  const readyDocId = doc?.status === 'ready' ? doc.id : null;
  const docCourse = doc ? (membership.get(doc.id) ?? null) : null;
  const earlier = useMemo(
    () => (docCourse ? earlierLectures(docCourse.course, docCourse.index, docs) : null),
    [docCourse, docs],
  );

  // Forget a remembered doc that no longer exists.
  useEffect(() => {
    if (docs && docId && !docs.some((d) => d.id === docId)) setDocId(null);
  }, [docs, docId, setDocId]);

  // Per-document UI state.
  const [focusedSlide, setFocusedSlide] = useState(1);
  const [pinnedSlide, setPinnedSlide] = useState<number | null>(null);
  const [tab, setTab] = useState<PanelTab>('chat');
  const [notesFilter, setNotesFilter] = useState<NotesFilter>('all');
  useEffect(() => {
    setPinnedSlide(null);
    setNotesFilter('all');
    setTab('chat');
  }, [readyDocId]);
  const [neighbors, setNeighbors] = useNeighbors();
  const [digestMode, setDigestModeState] = useState<DigestMode>(() =>
    readStorage<DigestMode>(storageKeys.digestMode, 'current', isDigestMode),
  );
  const setDigestMode = useCallback((mode: DigestMode) => {
    setDigestModeState(mode);
    writeStorage(storageKeys.digestMode, mode);
  }, []);

  // ---- Digest of the open document: keep its DocMeta badge in sync with what the digest says. ------
  const digest = useDigest(readyDocId);
  const digestStatus = digest.info?.status;
  useEffect(() => {
    if (readyDocId && digestStatus && doc && doc.digestStatus !== digestStatus) {
      patchDoc(readyDocId, { digestStatus });
    }
  }, [readyDocId, digestStatus, doc, patchDoc]);

  const notesState = useNotes(readyDocId);
  const refreshNotes = notesState.refresh;
  const refreshDigest = digest.refresh;
  // Creating a session may auto-start the digest on the server (DESIGN §11): look again right after
  // creation and after each turn (in case the job was registered only after the create response).
  const onSessionCreated = useCallback((forDoc: string) => void refreshDigest(forDoc), [refreshDigest]);
  const onTurnFinished = useCallback(
    (forDoc: string) => {
      void refreshNotes(forDoc);
      void refreshDigest(forDoc, true);
    },
    [refreshNotes, refreshDigest],
  );
  const study = useStudySession({ docId: readyDocId, choice, neighbors, onTurnFinished, onSessionCreated });

  const viewerRef = useRef<SlideViewerHandle>(null);
  const goToSlide = useCallback((slide: number) => viewerRef.current?.scrollToSlide(slide), []);
  const openNotesFor = useCallback(
    (slide: number) => {
      setTab('notes');
      setNotesFilter(slide);
      void refreshNotes();
    },
    [refreshNotes],
  );
  const changeTab = useCallback(
    (next: PanelTab) => {
      setTab(next);
      if (next === 'notes') void refreshNotes();
      if (next === 'digest') void refreshDigest();
    },
    [refreshNotes, refreshDigest],
  );
  const togglePin = useCallback(() => setPinnedSlide((p) => (p === null ? focusedSlide : null)), [focusedSlide]);

  // ---- Upload target: the course new PDFs go into ------------------------------------------------
  // Chosen in the library, and following the course of the lecture that is open ("you are in Compiler").
  const [uploadCourseId, setUploadCourseIdState] = useState<string | null>(() =>
    readStorage<string | null>(storageKeys.uploadCourse, null, isString),
  );
  const setUploadCourseId = useCallback((id: string | null) => {
    setUploadCourseIdState(id);
    writeStorage(storageKeys.uploadCourse, id);
  }, []);
  const docCourseId = docCourse?.course.id ?? null;
  const docExists = doc !== null;
  useEffect(() => {
    if (docExists) setUploadCourseId(docCourseId);
  }, [docId, docExists, docCourseId, setUploadCourseId]);
  const uploadTarget = courses?.find((c) => c.id === uploadCourseId) ?? null;

  // ---- Upload: file picker, library drop zone and window-wide drag & drop -------------------------
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);
  const { addLocally: addLectureLocally, refresh: refreshCourses } = coursesState;
  /**
   * Upload PDFs (into `courseId` when given). With `open`, the last created doc is opened (its
   * progress is shown and it opens automatically when ready); course-card uploads stay in the library.
   */
  const uploadFiles = useCallback(
    async (files: File[], courseId: string | null, open: boolean) => {
      if (files.length === 0) return;
      const onCreated = courseId ? (d: DocMeta) => addLectureLocally(courseId, d.id) : undefined;
      const created = await upload(files, courseId, onCreated);
      if (created.length === 0) return;
      if (courseId) {
        void refreshCourses(); // the server inserts new lectures in natural title order
        const title = courses?.find((c) => c.id === courseId)?.title;
        if (title) toast(`📁 ${title} 과목에 강의 ${created.length}개를 추가했어요`, 'success');
      }
      if (open) setDocId(created[created.length - 1].id);
    },
    [upload, addLectureLocally, refreshCourses, courses, setDocId],
  );
  const handleFiles = useCallback(
    (files: File[]) => uploadFiles(files, uploadTarget?.id ?? null, true),
    [uploadFiles, uploadTarget],
  );
  const handleFilesRef = useLatest(handleFiles);

  const [dragOver, setDragOver] = useState(false);
  const suspendedRef = useLatest(suspended);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || suspendedRef.current) return;
      depth++;
      setDragOver(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault(); // allow dropping anywhere
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragOver(false);
      if (!hasFiles(e) || e.defaultPrevented) return; // the library drop zone already handled it
      e.preventDefault();
      if (suspendedRef.current) return; // the login screen is up
      void handleFilesRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFilesRef, suspendedRef]);

  // Warn before closing the tab while an answer is streaming (closing aborts it) or an upload runs.
  const busy = study.anyRunning || uploads.length > 0;
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);

  // ---- Logout (remote mode) ----------------------------------------------------------------------
  const logout = useCallback(() => {
    if (!onLogout) return;
    if (
      busy &&
      !window.confirm(
        '답변을 만들거나 PDF를 올리는 중이에요. 지금 로그아웃하면 이 화면에서는 결과를 볼 수 없어요.\n로그아웃할까요?',
      )
    ) {
      return;
    }
    void onLogout();
  }, [busy, onLogout]);

  // ---- Documents whose conversion failed: retry or delete (DESIGN §14) ----------------------------
  const deleteDoc = useCallback(
    async (target: DocMeta) => {
      const msg =
        `‘${target.title}’을(를) 삭제할까요?\n` +
        '업로드한 PDF와 여기서 만든 파일(슬라이드 이미지, 대화, 노트, 정리본)이 모두 지워지고, 과목에서도 빠져요.';
      if (!window.confirm(msg)) return;
      if (await removeDoc(target.id)) {
        void refreshCourses(); // the server also removed it from its course
        toast(`‘${target.title}’을(를) 삭제했어요.`, 'success');
      }
    },
    [removeDoc, refreshCourses],
  );

  // ---- 정리본 of several lectures at once (earlier lectures of a course: their summaries become context) --
  const digestLectures = useCallback(
    async (targets: DocMeta[]) => {
      if (targets.length === 0) return;
      if (!choice) {
        toast('사용할 수 있는 LLM이 없어요. 상단의 모델 선택을 확인해 주세요.', 'error');
        return;
      }
      const who = providerWithModel(providers, choice.provider, choice.model);
      const msg =
        `강의 ${targets.length}개의 정리본을 ${who}(으)로 만들까요?\n\n` +
        targets.map((d) => `• ${d.title}`).join('\n') +
        '\n\nLLM이 강의마다 모든 슬라이드를 읽어서 시간이 걸리고 사용량이 들어요. 완성된 강의의 요약은 같은 과목의 뒤 강의를 공부할 때 LLM에게 함께 전달돼요.';
      if (!window.confirm(msg)) return;
      let started = 0;
      const failed: string[] = [];
      for (const d of targets) {
        try {
          await startDigest(d.id, { provider: choice.provider, model: choice.model || undefined });
          started++;
          patchDoc(d.id, { digestStatus: 'running' });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            started++; // already running
            patchDoc(d.id, { digestStatus: 'running' });
          } else {
            failed.push(`${d.title}: ${errorMessage(e)}`);
          }
        }
      }
      if (started > 0) {
        toast(`정리본 만들기를 시작했어요 (${started}개). 진행 상황은 강의 목록의 배지에서 볼 수 있어요.`, 'success');
      }
      if (failed.length > 0) toast(`정리본을 시작하지 못했어요:\n${failed.join('\n')}`, 'error');
      void refreshDocs();
    },
    [choice, providers, patchDoc, refreshDocs],
  );
  const onDigestLectures = useCallback((targets: DocMeta[]) => void digestLectures(targets), [digestLectures]);

  // ---- Provider availability ---------------------------------------------------------------------
  const noProvider = !!providers && !providers.some((p) => p.available);
  const providerProblem = healthError
    ? `서버 상태를 확인하지 못했어요 (${healthError})`
    : !providers
      ? '사용할 수 있는 LLM을 확인하는 중…'
      : noProvider
        ? '사용 가능한 LLM이 없어요 — 상단 ⓘ 에서 이유를 확인하세요'
        : null;

  const notesCount = (notesState.notes?.slides ?? []).reduce((n, s) => n + s.entries.length, 0);

  let main;
  if (doc && doc.status === 'ready') {
    main = (
      <SplitPane
        left={
          <SlideViewer
            key={doc.id}
            ref={viewerRef}
            doc={doc}
            qaCounts={notesState.qaCounts}
            pinnedSlide={pinnedSlide}
            onFocusChange={setFocusedSlide}
            onOpenNotes={openNotesFor}
          />
        }
        right={
          <ChatPanel
            doc={doc}
            providers={providers}
            providerProblem={providerProblem}
            choice={choice}
            study={study}
            focusedSlide={focusedSlide}
            pinnedSlide={pinnedSlide}
            onTogglePin={togglePin}
            onGoToSlide={goToSlide}
            tab={tab}
            onTabChange={changeTab}
            notesCount={notesCount}
            digestInfo={digest.info}
            course={docCourse}
            earlier={earlier}
            onDigestLectures={onDigestLectures}
            neighbors={neighbors}
            onNeighborsChange={setNeighbors}
            digest={
              <DigestPanel
                key={doc.id}
                doc={doc}
                digest={digest}
                providers={providers}
                choice={choice}
                providerProblem={providerProblem}
                focusedSlide={focusedSlide}
                active={tab === 'digest'}
                mode={digestMode}
                onModeChange={setDigestMode}
                onGoToSlide={goToSlide}
              />
            }
            notes={
              <NotesPanel
                docId={doc.id}
                notes={notesState.notes}
                loading={notesState.loading}
                error={notesState.error}
                providers={providers}
                focusedSlide={focusedSlide}
                filter={notesFilter}
                onFilterChange={setNotesFilter}
                onGoToSlide={goToSlide}
                onRefresh={() => void refreshNotes()}
              />
            }
          />
        }
      />
    );
  } else if (doc) {
    main = (
      <DocStatusView
        doc={doc}
        onBack={() => setDocId(null)}
        onRetry={() => void retryDoc(doc.id)}
        onDelete={() => void deleteDoc(doc)}
      />
    );
  } else {
    main = (
      <LibraryView
        docs={docs}
        loadError={loadError}
        courses={courses}
        coursesError={coursesState.loadError}
        uploads={uploads}
        libraryDir={health?.libraryDir ?? null}
        uploadCourseId={uploadTarget?.id ?? null}
        onUploadCourseChange={setUploadCourseId}
        onOpen={setDocId}
        onPickFiles={pickFiles}
        onDropFiles={(files) => void handleFiles(files)}
        onUploadToCourse={(courseId, files) => void uploadFiles(files, courseId, false)}
        onCreateCourse={coursesState.create}
        onRenameCourse={(courseId, title) => void coursesState.rename(courseId, title)}
        onDeleteCourse={(courseId) => void coursesState.remove(courseId)}
        onSetLectures={(courseId, ids) => void coursesState.setLectures(courseId, ids)}
        onMoveLecture={(id, courseId) => void coursesState.moveLecture(id, courseId)}
        onRetryDoc={(id) => void retryDoc(id)}
        onDeleteDoc={(d) => void deleteDoc(d)}
        canDigest={choice !== null}
        onDigestLectures={onDigestLectures}
        onRetryLoad={() => {
          void refreshDocs();
          void refreshCourses();
        }}
      />
    );
  }

  return (
    <div className="app" inert={suspended} aria-hidden={suspended || undefined}>
      <TopBar
        docs={docs}
        doc={doc}
        courses={courses}
        onSelectDoc={setDocId}
        onUploadClick={pickFiles}
        uploadCourse={uploadTarget}
        sessions={study.sessions}
        sessionId={study.sessionId}
        sessionBusy={study.running}
        onSelectSession={study.selectSession}
        onNewSession={() => void study.newSession(pinnedSlide ?? focusedSlide)}
        onDeleteSession={(sid) => void study.deleteSession(sid)}
        providers={providers}
        providersLoading={healthLoading}
        choice={choice}
        onChoiceChange={setChoice}
        hasNotes={notesCount > 0}
        onLogout={authRequired && onLogout ? logout : undefined}
      />

      {healthError && (
        <div className="banner banner-error" role="alert">
          ⚠️ 서버에 연결할 수 없어요: {healthError}
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => {
              void reloadHealth();
              void refreshDocs();
              void refreshCourses();
            }}
          >
            다시 시도
          </button>
        </div>
      )}
      {!healthError && noProvider && (
        <div className="banner banner-warn" role="alert">
          ⚠️ 사용 가능한 LLM이 없어요.{' '}
          {providers?.map((p) => `${p.label}: ${p.reason ?? '사용 불가'}`).join(' · ')}
          <button type="button" className="ghost-btn small" onClick={() => void reloadHealth()}>
            다시 확인
          </button>
        </div>
      )}

      <main className="main">{main}</main>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // allow picking the same file again
          void handleFiles(files);
        }}
      />
      {dragOver && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-card">
            {uploadTarget ? `📄 PDF를 놓으면 📁 ${uploadTarget.title}에 강의로 추가해요` : '📄 PDF를 놓으면 업로드해요'}
            {!doc && (courses?.length ?? 0) > 0 && (
              <div className="drop-overlay-sub">과목 카드 위에 놓으면 그 과목에 추가돼요</div>
            )}
          </div>
        </div>
      )}
      <Toaster />
    </div>
  );
}
