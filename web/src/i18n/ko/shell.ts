// Korean (the reference language) — namespace `shell`: the app frame. Top bar, library and its organizing (courses,
// groups, drag & drop), the update banner, the login and local-only screens, toasts of these areas.
import type { ReactNode } from 'react';
import { withParticle } from '../../lib/korean.ts';
import { rich } from '../rich.ts';

export const shell = {
  topBar: {
    toLibrary: '라이브러리로',
    docPicker: '문서 선택',
    docPlaceholder: '문서 선택…',
    noDocs: '문서 없음',
    addPdf: '＋ PDF 추가',
    addPdfTo: (course: string) => `＋ PDF 추가 (${course})`,
    /** A lecture being converted: "Lecture 3 (처리 중 40%)". */
    docProcessing: (name: string, percent: number) => `${name} (처리 중 ${percent}%)`,
    docError: (name: string) => `${name} (오류)`,
    /** The slide count of a ready lecture: "Lecture 3 · 24장". */
    slideCount: (n: number) => `${n}장`,
    digestReady: '정리본',
    digestRunning: '정리 중',
    noLectures: '(강의 없음)',
    uncategorized: '미분류',
    sessionPicker: '세션 선택',
    sessionsLoading: '세션 불러오는 중…',
    noSessions: '세션 없음',
    messageCount: (n: number) => `메시지 ${n}개`,
    newSession: '＋ 새 세션',
    deleteSession: '이 세션 삭제',
    deleteSessionConfirm: {
      title: '이 세션을 삭제할까요?',
      message: '세션과 대화 기록(노트 포함)이 지워지고 되돌릴 수 없어요.',
      confirmLabel: '세션 삭제',
    },
    notesFile: '노트 파일',
    openNotes: 'STUDY_NOTES.md 열기',
    noNotesYet: '아직 저장된 Q&A가 없어요',
    logout: '로그아웃',
    logoutTitle: '이 브라우저에서 로그아웃',
    settingsUpdateLabel: '설정 (새 버전 있음)',
    settingsUpdateTitle: '설정 · 새 버전 있음',
  },

  /** App.tsx: toasts, banners, the drop overlay and the reasons a question cannot be asked. */
  app: {
    qaSessionMissing: '그 질문의 세션을 찾을 수 없어요',
    recordingMissing: '그 녹음을 찾을 수 없어요',
    lectureDeleted: '그 강의는 지워졌어요',
    /**
     * PDFs uploaded while the composer holds attachments: the open lecture stays. `count` lectures (one: `title`),
     * into `course` when given.
     */
    addedKeptOpen: (count: number, title: string, course: string | null) =>
      `${count === 1 ? `‘${title}’ 강의` : `강의 ${count}개`}를 ${course ? `${course} 과목에 ` : ''}추가했어요. 입력창의 첨부를 지키려고 지금 강의에 그대로 있어요 — 상단 문서 목록에서 열 수 있어요.`,
    addedToCourse: (course: string, count: number) => `${course} 과목에 강의 ${count}개를 추가했어요`,
    logoutConfirm: {
      title: '로그아웃할까요?',
      recording: '강의를 녹음하는 중이에요. 로그아웃하면 녹음을 끝내요 (지금까지 녹음한 것은 다시 로그인하면 마저 올라가요).',
      busy: '답변을 만들거나 파일을 올리는 중이에요. 지금 로그아웃하면 이 화면에서는 결과를 볼 수 없어요.',
      confirmLabel: '로그아웃',
    },
    deleteDocConfirm: {
      title: (title: string) => `${withParticle(`‘${title}’`, '을', '를')} 삭제할까요?`,
      message: '업로드한 PDF와 여기서 만든 파일(슬라이드 이미지, 대화, 노트, 정리본)이 모두 지워지고, 과목에서도 빠져요.',
    },
    docDeleted: (title: string) => `‘${title}’을(를) 삭제했어요.`,
    noLlmForDigest: '사용할 수 있는 LLM이 없어요. 상단의 모델 선택을 확인해 주세요.',
    digestConfirm: {
      /** `who`: the LLM ("Codex · gpt-5.5 · 추론 높음"). */
      title: (count: number, who: string) => `강의 ${count}개의 정리본을 ${who}(으)로 만들까요?`,
      /** After the list of the lectures. */
      note: 'LLM이 강의마다 모든 슬라이드를 읽어서 시간이 걸리고 사용량이 들어요. 완성된 강의의 요약은 같은 과목의 뒤 강의를 공부할 때 LLM에게 함께 전달돼요.',
      confirmLabel: '정리본 만들기',
    },
    digestsStarted: (count: number) => `정리본 만들기를 시작했어요 (${count}개). 진행 상황은 강의 목록의 배지에서 볼 수 있어요.`,
    /** `lines`: one "title: reason" per line. */
    digestsFailed: (lines: string) => `정리본을 시작하지 못했어요:\n${lines}`,
    healthFailed: (error: string) => `서버 상태를 확인하지 못했어요 (${error})`,
    checkingLlms: '사용할 수 있는 LLM을 확인하는 중…',
    noLlmSeeInfo: '사용 가능한 LLM이 없어요 — 상단 ⓘ 에서 이유를 확인하세요',
    askAfterAnswer: '답변이 끝난 뒤에 질문할 수 있어요 (첨부는 지금도 돼요)',
    noLlm: '사용 가능한 LLM이 없어요',
    /** "이 부분 설명해줘" could not be sent: the region waits in the composer. */
    regionAttached: (reason: string) => `영역을 입력창에 첨부해 두었어요. ${reason}`,
    serverUnreachable: (error: string) => `서버에 연결할 수 없어요: ${error}`,
    noLlmBanner: '사용 가능한 LLM이 없어요.',
    /** "Codex: 사용 불가" when a provider gives no reason. */
    unavailable: '사용 불가',
    checkAgain: '다시 확인',
    dropPdfToCourse: (fileIcon: ReactNode, folderIcon: ReactNode, course: string) =>
      rich(fileIcon, ' PDF를 놓으면 ', folderIcon, ' ', course, '에 강의로 추가해요'),
    dropPdf: (fileIcon: ReactNode) => rich(fileIcon, ' PDF를 놓으면 업로드해요'),
    dropOnCourseCard: '과목 카드 위에 놓으면 그 과목에 추가돼요',
  },

  /** The login check, the login screen, the local-only screen (AuthGate, LoginScreen, LocalOnlyScreen). */
  auth: {
    linkAlreadyLoggedIn: '로그인 링크의 접속 코드가 맞지 않았어요. 이 브라우저는 이미 로그인되어 있어요.',
    logoutFailed: (error: string) => `로그아웃하지 못했어요: ${error}`,
    notices: {
      expired: '로그인이 만료됐어요. 다시 로그인하면 보던 화면 그대로 이어서 쓸 수 있어요.',
      logout: '로그아웃했어요.',
      linkFailed: '로그인 링크의 접속 코드가 맞지 않아요. 서버 컴퓨터에 표시된 코드를 직접 입력해 주세요.',
      linkLimited: '로그인 시도가 너무 많아서 링크로 로그인하지 못했어요. 잠시 후에 다시 시도해 주세요.',
    },
    enterCode: '접속 코드를 입력해 주세요.',
    tooManyAttempts: '로그인 시도가 너무 많아요. 잠시 후에 다시 시도해 주세요.',
    /** `wait`: formatWait ("9분 12초"). */
    tooManyAttemptsWait: (wait: string) => `로그인 시도가 너무 많아요. ${wait} 후에 다시 시도해 주세요.`,
    wrongCode: '접속 코드가 맞지 않아요. 서버 컴퓨터에 표시된 코드를 다시 확인해 주세요.',
    sub: '접속 코드를 입력하면 시작할 수 있어요.',
    codeLabel: '접속 코드',
    hide: '숨기기',
    show: '보기',
    hangulTyped: '한글이 입력됐어요. 한/영 키를 눌러 영문으로 바꾼 뒤 다시 입력해 주세요.',
    codeFormatHint: '대시(-)나 띄어쓰기는 있어도 없어도 괜찮아요. 붙여넣기도 돼요.',
    checking: '확인하는 중…',
    retryIn: (wait: string) => `${wait} 후 다시 시도`,
    login: '로그인',
    /** Where the code is shown: `server` is codeWhereServer in <strong>, then the settings icon, the command, the link. */
    codeWhere: (server: ReactNode, settingsIcon: ReactNode, command: ReactNode, link: ReactNode) =>
      rich(
        '접속 코드는 ',
        server,
        '에 표시돼요 — easy-study 앱이면 ',
        settingsIcon,
        ' 설정 › 데스크톱 앱 › 다른 기기에서 접속, 터미널이면 ',
        command,
        '의 출력. 터미널에 함께 나온 로그인 링크(',
        link,
        ')를 열어도 바로 들어올 수 있어요.',
      ),
    codeWhereServer: 'easy-study 서버를 실행한 컴퓨터',
    noCode: '코드가 보이지 않나요?',
    noCodeRestart: '서버를 다시 실행하면 같은 코드가 다시 표시돼요.',
    noCodePassword: (envVar: ReactNode) => rich(envVar, '로 비밀번호를 직접 정해 두었다면 그 비밀번호를 입력하세요.'),
    noCodeNew: (command: ReactNode) =>
      rich(
        '새 코드가 필요하면 앱에서는 ‘접속 코드 새로 만들기’, 터미널에서는 함께 나온 ‘코드를 바꾸고 모든 로그인을 끊으려면’ 명령(',
        command,
        ')으로 서버를 다시 실행하세요. 로그인해 둔 다른 기기들도 모두 로그아웃돼요.',
      ),
    insecure:
      '암호화되지 않은 연결(HTTP)이에요. 같은 네트워크의 누군가가 오가는 내용을 엿보거나 바꿀 수 있으니 같은 Wi‑Fi처럼 믿을 수 있는 네트워크에서만 사용하세요 (다른 곳에서는 Tailscale·HTTPS). 이 주소에서는 Chrome/Edge의 ‘앱 설치’도 되지 않아요 (HTTPS가 필요해요: README의 ‘앱으로 설치하기’ 참고).',
    switchServer: '다른 서버에 연결…',
    switchServerAnyway: '그래도 다른 서버에 연결',
    /** lib/auth.ts formatWait: "45초", "3분", "9분 12초", "1시간 5분". */
    wait: {
      seconds: (s: number) => `${s}초`,
      minutes: (m: number) => `${m}분`,
      minutesSeconds: (m: number, s: number) => `${m}분 ${s}초`,
      hours: (h: number) => `${h}시간`,
      hoursMinutes: (h: number, m: number) => `${h}시간 ${m}분`,
    },
    localOnly: {
      title: '이 컴퓨터에서만 열 수 있어요',
      sub: (host: ReactNode) => rich('easy-study 서버가 로컬 모드로 실행 중이라 이 주소(', host, ')로는 열 수 없어요.'),
      useApp: (settingsIcon: ReactNode) =>
        rich('서버 컴퓨터에서 easy-study 앱을 쓴다면 ', settingsIcon, ' 설정 › 데스크톱 앱 › ‘다른 기기에서 접속 허용’을 켜세요.'),
      thisComputer: (url: ReactNode) => rich('서버를 실행한 컴퓨터에서는 ', url, ' 로 열 수 있어요.'),
      remoteMode: '다른 컴퓨터에서도 쓰려면 서버를 원격 모드로 다시 실행하세요. 터미널에 접속 주소와 접속 코드가 표시돼요.',
      proxy: (serve: ReactNode, env: ReactNode) => rich(serve, ' 같은 프록시를 거친다면 ', env, ' 을 붙여 실행하세요.'),
      serverSaid: (message: string) => `서버 응답: ${message}`,
      checkAgain: '다시 확인',
    },
  },

  /** The LLM pickers: the top bar's LLM for new sessions, ProviderPicker, the LLM switch of a session. */
  llm: {
    checking: 'LLM 확인 중…',
    noInfo: 'LLM 정보 없음',
    noneAvailable: '사용 가능한 LLM 없음',
    newSessionLlm: '새 세션에 쓸 LLM',
    /** `full`: "Codex · gpt-5.5 · 추론 높음". */
    newSessionLlmIs: (full: string) => `새 세션에 쓸 LLM: ${full}`,
    noLlm: 'LLM 없음',
    popHint: '지금 세션의 LLM은 채팅 위의 LLM 이름을 눌러 바꿔요.',
    /** "Codex: 사용 불가" in the tooltip of unavailable providers (when they give no reason). */
    unavailable: '사용 불가',
    choose: 'LLM 선택',
    version: (version: string) => `버전 ${version}`,
    unavailableSuffix: ' — 사용 불가',
    chooseModel: '모델 선택',
    customModel: '직접 입력…',
    modelName: '모델 이름',
    modelNameInput: '모델 이름 직접 입력',
    effort: '추론 수준',
    effortNotSupported: '이 모델은 추론 수준을 고를 수 없어요',
    effortDefaultHint: '추론 수준: 기본값은 CLI 설정(또는 모델 기본값)을 따라요',
    effortDefault: '추론 기본값',
    /** `label`: the level's name from the server ("높음"). */
    effortOption: (label: string) => `추론 ${label}`,
    /** `names`: the unavailable providers, comma-separated. */
    unavailableList: (names: string) => `사용할 수 없음: ${names}`,
    unavailableLabel: (details: string) => `사용 불가 LLM: ${details}`,
    switchTitle: '이 세션의 LLM 바꾸기',
    switchCurrent: (name: string) => `지금: ${name}`,
    switchNote:
      '다음 질문부터 새 LLM이 답해요. 슬라이드와 최근 대화 요약을 다시 보내서 처음 질문은 토큰이 더 들어요. 지금까지의 대화는 그대로 남아요.',
    switching: '바꾸는 중…',
    switchApply: 'LLM 바꾸기',
  },

  /** The desktop app's update banner (UpdateBanner.tsx). */
  update: {
    installConfirm: {
      title: '업데이트하고 다시 시작할까요?',
      confirmLabel: '설치하고 다시 시작',
    },
    downloadLabel: '새 버전 내려받기',
    later: '나중에',
    available: (version: string) => `easy-study ${version} 버전이 나왔어요.`,
    openDownloadPage: '다운로드 페이지 열기',
    releaseNotes: '변경 사항',
    installAndRestart: '업데이트하고 다시 시작',
    downloading: '새 버전을 내려받는 중…',
    downloaded: '새 버전을 받아 두었어요. 녹음이 끝나면 다시 시작해서 설치할 수 있어요.',
    restartNow: '지금 다시 시작해서 설치',
    installing: (version: string) => `easy-study ${version} 버전을 설치하는 중… 끝나면 앱이 다시 시작돼요.`,
  },

  splitPane: {
    label: '패널 크기 조절',
    title: '드래그해서 크기 조절 · 더블클릭하면 기본값',
  },

  /** The library (LibraryView.tsx and organize/parts.tsx). */
  library: {
    dropzoneTitle: 'PDF를 끌어다 놓거나 클릭해서 업로드',
    /** `course`: the course (bold, with its folder icon). */
    dropzoneToCourse: (course: ReactNode) => rich(course, ' 과목에 강의로 추가돼요'),
    dropzoneSub: '슬라이드를 이미지로 변환해 두고, 질문할 때 LLM이 그림·도표까지 볼 수 있게 해요',
    uploadTarget: '업로드할 곳',
    uncategorized: '미분류',
    docsLoadFailed: (error: string) => `문서 목록을 불러오지 못했어요: ${error}`,
    courses: '과목',
    dragTip: (grip: ReactNode) => rich(grip, ' 를 끌어서 순서·위치를 바꿔요'),
    saving: '저장 중…',
    collapseAll: '모두 접기',
    expandAll: '모두 펼치기',
    newGroupTitle: '과목을 묶는 그룹 (예: 학기)',
    newGroup: '＋ 새 그룹',
    newCourse: '＋ 새 과목',
    coursesLoadFailed: (error: string) => `과목 목록을 불러오지 못했어요: ${error}`,
    layoutLoadFailed: (error: string) => `과목 배치(그룹·순서)를 불러오지 못해서 과목을 만든 순서대로 보여 줘요: ${error}`,
    groupPlaceholder: '그룹 이름 (예: 2026-2학기)',
    newGroupName: '새 그룹 이름',
    coursePlaceholder: '과목 이름 (예: Compiler)',
    newCourseName: '새 과목 이름',
    courseHint:
      '강의를 과목으로 묶어 두면 LLM이 이전 강의들을 알고 설명해요. 예: ‘Compiler’ 과목에 Lecture 1, 2, 3 … 을 순서대로 넣어 두면, Lecture 8을 공부할 때 1–7강 중 정리본이 있는 강의의 요약을 함께 받고, Claude Code·Codex는 필요하면 그 강의 파일도 열어 봐요. 과목이 많아지면 ‘새 그룹’으로 학기별로 묶을 수 있어요.',
    noDocsYet: '아직 문서가 없어요. 강의 자료 PDF를 올려 보세요.',
    storedAt: (dir: ReactNode) => rich('저장 위치: ', dir),
    uncategorizedLabel: '미분류 문서',
    myDocs: '내 문서',
    dropToUncategorize: '여기에 놓으면 과목에서 빠져요',
    uncategorizedTip: (grip: ReactNode) => rich('과목에 넣으려면 ', grip, ' 를 끌어다 과목에 놓거나 ‘과목으로 이동’을 고르세요'),
    processing: '슬라이드 이미지·텍스트·개요 이미지를 만드는 중이에요. 끝나면 자동으로 열려요.',
    processingError: '처리 중 오류가 발생했어요',
    failedHelp:
      '업로드한 PDF는 남아 있어요. 일시적인 문제였다면 다시 변환해 보세요. 암호가 걸렸거나 손상된 PDF라면 암호를 풀거나 다시 내보낸 PDF를 새로 올려 주세요.',
    convertAgain: '다시 변환',
    convertAgainTitle: '업로드한 PDF로 변환을 다시 해요',
    deleteDocTitle: '이 문서를 삭제해요',
    backToLibrary: '라이브러리',
    slideCount: (n: number) => `${n}장`,
    uploading: (percent: number, size: string) => `업로드 중 ${percent}% · ${size}`,
    /** DragHandle's tooltip after its label. */
    dragHandleTitle: (label: string) => `${label} — 끌어서 옮기기 (터치: 길게 누른 채 끌기, 키보드: 스페이스 후 화살표)`,
    digestBadge: {
      ready: '정리본',
      running: '정리 중',
      partial: '정리본 일부',
      partialTitle: '정리본을 만들다 멈췄어요 — 정리본 탭에서 이어서 만들 수 있어요',
    },
    /** A collapsed course's badges. */
    summary: {
      digestsTitle: (ready: number, total: number) => `정리본이 있는 강의 ${ready}개 / 전체 ${total}개`,
      digests: (ready: number, total: number) => `정리본 ${ready}/${total}`,
      running: (n: number) => `정리 중 ${n}`,
      converting: (n: number) => `변환 중 ${n}`,
      failed: (n: number) => `실패 ${n}`,
      uploading: (n: number) => `업로드 중 ${n}`,
    },
    convertingSlides: (done: number, total: number) => `슬라이드 변환 중 ${done} / ${total}`,
    analyzingPdf: 'PDF 분석 중…',
    create: '만들기',
  },

  /** A course card (organize/CourseCard.tsx). */
  course: {
    roleDescription: '옮길 수 있는 과목',
    deleteConfirm: {
      title: (title: string) => `과목 ${withParticle(`‘${title}’`, '을', '를')} 삭제할까요?`,
      lecturesKept: (n: number) => `강의 ${n}개는 지워지지 않고 ‘미분류’로 옮겨져요.`,
      empty: '비어 있는 과목이에요.',
      confirmLabel: '과목 삭제',
    },
    label: (title: string) => `과목 ${title}`,
    move: (title: string) => `‘${title}’ 과목 옮기기`,
    nameLabel: '과목 이름',
    rename: '과목 이름 바꾸기',
    renameLabel: (title: string) => `‘${title}’ 과목 이름 바꾸기`,
    lectureCount: (n: number) => `강의 ${n}개`,
    dropAtEnd: '놓으면 이 과목 끝에 추가',
    makeDigestsTitle:
      '정리본이 있는 강의만 요약이 다음 강의를 공부할 때 LLM에게 전달돼요 — 없는 강의의 정리본을 한 번에 만들어요',
    noLlm: '사용할 수 있는 LLM이 없어요',
    /** `wide`: makeDigestsWide in a span hidden on narrow screens. */
    makeDigests: (wide: ReactNode, n: number) => rich('정리본 ', wide, `${n}개 만들기`),
    makeDigestsWide: '없는 강의 ',
    summaryTitle: '과목 정리 파일(COURSE.md) 열기 — 강의별 요약과 정리본 링크',
    addLectureTitle: '이 과목에 강의 PDF 추가',
    addLecture: '＋ 강의 추가',
    deleteTitle: '과목 삭제 (강의는 남아요)',
    deleteLabel: (title: string) => `‘${title}’ 과목 삭제`,
    dropToJoin: '여기에 놓으면 이 과목의 강의가 돼요',
    empty: '아직 강의가 없어요 — PDF를 이 카드에 끌어다 놓거나 클릭해서 추가하세요',
    dropPdf: (title: string) => `놓으면 ‘${title}’에 강의로 추가해요`,
  },

  /** A group card (organize/GroupCard.tsx). */
  group: {
    roleDescription: '옮길 수 있는 그룹',
    deleteConfirm: {
      title: (title: string) => `그룹 ${withParticle(`‘${title}’`, '을', '를')} 삭제할까요?`,
      coursesKept: (n: number) => `안에 있는 과목 ${n}개와 강의는 지워지지 않고, 그룹이 있던 자리에 그대로 남아요.`,
      empty: '비어 있는 그룹이에요.',
      confirmLabel: '그룹 삭제',
    },
    label: (title: string) => `그룹 ${title}`,
    move: (title: string) => `‘${title}’ 그룹 옮기기`,
    nameLabel: '그룹 이름',
    rename: '그룹 이름 바꾸기',
    renameLabel: (title: string) => `‘${title}’ 그룹 이름 바꾸기`,
    courseCount: (n: number) => `과목 ${n}개`,
    opensSoon: '잠시 기다리면 열려요',
    dropAtEnd: '놓으면 이 그룹 끝에 추가',
    newCourseTitle: '이 그룹 안에 새 과목 만들기',
    newCourse: '＋ 과목',
    deleteTitle: '그룹 삭제 (과목과 강의는 남아요)',
    deleteLabel: (title: string) => `‘${title}’ 그룹 삭제`,
    newCourseName: (title: string) => `‘${title}’ 그룹에 만들 과목 이름`,
    dropToJoin: '여기에 놓으면 이 그룹에 들어가요',
    empty: (grip: ReactNode) => rich('비어 있는 그룹이에요 — 과목의 ', grip, ' 손잡이를 끌어다 놓거나 ‘＋ 과목’으로 만드세요'),
  },

  /** A lecture in a course (organize/LectureRow.tsx) or uncategorized (organize/DocCard.tsx). */
  lecture: {
    roleDescription: '옮길 수 있는 강의',
    uploadRecording: '녹음 파일 올리기',
    uploadRecordingHint: '음성·동영상',
    removeFromCourse: '과목에서 빼기',
    removeFromCourseHint: '미분류로',
    moveToCourse: '과목으로 이동',
    move: (title: string) => `‘${title}’ 강의 옮기기`,
    moveToACourse: (title: string) => `‘${title}’ 강의를 과목으로 옮기기`,
    moveSelect: (title: string) => `${title}을(를) 과목으로 이동`,
    moveSelectPlaceholder: '과목으로 이동…',
    nameLabel: '강의 이름',
    renameKeys: 'Enter로 저장 · Esc로 취소',
    open: '이 강의 열기',
    failed: '처리 실패',
    converting: '변환 중',
    menu: (title: string) => `‘${title}’ 강의 메뉴`,
  },

  /** Drag & drop in the library: names, places and screen-reader announcements (LibraryDnd.tsx, lib/libraryDnd.ts). */
  dnd: {
    /** An item's name in the announcements; the fallbacks stand in for a title that is gone. */
    lectureName: (title: string) => `‘${title}’ 강의`,
    courseName: (title: string) => `‘${title}’ 과목`,
    groupName: (title: string) => `‘${title}’ 그룹`,
    lectureFallback: '강의',
    courseFallback: '과목',
    groupFallback: '그룹',
    opened: (name: string) => `${withParticle(name, '을', '를')} 열었어요.`,
    openedPlain: '열었어요.',
    pickedUp: (name: string) => `${withParticle(name, '을', '를')} 집었어요. 위아래 화살표로 옮기고 스페이스나 엔터로 놓으세요.`,
    cancelled: (name: string) => `옮기기를 취소했어요. ${withParticle(name, '은', '는')} 원래 자리에 있어요.`,
    cancelledPlain: '옮기기를 취소했어요.',
    instructions:
      '끌어서 옮길 수 있어요. 스페이스나 엔터로 집고, 위아래 화살표로 옮긴 뒤 스페이스나 엔터로 놓으세요. Esc를 누르면 취소돼요. 터치 화면에서는 손잡이를 길게 누른 채 끌어요.',
    /** `place`: one of `place` below; `total`: the items of that list (null: not counted). */
    moved: (name: string, place: string, total: number | null) =>
      `${withParticle(name, '을', '를')} ${place}로 옮겼어요` + (total === null ? '.' : ` (${total}개 중).`),
    droppedBack: (name: string) => `${withParticle(name, '을', '를')} 원래 자리에 놓았어요.`,
    toBottom: '맨 아래로 옮기기',
    toBottomOutsideGroups: '그룹 밖 맨 아래로 옮기기',
    /** Where a drop puts the item. Every Korean place ends in a vowel ("…로 옮겼어요"). */
    place: {
      overCollapsedGroup: (title: string) => `접힌 ‘${title}’ 그룹 위 — 잠시 기다리면 열려요`,
      groupFallback: '그룹',
      original: '원래 자리',
      uncategorized: '미분류',
      course: '과목',
      inCourse: (title: string, position: number) => `‘${title}’ 과목의 ${position}번째 자리`,
      group: '그룹',
      inGroup: (title: string, position: number) => `‘${title}’ 그룹의 ${position}번째 자리`,
      outsideGroups: (position: number) => `그룹 밖 목록의 ${position}번째 자리`,
      topLevel: (position: number) => `전체 목록의 ${position}번째 자리`,
      /** "‘Compiler’ 과목의 3번째 자리 (5개 중)". */
      withTotal: (place: string, total: number) => `${place} (${total}개 중)`,
    },
  },

  /** Saving the library's organization (lib/organizer.ts). */
  organizer: {
    conflict: '다른 탭이나 기기에서 먼저 바뀌었어요. 새로 불러왔으니 다시 해 주세요',
    failed: {
      uncategorizeLecture: '강의를 과목에서 빼지 못해 원래대로 되돌렸어요',
      moveLecture: '강의를 옮기지 못해 원래대로 되돌렸어요',
      moveCourse: '과목을 옮기지 못해 원래대로 되돌렸어요',
      moveGroup: '그룹을 옮기지 못해 원래대로 되돌렸어요',
      renameCourse: '과목 이름을 바꾸지 못했어요',
      renameGroup: '그룹 이름을 바꾸지 못했어요',
      deleteCourse: '과목을 삭제하지 못했어요',
      deleteGroup: '그룹을 삭제하지 못했어요',
      createCourse: '과목을 만들지 못했어요',
      createGroup: '그룹을 만들지 못했어요',
      refresh: '과목 목록을 불러오지 못했어요',
    },
    gone: {
      targetCourse: '옮길 과목이 다른 곳에서 삭제됐어요',
      course: '이 과목은 다른 곳에서 삭제됐어요',
      targetGroup: '옮길 그룹이 다른 곳에서 삭제됐어요',
      group: '이 그룹은 다른 곳에서 삭제됐어요',
    },
  },
};
