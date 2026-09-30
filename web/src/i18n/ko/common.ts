// Korean (the reference language) — namespace `common`: words used all over the app and the API client's errors
// (web/src/api.ts). Owned by the settings area; other areas read these keys and add their own words to their namespace.
// See web/src/i18n/index.ts for the rules.

export const common = {
  close: '닫기',
  cancel: '취소',
  ok: '확인',
  delete: '삭제',
  rename: '이름 바꾸기',
  copy: '복사',
  retry: '다시 시도',
  settings: '설정',
  loading: '불러오는 중…',
  unknownError: '알 수 없는 오류',

  /** web/src/api.ts */
  api: {
    cannotConnect: '서버에 연결할 수 없어요',
    loginRequired: '로그인이 필요해요',
    unexpectedResponse: '예상하지 못한 응답 형식이에요',
    uploadFailed: '업로드 실패',
    uploadNetworkError: '업로드 중 네트워크 오류가 발생했어요',
    attachFailed: '첨부 실패',
    recordingUploadFailed: '녹음 파일을 올리지 못했어요',
    streamUnreadable: '응답 스트림을 읽을 수 없어요',
    busyAnswering: '이미 답변을 생성하고 있어요. 끝난 뒤에 다시 시도해 주세요.',
    /** `${failure} (HTTP 413)`: an upload refused without a message of the server's. */
    httpFailure: (failure: string, status: number) => `${failure} (HTTP ${status})`,
  },
};
