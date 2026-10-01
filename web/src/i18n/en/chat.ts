// English — namespace `chat` (the Korean reference: ../ko/chat.ts).
import type { chat as ko } from '../ko/chat.ts';
import { rich } from '../rich.ts';

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const slides = (n: number): string => plural(n, 'slide', 'slides');
const attachments = (n: number): string => plural(n, 'attachment', 'attachments');
/** "all 49 slides" (a deck of one: "the slide"). */
const allSlides = (n: number): string => (n === 1 ? 'the slide' : `all ${n} slides`);
const lectures = (n: number): string => plural(n, 'earlier lecture', 'earlier lectures');
const running = (n: number): string => (n > 0 ? ` (${plural(n, 'digest', 'digests')} in progress)` : '');
/** Which summaries of the earlier lectures the LLM gets (the course badge's tooltip). */
const summariesOf = (withSummary: number, total: number): string => {
  if (withSummary === total) {
    if (total === 1) return 'the summary of the earlier lecture';
    return total === 2 ? 'the summaries of both earlier lectures' : `the summaries of all ${total} earlier lectures`;
  }
  if (withSummary === 0)
    return total === 1 ? 'the summary of the earlier lecture once it has a digest' : `the summaries of the ${total} earlier lectures once they have digests`;
  return withSummary === 1
    ? `the summary of 1 of the ${total} earlier lectures (the one with a digest)`
    : `the summaries of ${withSummary} of the ${total} earlier lectures (those with a digest)`;
};

