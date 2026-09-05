import WebApp from '@twa-dev/sdk';

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

export function openExternalUrl(url: string): void {
  triggerHaptic('light');
  if (url.startsWith('https://t.me/') && typeof window !== 'undefined' && window.Telegram?.WebApp?.openTelegramLink) {
    WebApp.openTelegramLink(url);
  } else if (typeof window !== 'undefined' && window.Telegram?.WebApp?.openLink) {
    WebApp.openLink(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
