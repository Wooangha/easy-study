// HTTP routes of lecture recordings and the ASR engine (DESIGN §22). Mounted by server/index.ts inside the API
// router, after the Host/Origin guard and the login (remote mode): every route needs a session there. Errors are
// HttpErrors → JSON {error, …} through the API's error handler. Ids are validated before any file is touched.
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import { DOC_ID_RE, RECORDING_ID_RE } from '../../shared/types.ts';
import type { ProviderId, ProviderInfo } from '../../shared/types.ts';
import type { AcquireCliSlot } from '../cliBudget.ts';
import { HttpError } from '../config.ts';
import { docPaths } from '../library.ts';
import type { Provider } from '../providers/types.ts';
import { AI_ALIGN_SYSTEM_PROMPT } from './aiPrompt.ts';
import { SUPPORTED_UPLOADS, sniffMedia } from './ffmpeg.ts';
import {
  abortUpload,
  addSlideEvents,
  appendLiveAudio,
  asrStatus,
  beginUpload,
  createLiveRecording,
  deleteModel,
  deleteRecording,
  finishUpload,
  getRecording,
  getTranscript,
  listRecordings,
  pauseRecording,
  playbackSource,
  putMarkers,
  recordingsConfig,
  renameRecording,
  resumeRecording,
  startAiAlignment,
  startModelDownload,
  stopRecording,
  subscribe,
  uploadOptions,
} from './service.ts';
import type { UploadOptions } from './service.ts';
import { WAV_HEADER_BYTES, wavHeader } from './wav.ts';

/** Largest live audio chunk per request (the client batches a backlog in 512 KiB – 1 MiB pieces). */
export const MAX_AUDIO_CHUNK_BYTES = 2 * 1024 * 1024;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const HEAD_BYTES = 4096;

export interface RecordingRouteDeps {
  /** Provider + model of a request, validated like POST /sessions (400 unknown / unavailable). */
  resolveProvider: (provider: unknown, model: unknown) => Promise<{ info: ProviderInfo; model: string }>;
  getProvider: (id: ProviderId) => Provider | undefined;
  /** The CLI process budget (AI alignment calls take a 'digest' slot: chat turns go first). */
  cliSlot?: AcquireCliSlot;
}

function decodeFileName(header: string | undefined, fallback: string): string {
  if (!header) return fallback;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/** ENOSPC → 507 with a readable message (the client keeps the audio and retries later). */
function diskFull(err: unknown): unknown {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOSPC' ? new HttpError(507, '디스크 공간이 부족합니다. 공간을 확보한 뒤 다시 시도해 주세요') : err;
}

function jsonObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) && !Buffer.isBuffer(body) ? (body as Record<string, unknown>) : {};
}

/**
 * Streams a request body into `file` (backpressure: never more than a few chunks in memory). Stops at `max` bytes.
 * Returns the first bytes (for sniffing) and the size.
 */
function receiveBody(req: Request, file: string, max: number): Promise<{ bytes: number; head: Buffer } | { tooLarge: true }> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    let received = 0;
    let head = Buffer.alloc(0);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > max) {
        settled = true;
        req.pause();
        out.destroy();
        resolve({ tooLarge: true });
        return;
      }
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.once('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve({ bytes: received, head });
      });
    });
    req.once('error', (err) => fail(err));
    req.once('close', () => {
      if (!req.complete) fail(new Error('업로드가 중간에 끊겼습니다'));
    });
    out.once('error', (err) => fail(err));
  });
}

/**
 * Before answering 413 while the client is still sending: read a bounded rest off (≤ 16 MB, ≤ 5 s) so that the client
 * gets to read the answer instead of a reset connection. Resolves when the body ended or the bound was reached.
 */
function drainRest(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (req.complete || req.destroyed) {
      resolve();
      return;
    }
    let discarded = 0;
    const done = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      resolve();
    };
    const onData = (chunk: Buffer) => {
      discarded += chunk.length;
      if (discarded > 16 * 1024 * 1024) done();
    };
    const timer = setTimeout(done, 5_000);
    req.on('data', onData);
    req.once('end', done);
    req.once('close', done);
    req.resume();
  });
}

