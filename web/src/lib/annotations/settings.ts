// Per-device annotation settings (DESIGN §25, AnnotationDeviceSettings): the color of new items, the layer
// toggle (필기 보기/숨기기), 질문 표시 보기, "학생의 메모를 튜터에게 보이기" (the only one the server sees, as
// SendMessageRequest.memos) and 그때 필기 재생. Tiny shared stores like hooks/useNeighbors.ts, so the viewer's 필기
// menu, the 녹음 tab and 설정 › 공부 show the same value. Persisted under storage.ts keys of the same names.
import { useSyncExternalStore } from 'react';
import { ANNOTATION_COLORS, type AnnotationColor } from '../../../../shared/types.ts';
import { isBoolean, readStorage, storageKeys, writeStorage } from '../storage.ts';

interface Store<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

function createStore<T>(key: string, fallback: T, validate: (v: unknown) => v is T): Store<T> {
  let current: T | undefined;
  const listeners = new Set<() => void>();
  const get = () => {
    if (current === undefined) current = readStorage(key, fallback, validate);
    return current;
  };
  return {
    get,
    set: (value) => {
      if (!validate(value) || value === get()) return;
      current = value;
      // The default is stored as the absence of the item (like the theme's 시스템 설정).
      writeStorage(key, value === fallback ? null : value);
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const isColor = (v: unknown): v is AnnotationColor => (ANNOTATION_COLORS as readonly unknown[]).includes(v);

const annotColor = createStore<AnnotationColor>(storageKeys.annotColor, 'yellow', isColor);
const annotLayer = createStore<boolean>(storageKeys.annotLayer, true, isBoolean);
const questionMarkers = createStore<boolean>(storageKeys.questionMarkers, true, isBoolean);
const memosToTutor = createStore<boolean>(storageKeys.memosToTutor, true, isBoolean);
const replayAnnotations = createStore<boolean>(storageKeys.replayAnnotations, false, isBoolean);

export const getAnnotColor = annotColor.get;
export const setAnnotColor = annotColor.set;
export const getAnnotLayer = annotLayer.get;
export const setAnnotLayer = annotLayer.set;
export const getQuestionMarkers = questionMarkers.get;
export const setQuestionMarkers = questionMarkers.set;
export const getMemosToTutor = memosToTutor.get;
export const setMemosToTutor = memosToTutor.set;
export const getReplayAnnotations = replayAnnotations.get;
export const setReplayAnnotations = replayAnnotations.set;
export const subscribeAnnotationSettings = {
  annotColor: annotColor.subscribe,
  annotLayer: annotLayer.subscribe,
  questionMarkers: questionMarkers.subscribe,
  memosToTutor: memosToTutor.subscribe,
  replayAnnotations: replayAnnotations.subscribe,
};

function useStore<T>(store: Store<T>) {
  const value = useSyncExternalStore(store.subscribe, store.get);
  return [value, store.set] as const;
}

/** Color of new items (the toolbar's dots). */
export const useAnnotColor = () => useStore(annotColor);
/** 필기 보기/숨기기: hidden → the layers unmount and the tools are disabled. */
export const useAnnotLayer = () => useStore(annotLayer);
/** 슬라이드에 질문 표시 보기. */
export const useQuestionMarkers = () => useStore(questionMarkers);
/** 학생의 메모를 튜터에게 보이기 (설정 › 공부; sent as SendMessageRequest.memos). */
export const useMemosToTutor = () => useStore(memosToTutor);
/** 그때 필기 재생 (effective only while a recording of the lecture is selected in the 녹음 tab). */
export const useReplayAnnotations = () => useStore(replayAnnotations);
