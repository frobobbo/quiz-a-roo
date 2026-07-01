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

let memUsers = new Map();   // username -> { id, passwordHash }
let memSessions = new Map(); // token -> { userId, expiresAt }
let memNextId = 1;

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
      return { id: user.id, username: u };
    }
    const passwordHash = await hashPassword(password);
    const id = memNextId++;
    memUsers.set(u, { id, passwordHash });
    return { id, username: u };
  }

  // DB mode
  const existing = await query('SELECT id, password_hash FROM users WHERE username = $1', [u]);
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) throw new Error('Invalid password');
    return { id: row.id, username: u };
  }
  const passwordHash = await hashPassword(password);
  const result = await query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
    [u, passwordHash]
  );
  return { id: result.rows[0].id, username: u };
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
  hashPassword,
  verifyPassword,
  getOrCreateUser,
  createSession,
  getSession,
  deleteSession,
  cleanupExpiredSessions,
  _resetMemoryForTests,
};
