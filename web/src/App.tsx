import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocMeta } from '../../shared/types.ts';
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
import { isString, readStorage, storageKeys, writeStorage } from './lib/storage.ts';
import { toast } from './lib/toast.ts';

const isDigestMode = (v: unknown): v is DigestMode => v === 'current' || v === 'all';

export function App() {
  const { health, error: healthError, loading: healthLoading, reload: reloadHealth } = useHealth();
  const providers = health?.providers;
  const [choice, setChoice] = useProviderChoice(providers);

  const { docs, loadError, uploads, refresh: refreshDocs, upload, patchDoc } = useDocs();
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
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
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
  }, [handleFilesRef]);

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
    main = <DocStatusView doc={doc} onBack={() => setDocId(null)} />;
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
        onRetryLoad={() => {
          void refreshDocs();
          void refreshCourses();
        }}
      />
    );
  }

  return (
    <div className="app">
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
