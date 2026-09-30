// English — server namespace `chat` (the Korean reference: ../ko/chat.ts).
import type { chat as ko } from '../ko/chat.ts';

/** "Sep 30, 2:05 PM" (local time, the same clock as the rest of the English UI). */
const sessionStamp = (at: Date): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at).replace(/\u202f/g, ' ');

export const chat = {
  providers: {
    label: {
      'claude-code': 'Claude Code (subscription)',
      codex: 'Codex (ChatGPT subscription)',
      'anthropic-api': 'Claude API (API key)',
      'openai-api': 'OpenAI API (API key)',
    },
    effort: {
      none: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'very high',
      max: 'max',
      ultra: 'ultra',
    },
    claudeEffort: {
      low: 'Thinks quickly and lightly',
      medium: 'A balance of speed and depth',
      high: 'Thinks harder about complex material',
      xhigh: 'Thinks even harder (slower, more usage)',
      max: 'Thinks the hardest (slowest, most usage)',
    },
    claudeDefaultModel: 'CLI default',
    codexDefaultModel: 'Codex config default',
    codexDefaultModelOf: (model) => `Codex config default (${model})`,

    unknownProvider: (id) => `Unknown provider: ${id}`,
    unavailable: (provider, reason) => (reason ? `${provider} isn't available: ${reason}` : `${provider} isn't available`),
    modelInvalid: 'Invalid model name',
    modelNameInvalid: (model) => `Invalid model name: ${model}`,
    effortInvalid: 'Invalid reasoning effort',
    noEffortChoice: (provider) => `${provider} doesn't let you choose the reasoning effort`,
    unknownEffort: (effort) => `Unknown reasoning effort: ${effort}`,
    effortUnsupported: (effort) => `This model doesn't support the reasoning effort ‘${effort}’`,

    cannotCheck: "Couldn't check.",
    unknownState: 'Unknown state.',
    cliNotFound: (name, hint) => `${name} CLI not found (PATH). ${hint}`.trim(),
    versionTimeout: (name) => `${name} --version didn't respond.`,
    versionFailed: (name, detail) => `${name} --version failed: ${detail}`.trim(),
    runFailed: (name, error) => `Couldn't run ${name}: ${error}`,
    batchFile: (file) =>
      `${file} is a batch file and can't be run directly. ` +
      'Install it with the official installer, or set CLAUDE_BIN / CODEX_BIN to the path of the real executable (.exe).',
    apiKeyMissing: (envName) => `The ${envName} environment variable isn't set.`,

    executableNotFound: (name) => `The ${name} executable wasn't found (check PATH).`,
    notExecutable: (name, file) => `No permission to run ${name} (${file}).`,
    spawnFailed: (name, error) => `Couldn't run ${name}: ${error}`,
    slideImageUnreadable: (file, error) => `Couldn't read the slide image: ${file} (${error})`,
    aborted: 'The request was stopped.',

    thinking: 'Thinking…',
    readingFile: (file) => `Reading file: ${file}`,
    findingFiles: (pattern) => `Finding files: ${pattern}`,
    searchingText: (pattern) => `Searching text: ${pattern}`,
    usingTool: (tool) => `Using tool: ${tool}`,
    unknownTool: 'unknown',
    unknownFile: '(unknown)',
    runningCommand: (command) => `Running command: ${command}`,
    searchingWeb: 'Searching the web…',
    warning: (message) => `Warning: ${message}`,

    claude: {
      installHintWindows: 'Install Claude Code (PowerShell): irm https://claude.ai/install.ps1 | iex  or  winget install Anthropic.ClaudeCode',
      installHint: 'Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash  (or npm install -g @anthropic-ai/claude-code)',
      loginHint: 'Run `claude` in a terminal to check that you are logged in.',
      resumeInvalid: "The previous Claude Code conversation (session) can't be found anymore. A new conversation is needed.",
      contextOverflow: 'The conversation is larger than the model can take at once. It needs to continue in a new conversation.',
      modelUnavailable:
        "The selected model isn't available in this Claude Code. Choose another model, or update the CLI with `claude update` in a terminal.",
      error: (message) => `Claude Code error: ${message}`,
      crashed: (exit) => `Claude Code exited abnormally (${exit}).`,
      noResult: 'Claude Code exited without a result.',
    },
    codex: {
      installHintWindows:
        'Install the Codex CLI (PowerShell): powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      installHint: 'Install the Codex CLI: curl -fsSL https://chatgpt.com/codex/install.sh | sh  (or npm install -g @openai/codex)',
      threadReplaced: (previous, started) =>
        `Codex couldn't find the previous conversation (thread ${previous}) and started a new one (thread ${started}).`,
      loginHint: 'Run `codex login` in a terminal to check that you are logged in.',
      resumeInvalid: "The previous Codex conversation (thread) can't be continued anymore. A new conversation is needed.",
      contextOverflow: "The conversation exceeded the model's context limit. It needs to continue in a new conversation.",
      modelUnavailable: "The selected model isn't available in this Codex. Set another model, or update the Codex CLI.",
      confinementHint:
        "Codex may not have been able to start with the read restriction (reading only this course's lecture folders). " +
        "Update the Codex CLI, and if that doesn't help, restart the server with EASY_STUDY_CODEX_CONFINE=0 " +
        '(Codex can then read every file on the computer).',
      error: (message) => `Codex error: ${message}`,
      crashed: (exit) => `Codex exited abnormally (${exit}).`,
      noResponse: 'Codex exited without a response.',
      noThreadId: "Codex didn't report a thread id.",
    },
    anthropic: {
      requestTooLarge: (mb) => `The Anthropic API request is too large (about ${mb} MB, the limit is 32 MB).`,
      tooManyImages: 'The conversation has collected too many images and needs to continue in a new conversation.',
      nearContextLimit: (model, windowK, estimateK) =>
        `The conversation is close to the context limit of the model (${model}, ${windowK}K tokens; about ${estimateK}K tokens used). It needs to continue in a new conversation.`,
      continuedByOtherModel: 'Another model is continuing the answer…',
      connectFailed: (message) => `Couldn't connect to the Anthropic API: ${message}`,
      authFailed: 'Anthropic API authentication failed. Check ANTHROPIC_API_KEY.',
      permissionDenied: (message) => `Anthropic API permission error: ${message}`,
      notFound: (message) => `Anthropic API: model or path not found (${message})`,
      rateLimited: 'The Anthropic API rate limit was exceeded. Try again in a moment.',
      tooLargeForModel: (message) => `Anthropic API: the conversation is too large for the model (${message})`,
      badRequest: (message) => `Anthropic API request error: ${message}`,
      error: (status, message) => (status ? `Anthropic API error (${status}): ${message}` : `Anthropic API error: ${message}`),
      refused: (category) =>
        category
          ? `The model declined to answer this request (${category}). Rephrase the question and try again.`
          : 'The model declined to answer this request. Rephrase the question and try again.',
      contextFull: "The conversation filled the model's context limit, so no answer could be written. It needs to continue in a new conversation.",
      cutOffByContext: 'The answer stopped partway because the context limit was reached.',
    },
    openai: {
      endedEarly: (reason) => `The response stopped partway (${reason})`,
      failed: "Couldn't generate a response.",
      previousResponseNotFound: (detail) =>
        `OpenAI API: the previous response (previous_response_id) wasn't found. The stored conversation expired or was deleted (${detail})`,
      contextOverflow: (detail) => `OpenAI API: the conversation exceeded the model's context limit (${detail})`,
      permissionDenied: (detail) => `OpenAI API permission error: ${detail}`,
      authFailed: 'OpenAI API authentication failed. Check OPENAI_API_KEY.',
      modelUnavailable: (detail) => `OpenAI API: the model wasn't found or isn't available (${detail})`,
      rateLimited: (detail) => `The OpenAI API rate limit was exceeded: ${detail}`,
      badRequest: (detail) => `OpenAI API request error: ${detail}`,
      notFound: (detail) => `OpenAI API: the requested item wasn't found (${detail})`,
      error: (status, detail) => (status ? `OpenAI API error (${status}): ${detail}` : `OpenAI API error: ${detail}`),
      connectFailed: (message) => `Couldn't connect to the OpenAI API: ${message}`,
      incomplete: "The OpenAI API response didn't complete.",
      noResponseId: "The OpenAI API didn't report a response id.",
    },
  },
  turns: {
    slideRequired: 'A slide number is required',
    questionRequired: 'Enter a question',
    questionTooLong: (max) => `The question is too long (${max} characters max)`,
    memosNotBoolean: 'memos must be true or false',
    neighborsInvalid: (max) => `neighbors must be an integer from 0 to ${max}`,
    busy: 'This session is writing an answer. Try again when the answer is done',
    alreadyAnswering: 'This session is already writing an answer',
    waitingForSlot: 'Waiting for another answer to finish…',
    recovery: {
      resumeInvalid: "The previous conversation can't be continued, so a new one is starting",
      contextOverflow: 'The conversation got too long, so it continues in a new one',
    },
    aborted: 'The answer was stopped',
    abortedByUser: 'You stopped the answer',
    abortedByShutdown: 'Stopped because the server shut down',
    clientGone: 'Stopped because the connection to the client was lost',
    interrupted: "The server stopped, so the answer wasn't completed",
    stopped: 'Stopped',
  },
  sessions: {
    defaultTitle: (_date, _time, at) => `Session ${sessionStamp(at)}`,
    regionAlt: (slide) => `p.${slide} region`,
    imageAlt: 'image',
  },
  digest: {
    alreadyRunning: 'The digest is already being made',
    forceNotBoolean: 'force must be true or false',
    notYet: 'There is no digest yet',
    aborted: 'Making the digest was stopped',
    abortedByUser: 'You stopped making the digest',
    abortedByShutdown: 'Making the digest was stopped because the server shut down',
    interrupted: 'Making the digest was interrupted because the server stopped. You can continue it',
    notInOutput: (slides) => `Couldn't find the digest of ${slides.length === 1 ? 'slide' : 'slides'} ${slides.join(', ')} in the model output`,
    slideFailed: (reason) => (reason ? `Couldn't make the digest of this slide: ${reason}` : "Couldn't make the digest of this slide"),
    slideUnparsed: "Couldn't make the digest of this slide. Try making it again.",
    emptySummary: 'The model returned an empty summary',
    failed: "Couldn't make the digest",
    slidesFailed: (slides) =>
      `Couldn't make the digest of ${slides.length === 1 ? 'slide' : 'slides'} ${slides.join(', ')} (continue the digest to try again)`,
    summaryFailed: (error) => `Couldn't make the lecture summary: ${error}`,
    markdown: {
      title: (lecture) => `${lecture} — digest`,
      incomplete: (done, total) => `Incomplete digest: ${done}/${total} ${total === 1 ? 'slide' : 'slides'}`,
      summary: 'Lecture summary',
      slideFailed: 'The automatic digest failed for this slide.',
    },
  },
} satisfies typeof ko;
