import { InlineKeyboard } from 'grammy';

/**
 * Interactive Admin Control Panel Keyboard
 */
export function adminMenuKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text('📊 Statistics & Metrics', 'cb:admin:stats')
    .text('📦 Backup Database', 'cb:admin:backup')
    .row();
  kb.text('✨ Run Enrichment', 'cb:admin:enrich')
    .row();
  kb.text('💬 Auth FB (In Chat)', 'cb:admin:auth:fb_chat')
    .text('🌐 Auth FB (Web)', 'cb:admin:auth:fb')
    .row();
  kb.text('🌐 Auth Khmer24', 'cb:admin:auth:k24')
    .text('📥 Import Session', 'cb:admin:auth:fb_import')
    .row();
  kb.text('📥 Ingest JSON Guide', 'cb:admin:ingest_help')
    .row();
  kb.text('◀️ Main Menu', 'cb:menu:main');
  return kb;
}

/**
 * Return to Admin Menu Keyboard
 */
export function adminBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('◀️ Admin Menu', 'cb:admin:menu');
}

/**
 * In-Chat Interactive Auth Control Keyboard
 */
export function authInChatKeyboard(options?: { is2FA?: boolean; isWaiting?: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text('👤 Ввести логин', 'cb:auth:fb:login')
    .text('🔑 Ввести пароль', 'cb:auth:fb:pass')
    .row();
  kb.text('🚀 Войти (Submit)', 'cb:auth:fb:submit')
    .text('📲 Ввести 2FA', 'cb:auth:fb:2fa')
    .row();
  kb.text('🔄 Обновить снимок', 'cb:auth:fb:refresh')
    .text('💾 Сохранить', 'cb:auth:fb:save')
    .row();
  kb.text('❌ Закрыть сессию', 'cb:auth:fb:cancel');
  return kb;
}

