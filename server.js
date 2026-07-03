const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { defaultQuestions } = require('./questions');
const Anthropic = require('@anthropic-ai/sdk');

const settingsRepo = require('./db/repositories/settingsRepo');
const libraryRepo = require('./db/repositories/libraryRepo');
const historyRepo = require('./db/repositories/historyRepo');
const userRepo = require('./db/repositories/userRepo');
const siteRepo = require('./db/repositories/siteRepo');

const DATA_DIR = process.env.DATA_DIR || __dirname;

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.warn('Could not create data directory:', e.message); }
}

ensureDataDir();

function loadConfig() {
  try {
    const cfgPath = dataPath('config.json');
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) { console.warn('Could not read config.json:', e.message); }
  return {};
}
const config = loadConfig();
const https = require('https');
let apiKey = config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
let anthropic = apiKey ? new Anthropic({ apiKey, httpAgent: new https.Agent({ rejectUnauthorized: false }) }) : null;
let elevenLabsKey = config.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY || '';
const elevenLabsAgent = new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: false });
let spotifyClientId     = config.SPOTIFY_CLIENT_ID     || '';
let spotifyClientSecret = config.SPOTIFY_CLIENT_SECRET || '';
let _spotifyToken = null, _spotifyTokenExpiry = 0;

function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry - 60000) return Promise.resolve(_spotifyToken);
  if (!spotifyClientId || !spotifyClientSecret) return Promise.reject(new Error('Spotify credentials not configured. Add them in Settings.'));
  const creds = Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString('base64');
  const body  = 'grant_type=client_credentials';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'accounts.spotify.com', path: '/api/token', method: 'POST',
      rejectUnauthorized: false,
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString());
          if (!d.access_token) return reject(new Error('Spotify auth failed — check Client ID / Secret.'));
          _spotifyToken = d.access_token;
          _spotifyTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000;
          resolve(_spotifyToken);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function searchSpotifyTracks(query, limit = 50) {
  return getSpotifyToken().then(token => new Promise((resolve, reject) => {
    const path = `/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&market=US`;
    const req = https.request({
      hostname: 'api.spotify.com', path, method: 'GET',
      rejectUnauthorized: false,
      headers: { 'Authorization': `Bearer ${token}` },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString()).tracks?.items || []); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Spotify search timed out.')); });
    req.end();
  }));
}

function searchDeezerTracks(query, limit = 50) {
  return new Promise((resolve, reject) => {
    const reqPath = `/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const req = https.request({
      hostname: 'api.deezer.com', path: reqPath, method: 'GET',
      rejectUnauthorized: false,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve((data.data || []).filter(t => t.preview).map(t => ({
            name: t.title,
            artists: [{ name: t.artist?.name || '' }],
            preview_url: t.preview,
          })));
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Deezer search timed out.')); });
    req.end();
  });
}

const PORT = process.env.PORT || 3000;

// ── History ───────────────────────────────────────────────────────────────────

function saveHistory() {
  historyRepo.saveHistoryFile(history, activeUserId).catch(e => console.error('saveHistory error:', e));
}

let history = [];

// ── App settings (persistent defaults) ───────────────────────────────────────

function saveAppSettings() {
  settingsRepo.saveAppSettings(appSettings, activeUserId).catch(e => console.error('saveAppSettings error:', e));
}

let appSettings = { gameDefaults: {}, defaultTheme: 'classic', customThemeVars: null };

function recordGameResult() {
  const isTeamGame = game.settings.teamMode && game.teams.length > 0;
  let winner = '';
  if (isTeamGame) {
    const top = [...game.teams].sort((a, b) => b.score - a.score)[0];
    winner = top?.name ?? '';
  } else {
    const top = [...game.players].sort((a, b) => b.score - a.score)[0];
    winner = top?.name ?? '';
  }
  const entry = {
    id: Date.now(),
    date: new Date().toISOString(),
    isTeamGame,
    winner,
    rounds: game.round,
    players: game.players.map(p => ({ name: p.name, emoji: p.emoji, score: p.score, teamId: p.teamId })),
    teams: game.teams.map(t => ({ name: t.name, score: t.score })),
    categoriesPlayed: [...game.categories, ...game.round2Categories].map(c => c.name),
  };
  // Update in-memory history immediately for the current session.
  history.unshift(entry);
  if (history.length > 50) history = history.slice(0, 50);
  // Persist asynchronously (DB: inserts one row; file: rewrites the array).
  historyRepo.appendHistory(entry, 50, activeUserId).then(refreshed => {
    if (refreshed !== null) history = refreshed;
    else saveHistory();
  }).catch(e => console.error('recordGameResult persist error:', e));

  // Mark each played category in the library so it can be flagged and excluded from future randomization
  const playedIds = new Set([...game.categories, ...game.round2Categories].map(c => c.id).filter(Boolean));
  let libChanged = false;
  lib.categories.forEach(c => {
    if (playedIds.has(c.id) && !c.played) { c.played = true; libChanged = true; }
  });
  if (libChanged) { saveLibrary(); broadcastLibrary(); }
}

// ── Site settings / roles ─────────────────────────────────────────────────────
let siteSettings = { ...siteRepo.DEFAULT_SITE_SETTINGS };

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (req.path === '/admin.html') return res.redirect('/admin');
  if (req.path === '/host.html') return res.redirect('/host');
  if (req.path === '/settings.html') return res.redirect('/settings');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// ── Auth helpers ──────────────────────────────────────────────────────────────

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.auth_token;
  if (!token) return null;
  try {
    const session = await userRepo.getSession(token);
    if (!session) return null;
    const user = await userRepo.getUserById(session.userId);
    if (!user || user.active === false) return null;
    return { ...user, token };
  } catch {
    return null;
  }
}

function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    getCurrentUser(req).then(async user => {
      if (!user || !allowed.includes(user.role)) return res.status(403).json({ error: 'Forbidden' });
      if (allowed.includes('host')) await activateHostUser(user);
      req.user = user;
      next();
    }).catch(err => {
      if (/Another host is already active/.test(err.message || '')) return res.status(409).json({ error: err.message });
      return res.status(403).json({ error: 'Forbidden' });
    });
  };
}

async function getSocketUser(socket) {
  const user = await getCurrentUser({ headers: socket.request.headers || {} });
  if (!user || !['host', 'site_admin'].includes(user.role)) return null;
  return activateHostUser(user);
}

io.use(async (socket, next) => {
  try {
    socket.data.user = await getSocketUser(socket);
  } catch {
    socket.data.user = null;
  }
  next();
});

// Active user id for process-global state (last logged-in host user).
let activeUserId = 1;

function hasActiveHostSessionForOtherUser(userId) {
  const hostRoom = io.sockets.adapter.rooms.get('host');
  if (!hostRoom) return false;
  for (const socketId of hostRoom) {
    const hostSocket = io.sockets.sockets.get(socketId);
    const hostUserId = hostSocket?.data?.user?.id;
    if (hostUserId && +hostUserId !== +userId) return true;
  }
  return false;
}

async function activateHostUser(user) {
  if (!user || !['host', 'site_admin'].includes(user.role)) throw new Error('Host access requires a Host or Site Admin login.');
  if (+user.id === +activeUserId) return user;
  if (hasActiveHostSessionForOtherUser(user.id) || (activeUserId !== 1 && (game.phase !== 'lobby' || game.players.length > 0))) {
    throw new Error('Another host is already active on this app instance. Finish that session or deploy a separate instance before switching users.');
  }
  await loadUserState(user.id);
  return user;
}

async function loadUserState(userId) {
  activeUserId = userId;
  appSettings = await settingsRepo.loadAppSettings({ gameDefaults: {}, defaultTheme: 'classic', customThemeVars: null }, userId);
  history = await historyRepo.loadHistory(50, userId);
  await libraryRepo.initializeLibraries(appSettings, userId);
  if (!appSettings.activeLibrary) appSettings.activeLibrary = 'Default';
  libraryNames = await libraryRepo.listLibraries(userId);
  lib = await libraryRepo.loadLibrary(appSettings.activeLibrary, userId);
  if (!lib.pages) lib.pages = [{ id: 1, name: 'Page 1' }];
}

// ── Login / logout routes ─────────────────────────────────────────────────────

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) return res.redirect('login?error=missing');
  let user;
  try {
    const exists = await userRepo.userExists(username);
    if (!exists && siteSettings.registrationEnabled === false) return res.redirect('login?error=registration');
    user = await userRepo.getOrCreateUser(username, password);
  } catch {
    return res.redirect('login?error=invalid');
  }
  const token = await userRepo.createSession(user.id);
  const requested = req.query.next;
  const next = (requested === 'admin' && user.role === 'site_admin') ? 'admin' : (user.role === 'site_admin' ? 'admin' : 'host');
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict`);
  res.redirect(next);
});

app.get('/logout', async (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.auth_token) await userRepo.deleteSession(cookies.auth_token).catch(() => {});
  res.setHeader('Set-Cookie', [
    'auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
  ]);
  res.redirect('login');
});

app.post('/logout', async (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.auth_token) await userRepo.deleteSession(cookies.auth_token).catch(() => {});
  res.setHeader('Set-Cookie', [
    'auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
  ]);
  res.redirect('login');
});

app.get('/board',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

app.get('/host', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('login?next=host');
  if (!['host', 'site_admin'].includes(user.role)) return res.status(403).send('Forbidden');
  try {
    await activateHostUser(user);
  } catch (err) {
    if (/Another host is already active/.test(err.message || '')) return res.status(409).send(err.message);
    return res.status(403).send('Forbidden');
  }
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/admin', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('login?next=admin');
  if (user.role !== 'site_admin') return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const requireHost = requireRole(['host', 'site_admin']);
const requireSiteAdmin = requireRole('site_admin');

app.get('/api/admin/site-settings', requireSiteAdmin, (req, res) => res.json(siteSettings));

app.post('/api/admin/site-settings', requireSiteAdmin, async (req, res) => {
  siteSettings = await siteRepo.saveSiteSettings({ ...siteSettings, ...req.body });
  res.json(siteSettings);
});

app.get('/api/admin/users', requireSiteAdmin, async (req, res) => {
  res.json({ users: await userRepo.listUsers() });
});

app.post('/api/admin/users/:id', requireSiteAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });
  if (targetId === req.user.id && req.body.active === false) return res.status(400).json({ error: 'You cannot disable your own admin account.' });
  const updated = await userRepo.updateUser(targetId, { role: req.body.role, active: req.body.active });
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json(updated);
});

app.get('/api/history', requireHost, (req, res) => res.json(history));

