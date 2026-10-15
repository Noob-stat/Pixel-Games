'use strict';

/*
 * Pixel Games - realtime party game server.
 * Serves the hub (public/) plus every game under public/games/, and hosts all
 * realtime rooms over a single WebSocket endpoint. Node + ws only.
 * Deployable anywhere that runs Node (PORT env respected).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MAX_CUSTOM_WORDS = 80;

/* ------------------------------- game content ------------------------------ */

const CATEGORIES = {
  Animals: ['elephant', 'penguin', 'octopus', 'giraffe', 'hedgehog', 'butterfly', 'kangaroo', 'dolphin', 'squirrel', 'crocodile', 'owl', 'snail', 'shark', 'rabbit', 'camel', 'flamingo', 'turtle', 'bee', 'fox', 'panda'],
  Food: ['pizza', 'sushi', 'taco', 'pancake', 'watermelon', 'spaghetti', 'donut', 'popcorn', 'burger', 'ice cream', 'soup', 'sandwich', 'banana', 'cheese', 'carrot', 'cupcake', 'pasta', 'strawberry', 'coffee', 'fries'],
  Places: ['lighthouse', 'castle', 'volcano', 'beach', 'airport', 'hospital', 'library', 'stadium', 'desert', 'island', 'bridge', 'farm', 'museum', 'zoo', 'campsite', 'subway', 'park', 'hotel', 'mall', 'harbour'],
  Objects: ['umbrella', 'guitar', 'telescope', 'typewriter', 'hourglass', 'anchor', 'backpack', 'camera', 'lantern', 'compass', 'kite', 'robot', 'mirror', 'key', 'clock', 'scissors', 'balloon', 'ladder', 'candle', 'crown'],
  Nature: ['rainbow', 'mountain', 'waterfall', 'cactus', 'lightning', 'tornado', 'sunflower', 'glacier', 'cave', 'river', 'forest', 'cloud', 'mushroom', 'canyon', 'star', 'moon', 'bamboo', 'coral', 'snowflake', 'island'],
  Jobs: ['astronaut', 'firefighter', 'chef', 'doctor', 'pirate', 'wizard', 'detective', 'farmer', 'diver', 'knight', 'clown', 'pilot', 'scientist', 'barber', 'ninja', 'artist', 'judge', 'magician', 'postman', 'viking'],
  Movies: ['titanic', 'jaws', 'avatar', 'inception', 'frozen', 'godzilla', 'rocky', 'grease', 'shrek', 'alien', 'barbie', 'gladiator', 'matrix', 'up', 'cars', 'elf', 'psycho', 'ratatouille'],
};

const COLORS = ['#e5484d', '#0090ff', '#f5a524', '#30a46c', '#8e4ec6', '#e93d82', '#12a594', '#9a6b3f', '#575ad6', '#c8482a'];

const REACTIONS = ['😂', '😮', '🔥', '👀', '😭', '🤔', '👏', '💀', '🎉', '🫠', '😅', '🧐'];
const REACTION_COOLDOWN = 650; // ms per player

const MAX_ROUNDS = 10;
const MAX_LINES = 3;
// How long the caught Fake gets to steal the win. Timed so a sleeping phone
// can never leave the whole room stuck on the guess screen.
const GUESS_SECONDS = 45;

/* --------------------------------- helpers --------------------------------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(n = 4) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const clampInt = (v, lo, hi, fallback) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';

function cleanWords(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(/[\n,;]+/);
  const out = [];
  for (let w of arr) {
    w = String(w).replace(/[<>]/g, '').trim().slice(0, 40);
    if (!w) continue;
    const key = normalize(w);
    if (!key || out.some((x) => normalize(x) === key)) continue;
    out.push(w);
    if (out.length >= MAX_CUSTOM_WORDS) break;
  }
  return out;
}

/* ---------------------------------- rooms ---------------------------------- */

function defaultSettings() {
  return {
    category: 'random',   // 'random' or a CATEGORIES key
    rounds: 3,            // rounds per game
    lines: 2,             // lines each, per round
    fakes: 1,             // 1-2 (clamped to the player count when a round starts)
    turnTime: 0,          // seconds per turn; 0 = off
    voteTime: 0,          // seconds to vote; 0 = off (auto-fills missing votes)
    fakesKnowEachOther: false,
    shuffleFakes: true,   // new fake(s) every round
    rotateCategory: false, // pick a fresh random category each round even if one is chosen
    customWords: [],
    customHint: '',
  };
}

