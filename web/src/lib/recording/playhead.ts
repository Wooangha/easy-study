// The playhead of the recording playing in the 녹음 tab (DESIGN §25 "그때 필기 재생"): a tiny store written by the
// player (≈ 4 Hz from timeupdate, play/pause, and null when the player unmounts) and read by the slide viewer, which
// shows the annotations made up to that moment, and by a memo's "지금 재생 위치 연결". Written only while the replay
// toggle is on (or a memo asks), so nothing re-renders otherwise.
import { useSyncExternalStore } from 'react';

export interface Playhead {
  docId: string;
  rid: string;
  /** Seconds on the recording clock. */
  t: number;
  playing: boolean;
}

let current: Playhead | null = null;
const listeners = new Set<() => void>();

export function getPlayhead(): Playhead | null {
  return current;
}

/** Replace the playhead; the same values (or null twice) change nothing. */
export function setPlayhead(next: Playhead | null): void {
  if (samePlayhead(current, next)) return;
  current = next;
  for (const l of listeners) l();
}

/** Clear the playhead if it is the one of `rid` (the player of another recording may have taken over). */
export function clearPlayhead(rid: string): void {
  if (current?.rid === rid) setPlayhead(null);
}

export function samePlayhead(a: Playhead | null, b: Playhead | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.docId === b.docId && a.rid === b.rid && a.t === b.t && a.playing === b.playing;
}

export function subscribePlayhead(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePlayhead(): Playhead | null {
  return useSyncExternalStore(subscribePlayhead, getPlayhead);
}
