import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAnalytics } from './services/analytics';
import { AnalyticsPrivacy } from './components/AnalyticsPrivacy';
import { PrivacyPage } from './components/PrivacyPage';
import './index.css';
import App from './App.tsx';

initializeAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname.replace(/\/$/, '') === '/privacy' ? <PrivacyPage /> : <App />}
    <AnalyticsPrivacy />
  </StrictMode>,
);
