// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin/players.js — the console's Overview and Players tabs, its
// devices (admin passkeys) and sign-out, over /admin/api and /admin/auth
// (server/chat.mjs, server/admin.mjs). Everything a player wrote is set as
// text, never as HTML.

const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function btn(label, onClick, cls) {
  const b = el('button', label, cls);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const ago = (t) => {
  if (!t) return '–';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};
// A player's picture, or an empty square without one.
const pic = (p, cls = 'pic') => {
  if (!p.avatar) return el('span', null, `${cls} none`);
  const i = el('img', null, cls);
  i.alt = '';
  i.src = `/api/users/${p.id}/avatar?v=${p.avatar}`;
  return i;
};

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (r.status === 401) { location.href = '/admin/login'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `The server answered ${r.status}.`);
  return data;
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-pressed', String(t.dataset.tab === name));
  for (const n of ['overview', 'players', 'live']) $(`tab-${n}`).hidden = n !== name;
  if (name === 'overview') renderOverview();
  if (name === 'players') loadPlayers();
  if (location.hash.slice(1).split('/')[0] !== name) history.replaceState(null, '', `#${name}`);
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));

// ── Overview ──────────────────────────────────────────────────────────────
async function renderOverview() {
  const box = $('tab-overview');
  let o;
  try { o = await api('/admin/api/overview'); } catch (e) { box.replaceChildren(el('p', e.message, 'bad')); return; }
  const card = (n, label) => { const c = el('div', null, 'card'); c.append(el('b', String(n)), el('span', label, 'meta')); return c; };
  const cards = el('div', null, 'cards');
  cards.append(card(o.players, 'players'), card(o.newToday, 'new today'), card(o.newWeek, 'new this week'), card(o.onlineNow, 'in the chat now'),
    card(o.activeNow, 'active now (5 min)'), card(o.active24h, 'active today'), card(o.active7d, 'active this week'), card(o.unlocksToday, 'unlocks today'), card(o.bestsToday, 'new bests today'),
    card(o.toReview, 'to review'));
  const active = el('section');
  active.append(el('h2', 'Active now'));
  const list = el('ul', null, 'list');
  for (const p of o.active) {
    const li = el('li');
    li.append(pic(p), ' ', playerLink(p), el('span', ` ${p.online ? 'in the chat' : p.game ? `playing ${p.game}` : 'in the app'}, seen ${ago(p.seen)}`, 'meta'));
    list.append(li);
  }
  if (!o.active.length) list.append(el('li', 'No one right now.', 'meta'));
  else if (o.activeNow > o.active.length) list.append(el('li', `and ${o.activeNow - o.active.length} more`, 'meta'));
  active.append(list);
  const games = el('section');
  games.append(el('h2', 'Top games this week'));
  const gl = el('ul', null, 'list');
  for (const g of o.topGames) gl.append(el('li', `${g.title}: ${g.players} players, ${g.unlocks} unlocks`));
  if (!o.topGames.length) gl.append(el('li', 'Nothing yet this week.', 'meta'));
  games.append(gl);
  const latest = el('section');
  latest.append(el('h2', 'Latest sign-ups'));
  const ll = el('ul', null, 'list');
  for (const p of o.latest) { const li = el('li'); li.append(pic(p), ' ', playerLink(p), el('span', ` ${ago(p.joined)}`, 'meta')); ll.append(li); }
  latest.append(ll);
  const split = el('div', null, 'split');
  split.append(active, games, latest);
  box.replaceChildren(cards, await reviewSection(), split, demoSection(o.demoPlayers));
}

// Demo players: made-up accounts with unlocks and scores in every game, to fill the pages on a test
// server. Each press adds 50 more with new names; they all go at once.
function demoSection(count) {
  const sec = el('section', null, 'demo');
  sec.append(el('h2', 'Demo players'));
  const status = el('p', `${count} demo players.`, 'meta');
  const run = (action, ask) => async () => {
    if (!confirm(ask)) return;
    status.textContent = action === 'add' ? 'Adding…' : 'Removing…';
    try {
      const r = await api('/admin/api/demo', { action });
      status.textContent = action === 'add' ? `Added ${r.players} players, ${r.unlocks} unlocks and ${r.scores} scores.` : `Removed ${r.removed} demo players.`;
      setTimeout(renderOverview, 1500);
    } catch (e) { status.textContent = e.message; }
  };
  sec.append(status, btn('Add 50 demo players', run('add', 'Add 50 demo players, with unlocks and scores in every game?')), ' ',
    btn('Remove all demo players', run('remove', 'Remove every demo player and all their unlocks and scores?'), 'danger'));
  return sec;
}

