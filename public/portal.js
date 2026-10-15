(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase().trim();

  let games = [];
  let activeTag = 'all';

  /* --------------------------------- invite -------------------------------- */
  function initInvite() {
    if (!/^[A-Z0-9]{4}$/.test(roomParam)) return;
    $('#inviteCode').textContent = roomParam;
    $('#invite').classList.remove('hidden');
    // The invite points at whichever live game it came from; default to the first.
    const target = games.find((g) => g.status === 'live') || games[0];
    $('#inviteBtn').addEventListener('click', () => {
      location.href = `${target ? target.url : '/'}?room=${roomParam}`;
    });
  }

  /* --------------------------------- cards --------------------------------- */
  function cardHTML(g) {
    const soon = g.status !== 'live';
    const tags = (g.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const metaBits = [g.players, g.time].filter(Boolean)
      .map((m) => `<span class="tag">${escapeHtml(m)}</span>`).join('');
    return `<button class="card${soon ? ' soon' : ''}" data-id="${g.id}"
        style="--g1:${(g.gradient && g.gradient[0]) || '#6c8cff'};--g2:${(g.gradient && g.gradient[1]) || '#b06cff'}"
        ${soon ? 'disabled' : ''}>
      <span class="emoji">${escapeHtml(g.emoji || '🎮')}</span>
      <h2>${escapeHtml(g.title)}</h2>
      <p>${escapeHtml(g.tagline || '')}</p>
      <div class="meta">
        <span class="badge ${soon ? 'soon' : 'live'}">${soon ? 'Coming soon' : 'Play free'}</span>
        ${metaBits}${tags}
      </div>
    </button>`;
  }

  function render() {
    const list = activeTag === 'all' ? games : games.filter((g) => (g.tags || []).includes(activeTag));
    $('#games').innerHTML = list.map(cardHTML).join('');
    $('#empty').classList.toggle('hidden', list.length > 0);
    $('#games').querySelectorAll('.card:not(.soon)').forEach((el) => {
      el.addEventListener('click', () => openDetails(el.dataset.id));
    });
  }

  function renderFilters() {
    const tags = new Set();
    games.forEach((g) => (g.tags || []).forEach((t) => tags.add(t)));
    if (tags.size < 2) { $('#filters').innerHTML = ''; return; }
    const all = ['all', ...[...tags].sort()];
    $('#filters').innerHTML = all.map((t) =>
      `<button class="chip${t === activeTag ? ' on' : ''}" data-tag="${escapeHtml(t)}">${t === 'all' ? 'All games' : escapeHtml(t)}</button>`
    ).join('');
    $('#filters').querySelectorAll('.chip').forEach((b) => {
      b.addEventListener('click', () => { activeTag = b.dataset.tag; renderFilters(); render(); });
    });
  }

  /* -------------------------------- details -------------------------------- */
  let openGame = null;

  function openDetails(id) {
    const g = games.find((x) => x.id === id);
    if (!g || g.status !== 'live') return;
    openGame = g;
    document.documentElement.style.setProperty('--g1', (g.gradient && g.gradient[0]) || '#6c8cff');
    document.documentElement.style.setProperty('--g2', (g.gradient && g.gradient[1]) || '#b06cff');
    $('#mEmoji').textContent = g.emoji || '🎮';
    $('#mTitle').textContent = g.title;
    $('#mTagline').textContent = g.tagline || '';
    $('#mDesc').textContent = g.description || '';
    $('#mMeta').innerHTML = [
      `<span class="badge live">Play free</span>`,
      g.players, g.time, g.device,
      ...(g.tags || []),
    ].filter(Boolean).map((m) =>
      typeof m === 'string' && m.startsWith('<') ? m : `<span class="tag">${escapeHtml(m)}</span>`
    ).join('');
    $('#mHow').innerHTML = (g.howToPlay || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    $('#mFeatures').innerHTML = (g.features || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    $('#mPlay').href = g.url + (roomParam ? '?room=' + roomParam : '');
    $('#modal').classList.remove('hidden');
    try { history.replaceState(null, '', '?game=' + g.id + (roomParam ? '&room=' + roomParam : '')); } catch {}
    $('#closeBtn').focus();
  }

  function closeDetails() {
    $('#modal').classList.add('hidden');
    openGame = null;
    try { history.replaceState(null, '', location.pathname + (roomParam ? '?room=' + roomParam : '')); } catch {}
  }

  $('#closeBtn').addEventListener('click', closeDetails);
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeDetails(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openGame) closeDetails(); });

  /* ---------------------------------- boot --------------------------------- */
  (async () => {
    try {
      const res = await fetch('/games.json', { cache: 'no-cache' });
      const data = await res.json();
      games = Array.isArray(data.games) ? data.games : [];
      if (data.title) { $('#hubTitle').textContent = data.title; document.title = data.title + ' — free browser party games'; }
      if (data.tagline) $('#hubTagline').textContent = data.tagline;
    } catch {
      $('#games').innerHTML = '<p class="muted center">Could not load the game list.</p>';
      return;
    }

    renderFilters();
    render();
    initInvite();

    const deepLink = params.get('game');
    if (deepLink) openDetails(deepLink);
  })();
})();
