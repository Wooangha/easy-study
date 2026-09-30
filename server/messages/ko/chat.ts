// Korean (the reference language) — server namespace `chat`: sessions, turns, providers (errors and statuses sent to the web), the digest (정리본) and its files' headings.

export const chat = {
  /** The LLM providers (server/providers/*): names, choices, availability, errors and progress lines of a turn. */
  providers: {
    /** ProviderInfo.label. */
    label: {
      'claude-code': 'Claude Code (구독)',
      codex: 'Codex (ChatGPT 구독)',
      'anthropic-api': 'Claude API (API 키)',
      'openai-api': 'OpenAI API (API 키)',
    },
    /** EffortOption.label of the reasoning-effort levels (an unknown level is shown by its id). */
    effort: {
      none: '없음',
      minimal: '최소',
      low: '낮음',
      medium: '보통',
      high: '높음',
      xhigh: '매우 높음',
      max: '최대',
      ultra: '울트라',
    },
    /** EffortOption.description of the `claude --effort` levels. */
    claudeEffort: {
      low: '빠르게, 가볍게 생각해요',
      medium: '속도와 깊이의 균형',
      high: '복잡한 내용을 더 깊이 생각해요',
      xhigh: '더 깊이 생각해요 (느려지고 사용량이 늘어요)',
      max: '가장 깊이 생각해요 (가장 느리고 사용량이 가장 많아요)',
    },
    /** The default-model options ('' = the CLI's own default). */
    claudeDefaultModel: 'CLI 기본값',
    codexDefaultModel: 'Codex 설정 기본값',
    /** With the model of Codex's config.toml. */
    codexDefaultModelOf: (model: string) => `Codex 설정 기본값 (${model})`,

    // A provider / model / effort chosen by a request (POST /sessions, POST /digest, …).
    unknownProvider: (id: string) => `알 수 없는 제공자입니다: ${id}`,
    /** `reason` '' = no reason known. */
    unavailable: (provider: string, reason: string) =>
      reason ? `${provider}을(를) 사용할 수 없습니다: ${reason}` : `${provider}을(를) 사용할 수 없습니다`,
    modelInvalid: '모델 이름이 올바르지 않습니다',
    modelNameInvalid: (model: string) => `모델 이름이 올바르지 않습니다: ${model}`,
    effortInvalid: '추론 수준이 올바르지 않습니다',
    noEffortChoice: (provider: string) => `${provider}은(는) 추론 수준을 고를 수 없습니다`,
    unknownEffort: (effort: string) => `알 수 없는 추론 수준입니다: ${effort}`,
    /** `effort` is the level's name (`effort` above). */
    effortUnsupported: (effort: string) => `이 모델은 추론 수준 '${effort}'을(를) 지원하지 않습니다`,

    // Availability (ProviderInfo.reason).
    cannotCheck: '확인할 수 없습니다.',
    unknownState: '알 수 없는 상태입니다.',
    /** `hint` is how to install it ('' = none). */
    cliNotFound: (name: string, hint: string) => `${name} CLI를 찾을 수 없습니다 (PATH). ${hint}`.trim(),
    versionTimeout: (name: string) => `${name} --version 이 응답하지 않습니다.`,
    versionFailed: (name: string, detail: string) => `${name} --version 실패: ${detail}`.trim(),
    runFailed: (name: string, error: string) => `${name} 실행 실패: ${error}`,
    batchFile: (file: string) =>
      `${file} 은(는) 배치 파일이라 직접 실행할 수 없습니다. ` +
      '공식 설치 프로그램으로 설치하거나, 실제 실행 파일(.exe)의 경로를 CLAUDE_BIN / CODEX_BIN 에 지정하세요.',
    apiKeyMissing: (envName: string) => `${envName} 환경 변수가 설정되지 않았습니다.`,

    // Starting a CLI.
    executableNotFound: (name: string) => `${name} 실행 파일을 찾을 수 없습니다 (PATH를 확인하세요).`,
    notExecutable: (name: string, file: string) => `${name} 실행 권한이 없습니다 (${file}).`,
    spawnFailed: (name: string, error: string) => `${name} 실행에 실패했습니다: ${error}`,
    slideImageUnreadable: (file: string, error: string) => `슬라이드 이미지를 읽을 수 없습니다: ${file} (${error})`,
    aborted: '요청이 중단되었습니다.',

    // Progress lines of a turn (StreamEvent 'status').
    thinking: '생각하는 중…',
    readingFile: (file: string) => `파일 읽는 중: ${file}`,
    findingFiles: (pattern: string) => `파일 찾는 중: ${pattern}`,
    searchingText: (pattern: string) => `텍스트 검색 중: ${pattern}`,
    usingTool: (tool: string) => `도구 사용 중: ${tool}`,
    unknownTool: '알 수 없음',
    unknownFile: '(알 수 없음)',
    runningCommand: (command: string) => `명령 실행 중: ${command}`,
    searchingWeb: '웹 검색 중…',
    warning: (message: string) => `경고: ${message}`,

    /** Claude Code (server/providers/claudeCode.ts). A hint starts on a new line of the error. */
    claude: {
      installHintWindows: 'Claude Code 설치 (PowerShell): irm https://claude.ai/install.ps1 | iex  또는  winget install Anthropic.ClaudeCode',
      installHint: 'Claude Code 설치: curl -fsSL https://claude.ai/install.sh | bash  (또는 npm install -g @anthropic-ai/claude-code)',
      loginHint: '터미널에서 `claude` 를 실행해 로그인 상태를 확인하세요.',
      resumeInvalid: '이전 Claude Code 대화(세션)를 더 이상 찾을 수 없습니다. 새 대화로 다시 시작해야 합니다.',
      contextOverflow: '대화가 모델이 한 번에 받을 수 있는 크기를 넘었습니다. 새 대화로 이어가야 합니다.',
      modelUnavailable:
        '선택한 모델을 이 Claude Code에서 사용할 수 없습니다. 다른 모델을 고르거나 터미널에서 `claude update` 로 CLI를 업데이트하세요.',
      error: (message: string) => `Claude Code 오류: ${message}`,
      /** `exit` is "exit code 1" / "signal SIGTERM". */
      crashed: (exit: string) => `Claude Code가 비정상 종료했습니다 (${exit}).`,
      noResult: 'Claude Code가 결과 없이 종료되었습니다.',
    },
    /** Codex (server/providers/codex.ts). A hint starts on a new line of the error. */
    codex: {
      installHintWindows: 'Codex CLI 설치 (PowerShell): powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      installHint: 'Codex CLI 설치: curl -fsSL https://chatgpt.com/codex/install.sh | sh  (또는 npm install -g @openai/codex)',
      threadReplaced: (previous: string, started: string) =>
        `Codex가 이전 대화(thread ${previous})를 찾지 못해 새 대화(thread ${started})를 시작했습니다.`,
      loginHint: '터미널에서 `codex login` 으로 로그인 상태를 확인하세요.',
      resumeInvalid: '이전 Codex 대화(thread)를 더 이상 이어갈 수 없습니다. 새 대화로 다시 시작해야 합니다.',
      contextOverflow: '대화가 모델의 컨텍스트 한도를 넘었습니다. 새 대화로 이어가야 합니다.',
      modelUnavailable: '선택한 모델을 이 Codex에서 사용할 수 없습니다. 다른 모델을 설정하거나 Codex CLI를 업데이트하세요.',
      confinementHint:
        'Codex가 읽기 제한(이 강의와 같은 과목 강의 폴더만 읽기)을 적용한 채로 시작하지 못했을 수 있습니다. ' +
        'Codex CLI를 업데이트해 보고, 그래도 안 되면 EASY_STUDY_CODEX_CONFINE=0 으로 서버를 다시 시작하세요 ' +
        '(이 경우 Codex가 컴퓨터의 모든 파일을 읽을 수 있습니다).',
      error: (message: string) => `Codex 오류: ${message}`,
      crashed: (exit: string) => `Codex가 비정상 종료했습니다 (${exit}).`,
      noResponse: 'Codex가 응답 없이 종료되었습니다.',
      noThreadId: 'Codex가 thread id를 알려주지 않았습니다.',
    },
    /** The Claude API (server/providers/anthropicApi.ts). */
    anthropic: {
      requestTooLarge: (mb: string) => `Anthropic API 요청이 너무 큽니다 (약 ${mb} MB, 한도 32 MB).`,
      /** Follows requestTooLarge for a continued conversation. */
      tooManyImages: '대화에 이미지가 많이 쌓여 새 대화로 이어가야 합니다.',
      nearContextLimit: (model: string, windowK: number, estimateK: number) =>
        `대화가 모델(${model})의 컨텍스트 한도(${windowK}K 토큰)에 가까워졌습니다 (추정 ${estimateK}K 토큰). 새 대화로 이어가야 합니다.`,
      continuedByOtherModel: '다른 모델이 이어서 답변하는 중…',
      connectFailed: (message: string) => `Anthropic API에 연결할 수 없습니다: ${message}`,
      authFailed: 'Anthropic API 인증에 실패했습니다. ANTHROPIC_API_KEY를 확인하세요.',
      permissionDenied: (message: string) => `Anthropic API 권한 오류: ${message}`,
      notFound: (message: string) => `Anthropic API: 모델 또는 경로를 찾을 수 없습니다 (${message})`,
      rateLimited: 'Anthropic API 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.',
      tooLargeForModel: (message: string) => `Anthropic API: 대화가 너무 커서 모델이 받을 수 없습니다 (${message})`,
      badRequest: (message: string) => `Anthropic API 요청 오류: ${message}`,
      /** `status` 0 = unknown. */
      error: (status: number, message: string) => (status ? `Anthropic API 오류 (${status}): ${message}` : `Anthropic API 오류: ${message}`),
      /** `category` '' = none given. */
      refused: (category: string) =>
        category
          ? `모델이 이 요청에 대한 답변을 거절했습니다 (${category}). 질문을 바꿔 다시 시도해 보세요.`
          : '모델이 이 요청에 대한 답변을 거절했습니다. 질문을 바꿔 다시 시도해 보세요.',
      contextFull: '대화가 모델의 컨텍스트 한도를 채워 답변을 쓸 수 없습니다. 새 대화로 이어가야 합니다.',
      cutOffByContext: '컨텍스트 한도에 도달해 답변이 중간에 끝났습니다.',
    },
    /** The OpenAI API (server/providers/openaiApi.ts). */
    openai: {
      endedEarly: (reason: string) => `응답이 중간에 끝났습니다 (${reason})`,
      failed: '응답 생성에 실패했습니다.',
      previousResponseNotFound: (detail: string) =>
        `OpenAI API: 이전 응답(previous_response_id)을 찾을 수 없습니다. 저장된 대화가 만료되었거나 삭제되었습니다 (${detail})`,
      contextOverflow: (detail: string) => `OpenAI API: 대화가 모델의 컨텍스트 한도를 넘었습니다 (${detail})`,
      permissionDenied: (detail: string) => `OpenAI API 권한 오류: ${detail}`,
      authFailed: 'OpenAI API 인증에 실패했습니다. OPENAI_API_KEY를 확인하세요.',
      modelUnavailable: (detail: string) => `OpenAI API: 모델을 찾을 수 없거나 사용할 수 없습니다 (${detail})`,
      rateLimited: (detail: string) => `OpenAI API 요청 한도를 초과했습니다: ${detail}`,
      badRequest: (detail: string) => `OpenAI API 요청 오류: ${detail}`,
      notFound: (detail: string) => `OpenAI API: 요청한 항목을 찾을 수 없습니다 (${detail})`,
      /** `status` 0 = unknown. */
      error: (status: number, detail: string) => (status ? `OpenAI API 오류 (${status}): ${detail}` : `OpenAI API 오류: ${detail}`),
      connectFailed: (message: string) => `OpenAI API에 연결할 수 없습니다: ${message}`,
      incomplete: 'OpenAI API 응답이 완료되지 않았습니다.',
      noResponseId: 'OpenAI API가 response id를 알려주지 않았습니다.',
    },
  },
  /** Turns (server/chat.ts, the turn routes of server/index.ts). */
  turns: {
    slideRequired: '슬라이드 번호가 필요합니다',
    questionRequired: '질문을 입력해 주세요',
    questionTooLong: (max: string) => `질문이 너무 깁니다 (최대 ${max}자)`,
    memosNotBoolean: 'memos는 true/false여야 합니다',
    neighborsInvalid: (max: number) => `neighbors는 0부터 ${max} 사이의 정수여야 합니다`,
    busy: '이 세션은 답변을 생성하고 있습니다. 답변이 끝난 뒤에 다시 시도해 주세요',
    alreadyAnswering: '이 세션은 이미 답변을 생성하고 있습니다',
    waitingForSlot: '다른 답변이 끝나기를 기다리는 중…',
    /** While a turn is retried in a new provider conversation. */
    recovery: {
      resumeInvalid: '이전 대화를 이어갈 수 없어 새 대화로 다시 시작해요',
      contextOverflow: '대화가 너무 길어져 새 대화로 이어가요',
    },
    // Why an answer stopped (stored on the message).
    aborted: '답변 생성이 중단되었습니다',
    abortedByUser: '사용자가 답변 생성을 중단했습니다',
    abortedByShutdown: '서버가 종료되어 중단되었습니다',
    clientGone: '클라이언트 연결이 끊어져 중단되었습니다',
    interrupted: '서버가 중단되어 답변이 완료되지 않았습니다',
    /** A wait for a CLI process slot that was stopped without a reason. */
    stopped: '중단되었습니다',
  },
  /** Sessions and their notes (server/sessions.ts). */
  sessions: {
    /** The default title of a new session: `date` MM/DD, `time` HH:MM (local); `at` is the same moment, for a language that formats it itself. */
    defaultTitle: (date: string, time: string, _at: Date) => `세션 ${date} ${time}`,
    /** Alt texts of a question's attachments in STUDY_NOTES.md and notes/<session>.md. */
    regionAlt: (slide: number) => `p.${slide} 영역`,
    imageAlt: '이미지',
  },
  /** The digest (정리본, server/digest.ts): errors, stored notes and DIGEST.md, in the language it was made in. */
  digest: {
    alreadyRunning: '이미 정리본을 만들고 있습니다',
    forceNotBoolean: 'force는 true/false 여야 합니다',
    notYet: '정리본이 아직 없습니다',
    aborted: '정리본 만들기가 중단되었습니다',
    abortedByUser: '사용자가 정리본 만들기를 중단했습니다',
    abortedByShutdown: '서버가 종료되어 정리본 만들기가 중단되었습니다',
    interrupted: '서버가 중단되어 정리본 만들기가 멈췄습니다. 이어서 만들 수 있습니다',
    notInOutput: (slides: number[]) => `모델 출력에서 슬라이드 ${slides.join(', ')}의 정리를 찾지 못했습니다`,
    /** The entry of a slide the model gave nothing usable for (in italics, in parentheses); `reason` '' = none. */
    slideFailed: (reason: string) => (reason ? `이 슬라이드의 정리본을 만들지 못했습니다: ${reason}` : '이 슬라이드의 정리본을 만들지 못했습니다'),
    /** The entry of a slide whose output could not be parsed (in italics, in parentheses). */
    slideUnparsed: '이 슬라이드의 정리본을 만들지 못했습니다. 다시 만들기를 시도해 보세요.',
    emptySummary: '모델이 빈 요약을 돌려주었습니다',
    failed: '정리본을 만들지 못했습니다',
    slidesFailed: (slides: number[]) => `슬라이드 ${slides.join(', ')}의 정리본을 만들지 못했습니다 (이어서 만들기로 다시 시도할 수 있습니다)`,
    summaryFailed: (error: string) => `강의 요약을 만들지 못했습니다: ${error}`,
    /** DIGEST.md. */
    markdown: {
      /** The top heading after `# `. */
      title: (lecture: string) => `${lecture} — 정리본`,
      /** In italics, in parentheses. */
      incomplete: (done: number, total: number) => `미완성 정리본: ${done}/${total} 슬라이드`,
      summary: '강의 요약',
      slideFailed: '이 슬라이드는 자동 정리에 실패했습니다.',
    },
  },
};
