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

const PORT = process.env.PORT || 3000;
const LIBRARY_FILE = dataPath('library.json');
const LIBRARIES_DIR = dataPath('libraries');
const HISTORY_FILE = dataPath('history.json');
const APP_SETTINGS_FILE = dataPath('app-settings.json');

// ── History ───────────────────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load history.json:', e.message); }
  return [];
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); }
  catch (e) { console.error('Failed to save history.json:', e.message); }
}

let history = loadHistory();

// ── App settings (persistent defaults) ───────────────────────────────────────

function loadAppSettings() {
  try {
    if (fs.existsSync(APP_SETTINGS_FILE)) return JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8'));
  } catch (e) { console.warn('Could not read app-settings.json:', e.message); }
  return { gameDefaults: {}, defaultTheme: 'classic', customThemeVars: null };
}

function saveAppSettings() {
  try { fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); }
  catch (e) { console.error('Failed to save app-settings.json:', e.message); }
}

let appSettings = loadAppSettings();

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
  history.unshift(entry);
  if (history.length > 50) history = history.slice(0, 50);
  saveHistory();

  // Mark each played category in the library so it can be flagged and excluded from future randomization
  const playedIds = new Set([...game.categories, ...game.round2Categories].map(c => c.id).filter(Boolean));
  let libChanged = false;
  lib.categories.forEach(c => {
    if (playedIds.has(c.id) && !c.played) { c.played = true; libChanged = true; }
  });
  if (libChanged) { saveLibrary(); broadcastLibrary(); }
}

// ── Host PIN auth ─────────────────────────────────────────────────────────────
const HOST_PIN   = '2653';
const HOST_TOKEN = crypto.randomBytes(16).toString('hex');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.get('/board',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

app.get('/host', (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/host_auth=([a-f0-9]+)/);
  if (m && m[1] === HOST_TOKEN) return res.sendFile(path.join(__dirname, 'public', 'host.html'));
  res.sendFile(path.join(__dirname, 'public', 'host-pin.html'));
});
function requireHost(req, res, next) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/host_auth=([a-f0-9]+)/);
  if (m && m[1] === HOST_TOKEN) return next();
  res.status(403).json({ error: 'Forbidden' });
}

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
  res.json({
    apiKeyConfigured:  !!key,
    apiKeyPreview:     key  ? key.slice(0, 14)  + '…' + key.slice(-4)  : '',
    elKeyConfigured:   !!elKey,
    elKeyPreview:      elKey ? elKey.slice(0, 8) + '…' + elKey.slice(-4) : '',
    gameDefaults:      appSettings.gameDefaults  || {},
    defaultTheme:      appSettings.defaultTheme  || 'classic',
    customThemeVars:   appSettings.customThemeVars || null,
    tts:               appSettings.tts || {},
  });
});

