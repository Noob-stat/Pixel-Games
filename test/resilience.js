'use strict';
/*
 * Resilience tests.
 *
 * These exist because a party game that dies mid-vote is worse than one that
 * is merely slow: everyone is staring at a frozen screen and nobody can play.
 * The server must therefore survive hostile input, and a room must never be
 * able to soft-lock itself. Both are covered here.
 */
const WebSocket = require('ws');
const http = require('http');
const URL = process.env.URL || 'ws://localhost:3000';
const HTTP = URL.replace(/^ws/, 'http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

function client(name) {
  const id = 'p-' + name.toLowerCase() + '-' + Math.floor(Math.random() * 1e6);
  const ws = new WebSocket(URL);
  const c = { name, id, ws, state: null };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'state') c.state = m;
  });
  ws.on('error', () => {});
  c.send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
  c.open = new Promise((res) => ws.on('open', res));
  c.close = () => { try { ws.close(); } catch {} };
  return c;
}

function get(pathname) {
  return new Promise((res, rej) => {
    const req = http.get(HTTP + pathname, (r) => {
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.on('error', rej);
    req.setTimeout(4000, () => req.destroy(new Error('http timeout')));
  });
}

async function healthOk() {
  const r = await get('/health');
  return r.status === 200 && r.body === 'ok';
}

async function waitFor(fn, timeout = 8000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(30); }
  throw new Error('TIMEOUT waiting for ' + label);
}

/* --------------------- 1. malformed HTTP must not crash -------------------- */
async function testBadUrl() {
  const r = await get('/%E0%A4%A');           // invalid percent-encoding
  assert(r.status === 400, 'malformed URL should be rejected with 400, got ' + r.status);
  assert(await healthOk(), 'server must still be alive after a malformed URL');
  process.stdout.write('  ✅ Malformed URL: rejected with 400 and the server stayed up ✅\n');
}

/* ----------------- 2. garbage / flooding socket must not crash ------------- */
async function testHostileSocket() {
  const ws = new WebSocket(URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('error', () => {});

  for (let i = 0; i < 600; i++) { try { ws.send('not json at all ' + i); } catch {} }
  for (let i = 0; i < 600; i++) { try { ws.send(JSON.stringify({ type: 'nope', x: i })); } catch {} }
  // A frame far bigger than the server's 256 KB cap.
  try { ws.send(JSON.stringify({ type: 'stroke', points: new Array(20000).fill({ x: 1, y: 1 }) })); } catch {}

  await sleep(500);
  assert(await healthOk(), 'server must survive a flooding / malformed socket');
  try { ws.close(); } catch {}
  await sleep(100);
  assert(await healthOk(), 'server must still serve health checks afterwards');
  process.stdout.write('  ✅ Hostile socket: floods + garbage rejected, server stayed up ✅\n');
}

/* ------------- 3. caught Fake drops mid-guess → no frozen room ------------ */
async function testGuessPhaseDisconnect() {
  const A = client('Rsz1'), B = client('Rsz2'), C = client('Rsz3');
  const cs = [A, B, C];
  await Promise.all(cs.map((c) => c.open));

  A.send({ type: 'create', name: A.name, playerId: A.id, settings: {} });
  await waitFor(() => A.state, 5000, 'lobby');
  const code = A.state.code;
  [B, C].forEach((c) => c.send({ type: 'join', code, name: c.name, playerId: c.id }));
  await waitFor(() => A.state.players.length === 3, 5000, 'all players');

  A.send({ type: 'start' });
  await waitFor(() => A.state.phase === 'drawing', 5000, 'drawing');

  // every player draws their line
  let guard = 0;
  while (A.state.phase === 'drawing' && guard++ < 400) {
    const turnId = A.state.turnPlayerId;
    const actor = cs.find((c) => c.id === turnId);
    if (!actor) { await sleep(30); continue; }
    actor.send({ type: 'stroke', points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }] });
    await sleep(10);
    actor.send({ type: 'endTurn' });
    await waitFor(() => A.state.turnPlayerId !== turnId || A.state.phase !== 'drawing', 4000, 'turn advance');
    await sleep(20);
  }
  await waitFor(() => A.state.phase === 'voting', 6000, 'voting');

  // everyone points at the Fake so the vote definitely lands on them
  const fake = cs.find((c) => c.state && c.state.you.isFake);
  assert(fake, 'exactly one player should be the Fake');
  for (const c of cs) {
    const target = c.id === fake.id ? cs.find((x) => x.id !== c.id).id : fake.id;
    c.send({ type: 'vote', targetId: target });
  }
  await waitFor(() => A.state.phase === 'guess', 6000, 'guess phase');
  assert(A.state.caughtFakeId === fake.id, 'the caught player should be the Fake');

  const before = {};
  A.state.players.forEach((p) => { before[p.id] = p.score; });

  // the caught Fake's phone dies before they can guess. Previously the whole
  // room sat on "the Fake gets one guess" forever.
  fake.close();

  await waitFor(() => A.state.phase === 'reveal', 6000, 'reveal after the Fake dropped');
  assert(A.state.outcome === 'fake_caught', 'outcome should be fake_caught, got ' + A.state.outcome);
  const artists = A.state.players.filter((p) => !(A.state.fakeIds || []).includes(p.id));
  assert(artists.length === 2, 'expected 2 artists, got ' + artists.length);
  assert(artists.every((p) => p.score === before[p.id] + 1), 'artists should each score +1 when the Fake vanishes');
  assert(await healthOk(), 'server must still be alive after the guess-phase drop');

  cs.forEach((c) => c.close());
  process.stdout.write('  ✅ Guess-phase drop: room resolved itself instead of freezing ✅\n');
}

(async () => {
  const only = process.argv[2];
  const tests = [
    ['Malformed URL', testBadUrl],
    ['Hostile socket', testHostileSocket],
    ['Guess-phase disconnect', testGuessPhaseDisconnect],
  ];
  for (const [name, fn] of tests) {
    if (only && !name.toLowerCase().includes(only.toLowerCase())) continue;
    await fn();
  }
  process.stdout.write('\n  ✅ Resilience: the server survives hostile input and the game cannot freeze ✅\n\n');
  process.exit(0);
})().catch((e) => { console.error('\n  ❌ Resilience: ' + e.message + '\n'); process.exit(1); });
