// Nothing anyone types into the chat runs as code: an attacker talking to the
// chat server directly, with none of the app's own limits, fills a room's name,
// topic, nicknames and messages with HTML, script and URL payloads, and a disk
// with such a file name is loaded and offered as a room. The app's chat window
// and the admin console both show it all, and the test fails if any payload
// runs, opens a dialog or turns into an element. A room's LOAD fetches the
// release from Assembly64 itself (mocked here): a file the release does not
// have is refused, and the confirmation names what the catalog says, not what
// the room claims.
//
// Needs Playwright's Chromium. Without it the file reports a SKIP. No ROMs.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createChatServer } from '../../server/chat.mjs';

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
const ROOM_NAME = '<img src=x onerror=__pwned=21>';
const TOPIC = '<svg onload=__pwned=22><script>';
const NICK = '<b onclick=x()>';
const VICTIM = '<i onclick=y()>';
// No "_", "." or brackets, which the title drops, and not all lower case, which
// it would capitalize.
const FILE_TITLE = '<SVG onload=alert`23`>';
const FILE_NAME = `${FILE_TITLE}.d64`;

// The chat server with its console, and the app on a dev server pointed at it.
const PASSWORD = crypto.randomBytes(9).toString('base64url');
const chat = createChatServer({ admin: { user: 'sysop', passwordSha256: crypto.createHash('sha256').update(PASSWORD).digest('hex') } });
const chatHttp = http.createServer((q, r) => { if (!chat.handleRequest(q, r)) r.writeHead(404).end(); });
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
function attacker(steps, token) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}/chat`);
    let i = 0, room = null, said = 0;
    w.onopen = () => w.send(JSON.stringify({ t: 'hello', v: 1, token }));
    w.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.t === 'err') { reject(new Error(`attacker step ${i} refused: ${d.code}`)); return; }
      if (d.t !== 'welcome' && d.t !== 'ok') return;
      if (d.token) token = d.token;
      if (d.room) room = d.room;
      const next = steps[i++];
      if (!next) { resolve({ w, room, token }); return; }
      const msg = { id: i, ...(typeof next === 'function' ? next(room) : next) };
      // Past the server's burst of five messages, one a second.
      const wait = msg.t === 'say' && ++said > 5 ? 1050 : 0;
      setTimeout(() => w.send(JSON.stringify(msg)), wait);
    };
    w.onerror = reject;
  });
}

// Assembly64, mocked: release 42 in category 3 has one file, "real.d64".
const downloads = [];
async function mockAssembly64(ctx) {
  await ctx.route('https://hackerswithstyle.se/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (v) => route.fulfill({ status: 200, body: JSON.stringify(v), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'client-id' } });
    if (p.endsWith('/search/meta/42/3')) return json({ name: 'Real Release', group: 'Real Group' });
    if (p.endsWith('/search/entries/42/3')) return json({ contentEntry: [{ id: '7', path: 'real.d64', size: 174848 }] });
    if (p.includes('/search/bin/')) { downloads.push(p); return route.fulfill({ status: 404, body: '' }); }
    return json([]);
  });
}

function blankD64() {
  const b = new Uint8Array(174848), bam = 0x16500;
  b[bam] = 18; b[bam + 1] = 1; b[bam + 2] = 0x41; b.fill(0xa0, bam + 0x90, bam + 0xab);
  return Buffer.from(b);
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
  // Only the header's static close icon is outside user-controlled content.
  const closeIcon = box.querySelector(':scope > .chat-head > .chat-close > svg');
  return [...box.querySelectorAll('img, script, svg, iframe, object, embed, a, style, details, link')]
    .filter(element => element !== closeIcon).length;
}, scope);

try {
  // ── The attacker's rooms ───────────────────────────────────────────────────
  const evil = await attacker([
    { t: 'create', nick: NICK, name: ROOM_NAME, topic: { title: TOPIC, kind: 'disk', a64: { item: '42', cat: 3, file: '999', name: 'evil.d64' } } },
    ...PAYLOADS.map((text) => ({ t: 'say', text })),
  ]).catch((e) => { current.push(e.message); return {}; });
  const lying = await attacker([
    { t: 'create', nick: 'Liar', name: 'Totally Commando', topic: { title: 'Commando', kind: 'disk', a64: { item: '42', cat: 3, file: '7', name: 'commando.d64' } } },
  ]).catch((e) => { current.push(e.message); return {}; });
  ok('an attacker can put payloads in a room name, topic, nickname and messages');

  // ── The chat window ────────────────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1460, height: 1000 } });
  await mockAssembly64(ctx);
  const app = await ctx.newPage();
  await watch(app);
  await app.addInitScript((port) => {
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.chat.server', `ws://127.0.0.1:${port}/chat`);
  }, CHAT_PORT);
  await app.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'domcontentloaded' });
  await app.waitForFunction(() => document.getElementById('btn-chat'), null, { timeout: 30_000 });
  await app.setInputFiles('#d64-input', { name: FILE_NAME, mimeType: 'application/octet-stream', buffer: blankD64() });
  await app.click('#btn-chat');
  await app.fill('.chat-view-join .chat-input', VICTIM);
  await app.click('.chat-view-join button[type=submit]');
  await app.locator('.chat-room').first().waitFor({ timeout: 10_000 });
  await app.waitForTimeout(300);
  expect(await app.locator('.chat-room-name', { hasText: ROOM_NAME }).count() === 1, 'the lobby shows the payload room name as text');
  expect((await app.locator('.chat-online').innerText()).includes(NICK), 'the lobby shows an online nickname payload as text');
  expect(await app.locator('.chat-online b, .chat-online i').count() === 0, 'online nicknames never become HTML elements');
  const chipText = await app.locator('.chat-chips').innerText();
  expect(chipText.includes(FILE_TITLE), `a file name with markup is offered as text (saw "${chipText}")`);
  await app.locator('.chat-room', { hasText: ROOM_NAME }).locator('button').click();
  await app.locator('.chat-view-room').waitFor({ state: 'visible', timeout: 10_000 });
  await app.click('.chat-room-bar button:has-text("PEOPLE")');
  await app.waitForTimeout(500);
  const logText = await app.locator('.chat-log').innerText();
  expect(PAYLOADS.every((p) => logText.includes(p.replace('\u202e', ''))), 'every payload shows as literal text, direction override removed');
  expect(await app.locator('.chat-title').innerText() === `Chat about ${ROOM_NAME}`, 'the title bar shows the room name as text');
  expect(/<svg onload=__pwned=22><script>/.test(await app.locator('.chat-topic').innerText()), 'the topic shows as text');
  expect((await app.locator('.chat-people').innerText()).includes(NICK), 'nicknames show as text');
  expect(await injected(app, '.chat-window') === 0, 'no payload became an element in the chat window');
  ok('the chat window shows every payload as text');

  // A room of its own from the disk with a payload file name.
  await app.click('.chat-room-bar button:has-text("LEAVE")');
  await app.locator('.chat-chip').first().click();
  await app.locator('.chat-view-room').waitFor({ state: 'visible', timeout: 10_000 });
  expect((await app.locator('.chat-title').innerText()) === `Chat about ${FILE_TITLE}`, 'a room started from that disk is named with the text');
  expect(await injected(app, '.chat-window') === 0, 'and nothing in it became an element');
  ok('a file name with markup stays text all the way into a room');

  // ── LOAD checks the catalog ────────────────────────────────────────────────
  await app.click('.chat-room-bar button:has-text("LEAVE")');
  await app.locator('.chat-room', { hasText: ROOM_NAME }).locator('button').click();
  await app.locator('.chat-view-room').waitFor({ state: 'visible', timeout: 10_000 });
  await app.locator('.chat-topic button').click();
  await app.locator('.chat-notice', { hasText: 'not part of the release' }).waitFor({ timeout: 10_000 });
  expect(downloads.length === 0, 'a file the release does not have is never downloaded');
  await app.click('.chat-room-bar button:has-text("LEAVE")');
  await app.locator('.chat-room', { hasText: 'Totally Commando' }).locator('button').click();
  await app.locator('.chat-view-room').waitFor({ state: 'visible', timeout: 10_000 });
  await app.locator('.chat-topic button', { hasText: 'LOAD COMMANDO' }).click();
  await app.locator('#confirm-modal').waitFor({ state: 'visible', timeout: 10_000 });
  const asked = await app.locator('#confirm-modal-message').innerText();
  expect(/Real Release/.test(asked) && /real\.d64/.test(asked) && !/Commando|commando\.d64/.test(asked), `LOAD asks with the catalog's title and file, not the room's (asked "${asked}")`);
  await app.click('#btn-confirm-cancel');
  await app.waitForTimeout(300);
  expect(downloads.length === 0, 'declining downloads nothing');
  ok("a room's LOAD is checked against Assembly64 and named by it");

  // ── The admin console ──────────────────────────────────────────────────────
  if (evil.w) evil.w.send(JSON.stringify({ t: 'report', id: 99, member: evil.room?.members?.[0]?.id }));
  const adminCtx = await browser.newContext({ viewport: { width: 1400, height: 900 }, httpCredentials: { username: 'sysop', password: PASSWORD } });
  const admin = await adminCtx.newPage();
  await watch(admin);
  await admin.goto(`http://127.0.0.1:${CHAT_PORT}/admin`);
  await admin.locator('#room-list .room-item').first().waitFor({ timeout: 10_000 });
  await admin.waitForTimeout(500);
  const feed = await admin.locator('#feed').innerText();
  expect(PAYLOADS.slice(0, 11).every((p) => feed.includes(p)), 'the live feed shows every payload as text');
  const online = admin.locator('#online-users');
  expect((await online.innerText()).includes(NICK), 'the admin online list shows nickname payloads as text');
  expect((await online.innerText()).includes('Liar'), 'the admin online list covers other rooms too');
  expect(await online.locator('b, i').count() === 0, 'online nicknames never become HTML in the admin');
  await online.getByRole('button', { name: NICK, exact: true }).click();
  expect(await admin.locator('#room-name').innerText() === ROOM_NAME, 'selecting an online nickname opens its room');
  await admin.locator('#room-list .room-item', { hasText: ROOM_NAME }).click();
  await admin.waitForTimeout(300);
  expect((await admin.locator('#room-name').innerText()) === ROOM_NAME, 'the room view shows the name as text');
  expect(await injected(admin, 'main') === 0, 'no payload became an element in the console');
  ok('the admin console shows every payload as text');

  const newcomer = await attacker([{ t: 'join', code: evil.room.code, nick: 'Online guest' }]);
  const guestButton = online.getByRole('button', { name: 'Online guest', exact: true });
  await guestButton.waitFor();
  expect(await guestButton.count() === 1, 'a joined user appears in the admin online list');
  newcomer.w.close();
  await guestButton.waitFor({ state: 'detached' });
  expect((await admin.locator('#members .away').innerText()).includes('Online guest'), 'a disconnected member keeps their room place but is absent from online users');
  const resumed = await attacker([], newcomer.token);
  await guestButton.waitFor();
  expect(await guestButton.count() === 1, 'a reconnecting user appears exactly once');
  await admin.locator('#members li', { hasText: 'Online guest' }).getByRole('button', { name: 'kick', exact: true }).click();
  await guestButton.waitFor({ state: 'detached' });
  expect(await guestButton.count() === 0, 'a removed user disappears from online users');
  resumed.w.close();

  const temporary = await attacker([{ t: 'create', nick: 'Temporary', name: 'Presence room' }]);
  const temporaryButton = online.getByRole('button', { name: 'Temporary', exact: true });
  await temporaryButton.waitFor();
  temporary.w.send(JSON.stringify({ t: 'leave', id: 50 }));
  await temporaryButton.waitFor({ state: 'detached' });
  expect(await admin.locator('#room-list .room-item', { hasText: 'Presence room' }).count() === 0, 'closing a room also removes its online user');
  temporary.w.close();
  ok('the admin online list follows joins, disconnects, reconnects, removal and room closure');

  for (const [name, page] of [['chat window', app], ['admin console', admin]]) {
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
