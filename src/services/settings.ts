import fs from 'node:fs';
import path from 'node:path';

const SETTINGS_PATH = path.join(process.cwd(), 'data', 'scraper_settings.json');

export interface ScraperSettings {
  facebookEnabled: boolean;
}

const defaultSettings: ScraperSettings = {
  facebookEnabled: true,
};

export function getScraperSettings(): ScraperSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      return { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('[Settings] Failed to read scraper settings', e);
  }
  return defaultSettings;
}

export function saveScraperSettings(settings: Partial<ScraperSettings>): ScraperSettings {
  const current = getScraperSettings();
  const updated = { ...current, ...settings };
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Settings] Failed to save scraper settings', e);
  }
  return updated;
}
