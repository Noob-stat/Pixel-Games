'use strict';
/* Feature tests for Fake Artist: timers, custom words, 2 fakes, rounds, moderation, reactions. */
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

function client(name) {
  const id = 'p-' + name.toLowerCase() + '-' + Math.floor(Math.random() * 1e6);
  const ws = new WebSocket(URL);
  const c = { name, id, ws, state: null, got: [], errors: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    c.got.push(m.type);
    if (m.type === 'state') c.state = m;
    if (m.type === 'error') c.errors.push(m.message);
    if (m.type === 'kicked') c.kicked = m.message;
    if (m.type === 'closed') c.closed = m.message;
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.open = new Promise((res) => ws.on('open', res));
  c.close = () => ws.close();
  return c;
}

async function waitFor(fn, timeout = 8000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(30); }
  throw new Error('TIMEOUT waiting for ' + label);
}

async function makeRoom(host, others, settings) {
  await Promise.all([host, ...others].map((c) => c.open));
  host.send({ type: 'create', name: host.name, playerId: host.id, settings: settings || {} });
  await waitFor(() => host.state, 5000, 'lobby');
  const code = host.state.code;
  others.forEach((c) => c.send({ type: 'join', code, name: c.name, playerId: c.id }));
  await waitFor(() => host.state && host.state.players.length === 1 + others.length, 5000, 'all players');
  await sleep(80);
  return code;
}

/* Draws every turn of the current round, votes, guesses if needed → reveal. */
async function playOneRound(cs) {
  const host = cs[0];
  let guard = 0;
  while (host.state.phase === 'drawing' && guard++ < 400) {
    const turnId = host.state.turnPlayerId;
    const actor = cs.find((c) => c.id === turnId);
    if (!actor) { await sleep(30); continue; }
    actor.send({ type: 'stroke', points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }] });
    await sleep(10);
    actor.send({ type: 'endTurn' });
    await waitFor(() => host.state.turnPlayerId !== turnId || host.state.phase !== 'drawing', 4000, 'turn advance');
    await sleep(20);
  }
  await waitFor(() => ['voting', 'guess', 'reveal'].includes(host.state.phase), 5000, 'post-draw phase');

  if (host.state.phase === 'voting') {
    const first = host.state.players[0];
    for (const c of cs) {
      if (!c.state || c.state.you.votedFor) continue;
      const target = c.state.players.find((p) => p.id !== c.id);
      if (target) c.send({ type: 'vote', targetId: target.id });
    }
    await waitFor(() => host.state.phase !== 'voting', 6000, 'votes resolved');
  }
  if (host.state.phase === 'guess') {
    const caught = host.state.caughtFakeId;
    const c = cs.find((x) => x.id === caught);
    if (c) c.send({ type: 'guess', text: 'definitelynotaword' });
    await waitFor(() => host.state.phase === 'reveal', 6000, 'reveal after guess');
  }
  await waitFor(() => host.state.phase === 'reveal', 6000, 'reveal');
}

/* ------------------------------- test timer ------------------------------- */
async function testTimer() {
  const A = client('Tim1'), B = client('Tim2'), C = client('Tim3');
  await makeRoom(A, [B, C], { lines: 1, rounds: 1, turnTime: 1 });
  A.send({ type: 'start' });
  await waitFor(() => A.state && A.state.phase === 'drawing', 5000, 'drawing');
  assert(A.state.turnEndsAt > 0, 'turn timer armed (turnEndsAt set)');
  assert(A.state.roundNo === 1 && A.state.gameRounds === 1, 'round 1 of 1');
  await waitFor(() => A.state && A.state.phase === 'voting', 20000, 'timer auto-advances to voting');
  [A, B, C].forEach((c) => { c.send({ type: 'disband' }); c.close(); });
  return 'turn timer auto-advanced every turn ✅';
}

