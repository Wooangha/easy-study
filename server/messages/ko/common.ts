// Korean (the reference language) — server namespace `common`: generic HTTP errors and the not-found messages every
// area uses. Owned by server-core; other areas read these keys. See server/i18n.ts for the rules.

export const common = {
  notFound: {
    doc: '문서를 찾을 수 없습니다',
    course: '과목을 찾을 수 없습니다',
    group: '그룹을 찾을 수 없습니다',
    session: '세션을 찾을 수 없습니다',
    slide: '슬라이드를 찾을 수 없습니다',
    attachment: '첨부를 찾을 수 없습니다',
    apiRoute: 'API 경로를 찾을 수 없습니다',
  },
  /** Errors of the HTTP layer (server/index.ts). */
  http: {
    localOnly: '로컬 주소(127.0.0.1)로만 접속할 수 있습니다',
    crossSite: '다른 사이트에서 보낸 요청은 허용되지 않습니다',
    requestTimeout: '요청을 받는 데 너무 오래 걸려서 중단했습니다',
    fileTooLarge: (max: string) => `파일이 너무 큽니다 (최대 ${max})`,
    bodyNotJson: '요청 본문이 올바른 JSON이 아닙니다',
    bodyInvalid: '요청 본문이 올바르지 않습니다',
    shuttingDown: '서버를 종료하는 중입니다',
    /** `?w=` of a slide's display image; `widths` "1000, 1600". */
    viewWidthInvalid: (widths: string) => `w는 ${widths} 중 하나여야 합니다`,
  },
  /** Plain-text pages outside /api (each followed by a line break). */
  page: {
    notFound: '페이지를 찾을 수 없습니다.',
    badRequest: '요청을 처리할 수 없습니다.',
    serverError: '서버 오류가 발생했습니다.',
    clientNotBuilt: '웹 클라이언트가 빌드되지 않았습니다 (web/dist 없음).\n`npm start` 또는 `npm run dev` 로 실행하세요.',
  },
  /** A slide number outside 1..pageCount (a turn, a selected region). */
  slideOutOfRange: (pageCount: number) => `슬라이드 번호가 올바르지 않습니다 (1–${pageCount})`,
};
