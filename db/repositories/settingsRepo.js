'use strict';
const fs = require('fs');
const path = require('path');
const { hasDatabase, query } = require('../index');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../..');

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

const DEFAULT_APP_SETTINGS = { gameDefaults: {}, defaultTheme: 'classic', customThemeVars: null };

async function loadAppSettings(defaultValue = DEFAULT_APP_SETTINGS) {
  if (hasDatabase()) {
    try {
      const { rows } = await query(
        'select value from app_settings where key = $1',
        ['app-settings']
      );
      if (rows.length > 0) return rows[0].value;
    } catch (e) {
      console.warn('[db] loadAppSettings failed, using default:', e.message);
    }
    return defaultValue;
  }
  try {
    const f = dataPath('app-settings.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn('Could not read app-settings.json:', e.message);
  }
  return defaultValue;
}

async function saveAppSettings(settings) {
  if (hasDatabase()) {
    try {
      await query(
        `insert into app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
         on conflict (key) do update set value = $2::jsonb, updated_at = now()`,
        ['app-settings', JSON.stringify(settings)]
      );
    } catch (e) {
      console.error('[db] saveAppSettings failed:', e.message);
    }
    return;
  }
  try {
    fs.writeFileSync(dataPath('app-settings.json'), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save app-settings.json:', e.message);
  }
}

// Config (API keys) is always file-based; env vars are applied by the caller.
function loadConfig(defaultValue = {}) {
  try {
    const f = dataPath('config.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn('Could not read config.json:', e.message);
  }
  return defaultValue;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(dataPath('config.json'), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('Failed to save config.json:', e.message);
  }
}

module.exports = { loadAppSettings, saveAppSettings, loadConfig, saveConfig };
