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
  kb.text(' Ingest JSON Guide', 'cb:admin:ingest_help')
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

