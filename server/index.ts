// HTTP server (DESIGN §4): JSON API, SSE chat turns, slide images and the web client.
//
//   node server/index.ts --dev          Express + Vite in middleware mode (HMR), TypeScript run directly
//   node dist-server/server/index.js    production: the compiled server (npm run build) serving web/dist
//   EASY_STUDY_DESKTOP=1 ...            desktop mode, started by the desktop app (DESIGN §19, server/desktop.ts)
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIPv6 } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  ATTACHMENT_ID_RE,
  COURSE_ID_RE,
  DECK_REV_HEADER,
  DOC_ID_RE,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MODEL_ID_RE,
  SESSION_ID_RE,
} from '../shared/types.ts';
import { closeAnnotationStreams, forgetDocAnnotations } from './annotations.ts';
import { createAnnotationsRouter } from './annotationsRoutes.ts';
import { VIEW_WIDTHS, thumbPath, viewPath } from './assets.ts';
import type { ViewWidth } from './assets.ts';
import {
  attachmentImagePath,
  createImageAttachment,
  createRegionAttachment,
  deleteAttachment,
  readAttachment,
  startAttachmentSweeper,
  stopAttachmentJobs,
  tooLarge,
} from './attachments.ts';
import type { AttachmentSweeper } from './attachments.ts';
import type {
  CreateSessionRequest,
  DocMeta,
  HealthResponse,
  ProviderId,
  ProviderInfo,
  StartDigestRequest,
  StreamEvent,
  UndoVersionRequest,
  UpdateSessionRequest,
} from '../shared/types.ts';
import {
  MAX_NEIGHBORS,
  abortAllTurns,
  abortTurn,
  defaultChatDeps,
  hasRunningTurns,
  runTurn,
  waitForIdle,
  waitForTurn,
  withSessionReserved,
} from './chat.ts';
import type { ChatDeps } from './chat.ts';
import {
  AUTH_FILE_NAME,
  AuthStore,
  LoginLimiter,
  authFilePath,
  createAuthGate,
  devServerGuard,
  formatAccessBanner,
  isLoopbackPeer,
  reachableUrls,
} from './auth.ts';
import type { AuthGate } from './auth.ts';
import {
  ConfigError,
  HttpError,
  autoDigestEnabled,
  desktopMode,
  fallbackFontProblem,
  isLoopbackHost,
  isWildcardHost,
  libraryDir,
  networkSettings,
  port,
  repoRoot,
  webDir,
  webDistDir,
} from './config.ts';
import type { TlsFiles } from './config.ts';
import {
  addDocToCourse,
  createCourse,
  createGroup,
  deleteCourse,
  deleteGroup,
  courseOf,
  getCourse,
  getLayout,
  listCourses,
  putLayout,
  removeDocFromCourses,
  updateCourse,
  updateGroup,
  writeCourseMarkdown,
} from './courses.ts';
import { DESKTOP_ACTION_PATH, desktopBusy, runDesktopServer } from './desktop.ts';
import {
  abortAllDigests,
  abortDigest,
  defaultDigestDeps,
  getDigestInfo,
  isDigestRunning,
  readDigestMarkdown,
  recoverInterruptedDigests,
  rewriteDigestMarkdown,
  startDigest,
  waitForDigestsIdle,
} from './digest.ts';
import type { DigestDeps } from './digest.ts';
import { langContext, requestLang, smsg } from './i18n.ts';
import {
  LibraryLockedError,
  SERVER_LOCK_FILE_NAME,
  acquireServerLock,
  startBackfill,
  coursePaths,
  deleteDoc,
  docPaths,
  getDoc,
  importPdf,
  isDocSwapping,
  listDocs,
  readStoredDoc,
  removeDeletedLeftovers,
  renameDoc,
  requestDeckRev,
  requestDerivedImages,
  resumePendingIngests,
  retryIngest,
  slideFileName,
  stopImageWork,
} from './library.ts';
import type { ServerLock, StoredDocMeta } from './library.ts';
import { providerInfos } from './providers/index.ts';
import { effortLabel } from './providers/types.ts';
import { createRecordingsRouter } from './recordings/routes.ts';
import { configureRecordings, forgetDocRecordings, resumeRecordings, stopRecordingWork } from './recordings/service.ts';
import type { RecordingsConfig } from './recordings/service.ts';
import {
  buildNotes,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  recoverInterruptedSessions,
  referencedAttachmentIds,
  switchSessionLlm,
  toSession,
  writeNotes,
} from './sessions.ts';
import {
  applyNextVersion,
  dropNextVersion,
  getNextVersion,
  importNextVersion,
  nextVersionThumb,
  resumeSwaps,
  undoLastVersion,
} from './versions.ts';

const MAX_UPLOAD = '300mb';
const SSE_PING_MS = 15_000;
const IMMUTABLE_MAX_AGE_MS = 31_536_000 * 1000; // one year → "max-age=31536000"
/** Behind the login (remote mode) slide images are for this browser only: no shared (proxy) caches. */
const PRIVATE_IMMUTABLE = 'private, max-age=31536000, immutable';

export interface AppOptions {
  /** Provider availability for /api/health and session creation (default: the real registry). */
  providerInfos?: () => Promise<ProviderInfo[]>;
  /** Collaborators of the chat orchestrator (default: the real providers and context builder). */
  chatDeps?: ChatDeps;
  /**
   * Collaborators of the digest runner. Default: digestPrompt.ts with the provider lookup and
   * availability check of `chatDeps` (so fake chat providers are used for digests too).
   */
  digestDeps?: DigestDeps;
  /** Lecture recordings (DESIGN §22): models store, upload limit, window presets (tests). */
  recordings?: Partial<RecordingsConfig>;
  /** Desktop mode (DESIGN §19, §24): the routes only the desktop app's shell uses (GET /api/desktop/busy). */
  desktop?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let cachedVersion: string | undefined | null = null;

/** The version in package.json (read once; undefined when it cannot be read). */
function serverVersion(): string | undefined {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { version?: unknown };
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : undefined;
    } catch {
      cachedVersion = undefined;
    }
  }
  return cachedVersion;
}

/** DocMeta with its derived fields (course, digest status): only GET /docs/:docId needs them. */
async function requireDoc(docId: string): Promise<DocMeta> {
  const doc = await getDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  return doc;
}

/** doc.json alone (no course or digest file is read): for routes that only need the document to exist. */
async function requireStoredDoc(docId: string): Promise<StoredDocMeta> {
  const doc = await readStoredDoc(docId);
  if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
  return doc;
}

interface SlideRequest {
  doc: StoredDocMeta;
  slide: number;
  /** e.g. `007.png`. */
  slideFile: string;
}

/** The slide named by `<n>.<ext>` of a document (404 when the document or the slide does not exist). */
async function requireSlide(docId: string, file: string, ext: 'png' | 'webp'): Promise<SlideRequest> {
  const doc = await readStoredDoc(docId);
  const match = /^(\d{1,6})\.([a-z]+)$/.exec(file);
  const slide = match && match[2] === ext ? Number(match[1]) : 0;
  if (!doc || slide < 1 || slide > doc.pageCount) throw new HttpError(404, smsg().common.notFound.slide);
  return { doc, slide, slideFile: slideFileName(slide, doc.pageCount) };
}

