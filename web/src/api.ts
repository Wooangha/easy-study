// Typed client for the easy-study HTTP API (DESIGN.md §4). Same-origin, everything under /api.
import type {
  AuthStatusResponse,
  Course,
  CreateCourseRequest,
  CreateSessionRequest,
  DigestInfo,
  DocMeta,
  HealthResponse,
  NotesResponse,
  PrimeRequest,
  SendMessageRequest,
  Session,
  SessionSummary,
  StartDigestRequest,
  StreamEvent,
  UpdateCourseRequest,
} from '../../shared/types.ts';
import {
  getAuthSnapshot,
  loginPending,
  markLocalOnly,
  markUnauthorized,
  parseRetryAfter,
  waitForLogin,
} from './lib/auth.ts';

export class ApiError extends Error {
  readonly status: number;
  /** Seconds to wait before trying again (429 with Retry-After), else null. */
  readonly retryAfter: number | null;
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof Error && e.name === 'AbortError')
  );
}

/** Best-effort extraction of the server's `{ error }` message from a failed response. */
async function toApiError(res: Response): Promise<ApiError> {
  let message = '';
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      message = text.trim().slice(0, 300);
    }
  } catch {
    /* body unreadable */
  }
  if (!message) message = res.ok ? '예상하지 못한 응답 형식이에요' : `HTTP ${res.status} ${res.statusText}`.trim();
  const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null;
  return new ApiError(message, res.ok ? 500 : res.status, retryAfter);
}

// ---------------------------------------------------------------------------
// Login required (remote mode, DESIGN §16)
// ---------------------------------------------------------------------------
//
// A request answered 401 (no session, or it expired) shows the login screen and waits there: it is sent
// again after the next login and its caller simply gets the answer, so a question, an upload or a list
// being loaded is not lost, and polling pauses by itself. While the login screen is up, new requests wait
// before being sent; identical GETs share one request.

/** Resolves once a request can be sent (logged in, or the server needs no login). */
async function whenLoggedIn(signal?: AbortSignal | null): Promise<void> {
  while (loginPending()) await waitForLogin(getAuthSnapshot().epoch, signal);
}

/**
 * fetch() that waits for a login when the answer is 401 and then sends the request again. `init.body`
 * must be re-sendable (a string), which every JSON call here is.
 */
async function fetchWithLogin(path: string, init?: RequestInit): Promise<Response> {
  for (;;) {
    await whenLoggedIn(init?.signal);
    const epoch = getAuthSnapshot().epoch;
    let res: Response;
    try {
      res = await fetch(path, init);
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ApiError('서버에 연결할 수 없어요', 0);
    }
    if (res.status !== 401) return res;
    await res.body?.cancel().catch(() => {});
    // Answered 401 after a login that happened meanwhile (it was sent without the new cookie): just resend.
    if (getAuthSnapshot().epoch === epoch) markUnauthorized();
    await waitForLogin(epoch, init?.signal);
  }
}

/** GETs waiting for a login, by path: repeated polls of the same resource share one request. */
const parkedGets = new Map<string, Promise<unknown>>();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' && !init?.signal && loginPending()) {
    const parked = parkedGets.get(path);
    if (parked) return parked as Promise<T>;
    const shared = (async () => {
      try {
        await whenLoggedIn();
      } finally {
        parkedGets.delete(path);
      }
      return requestNow<T>(path, init);
    })();
    parkedGets.set(path, shared);
    return shared;
  }
  return requestNow<T>(path, init);
}

async function requestNow<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithLogin(path, init);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Auth routes (answered without a session)
// ---------------------------------------------------------------------------

export type AuthStatus = AuthStatusResponse;

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'same-origin', ...init });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApiError('서버에 연결할 수 없어요', 0);
  }
}

/**
 * GET /api/auth/status. A server from before the remote mode (404) needs no login. A 403 means the server
 * runs in local mode and this page was opened through another address (LAN IP, host name): the login screen
 * cannot help then, so the phase becomes `local` (the caller shows how to enable remote access).
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await authFetch('/api/auth/status', { cache: 'no-store' });
  if (res.status === 404) return { authRequired: false, authenticated: true };
  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 403) markLocalOnly(err.message);
    throw err;
  }
  const body = (await res.json()) as Partial<AuthStatus>;
  return { authRequired: body.authRequired === true, authenticated: body.authenticated !== false };
}

/** POST /api/auth/login. Throws ApiError 401 (wrong code), 429 (too many attempts; `retryAfter`), 0 (offline). */
export async function login(code: string): Promise<void> {
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw await toApiError(res);
}

/** POST /api/auth/logout: ends this browser's session. */
export async function logout(): Promise<void> {
  const res = await authFetch('/api/auth/logout', { method: 'POST' });
  if (!res.ok && res.status !== 401) throw await toApiError(res);
}

let lastSessionCheck = 0;
const SESSION_CHECK_INTERVAL_MS = 5000;

