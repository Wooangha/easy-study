// Text layouts for the highlight tools (lib/annotations/layoutCache.ts), for the viewer: `ensure` starts loading a
// slide's layout on pointerdown (so it is usually there by pointerup) and resolves with it, or with why it is not.
import { useCallback } from 'react';
import type { SlideTextLayout } from '../../../shared/types.ts';
import { loadTextLayout, peekTextLayout, type LayoutResult } from '../lib/annotations/layoutCache.ts';

export function useTextLayout(docId: string) {
  const ensure = useCallback((slide: number): Promise<LayoutResult> => loadTextLayout(docId, slide), [docId]);
  const peek = useCallback((slide: number): SlideTextLayout | null => peekTextLayout(docId, slide), [docId]);
  return { ensure, peek };
}