/** X-Filename carries the URI-encoded original file name (headers cannot hold raw unicode). */
function decodeFileName(header: string | undefined): string {
  if (!header) return 'document.pdf';
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/**
 * Provider + model + reasoning effort of a request (POST /sessions, POST /digest): the provider must be known and
 * available; '' / omitted model = the provider's default. The effort ('' / omitted = the CLI's default) must be one
 * of the provider's levels (ProviderInfo.efforts) that a listed model supports (a model typed in by hand may take any
 * of them). Throws HttpError 400 otherwise.
 */
function resolveProviderChoice(
  infos: ProviderInfo[],
  provider: unknown,
  model: unknown,
  effort?: unknown,
): { info: ProviderInfo; model: string; effort: string } {
  const m = smsg().chat.providers;
  const info = infos.find((candidate) => candidate.id === provider);
  if (!info) throw new HttpError(400, m.unknownProvider(String(provider)));
  if (!info.available) throw new HttpError(400, m.unavailable(info.label, info.reason ?? ''));
  if (model !== undefined && typeof model !== 'string') throw new HttpError(400, m.modelInvalid);
  const resolved = (model ?? '').trim() || info.defaultModel;
  if (resolved && !MODEL_ID_RE.test(resolved)) throw new HttpError(400, m.modelNameInvalid(resolved));
  if (effort !== undefined && typeof effort !== 'string') throw new HttpError(400, m.effortInvalid);
  const level = (effort ?? '').trim();
  if (level) {
    if (!info.efforts?.length) throw new HttpError(400, m.noEffortChoice(info.label));
    if (!info.efforts.some((e) => e.id === level)) throw new HttpError(400, m.unknownEffort(level));
    const supported = info.models.find((candidate) => candidate.id === resolved)?.efforts;
    if (supported && !supported.includes(level)) throw new HttpError(400, m.effortUnsupported(effortLabel(level)));
  }
  return { info, model: resolved, effort: level };
}

/**
 * SendMessageRequest.attachments: absent, or ids of attachments (ATTACHMENT_ID_RE), at most MAX_ATTACHMENTS once
 * duplicates are dropped. Whether they exist in this document is checked by the turn (400 as well).
 */
function parseAttachmentIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && ATTACHMENT_ID_RE.test(id))) {
    throw new HttpError(400, smsg().library.attachments.idsNotArray);
  }
  const ids = [...new Set(value as string[])];
  if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, smsg().library.attachments.tooMany(MAX_ATTACHMENTS));
  return ids;
}

/**
 * The raw body of an image upload (≤ MAX_ATTACHMENT_BYTES, whatever its Content-Type). A larger one is read off
 * (so the client gets the answer, not a reset connection) and answered 413 with a readable message.
 */
function rawImageBody(): express.RequestHandler {
  const parse = express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES });
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      next((err as { type?: string } | undefined)?.type === 'entity.too.large' ? tooLarge() : err);
    });
  };
}

/** SendMessageRequest.memos (DESIGN §25): absent, or a boolean. */
function parseMemos(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, smsg().chat.turns.memosNotBoolean);
  return value;
}

/** SendMessageRequest.neighbors / PrimeRequest.neighbors: absent, or an integer 0..3. */
function parseNeighbors(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_NEIGHBORS) {
    throw new HttpError(400, smsg().chat.turns.neighborsInvalid(MAX_NEIGHBORS));
  }
  return value;
}

function sendMarkdown(res: Response, markdown: string): void {
  res.set('Cache-Control', 'no-cache');
  res.type('text/markdown; charset=utf-8').send(markdown);
}

/** Express 5 leaves req.body undefined when there is no body. */
function jsonBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && !Buffer.isBuffer(body) ? (body as Record<string, unknown>) : {};
}

/**
 * res.sendFile(file) with the file's folder as `root`. Express's `send` refuses (404) every path with a segment
 * that starts with a dot, but checks only the part below `root`: an absolute path alone would fail for a
 * library or an install under a dot folder (the Linux desktop app's ~/.local/share/…, the AppImage's
 * /tmp/.mount_…, a repository under ~/.projects).
 */
function sendFileFrom(
  res: Response,
  file: string,
  options: Parameters<Response['sendFile']>[1],
  callback: (err?: Error) => void,
): void {
  res.sendFile(path.basename(file), { ...options, root: path.dirname(file) }, callback);
}

