'use strict';

const assert = require('node:assert/strict');
const {
  normalizeUsername,
  hashPassword,
  verifyPassword,
  getOrCreateUser,
  createSession,
  getSession,
  deleteSession,
  _resetMemoryForTests,
} = require('../db/repositories/userRepo');

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

async function main() {
  // --- normalizeUsername ---

  console.log('\nnormalizeUsername');

  await test('trims and lowercases', () => {
    assert.equal(normalizeUsername('  Alice  '), 'alice');
  });

  await test('allows valid chars', () => {
    assert.equal(normalizeUsername('user_name.foo-bar'), 'user_name.foo-bar');
  });

  await test('rejects too short', () => {
    assert.throws(() => normalizeUsername('ab'), /3-50/);
  });

  await test('rejects too long', () => {
    assert.throws(() => normalizeUsername('a'.repeat(51)), /3-50/);
  });

  await test('rejects invalid chars', () => {
    assert.throws(() => normalizeUsername('bad user!'), /only contain/);
  });

  // --- hashPassword / verifyPassword ---

  console.log('\nhashPassword / verifyPassword');

  await test('hash does not contain plaintext', async () => {
    const h = await hashPassword('s3cr3t');
    assert.ok(!h.includes('s3cr3t'));
    assert.ok(h.startsWith('scrypt$'));
  });

  await test('verifyPassword returns true for correct password', async () => {
    const h = await hashPassword('correct');
    assert.ok(await verifyPassword('correct', h));
  });

  await test('verifyPassword returns false for wrong password', async () => {
    const h = await hashPassword('correct');
    assert.ok(!(await verifyPassword('wrong', h)));
  });

  // --- file-mode getOrCreateUser ---

  console.log('\ngetOrCreateUser (file mode)');

  _resetMemoryForTests();

  await test('creates a new user and returns id', async () => {
    const u = await getOrCreateUser('testuser', 'pass1');
    assert.equal(u.username, 'testuser');
    assert.ok(typeof u.id === 'number');
  });

  await test('authenticates same user with correct password', async () => {
    const u = await getOrCreateUser('testuser', 'pass1');
    assert.equal(u.username, 'testuser');
  });

  await test('rejects wrong password for existing user', async () => {
    await assert.rejects(() => getOrCreateUser('testuser', 'wrongpass'), /Invalid password/);
  });

  await test('creates distinct ids for different users', async () => {
    const a = await getOrCreateUser('alice99', 'pw');
    const b = await getOrCreateUser('bob99', 'pw');
    assert.notEqual(a.id, b.id);
  });

  // --- session management (file mode) ---

  console.log('\nsession management (file mode)');

  _resetMemoryForTests();

  await test('createSession returns a token and getSession retrieves it', async () => {
    const token = await createSession(42);
    assert.ok(typeof token === 'string' && token.length > 0);
    const s = await getSession(token);
    assert.ok(s !== null);
    assert.equal(s.userId, 42);
  });

  await test('getSession returns null for unknown token', async () => {
    assert.equal(await getSession('notavalidtoken'), null);
  });

  await test('deleteSession removes the session', async () => {
    const token = await createSession(7);
    await deleteSession(token);
    assert.equal(await getSession(token), null);
  });

  // --- static source assertions: user_id scoping ---

  console.log('\nstatic source assertions');

  const fs = require('fs');
  const path = require('path');

  function readSrc(rel) {
    return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  }

  const migration = readSrc('db/migrations/002_user_login.sql');
  const libraryRepo = readSrc('db/repositories/libraryRepo.js');
  const settingsRepo = readSrc('db/repositories/settingsRepo.js');
  const historyRepo = readSrc('db/repositories/historyRepo.js');
  const serverSrc = readSrc('server.js');
  const loginHtml = readSrc('public/login.html');

  await test('migration creates users table', () => {
    assert.ok(/create table if not exists users/.test(migration));
  });

  await test('migration creates user_sessions table', () => {
    assert.ok(/create table if not exists user_sessions/.test(migration));
  });

  await test('migration inserts default user', () => {
    assert.ok(/insert into users.*'default'/.test(migration.replace(/\n/g, ' ')));
  });

  await test('migration adds user_id to libraries', () => {
    assert.ok(/alter table libraries add column user_id/.test(migration));
  });

  await test('migration adds user_id to app_settings', () => {
    assert.ok(/alter table app_settings add column user_id/.test(migration));
  });

  await test('migration adds user_id to game_history', () => {
    assert.ok(/alter table game_history add column user_id/.test(migration));
  });

  await test('migration adds unique(user_id, name) to libraries', () => {
    assert.ok(/libraries_user_id_name_key/.test(migration));
  });

  await test('libraryRepo queries use user_id param', () => {
    assert.ok(/where user_id = \$1/.test(libraryRepo));
  });

  await test('libraryRepo methods accept userId arg with default', () => {
    assert.ok(/userId = 1/.test(libraryRepo));
  });

  await test('settingsRepo loadAppSettings scopes by user_id', () => {
    assert.ok(/user_id = \$1 and key/.test(settingsRepo) || /user_id.*key/.test(settingsRepo));
  });

  await test('settingsRepo saveAppSettings inserts with user_id', () => {
    assert.ok(/insert into app_settings \(user_id/.test(settingsRepo));
  });

  await test('settingsRepo methods accept userId arg with default', () => {
    assert.ok(/userId = 1/.test(settingsRepo));
  });

  await test('historyRepo loadHistory scopes by user_id', () => {
    assert.ok(/where user_id = \$1/.test(historyRepo));
  });

  await test('historyRepo appendHistory inserts user_id', () => {
    assert.ok(/insert into game_history \(user_id/.test(historyRepo));
  });

  await test('historyRepo clearHistory deletes by user_id', () => {
    assert.ok(/delete from game_history where user_id/.test(historyRepo));
  });

  await test('historyRepo methods accept userId arg with default', () => {
    assert.ok(/userId = 1/.test(historyRepo));
  });

  await test('server exposes login/logout routes', () => {
    assert.ok(/app\.get\('\/login'/.test(serverSrc));
    assert.ok(/app\.post\('\/login'/.test(serverSrc));
    assert.ok(/app\.get\('\/logout'/.test(serverSrc));
  });

  await test('server uses auth_token sessions', () => {
    assert.ok(/auth_token/.test(serverSrc));
    assert.ok(/userRepo\.createSession/.test(serverSrc));
    assert.ok(/userRepo\.getSession/.test(serverSrc));
  });

  await test('server loads per-user state through scoped repos', () => {
    assert.ok(/async function loadUserState\(userId\)/.test(serverSrc));
    assert.ok(/settingsRepo\.loadAppSettings\([^\n]+userId/.test(serverSrc));
    assert.ok(/historyRepo\.loadHistory\(50, userId\)/.test(serverSrc));
    assert.ok(/libraryRepo\.listLibraries\(userId\)/.test(serverSrc));
    assert.ok(/historyRepo\.clearHistory\(activeUserId\)/.test(serverSrc));
  });

  await test('login form posts relatively for proxy compatibility', () => {
    assert.ok(/<form[^>]+method="POST"[^>]+action="login"/.test(loginHtml));
    assert.ok(/name="username"/.test(loginHtml));
    assert.ok(/name="password"/.test(loginHtml));
  });

  await test('login page documents new user creation', () => {
    assert.ok(/new username creates a new board/i.test(loginHtml));
  });

  // --- summary ---

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
