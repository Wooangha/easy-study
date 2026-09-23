import { useLayoutEffect, useRef } from 'react';

/** Ref that always holds the latest value (for use inside long-lived callbacks / listeners). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