/* ------------------------ custom words + 2 fakes + rematch ---------------- */
async function testCustomFakesRematch() {
  const cs = ['Ada', 'Ben', 'Cy', 'Dee'].map(client);
  const [host] = cs;
  await makeRoom(host, cs.slice(1), {
    lines: 1, rounds: 2, fakes: 2, category: 'random',
    customWords: 'apple\nbanana\ncherry', customHint: 'fruit',
  });

  assert(host.state.settings.customWords.length === 3, 'custom words stored (3)');
  assert(host.state.settings.fakes === 2, 'settings say 2 fakes');
  assert(host.state.maxFakes === 2, 'server allows 2 fakes at 4 players');

  host.send({ type: 'start' });
  await waitFor(() => host.state && host.state.phase === 'drawing', 5000, 'drawing');

  assert(host.state.fakeIds.length === 0, 'fake identities hidden while drawing');
  const fakes = cs.filter((c) => c.state.you.isFake);
  assert(fakes.length === 2, `exactly 2 fakes (got ${fakes.length})`);
  const artist = cs.find((c) => !c.state.you.isFake);
  assert(['apple', 'banana', 'cherry'].includes(artist.state.word), `custom word used (got ${artist.state.word})`);
  assert(host.state.category === 'fruit', `custom hint becomes the category (got ${host.state.category})`);
  for (const c of cs) {
    if (c.state.you.isFake) assert(c.state.word === null, `${c.name} (fake) must NOT receive the word`);
    else assert(!!c.state.word, `${c.name} (artist) must receive the word`);
  }

  // drive one turn each (lines: 1 → 4 strokes total)
  for (let i = 0; i < 4; i++) {
    const turnId = host.state.turnPlayerId;
    const actor = cs.find((c) => c.id === turnId);
    actor.send({ type: 'stroke', points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }] });
    await sleep(20);
    actor.send({ type: 'endTurn' });
    await waitFor(() => host.state.turnPlayerId !== turnId || host.state.phase !== 'drawing', 4000, 'turn advance');
    await sleep(30);
  }
  assert(host.state.phase === 'voting', 'reached voting');

  // everyone votes for fakes[0] (fakes[0] votes for fakes[1])
  for (const c of cs) {
    const target = (c.id === fakes[0].id) ? fakes[1].id : fakes[0].id;
    c.send({ type: 'vote', targetId: target });
  }
  await waitFor(() => host.state.phase === 'guess', 5000, 'plurality fake caught → guess');
  assert(host.state.caughtFakeId === fakes[0].id, 'the caught player is a fake');

  fakes[0].send({ type: 'guess', text: 'definitelynotaword' });
  await waitFor(() => host.state.phase === 'reveal', 5000, 'reveal');
  assert(host.state.outcome === 'fake_caught', `outcome fake_caught (got ${host.state.outcome})`);
  assert(host.state.fakeIds.length === 2, 'both fakes revealed at the end');
  assert(host.state.strokes.length === 4, `4 strokes available for the reveal (got ${host.state.strokes.length})`);
  const artists = cs.filter((c) => !c.state.you.isFake);
  for (const p of host.state.players) {
    const isArtist = !host.state.fakeIds.includes(p.id);
    if (isArtist) assert(p.score === 1, `artist ${p.name} scored 1 (got ${p.score})`);
    else assert(p.score === 0, `fake ${p.name} scored 0 (got ${p.score})`);
  }
  assert(host.state.gameOver === false, 'game is not over after round 1 of 2');

  // rematch keeps scores
  const before = host.state.roundNo;
  host.send({ type: 'nextRound' });
  await waitFor(() => host.state.roundNo === before + 1 && host.state.phase === 'drawing', 5000, 'next round');
  const stillScored = host.state.players.some((p) => p.score === 1);
  assert(stillScored, 'scores kept across rematch');

  cs.forEach((c) => { c.send({ type: 'disband' }); c.close(); });
  return 'custom words, 2 fakes, privacy, scoring + rematch-keeps-scores ✅';
}