app.get('/api/duplicates', requireHost, (req, res) => {
  function norm(s) {
    return (s || '').toLowerCase().trim()
      .replace(/[.,!?;:'"()\[\]]+/g, '')
      .replace(/\s+/g, ' ');
  }
  function normAnswer(s) {
    return norm(s).replace(/^(the|a|an) /, '');
  }

  const cats = lib.categories;

  // Duplicate category names
  const catMap = new Map();
  for (const cat of cats) {
    const key = norm(cat.name);
    if (!catMap.has(key)) catMap.set(key, []);
    catMap.get(key).push({ id: cat.id, name: cat.name, questionCount: (cat.questions || []).length });
  }
  const dupeCats = [...catMap.values()].filter(g => g.length > 1)
    .sort((a, b) => b.length - a.length);

  // Duplicate question text
  const qMap = new Map();
  for (const cat of cats) {
    for (let qi = 0; qi < (cat.questions || []).length; qi++) {
      const q = cat.questions[qi];
      if (!q.question) continue;
      const key = norm(q.question);
      if (!qMap.has(key)) qMap.set(key, []);
      qMap.get(key).push({ categoryId: cat.id, categoryName: cat.name, questionIdx: qi, question: q.question, answer: q.answer, value: q.value });
    }
  }
  const dupeQs = [...qMap.values()].filter(g => g.length > 1)
    .sort((a, b) => b.length - a.length);

  // Duplicate answers
  const aMap = new Map();
  for (const cat of cats) {
    for (let qi = 0; qi < (cat.questions || []).length; qi++) {
      const q = cat.questions[qi];
      if (!q.answer) continue;
      const key = normAnswer(q.answer);
      if (!aMap.has(key)) aMap.set(key, []);
      aMap.get(key).push({ categoryId: cat.id, categoryName: cat.name, questionIdx: qi, question: q.question, answer: q.answer, value: q.value });
    }
  }
  const dupeAs = [...aMap.values()].filter(g => g.length > 1)
    .sort((a, b) => b.length - a.length);

  res.json({
    library: appSettings.activeLibrary || 'Default',
    stats: {
      totalCategories: cats.length,
      totalQuestions:  cats.reduce((s, c) => s + (c.questions || []).length, 0),
      dupeCatGroups:   dupeCats.length,
      dupeQGroups:     dupeQs.length,
      dupeAGroups:     dupeAs.length,
    },
    duplicateCategories: dupeCats,
    duplicateQuestions:  dupeQs,
    duplicateAnswers:    dupeAs,
  });
});

app.get('/settings', requireHost, (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

app.get('/api/app-settings', requireHost, (req, res) => {
  const cfg = loadConfig();
  const key  = cfg.ANTHROPIC_API_KEY  || '';
  const elKey = cfg.ELEVENLABS_API_KEY || '';
  const spId  = cfg.SPOTIFY_CLIENT_ID     || '';
  const spSec = cfg.SPOTIFY_CLIENT_SECRET || '';
  res.json({
    apiKeyConfigured:       !!key,
    apiKeyPreview:          key   ? key.slice(0, 14)  + '…' + key.slice(-4)   : '',
    elKeyConfigured:        !!elKey,
    elKeyPreview:           elKey ? elKey.slice(0, 8) + '…' + elKey.slice(-4) : '',
    spotifyConfigured:      !!(spId && spSec),
    spotifyIdPreview:       spId  ? spId.slice(0, 6)  + '…'                   : '',
    gameDefaults:           appSettings.gameDefaults   || {},
    defaultTheme:           appSettings.defaultTheme   || 'classic',
    customThemeVars:        appSettings.customThemeVars || null,
    tts:                    appSettings.tts || {},
  });
});

app.post('/api/app-settings', requireHost, (req, res) => {
  const { apiKey: newKey, elKey: newElKey, spotifyClientId: newSpId, spotifyClientSecret: newSpSec, gameDefaults, defaultTheme, customThemeVars, tts } = req.body;
  if (newKey !== undefined || newElKey !== undefined || newSpId !== undefined || newSpSec !== undefined) {
    const cfg = loadConfig();
    if (newKey !== undefined) {
      const trimmed = (newKey || '').trim();
      cfg.ANTHROPIC_API_KEY = trimmed;
      apiKey = trimmed;
      anthropic = trimmed ? new Anthropic({ apiKey: trimmed, httpAgent: new https.Agent({ rejectUnauthorized: false }) }) : null;
    }
    if (newElKey !== undefined) {
      const trimmed = (newElKey || '').trim();
      cfg.ELEVENLABS_API_KEY = trimmed;
      elevenLabsKey = trimmed;
    }
    if (newSpId !== undefined) {
      spotifyClientId = (newSpId || '').trim();
      cfg.SPOTIFY_CLIENT_ID = spotifyClientId;
      _spotifyToken = null;
    }
    if (newSpSec !== undefined) {
      spotifyClientSecret = (newSpSec || '').trim();
      cfg.SPOTIFY_CLIENT_SECRET = spotifyClientSecret;
      _spotifyToken = null;
    }
    try { settingsRepo.saveConfig(cfg); }
    catch (e) { return res.status(500).json({ error: 'Failed to save API key.' }); }
  }
  if (gameDefaults && typeof gameDefaults === 'object') appSettings.gameDefaults = { ...appSettings.gameDefaults, ...gameDefaults };
  if (defaultTheme   !== undefined) appSettings.defaultTheme   = defaultTheme;
  if (customThemeVars !== undefined) appSettings.customThemeVars = customThemeVars;
  if (tts && typeof tts === 'object') appSettings.tts = { ...(appSettings.tts || {}), ...tts };
  saveAppSettings();
  broadcast(); // push updated ttsEnabled to board
  res.json({ ok: true });
});

// ── Library (persists via repository) ────────────────────────────────────────

// In-memory cache of library names, populated in main() and kept in sync.
let libraryNames = ['Default'];

function listLibraries() {
  return libraryNames;
}

function saveLibrary() {
  libraryRepo.saveLibrary(appSettings.activeLibrary || 'Default', lib, activeUserId)
    .catch(e => console.error('saveLibrary error:', e));
}

let lib = { categories: [], nextId: 0, activeIds: [], pages: [{ id: 1, name: 'Page 1' }] };

function generateToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function broadcastLibrary() {
  io.to('host').emit('library-state', {
    categories: lib.categories,
    activeIds: lib.activeIds,
    pages: lib.pages,
    libraries: listLibraries(),
    activeLibrary: appSettings.activeLibrary || 'Default',
  });
}

// ── Game state ────────────────────────────────────────────────────────────────

const GAME_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateGameCode() {
  let out = '';
  for (let i = 0; i < 4; i++) out += GAME_CODE_ALPHABET[crypto.randomInt(GAME_CODE_ALPHABET.length)];
  return out;
}
function normalizeGameCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

const VALID_THEMES = ['classic','midnight','retro','forest','crimson','ocean','violet'];

function freshState() {
  const d = appSettings.gameDefaults || {};
  return {
    phase: 'lobby',
    code: generateGameCode(),
    theme: appSettings.defaultTheme || 'classic',
    round: 1,
    players: [],
    currentPlayerIndex: 0,
    categories: [],
    round2Categories: [],
    finalQuestion: null,
    finalWagers: {},
    finalAnswers: {},
    finalJudged: [],
    finalAnswersLocked: false,
    allPlayAnswers: {},
    currentQuestion: null,
    buzzedPlayerId: null,
    buzzOrder: [],
    timerEndsAt: null,
    timerType: null,
    buzzOpen: false,
    buzzOpenAt: null,
    dailyDoubleWager: null,
    dailyDoublePlayerId: null,
    dailyDoubleCount: 0,
    isStealOpportunity: false,
    paused: false,
    pausedTimerRemaining: null,
    pausedTimerType: null,
    doubleDown: false,
    buzzActualOpenAt: null,
    correctCounts: {},
    buzzTimes: {},
    catCorrect: {},
    scoreHistory: [],
    lockedOutIds: [],
    tiebreakerQuestion: null,
    tiebreakerPlayers: [],
    settings: {
      buzzTime:            d.buzzTime            || 30,
      answerTime:          d.answerTime          || 10,
      wagerTime:           d.wagerTime           || 30,
      lockoutEnabled:      !!d.lockoutEnabled,
      dailyDoublesEnabled: d.dailyDoublesEnabled !== false,
      teamMode:            !!d.teamMode,
      allPlayMode:         !!d.allPlayMode,
      powerUpsEnabled:     !!d.powerUpsEnabled,
      powerUpCounts: {
        doubleDown: d.powerUpCounts?.doubleDown ?? 1,
        shield:     d.powerUpCounts?.shield     ?? 1,
      },
    },
    playerPowerUps: {},
    activePowerUps: {},
    customThemeVars: appSettings.customThemeVars || null,
    currentPage: 1,
    pages: [{ id: 1, name: 'Page 1' }],
    teams: [],
  };
}

const disconnectTimers = {};
const games = new Map();
let game = freshState();
game.gameTimer = null;
game.lockTimer = null;
game.resultSaved = false;
games.set(game.code, game);

function createGame(hostUserId = null) {
  const next = freshState();
  while (games.has(next.code)) next.code = generateGameCode();
  next.hostUserId = hostUserId;
  next.gameTimer = null;
  next.lockTimer = null;
  next.resultSaved = false;
  games.set(next.code, next);
  return next;
}

function getGame(code) {
  const normalized = normalizeGameCode(code);
  return normalized ? games.get(normalized) : null;
}

function socketGame(socket) {
  return getGame(socket?.data?.gameCode) || game;
}

function setSocketGame(socket, g) {
  socket.data.gameCode = g.code;
  socket.join(`game:${g.code}`);
}

function withGame(g, fn) {
  const previous = game;
  game = g || game;
  try { return fn(); }
  finally { game = previous; }
}

function clearLockTimer() {
  if (game.lockTimer) { clearTimeout(game.lockTimer); game.lockTimer = null; }
}

function clearGameTimer() {
  if (game.gameTimer) { clearTimeout(game.gameTimer); game.gameTimer = null; }
  game.timerEndsAt = null;
  game.timerType   = null;
}

function startBuzzTimer() {
  clearGameTimer();
  const currentGame = game;
  const ms = (game.settings.buzzTime || 30) * 1000;
  game.timerType   = 'buzz';
  game.timerEndsAt = Date.now() + ms;
  game.buzzActualOpenAt = Date.now();
  game.gameTimer = setTimeout(() => withGame(currentGame, () => {
    if (game.phase === 'tiebreaker' && !game.buzzedPlayerId) { advanceTurn(null); return; }
    if (game.phase === 'question' && !game.buzzedPlayerId) {
      game.timerType   = null;
      game.timerEndsAt = null;
      game.phase = game.settings.allPlayMode ? 'all-play-review' : 'answer-reveal';
      broadcast();
    }
  }), ms);
}

function startFinalWagerTimer() {
  clearGameTimer();
  const currentGame = game;
  const wagerMs = (game.settings.wagerTime || 30) * 1000;
  game.timerType   = 'final-wager';
  game.timerEndsAt = Date.now() + wagerMs;
  game.gameTimer = setTimeout(() => withGame(currentGame, () => {
    if (game.phase !== 'final-wager') return;
    if (game.settings.teamMode) {
      game.teams.forEach(t => { if (game.finalWagers[t.id] === undefined) game.finalWagers[t.id] = 0; });
    } else {
      game.players.forEach(p => { if (game.finalWagers[p.id] === undefined) game.finalWagers[p.id] = 0; });
    }
    game.phase = 'final-question';
    startFinalAnswerTimer();
    broadcast();
  }), wagerMs);
}

function startFinalAnswerTimer() {
  clearGameTimer();
  const currentGame = game;
  game.timerType   = 'final-answer';
  game.timerEndsAt = Date.now() + 30000;
  game.gameTimer = setTimeout(() => withGame(currentGame, () => {
    if (game.phase !== 'final-question') return;
    game.finalAnswersLocked = true;
    game.timerType   = null;
    game.timerEndsAt = null;
    broadcast();
  }), 30000);
}

function startAnswerTimer() {
  clearGameTimer();
  const currentGame = game;
  const ms = (game.settings.answerTime || 10) * 1000;
  game.timerType   = 'answer';
  game.timerEndsAt = Date.now() + ms;
  game.gameTimer = setTimeout(() => withGame(currentGame, () => {
    if (game.phase !== 'question' && game.phase !== 'tiebreaker') return;
    if (!game.buzzedPlayerId) return;
    const player = game.players.find(p => p.id === game.buzzedPlayerId);
    const points = game.currentQuestion.dailyDouble ? (game.dailyDoubleWager || 0) : game.currentQuestion.value;
    if (player) {
      snapshotScores();
      player.score -= points;
      player.streak = 0;
      if (game.settings.teamMode && player.teamId) {
        const t = game.teams.find(tm => tm.id === player.teamId);
        if (t) t.streak = 0;
      }
    }
    game.doubleDown = false;
    game.buzzOrder = game.buzzOrder.filter(id => id !== game.buzzedPlayerId);
    if (game.settings.lockoutEnabled) game.lockedOutIds.push(game.buzzedPlayerId);
    game.buzzedPlayerId = game.buzzOrder[0] ?? null;
    if (game.buzzedPlayerId) startAnswerTimer();
    else advanceTurn(null);
    broadcast();
  }), ms);
}

function snapshotScores() {
  game.scoreHistory.push({
    players: game.players.map(p => ({ id: p.id, score: p.score })),
    teams:   game.teams.map(t => ({ id: t.id, score: t.score })),
  });
  if (game.scoreHistory.length > 20) game.scoreHistory.shift();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function baseUrlFromHeaders(headers = {}) {
  if (siteSettings.publicBaseUrl) return siteSettings.publicBaseUrl.replace(/\/+$/, '');
  const host = String(headers['x-forwarded-host'] || headers.host || `localhost:${PORT}`).split(',')[0].trim();
  const proto = String(headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}
function playerUrl(headers = {}, g = game) { return `${baseUrlFromHeaders(headers)}/player?code=${encodeURIComponent(g.code)}`; }
function boardUrl(headers = {}, g = game) { return `${baseUrlFromHeaders(headers)}/board?code=${encodeURIComponent(g.code)}`; }

async function playerLinkPayload(headers = {}, g = game) {
  const url = playerUrl(headers, g);
  const board = boardUrl(headers, g);
  let qr = null;
  try {
    qr = await QRCode.toDataURL(url, {
      width: 300, margin: 2,
      color: { dark: '#000080', light: '#FFD700' },
    });
  } catch (e) { console.error('QR generation failed:', e.message); }
  return { url, boardUrl: board, qr, code: g.code };
}

function publicState() {
  const revealFinal = ['final-question', 'game-over'].includes(game.phase);
  return {
    phase: game.phase,
    code: game.code,
    gameCode: game.code,
    theme: game.theme,
    round: game.round,
    players: game.players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji || '', score: p.score, isCurrentTurn: p.isCurrentTurn, teamId: p.teamId || null, streak: p.streak || 0, disconnected: p.disconnectedAt ? true : undefined })),
    currentPlayerIndex: game.currentPlayerIndex,
    categories: game.categories.map(cat => ({
      name: cat.locked ? '?????' : cat.name,
      page: cat.page || 1,
      locked: cat.locked || false,
      questions: cat.locked
        ? cat.questions.map(({ value, used }) => ({ value, used, locked: true }))
        : cat.questions.map(({ value, used, audioUrl }) => ({ value, used, ...(audioUrl ? { audioUrl } : {}) })),
    })),
    currentPage: game.currentPage || 1,
    pages: game.pages || [{ id: 1, name: 'Page 1' }],
    ttsEnabled: !!(appSettings.tts?.enabled && elevenLabsKey),
    currentQuestion: game.currentQuestion ? {
      categoryName: game.currentQuestion.categoryName,
      value: game.currentQuestion.value,
      question: game.currentQuestion.question,
      answer: (game.phase === 'answer-reveal' || game.phase === 'all-play-review') ? game.currentQuestion.answer : undefined,
      audioUrl:   game.currentQuestion.audioUrl   || undefined,
      audioStart: game.currentQuestion.audioStart || undefined,
    } : null,
    buzzedPlayerId: game.buzzedPlayerId,
    buzzedPlayerName: game.buzzedPlayerId
      ? (game.players.find(p => p.id === game.buzzedPlayerId)?.name ?? null)
      : null,
    buzzOrder: game.buzzOrder,
    timerEndsAt: game.timerEndsAt,
    timerType:   game.timerType,
    buzzOpen:    game.buzzOpen,
    buzzOpenAt:  game.buzzOpenAt,
    hasRound2:   game.round2Categories.length > 0,
    finalQuestion: game.finalQuestion ? {
      categoryName: game.finalQuestion.categoryName,
      question: revealFinal ? game.finalQuestion.question : null,
    } : null,
    finalWagers:  revealFinal
      ? { ...game.finalWagers }
      : Object.fromEntries(game.players.map(p => [p.id, game.finalWagers[p.id] !== undefined])),
    finalJudged:        [...game.finalJudged],
    finalAnswersLocked: game.finalAnswersLocked,
    finalAnswers: Object.fromEntries(Object.keys(game.finalAnswers).map(id => [id, true])),
    allPlayAnswers: game.phase === 'all-play-review'
      ? JSON.parse(JSON.stringify(game.allPlayAnswers))
      : Object.fromEntries(Object.entries(game.allPlayAnswers).map(([id, v]) => [id, { submitted: true, skipped: v.skipped }])),
    dailyDoubleWager: game.dailyDoubleWager,
    dailyDoublePlayerId: game.dailyDoublePlayerId,
    dailyDoubleCount: game.dailyDoubleCount,
    isStealOpportunity: game.isStealOpportunity,
    doubleDown: game.doubleDown,
    paused: game.paused,
    scoreHistoryLength: game.scoreHistory.length,
    playerPowerUps: game.settings.powerUpsEnabled ? JSON.parse(JSON.stringify(game.playerPowerUps)) : {},
    activePowerUps: game.settings.powerUpsEnabled ? JSON.parse(JSON.stringify(game.activePowerUps)) : {},
    lockedOutIds: [...game.lockedOutIds],
    tiebreakerQuestion: game.tiebreakerQuestion
      ? { categoryName: game.tiebreakerQuestion.categoryName, question: game.tiebreakerQuestion.question }
      : null,
    tiebreakerPlayers: [...game.tiebreakerPlayers],
    settings: { ...game.settings },
    customThemeVars: game.customThemeVars ? { ...game.customThemeVars } : null,
    teams: game.teams.map(t => ({ id: t.id, name: t.name, score: t.score, memberIds: [...t.memberIds], isCurrentTurn: t.isCurrentTurn || false, streak: t.streak || 0 })),
    recap: game.phase === 'game-over' ? computeRecap() : undefined,
  };
}

function computeRecap() {
  // Most correct answers
  let mostCorrectId = null, mostCorrectCount = 0;
  for (const [id, count] of Object.entries(game.correctCounts || {})) {
    if (count > mostCorrectCount) { mostCorrectCount = count; mostCorrectId = id; }
  }
  let mostCorrectName = null;
  if (mostCorrectId) {
    const p = game.players.find(pl => pl.id === mostCorrectId);
    mostCorrectName = p ? p.name : null;
  }

  // Fastest buzz (lowest average buzz-in time)
  let fastestId = null, fastestAvg = Infinity;
  for (const [id, times] of Object.entries(game.buzzTimes || {})) {
    if (!times.length) continue;
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    if (avg < fastestAvg) { fastestAvg = avg; fastestId = id; }
  }
  let fastestName = null;
  if (fastestId) {
    const p = game.players.find(pl => pl.id === fastestId);
    fastestName = p ? p.name : null;
  }

  // Category sweeps (player who got ALL questions in a category)
  const sweeps = [];
  for (const [catName, byPlayer] of Object.entries(game.catCorrect || {})) {
    const cat = game.categories.find(c => c.name === catName);
    if (!cat) continue;
    const total = cat.questions.length;
    for (const [pid, count] of Object.entries(byPlayer)) {
      if (count >= total) {
        const p = game.players.find(pl => pl.id === pid);
        if (p) sweeps.push({ playerName: p.name, catName });
      }
    }
  }

  return {
    mostCorrect: mostCorrectName ? { name: mostCorrectName, count: mostCorrectCount } : null,
    fastestBuzz: fastestName ? { name: fastestName, avgMs: Math.round(fastestAvg) } : null,
    sweeps,
  };
}

function hostState() {
  return {
    ...publicState(),
    currentQuestion: game.currentQuestion,
    categories: game.categories,
    finalQuestion: game.finalQuestion,
    finalWagers: { ...game.finalWagers },
    finalAnswers: { ...game.finalAnswers },
    tiebreakerQuestion: game.tiebreakerQuestion,
    allPlayAnswers: JSON.parse(JSON.stringify(game.allPlayAnswers)),
  };
}

function broadcast() {
  if (game.phase === 'game-over' && !game.resultSaved) {
    game.resultSaved = true;
    recordGameResult();
  }
  io.to(`game:${game.code}`).emit('game-state', publicState());
  io.to(`host:${game.code}`).emit('host-state', hostState());
}

function allUsed() {
  return game.categories.every(cat => cat.questions.every(q => q.used));
}

function findTiebreakerQuestion() {
  const usedKeys = new Set();
  [...game.categories, ...game.round2Categories].forEach(cat =>
    cat.questions.forEach(q => usedKeys.add(`${cat.name}||${q.question}`))
  );
  if (game.finalQuestion) usedKeys.add(`${game.finalQuestion.categoryName}||${game.finalQuestion.question}`);
  const candidates = [];
  lib.categories.forEach(cat => {
    cat.questions.forEach(q => {
      if (q.question.trim() && q.answer.trim() && q.enabled !== false &&
          !usedKeys.has(`${cat.name}||${q.question}`)) {
        candidates.push({ categoryName: cat.name, question: q.question, answer: q.answer, value: q.value || 0 });
      }
    });
  });
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function assignDailyDoubles(categories, count) {
  if (!count || !game.settings.dailyDoublesEnabled) return;
  const eligible = [];
  categories.forEach((cat, ci) => {
    cat.questions.forEach((q, qi) => {
      if (qi > 0) eligible.push({ ci, qi });
    });
  });
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  eligible.slice(0, count).forEach(({ ci, qi }) => {
    categories[ci].questions[qi].dailyDouble = true;
  });
}

function maybeSetGameOver() {
  if (game.settings.teamMode && game.teams.length > 0) { game.phase = 'game-over'; return; }
  if (game.players.length < 2) { game.phase = 'game-over'; return; }
  const topScore = Math.max(...game.players.map(p => p.score));
  const tied = game.players.filter(p => p.score === topScore);
  const tbQ = tied.length >= 2 ? findTiebreakerQuestion() : null;
  if (tbQ) {
    game.tiebreakerQuestion = tbQ;
    game.tiebreakerPlayers  = tied.map(p => p.id);
    game.currentQuestion    = { ...tbQ, dailyDouble: false };
    game.phase              = 'tiebreaker';
    game.lockedOutIds       = [];
    game.buzzedPlayerId     = null;
    game.buzzOrder          = [];
    game.buzzOpen           = false;
    game.buzzOpenAt         = Date.now() + 8000;
    game.timerEndsAt        = game.buzzOpenAt;
    game.timerType          = 'lock';
    const currentGame = game;
    game.lockTimer = setTimeout(() => withGame(currentGame, () => {
      game.buzzOpen   = true;
      game.buzzOpenAt = null;
      startBuzzTimer();
      broadcast();
    }), 8000);
  } else {
    game.phase = 'game-over';
  }
}

function advanceTurn(winnerId) {
  clearLockTimer();
  clearGameTimer();
  game.buzzOpen   = false;
  game.buzzOpenAt = null;
  game.buzzActualOpenAt = null;
  game.isStealOpportunity = false;
  game.currentQuestion = null;
  game.buzzedPlayerId = null;
  game.buzzOrder = [];
  if (allUsed()) {
    if (game.round === 1 && game.round2Categories.length > 0) {
      game.phase = 'round-over';
    } else if (game.finalQuestion) {
      game.finalWagers        = {};
      game.finalAnswers       = {};
      game.finalJudged        = [];
      game.finalAnswersLocked = false;
      game.phase = 'final-wager';
      startFinalWagerTimer();
    } else {
      maybeSetGameOver();
    }
    broadcast();
    return;
  }
  game.phase = 'selecting';
  if (game.settings.teamMode && game.teams.length > 0) {
    if (winnerId) {
      const winner = game.players.find(p => p.id === winnerId);
      const teamIdx = winner ? game.teams.findIndex(t => t.id === winner.teamId) : -1;
      if (teamIdx !== -1) game.currentPlayerIndex = teamIdx;
    } else {
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.teams.length;
    }
    const curTeamId = game.teams[game.currentPlayerIndex]?.id;
    game.teams.forEach((t, i) => { t.isCurrentTurn = i === game.currentPlayerIndex; });
    game.players.forEach(p => { p.isCurrentTurn = p.teamId === curTeamId; });
  } else {
    if (winnerId) {
      const idx = game.players.findIndex(p => p.id === winnerId);
      if (idx !== -1) game.currentPlayerIndex = idx;
    } else {
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    }
    game.players.forEach((p, i) => { p.isCurrentTurn = i === game.currentPlayerIndex; });
  }
  broadcast();
}

function doStartRound2() {
  game.categories = JSON.parse(JSON.stringify(game.round2Categories)).map(cat => ({
    ...cat,
    questions: cat.questions.map(q => ({ ...q, value: q.value * 2 })),
  }));
  game.round2Categories = [];
  game.round = 2;
  game.currentPage = game.pages?.[0]?.id || 1;
  assignDailyDoubles(game.categories, 2);
  game.phase = 'selecting';
  if (game.settings.teamMode && game.teams.length > 0) {
    const curTeamId = game.teams[game.currentPlayerIndex]?.id;
    game.teams.forEach((t, i) => { t.isCurrentTurn = i === game.currentPlayerIndex; });
    game.players.forEach(p => { p.isCurrentTurn = p.teamId === curTeamId; });
  } else {
    game.players.forEach((p, i) => { p.isCurrentTurn = i === game.currentPlayerIndex; });
  }
  broadcast();
}

// ── URL fetcher for AI generation ────────────────────────────────────────────

function fetchUrlText(urlStr) {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('https') ? https : http;
    const req = mod.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrlText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        resolve(text);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout fetching URL')); });
  });
}

// ── TTS proxy ─────────────────────────────────────────────────────────────────

const PRESET_VOICE_IDS = [
  'pNInz6obpgDQGcFmaJgB','SOYHLrjzK2X1ezoPC6cr','onwK4e9ZLuTAKqWW03F9',
  'TX3LPaxmHKxFdv7VOQHJ','VR6AewLTigWG4xSOukaG','TxGEqnHWrfWFTfGW9XjX',
  'ZQe5CZNOzWyzPSCn5a3c','flq6f7ztfj1uc8fnMIAO','21m00Tcm4TlvDq8ikWAM','EXAVITQu4vr4xnSDxMaL',
];

app.post('/api/tts', (req, res) => {
  const text = (req.body?.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!appSettings.tts?.enabled) return res.status(204).end();
  if (!elevenLabsKey) return res.status(503).json({ error: 'ElevenLabs key not configured' });

  let voiceId = (appSettings.tts?.voiceId || PRESET_VOICE_IDS[0]).trim();
  if (voiceId === '__random__') {
    const customIds = (appSettings.tts?.customVoices || []).map(v => v.id);
    const pool = [...PRESET_VOICE_IDS, ...customIds];
    voiceId = pool[Math.floor(Math.random() * pool.length)];
    console.log(`[TTS] Random voice selected: ${voiceId}`);
  }
  const body    = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
  });

  const elReq = https.request({
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    method: 'POST',
    agent: elevenLabsAgent,
    headers: {
      'xi-api-key': elevenLabsKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Accept': 'audio/mpeg',
    },
  }, elRes => {
    console.log(`[TTS] ElevenLabs responded ${elRes.statusCode} for voice ${voiceId}`);
    if (elRes.statusCode !== 200) {
      const chunks = [];
      elRes.on('data', d => chunks.push(d));
      elRes.on('end', () => {
        const msg = Buffer.concat(chunks).toString().slice(0, 300);
        console.error('[TTS] ElevenLabs error body:', msg);
        res.status(502).json({ error: msg });
      });
      return;
    }
    res.set('Content-Type', 'audio/mpeg');
    elRes.pipe(res);
  });
  elReq.on('error', e => { console.error('[TTS] HTTPS error:', e.message); res.status(500).json({ error: e.message }); });
  elReq.write(body);
  elReq.end();
});

