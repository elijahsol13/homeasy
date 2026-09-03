import { InlineKeyboard } from 'grammy';
import {
  BUDGET_RANGES,
  CATEGORY_OPTIONS,
  DISTRICTS,
  LEASE_OPTIONS,
  POOL_OPTIONS,
  type CityKey,
} from '../../../config/settings';

// Helper to format bedrooms label e.g. "1, 2 BR", "Studio", "4+ BR", "Any"
export function formatBedroomsLabel(bedrooms: number[] | number | null | undefined): string {
  if (bedrooms === null || bedrooms === undefined) return 'Any';
  if (typeof bedrooms === 'number') {
    return bedrooms === 0 ? 'Studio' : bedrooms >= 4 ? '4+ BR' : `${bedrooms} BR`;
  }
  if (!Array.isArray(bedrooms) || bedrooms.length === 0) return 'Any';

  const sorted = [...bedrooms].sort((a, b) => a - b);
  const parts = sorted.map((b) => (b === 0 ? 'Studio' : b >= 4 ? '4+' : String(b)));

  if (parts.length === 1 && parts[0] === 'Studio') return 'Studio';
  if (parts.includes('Studio')) {
    const nonStudio = parts.filter((p) => p !== 'Studio');
    return nonStudio.length > 0 ? `Studio, ${nonStudio.join(', ')} BR` : 'Studio';
  }
  return `${parts.join(', ')} BR`;
}

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

  kb.text('◀️ Back', 'cb:filter:back:filter:type').text('❌ Cancel', 'cb:filter:cancel');
  return kb;
}

// ─── Step 3: City ─────────────────────────────────────────────────────────────

export function cityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🏙️ Phnom Penh', 'cb:filter:city:phnom_penh')
    .row()
    .text('🌴 Siem Reap', 'cb:filter:city:siem_reap')
    .row()
    .text('◀️ Back', 'cb:filter:back:filter:category')
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
    .row()
    .text('◀️ Back', 'cb:filter:back:filter:city')
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
    .text('◀️ Back', 'cb:filter:back:filter:locations')
    .text('❌ Cancel', 'cb:filter:cancel');

  return kb;
}

// ─── Step 6: Bedrooms (Multi-select) ──────────────────────────────────────────

export function bedroomsKeyboard(selected: number[] = []): InlineKeyboard {
  const kb = new InlineKeyboard();

  const options = [
    { label: 'Studio', value: 0 },
    { label: '1 BR', value: 1 },
    { label: '2 BR', value: 2 },
    { label: '3 BR', value: 3 },
    { label: '4+ BR', value: 4 },
  ];

  // Row 1: Studio, 1 BR, 2 BR
  options.slice(0, 3).forEach((opt) => {
    const isSelected = selected.includes(opt.value);
    const label = isSelected ? `✅ ${opt.label}` : `   ${opt.label}`;
    kb.text(label, `cb:filter:beds:toggle:${opt.value}`);
  });
  kb.row();

  // Row 2: 3 BR, 4+ BR, Any
  options.slice(3, 5).forEach((opt) => {
    const isSelected = selected.includes(opt.value);
    const label = isSelected ? `✅ ${opt.label}` : `   ${opt.label}`;
    kb.text(label, `cb:filter:beds:toggle:${opt.value}`);
  });
  kb.text('🛏 Any', 'cb:filter:beds:any');
  kb.row();

  // Row 3: Continue button with selected label
  const continueText =
    selected.length > 0 ? `➡️ Continue (${formatBedroomsLabel(selected)})` : '➡️ Continue (Any Bedrooms)';
  kb.text(continueText, 'cb:filter:beds:done').row();

  // Row 4: Back & Cancel
  kb.text('◀️ Back', 'cb:filter:back:filter:budget').text('❌ Cancel', 'cb:filter:cancel');

  return kb;
}

// ─── Step 7: Pool Required? ───────────────────────────────────────────────────

export function poolKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  POOL_OPTIONS.forEach((opt, i) => {
    kb.text(opt.label, `cb:filter:pool:${i}`).row();
  });

  kb.text('◀️ Back', 'cb:filter:back:filter:bedrooms').text('❌ Cancel', 'cb:filter:cancel');
  return kb;
}

// ─── Step 8: Lease Term ───────────────────────────────────────────────────────

export function leaseKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  LEASE_OPTIONS.forEach((opt, i) => {
    kb.text(opt.label, `cb:filter:lease:${i}`).row();
  });

  kb.text('◀️ Back', 'cb:filter:back:filter:pool').text('❌ Cancel', 'cb:filter:cancel');
  return kb;
}

// ─── Confirm ──────────────────────────────────────────────────────────────────

export function confirmKeyboard(type: 'rent' | 'sale' = 'rent'): InlineKeyboard {
  const backStep = type === 'rent' ? 'filter:lease' : 'filter:pool';
  return new InlineKeyboard()
    .text('✅ Save Alert', 'cb:filter:confirm')
    .row()
    .text('◀️ Back', `cb:filter:back:${backStep}`)
    .text('🔄 Start Over', 'cb:filter:restart')
    .row()
    .text('❌ Cancel', 'cb:filter:cancel');
}