// Results the fair-play checks flagged: hidden from the public until approved, or cleared.
async function reviewSection() {
  const sec = el('section');
  sec.append(el('h2', 'To review'));
  let r;
  try { r = await api('/admin/api/flags'); } catch (e) { sec.append(el('p', e.message, 'bad')); return sec; }
  const ul = el('ul', null, 'list');
  for (const f of r.items) {
    const li = el('li');
    const what = f.kind === 'unlock' ? `unlocked ${f.item ?? `#${f.ref}`}${f.points != null ? ` (${f.points} points)` : ''}` : `scored ${f.value} on ${f.item ?? `board ${f.ref}`}`;
    const decide = (decision) => btn(decision === 'approve' ? 'Approve' : 'Clear', async () => {
      try { await api('/admin/api/flags', { kind: f.kind, user: f.user.id, game: f.game.id, ref: f.ref, decision }); renderOverview(); } catch (e) { alert(e.message); }
    }, decision === 'clear' ? 'danger' : '');
    li.append(playerLink(f.user), el('span', ` ${what} in ${f.game.title}, ${ago(f.at)}: ${f.flag}. `, 'meta'), decide('approve'), ' ', decide('clear'));
    ul.append(li);
  }
  if (!r.items.length) ul.append(el('li', 'Nothing flagged.', 'meta'));
  sec.append(ul);
  return sec;
}
function playerLink(p) {
  return btn(p.name, () => { showTab('players'); openPlayer(p.id); }, 'link');
}

// ── Players ───────────────────────────────────────────────────────────────
const list = { search: '', sort: 'joined', dir: 'desc', page: 0, total: 0, size: 50 };
const COLUMNS = [['name', 'Name'], ['joined', 'Joined'], ['seen', 'Last seen'], ['points', 'Points'], ['unlocks', 'Unlocks'], ['games', 'Games'], [null, 'Passkeys'], [null, 'Last IP']];
function renderHead() {
  $('player-head').replaceChildren(...COLUMNS.map(([key, label]) => {
    const th = el('th');
    if (!key) th.textContent = label;
    else th.append(btn(`${label}${list.sort === key ? (list.dir === 'asc' ? ' ▲' : ' ▼') : ''}`, () => {
      list.dir = list.sort === key && list.dir === 'desc' ? 'asc' : 'desc';
      list.sort = key; list.page = 0; loadPlayers();
    }));
    return th;
  }));
}
let picked = null;
let listTurn = 0;   // the latest request for the list: an older answer that arrives later is dropped
async function loadPlayers() {
  renderHead();
  const q = new URLSearchParams({ search: list.search, sort: list.sort, dir: list.dir, page: String(list.page) });
  const turn = ++listTurn;
  let r;
  try { r = await api(`/admin/api/players?${q}`); } catch (e) { if (turn === listTurn) $('player-rows').replaceChildren(el('tr', e.message, 'bad')); return; }
  if (turn !== listTurn) return;
  list.total = r.total; list.size = r.pageSize;
  $('player-rows').replaceChildren(...r.players.map((p) => {
    const tr = el('tr', null, p.id === picked ? 'is-picked' : null);
    const name = el('td');
    name.append(pic(p), ' ', p.name, p.online ? el('span', 'online', 'flag on') : '');
    tr.append(name, el('td', when(p.joined)), el('td', ago(p.lastSeen)), el('td', String(p.points)), el('td', String(p.unlocks)), el('td', String(p.games)), el('td', String(p.passkeys)), el('td', `${p.lastIp ?? '–'}${p.banned ? ' (banned)' : ''}`, p.banned ? 'bad' : null));
    tr.addEventListener('click', () => openPlayer(p.id));
    return tr;
  }));
  const pages = Math.max(1, Math.ceil(list.total / list.size));
  $('page-info').textContent = `${list.total} players, page ${list.page + 1} of ${pages}`;
  $('page-prev').disabled = list.page === 0;
  $('page-next').disabled = list.page + 1 >= pages;
}
let searchTimer = 0;
$('player-search').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { list.search = e.target.value; list.page = 0; loadPlayers(); }, 250); });
$('page-prev').addEventListener('click', () => { list.page--; loadPlayers(); });
$('page-next').addEventListener('click', () => { list.page++; loadPlayers(); });