function sendFile(res: Response, file: string, options: Parameters<Response['sendFile']>[1]): Promise<void> {
  return new Promise((resolve, reject) => {
    sendFileFrom(res, file, options, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * A request's path for a log line: never its query (a login link `/login?code=` carries the access code, and in
 * the desktop app stderr ends up in server.log).
 */
function logPath(req: Request): string {
  return req.originalUrl.replace(/[?#].*$/, '');
}

/** Logs a failed transfer unless the client simply went away. */
function warnTransfer(req: Request, err: unknown): void {
  if ((err as NodeJS.ErrnoException).code !== 'ECONNABORTED') console.warn(`[http] ${req.path}: ${errorMessage(err)}`);
}

/** sendFile options of a file that never changes under its URL (`private` in remote mode). */
function immutableOptions(res: Response): Parameters<Response['sendFile']>[1] {
  return res.locals.authRequired === true
    ? { cacheControl: false, headers: { 'Cache-Control': PRIVATE_IMMUTABLE } }
    : { maxAge: IMMUTABLE_MAX_AGE_MS, immutable: true };
}

/** A file that never changes under its URL (slides of a converted document); 404 when it does not exist. */
async function sendImmutable(req: Request, res: Response, file: string): Promise<void> {
  try {
    await sendFile(res, file, immutableOptions(res));
  } catch (err) {
    // Not rendered yet (still processing) or the client went away mid-transfer.
    if (!res.headersSent) throw new HttpError(404, smsg().common.notFound.slide);
    warnTransfer(req, err);
  }
}

/**
 * A derived image of a slide (server/assets.ts), cached for good. When it does not exist yet (a document
 * converted before derived images existed, or its image worker is still busy), the backfill is asked for
 * it and the original PNG is sent instead with `Cache-Control: no-store`, so the browser asks again later.
 */
async function sendDerivedFile(req: Request, res: Response, doc: StoredDocMeta, slideFile: string, file: string): Promise<void> {
  try {
    await sendFile(res, file, immutableOptions(res));
    return;
  } catch (err) {
    if (res.headersSent) return warnTransfer(req, err);
  }
  if (doc.status === 'ready') requestDerivedImages(doc.id);
  try {
    await sendFile(res, path.join(docPaths(doc.id).slidesDir, slideFile), {
      cacheControl: false,
      lastModified: false,
      etag: false,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (!res.headersSent) throw new HttpError(404, smsg().common.notFound.slide);
    warnTransfer(req, err);
  }
}

/** `?w=` of a view rendition: one of VIEW_WIDTHS, default the largest. */
function parseViewWidth(value: unknown): ViewWidth {
  if (value === undefined || value === '') return VIEW_WIDTHS[VIEW_WIDTHS.length - 1];
  const width = VIEW_WIDTHS.find((candidate) => String(candidate) === value);
  if (width === undefined) throw new HttpError(400, smsg().common.http.viewWidthInvalid(VIEW_WIDTHS.join(', ')));
  return width;
}

interface LazySse {
  readonly opened: boolean;
  send(event: StreamEvent): void;
  close(): void;
}

/**
 * Server-Sent Events writer that only commits the response (status 200 + SSE headers) on the
 * first event, so failures before a turn starts can still be answered with a JSON error.
 */
function lazySse(res: Response): LazySse {
  let opened = false;
  let ping: NodeJS.Timeout | undefined;
  const writable = () => !res.writableEnded && !res.destroyed;
  const open = () => {
    opened = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    ping = setInterval(() => {
      if (writable()) res.write(': ping\n\n');
    }, SSE_PING_MS);
  };
  return {
    get opened() {
      return opened;
    },
    send(event) {
      if (!opened) open();
      if (writable()) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      clearInterval(ping);
      if (opened && writable()) res.end();
    },
  };
}

/**
 * Whether a browser request comes from a page of this server (its Origin is the host it was sent to).
 * With the login on, a reverse proxy on this computer (e.g. tailscale serve, EASY_STUDY_AUTH=on) may pass
 * the public host name on as X-Forwarded-Host. Local mode has no proxy to trust: there, only the Host
 * header counts, exactly as before remote mode existed.
 */
function isSameOrigin(req: Request, origin: string, authRequired: boolean): boolean {
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // "null" or garbage: not our page
  }
  const hosts = [req.headers.host];
  if (authRequired && isLoopbackPeer(req)) hosts.push(String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim());
  return hosts.some((candidate) => candidate !== undefined && candidate !== '' && candidate.toLowerCase() === originHost);
}

/**
 * Keeps web pages of other sites out of the API (DESIGN §16):
 * - state-changing requests sent by a browser must come from our own origin (CSRF), in both modes;
 * - local mode (no login): the Host must be a loopback name, which defeats DNS rebinding. With the login
 *   on, rebinding is harmless (the session cookie is host-only and SameSite=Strict), and other hosts are
 *   exactly what remote mode is for.
 */
function apiGuard(authRequired: boolean): express.RequestHandler {
  return (req, _res, next) => {
    const hostHeader = req.headers.host ?? '';
    if (!authRequired && !isLoopbackHost(hostHeader.replace(/:\d+$/, ''))) {
      next(new HttpError(403, smsg().common.http.localOnly));
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req, origin, authRequired)) {
      next(new HttpError(403, smsg().common.http.crossSite));
      return;
    }
    next();
  };
}

/**
 * Headers every response carries, in both modes (DESIGN §16):
 * - no framing by other sites (X-Frame-Options + CSP frame-ancestors; the latter cannot be set in a <meta>
 *   tag). A framed app would make requests from its own origin, which pass the Host and Origin checks, so
 *   a page of another site could make the owner click "delete" or start a CLI run through a disguised
 *   frame (clickjacking);
 * - no Referer to other sites (links in answers, the one-click login link);
 * - no content-type sniffing (Markdown and images are served with their exact types).
 */
export function securityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  };
}

/** Whole-request limit of every request but a recording upload (Node's former requestTimeout default). */
export const REQUEST_BODY_DEADLINE_MS = 300_000;

/**
 * Node's `server.requestTimeout` (5 minutes, the whole request including its body) is turned off so that a recording
 * upload of up to 4 GB over a slow network can finish (the upload route stops a transfer that stalls instead). Every
 * other request keeps the old bound here: a body still incomplete after `ms` is answered 408 and the connection
 * closed. The check only looks at `req.complete` — it never reads the body.
 */
export function requestBodyDeadline(ms: number = REQUEST_BODY_DEADLINE_MS, exempt: (req: express.Request) => boolean = isRecordingUpload): express.RequestHandler {
  return (req, res, next) => {
    if (req.complete || exempt(req)) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      if (req.complete || res.writableEnded) return;
      if (!res.headersSent) {
        // Outside the API router (no request language yet): the request's own.
        res.status(408).set('Connection', 'close').json({ error: smsg(requestLang(req)).common.http.requestTimeout });
      }
      req.socket?.destroySoon?.();
    }, ms);
    timer.unref?.();
    res.once('close', () => clearTimeout(timer));
    next();
  };
}

function isRecordingUpload(req: express.Request): boolean {
  return req.method === 'POST' && /^\/api\/docs\/[^/]+\/recordings\/upload\/?$/.test(req.path);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * The JSON API. `gate` decides who may use it (DESIGN §16); the default is local mode (no login, loopback
 * Host names only).
 */
export function createApiRouter(options: AppOptions = {}, gate: AuthGate = createAuthGate(null)): express.Router {
  const getProviderInfos = options.providerInfos ?? providerInfos;
  const chatDeps = options.chatDeps ?? defaultChatDeps();
  const digestDeps: DigestDeps = options.digestDeps ?? {
    ...defaultDigestDeps(),
    getProvider: chatDeps.getProvider,
    checkProvider: chatDeps.checkProvider,
  };
  const api = express.Router();

  // First: everything below answers in the request's language (DESIGN §27), the guard's refusals included.
  api.use(langContext());
  api.use(apiGuard(gate.required));
  // Login routes answer without a session; everything after requireAuth needs one in remote mode
  // (including slide images and SSE turns: the cookie comes along on same-origin requests).
  api.use('/auth', gate.routes);
  api.use(gate.requireAuth);

  // Invalid ids are answered with 404 before any handler (and any filesystem access) runs.
  api.param('docId', (_req, _res, next, value: string) => {
    next(DOC_ID_RE.test(value) ? undefined : new HttpError(404, smsg().common.notFound.doc));
  });
  api.param('sid', (_req, _res, next, value: string) => {
    next(SESSION_ID_RE.test(value) ? undefined : new HttpError(404, smsg().common.notFound.session));
  });
  api.param('courseId', (_req, _res, next, value: string) => {
    next(COURSE_ID_RE.test(value) ? undefined : new HttpError(404, smsg().common.notFound.course));
  });
  api.param('groupId', (_req, _res, next, value: string) => {
    next(COURSE_ID_RE.test(value) ? undefined : new HttpError(404, smsg().common.notFound.group));
  });
  api.param('attachmentId', (_req, _res, next, value: string) => {
    next(ATTACHMENT_ID_RE.test(value) ? undefined : new HttpError(404, smsg().common.notFound.attachment));
  });
  // While a lecture's deck is swapped for a new version (DESIGN §28) it takes no writes, on every router (recordings
  // and annotations included); the versions routes answer for themselves. Reads go on.
  api.use('/docs/:docId', (req, _res, next) => {
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    const refused = write && isDocSwapping(String(req.params.docId)) && !/^\/versions(\/|$)/.test(req.path);
    next(refused ? new HttpError(409, smsg().library.versions.swapping) : undefined);
  });
  // Only parses application/json bodies; the raw PDF upload passes through untouched.
  api.use(express.json({ limit: '2mb' }));

  api.get('/health', async (_req, res) => {
    const body: HealthResponse = { ok: true, providers: await getProviderInfos(), libraryDir: libraryDir() };
    const version = serverVersion();
    if (version) body.version = version;
    res.json(body);
  });

  // What a restart would interrupt, for the desktop app's shell before it installs an update (DESIGN §24). Desktop
  // mode only (loopback, no login by design); elsewhere it does not exist (404).
  if (options.desktop) {
    api.get('/desktop/busy', async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await desktopBusy());
    });
  }

  // --- documents -------------------------------------------------------------------------------

  api.get('/docs', async (_req, res) => {
    res.json(await listDocs());
  });

  api.post('/docs', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, smsg().library.docs.pdfEmpty);
    // X-Course-Id: upload straight into a course ("과목" folder).
    const courseId = req.get('X-Course-Id')?.trim() || null;
    if (courseId !== null && (!COURSE_ID_RE.test(courseId) || (await getCourse(courseId)) === null)) {
      throw new HttpError(400, smsg().library.courses.courseNotFoundId(courseId));
    }
    const meta: DocMeta = await importPdf(bytes, decodeFileName(req.get('X-Filename')));
    if (courseId !== null) {
      try {
        await addDocToCourse(courseId, meta.id);
        meta.courseId = courseId;
      } catch (err) {
        // The course was deleted in the meantime: the lecture stays uncategorized.
        console.warn(`[courses] could not add ${meta.id} to ${courseId}: ${errorMessage(err)}`);
      }
    }
    res.status(201).json(meta);
  });

  api.get('/docs/:docId', async (req, res) => {
    res.json(await requireDoc(req.params.docId));
  });

  /**
   * Renames a lecture: `{ title }` → the DocMeta (400 for an empty or too long title, 404 when missing). The files that
   * show the title follow: the course's COURSE.md, STUDY_NOTES.md and DIGEST.md (failures are logged: the rename holds).
   */
  api.patch('/docs/:docId', async (req, res) => {
    const docId = req.params.docId;
    const doc = await renameDoc(docId, jsonBody(req).title);
    const log = (what: string) => (err: unknown) => console.error(`[library] could not rewrite ${what} of ${docId} after a rename:`, err);
    await Promise.all([
      courseOf(docId).then((course) => (course ? writeCourseMarkdown(course.id) : undefined)).catch(log('COURSE.md')),
      writeNotes(docId).catch(log('STUDY_NOTES.md')),
      rewriteDigestMarkdown(docId).catch(log('DIGEST.md')),
    ]);
    res.json(doc);
  });

  /**
   * Deletes a document with its slides, sessions, notes and digest (DESIGN §14). 409 while its PDF is
   * converted, its digest is made or one of its sessions is answering.
   */
  api.delete('/docs/:docId', async (req, res) => {
    const docId = req.params.docId;
    // Checked synchronously right before the deletion starts, so nothing can start in between.
    await deleteDoc(docId, () => {
      if (isDocSwapping(docId)) return smsg().library.versions.swapping;
      if (isDigestRunning(docId)) return smsg().library.docs.deleteWhileDigest;
      if (hasRunningTurns(docId)) return smsg().library.docs.deleteWhileAnswering;
      // From here on the document is gone for every request: attachment images still being made are not wanted,
      // its recordings stop (live audio, transcription, conversion, AI alignment) and its annotation streams end.
      stopAttachmentJobs(docId);
      forgetDocRecordings(docId);
      forgetDocAnnotations(docId);
      return null;
    });
    try {
      // The course files still list the lecture: take it out and rewrite COURSE.md.
      await removeDocFromCourses(docId);
    } catch (err) {
      // The document is gone either way (course reads skip missing lectures).
      console.error(`[courses] could not remove ${docId} from its course:`, err);
    }
    res.status(204).end();
  });

  /** Converts a document whose conversion failed again (e.g. after replacing its source.pdf). 409 otherwise. */
  api.post('/docs/:docId/retry', async (req, res) => {
    res.status(202).json(await retryIngest(req.params.docId));
  });

  /** The original render (PNG): kept for compatibility and as the fallback of the WebP routes below. */
  api.get('/docs/:docId/slides/:file', async (req, res) => {
    const { doc, slideFile } = await requireSlide(req.params.docId, req.params.file, 'png');
    await sendImmutable(req, res, path.join(docPaths(doc.id).slidesDir, slideFile));
  });

  /** Display rendition (lossy WebP, `?w=1000|1600`, default the largest) of a slide (DESIGN §15). */
  api.get('/docs/:docId/view/:file', async (req, res) => {
    const width = parseViewWidth(req.query.w);
    const { doc, slideFile } = await requireSlide(req.params.docId, req.params.file, 'webp');
    await sendDerivedFile(req, res, doc, slideFile, viewPath(docPaths(doc.id).dir, slideFile, width));
  });

  /** Small thumbnail (WebP) of a slide for the notes and digest lists (DESIGN §15). */
  api.get('/docs/:docId/thumbs/:file', async (req, res) => {
    const { doc, slideFile } = await requireSlide(req.params.docId, req.params.file, 'webp');
    await sendDerivedFile(req, res, doc, slideFile, thumbPath(docPaths(doc.id).dir, slideFile));
  });

  // --- a new version of the lecture's PDF (DESIGN §28) -------------------------------------------------

  /**
   * The new version (raw PDF like POST /docs, X-Filename URI-encoded) → 202 NextVersionInfo; it is converted and matched
   * in the background, replacing a pending one. 400 not a PDF / empty, 404, 409 the lecture is not ready or swapping.
   */
  api.post('/docs/:docId/versions', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, smsg().library.docs.pdfEmpty);
    res.status(202).json(await importNextVersion(req.params.docId, bytes, decodeFileName(req.get('X-Filename'))));
  });

  /** NextVersionInfo of the uploaded new version (the client polls it while it is converted); 404 when there is none. */
  api.get('/docs/:docId/versions/next', async (req, res) => {
    const info = await getNextVersion(req.params.docId);
    if (!info) throw new HttpError(404, smsg().library.versions.noNext);
    res.set('Cache-Control', 'no-store');
    res.json(info);
  });

  /** A thumbnail of the new version (`<n>.webp`; the slide PNG until it is written), never cached: it may be replaced. */
  api.get('/docs/:docId/versions/next/thumbs/:file', async (req, res) => {
    const { thumb, png } = await nextVersionThumb(req.params.docId, req.params.file);
    const options = { cacheControl: false, lastModified: false, etag: false, headers: { 'Cache-Control': 'no-store' } };
    for (const file of [thumb, png]) {
      try {
        await sendFile(res, file, options);
        return;
      } catch (err) {
        if (res.headersSent) return warnTransfer(req, err);
      }
    }
    throw new HttpError(404, smsg().common.notFound.slide);
  });

  /** Drops the uploaded new version (idempotent). */
  api.delete('/docs/:docId/versions/next', async (req, res) => {
    await dropNextVersion(req.params.docId);
    res.status(204).end();
  });

  /** The new version replaces the deck → the lecture's DocMeta. 409 (with the reason) when busy, stale or not ready. */
  api.post('/docs/:docId/versions/next/apply', async (req, res) => {
    res.json(await applyNextVersion(req.params.docId));
  });

  /**
   * The deck the last new version replaced comes back → the lecture's DocMeta. UndoVersionRequest: `fromRev`, the deck
   * the client saw (409 deckChanged with the lecture's deckRev when it changed since). 409 when there is nothing to undo
   * or busy.
   */
  api.post('/docs/:docId/versions/undo', async (req, res) => {
    const { fromRev } = jsonBody(req) as Partial<Record<keyof UndoVersionRequest, unknown>>;
    if (fromRev !== undefined && fromRev !== null && !(Number.isInteger(fromRev) && (fromRev as number) >= 0)) {
      throw new HttpError(400, smsg().common.http.bodyInvalid);
    }
    res.json(await undoLastVersion(req.params.docId, typeof fromRev === 'number' ? fromRev : undefined));
  });

  // --- attachments: selected slide regions and images of the student (DESIGN §21) -------------------

  /**
   * CreateRegionRequest → 201 Attachment (400 bad slide / rect, 409 document not converted, 409 deckChanged when the
   * DECK_REV_HEADER names another deck than the lecture's).
   */
  api.post('/docs/:docId/regions', async (req, res) => {
    res.status(201).json(await createRegionAttachment(req.params.docId, jsonBody(req), new Date(), requestDeckRev(req.get(DECK_REV_HEADER))));
  });

  /**
   * A raw image (Content-Type image/*, optional X-Filename URI-encoded) → 201 Attachment. 413 over
   * MAX_ATTACHMENT_BYTES, 415 when it is not a supported image (by its bytes).
   */
  api.post('/docs/:docId/attachments', rawImageBody(), async (req, res) => {
    const docId = String(req.params.docId);
    await requireStoredDoc(docId);
    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, smsg().library.attachments.imageEmpty);
    if (!/^image\//i.test(req.get('Content-Type') ?? '')) throw new HttpError(415, smsg().library.attachments.imageOnly);
    const header = req.get('X-Filename');
    res.status(201).json(await createImageAttachment(docId, bytes, header ? decodeFileName(header) : undefined));
  });

  /** The stored image of an attachment (never changes under its URL; private in both modes). */
  api.get('/docs/:docId/attachments/:attachmentId', async (req, res) => {
    const { docId, attachmentId } = req.params;
    const file = (await readAttachment(docId, attachmentId)) ? await attachmentImagePath(docId, attachmentId) : null;
    if (!file) throw new HttpError(404, smsg().common.notFound.attachment);
    try {
      await sendFile(res, file, { cacheControl: false, headers: { 'Cache-Control': PRIVATE_IMMUTABLE } });
    } catch (err) {
      if (!res.headersSent) throw new HttpError(404, smsg().common.notFound.attachment);
      warnTransfer(req, err);
    }
  });

  /** 204 while no message uses the attachment; 409 once one does. */
  api.delete('/docs/:docId/attachments/:attachmentId', async (req, res) => {
    await deleteAttachment(req.params.docId, req.params.attachmentId, referencedAttachmentIds);
    res.status(204).end();
  });

  // --- sessions ----------------------------------------------------------------------------------

  api.get('/docs/:docId/sessions', async (req, res) => {
    await requireStoredDoc(req.params.docId);
    res.json(await listSessions(req.params.docId));
  });

  api.post('/docs/:docId/sessions', async (req, res) => {
    const docId = req.params.docId;
    await requireStoredDoc(docId);
    const body = jsonBody(req) as Partial<Record<keyof CreateSessionRequest, unknown>>;
    const { info, model, effort } = resolveProviderChoice(await getProviderInfos(), body.provider, body.model, body.effort);
    const record = await createSession(docId, {
      provider: info.id,
      model,
      effort,
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    await autoStartDigest(docId, info.id, model, effort);
    res.status(201).json(toSession(record));
  });

  /**
   * The first session of a document starts its digest with the session's provider/model/effort
   * (DESIGN §11; EASY_STUDY_AUTO_DIGEST=0 disables it). Never fails the request.
   */
  const autoStartDigest = async (docId: string, provider: ProviderId, model: string, effort: string) => {
    if (!autoDigestEnabled()) return;
    try {
      if ((await getDigestInfo(docId)).status !== 'none') return;
      await startDigest(docId, { provider, model, effort }, digestDeps);
    } catch (err) {
      // e.g. 409: the document is still being processed, or a job started concurrently.
      console.warn(`[digest] auto start for ${docId} skipped: ${errorMessage(err)}`);
    }
  };

  api.get('/docs/:docId/sessions/:sid', async (req, res) => {
    const record = await getSession(req.params.docId, req.params.sid);
    if (!record) throw new HttpError(404, smsg().common.notFound.session);
    res.json(toSession(record));
  });

  /**
   * Changes the session's LLM (UpdateSessionRequest, validated like POST /sessions): its provider conversation is
   * dropped, so the next turn starts a new one on the new LLM — the deck fed again, the latest Q&A recapped
   * (DESIGN §5). 409 while the session is answering; the unchanged session (200) when nothing differs.
   */
  api.patch('/docs/:docId/sessions/:sid', async (req, res) => {
    const { docId, sid } = req.params;
    // Existence first, like POST /sessions: a missing session is 404 whatever the body says (and no CLI is detected for it).
    if (!(await getSession(docId, sid))) throw new HttpError(404, smsg().common.notFound.session);
    const body = jsonBody(req) as Partial<Record<keyof UpdateSessionRequest, unknown>>;
    const { info, model, effort } = resolveProviderChoice(await getProviderInfos(), body.provider, body.model, body.effort);
    const { record } = await withSessionReserved(docId, sid, () =>
      switchSessionLlm(docId, sid, { provider: info.id, model, ...(effort ? { effort } : {}) }),
    );
    res.json(toSession(record));
  });

  api.delete('/docs/:docId/sessions/:sid', async (req, res) => {
    const { docId, sid } = req.params;
    if (abortTurn(docId, sid)) await waitForTurn(docId, sid, 5_000);
    if (!(await deleteSession(docId, sid))) throw new HttpError(404, smsg().common.notFound.session);
    res.status(204).end();
  });

  /** Runs a turn, streaming it as SSE once it has started. */
  const streamTurn = async (req: Request, res: Response, kind: 'question' | 'prime') => {
    const docId = String(req.params.docId);
    const sessionId = String(req.params.sid);
    const body = jsonBody(req);
    const slide = body.slide;
    if (typeof slide !== 'number' || !Number.isInteger(slide)) throw new HttpError(400, smsg().chat.turns.slideRequired);
    if (kind === 'question' && typeof body.text !== 'string') throw new HttpError(400, smsg().chat.turns.questionRequired);
    const text = kind === 'question' ? String(body.text) : '';
    const neighbors = parseNeighbors(body.neighbors);
    // The deck the slide number belongs to (409 deckChanged before the turn starts when it is not the lecture's).
    const deckRev = requestDeckRev(req.get(DECK_REV_HEADER));
    // Priming turns take no attachments (DESIGN §21) and no memos (DESIGN §25).
    const attachments = kind === 'question' ? parseAttachmentIds(body.attachments) : undefined;
    const memos = kind === 'question' ? parseMemos(body.memos) : undefined;

    // Abort the turn when the client goes away mid-stream. This must watch the *response*:
    // req 'close' fires as soon as the request body has been consumed.
    // The reason is read here: the 'close' listener runs outside the request's language (AsyncLocalStorage).
    const disconnect = new AbortController();
    const gone = smsg().chat.turns.clientGone;
    res.on('close', () => {
      if (!res.writableFinished) disconnect.abort(new Error(gone));
    });

    const sse = lazySse(res);
    try {
      await runTurn(
        { docId, sessionId, kind, text, slide, deckRev, neighbors, attachments, memos, signal: disconnect.signal, onEvent: (event) => sse.send(event) },
        chatDeps,
      );
    } catch (err) {
      if (!sse.opened) throw err; // not started: answered as a JSON error
      console.error(`[chat] turn of ${sessionId} failed after start:`, err);
      sse.send({ type: 'error', message: errorMessage(err) });
    } finally {
      sse.close();
    }
  };

  api.post('/docs/:docId/sessions/:sid/prime', (req, res) => streamTurn(req, res, 'prime'));
  api.post('/docs/:docId/sessions/:sid/messages', (req, res) => streamTurn(req, res, 'question'));

  api.post('/docs/:docId/sessions/:sid/abort', async (req, res) => {
    const { docId, sid } = req.params;
    if (!(await getSession(docId, sid))) throw new HttpError(404, smsg().common.notFound.session);
    abortTurn(docId, sid);
    res.status(204).end();
  });

  // --- notes ---------------------------------------------------------------------------------------

  api.get('/docs/:docId/notes', async (req, res) => {
    res.json(await buildNotes(req.params.docId));
  });

  api.get('/docs/:docId/notes.md', async (req, res) => {
    const docId = req.params.docId;
    await requireStoredDoc(docId);
    const file = docPaths(docId).studyNotes;
    if (!existsSync(file)) await writeNotes(docId);
    sendMarkdown(res, await fs.readFile(file, 'utf8'));
  });

  // --- digest ("정리본") ------------------------------------------------------------------------

  api.get('/docs/:docId/digest', async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(await getDigestInfo(req.params.docId));
  });

  api.post('/docs/:docId/digest', async (req, res) => {
    const docId = req.params.docId;
    await requireStoredDoc(docId);
    const body = jsonBody(req) as Partial<Record<keyof StartDigestRequest, unknown>>;
    if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, smsg().chat.digest.forceNotBoolean);
    const { info, model, effort } = resolveProviderChoice(await getProviderInfos(), body.provider, body.model, body.effort);
    res.status(202).json(await startDigest(docId, { provider: info.id, model, effort, force: body.force === true }, digestDeps));
  });

  api.post('/docs/:docId/digest/abort', async (req, res) => {
    await requireStoredDoc(req.params.docId);
    abortDigest(req.params.docId);
    res.status(204).end();
  });

  api.get('/docs/:docId/digest.md', async (req, res) => {
    const markdown = await readDigestMarkdown(req.params.docId);
    if (markdown === null) throw new HttpError(404, smsg().chat.digest.notYet);
    sendMarkdown(res, markdown);
  });

  // --- courses ("과목") -----------------------------------------------------------------------------

  api.get('/courses', async (_req, res) => {
    res.json(await listCourses());
  });

  /** CreateCourseRequest; with `groupId` the course goes to the end of that group (400 when unknown). */
  api.post('/courses', async (req, res) => {
    const body = jsonBody(req);
    res.status(201).json(await createCourse(body.title, new Date(), body.groupId));
  });

  api.patch('/courses/:courseId', async (req, res) => {
    const body = jsonBody(req);
    res.json(await updateCourse(req.params.courseId, { title: body.title, docIds: body.docIds, baseDocIds: body.baseDocIds }));
  });

  api.delete('/courses/:courseId', async (req, res) => {
    if (!(await deleteCourse(req.params.courseId))) throw new HttpError(404, smsg().common.notFound.course);
    res.status(204).end();
  });

  api.get('/courses/:courseId/summary.md', async (req, res) => {
    const courseId = req.params.courseId;
    if ((await getCourse(courseId)) === null) throw new HttpError(404, smsg().common.notFound.course);
    // Regenerated on every request: lecture titles and summaries may have changed since the last write.
    await writeCourseMarkdown(courseId);
    let markdown: string;
    try {
      markdown = await fs.readFile(coursePaths(courseId).courseMd, 'utf8');
    } catch {
      throw new HttpError(404, smsg().common.notFound.course); // deleted in the meantime
    }
    sendMarkdown(res, markdown);
  });

  // --- library layout: groups of courses and their order (DESIGN §18) -------------------------------

  api.get('/layout', async (_req, res) => {
    res.json(await getLayout());
  });

  /** PutLayoutRequest: the full arrangement (400 for unknown or duplicated ids and for missing courses/groups). */
  api.put('/layout', async (req, res) => {
    res.json(await putLayout(req.body));
  });

  api.post('/groups', async (req, res) => {
    const body = jsonBody(req);
    res.status(201).json(await createGroup(body.title, body.courseIds));
  });

  api.patch('/groups/:groupId', async (req, res) => {
    res.json(await updateGroup(req.params.groupId, { title: jsonBody(req).title }));
  });

  /** Its courses move to the top level where the group was; nothing else is deleted. */
  api.delete('/groups/:groupId', async (req, res) => {
    if (!(await deleteGroup(req.params.groupId))) throw new HttpError(404, smsg().common.notFound.group);
    res.status(204).end();
  });

  // --- lecture recordings and the ASR engine (DESIGN §22) --------------------------------------------------

  api.use(
    createRecordingsRouter({
      resolveProvider: async (provider, model) => resolveProviderChoice(await getProviderInfos(), provider, model),
      getProvider: chatDeps.getProvider,
      cliSlot: chatDeps.cliSlot,
    }),
  );

  // --- slide annotations (DESIGN §25) --------------------------------------------------------------------------

  api.use(createAnnotationsRouter());

  api.use((_req, _res, next) => next(new HttpError(404, smsg().common.notFound.apiRoute)));
  api.use(apiErrorHandler);
  return api;
}

