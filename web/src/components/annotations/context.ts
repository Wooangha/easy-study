// What the pieces inside an annotation layer (memo cards, markers, the item menu) need from the viewer: the
// stable actions (mutations go through the viewer, which owns the store, the selection and the undo history) and a
// few values. One context provided around the slides track, so per-slide props stay small.
import { createContext, useContext } from 'react';
import type { AnnotationItem, DocMeta, MarkerKey, Patchable } from '../../../../shared/types.ts';

export interface LayerActions {
  /** Select an item (null = clear the selection). */
  select: (slide: number, id: string | null) => void;
  /** Open (or close, null) a text box / memo for editing. */
  edit: (slide: number, id: string | null) => void;
  update: (slide: number, id: string, patch: Patchable<AnnotationItem>) => void;
  /** Delete an item (a memo with text asks first). */
  remove: (slide: number, id: string) => void;
  /** 📎 첨부: make a region attachment of the item for the next question. */
  attach: (slide: number, id: string) => void;
  /** Hide question markers (their Q&A stays). */
  hideMarkers: (slide: number, keys: MarkerKey[]) => void;
  openQa: (sessionId: string, messageId: string) => void;
  openNotes: (slide: number) => void;
  goToSlide: (slide: number) => void;
  openDoc: (docId: string, slide?: number) => void;
  playRecording: (rid: string, t: number) => void;
  /** Narrow panes: expand a memo in the bottom sheet instead of inline. */
  openSheet: (slide: number, id: string) => void;
}

export interface LayerEnv {
  docId: string;
  actions: LayerActions;
  /** The library's lectures (memo links to another lecture); null while unknown. */
  docs: DocMeta[] | null;
  focusedSlide: number;
  pageCount: number;
  /** This lecture's tags with counts (autocomplete). */
  tags: ReadonlyArray<{ tag: string; count: number }>;
  /** A narrow pane or a coarse pointer: memos collapse to pills and expand as a sheet. */
  compact: boolean;
}

export const LayerContext = createContext<LayerEnv | null>(null);

export function useLayerEnv(): LayerEnv {
  const env = useContext(LayerContext);
  if (!env) throw new Error('annotation layer pieces need a LayerContext');
  return env;
}