const rooms = new Map();

function createRoom() {
  let code;
  do { code = makeCode(); } while (rooms.has(code));
  const room = {
    code,
    players: new Map(),
    banned: new Set(),
    hostId: null,
    phase: 'lobby',
    settings: defaultSettings(),
    order: [],
    turnIndex: 0,
    line: 1,
    lines: 2,
    roundNo: 0,          // current round (1..gameRounds)
    gameRounds: 3,
    gameOver: false,
    strokes: [],
    strokeGen: 0,        // bumped whenever the drawing is cleared
    votes: {},
    word: null,
    category: null,
    wordHistory: [],
    fakeIds: [],
    caughtFakeId: null,
    outcome: null,
    guessText: null,
    turnEndsAt: 0,
    voteEndsAt: 0,
    guessEndsAt: 0,
    lastReaction: {},
    lastActive: Date.now(),
    _bcast: null,
  };
  rooms.set(code, room);
  return room;
}

function ensureHost(room) {
  const list = [...room.players.values()];
  if (!list.length) { room.hostId = null; return; }
  if (room.hostId && list.some((p) => p.id === room.hostId)) return;
  const fallback = list.find((p) => p.connected) || list[0];
  room.hostId = fallback.id;
  list.forEach((p) => { p.isHost = p.id === room.hostId; });
}

function addPlayer(room, id, rawName) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || pick(COLORS);
  const player = {
    id,
    name: cleanName(rawName),
    color,
    score: 0,
    roundsWon: 0,
    connected: true,
    isHost: room.players.size === 0,
    socket: null,
  };
  room.players.set(id, player);
  if (player.isHost) room.hostId = id;
  ensureHost(room);
  return player;
}

function removePlayer(room, id) {
  room.players.delete(id);
  delete room.votes[id];
  Object.keys(room.votes).forEach((k) => { if (room.votes[k] === id) delete room.votes[k]; });
  room.order = room.order.filter((x) => x !== id);
  if (room.fakeIds) room.fakeIds = room.fakeIds.filter((x) => x !== id);
  ensureHost(room);
}

function tally(room) {
  const t = {};
  for (const target of Object.values(room.votes)) t[target] = (t[target] || 0) + 1;
  return t;
}

const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);
const connectedCount = (room) => connectedPlayers(room).length;
const maxFakesFor = (n) => Math.max(1, Math.min(2, n - 2));

/* -------------------------------- game flow -------------------------------- */

// Picks the word for the current round. A random category rotates every round,
// the host may force rotation with `rotateCategory`, and words never repeat
// twice inside the same game.
function resolveWord(room) {
  const s = room.settings;
  const used = room.wordHistory;

  if (s.customWords && s.customWords.length) {
    const fresh = s.customWords.filter((w) => !used.includes(normalize(w)));
    room.word = pick(fresh.length ? fresh : s.customWords);
    room.category = (s.customHint && s.customHint.trim())
      ? s.customHint.trim().slice(0, 30) : 'Custom words';
  } else {
    const names = Object.keys(CATEGORIES);
    const chosen = (s.category && s.category !== 'random' && CATEGORIES[s.category]) ? s.category : null;
    const rotate = !chosen || s.rotateCategory;
    let cat = rotate ? pick(names) : chosen;
    // never pick the same word twice in one game
    let word = pick(CATEGORIES[cat]);
    for (let i = 0; i < 20 && used.includes(normalize(word)); i++) word = pick(CATEGORIES[cat]);
    room.category = cat;
    room.word = word;
  }

  used.push(normalize(room.word));
  while (used.length > 60) used.shift();
}

function armTurn(room) {
  if (room.phase === 'drawing' && room.settings.turnTime > 0) {
    room.turnEndsAt = Date.now() + room.settings.turnTime * 1000;
  } else {
    room.turnEndsAt = 0;
  }
}

