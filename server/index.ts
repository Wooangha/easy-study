// HTTP server (DESIGN §4): JSON API, SSE chat turns, slide images and the web client.
//
//   node server/index.ts --dev   Express + Vite in middleware mode (HMR)
//   node server/index.ts         serves the production build in web/dist
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { COURSE_ID_RE, DOC_ID_RE, SESSION_ID_RE } from '../shared/types.ts';
import type {
  CreateSessionRequest,
  DocMeta,
  HealthResponse,
  ProviderId,
  ProviderInfo,
  StartDigestRequest,
  StreamEvent,
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
} from './chat.ts';
import type { ChatDeps } from './chat.ts';
import { HttpError, autoDigestEnabled, host, libraryDir, port, webDir, webDistDir } from './config.ts';
import {
  addDocToCourse,
  createCourse,
  deleteCourse,
  getCourse,
  listCourses,
  removeDocFromCourses,
  updateCourse,
  writeCourseMarkdown,
} from './courses.ts';
import {
  abortAllDigests,
  abortDigest,
  defaultDigestDeps,
  getDigestInfo,
  isDigestRunning,
  readDigestMarkdown,
  recoverInterruptedDigests,
  startDigest,
  waitForDigestsIdle,
} from './digest.ts';
import type { DigestDeps } from './digest.ts';
import {
  LibraryLockedError,
  acquireServerLock,
  coursePaths,
  deleteDoc,
  docPaths,
  getDoc,
  importPdf,
  listDocs,
  removeDeletedLeftovers,
  resumePendingIngests,
  retryIngest,
  slideFileName,
} from './library.ts';
import type { ServerLock } from './library.ts';
import { providerInfos } from './providers/index.ts';
import {
  buildNotes,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  recoverInterruptedSessions,
  toSession,
  writeNotes,
} from './sessions.ts';

const MAX_UPLOAD = '300mb';
const SSE_PING_MS = 15_000;
const IMMUTABLE_MAX_AGE_MS = 31_536_000 * 1000; // one year → "max-age=31536000"
/** Model names reach CLI argument lists: no leading dash, no whitespace. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function requireDoc(docId: string): Promise<DocMeta> {
  const doc = await getDoc(docId);
  if (!doc) throw new HttpError(404, '문서를 찾을 수 없습니다');
  return doc;
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
 * Provider + model of a request (POST /sessions, POST /digest): the provider must be known and
 * available; '' / omitted model = the provider's default. Throws HttpError 400 otherwise.
 */
function resolveProviderChoice(infos: ProviderInfo[], provider: unknown, model: unknown): { info: ProviderInfo; model: string } {
  const info = infos.find((candidate) => candidate.id === provider);
  if (!info) throw new HttpError(400, `알 수 없는 제공자입니다: ${String(provider)}`);
  if (!info.available) {
    throw new HttpError(400, `${info.label}을(를) 사용할 수 없습니다${info.reason ? `: ${info.reason}` : ''}`);
  }
  if (model !== undefined && typeof model !== 'string') throw new HttpError(400, '모델 이름이 올바르지 않습니다');
  const resolved = (model ?? '').trim() || info.defaultModel;
  if (resolved && !MODEL_RE.test(resolved)) throw new HttpError(400, `모델 이름이 올바르지 않습니다: ${resolved}`);
  return { info, model: resolved };
}

