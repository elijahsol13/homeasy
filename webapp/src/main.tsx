import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import posthog from 'posthog-js';
import './index.css';
import App from './App.tsx';

const posthogKey = import.meta.env.VITE_POSTHOG_API_KEY;
if (posthogKey) {
  try {
    posthog.init(posthogKey, {
      api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
      autocapture: false,
      capture_pageview: true,
    });
  } catch (err) {
    console.warn('[PostHog] Init error:', err);
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