export const chat = {
  shared: {
    currentSlideOnly: 'Current slide only',
    refresh: 'Refresh',
    goToThisSlide: 'Go to this slide',
    goToSlide: (n) => `Go to slide ${n}`,
    copyFailed: "Couldn't copy",
    pathCopied: 'Path copied',
    pathCopiedRemote: "Copied the path (it's on the server computer)",
    pathTitle: 'Click to copy the path',
    pathTitleRemote: 'A path on the server computer. Click to copy',
    noLlm: 'No LLM available',
    noLlmSentence: 'No LLM available.',
    noLlmToast: 'No LLM is available. Check the model choice at the top.',
    stop: 'Stop',
    answerFailed: (error) => (error ? `Answer failed: ${error}` : 'Answer failed'),
    answerAborted: 'This answer was stopped',
    answerUnfinished: "This answer isn't finished yet",
  },

  llm: {
    effortNames: {
      none: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'very high',
      max: 'max',
      ultra: 'ultra',
    },
    reasoning: (effort) => `${effort} reasoning`,
    switchMarker: (name) => `From here: ${name}`,
    switchMarkerTitle: (time, from, to) =>
      `LLM changed at ${time}: ${from} → ${to}. The new LLM gets the slides and a summary of the recent conversation again, then carries on.`,
    switchNotice: (name) =>
      `${name} answers from your next question on. The slides and a summary of the recent conversation are sent again, so the first question uses more tokens.`,
  },

  context: {
    resumeInvalid: 'Earlier conversation lost, resent in a new one',
    resumeInvalidTitle:
      "The LLM couldn't continue the earlier conversation (expired, deleted, …), so a new one was started and the slides and a summary of the recent conversation were sent again before answering.",
    contextOverflow: 'Conversation too long, continued in a new one',
    contextOverflowTitle:
      'The LLM conversation got too long, so a new one was started and the slides and a summary of the recent conversation were sent again before answering.',
    switched: 'New conversation with the new LLM',
    switchedTitle:
      'The LLM was changed, so a new conversation was started and the slides and a summary of the recent conversation were sent again before answering.',
    rollover: 'Continued in a new conversation',
    deckUpdated: 'Restarted with the new slides',
    deckUpdatedTitle:
      'The lecture PDF was replaced by a new version, so a new conversation was started and the new slides and a summary of the recent conversation were sent again before answering.',
    primed: 'All slides sent',
    overviewImages: (n) => plural(n, 'overview image', 'overview images'),
    attached: (pages) => `${pages} attached`,
    reused: (pages) => `${pages} already sent`,
    attachments: (n) => attachments(n),
    attachmentsTitle: 'Selected regions and images sent with the question (a selected region also sends the text inside it)',
    memos: (n) => plural(n, 'memo', 'memos'),
    memosTitle: 'Your memos on this slide and the neighboring slides were sent to the tutor too',
  },

  primeCard: {
    sending: (n) => `Sending ${allSlides(n)} to the LLM…`,
    sent: (n) => `Sent ${allSlides(n)} to the LLM`,
    failed: (n) => `Couldn't send ${allSlides(n)} to the LLM`,
    aborted: (n) => `Stopped sending ${allSlides(n)}`,
    unknown: (n) => `Couldn't tell if ${allSlides(n)} reached the LLM`,
  },

  course: {
    opensFiles: " When needed, it also opens the earlier lectures' files (digests, slides).",
    first: (course, index) => `Lecture ${index} of ${course}.`,
    allSummaries: (course, index, total) =>
      total === 1
        ? `Lecture ${index} of ${course}, so the summary of the earlier lecture is sent too.`
        : `Lecture ${index} of ${course}, so the summaries of the ${total} earlier lectures are sent too.`,
    noSummaries: (course, index, total, n) =>
      total === 1
        ? `Lecture ${index} of ${course} — the earlier lecture has no summary yet, so only its title is sent${running(n)}.`
        : `Lecture ${index} of ${course} — none of the ${total} earlier lectures has a summary yet, so only their titles are sent${running(n)}.`,
    someSummaries: (course, index, total, withSummary, n) => {
      const sent =
        withSummary === 1
          ? `1 of the ${lectures(total)} has a summary, which is sent`
          : `${withSummary} of the ${lectures(total)} have summaries, which are sent`;
      const rest = total - withSummary === 1 ? 'for the other one only the title is sent' : 'for the others only the titles are sent';
      return `Lecture ${index} of ${course} — ${sent}; ${rest}${running(n)}.`;
    },
    summariesLater: ' A lecture gets its summary once its digest is finished.',
    badgeTitle: (course, index) => `Lecture ${index} of the course ‘${course}’ (click for COURSE.md)`,
    badgeTitleSummaries: (course, index, total, withSummary) =>
      `Lecture ${index} of the course ‘${course}’ — the LLM also gets ${summariesOf(withSummary, total)} (click for COURSE.md)`,
    badge: (index, total) => `Lecture ${index}/${total}`,
  },

  panel: {
    tabs: {
      chat: 'Chat',
      digest: 'Digest',
      notes: 'Notes',
      memos: 'Memos',
      memosTitle: 'Memos on the slides',
      recordings: 'Recordings',
      recordingsTitle: 'Lecture recordings and transcripts',
      digestDone: 'Done',
      digestPartial: 'Partial',
    },
    creating: 'Creating a new session…',
    emptyTitle: 'Ask anything',
    llmFallback: 'the LLM',
    deck: (n) => allSlides(n),
    emptyIntro: (llm, deck, digestReady, neighbors) =>
      rich(
        'Your first question starts a new session with ',
        llm,
        ', which first gets ',
        deck,
        digestReady ? ' (as digest text)' : '',
        " and then explains the slide you're viewing",
        neighbors > 0 ? ` (plus ${plural(neighbors, 'slide', 'slides')} before and after)` : '',
        '.',
      ),
    digestEarlier: (n) => `Make digests of ${lectures(n)}`,
    startSession: '＋ Start a new session (sends the slides)',
    tipKeys: (j, k, up, down, slash) =>
      rich('Press ', j, '/', k, ' or ', up, '/', down, ' to move between slides and ', slash, ' to type a question'),
    tipPin: 'Pin a slide to keep asking about it while you scroll',
    tipNotes: 'Every Q&A is saved to a file; the ‘Notes’ tab shows them again by slide',
    tipDigest: "The ‘Digest’ tab has the LLM's transcription and explanation of each slide",
    loadingSession: 'Loading the session…',
    notPrimed: "This session hasn't received the slides yet.",
    primeAll: 'Send all slides',
    primeLater: "You can also just ask — they're sent with your first question.",
    typeQuestion: 'Type a question.',
    viewedSlide: "The slide you're viewing",
    unpinTitle: "Unpin — ask about the slide you're viewing again",
    pinTitle: 'Pin this slide — keep asking about it while you scroll',
    pinned: (slide) => `p.${slide} pinned`,
    pin: 'Pin',
    neighborsTitle: 'Also sends the neighboring slides to the LLM with each question (useful when a topic spans several slides)',
    neighbors: 'Neighbors',
    neighborsLabel: 'Neighboring slides to send along',
    switchLabel: (llm) => `Change LLM (now: ${llm})`,
    switchTitle: (llm) => `This session's LLM: ${llm} — click to change it`,
    switchTitleRunning: (llm) => `This session's LLM: ${llm} — you can change it once the answer is done`,
    closeNotice: 'Dismiss',
  },

  messages: {
    showOlder: (n) => (n === 1 ? 'Show 1 earlier message' : `Show ${n} earlier messages`),
    showAll: (n) => `Show all (${n})`,
    latest: 'Latest messages',
    contextTitle: 'What was sent to the LLM with this question',
    sending: 'Sending…',
    copied: 'Answer copied',
    overview: 'Slide overview',
    tutor: 'Tutor',
    copyTitle: 'Copy as Markdown',
    requesting: 'Sending the request…',
    readingSlides: 'Reading the slides…',
    thinking: 'Thinking…',
    stopping: 'Stopping…',
    unfinishedElsewhere: "This answer isn't finished yet (still running in another window, or interrupted)",
    retryWithAttachments: (n) => `Sends it again with ${attachments(n)}`,
    retry: 'Ask again',
    retryPrimeTitle: 'Sends the slides to the LLM again (or just ask: they go with your first question)',
    retryPrime: 'Send again',
  },

  composer: {
    quickPrompts: ['Explain this slide', 'Key points only', 'Explain with an example', 'Quiz me'],
    quickPromptsLabel: 'Quick questions',
    memosIncluded: (n) => `${plural(n, 'memo', 'memos')} included`,
    memosIncludedTitle: 'Sends your memos on this slide and the neighboring slides to the tutor (turn off in Settings › Study)',
    stillUploading: "Your images are still uploading. Send when they're done.",
    withNeighbors: (from, to) => ` (p.${from}–${to} sent too)`,
    placeholderRunning: 'Waiting for the answer… (you can write your next question now)',
    placeholderAttachments: (n, question) => `${attachments(n)} · leave empty to ask “${question}”`,
    placeholderTouch: (slide) => `Ask about p.${slide}`,
    placeholder: (slide) => `Ask about p.${slide} · Enter to send · Shift+Enter for a new line`,
    sendWithAttachments: (n) => `Sends with ${attachments(n)}`,
    attachLabel: 'Attach images',
    attachTitle: 'Attach images — you can also paste (⌘/Ctrl+V) or drag and drop. Drag on a slide to attach that region',
    targetPinned: 'Asks about the pinned slide (click to go there)',
    targetFocused: "Asks about the slide you're viewing",
    inputLabel: 'Your question',
    stopTitle: 'Stop the answer',
    uploadingTitle: 'Uploading your images…',
    sendTitle: 'Send (Enter)',
    attaching: 'Attaching…',
    send: 'Send',
  },

  attachments: {
    imageNeedsLecture: 'Open a lecture first, then drop images to attach them to a question',
    dropRefused: (formats, names) => `You can only drop PDFs (to add lectures) or images (${formats}, to attach to a question): ${names}`,
    pdfOnly: (names) => `Only PDF files can be uploaded: ${names}`,
    dropImage: 'Drop images to attach them to your question',
    dropImageWithPdf: 'Drop images to attach them to your question (PDFs are only added to the lectures)',
    dropMaybeImage: 'Images are attached to your question',
    kinds: {
      memo: 'memo',
      highlight: 'highlight',
      textHighlight: 'highlight',
      text: 'text',
      rect: 'rectangle',
      ellipse: 'circle',
    },
    kindTitles: {
      memo: (where) => `Memo on ${where}`,
      highlight: (where) => `Highlighted area on ${where}`,
      textHighlight: (where) => `Highlighted text on ${where}`,
      text: (where) => `Text box on ${where}`,
      rect: (where) => `Area marked with a rectangle on ${where}`,
      ellipse: (where) => `Area marked with a circle on ${where}`,
    },
    onSlide: (n) => `slide ${n}`,
    someSlide: 'the slide',
    regionTitle: (where) => `Region selected on ${where}`,
    onPage: (slide, what) => `p.${slide} ${what}`,
    onRemovedPage: (slide, what, old) => `p.${slide} ${what} (removed p.${old})`,
    region: 'region',
    selectedRegion: 'Selected region',
    image: 'Image',
    pastedImage: 'Pasted image',
    imageTitle: 'Attached image',
    imageTitleNamed: (name) => `Attached image: ${name}`,
    explainRegion: 'Explain this part',
    explainImage: 'Explain the attached image',
    limit: (max, refused) =>
      `You can attach up to ${max} items to a question${refused > 0 ? ` (${refused} not attached)` : ''}`,
    tooLarge: (mb) => `The image is too large (max ${mb} MB)`,
    tooLargeFile: (mb, name, size) => `The image is too large (max ${mb} MB): ${name} (${size})`,
    unsupported: (formats) => `Unsupported image format (${formats})`,
    onlyImages: (formats, names) => `Only ${formats} images can be attached: ${names}`,
    docNotReady: "The document isn't ready yet",
    docNotFound: "Couldn't find the document",
    missing: (labels) =>
      `The question wasn't sent: the server no longer has these attachments (${labels}). Attachments not used in a question are deleted after 24 hours — send it again without them.`,
    missingCount: (n) =>
      `The question wasn't sent: the server no longer has ${n === 1 ? 'one of its attachments' : `${n} of its attachments`}. Attachments not used in a question are deleted after 24 hours — send it again without them.`,
    attachFailed: (label, message) => `Couldn't attach ${label}: ${message}`,
    regionFailed: (message) => `Couldn't attach the region: ${message}`,
    annotationFailed: (message) => `Couldn't attach the annotation: ${message}`,
    alreadyAttached: 'Already attached to your question',
    someAlreadyAttached: (n) => (n === 1 ? '1 was already attached' : `${n} were already attached`),
    imageLoadFailed: "Couldn't load the image",
    openRegionTitle: (title) => `${title} — click to enlarge it and show where it is on the slide`,
    openImageTitle: (title) => `${title} — click to enlarge`,
    chipsLabel: 'Attachments for your question',
    cropping: 'Cropping the region…',
    uploading: (percent) => `Uploading… ${percent}%`,
    removeLabel: (label) => `Remove ${label}`,
    removeTitle: 'Remove attachment',
    showOnSlide: (slide) => `Show on p.${slide}`,
    closeTitle: 'Close (Esc)',
    regionText: (empty) => `Text in the selected region${empty ? ' (none)' : ''}`,
    noPdfText: 'This region has no PDF text. The LLM reads it as an image.',
  },

  usage: {
    line: (input, cached, output) => `${input} in${cached ? ` (${cached} cached)` : ''} · ${output} out`,
    answerHeading: 'Tokens used by this answer',
    input: (n) => `Input ${n}`,
    cacheRead: (n) => `  Read from cache ${n}`,
    cacheWrite: (n) => `  Written to cache ${n}`,
    output: (n) => `Output ${n}`,
    reasoning: (n) => `  Reasoning ${n}`,
    total: (n) => `Total ${n}`,
    sessionHeading: 'Tokens used in this session (including sending the slides and failed or stopped answers)',
    sessionPriming: (n) => `Of these, sending the slides: ${n}`,
    unrecorded: (n) =>
      n === 1
        ? "1 answer without recorded tokens isn't included (e.g. one made before tokens were recorded)"
        : `${n} answers without recorded tokens aren't included (e.g. ones made before tokens were recorded)`,
    session: (n) => `This session: ${n} tokens`,
    weekly: 'Weekly',
    days: (n) => `${n}-day`,
    hours: (n) => `${n}-hour`,
    minutes: (n) => `${n}-minute`,
    windowOf: (name, label) => `${name} (${label})`,
    reached: 'Usage limit reached',
    near: 'Near the usage limit',
    limit: (name, first, percent, resets) => `${name}${first ? ' limit' : ''} ${percent}%${resets ? ` (resets ${resets})` : ''}`,
    asOf: (time) => `as of ${time}`,
    limitsHeading: (provider, time) => `${provider} usage limits (as of ${time})`,
    windowLine: (name, percent, resets) => `${name} limit: ${percent}% used${resets ? ` · resets ${resets}` : ''}`,
    reachedNote: "You've reached the limit. You may not get answers until it resets.",
    nearNote: "You're close to the limit.",
  },

  notes: {
    clearFilter: 'Clear filter',
    onlySlide: (slide) => `Only p.${slide}`,
    collapseAll: 'Collapse all',
    expandAll: 'Expand all',
    openFile: 'Open STUDY_NOTES.md',
    loadFailed: (error) => `Couldn't load the notes: ${error}`,
    empty: 'No saved Q&A yet.',
    emptyHint: 'Questions you ask in the chat are saved here by slide.',
    noneForSlide: (slide) => `No Q&A for p.${slide} yet.`,
    slideAlt: (n) => `Slide ${n}`,
    count: (n) => (n === 1 ? '1 Q&A' : `${n} Q&As`),
    attachmentsTitle: (n) => `${attachments(n)} (selected regions, images)`,
    noAnswer: '(no answer)',
  },

  memos: {
    deleteTitle: 'Delete this memo?',
    alreadyDeleted: 'That memo was already deleted',
    search: 'Search memos and tags',
    tagFilter: 'Filter by tag',
    clearTag: 'Clear tag filter',
    onlyTag: (tag) => `Show only #${tag} memos`,
    loadFailed: (error) => `Couldn't load the memos: ${error}`,
    empty: 'No memos yet.',
    emptyHint:
      'Use the memo tool in the toolbar above the slides to stick a memo on a slide. Memos can have tags and link to other slides or recordings.',
    noMatch: 'No memos match.',
    none: 'No memos.',
    openTitle: 'Open this memo on its slide',
    hiddenFromTutor: 'Hidden from tutor',
    playTitle: 'Play this moment of the recording (Recordings tab)',
    menu: 'Memo menu',
    openOnSlide: 'Open on slide',
    delete: 'Delete memo',
  },

  digest: {
    redoConfirm: {
      title: 'Make the digest again from scratch?',
      message: 'Every slide is shown to the LLM and digested again (this takes time and uses your LLM quota).',
      confirmLabel: 'Redo',
    },
    startTitle: (llm) => `Uses ${llm} — change the LLM under ‘New session’ at the top`,
    madeWith: (llm) => `Uses ${llm} · may take a few minutes`,
    outdated: 'This summary was made before the slide digests changed. Use ‘Redo lecture summary’ above to make a new one.',
    loadFailed: (error) => `Couldn't load the digest: ${error}`,
    introTitle: 'No digest yet',
    slides: (n) => slides(n),
    intro: (count) =>
      rich(
        'The LLM reads the images of the ',
        count,
        ' itself, transcribes them as they are (formulas, tables and code included), then adds explanations and key points. Once made, the digest is reused.',
      ),
    tipFaster: 'New sessions get this text instead of the images, which is faster and cheaper',
    tipFormulas: 'Formulas, tables and symbols (α, ε, ∪, ∈ …) that text extraction garbles are read accurately from the images',
    tipCourse: "In a course, this lecture's summary is sent along when you study the next lectures",
    tipAuto: 'It starts by itself when you create the first session',
    make: 'Make digest',
    stillRunning: (done, total) => ` Still being digested (${done} / ${total} done)`,
    notYet: " This slide isn't digested yet. Use ‘Continue’ to fill it in.",
    wholeSummary: (outdated) => `Summary of the whole lecture${outdated ? ' (earlier summary)' : ''}`,
    summary: 'Lecture summary',
    noSummary: 'No lecture summary yet.',
    mode: 'Digest view',
    modeCurrent: 'Current slide',
    modeAll: 'All',
    tokensTitle: 'Tokens used to make this digest (including failed calls)',
    tokens: (n) => `${n} tokens`,
    redo: 'Redo',
    openFile: 'Open DIGEST.md',
    hint: 'New sessions reuse the digest instead of the slide images, which is faster and cheaper.',
    refreshFailed: (error) => `Couldn't refresh: ${error}`,
    untitled: '(untitled)',
    slideFailed: "Couldn't digest this slide — try again with ‘Continue’",
    waiting: 'Waiting…',
    notDigested: 'Not digested yet',
    continue: 'Continue',
    retryFailed: 'Retry failed slides',
    redoSummary: 'Redo lecture summary',
    makeSummary: 'Make lecture summary',
    statusRunning: 'Making digest',
    statusFailed: (n) => `Digest · ${n} failed`,
    statusPartial: 'Digest (partial)',
    statusSummaryOutdated: (n) => `Digest done · ${slides(n)} · summary needs updating`,
    statusNoSummary: (n) => `Digest done · ${slides(n)} · no summary`,
    statusComplete: (n) => `Digest done · ${slides(n)}`,
    statusAborted: 'Stopped',
    statusError: 'Stopped by an error',
    statusNone: 'Digest',
    hintOutdated:
      'The lecture summary shown was made before the slide digests changed. Use ‘Redo lecture summary’ to redo just the summary.',
    hintMissing: 'Use ‘Make lecture summary’ to make just the summary.',
    done: 'The digest is done',
    doneWithFailures: (n) => `Digest made (${plural(n, 'slide', 'slides')} failed)`,
    failed: (error) => `Couldn't make the digest: ${error}`,
    alreadyRunning: 'The digest is already being made.',
    startFailed: (error) => `Couldn't start the digest: ${error}`,
    abortFailed: (error) => `Couldn't stop the digest: ${error}`,
  },

  session: {
    listFailed: (error) => `Couldn't load the sessions: ${error}`,
    loadFailed: (error) => `Couldn't load the session: ${error}`,
    connectionLostReload: 'Lost the connection to the server. Reloading the conversation.',
    connectionLost: (error) => `Connection lost: ${error}`,
    createFailed: (error) => `Couldn't create the session: ${error}`,
    primeFailed: "Couldn't send the slides to the LLM, so the question wasn't sent. Please try again.",
    switchWhileRunning: 'You can change the LLM once the answer is done.',
    switchFailed: (error) => `Couldn't change the LLM: ${error}`,
    deleteWhileRunning: "A session can't be deleted while an answer is being written.",
    deleteFailed: (error) => `Couldn't delete the session: ${error}`,
    deleted: 'Session deleted.',
  },

  docs: {
    processingFailed: (title, error) => `Couldn't process ‘${title}’: ${error}`,
    uploadFailed: (name, error) => `Upload failed (${name}): ${error}`,
    retryFailed: (error) => `Couldn't convert it again: ${error}`,
    renameFailed: (error) => `Couldn't rename it: ${error}`,
    deleteBusy: "It can't be deleted while a conversion, a digest or an answer is running. Try again when it's done.",
    deleteFailed: (error) => `Couldn't delete it: ${error}`,
  },

  markdown: {
    externalImage: 'External image',
    blockedImageTitle: (url) => `External images aren't loaded automatically — click to open in a new tab: ${url}`,
  },
} satisfies typeof ko;
