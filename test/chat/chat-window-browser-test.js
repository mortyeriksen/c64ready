// The chat window (src/chat/) in a real browser: the app on its own Vite dev
// server, which hosts the chat server at /chat, driven by headless Chromium.
// Nothing connects until the chat is opened; a desktop window drags, resizes
// and remembers its place; a phone gets it full screen and joins from the lobby;
// a loaded disk offers a room about it; messages travel both ways; the CHAT
// button counts unread messages; and the host removes a member.
//
// Needs Playwright's Chromium (npx playwright install chromium). Without it the
// file reports a SKIP. No ROMs needed.

import net from 'node:net';
import { fileURLToPath } from 'node:url';

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

const root = fileURLToPath(new URL('../../', import.meta.url));
const freePort = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ root, configFile: `${root}vite.config.js`, logLevel: 'silent', server: { port: freePort, strictPort: true, host: '127.0.0.1' } });
await vite.listen();
const BASE = `http://127.0.0.1:${freePort}`;

// A 35-track D64 whose header names a cracking group, under a file name that
// names the game: the file name should win.
function d64(headerName) {
  const bytes = new Uint8Array(174848);
  const bam = 0x16500;
  bytes[bam] = 18; bytes[bam + 1] = 1; bytes[bam + 2] = 0x41;
  bytes.fill(0xa0, bam + 0x90, bam + 0xab);
  for (let i = 0; i < headerName.length; i++) bytes[bam + 0x90 + i] = headerName.charCodeAt(i);
  bytes[bam + 0xa2] = 0x30; bytes[bam + 0xa3] = 0x31; bytes[bam + 0xa5] = 0x32; bytes[bam + 0xa6] = 0x41;
  bytes[bam + 0x100] = 0; bytes[bam + 0x101] = 0xff;
  return Buffer.from(bytes);
}

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1460, height: 1000 }, ...opts });
  const page = await ctx.newPage();
  page.chatSockets = [];
  page.on('websocket', (ws) => { if (ws.url().endsWith('/chat')) page.chatSockets.push(ws.url()); });
  // Past the splash, and on the dev server's own chat, never the production one.
  await page.addInitScript((port) => {
    try {
      localStorage.setItem('c64emu.splashSeen', '1');
      localStorage.setItem('c64emu.chat.server', `ws://127.0.0.1:${port}/chat`);
    } catch { /* storage blocked */ }
  }, freePort);
  return page;
}
async function openApp(page, url = BASE) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('btn-chat'), null, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('.splash-overlay, #splash')?.remove());
}
const win = (page) => page.locator('.chat-window');

