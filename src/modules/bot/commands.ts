import type { BotCommand } from 'grammy/types';

/**
 * Commands registered globally via bot.api.setMyCommands().
 * Admin-only commands are intentionally NOT listed here — they stay
 * accessible via the Admin Control Panel button or direct input.
 */
export const USER_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Start HomEasy & open main menu' },
  { command: 'search', description: '🎙️ / ✍️ AI Voice & Text Search' },
  { command: 'menu', description: 'Open main menu & search options' },
  { command: 'app', description: '📱 Open interactive map & catalog' },
  { command: 'myfilters', description: 'View & manage your search alerts' },
  { command: 'favorites', description: 'View saved listings' },
  { command: 'help', description: '❓ How HomEasy works & command list' },
  { command: 'stop', description: 'Unsubscribe from all notifications' },
] as const;