function armVote(room) {
  if (room.phase === 'voting' && room.settings.voteTime > 0) {
    room.voteEndsAt = Date.now() + room.settings.voteTime * 1000;
  } else {
    room.voteEndsAt = 0;
  }
}

/*
 * Starts a round (or the first round of a new game).
 * Every round: new word + new category (when rotating) and, by default, new
 * fake(s). Scores persist unless opts.resetScores is set.
 */
function startRound(room, opts = {}) {
  const active = connectedPlayers(room);
  if (active.length < MIN_PLAYERS) return { error: `Need at least ${MIN_PLAYERS} players.` };
  const s = room.settings;

  if (opts.resetScores) room.players.forEach((p) => { p.score = 0; p.roundsWon = 0; });
  if (opts.newGame) { room.roundNo = 0; room.wordHistory = []; }

  room.gameRounds = clampInt(s.rounds, 1, MAX_ROUNDS, 3);
  room.lines = clampInt(s.lines, 1, MAX_LINES, 2);
  room.roundNo += 1;
  if (room.roundNo > room.gameRounds) room.roundNo = room.gameRounds;
  room.gameOver = false;

  const fakeCount = clampInt(s.fakes, 1, maxFakesFor(active.length), 1);
  const reshuffle = opts.newGame || s.shuffleFakes || !room.fakeIds.length;
  if (reshuffle) {
    room.fakeIds = shuffle(active.map((p) => p.id)).slice(0, fakeCount);
  } else {
    const ids = active.map((p) => p.id);
    room.fakeIds = room.fakeIds.filter((id) => ids.includes(id)).slice(0, fakeCount);
    while (room.fakeIds.length < fakeCount) {
      const candidates = ids.filter((id) => !room.fakeIds.includes(id));
      if (!candidates.length) break;
      room.fakeIds.push(pick(candidates));
    }
  }

  resolveWord(room);

  room.order = shuffle(active.map((p) => p.id));
  room.turnIndex = 0;
  room.line = 1;
  room.strokes = [];
  room.strokeGen = (room.strokeGen || 0) + 1;
  room.votes = {};
  room.outcome = null;
  room.guessText = null;
  room.caughtFakeId = null;
  room.turnEndsAt = 0;
  room.voteEndsAt = 0;
  room.guessEndsAt = 0;
  room.phase = 'drawing';
  ensureActiveTurn(room);
  armTurn(room);
  return {};
}

function advanceTurn(room, guard = 0) {
  if (guard > 1000) return;
  room.turnIndex++;
  if (room.turnIndex >= room.order.length) {
    room.turnIndex = 0;
    room.line++;
    if (room.line > room.lines) { room.phase = 'voting'; room.turnEndsAt = 0; armVote(room); return; }
  }
  const cur = room.players.get(room.order[room.turnIndex]);
  if (!cur || !cur.connected) advanceTurn(room, guard + 1);
}

function ensureActiveTurn(room) {
  if (room.phase !== 'drawing') return;
  const cur = room.players.get(room.order[room.turnIndex]);
  if (cur && cur.connected) return;
  advanceTurn(room);
}

function finishTurn(room) {
  if (room.phase !== 'drawing') return;
  const last = room.strokes[room.strokes.length - 1];
  if (last && last.inProgress) { last.inProgress = false; sendInkDone(room, room.strokes.length - 1); }
  advanceTurn(room);
  ensureActiveTurn(room);
  armTurn(room);
}

function resolveVotes(room) {
  const t = tally(room);
  let top = null, topN = -1, tie = false;
  for (const [id, n] of Object.entries(t)) {
    if (n > topN) { top = id; topN = n; tie = false; }
    else if (n === topN) { tie = true; }
  }
  const caught = !tie && topN > 0 && room.fakeIds.includes(top);
  room.turnEndsAt = 0;
  room.voteEndsAt = 0;
  if (caught) {
    room.caughtFakeId = top;
    room.phase = 'guess';
    room.guessEndsAt = Date.now() + GUESS_SECONDS * 1000;
  } else {
    room.outcome = 'fake_escaped';
    room.fakeIds.forEach((id) => {
      const f = room.players.get(id);
      if (f) { f.score += 2; f.roundsWon += 1; }
    });
    endRound(room);
  }
}

