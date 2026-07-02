'use strict';

const assert = require('node:assert/strict');
const {
  normalizeUsername,
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

  await test('creates a new user as host by default', async () => {
    const u = await getOrCreateUser('testuser', 'pass1');
    assert.equal(u.username, 'testuser');
    assert.ok(typeof u.id === 'number');
    assert.equal(u.role, 'host');
  });

  await test('bootstrap admin requires matching environment username and password', async () => {
    _resetMemoryForTests();
    process.env.QUIZ_A_ROO_BOOTSTRAP_ADMIN_USERNAME = 'owner';
    process.env.QUIZ_A_ROO_BOOTSTRAP_ADMIN_PASSWORD = 'ownerpass';
    const wrong = await getOrCreateUser('randomuser', 'pass1');
    assert.equal(wrong.role, 'host');
    _resetMemoryForTests();
    const admin = await getOrCreateUser('owner', 'ownerpass');
    assert.equal(admin.role, 'site_admin');
    delete process.env.QUIZ_A_ROO_BOOTSTRAP_ADMIN_USERNAME;
    delete process.env.QUIZ_A_ROO_BOOTSTRAP_ADMIN_PASSWORD;
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
    assert.equal(a.role, 'host');
    assert.equal(b.role, 'host');
  });

  await test('userExists detects registered users', async () => {
    assert.equal(await userExists('alice99'), true);
    assert.equal(await userExists('missing-user'), false);
  });

  await test('listUsers and updateUser manage role and active status', async () => {
    const users = await listUsers();
    const alice = users.find(u => u.username === 'alice99');
    assert.ok(alice);
    const updated = await updateUser(alice.id, { role: 'site_admin', active: false });
    assert.equal(updated.role, 'site_admin');
    assert.equal(updated.active, false);
    const byId = await getUserById(alice.id);
    assert.equal(byId.role, 'site_admin');
    assert.equal(byId.active, false);
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
  const roleMigration = readSrc('db/migrations/003_roles_site_settings.sql');
  const libraryRepo = readSrc('db/repositories/libraryRepo.js');
  const settingsRepo = readSrc('db/repositories/settingsRepo.js');
  const historyRepo = readSrc('db/repositories/historyRepo.js');
  const userRepoSrc = readSrc('db/repositories/userRepo.js');
  const siteRepoSrc = readSrc('db/repositories/siteRepo.js');
  const serverSrc = readSrc('server.js');
  const loginHtml = readSrc('public/login.html');
  const adminHtml = readSrc('public/admin.html');
  const hostHtml = readSrc('public/host.html');
  const boardHtml = readSrc('public/board.html');
  const playerHtml = readSrc('public/player.html');

  await test('migration creates users table', () => {
    assert.ok(/create table if not exists users/.test(migration));
  });

  await test('migration creates user_sessions table', () => {
    assert.ok(/create table if not exists user_sessions/.test(migration));
  });

  await test('migration inserts default user', () => {
    assert.ok(/insert into users.*'default'/.test(migration.replace(/\n/g, ' ')));
  });

  await test('role migration adds roles and site settings without public admin promotion', () => {
    assert.ok(/add column if not exists role/.test(roleMigration));
    assert.ok(/site_admin/.test(roleMigration));
    assert.ok(/create table if not exists site_settings/.test(roleMigration));
    assert.ok(/registrationEnabled/.test(roleMigration));
    assert.ok(!/first_real_user/.test(roleMigration));
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

  await test('server exposes role-protected admin and host routes', () => {
    assert.ok(/app\.get\('\/admin'/.test(serverSrc));
    assert.ok(/requireRole\(\['host', 'site_admin'\]\)/.test(serverSrc));
    assert.ok(/requireRole\('site_admin'\)/.test(serverSrc));
    assert.ok(/app\.get\('\/api\/admin\/users'/.test(serverSrc));
    assert.ok(/app\.post\('\/api\/admin\/site-settings'/.test(serverSrc));
  });

  await test('host pin code path is removed', () => {
    assert.ok(!/HOST_PIN|HOST_TOKEN|host_auth|host-pin|Host PIN|2653/.test(serverSrc));
  });

  await test('server generates and validates 4-character game codes', () => {
    assert.ok(/const GAME_CODE_ALPHABET/.test(serverSrc));
    assert.ok(/function generateGameCode/.test(serverSrc));
    assert.ok(/code: generateGameCode\(\)/.test(serverSrc));
    assert.ok(/gameCode: game\.code/.test(serverSrc));
    assert.ok(/normalizeGameCode\(code\) !== game\.code/.test(serverSrc));
  });

  await test('server guards host-only socket events', () => {
    assert.ok(/io\.use\(async \(socket, next\)/.test(serverSrc));
    assert.ok(/const HOST_ONLY_EVENTS = new Set/.test(serverSrc));
    assert.ok(/function isHostSocket/.test(serverSrc));
    assert.ok(/HOST_ONLY_EVENTS\.has\(eventName\)/.test(serverSrc));
    assert.ok(/'set-theme'/.test(serverSrc));
    assert.ok(/'start-game'/.test(serverSrc));
  });

  await test('QR/player URL uses host headers or public base URL', () => {
    assert.ok(/x-forwarded-host/.test(serverSrc));
    assert.ok(/siteSettings\.publicBaseUrl/.test(serverSrc));
    assert.ok(/\/player\?code=/.test(serverSrc));
  });

  await test('userRepo supports roles and admin user management', () => {
    assert.ok(/normalizeRole/.test(userRepoSrc));
    assert.ok(/listUsers/.test(userRepoSrc));
    assert.ok(/updateUser/.test(userRepoSrc));
    assert.ok(/userExists/.test(userRepoSrc));
  });

  await test('siteRepo persists global site settings', () => {
    assert.ok(/DEFAULT_SITE_SETTINGS/.test(siteRepoSrc));
    assert.ok(/loadSiteSettings/.test(siteRepoSrc));
    assert.ok(/saveSiteSettings/.test(siteRepoSrc));
  });

  await test('server loads per-user state through scoped repos', () => {
    assert.ok(/async function loadUserState\(userId\)/.test(serverSrc));
    assert.ok(/settingsRepo\.loadAppSettings\([^\n]+userId/.test(serverSrc));
    assert.ok(/historyRepo\.loadHistory\(50, userId\)/.test(serverSrc));
    assert.ok(/libraryRepo\.listLibraries\(userId\)/.test(serverSrc));
    assert.ok(/historyRepo\.clearHistory\(activeUserId\)/.test(serverSrc));
  });

  await test('server prevents concurrent host users from switching global runtime state', () => {
    assert.ok(/function hasActiveHostSessionForOtherUser/.test(serverSrc));
    assert.ok(/async function activateHostUser/.test(serverSrc));
    assert.ok(/Another host is already active/.test(serverSrc));
    assert.ok(/409/.test(serverSrc));
  });

  await test('server preserves Spotify settings from current main', () => {
    assert.ok(/SPOTIFY_CLIENT_ID/.test(serverSrc));
    assert.ok(/SPOTIFY_CLIENT_SECRET/.test(serverSrc));
    assert.ok(/_spotifyToken = null/.test(serverSrc));
    assert.ok(/settingsRepo\.saveConfig\(cfg\)/.test(serverSrc));
  });

  await test('server startup preserves async user loading and ElevenLabs warmup', () => {
    assert.ok(/async function main\(\)/.test(serverSrc));
    assert.ok(/siteRepo\.loadSiteSettings\(\)/.test(serverSrc));
    assert.ok(/await loadUserState\(1\)/.test(serverSrc));
    assert.ok(/api\.elevenlabs\.io/.test(serverSrc));
  });

  await test('login form posts relatively for proxy compatibility', () => {
    assert.ok(/<form[^>]+method="POST"[^>]+action="login"/.test(loginHtml));
    assert.ok(/name="username"/.test(loginHtml));
    assert.ok(/name="password"/.test(loginHtml));
  });

  await test('login page documents new user creation', () => {
    assert.ok(/new username creates a new board/i.test(loginHtml));
  });

  await test('admin page manages settings and users', () => {
    assert.ok(/\/api\/admin\/site-settings/.test(adminHtml));
    assert.ok(/\/api\/admin\/users/.test(adminHtml));
    assert.ok(/Site Admin/.test(adminHtml));
    assert.ok(/Host/.test(adminHtml));
  });

  await test('host page displays game code instead of legacy pin UI', () => {
    assert.ok(/game-code-display/.test(hostHtml));
    assert.ok(!/host-pin-display|Legacy PIN/.test(hostHtml));
  });

  await test('board page displays game code with QR', () => {
    assert.ok(/board-game-code/.test(boardHtml));
    assert.ok(/player-url'.*code/s.test(boardHtml));
  });

  await test('player page accepts game code and sends it when joining', () => {
    assert.ok(/id="join-code"/.test(playerHtml));
    assert.ok(/join-player'.*code/s.test(playerHtml));
    assert.ok(/rejoin-player'.*code/s.test(playerHtml));
  });

  // --- summary ---

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