/** Every API error becomes `{ "error": string }` (plus an HttpError's `fields`) with a 4xx/5xx status. */
function apiErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const bodyParserError = err as { status?: number; statusCode?: number; type?: string };
  let status = 500;
  let message = errorMessage(err);
  let fields: Readonly<Record<string, unknown>> | undefined;
  if (err instanceof HttpError) {
    status = err.status;
    fields = err.fields;
  } else if (bodyParserError.type === 'entity.too.large') {
    status = 413;
    message = smsg().common.http.fileTooLarge(MAX_UPLOAD.toUpperCase());
  } else if (bodyParserError.type === 'entity.parse.failed') {
    status = 400;
    message = smsg().common.http.bodyNotJson;
  } else {
    const candidate = bodyParserError.status ?? bodyParserError.statusCode;
    if (typeof candidate === 'number' && candidate >= 400 && candidate < 600) status = candidate;
  }
  if (status >= 500) console.error(`[http] ${req.method} ${logPath(req)} failed:`, err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ ...fields, error: message });
}

// ---------------------------------------------------------------------------
// Web client
// ---------------------------------------------------------------------------

/**
 * Serves the production build of the web client (`dist`, default web/dist) with the SPA fallback, and ends
 * with the error handler of everything outside /api (plain text, never a stack trace or a path).
 */
