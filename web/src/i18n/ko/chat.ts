// Korean (the reference language) — namespace `chat`: the chat panel (messages, composer, attachments, context chips), notes, the memo list, the digest panel, Markdown.
import type { ReactNode } from 'react';
import { rich } from '../rich.ts';

export const chat = {
  /** Words several chat panels use. */
  shared: {
    currentSlideOnly: '현재 슬라이드만',
    refresh: '새로고침',
    goToThisSlide: '이 슬라이드로 이동',
    goToSlide: (n: number) => `슬라이드 ${n}로 이동`,
    copyFailed: '복사하지 못했어요',
    pathCopied: '경로를 복사했어요',
    pathCopiedRemote: '서버 컴퓨터의 경로를 복사했어요',
    /** Tooltip of a notes / digest file path (click copies it). */
    pathTitle: '클릭해서 경로 복사',
    pathTitleRemote: '서버 컴퓨터의 경로예요. 클릭해서 복사',
    noLlm: '사용 가능한 LLM이 없어요',
    noLlmSentence: '사용 가능한 LLM이 없어요.',
    /** Toast when a session or a digest needs a provider and none is chosen. */
    noLlmToast: '사용할 수 있는 LLM이 없어요. 상단의 모델 선택을 확인해 주세요.',
    stop: '중지',
    /** An answer that failed, with the reason when there is one. */
    answerFailed: (error: string) => (error ? `답변 실패: ${error}` : '답변 실패'),
    answerAborted: '중단된 답변이에요',
    answerUnfinished: '답변이 아직 완료되지 않았어요',
  },

  /** lib/format.ts: the LLM of a session or an answer, and its change. */
  llm: {
    /** Names of the reasoning-effort levels (an unknown level is shown by its id). */
    effortNames: {
      none: '없음',
      minimal: '최소',
      low: '낮음',
      medium: '보통',
      high: '높음',
      xhigh: '매우 높음',
      max: '최대',
      ultra: '울트라',
    } as Readonly<Record<string, string>>,
    /** "추론 높음" after the model: "Claude Code · sonnet · 추론 높음". */
    reasoning: (effort: string) => `추론 ${effort}`,
    /** The marker where the session's LLM changed: "여기부터 Codex · gpt-5.5 · 추론 높음". */
    switchMarker: (name: string) => `여기부터 ${name}`,
    switchMarkerTitle: (time: string, from: string, to: string) =>
      `${time}에 LLM을 바꿨어요: ${from} → ${to}. 새 LLM은 슬라이드와 최근 대화 요약을 다시 받고 이어서 답해요.`,
    /** The notice in the chat after its LLM was changed. */
    switchNotice: (name: string) =>
      `다음 질문부터 ${name}(으)로 답해요. 슬라이드와 최근 대화 요약을 다시 보내서 처음 질문은 토큰이 더 들어요.`,
  },

  /** lib/format.ts describeContext: the chips of what was sent to the LLM with a question. */
  context: {
    resumeInvalid: '이전 대화를 잃어 새 대화로 다시 전달',
    resumeInvalidTitle:
      'LLM 쪽 이전 대화를 이어갈 수 없어서(만료·삭제 등) 새 대화를 시작하고, 슬라이드와 최근 대화 요약을 다시 전달한 뒤 답했어요.',
    contextOverflow: '대화가 길어져 새 대화로 전달',
    contextOverflowTitle: 'LLM 대화가 너무 길어져서 새 대화를 시작하고, 슬라이드와 최근 대화 요약을 다시 전달한 뒤 답했어요.',
    switched: '바꾼 LLM으로 새 대화 시작',
    switchedTitle: 'LLM을 바꿔서 새 대화를 시작하고, 슬라이드와 최근 대화 요약을 다시 전달한 뒤 답했어요.',
    rollover: '새 대화로 이어감',
    /** ContextInfo.deckUpdated (DESIGN §28). */
    deckUpdated: '새 버전 슬라이드로 다시 시작',
    deckUpdatedTitle: '강의 PDF가 새 버전으로 바뀌어서 새 대화를 시작하고, 새 슬라이드와 최근 대화 요약을 다시 전달한 뒤 답했어요.',
    primed: '전체 슬라이드 전달',
    overviewImages: (n: number) => `개요 이미지 ${n}장`,
    /** `pages` = "p.12·13". */
    attached: (pages: string) => `${pages} 첨부`,
    reused: (pages: string) => `${pages} 이미 전달됨`,
    attachments: (n: number) => `첨부 ${n}개`,
    attachmentsTitle: '질문과 함께 보낸 선택 영역·이미지 (선택 영역은 그 안의 텍스트도 함께 전달돼요)',
    memos: (n: number) => `메모 ${n}개`,
    memosTitle: '이 슬라이드와 앞뒤 슬라이드에 쓴 메모를 튜터에게 함께 전달했어요',
  },

  /** lib/format.ts primeCardState: the title of the card that feeds the whole deck. */
  primeCard: {
    sending: (n: number) => `전체 슬라이드 ${n}장을 LLM에게 전달하는 중…`,
    sent: (n: number) => `전체 슬라이드 ${n}장을 LLM에게 전달했어요`,
    failed: (n: number) => `전체 슬라이드 ${n}장을 LLM에게 전달하지 못했어요`,
    aborted: (n: number) => `전체 슬라이드 ${n}장 전달이 중단됐어요`,
    unknown: (n: number) => `전체 슬라이드 ${n}장 전달 (결과를 알 수 없어요)`,
  },

  /** lib/courseContext.ts: what the LLM gets about the earlier lectures of a course. */
  course: {
    /** Appended when the provider can open files. */
    opensFiles: ' 필요하면 이전 강의 파일(정리본·슬라이드)도 열어 봐요.',
    first: (course: string, index: number) => `${course}의 ${index}강이에요.`,
    allSummaries: (course: string, index: number, total: number) =>
      `${course}의 ${index}강이라서 이전 강의 ${total}개의 요약도 함께 전달해요.`,
    /** `running` = earlier lectures whose digest is being made. */
    noSummaries: (course: string, index: number, total: number, running: number) =>
      `${course}의 ${index}강 — 이전 강의 ${total}개 중 요약이 있는 강의가 아직 없어서 제목만 전달해요${running > 0 ? ` (${running}개는 정리본을 만드는 중)` : ''}.`,
    someSummaries: (course: string, index: number, total: number, withSummary: number, running: number) =>
      `${course}의 ${index}강 — 이전 강의 ${total}개 중 요약이 있는 ${withSummary}개만 요약을 전달하고, 나머지는 제목만 전달해요${running > 0 ? ` (${running}개는 정리본을 만드는 중)` : ''}.`,
    /** Appended to noSummaries / someSummaries. */
    summariesLater: ' 강의 요약은 그 강의의 정리본이 완성되면 생겨요.',
    /** Tooltip of the course badge in the chat header. */
    badgeTitle: (course: string, index: number) => `과목 ‘${course}’의 ${index}번째 강의 (클릭하면 COURSE.md)`,
    badgeTitleSummaries: (course: string, index: number, total: number, withSummary: number) =>
      `과목 ‘${course}’의 ${index}번째 강의 — 이전 강의 ${total}개 중 요약(정리본)이 있는 ${withSummary}개의 요약을 LLM에게 함께 전달해요 (클릭하면 COURSE.md)`,
    /** The badge after the course title: "· 3/12강". */
    badge: (index: number, total: number) => `${index}/${total}강`,
  },

  /** ChatPanel.tsx */
  panel: {
    tabs: {
      chat: '채팅',
      digest: '정리본',
      notes: '노트',
      memos: '메모',
      memosTitle: '슬라이드에 붙인 메모',
      recordings: '녹음',
      recordingsTitle: '강의 녹음과 받아쓴 글',
      digestDone: '완성',
      digestPartial: '일부',
    },
    creating: '새 세션을 만드는 중…',
    emptyTitle: '무엇이든 물어보세요',
    /** The LLM named in emptyIntro when none is chosen. */
    llmFallback: 'LLM',
    /** The bold deck in emptyIntro. */
    deck: (n: number) => `전체 슬라이드 ${n}장`,
    emptyIntro: (llm: ReactNode, deck: ReactNode, digestReady: boolean, neighbors: number) =>
      rich(
        '질문을 보내면 ',
        llm,
        '(으)로 새 세션을 만들고, ',
        deck,
        digestReady ? '(정리본 텍스트)' : '',
        '을 먼저 전달한 뒤 지금 보고 있는 슬라이드',
        neighbors > 0 ? `(앞뒤 ${neighbors}장 포함)` : '',
        '를 기준으로 설명해요.',
      ),
    digestEarlier: (n: number) => `이전 강의 ${n}개 정리본 만들기`,
    startSession: '＋ 새 세션 시작 (슬라이드 전달)',
    tipKeys: (j: ReactNode, k: ReactNode, up: ReactNode, down: ReactNode, slash: ReactNode) =>
      rich(j, '/', k, ' 또는 ', up, '/', down, ' 로 슬라이드 이동, ', slash, ' 로 입력창 포커스'),
    tipPin: '고정하면 스크롤해도 같은 슬라이드에 대해 계속 질문해요',
    tipNotes: '모든 Q&A는 파일로 저장되고 ‘노트’ 탭에서 슬라이드별로 다시 볼 수 있어요',
    tipDigest: '‘정리본’ 탭에서 LLM이 슬라이드를 옮겨 적고 설명한 정리본을 슬라이드별로 읽을 수 있어요',
    loadingSession: '세션을 불러오는 중…',
    notPrimed: '이 세션은 아직 슬라이드를 전달받지 않았어요.',
    primeAll: '전체 슬라이드 전달하기',
    primeLater: '바로 질문해도 괜찮아요 — 첫 질문과 함께 전달돼요.',
    typeQuestion: '질문을 입력해 보세요.',
    viewedSlide: '보고 있는 슬라이드',
    unpinTitle: '고정 해제 — 다시 보고 있는 슬라이드에 대해 질문해요',
    pinTitle: '지금 슬라이드를 고정 — 스크롤해도 이 슬라이드에 대해 질문해요',
    pinned: (slide: number) => `p.${slide} 고정됨`,
    pin: '고정',
    neighborsTitle: '질문할 때 지금 슬라이드와 함께 앞뒤 슬라이드도 LLM에게 전달해요 (슬라이드 내용이 여러 장에 이어질 때 유용해요)',
    neighbors: '앞뒤',
    neighborsLabel: '함께 전달할 앞뒤 슬라이드 수',
    /** `llm` = "Codex (gpt-5.5, 추론 높음)". */
    switchLabel: (llm: string) => `LLM 바꾸기 (지금: ${llm})`,
    switchTitle: (llm: string) => `이 세션의 LLM: ${llm} — 클릭하면 다른 LLM으로 바꿀 수 있어요`,
    switchTitleRunning: (llm: string) => `이 세션의 LLM: ${llm} — 답변이 끝난 뒤에 바꿀 수 있어요`,
    closeNotice: '알림 닫기',
  },

  /** MessageList.tsx */
  messages: {
    showOlder: (n: number) => `이전 메시지 ${n}개 보기`,
    showAll: (n: number) => `모두 보기 (${n}개)`,
    latest: '최신 메시지',
    contextTitle: '이 질문과 함께 LLM에게 전달된 내용',
    sending: '보내는 중…',
    copied: '답변을 복사했어요',
    overview: '슬라이드 개요',
    tutor: '튜터',
    copyTitle: 'Markdown 복사',
    requesting: '요청을 보내는 중…',
    readingSlides: '슬라이드를 읽는 중…',
    thinking: '생각하는 중…',
    stopping: '중지하는 중…',
    unfinishedElsewhere: '답변이 아직 완료되지 않았어요 (다른 창에서 진행 중이거나 중단됨)',
    retryWithAttachments: (n: number) => `첨부 ${n}개와 함께 다시 보내요`,
    retry: '다시 질문하기',
    retryPrimeTitle: '슬라이드를 LLM에게 다시 전달해요 (바로 질문해도 첫 질문과 함께 전달돼요)',
    retryPrime: '다시 전달하기',
  },

  /** Composer.tsx */
  composer: {
    /** The quick questions above the input (sent as they are). */
    quickPrompts: ['이 슬라이드 설명해줘', '핵심만 요약', '예시로 설명', '시험 문제 내줘'],
    quickPromptsLabel: '빠른 질문',
    memosIncluded: (n: number) => `메모 ${n}개 포함`,
    memosIncludedTitle: '이 슬라이드와 앞뒤 슬라이드의 메모를 튜터에게 함께 보내요 (설정 › 공부에서 끌 수 있어요)',
    stillUploading: '첨부한 이미지를 올리는 중이에요. 끝나면 보내 주세요.',
    /** Appended to the target chip's tooltip. */
    withNeighbors: (from: number, to: number) => ` (p.${from}–${to}도 함께 전달)`,
    placeholderRunning: '답변을 기다리는 중… (다음 질문을 미리 써 둘 수 있어요)',
    /** `question` = what an empty send asks (defaultQuestion). */
    placeholderAttachments: (n: number, question: string) => `첨부 ${n}개 · 비워 두면 “${question}”`,
    placeholderTouch: (slide: number) => `p.${slide}에 대해 질문하세요`,
    placeholder: (slide: number) => `p.${slide}에 대해 질문하세요 · Enter 전송 · Shift+Enter 줄바꿈`,
    sendWithAttachments: (n: number) => `첨부 ${n}개와 함께 보내요`,
    attachLabel: '이미지 첨부',
    attachTitle: '이미지 첨부 — 붙여넣기(⌘/Ctrl+V)나 끌어다 놓기도 돼요. 슬라이드에서 끌면 그 영역을 첨부해요',
    targetPinned: '고정된 슬라이드에 대해 질문해요 (클릭하면 이동)',
    targetFocused: '보고 있는 슬라이드에 대해 질문해요',
    inputLabel: '질문 입력',
    stopTitle: '답변 중지',
    uploadingTitle: '첨부한 이미지를 올리는 중…',
    sendTitle: '전송 (Enter)',
    attaching: '첨부 중…',
    send: '전송',
  },

  /** lib/attachments.ts, Attachments.tsx and hooks/useAttachments.ts: selected regions and images. */
  attachments: {
    /** An image dropped where no lecture is open. */
    imageNeedsLecture: '이미지는 강의를 연 뒤 놓으면 질문에 첨부돼요',
    dropRefused: (formats: string, names: string) => `PDF(강의 추가)나 이미지(${formats}, 질문에 첨부)만 놓을 수 있어요: ${names}`,
    pdfOnly: (names: string) => `PDF 파일만 올릴 수 있어요: ${names}`,
    dropImage: '이미지를 놓으면 질문에 첨부해요',
    dropImageWithPdf: '이미지를 놓으면 질문에 첨부해요 (PDF는 강의 목록에 추가만 해요)',
    dropMaybeImage: '이미지는 질문에 첨부돼요',
    /** What a region made from an annotation is called in its chip: "p.12 메모". */
    kinds: {
      memo: '메모',
      highlight: '형광',
      textHighlight: '형광',
      text: '텍스트',
      rect: '사각형',
      ellipse: '동그라미',
    },
    /** …and in the longer description; `where` = onSlide(n) or someSlide. */
    kindTitles: {
      memo: (where: string) => `${where}에 붙인 메모`,
      highlight: (where: string) => `${where}에 형광펜으로 칠한 부분`,
      textHighlight: (where: string) => `${where}에 형광펜으로 칠한 글`,
      text: (where: string) => `${where}에 쓴 텍스트 상자`,
      rect: (where: string) => `${where}에 사각형으로 표시한 부분`,
      ellipse: (where: string) => `${where}에 동그라미로 표시한 부분`,
    },
    onSlide: (n: number) => `슬라이드 ${n}`,
    someSlide: '슬라이드',
    regionTitle: (where: string) => `${where}에서 선택한 영역`,
    /** "p.12 영역" (`what` = region or a kind). */
    onPage: (slide: number, what: string) => `p.${slide} ${what}`,
    /** A region whose slide a new version dropped (Attachment.removedFrom, DESIGN §28): "p.12 영역 (빠진 장 p.15)". */
    onRemovedPage: (slide: number, what: string, old: number) => `p.${slide} ${what} (빠진 장 p.${old})`,
    region: '영역',
    selectedRegion: '선택 영역',
    image: '이미지',
    pastedImage: '붙여넣은 이미지',
    imageTitle: '첨부한 이미지',
    imageTitleNamed: (name: string) => `첨부한 이미지: ${name}`,
    /** The question sent with only attachments (and the region menu's "이 부분 설명해줘"). */
    explainRegion: '이 부분 설명해줘',
    explainImage: '첨부한 이미지 설명해줘',
    limit: (max: number, refused: number) =>
      `한 질문에 최대 ${max}개까지 첨부할 수 있어요${refused > 0 ? ` (${refused}개는 첨부하지 않았어요)` : ''}`,
    tooLarge: (mb: number) => `이미지가 너무 커요 (최대 ${mb} MB)`,
    tooLargeFile: (mb: number, name: string, size: string) => `이미지가 너무 커요 (최대 ${mb} MB): ${name} (${size})`,
    unsupported: (formats: string) => `지원하지 않는 이미지 형식이에요 (${formats})`,
    onlyImages: (formats: string, names: string) => `${formats} 이미지만 첨부할 수 있어요: ${names}`,
    docNotReady: '문서가 아직 준비되지 않았어요',
    docNotFound: '문서를 찾을 수 없어요',
    missing: (labels: string) =>
      `첨부(${labels})를 서버에서 찾을 수 없어서 질문을 보내지 않았어요. 질문에 쓰지 않은 첨부는 24시간 뒤에 지워져요 — 그 첨부 없이 다시 보내 주세요.`,
    missingCount: (n: number) =>
      `첨부(${n}개)를 서버에서 찾을 수 없어서 질문을 보내지 않았어요. 질문에 쓰지 않은 첨부는 24시간 뒤에 지워져요 — 그 첨부 없이 다시 보내 주세요.`,
    attachFailed: (label: string, message: string) => `첨부하지 못했어요 (${label}): ${message}`,
    regionFailed: (message: string) => `영역을 첨부하지 못했어요: ${message}`,
    annotationFailed: (message: string) => `필기를 첨부하지 못했어요: ${message}`,
    alreadyAttached: '이미 입력창에 첨부되어 있어요',
    someAlreadyAttached: (n: number) => `${n}개는 이미 첨부되어 있어요`,
    imageLoadFailed: '이미지를 불러오지 못했어요',
    openRegionTitle: (title: string) => `${title} — 클릭하면 크게 보고 슬라이드에서 위치를 보여줘요`,
    openImageTitle: (title: string) => `${title} — 클릭하면 크게 봐요`,
    chipsLabel: '질문에 첨부할 항목',
    cropping: '영역을 잘라내는 중…',
    uploading: (percent: number) => `올리는 중… ${percent}%`,
    removeLabel: (label: string) => `${label} 첨부 빼기`,
    removeTitle: '첨부 빼기',
    showOnSlide: (slide: number) => `p.${slide}에서 보기`,
    closeTitle: '닫기 (Esc)',
    regionText: (empty: boolean) => `선택 영역의 텍스트${empty ? ' (없음)' : ''}`,
    noPdfText: '이 영역에는 PDF 텍스트가 없어요. LLM은 이미지로 읽어요.',
  },

  /** lib/usage.ts: tokens and subscription limits (counts come formatted: format.tokens / format.count). */
  usage: {
    line: (input: string, cached: string | null, output: string) =>
      `입력 ${input}${cached ? ` (캐시 ${cached})` : ''} · 출력 ${output}`,
    answerHeading: '이 답변에 쓴 토큰',
    input: (n: string) => `입력 ${n}`,
    cacheRead: (n: string) => `  캐시에서 읽음 ${n}`,
    cacheWrite: (n: string) => `  캐시에 저장 ${n}`,
    output: (n: string) => `출력 ${n}`,
    reasoning: (n: string) => `  추론 ${n}`,
    total: (n: string) => `합계 ${n}`,
    sessionHeading: '이 세션에서 쓴 토큰 (슬라이드 전달, 실패·중단된 답변 포함)',
    sessionPriming: (n: string) => `그중 슬라이드 전달 ${n}`,
    unrecorded: (n: number) => `토큰이 기록되지 않은 답변 ${n}개는 빠져 있어요 (기록 전에 만든 답변 등)`,
    session: (n: string) => `이 세션 ${n} 토큰`,
    /** Names of a limit window: "5시간", "주간", "3일", "90분"; with a model family "주간(Opus)". */
    weekly: '주간',
    days: (n: number) => `${n}일`,
    hours: (n: number) => `${n}시간`,
    minutes: (n: number) => `${n}분`,
    windowOf: (name: string, label: string) => `${name}(${label})`,
    reached: '사용 한도 도달',
    near: '사용 한도 임박',
    /** "5시간 한도 12%" (the first item names the limit), "주간 9%", "… (14:30 초기화)". */
    limit: (name: string, first: boolean, percent: number, resets: string | null) =>
      `${name}${first ? ' 한도' : ''} ${percent}%${resets ? ` (${resets} 초기화)` : ''}`,
    asOf: (time: string) => `${time} 기준`,
    limitsHeading: (provider: string, time: string) => `${provider} 사용 한도 (${time} 기준)`,
    windowLine: (name: string, percent: number, resets: string | null) =>
      `${name}: ${percent}% 사용${resets ? ` · ${resets}에 초기화` : ''}`,
    reachedNote: '한도에 도달했어요. 초기화될 때까지 답변을 받지 못할 수 있어요.',
    nearNote: '한도에 가까워졌어요.',
  },

  /** NotesPanel.tsx */
  notes: {
    clearFilter: '필터 해제',
    onlySlide: (slide: number) => `p.${slide}만 보는 중`,
    collapseAll: '모두 접기',
    expandAll: '모두 펼치기',
    openFile: 'STUDY_NOTES.md 열기',
    loadFailed: (error: string) => `노트를 불러오지 못했어요: ${error}`,
    empty: '아직 저장된 Q&A가 없어요.',
    emptyHint: '채팅에서 질문하면 슬라이드별로 자동으로 기록돼요.',
    noneForSlide: (slide: number) => `p.${slide}에 대한 Q&A가 아직 없어요.`,
    slideAlt: (n: number) => `슬라이드 ${n}`,
    count: (n: number) => `Q&A ${n}개`,
    attachmentsTitle: (n: number) => `첨부 ${n}개 (선택 영역·이미지)`,
    noAnswer: '(답변 없음)',
  },

  /** MemoListPanel.tsx */
  memos: {
    deleteTitle: '메모를 지울까요?',
    alreadyDeleted: '그 메모는 이미 지워졌어요',
    search: '메모·태그 검색',
    tagFilter: '태그로 거르기',
    clearTag: '태그 필터 해제',
    onlyTag: (tag: string) => `#${tag} 메모만 보기`,
    loadFailed: (error: string) => `메모를 불러오지 못했어요: ${error}`,
    empty: '아직 메모가 없어요.',
    emptyHint: '슬라이드 위 도구 줄의 메모 도구로 스티커 메모를 붙일 수 있어요. 태그와 다른 슬라이드·녹음으로의 연결도 돼요.',
    noMatch: '조건에 맞는 메모가 없어요.',
    none: '메모가 없어요.',
    openTitle: '슬라이드에서 이 메모 열기',
    hiddenFromTutor: '튜터에게 숨김',
    playTitle: '녹음의 이 순간 듣기 (녹음 탭)',
    menu: '메모 메뉴',
    openOnSlide: '슬라이드에서 열기',
    delete: '메모 삭제',
  },

  /** DigestPanel.tsx, lib/digestState.ts, hooks/useDigest.ts */
  digest: {
    redoConfirm: {
      title: '정리본을 처음부터 다시 만들까요?',
      message: '모든 슬라이드를 다시 LLM에게 보여 주고 정리해요 (시간과 사용량이 들어요).',
      confirmLabel: '다시 만들기',
    },
    /** `llm` = "Claude Code · sonnet". */
    startTitle: (llm: string) => `${llm}(으)로 만들어요 — 상단 ‘새 세션’에서 LLM을 바꿀 수 있어요`,
    madeWith: (llm: string) => `${llm}(으)로 만들어요 · 몇 분 걸릴 수 있어요`,
    outdated: '슬라이드 정리가 바뀌기 전에 만든 요약이에요. 위의 ‘강의 요약 다시 만들기’로 새로 만들 수 있어요.',
    loadFailed: (error: string) => `정리본 정보를 불러오지 못했어요: ${error}`,
    introTitle: '아직 정리본이 없어요',
    /** The bold slide count in intro. */
    slides: (n: number) => `${n}장`,
    intro: (slides: ReactNode) =>
      rich(
        'LLM이 슬라이드 ',
        slides,
        '의 이미지를 직접 읽고, 내용을 그대로 옮겨 적은 뒤(수식·표·코드 포함) 설명과 핵심을 붙여 정리해요. 한 번 만들어 두면 계속 재사용돼요.',
      ),
    tipFaster: '새 세션을 시작할 때 이미지 대신 이 텍스트를 전달해서 더 빠르고 저렴해요',
    tipFormulas: '텍스트 추출로는 흐트러지는 수식·표·기호(α, ε, ∪, ∈ …)도 이미지에서 정확히 읽어 와요',
    tipCourse: '과목에 넣어 두면 다음 강의를 공부할 때 이 강의의 요약이 함께 전달돼요',
    tipAuto: '새 세션을 처음 만들면 자동으로 만들기 시작해요',
    make: '정리본 만들기',
    /** After the slide chip of a slide without an entry. */
    stillRunning: (done: number, total: number) => ` 아직 정리하는 중이에요 (${done} / ${total} 완료)`,
    notYet: ' 이 슬라이드는 아직 정리되지 않았어요. ‘이어서 만들기’로 채울 수 있어요.',
    wholeSummary: (outdated: boolean) => `강의 전체 요약${outdated ? ' (이전 요약)' : ''}`,
    summary: '강의 요약',
    noSummary: '강의 요약이 아직 없어요.',
    mode: '정리본 보기 방식',
    modeCurrent: '현재 슬라이드',
    modeAll: '전체',
    tokensTitle: '이번 정리본 만들기에 쓴 토큰 (실패한 호출 포함)',
    tokens: (n: string) => `토큰 ${n}`,
    redo: '다시 만들기',
    openFile: 'DIGEST.md 열기',
    hint: '정리본은 새 세션을 시작할 때 슬라이드 이미지 대신 재사용돼서 더 빠르고 저렴해요.',
    refreshFailed: (error: string) => `새로고침 실패: ${error}`,
    untitled: '(제목 없음)',
    slideFailed: '이 슬라이드는 정리하지 못했어요 — ‘이어서 만들기’로 다시 시도할 수 있어요',
    waiting: '정리 대기 중…',
    notDigested: '아직 정리되지 않았어요',
    // lib/digestState.ts
    continue: '이어서 만들기',
    retryFailed: '실패한 슬라이드 다시',
    redoSummary: '강의 요약 다시 만들기',
    makeSummary: '강의 요약 만들기',
    statusRunning: '정리하는 중',
    statusFailed: (n: number) => `정리본 · 실패 ${n}장`,
    statusPartial: '정리본 (일부)',
    statusSummaryOutdated: (n: number) => `정리본 완성 · ${n}장 · 요약 갱신 필요`,
    statusNoSummary: (n: number) => `정리본 완성 · ${n}장 · 요약 없음`,
    statusComplete: (n: number) => `정리본 완성 · ${n}장`,
    statusAborted: '중지됨',
    statusError: '오류로 멈춤',
    statusNone: '정리본',
    hintOutdated: '지금 보이는 강의 요약은 슬라이드 정리가 바뀌기 전에 만든 거예요. ‘강의 요약 다시 만들기’로 요약만 다시 만들 수 있어요.',
    hintMissing: '‘강의 요약 만들기’로 요약만 다시 만들 수 있어요.',
    // hooks/useDigest.ts
    done: '정리본이 완성됐어요',
    doneWithFailures: (n: number) => `정리본을 만들었어요 (슬라이드 ${n}장은 실패)`,
    failed: (error: string) => `정리본을 만들지 못했어요: ${error}`,
    alreadyRunning: '이미 정리본을 만들고 있어요.',
    startFailed: (error: string) => `정리본 만들기를 시작하지 못했어요: ${error}`,
    abortFailed: (error: string) => `정리를 중지하지 못했어요: ${error}`,
  },

  /** hooks/useStudySession.ts */
  session: {
    listFailed: (error: string) => `세션 목록을 불러오지 못했어요: ${error}`,
    loadFailed: (error: string) => `세션을 불러오지 못했어요: ${error}`,
    connectionLostReload: '서버와의 연결이 끊겼어요. 대화를 다시 불러올게요.',
    connectionLost: (error: string) => `연결이 끊겼어요: ${error}`,
    createFailed: (error: string) => `세션을 만들지 못했어요: ${error}`,
    primeFailed: '슬라이드를 LLM에게 전달하지 못해서 질문을 보내지 않았어요. 다시 시도해 주세요.',
    switchWhileRunning: '답변이 끝난 뒤에 LLM을 바꿀 수 있어요.',
    switchFailed: (error: string) => `LLM을 바꾸지 못했어요: ${error}`,
    deleteWhileRunning: '답변이 생성되는 중에는 세션을 삭제할 수 없어요.',
    deleteFailed: (error: string) => `세션을 삭제하지 못했어요: ${error}`,
    deleted: '세션을 삭제했어요.',
  },

  /** hooks/useDocs.ts: lectures (PDF documents). */
  docs: {
    processingFailed: (title: string, error: string) => `"${title}" 처리 실패: ${error}`,
    uploadFailed: (name: string, error: string) => `업로드 실패 (${name}): ${error}`,
    retryFailed: (error: string) => `다시 변환하지 못했어요: ${error}`,
    renameFailed: (error: string) => `이름을 바꾸지 못했어요: ${error}`,
    deleteBusy: '변환·정리본 만들기·답변이 진행 중이라 지금은 삭제할 수 없어요. 끝난 뒤에 다시 시도해 주세요.',
    deleteFailed: (error: string) => `삭제하지 못했어요: ${error}`,
  },

  /** lib/markdownOptions.ts: a remote image shown as a link. */
  markdown: {
    externalImage: '외부 이미지',
    blockedImageTitle: (url: string) => `외부 이미지는 자동으로 불러오지 않아요 — 클릭하면 새 탭에서 열려요: ${url}`,
  },
};
