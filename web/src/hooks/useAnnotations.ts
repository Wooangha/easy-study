// The annotation store of the open document (lib/annotations/store.ts), for React: subscribing creates the store
// (reference counted; it lingers a little after the last viewer leaves), and the snapshot changes whenever a slide
// document, the summary, the undo history or the stream's state does.
import { useCallback, useSyncExternalStore } from 'react';
import type { SlideAnnotations } from '../../../shared/types.ts';
import { EMPTY_SNAPSHOT, annotationStore, peekAnnotationStore, type AnnotationSnapshot, type DocAnnotations } from '../lib/annotations/store.ts';

export interface AnnotationsState {
  store: DocAnnotations | null;
  snapshot: AnnotationSnapshot;
}

/** The store and its snapshot for `docId` (an empty snapshot and no store for null). */
export function useAnnotations(docId: string | null): AnnotationsState {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!docId) return () => {};
      const unsubscribe = annotationStore(docId).subscribe(listener);
      listener(); // the store may have been created just now
      return unsubscribe;
    },
    [docId],
  );
  const get = useCallback(() => (docId ? (peekAnnotationStore(docId)?.snapshot ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT), [docId]);
  const snapshot = useSyncExternalStore(subscribe, get);
  return { store: docId ? peekAnnotationStore(docId) : null, snapshot };
}

/** One slide's document from the store (null while not loaded or for no document). */
export function useSlideAnnotations(docId: string | null, slide: number): SlideAnnotations | null {
  const { snapshot } = useAnnotations(docId);
  return snapshot.slides.get(slide) ?? null;
}
