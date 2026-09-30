// English — server namespace `recordings` (the Korean reference: ../ko/recordings.ts).
import type { recordings as ko } from '../ko/recordings.ts';

const seconds = (n: number) => (n === 1 ? '1 second' : `${n} seconds`);
/** "Sep 27, 2026, 3:30 PM" (local time). */
const titleStamp = (at: Date): string =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(at)
    .replace(/\u202f/g, ' ');

export const recordings = {
  notFound: {
    recording: 'Recording not found',
    model: 'Model not found',
    playbackAudio: 'No audio to play yet',
  },
  docNotReady: 'The document is still being processed',
  tooManyRequests: 'Too many requests. Wait a moment and send them again',
  shuttingDown: 'The server is shutting down',
  diskFull: 'Not enough disk space. Free up some space and try again',
  unknownProvider: (id: string) => `Unknown provider: ${id}`,
  titles: {
    live: (_stamp: string, at: Date) => `Recording ${titleStamp(at)}`,
    upload: (_stamp: string, at: Date) => `Recording file ${titleStamp(at)}`,
  },
  upload: {
    stalled: (n: number) => `The upload was stuck for over ${seconds(n)}, so it was stopped. Upload it again`,
    interrupted: 'The upload was interrupted',
    tooLarge: (limit: string) => `The recording file is too large (max ${limit})`,
    empty: 'The recording file is empty',
    notMedia: (supported: string) => `Not an audio or video file (supported: ${supported})`,
    ffmpegNotFoundDesktop: "Couldn't find ffmpeg to convert the recording file. Reinstall the app or set its path in EASY_STUDY_FFMPEG",
    ffmpegMissing: "ffmpeg isn't installed, so the recording file can't be converted. Install ffmpeg or set its path in EASY_STUDY_FFMPEG",
  },
  conversion: {
    ffmpegNotFound: "Couldn't find ffmpeg. Install ffmpeg or set its path in EASY_STUDY_FFMPEG",
    noAudioTrack: 'The file has no audio track',
    damaged: "The file is damaged or the upload didn't finish",
    failed: (detail: string) => (detail ? `Couldn't convert the recording file: ${detail}` : "Couldn't convert the recording file"),
  },
  live: {
    chunkTooLarge: (maxBytes: number) => `The audio chunk is too large (max ${maxBytes} bytes)`,
    offsetRequired: 'offset (an integer of 0 or more) is required',
    emptyAudio: 'The audio is empty',
    oddBytes: 'Send whole 16-bit PCM samples (an even number of bytes)',
    fileClosed: 'The recording file is closed',
    gap: (offset: number, committed: number) => `offset ${offset} is past the stored end (${committed}). Send again from that point`,
    conflict: "The audio doesn't match the audio already stored",
    ended: 'The recording has already ended',
    tooLong: 'The recording is too long (max 24 hours)',
    uploadCannotAppend: "Audio can't be added to an uploaded recording",
    notRecording: "The recording isn't in progress",
    uploadCannotStop: "An uploaded recording can't be stopped",
    stopBeforeStored: 'The stop size is smaller than the audio already stored',
    starting: 'A recording is already starting',
    alreadyRecording: (title: string, docTitle: string | null) =>
      docTitle !== null
        ? `A lecture is already being recorded (‘${title}’ in ‘${docTitle}’). Finish that recording first`
        : `A lecture is already being recorded (‘${title}’). Finish that recording first`,
  },
  request: {
    badLanguage: 'language must be ko, en or auto',
    unknownAsrModel: (id: string) => `Unknown speech recognition model: ${id}`,
    badLiveTranscribe: 'liveTranscribe must be true or false',
    slideEventsRequired: 'An array of slide events (max 1000) is required',
    badSlideEvent: (json: string) => `Invalid slide event: ${json}`,
    uploadHasNoSlides: 'An uploaded recording has no slide history',
    badBytes: 'bytes must be an integer of 0 or more',
    titleRequired: 'Enter a title',
    markersRequired: 'An array of markers (max 500) is required',
    badMarker: (json: string) => `Invalid marker: ${json}`,
  },
  transcription: {
    failed: (reason: string) => `Transcription failed: ${reason}`,
    noOutputFile: "whisper-cli didn't create its output file",
    unreadableOutput: "Couldn't read the whisper-cli output",
  },
  engine: {
    missingEnv: (path: string) => `The transcription engine (whisper-cli) set in EASY_STUDY_WHISPER doesn't exist: ${path}`,
    notFoundDesktop: "Couldn't find the transcription engine (whisper-cli). Reinstall the app or set the whisper-cli path in EASY_STUDY_WHISPER",
    missing:
      "The transcription engine (whisper-cli) isn't installed. Install it with `npm run setup:whisper` in the repository or set the whisper-cli path in EASY_STUDY_WHISPER",
    cannotRun: (path: string, error: string) => `Couldn't run the transcription engine (${path}): ${error}`,
    unknownError: 'Unknown error',
    fileMissing: (file: string) => `File not found: ${file}`,
  },
  models: {
    labels: {
      turbo: 'Accurate (large-v3-turbo)',
      small: 'Fast (small)',
    },
    unknown: (id: string) => `Unknown model: ${id}`,
    inUse: "Can't delete this model while it's transcribing",
    downloadCanceled: 'Download canceled',
    downloadFailed: (reason: string) => `Couldn't download the model: ${reason}`,
    incomplete: (size: number, total: number) => `The download didn't finish (${size}/${total} bytes). Try again to continue it`,
    corrupt: (file: string) => `The downloaded file is damaged (sha256 mismatch: ${file}). Try again`,
    emptyResponse: 'Empty response',
    largerThanExpected: 'The file is larger than expected',
  },
  aiAlign: {
    running: 'AI alignment is already running',
    noTranscript: 'Nothing has been transcribed yet',
    notFinished: 'AI alignment can run once transcription has finished',
    failed: (reason: string) => `AI alignment failed: ${reason}`,
    noJsonArray: "Couldn't find a JSON array in the AI alignment result",
    unreadable: "Couldn't read the AI alignment result",
    notArray: 'The AI alignment result is not an array',
    noRuns: 'The AI alignment result has no ranges',
  },
} satisfies typeof ko;
