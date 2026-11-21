import { useState } from 'react';
import {
  getAnalyticsConsent,
  isAnalyticsConfigured,
  setAnalyticsConsent,
  type AnalyticsConsent,
} from '../services/analytics';

/** Public, directly addressable policy and consent settings for both builds. */
export function PrivacyPage() {
  const [consent, setConsent] = useState<AnalyticsConsent>(getAnalyticsConsent);
  const configured = isAnalyticsConfigured();

  function choose(value: 'accepted' | 'declined') {
    setAnalyticsConsent(value);
    setConsent(value);
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-5 py-10 text-zinc-800 dark:text-zinc-100">
      <a href="/" className="text-sm font-semibold text-sky-600 underline underline-offset-2 dark:text-sky-400">← Homeasy catalog</a>
      <h1 className="mt-7 text-3xl font-bold">Privacy & analytics</h1>
      <p className="mt-4 leading-relaxed">
        You can browse Homeasy without signing in. We display public property listings from the Homeasy API.
        Contact buttons may open external services such as Telegram, WhatsApp, phone or the original listing source.
        Those services handle data under their own policies.
      </p>
      <h2 className="mt-7 text-xl font-semibold">Data stored on your device</h2>
      <p className="mt-2 leading-relaxed">
        On the public website, Saved listings are kept in this browser’s local storage. They are not shared across
        devices and can disappear when browser data is cleared. The Telegram Mini App uses its existing authenticated
        favorites service. Your analytics choice is also stored locally so you do not have to answer repeatedly.
      </p>
      <h2 className="mt-7 text-xl font-semibold">Optional PostHog analytics</h2>
      <p className="mt-2 leading-relaxed">
        If you allow analytics, we send anonymous app usage events to PostHog, including which Homeasy surface you
        use, page category, listing reference, actions such as filters, saves and contact-button clicks, and limited
        campaign/referring-domain information. PostHog uses a randomly generated browser identifier to associate
        visits. We do not deliberately send your name, phone number, search text, message content or full listing URL.
        A contact-button click indicates interest; it does not establish that you contacted anyone or made a deal.
      </p>
      <p className="mt-3 leading-relaxed">
        Analytics is optional and is turned off until you allow it. We disable automatic interaction capture and
        session recordings. You can withdraw permission below at any time to stop subsequent analytics events.
        Essential catalog features remain usable either way.
      </p>
      <div className="mt-7 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
        <h2 className="text-lg font-semibold">Your analytics preference</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300" aria-live="polite">
          {consent === 'accepted' ? 'Allowed' : consent === 'declined' ? 'Declined' : 'Not chosen — analytics off'}
          {!configured ? ' · Analytics is not configured on this deployment.' : ''}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => choose('accepted')} disabled={!configured}
            className="rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            Allow analytics
          </button>
          <button type="button" onClick={() => choose('declined')}
            className="rounded-lg border border-zinc-300 px-4 py-2 font-semibold dark:border-zinc-500">
            Decline / withdraw
          </button>
        </div>
      </div>
    </main>
  );
}