function autoVote(room) {
  const connected = connectedPlayers(room);
  for (const p of connected) {
    if (room.votes[p.id]) continue;
    const others = connected.filter((x) => x.id !== p.id);
    if (others.length) room.votes[p.id] = pick(others).id;
  }
}

function submitGuess(room, text) {
  room.guessText = String(text || '').trim().slice(0, 40);
  const fake = room.players.get(room.caughtFakeId);
  if (normalize(room.guessText) === normalize(room.word)) {
    room.outcome = 'fake_guessed';
    if (fake) { fake.score += 2; fake.roundsWon += 1; }
  } else {
    room.outcome = 'fake_caught';
    room.players.forEach((p) => {
      if (!room.fakeIds.includes(p.id)) { p.score += 1; p.roundsWon += 1; }
    });
  }
  endRound(room);
}

// Moves to the reveal screen and decides whether the game is finished.
function endRound(room) {
  room.turnEndsAt = 0;
  room.voteEndsAt = 0;
  room.guessEndsAt = 0;
  room.phase = 'reveal';
  room.gameOver = room.roundNo >= room.gameRounds;
}

function artistsWin(room) {
  room.outcome = 'fake_caught';
  room.players.forEach((p) => {
    if (!room.fakeIds.includes(p.id)) { p.score += 1; p.roundsWon += 1; }
  });
  endRound(room);
}

/*
 * The guess phase is the one place a room can still deadlock: exactly one player
 * is allowed to act, so if their phone dies (or they just wander off) nobody can
 * move the game on. Treating a vanished Fake as a wrong guess keeps the round
 * moving. Returns true when it resolved something.
 */
function resolveGuessIfFakeGone(room) {
  if (room.phase !== 'guess') return false;
  const fake = room.caughtFakeId ? room.players.get(room.caughtFakeId) : null;
  if (fake && fake.connected) return false;
  artistsWin(room);
  return true;
}

// Ran out of time without guessing: same result as a wrong guess.
function expireGuess(room, now) {
  if (room.phase !== 'guess' || !room.guessEndsAt || now < room.guessEndsAt) return false;
  artistsWin(room);
  return true;
}

/* --------------------------------- messages -------------------------------- */

function stateFor(room, viewerId, tallied) {
  const you = room.players.get(viewerId);
  const inGame = room.phase !== 'lobby';
  const isFake = inGame && room.fakeIds.includes(viewerId);
  const showWord = inGame && (!isFake || room.phase === 'reveal');
  const revealFakes = room.phase === 'reveal';
  const showCaught = room.phase === 'guess' || room.phase === 'reveal';
  const showStrokes = room.phase === 'drawing' || room.phase === 'reveal';
  // During a turn only tiny ink deltas travel; the full drawing is (re)sent once
  // per generation and again for the reveal, so the reveal is always complete.
  // Re-sending every point of every line on every broadcast is what made big
  // doodles stutter and made the switch into voting spike.
  const strokesFull = showStrokes && (room.phase === 'reveal' || !you || you._strokeGen !== room.strokeGen);
  if (you && strokesFull) you._strokeGen = room.strokeGen;

  const fellowFakes = (isFake && room.settings.fakesKnowEachOther && !revealFakes)
    ? room.fakeIds.filter((x) => x !== viewerId)
    : [];

  return {
    type: 'state',
    now: Date.now(),
    code: room.code,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
      roundsWon: p.roundsWon, connected: p.connected, isHost: p.id === room.hostId,
    })),
    order: room.order,
    turnPlayerId: room.phase === 'drawing' ? (room.order[room.turnIndex] || null) : null,
    turnEndsAt: room.phase === 'drawing' ? room.turnEndsAt : 0,
    voteEndsAt: room.phase === 'voting' ? room.voteEndsAt : 0,
    guessEndsAt: room.phase === 'guess' ? room.guessEndsAt : 0,
    line: room.line,
    lines: room.lines,
    roundNo: room.roundNo,
    gameRounds: room.gameRounds,
    gameOver: room.gameOver,
    // Strokes are big; they are only sent while they are on screen.
    strokes: strokesFull ? room.strokes : [],
    strokesFull,
    votes: room.votes,
    category: room.category,
    word: showWord ? room.word : null,
    fakeIds: revealFakes ? room.fakeIds : [],
    caughtFakeId: showCaught ? room.caughtFakeId : null,
    outcome: room.outcome,
    guessText: room.guessText,
    tally: tallied || tally(room),
    settings: room.settings,
    categories: Object.keys(CATEGORIES),
    you: {
      id: viewerId,
      isFake,
      isHost: !!(you && you.isHost),
      color: you ? you.color : null,
      votedFor: room.votes[viewerId] || null,
      fellowFakes,
    },
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    maxRounds: MAX_ROUNDS,
    maxLines: MAX_LINES,
    connectedCount: connectedCount(room),
    maxFakes: maxFakesFor(Math.max(MIN_PLAYERS, connectedCount(room))),
  };
}