/** A path relative to the working directory when it is inside it, otherwise the absolute path. */
function displayPath(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

export function mountProductionClient(app: express.Express, log: boolean, dist = webDistDir()): void {
  const indexHtml = path.join(dist, 'index.html');
  if (!existsSync(indexHtml)) {
    if (log) {
      console.warn(
        `[web] ${displayPath(dist)} 이(가) 없습니다. ` +
          '`npm start`(빌드 후 실행) 또는 `npm run dev`(개발 모드)로 실행하세요.',
      );
    }
    app.use((req, res) => {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send(`${smsg(requestLang(req)).common.page.clientNotBuilt}\n`);
    });
    app.use(clientErrorHandler);
    return;
  }
  // Vite emits content-hashed file names under assets/.
  app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: IMMUTABLE_MAX_AGE_MS, immutable: true }));
  app.use(express.static(dist, { index: false }));
  // SPA fallback.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-cache');
    sendFileFrom(res, indexHtml, {}, (err) => {
      if (err && !res.headersSent) next(err);
      else if (err) warnTransfer(req, err);
    });
  });
  app.use(clientErrorHandler);
}

/**
 * The last error handler outside /api (the API has its own, JSON). Express's default one would show the stack
 * trace, with the absolute paths of the install, unless NODE_ENV=production.
 */
function clientErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const fields = (typeof err === 'object' && err !== null ? err : {}) as { status?: unknown; statusCode?: unknown };
  const candidate = fields.status ?? fields.statusCode;
  const status = typeof candidate === 'number' && candidate >= 400 && candidate < 600 ? candidate : 500;
  if (status >= 500) console.error(`[http] ${req.method} ${logPath(req)} failed:`, err);
  if (res.headersSent) {
    res.end();
    return;
  }
  const m = smsg(requestLang(req)).common.page;
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(`${status === 404 ? m.notFound : status < 500 ? m.badRequest : m.serverError}\n`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerOptions extends AppOptions {
  /** Port to listen on (default: PORT env or 5180; 0 = ephemeral). */
  port?: number;
  /** Vite middleware mode with HMR instead of serving web/dist. */
  dev?: boolean;
  /** Re-process documents left in 'processing' (default true). */
  resumeIngests?: boolean;
  /**
   * Bring converted documents up to date in the background, one document at a time (default: like
   * `resumeIngests`): the text of documents converted before PDFium (DESIGN §17) and the missing derived
   * images (view renditions, thumbnails, inline JPEGs). Requests for a missing derived image ask for them
   * either way.
   */
  backfillImages?: boolean;
  /**
   * Delete attachments no message refers to after 24 h, at startup and hourly (DESIGN §21; default true).
   */
  sweepAttachments?: boolean;
  /**
   * Resume lecture recordings interrupted by a restart (DESIGN §22): live recordings stay resumable, conversions
   * and transcriptions continue (default: like `resumeIngests`).
   */
  resumeRecordings?: boolean;
  /** Print startup information (default true). */
  log?: boolean;
  /** Address to bind (default: EASY_STUDY_HOST or 127.0.0.1). Not loopback = remote mode (DESIGN §16). */
  host?: string;
  /** Login requirement 'on' | 'off' | 'auto' (default: EASY_STUDY_AUTH, auto = on for non-loopback hosts). */
  auth?: string;
  /** Access code instead of a generated one (default: EASY_STUDY_PASSWORD). */
  password?: string | null;
  /** HTTPS certificate and key (PEM files; default: EASY_STUDY_TLS_CERT/KEY); null = plain HTTP. */
  tls?: TlsFiles | null;
  /** --reset-access-code: a new generated access code, every login ended. */
  resetAccessCode?: boolean;
  /** Login rate limiter (tests; default: 10 failures per client per 10 minutes). */
  loginLimiter?: LoginLimiter;
  /** Clock of the login sessions (tests). */
  authClock?: () => number;
}

/** Remote mode details of a running server (startup banner, tests). */
export interface RemoteAccess {
  scheme: 'http' | 'https';
  /** The bound address as configured. */
  bindHost: string;
  /** Addresses other computers can use (reachableUrls). */
  urls: string[];
  /** The access code (EASY_STUDY_PASSWORD when set). Only the startup banner prints it. */
  accessCode: string;
  codeSource: 'password' | 'generated';
  codeIsNew: boolean;
  sessionsRevoked: boolean;
}

export interface RunningServer {
  server: http.Server;
  /** URL of the server from this computer (a wildcard bind address is reached through 127.0.0.1). */
  url: string;
  /** Remote mode (login required): addresses and access code; null in local mode. */
  access: RemoteAccess | null;
  /** Aborts running turns and digest jobs, then stops Vite and the HTTP server. */
  close(): Promise<void>;
}

function listen(server: http.Server, portNumber: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(portNumber, hostname, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Vite's default server.fs.deny (Vite 8), which a configured list replaces rather than extends. */
const VITE_DEFAULT_FS_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**'];

/**
 * Reads the TLS certificate, then the key, and checks that they make a server (ConfigError otherwise). One after
 * the other, so a problem with both always names the certificate first (read together, whichever failed first won).
 */
async function createHttpsServer(files: TlsFiles, app: express.Express): Promise<https.Server> {
  const read = async (file: string, what: string) => {
    try {
      return await fs.readFile(file);
    } catch (err) {
      throw new ConfigError(`HTTPS ${what} 파일을 읽을 수 없습니다: ${file} (${errorMessage(err)})`);
    }
  };
  const cert = await read(files.certFile, '인증서(EASY_STUDY_TLS_CERT)');
  const key = await read(files.keyFile, '키(EASY_STUDY_TLS_KEY)');
  try {
    return https.createServer({ cert, key }, app);
  } catch (err) {
    throw new ConfigError(`HTTPS 인증서/키가 올바르지 않습니다 (${files.certFile}, ${files.keyFile}): ${errorMessage(err)}`);
  }
}

/**
 * Starts the server. Throws ConfigError for unsafe or incomplete network settings (DESIGN §16) and
 * LibraryLockedError when another live server uses the same library (library/.server.lock, DESIGN §14):
 * nothing in the library is touched then.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? true;
  // Checked before anything else: an unsafe combination (EASY_STUDY_AUTH=off on 0.0.0.0) never starts.
  const settings = networkSettings({ host: options.host, auth: options.auth, password: options.password, tls: options.tls });
  const bindHost = settings.host.replace(/^\[(.*)\]$/, '$1');
  const scheme = settings.tls ? 'https' : 'http';
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  const server: http.Server = settings.tls ? await createHttpsServer(settings.tls, app) : http.createServer(app);
  // Recording uploads may take far longer than 5 minutes (DESIGN §22): no whole-request limit of Node's; requests
  // are bounded by requestBodyDeadline() instead, uploads by their idle timer (headers still within 60 s).
  server.requestTimeout = 0;
  app.use(requestBodyDeadline());

  // First of all: one server per library. The startup sweeps below and resumed ingests rewrite files
  // that a running server may be working on (and .auth.json has one writer).
  const lock: ServerLock = await acquireServerLock(options.port ?? port());

  let closeVite: (() => Promise<void>) | undefined;
  let store: AuthStore | null = null;
  let url: string;
  let access: RemoteAccess | null = null;
  try {
    if (settings.authRequired) {
      store = await AuthStore.open({ password: settings.password, reset: options.resetAccessCode, now: options.authClock });
    } else if (options.resetAccessCode) {
      // Local mode: the next remote start generates a new code (and no old session survives).
      await fs.rm(authFilePath(), { force: true });
    }
    const gate = createAuthGate(store, options.loginLimiter);

    // Before accepting requests: mark answers and digest jobs interrupted by a previous crash as aborted.
    const repaired = await recoverInterruptedSessions();
    if (log && repaired > 0) console.log(`[chat] marked unfinished answers of ${repaired} session(s) as aborted`);
    const interruptedDigests = await recoverInterruptedDigests();
    if (log && interruptedDigests > 0) console.log(`[digest] marked ${interruptedDigests} unfinished digest(s) as aborted`);
    const leftovers = await removeDeletedLeftovers();
    if (log && leftovers > 0) console.log(`[library] removed ${leftovers} leftover folder(s) of deleted documents`);
    configureRecordings(options.recordings);
    // A swap of a lecture's deck the server stopped in the middle is finished before anything else touches the lecture
    // (DESIGN §28); new versions left converting are marked interrupted.
    const swaps = await resumeSwaps();
    if (log && swaps > 0) console.log(`[versions] finished ${swaps} interrupted switch(es) to a new version`);
    if (options.resumeRecordings ?? options.resumeIngests ?? true) {
      const resumed = await resumeRecordings();
      if (log && resumed > 0) console.log(`[recordings] resumed ${resumed} unfinished recording(s)`);
    }

    // A page action of the desktop app that its shell did not intercept (DESIGN §24): 204 No Content leaves the page
    // where it is instead of loading the web client again. No side effects, in every mode.
    app.use(DESKTOP_ACTION_PATH, (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.set('Cache-Control', 'no-store').status(204).end();
    });
    // The one-click login link of the startup banner (never logged: it carries the code).
    app.get('/login', gate.loginLink);
    app.use('/api', createApiRouter(options, gate));
    if (options.dev) {
      const remoteDev = gate.required;
      if (remoteDev) {
        // Vite may serve any file of the repository (web/vite.config.ts), including the default library.
        app.use(
          devServerGuard(
            {
              allowRoots: [webDir(), path.join(repoRoot(), 'shared'), path.join(repoRoot(), 'node_modules')],
              denyRoots: [libraryDir()],
              denyNames: [AUTH_FILE_NAME, SERVER_LOCK_FILE_NAME],
            },
            gate,
          ),
        );
      }
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        configFile: path.join(webDir(), 'vite.config.ts'),
        // HMR websocket shares our HTTP server (Vite 8: server.ws.server, formerly server.hmr.server).
        server: {
          middlewareMode: true,
          ws: { server },
          // Remote mode: host names (e.g. my-mac.local) are fine, the login protects the API.
          ...(remoteDev
            ? { allowedHosts: true, fs: { deny: [...VITE_DEFAULT_FS_DENY, `**/${AUTH_FILE_NAME}`, `**/${SERVER_LOCK_FILE_NAME}`] } }
            : {}),
        },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      closeVite = () => vite.close();
    } else {
      mountProductionClient(app, log);
    }

    await listen(server, options.port ?? port(), bindHost);
    const { port: actualPort } = server.address() as AddressInfo;
    const localHost = isWildcardHost(bindHost) ? '127.0.0.1' : bindHost;
    url = `${scheme}://${isIPv6(localHost) ? `[${localHost}]` : localHost}:${actualPort}`;
    await lock.setPort(actualPort);
    if (store) {
      access = {
        scheme,
        bindHost: settings.host,
        urls: reachableUrls(scheme, settings.host, actualPort),
        accessCode: store.accessCode,
        codeSource: store.codeSource,
        codeIsNew: store.codeIsNew,
        sessionsRevoked: store.sessionsRevoked,
      };
    }
  } catch (err) {
    await closeVite?.().catch(() => {});
    await store?.flush();
    await lock.release();
    throw err;
  }

  if (options.resumeIngests ?? true) {
    resumePendingIngests().catch((err: unknown) => console.error('[library] resuming ingests failed:', err));
  }
  if (options.backfillImages ?? options.resumeIngests ?? true) {
    startBackfill().catch((err: unknown) => console.error('[library] backfill failed:', err));
  }
  const sweeper: AttachmentSweeper | null =
    (options.sweepAttachments ?? true) ? startAttachmentSweeper(referencedAttachmentIds, undefined, log) : null;

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      abortAllTurns();
      abortAllDigests();
      stopAttachmentJobs();
      // Let aborted turns and digest jobs persist their partial results; stop the image workers.
      await Promise.all([waitForIdle(4_000), waitForDigestsIdle(4_000), stopImageWork(), sweeper?.stop(), stopRecordingWork(), closeAnnotationStreams()]);
      await closeVite?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await store?.flush();
      await lock.release();
    })());
  return { server, url, access, close };
}

