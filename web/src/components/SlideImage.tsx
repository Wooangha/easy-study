import { useState } from 'react';
import { slideUrl } from '../api.ts';

interface SlideImageProps {
  docId: string;
  slide: number;
  /** Preferred source: a lossy WebP rendition (view or thumbnail). */
  src: string;
  srcSet?: string;
  sizes?: string;
  alt: string;
  draggable?: boolean;
  /** The PNG fallback failed too. */
  onFail?: () => void;
}

/**
 * Lazily loaded slide image that uses a WebP rendition and falls back to the original PNG only when the
 * rendition fails to load (a decoded PNG takes about 2.7× the image memory, DESIGN §15).
 */
export function SlideImage({ docId, slide, src, srcSet, sizes, alt, draggable, onFail }: SlideImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const common = { alt, draggable, loading: 'lazy', decoding: 'async' } as const;
  if (failedSrc === src) {
    return <img key="png" src={slideUrl(docId, slide)} {...common} onError={onFail} />;
  }
  return <img key="webp" src={src} srcSet={srcSet} sizes={sizes} {...common} onError={() => setFailedSrc(src)} />;
}
