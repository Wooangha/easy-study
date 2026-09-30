// Korean (the reference language) — server namespace `recordings`: lecture recordings (server/recordings/): errors, statuses and labels sent to the web.
//
// A recording's background work (conversion, transcription) writes its errors into meta.json in the language of the
// request that made the recording (RecordingMeta.lang), so they stay in that language afterwards (like its title).

export const recordings = {
  notFound: {
    recording: '녹음을 찾을 수 없습니다',
    model: '모델을 찾을 수 없습니다',
    playbackAudio: '재생할 오디오가 아직 없습니다',
  },
  docNotReady: '문서를 아직 처리하는 중입니다',
  tooManyRequests: '요청이 너무 많습니다. 잠시 뒤에 다시 보내 주세요',
  shuttingDown: '서버가 종료되는 중입니다',
  diskFull: '디스크 공간이 부족합니다. 공간을 확보한 뒤 다시 시도해 주세요',
  unknownProvider: (id: string) => `알 수 없는 제공자입니다: ${id}`,
  /** Default titles; `stamp` is "2026-09-27 15:30" (local time), `at` the same moment (for a language that formats it itself). */
  titles: {
    live: (stamp: string, _at: Date) => `녹음 ${stamp}`,
    upload: (stamp: string, _at: Date) => `녹음 파일 ${stamp}`,
  },
  upload: {
    stalled: (seconds: number) => `업로드가 ${seconds}초 넘게 멈춰 있어서 중단했습니다. 다시 올려 주세요`,
    interrupted: '업로드가 중간에 끊겼습니다',
    /** `limit`: "1 MB", "4 GB". */
    tooLarge: (limit: string) => `녹음 파일이 너무 큽니다 (최대 ${limit})`,
    empty: '녹음 파일 내용이 비어 있습니다',
    notMedia: (supported: string) => `오디오·동영상 파일이 아닙니다 (지원: ${supported})`,
    ffmpegNotFoundDesktop: '녹음 파일을 변환할 ffmpeg를 찾을 수 없습니다. 앱을 다시 설치하거나 EASY_STUDY_FFMPEG에 경로를 지정하세요',
    ffmpegMissing: '녹음 파일을 변환할 ffmpeg가 없습니다. ffmpeg를 설치하거나 EASY_STUDY_FFMPEG에 경로를 지정하세요',
  },
  /** Why the conversion of an upload failed (ffmpeg.ts conversionError). */
  conversion: {
    ffmpegNotFound: 'ffmpeg를 찾을 수 없습니다. ffmpeg를 설치하거나 EASY_STUDY_FFMPEG에 경로를 지정하세요',
    noAudioTrack: '오디오 트랙이 없습니다',
    damaged: '파일이 손상되었거나 업로드가 끝나지 않았습니다',
    /** `detail`: ffmpeg's last stderr line, or ''. */
    failed: (detail: string) => (detail ? `녹음 파일을 변환하지 못했습니다: ${detail}` : '녹음 파일을 변환하지 못했습니다'),
  },
  live: {
    chunkTooLarge: (maxBytes: number) => `오디오 조각이 너무 큽니다 (최대 ${maxBytes} 바이트)`,
    offsetRequired: 'offset(0 이상의 정수)이 필요합니다',
    emptyAudio: '오디오 내용이 비어 있습니다',
    oddBytes: 'PCM 16비트 샘플 단위(짝수 바이트)로 보내 주세요',
    fileClosed: '녹음 파일이 닫혀 있습니다',
    gap: (offset: number, committed: number) => `offset ${offset}은(는) 저장된 끝(${committed})보다 뒤입니다. 그 지점부터 다시 보내 주세요`,
    conflict: '이미 저장된 오디오와 내용이 다릅니다',
    ended: '녹음이 이미 끝났습니다',
    tooLong: '녹음이 너무 깁니다 (최대 24시간)',
    uploadCannotAppend: '업로드한 녹음에는 오디오를 이어 붙일 수 없습니다',
    notRecording: '녹음 중이 아닙니다',
    uploadCannotStop: '업로드한 녹음은 멈출 수 없습니다',
    stopBeforeStored: '종료 크기가 이미 저장된 오디오보다 작습니다',
    starting: '이미 녹음을 시작하는 중입니다',
    /** Another live recording runs: its title, and its document's title when it is another document (else null). */
    alreadyRecording: (title: string, docTitle: string | null) =>
      docTitle !== null
        ? `이미 녹음 중인 강의가 있습니다 (‘${docTitle}’의 ‘${title}’). 그 녹음을 먼저 끝내 주세요`
        : `이미 녹음 중인 강의가 있습니다 (‘${title}’). 그 녹음을 먼저 끝내 주세요`,
  },
  /** Validation of request bodies and headers. */
  request: {
    badLanguage: 'language는 ko, en, auto 중 하나여야 합니다',
    unknownAsrModel: (id: string) => `알 수 없는 받아쓰기 모델입니다: ${id}`,
    badLiveTranscribe: 'liveTranscribe는 true/false 여야 합니다',
    slideEventsRequired: '슬라이드 이벤트 배열(최대 1000개)이 필요합니다',
    badSlideEvent: (json: string) => `잘못된 슬라이드 이벤트입니다: ${json}`,
    uploadHasNoSlides: '업로드한 녹음에는 슬라이드 기록이 없습니다',
    badBytes: 'bytes는 0 이상의 정수여야 합니다',
    titleRequired: '제목을 입력해 주세요',
    markersRequired: '마커 배열(최대 500개)이 필요합니다',
    badMarker: (json: string) => `잘못된 마커입니다: ${json}`,
  },
  transcription: {
    failed: (reason: string) => `받아쓰기 실패: ${reason}`,
    noOutputFile: 'whisper-cli가 결과 파일을 만들지 않았습니다',
    unreadableOutput: 'whisper-cli 결과를 읽을 수 없습니다',
  },
  /** Why transcription is unavailable (GET /api/asr reason). */
  engine: {
    missingEnv: (path: string) => `EASY_STUDY_WHISPER에 지정한 받아쓰기 엔진(whisper-cli)이 없습니다: ${path}`,
    notFoundDesktop: '받아쓰기 엔진(whisper-cli)을 찾을 수 없습니다. 앱을 다시 설치하거나 EASY_STUDY_WHISPER에 whisper-cli 경로를 지정하세요',
    missing: '받아쓰기 엔진(whisper-cli)이 없습니다. 저장소에서 `npm run setup:whisper`로 설치하거나 EASY_STUDY_WHISPER에 whisper-cli 경로를 지정하세요',
    cannotRun: (path: string, error: string) => `받아쓰기 엔진을 실행할 수 없습니다 (${path}): ${error}`,
    unknownError: '알 수 없는 오류',
    fileMissing: (file: string) => `파일이 없습니다: ${file}`,
  },
  /** Speech recognition models (models.ts). */
  models: {
    /** Labels of the catalog's models (CatalogModel.labelKey). */
    labels: {
      turbo: '정확 (large-v3-turbo)',
      small: '빠름 (small)',
    },
    unknown: (id: string) => `알 수 없는 모델입니다: ${id}`,
    inUse: '이 모델로 받아쓰는 중에는 지울 수 없습니다',
    downloadCanceled: '다운로드를 취소했습니다',
    downloadFailed: (reason: string) => `모델을 내려받을 수 없습니다: ${reason}`,
    incomplete: (size: number, total: number) => `다운로드가 끝나지 않았습니다 (${size}/${total} 바이트). 다시 시도하면 이어서 받습니다`,
    corrupt: (file: string) => `내려받은 파일이 손상되었습니다 (sha256 불일치: ${file}). 다시 시도해 주세요`,
    emptyResponse: '빈 응답',
    largerThanExpected: '파일이 예상보다 큽니다',
  },
  /** "AI 정밀 정렬" (aiPrompt.ts, service.ts startAiAlignment). */
  aiAlign: {
    running: 'AI 정렬이 이미 진행 중입니다',
    noTranscript: '받아쓴 내용이 아직 없습니다',
    notFinished: '받아쓰기가 끝난 뒤에 AI 정렬을 할 수 있습니다',
    failed: (reason: string) => `AI 정렬 실패: ${reason}`,
    noJsonArray: 'AI 정렬 결과에서 JSON 배열을 찾을 수 없습니다',
    unreadable: 'AI 정렬 결과를 읽을 수 없습니다',
    notArray: 'AI 정렬 결과가 배열이 아닙니다',
    noRuns: 'AI 정렬 결과에 구간이 없습니다',
  },
};