// ── One player ────────────────────────────────────────────────────────────
/** Bans an address (from a login or the last IP), or lifts its ban: both ask, and are logged. */
async function banAddress(p, ip, banned) {
  try {
    if (banned) {
      if (!confirm(`Lift the ban on ${ip}?`)) return;
      await api('/admin/api/unban', { ip });
    } else {
      const hours = Number(prompt(`Ban ${ip} for how many hours? (1 to 720) It can neither chat nor sign in, sign up or post results.`, '24'));
      if (!hours) return;
      const reason = prompt('Reason, for the log', '');
      if (!reason?.trim()) return;
      await api('/admin/api/ban', { ip, hours, reason });
    }
    openPlayer(p.id);
    loadPlayers();
  } catch (e) { alert(e.message); }
}
// `label` starts the question ("Sign out" → "Sign out Ann?"), or is the whole question as a function of the player.
async function act(p, action, label, extra = {}) {
  const question = typeof label === 'function' ? label(p) : `${label} ${p.name}?`;
  const reason = prompt(`${question} Give a reason for the log.`, '');
  if (!reason?.trim()) return;
  try {
    await api(`/admin/api/players/${p.id}/${action}`, { reason, ...extra });
    if (action === 'delete') { $('player-detail').replaceChildren(el('p', `${p.name} was deleted.`, 'meta')); picked = null; }
    else openPlayer(p.id);
    loadPlayers();
  } catch (e) { alert(e.message); }
}
/** A table that pages with LOAD MORE: rows(items) makes the rows. */
function paged(first, url, head, rows) {
  const box = el('div');
  const t = el('table', null, 'table');
  const tr = el('tr');
  for (const h of head) tr.append(el('th', h));
  const thead = el('thead'); thead.append(tr);
  const tbody = el('tbody');
  t.append(thead, tbody);
  const more = btn('LOAD MORE', async () => {
    try { add(await api(`${url}?before=${last}`)); } catch (e) { more.replaceWith(el('p', e.message, 'bad')); }
  });
  let last = null;
  const add = (page) => { tbody.append(...rows(page.items)); last = page.items.at(-1)?.id ?? last; more.hidden = !page.more; };
  add(first);
  box.append(t, more);
  return box;
}
async function openPlayer(id) {
  picked = id;
  for (const r of document.querySelectorAll('#player-rows tr')) r.classList.remove('is-picked');
  const box = $('player-detail');
  box.replaceChildren(el('p', 'Loading…', 'meta'));
  let p;
  try { p = await api(`/admin/api/players/${id}`); } catch (e) { if (picked === id) box.replaceChildren(el('p', e.message, 'bad')); return; }
  // Another player was picked meanwhile: this answer, and its buttons, are not shown.
  if (picked !== id) return;
  history.replaceState(null, '', `#players/${id}`);
  const head = el('div', null, 'row');
  const title = el('div');
  title.append(el('h2', p.name), el('span', `id ${p.id}, joined ${when(p.joined)}, last seen ${ago(p.lastSeen)}${p.online ? ', in the chat now' : ''}`, 'meta'));
  head.append(pic(p, 'pic big'), title);
  const facts = el('ul', null, 'list');
  const ipLine = el('li', `Last IP: ${p.lastIp ?? '–'} `);
  if (p.lastIp) ipLine.append(p.lastIpBanned ? el('span', 'banned ', 'bad') : '', btn(p.lastIpBanned ? 'lift ban' : 'ban', () => banAddress(p, p.lastIp, p.lastIpBanned), p.lastIpBanned ? null : 'danger'));
  facts.append(el('li', `Sessions open: ${p.sessions}`), el('li', `Recovery code: ${p.recoveryCode ? 'set' : 'none'}`), ipLine);
  if (p.sameAddress.length) {
    const li = el('li', 'Same address as: ');
    p.sameAddress.forEach((o, i) => li.append(i ? ', ' : '', btn(o.name, () => openPlayer(o.id), 'link')));
    facts.append(li);
  }
  const actions = el('div', null, 'actions');
  actions.append(btn('Sign out everywhere', () => act(p, 'signout', 'Sign out')), btn('Rename', () => act(p, 'rename', (x) => `Rename ${x.name} to Player${x.id}?`)),
    p.avatar ? btn('Remove badge', () => act(p, 'picture', 'Remove the badge of')) : '',
    btn('Delete account', () => confirm(`Delete ${p.name} and all their results? This cannot be undone.`) && act(p, 'delete', 'Delete'), 'danger'));
  const keys = el('ul', null, 'list');
  for (const k of p.passkeys) keys.append(el('li', `Added ${when(k.created)}, last used ${when(k.lastUsed)}${k.transports.length ? ` (${k.transports.join(', ')})` : ''}`));
  const games = el('div');
  for (const g of p.games) {
    const sec = el('div', null, 'card');
    const top = el('div', null, 'row');
    top.append(el('b', g.title), el('span', `${g.unlocked} of ${g.total} unlocked, ${g.points} points`, 'meta'), btn('Clear results', () => act(p, 'results', `Clear ${g.title} results of`, { game: g.id }), 'danger'));
    sec.append(top);
    for (const s of g.scores) {
      const row = el('div', null, 'row');
      row.append(el('span', `${s.title}: ${s.value} (${when(s.at)})`), btn('Remove', () => act(p, 'score', `Remove the ${s.title} score of`, { game: g.id, board: s.id })));
      sec.append(row);
    }
    games.append(sec);
  }
  if (!p.games.length) games.append(el('p', 'No results yet.', 'meta'));
  const logins = paged(p.logins, `/admin/api/players/${id}/logins`, ['When', 'What', 'IP address', 'Browser', '', ''], (items) => items.map((l) => {
    const tr = el('tr');
    const ban = el('td');
    if (l.ip) ban.append(btn(l.banned ? 'lift ban' : 'ban', () => banAddress(p, l.ip, l.banned), l.banned ? null : 'danger'));
    tr.append(el('td', when(l.at)), el('td', l.kind), el('td', `${l.ip ?? '–'}${l.banned ? ' (banned)' : ''}`, l.banned ? 'bad' : null), el('td', l.device ?? '–'), el('td', l.ok ? 'ok' : 'failed', l.ok ? null : 'bad'), ban);
    return tr;
  }));
  const activity = paged(p.activity, `/admin/api/players/${id}/activity`, ['When', 'Game', 'What', ''], (items) => items.map((a) => {
    const tr = el('tr');
    const what = a.kind === 'unlock' ? `unlocked ${a.achievement} (+${a.points})` : `best ${a.value} on ${a.board}`;
    const remove = el('td');
    remove.append(btn('remove', () => act(p, 'entry', (x) => `Remove "${what}" in ${a.game} from the activity of ${x.name}? The result itself stays.`, { entry: a.id }), 'danger'));
    tr.append(el('td', when(a.at)), el('td', a.game), el('td', what), remove);
    return tr;
  }));
  box.replaceChildren(head, facts, actions, el('h2', 'Passkeys'), keys, el('h2', 'Games'), games, el('h2', 'Logins'), logins, el('h2', 'Activity'), activity);
}

