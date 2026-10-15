(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const CATEGORY_NAMES = ['Animals', 'Food', 'Places', 'Objects', 'Nature', 'Jobs', 'Movies'];
  const REACTIONS = ['😂', '😮', '🔥', '👀', '😭', '🤔', '👏', '💀', '🎉', '🫠', '😅', '🧐'];
  const GAME_URL = '/games/fake-artist/';

  // Only touch innerHTML when it actually changes, so CSS animations don't
  // restart on every incoming stroke update.
  function setHTML(el, html) {
    if (el.__last !== html) { el.__last = html; el.innerHTML = html; }
  }

  const initials = (name) => String(name || '?').trim().slice(0, 2).toUpperCase();
  const avatar = (p) => `<span class="avatar" style="background:${p.color}">${escapeHtml(initials(p.name))}</span>`;

  /* ------------------------------- identity -------------------------------- */
  let myId = sessionStorage.getItem('fa_id');
  if (!myId) {
    myId = (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now() + Math.random().toString(36).slice(2));
    sessionStorage.setItem('fa_id', myId);
  }
  let myName = localStorage.getItem('fa_name') || '';

  /* -------------------------------- state ---------------------------------- */
  let ws = null;
  let S = null;
  let clockOffset = 0;
  let prevPhase = null;
  let prevRoundNo = -1;
  let prevMyTurn = false;
  let prevLobbyIds = [];
  // Vote state: what the player tapped, plus a vote waiting for the socket to
  // come back. Deliberately tiny — no timers, no retries, no loops.
  let myVote = null;
  let queuedVote = null;

  const screens = {
    home: $('#scr-home'), lobby: $('#scr-lobby'), play: $('#scr-play'),
    vote: $('#scr-vote'), guess: $('#scr-guess'), reveal: $('#scr-reveal'),
  };

  function showScreen(key) {
    for (const k in screens) screens[k].classList.toggle('hidden', k !== key);
    $('#topbar').classList.toggle('hidden', key === 'home');
    const inGame = ['play', 'vote', 'guess', 'reveal'].includes(key);
    // The vote screen has no reaction bar: it must stay absolutely still, and a
    // fixed overlay + floating emoji is exactly the kind of thing that costs
    // frames on a weak device.
    const bar = inGame && key !== 'vote';
    $('#reactionBar').classList.toggle('hidden', !bar);
    document.body.classList.toggle('has-bar', bar);
  }

  const serverNow = () => Date.now() + clockOffset;

  /*
   * Coalesce state updates into a single paint per frame. When a burst of state
   * messages arrives (fast votes, stroke relays, a reconnect) we render once
   * instead of N times. This is the guard that keeps the voting screen smooth
   * even when every player taps at once.
   */
  let renderQueued = false;
  function scheduleRender() {
    // A hidden tab has nothing to paint and the browser throttles rAF to a stop,
    // so waiting for a frame there would let the client fall behind the game.
    // Render straight away instead; only a *visible* tab pays for coalescing.
    if (document.hidden) { render(); return; }
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  // Writing textContent/className with an unchanged value still invalidates
  // style on some browsers. Only touch the DOM when the value really changed.
  const setText = (el, txt) => { if (el.__t !== txt) { el.__t = txt; el.textContent = txt; } };
  const setClass = (el, cls) => { if (el.__c !== cls) { el.__c = cls; el.className = cls; } };

  /* --------------------------------- sound --------------------------------- */
  const Sound = (() => {
    let ctx = null;
    let enabled = localStorage.getItem('fa_sound') !== 'off';
    let volume = Math.max(0, Math.min(1, parseFloat(localStorage.getItem('fa_volume')) || 0.7));

    function ac() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; } }
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(freq, dur, type = 'sine', gain = 0.06, when = 0) {
      if (!enabled || volume <= 0) return;
      const c = ac(); if (!c) return;
      const t = c.currentTime + when;
      const g = c.createGain();
      const o = c.createOscillator();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.03);
    }
    function noise(dur, gain = 0.05, when = 0) {
      if (!enabled || volume <= 0) return;
      const c = ac(); if (!c) return;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
      const g = c.createGain(); g.gain.value = gain * volume;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(c.currentTime + when);
    }
    return {
      unlock() { ac(); },
      get enabled() { return enabled; },
      get volume() { return volume; },
      setEnabled(v) { enabled = v; localStorage.setItem('fa_sound', v ? 'on' : 'off'); if (v) tone(660, 0.09, 'triangle', 0.06); },
      toggle() { this.setEnabled(!enabled); return enabled; },
      setVolume(v) { volume = Math.max(0, Math.min(1, v)); localStorage.setItem('fa_volume', String(volume)); },
      tick() { tone(1250, 0.045, 'square', 0.045); },
      urgent() { tone(1600, 0.06, 'square', 0.08); },
      pop() { tone(520, 0.09, 'triangle', 0.06); tone(780, 0.09, 'triangle', 0.045, 0.07); },
      yourTurn() { tone(880, 0.12, 'sine', 0.07); tone(1318, 0.16, 'sine', 0.06, 0.1); },
      react() { tone(1050, 0.06, 'triangle', 0.05); tone(1400, 0.07, 'triangle', 0.04, 0.05); },
      join() { tone(600, 0.08, 'sine', 0.05); tone(900, 0.09, 'sine', 0.04, 0.06); },
      leave() { tone(500, 0.09, 'sine', 0.045); tone(340, 0.12, 'sine', 0.04, 0.07); },
      round() { [660, 880].forEach((f, i) => tone(f, 0.12, 'triangle', 0.06, i * 0.09)); },
      caught() { tone(180, 0.35, 'sawtooth', 0.07); tone(140, 0.4, 'sawtooth', 0.05, 0.08); },
      drumroll(dur = 1.4) {
        let t = 0, gap = 0.11;
        while (t < dur) { noise(0.055, 0.05, t); t += gap; gap *= 0.9; }
      },
      win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'triangle', 0.07, i * 0.09)); },
      lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.24, 'sawtooth', 0.05, i * 0.13)); },
    };
  })();

  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {} }

  /* ------------------------------ motion pref ------------------------------ */
  let reduceMotion = localStorage.getItem('fa_motion') === 'reduce';
  function applyMotion() { document.body.classList.toggle('reduce-motion', reduceMotion); }

  /* ------------------------------ websocket -------------------------------- */
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function setConnected(v) {
    $('#statusDot').classList.toggle('off', !v);
    $('#statusDot').title = v ? 'Connected' : 'Reconnecting…';
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      setConnected(true);
      const saved = sessionStorage.getItem('fa_room');
      if (saved && myName) send({ type: 'join', code: saved, name: myName, playerId: myId });
      if (queuedVote) { send(queuedVote); queuedVote = null; }
    };
    ws.onclose = () => { setConnected(false); setTimeout(connect, 1200); };

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'state': {
          // The drawing arrives as ink deltas; a full snapshot only comes when the
          // server says so. Keep the strokes we already have otherwise.
          if (!msg.strokesFull && S && S.strokes) msg.strokes = S.strokes;
          S = msg; clockOffset = (msg.now || Date.now()) - Date.now(); scheduleRender(); break;
        }
        case 'ink': applyInk(msg); break;
        case 'reaction': showFloater(msg); break;
        case 'joined':
          myId = msg.playerId;
          sessionStorage.setItem('fa_id', myId);
          sessionStorage.setItem('fa_room', msg.code);
          try { history.replaceState(null, '', GAME_URL + '?room=' + msg.code); } catch {}
          break;
        case 'error':
          if (S) toast(msg.message || 'Something went wrong.', true);
          else { $('#homeErr').textContent = msg.message || 'Something went wrong.'; sessionStorage.removeItem('fa_room'); }
          break;
        case 'kicked':
          sessionStorage.removeItem('fa_room'); S = null; prevPhase = null; goHome();
          toast(msg.message || 'You were removed.', true); break;
        case 'closed':
          sessionStorage.removeItem('fa_room'); S = null; prevPhase = null; goHome();
          toast(msg.message || 'The host closed the room.', true); break;
        default: break;
      }
    };
  }

  function goHome() { showScreen('home'); $('#homeErr').textContent = ''; }

  /* ------------------------------ settings form ---------------------------- */
  const opts = (list, sel) => list.map((v) => `<option value="${v}"${String(v) === String(sel) ? ' selected' : ''}>${v}</option>`).join('');

  function settingsFormHTML() {
    return `
      <label class="field">
        <span>Category</span>
        <select data-set="category">
          <option value="random">🎲 Random</option>
          ${CATEGORY_NAMES.map((c) => `<option value="${c}">${c}</option>`).join('')}
        </select>
      </label>

      <details class="adv" style="margin-bottom:10px">
        <summary>✍️ Custom words (optional)</summary>
        <label class="field">
          <span>Your words — comma or new line separated</span>
          <textarea data-set="customWords" rows="3" placeholder="pizza, your dog, the moon, homework"></textarea>
        </label>
        <label class="field">
          <span>Hint shown to the Fake (optional)</span>
          <input data-set="customHint" maxlength="30" placeholder="e.g. Things in our kitchen" />
        </label>
      </details>

      <div class="cols2">
        <label class="field"><span>Rounds</span>
          <select data-set="rounds">${opts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)}</select>
        </label>
        <label class="field"><span>Lines each / round</span>
          <select data-set="lines">${opts([1, 2, 3], 2)}</select>
        </label>
      </div>

      <div class="two">
        <label class="field"><span>Fakes</span>
          <select data-set="fakes"><option value="1">1 fake</option><option value="2">2 fakes</option></select>
        </label>
        <label class="field"><span>Turn timer</span>
          <select data-set="turnTime">
            <option value="0">Off</option><option value="20">20s</option><option value="30">30s</option>
            <option value="45">45s</option><option value="60">60s</option><option value="90">90s</option>
          </select>
        </label>
        <label class="field"><span>Vote timer</span>
          <select data-set="voteTime">
            <option value="0">Off</option><option value="30">30s</option>
            <option value="45">45s</option><option value="60">60s</option>
          </select>
        </label>
      </div>

      <label class="check"><input type="checkbox" data-set="shuffleFakes" /> New Fake every round</label>
      <label class="check"><input type="checkbox" data-set="rotateCategory" /> New random category every round</label>
      <label class="check"><input type="checkbox" data-set="fakesKnowEachOther" /> Fakes know each other</label>
    `;
  }

  const INT_FIELDS = ['rounds', 'lines', 'fakes', 'turnTime', 'voteTime'];

  function readSettings(root, out = {}) {
    root.querySelectorAll('[data-set]').forEach((el) => {
      const k = el.dataset.set;
      if (el.type === 'checkbox') out[k] = el.checked;
      else if (k === 'customWords') out[k] = el.value;
      else if (INT_FIELDS.includes(k)) out[k] = parseInt(el.value, 10);
      else out[k] = el.value;
    });
    return out;
  }

  function applySettings(root, s, force) {
    if (!s) return;
    if (!force && root.contains(document.activeElement) && document.activeElement.tagName !== 'SELECT') return;
    root.querySelectorAll('[data-set]').forEach((el) => {
      const k = el.dataset.set;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else if (k === 'customWords') el.value = (s.customWords || []).join('\n');
      else if (s[k] !== undefined && s[k] !== null) el.value = String(s[k]);
    });
  }

  function saveHomeSettings() {
    try { localStorage.setItem('fa_settings', JSON.stringify(readSettings($('#homeSettings')))); } catch {}
  }

  const summaryOf = (s) => {
    if (!s) return '';
    const bits = [`${s.rounds} round${s.rounds > 1 ? 's' : ''}`];
    bits.push(`${s.lines} line${s.lines > 1 ? 's' : ''} each`);
    bits.push(`${s.fakes} fake${s.fakes > 1 ? 's' : ''}${s.shuffleFakes ? ' (new each round)' : ''}`);
    bits.push(s.turnTime ? `${s.turnTime}s turns` : 'no turn timer');
    bits.push(s.voteTime ? `${s.voteTime}s votes` : 'no vote timer');
    if (s.customWords && s.customWords.length) bits.push(`${s.customWords.length} custom words`);
    else bits.push(s.category === 'random' || s.rotateCategory ? 'random category each round' : s.category);
    return bits.join(' · ');
  };

  /* -------------------------------- render --------------------------------- */
  function setRoundChip() {
    const chip = $('#roundChip');
    if (!S || S.phase === 'lobby') { chip.classList.add('hidden'); return; }
    chip.classList.remove('hidden');
    chip.textContent = `Round ${S.roundNo}/${S.gameRounds}`;
  }

  function render() {
    if (!S) { goHome(); return; }

    const phaseChanged = S.phase !== prevPhase;
    if (phaseChanged) {
      if (S.phase === 'drawing') Sound.pop();
      else if (S.phase === 'voting') { Sound.pop(); voteSig = ''; }
      else if (S.phase === 'guess') Sound.drumroll(1.4);
      else if (S.phase === 'reveal') {
      const good = S.outcome === 'fake_caught' || S.you.isFake;
      if (good) { Sound.win(); if (!reduceMotion) setTimeout(() => burstConfetti(26), 0); }
      else Sound.lose();
      }
    }
    // The vote screen keeps no state of its own beyond "did I tap?".
    if (S.phase !== 'voting') myVote = null;
    else if (S.you.votedFor) myVote = S.you.votedFor;

    if (S.roundNo !== prevRoundNo) {
      if (S.roundNo > prevRoundNo && prevRoundNo !== -1 && S.phase === 'drawing') Sound.round();
      prevRoundNo = S.roundNo;
    }
    prevPhase = S.phase;

    switch (S.phase) {
      case 'lobby': showScreen('lobby'); renderLobby(); break;
      case 'drawing': showScreen('play'); renderPlay(); break;
      case 'voting': showScreen('vote'); renderVote(); break;
      case 'guess': showScreen('guess'); renderGuess(); break;
      case 'reveal': showScreen('reveal'); renderReveal(); break;
      default: goHome();
    }
    setRoundChip();

    const myTurn = S.phase === 'drawing' && S.turnPlayerId === myId;
    if (myTurn && !prevMyTurn) { Sound.yourTurn(); buzz(45); }
    prevMyTurn = myTurn;
  }

  function renderLobby() {
    $('#lobbyCode').textContent = S.code;
    $('#codeChip').textContent = S.code;
    $('#lobbyCount').textContent = `(${S.players.length}/${S.maxPlayers})`;

    const ids = S.players.map((p) => p.id);
    if (prevLobbyIds.length !== ids.length) {
      const joined = ids.filter((id) => !prevLobbyIds.includes(id));
      const left = prevLobbyIds.filter((id) => !ids.includes(id));
      if (joined.length && prevLobbyIds.length) Sound.join();
      if (left.length) Sound.leave();
    }
    prevLobbyIds = ids;

    const iAmHost = S.you.isHost;
    setHTML($('#lobbyPlayers'), S.players.map((p) => {
      const kickBtn = (iAmHost && p.id !== myId)
        ? `<button class="kick" data-kick="${p.id}" title="Remove">✕</button>` : '';
      return `<li>
        ${avatar(p)}
        <span class="pname">${escapeHtml(p.name)}${p.isHost ? ' <em>host</em>' : ''}${p.connected ? '' : ' <em>offline</em>'}</span>
        ${kickBtn}
      </li>`;
    }).join(''));

    const scored = S.players.some((p) => p.score > 0) || S.roundNo > 0;
    $('#lobbyLeaderboard').classList.toggle('hidden', !scored);
    $('#resetBtn').classList.toggle('hidden', !(iAmHost && scored));
    setHTML($('#lobbyScores'), S.players.slice().sort((a, b) => b.score - a.score)
      .map((p) => `<li>${avatar(p)}<span class="pname">${escapeHtml(p.name)}</span>
        <span class="muted">${p.roundsWon ? p.roundsWon + '★' : ''}</span><b>${p.score}</b></li>`).join(''));

    $('#hostControls').classList.toggle('hidden', !iAmHost);
    if (iAmHost) {
      applySettings($('#lobbySettings'), S.settings, false);
      const warn = (S.settings.fakes > S.maxFakes)
        ? `  ⚠️ 2 fakes needs 4+ players — will use ${S.maxFakes}.` : '';
      $('#settingsSummary').textContent = summaryOf(S.settings) + warn;
    }

    const n = S.connectedCount;
    const enough = n >= S.minPlayers;
    $('#startBtn').disabled = !enough;
    $('#lobbyMsg').textContent = !enough
      ? `Need at least ${S.minPlayers} players — share the code!`
      : (iAmHost ? 'Everyone in? Start when ready.' : 'Waiting for the host to start…');

    $('#lobbyPlayers').querySelectorAll('[data-kick]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = S.players.find((x) => x.id === b.dataset.kick);
        if (p && confirm(`Remove ${p.name} from the room?`)) send({ type: 'kick', playerId: p.id });
      });
    });
  }

  let lastTurnKey = '';
  let lastRoleKey = '';

  function renderPlay() {
    const isMyTurn = S.turnPlayerId === myId;
    const perRound = S.order.length * S.lines;
    const idx = S.order.indexOf(S.turnPlayerId);
    const strokeNo = idx >= 0 ? (S.line - 1) * S.order.length + idx + 1 : perRound;

    const turnKey = `${S.roundNo}:${S.line}:${S.turnPlayerId}`;
    if (turnKey !== lastTurnKey) {
      lastTurnKey = turnKey;
      myStroke = []; sendBuf = []; drawing = false; drewThisTurn = false;
    }

    const banner = $('#roleBanner');
    const roleKey = `${S.roundNo}:${S.you.isFake}:${S.category}:${(S.you.fellowFakes || []).join(',')}`;
    const roleChanged = roleKey !== lastRoleKey;
    lastRoleKey = roleKey;
    if (S.you.isFake) {
      let mates = '';
      if (S.you.fellowFakes && S.you.fellowFakes.length) {
        const names = S.you.fellowFakes.map((id) => {
          const p = S.players.find((x) => x.id === id); return p ? p.name : '?';
        }).join(', ');
        mates = `<br><span class="muted">Fellow fake: ${escapeHtml(names)}</span>`;
      }
      banner.className = 'banner fake' + (roleChanged ? ' animate-pop' : '');
      setHTML(banner, `<b>You are the FAKE 🕵️</b><br>Category: <b>${escapeHtml(S.category)}</b>${mates}<br>
        You don't know the word. Blend in.`);
    } else {
      banner.className = 'banner artist' + (roleChanged ? ' animate-pop' : '');
      setHTML(banner, `<b>Your word: ${escapeHtml(S.word)}</b><br>Category: ${escapeHtml(S.category)}<br>
        Draw one line. Don't give it away.`);
    }

    const turnPlayer = S.players.find((p) => p.id === S.turnPlayerId);
    setHTML($('#turnText'), isMyTurn
      ? '<span style="color:var(--accent)">Your turn — draw one line</span>'
      : (turnPlayer ? `${avatar(turnPlayer)} ${escapeHtml(turnPlayer.name)}'s turn` : ''));

    setHTML($('#progressText'), `Round ${S.roundNo}/${S.gameRounds} · Line ${S.line}/${S.lines} · Stroke ${strokeNo}/${perRound}`);
    $('#doneBtn').classList.toggle('hidden', !isMyTurn);

    setHTML($('#playPlayers'), S.players.slice().sort((a, b) => b.score - a.score)
      .map((p) => `<li>${avatar(p)}<span class="pname">${escapeHtml(p.name)}</span><b>${p.score}</b></li>`).join(''));

    queueBoard();
  }

  /*
   * Vote screen — deliberately the dumbest screen in the game.
   *
   * The ballot is built once per voting phase and after that only ever has
   * classes toggled on it. No animation, no timers writing to the DOM, no
   * canvas, no live tally. Tapping a name sends exactly one message. There is
   * nothing on this screen that can cost a frame.
   */
  let voteSig = '';

  function renderVote() {
    const voted = S.you.votedFor || myVote;
    const targets = S.players.filter((p) => p.id !== myId);
    const sig = targets.map((p) => p.id + (p.connected ? '1' : '0')).join(',');

    if (sig !== voteSig) {
      voteSig = sig;
      const list = $('#voteList');
      list.textContent = '';
      for (const p of targets) {
        const li = document.createElement('li');
        li.dataset.id = p.id;
        const btn = document.createElement('button');
        btn.className = 'voteBtn';
        btn.dataset.id = p.id;
        btn.innerHTML = `${avatar(p)}<span class="vname">${escapeHtml(p.name)}</span>`;
        li.appendChild(btn);
        list.appendChild(li);
      }
    }

    for (const li of $('#voteList').children) {
      const id = li.dataset.id;
      const mine = voted === id;
      if (li.classList.contains('voted') !== mine) li.classList.toggle('voted', mine);
      const dim = !!voted && !mine;
      if (li.classList.contains('dim') !== dim) li.classList.toggle('dim', dim);
      const btn = li.firstElementChild;
      if (btn && btn.disabled !== !!voted) btn.disabled = !!voted;
    }

    setHTML($('#voteHint'), `Tap whoever you think is faking it. <b>${Object.keys(S.votes).length}/${S.connectedCount}</b> votes in.`);
    setText($('#voteMsg'), voted ? 'Vote locked in. Waiting for everyone…' : '');
  }

  function renderGuess() {
    const iAmCaught = S.you.id === S.caughtFakeId;
    const caught = S.players.find((p) => p.id === S.caughtFakeId);
    $('#guessTitle').textContent = caught ? `${caught.name} was caught!` : 'Caught!';
    $('#guessBox').classList.toggle('hidden', !iAmCaught);
    $('#guessWait').classList.toggle('hidden', iAmCaught);
    if (!iAmCaught) $('#guessWait').textContent = 'The Fake gets one guess at the word…';
    else if (document.activeElement !== $('#guessInput')) $('#guessInput').focus();
  }

  const REVEAL_BANNERS = (fakeNames, label) => ({
    fake_caught: `🎉 Artists win! <b>${fakeNames}</b> got caught and missed the guess.`,
    fake_guessed: `🕵️ ${label} win! <b>${fakeNames}</b> was caught… but guessed the word.`,
    fake_escaped: `😈 ${label} escape! <b>${fakeNames}</b> fooled everyone.`,
  });

  let lastRevealKey = '';

  function renderReveal() {
    const fakes = (S.fakeIds || []).map((id) => S.players.find((p) => p.id === id)).filter(Boolean);
    const fakeNames = fakes.map((p) => escapeHtml(p.name)).join(' & ') || 'The Fake';
    const label = fakes.length > 1 ? 'Fakes' : 'Fake';

    const b = $('#revealBanner');
    const revealKey = `${S.roundNo}:${S.outcome}:${(S.fakeIds || []).join(',')}`;
    const revealChanged = revealKey !== lastRevealKey;
    lastRevealKey = revealKey;
    b.className = 'banner ' + (revealChanged ? 'animate-pop ' : '') + (S.outcome === 'fake_caught' ? 'artist' : 'fake');
    setHTML(b, REVEAL_BANNERS(fakeNames, label)[S.outcome] || 'Round over.');

    setHTML($('#wordReveal'), `<span class="muted">Round ${S.roundNo}/${S.gameRounds} — the word was</span><br><b>${escapeHtml(S.word || '')}</b>` +
      (S.guessText ? `<br><span class="muted small">${label} guessed: “${escapeHtml(S.guessText)}”</span>` : ''));

    const rows = (p) => `<li>${avatar(p)}<span class="pname">${escapeHtml(p.name)}${(S.fakeIds || []).includes(p.id) ? ' 🕵️' : ''}</span>
      <span class="muted">${p.roundsWon ? p.roundsWon + '★' : ''}</span><b>${p.score}</b></li>`;
    const sorted = S.players.slice().sort((a, c) => c.score - a.score || a.name.localeCompare(c.name));
    setHTML($('#scoreList'), sorted.map(rows).join(''));
    setHTML($('#finalList'), sorted.map(rows).join(''));

    const iAmHost = S.you.isHost;
    $('#midCard').classList.toggle('hidden', !!S.gameOver);
    $('#finalCard').classList.toggle('hidden', !S.gameOver);

    if (S.gameOver) {
      $('#hostFinal').classList.toggle('hidden', !iAmHost);
      $('#finalWait').classList.toggle('hidden', iAmHost);
      $('#resetScoresBtn').classList.toggle('hidden', !iAmHost);
      if (!iAmHost) $('#finalWait').textContent = 'Waiting for the host…';
    } else {
      const nextNo = S.roundNo + 1;
      $('#hostReveal').classList.toggle('hidden', !iAmHost);
      $('#againWait').classList.toggle('hidden', iAmHost);
      $('#nextBtn').textContent = `▶ Start round ${nextNo} of ${S.gameRounds}`;
      if (iAmHost) applySettings($('#revealSettings'), S.settings, false);
      if (!iAmHost) $('#againWait').textContent = `Waiting for the host to start round ${nextNo} of ${S.gameRounds}…`;
    }

    queueReveal();
  }

  /* -------------------------------- canvas --------------------------------- */
  const board = $('#board');
  const ctx = board.getContext('2d');
  const rCanvas = $('#revealCanvas');
  const rctx = rCanvas.getContext('2d');
  const boardSize = { w: 0, h: 0, dpr: 0 };
  const revealSize = { w: 0, h: 0, dpr: 0 };
  let myStroke = [], sendBuf = [], drawing = false, drewThisTurn = false, flushTimer = null;

  const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
  const canDraw = () => S && S.phase === 'drawing' && S.turnPlayerId === myId;

  // Resizes only when the element actually changed size (resetting canvas.width
  // every frame is what made drawing and voting feel laggy).
  // The DPR is capped: a 3x phone screen triples the pixel work of every repaint
  // for no visible gain, and that alone can pin the main thread.
  // 1.5 is visually indistinguishable from 2 on this art and uses ~45% less
  // canvas memory — which matters when several players share one machine.
  const MAX_DPR = 1.5;
  function fitTo(canvas, c, size) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (size.w === w && size.h === h && size.dpr === dpr) return false;
    size.w = w; size.h = h; size.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function strokePath(c, w, h, points, color, lw) {
    if (!points || !points.length) return;
    c.strokeStyle = color; c.fillStyle = color;
    c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = lw;
    if (points.length === 1) {
      c.beginPath(); c.arc(points[0].x * w, points[0].y * h, lw / 2, 0, Math.PI * 2); c.fill(); return;
    }
    c.beginPath();
    c.moveTo(points[0].x * w, points[0].y * h);
    for (let i = 1; i < points.length; i++) c.lineTo(points[i].x * w, points[i].y * h);
    c.stroke();
  }

  /*
   * Finished strokes never change, so they are rasterised once into an offscreen
   * layer and then blitted. Every frame after that only redraws the stroke that is
   * actually being drawn right now.
   *
   * This is the difference between a phone staying smooth and melting: the old
   * code re-stroked the entire history (every point of every line) on each
   * pointermove, so cost grew all game and taps stopped registering.
   */
  function makeLayer(canvas) {
    const o = document.createElement('canvas');
    return { canvas: o, ctx: o.getContext('2d'), sig: '' };
  }
  const boardLayer = makeLayer(board);
  const revealLayer = makeLayer(rCanvas);

  function finishedSig(strokes) {
    let n = 0, pts = 0;
    for (const st of strokes) if (!st.inProgress) { n++; pts += st.points.length; }
    return n + ':' + pts;
  }

  function commitLayer(layer, size, strokes) {
    layer.canvas.width = Math.round(size.w * size.dpr);
    layer.canvas.height = Math.round(size.h * size.dpr);
    const c = layer.ctx;
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    const lw = Math.max(2.5, size.w * 0.007);
    for (const st of strokes) {
      if (st.inProgress) continue;
      strokePath(c, size.w, size.h, st.points, st.color, lw);
    }
  }

  // Live (still-growing) strokes are drawn on top of the cached layer each frame.
  function drawLive(c, size, strokes, myLocal) {
    const lw = Math.max(2.5, size.w * 0.007);
    for (const st of strokes) {
      if (!st.inProgress) continue;
      if (myLocal && st.playerId === myId && myStroke.length) continue;
      strokePath(c, size.w, size.h, st.points, st.color, lw);
    }
    if (myLocal && myStroke.length) strokePath(c, size.w, size.h, myStroke, (S && S.you.color) || '#000', lw);
  }

  function paintBoard() {
    fitTo(board, ctx, boardSize);
    if (!boardSize.w) return;
    const strokes = (S && S.strokes) || [];
    const sig = finishedSig(strokes);
    if (sig !== boardLayer.sig || boardLayer.canvas.width !== board.width) {
      commitLayer(boardLayer, boardSize, strokes);
      boardLayer.sig = sig;
    }
    ctx.clearRect(0, 0, boardSize.w, boardSize.h);
    ctx.drawImage(boardLayer.canvas, 0, 0, boardSize.w, boardSize.h);
    drawLive(ctx, boardSize, strokes, true);
  }

  function paintReveal() {
    fitTo(rCanvas, rctx, revealSize);
    if (!revealSize.w) return;
    const strokes = (S && S.strokes) || [];
    const sig = finishedSig(strokes);
    if (sig !== revealLayer.sig || revealLayer.canvas.width !== rCanvas.width) {
      commitLayer(revealLayer, revealSize, strokes);
      revealLayer.sig = sig;
    }
    rctx.clearRect(0, 0, revealSize.w, revealSize.h);
    rctx.drawImage(revealLayer.canvas, 0, 0, revealSize.w, revealSize.h);
    drawLive(rctx, revealSize, strokes, false);
  }

  // Coalesce to one repaint per frame instead of one per pointer event.
  let boardQueued = false, revealQueued = false;
  function queueBoard() {
    if (boardQueued) return;
    boardQueued = true;
    requestAnimationFrame(() => { boardQueued = false; paintBoard(); });
  }
  function queueReveal() {
    if (revealQueued) return;
    revealQueued = true;
    requestAnimationFrame(() => { revealQueued = false; paintReveal(); });
  }

  function syncBoard() { paintBoard(); }
  function syncReveal() { paintReveal(); }

  // Incremental drawing updates: the server only ever sends the new points.
  function applyInk(msg) {
    if (!S) return;
    const arr = S.strokes || (S.strokes = []);
    if (msg.done) {
      const st = arr[msg.i];
      if (st) st.inProgress = false;
      if (S.phase === 'reveal') queueReveal();
      return;
    }
    let st = arr[msg.i];
    if (!st || st.playerId !== msg.playerId) {
      for (let k = arr.length; k < msg.i; k++) {
        arr[k] = { playerId: msg.playerId, color: msg.color, points: [], inProgress: true };
      }
      st = arr[msg.i] = { playerId: msg.playerId, color: msg.color, points: [], inProgress: true };
    }
    if (Array.isArray(msg.points)) for (const p of msg.points) st.points.push(p);
    st.inProgress = true;
    if (S.phase === 'drawing') queueBoard();
    else if (S.phase === 'reveal') queueReveal();
  }

  // The board's rect can't change mid-stroke, and reading it on every pointermove
  // forces a layout on each event — so it's measured once when the stroke starts.
  let boardRect = null;

  function addPoint(e) {
    const rect = boardRect || board.getBoundingClientRect();
    if (!rect.width) return;
    const pt = { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
    myStroke.push(pt); sendBuf.push(pt); queueBoard();
  }

  function flush(final) {
    if (sendBuf.length) { send({ type: 'stroke', points: sendBuf }); sendBuf = []; }
    if (final && flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  }

  function endDraw() { if (!drawing) return; drawing = false; boardRect = null; flush(true); drewThisTurn = true; }

  board.addEventListener('pointerdown', (e) => {
    Sound.unlock();
    if (!canDraw() || drewThisTurn) return;
    e.preventDefault();
    drawing = true; myStroke = []; sendBuf = [];
    boardRect = board.getBoundingClientRect();
    try { board.setPointerCapture(e.pointerId); } catch {}
    addPoint(e);
    if (!flushTimer) flushTimer = setInterval(() => flush(false), 40);
  });
  board.addEventListener('pointermove', (e) => { if (!drawing) return; e.preventDefault(); addPoint(e); });
  board.addEventListener('pointerup', endDraw);
  board.addEventListener('pointercancel', endDraw);
  window.addEventListener('resize', () => {
    if (!S) return;
    if (S.phase === 'drawing') syncBoard();
    else if (S.phase === 'reveal') syncReveal();
  });
  window.addEventListener('orientationchange', () => setTimeout(() => {
    if (!S) return;
    if (S.phase === 'drawing') syncBoard(); else if (S.phase === 'reveal') syncReveal();
  }, 250));

  /* --------------------------------- timers -------------------------------- */
  let lastTickSec = -1;
  let lastVoteSec = -1;
  let lastGuessSec = -1;
  setInterval(() => {
    const el = $('#timerText');
    if (el) {
      if (!S || S.phase !== 'drawing' || !S.turnEndsAt) { setText(el, ''); setClass(el, 'timer'); lastTickSec = -1; }
      else {
        const remaining = Math.max(0, S.turnEndsAt - serverNow());
        const sec = Math.ceil(remaining / 1000);
        setText(el, `⏱ ${sec}s`);
        setClass(el, 'timer' + (remaining <= 3000 ? ' danger' : remaining <= 5000 ? ' warn' : ''));
        if (remaining <= 5000) {
          if (sec !== lastTickSec) { lastTickSec = sec; remaining <= 3000 ? Sound.urgent() : Sound.tick(); }
        } else lastTickSec = -1;
      }
    }

    const vt = $('#voteTimerText');
    if (vt) {
      if (!S || S.phase !== 'voting' || !S.voteEndsAt) { setText(vt, ''); setClass(vt, 'timer'); lastVoteSec = -1; }
      else {
        const remaining = Math.max(0, S.voteEndsAt - serverNow());
        const sec = Math.ceil(remaining / 1000);
        setText(vt, `⏱ ${sec}s`);
        setClass(vt, 'timer' + (remaining <= 5000 ? ' warn' : ''));
        if (remaining <= 10000 && sec !== lastVoteSec) { lastVoteSec = sec; Sound.tick(); }
      }
    }

    const gt = $('#guessTimerText');
    if (gt) {
      if (!S || S.phase !== 'guess' || !S.guessEndsAt) { setText(gt, ''); setClass(gt, 'timer'); lastGuessSec = -1; }
      else {
        const remaining = Math.max(0, S.guessEndsAt - serverNow());
        const sec = Math.ceil(remaining / 1000);
        setText(gt, `⏱ ${sec}s`);
        setClass(gt, 'timer' + (remaining <= 10000 ? ' warn' : ''));
        if (remaining <= 10000 && sec !== lastGuessSec) { lastGuessSec = sec; Sound.tick(); }
      }
    }
  }, 250);

  /* ------------------------------- reactions ------------------------------- */
  function buildReactionBar() {
    $('#reactionBar').innerHTML = REACTIONS
      .map((e) => `<button data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('');
    $('#reactionBar').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        Sound.unlock();
        send({ type: 'reaction', emoji: b.dataset.emoji });
        buzz(12);
      });
    });
  }

  function showFloater(msg) {
    if (reduceMotion) { Sound.react(); return; }
    const host = $('#floaters');
    if (host.childElementCount > 14) return;  // cap DOM churn during reaction spam
    const el = document.createElement('div');
    el.className = 'floater';
    el.style.left = (8 + Math.random() * 74) + '%';
    el.innerHTML = `<em>${escapeHtml(msg.emoji)}</em><small style="color:${msg.color}">${escapeHtml(msg.name)}</small>`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 2900);
    Sound.react();
    if (msg.playerId !== myId) buzz(8);
  }

  /* ------------------------------- confetti -------------------------------- */
  function burstConfetti(n) {
    if (reduceMotion) return;
    const host = $('#confetti');
    const colors = ['#6c8cff', '#b06cff', '#f5a524', '#30a46c', '#e5484d', '#12a594'];
    for (let i = 0; i < n; i++) {
      const s = document.createElement('i');
      s.style.left = Math.random() * 100 + 'vw';
      s.style.background = colors[Math.floor(Math.random() * colors.length)];
      s.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
      s.style.animationDelay = (Math.random() * 0.4) + 's';
      s.style.transform = `rotate(${Math.random() * 360}deg)`;
      host.appendChild(s);
      setTimeout(() => s.remove(), 3400);
    }
  }

  function toast(text, bad) {
    const el = document.createElement('div');
    el.className = 'banner ' + (bad ? 'fake' : 'artist') + ' animate-pop';
    el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:95;max-width:90%;width:max-content;';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  /* ------------------------------ menu modal ------------------------------- */
  function openMenu() {
    $('#menuModal').classList.remove('hidden');
    $('#modalSoundToggle').textContent = Sound.enabled ? 'On' : 'Off';
    $('#volumeSlider').value = Math.round(Sound.volume * 100);
    $('#motionToggle').textContent = reduceMotion ? 'On' : 'Off';
  }
  function closeMenu() { $('#menuModal').classList.add('hidden'); }

  /* --------------------------------- events -------------------------------- */
  function saveName() {
    const n = $('#nameInput').value.trim();
    if (!n) { $('#homeErr').textContent = 'Enter a name first.'; return null; }
    myName = n; localStorage.setItem('fa_name', n); $('#homeErr').textContent = '';
    return n;
  }

  $('#createBtn').addEventListener('click', () => {
    Sound.unlock();
    const n = saveName(); if (!n) return;
    saveHomeSettings();
    send({ type: 'create', name: n, playerId: myId, settings: readSettings($('#homeSettings')) });
  });

  $('#joinBtn').addEventListener('click', () => {
    Sound.unlock();
    const n = saveName(); if (!n) return;
    const code = $('#codeInput').value.trim().toUpperCase();
    if (!code) { $('#homeErr').textContent = 'Enter a room code.'; return; }
    send({ type: 'join', code, name: n, playerId: myId });
  });

  $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#createBtn').click(); });
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#guessInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#guessBtn').click(); });

  $('#homeSettings').addEventListener('change', saveHomeSettings);
  $('#homeSettings').addEventListener('input', saveHomeSettings);

  $('#soundBtn').addEventListener('click', () => { Sound.unlock(); updateSoundIcon(Sound.toggle()); });
  $('#menuBtn').addEventListener('click', openMenu);
  $('#menuClose').addEventListener('click', closeMenu);
  $('#menuModal').addEventListener('click', (e) => { if (e.target === $('#menuModal')) closeMenu(); });
  $('#homeRules').addEventListener('click', openMenu);

  $('#modalSoundToggle').addEventListener('click', (e) => {
    const on = Sound.toggle(); e.target.textContent = on ? 'On' : 'Off'; updateSoundIcon(on);
  });
  $('#volumeSlider').addEventListener('input', (e) => Sound.setVolume(parseInt(e.target.value, 10) / 100));
  $('#motionToggle').addEventListener('click', (e) => {
    reduceMotion = !reduceMotion;
    localStorage.setItem('fa_motion', reduceMotion ? 'reduce' : 'auto');
    applyMotion();
    e.target.textContent = reduceMotion ? 'On' : 'Off';
  });

  $('#codeChip').addEventListener('click', async () => {
    if (!S) return;
    try { await navigator.clipboard.writeText(S.code); toast('Room code copied'); } catch {}
  });

  $('#leaveBtn').addEventListener('click', () => {
    if (!confirm('Leave the room?')) return;
    send({ type: 'leave' });
    sessionStorage.removeItem('fa_room');
    S = null; prevPhase = null; prevLobbyIds = []; voteSig = '';
    goHome();
  });

  $('#shareBtn').addEventListener('click', async () => {
    const url = `${location.origin}${GAME_URL}?room=${S.code}`;
    const text = `Play Fake Artist with me! Code: ${S.code}\n${url}`;
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(url);
      $('#shareBtn').textContent = 'Link copied!';
      setTimeout(() => { $('#shareBtn').textContent = 'Copy invite link'; }, 1500);
    } catch {}
  });

  let settingsDebounce = null;
  const pushSettings = () => {
    clearTimeout(settingsDebounce);
    settingsDebounce = setTimeout(() => {
      send({ type: 'settings', settings: readSettings($('#lobbySettings')) });
      send({ type: 'settings', settings: readSettings($('#revealSettings')) });
    }, 160);
  };
  $('#lobbySettings').addEventListener('change', pushSettings);
  $('#lobbySettings').addEventListener('input', pushSettings);
  $('#revealSettings').addEventListener('change', pushSettings);
  $('#revealSettings').addEventListener('input', pushSettings);

  // One delegated listener for the whole ballot. pointerdown (not click) so the
  // vote registers the instant the finger lands, even on a janky frame.
  function castVote(targetId) {
    if (!S || S.phase !== 'voting' || myVote || S.you.votedFor) return;
    myVote = targetId;
    const payload = { type: 'vote', targetId };
    // If the socket happens to be down the vote is kept and sent the moment it
    // is back — a tapped vote is never silently dropped.
    if (ws && ws.readyState === 1) send(payload);
    else queuedVote = payload;
    renderVote();
  }

  $('#voteList').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.voteBtn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    Sound.unlock();
    castVote(btn.dataset.id);
    Sound.react();
    buzz(15);
  });

  $('#startBtn').addEventListener('click', () => send({ type: 'start', settings: readSettings($('#lobbySettings')) }));
  $('#nextBtn').addEventListener('click', () => send({ type: 'nextRound', settings: readSettings($('#revealSettings')) }));
  $('#playAgainBtn').addEventListener('click', () => send({ type: 'playAgain' }));
  $('#disbandBtn').addEventListener('click', () => { if (confirm('Close the room for everyone?')) send({ type: 'disband' }); });
  $('#resetBtn').addEventListener('click', () => { if (confirm('Reset all scores?')) send({ type: 'resetScores' }); });
  $('#resetScoresBtn').addEventListener('click', () => { if (confirm('Reset all scores?')) send({ type: 'resetScores' }); });
  $('#doneBtn').addEventListener('click', () => send({ type: 'endTurn' }));
  $('#toLobbyBtn').addEventListener('click', () => send({ type: 'toLobby' }));
  $('#toLobbyBtn2').addEventListener('click', () => send({ type: 'toLobby' }));
  $('#guessBtn').addEventListener('click', () => { const t = $('#guessInput').value.trim(); if (t) send({ type: 'guess', text: t }); });

  function updateSoundIcon(on) { $('#soundBtn').textContent = on ? '🔊' : '🔇'; }

  /* ------------------------------ PWA + install ---------------------------- */
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('#installRow').style.display = 'flex';
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch {}
    deferredInstall = null;
    $('#installRow').style.display = 'none';
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/games/fake-artist/sw.js').catch(() => {}));
  }

  /* --------------------------------- boot ---------------------------------- */
  $('#homeSettings').innerHTML = settingsFormHTML();
  $('#lobbySettings').innerHTML = settingsFormHTML();
  $('#revealSettings').innerHTML = settingsFormHTML();
  buildReactionBar();
  applyMotion();
  updateSoundIcon(Sound.enabled);

  const defaults = {
    category: 'random', rounds: 3, lines: 2, fakes: 1, turnTime: 0, voteTime: 0,
    fakesKnowEachOther: false, shuffleFakes: true, rotateCategory: false,
    customWords: [], customHint: '',
  };
  let saved = defaults;
  try {
    const raw = localStorage.getItem('fa_settings');
    if (raw) saved = Object.assign({}, defaults, JSON.parse(raw));
  } catch {}
  applySettings($('#homeSettings'), saved, true);

  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('#codeInput').value = urlRoom.toUpperCase().trim();
  $('#nameInput').value = myName;

  // unlock audio on the very first interaction (browser autoplay policy)
  const unlock = () => { Sound.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  showScreen('home');
  connect();
})();