function sendJSON(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  // A socket can die between the readyState check and the write. Never let one
  // dead phone take the whole party (or the server) down with it.
  try { ws.send(JSON.stringify(obj)); } catch (err) { console.error('send error:', err && err.message); }
}

// Global safety net: a party game must never fall over mid-round. Anything that
// slips past the per-handler guards gets logged instead of killing the process.
process.on('uncaughtException', (err) => { console.error('uncaught exception:', err); });
process.on('unhandledRejection', (err) => { console.error('unhandled rejection:', err); });

/*
 * Broadcasts are coalesced: a burst of events (several strokes or votes in the
 * same tick) results in a single state message instead of many. This is what
 * keeps phones from stuttering during drawing and voting.
 */
function broadcast(room) {
  room.lastActive = Date.now();
  if (room._bcast) return;
  room._bcast = setTimeout(() => {
    room._bcast = null;
    try {
      if (!rooms.has(room.code)) return; // room was disbanded in the meantime
      const t = tally(room);
      for (const p of room.players.values()) {
        if (p.connected && p.socket) sendJSON(p.socket, stateFor(room, p.id, t));
      }
    } catch (err) { console.error('broadcast error:', err); }
  }, 40);
}

/* -------------------------------- websockets ------------------------------- */

const server = http.createServer(handleHttp);
// Cap the frame size: a runaway client (or a flaky mobile link) can no longer
// send one enormous frame that makes the server choke.
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
server.on('error', (err) => { console.error('server error:', err && err.message); });

wss.on('connection', (ws) => {
  ws.meta = { roomCode: null, playerId: null };
  // Flood guard: a stuck or looping client must never be able to pin the
  // event loop, which is what makes every room in the app freeze at once.
  let windowStart = Date.now(), windowCount = 0;

  ws.on('message', (data) => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; windowCount = 0; }
    if (++windowCount > 400) { if (windowCount === 401) console.warn('flood guard: dropping messages from a socket'); return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handleMessage(ws, msg); } catch (err) { console.error('message error', err); }
  });

  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

function roomOf(ws) {
  const meta = ws.meta || {};
  const room = rooms.get(meta.roomCode);
  if (!room) return null;
  const player = room.players.get(meta.playerId);
  if (!player || player.socket !== ws) return null;
  return room;
}

const isHostOf = (room, ws) => room && room.hostId === ws.meta.playerId;

