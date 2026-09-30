// English — namespace `common` (the Korean reference: ../ko/common.ts).
import type { common as ko } from '../ko/common.ts';

export const common = {
  close: 'Close',
  cancel: 'Cancel',
  ok: 'OK',
  delete: 'Delete',
  rename: 'Rename',
  copy: 'Copy',
  retry: 'Try again',
  settings: 'Settings',
  loading: 'Loading…',
  unknownError: 'Unknown error',

  api: {
    cannotConnect: "Can't connect to the server",
    loginRequired: 'You need to log in',
    unexpectedResponse: 'Unexpected response from the server',
    uploadFailed: 'Upload failed',
    uploadNetworkError: 'A network error interrupted the upload',
    attachFailed: 'Attachment failed',
    recordingUploadFailed: "Couldn't upload the recording",
    streamUnreadable: "Couldn't read the response stream",
    busyAnswering: "An answer is already being written. Try again when it's done.",
    httpFailure: (failure, status) => `${failure} (HTTP ${status})`,
  },
} satisfies typeof ko;
