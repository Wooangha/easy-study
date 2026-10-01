// HTTP routes of slide annotations (DESIGN §25): the per-lecture summary, the per-slide documents (GET / PUT /
// PATCH with optimistic concurrency), the SSE stream of a document, the 빠진 슬라이드 archive (DESIGN §28), the text
// layout of a slide and the library-wide tag list. Mounted by server/index.ts inside the API router, after the Host/Origin guard and the login (remote
// mode): every route needs a session there. Errors are HttpErrors → JSON {error, …} through the API's error handler.
// Ids are validated before any file is touched; `/annotations`, `/annotations/events` and `/annotations/removed` are
// registered before `/annotations/:slide` so the slide validator never sees 'events' or 'removed'.
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import { ANNOTATION_CLIENT_HEADER, ANNOTATION_CLIENT_ID_RE, DECK_REV_HEADER, DOC_ID_RE } from '../shared/types.ts';
import type { TextLayoutMissingResponse } from '../shared/types.ts';
import {
  listAnnotationTags,
  listRemovedSlides,
  patchSlideAnnotations,
  putSlideAnnotations,
  readSlideAnnotations,
  readSummary,
  removedThumbFile,
  subscribeAnnotations,
} from './annotations.ts';
import { HttpError } from './config.ts';
import { smsg } from './i18n.ts';
import { docPaths, notReadyError, readStoredDoc, requestDeckRev, requestTextBackfill, textExtractionPending } from './library.ts';
import { layoutFileName } from './pageNames.ts';

/** The writer's client id of a PUT / PATCH (its own events are not echoed to it), when the header carries a valid one. */
function clientOf(req: Request): string | undefined {
  const value = req.get(ANNOTATION_CLIENT_HEADER)?.trim();
  return value && ANNOTATION_CLIENT_ID_RE.test(value) ? value : undefined;
}

/** `?client=` of the events stream, when valid (else the subscriber gets every event). */
function clientOfQuery(req: Request): string | undefined {
  const value = typeof req.query.client === 'string' ? req.query.client.trim() : '';
  return value && ANNOTATION_CLIENT_ID_RE.test(value) ? value : undefined;
}

/** res.sendFile with the file's folder as `root` (Express refuses dot segments only below `root`, see index.ts). */
function sendFile(res: Response, file: string, options: Parameters<Response['sendFile']>[1]): Promise<void> {
  return new Promise((resolve, reject) => {
    res.sendFile(path.basename(file), { ...options, root: path.dirname(file) }, (err) => (err ? reject(err) : resolve()));
  });
}

export function createAnnotationsRouter(): express.Router {
  const router = express.Router();
  router.param('docId', (_req, _res, next, value: string) => {
    next(DOC_ID_RE.test(value) ? undefined : new HttpError(404, smsg().common.notFound.doc));
  });
  // An integer ≥ 1; the range (1..pageCount) is checked by the store.
  router.param('slide', (_req, _res, next, value: string) => {
    next(/^[1-9]\d{0,5}$/.test(value) ? undefined : new HttpError(404, smsg().common.notFound.slide));
  });
  // A deckRev of the 빠진 슬라이드 archive.
  router.param('rev', (_req, _res, next, value: string) => {
    next(/^\d{1,9}$/.test(value) ? undefined : new HttpError(404, smsg().common.notFound.slide));
  });

  /** Library-wide tag counts, for autocomplete. */
  router.get('/annotations/tags', async (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(await listAnnotationTags());
  });

  const base = '/docs/:docId/annotations';

  router.get(base, async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(await readSummary(req.params.docId as string));
  });

  /** SSE: slide (ops) / slide-reset / summary / qa / ping; no replay (clients refetch what they hold on reconnect). */
  router.get(`${base}/events`, async (req, res) => {
    const docId = req.params.docId as string;
    if ((await readStoredDoc(docId)) === null) throw new HttpError(404, smsg().common.notFound.doc); // as JSON, before the stream opens
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
      unsubscribe = await subscribeAnnotations(docId, res, clientOfQuery(req));
      if (closed) unsubscribe();
    } catch {
      if (!res.writableEnded) res.end();
    }
  });

  /** The 빠진 슬라이드 archive (RemovedSlide[], DESIGN §28): the 필기 of slides a new version dropped. */
  router.get(`${base}/removed`, async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(await listRemovedSlides(req.params.docId as string));
  });

  /** The old thumbnail of an archived slide (`<slide>.webp`; nothing else is served from the archive). */
  router.get(`${base}/removed/:rev/:file`, async (req, res) => {
    const file = await removedThumbFile(req.params.docId as string, Number(req.params.rev), req.params.file as string);
    if (!file) throw new HttpError(404, smsg().common.notFound.slide);
    try {
      await sendFile(res, file, { cacheControl: false, headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'image/webp' } });
    } catch (err) {
      if (!res.headersSent) throw new HttpError(404, smsg().common.notFound.slide);
      if ((err as NodeJS.ErrnoException).code !== 'ECONNABORTED') console.warn(`[http] ${req.path}: ${(err as Error).message}`);
    }
  });

  router.get(`${base}/:slide`, async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(await readSlideAnnotations(req.params.docId as string, Number(req.params.slide)));
  });

  // Writes name the deck their slide number belongs to (DECK_REV_HEADER, DESIGN §28): 409 deckChanged for another one.
  router.put(`${base}/:slide`, async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const deckRev = requestDeckRev(req.get(DECK_REV_HEADER));
    res.json(await putSlideAnnotations(req.params.docId as string, Number(req.params.slide), req.body, clientOf(req), deckRev));
  });

  router.patch(`${base}/:slide`, async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const deckRev = requestDeckRev(req.get(DECK_REV_HEADER));
    res.json(await patchSlideAnnotations(req.params.docId as string, Number(req.params.slide), req.body, clientOf(req), deckRev));
  });

  /**
   * The word boxes of a slide (text/NNN.layout.json, served with no-cache + ETag: it changes only with the engine).
   * 409 while the document is not ready; 404 `pending: true` when the backfill can still write it (asked for), 404
   * `pending: false` when it never will exist (no source.pdf, or the current engine already ran).
   */
  router.get('/docs/:docId/text-layout/:slide', async (req, res) => {
    const docId = req.params.docId as string;
    const doc = await readStoredDoc(docId);
    if (!doc) throw new HttpError(404, smsg().common.notFound.doc);
    if (doc.status !== 'ready') throw notReadyError(doc);
    const slide = Number(req.params.slide);
    if (slide > doc.pageCount) throw new HttpError(404, smsg().common.notFound.slide);
    const file = path.join(docPaths(docId).textDir, layoutFileName(slide, doc.pageCount));
    try {
      await sendFile(res, file, { cacheControl: false, headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json; charset=utf-8' } });
      return;
    } catch (err) {
      if (res.headersSent) {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNABORTED') console.warn(`[http] ${req.path}: ${(err as Error).message}`);
        return;
      }
    }
    const pending = await textExtractionPending(docId);
    if (pending) requestTextBackfill(docId);
    const body: Omit<TextLayoutMissingResponse, 'error'> = { pending };
    // 404 bodies (TextLayoutMissingResponse): the layout is still to come, or it never will be.
    const m = smsg().library.annotations;
    throw new HttpError(404, pending ? m.layoutPending : m.layoutNever, body);
  });

  return router;
}
