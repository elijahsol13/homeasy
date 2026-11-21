import { useState } from 'react';
import {
  getAnalyticsConsent,
  isAnalyticsConfigured,
  setAnalyticsConsent,
  type AnalyticsConsent,
} from '../services/analytics';

/** Mount once in either app shell. The site remains fully usable without a choice. */
export function AnalyticsPrivacy() {
  const [choice, setChoice] = useState<AnalyticsConsent>(getAnalyticsConsent);
  if (!isAnalyticsConfigured() || choice !== 'unknown' ||
      window.location.pathname.replace(/\/$/, '') === '/privacy') return null;

  function choose(consent: 'accepted' | 'declined') {
    setAnalyticsConsent(consent);
    setChoice(consent);
  }

  return (
    <aside
      role="region"
      aria-label="Analytics privacy preferences"
      className="fixed inset-x-3 bottom-4 z-40 mx-auto max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Optional analytics</p>
      <p className="mt-1 text-sm leading-5 text-zinc-600 dark:text-zinc-300">
        May we collect usage statistics to improve Homeasy? If you agree, we use a random browser ID
        stored on this device. We do not send names, contact details or search text. Learn more in our{' '}
        <a className="underline underline-offset-2" href="/privacy">privacy policy</a>.
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-100"
          onClick={() => choose('declined')}
        >
          No thanks
        </button>
        <button
          type="button"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          onClick={() => choose('accepted')}
        >
          Allow analytics
        </button>
      </div>
    </aside>
  );
}
