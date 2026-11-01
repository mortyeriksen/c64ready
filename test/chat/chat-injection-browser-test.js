// Nothing anyone types into the chat runs as code: attackers talking to the
// chat server directly, with none of the app's own limits, fill their account
// names and messages with HTML, script and URL payloads, mention a game whose
// title is one, and send forged mentions. The app's chat and the admin console
// both show it all, and the test fails if any payload runs, opens a dialog or
// turns into an element. Only a game the server knows becomes a mention.
//
// Needs Playwright's Chromium. Without it the file reports a SKIP. No ROMs.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createChatServer } from '../../server/chat.mjs';
import { PROTOCOL } from '../../server/protocol.mjs';
import { createAccounts } from '../../server/accounts.mjs';
import { openDatabase } from '../../server/db.mjs';
import { createAdminData } from '../../server/admin-data.mjs';
import { createAdminPasskeys } from '../../server/admin-passkeys.mjs';
import { newSetupKey, setupKeyHash } from '../../server/admin.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* reported below */ }
let browser = null;
if (chromium) { try { browser = await chromium.launch(); } catch { browser = null; } }
if (!browser) {
  console.log('# SKIP Playwright Chromium is not installed (npx playwright install chromium)');
  process.exit(0);
}

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// Every payload sets window.__pwned (or opens a dialog) if it ever runs.
const PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=2</script>',
  '<svg onload="window.__pwned=3"></svg>',
  '"><iframe srcdoc="<script>parent.__pwned=4</script>"></iframe>',
  '<a href="javascript:window.__pwned=5">click</a>',
  'javascript:window.__pwned=6',
  "'-alert(7)-'",
  '${window.__pwned=8}',
  '{{constructor.constructor("window.__pwned=9")()}}',
  '<details open ontoggle="window.__pwned=10">',
  '<style>@import "javascript:window.__pwned=11"</style>',
  '\u202e<img src=x onerror=window.__pwned=12>',
];
const SAID_WITH = '<img src=x onerror=__pwned=21>';
// A game's title is the server's, from its sets: the worst case, one that is a payload.
const TOPIC = '<svg onload=__pwned=22><script>';
const NICK = '<b onclick=x()>';
const VICTIM = '<i onclick=y()>';

// The chat server with its console and the accounts it needs, and the app on a
// dev server pointed at it.
const SETUP_KEY = newSetupKey();
const db = openDatabase(':memory:');
const accounts = createAccounts({ db, allowLoopback: true });   // the app runs on a page on this computer
const adminPasskeys = createAdminPasskeys({ db });
const chat = createChatServer({
  allowLoopback: true,
  // The console's passkey is set up with this key, from its sign-in page, in the test's browser.
  admin: { passkeys: adminPasskeys, setupKeySha256: setupKeyHash(SETUP_KEY), keyUsed: adminPasskeys.keyUsed, useKey: adminPasskeys.useKey },
  adminData: createAdminData({ db, accounts }),
  authenticate: (t) => accounts.userForToken(t),
  findGame: (id) => (id === 'evil-game' ? { id, title: TOPIC } : null),
});
const chatHttp = http.createServer((q, r) => { if (accounts.handleRequest(q, r)) return; if (!chat.handleRequest(q, r)) r.writeHead(404).end(); });

// An account with a session, straight into the database: an attacker's name
// skips the checks sign-up would make, the worst case for the views.
function account(name) {
  const id = Number(db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)').run(name, name.toLowerCase(), crypto.randomBytes(16), Date.now()).lastInsertRowid);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), id, Date.now(), Date.now() + 1e9, Date.now());
  return token;
}
chatHttp.on('upgrade', (q, s, h) => { if (!chat.handleUpgrade(q, s, h)) s.destroy(); });
const CHAT_PORT = await freePort();
await new Promise((r) => chatHttp.listen(CHAT_PORT, '127.0.0.1', r));

const root = fileURLToPath(new URL('../../', import.meta.url));
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const APP_PORT = await freePort();
const vite = await createServer({ root, configFile: `${root}vite.config.js`, logLevel: 'silent', server: { port: APP_PORT, strictPort: true, host: '127.0.0.1' } });
await vite.listen();