function sanitizeSettings(patch, room) {
  const s = room.settings;
  if (!patch || typeof patch !== 'object') return;
  if (typeof patch.category === 'string') {
    s.category = (patch.category === 'random' || CATEGORIES[patch.category]) ? patch.category : s.category;
  }
  if (patch.rounds !== undefined) s.rounds = clampInt(patch.rounds, 1, MAX_ROUNDS, s.rounds);
  if (patch.lines !== undefined) s.lines = clampInt(patch.lines, 1, MAX_LINES, s.lines);
  if (patch.fakes !== undefined) s.fakes = clampInt(patch.fakes, 1, 2, s.fakes);
  if (patch.turnTime !== undefined) {
    const t = parseInt(patch.turnTime, 10) || 0;
    s.turnTime = [0, 20, 30, 45, 60, 90, 120].includes(t) ? t : (t > 0 ? Math.min(300, t) : 0);
  }
  if (patch.voteTime !== undefined) {
    const t = parseInt(patch.voteTime, 10) || 0;
    s.voteTime = [0, 20, 30, 45, 60].includes(t) ? t : (t > 0 ? Math.min(180, t) : 0);
  }
  if (typeof patch.fakesKnowEachOther === 'boolean') s.fakesKnowEachOther = patch.fakesKnowEachOther;
  if (typeof patch.shuffleFakes === 'boolean') s.shuffleFakes = patch.shuffleFakes;
  if (typeof patch.rotateCategory === 'boolean') s.rotateCategory = patch.rotateCategory;
  if (patch.customWords !== undefined) s.customWords = cleanWords(patch.customWords);
  if (typeof patch.customHint === 'string') s.customHint = patch.customHint.replace(/[<>]/g, '').trim().slice(0, 30);
  // Note: the number of fakes is the host's *desire* (1-2). It is clamped against
  // the real player count only when a round actually starts, so settings can be
  // configured on the create screen before everyone has joined.
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': return onCreate(ws, msg);
    case 'join': return onJoin(ws, msg);
    case 'settings': return onSettings(ws, msg);
    case 'start': return onStart(ws, msg);
    case 'stroke': return onStroke(ws, msg);
    case 'endTurn': return onEndTurn(ws);
    case 'vote': return onVote(ws, msg);
    case 'guess': return onGuess(ws, msg);
    case 'reaction': return onReaction(ws, msg);
    case 'nextRound': return onNextRound(ws);
    case 'playAgain': return onPlayAgain(ws);
    case 'toLobby': return onToLobby(ws);
    case 'resetScores': return onResetScores(ws);
    case 'kick': return onKick(ws, msg);
    case 'leave': return onLeave(ws);
    case 'disband': return onDisband(ws);
    default: return;
  }
}

function onCreate(ws, msg) {
  const room = createRoom();
  const id = String(msg.playerId || '').slice(0, 64) || makeCode(8);
  sanitizeSettings(msg.settings, room);
  addPlayer(room, id, msg.name);
  ws.meta = { roomCode: room.code, playerId: id };
  room.players.get(id).socket = ws;
  sendJSON(ws, { type: 'joined', playerId: id, code: room.code });
  broadcast(room);
}

function onJoin(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase().trim());
  if (!room) return sendJSON(ws, { type: 'error', message: 'Room not found. Check the code.' });

  const id = String(msg.playerId || '').slice(0, 64) || makeCode(8);
  if (room.banned.has(id)) return sendJSON(ws, { type: 'error', message: 'You were removed from that room.' });

  const existing = room.players.get(id);
  if (existing) {
    existing.connected = true;
    existing.socket = ws;
    existing._strokeGen = undefined;   // force a full drawing snapshot on reconnect
    if (msg.name) existing.name = cleanName(msg.name);
  } else {
    if (room.phase !== 'lobby') return sendJSON(ws, { type: 'error', message: 'That game is already in progress.' });
    if (room.players.size >= MAX_PLAYERS) return sendJSON(ws, { type: 'error', message: 'That room is full.' });
    const p = addPlayer(room, id, msg.name);
    p.socket = ws;
  }

  ws.meta = { roomCode: room.code, playerId: id };
  sendJSON(ws, { type: 'joined', playerId: id, code: room.code });
  broadcast(room);
}

// Host can change settings in the lobby and between rounds (on the reveal screen).
function onSettings(ws, msg) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  if (room.phase !== 'lobby' && room.phase !== 'reveal') return;
  sanitizeSettings(msg.settings, room);
  broadcast(room);
}

function onStart(ws, msg) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  if (room.phase !== 'lobby' && room.phase !== 'reveal') return;
  if (msg && msg.settings) sanitizeSettings(msg.settings, room);
  // A fresh game: scores persist unless the host explicitly resets them.
  const res = startRound(room, { newGame: true });
  if (res.error) return sendJSON(ws, { type: 'error', message: res.error });
  broadcast(room);
}

// Points closer together than this are invisible on screen but still cost
// payload and render time, so they never reach the room.
const MIN_PT_DIST = 0.0035;

