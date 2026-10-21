import React, { useState } from 'react';

type Props = React.ImgHTMLAttributes<HTMLImageElement> & { src: string };

/** Source-hosted Facebook image URLs can expire before the listing does. */
export function PhotoWithFallback({ src, alt, className = '', onError, ...rest }: Props) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    return (
      <div role="img" aria-label={alt || 'Photo unavailable'}
        className={`${className} flex items-center justify-center bg-zinc-200 dark:bg-zinc-800 text-zinc-500 text-xs text-center p-2`}>
        Photo unavailable
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} onError={event => { setFailedSrc(src); onError?.(event); }} {...rest} />;
}
