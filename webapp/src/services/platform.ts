/** Choose the same surface for UI behavior and anonymous analytics. */
export function isTelegramWebApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.Telegram?.WebApp?.initData);
}

export function isWebSurface(): boolean {
  return import.meta.env.MODE === 'web' || !isTelegramWebApp();
}
