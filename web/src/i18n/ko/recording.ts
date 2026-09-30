// Korean (the reference language) — namespace `recording`: the recording panel, the recorder bar and live strip, speech
// recognition (ASR) settings, the transcript, playback. See web/src/i18n/index.ts for the rules.
import type { ReactNode } from 'react';
import { rich } from '../rich.ts';

export const recording = {
  /** The status badge of a recording (lib/recording/labels.ts recordingStatus). */
  status: {
    recording: '녹음 중',
    paused: '일시정지',
    converting: '변환 중',
    convertingTitle: '올린 파일에서 소리를 꺼내는 중이에요',
    error: '오류',
    queued: '받아쓰기 대기',
    queuedTitle: '다른 녹음을 받아쓰는 중이에요. 차례가 오면 시작해요',
    transcribing: '받아쓰는 중',
    transcribingPercent: (percent: number) => `받아쓰기 ${percent}%`,
    transcribed: '받아쓰기 완료',
    transcriptFailed: '받아쓰기 실패',
    notTranscribed: '받아쓰기 전',
  },

  /** How the slides were assigned (a badge and its tooltip). */
  alignment: {
    timeline: '보던 슬라이드 기준',
    timelineTitle: '녹음하는 동안 보고 있던 슬라이드를 기준으로 나눴어요 (말의 내용으로 조금 보정)',
    lexical: '자동 정렬',
    lexicalTitle: '말한 내용과 슬라이드 글자를 비교해서 나눴어요',
    llm: 'AI 정렬',
    llmTitle: 'LLM이 말한 내용과 슬라이드를 비교해서 나눴어요',
  },

  /** The model of "AI 정밀 정렬" when the provider names none. */
  defaultModel: '기본 모델',
  /** A live recording's length and how far it is transcribed: "12:34 · 받아쓰기 11:50까지". */
  durationLive: (total: string, transcribed: string) => `${total} · 받아쓰기 ${transcribed}까지`,

  /** The lecture language options of a recording (RecordingLanguage). */
  languages: {
    ko: '한국어',
    en: '영어',
    auto: '자동 감지',
  },
  /** Languages whisper can report for an 'auto' recording (others are shown as their code). */
  detectedLanguages: {
    ko: '한국어',
    en: '영어',
    ja: '일본어',
    zh: '중국어',
  },
  /** An 'auto' recording once whisper found its language: "자동 감지 (영어)". */
  autoDetected: (language: string) => `자동 감지 (${language})`,

  /** Why transcription cannot run (lib/recording/labels.ts). */
  asr: {
    engineMissing: '음성 인식 엔진(whisper.cpp)을 찾지 못했어요.',
    noModel: '사용할 수 있는 음성 인식 모델이 없어요.',
    blockedEngine: (reason: string) => `녹음은 저장되지만 아직 받아쓸 수 없어요: ${reason}`,
    blockedModel: (model: string, size: string) =>
      `받아쓰기에 필요한 음성 인식 모델이 아직 없어요: ${model} (${size}). ` +
      '녹음 탭에서 내려받으면 그때부터 받아써요 — 녹음은 그대로 계속돼요.',
  },

  /** Microphone problems (getUserMedia / AudioContext failures, a lost or silent track). */
  mic: {
    /** Where each system keeps the microphone permission. */
    privacySetting: {
      mac: '시스템 설정 › 개인정보 보호 및 보안 › 마이크',
      windows: '설정 › 개인 정보 및 보안 › 마이크 (‘데스크톱 앱이 마이크에 액세스하도록 허용’도 켜기)',
      linux: '시스템의 소리 설정',
      ios: '설정 › 개인정보 보호 및 보안 › 마이크',
      android: '설정 › 앱 › 권한 › 마이크',
      other: '운영체제의 개인정보(마이크) 설정',
    },
    notAllowed: (setting: string) =>
      '마이크 사용이 허용되지 않았어요. 주소창의 마이크 아이콘에서 이 사이트의 마이크를 허용하고, ' +
      `${setting}에서 이 앱(또는 브라우저)이 켜져 있는지 확인해 주세요.`,
    /** Added after notAllowed on macOS. */
    notAllowedMac: '켜져 있는데도 안 되면 껐다가 다시 켜 주세요 (앱을 업데이트한 뒤에 그럴 수 있어요).',
    notFound: '마이크를 찾지 못했어요. 마이크가 연결되어 있는지 확인해 주세요.',
    notFoundLinux: '마이크를 찾지 못했어요. 마이크가 연결되어 있는지, 오디오 서버(PipeWire 또는 PulseAudio)가 실행 중인지 확인해 주세요.',
    notReadable: '마이크를 열 수 없어요. 다른 앱(화상 회의 등)이 마이크를 쓰고 있지 않은지 확인하고 다시 시도해 주세요.',
    notSupported: '이 브라우저는 16 kHz 녹음을 지원하지 않아요. 최신 Chrome·Edge·Safari 또는 easy-study 앱을 써 주세요.',
    failed: '마이크를 시작하지 못했어요',
    failedDetail: (detail: string) => `마이크를 시작하지 못했어요: ${detail}`,
    disconnected: '마이크 연결이 끊겼어요. 녹음을 일시정지했어요 — 마이크를 확인하고 ‘계속’을 누르세요.',
    silent: '마이크 소리가 들어오지 않아요 (시스템이 마이크를 막았거나 다른 앱이 쓰고 있어요).',
  },

  /** Why this page cannot record at all. */
  unavailable: {
    insecure: (origin: string) =>
      `이 주소(${origin})는 보안 연결(HTTPS)이 아니라서 브라우저가 마이크를 막아요. ` +
      '녹음하려면 서버 컴퓨터에서 easy-study 앱이나 http://127.0.0.1 주소로 열거나, ' +
      'easy-study 앱으로 그 컴퓨터에 연결하거나(앱 안에서는 http 주소여도 녹음돼요), ' +
      'HTTPS로 접속해 주세요 (예: tailscale serve, 또는 EASY_STUDY_TLS_CERT/KEY). 녹음 파일 올리기는 여기서도 돼요.',
    noMediaDevices: '이 브라우저(또는 앱 창)에서는 마이크를 쓸 수 없어요. 최신 Chrome·Edge·Safari 또는 easy-study 앱을 써 주세요.',
    noAudioWorklet: '이 브라우저는 녹음에 필요한 기능(AudioWorklet)이 없어요. 최신 Chrome·Edge·Safari 또는 easy-study 앱을 써 주세요.',
  },

  /** One-time notice before the first recording. */
  consent: {
    title: '수업을 녹음하기 전에',
    message:
      '교수님과 학교의 녹음 규정을 먼저 확인해 주세요. 수업 녹음을 허락받지 않았다면 녹음하지 마세요.\n' +
      '녹음은 이 컴퓨터(또는 연결한 easy-study 서버)에만 저장되고, 받아쓰기도 그 컴퓨터에서 해요. ' +
      '녹음 파일과 받아쓴 글은 녹음 탭에서 언제든 지울 수 있어요.',
    confirmLabel: '확인했어요, 녹음하기',
  },

  /** A picked recording file refused before uploading. */
  files: {
    notAudio: (name: string) => `‘${name}’은(는) 오디오·동영상 파일이 아니에요.`,
    empty: (name: string) => `‘${name}’은(는) 빈 파일이에요.`,
    tooLarge: (name: string, max: string) => `‘${name}’이(가) 너무 커요 (최대 ${max}).`,
  },

  /** A span of time in a sentence (lib/recording/timeline.ts formatSpan): "45초", "3분 12초", "1시간 2분". */
  span: {
    seconds: (s: number) => `${s}초`,
    minutes: (m: number, s: number) => (s > 0 ? `${m}분 ${s}초` : `${m}분`),
    hours: (h: number, m: number) => (m > 0 ? `${h}시간 ${m}분` : `${h}시간`),
  },

  /** "여기부터 p.N" markers (lib/recording/markers.ts). */
  markers: {
    fromSlide: (slide: number) => `여기부터 p.${slide}`,
    fromHereOff: '여기부터 슬라이드 밖',
    /** The short form on a marker chip. */
    toSlide: (slide: number) => `→ p.${slide}`,
    toOff: '→ 슬라이드 밖',
    saveFailed: (reason: string) => `슬라이드 표시를 저장하지 못했어요: ${reason}`,
  },

  /** components/recording/AsrSettings.tsx and the model download / delete of hooks/useAsrStatus.ts. */
  asrSettings: {
    installed: '설치됨',
    downloading: '내려받는 중',
    downloadFailed: '내려받기 실패',
    needsDownload: '내려받기 필요',
    recommended: '추천',
    accelMetal: 'GPU(Metal) 가속',
    accelVulkan: 'GPU(Vulkan) 가속',
    cpuAfterGpuError: 'CPU · GPU 오류로 CPU로 받아써요',
    statusFailed: (error: string) => `음성 인식 상태를 확인하지 못했어요: ${error}`,
    problemHint: '녹음과 파일 올리기는 되고, 받아쓰기는 엔진이 준비되면 시작돼요.',
    downloadingModel: (model: ReactNode, received: string, total: string) =>
      rich('음성 인식 모델 ', model, ` 내려받는 중 · ${received} / ${total}`),
    downloadingHint: '내려받는 동안에도 녹음할 수 있어요. 받아쓰기는 모델이 준비되면 시작돼요.',
    needsModel: (model: ReactNode, size: string) =>
      rich('받아쓰기에는 음성 인식 모델이 필요해요: ', model, ` (${size}). 한 번만 내려받으면 돼요.`),
    lastDownloadFailed: (error: string) => `지난번 내려받기가 실패했어요: ${error}`,
    download: '내려받기',
    downloadAgain: '다시 내려받기',
    modelStaysLocal: '모델은 서버 컴퓨터에만 저장되고, 받아쓰기도 거기서 해요 (인터넷으로 보내지 않아요).',
    removeConfirm: {
      title: (model: string) => `${model} 모델을 지울까요?`,
      message: (size: string) => `디스크 ${size}를 비워요. 이 모델로 받아쓰려면 다시 내려받아야 해요. 녹음과 받아쓴 글은 그대로예요.`,
      confirmLabel: '모델 지우기',
    },
    model: '음성 인식 모델',
    cpuHint: (model: ReactNode, size: string) =>
      rich('이 컴퓨터는 GPU 가속 없이(CPU로) 받아써요. 느리면 더 작은 ', model, ` 모델(${size})이 몇 배 빨라요.`),
    integratedGpuHint: (model: ReactNode, size: string) =>
      rich('이 컴퓨터는 내장 그래픽으로 받아써요. 느리면 더 작은 ', model, ` 모델(${size})이 더 빨라요.`),
    lectureLanguage: '강의 언어',
    liveTranscribe: '녹음하면서 받아쓰기',
    liveTranscribeHint: '끄면 녹음을 끝낸 뒤에 받아써요 (느린 컴퓨터에서 수업 중 부담이 줄어요)',
    engine: '엔진',
    none: '없음',
    fileConversion: '파일 변환(ffmpeg)',
    available: '있음',
    removeModel: (model: string) => `${model} 지우기`,
    appliesHere: '이 설정은 이 기기에서 새로 시작하는 녹음에 적용돼요. 올린 파일은 서버가 언어를 자동으로 알아내요.',
    modelDownloadFailed: (reason: string) => `음성 인식 모델을 내려받지 못했어요: ${reason}`,
    modelRemoved: '음성 인식 모델을 지웠어요.',
    modelRemoveFailed: (reason: string) => `모델을 지우지 못했어요: ${reason}`,
  },

  /** components/recording/LectureSpeech.tsx: the composer chip. */
  speech: {
    chipTitle: '녹음 중인 강의에서 교수님이 최근에 한 말(받아쓴 글)을 질문과 함께 튜터에게 전달해요. 받아쓰기에는 오류가 있을 수 있어요.',
    recentMinutes: (minutes: number) => `최근 ${minutes}분 포함`,
    recordingPaused: '녹음 일시정지',
  },

  /** components/recording/RecordingUploads.tsx: a lecture's uploads in progress. */
  uploadBadge: (percent: number) => `녹음 올리는 중 ${percent}%`,

  /** components/recording/RecorderBar.tsx RecordControl: the top bar's record button and running recording. */
  bar: {
    start: '녹음 시작',
    startTitle: '녹음 시작 — 이 강의를 녹음하고 바로 받아써요 (교수님이 한 말을 튜터가 함께 알게 돼요)',
    startingMic: '마이크 준비 중…',
    savingTitle: '남은 녹음을 서버로 보내고 있어요',
    saving: '녹음 저장 중…',
    savingLeft: (left: string) => `녹음 저장 중 · ${left} 남음`,
    loginToContinue: '로그인하면 이어서 보내요',
    offline: (unsent: string) => `서버에 연결되지 않아 이 기기에 보관 중 (${unsent})`,
    label: '녹음 중',
    otherDocTitle: (lecture: string) => `‘${lecture}’ 강의를 녹음하고 있어요 — 클릭하면 그 강의로 가요`,
    thisDocTitle: (title: string) => `‘${title}’ 녹음 — 클릭하면 녹음 탭을 열어요`,
    paused: '일시정지',
    resume: '녹음 계속',
    pauseTitle: '일시정지 (쉬는 시간 등)',
    pause: '녹음 일시정지',
    stopTitle: '녹음 끝내기 — 남은 받아쓰기와 슬라이드 정렬이 이어서 진행돼요',
    stop: '녹음 끝내기',
  },

  /** components/recording/RecorderBar.tsx RecordingStrip: the strip under the top bar. */
  strip: {
    label: '녹음',
    interrupted: (title: ReactNode, saved: string) => rich(title, ` 녹음이 중간에 멈췄어요 (${saved}까지 저장됨).`),
    interruptedSending: (title: ReactNode, saved: string, sending: string) =>
      rich(title, ` 녹음이 중간에 멈췄어요 (${saved}까지 저장됨 · 서버로 보내는 중 ${sending}).`),
    continue: '이어서 녹음',
    finishHere: '여기서 끝내기',
    finishHereTitle: '지금까지 녹음한 것만 저장하고 받아쓰기를 끝까지 해요',
    notPersistent: '이 브라우저는 녹음을 기기에 임시 저장하지 못해요. 새로고침하거나 창을 닫으면 아직 서버로 못 보낸 부분을 잃을 수 있어요.',
    iosKeepOpen: '녹음하는 동안 이 화면을 켠 채로 열어 두세요 (다른 앱으로 가거나 화면이 꺼지면 녹음이 멈춰요).',
    liveTitle: '실시간 받아쓰기',
    waitingFirst: '첫 문장을 기다리는 중…',
    behind: (lag: string) => `${lag} 늦게 따라가는 중`,
    nearlyLive: '거의 실시간',
    afterStop: '녹음을 끝내면 받아써요 (설정에서 바꿀 수 있어요)',
    recordingTab: '녹음 탭',
    expandTitle: '최근 문장 몇 줄 더 보기',
    collapseTitle: '마지막 한 줄만 보기',
    expand: '펼치기',
    collapse: '접기',
  },

  /** components/recording/Transcript.tsx. */
  transcript: {
    emptyLive: '받아쓴 문장이 여기에 나타나요…',
    empty: '받아쓴 문장이 아직 없어요.',
    nothingOnSlide: '이 슬라이드에서 한 말이 없어요.',
    nothingOnSlideYet: '이 슬라이드에서 한 말이 아직 없어요.',
    offSlideTitle: '슬라이드와 관계없는 말 (공지, 잡담 등)',
    offSlide: '슬라이드 밖',
    goToSlide: '이 슬라이드로 이동',
    playFromHere: '여기부터 재생',
    markTitle: (slide: number) =>
      `이 문장부터 지금 보고 있는 슬라이드(p.${slide})에 대한 설명이라고 표시해요 — 뒤따르는 문장도 다시 정렬돼요`,
    playFrom: (time: string) => `${time}부터 재생`,
    markerTitle: (marker: string) => `직접 표시한 구간: ${marker}`,
    /** A marker of "슬라이드 밖" on its line (a marker of a slide shows "p.N"). */
    markerOff: '밖',
    sentenceMenu: (time: string) => `${time} 문장 메뉴`,
    offSlideHint: '공지·잡담',
    removeMarker: '이 표시 지우기',
  },

  /** components/recording/RecordingsPanel.tsx: the 녹음 tab's toolbar and list. */
  panel: {
    liveChipTitle: '녹음 중인 녹음 보기 (멈추기는 위쪽 녹음 막대에서)',
    saving: '저장 중',
    recordingElsewhere: '다른 강의를 녹음하고 있어요',
    startTitle: '이 강의를 녹음하고 바로 받아쓰기해요',
    start: '녹음 시작',
    uploadNoFfmpeg: '서버에 파일 변환 도구(ffmpeg)가 없어서 녹음 파일을 올릴 수 없어요',
    uploadTitle: '이미 녹음한 파일(음성·동영상)을 올려서 받아쓰고 슬라이드에 맞춰요',
    upload: '녹음 파일 올리기',
    settingsTitle: '받아쓰기 설정 (모델·언어·실시간 받아쓰기)',
    refresh: '새로고침',
    listFailed: (error: string) => `녹음 목록을 불러오지 못했어요: ${error}`,
    emptyTitle: '아직 녹음이 없어요',
    emptyBody: (start: ReactNode, upload: ReactNode) =>
      rich('수업 중에 ', start, '을 누르면 강의를 녹음하면서 바로 받아써요. 이미 녹음한 파일은 ', upload, '로 올리면 돼요.'),
    tipAsk: '녹음하는 동안 질문하면 최근 몇 분 동안 교수님이 한 말도 튜터에게 함께 전달돼요',
    tipSlides: '받아쓴 문장은 슬라이드별로 나뉘고, 튜터가 그 슬라이드에서 한 말을 알고 설명해요',
    tipReplay: '나중에 문장을 누르면 그 부분부터 다시 들을 수 있고, 슬라이드도 따라 넘어가요',
    tipLocal: '받아쓰기는 서버 컴퓨터에서 해요 (녹음을 인터넷으로 보내지 않아요)',
    list: '녹음 목록',
  },

  /** components/recording/RecordingsPanel.tsx: the selected recording (player, transcript, markers, menu). */
  detail: {
    noPlayableFile: '아직 재생할 수 있는 파일이 없어요.',
    audioErrors: {
      format: '재생하지 못했어요. 이 브라우저가 이 형식을 재생할 수 없을 수 있어요.',
      play: '재생하지 못했어요.',
      pressPlay: '재생하지 못했어요. 재생 버튼을 눌러 주세요.',
      load: '녹음 파일을 불러오지 못했어요.',
    },
    renameFailed: (reason: string) => `이름을 바꾸지 못했어요: ${reason}`,
    deleteConfirm: {
      title: (title: string) => `‘${title}’ 녹음을 삭제할까요?`,
      message: '녹음 파일과 받아쓴 글, 슬라이드 정렬이 모두 지워지고 되돌릴 수 없어요. 튜터도 이 녹음의 내용을 더 이상 쓰지 않아요.',
      messageLive:
        '녹음을 멈추고 삭제해요. 녹음 파일과 받아쓴 글, 슬라이드 정렬이 모두 지워지고 되돌릴 수 없어요. 튜터도 이 녹음의 내용을 더 이상 쓰지 않아요.',
      confirmLabel: '녹음 삭제',
    },
    deleted: (title: string) => `‘${title}’ 녹음을 삭제했어요.`,
    deleteFailed: (reason: string) => `녹음을 삭제하지 못했어요: ${reason}`,
    markedOff: '여기부터 슬라이드 밖으로 표시하고 다시 정렬했어요.',
    markedSlide: (slide: number) => `여기부터 p.${slide}로 표시하고 다시 정렬했어요.`,
    finish: '녹음 끝내기',
    finishHint: '다른 기기의 녹음',
    clearMarkers: '직접 표시한 구간 모두 지우기',
    delete: '녹음 삭제',
    nameLabel: '녹음 이름',
    aligningTitle: 'AI가 정렬하고 있어요',
    alignAfterTranscript: '받아쓰기가 끝난 뒤에 할 수 있어요',
    alignTitle: 'LLM이 받아쓴 글과 슬라이드를 비교해서 더 정확하게 나눠요',
    aligning: 'AI 정렬 중…',
    align: 'AI 정밀 정렬',
    menu: (title: string) => `‘${title}’ 녹음 메뉴`,
    manualMarkers: '직접 표시',
    markersElsewhere: '다른 기기(또는 브라우저)에서 직접 표시한 구간이 있어요. 여기서 새로 표시하면 그 표시를 대신해요.',
    markers: '직접 표시한 구간:',
    markersRealigning: '직접 표시한 구간 (다시 정렬하는 중…):',
    removeMarkerAt: (time: string) => `${time} 표시 지우기`,
    viewMode: '받아쓴 글 보기 방식',
    currentSlide: (slide: number) => `현재 슬라이드 (p.${slide})`,
    all: '전체',
    sentences: (n: number) => `${n}문장`,
    transcriptFailed: (error: string) => `받아쓴 글을 불러오지 못했어요: ${error}`,
    pause: '일시정지',
    play: '재생',
    position: '재생 위치',
    followTitle: '재생하는 동안 슬라이드 창이 지금 설명 중인 슬라이드로 넘어가요',
    follow: '슬라이드 따라가기',
    replayTitle: '재생하는 동안 그때까지 쓴 필기(형광·메모 등)만 슬라이드에 보여요',
    replay: '그때 필기 재생',
    latestTitle: '녹음 중인 부분까지 다시 불러와요',
    latest: '최신',
    preparing: '재생할 파일을 만드는 중이에요…',
  },

  /** components/recording/RecordingsPanel.tsx AiAlignForm: "AI 정밀 정렬". */
  aiAlign: {
    started: 'AI 정밀 정렬을 시작했어요. 끝나면 받아쓴 글의 슬라이드 구분이 바뀌어요.',
    failed: (reason: string) => `AI 정밀 정렬을 시작하지 못했어요: ${reason}`,
    intro: (marker: ReactNode) =>
      rich(
        'LLM이 받아쓴 글과 슬라이드(정리본이 있으면 정리본)를 직접 비교해서, 어느 문장이 어느 슬라이드 설명인지 다시 나눠요. 직접 표시한 구간(',
        marker,
        ')은 그대로 지켜요. 몇 분 걸리고 LLM 사용량이 들어요.',
      ),
    noLlm: '사용할 수 있는 LLM이 없어요.',
    llmLabel: '정렬에 쓸 LLM',
    starting: '시작하는 중…',
    start: '정렬 시작',
    model: (model: string) => `모델: ${model}`,
  },

  /** components/recording/PlaybackRate.tsx. */
  rate: {
    title: '재생 속도',
    button: (rate: string) => `재생 속도 ${rate}배속`,
    reset: '1배속으로',
    resetTitle: '보통 속도(1×)로',
    valueText: (rate: string) => `${rate}배속`,
    sliderTitle: '끌면 눈금에 달라붙어요 · ←→ 0.05씩 · 더블클릭하면 1×',
    notANumber: '재생 속도는 숫자로 입력해 주세요 (예: 1.25).',
    clamped: (min: string, max: string, rate: string) => `재생 속도는 ${min}×부터 ${max}×까지예요. ${rate}×로 맞췄어요.`,
    boxTitle: '재생 속도 직접 입력 (0.5~3, Enter로 적용 · Esc로 취소)',
    boxLabel: '재생 속도 직접 입력 (배)',
  },

  /** lib/recording/actions.ts: the record buttons' dialogs and toasts. */
  actions: {
    unavailableTitle: '이 연결에서는 녹음할 수 없어요',
    finishElsewhere: {
      titleBlocking: '다른 녹음이 아직 진행 중인 것으로 되어 있어요',
      title: (title: string) => `‘${title}’ 녹음을 여기서 끝낼까요?`,
      message: (title: string, uploaded: string) =>
        `‘${title}’ 녹음이 다른 기기(또는 브라우저)에서 진행 중인 것으로 되어 있어요 — 서버에는 ${uploaded}까지 올라와 있어요. ` +
        '그 기기에서 아직 녹음하고 있다면 거기서 멈춰 주세요. 그 기기를 더 쓸 수 없다면 여기서 끝낼 수 있어요: 서버에 올라온 부분으로 녹음을 마치고 받아쓰기와 슬라이드 정렬을 끝내요. ' +
        '그 기기에서 아직 올리지 못한 부분은 사라져요.',
      /** Added after the message when the recording keeps a new one from starting. */
      blockingNote: '끝낸 뒤에 새 녹음을 시작할 수 있어요.',
      confirmLabel: '그 녹음 끝내기',
    },
    finishedBlocking: (title: string) => `‘${title}’ 녹음을 끝냈어요. 이제 녹음 시작을 다시 누르세요.`,
    finished: (title: string) => `‘${title}’ 녹음을 끝냈어요. 남은 받아쓰기와 슬라이드 정렬이 끝나면 다시 들을 수 있어요.`,
    finishFailed: (reason: string) => `녹음을 끝내지 못했어요: ${reason}`,
    stopFailed: (reason: string) => `녹음을 멈추지 못했어요: ${reason}`,
  },

  /** lib/recording/uploads.ts: uploading recording files. */
  uploads: {
    uploaded: (title: string, lecture: string) =>
      `‘${title}’ 녹음을 ‘${lecture}’에 올렸어요. 변환과 받아쓰기가 끝나면 녹음 탭에서 볼 수 있어요.`,
    canceled: (name: string) => `‘${name}’ 올리기를 취소했어요.`,
    tooLarge: (name: string) => `‘${name}’이(가) 너무 커서 올리지 못했어요.`,
    failed: (name: string, reason: string) => `‘${name}’을(를) 올리지 못했어요: ${reason}`,
  },

  /** lib/recording/recorder.ts: the live recorder's errors and toasts. */
  recorder: {
    allUploaded: (title: string) => `‘${title}’ 녹음을 모두 올렸어요. 받아쓰기가 끝나면 녹음 탭에서 볼 수 있어요.`,
    gone: (title: string) => `‘${title}’ 녹음이 서버에서 지워져서 녹음을 멈췄어요.`,
    notLive: (title: string) => `‘${title}’ 녹음은 이미 끝나 있었어요 (다른 창이나 기기에서 멈췄을 수 있어요).`,
    localMissing: (title: string) => `‘${title}’ 녹음의 이 기기 기록이 사라졌어요 (브라우저 저장소가 지워졌을 수 있어요).`,
    cannotUpload: (title: string, detail: string) => `‘${title}’ 녹음을 더 올릴 수 없어요: ${detail}`,
    stillSaving: '방금 멈춘 녹음을 마저 올리는 중이에요. 끝난 뒤에 새로 녹음할 수 있어요.',
    alreadyRecording: '이미 녹음하고 있어요.',
    /** A start refused because another recording is live (after the server's own message and " — "). */
    busy: '다른 녹음이 진행 중이에요. 한 번에 하나만 녹음할 수 있어요.',
    startFailed: (reason: string) => `녹음을 시작하지 못했어요: ${reason}`,
    cannotStore: (reason: string) => `녹음을 이 기기에 저장할 수 없어요: ${reason}`,
    cannotContinue: '이어서 녹음할 수 없어요: 이 기기에 남은 녹음 정보가 없어요.',
    storingAgain: '녹음을 다시 이 기기에 저장하고 있어요.',
    storageFull: '저장 공간이 부족해요',
    storeFailedQuota: '저장 공간이 부족해서 녹음을 이 기기에 저장하지 못하고 있어요. 공간을 확보해 주세요 — 잠시 메모리에 보관하고 있어요.',
    storeFailed: (reason: string) => `녹음을 이 기기에 저장하지 못하고 있어요: ${reason} — 잠시 메모리에 보관하고 있어요.`,
    pausedStoreFailed: (reason: string) =>
      `이 기기에 녹음을 저장할 수 없어서 일시정지했어요 (${reason}). 공간을 확보한 뒤 ‘계속’을 누르고, 그래도 안 되면 새로고침한 뒤 ‘이어서 녹음’을 누르세요.`,
    backlog: (unsent: string) =>
      `서버에 아직 못 보낸 녹음이 ${unsent} 쌓였어요. 이 기기에 안전하게 보관 중이고, 연결되면 이어서 보내요.`,
    resumeStoreFailed: '아직 이 기기에 녹음을 저장할 수 없어요. 저장 공간을 확보하거나, 페이지를 새로고침한 뒤 ‘이어서 녹음’을 눌러 주세요.',
    lastPartLost: (lost: string) => `마지막 ${lost}은 이 기기에 저장하지 못해서 녹음에서 빠졌어요.`,
    readFailed: (reason: string) => `이 기기에 저장된 녹음을 읽지 못했어요: ${reason}`,
    saved: (title: string) => `‘${title}’ 녹음을 저장했어요. 남은 받아쓰기와 슬라이드 정렬이 끝나면 녹음 탭에서 다시 들을 수 있어요.`,
    savedTranscribing: (title: string) => `‘${title}’ 녹음을 저장했어요. 이제 받아쓰기를 시작해요 — 진행 상황은 녹음 탭에서 볼 수 있어요.`,
  },

  /** lib/recording/uploader.ts: why the live upload is retrying or gave up (a tooltip, or the detail of a toast). */
  uploader: {
    timeout: '서버 응답이 없어요 (시간 초과)',
    localMissing: '이 기기에 저장된 녹음 정보가 없어요',
    gone: '녹음이 서버에서 지워졌어요',
    dataLostAt: (bytes: number) => `이 기기에 ${bytes}바이트 이후의 녹음이 남아 있지 않아요`,
    outOfSync: '서버와 녹음 상태가 맞지 않아요. 잠시 후 다시 시도해요',
    notLive: '이 녹음은 이미 끝났어요 (다른 곳에서 멈췄을 수 있어요)',
    serverAhead: (bytes: number) => `서버의 녹음(${bytes}바이트)이 이 기기에서 녹음한 것보다 길어요`,
    dataLost: '서버가 받은 녹음 일부를 잃었고, 이 기기에도 더 이상 남아 있지 않아요',
  },
};