app.post('/api/app-settings', requireHost, (req, res) => {
  const { apiKey: newKey, elKey: newElKey, gameDefaults, defaultTheme, customThemeVars, tts } = req.body;
  if (newKey !== undefined || newElKey !== undefined) {
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
    try { fs.writeFileSync(dataPath('config.json'), JSON.stringify(cfg, null, 2)); }
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

app.post('/host-auth', (req, res) => {
  if ((req.body.pin || '').trim() === HOST_PIN) {
    res.setHeader('Set-Cookie', `host_auth=${HOST_TOKEN}; Path=/; SameSite=Strict`);
    return res.redirect('/host');
  }
  res.redirect('/host-pin?error=1');
});

// ── Library (persists to disk) ────────────────────────────────────────────────

function listLibraries() {
  try {
    if (!fs.existsSync(LIBRARIES_DIR)) return ['Default'];
    const names = fs.readdirSync(LIBRARIES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))
      .sort();
    return names.length ? names : ['Default'];
  } catch (e) { return ['Default']; }
}

function activeLibraryPath() {
  const name = appSettings.activeLibrary || 'Default';
  return path.join(LIBRARIES_DIR, name + '.json');
}

function loadLibrary() {
  if (!fs.existsSync(LIBRARIES_DIR)) {
    fs.mkdirSync(LIBRARIES_DIR, { recursive: true });
  }
  // Migrate legacy library.json to named libraries/ on first run
  if (!appSettings.activeLibrary && fs.existsSync(LIBRARY_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
      fs.writeFileSync(path.join(LIBRARIES_DIR, 'Default.json'), JSON.stringify(legacy, null, 2));
    } catch (e) { console.warn('Library migration failed:', e.message); }
  }
  if (!appSettings.activeLibrary) appSettings.activeLibrary = 'Default';
  try {
    const libPath = activeLibraryPath();
    if (fs.existsSync(libPath)) return JSON.parse(fs.readFileSync(libPath, 'utf8'));
    // Fallback to legacy file
    if (fs.existsSync(LIBRARY_FILE)) return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load library:', e.message); }
  const categories = defaultQuestions.map((cat, i) => ({ ...cat, id: i }));
  return { categories, nextId: categories.length, activeIds: categories.map(c => c.id) };
}

function saveLibrary() {
  if (!fs.existsSync(LIBRARIES_DIR)) fs.mkdirSync(LIBRARIES_DIR, { recursive: true });
  try { fs.writeFileSync(activeLibraryPath(), JSON.stringify(lib, null, 2)); }
  catch (e) { console.error('Failed to save library:', e.message); }
}

let lib = loadLibrary();
if (!lib.pages) lib.pages = [{ id: 1, name: 'Page 1' }];
saveAppSettings(); // persist activeLibrary if it was just set during migration

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

const VALID_THEMES = ['classic','midnight','retro','forest','crimson','ocean','violet'];

function freshState() {
  const d = appSettings.gameDefaults || {};
  return {
    phase: 'lobby',
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

let game = freshState();
let gameTimer = null;
let lockTimer = null;
let gameResultSaved = false;

function clearLockTimer() {
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}

function clearGameTimer() {
  if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
  game.timerEndsAt = null;
  game.timerType   = null;
}

function startBuzzTimer() {
  clearGameTimer();
  const ms = (game.settings.buzzTime || 30) * 1000;
  game.timerType   = 'buzz';
  game.timerEndsAt = Date.now() + ms;
  gameTimer = setTimeout(() => {
    if (game.phase === 'tiebreaker' && !game.buzzedPlayerId) { advanceTurn(null); return; }
    if (game.phase === 'question' && !game.buzzedPlayerId) {
      game.timerType   = null;
      game.timerEndsAt = null;
      game.phase = game.settings.allPlayMode ? 'all-play-review' : 'answer-reveal';
      broadcast();
    }
  }, ms);
}

function startFinalWagerTimer() {
  clearGameTimer();
  const wagerMs = (game.settings.wagerTime || 30) * 1000;
  game.timerType   = 'final-wager';
  game.timerEndsAt = Date.now() + wagerMs;
  gameTimer = setTimeout(() => {
    if (game.phase !== 'final-wager') return;
    if (game.settings.teamMode) {
      game.teams.forEach(t => { if (game.finalWagers[t.id] === undefined) game.finalWagers[t.id] = 0; });
    } else {
      game.players.forEach(p => { if (game.finalWagers[p.id] === undefined) game.finalWagers[p.id] = 0; });
    }
    game.phase = 'final-question';
    startFinalAnswerTimer();
    broadcast();
  }, wagerMs);
}

function startFinalAnswerTimer() {
  clearGameTimer();
  game.timerType   = 'final-answer';
  game.timerEndsAt = Date.now() + 30000;
  gameTimer = setTimeout(() => {
    if (game.phase !== 'final-question') return;
    game.finalAnswersLocked = true;
    game.timerType   = null;
    game.timerEndsAt = null;
    broadcast();
  }, 30000);
}

function startAnswerTimer() {
  clearGameTimer();
  const ms = (game.settings.answerTime || 10) * 1000;
  game.timerType   = 'answer';
  game.timerEndsAt = Date.now() + ms;
  gameTimer = setTimeout(() => {
    if (game.phase !== 'question' && game.phase !== 'tiebreaker') return;
    if (!game.buzzedPlayerId) return;
    const player = game.players.find(p => p.id === game.buzzedPlayerId);
    const points = game.currentQuestion.dailyDouble ? (game.dailyDoubleWager || 0) : game.currentQuestion.value;
    if (player) { snapshotScores(); player.score -= points; }
    game.buzzOrder = game.buzzOrder.filter(id => id !== game.buzzedPlayerId);
    if (game.settings.lockoutEnabled) game.lockedOutIds.push(game.buzzedPlayerId);
    game.buzzedPlayerId = game.buzzOrder[0] ?? null;
    if (game.buzzedPlayerId) startAnswerTimer();
    else advanceTurn(null);
    broadcast();
  }, ms);
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

function playerUrl() { return `http://${getLocalIP()}:${PORT}/player`; }

let qrDataUrl = null;
async function buildQR() {
  try {
    qrDataUrl = await QRCode.toDataURL(playerUrl(), {
      width: 300, margin: 2,
      color: { dark: '#000080', light: '#FFD700' },
    });
  } catch (e) { console.error('QR generation failed:', e.message); }
}

function publicState() {
  const revealFinal = ['final-question', 'game-over'].includes(game.phase);
  return {
    phase: game.phase,
    theme: game.theme,
    round: game.round,
    players: game.players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji || '', score: p.score, isCurrentTurn: p.isCurrentTurn, teamId: p.teamId || null })),
    currentPlayerIndex: game.currentPlayerIndex,
    categories: game.categories.map(cat => ({
      name: cat.name,
      page: cat.page || 1,
      questions: cat.questions.map(({ value, used }) => ({ value, used })),
    })),
    currentPage: game.currentPage || 1,
    pages: game.pages || [{ id: 1, name: 'Page 1' }],
    ttsEnabled: !!(appSettings.tts?.enabled && elevenLabsKey),
    currentQuestion: game.currentQuestion ? {
      categoryName: game.currentQuestion.categoryName,
      value: game.currentQuestion.value,
      question: game.currentQuestion.question,
      answer: (game.phase === 'answer-reveal' || game.phase === 'all-play-review') ? game.currentQuestion.answer : undefined,
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
    allPlayAnswers: game.phase === 'all-play-review'
      ? JSON.parse(JSON.stringify(game.allPlayAnswers))
      : Object.fromEntries(Object.entries(game.allPlayAnswers).map(([id, v]) => [id, { submitted: true, skipped: v.skipped }])),
    dailyDoubleWager: game.dailyDoubleWager,
    dailyDoublePlayerId: game.dailyDoublePlayerId,
    dailyDoubleCount: game.dailyDoubleCount,
    isStealOpportunity: game.isStealOpportunity,
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
    teams: game.teams.map(t => ({ id: t.id, name: t.name, score: t.score, memberIds: [...t.memberIds], isCurrentTurn: t.isCurrentTurn || false })),
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
  if (game.phase === 'game-over' && !gameResultSaved) {
    gameResultSaved = true;
    recordGameResult();
  }
  io.emit('game-state', publicState());
  io.to('host').emit('host-state', hostState());
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
    lockTimer = setTimeout(() => {
      game.buzzOpen   = true;
      game.buzzOpenAt = null;
      startBuzzTimer();
      broadcast();
    }, 8000);
  } else {
    game.phase = 'game-over';
  }
}

function advanceTurn(winnerId) {
  clearLockTimer();
  clearGameTimer();
  game.buzzOpen   = false;
  game.buzzOpenAt = null;
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
    rejectUnauthorized: false,
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

io.on('connection', socket => {

  socket.on('join-board', () => {
    socket.join('board');
    socket.emit('game-state', publicState());
    socket.emit('player-url', { url: playerUrl(), qr: qrDataUrl });
  });

  socket.on('join-host', () => {
    socket.join('host');
    socket.emit('host-state', hostState());
    socket.emit('library-state', { categories: lib.categories, activeIds: lib.activeIds, pages: lib.pages, libraries: listLibraries(), activeLibrary: appSettings.activeLibrary || 'Default' });
    socket.emit('player-url', { url: playerUrl(), qr: qrDataUrl, pin: HOST_PIN });
  });

  socket.on('join-player', ({ name, emoji }) => {
    if (game.phase !== 'lobby') { socket.emit('join-error', 'Game already in progress.'); return; }
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) { socket.emit('join-error', 'Name cannot be empty.'); return; }
    if (game.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      socket.emit('join-error', 'That name is already taken.'); return;
    }
    const token = generateToken();
    const safeEmoji = (typeof emoji === 'string' && /^\p{Emoji}/u.test(emoji)) ? emoji.slice(0, 2) : '';
    game.players.push({ id: socket.id, name: trimmed, emoji: safeEmoji, score: 0, isCurrentTurn: false, token, teamId: null });
    socket.join('players');
    socket.emit('joined', { playerId: socket.id, playerName: trimmed, token });
    broadcast();
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
      const newTeam = { id: `t${Date.now()}`, name: trimmedName, score: 0, memberIds: [socket.id], isCurrentTurn: false };
      game.teams.push(newTeam);
      if (player.teamId) {
        const oldTeam = game.teams.find(t => t.id === player.teamId);
        if (oldTeam) oldTeam.memberIds = oldTeam.memberIds.filter(id => id !== socket.id);
      }
      player.teamId = newTeam.id;
    }
    broadcast();
  });

  socket.on('rejoin-player', ({ token }) => {
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
          enabled:  true
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
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 6000,
        system: `You are an expert Jeopardy! question writer with decades of experience.
Create original, clever categories with accurate, well-crafted clues.
Categories should be specific and interesting (e.g. "THINGS WITH HOLES" or "BEFORE & AFTER"), not generic (e.g. "HISTORY").
Clues must be written as statements players respond to with "What is/Who is ___?".
Questions should escalate in difficulty: $200 is easy, $1000 is very challenging.
Return ONLY valid JSON with no markdown, code fences, or explanation.`,
        messages: [{
          role: 'user',
          content: `Generate ${n} distinct Jeopardy!-style trivia categories${themeStr}.
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
  socket.on('update-question', ({ catId, qIdx, question, answer, value }) => {
    if (game.phase !== 'lobby') return;
    const cat = lib.categories.find(c => c.id === catId);
    if (!cat?.questions[qIdx]) return;
    if (question !== undefined) cat.questions[qIdx].question = question;
    if (answer  !== undefined) cat.questions[qIdx].answer   = answer;
    if (value   !== undefined) {
      const v = parseInt(value);
      if (!isNaN(v) && v > 0) cat.questions[qIdx].value = v;
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
    const hasContent = c => c.questions.some(q => q.question.trim() && q.answer.trim() && q.enabled !== false);
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
          .filter(q => q.question.trim() && q.answer.trim() && q.enabled !== false)
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

    const ttsActive = !!(appSettings.tts?.enabled && elevenLabsKey);

    if (game.settings.allPlayMode) {
      if (ttsActive) {
        game.timerType   = 'tts';
        game.timerEndsAt = null;
        lockTimer = setTimeout(() => {
          if (game.phase === 'question' && game.timerType === 'tts') {
            game.timerType = null;
            startBuzzTimer();
            broadcast();
          }
        }, 30000);
      } else {
        startBuzzTimer();
      }
      broadcast();
      return;
    }

    if (ttsActive) {
      game.timerType   = 'tts';
      game.timerEndsAt = null;
      lockTimer = setTimeout(() => {
        if (game.phase === 'question' && !game.buzzOpen) {
          game.buzzOpen   = true;
          game.buzzOpenAt = null;
          game.timerType  = null;
          startBuzzTimer();
          broadcast();
        }
      }, 30000);
    } else {
      game.buzzOpenAt  = Date.now() + 8000;
      game.timerEndsAt = game.buzzOpenAt;
      game.timerType   = 'lock';
      lockTimer = setTimeout(() => {
        game.buzzOpen   = true;
        game.buzzOpenAt = null;
        startBuzzTimer();
        broadcast();
      }, 8000);
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
      io.emit('sound-cue', 'correct');
      game.isStealOpportunity = false;
      let effectivePoints = points;
      if (game.settings.powerUpsEnabled && game.activePowerUps[player.id]?.doubleDown) {
        effectivePoints = points * 2;
        delete game.activePowerUps[player.id].doubleDown;
      }
      if (team) team.score += effectivePoints; else player.score += effectivePoints;
      if (game.phase === 'tiebreaker') { game.phase = 'game-over'; broadcast(); return; }
      advanceTurn(player.id);
    } else {
      io.emit('sound-cue', 'wrong');
      const shielded = game.settings.powerUpsEnabled && !!game.activePowerUps[player.id]?.shield;
      if (shielded) {
        delete game.activePowerUps[player.id].shield;
      } else {
        if (team) team.score -= points; else player.score -= points;
      }
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
      lockTimer = setTimeout(() => {
        if (game.phase === 'question' && !game.buzzOpen) {
          game.buzzOpen    = true;
          game.timerType   = null;
          startAnswerTimer();
          broadcast();
        }
      }, 30000);
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

  socket.on('create-library', ({ name } = {}) => {
    const safeName = (name || '').trim().replace(/[/\\?%*:|"<>]/g, '').slice(0, 40);
    if (!safeName) return;
    const allLibs = listLibraries();
    if (allLibs.some(l => l.toLowerCase() === safeName.toLowerCase())) {
      socket.emit('game-error', 'A library with that name already exists.'); return;
    }
    if (!fs.existsSync(LIBRARIES_DIR)) fs.mkdirSync(LIBRARIES_DIR, { recursive: true });
    const empty = { categories: [], nextId: 0, activeIds: [], pages: [{ id: 1, name: 'Page 1' }] };
    fs.writeFileSync(path.join(LIBRARIES_DIR, safeName + '.json'), JSON.stringify(empty, null, 2));
    broadcastLibrary();
  });

  socket.on('switch-library', ({ name } = {}) => {
    if (!name) return;
    if (!listLibraries().includes(name)) { socket.emit('game-error', 'Library not found.'); return; }
    saveLibrary();
    appSettings.activeLibrary = name;
    saveAppSettings();
    lib = loadLibrary();
    if (!lib.pages) lib.pages = [{ id: 1, name: 'Page 1' }];
    broadcastLibrary();
  });

  socket.on('delete-library', ({ name } = {}) => {
    const allLibs = listLibraries();
    if (!allLibs.includes(name)) return;
    if (allLibs.length <= 1) { socket.emit('game-error', 'Cannot delete the only library.'); return; }
    try { fs.unlinkSync(path.join(LIBRARIES_DIR, name + '.json')); } catch (e) { return; }
    if (appSettings.activeLibrary === name) {
      appSettings.activeLibrary = allLibs.find(l => l !== name) || 'Default';
      saveAppSettings();
      lib = loadLibrary();
      if (!lib.pages) lib.pages = [{ id: 1, name: 'Page 1' }];
    }
    broadcastLibrary();
  });

  socket.on('rename-library', ({ oldName, newName } = {}) => {
    const safeName = (newName || '').trim().replace(/[/\\?%*:|"<>]/g, '').slice(0, 40);
    const allLibs = listLibraries();
    if (!safeName || !allLibs.includes(oldName)) return;
    if (allLibs.some(l => l.toLowerCase() === safeName.toLowerCase() && l !== oldName)) {
      socket.emit('game-error', 'A library with that name already exists.'); return;
    }
    try {
      fs.renameSync(path.join(LIBRARIES_DIR, oldName + '.json'), path.join(LIBRARIES_DIR, safeName + '.json'));
    } catch (e) { return; }
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
      if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
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
        gameTimer = setTimeout(() => {
          if (game.paused) return;
          if (type === 'buzz' && game.phase === 'question' && !game.buzzedPlayerId) {
            game.timerType = null; game.timerEndsAt = null;
            game.phase = game.settings.allPlayMode ? 'all-play-review' : 'answer-reveal';
            broadcast();
          } else if (type === 'answer' && (game.phase === 'question' || game.phase === 'tiebreaker') && game.buzzedPlayerId) {
            advanceTurn(null);
          }
        }, ms);
      }
    }
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
    io.emit('game-state', publicState());
  });

  socket.on('set-custom-theme', ({ vars }) => {
    game.customThemeVars = vars;
    game.theme = 'custom';
    io.emit('game-state', publicState());
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
    if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
    const prevTheme    = game.theme;
    const prevPlayers  = game.players.map(p => ({ ...p, score: 0, isCurrentTurn: false }));
    const prevTeams    = game.teams.map(t => ({ ...t, score: 0, isCurrentTurn: false }));
    const prevSettings = { ...game.settings };
    game = freshState();
    game.theme    = prevTheme;
    game.players  = prevPlayers;
    game.teams    = prevTeams;
    game.settings = prevSettings;
    gameResultSaved = false;
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

  socket.on('reset-game', () => {
    clearLockTimer();
    if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
    const prevTheme = game.theme;
    game = freshState();
    game.theme = prevTheme;
    gameResultSaved = false;
    broadcast();
  });

  socket.on('get-history', () => {
    socket.emit('history-data', history);
  });

  socket.on('clear-history', () => {
    if (!io.sockets.adapter.rooms.get('host')?.has(socket.id)) return;
    history = [];
    saveHistory();
    socket.emit('history-data', history);
  });

  socket.on('disconnect', () => {
    if (game.phase === 'lobby') {
      game.players = game.players.filter(p => p.id !== socket.id);
      broadcast();
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  await buildQR();
  const ip = getLocalIP();
  console.log('\n  TRIVIA NIGHT SERVER');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Board  (TV):    http://${ip}:${PORT}/board`);
  console.log(`  Host:           http://${ip}:${PORT}/host  (PIN: ${HOST_PIN})`);
  console.log(`  Player (phone): http://${ip}:${PORT}/player`);
  console.log('  ─────────────────────────────────────────\n');
});