/* ------------------------------ round system ------------------------------ */
async function testRoundSystem() {
  const cs = ['Rnd1', 'Rnd2', 'Rnd3'].map(client);
  const [host] = cs;
  await makeRoom(host, cs.slice(1), { lines: 1, rounds: 3, shuffleFakes: true, category: 'random' });

  assert(host.state.settings.rounds === 3, 'rounds setting stored');
  assert(host.state.settings.lines === 1, 'lines setting stored');

  host.send({ type: 'start' });
  await waitFor(() => host.state.phase === 'drawing', 5000, 'drawing r1');
  assert(host.state.roundNo === 1 && host.state.gameRounds === 3, 'round 1 of 3');

  const artist1 = cs.find((c) => !c.state.you.isFake);
  const word1 = artist1.state.word;
  const cat1 = artist1.state.category;
  assert(!!word1, 'round 1 has a word');

  await playOneRound(cs);
  assert(host.state.gameOver === false, 'not game over after round 1');
  assert(host.state.strokes.length > 0, 'reveal still carries the drawing');

  host.send({ type: 'nextRound' });
  await waitFor(() => host.state.roundNo === 2 && host.state.phase === 'drawing', 5000, 'round 2 drawing');
  const artist2 = cs.find((c) => !c.state.you.isFake);
  assert(!!artist2.state.word, 'round 2 has a word');
  assert(artist2.state.word !== word1, `round 2 uses a NEW word (${word1} → ${artist2.state.word})`);
  assert(host.state.fakeIds.length === 0, 'fakes hidden again in round 2');
  const fakes2 = cs.filter((c) => c.state.you.isFake);
  assert(fakes2.length === 1, 'exactly one fake in round 2');
  if (cat1) assert(typeof artist2.state.category === 'string', 'round 2 has a category');

  await playOneRound(cs);
  assert(host.state.roundNo === 2, 'still round 2');
  host.send({ type: 'nextRound' });
  await waitFor(() => host.state.roundNo === 3 && host.state.phase === 'drawing', 5000, 'round 3 drawing');

  await playOneRound(cs);
  assert(host.state.gameOver === true, 'game over after the last round');

  // nextRound must be ignored once the game is over
  host.send({ type: 'nextRound' });
  await sleep(250);
  assert(host.state.phase === 'reveal' && host.state.roundNo === 3, 'no extra round after the game ends');

  // play again → fresh game, round 1, scores kept
  const scoreBefore = host.state.players.reduce((n, p) => n + p.score, 0);
  host.send({ type: 'playAgain' });
  await waitFor(() => host.state.roundNo === 1 && host.state.phase === 'drawing', 5000, 'play again');
  assert(host.state.gameOver === false, 'new game is not over');
  assert(host.state.players.reduce((n, p) => n + p.score, 0) === scoreBefore, 'play again keeps scores');

  cs.forEach((c) => { c.send({ type: 'disband' }); c.close(); });
  return 'configurable rounds: new word + new fakes each round, game over + play again ✅';
}

/* --------------------------- kick / leave / disband ----------------------- */
async function testModeration() {
  const A = client('Mod1'), B = client('Mod2'), C = client('Mod3');
  const code = await makeRoom(A, [B, C], { lines: 1 });
  await sleep(200);

  A.send({ type: 'kick', playerId: B.id });
  await waitFor(() => B.kicked, 5000, 'kicked notice');
  await waitFor(() => A.state && A.state.players.length === 2, 5000, 'B removed');
  assert(!A.state.players.some((p) => p.id === B.id), 'kicked player gone from roster');

  B.send({ type: 'join', code, name: B.name, playerId: B.id });
  await waitFor(() => B.errors.length > 0, 5000, 'rejoin blocked');
  assert(/removed/i.test(B.errors[B.errors.length - 1]), 'rejoin rejected: ' + B.errors[B.errors.length - 1]);

  C.send({ type: 'leave' });
  await waitFor(() => A.state && A.state.players.length === 1, 5000, 'C left');

  B.close();
  A.send({ type: 'disband' });
  A.close();
  return 'kick (with rejoin block), leave, disband ✅';
}

