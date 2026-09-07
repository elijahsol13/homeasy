import WebApp from '@twa-dev/sdk';
import posthog from 'posthog-js';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: typeof WebApp;
    };
  }
}

export function isTelegramWebApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.Telegram?.WebApp?.initData);
}

export function initTelegramWebApp(): void {
  try {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      WebApp.ready();
      WebApp.expand();
      WebApp.enableClosingConfirmation();

      // Stitch Telegram user identity with PostHog
      const tgUser = WebApp.initDataUnsafe?.user;
      if (tgUser?.id) {
        try {
          posthog.identify(String(tgUser.id), {
            username: tgUser.username,
            first_name: tgUser.first_name,
            last_name: tgUser.last_name,
            language_code: tgUser.language_code,
          });
        } catch (phErr) {
          console.warn('[PostHog] Error identifying user:', phErr);
        }
      }

      // Apply Telegram theme colors to CSS variables
      if (WebApp.themeParams) {
        const root = document.documentElement;
        if (WebApp.themeParams.bg_color) {
          root.style.setProperty('--tg-theme-bg-color', WebApp.themeParams.bg_color);
        }
        if (WebApp.themeParams.text_color) {
          root.style.setProperty('--tg-theme-text-color', WebApp.themeParams.text_color);
        }
        if (WebApp.themeParams.hint_color) {
          root.style.setProperty('--tg-theme-hint-color', WebApp.themeParams.hint_color);
        }
        if (WebApp.themeParams.link_color) {
          root.style.setProperty('--tg-theme-link-color', WebApp.themeParams.link_color);
        }
        if (WebApp.themeParams.button_color) {
          root.style.setProperty('--tg-theme-button-color', WebApp.themeParams.button_color);
        }
        if (WebApp.themeParams.button_text_color) {
          root.style.setProperty('--tg-theme-button-text-color', WebApp.themeParams.button_text_color);
        }
        if (WebApp.themeParams.secondary_bg_color) {
          root.style.setProperty('--tg-theme-secondary-bg-color', WebApp.themeParams.secondary_bg_color);
        }
      }
    }
  } catch (err) {
    console.warn('[Telegram] Could not initialize Telegram WebApp SDK:', err);
  }
}

export function triggerHaptic(type: 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error' = 'light'): void {
  try {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp?.HapticFeedback) {
      if (type === 'selection') {
        WebApp.HapticFeedback.selectionChanged();
      } else if (type === 'success' || type === 'warning' || type === 'error') {
        WebApp.HapticFeedback.notificationOccurred(type);
      } else {
        WebApp.HapticFeedback.impactOccurred(type);
      }
    }
  } catch {
    // Fallback or ignore if haptics unavailable
  }
}

export function getTelegramInitData(): string {
  try {
    return WebApp.initData || '';
  } catch {
    return '';
  }
}

export function openExternalUrl(url: string | null | undefined, e?: React.SyntheticEvent): void {
  if (!url) return;
  triggerHaptic('light');

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  // 1. Try Telegram WebApp openTelegramLink for t.me links
  if (targetUrl.startsWith('https://t.me/')) {
    try {
      if (typeof window !== 'undefined' && window.Telegram?.WebApp?.openTelegramLink) {
        window.Telegram.WebApp.openTelegramLink(targetUrl);
        if (e) e.preventDefault();
        return;
      }
    } catch (err) {
      console.warn('[Telegram] openTelegramLink failed:', err);
    }
  }

  // 2. Try Telegram WebApp openLink for external websites
  try {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(targetUrl);
      if (e) e.preventDefault();
      return;
    }
  } catch (err) {
    console.warn('[Telegram] openLink failed:', err);
  }

  // 3. Browser fallback
  try {
    const win = window.open(targetUrl, '_blank', 'noopener,noreferrer');
    if (win) {
      if (e) e.preventDefault();
      return;
    }
  } catch {
    // Popup was blocked
  }

  // 4. Ultimate fallback if window.open was blocked and event not prevented
  if (!e) {
    window.location.href = targetUrl;
  }
}
