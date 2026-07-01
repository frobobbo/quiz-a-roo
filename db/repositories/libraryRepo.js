'use strict';
const fs = require('fs');
const path = require('path');
const { hasDatabase, query } = require('../index');
const { defaultQuestions } = require('../../questions');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../..');
const LIBRARIES_DIR = path.join(DATA_DIR, 'libraries');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');

function defaultLibrary() {
  const categories = defaultQuestions.map((cat, i) => ({ ...cat, id: i }));
  return {
    categories,
    nextId: categories.length,
    activeIds: categories.map(c => c.id),
    pages: [{ id: 1, name: 'Page 1' }],
  };
}

async function listLibraries() {
  if (hasDatabase()) {
    try {
      const { rows } = await query('select name from libraries order by name');
      const names = rows.map(r => r.name);
      return names.length ? names : ['Default'];
    } catch (e) {
      console.warn('[db] listLibraries failed:', e.message);
      return ['Default'];
    }
  }
  try {
    if (!fs.existsSync(LIBRARIES_DIR)) return ['Default'];
    const names = fs.readdirSync(LIBRARIES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))
      .sort();
    return names.length ? names : ['Default'];
  } catch (e) {
    return ['Default'];
  }
}

async function loadLibrary(name) {
  if (hasDatabase()) {
    try {
      const { rows } = await query('select data from libraries where name = $1', [name]);
      if (rows.length > 0) return rows[0].data;
    } catch (e) {
      console.warn(`[db] loadLibrary(${name}) failed:`, e.message);
    }
    return defaultLibrary();
  }
  try {
    const libPath = path.join(LIBRARIES_DIR, name + '.json');
    if (fs.existsSync(libPath)) return JSON.parse(fs.readFileSync(libPath, 'utf8'));
    if (fs.existsSync(LIBRARY_FILE)) return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load library:', e.message);
  }
  return defaultLibrary();
}

async function saveLibrary(name, lib) {
  if (hasDatabase()) {
    try {
      await query(
        `insert into libraries (name, data, updated_at) values ($1, $2::jsonb, now())
         on conflict (name) do update set data = $2::jsonb, updated_at = now()`,
        [name, JSON.stringify(lib)]
      );
    } catch (e) {
      console.error(`[db] saveLibrary(${name}) failed:`, e.message);
    }
    return;
  }
  if (!fs.existsSync(LIBRARIES_DIR)) fs.mkdirSync(LIBRARIES_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(LIBRARIES_DIR, name + '.json'), JSON.stringify(lib, null, 2));
  } catch (e) {
    console.error('Failed to save library:', e.message);
  }
}

async function createLibrary(name, lib) {
  if (hasDatabase()) {
    try {
      await query(
        'insert into libraries (name, data) values ($1, $2::jsonb) on conflict (name) do nothing',
        [name, JSON.stringify(lib)]
      );
    } catch (e) {
      console.error(`[db] createLibrary(${name}) failed:`, e.message);
      throw e;
    }
    return;
  }
  if (!fs.existsSync(LIBRARIES_DIR)) fs.mkdirSync(LIBRARIES_DIR, { recursive: true });
  fs.writeFileSync(path.join(LIBRARIES_DIR, name + '.json'), JSON.stringify(lib, null, 2));
}

async function deleteLibrary(name) {
  if (hasDatabase()) {
    await query('delete from libraries where name = $1', [name]);
    return;
  }
  fs.unlinkSync(path.join(LIBRARIES_DIR, name + '.json'));
}

async function renameLibrary(oldName, newName) {
  if (hasDatabase()) {
    await query(
      'update libraries set name = $1, updated_at = now() where name = $2',
      [newName, oldName]
    );
    return;
  }
  fs.renameSync(
    path.join(LIBRARIES_DIR, oldName + '.json'),
    path.join(LIBRARIES_DIR, newName + '.json')
  );
}

// Ensures file-mode legacy library.json is migrated to named libraries, and
// in DB mode imports any existing JSON files if the libraries table is empty.
async function initializeLibraries(appSettings) {
  if (!hasDatabase()) {
    // File mode: ensure directory exists and migrate legacy single-file library
    if (!fs.existsSync(LIBRARIES_DIR)) fs.mkdirSync(LIBRARIES_DIR, { recursive: true });
    if (!appSettings.activeLibrary && fs.existsSync(LIBRARY_FILE)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
        fs.writeFileSync(path.join(LIBRARIES_DIR, 'Default.json'), JSON.stringify(legacy, null, 2));
        console.log('Migrated legacy library.json to libraries/Default.json');
      } catch (e) {
        console.warn('Library migration failed:', e.message);
      }
    }
    return;
  }

  // DB mode: import existing JSON files if the table is empty
  try {
    const { rows } = await query('select count(*)::int as cnt from libraries');
    if (rows[0].cnt > 0) return;

    if (fs.existsSync(LIBRARIES_DIR)) {
      const files = fs.readdirSync(LIBRARIES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const libName = file.slice(0, -5);
        try {
          const data = JSON.parse(fs.readFileSync(path.join(LIBRARIES_DIR, file), 'utf8'));
          await query(
            'insert into libraries (name, data) values ($1, $2::jsonb) on conflict (name) do nothing',
            [libName, JSON.stringify(data)]
          );
          console.log(`[db] Imported library: ${libName}`);
        } catch (e) {
          console.warn(`[db] Failed to import library ${libName}:`, e.message);
        }
      }
    } else if (fs.existsSync(LIBRARY_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
        await query(
          'insert into libraries (name, data) values ($1, $2::jsonb) on conflict (name) do nothing',
          ['Default', JSON.stringify(data)]
        );
        console.log('[db] Imported legacy library.json as Default');
      } catch (e) {
        console.warn('[db] Failed to import legacy library.json:', e.message);
      }
    }

    // Always ensure Default exists
    const { rows: check } = await query(
      'select count(*)::int as cnt from libraries where name = $1',
      ['Default']
    );
    if (check[0].cnt === 0) {
      await query(
        'insert into libraries (name, data) values ($1, $2::jsonb)',
        ['Default', JSON.stringify(defaultLibrary())]
      );
      console.log('[db] Created default library');
    }
  } catch (e) {
    console.error('[db] initializeLibraries failed:', e.message);
  }
}

module.exports = {
  listLibraries,
  loadLibrary,
  saveLibrary,
  createLibrary,
  deleteLibrary,
  renameLibrary,
  initializeLibraries,
};
