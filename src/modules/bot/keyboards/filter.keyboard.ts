import { InlineKeyboard } from 'grammy';
import {
  BEDROOM_OPTIONS,
  BUDGET_RANGES,
  CATEGORY_OPTIONS,
  DISTRICTS,
  LEASE_OPTIONS,
  POOL_OPTIONS,
  type CityKey,
} from '../../../config/settings';

// ─── Step 1: Type ─────────────────────────────────────────────────────────────

export function typeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🏠 For Rent', 'cb:filter:type:rent')
    .text('🏷️ For Sale', 'cb:filter:type:sale')
    .row()
    .text('❌ Cancel', 'cb:filter:cancel');
}

// ─── Step 2: Category ─────────────────────────────────────────────────────────

export function categoryKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  CATEGORY_OPTIONS.forEach((cat, i) => {
    kb.text(cat.label, `cb:filter:cat:${i}`).row();
  });

  kb.text('❌ Cancel', 'cb:filter:cancel');
  return kb;
}

// ─── Step 3: City ─────────────────────────────────────────────────────────────

export function cityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🏙️ Phnom Penh', 'cb:filter:city:phnom_penh')
    .row()
    .text('🌴 Siem Reap', 'cb:filter:city:siem_reap')
    .row()
    .text('❌ Cancel', 'cb:filter:cancel');
}

// ─── Step 4: Locations ────────────────────────────────────────────────────────

export function locationsKeyboard(city: CityKey, selected: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const districts = DISTRICTS[city];

  districts.forEach((district, i) => {
    const isSelected = selected.includes(district);
    const label = isSelected ? `✅ ${district}` : `   ${district}`;
    kb.text(label, `cb:filter:loc:${i}`).row();
  });

  kb.text('🌍 Any Area (all)', 'cb:filter:loc:all')
    .row()
    .text(`✅ Done (${selected.length > 0 ? selected.length + ' selected' : 'all'})`, 'cb:filter:loc:done')
    .text('❌ Cancel', 'cb:filter:cancel');

  return kb;
}

// ─── Step 5: Budget ───────────────────────────────────────────────────────────

export function budgetKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  BUDGET_RANGES.forEach((range, i) => {
    kb.text(range.label, `cb:filter:budget:${i}`);
    if ((i + 1) % 2 === 0) kb.row();
  });

  kb.row()
    .text('✍️ Custom Budget (e.g. $150–$300)', 'cb:filter:budget:custom')
    .row()
    .text('💸 Any Budget', 'cb:filter:budget:any')
    .row()
    .text('❌ Cancel', 'cb:filter:cancel');

  return kb;
}

// ─── Step 6: Bedrooms ─────────────────────────────────────────────────────────

export function bedroomsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  BEDROOM_OPTIONS.forEach((opt, i) => {
    kb.text(opt.label, `cb:filter:beds:${i}`);
    if ((i + 1) % 3 === 0) kb.row();
  });

  kb.row().text('❌ Cancel', 'cb:filter:cancel');
  return kb;
}

// ─── Step 7: Pool Required? ───────────────────────────────────────────────────

export function poolKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  POOL_OPTIONS.forEach((opt, i) => {
    kb.text(opt.label, `cb:filter:pool:${i}`).row();
  });

  kb.text('❌ Cancel', 'cb:filter:cancel');
  return kb;
}

// ─── Step 8: Lease Term ───────────────────────────────────────────────────────

export function leaseKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  LEASE_OPTIONS.forEach((opt, i) => {
    kb.text(opt.label, `cb:filter:lease:${i}`).row();
  });

  kb.text('❌ Cancel', 'cb:filter:cancel');
  return kb;
}

// ─── Confirm ──────────────────────────────────────────────────────────────────

export function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Save Alert', 'cb:filter:confirm')
    .row()
    .text('🔄 Start Over', 'cb:filter:restart')
    .row()
    .text('❌ Cancel', 'cb:filter:cancel');
}