// Only the new points travel during a turn. Re-sending the whole drawing on
// every broadcast is what made long doodles stutter and made the switch into
// voting spike.
function sendInk(room, i, stroke, points) {
  const msg = { type: 'ink', i, playerId: stroke.playerId, color: stroke.color, points, inProgress: true };
  for (const p of room.players.values()) {
    if (p.connected && p.socket) sendJSON(p.socket, msg);
  }
}

function sendInkDone(room, i) {
  const msg = { type: 'ink', i, done: true };
  for (const p of room.players.values()) {
    if (p.connected && p.socket) sendJSON(p.socket, msg);
  }
}

function onStroke(ws, msg) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'drawing') return;
  const pid = ws.meta.playerId;
  if (room.order[room.turnIndex] !== pid) return;

  const drawer = room.players.get(pid);
  if (!drawer) return;
  let cur = room.strokes[room.strokes.length - 1];
  if (!cur || !cur.inProgress || cur.playerId !== pid) {
    if (room.strokes.length >= 200) return;  // hard ceiling on room memory
    cur = { playerId: pid, color: drawer.color, points: [], inProgress: true };
    room.strokes.push(cur);
  }
  const idx = room.strokes.length - 1;
  const pts = Array.isArray(msg.points) ? msg.points.slice(0, 400) : [];
  const added = [];
  for (const pt of pts) {
    if (cur.points.length >= 4000) break;    // per-stroke ceiling
    if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') continue;
    const x = clamp01(pt.x), y = clamp01(pt.y);
    const last = cur.points[cur.points.length - 1];
    if (last && Math.abs(x - last.x) < MIN_PT_DIST && Math.abs(y - last.y) < MIN_PT_DIST) continue;
    const p = { x, y };
    cur.points.push(p);
    added.push(p);
  }
  if (added.length) sendInk(room, idx, cur, added);
}

function onEndTurn(ws) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'drawing') return;
  if (room.order[room.turnIndex] !== ws.meta.playerId) return;
  finishTurn(room);
  broadcast(room);
}

function onVote(ws, msg) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'voting') return;
  const pid = ws.meta.playerId;
  const target = String(msg.targetId || '');
  if (!room.players.has(target) || target === pid) return;
  if (room.votes[pid] === target) return;   // nothing changed — no need to churn
  room.votes[pid] = target;
  if (Object.keys(room.votes).length >= connectedCount(room)) resolveVotes(room);
  broadcast(room);
}

function onGuess(ws, msg) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'guess') return;
  if (ws.meta.playerId !== room.caughtFakeId) return;
  submitGuess(room, msg.text);
  broadcast(room);
}

let reactionSeq = 0;

function onReaction(ws, msg) {
  const room = roomOf(ws);
  if (!room) return;
  const pid = ws.meta.playerId;
  const emoji = String(msg.emoji || '');
  if (!REACTIONS.includes(emoji)) return;

  const now = Date.now();
  if (room.lastReaction[pid] && now - room.lastReaction[pid] < REACTION_COOLDOWN) return;
  room.lastReaction[pid] = now;

  const p = room.players.get(pid);
  const payload = {
    type: 'reaction',
    id: 'r' + (++reactionSeq),
    emoji,
    name: p ? p.name : '',
    color: p ? p.color : '#ffffff',
    playerId: pid,
  };
  for (const pl of room.players.values()) {
    if (pl.connected && pl.socket) sendJSON(pl.socket, payload);
  }
}

// Next round of the same game (new word, new category, new fakes by default).
function onNextRound(ws) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'reveal' || !isHostOf(room, ws)) return;
  if (room.gameOver) return;
  const res = startRound(room, {});
  if (res.error) return sendJSON(ws, { type: 'error', message: res.error });
  broadcast(room);
}

// New game after the last round, keeping the running scores.
function onPlayAgain(ws) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'reveal' || !isHostOf(room, ws)) return;
  if (!room.gameOver) return;
  const res = startRound(room, { newGame: true });
  if (res.error) return sendJSON(ws, { type: 'error', message: res.error });
  broadcast(room);
}