/* ------------------------------- reactions -------------------------------- */
async function testReactions() {
  const A = client('R1'), B = client('R2'), C = client('R3');
  await makeRoom(A, [B, C], { lines: 1 });
  A.send({ type: 'start' });
  await waitFor(() => A.state && A.state.phase === 'drawing', 5000, 'drawing');

  const bReactions = [];
  B.got.length = 0;
  B.ws.removeAllListeners('message');
  B.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'state') B.state = m;
    if (m.type === 'reaction') bReactions.push(m);
  });

  A.send({ type: 'reaction', emoji: '🔥' });
  await waitFor(() => bReactions.length >= 1, 4000, 'reaction delivered');
  assert(bReactions[0].emoji === '🔥', 'emoji delivered');
  assert(bReactions[0].name === 'R1', 'sender name attached');

  A.send({ type: 'reaction', emoji: '😂' });
  await sleep(300);
  assert(bReactions.length === 1, `rate limit blocked a spam reaction (got ${bReactions.length})`);

  A.send({ type: 'reaction', emoji: 'not-an-emoji' });
  await sleep(700);
  assert(bReactions.length === 1, 'invalid emoji ignored');
  assert(bReactions[0].emoji === '🔥', 'only valid reactions delivered');

  [A, B, C].forEach((c) => { c.send({ type: 'disband' }); c.close(); });
  return 'emoji reactions delivered with rate-limit + validation ✅';
}

/* ------------------------------ vote timer -------------------------------- */
async function testVoteTimer() {
  const A = client('V1'), B = client('V2'), C = client('V3');
  await makeRoom(A, [B, C], { lines: 1, rounds: 2, turnTime: 0, voteTime: 1 });
  assert(A.state.settings.voteTime === 1, 'vote timer setting stored');
  A.send({ type: 'start' });
  await waitFor(() => A.state && A.state.phase === 'drawing', 5000, 'drawing');

  for (let i = 0; i < 3; i++) {
    const turnId = A.state.turnPlayerId;
    const actor = [A, B, C].find((c) => c.id === turnId);
    actor.send({ type: 'stroke', points: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.6 }] });
    await sleep(20);
    actor.send({ type: 'endTurn' });
    await waitFor(() => A.state.turnPlayerId !== turnId || A.state.phase !== 'drawing', 4000, 'turn advance');
    await sleep(30);
  }

  await waitFor(() => A.state.phase === 'voting', 5000, 'voting');
  assert(A.state.voteEndsAt > 0, 'vote timer armed');
  await waitFor(() => A.state.phase === 'guess' || A.state.phase === 'reveal', 8000, 'auto-resolved after vote timer');

  [A, B, C].forEach((c) => { c.send({ type: 'disband' }); c.close(); });
  return 'vote timer auto-fills missing votes and resolves ✅';
}

/* ---------------------------------- runner -------------------------------- */
(async () => {
  const results = [];
  const run = async (name, fn) => {
    try { const msg = await fn(); results.push(['PASS', name, msg]); }
    catch (e) { results.push(['FAIL', name, e.message]); }
  };

  await run('Turn timer', testTimer);
  await run('Custom words + 2 fakes + rematch', testCustomFakesRematch);
  await run('Round system', testRoundSystem);
  await run('Kick / leave / disband', testModeration);
  await run('Emoji reactions', testReactions);
  await run('Vote timer', testVoteTimer);

  console.log('');
  let failed = 0;
  for (const [status, name, msg] of results) {
    if (status === 'FAIL') failed++;
    console.log(`  ${status === 'PASS' ? '✅' : '❌'} ${name}: ${msg}`);
  }
  console.log('');
  process.exit(failed ? 1 : 0);
})();
