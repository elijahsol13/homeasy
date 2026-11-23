// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { PhotoWithFallback } from './PhotoWithFallback';

describe('hosted photo fallback', () => {
  it('loads media from the API origin, then the paired source URL, then a placeholder on errors', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const source = 'https://img.test/original.jpg?width=800&x=1';
    const hosted = `/api/v1/media/${'a'.repeat(64)}/thumb#source=${encodeURIComponent(source)}`;
    try {
      await act(async () => root.render(<PhotoWithFallback src={hosted} alt="Cover" />));
      const image = () => host.querySelector<HTMLImageElement>('img[alt="Cover"]');
      const apiOrigin = new URL(import.meta.env.VITE_API_URL || 'https://api.rustycat.cc/api/v1').origin;
      expect(image()?.src).toBe(`${apiOrigin}${hosted}`);
      await act(async () => image()?.dispatchEvent(new Event('error')));
      expect(image()?.src).toBe(source);
      await act(async () => image()?.dispatchEvent(new Event('error')));
      expect(image()).toBeNull();
      expect(host.querySelector('[role="img"]')?.textContent).toBe('Photo unavailable');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('uses a placeholder when a hosted file fails and has no usable original', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<PhotoWithFallback src={`/api/v1/media/${'b'.repeat(64)}/full`} alt="Photo" />));
      const image = host.querySelector('img');
      await act(async () => image?.dispatchEvent(new Event('error')));
      expect(host.querySelector('[role="img"]')?.textContent).toBe('Photo unavailable');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
