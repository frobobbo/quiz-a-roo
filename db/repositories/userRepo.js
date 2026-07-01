'use strict';

const crypto = require('crypto');
const { hasDatabase, query } = require('../index');

// --- username normalization ---

function normalizeUsername(username) {
  if (typeof username !== 'string') throw new Error('Username must be a string');
  const u = username.trim().toLowerCase();
  if (u.length < 3 || u.length > 50) throw new Error('Username must be 3-50 characters');
  if (!/^[a-z0-9_.\-]+$/.test(u)) throw new Error('Username may only contain a-z, 0-9, _, ., -');
  return u;
}

// --- password hashing ---

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, buf) =>
      err ? reject(err) : resolve(buf.toString('hex'))
    )
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

async function verifyPassword(password, storedHash) {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const actual = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEY_LEN, { N: +N, r: +r, p: +p }, (err, buf) =>
      err ? reject(err) : resolve(buf.toString('hex'))
    )
  );
  const a = Buffer.from(actual, 'hex'), b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- in-memory fallback state ---

let memUsers = new Map();   // username -> { id, username, passwordHash, role, active }
let memSessions = new Map(); // token -> { userId, expiresAt }
let memNextId = 1;

const VALID_ROLES = new Set(['site_admin', 'host']);

function normalizeRole(role) {
  return VALID_ROLES.has(role) ? role : 'host';
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: normalizeRole(user.role), active: user.active !== false };
}

function _resetMemoryForTests() {
  memUsers = new Map();
  memSessions = new Map();
  memNextId = 1;
}

// --- user management ---

async function getOrCreateUser(username, password) {
  const u = normalizeUsername(username);

  if (!hasDatabase()) {
    if (memUsers.has(u)) {
      const user = memUsers.get(u);
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) throw new Error('Invalid password');
      if (user.active === false) throw new Error('User disabled');
      return publicUser(user);
    }
    const passwordHash = await hashPassword(password);
    const id = memNextId++;
    const role = memUsers.size === 0 ? 'site_admin' : 'host';
    const user = { id, username: u, passwordHash, role, active: true };
    memUsers.set(u, user);
    return publicUser(user);
  }

  // DB mode
  const existing = await query('SELECT id, username, password_hash, role, active FROM users WHERE username = $1', [u]);
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) throw new Error('Invalid password');
    if (row.active === false) throw new Error('User disabled');
    return publicUser({ id: row.id, username: row.username || u, role: row.role, active: row.active });
  }
  const passwordHash = await hashPassword(password);
  const roleRes = await query("SELECT COUNT(*)::int AS count FROM users WHERE username <> 'default'", []);
  const role = Number(roleRes.rows[0]?.count || 0) === 0 ? 'site_admin' : 'host';
  const result = await query(
    'INSERT INTO users (username, password_hash, role, active) VALUES ($1, $2, $3, true) RETURNING id, username, role, active',
    [u, passwordHash, role]
  );
  return publicUser(result.rows[0]);
}

async function getUserById(userId) {
  if (!hasDatabase()) {
    for (const user of memUsers.values()) {
      if (+user.id === +userId) return publicUser(user);
    }
    return null;
  }
  try {
    const res = await query('SELECT id, username, role, active FROM users WHERE id = $1', [userId]);
    return res.rows.length ? publicUser(res.rows[0]) : null;
  } catch {
    return null;
  }
}

async function userExists(username) {
  const u = normalizeUsername(username);
  if (!hasDatabase()) return memUsers.has(u);
  const res = await query('SELECT 1 FROM users WHERE username = $1 LIMIT 1', [u]);
  return res.rows.length > 0;
}

async function listUsers() {
  if (!hasDatabase()) return [...memUsers.values()].map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
  const res = await query('SELECT id, username, role, active, created_at FROM users ORDER BY username', []);
  return res.rows.map(row => ({ ...publicUser(row), createdAt: row.created_at }));
}

async function updateUser(userId, changes = {}) {
  const role = changes.role !== undefined ? normalizeRole(changes.role) : undefined;
  const active = changes.active !== undefined ? !!changes.active : undefined;
  if (!hasDatabase()) {
    for (const user of memUsers.values()) {
      if (+user.id === +userId) {
        if (role !== undefined) user.role = role;
        if (active !== undefined) user.active = active;
        return publicUser(user);
      }
    }
    return null;
  }
  const current = await getUserById(userId);
  if (!current) return null;
  const nextRole = role !== undefined ? role : current.role;
  const nextActive = active !== undefined ? active : current.active;
  const res = await query(
    'UPDATE users SET role = $2, active = $3, updated_at = NOW() WHERE id = $1 RETURNING id, username, role, active',
    [userId, nextRole, nextActive]
  );
  return res.rows.length ? publicUser(res.rows[0]) : null;
}

// --- session management ---

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  if (!hasDatabase()) {
    memSessions.set(token, { userId, expiresAt });
    return token;
  }

  try {
    await query(
      'INSERT INTO user_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, userId, expiresAt]
    );
  } catch {
    // table may not exist yet; fall back to memory
    memSessions.set(token, { userId, expiresAt });
  }
  return token;
}

async function getSession(token) {
  if (!hasDatabase()) {
    const s = memSessions.get(token);
    if (!s) return null;
    if (s.expiresAt < new Date()) { memSessions.delete(token); return null; }
    return { userId: s.userId, expiresAt: s.expiresAt };
  }

  try {
    const res = await query(
      'SELECT user_id, expires_at FROM user_sessions WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    if (!res.rows.length) return null;
    return { userId: res.rows[0].user_id, expiresAt: res.rows[0].expires_at };
  } catch {
    const s = memSessions.get(token);
    if (!s || s.expiresAt < new Date()) return null;
    return { userId: s.userId, expiresAt: s.expiresAt };
  }
}

async function deleteSession(token) {
  if (!hasDatabase()) {
    memSessions.delete(token);
    return;
  }
  try {
    await query('DELETE FROM user_sessions WHERE token = $1', [token]);
  } catch {
    memSessions.delete(token);
  }
}

async function cleanupExpiredSessions() {
  if (!hasDatabase()) {
    const now = new Date();
    for (const [token, s] of memSessions) {
      if (s.expiresAt < now) memSessions.delete(token);
    }
    return;
  }
  try {
    await query('DELETE FROM user_sessions WHERE expires_at <= NOW()', []);
  } catch {
    // ignore if table absent
  }
}

module.exports = {
  normalizeUsername,
  normalizeRole,
  hashPassword,
  verifyPassword,
  getOrCreateUser,
  getUserById,
  userExists,
  listUsers,
  updateUser,
  createSession,
  getSession,
  deleteSession,
  cleanupExpiredSessions,
  _resetMemoryForTests,
};