// ── Sockets ───────────────────────────────────────────────────────────────────

const HOST_ONLY_EVENTS = new Set([
  'add-category', 'delete-category', 'add-generated-categories', 'generate-categories',
  'bulk-delete-categories', 'update-category-name', 'set-active', 'update-question',
  'add-question', 'delete-question', 'bulk-delete-questions', 'toggle-question',
  'add-generated-questions', 'generate-questions', 'randomize-game',
  'reset-played-categories', 'deactivate-all-categories', 'reset-library', 'remove-player',
  'set-category-round', 'set-category-page', 'add-page', 'rename-page', 'delete-page',
  'switch-page', 'start-game', 'start-round2', 'reveal-final-question', 'judge-final',
  'host-select-question', 'judge-answer', 'host-pick-dd-player',
  'update-settings', 'toggle-game-mode', 'judge-all-play', 'finish-all-play',
  'duplicate-category', 'import-library', 'import-csv-questions', 'create-library',
  'switch-library', 'delete-library', 'rename-library', 'skip-question',
  'dismiss-answer-reveal', 'undo-last-score', 'toggle-pause', 'adjust-score',
  'adjust-team-score', 'set-score', 'set-team-score', 'set-theme', 'set-custom-theme',
  'rematch', 'generate-category-from-source', 'reset-game', 'get-history', 'clear-history',
  'generate-song-category', 'ai-dedupe-delete', 'ai-reword-dupes',
  'toggle-double-down', 'toggle-category-lock', 'reveal-category', 'advance-round-scores',
]);

