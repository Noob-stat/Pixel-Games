'use strict';
/* Headless playtest: drives 3 clients through a full round. */
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:3000';
const log = (...a) => console.log('[test]', ...a);

const names = ['Alice', 'Bob', 'Cara'];
const clients = names.map((name, i) => {
  const id = 'id-' + i;
  const ws = new WebSocket(URL);
  const c = { name, id, ws, state: null };
  ws.on('open', () => {
    if (i === 0) ws.send(JSON.stringify({ type: 'create', name, playerId: id }));
    tick();
  });
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === 'state') { c.state = m; tick(); }
    if (m.type === 'error') log('ERROR', name, m.message);
  });
  ws.on('error', (e) => log('WS ERROR', name, e.message));
  return c;
});

let created = true, joined = false, started = false, guessed = false, finished = false;
let privacyOk = true;
const turnKeys = new Set();
const voted = new Set();

let lastLogged = '';
function tick() {
  const [A, B, C] = clients;
  if (!A.state) return;
  const code = A.state.code;
  const sig = `${A.state.phase}|${A.state.players.length}|${A.state.turnPlayerId}|R${A.state.roundNo}L${A.state.line}`;
  if (sig !== lastLogged) { lastLogged = sig; log('state:', sig, 'words?', A.state.word, 'fake?', A.state.you && A.state.you.isFake); }

  if (!created) { created = true; A.ws.send(JSON.stringify({ type: 'create', name: A.name, playerId: A.id })); return; }

  if (!joined && code) {
    if (B.ws.readyState !== 1 || C.ws.readyState !== 1) return;
    joined = true;
    B.ws.send(JSON.stringify({ type: 'join', code, name: B.name, playerId: B.id }));
    C.ws.send(JSON.stringify({ type: 'join', code, name: C.name, playerId: C.id }));
    return;
  }

  const s = A.state;

  if (s.phase === 'lobby') {
    if (!started && s.players.length === 3 && s.connectedCount === 3) {
      started = true;
      A.ws.send(JSON.stringify({ type: 'start', totalRounds: 2 }));
    }
    return;
  }

  if (s.phase === 'drawing') {
    for (const c of clients) {
      if (c.state && c.state.phase === 'drawing') {
        if (c.state.you.isFake && c.state.word !== null) { privacyOk = false; log('LEAK ❌ fake', c.name, 'received word', c.state.word); }
        if (!c.state.you.isFake && !c.state.word) { privacyOk = false; log('MISS ❌ artist', c.name, 'has no word'); }
      }
    }
    const key = s.line + ':' + s.turnPlayerId;
    if (!turnKeys.has(key)) {
      turnKeys.add(key);
      const c = clients.find((x) => x.id === s.turnPlayerId);
      if (c) {
        c.ws.send(JSON.stringify({ type: 'stroke', points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }, { x: 0.5, y: 0.2 }] }));
        setTimeout(() => c.ws.send(JSON.stringify({ type: 'endTurn' })), 25);
      }
    }
    return;
  }

  if (s.phase === 'voting') {
    for (const c of clients) {
      if (c.state && c.state.you && !c.state.you.votedFor && !voted.has(c.id)) {
        voted.add(c.id);
        const target = c.state.players.find((p) => p.id !== c.id);
        if (target) c.ws.send(JSON.stringify({ type: 'vote', targetId: target.id }));
      }
    }
    return;
  }

  if (s.phase === 'guess') {
    if (!guessed) {
      guessed = true;
      const fake = clients.find((c) => c.state && c.state.you && c.state.you.isFake);
      if (fake) fake.ws.send(JSON.stringify({ type: 'guess', text: 'definitelywrong' }));
      else log('WARN: no fake found among clients');
    }
    return;
  }

  if (s.phase === 'reveal' && !finished) {
    finished = true;
    const strokesPerPlayer = 2;
    log('outcome =', s.outcome);
    log('word =', s.word, '| fakeIds =', s.fakeIds);
    log('scores =', s.players.map((p) => `${p.name}:${p.score}`).join(', '));
    log('strokes =', s.strokes.length, '(expected', 3 * strokesPerPlayer + ')');
    const okay = !!s.outcome && s.strokes.length === 3 * strokesPerPlayer && privacyOk;
    log('privacy check =', privacyOk ? 'PASS ✅ (fake never saw the word)' : 'FAIL ❌');
    log(okay ? 'PASS ✅' : 'FAIL ❌');
    process.exit(okay ? 0 : 1);
  }
}

setTimeout(() => { log('TIMEOUT ❌'); process.exit(1); }, 15000);