// An attacker with a raw socket: no maxlength, no client-side checks.
function attacker(name, steps, token, acct = account(name)) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}/chat`);
    let i = 0, room = null, said = 0;
    w.onopen = () => w.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token, account: acct }));
    w.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.t === 'err') { reject(new Error(`attacker step ${i} refused: ${d.code}`)); return; }
      if (d.t !== 'welcome' && d.t !== 'ok') return;
      if (d.token) token = d.token;
      if (d.room) room = d.room;
      const next = steps[i++];
      if (!next) { resolve({ w, room, token, acct }); return; }
      const msg = { id: i, ...(typeof next === 'function' ? next(room) : next) };
      // Past the server's burst of five messages, one a second.
      const wait = msg.t === 'say' && ++said > 5 ? 1050 : 0;
      setTimeout(() => w.send(JSON.stringify(msg)), wait);
    };
    w.onerror = reject;
  });
}

async function watch(page) {
  page.dialogs = [];
  page.errors = [];
  page.on('dialog', (d) => { page.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  page.on('pageerror', (e) => page.errors.push(e.message));
}
const pwned = (page) => page.evaluate(() => window.__pwned ?? parent.__pwned ?? null);
const injected = (page, scope) => page.evaluate((sel) => {
  const box = document.querySelector(sel);
  if (!box) return -1;
  return box.querySelectorAll('img, script, svg, iframe, object, embed, a, style, details, link').length;
}, scope);

try {
  // ── The attackers' messages ────────────────────────────────────────────────
  const evil = await attacker(NICK, [
    ...PAYLOADS.map((text) => ({ t: 'say', text })),
    { t: 'say', text: `${SAID_WITH} @${TOPIC}`, games: ['evil-game', { id: 'evil-game', html: '<script>' }, '<script>', '__proto__'] },
  ]).catch((e) => { current.push(e.message); return {}; });
  const lying = await attacker('Liar', [
    { t: 'say', text: 'play this one @Commando', games: ['commando'] },
  ]).catch((e) => { current.push(e.message); return {}; });
  ok('an attacker can put payloads in an account name and messages, and forge mentions');

  // ── The chat ───────────────────────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1460, height: 1000 } });
  const app = await ctx.newPage();
  await watch(app);
  await app.addInitScript(([port, token]) => {
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.chat.server', `ws://127.0.0.1:${port}/chat`);
    localStorage.setItem('c64emu.account.token', token);
  }, [CHAT_PORT, account(VICTIM)]);
  await app.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'domcontentloaded' });
  await app.waitForFunction(() => document.getElementById('btn-online'), null, { timeout: 30_000 });
  await app.click('#btn-online');
  await app.click('#online-tab-chat');
  await app.locator('.chat-msg', { hasText: 'play this one' }).waitFor({ timeout: 10_000 });
  await app.click('.chat-room-bar button:has-text("PEOPLE")');
  await app.waitForTimeout(500);
  const logText = await app.locator('.chat-log').innerText();
  expect(PAYLOADS.every((p) => logText.includes(p.replace('\u202e', ''))), 'every payload shows as literal text, direction override removed');
  const carried = app.locator('.chat-msg', { hasText: SAID_WITH }).locator('.chat-mention');
  expect(await carried.count() === 1 && await carried.innerText() === TOPIC, 'a mentioned game shows its title as text, once');
  expect(await app.locator('.chat-msg', { hasText: 'play this one' }).locator('.chat-mention').count() === 0, 'a game the server does not know is no mention');
  expect((await app.locator('.chat-people').innerText()).includes(NICK), 'account names show as text');
  expect(await injected(app, '.chat-window') === 0, 'no payload became an element in the chat');
  ok('the chat shows every payload as text');

  // ── The admin console ──────────────────────────────────────────────────────
  if (evil.w) evil.w.send(JSON.stringify({ t: 'report', id: 99, member: evil.room?.members?.find((m) => m.nick === NICK)?.id }));
  const adminCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const admin = await adminCtx.newPage();
  await watch(admin);
  const cdp = await adminCtx.newCDPSession(admin);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  // A passkey's site must be a name, never an IP address: the console opens at localhost.
  await admin.goto(`http://localhost:${CHAT_PORT}/admin`);
  await admin.fill('#setup-key', SETUP_KEY);
  await admin.click('#setup-form button[type=submit]');
  await admin.waitForURL(/\/admin(#.*)?$/, { timeout: 10_000 });
  // The players list: every account name, payloads included, as text.
  await admin.click('.tab[data-tab="players"]');
  await admin.locator('#player-rows tr').first().waitFor({ timeout: 10_000 });
  const players = await admin.locator('#player-rows').innerText();
  expect(players.includes(NICK) && players.includes(VICTIM), 'the players list shows payload names as text');
  await admin.locator('#player-rows tr', { hasText: NICK }).click();
  await admin.locator('#player-detail h2', { hasText: NICK }).waitFor({ timeout: 10_000 });
  expect(await injected(admin, '#tab-players') === 0, 'and neither the list nor a player\'s page turns a payload into an element');
  await admin.click('.tab[data-tab="live"]');
  await admin.locator('#room-list .room-item').first().waitFor({ timeout: 10_000 });
  await admin.waitForTimeout(500);
  const feed = await admin.locator('#feed').innerText();
  expect(PAYLOADS.slice(0, 11).every((p) => feed.includes(p)), 'the live feed shows every payload as text');
  const online = admin.locator('#online-users');
  expect((await online.innerText()).includes(NICK), 'the admin online list shows nickname payloads as text');
  expect((await online.innerText()).includes('Liar'), 'the admin online list covers everyone');
  expect(await online.locator('b, i').count() === 0, 'online nicknames never become HTML in the admin');
  expect(feed.includes(TOPIC), 'and a mentioned game, as text');
  await online.getByRole('button', { name: NICK, exact: true }).click();
  expect(await admin.locator('#room-name').innerText() === 'C64 READY', 'selecting an online name opens the channel');
  await admin.waitForTimeout(300);
  expect(await injected(admin, 'main') === 0, 'no payload became an element in the console');
  ok('the admin console shows every payload as text');

  const newcomer = await attacker('Online guest', []);
  const guestButton = online.getByRole('button', { name: 'Online guest', exact: true });
  await guestButton.waitFor();
  expect(await guestButton.count() === 1, 'a joined user appears in the admin online list');
  newcomer.w.close();
  await guestButton.waitFor({ state: 'detached' });
  expect((await admin.locator('#members .away').innerText()).includes('Online guest'), 'a disconnected member keeps their place but is absent from online users');
  const resumed = await attacker(null, [], newcomer.token, newcomer.acct);
  await guestButton.waitFor();
  expect(await guestButton.count() === 1, 'a reconnecting user appears exactly once');

  const temporary = await attacker('Temporary', []);
  const temporaryButton = online.getByRole('button', { name: 'Temporary', exact: true });
  await temporaryButton.waitFor();
  temporary.w.send(JSON.stringify({ t: 'leave', id: 50 }));
  await temporaryButton.waitFor({ state: 'detached' });
  expect(await temporaryButton.count() === 0, 'leaving removes the online user');
  temporary.w.close();
  // Last: a removal keeps the address out for an hour, and every socket here shares one.
  await admin.locator('#members li', { hasText: 'Online guest' }).getByRole('button', { name: 'kick', exact: true }).click();
  await guestButton.waitFor({ state: 'detached' });
  expect(await guestButton.count() === 0, 'a removed user disappears from online users');
  resumed.w.close();
  ok('the admin online list follows joins, disconnects, reconnects, removal and leaving');

  for (const [name, page] of [['chat', app], ['admin console', admin]]) {
    expect(await pwned(page) === null, `no payload ran in the ${name}`);
    expect(page.dialogs.length === 0, `no payload opened a dialog in the ${name} (${page.dialogs.join(', ')})`);
  }
  ok('no payload ran anywhere');

  evil.w?.close(); lying.w?.close();
} catch (e) {
  current.push(`threw: ${e.message}`);
  ok('the injection run');
} finally {
  await browser.close();
  await vite.close();
  chat.close();
  chatHttp.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nall ${testNo} passed`);
