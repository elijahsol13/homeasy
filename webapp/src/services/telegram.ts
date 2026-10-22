import { identifyTelegramUser } from './analytics';
import { openTelegramContact } from './contact-actions';

/** The official https://telegram.org/js/telegram-web-app.js exposes this global. */
interface TelegramWebApp {
  initData?: string;
  initDataUnsafe?: {
    start_param?: string;
    user?: Parameters<typeof identifyTelegramUser>[0];
  };
  ready: () => void;
  expand: () => void;
  enableClosingConfirmation?: () => void;
  themeParams?: Partial<Record<
    'bg_color' | 'text_color' | 'hint_color' | 'link_color' |
    'button_color' | 'button_text_color' | 'secondary_bg_color', string
  >>;
  HapticFeedback?: {
    selectionChanged?: () => void;
    notificationOccurred?: (type: 'success' | 'warning' | 'error') => void;
    impactOccurred?: (type: 'light' | 'medium' | 'heavy') => void;
  };
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

function telegramWebApp(): TelegramWebApp | undefined {
  return typeof window === 'undefined' ? undefined : window.Telegram?.WebApp;
}

export function isTelegramWebApp(): boolean {
  return Boolean(telegramWebApp()?.initData);
}

export function getTelegramStartParam(): string | undefined {
  return telegramWebApp()?.initDataUnsafe?.start_param;
}

export function initTelegramWebApp(): void {
  try {
    const webApp = telegramWebApp();
    if (webApp) {
      // Required official methods: a missing method indicates a broken bridge.
      webApp.ready();
      webApp.expand();
      webApp.enableClosingConfirmation?.();

      // Stitch Telegram user identity with PostHog
      const tgUser = webApp.initDataUnsafe?.user;
      if (tgUser?.id) {
        identifyTelegramUser(tgUser);
      }

      // Apply Telegram theme colors to CSS variables
      if (webApp.themeParams) {
        const root = document.documentElement;
        if (webApp.themeParams.bg_color) {
          root.style.setProperty('--tg-theme-bg-color', webApp.themeParams.bg_color);
        }
        if (webApp.themeParams.text_color) {
          root.style.setProperty('--tg-theme-text-color', webApp.themeParams.text_color);
        }
        if (webApp.themeParams.hint_color) {
          root.style.setProperty('--tg-theme-hint-color', webApp.themeParams.hint_color);
        }
        if (webApp.themeParams.link_color) {
          root.style.setProperty('--tg-theme-link-color', webApp.themeParams.link_color);
        }
        if (webApp.themeParams.button_color) {
          root.style.setProperty('--tg-theme-button-color', webApp.themeParams.button_color);
        }
        if (webApp.themeParams.button_text_color) {
          root.style.setProperty('--tg-theme-button-text-color', webApp.themeParams.button_text_color);
        }
        if (webApp.themeParams.secondary_bg_color) {
          root.style.setProperty('--tg-theme-secondary-bg-color', webApp.themeParams.secondary_bg_color);
        }
      }
    }
  } catch (err) {
    console.warn('[Telegram] Could not initialize Telegram WebApp SDK:', err);
  }
}

export function triggerHaptic(type: 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error' = 'light'): void {
  try {
    const feedback = telegramWebApp()?.HapticFeedback;
    if (feedback) {
      if (type === 'selection') {
        feedback.selectionChanged?.();
      } else if (type === 'success' || type === 'warning' || type === 'error') {
        feedback.notificationOccurred?.(type);
      } else {
        feedback.impactOccurred?.(type);
      }
    }
  } catch {
    // Fallback or ignore if haptics unavailable
  }
}

export function getTelegramInitData(): string {
  return telegramWebApp()?.initData || '';
}

export function openExternalUrl(url: string | null | undefined, e?: React.SyntheticEvent): void {
  if (!url) return;
  triggerHaptic('light');

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  if (targetUrl.startsWith('https://t.me/')) {
    openTelegramContact(targetUrl, e);
    return;
  }

  // 2. Try Telegram WebApp openLink for external websites
  try {
    const webApp = telegramWebApp();
    if (webApp?.openLink) {
      webApp.openLink(targetUrl);
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
