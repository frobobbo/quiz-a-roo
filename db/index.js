const { Pool } = require('pg');

function hasDatabase() {
  return !!process.env.DATABASE_URL;
}

let pool = null;
if (hasDatabase()) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (err) => console.error('[db] pool error:', err.message));
}

async function query(text, params) {
  return pool.query(text, params);
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { hasDatabase, pool, query, close };
