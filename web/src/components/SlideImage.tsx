import { useState } from 'react';
import { checkSessionSoon, slideUrl } from '../api.ts';
import { useLoginEpoch } from '../hooks/useAuth.ts';

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
  /** Loaded (WebP or PNG): its natural size tells the image's aspect ratio. */
  onLoad?: (img: HTMLImageElement) => void;
}

/**
 * Lazily loaded slide image that uses a WebP rendition and falls back to the original PNG only when the
 * rendition fails to load (a decoded PNG takes about 2.7× the image memory, DESIGN §15).
 *
 * In remote mode an image also fails when the session has ended (401): a failure then asks the server
 * whether the session is still valid (→ login screen), and images that failed are loaded again after the
 * next login.
 */
export function SlideImage({ docId, slide, src, srcSet, sizes, alt, draggable, onFail, onLoad }: SlideImageProps) {
  const epoch = useLoginEpoch();
  const [failure, setFailure] = useState<{ src: string; epoch: number } | null>(null);
  const common = {
    alt,
    draggable,
    loading: 'lazy',
    decoding: 'async',
    onLoad: onLoad ? (e: { currentTarget: HTMLImageElement }) => onLoad(e.currentTarget) : undefined,
  } as const;
  if (failure && failure.src === src && failure.epoch === epoch) {
    return (
      <img
        key={`png:${epoch}`}
        src={slideUrl(docId, slide)}
        {...common}
        onError={() => {
          checkSessionSoon();
          onFail?.();
        }}
      />
    );
  }
  return (
    <img
      // A new element after a login: the browser tries a source that failed before again.
      key={failure ? `webp:${epoch}` : 'webp'}
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      {...common}
      onError={() => {
        checkSessionSoon();
        setFailure({ src, epoch });
      }}
    />
  );
}