// ── Devices and sign-out ──────────────────────────────────────────────────
async function showDevices() {
  const d = $('devices');
  $('device-key').textContent = '';
  try {
    const { passkeys } = await api('/admin/auth/passkeys');
    $('device-list').replaceChildren(...passkeys.map((k) => {
      const li = el('li', `${k.label || 'A device'}: added ${when(k.created)}, last used ${when(k.lastUsed)} `);
      li.append(btn('remove', async () => { if (!confirm('Remove this admin passkey?')) return; try { await api('/admin/auth/remove', { id: k.id }); showDevices(); } catch (e) { alert(e.message); } }, 'danger'));
      return li;
    }));
  } catch (e) { $('device-list').replaceChildren(el('li', e.message, 'bad')); }
  if (!d.open) d.showModal();
}
$('btn-devices').addEventListener('click', showDevices);
$('btn-close-devices').addEventListener('click', () => $('devices').close());
$('btn-add-device').addEventListener('click', async () => {
  try {
    const { key, expires } = await api('/admin/auth/add', {});
    $('device-key').textContent = `${key}  (enter it on the other device within ${Math.round((expires - Date.now()) / 60000)} minutes)`;
  } catch (e) { alert(e.message); }
});
$('btn-signout').addEventListener('click', async () => { await api('/admin/auth/logout', {}).catch(() => {}); location.href = '/admin/login'; });

// The tab, and player, in the address.
const [tab, id] = location.hash.slice(1).split('/');
showTab(['overview', 'players', 'live'].includes(tab) ? tab : 'overview');
if (tab === 'players' && /^\d+$/.test(id ?? '')) openPlayer(Number(id));
