// Attachments waiting in the composer (DESIGN §21): regions selected on a slide and images pasted / dropped /
// picked. Each one is created on the server right away (so the chip can show the server's copy), then its id is
// sent with the next question. The chips belong to the open document; they survive slide changes, leave the
// composer when a question is sent and come back when the question was not accepted.
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { MAX_ATTACHMENT_BYTES, type AnnotationItem, type Attachment, type RegionRect } from '../../../shared/types.ts';
import * as api from '../api.ts';
import { msg } from '../i18n/index.ts';
import { itemBounds, unionRects } from '../lib/annotations/geometry.ts';
import {
  annotationAttachPlan,
  attachErrorMessage,
  attachmentLabel,
  attachmentTitle,
  chipOfItem,
  chipsReducer,
  classifyFiles,
  formatMegabytes,
  freeSlots,
  isGenericPastedName,
  isUploading,
  limitMessage,
  MAX_ATTACHMENT_MB,
  regionRequest,
  SUPPORTED_IMAGE_FORMATS,
  type Chip,
  type ChipAction,
  type ChipState,
} from '../lib/attachments.ts';
import { toast } from '../lib/toast.ts';
import { useLatest } from './useLatest.ts';

/**
 * How a region is cropped (DESIGN §29): `ink` false = without the student's 펜 strokes (the viewer's 필기 layer is
 * hidden or a replay is running: the crop shows what the student sees). A region made from a stroke has them anyway.
 */
export interface RegionOptions {
  ink?: boolean;
}

export interface AttachmentsApi {
  docId: string | null;
  /** Chips of the open document, in the order they were added. */
  items: Chip[];
  /** An image upload or a region crop is still running (sending waits for it). */
  uploading: boolean;
  /** Upload images (non-images and files that are too large are refused with a toast). */
  addFiles: (files: readonly File[], options?: { pasted?: boolean }) => void;
  /** Crop a region of a slide; resolves with the attachment, or null when it failed (a toast says why). */
  addRegion: (slide: number, rect: RegionRect, options?: RegionOptions) => Promise<Attachment | null>;
  /**
   * 📎 첨부 of an annotation item (DESIGN §25): a region attachment of the item's bounds that carries the item
   * (`Attachment.annotation`), as a chip like any region — sent with the next question, nothing now.
   */
  addAnnotation: (slide: number, item: AnnotationItem, options?: RegionOptions) => Promise<Attachment | null>;
  /**
   * 📎 첨부 of several selected items at once: the free slots are counted once (`annotationAttachPlan`) — one toast
   * for the items that did not fit, one for those attached already — and a chip is made for each of the rest (every
   * selected 펜 stroke in one, DESIGN §29).
   */
  addAnnotations: (slide: number, items: readonly AnnotationItem[], options?: RegionOptions) => Promise<Array<Attachment | null>>;
  /** Remove a chip (and the unused attachment on the server). */
  remove: (key: string) => void;
  /** Takes the ready chips out of the composer for sending (see restore). */
  take: () => { docId: string | null; chips: Chip[] };
  /** Puts back chips taken for a question that was not accepted. */
  restore: (taken: { docId: string | null; chips: Chip[] }) => void;
  /** Resolves when no upload / crop is running any more. */
  settle: () => Promise<void>;
  /** Chips of the open document right now (read at call time, not at the last render). */
  count: () => number;
  /** Remove the slide regions (their slide numbers belong to a deck that was swapped, DESIGN §28); images stay. */
  dropRegions: () => void;
}

interface InFlight {
  promise: Promise<unknown>;
  controller?: AbortController;
}

/** Re-render at most this often for upload progress (the hook lives at the top of the app). */
const PROGRESS_STEP = 0.05;

let chipSeq = 0;
const NO_CHIPS: Chip[] = [];

