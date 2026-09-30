// English — namespace `recording` (the Korean reference: ../ko/recording.ts).
import { rich } from '../rich.ts';
import type { recording as ko } from '../ko/recording.ts';

export const recording = {
  status: {
    recording: 'Recording',
    paused: 'Paused',
    converting: 'Converting',
    convertingTitle: 'Extracting the audio from the uploaded file',
    error: 'Error',
    queued: 'Waiting to transcribe',
    queuedTitle: "Another recording is being transcribed. This one starts when it's its turn",
    transcribing: 'Transcribing',
    transcribingPercent: (percent) => `Transcribing ${percent}%`,
    transcribed: 'Transcribed',
    transcriptFailed: 'Transcription failed',
    notTranscribed: 'Not transcribed',
  },

  alignment: {
    timeline: 'By viewed slides',
    timelineTitle: 'Split by the slides you were viewing while recording (adjusted a little by what was said)',
    lexical: 'Auto-aligned',
    lexicalTitle: 'Split by comparing what was said with the text on the slides',
    llm: 'AI-aligned',
    llmTitle: 'Split by an LLM comparing what was said with the slides',
  },

  defaultModel: 'Default model',
  durationLive: (total, transcribed) => `${total} · transcribed up to ${transcribed}`,

  languages: {
    ko: 'Korean',
    en: 'English',
    auto: 'Auto-detect',
  },
  detectedLanguages: {
    ko: 'Korean',
    en: 'English',
    ja: 'Japanese',
    zh: 'Chinese',
  },
  autoDetected: (language) => `Auto-detected (${language})`,

  asr: {
    engineMissing: "Couldn't find the speech recognition engine (whisper.cpp).",
    noModel: 'No speech recognition model is available.',
    blockedEngine: (reason) => `The recording is saved, but it can't be transcribed yet: ${reason}`,
    blockedModel: (model, size) =>
      `The speech recognition model for transcripts isn't downloaded yet: ${model} (${size}). ` +
      'Once you download it in the Recordings tab, transcription starts — the recording goes on meanwhile.',
  },

  mic: {
    privacySetting: {
      mac: 'System Settings › Privacy & Security › Microphone',
      windows: 'Settings › Privacy & security › Microphone (also turn on ‘Let desktop apps access your microphone’)',
      linux: "your system's sound settings",
      ios: 'Settings › Privacy & Security › Microphone',
      android: 'Settings › Apps › Permissions › Microphone',
      other: "your operating system's privacy (microphone) settings",
    },
    notAllowed: (setting) =>
      "Microphone access isn't allowed. Allow the microphone for this site from the microphone icon in the address bar, " +
      `and check that this app (or browser) is turned on in ${setting}.`,
    notAllowedMac: "If it's on and still doesn't work, turn it off and on again (this can happen after an app update).",
    notFound: "Couldn't find a microphone. Check that one is connected.",
    notFoundLinux: "Couldn't find a microphone. Check that one is connected and that the audio server (PipeWire or PulseAudio) is running.",
    notReadable: "Can't open the microphone. Check that no other app (a video call, for example) is using it, and try again.",
    notSupported: "This browser doesn't support 16 kHz recording. Use a recent Chrome, Edge or Safari, or the easy-study app.",
    failed: "Couldn't start the microphone",
    failedDetail: (detail) => `Couldn't start the microphone: ${detail}`,
    disconnected: 'The microphone was disconnected. Recording is paused — check the microphone and press ‘Resume’.',
    silent: 'No sound is coming from the microphone (the system blocked it, or another app is using it).',
  },

  unavailable: {
    insecure: (origin) =>
      `This address (${origin}) isn't a secure connection (HTTPS), so the browser blocks the microphone. ` +
      'To record, open easy-study on the server computer (in the easy-study app or at http://127.0.0.1), ' +
      'connect to that computer with the easy-study app (the app records even on an http address), ' +
      'or connect over HTTPS (for example tailscale serve, or EASY_STUDY_TLS_CERT/KEY). Uploading recording files works here too.',
    noMediaDevices: "The microphone isn't available in this browser (or app window). Use a recent Chrome, Edge or Safari, or the easy-study app.",
    noAudioWorklet: 'This browser lacks a feature recording needs (AudioWorklet). Use a recent Chrome, Edge or Safari, or the easy-study app.',
  },

  consent: {
    title: 'Before you record a class',
    message:
      "Check your professor's and your school's rules on recording first. Don't record a class without permission.\n" +
      "Recordings are stored only on this computer (or the easy-study server you connected to), and they're transcribed there too. " +
      'You can delete recordings and transcripts in the Recordings tab at any time.',
    confirmLabel: 'Got it, start recording',
  },

  files: {
    notAudio: (name) => `‘${name}’ isn't an audio or video file.`,
    empty: (name) => `‘${name}’ is empty.`,
    tooLarge: (name, max) => `‘${name}’ is too large (max ${max}).`,
  },

  span: {
    seconds: (s) => `${s} sec`,
    minutes: (m, s) => (s > 0 ? `${m} min ${s} sec` : `${m} min`),
    hours: (h, m) => (m > 0 ? `${h} hr ${m} min` : `${h} hr`),
  },

  markers: {
    fromSlide: (slide) => `From here: p.${slide}`,
    fromHereOff: 'From here: off slides',
    toSlide: (slide) => `→ p.${slide}`,
    toOff: '→ off slides',
    saveFailed: (reason) => `Couldn't save the slide markers: ${reason}`,
  },

  asrSettings: {
    installed: 'Installed',
    downloading: 'Downloading',
    downloadFailed: 'Download failed',
    needsDownload: 'Needs download',
    recommended: 'Recommended',
    accelMetal: 'GPU (Metal)',
    accelVulkan: 'GPU (Vulkan)',
    cpuAfterGpuError: 'CPU · transcribing on the CPU after a GPU error',
    statusFailed: (error) => `Couldn't check speech recognition: ${error}`,
    problemHint: 'Recording and uploading still work; transcription starts once the engine is ready.',
    downloadingModel: (model, received, total) =>
      rich('Downloading the speech recognition model ', model, ` · ${received} / ${total}`),
    downloadingHint: 'You can record while it downloads. Transcription starts once the model is ready.',
    needsModel: (model, size) =>
      rich('Transcripts need a speech recognition model: ', model, ` (${size}). You only download it once.`),
    lastDownloadFailed: (error) => `The last download failed: ${error}`,
    download: 'Download',
    downloadAgain: 'Download again',
    modelStaysLocal: 'The model is stored only on the server computer, and transcription happens there (nothing is sent over the internet).',
    removeConfirm: {
      title: (model) => `Delete the ${model} model?`,
      message: (size) =>
        `This frees ${size} of disk space. To transcribe with this model, you'll need to download it again. Recordings and transcripts stay.`,
      confirmLabel: 'Delete model',
    },
    model: 'Speech recognition model',
    cpuHint: (model, size) =>
      rich("This computer transcribes without GPU acceleration (on the CPU). If it's slow, the smaller ", model, ` model (${size}) is several times faster.`),
    integratedGpuHint: (model, size) =>
      rich("This computer transcribes with integrated graphics. If it's slow, the smaller ", model, ` model (${size}) is faster.`),
    lectureLanguage: 'Lecture language',
    liveTranscribe: 'Transcribe while recording',
    liveTranscribeHint: 'when off, transcription runs after the recording ends (less load during class on a slow computer)',
    engine: 'Engine',
    none: 'none',
    fileConversion: 'File conversion (ffmpeg)',
    available: 'available',
    removeModel: (model) => `Delete ${model}`,
    appliesHere: 'These settings apply to new recordings started on this device. For uploaded files, the server detects the language itself.',
    modelDownloadFailed: (reason) => `Couldn't download the speech recognition model: ${reason}`,
    modelRemoved: 'Deleted the speech recognition model.',
    modelRemoveFailed: (reason) => `Couldn't delete the model: ${reason}`,
  },

  speech: {
    chipTitle:
      'Sends the tutor what the professor said recently in the lecture being recorded (the transcript) along with your question. The transcript may contain errors.',
    recentMinutes: (minutes) => (minutes === 1 ? 'Last minute included' : `Last ${minutes} min included`),
    recordingPaused: 'Recording paused',
  },

  uploadBadge: (percent) => `Uploading recording ${percent}%`,

  bar: {
    start: 'Start recording',
    startTitle: 'Start recording — records this lecture and transcribes it as you go (the tutor also learns what the professor said)',
    startingMic: 'Starting the microphone…',
    savingTitle: 'Sending the rest of the recording to the server',
    saving: 'Saving recording…',
    savingLeft: (left) => `Saving recording · ${left} left`,
    loginToContinue: 'Log in to keep sending',
    offline: (unsent) => `Not connected to the server, kept on this device (${unsent})`,
    label: 'Recording',
    otherDocTitle: (lecture) => `Recording the lecture ‘${lecture}’ — click to go to it`,
    thisDocTitle: (title) => `Recording ‘${title}’ — click to open the Recordings tab`,
    paused: 'Paused',
    resume: 'Resume recording',
    pauseTitle: 'Pause (for a break, for example)',
    pause: 'Pause recording',
    stopTitle: 'Stop recording — the rest of the transcript and the slide alignment follow',
    stop: 'Stop recording',
  },

  strip: {
    label: 'Recording',
    interrupted: (title, saved) => rich('The recording ', title, ` stopped partway (saved up to ${saved}).`),
    interruptedSending: (title, saved, sending) =>
      rich('The recording ', title, ` stopped partway (saved up to ${saved} · sending ${sending} to the server).`),
    continue: 'Continue recording',
    finishHere: 'Finish here',
    finishHereTitle: 'Keep only what was recorded so far and finish the transcript',
    notPersistent:
      "This browser can't keep the recording on this device. If you reload or close the window, the part not yet sent to the server can be lost.",
    iosKeepOpen: 'Keep this screen on and open while recording (the recording stops if you switch apps or the screen turns off).',
    liveTitle: 'Live transcript',
    waitingFirst: 'Waiting for the first sentence…',
    behind: (lag) => `${lag} behind`,
    nearlyLive: 'Almost live',
    afterStop: 'Transcribed when the recording ends (you can change this in the settings)',
    recordingTab: 'Recordings tab',
    expandTitle: 'Show a few more recent lines',
    collapseTitle: 'Show only the last line',
    expand: 'Expand',
    collapse: 'Collapse',
  },

  transcript: {
    emptyLive: 'Transcribed sentences appear here…',
    empty: 'No transcribed sentences yet.',
    nothingOnSlide: 'Nothing was said on this slide.',
    nothingOnSlideYet: 'Nothing said on this slide yet.',
    offSlideTitle: 'Speech unrelated to the slides (announcements, small talk, …)',
    offSlide: 'Off slides',
    goToSlide: 'Go to this slide',
    playFromHere: 'Play from here',
    markTitle: (slide) =>
      `Mark this sentence as the start of the slide you're viewing (p.${slide}) — the sentences after it are realigned too`,
    playFrom: (time) => `Play from ${time}`,
    markerTitle: (marker) => `Marked by you: ${marker}`,
    markerOff: 'off-slide',
    sentenceMenu: (time) => `Menu of the sentence at ${time}`,
    offSlideHint: 'Announcements, small talk',
    removeMarker: 'Remove this marker',
  },

  panel: {
    liveChipTitle: 'Show the recording in progress (stop it from the recording bar at the top)',
    saving: 'Saving',
    recordingElsewhere: 'Another lecture is being recorded',
    startTitle: 'Record this lecture and transcribe it as you go',
    start: 'Record',
    uploadNoFfmpeg: "Recording files can't be uploaded: the server has no file conversion tool (ffmpeg)",
    uploadTitle: 'Upload a file you already recorded (audio or video) to transcribe it and match it to the slides',
    upload: 'Upload recording',
    settingsTitle: 'Transcript settings (model, language, live transcript)',
    refresh: 'Refresh',
    listFailed: (error) => `Couldn't load the recordings: ${error}`,
    emptyTitle: 'No recordings yet',
    emptyBody: (start, upload) =>
      rich('Press ', start, ' during class to record the lecture and transcribe it as you go. For a file you already recorded, use ', upload, '.'),
    tipAsk: 'Questions you ask while recording also send the tutor what the professor said in the last few minutes',
    tipSlides: 'Transcribed sentences are split by slide, and the tutor knows what was said on a slide when it explains it',
    tipReplay: 'Later, click a sentence to listen again from there, and the slides follow along',
    tipLocal: 'Transcription happens on the server computer (recordings are not sent over the internet)',
    list: 'Recordings',
  },

  detail: {
    noPlayableFile: 'There is no playable file yet.',
    audioErrors: {
      format: "Couldn't play it. This browser may not be able to play this format.",
      play: "Couldn't play it.",
      pressPlay: "Couldn't play it. Press the play button.",
      load: "Couldn't load the recording file.",
    },
    renameFailed: (reason) => `Couldn't rename it: ${reason}`,
    deleteConfirm: {
      title: (title) => `Delete the recording ‘${title}’?`,
      message:
        "The recording file, its transcript and the slide alignment will all be deleted. This can't be undone. The tutor won't use this recording anymore.",
      messageLive:
        "The recording stops and is deleted. The recording file, its transcript and the slide alignment will all be deleted. This can't be undone. The tutor won't use this recording anymore.",
      confirmLabel: 'Delete recording',
    },
    deleted: (title) => `Deleted the recording ‘${title}’.`,
    deleteFailed: (reason) => `Couldn't delete the recording: ${reason}`,
    markedOff: 'Marked from here as off slides and realigned.',
    markedSlide: (slide) => `Marked p.${slide} from here and realigned.`,
    finish: 'Stop recording',
    finishHint: 'Recorded on another device',
    clearMarkers: 'Remove all your markers',
    delete: 'Delete recording',
    nameLabel: 'Recording name',
    aligningTitle: 'The AI is aligning it',
    alignAfterTranscript: 'Available once the transcript is done',
    alignTitle: 'An LLM compares the transcript with the slides and splits it more precisely',
    aligning: 'AI aligning…',
    align: 'Precise AI alignment',
    menu: (title) => `Menu of the recording ‘${title}’`,
    manualMarkers: 'Marked by you',
    markersElsewhere: 'There are markers you set on another device (or browser). Marking here replaces them.',
    markers: 'Your markers:',
    markersRealigning: 'Your markers (realigning…):',
    removeMarkerAt: (time) => `Remove the marker at ${time}`,
    viewMode: 'Transcript view',
    currentSlide: (slide) => `Current slide (p.${slide})`,
    all: 'All',
    sentences: (n) => (n === 1 ? '1 sentence' : `${n} sentences`),
    transcriptFailed: (error) => `Couldn't load the transcript: ${error}`,
    pause: 'Pause',
    play: 'Play',
    position: 'Playback position',
    followTitle: 'While playing, the slide view moves to the slide being explained',
    follow: 'Follow slides',
    replayTitle: 'While playing, the slides show only the annotations (highlights, memos, …) made up to that moment',
    replay: 'Replay annotations',
    latestTitle: 'Reload up to the part being recorded now',
    latest: 'Latest',
    preparing: 'Preparing the file for playback…',
  },

  aiAlign: {
    started: "Precise AI alignment started. When it's done, the transcript's slide split will change.",
    failed: (reason) => `Couldn't start precise AI alignment: ${reason}`,
    intro: (marker) =>
      rich(
        'An LLM compares the transcript directly with the slides (with the digest, if there is one) and works out again which sentence explains which slide. Your markers (',
        marker,
        ') are kept. It takes a few minutes and uses your LLM quota.',
      ),
    noLlm: 'No LLM is available.',
    llmLabel: 'LLM for the alignment',
    starting: 'Starting…',
    start: 'Start alignment',
    model: (model) => `Model: ${model}`,
  },

  rate: {
    title: 'Playback speed',
    button: (rate) => `Playback speed ${rate}×`,
    reset: 'Reset to 1×',
    resetTitle: 'Back to normal speed (1×)',
    valueText: (rate) => `${rate}×`,
    sliderTitle: 'Snaps to the marks as you drag · ←→ by 0.05 · Double-click for 1×',
    notANumber: 'Enter the playback speed as a number (e.g. 1.25).',
    clamped: (min, max, rate) => `Playback speed goes from ${min}× to ${max}×, so it's set to ${rate}×.`,
    boxTitle: 'Type a playback speed (0.5–3, Enter to apply · Esc to cancel)',
    boxLabel: 'Playback speed (×)',
  },

  actions: {
    unavailableTitle: "Can't record over this connection",
    finishElsewhere: {
      titleBlocking: 'Another recording is still marked as in progress',
      title: (title) => `Stop the recording ‘${title}’ from here?`,
      message: (title, uploaded) =>
        `The recording ‘${title}’ is marked as in progress on another device (or browser) — the server has it up to ${uploaded}. ` +
        "If that device is still recording, stop it there. If you can't use that device anymore, you can stop it here: the recording ends with what the server has, and the transcript and slide alignment are finished. " +
        "Anything that device hasn't uploaded yet is lost.",
      blockingNote: 'After that, you can start a new recording.',
      confirmLabel: 'Stop that recording',
    },
    finishedBlocking: (title) => `Stopped the recording ‘${title}’. Now start recording again.`,
    finished: (title) =>
      `Stopped the recording ‘${title}’. You can listen to it once the rest of the transcript and the slide alignment are done.`,
    finishFailed: (reason) => `Couldn't stop the recording: ${reason}`,
    stopFailed: (reason) => `Couldn't stop the recording: ${reason}`,
  },

  uploads: {
    uploaded: (title, lecture) =>
      `Uploaded the recording ‘${title}’ to ‘${lecture}’. You'll find it in the Recordings tab once conversion and transcription are done.`,
    canceled: (name) => `Canceled the upload of ‘${name}’.`,
    tooLarge: (name) => `‘${name}’ is too large to upload.`,
    failed: (name, reason) => `Couldn't upload ‘${name}’: ${reason}`,
  },

  recorder: {
    allUploaded: (title) => `The recording ‘${title}’ is fully uploaded. You'll find it in the Recordings tab once the transcript is done.`,
    gone: (title) => `The recording ‘${title}’ was deleted on the server, so recording stopped.`,
    notLive: (title) => `The recording ‘${title}’ had already ended (it may have been stopped in another window or on another device).`,
    localMissing: (title) => `This device's data for the recording ‘${title}’ is gone (the browser storage may have been cleared).`,
    cannotUpload: (title, detail) => `Can't upload more of the recording ‘${title}’: ${detail}`,
    stillSaving: 'Still uploading the recording you just stopped. You can start a new one after that.',
    alreadyRecording: 'Already recording.',
    busy: 'Another recording is in progress. Only one can be recorded at a time.',
    startFailed: (reason) => `Couldn't start recording: ${reason}`,
    cannotStore: (reason) => `Can't save the recording on this device: ${reason}`,
    cannotContinue: "Can't continue the recording: there's no recording data left on this device.",
    storingAgain: 'Saving the recording on this device again.',
    storageFull: 'Not enough storage space',
    storeFailedQuota: "Not enough storage space to save the recording on this device. Free up some space — it's kept in memory for now.",
    storeFailed: (reason) => `Can't save the recording on this device: ${reason} — it's kept in memory for now.`,
    pausedStoreFailed: (reason) =>
      `Paused because the recording can't be saved on this device (${reason}). Free up space and press ‘Resume’; if that doesn't work, reload the page and press ‘Continue recording’.`,
    backlog: (unsent) =>
      `${unsent} of recording hasn't reached the server yet. It's kept safely on this device and will be sent once connected.`,
    resumeStoreFailed: "The recording still can't be saved on this device. Free up storage space, or reload the page and press ‘Continue recording’.",
    lastPartLost: (lost) => `The last ${lost} couldn't be saved on this device and is missing from the recording.`,
    readFailed: (reason) => `Couldn't read the recording saved on this device: ${reason}`,
    saved: (title) =>
      `Saved the recording ‘${title}’. You can listen to it in the Recordings tab once the rest of the transcript and the slide alignment are done.`,
    savedTranscribing: (title) => `Saved the recording ‘${title}’. Transcription starts now — you can follow it in the Recordings tab.`,
  },

  uploader: {
    timeout: 'No answer from the server (timed out)',
    localMissing: 'No recording data is saved on this device',
    gone: 'The recording was deleted on the server',
    dataLostAt: (bytes) => `This device no longer has the recording after byte ${bytes}`,
    outOfSync: "The recording's state on the server doesn't match. Trying again shortly",
    notLive: 'This recording has already ended (it may have been stopped elsewhere)',
    serverAhead: (bytes) => `The recording on the server (${bytes} bytes) is longer than what this device recorded`,
    dataLost: 'The server lost part of the recording it received, and this device no longer has it either',
  },
} satisfies typeof ko;