/**
 * Something that is not fetched through this module failed (a slide image): if a login is required,
 * ask whether the session is still valid and show the login screen when it is not. Throttled.
 */
export function checkSessionSoon(): void {
  const auth = getAuthSnapshot();
  if (auth.phase !== 'ok' || !auth.authRequired) return;
  const now = Date.now();
  if (now - lastSessionCheck < SESSION_CHECK_INTERVAL_MS) return;
  lastSessionCheck = now;
  const epoch = auth.epoch;
  getAuthStatus()
    .then((status) => {
      if (status.authRequired && !status.authenticated && getAuthSnapshot().epoch === epoch) markUnauthorized();
    })
    .catch(() => {
      /* offline: the next API call says so */
    });
}

function sendJSON<T>(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function postJSON<T>(path: string, body?: unknown): Promise<T> {
  return sendJSON<T>('POST', path, body);
}

const enc = encodeURIComponent;
const docPath = (docId: string) => `/api/docs/${enc(docId)}`;
const sessionPath = (docId: string, sid: string) => `${docPath(docId)}/sessions/${enc(sid)}`;
const coursePath = (courseId: string) => `/api/courses/${enc(courseId)}`;

// ---------------------------------------------------------------------------
// Plain JSON endpoints
// ---------------------------------------------------------------------------

export const getHealth = () => request<HealthResponse>('/api/health');

/** Fill round-2 fields an older server may omit, so the UI can rely on them. */
function normalizeDoc(d: DocMeta): DocMeta {
  return { ...d, courseId: d.courseId ?? null, digestStatus: d.digestStatus ?? 'none' };
}

export const listDocs = () => request<DocMeta[]>('/api/docs').then((list) => list.map(normalizeDoc));

export const getDoc = (docId: string) => request<DocMeta>(docPath(docId)).then(normalizeDoc);

/**
 * Delete a document and everything made from it (slides, sessions, notes, 정리본); it also leaves its
 * course. 409 while its conversion, digest or an answer is running.
 */
export const deleteDoc = (docId: string) => request<void>(docPath(docId), { method: 'DELETE' });

/** Run the PDF conversion again for a document whose conversion failed (status 'error'); 409 otherwise. */
export const retryDoc = (docId: string) => postJSON<DocMeta>(`${docPath(docId)}/retry`).then(normalizeDoc);

/**
 * Original 1600 px PNG of a slide. The browser only falls back to it when a WebP rendition fails to load:
 * a decoded PNG costs 4 bytes per pixel in the image cache, lossy WebP about 1.5 (DESIGN §15).
 */
export const slideUrl = (docId: string, slide: number) => `${docPath(docId)}/slides/${slide}.png`;

/** Widths of the lossy WebP display renditions — the server's VIEW_WIDTHS (server/assets.ts, checked by a test). */
export const VIEW_WIDTHS = [1000, 1600] as const;
export type ViewWidth = (typeof VIEW_WIDTHS)[number];

/** Lossy WebP display rendition of a slide (the server answers the PNG until the rendition exists). */
export const viewUrl = (docId: string, slide: number, width: ViewWidth) =>
  `${docPath(docId)}/view/${slide}.webp?w=${width}`;

/** `srcset` with every display rendition; pair it with a `sizes` that matches the rendered width. */
export const viewSrcSet = (docId: string, slide: number) =>
  VIEW_WIDTHS.map((w) => `${viewUrl(docId, slide, w)} ${w}w`).join(', ');

/** Small WebP thumbnail (240 px wide) for lists. */
export const thumbUrl = (docId: string, slide: number) => `${docPath(docId)}/thumbs/${slide}.webp`;

export const listSessions = (docId: string) => request<SessionSummary[]>(`${docPath(docId)}/sessions`);

export const createSession = (docId: string, body: CreateSessionRequest) =>
  postJSON<Session>(`${docPath(docId)}/sessions`, body);

export const getSession = (docId: string, sid: string) => request<Session>(sessionPath(docId, sid));

export const deleteSession = (docId: string, sid: string) =>
  request<void>(sessionPath(docId, sid), { method: 'DELETE' });

/** Ask the server to abort the running turn of a session (no-op if none is running). */
export const abortTurn = (docId: string, sid: string) => postJSON<void>(`${sessionPath(docId, sid)}/abort`);

export const getNotes = (docId: string) => request<NotesResponse>(`${docPath(docId)}/notes`);

export const notesMarkdownUrl = (docId: string) => `${docPath(docId)}/notes.md`;

// ---------------------------------------------------------------------------
// Digest ("정리본", DESIGN.md §11)
// ---------------------------------------------------------------------------

export const getDigest = (docId: string) => request<DigestInfo>(`${docPath(docId)}/digest`);

/** Start (or resume, or with `force` redo) the digest job. 409 when one is already running. */
export const startDigest = (docId: string, body: StartDigestRequest) =>
  postJSON<DigestInfo>(`${docPath(docId)}/digest`, body);

export const abortDigest = (docId: string) => postJSON<void>(`${docPath(docId)}/digest/abort`);

export const digestMarkdownUrl = (docId: string) => `${docPath(docId)}/digest.md`;

// ---------------------------------------------------------------------------
// Courses ("과목" folders, DESIGN.md §12)
// ---------------------------------------------------------------------------

/** Courses in creation order (oldest first). */
export const listCourses = () => request<Course[]>('/api/courses');

export const createCourse = (body: CreateCourseRequest) => postJSON<Course>('/api/courses', body);

/** Rename and/or replace the full ordered lecture list (documents omitted become uncategorized). */
export const updateCourse = (courseId: string, body: UpdateCourseRequest) =>
  sendJSON<Course>('PATCH', coursePath(courseId), body);

/** Delete a course folder. Its lectures are kept and become uncategorized. */
export const deleteCourse = (courseId: string) => request<void>(coursePath(courseId), { method: 'DELETE' });

export const courseSummaryUrl = (courseId: string) => `${coursePath(courseId)}/summary.md`;

/**
 * Upload a PDF as raw bytes. Uses XMLHttpRequest (not fetch) to get upload progress events.
 * With `courseId` the new lecture is added to that course (header X-Course-Id).
 * Resolves with the new DocMeta (status 'processing').
 */
export async function uploadPdf(
  file: File,
  onProgress?: (fraction: number) => void,
  courseId?: string | null,
): Promise<DocMeta> {
  for (;;) {
    await whenLoggedIn();
    // A login is required: do not send a large file just to have it refused.
    if (getAuthSnapshot().authRequired) {
      const status = await getAuthStatus().catch(() => null);
      if (status && status.authRequired && !status.authenticated) {
        markUnauthorized();
        continue;
      }
    }
    const epoch = getAuthSnapshot().epoch;
    try {
      return await uploadOnce(file, onProgress, courseId);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      if (getAuthSnapshot().epoch === epoch) markUnauthorized();
      onProgress?.(0);
      await waitForLogin(epoch);
    }
  }
}

function uploadOnce(file: File, onProgress?: (fraction: number) => void, courseId?: string | null): Promise<DocMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/docs');
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('X-Filename', enc(file.name));
    if (courseId) xhr.setRequestHeader('X-Course-Id', courseId);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object') {
        resolve(normalizeDoc(body as DocMeta));
        return;
      }
      const error = (body as { error?: unknown } | null)?.error;
      reject(new ApiError(typeof error === 'string' ? error : `업로드 실패 (HTTP ${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('업로드 중 네트워크 오류가 발생했어요', 0));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    xhr.send(file);
  });
}

// ---------------------------------------------------------------------------
// Server-Sent Events over fetch (POST streams)
// ---------------------------------------------------------------------------

/**
 * Incremental SSE parser. Feed decoded text with push(); complete frames (separated by a blank line)
 * are dispatched as (eventName, data). Comment lines (": ping") are ignored. CRLF/CR are accepted.
 */
export function createSSEParser(onFrame: (event: string, data: string) => void) {
  let buffer = '';

  const dispatch = (frame: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) onFrame(event, data.join('\n'));
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      // Normalise line endings, but keep a trailing CR: its LF may arrive in the next chunk.
      const trailingCR = buffer.endsWith('\r');
      let text = (trailingCR ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
      let sep: number;
      while ((sep = text.indexOf('\n\n')) !== -1) {
        dispatch(text.slice(0, sep));
        text = text.slice(sep + 2);
      }
      buffer = trailingCR ? `${text}\r` : text;
    },
    /** Flush a final frame that was not terminated by a blank line (lenient). */
    end() {
      const rest = buffer.replace(/\r\n?/g, '\n');
      buffer = '';
      if (rest.trim() !== '') dispatch(rest);
    },
  };
}

/**
 * POST a JSON body and consume the SSE response, calling onEvent for every StreamEvent.
 * Resolves when the stream ends. Throws ApiError when the server answers with a non-SSE error
 * (validation failures, 409 busy, ...), and an AbortError when `signal` aborts.
 */
export async function postStream(
  path: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchWithLogin(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream')) throw await toApiError(res);
  if (!res.body) throw new ApiError('응답 스트림을 읽을 수 없어요', res.status);

  const parser = createSSEParser((eventName, data) => {
    let parsed: StreamEvent;
    try {
      parsed = JSON.parse(data) as StreamEvent;
    } catch {
      console.warn('[easy-study] ignoring malformed SSE data', eventName, data);
      return;
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') onEvent(parsed);
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export const primeSession = (
  docId: string,
  sid: string,
  body: PrimeRequest,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) => postStream(`${sessionPath(docId, sid)}/prime`, body, onEvent, signal);

export const sendMessage = (
  docId: string,
  sid: string,
  body: SendMessageRequest,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) => postStream(`${sessionPath(docId, sid)}/messages`, body, onEvent, signal);

/** User-facing message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return '이미 답변을 생성하고 있어요. 끝난 뒤에 다시 시도해 주세요.';
    if (e.status === 401) return '로그인이 필요해요';
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
