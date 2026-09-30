// English — server namespace `common` (the Korean reference: ../ko/common.ts).
import type { common as ko } from '../ko/common.ts';

export const common = {
  notFound: {
    doc: 'Document not found',
    course: 'Course not found',
    group: 'Group not found',
    session: 'Session not found',
    slide: 'Slide not found',
    attachment: 'Attachment not found',
    apiRoute: 'API route not found',
  },
  http: {
    localOnly: 'Only connections to the local address (127.0.0.1) are allowed',
    crossSite: "Requests from other sites aren't allowed",
    requestTimeout: 'The request took too long to arrive, so it was stopped',
    fileTooLarge: (max) => `The file is too large (${max} max)`,
    bodyNotJson: "The request body isn't valid JSON",
    bodyInvalid: 'The request body is invalid',
    shuttingDown: 'The server is shutting down',
    viewWidthInvalid: (widths) => `w must be one of ${widths}`,
  },
  page: {
    notFound: 'Page not found.',
    badRequest: "The request can't be processed.",
    serverError: 'A server error occurred.',
    clientNotBuilt: "The web client isn't built (no web/dist).\nRun it with `npm start` or `npm run dev`.",
  },
  slideOutOfRange: (pageCount) => `Invalid slide number (1–${pageCount})`,
} satisfies typeof ko;
