'use strict';

const fs = require('fs');
const path = require('path');
const { hasDatabase, query } = require('../index');

const DEFAULT_SITE_SETTINGS = {
  registrationEnabled: true,
  publicBaseUrl: '',
  siteName: 'quiz-a-roo',
};

function dataDir() { return process.env.DATA_DIR || path.join(__dirname, '..', '..'); }
function siteSettingsPath() { return path.join(dataDir(), 'site-settings.json'); }

function normalizeSiteSettings(settings = {}) {
  return {
    ...DEFAULT_SITE_SETTINGS,
    registrationEnabled: settings.registrationEnabled !== false,
    publicBaseUrl: typeof settings.publicBaseUrl === 'string' ? settings.publicBaseUrl.trim().replace(/\/+$/, '') : '',
    siteName: (typeof settings.siteName === 'string' && settings.siteName.trim()) ? settings.siteName.trim().slice(0, 80) : DEFAULT_SITE_SETTINGS.siteName,
  };
}

async function loadSiteSettings() {
  if (!hasDatabase()) {
    try {
      if (fs.existsSync(siteSettingsPath())) {
        return normalizeSiteSettings(JSON.parse(fs.readFileSync(siteSettingsPath(), 'utf8')));
      }
    } catch (e) { console.warn('Could not read site-settings.json:', e.message); }
    return { ...DEFAULT_SITE_SETTINGS };
  }
  try {
    const res = await query('SELECT key, value FROM site_settings', []);
    const out = {};
    for (const row of res.rows) out[row.key] = row.value;
    return normalizeSiteSettings(out);
  } catch {
    return { ...DEFAULT_SITE_SETTINGS };
  }
}

async function saveSiteSettings(settings) {
  const clean = normalizeSiteSettings(settings);
  if (!hasDatabase()) {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(siteSettingsPath(), JSON.stringify(clean, null, 2));
    return clean;
  }
  try {
    for (const [key, value] of Object.entries(clean)) {
      await query(
        'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
        [key, JSON.stringify(value)]
      );
    }
  } catch (e) {
    console.warn('Could not save site settings to database:', e.message);
  }
  return clean;
}

module.exports = {
  DEFAULT_SITE_SETTINGS,
  normalizeSiteSettings,
  loadSiteSettings,
  saveSiteSettings,
};