function onToLobby(ws) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  room.phase = 'lobby';
  room.strokes = [];
  room.strokeGen = (room.strokeGen || 0) + 1;
  room.votes = {};
  room.outcome = null;
  room.guessText = null;
  room.fakeIds = [];
  room.caughtFakeId = null;
  room.turnEndsAt = 0;
  room.voteEndsAt = 0;
  room.guessEndsAt = 0;
  room.roundNo = 0;
  room.gameOver = false;
  room.word = null;
  room.category = null;
  room.wordHistory = [];
  broadcast(room);
}

function onResetScores(ws) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  if (room.phase !== 'lobby' && room.phase !== 'reveal') return;
  room.players.forEach((p) => { p.score = 0; p.roundsWon = 0; });
  broadcast(room);
}

function onKick(ws, msg) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  const target = String(msg.playerId || '');
  if (!target || target === room.hostId) return;
  const player = room.players.get(target);
  if (!player) return;
  room.banned.add(target);
  sendJSON(player.socket, { type: 'kicked', message: 'The host removed you from the room.' });
  if (player.socket) { try { player.socket.meta = { roomCode: null, playerId: null }; } catch {} }
  removePlayer(room, target);
  if (room.phase === 'drawing') ensureActiveTurn(room);
  resolveGuessIfFakeGone(room);
  broadcast(room);
}

function onLeave(ws) {
  const room = roomOf(ws);
  if (!room) return;
  const pid = ws.meta.playerId;
  const p = room.players.get(pid);
  if (p) p.connected = false;
  removePlayer(room, pid);
  ws.meta = { roomCode: null, playerId: null };
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  ensureActiveTurn(room);
  if (room.phase === 'voting' && Object.keys(room.votes).length >= connectedCount(room)) resolveVotes(room);
  resolveGuessIfFakeGone(room);
  broadcast(room);
}

function onDisband(ws) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  for (const p of room.players.values()) {
    if (p.socket) sendJSON(p.socket, { type: 'closed', message: 'The host closed the room.' });
  }
  if (room._bcast) { clearTimeout(room._bcast); room._bcast = null; }
  rooms.delete(room.code);
}

function handleClose(ws) {
  const meta = ws.meta || {};
  const room = rooms.get(meta.roomCode);
  if (!room) return;
  const player = room.players.get(meta.playerId);
  if (!player || player.socket !== ws) return;

  player.connected = false;
  player.socket = null;

  if (room.phase === 'lobby') {
    removePlayer(room, player.id);
  } else {
    ensureActiveTurn(room);
    armTurn(room);
    if (room.phase === 'voting' && Object.keys(room.votes).length >= connectedCount(room)) resolveVotes(room);
  }
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  resolveGuessIfFakeGone(room);
  broadcast(room);
}

/* ------------------------------ static server ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function handleHttp(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  if (urlPath === '/health') { res.writeHead(200); res.end('ok'); return; }

  // "/" and any directory resolve to their index.html, so every game lives at
  // its own clean URL (e.g. /games/fake-artist/).
  let rel = path.normalize(urlPath).replace(/^([/\\])+/, '');
  if (rel === '' || rel.endsWith(path.sep) || rel.endsWith('/')) rel = path.join(rel, 'index.html');

  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'EISDIR') {
        res.writeHead(301, { Location: urlPath.replace(/\/?$/, '/') });
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* -------------------------- timers + room cleanup -------------------------- */

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    try {
      if (room.phase === 'drawing' && room.turnEndsAt && now >= room.turnEndsAt) {
        finishTurn(room);
        broadcast(room);
      } else if (room.phase === 'voting' && room.voteEndsAt && now >= room.voteEndsAt) {
        autoVote(room);
        resolveVotes(room);
        broadcast(room);
      }
      // Backstop for a Fake who is still "connected" but has stopped responding,
      // plus the timed-out guess.
      if (expireGuess(room, now) || resolveGuessIfFakeGone(room)) {
        broadcast(room);
      }
    } catch (err) { console.error('tick error:', err); }
  }
}, 250);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const alive = [...room.players.values()].some((p) => p.connected);
    if (!alive && now - room.lastActive > 30 * 60 * 1000) {
      if (room._bcast) clearTimeout(room._bcast);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n  🎮 Pixel Games running on http://localhost:${PORT}`);
  console.log(`     🎭 Fake Artist: http://localhost:${PORT}/games/fake-artist/\n`);
});
