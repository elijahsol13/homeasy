import React, { useState } from 'react';

type Props = React.ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  fallbackSrcs?: readonly string[];
};

/** Source-hosted Facebook image URLs can expire before the listing does. */
export function PhotoWithFallback({ src, fallbackSrcs = [], alt, className = '', onError, ...rest }: Props) {
  const candidates = [src, ...fallbackSrcs]
    .filter((url, index, urls) => url && urls.indexOf(url) === index)
    .slice(0, 3);
  const candidateKey = JSON.stringify(candidates);
  const [failure, setFailure] = useState({ key: candidateKey, count: 0 });
  const attempt = failure.key === candidateKey ? failure.count : 0;
  const currentSrc = candidates[attempt];

  if (!currentSrc) {
    return (
      <div role="img" aria-label={alt || 'Photo unavailable'}
        className={`${className} flex items-center justify-center bg-zinc-200 dark:bg-zinc-800 text-zinc-500 text-xs text-center p-2`}>
        Photo unavailable
      </div>
    );
  }
  return <img src={currentSrc} alt={alt} className={className} onError={event => {
    setFailure(previous => ({
      key: candidateKey,
      count: (previous.key === candidateKey ? previous.count : 0) + 1,
    }));
    onError?.(event);
  }} {...rest} />;
}