/** SendMessageRequest.neighbors / PrimeRequest.neighbors: absent, or an integer 0..3. */
function parseNeighbors(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_NEIGHBORS) {
    throw new HttpError(400, `neighbors는 0부터 ${MAX_NEIGHBORS} 사이의 정수여야 합니다`);
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

function sendFile(res: Response, file: string, options: Parameters<Response['sendFile']>[1]): Promise<void> {
  return new Promise((resolve, reject) => {
    res.sendFile(file, options ?? {}, (err) => (err ? reject(err) : resolve()));
  });
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

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The API has no authentication; binding to loopback keeps other machines out, and this guard
 * keeps web pages out: the Host must be a loopback name (defeats DNS rebinding) and state-changing
 * requests sent by a browser must come from our own origin (defeats cross-site "simple" POSTs).
 */
function localOriginOnly(req: Request, _res: Response, next: NextFunction): void {
  const hostHeader = req.headers.host ?? '';
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    next(new HttpError(403, '로컬 주소(127.0.0.1)로만 접속할 수 있습니다'));
    return;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === hostHeader.toLowerCase();
    } catch {
      // "null" or garbage: not our page.
    }
    if (!sameOrigin) {
      next(new HttpError(403, '다른 사이트에서 보낸 요청은 허용되지 않습니다'));
      return;
    }
  }
  next();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export function createApiRouter(options: AppOptions = {}): express.Router {
  const getProviderInfos = options.providerInfos ?? providerInfos;
  const chatDeps = options.chatDeps ?? defaultChatDeps();
  const digestDeps: DigestDeps = options.digestDeps ?? {
    ...defaultDigestDeps(),
    getProvider: chatDeps.getProvider,
    checkProvider: chatDeps.checkProvider,
  };
  const api = express.Router();

  api.use(localOriginOnly);

  // Invalid ids are answered with 404 before any handler (and any filesystem access) runs.
  api.param('docId', (_req, _res, next, value: string) => {
    next(DOC_ID_RE.test(value) ? undefined : new HttpError(404, '문서를 찾을 수 없습니다'));
  });
  api.param('sid', (_req, _res, next, value: string) => {
    next(SESSION_ID_RE.test(value) ? undefined : new HttpError(404, '세션을 찾을 수 없습니다'));
  });
  api.param('courseId', (_req, _res, next, value: string) => {
    next(COURSE_ID_RE.test(value) ? undefined : new HttpError(404, '과목을 찾을 수 없습니다'));
  });
  // Only parses application/json bodies; the raw PDF upload passes through untouched.
  api.use(express.json({ limit: '2mb' }));

  api.get('/health', async (_req, res) => {
    const body: HealthResponse = { ok: true, providers: await getProviderInfos(), libraryDir: libraryDir() };
    res.json(body);
  });

  // --- documents -------------------------------------------------------------------------------

  api.get('/docs', async (_req, res) => {
    res.json(await listDocs());
  });

  api.post('/docs', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, 'PDF 파일 내용이 비어 있습니다');
    // X-Course-Id: upload straight into a course ("과목" folder).
    const courseId = req.get('X-Course-Id')?.trim() || null;
    if (courseId !== null && (!COURSE_ID_RE.test(courseId) || (await getCourse(courseId)) === null)) {
      throw new HttpError(400, `과목을 찾을 수 없습니다: ${courseId}`);
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
   * Deletes a document with its slides, sessions, notes and digest (DESIGN §14). 409 while its PDF is
   * converted, its digest is made or one of its sessions is answering.
   */
  api.delete('/docs/:docId', async (req, res) => {
    const docId = req.params.docId;
    // Checked synchronously right before the deletion starts, so nothing can start in between.
    await deleteDoc(docId, () => {
      if (isDigestRunning(docId)) return '정리본을 만드는 중에는 지울 수 없습니다. 정리본 만들기를 먼저 중단해 주세요';
      if (hasRunningTurns(docId)) return '답변을 생성하는 중에는 지울 수 없습니다. 답변이 끝난 뒤에 다시 시도해 주세요';
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

  /** Converts a document whose conversion failed again (e.g. after installing poppler). 409 otherwise. */
  api.post('/docs/:docId/retry', async (req, res) => {
    res.status(202).json(await retryIngest(req.params.docId));
  });

  api.get('/docs/:docId/slides/:file', async (req, res) => {
    const doc = await getDoc(req.params.docId);
    const match = /^(\d{1,6})\.png$/.exec(req.params.file);
    const slide = match ? Number(match[1]) : 0;
    if (!doc || slide < 1 || slide > doc.pageCount) throw new HttpError(404, '슬라이드를 찾을 수 없습니다');
    const file = path.join(docPaths(doc.id).slidesDir, slideFileName(slide, doc.pageCount));
    try {
      await sendFile(res, file, { maxAge: IMMUTABLE_MAX_AGE_MS, immutable: true });
    } catch (err) {
      // Not rendered yet (still processing) or the client went away mid-transfer.
      if (!res.headersSent) throw new HttpError(404, '슬라이드를 찾을 수 없습니다');
      if ((err as NodeJS.ErrnoException).code !== 'ECONNABORTED') console.warn(`[http] ${req.path}: ${errorMessage(err)}`);
    }
  });

  // --- sessions ----------------------------------------------------------------------------------

  api.get('/docs/:docId/sessions', async (req, res) => {
    await requireDoc(req.params.docId);
    res.json(await listSessions(req.params.docId));
  });

  api.post('/docs/:docId/sessions', async (req, res) => {
    const docId = req.params.docId;
    await requireDoc(docId);
    const body = jsonBody(req) as Partial<Record<keyof CreateSessionRequest, unknown>>;
    const { info, model } = resolveProviderChoice(await getProviderInfos(), body.provider, body.model);
    const record = await createSession(docId, {
      provider: info.id,
      model,
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    await autoStartDigest(docId, info.id, model);
    res.status(201).json(toSession(record));
  });

  /**
   * The first session of a document starts its digest with the session's provider/model
   * (DESIGN §11; EASY_STUDY_AUTO_DIGEST=0 disables it). Never fails the request.
   */
  const autoStartDigest = async (docId: string, provider: ProviderId, model: string) => {
    if (!autoDigestEnabled()) return;
    try {
      if ((await getDigestInfo(docId)).status !== 'none') return;
      await startDigest(docId, { provider, model }, digestDeps);
    } catch (err) {
      // e.g. 409: the document is still being processed, or a job started concurrently.
      console.warn(`[digest] auto start for ${docId} skipped: ${errorMessage(err)}`);
    }
  };

  api.get('/docs/:docId/sessions/:sid', async (req, res) => {
    const record = await getSession(req.params.docId, req.params.sid);
    if (!record) throw new HttpError(404, '세션을 찾을 수 없습니다');
    res.json(toSession(record));
  });

  api.delete('/docs/:docId/sessions/:sid', async (req, res) => {
    const { docId, sid } = req.params;
    if (abortTurn(docId, sid)) await waitForTurn(docId, sid, 5_000);
    if (!(await deleteSession(docId, sid))) throw new HttpError(404, '세션을 찾을 수 없습니다');
    res.status(204).end();
  });

  /** Runs a turn, streaming it as SSE once it has started. */
  const streamTurn = async (req: Request, res: Response, kind: 'question' | 'prime') => {
    const docId = String(req.params.docId);
    const sessionId = String(req.params.sid);
    const body = jsonBody(req);
    const slide = body.slide;
    if (typeof slide !== 'number' || !Number.isInteger(slide)) throw new HttpError(400, '슬라이드 번호가 필요합니다');
    if (kind === 'question' && typeof body.text !== 'string') throw new HttpError(400, '질문을 입력해 주세요');
    const text = kind === 'question' ? String(body.text) : '';
    const neighbors = parseNeighbors(body.neighbors);

    // Abort the turn when the client goes away mid-stream. This must watch the *response*:
    // req 'close' fires as soon as the request body has been consumed.
    const disconnect = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) disconnect.abort(new Error('클라이언트 연결이 끊어져 중단되었습니다'));
    });

    const sse = lazySse(res);
    try {
      await runTurn(
        { docId, sessionId, kind, text, slide, neighbors, signal: disconnect.signal, onEvent: (event) => sse.send(event) },
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
    if (!(await getSession(docId, sid))) throw new HttpError(404, '세션을 찾을 수 없습니다');
    abortTurn(docId, sid);
    res.status(204).end();
  });

  // --- notes ---------------------------------------------------------------------------------------

  api.get('/docs/:docId/notes', async (req, res) => {
    res.json(await buildNotes(req.params.docId));
  });

  api.get('/docs/:docId/notes.md', async (req, res) => {
    const docId = req.params.docId;
    await requireDoc(docId);
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
    await requireDoc(docId);
    const body = jsonBody(req) as Partial<Record<keyof StartDigestRequest, unknown>>;
    if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, 'force는 true/false 여야 합니다');
    const { info, model } = resolveProviderChoice(await getProviderInfos(), body.provider, body.model);
    res.status(202).json(await startDigest(docId, { provider: info.id, model, force: body.force === true }, digestDeps));
  });

  api.post('/docs/:docId/digest/abort', async (req, res) => {
    await requireDoc(req.params.docId);
    abortDigest(req.params.docId);
    res.status(204).end();
  });

  api.get('/docs/:docId/digest.md', async (req, res) => {
    const markdown = await readDigestMarkdown(req.params.docId);
    if (markdown === null) throw new HttpError(404, '정리본이 아직 없습니다');
    sendMarkdown(res, markdown);
  });

  // --- courses ("과목") -----------------------------------------------------------------------------

  api.get('/courses', async (_req, res) => {
    res.json(await listCourses());
  });

  api.post('/courses', async (req, res) => {
    res.status(201).json(await createCourse(jsonBody(req).title));
  });

  api.patch('/courses/:courseId', async (req, res) => {
    const body = jsonBody(req);
    res.json(await updateCourse(req.params.courseId, { title: body.title, docIds: body.docIds }));
  });

  api.delete('/courses/:courseId', async (req, res) => {
    if (!(await deleteCourse(req.params.courseId))) throw new HttpError(404, '과목을 찾을 수 없습니다');
    res.status(204).end();
  });

  api.get('/courses/:courseId/summary.md', async (req, res) => {
    const courseId = req.params.courseId;
    if ((await getCourse(courseId)) === null) throw new HttpError(404, '과목을 찾을 수 없습니다');
    // Regenerated on every request: lecture titles and summaries may have changed since the last write.
    await writeCourseMarkdown(courseId);
    let markdown: string;
    try {
      markdown = await fs.readFile(coursePaths(courseId).courseMd, 'utf8');
    } catch {
      throw new HttpError(404, '과목을 찾을 수 없습니다'); // deleted in the meantime
    }
    sendMarkdown(res, markdown);
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'API 경로를 찾을 수 없습니다')));
  api.use(apiErrorHandler);
  return api;
}

/** Every API error becomes `{ "error": string }` with a 4xx/5xx status. */
function apiErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const bodyParserError = err as { status?: number; statusCode?: number; type?: string };
  let status = 500;
  let message = errorMessage(err);
  if (err instanceof HttpError) {
    status = err.status;
  } else if (bodyParserError.type === 'entity.too.large') {
    status = 413;
    message = `파일이 너무 큽니다 (최대 ${MAX_UPLOAD.toUpperCase()})`;
  } else if (bodyParserError.type === 'entity.parse.failed') {
    status = 400;
    message = '요청 본문이 올바른 JSON이 아닙니다';
  } else {
    const candidate = bodyParserError.status ?? bodyParserError.statusCode;
    if (typeof candidate === 'number' && candidate >= 400 && candidate < 600) status = candidate;
  }
  if (status >= 500) console.error(`[http] ${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message });
}

// ---------------------------------------------------------------------------
// Web client
// ---------------------------------------------------------------------------

function mountProductionClient(app: express.Express, log: boolean): void {
  const dist = webDistDir();
  const indexHtml = path.join(dist, 'index.html');
  if (!existsSync(indexHtml)) {
    if (log) {
      console.warn(
        `[web] ${path.relative(process.cwd(), dist) || dist} 이(가) 없습니다. ` +
          '`npm start`(빌드 후 실행) 또는 `npm run dev`(개발 모드)로 실행하세요.',
      );
    }
    app.use((_req, res) => {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('웹 클라이언트가 빌드되지 않았습니다 (web/dist 없음).\n`npm start` 또는 `npm run dev` 로 실행하세요.\n');
    });
    return;
  }
  // Vite emits content-hashed file names under assets/.
  app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: IMMUTABLE_MAX_AGE_MS, immutable: true }));
  app.use(express.static(dist, { index: false }));
  // SPA fallback.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
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
  /** Print startup information (default true). */
  log?: boolean;
}

export interface RunningServer {
  server: http.Server;
  url: string;
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

/**
 * Starts the server. Throws LibraryLockedError when another live server uses the same library
 * (library/.server.lock, DESIGN §14): nothing in the library is touched then.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? true;
  // First of all: one server per library. The startup sweeps below and resumed ingests rewrite files
  // that a running server may be working on.
  const lock: ServerLock = await acquireServerLock(options.port ?? port());

  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  let closeVite: (() => Promise<void>) | undefined;
  let url: string;
  try {
    // Before accepting requests: mark answers and digest jobs interrupted by a previous crash as aborted.
    const repaired = await recoverInterruptedSessions();
    if (log && repaired > 0) console.log(`[chat] marked unfinished answers of ${repaired} session(s) as aborted`);
    const interruptedDigests = await recoverInterruptedDigests();
    if (log && interruptedDigests > 0) console.log(`[digest] marked ${interruptedDigests} unfinished digest(s) as aborted`);
    const leftovers = await removeDeletedLeftovers();
    if (log && leftovers > 0) console.log(`[library] removed ${leftovers} leftover folder(s) of deleted documents`);

    app.use('/api', createApiRouter(options));
    if (options.dev) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        configFile: path.join(webDir(), 'vite.config.ts'),
        // HMR websocket shares our HTTP server (Vite 8: server.ws.server, formerly server.hmr.server).
        server: { middlewareMode: true, ws: { server } },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      closeVite = () => vite.close();
    } else {
      mountProductionClient(app, log);
    }

    await listen(server, options.port ?? port(), host());
    const { port: actualPort } = server.address() as AddressInfo;
    url = `http://${host()}:${actualPort}`;
    await lock.setPort(actualPort);
  } catch (err) {
    await closeVite?.().catch(() => {});
    await lock.release();
    throw err;
  }

  if (options.resumeIngests ?? true) {
    resumePendingIngests().catch((err: unknown) => console.error('[library] resuming ingests failed:', err));
  }

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      abortAllTurns();
      abortAllDigests();
      // Let aborted turns and digest jobs persist their partial results.
      await Promise.all([waitForIdle(4_000), waitForDigestsIdle(4_000)]);
      await closeVite?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await lock.release();
    })());
  return { server, url, close };
}

