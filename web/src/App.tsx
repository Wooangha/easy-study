import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnnotationItem, Attachment, DocMeta, RegionRect } from '../../shared/types.ts';
import { ApiError, errorMessage, startDigest } from './api.ts';
import { AttachmentContext, AttachmentPreview, type AttachmentActions } from './components/Attachments.tsx';
import { ChatPanel, type PanelTab, type ScrollRequest } from './components/ChatPanel.tsx';
import { ConfirmHost } from './components/ConfirmDialog.tsx';
import { DigestPanel, type DigestMode } from './components/DigestPanel.tsx';
import { DocStatusView, LibraryView } from './components/LibraryView.tsx';
import { MemoListPanel } from './components/MemoListPanel.tsx';
import { NotesPanel, type NotesFilter } from './components/NotesPanel.tsx';
import { RecordControl, RecordingStrip } from './components/recording/RecorderBar.tsx';
import { RecordingUploadContext } from './components/recording/RecordingUploads.tsx';
import { RecordingsPanel, type PlayRequest } from './components/recording/RecordingsPanel.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { SlideViewer, type SlideViewerHandle } from './components/SlideViewer.tsx';
import { SplitPane } from './components/SplitPane.tsx';
import { Toaster } from './components/Toaster.tsx';
import { TopBar } from './components/TopBar.tsx';
import { UpdateBanner } from './components/UpdateBanner.tsx';
import { useAnnotations } from './hooks/useAnnotations.ts';
import { useAttachments } from './hooks/useAttachments.ts';
import { useCourses } from './hooks/useCourses.ts';
import { useDigest } from './hooks/useDigest.ts';
import { useDocs } from './hooks/useDocs.ts';
import { useHealth } from './hooks/useHealth.ts';
import { useLatest } from './hooks/useLatest.ts';
import { useNeighbors } from './hooks/useNeighbors.ts';
import { useNotes } from './hooks/useNotes.ts';
import { useProviderChoice } from './hooks/useProviderChoice.ts';
import { useRecordings } from './hooks/useRecordings.ts';
import { useStudySession } from './hooks/useStudySession.ts';
import {
  classifyDragTypes,
  dropOverlayCopy,
  EXPLAIN_REGION_PROMPT,
  planDrop,
  readyAttachments,
  withoutAttachments,
  type DragKinds,
} from './lib/attachments.ts';
import { confirmDialog } from './lib/confirm.ts';
import {
  SHELL_LEAVE_MS,
  allowLeave,
  desktopMarker,
  exposePageHook,
  firstUpdatedToast,
  leaveAllowed,
  settingsSection,
  updatePending,
  updatedToast,
  useDesktopState,
  type PageBusy,
  type SettingsSection,
} from './lib/desktop.ts';
import { RECORDING_ACCEPT } from './lib/recording/labels.ts';
import { recorder } from './lib/recording/recorder.ts';
import { getRecordingUploads, subscribeRecordingUploads, uploadRecordingFiles } from './lib/recording/uploads.ts';
import { earlierLectures } from './lib/courseContext.ts';
import { withParticle } from './lib/korean.ts';
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
  /** Tab to show when the lecture being opened is ready (e.g. 녹음, from the recording bar). */
  const pendingTab = useRef<PanelTab | null>(null);
  useEffect(() => {
    setPinnedSlide(null);
    setNotesFilter('all');
    setTab(pendingTab.current ?? 'chat');
    pendingTab.current = null;
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

  // ---- Lecture recordings (DESIGN §22) ------------------------------------------------------------------
  // The recorder lives outside React (it survives switching lectures and the login screen); at startup it looks
  // for a recording a reload interrupted. The viewer's slide changes are its slide-view events.
  useEffect(() => {
    void recorder.init();
  }, []);
  useEffect(() => {
    recorder.slideViewed(readyDocId, focusedSlide);
  }, [readyDocId, focusedSlide]);
  const recordings = useRecordings(readyDocId, tab === 'recordings');
  const recorderPhase = useSyncExternalStore(recorder.subscribe, () => recorder.getSnapshot().phase);
  const recordingUploads = useSyncExternalStore(subscribeRecordingUploads, () => getRecordingUploads().length);
  /** Recorded audio still on its way to the server (a restart or leaving would stop it). */
  const audioBacklog = useSyncExternalStore(recorder.subscribe, () => {
    const s = recorder.getSnapshot();
    return s.unsentSeconds > 0 || s.finishing > 0;
  });
  const recordingFileRef = useRef<HTMLInputElement>(null);
  const recordingTarget = useRef<DocMeta | null>(null);
  const pickRecordingFor = useCallback((target: DocMeta) => {
    recordingTarget.current = target;
    recordingFileRef.current?.click();
  }, []);

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

  // ---- Attachments of the next question (DESIGN §21) ---------------------------------------------
  const attachments = useAttachments(readyDocId);
  const {
    addFiles,
    addRegion,
    addAnnotation,
    take: takeAttachments,
    restore: restoreAttachments,
    settle: settleAttachments,
    count: countAttachments,
  } = attachments;
  const attachFiles = useCallback(
    (files: File[], options?: { pasted?: boolean }) => {
      setTab('chat'); // the chips are shown in the composer
      addFiles(files, options);
    },
    [addFiles],
  );
  const studyRef = useLatest(study);
  /**
   * Send a question with the composer's attachments; they come back when the question was not accepted — except
   * those the server no longer has (swept after 24 h unused): back, they would make every later question fail.
   */
  const sendQuestion = useCallback(
    async (text: string, slide: number): Promise<boolean> => {
      const taken = takeAttachments();
      const result = await studyRef.current.ask(text, slide, readyAttachments(taken.chips));
      if (!result.accepted) {
        restoreAttachments({ docId: taken.docId, chips: withoutAttachments(taken.chips, result.missingAttachments) });
      }
      return result.accepted;
    },
    [takeAttachments, restoreAttachments, studyRef],
  );
  const [preview, setPreview] = useState<{ docId: string; attachment: Attachment } | null>(null);
  useEffect(() => setPreview(null), [readyDocId]);
  const openAttachment = useCallback(
    (attachment: Attachment) => {
      if (!readyDocId) return;
      setPreview({ docId: readyDocId, attachment });
      if (attachment.kind === 'region' && attachment.slide && attachment.rect) {
        viewerRef.current?.showRegion(attachment.slide, attachment.rect);
      }
    },
    [readyDocId],
  );
  const showOnSlide = useCallback((attachment: Attachment) => {
    if (attachment.slide && attachment.rect) viewerRef.current?.showRegion(attachment.slide, attachment.rect);
  }, []);
  const attachmentActions = useMemo<AttachmentActions | null>(
    () => (readyDocId ? { docId: readyDocId, open: openAttachment } : null),
    [readyDocId, openAttachment],
  );
  const attachRegion = useCallback(
    (slide: number, rect: RegionRect) => {
      setTab('chat');
      void addRegion(slide, rect);
    },
    [addRegion],
  );
  /** 📎 첨부 of an annotation item (DESIGN §25): a chip in the composer, sent with the next question. */
  const attachItem = useCallback(
    (slide: number, item: AnnotationItem) => {
      setTab('chat');
      void addAnnotation(slide, item);
    },
    [addAnnotation],
  );
  const openNotesFor = useCallback(
    (slide: number) => {
      setTab('notes');
      setNotesFilter(slide);
      void refreshNotes();
    },
    [refreshNotes],
  );
  const refreshRecordings = recordings.refresh;
  const changeTab = useCallback(
    (next: PanelTab) => {
      setTab(next);
      if (next === 'notes') void refreshNotes();
      if (next === 'digest') void refreshDigest();
      if (next === 'recordings') void refreshRecordings();
    },
    [refreshNotes, refreshDigest, refreshRecordings],
  );
  /** The 녹음 tab of the lecture being recorded (opening it first when another one is shown). */
  const showRecordings = useCallback(() => {
    const target = recorder.getSnapshot().docId;
    if (target && target !== readyDocId) {
      pendingTab.current = 'recordings';
      setDocId(target);
      return;
    }
    changeTab('recordings');
  }, [readyDocId, setDocId, changeTab]);
  const togglePin = useCallback(() => setPinnedSlide((p) => (p === null ? focusedSlide : null)), [focusedSlide]);

  // ---- Slide annotations (DESIGN §25): the memo tab, question markers → Q&A, memo links, recording moments ----
  const annotations = useAnnotations(readyDocId);
  const annotationStore = annotations.store;
  const memoCount = annotations.snapshot.summary?.memos.length ?? 0;
  // Another device's turn finished (or a session was deleted): the notes (and so the markers) are stale.
  useEffect(() => {
    if (!annotationStore) return;
    return annotationStore.onQa((change) => {
      const known = studyRef.current.sessions?.find((s) => s.id === change.sessionId);
      if (known && change.updatedAt !== null && known.updatedAt === change.updatedAt) return;
      void refreshNotes(annotationStore.docId);
      void studyRef.current.refreshSessions(annotationStore.docId);
    });
  }, [annotationStore, refreshNotes, studyRef]);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  const scrollSeq = useRef(0);
  /** A question marker was clicked: the chat shows that Q&A (its session opened, the message scrolled into view). */
  const openQa = useCallback(
    (sessionId: string, messageId: string) => {
      const s = studyRef.current;
      if (s.sessions && !s.sessions.some((x) => x.id === sessionId)) {
        toast('그 질문의 세션을 찾을 수 없어요', 'info');
        return;
      }
      setTab('chat');
      if (s.sessionId !== sessionId) s.selectSession(sessionId);
      setScrollRequest({ sessionId, messageId, seq: ++scrollSeq.current, at: Date.now() });
    },
    [studyRef],
  );
  const [playRequest, setPlayRequest] = useState<PlayRequest | null>(null);
  const playSeq = useRef(0);
  const recordingsRef = useLatest(recordings);
  /** A memo's 🎙 chip: play that moment in the 녹음 tab. */
  const playRecording = useCallback(
    (rid: string, t: number) => {
      const list = recordingsRef.current.list;
      if (list && !list.some((r) => r.id === rid)) {
        toast('그 녹음을 찾을 수 없어요', 'info');
        return;
      }
      changeTab('recordings');
      setPlayRequest({ rid, t, seq: ++playSeq.current });
    },
    [recordingsRef, changeTab],
  );
  /** A memo's link to another lecture: open it on that slide (the viewer restores the remembered slide). */
  const openDoc = useCallback(
    (target: string, slide?: number) => {
      if (target === readyDocId) {
        if (slide) goToSlide(slide);
        return;
      }
      if (!docs?.some((d) => d.id === target)) {
        toast('그 강의는 지워졌어요', 'info');
        return;
      }
      if (slide) writeStorage(storageKeys.slide(target), slide);
      setDocId(target);
    },
    [readyDocId, docs, goToSlide, setDocId],
  );
  const openMemo = useCallback((slide: number, id: string) => viewerRef.current?.showItem(slide, id), []);
  useEffect(() => {
    setScrollRequest(null);
    setPlayRequest(null);
  }, [readyDocId]);

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
   * Opening never throws away the open lecture's attachments waiting in the composer (e.g. images dropped
   * together with the PDF): with any there, the new lecture is only added, and a toast says where it is.
   */
  const uploadFiles = useCallback(
    async (files: File[], courseId: string | null, open: boolean) => {
      if (files.length === 0) return;
      const onCreated = courseId ? (d: DocMeta) => addLectureLocally(courseId, d.id) : undefined;
      const created = await upload(files, courseId, onCreated);
      if (created.length === 0) return;
      const last = created[created.length - 1];
      const stay = open && countAttachments() > 0;
      const courseTitle = courseId ? courses?.find((c) => c.id === courseId)?.title : undefined;
      if (courseId) void refreshCourses(); // the server inserts new lectures in natural title order
      if (stay) {
        const what = created.length === 1 ? `‘${last.title}’ 강의` : `강의 ${created.length}개`;
        toast(
          `${what}를 ${courseTitle ? `📁 ${courseTitle} 과목에 ` : ''}추가했어요. 입력창의 첨부를 지키려고 지금 강의에 그대로 있어요 — 상단 문서 목록에서 열 수 있어요.`,
          'success',
        );
      } else {
        if (courseTitle) toast(`📁 ${courseTitle} 과목에 강의 ${created.length}개를 추가했어요`, 'success');
        if (open) setDocId(last.id);
      }
    },
    [upload, addLectureLocally, refreshCourses, courses, setDocId, countAttachments],
  );
  const handleFiles = useCallback(
    (files: File[]) => uploadFiles(files, uploadTarget?.id ?? null, true),
    [uploadFiles, uploadTarget],
  );
  /**
   * Dropped files, wherever they land (the window, the library's drop zone, a course card): PDFs become lectures
   * (into `courseId`), images are attached to the next question while a lecture is open, the rest is explained.
   */
  const dropFiles = useCallback(
    (files: File[], courseId: string | null, open: boolean) => {
      const plan = planDrop(files, readyDocId !== null);
      for (const notice of plan.notices) toast(notice.message, notice.kind);
      // Attached first: the chips are in the composer before the PDFs are uploaded, so those are not opened.
      if (plan.images.length > 0) attachFiles(plan.images);
      if (plan.pdfs.length > 0) void uploadFiles(plan.pdfs, courseId, open);
    },
    [readyDocId, attachFiles, uploadFiles],
  );
  const dropFilesRef = useLatest(dropFiles);
  const uploadTargetIdRef = useLatest(uploadTarget?.id ?? null);

  // Dropped PDFs become lectures; dropped images are attached to the next question while a lecture is open
  // (anywhere on the page, the chat panel included). One listener decides, so the two never compete.
  const [dragOver, setDragOver] = useState<DragKinds | null>(null);
  const suspendedRef = useLatest(suspended);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const dragKinds = (e: DragEvent) =>
      classifyDragTypes(
        Array.from(e.dataTransfer?.items ?? [])
          .filter((item) => item.kind === 'file')
          .map((item) => item.type),
      );
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || suspendedRef.current) return;
      depth++;
      setDragOver(dragKinds(e));
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(null);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault(); // allow dropping anywhere
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragOver(null);
      if (!hasFiles(e) || e.defaultPrevented) return; // the library drop zone already handled it
      e.preventDefault();
      if (suspendedRef.current) return; // the login screen is up
      dropFilesRef.current(Array.from(e.dataTransfer?.files ?? []), uploadTargetIdRef.current, true);
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
  }, [dropFilesRef, uploadTargetIdRef, suspendedRef]);

  // Warn before closing the tab while an answer is streaming (closing aborts it), an upload runs or a lecture is
  // being recorded (the audio captured so far is safe, but the recording stops).
  const busy = study.anyRunning || uploads.length > 0 || recordingUploads > 0 || recorderPhase !== 'idle';
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // A navigation of the desktop app that was already asked about, or one it cancels anyway (DESIGN §24).
      if (leaveAllowed()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);

  // ---- The desktop app (DESIGN §24): its update state, and the hooks its shell calls ------------------
  // What an update or a change of server would interrupt: for the banner and 설정 (re-rendered when it changes)…
  const pageBusy = useMemo<PageBusy>(() => {
    const s = recorder.getSnapshot();
    return {
      recording: recorderPhase !== 'idle',
      unsentSeconds: s.unsentSeconds,
      finishing: s.finishing,
      recordingUploads,
      uploads: uploads.length,
      answering: study.anyRunning,
    };
    // audioBacklog: the snapshot's numbers are read when it changes.
  }, [recorderPhase, audioBacklog, recordingUploads, uploads.length, study.anyRunning]);
  // …and for the shell, read when it asks (window.__easyStudyBusy). The hooks exist in browsers too, unused there.
  const uploadCountRef = useLatest(uploads.length);
  useEffect(() => {
    const removeBusy = exposePageHook('__easyStudyBusy', () => {
      const s = recorder.getSnapshot();
      return {
        recording: s.phase !== 'idle',
        unsentSeconds: s.unsentSeconds,
        finishing: s.finishing,
        recordingUploads: getRecordingUploads().length,
        uploads: uploadCountRef.current,
        answering: studyRef.current.anyRunning,
      };
    });
    // The shell navigates after asking the user in its own dialog: the page must not ask again ("Leave site?").
    const removeAllowLeave = exposePageHook('__easyStudyAllowLeave', () => {
      allowLeave(SHELL_LEAVE_MS);
      return true;
    });
    return () => {
      removeBusy();
      removeAllowLeave();
    };
  }, [uploadCountRef, studyRef]);

  // 설정 (⚙, the app menu "설정…" through __easyStudyOpenSettings). Under the login screen it opens after the login.
  const [settings, setSettings] = useState<{ section: SettingsSection | null } | null>(null);
  const pendingSettings = useRef<{ section: SettingsSection | null } | null>(null);
  useEffect(() => {
    if (suspended) {
      setSettings(null);
    } else if (pendingSettings.current) {
      setSettings(pendingSettings.current);
      pendingSettings.current = null;
    }
  }, [suspended]);
  useEffect(
    () =>
      exposePageHook('__easyStudyOpenSettings', (section?: unknown) => {
        const request = { section: settingsSection(section) };
        if (suspendedRef.current) pendingSettings.current = request;
        else setSettings(request);
        return true;
      }),
    [suspendedRef],
  );

  const desktop = useDesktopState();
  const update = desktop?.update ?? null;
  const justUpdated = desktop?.justUpdated ?? null;
  useEffect(() => {
    if (!justUpdated || !firstUpdatedToast(justUpdated)) return;
    toast(updatedToast(justUpdated, desktopMarker()?.os), 'success', 12_000);
  }, [justUpdated]);

  // ---- Logout (remote mode) ----------------------------------------------------------------------
  const logout = useCallback(async () => {
    if (!onLogout) return;
    const recording = recorderPhase === 'recording' || recorderPhase === 'paused';
    if (
      busy &&
      !(await confirmDialog({
        title: '로그아웃할까요?',
        message: recording
          ? '강의를 녹음하는 중이에요. 로그아웃하면 녹음을 끝내요 (지금까지 녹음한 것은 다시 로그인하면 마저 올라가요).'
          : '답변을 만들거나 파일을 올리는 중이에요. 지금 로그아웃하면 이 화면에서는 결과를 볼 수 없어요.',
        confirmLabel: '로그아웃',
      }))
    ) {
      return;
    }
    if (recording) await recorder.stop();
    void onLogout();
  }, [busy, onLogout, recorderPhase]);

  // ---- Documents whose conversion failed: retry or delete (DESIGN §14) ----------------------------
  const deleteDoc = useCallback(
    async (target: DocMeta) => {
      const ok = await confirmDialog({
        title: `${withParticle(`‘${target.title}’`, '을', '를')} 삭제할까요?`,
        message: '업로드한 PDF와 여기서 만든 파일(슬라이드 이미지, 대화, 노트, 정리본)이 모두 지워지고, 과목에서도 빠져요.',
        confirmLabel: '삭제',
        danger: true,
      });
      if (!ok) return;
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
      const who = providerWithModel(providers, choice.provider, choice.model, choice.effort);
      const ok = await confirmDialog({
        title: `강의 ${targets.length}개의 정리본을 ${who}(으)로 만들까요?`,
        message:
          targets.map((d) => `• ${d.title}`).join('\n') +
          '\nLLM이 강의마다 모든 슬라이드를 읽어서 시간이 걸리고 사용량이 들어요. 완성된 강의의 요약은 같은 과목의 뒤 강의를 공부할 때 LLM에게 함께 전달돼요.',
        confirmLabel: '정리본 만들기',
      });
      if (!ok) return;
      let started = 0;
      const failed: string[] = [];
      for (const d of targets) {
        try {
          await startDigest(d.id, {
            provider: choice.provider,
            model: choice.model || undefined,
            effort: choice.effort || undefined,
          });
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

  // "💬 이 부분 설명해줘" on a selected region: the same rule as the composer's send button.
  const askDisabledReason = study.running
    ? '답변이 끝난 뒤에 질문할 수 있어요 (📎 첨부는 지금도 돼요)'
    : !study.session && !choice
      ? (providerProblem ?? '사용 가능한 LLM이 없어요')
      : null;
  const askDisabledRef = useLatest(askDisabledReason);
  const askRegion = useCallback(
    async (slide: number, rect: RegionRect) => {
      setTab('chat');
      const created = await addRegion(slide, rect);
      if (!created) return;
      await settleAttachments(); // images still uploading go along
      const blocked = askDisabledRef.current;
      if (blocked) {
        toast(`영역을 입력창에 첨부해 두었어요. ${blocked}`, 'info');
        return;
      }
      await sendQuestion(EXPLAIN_REGION_PROMPT, slide);
    },
    [addRegion, settleAttachments, askDisabledRef, sendQuestion],
  );
  const onAskRegion = useCallback((slide: number, rect: RegionRect) => void askRegion(slide, rect), [askRegion]);

  const notesCount = (notesState.notes?.slides ?? []).reduce((n, s) => n + s.entries.length, 0);

  let main;
  if (doc && doc.status === 'ready') {
    main = (
      <AttachmentContext.Provider value={attachmentActions}>
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
              onAttachRegion={attachRegion}
              onAskRegion={onAskRegion}
              askDisabledReason={askDisabledReason}
              onAttachItem={attachItem}
              onOpenQa={openQa}
              onPlayRecording={playRecording}
              onOpenDoc={openDoc}
              notes={notesState.notes}
              docs={docs}
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
              attachments={attachments}
              onAttachFiles={attachFiles}
              onSendQuestion={sendQuestion}
              onOpenAttachment={openAttachment}
              overlay={
                preview && preview.docId === doc.id ? (
                  <AttachmentPreview
                    docId={preview.docId}
                    attachment={preview.attachment}
                    onClose={() => setPreview(null)}
                    onShowOnSlide={showOnSlide}
                  />
                ) : null
              }
              recordingCount={recordings.list?.length ?? null}
              memoCount={memoCount}
              scrollTo={scrollRequest}
              memos={
                <MemoListPanel
                  key={doc.id}
                  docId={doc.id}
                  focusedSlide={focusedSlide}
                  onOpenMemo={openMemo}
                  onGoToSlide={goToSlide}
                  onPlayRecording={playRecording}
                />
              }
              recordings={
                <RecordingsPanel
                  key={doc.id}
                  doc={doc}
                  focusedSlide={focusedSlide}
                  active={tab === 'recordings'}
                  providers={providers}
                  choice={choice}
                  recordings={recordings}
                  onGoToSlide={goToSlide}
                  playRequest={playRequest}
                />
              }
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
      </AttachmentContext.Provider>
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
        org={coursesState}
        uploads={uploads}
        libraryDir={health?.libraryDir ?? null}
        uploadCourseId={uploadTarget?.id ?? null}
        onUploadCourseChange={setUploadCourseId}
        onOpen={setDocId}
        onPickFiles={pickFiles}
        onDropFiles={(files) => dropFiles(files, uploadTarget?.id ?? null, true)}
        onUploadToCourse={(courseId, files) => dropFiles(files, courseId, false)}
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
        layout={coursesState.layout}
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
        onLogout={authRequired && onLogout ? () => void logout() : undefined}
        onOpenSettings={() => setSettings({ section: null })}
        updatePending={updatePending(update)}
        recordControl={
          <RecordControl
            doc={doc?.status === 'ready' ? doc : null}
            focusedSlide={focusedSlide}
            docs={docs}
            onOpenDoc={setDocId}
            onShowRecordings={showRecordings}
          />
        }
      />
      <RecordingStrip onShowRecordings={showRecordings} />
      <UpdateBanner update={update} busy={pageBusy} />

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

      <RecordingUploadContext.Provider value={pickRecordingFor}>
        <main className="main">{main}</main>
      </RecordingUploadContext.Provider>
      <input
        ref={recordingFileRef}
        type="file"
        accept={RECORDING_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          const target = recordingTarget.current;
          recordingTarget.current = null;
          if (target && files.length > 0) void uploadRecordingFiles(target.id, target.title, files);
        }}
      />

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
            {(() => {
              const copy = dropOverlayCopy(
                dragOver,
                uploadTarget ? `📄 PDF를 놓으면 📁 ${uploadTarget.title}에 강의로 추가해요` : '📄 PDF를 놓으면 업로드해요',
                readyDocId !== null,
              );
              return (
                <>
                  {copy.title}
                  {copy.sub && <div className="drop-overlay-sub">{copy.sub}</div>}
                </>
              );
            })()}
            {!doc && (courses?.length ?? 0) > 0 && (dragOver.pdf || dragOver.unknown) && (
              <div className="drop-overlay-sub">과목 카드 위에 놓으면 그 과목에 추가돼요</div>
            )}
          </div>
        </div>
      )}
      {/* A modal dialog covers the page, toasts too: while 설정 is open, it shows them. */}
      {settings === null && <Toaster />}
      <SettingsDialog
        open={settings !== null}
        section={settings?.section ?? null}
        onClose={() => setSettings(null)}
        health={health}
        busy={pageBusy}
      />
      <ConfirmHost suspended={suspended} />
    </div>
  );
}
