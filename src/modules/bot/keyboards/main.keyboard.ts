import { InlineKeyboard } from 'grammy';
import { env } from '../../../config/env';

export interface MainMenuOptions {
  alertsPaused?: boolean;
  isAdmin?: boolean;
  webappUrl?: string;
}

export function mainMenuKeyboard(options?: boolean | MainMenuOptions): InlineKeyboard {
  const opts: MainMenuOptions =
    typeof options === 'boolean'
      ? { alertsPaused: options }
      : (options ?? {});

  const toggleAlertsLabel = opts.alertsPaused ? '▶️ Resume Alerts' : '⏸ Pause Alerts';
  const toggleAlertsData = opts.alertsPaused ? 'cb:alerts:resume' : 'cb:alerts:pause';

  const kb = new InlineKeyboard();

  const webUrl = opts.webappUrl !== undefined ? opts.webappUrl : env.WEBAPP_URL;
  if (webUrl && (webUrl.startsWith('https://') || webUrl.startsWith('http://'))) {
    // If https, can open as WebApp; otherwise url link
    if (webUrl.startsWith('https://')) {
      kb.webApp('📱 Open App (Map & Catalog)', webUrl).row();
    } else {
      kb.url('📱 Open App (Map & Catalog)', webUrl).row();
    }
  }

  kb.text('🔍 Search & Alerts', 'cb:menu:search').row();
  kb.text('🛠 Manage Alerts', 'cb:menu:filters').text('⭐ Favorites', 'cb:menu:favorites').row();
  kb.text(toggleAlertsLabel, toggleAlertsData);

  if (opts.isAdmin) {
    kb.row().text('👑 Admin Control Panel', 'cb:admin:menu');
  }

  return kb;
}
