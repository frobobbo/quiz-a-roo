'use strict';
const fs = require('fs');
const path = require('path');
const { hasDatabase, query } = require('../index');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../..');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

async function loadHistory(limit = 50, userId = 1) {
  if (hasDatabase()) {
    try {
      const { rows } = await query(
        'select entry from game_history where user_id = $1 order by played_at desc limit $2',
        [userId, limit]
      );
      return rows.map(r => r.entry);
    } catch (e) {
      console.error('[db] loadHistory failed:', e.message);
      return [];
    }
  }
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load history.json:', e.message);
  }
  return [];
}

// In DB mode, inserts a single entry and returns the refreshed array.
// In file mode, returns null (caller manages the in-memory array and calls saveHistoryFile).
async function appendHistory(entry, limit = 50, userId = 1) {
  if (hasDatabase()) {
    try {
      await query(
        'insert into game_history (user_id, entry, played_at) values ($1, $2::jsonb, now())',
        [userId, JSON.stringify(entry)]
      );
      const { rows } = await query(
        'select entry from game_history where user_id = $1 order by played_at desc limit $2',
        [userId, limit]
      );
      return rows.map(r => r.entry);
    } catch (e) {
      console.error('[db] appendHistory failed:', e.message);
      return null;
    }
  }
  return null;
}

async function clearHistory(userId = 1) {
  if (hasDatabase()) {
    try {
      await query('delete from game_history where user_id = $1', [userId]);
    } catch (e) {
      console.error('[db] clearHistory failed:', e.message);
    }
    return;
  }
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
  } catch (e) {
    console.error('Failed to clear history.json:', e.message);
  }
}

async function saveHistoryFile(history) {
  if (hasDatabase()) return;
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('Failed to save history.json:', e.message);
  }
}

module.exports = { loadHistory, appendHistory, clearHistory, saveHistoryFile };