/** Why the server did not start because another one uses the library, and what to do about it. */
function libraryLockedMessage(err: LibraryLockedError, dev: boolean): string {
  const { holder } = err;
  return [
    `easy-study가 이미 이 라이브러리로 실행 중입니다 (pid ${holder.pid}): http://${host()}:${holder.port}`,
    `  라이브러리: ${libraryDir()}`,
    '  같은 라이브러리에 서버를 두 개 띄우면 서로의 작업(PDF 변환, 정리본, 답변)을 망가뜨리므로 시작하지 않았습니다.',
    '  - 이미 실행 중인 서버를 그대로 쓰거나, 그 서버를 먼저 종료하세요 (Ctrl+C).',
    `  - 다른 라이브러리로 하나 더 띄우려면: EASY_STUDY_LIBRARY=<다른 폴더> PORT=${holder.port + 1} npm run ${dev ? 'dev' : 'serve'}`,
    `  - 실행 중인 easy-study가 없는데도 이 메시지가 나오면 잠금 파일을 지우세요: ${err.lockFile}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const dev = process.argv.includes('--dev');
  let running: RunningServer;
  try {
    running = await startServer({ dev });
  } catch (err) {
    if (err instanceof LibraryLockedError) {
      console.error(libraryLockedMessage(err, dev));
    } else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Not an easy-study on this library (the library lock would have said so).
      console.error(
        `포트 ${port()}을(를) 다른 프로그램(또는 다른 라이브러리로 실행 중인 easy-study)이 쓰고 있습니다. ` +
          `다른 포트로 실행하세요: PORT=${port() + 1} npm run ${dev ? 'dev' : 'serve'}`,
      );
    } else {
      console.error('서버를 시작하지 못했습니다:', err);
    }
    process.exit(1);
  }

  console.log(`\n  easy-study ${dev ? '(dev)' : ''}  →  ${running.url}`);
  console.log(`  library     →  ${libraryDir()}\n`);

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
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) {
  await main();
}
