// "The recordings of this lecture changed" (a live recording started or stopped, an upload finished, one was
// deleted): the 녹음 tab reloads its list. A tiny event bus, so the recorder and the uploads need no UI imports.

type Listener = (docId: string) => void;

const listeners = new Set<Listener>();

export function notifyRecordingsChanged(docId: string): void {
  for (const l of listeners) l(docId);
}

export function onRecordingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