const desktop = await newPage();
const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
try {
  // ── Nothing until asked ────────────────────────────────────────────────────
  await openApp(desktop);
  await desktop.waitForTimeout(500);
  expect(desktop.chatSockets.length === 0, 'the app does not contact the chat server before the chat is opened');
  expect(await desktop.locator('.chat-window').count() === 0, 'the chat window is not built before it is opened');
  ok('the chat stays out of the app until someone opens it');

  // ── A room about the loaded disk ───────────────────────────────────────────
  await desktop.setInputFiles('#d64-input', { name: 'Commando (1985).d64', mimeType: 'application/octet-stream', buffer: d64('FAIRLIGHT') });
  await desktop.click('#btn-chat');
  await win(desktop).waitFor({ state: 'visible' });
  expect(await desktop.locator('.chat-view-join').isVisible(), 'the first open asks for a nickname');
  await desktop.fill('.chat-view-join .chat-input', 'Hostess');
  await desktop.click('.chat-view-join button[type=submit]');
  await desktop.locator('.chat-view-lobby').waitFor({ state: 'visible' });
  const chip = desktop.locator('.chat-chip').first();
  await chip.waitFor({ timeout: 5000 }).catch(() => {});
  const chipText = (await chip.count()) ? await chip.innerText() : '';
  expect(/Commando/.test(chipText) && !/FAIRLIGHT/.test(chipText), `the loaded disk is offered by its file name, not its header (saw "${chipText}")`);
  expect(/drive 8/.test(chipText), 'the chip says where the medium is');
  await chip.click();
  await desktop.locator('.chat-view-room').waitFor({ state: 'visible' });
  expect(await desktop.locator('.chat-title').innerText() === 'Chat about Commando', 'the title bar says what the room is about, named after the disk');
  expect(/About Commando/.test(await desktop.locator('.chat-topic').innerText()) && /loaded/.test(await desktop.locator('.chat-topic').innerText()), 'the topic says it is already loaded here');
  expect(desktop.chatSockets.length === 1, 'opening the chat makes one connection');
  ok('one tap starts a room about what is in the drive');

  // ── Desktop window: drag, resize, remember ─────────────────────────────────
  const before = await win(desktop).boundingBox();
  const headBox = await desktop.locator('.chat-head').boundingBox();
  await desktop.mouse.move(headBox.x + 40, headBox.y + headBox.height / 2);
  await desktop.mouse.down();
  await desktop.mouse.move(headBox.x - 160, headBox.y + headBox.height / 2 + 60, { steps: 5 });
  await desktop.mouse.up();
  const moved = await win(desktop).boundingBox();
  expect(Math.abs(moved.x - (before.x - 200)) <= 2 && Math.abs(moved.y - (before.y + 60)) <= 2, 'dragging the title bar moves the window');
  const se = await desktop.locator('.chat-resize-se').boundingBox();
  await desktop.mouse.move(se.x + 5, se.y + 5);
  await desktop.mouse.down();
  await desktop.mouse.move(se.x + 85, se.y + 45, { steps: 5 });
  await desktop.mouse.up();
  const sized = await win(desktop).boundingBox();
  expect(Math.abs(sized.width - (moved.width + 80)) <= 2 && Math.abs(sized.height - (moved.height + 40)) <= 2, 'dragging the corner resizes the window');
  const saved = await desktop.evaluate(() => JSON.parse(localStorage.getItem('c64emu.chat.rect')));
  expect(saved && Math.abs(saved.w - sized.width) <= 2 && Math.abs(saved.x - sized.x) <= 2, 'the place and size are remembered');
  expect(!(await win(desktop).evaluate((el) => el.classList.contains('is-full'))), 'a desktop window is not full screen');
  ok('on a desktop the window floats, drags, resizes and remembers');

  // ── A phone joins from the lobby ───────────────────────────────────────────
  await openApp(phone);
  await phone.click('#btn-chat');
  await win(phone).waitFor({ state: 'visible', timeout: 15_000 });
  const box = await win(phone).boundingBox();
  expect(await win(phone).evaluate((el) => el.classList.contains('is-full')), 'on a phone the window is full screen');
  expect(box.x <= 0.5 && box.width >= 389 && box.height >= 600, `it covers the screen (${Math.round(box.width)}×${Math.round(box.height)})`);
  await phone.fill('.chat-view-join .chat-input', 'Pocket');
  await phone.click('.chat-view-join button[type=submit]');
  const listed = phone.locator('.chat-room', { hasText: 'Commando' });
  await listed.waitFor({ timeout: 10_000 });
  expect(/1 here/.test(await listed.innerText()), 'the room is listed with its member count');
  expect(await phone.locator('.chat-online').innerText() === 'Hostess', 'the lobby shows who is online before joining');
  expect(!/Hostess/.test(await listed.innerText()), 'nicknames appear separately from the rooms');
  expect(await phone.locator('.chat-online').evaluate((el) => el.scrollWidth <= el.clientWidth), 'online nicknames fit on a phone');
  expect(await listed.evaluate((el) => el.scrollWidth <= el.clientWidth), 'the room and its users fit on a phone');
  await listed.locator('button', { hasText: 'JOIN' }).click();
  await phone.locator('.chat-view-room').waitFor({ state: 'visible', timeout: 10_000 });
  expect(await phone.locator('.chat-title').innerText() === 'Chat about Commando', 'the phone is in the same room');
  ok('on a phone the chat fills the screen, and any room in the lobby can be joined');

  // ── Messages both ways ─────────────────────────────────────────────────────
  await desktop.fill('.chat-compose .chat-input', 'Anyone past level 2?');
  await desktop.press('.chat-compose .chat-input', 'Enter');
  await phone.locator('.chat-msg', { hasText: 'Anyone past level 2?' }).waitFor({ timeout: 5000 });
  await phone.fill('.chat-compose .chat-input', '<b>not bold</b>');
  await phone.click('.chat-compose button[type=submit]');
  const got = desktop.locator('.chat-msg', { hasText: '<b>not bold</b>' });
  await got.waitFor({ timeout: 5000 });
  expect(await got.locator('b').count() === 0, 'a message is shown as text, never as markup');
  expect(/Pocket/.test(await got.locator('.chat-nick').innerText()), 'with its author');
  await desktop.click('.chat-emoji-btn');
  expect(await desktop.locator('.chat-emoji').isVisible(), 'the emoji button opens the picker');
  await desktop.keyboard.press('Escape');
  expect(await desktop.locator('.chat-emoji').isHidden() && await win(desktop).isVisible(), 'Esc closes the picker, not the chat');
  await desktop.fill('.chat-compose .chat-input', 'nice ');
  await desktop.click('.chat-emoji-btn');
  await desktop.click('.chat-emoji-pick[aria-label="joystick"]');
  expect(await desktop.locator('.chat-emoji').isHidden(), 'picking an emoji closes the picker');
  expect(await desktop.locator('.chat-compose .chat-input').inputValue() === 'nice 🕹️', 'the emoji goes in at the cursor');
  await desktop.press('.chat-compose .chat-input', 'Enter');
  await phone.locator('.chat-msg', { hasText: 'nice 🕹️' }).waitFor({ timeout: 5000 });
  ok('messages travel both ways and stay plain text');

  // ── Unread count while closed ──────────────────────────────────────────────
  await desktop.click('.chat-close');
  expect(!(await win(desktop).isVisible()), 'closing hides the window');
  await phone.fill('.chat-compose .chat-input', 'hi all');
  await phone.press('.chat-compose .chat-input', 'Enter');
  await desktop.waitForFunction(() => { const b = document.querySelector('#btn-chat .chat-badge'); return b && !b.hidden && b.textContent === '1'; }, null, { timeout: 5000 }).catch(() => {});
  expect(await desktop.locator('#btn-chat .chat-badge').innerText().catch(() => '') === '1', 'the CHAT button counts a message that arrived while closed');
  await desktop.click('#btn-chat');
  expect(await desktop.locator('.chat-view-room').isVisible(), 'reopening goes straight back to the room');
  expect(await desktop.locator('#btn-chat .chat-badge').isHidden(), 'and clears the count');
  expect(await desktop.locator('.chat-msg', { hasText: 'hi all' }).count() === 1, 'with the message that arrived');
  ok('closing keeps you in the room and the button counts unread messages');

  // ── The host removes a member ──────────────────────────────────────────────
  await desktop.click('.chat-room-bar button:has-text("PEOPLE")');
  desktop.once('dialog', (d) => d.accept());
  const removeLink = desktop.locator('.chat-person', { hasText: 'Pocket' }).locator('button', { hasText: 'remove' });
  await removeLink.click();
  const confirmOk = desktop.locator('#btn-confirm-ok');
  if (await confirmOk.count()) await confirmOk.first().click();
  await phone.locator('.chat-banner', { hasText: 'removed you' }).waitFor({ timeout: 5000 });
  expect(await phone.locator('.chat-view-lobby').isVisible(), 'the removed member is back in the lobby');
  await phone.waitForFunction(() => document.querySelector('.chat-online')?.textContent === 'Hostess');
  expect(!await phone.locator('.chat-online li').filter({ hasText: 'Pocket' }).count(), 'the lobby no longer lists the removed user');
  await phone.locator('.chat-room', { hasText: 'Commando' }).locator('button', { hasText: 'JOIN' }).click();
  await phone.locator('.chat-view-lobby .chat-error', { hasText: 'removed' }).waitFor({ timeout: 5000 });
  ok('the host removes a member, who cannot come back');

} catch (e) {
  current.push(`threw: ${e.message}`);
  ok('the chat window run');
} finally {
  await browser.close();
  await vite.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nall ${testNo} passed`);
