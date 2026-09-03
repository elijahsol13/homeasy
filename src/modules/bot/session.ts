import type { Context, SessionFlavor } from 'grammy';
import type { CityKey, PropertyCategory } from '../../config/settings';
import type { AppContainer } from '../../container';

// ─── Filter wizard draft ──────────────────────────────────────────────────────

export interface FilterDraft {
  type?: 'rent' | 'sale';
  category?: PropertyCategory | null;
  city?: CityKey;
  locations: string[];
  min_price?: number;
  max_price?: number;
  bedrooms?: number | null;
  requires_pool?: boolean;
  min_lease_preferred?: number | null;
}

// ─── Wizard steps ─────────────────────────────────────────────────────────────

export type WizardStep =
  | 'idle'
  | 'filter:type'
  | 'filter:category'
  | 'filter:city'
  | 'filter:locations'
  | 'filter:budget'
  | 'filter:budget:custom'
  | 'filter:bedrooms'
  | 'filter:pool'
  | 'filter:lease'
  | 'filter:confirm';

// ─── Session data ─────────────────────────────────────────────────────────────

export interface SessionData {
  wizardStep: WizardStep;
  filterDraft: FilterDraft;
}

export function initialSession(): SessionData {
  return {
    wizardStep: 'idle',
    filterDraft: { locations: [] },
  };
}

// ─── Augmented context ────────────────────────────────────────────────────────

export type MyContext = Context & SessionFlavor<SessionData> & { container: AppContainer };