/** `Range: bytes=a-b | a- | -n` of a body of `size` bytes (null = whole body; 'unsatisfiable' → 416). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multiple or malformed ranges: the whole body
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Live playback: WAV = 44-byte header + audio.pcm as stored right now, with Range requests. */
function sendLiveWav(req: Request, res: Response, file: string, bytes: number): void {
  const total = WAV_HEADER_BYTES + bytes;
  const range = parseRange(req.get('Range'), total);
  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'no-store');
  if (range === 'unsatisfiable') {
    res.status(416).set('Content-Range', `bytes */${total}`).end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  if (range) res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.set('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  if (start < WAV_HEADER_BYTES) res.write(wavHeader(bytes).subarray(start, Math.min(end + 1, WAV_HEADER_BYTES)));
  if (end < WAV_HEADER_BYTES) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start: Math.max(0, start - WAV_HEADER_BYTES), end: end - WAV_HEADER_BYTES });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function createRecordingsRouter(deps: RecordingRouteDeps): express.Router {
  const router = express.Router();
  router.param('docId', (_req, _res, next, value: string) => {
    next(DOC_ID_RE.test(value) ? undefined : new HttpError(404, '문서를 찾을 수 없습니다'));
  });
  router.param('rid', (_req, _res, next, value: string) => {
    next(RECORDING_ID_RE.test(value) ? undefined : new HttpError(404, '녹음을 찾을 수 없습니다'));
  });
  router.param('modelId', (_req, _res, next, value: string) => {
    next(MODEL_ID_RE.test(value) ? undefined : new HttpError(404, '모델을 찾을 수 없습니다'));
  });

  // --- engine and models ----------------------------------------------------------------------------------------

  router.get('/asr', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await asrStatus());
  });

  router.post('/asr/models/:modelId/download', async (req, res) => {
    await startModelDownload(req.params.modelId as string);
    res.status(202).end();
  });

  router.delete('/asr/models/:modelId', async (req, res) => {
    await deleteModel(req.params.modelId as string);
    res.status(204).end();
  });

  // --- recordings -----------------------------------------------------------------------------------------------

  const base = '/docs/:docId/recordings';

  router.get(base, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await listRecordings(req.params.docId as string));
  });

  router.post(base, async (req, res) => {
    res.status(201).json(await createLiveRecording(req.params.docId as string, jsonObject(req)));
  });

  /**
   * Raw audio/video body (never buffered: streamed to disk), X-Filename = URI-encoded original name, optional
   * X-Language / X-Model (the recording settings).
   */
  router.post(`${base}/upload`, async (req, res) => {
    const docId = req.params.docId as string;
    const max = recordingsConfig().maxUploadBytes;
    // Refused before the body was read: read a bounded rest off first so that the client gets to see the answer.
    const refuse = async (err: HttpError) => {
      await drainRest(req);
      res.set('Connection', 'close');
      return err;
    };
    const tooLarge = () => {
      const limit = max >= 1024 ** 3 ? `${(max / 1024 ** 3).toFixed(0)} GB` : `${Math.ceil(max / 1024 ** 2)} MB`;
      return refuse(new HttpError(413, `녹음 파일이 너무 큽니다 (최대 ${limit})`, { maxBytes: max }));
    };
    const declared = Number(req.get('Content-Length'));
    if (Number.isFinite(declared) && declared > max) throw await tooLarge();
    const fileName = decodeFileName(req.get('X-Filename'), 'recording');
    let options: UploadOptions;
    let upload: { id: string; dir: string; partFile: string };
    try {
      // The recording settings of the web app (optional): X-Language ko|en|auto, X-Model <model id>.
      options = uploadOptions(req.get('X-Language'), req.get('X-Model'));
      upload = await beginUpload(docId);
    } catch (err) {
      throw err instanceof HttpError ? await refuse(err) : err;
    }
    let received: { bytes: number; head: Buffer } | { tooLarge: true };
    try {
      received = await receiveBody(req, upload.partFile, max);
    } catch (err) {
      await abortUpload(upload.dir);
      const mapped = diskFull(err);
      throw mapped instanceof HttpError ? mapped : new HttpError(400, err instanceof Error ? err.message : '업로드가 중간에 끊겼습니다');
    }
    if ('tooLarge' in received) {
      await abortUpload(upload.dir);
      throw await tooLarge();
    }
    if (received.bytes === 0) {
      await abortUpload(upload.dir);
      throw new HttpError(400, '녹음 파일 내용이 비어 있습니다');
    }
    const kind = sniffMedia(received.head, fileName);
    if (!kind) {
      await abortUpload(upload.dir);
      throw new HttpError(415, `오디오·동영상 파일이 아닙니다 (지원: ${SUPPORTED_UPLOADS})`);
    }
    res.status(201).json(await finishUpload(docId, upload.id, kind.ext, path.basename(fileName), options));
  });

  router.get(`${base}/:rid`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await getRecording(req.params.docId as string, req.params.rid as string));
  });

  router.get(`${base}/:rid/transcript`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await getTranscript(req.params.docId as string, req.params.rid as string));
  });

  /** Live PCM: 200 {offset} once fsynced; overlaps are skipped, a gap or a conflict is 409 {offset}. */
  const rawAudio = express.raw({ type: () => true, limit: MAX_AUDIO_CHUNK_BYTES });
  router.post(
    `${base}/:rid/audio`,
    (req, res, next) => {
      rawAudio(req, res, (err?: unknown) => {
        next(
          (err as { type?: string } | undefined)?.type === 'entity.too.large'
            ? new HttpError(413, `오디오 조각이 너무 큽니다 (최대 ${MAX_AUDIO_CHUNK_BYTES} 바이트)`, { maxBytes: MAX_AUDIO_CHUNK_BYTES })
            : err,
        );
      });
    },
    async (req, res) => {
      const raw = String(req.query.offset ?? '');
      const offset = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(offset)) throw new HttpError(400, 'offset(0 이상의 정수)이 필요합니다');
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, '오디오 내용이 비어 있습니다');
      if (offset % 2 !== 0 || body.length % 2 !== 0) throw new HttpError(400, 'PCM 16비트 샘플 단위(짝수 바이트)로 보내 주세요');
      try {
        res.json(await appendLiveAudio(req.params.docId as string, req.params.rid as string, offset, body));
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) res.set('Retry-After', '1');
        throw diskFull(err);
      }
    },
  );

  /** Playback: m4a for uploads (Range via send), WAV of the stored PCM for live recordings. */
  router.get(`${base}/:rid/audio`, async (req, res) => {
    const source = await playbackSource(req.params.docId as string, req.params.rid as string);
    if (source.kind === 'live') {
      sendLiveWav(req, res, source.file, source.bytes);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      res.sendFile(
        path.basename(source.file),
        { root: path.dirname(source.file), cacheControl: false, headers: { 'Content-Type': source.mime, 'Cache-Control': 'private, no-cache' } },
        (err) => {
          if (!err) resolve();
          else if (!res.headersSent) reject(new HttpError(404, '재생할 오디오가 아직 없습니다'));
          else resolve();
        },
      );
    });
  });

  router.post(`${base}/:rid/slides`, async (req, res) => {
    await addSlideEvents(req.params.docId as string, req.params.rid as string, req.body);
    res.status(204).end();
  });

  router.post(`${base}/:rid/pause`, async (req, res) => {
    res.json(await pauseRecording(req.params.docId as string, req.params.rid as string));
  });

  router.post(`${base}/:rid/resume`, async (req, res) => {
    res.json(await resumeRecording(req.params.docId as string, req.params.rid as string));
  });

  /** Optional body {bytes}: everything the client captured (the recording then ends once that much is stored). */
  router.post(`${base}/:rid/stop`, async (req, res) => {
    res.json(await stopRecording(req.params.docId as string, req.params.rid as string, jsonObject(req).bytes));
  });

  /** SSE: status / segment (id: segment id) / realigned / ping; `?since=` or Last-Event-ID replays newer segments. */
  router.get(`${base}/:rid/events`, async (req, res) => {
    const docId = req.params.docId as string;
    const rid = req.params.rid as string;
    await getRecording(docId, rid); // 404 as JSON before the stream opens
    const rawSince = req.get('Last-Event-ID') ?? (typeof req.query.since === 'string' ? req.query.since : '0');
    const since = /^\d{1,15}$/.test(rawSince.trim()) ? Number(rawSince.trim()) : 0;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    res.on('close', () => {
      closed = true;
      unsubscribe?.();
    });
    try {
      unsubscribe = await subscribe(docId, rid, res, since);
      if (closed) unsubscribe();
    } catch {
      if (!res.writableEnded) res.end();
    }
  });

  router.put(`${base}/:rid/markers`, async (req, res) => {
    res.json(await putMarkers(req.params.docId as string, req.params.rid as string, req.body));
  });

  /** {provider, model?} → 202; labels are fused chunk by chunk (progress: realigned + status events). */
  router.post(`${base}/:rid/align-ai`, async (req, res) => {
    const docId = req.params.docId as string;
    const rid = req.params.rid as string;
    const body = jsonObject(req);
    let { info, model } = await deps.resolveProvider(body.provider, body.model);
    // DESIGN §22: haiku unless the request names a model.
    if (body.model === undefined || body.model === '') model = info.models.find((m) => /haiku/i.test(m.id))?.id ?? model;
    const provider = deps.getProvider(info.id);
    if (!provider) throw new HttpError(400, `알 수 없는 제공자입니다: ${info.id}`);
    const cwd = docPaths(docId).dir;
    await startAiAlignment(docId, rid, {
      provider: info.id,
      model,
      call: async (parts, signal) => {
        let release: (() => void) | null = null;
        try {
          if (provider.kind === 'cli' && deps.cliSlot) release = await deps.cliSlot('digest', signal);
          let streamed = '';
          const result = await provider.run({
            cwd,
            systemPrompt: AI_ALIGN_SYSTEM_PROMPT,
            parts,
            resume: null,
            history: [],
            model,
            ephemeral: true,
            allowTools: false,
            signal,
            onDelta: (text) => {
              streamed += text;
            },
            onStatus: () => {},
          });
          return result.text.trim() ? result.text : streamed;
        } finally {
          release?.();
        }
      },
    });
    res.status(202).end();
  });

  router.patch(`${base}/:rid`, async (req, res) => {
    res.json(await renameRecording(req.params.docId as string, req.params.rid as string, jsonObject(req).title));
  });

  router.delete(`${base}/:rid`, async (req, res) => {
    await deleteRecording(req.params.docId as string, req.params.rid as string);
    res.status(204).end();
  });

  return router;
}