/**
 * A command line that runs `command` with environment variables, in the syntax of the platform's usual
 * shell: POSIX shells (`A=1 npm run dev`) or, on Windows, PowerShell (`$env:A="1"; npm run dev`).
 */
export function envCommand(vars: Record<string, string>, command: string, platform: NodeJS.Platform = process.platform): string {
  const entries = Object.entries(vars);
  if (platform === 'win32') {
    return `${entries.map(([name, value]) => `$env:${name}="${value}"; `).join('')}${command}  (PowerShell)`;
  }
  return `${entries.map(([name, value]) => `${name}=${/[\s<>'"$&|;]/.test(value) ? `'${value}'` : value} `).join('')}${command}`;
}

/**
 * The command line that starts the server again with a change (another port, another library, a new access code), for
 * the messages of serverMain. `easy-study server` (server/cli.ts) passes one; without it they name the npm scripts.
 */
export type RestartCommand = (change: { port?: number; library?: string; resetAccessCode?: boolean }) => string;

/** Why the server did not start because another one uses the library, and what to do about it. */
function libraryLockedMessage(err: LibraryLockedError, dev: boolean, restartCommand?: RestartCommand): string {
  const { holder } = err;
  const again = restartCommand
    ? restartCommand({ library: '<다른 폴더>', port: holder.port + 1 })
    : envCommand({ EASY_STUDY_LIBRARY: '<다른 폴더>', PORT: String(holder.port + 1) }, `npm run ${dev ? 'dev' : 'serve'}`);
  return [
    `easy-study가 이미 이 라이브러리로 실행 중입니다 (pid ${holder.pid}, 포트 ${holder.port})`,
    `  라이브러리: ${libraryDir()}`,
    '  같은 라이브러리에 서버를 두 개 띄우면 서로의 작업(PDF 변환, 정리본, 답변)을 망가뜨리므로 시작하지 않았습니다.',
    '  - 이미 실행 중인 서버를 그대로 쓰거나, 그 서버를 먼저 종료하세요 (Ctrl+C).',
    `  - 다른 라이브러리로 하나 더 띄우려면: ${again}`,
    `  - 실행 중인 easy-study가 없는데도 이 메시지가 나오면 잠금 파일을 지우세요: ${err.lockFile}`,
  ].join('\n');
}

/**
 * Command line flags: --dev (Vite + HMR), --remote (remote mode: bind 0.0.0.0 with the login on unless
 * EASY_STUDY_HOST / EASY_STUDY_AUTH say otherwise; the npm scripts then work the same in every shell,
 * PowerShell included), --reset-access-code (DESIGN §16). `easy-study server` (server/cli.ts, DESIGN §26) calls it
 * with its own flags and `restartCommand` for the commands it prints.
 */
export async function serverMain(args: readonly string[] = process.argv.slice(2), restartCommand?: RestartCommand): Promise<void> {
  // The desktop app's server (DESIGN §19): ready line, stop on stdin EOF, errors for the app (server/desktop.ts).
  if (desktopMode(process.env, args)) {
    await runDesktopServer(startServer);
    return;
  }
  const dev = args.includes('--dev');
  const remote = args.includes('--remote');
  // node --watch (npm run dev) starts the server again after every change with the same flags: a reset
  // there would end every login at each save. Resetting is for a plain start.
  const underWatch = process.env.WATCH_REPORT_DEPENDENCIES !== undefined;
  const resetAccessCode = args.includes('--reset-access-code') && !underWatch;
  if (underWatch && args.includes('--reset-access-code')) {
    console.warn(`--reset-access-code 는 개발 모드(node --watch)에서는 무시됩니다: ${authFilePath()} 을(를) 지우고 다시 시작하세요.`);
  }
  const script = `${dev ? 'dev' : 'serve'}${remote ? ':remote' : ''}`;
  let running: RunningServer;
  try {
    // --remote: every interface and the login on, unless EASY_STUDY_HOST / EASY_STUDY_AUTH say otherwise
    // (EASY_STUDY_HOST=127.0.0.1 --remote = behind a reverse proxy such as tailscale serve).
    running = await startServer({
      dev,
      resetAccessCode,
      host: remote && !process.env.EASY_STUDY_HOST?.trim() ? '0.0.0.0' : undefined,
      auth: remote && !process.env.EASY_STUDY_AUTH?.trim() ? 'on' : undefined,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`설정 오류: ${err.message}`);
    } else if (err instanceof LibraryLockedError) {
      console.error(libraryLockedMessage(err, dev, restartCommand));
    } else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Not an easy-study on this library (the library lock would have said so).
      console.error(
        `포트 ${port()}을(를) 다른 프로그램(또는 다른 라이브러리로 실행 중인 easy-study)이 쓰고 있습니다. ` +
          `다른 포트로 실행하세요: ${restartCommand ? restartCommand({ port: port() + 1 }) : envCommand({ PORT: String(port() + 1) }, `npm run ${script}`)}`,
      );
    } else {
      console.error('서버를 시작하지 못했습니다:', err);
    }
    process.exit(1);
  }

  console.log(`\n  easy-study ${dev ? '(dev)' : ''}  →  ${running.url}`);
  if (running.access) {
    // The only place the access code is ever printed.
    console.log(
      formatAccessBanner({
        ...running.access,
        store: running.access,
        dev,
        resetCommand: underWatch
          ? `${authFilePath()} 을(를) 지우고 다시 시작`
          : restartCommand
            ? restartCommand({ resetAccessCode: true })
            : `npm run ${script} -- --reset-access-code`,
      }),
    );
  } else if (resetAccessCode) {
    console.log('  접속 코드를 지웠습니다: 다음에 원격 모드로 시작할 때 새 코드가 만들어지고, 이전 로그인은 모두 끊깁니다.');
  }
  console.log(`  library     →  ${libraryDir()}\n`);
  const fontProblem = fallbackFontProblem();
  if (fontProblem) console.warn(`  ${fontProblem}\n`);

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1); // second Ctrl+C: leave immediately
    stopping = true;
    console.log(`\n${signal}: 종료하는 중…`);
    const forceExit = setTimeout(() => process.exit(0), 8_000);
    forceExit.unref();
    running
      .close()
      .catch((err: unknown) => console.error('종료 중 오류:', err))
      .finally(() => process.exit(0));
  };
  // SIGHUP: the terminal window was closed. SIGBREAK: Ctrl+Break in a Windows console (Windows has no SIGTERM).
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  for (const signal of signals) process.on(signal, shutdown);
}

if (import.meta.main) {
  await serverMain();
}