export function useAttachments(docId: string | null): AttachmentsApi {
  // The state lives in a ref and is updated synchronously: several files dropped at once, or a region added
  // and sent in the same click, must see each other's chips before React re-renders.
  const stateRef = useRef<ChipState>({ docId, items: [] });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const dispatch = useCallback((action: ChipAction) => {
    const next = chipsReducer(stateRef.current, action);
    if (next !== stateRef.current) {
      stateRef.current = next;
      rerender();
    }
  }, []);
  const inflight = useRef(new Map<string, InFlight>());
  const docIdRef = useLatest(docId);

  const revoke = (url: string | undefined) => {
    if (url) URL.revokeObjectURL(url);
  };

  const abortAll = useCallback(() => {
    for (const f of inflight.current.values()) f.controller?.abort();
    inflight.current.clear();
    for (const c of stateRef.current.items) revoke(c.localUrl);
  }, []);

  // Another document: its attachment ids mean nothing here. Unfinished uploads are cancelled (anything the
  // server already made and no message uses is swept after 24 h).
  useEffect(() => {
    if (stateRef.current.docId !== docId) {
      abortAll();
      dispatch({ type: 'reset', docId });
    }
  }, [docId, abortAll, dispatch]);
  useEffect(() => abortAll, [abortAll]);

  /** The current document's chips (none for one render right after switching documents). */
  const current = () => (stateRef.current.docId === docIdRef.current ? stateRef.current.items : []);

  /** A chip that finished after it was removed (or its document was left): delete the unused attachment. */
  const discardLate = (forDoc: string, key: string, attachment: Attachment) => {
    if (stateRef.current.docId === forDoc && stateRef.current.items.some((c) => c.key === key)) return false;
    api.deleteAttachment(forDoc, attachment.id).catch(() => {});
    return true;
  };

  const addFiles = useCallback(
    (files: readonly File[], options: { pasted?: boolean } = {}) => {
      const forDoc = docIdRef.current;
      if (!forDoc || files.length === 0) return;
      const { images, pdfs, others } = classifyFiles(files);
      const refused = [...pdfs, ...others];
      if (refused.length > 0) {
        toast(msg().chat.attachments.onlyImages(SUPPORTED_IMAGE_FORMATS, refused.map((f) => f.name).join(', ')), 'error');
      }
      const tooBig = images.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
      for (const f of tooBig) {
        toast(msg().chat.attachments.tooLargeFile(MAX_ATTACHMENT_MB, f.name, formatMegabytes(f.size)), 'error');
      }
      const wanted = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
      const free = freeSlots(current());
      if (wanted.length > free) toast(limitMessage(wanted.length - free), 'error');

      for (const file of wanted.slice(0, free)) {
        const key = `img-${++chipSeq}`;
        const name = options.pasted && isGenericPastedName(file.name) ? undefined : file.name || undefined;
        let localUrl: string | undefined;
        try {
          localUrl = URL.createObjectURL(file);
        } catch {
          localUrl = undefined;
        }
        const label = name ?? (options.pasted ? msg().chat.attachments.pastedImage : msg().chat.attachments.image);
        dispatch({
          type: 'add',
          item: {
            key,
            kind: 'image',
            label,
            title: attachmentTitle({ kind: 'image', name }),
            status: 'uploading',
            progress: 0,
            localUrl,
          },
        });
        const controller = new AbortController();
        let shown = 0;
        const promise = api
          .uploadAttachment(forDoc, file, {
            name,
            signal: controller.signal,
            onProgress: (fraction) => {
              if (fraction < 1 && fraction - shown < PROGRESS_STEP) return;
              shown = fraction;
              dispatch({ type: 'progress', key, fraction });
            },
          })
          .then((attachment) => {
            if (!discardLate(forDoc, key, attachment)) dispatch({ type: 'ready', key, attachment });
          })
          .catch((e: unknown) => {
            if (api.isAbortError(e)) return;
            const status = e instanceof api.ApiError ? e.status : -1;
            const message = status === -1 ? api.errorMessage(e) : attachErrorMessage(status, api.errorMessage(e));
            if (stateRef.current.docId === forDoc) toast(msg().chat.attachments.attachFailed(label, message), 'error');
            dispatch({ type: 'remove', keys: [key] });
          })
          .finally(() => {
            inflight.current.delete(key);
            revoke(localUrl);
          });
        inflight.current.set(key, { promise, controller });
      }
    },
    [docIdRef, dispatch],
  );

  /**
   * A region chip: a plain region, or one made from `item` standing for `members` (its ids; the item alone by
   * default — several 펜 strokes share one region).
   */
  const addRegionOf = useCallback(
    async (slide: number, rect: RegionRect, item: AnnotationItem | null, options: RegionOptions & { members?: readonly string[] } = {}): Promise<Attachment | null> => {
      const forDoc = docIdRef.current;
      if (!forDoc) return null;
      if (freeSlots(current()) === 0) {
        toast(limitMessage(1), 'error');
        return null;
      }
      const members = item ? (options.members ?? [item.id]) : [];
      // The same item twice would be two chips of one region: the first one stands.
      if (members.some((id) => current().some((c) => chipOfItem(c, id)))) {
        toast(msg().chat.attachments.alreadyAttached, 'info', 2500);
        return null;
      }
      const key = item ? `region-${++chipSeq}:${item.id}` : `region-${++chipSeq}`;
      const labelled = { kind: 'region' as const, slide, ...(item ? { annotation: { id: item.id, type: item.type } } : {}) };
      dispatch({
        type: 'add',
        item: {
          key,
          kind: 'region',
          label: attachmentLabel(labelled),
          title: attachmentTitle(labelled),
          slide,
          rect,
          status: 'uploading',
          progress: 0,
          ...(item ? { items: members } : {}),
        },
      });
      const promise = api
        .createRegion(forDoc, regionRequest(slide, rect, item, options.ink))
        .then((attachment) => {
          if (discardLate(forDoc, key, attachment)) return null;
          dispatch({ type: 'ready', key, attachment });
          return attachment;
        })
        .catch((e: unknown) => {
          const status = e instanceof api.ApiError ? e.status : -1;
          const message = status === -1 ? api.errorMessage(e) : attachErrorMessage(status, api.errorMessage(e));
          if (stateRef.current.docId === forDoc) {
            const m = msg().chat.attachments;
            toast(item ? m.annotationFailed(message) : m.regionFailed(message), 'error');
          }
          dispatch({ type: 'remove', keys: [key] });
          return null;
        })
        .finally(() => inflight.current.delete(key));
      inflight.current.set(key, { promise });
      return promise;
    },
    [docIdRef, dispatch],
  );

  const addRegion = useCallback((slide: number, rect: RegionRect, options?: RegionOptions) => addRegionOf(slide, rect, null, options), [addRegionOf]);

  const addAnnotation = useCallback(
    (slide: number, item: AnnotationItem, options?: RegionOptions) => addRegionOf(slide, itemBounds(item), item, options),
    [addRegionOf],
  );

  const addAnnotations = useCallback(
    (slide: number, items: readonly AnnotationItem[], options: RegionOptions = {}): Promise<Array<Attachment | null>> => {
      const { take, refused, attached } = annotationAttachPlan(current(), items);
      if (refused > 0) toast(limitMessage(refused), 'error');
      else if (attached > 0) {
        const m = msg().chat.attachments;
        toast(attached === items.length ? m.alreadyAttached : m.someAlreadyAttached(attached), 'info', 2500);
      }
      // Each one passes addRegionOf's own checks (the plan left room for all of them, none is attached yet); the
      // selected 펜 strokes are one region, the union of their bounds.
      return Promise.all(
        take.map(({ item, members }) =>
          members.length === 1
            ? addRegionOf(slide, itemBounds(item), item, options)
            : addRegionOf(slide, unionRects(members.map(itemBounds)), item, { ...options, members: members.map((m) => m.id) }),
        ),
      );
    },
    [addRegionOf],
  );

  const remove = useCallback(
    (key: string) => {
      const chip = stateRef.current.items.find((c) => c.key === key);
      const forDoc = stateRef.current.docId;
      if (!chip) return;
      inflight.current.get(key)?.controller?.abort();
      revoke(chip.localUrl);
      dispatch({ type: 'remove', keys: [key] });
      // Best effort: the server keeps an unused attachment for 24 h anyway.
      if (forDoc && chip.attachment) api.deleteAttachment(forDoc, chip.attachment.id).catch(() => {});
    },
    [dispatch],
  );

  const take = useCallback(() => {
    const forDoc = stateRef.current.docId;
    if (forDoc !== docIdRef.current) return { docId: forDoc, chips: [] };
    const chips = stateRef.current.items.filter((c) => c.status === 'ready' && c.attachment);
    if (chips.length > 0) dispatch({ type: 'remove', keys: chips.map((c) => c.key) });
    return { docId: forDoc, chips };
  }, [docIdRef, dispatch]);

  const restore = useCallback(
    (taken: { docId: string | null; chips: Chip[] }) => {
      if (taken.chips.length === 0) return;
      const before = stateRef.current.items;
      const back = taken.chips.filter((c) => !before.some((x) => x.key === c.key)).length;
      dispatch({ type: 'restore', docId: taken.docId, items: taken.chips });
      const lost = before.length + back - stateRef.current.items.length;
      if (stateRef.current.docId === taken.docId && lost > 0) toast(limitMessage(lost), 'error');
    },
    [dispatch],
  );

  const settle = useCallback(async () => {
    while (inflight.current.size > 0) {
      await Promise.allSettled([...inflight.current.values()].map((f) => f.promise));
    }
  }, []);

  const count = useCallback(
    () => (stateRef.current.docId === docIdRef.current ? stateRef.current.items.length : 0),
    [docIdRef],
  );

  const dropRegions = useCallback(() => {
    const forDoc = stateRef.current.docId;
    const regions = stateRef.current.items.filter((c) => c.kind === 'region');
    if (regions.length === 0) return;
    dispatch({ type: 'remove', keys: regions.map((c) => c.key) });
    // Best effort, like remove(); a crop still running is deleted when it finishes (discardLate).
    for (const c of regions) if (forDoc && c.attachment) api.deleteAttachment(forDoc, c.attachment.id).catch(() => {});
  }, [dispatch]);

  const items = stateRef.current.docId === docId ? stateRef.current.items : NO_CHIPS;
  const uploading = isUploading(items);
  return useMemo(
    () => ({ docId, items, uploading, addFiles, addRegion, addAnnotation, addAnnotations, remove, take, restore, settle, count, dropRegions }),
    [docId, items, uploading, addFiles, addRegion, addAnnotation, addAnnotations, remove, take, restore, settle, count, dropRegions],
  );
}
