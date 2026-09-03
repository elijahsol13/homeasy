import { InlineKeyboard } from 'grammy';

export function mainMenuKeyboard(alertsPaused = false): InlineKeyboard {
  const toggleAlertsLabel = alertsPaused ? '▶️ Resume Alerts' : '⏸ Pause Alerts';
  const toggleAlertsData = alertsPaused ? 'cb:alerts:resume' : 'cb:alerts:pause';

  return new InlineKeyboard()
    .text('🔍 Search & Alerts', 'cb:menu:search')
    .row()
    .text('🛠 Manage Alerts', 'cb:menu:filters')
    .text('⭐ Favorites', 'cb:menu:favorites')
    .row()
    .text(toggleAlertsLabel, toggleAlertsData);
}