function isHostSocket(socket) {
  return !!socket.data.user && ['host', 'site_admin'].includes(socket.data.user.role);
}

io.on('connection', socket => {
  socket.use((packet, next) => {
    const target = getGame(socket.data.gameCode);
    if (target) game = target;
    next();
  });

  socket.use((packet, next) => {
    const eventName = packet?.[0];
    if (HOST_ONLY_EVENTS.has(eventName)) {
      if (!isHostSocket(socket)) {
        socket.emit('host-auth-error', 'Host access requires a Host or Site Admin login.');
        return next(new Error('Host access required'));
      }
      // Role alone isn't enough: the socket must have joined this game via
      // join-host (which enforces hostUserId), or it could rebind to another
      // host's game through the unauthenticated join-board event.
      const target = socketGame(socket);
      if (!io.sockets.adapter.rooms.get(`host:${target.code}`)?.has(socket.id)) {
        socket.emit('game-error', 'You are not the host of this game.');
        return next(new Error('Host access required'));
      }
    }
    next();
  });

  socket.on('join-board', async ({ code } = {}) => {
    const target = getGame(code) || game;
    setSocketGame(socket, target);
    socket.join(`board:${target.code}`);
    withGame(target, () => socket.emit('game-state', publicState()));
    socket.emit('player-url', await playerLinkPayload(socket.request.headers, target));
  });

  socket.on('join-host', async ({ code } = {}) => {
    const user = socket.data.user || await getSocketUser(socket);
    if (!user) { socket.emit('host-auth-error', 'Host access requires a Host or Site Admin login.'); return; }
    socket.data.user = user;
    const requested = getGame(code || socket.handshake?.query?.code);
    let target = requested;
    if (requested && requested.hostUserId && requested.hostUserId !== user.id) {
      socket.emit('game-error', 'That game code belongs to another host. Created a new game for you.');
      target = null;
    }
    // Without a valid code, reattach to a game this user already hosts
    // (e.g. the settings page or a reconnect without localStorage) before
    // creating a fresh one.
    target = target || [...games.values()].reverse().find(g => g.hostUserId === user.id) || createGame(user.id);
    if (!target.hostUserId) target.hostUserId = user.id;
    setSocketGame(socket, target);
    socket.join('host');
    socket.join(`host:${target.code}`);
    withGame(target, () => socket.emit('host-state', hostState()));
    socket.emit('library-state', { categories: lib.categories, activeIds: lib.activeIds, pages: lib.pages, libraries: listLibraries(), activeLibrary: appSettings.activeLibrary || 'Default' });
    socket.emit('player-url', await playerLinkPayload(socket.request.headers, target));
  });

  socket.on('join-player', ({ name, emoji, code }) => {
    const target = getGame(code);
    if (!target) { socket.emit('join-error', 'Enter a valid 4-character game code.'); return; }
    setSocketGame(socket, target);
    socket.join(`players:${target.code}`);
    withGame(target, () => {
    if (normalizeGameCode(code) !== game.code) { socket.emit('join-error', 'Enter the correct 4-character game code.'); return; }
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) { socket.emit('join-error', 'Name cannot be empty.'); return; }
    // Reconnect grace period: restore disconnected player by name
    const disconnectedPlayer = game.players.find(p => p.disconnectedAt && p.name.toLowerCase() === trimmed.toLowerCase());
    if (disconnectedPlayer) {
      const oldId = disconnectedPlayer.id;
      if (disconnectTimers[oldId]) { clearTimeout(disconnectTimers[oldId]); delete disconnectTimers[oldId]; }
      disconnectedPlayer.disconnectedAt = undefined;
      disconnectedPlayer.id = socket.id;
      if (game.buzzedPlayerId === oldId) game.buzzedPlayerId = socket.id;
      game.buzzOrder = game.buzzOrder.map(id => id === oldId ? socket.id : id);
      socket.join('players');
      socket.emit('joined', { playerId: socket.id, playerName: disconnectedPlayer.name, token: disconnectedPlayer.token });
      socket.emit('game-state', publicState());
      broadcast();
      return;
    }
    if (game.phase !== 'lobby') { socket.emit('join-error', 'Game already in progress.'); return; }
    if (game.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      socket.emit('join-error', 'That name is already taken.'); return;
    }
    const token = generateToken();
    const safeEmoji = (typeof emoji === 'string' && /^\p{Emoji}/u.test(emoji)) ? emoji.slice(0, 2) : '';
    game.players.push({ id: socket.id, name: trimmed, emoji: safeEmoji, score: 0, streak: 0, isCurrentTurn: false, token, teamId: null });
    socket.join('players');
    socket.emit('joined', { playerId: socket.id, playerName: trimmed, token });
    broadcast();
    });
  });

  socket.on('select-team', ({ teamId, teamName }) => {
    if (game.phase !== 'lobby') return;
    if (!game.settings.teamMode) return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    if (teamId !== undefined) {
      const team = game.teams.find(t => t.id === teamId);
      if (!team) return;
      // Remove from old team if switching
      if (player.teamId && player.teamId !== team.id) {
        const oldTeam = game.teams.find(t => t.id === player.teamId);
        if (oldTeam) oldTeam.memberIds = oldTeam.memberIds.filter(id => id !== socket.id);
      }
      player.teamId = team.id;
      if (!team.memberIds.includes(socket.id)) team.memberIds.push(socket.id);
    } else if (teamName) {
      const trimmedName = (teamName || '').trim().slice(0, 24);
      if (!trimmedName) return;
      if (game.teams.some(t => t.name.toLowerCase() === trimmedName.toLowerCase())) {
        socket.emit('team-error', 'That team name is already taken.'); return;
      }
      const newTeam = { id: `t${Date.now()}`, name: trimmedName, score: 0, streak: 0, memberIds: [socket.id], isCurrentTurn: false };
      game.teams.push(newTeam);
      if (player.teamId) {
        const oldTeam = game.teams.find(t => t.id === player.teamId);
        if (oldTeam) oldTeam.memberIds = oldTeam.memberIds.filter(id => id !== socket.id);
      }
      player.teamId = newTeam.id;
    }
    broadcast();
  });

  socket.on('rejoin-player', ({ token, code }) => {
    const target = getGame(code);
    if (!target) { socket.emit('rejoin-failed'); return; }
    setSocketGame(socket, target);
    socket.join(`players:${target.code}`);
    withGame(target, () => {
    if (normalizeGameCode(code) !== game.code) { socket.emit('rejoin-failed'); return; }
    const player = game.players.find(p => p.token === token);
    if (!player) { socket.emit('rejoin-failed'); return; }
    const oldId = player.id;
    player.id = socket.id;
    // Patch live game state that references the old socket id
    if (game.buzzedPlayerId === oldId) game.buzzedPlayerId = socket.id;
    game.buzzOrder = game.buzzOrder.map(id => id === oldId ? socket.id : id);
    socket.join('players');
    socket.emit('joined', { playerId: socket.id, playerName: player.name, token: player.token });
    socket.emit('game-state', publicState());
    broadcast();
    });
  });

  // ── Library management ────────────────────────────────────────────────────

  socket.on('add-category', ({ name } = {}, ack) => {
    if (game.phase !== 'lobby') return;
    const id = lib.nextId++;
    lib.categories.push({ id, name: (name || '').trim() || 'New Category', questions: [], round: 1 });
    saveLibrary();
    broadcastLibrary();
    if (typeof ack === 'function') ack(id);
  });

  socket.on('delete-category', ({ id }) => {
    if (game.phase !== 'lobby') return;
    lib.categories = lib.categories.filter(c => c.id !== id);
    lib.activeIds = lib.activeIds.filter(i => i !== id);
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('add-generated-categories', ({ categories }) => {
    if (game.phase !== 'lobby') return;
    if (!Array.isArray(categories) || categories.length === 0) return;
    categories.forEach(({ name, questions }) => {
      const id = lib.nextId++;
      lib.categories.push({
        id,
        round: 1,
        name: (name || '').trim() || 'New Category',
        questions: (Array.isArray(questions) ? questions : []).map(q => ({
          value:    q.value    || 200,
          question: (q.question || '').trim(),
          answer:   (q.answer   || '').trim(),
          enabled:  true,
          ...(q.audioUrl   ? { audioUrl:   q.audioUrl   } : {}),
          ...(q.audioStart ? { audioStart: q.audioStart } : {}),
        }))
      });
    });
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('generate-categories', async ({ theme, count }) => {
    if (!anthropic) {
      socket.emit('gen-categories-error', { message: 'Anthropic API not configured. Add your key to config.json.' });
      return;
    }
    const n = Math.min(Math.max(parseInt(count) || 3, 1), 8);
    const themeStr = theme ? ` themed around: "${theme.trim()}"` : '';
    const seed = Math.floor(Math.random() * 1000000);
    const domains = ['pop culture','science','wordplay','history','geography','sports','food & drink','music','literature','movies','TV','art','mythology','animals','technology','language','fashion','architecture','politics','games'];
    const picks = domains.sort(() => Math.random() - 0.5).slice(0, 4).join(', ');
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 6000,
        temperature: 1,
        system: `You are an expert Jeopardy! question writer with decades of experience.
Create original, clever categories with accurate, well-crafted clues.
Categories should be specific and interesting (e.g. "THINGS WITH HOLES" or "BEFORE & AFTER"), not generic (e.g. "HISTORY").
Clues must be written as statements players respond to with "What is/Who is ___?".
Questions should escalate in difficulty: $200 is easy, $1000 is very challenging.
Return ONLY valid JSON with no markdown, code fences, or explanation.`,
        messages: [{
          role: 'user',
          content: `[Randomness seed: ${seed}] Generate ${n} distinct Jeopardy!-style trivia categories${themeStr}.
${!theme ? `Draw from varied domains — consider mixing some of these this time: ${picks}. Be unexpected and specific; avoid the most obvious topics.` : ''}
For each category provide exactly 5 questions at values $200, $400, $600, $800, $1000.
Return this exact JSON structure:
{"categories":[{"name":"CATEGORY NAME","questions":[{"value":200,"question":"clue text","answer":"answer text"},{"value":400,"question":"clue text","answer":"answer text"},{"value":600,"question":"clue text","answer":"answer text"},{"value":800,"question":"clue text","answer":"answer text"},{"value":1000,"question":"clue text","answer":"answer text"}]}]}`
        }]
      });
      let raw = msg.content[0].text.trim()
        .replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
      const data = JSON.parse(raw);
      socket.emit('gen-categories-result', { categories: data.categories });
    } catch (e) {
      socket.emit('gen-categories-error', { message: e.message || 'Generation failed.' });
    }
  });

  socket.on('bulk-delete-categories', ({ ids }) => {
    if (game.phase !== 'lobby') return;
    if (!Array.isArray(ids) || ids.length === 0) return;
    lib.categories = lib.categories.filter(c => !ids.includes(c.id));
    lib.activeIds   = lib.activeIds.filter(id => !ids.includes(id));
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('update-category-name', ({ id, name }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === id);
    if (cat) { cat.name = (name || '').trim() || cat.name; saveLibrary(); broadcastLibrary(); }
  });

  socket.on('set-active', ({ id, active }) => {
    if (active) { if (!lib.activeIds.includes(id)) lib.activeIds.push(id); }
    else { lib.activeIds = lib.activeIds.filter(i => i !== id); }
    saveLibrary();
    broadcastLibrary();
  });

  // update-question does NOT broadcast (keeps focus during typing)
  socket.on('update-question', ({ catId, qIdx, question, answer, value, audioUrl, audioStart }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat?.questions[qIdx]) return;
    if (question !== undefined) cat.questions[qIdx].question = question;
    if (answer  !== undefined) cat.questions[qIdx].answer   = answer;
    if (value   !== undefined) {
      const v = parseInt(value);
      if (!isNaN(v) && v > 0) cat.questions[qIdx].value = v;
    }
    if (audioUrl !== undefined) {
      if (audioUrl) cat.questions[qIdx].audioUrl = audioUrl;
      else delete cat.questions[qIdx].audioUrl;
    }
    if (audioStart !== undefined) {
      const s = parseInt(audioStart);
      if (!isNaN(s) && s > 0) cat.questions[qIdx].audioStart = s;
      else delete cat.questions[qIdx].audioStart;
    }
    saveLibrary();
  });

  socket.on('add-question', ({ catId }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat) return;
    const maxVal = Math.max(0, ...cat.questions.map(q => q.value));
    cat.questions.push({ value: maxVal + 200, question: '', answer: '' });
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('delete-question', ({ catId, qIdx }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat) return;
    cat.questions.splice(qIdx, 1);
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('bulk-delete-questions', ({ catId, qIndices }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat || !Array.isArray(qIndices) || qIndices.length === 0) return;
    [...qIndices].sort((a, b) => b - a).forEach(qi => {
      if (qi >= 0 && qi < cat.questions.length) cat.questions.splice(qi, 1);
    });
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('toggle-question', ({ catId, qIdx }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat?.questions[qIdx]) return;
    const wasEnabled = cat.questions[qIdx].enabled !== false;
    cat.questions[qIdx].enabled = !wasEnabled;
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('add-generated-questions', ({ catId, questions }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat || !Array.isArray(questions)) return;
    questions.forEach(q => {
      cat.questions.push({ value: q.value || 200, question: q.question || '', answer: q.answer || '', enabled: true });
    });
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('generate-questions', async ({ catId, catName }) => {
    if (game.phase !== 'lobby') return;
    if (!anthropic) {
      socket.emit('generate-error', { catId, message: 'Set ANTHROPIC_API_KEY on the server to enable AI generation.' });
      return;
    }
    try {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 2048,
        system: `You are a veteran Jeopardy! clue writer with 20 years of experience crafting engaging, well-researched trivia.

Your clues must follow these rules:
- FORMAT: Present a fact or description; contestants respond "What is [answer]?" The answer should be a specific name, term, place, number, or date — never a yes/no or vague phrase.
- VARIETY: Cover clearly different angles of the category across the 5 clues. Draw from: origins/etymology, geography, record-holders, famous firsts, notable people, science/mechanics, cultural impact, surprising connections, historical moments, and so on. Never write two clues that test the same type of knowledge.
- DIFFICULTY LADDER: $200 = common knowledge most adults know; $400 = educated general knowledge; $600 = something a hobbyist or enthusiast would know; $800 = obscure or highly specific detail; $1000 = expert-level, niche, or tricky.
- QUALITY: Clues should be precise and unambiguous. Avoid filler phrases like "This famous..." or "Known for...". Lead with the interesting fact. Keep clues concise (1–2 sentences).

Return ONLY valid JSON. No markdown fences, no explanation, no extra text.`,
        messages: [{ role: 'user', content: `Write 5 Jeopardy! clues for the category: "${catName}"

JSON format (return exactly this structure, no extra text):
{"questions":[{"question":"clue text","answer":"answer","value":200},{"question":"clue text","answer":"answer","value":400},{"question":"clue text","answer":"answer","value":600},{"question":"clue text","answer":"answer","value":800},{"question":"clue text","answer":"answer","value":1000}]}` }],
      });
      const raw = response.content[0].text.trim().replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
      const data = JSON.parse(raw);
      if (!Array.isArray(data.questions)) throw new Error('Unexpected response shape');
      socket.emit('generated-questions', { catId, questions: data.questions });
    } catch (e) {
      socket.emit('generate-error', { catId, message: 'AI generation failed: ' + e.message });
    }
  });

  socket.on('randomize-game', () => {
    if (game.phase !== 'lobby') return;

    // Eligible = has at least one complete, enabled question and hasn't been played yet
    const hasContent = c => c.questions.some(q => (q.question.trim() || q.audioUrl) && q.answer.trim() && q.enabled !== false);
    let eligible = lib.categories.filter(c => hasContent(c) && !c.played);
    // If all categories have been played, fall back to the full pool
    if (eligible.length === 0) eligible = lib.categories.filter(hasContent);

    if (eligible.length === 0) {
      socket.emit('game-error', 'No categories with questions found.');
      return;
    }

    // Fisher-Yates shuffle
    const pool = [...eligible];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const r1Cats = pool.slice(0, Math.min(6, pool.length));
    const r2Cats = pool.slice(r1Cats.length, r1Cats.length + Math.min(6, pool.length - r1Cats.length));
    const fjCats = pool.slice(r1Cats.length + r2Cats.length, r1Cats.length + r2Cats.length + 1);

    // Reset all: deactivate everything, reset round to 1
    lib.categories.forEach(cat => { cat.round = 1; });
    lib.activeIds = [];

    const markCat = (cat, round) => {
      const c = lib.categories.find(c => c.id === cat.id);
      if (!c) return;
      c.round = round;
      lib.activeIds.push(c.id);
    };

    r1Cats.forEach(c => markCat(c, 1));
    r2Cats.forEach(c => markCat(c, 2));
    fjCats.forEach(c => markCat(c, 'final'));

    saveLibrary();
    broadcastLibrary();
    socket.emit('randomize-result', {
      r1: r1Cats.length, r2: r2Cats.length, hasFinal: fjCats.length > 0,
    });
  });

  socket.on('reset-played-categories', () => {
    if (game.phase !== 'lobby') return;
    lib.categories.forEach(c => { delete c.played; });
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('deactivate-all-categories', () => {
    if (game.phase !== 'lobby') return;
    lib.categories.forEach(cat => { cat.round = 1; });
    lib.activeIds = [];
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('reset-library', () => {
    if (game.phase !== 'lobby') return;
    const categories = defaultQuestions.map((cat, i) => ({ ...cat, id: i }));
    lib = { categories, nextId: categories.length, activeIds: categories.map(c => c.id) };
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('toggle-category-lock', ({ catId }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat) return;
    cat.locked = !cat.locked;
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('reveal-category', ({ catIdx }) => {
    const cat = game.categories[catIdx];
    if (!cat) return;
    cat.locked = false;
    broadcast();
  });

  // ── Game controls ─────────────────────────────────────────────────────────

  socket.on('remove-player', playerId => {
    if (game.phase !== 'lobby') return;
    game.players = game.players.filter(p => p.id !== playerId);
    broadcast();
  });

  socket.on('set-category-round', ({ id, round }) => {
    if (game.phase !== 'lobby') return;
    if (![1, 2, 'final'].includes(round)) return;
    const cat = lib.categories.find(c => c.id === id);
    if (cat) {
      cat.round = round;
      if (round === 'final') cat.page = 1;
      saveLibrary(); broadcastLibrary();
    }
  });

  socket.on('set-category-page', ({ id, page }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === id);
    const pageExists = lib.pages.some(p => p.id === page);
    if (cat && cat.round !== 'final' && pageExists) { cat.page = page; saveLibrary(); broadcastLibrary(); }
  });

  socket.on('add-page', () => {
    if (game.phase !== 'lobby') return;
    const maxId = lib.pages.reduce((m, p) => Math.max(m, p.id), 0);
    const id = maxId + 1;
    lib.pages.push({ id, name: `Page ${id}` });
    saveLibrary(); broadcastLibrary();
  });

  socket.on('rename-page', ({ id, name }) => {
    if (game.phase !== 'lobby') return;
    const p = lib.pages.find(p => p.id === id);
    if (p) { p.name = (name || '').trim().slice(0, 40) || p.name; saveLibrary(); broadcastLibrary(); }
  });

  socket.on('delete-page', ({ id }) => {
    if (game.phase !== 'lobby') return;
    if (lib.pages.length <= 1) return;
    lib.pages = lib.pages.filter(p => p.id !== id);
    const fallback = lib.pages[0].id;
    lib.categories.forEach(cat => { if ((cat.page || 1) === id) cat.page = fallback; });
    saveLibrary(); broadcastLibrary();
  });

  socket.on('switch-page', ({ page }) => {
    if (game.phase !== 'selecting') return;
    if (!game.pages?.some(p => p.id === page)) return;
    game.currentPage = page;
    broadcast();
  });

  socket.on('start-game', () => {
    if (game.players.length < 1) { socket.emit('game-error', 'Need at least one player.'); return; }
    const active = lib.categories
      .filter(c => lib.activeIds.includes(c.id))
      .map(cat => ({
        ...cat,
        round: cat.round || 1,
        questions: cat.questions
          .filter(q => (q.question.trim() || q.audioUrl) && q.answer.trim() && q.enabled !== false)
          .sort((a, b) => a.value - b.value)
          .map(q => ({ ...q, used: false })),
      }))
      .filter(cat => cat.questions.length > 0);
    if (!active.length) {
      socket.emit('game-error', 'No active categories have complete questions (question + answer required).');
      return;
    }
    const round1 = active.filter(c => c.round === 1);
    const round2 = active.filter(c => c.round === 2);
    const finals = active.filter(c => c.round === 'final');
    if (!round1.length) {
      socket.emit('game-error', 'No Round 1 categories found. Mark at least one active category as Round 1.');
      return;
    }
    game.categories = JSON.parse(JSON.stringify(round1));
    game.round2Categories = JSON.parse(JSON.stringify(round2));
    game.pages = JSON.parse(JSON.stringify(lib.pages));
    game.round = 1;
    assignDailyDoubles(game.categories, 1);
    if (finals.length > 0) {
      const fcat = finals[0];
      const fq = fcat.questions[fcat.questions.length - 1];
      game.finalQuestion = { categoryName: fcat.name, question: fq.question, answer: fq.answer };
    } else {
      game.finalQuestion = null;
    }
    game.finalWagers = {};
    game.finalJudged = [];
    game.phase = 'selecting';
    game.currentPlayerIndex = 0;
    if (game.settings.teamMode && game.teams.length > 0) {
      game.teams.forEach((t, i) => { t.isCurrentTurn = i === 0; t.score = 0; });
      const firstTeamId = game.teams[0].id;
      game.players.forEach(p => { p.isCurrentTurn = p.teamId === firstTeamId; p.score = 0; });
    } else {
      game.players[0].isCurrentTurn = true;
    }
    game.playerPowerUps = {};
    game.activePowerUps = {};
    if (game.settings.powerUpsEnabled) {
      const counts = game.settings.powerUpCounts;
      game.players.forEach(p => {
        game.playerPowerUps[p.id] = {
          doubleDown: counts.doubleDown ?? 1,
          shield:     counts.shield     ?? 1,
        };
      });
    }
    broadcast();
  });

  socket.on('start-round2', () => {
    if (game.phase !== 'round-over') return;
    const currentGame = game;
    game.phase = 'round-scores';
    broadcast();
    // Auto-advance after 8 seconds
    if (!currentGame._roundScoresTimer) {
      currentGame._roundScoresTimer = setTimeout(() => withGame(currentGame, () => {
        if (game.phase === 'round-scores') doStartRound2();
        currentGame._roundScoresTimer = null;
      }), 8000);
    }
  });

  socket.on('advance-round-scores', () => {
    if (game.phase !== 'round-scores') return;
    if (game._roundScoresTimer) { clearTimeout(game._roundScoresTimer); game._roundScoresTimer = null; }
    doStartRound2();
  });

  socket.on('submit-wager', ({ wager }) => {
    if (game.phase !== 'final-wager') return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    if (game.settings.teamMode) {
      const teamId = player.teamId;
      if (!teamId || game.finalWagers[teamId] !== undefined) return;
      const team = game.teams.find(t => t.id === teamId);
      const max = Math.max(team?.score ?? 0, 0);
      game.finalWagers[teamId] = Math.min(Math.max(parseInt(wager) || 0, 0), max);
      const allWagered = game.teams.every(t => game.finalWagers[t.id] !== undefined);
      broadcast();
      if (allWagered) { game.phase = 'final-question'; startFinalAnswerTimer(); broadcast(); }
    } else {
      const max = Math.max(player.score, 0);
      game.finalWagers[player.id] = Math.min(Math.max(parseInt(wager) || 0, 0), max);
      const allWagered = game.players.every(p => game.finalWagers[p.id] !== undefined);
      broadcast();
      if (allWagered) { game.phase = 'final-question'; startFinalAnswerTimer(); broadcast(); }
    }
  });

  socket.on('submit-final-answer', ({ answer }) => {
    if (game.phase !== 'final-question' || game.finalAnswersLocked) return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    if (game.settings.teamMode) {
      const teamId = player.teamId;
      if (!teamId || game.finalAnswers[teamId] !== undefined) return;
      game.finalAnswers[teamId] = (answer || '').trim().slice(0, 200);
    } else {
      game.finalAnswers[player.id] = (answer || '').trim().slice(0, 200);
    }
    broadcast();
  });

  socket.on('reveal-final-question', () => {
    if (game.phase !== 'final-wager') return;
    if (game.settings.teamMode) {
      game.teams.forEach(t => { if (game.finalWagers[t.id] === undefined) game.finalWagers[t.id] = 0; });
    } else {
      game.players.forEach(p => { if (game.finalWagers[p.id] === undefined) game.finalWagers[p.id] = 0; });
    }
    game.phase = 'final-question';
    startFinalAnswerTimer();
    broadcast();
  });

  socket.on('judge-final', ({ playerId, correct }) => {
    if (game.phase !== 'final-question') return;
    snapshotScores();
    if (game.settings.teamMode) {
      // playerId is a teamId in team mode
      const teamId = playerId;
      if (game.finalJudged.includes(teamId)) return;
      const team = game.teams.find(t => t.id === teamId);
      if (!team) return;
      const wager = game.finalWagers[teamId] ?? 0;
      team.score += correct ? wager : -wager;
      game.finalJudged.push(teamId);
      if (game.finalJudged.length >= game.teams.length) maybeSetGameOver();
    } else {
      if (game.finalJudged.includes(playerId)) return;
      const player = game.players.find(p => p.id === playerId);
      if (!player) return;
      const wager = game.finalWagers[playerId] ?? 0;
      player.score += correct ? wager : -wager;
      game.finalJudged.push(playerId);
      if (game.finalJudged.length >= game.players.length) maybeSetGameOver();
    }
    broadcast();
  });

  function doSelectQuestion(categoryIndex, questionIndex) {
    const cat = game.categories[categoryIndex];
    const q = cat?.questions[questionIndex];
    if (!q || q.used) return;
    q.used = true;
    game.currentQuestion = {
      categoryName: cat.name, categoryIndex, questionIndex,
      value: q.value, question: q.question, answer: q.answer,
      dailyDouble: q.dailyDouble || false,
      ...(q.audioUrl   ? { audioUrl:   q.audioUrl   } : {}),
      ...(q.audioStart ? { audioStart: q.audioStart } : {}),
    };
    game.lockedOutIds = [];
    game.allPlayAnswers = {};

    if (q.dailyDouble && !game.settings.allPlayMode) {
      game.phase = 'daily-double';
      game.dailyDoubleWager = null;
      game.dailyDoublePlayerId = null;
      game.dailyDoubleCount++;
      game.buzzedPlayerId = null;
      game.buzzOrder = [];
      game.buzzOpen = false;
      game.buzzOpenAt = null;
      game.timerEndsAt = null;
      game.timerType = null;
      broadcast();
      return;
    }

    game.phase = 'question';
    game.buzzedPlayerId = null;
    game.buzzOrder = [];
    game.buzzOpen   = false;
    game.buzzOpenAt = null;

    // Audio-only question (song category): skip TTS lockout, let players respond during the clip
    if (game.currentQuestion.audioUrl && !game.currentQuestion.question) {
      game.timerType = null;
      if (!game.settings.allPlayMode) game.buzzOpen = true;
      startBuzzTimer();
      broadcast();
      return;
    }

    const ttsActive = !!(appSettings.tts?.enabled && elevenLabsKey);

    if (game.settings.allPlayMode) {
      if (ttsActive) {
        game.timerType   = 'tts';
        game.timerEndsAt = null;
        const currentGame = game;
        game.lockTimer = setTimeout(() => withGame(currentGame, () => {
          if (game.phase === 'question' && game.timerType === 'tts') {
            game.timerType = null;
            startBuzzTimer();
            broadcast();
          }
        }), 30000);
      } else {
        startBuzzTimer();
      }
      broadcast();
      return;
    }

    if (ttsActive) {
      game.timerType   = 'tts';
      game.timerEndsAt = null;
      const currentGame = game;
      game.lockTimer = setTimeout(() => withGame(currentGame, () => {
        if (game.phase === 'question' && !game.buzzOpen) {
          game.buzzOpen   = true;
          game.buzzOpenAt = null;
          game.timerType  = null;
          startBuzzTimer();
          broadcast();
        }
      }), 30000);
    } else {
      game.buzzOpenAt  = Date.now() + 8000;
      game.timerEndsAt = game.buzzOpenAt;
      game.timerType   = 'lock';
      const currentGame = game;
      game.lockTimer = setTimeout(() => withGame(currentGame, () => {
        game.buzzOpen   = true;
        game.buzzOpenAt = null;
        startBuzzTimer();
        broadcast();
      }), 8000);
    }
    broadcast();
  }

  socket.on('select-question', ({ categoryIndex, questionIndex }) => {
    if (game.phase !== 'selecting') return;
    if (game.settings.teamMode) {
      const player = game.players.find(p => p.id === socket.id);
      const curTeam = game.teams[game.currentPlayerIndex];
      if (!player || !curTeam || player.teamId !== curTeam.id) return;
    } else {
      const current = game.players[game.currentPlayerIndex];
      if (!current || current.id !== socket.id) return;
    }
    doSelectQuestion(categoryIndex, questionIndex);
  });

  socket.on('host-select-question', ({ categoryIndex, questionIndex }) => {
    if (game.phase !== 'selecting') return;
    doSelectQuestion(categoryIndex, questionIndex);
  });

  socket.on('tts-done', () => {
    if ((game.phase !== 'question' && game.phase !== 'tiebreaker') || game.buzzOpen) return;
    if (game.timerType !== 'tts') return;
    clearLockTimer();
    game.timerType  = null;
    if (game.currentQuestion?.dailyDouble) {
      game.buzzOpen = false;
      startAnswerTimer();
    } else if (game.settings.allPlayMode) {
      game.buzzOpen = false;
      startBuzzTimer();
    } else {
      game.buzzOpen   = true;
      game.buzzOpenAt = null;
      startBuzzTimer();
    }
    broadcast();
  });

  socket.on('buzz-in', () => {
    if (game.phase !== 'question' && game.phase !== 'tiebreaker') return;
    if (!game.buzzOpen) return;
    if (game.buzzOrder.includes(socket.id)) return;
    if (game.settings.teamMode) {
      const player = game.players.find(p => p.id === socket.id);
      if (!player || !player.teamId) return;
      if (game.lockedOutIds.includes(player.teamId)) return;
      // Only one buzz per team per question
      const teamMemberIds = game.players.filter(p => p.teamId === player.teamId).map(p => p.id);
      if (teamMemberIds.some(id => game.buzzOrder.includes(id))) return;
    } else {
      if (game.lockedOutIds.includes(socket.id)) return;
    }
    if (game.phase === 'tiebreaker' && !game.tiebreakerPlayers.includes(socket.id)) return;
    game.buzzOrder.push(socket.id);
    // Record buzz time for recap stats
    if (game.buzzActualOpenAt) {
      if (!game.buzzTimes[socket.id]) game.buzzTimes[socket.id] = [];
      game.buzzTimes[socket.id].push(Date.now() - game.buzzActualOpenAt);
    }
    if (!game.buzzedPlayerId) { game.buzzedPlayerId = socket.id; startAnswerTimer(); }
    broadcast();
  });

  socket.on('judge-answer', ({ correct }) => {
    if (game.phase !== 'question' && game.phase !== 'tiebreaker') return;
    if (!game.buzzedPlayerId) return;
    const player = game.players.find(p => p.id === game.buzzedPlayerId);
    if (!player) return;
    const points = game.currentQuestion.dailyDouble
      ? (game.dailyDoubleWager || 0)
      : game.currentQuestion.value;
    const team = game.settings.teamMode ? game.teams.find(t => t.id === player.teamId) : null;
    const lockId = game.settings.teamMode ? player.teamId : player.id;
    snapshotScores();
    if (correct) {
      io.to(`game:${game.code}`).emit('sound-cue', 'correct');
      game.isStealOpportunity = false;
      let effectivePoints = points;
      if (game.settings.powerUpsEnabled && game.activePowerUps[player.id]?.doubleDown) {
        effectivePoints = points * 2;
        delete game.activePowerUps[player.id].doubleDown;
      }
      // Double Down feature multiplier
      if (game.doubleDown) {
        effectivePoints = effectivePoints * 2;
        game.doubleDown = false;
      }
      if (team) team.score += effectivePoints; else player.score += effectivePoints;
      // Streak tracking
      player.streak = (player.streak || 0) + 1;
      if (team) team.streak = (team.streak || 0) + 1;
      // Correct count tracking for recap
      game.correctCounts[player.id] = (game.correctCounts[player.id] || 0) + 1;
      // Category correct tracking for sweep detection
      if (game.currentQuestion) {
        const catName = game.currentQuestion.categoryName;
        if (catName) {
          if (!game.catCorrect[catName]) game.catCorrect[catName] = {};
          game.catCorrect[catName][player.id] = (game.catCorrect[catName][player.id] || 0) + 1;
        }
      }
      if (game.phase === 'tiebreaker') { game.phase = 'game-over'; broadcast(); return; }
      advanceTurn(player.id);
    } else {
      io.to(`game:${game.code}`).emit('sound-cue', 'wrong');
      const shielded = game.settings.powerUpsEnabled && !!game.activePowerUps[player.id]?.shield;
      if (shielded) {
        delete game.activePowerUps[player.id].shield;
      } else {
        if (team) team.score -= points; else player.score -= points;
      }
      // Reset streak and doubleDown on incorrect
      player.streak = 0;
      if (team) team.streak = 0;
      game.doubleDown = false;
      if (game.settings.lockoutEnabled || game.currentQuestion.dailyDouble || game.phase === 'tiebreaker') {
        if (lockId) game.lockedOutIds.push(lockId);
      }
      if (game.currentQuestion.dailyDouble) {
        advanceTurn(null);
        return;
      }
      if (game.phase === 'tiebreaker') {
        const allOut = game.tiebreakerPlayers.every(id => game.lockedOutIds.includes(id));
        game.buzzOrder      = game.buzzOrder.filter(id => id !== game.buzzedPlayerId);
        game.buzzedPlayerId = game.buzzOrder[0] ?? null;
        if (allOut) { game.phase = 'game-over'; broadcast(); return; }
        if (game.buzzedPlayerId) startAnswerTimer(); else startBuzzTimer();
        broadcast();
        return;
      }
      game.isStealOpportunity = true;
      game.buzzOrder      = game.buzzOrder.filter(id => id !== game.buzzedPlayerId);
      game.buzzedPlayerId = game.buzzOrder[0] ?? null;
      if (game.buzzedPlayerId) startAnswerTimer(); else startBuzzTimer();
      broadcast();
    }
  });

  socket.on('host-pick-dd-player', ({ playerId }) => {
    if (game.phase !== 'daily-double') return;
    const player = game.players.find(p => p.id === playerId);
    if (!player) return;
    game.dailyDoublePlayerId = playerId;
    broadcast();
  });

  socket.on('submit-daily-double-wager', ({ wager }) => {
    if (game.phase !== 'daily-double') return;
    if (!game.dailyDoublePlayerId) return; // host must pick a player first
    const ddPlayer = game.players.find(p => p.id === game.dailyDoublePlayerId);
    if (!ddPlayer || ddPlayer.id !== socket.id) return;
    if (game.settings.teamMode) {
      const team = game.teams.find(t => t.id === ddPlayer.teamId);
      const max = Math.max(team ? team.score : 0, game.currentQuestion.value);
      game.dailyDoubleWager = Math.min(Math.max(parseInt(wager) || 0, 0), max);
    } else {
      const max = Math.max(ddPlayer.score, game.currentQuestion.value);
      game.dailyDoubleWager = Math.min(Math.max(parseInt(wager) || 0, 0), max);
    }
    game.phase = 'question';
    game.buzzedPlayerId = game.dailyDoublePlayerId;
    game.buzzOrder = [game.dailyDoublePlayerId];
    game.lockedOutIds = [];

    const ttsActive = !!(appSettings.tts?.enabled && elevenLabsKey);
    if (ttsActive) {
      game.buzzOpen    = false;
      game.timerType   = 'tts';
      game.timerEndsAt = null;
      const currentGame = game;
      game.lockTimer = setTimeout(() => withGame(currentGame, () => {
        if (game.phase === 'question' && !game.buzzOpen) {
          game.buzzOpen    = true;
          game.timerType   = null;
          startAnswerTimer();
          broadcast();
        }
      }), 30000);
    } else {
      game.buzzOpen = true;
      startAnswerTimer();
    }
    broadcast();
  });

  socket.on('update-settings', (s) => {
    if (game.phase !== 'lobby') return;
    if (s.buzzTime !== undefined)         game.settings.buzzTime         = Math.min(Math.max(parseInt(s.buzzTime) || 30, 5), 120);
    if (s.answerTime !== undefined)       game.settings.answerTime       = Math.min(Math.max(parseInt(s.answerTime) || 10, 5), 60);
    if (s.wagerTime !== undefined)        game.settings.wagerTime        = Math.min(Math.max(parseInt(s.wagerTime) || 30, 10), 60);
    if (s.lockoutEnabled !== undefined)   game.settings.lockoutEnabled   = !!s.lockoutEnabled;
    if (s.dailyDoublesEnabled !== undefined) game.settings.dailyDoublesEnabled = !!s.dailyDoublesEnabled;
    if (s.teamMode !== undefined)         game.settings.teamMode         = !!s.teamMode;
    if (s.allPlayMode !== undefined)      game.settings.allPlayMode      = !!s.allPlayMode;
    if (s.powerUpsEnabled !== undefined)  game.settings.powerUpsEnabled  = !!s.powerUpsEnabled;
    if (s.powerUpCounts && typeof s.powerUpCounts === 'object') {
      game.settings.powerUpCounts = {
        doubleDown: Math.min(Math.max(parseInt(s.powerUpCounts.doubleDown) || 0, 0), 5),
        shield:     Math.min(Math.max(parseInt(s.powerUpCounts.shield)     || 0, 0), 5),
      };
    }
    broadcast();
  });

  socket.on('toggle-game-mode', () => {
    game.settings.allPlayMode = !game.settings.allPlayMode;
    broadcast();
  });

  socket.on('submit-all-play', ({ answer, skip }) => {
    if (game.phase !== 'question' || !game.settings.allPlayMode) return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    const id = game.settings.teamMode ? player.teamId : player.id;
    if (!id || game.allPlayAnswers[id] !== undefined) return;
    game.allPlayAnswers[id] = {
      answer: skip ? null : (answer || '').trim().slice(0, 200),
      skipped: !!skip,
      result: null,
    };
    const participants = game.settings.teamMode ? game.teams : game.players;
    const allDone = participants.every(p => game.allPlayAnswers[p.id] !== undefined);
    broadcast();
    if (allDone) {
      clearGameTimer();
      clearLockTimer();
      game.timerType   = null;
      game.timerEndsAt = null;
      game.phase = 'all-play-review';
      broadcast();
    }
  });

  socket.on('judge-all-play', ({ id, result }) => {
    if (game.phase !== 'all-play-review') return;
    snapshotScores();
    const entry = game.allPlayAnswers[id];
    if (!entry || entry.result !== null) return;
    if (!['correct', 'incorrect', 'skip'].includes(result)) return;
    entry.result = result;
    const val = game.currentQuestion?.value || 0;
    if (game.settings.teamMode) {
      const team = game.teams.find(t => t.id === id);
      if (team) {
        if (result === 'correct')   { team.score += val; game.players.filter(p => p.teamId === id).forEach(p => p.score += val); }
        if (result === 'incorrect') { team.score -= val; game.players.filter(p => p.teamId === id).forEach(p => p.score -= val); }
      }
    } else {
      const player = game.players.find(p => p.id === id);
      if (player) {
        if (result === 'correct')   player.score += val;
        if (result === 'incorrect') player.score -= val;
      }
    }
    broadcast();
  });

  socket.on('finish-all-play', () => {
    if (game.phase !== 'all-play-review') return;
    advanceTurn(null);
  });

  socket.on('duplicate-category', ({ id }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === id);
    if (!cat) return;
    const newCat = JSON.parse(JSON.stringify(cat));
    newCat.id   = lib.nextId++;
    newCat.name = cat.name + ' (copy)';
    lib.categories.push(newCat);
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('import-library', ({ categories, activeIds }) => {
    if (game.phase !== 'lobby') return;
    if (!Array.isArray(categories)) return;
    let nextId = 0;
    categories.forEach(c => { if ((c.id ?? -1) >= nextId) nextId = c.id + 1; });
    lib = { categories, nextId, activeIds: Array.isArray(activeIds) ? activeIds : categories.map(c => c.id) };
    saveLibrary();
    broadcastLibrary();
  });

  socket.on('import-csv-questions', ({ catId, questions }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat || !Array.isArray(questions) || questions.length === 0) return;
    questions.forEach(q => cat.questions.push({ value: q.value || 200, question: q.question || '', answer: q.answer || '', enabled: true }));
    saveLibrary();
    broadcastLibrary();
  });

  // ── Library pack management ────────────────────────────────────────────────

  socket.on('create-library', async ({ name } = {}) => {
    const safeName = (name || '').trim().replace(/[/\\?%*:|"<>]/g, '').slice(0, 40);
    if (!safeName) return;
    if (libraryNames.some(l => l.toLowerCase() === safeName.toLowerCase())) {
      socket.emit('game-error', 'A library with that name already exists.'); return;
    }
    const empty = { categories: [], nextId: 0, activeIds: [], pages: [{ id: 1, name: 'Page 1' }] };
    try { await libraryRepo.createLibrary(safeName, empty, activeUserId); } catch (e) { return; }
    libraryNames = [...libraryNames, safeName].sort();
    broadcastLibrary();
  });

  socket.on('switch-library', async ({ name } = {}) => {
    if (!name) return;
    if (!libraryNames.includes(name)) { socket.emit('game-error', 'Library not found.'); return; }
    saveLibrary();
    appSettings.activeLibrary = name;
    saveAppSettings();
    lib = await libraryRepo.loadLibrary(name, activeUserId);
    if (!lib.pages) lib.pages = [{ id: 1, name: 'Page 1' }];
    broadcastLibrary();
  });

  socket.on('delete-library', async ({ name } = {}) => {
    if (!libraryNames.includes(name)) return;
    if (libraryNames.length <= 1) { socket.emit('game-error', 'Cannot delete the only library.'); return; }
    try { await libraryRepo.deleteLibrary(name, activeUserId); } catch (e) { return; }
    libraryNames = libraryNames.filter(l => l !== name);
    if (appSettings.activeLibrary === name) {
      appSettings.activeLibrary = libraryNames[0] || 'Default';
      saveAppSettings();
      lib = await libraryRepo.loadLibrary(appSettings.activeLibrary, activeUserId);
      if (!lib.pages) lib.pages = [{ id: 1, name: 'Page 1' }];
    }
    broadcastLibrary();
  });

  socket.on('rename-library', async ({ oldName, newName } = {}) => {
    const safeName = (newName || '').trim().replace(/[/\\?%*:|"<>]/g, '').slice(0, 40);
    if (!safeName || !libraryNames.includes(oldName)) return;
    if (libraryNames.some(l => l.toLowerCase() === safeName.toLowerCase() && l !== oldName)) {
      socket.emit('game-error', 'A library with that name already exists.'); return;
    }
    try { await libraryRepo.renameLibrary(oldName, safeName, activeUserId); } catch (e) { return; }
    libraryNames = libraryNames.map(l => l === oldName ? safeName : l).sort();
    if (appSettings.activeLibrary === oldName) {
      appSettings.activeLibrary = safeName;
      saveAppSettings();
    }
    broadcastLibrary();
  });

  socket.on('skip-question', () => {
    if (game.phase !== 'question' && game.phase !== 'tiebreaker' && game.phase !== 'daily-double') return;
    if (game.phase === 'daily-double') { advanceTurn(null); return; }
    advanceTurn(null);
  });

  socket.on('dismiss-answer-reveal', () => {
    if (game.phase !== 'answer-reveal') return;
    advanceTurn(null);
  });

  socket.on('undo-last-score', () => {
    const snap = game.scoreHistory.pop();
    if (!snap) return;
    snap.players.forEach(s => { const p = game.players.find(p => p.id === s.id); if (p) p.score = s.score; });
    snap.teams.forEach(s => { const t = game.teams.find(t => t.id === s.id); if (t) t.score = s.score; });
    broadcast();
  });

  socket.on('toggle-pause', () => {
    if (!['question', 'tiebreaker'].includes(game.phase)) return;
    if (!game.paused) {
      game.pausedTimerType      = game.timerType;
      game.pausedTimerRemaining = game.timerEndsAt ? Math.max(0, game.timerEndsAt - Date.now()) : null;
      if (game.gameTimer) { clearTimeout(game.gameTimer); game.gameTimer = null; }
      game.timerEndsAt = null;
      game.paused = true;
    } else {
      game.paused = false;
      if (game.pausedTimerRemaining !== null && game.pausedTimerType) {
        const ms   = game.pausedTimerRemaining;
        const type = game.pausedTimerType;
        game.timerType   = type;
        game.timerEndsAt = Date.now() + ms;
        game.pausedTimerRemaining = null;
        game.pausedTimerType      = null;
        const currentGame = game;
        game.gameTimer = setTimeout(() => withGame(currentGame, () => {
          if (game.paused) return;
          if (type === 'buzz' && game.phase === 'question' && !game.buzzedPlayerId) {
            game.timerType = null; game.timerEndsAt = null;
            game.phase = game.settings.allPlayMode ? 'all-play-review' : 'answer-reveal';
            broadcast();
          } else if (type === 'answer' && (game.phase === 'question' || game.phase === 'tiebreaker') && game.buzzedPlayerId) {
            advanceTurn(null);
          }
        }), ms);
      }
    }
    broadcast();
  });

  socket.on('toggle-double-down', () => {
    game.doubleDown = !game.doubleDown;
    broadcast();
  });

  socket.on('adjust-score', ({ playerId, delta }) => {
    const player = game.players.find(p => p.id === playerId);
    if (player) { snapshotScores(); player.score += delta; broadcast(); }
  });

  socket.on('adjust-team-score', ({ teamId, delta }) => {
    const team = game.teams.find(t => t.id === teamId);
    if (team) { snapshotScores(); team.score += delta; broadcast(); }
  });

  socket.on('set-score', ({ playerId, score }) => {
    const player = game.players.find(p => p.id === playerId);
    if (player && typeof score === 'number' && isFinite(score)) { snapshotScores(); player.score = Math.round(score); broadcast(); }
  });

  socket.on('set-team-score', ({ teamId, score }) => {
    const team = game.teams.find(t => t.id === teamId);
    if (team && typeof score === 'number' && isFinite(score)) { snapshotScores(); team.score = Math.round(score); broadcast(); }
  });

  socket.on('set-theme', ({ theme }) => {
    if (!VALID_THEMES.includes(theme)) return;
    game.theme = theme;
    game.customThemeVars = null;
    broadcast();
  });

  socket.on('set-custom-theme', ({ vars }) => {
    game.customThemeVars = vars;
    game.theme = 'custom';
    broadcast();
  });

  socket.on('use-power-up', ({ type }) => {
    if (!['doubleDown', 'shield'].includes(type)) return;
    if (!game.settings.powerUpsEnabled) return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    const pu = game.playerPowerUps[socket.id];
    if (!pu || !(pu[type] > 0)) return;
    pu[type]--;
    if (!game.activePowerUps[socket.id]) game.activePowerUps[socket.id] = {};
    game.activePowerUps[socket.id][type] = true;
    broadcast();
  });

  socket.on('cancel-power-up', ({ type }) => {
    if (!['doubleDown', 'shield'].includes(type)) return;
    if (!game.settings.powerUpsEnabled) return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    if (game.activePowerUps[socket.id]?.[type]) {
      delete game.activePowerUps[socket.id][type];
      if (!game.playerPowerUps[socket.id]) game.playerPowerUps[socket.id] = {};
      game.playerPowerUps[socket.id][type] = (game.playerPowerUps[socket.id][type] || 0) + 1;
      broadcast();
    }
  });

  socket.on('rematch', () => {
    if (!io.sockets.adapter.rooms.get('host')?.has(socket.id)) return;
    clearLockTimer();
    if (game.gameTimer) { clearTimeout(game.gameTimer); game.gameTimer = null; }
    if (game._roundScoresTimer) { clearTimeout(game._roundScoresTimer); game._roundScoresTimer = null; }
    // Clear any disconnect timers
    Object.keys(disconnectTimers).forEach(id => { clearTimeout(disconnectTimers[id]); delete disconnectTimers[id]; });
    const prevTheme    = game.theme;
    const prevPlayers  = game.players.map(p => ({ ...p, score: 0, streak: 0, isCurrentTurn: false, disconnectedAt: undefined }));
    const prevTeams    = game.teams.map(t => ({ ...t, score: 0, streak: 0, isCurrentTurn: false }));
    const prevSettings = { ...game.settings };
    const fresh = freshState();
    const sameCode = game.code;
    Object.keys(game).forEach(k => delete game[k]);
    Object.assign(game, fresh, {
      code: sameCode,
      theme: prevTheme,
      players: prevPlayers,
      teams: prevTeams,
      settings: prevSettings,
      gameTimer: null,
      lockTimer: null,
      resultSaved: false,
    });
    broadcast();
  });

  socket.on('generate-category-from-source', async ({ source, sourceType, count }) => {
    if (!anthropic) {
      socket.emit('gen-source-error', { message: 'Anthropic API not configured. Add your key to config.json.' });
      return;
    }
    const n = Math.min(Math.max(parseInt(count) || 1, 1), 10);
    try {
      let contextText = '';
      if (sourceType === 'url') {
        contextText = await fetchUrlText((source || '').trim());
      } else {
        contextText = (source || '').trim();
      }
      if (!contextText) { socket.emit('gen-source-error', { message: 'No content provided.' }); return; }
      const userContent = sourceType === 'url'
        ? `Based on this webpage content, create exactly ${n} distinct Jeopardy! ${n === 1 ? 'category' : 'categories'}. Each should cover a different angle or subtopic of the content. Focus on specific, testable facts:\n\n${contextText.slice(0, 5000)}`
        : `Create exactly ${n} distinct Jeopardy! ${n === 1 ? 'category' : 'categories'} about: "${contextText}". Each should cover a clearly different angle or subtopic.`;
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: n * 1200,
        system: `You are an expert Jeopardy! question writer. Create ${n} distinct ${n === 1 ? 'category' : 'categories'}, each with 5 clues at $200, $400, $600, $800, $1000 escalating in difficulty. Each category must cover a clearly different angle. Clues must be statements answered with "What is/Who is ___?". Return ONLY valid JSON, no markdown: {"categories":[{"name":"CATEGORY NAME","questions":[{"value":200,"question":"clue","answer":"answer"},{"value":400,"question":"clue","answer":"answer"},{"value":600,"question":"clue","answer":"answer"},{"value":800,"question":"clue","answer":"answer"},{"value":1000,"question":"clue","answer":"answer"}]}]}`,
        messages: [{ role: 'user', content: userContent }],
      });
      const raw = msg.content[0].text.trim().replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
      const data = JSON.parse(raw);
      socket.emit('gen-source-result', { categories: Array.isArray(data.categories) ? data.categories : [data] });
    } catch (e) {
      socket.emit('gen-source-error', { message: e.message || 'Generation failed.' });
    }
  });

  // ── Song Category Generation ─────────────────────────────────────────────

  socket.on('generate-song-category', async ({ theme, count }) => {
    const n = Math.min(Math.max(parseInt(count) || 1, 1), 5);
    try {
      const tracks = await searchDeezerTracks(theme, 100);

      if (tracks.length < n * 5) {
        socket.emit('gen-song-error', { message: `Only ${tracks.length} tracks with audio previews found for "${theme}". Try a broader theme.` });
        return;
      }

      const shuffled = tracks.sort(() => Math.random() - 0.5);
      const values = [200, 400, 600, 800, 1000];
      const themeLabel = theme.toUpperCase().slice(0, 22);
      const cats = [];
      for (let i = 0; i < n; i++) {
        cats.push({
          name: `NAME THAT TUNE: ${themeLabel}${n > 1 ? ` (${i + 1})` : ''}`,
          questions: values.map((val, j) => {
            const t = shuffled[i * 5 + j];
            return { value: val, question: '', answer: t.name, audioUrl: t.preview_url };
          }),
        });
      }

      socket.emit('gen-song-result', { categories: cats });
    } catch (e) {
      socket.emit('gen-song-error', { message: e.message || 'Song generation failed.' });
    }
  });

  // ── AI Deduplication ──────────────────────────────────────────────────────

  function buildDupeMap() {
    function norm(s) {
      return (s || '').toLowerCase().trim().replace(/[.,!?;:'"()\[\]]+/g, '').replace(/\s+/g, ' ');
    }
    const catMap = new Map();
    for (const cat of lib.categories) {
      const key = norm(cat.name);
      if (!catMap.has(key)) catMap.set(key, []);
      catMap.get(key).push(cat);
    }
    const dupeCatGroups = [...catMap.values()].filter(g => g.length > 1)
      .map(g => [...g].sort((a, b) => (b.questions || []).length - (a.questions || []).length));

    const qMap = new Map();
    for (const cat of lib.categories) {
      for (let qi = 0; qi < (cat.questions || []).length; qi++) {
        const q = cat.questions[qi];
        if (!q.question) continue;
        const key = norm(q.question);
        if (!qMap.has(key)) qMap.set(key, []);
        qMap.get(key).push({ catId: cat.id, catName: cat.name, qi, question: q.question, answer: q.answer });
      }
    }
    const dupeQGroups = [...qMap.values()].filter(g => g.length > 1);

    return { dupeCatGroups, dupeQGroups, norm };
  }

  socket.on('ai-dedupe-delete', () => {
    const { dupeCatGroups, dupeQGroups, norm } = buildDupeMap();

    const catIdsToDelete = dupeCatGroups.flatMap(group => group.slice(1).map(c => c.id));
    lib.categories = lib.categories.filter(c => !catIdsToDelete.includes(c.id));
    lib.activeIds = lib.activeIds.filter(id => !catIdsToDelete.includes(id));

    const qSeen = new Set();
    let qRemoved = 0;
    for (const cat of lib.categories) {
      const before = (cat.questions || []).length;
      cat.questions = (cat.questions || []).filter(q => {
        const key = norm(q.question);
        if (!key) return true;
        if (qSeen.has(key)) return false;
        qSeen.add(key);
        return true;
      });
      qRemoved += before - cat.questions.length;
    }

    saveLibrary();
    broadcastLibrary();
    socket.emit('ai-dedupe-done', { deletedCategories: catIdsToDelete.length, deletedQuestions: qRemoved, type: 'delete' });
  });

  socket.on('ai-reword-dupes', async () => {
    if (!anthropic) {
      socket.emit('ai-dedupe-error', { message: 'Anthropic API not configured. Add your key in Settings.' });
      return;
    }
    const { dupeCatGroups, dupeQGroups } = buildDupeMap();
    if (dupeCatGroups.length === 0 && dupeQGroups.length === 0) {
      socket.emit('ai-dedupe-done', { rewordedCategories: 0, rewordedQuestions: 0, type: 'reword' });
      return;
    }

    const catTasks = dupeCatGroups.slice(0, 20).flatMap(group =>
      group.slice(1).map(c => ({ id: c.id, currentName: c.name, keepName: group[0].name }))
    );
    const qTasks = dupeQGroups.slice(0, 20).flatMap(group =>
      group.slice(1).map(entry => ({ catId: entry.catId, qi: entry.qi, currentQuestion: entry.question, answer: entry.answer, keepQuestion: group[0].question }))
    );

    const parts = [];
    if (catTasks.length) parts.push(`RENAME THESE DUPLICATE CATEGORY NAMES (make each unique, keep the topic):\n${JSON.stringify(catTasks)}`);
    if (qTasks.length) parts.push(`REWORD THESE JEOPARDY CLUES (keep the same answer, write a different clue):\n${JSON.stringify(qTasks)}`);
    const prompt = parts.join('\n\n') + '\n\nReturn ONLY valid JSON: {"categories":[{"id":<id>,"newName":"..."}],"questions":[{"catId":<id>,"qi":<index>,"newQuestion":"..."}]}';

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 4000,
        system: 'You rename Jeopardy category names and rewrite Jeopardy clues to eliminate duplicates. Respond only with valid JSON, no markdown.',
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0].text.trim().replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
      const result = JSON.parse(raw);

      let catCount = 0, qCount = 0;
      for (const { id, newName } of (result.categories || [])) {
        const cat = lib.categories.find(c => c.id === id);
        if (cat && newName) { cat.name = String(newName).toUpperCase().slice(0, 60); catCount++; }
      }
      for (const { catId, qi, newQuestion } of (result.questions || [])) {
        const cat = lib.categories.find(c => c.id === catId);
        if (cat && cat.questions[qi] && newQuestion) { cat.questions[qi].question = String(newQuestion); qCount++; }
      }

      saveLibrary();
      broadcastLibrary();
      socket.emit('ai-dedupe-done', { rewordedCategories: catCount, rewordedQuestions: qCount, type: 'reword' });
    } catch (e) {
      socket.emit('ai-dedupe-error', { message: e.message || 'AI reword failed.' });
    }
  });

  socket.on('reset-game', () => {
    clearLockTimer();
    if (game.gameTimer) { clearTimeout(game.gameTimer); game.gameTimer = null; }
    if (game._roundScoresTimer) { clearTimeout(game._roundScoresTimer); game._roundScoresTimer = null; }
    Object.keys(disconnectTimers).forEach(id => { clearTimeout(disconnectTimers[id]); delete disconnectTimers[id]; });
    const prevTheme = game.theme;
    const sameCode = game.code;
    const fresh = freshState();
    Object.keys(game).forEach(k => delete game[k]);
    Object.assign(game, fresh, {
      code: sameCode,
      theme: prevTheme,
      gameTimer: null,
      lockTimer: null,
      resultSaved: false,
    });
    broadcast();
  });

  socket.on('get-history', () => {
    socket.emit('history-data', history);
  });

  socket.on('clear-history', () => {
    if (!io.sockets.adapter.rooms.get('host')?.has(socket.id)) return;
    history = [];
    historyRepo.clearHistory(activeUserId).catch(e => console.error('clearHistory error:', e));
    socket.emit('history-data', history);
  });

  socket.on('disconnect', () => {
    // socket.use middleware only runs for incoming packets, not disconnects,
    // so resolve this socket's game explicitly instead of trusting `game`.
    const target = getGame(socket.data.gameCode);
    if (!target) return;
    withGame(target, () => {
      const player = game.players.find(p => p.id === socket.id);
      if (!player) return;
      if (game.phase === 'lobby') {
        game.players = game.players.filter(p => p.id !== socket.id);
        broadcast();
      } else {
        // Grace period: mark disconnected, remove after 60s if not reconnected
        player.disconnectedAt = Date.now();
        broadcast();
        const currentGame = game;
        const socketId = socket.id;
        disconnectTimers[socketId] = setTimeout(() => withGame(currentGame, () => {
          game.players = game.players.filter(p => p.id !== socketId);
          delete disconnectTimers[socketId];
          broadcast();
        }), 60000);
      }
    });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  siteSettings = await siteRepo.loadSiteSettings();
  // Load default-user persistent state asynchronously before accepting connections.
  // Actual host login switches this process-global state to the authenticated user.
  await loadUserState(1);

  // Persist any settings mutations that happened during initialization.
  await settingsRepo.saveAppSettings(appSettings, activeUserId).catch(() => {});

  // Purge expired login sessions on startup and hourly thereafter.
  userRepo.cleanupExpiredSessions().catch(e => console.error('session cleanup error:', e.message));
  setInterval(() => {
    userRepo.cleanupExpiredSessions().catch(e => console.error('session cleanup error:', e.message));
  }, 60 * 60 * 1000).unref();

  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    const localBase = `http://${ip}:${PORT}`;
    console.log('\n  QUIZ-A-ROO SERVER');
    console.log('  ─────────────────────────────────────────');
    console.log(`  Board  (TV):    ${localBase}/board`);
    console.log(`  Admin:          ${localBase}/admin`);
    console.log(`  Host:           ${localBase}/host`);
    console.log(`  Player (phone): ${localBase}/player?code=${game.code}`);
    console.log(`  Game Code:      ${game.code}`);
    console.log('  ─────────────────────────────────────────\n');

    // Pre-warm the ElevenLabs TCP connection so the first TTS call isn't slow
    if (elevenLabsKey) {
      const warmReq = https.request({
        hostname: 'api.elevenlabs.io', path: '/v1/user', method: 'GET',
        agent: elevenLabsAgent,
        headers: { 'xi-api-key': elevenLabsKey },
      }, r => r.resume());
      warmReq.on('error', () => {});
      warmReq.end();
    }
  });
}

main().catch(e => { console.error('Fatal startup error:', e); process.exit(1); });
