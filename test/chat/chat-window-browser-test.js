// The chat (src/chat/), the CHAT tab of the Achievements window (src/online/), in a
// real browser: the app on its own Vite dev server, which hosts the chat
// server at /chat and the accounts at /api, driven by headless Chromium.
// Nothing connects until the tab is opened, and chatting needs an account
// (signing up through the ACCOUNT tab, with Chromium's virtual authenticator
// as the passkey device). Everyone is in one channel; '@' lists the games with
// achievements, and a mention opens that game under GAMES; on a desktop the window drags, resizes
// and remembers its place; a phone gets it full screen; messages travel both
// ways as plain text; the ACHIEVEMENTS button counts unread messages, whether the
// window is closed or on another tab; a member can be hidden; and signing out
// leaves the chat.
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
process.env.VITE_ACCOUNTS_IN_MEMORY = '1';
const { createServer } = await import('vite');
const vite = await createServer({ root, configFile: `${root}vite.config.js`, logLevel: 'silent', server: { port: freePort, strictPort: true, host: '127.0.0.1' } });
await vite.listen();
// localhost, not 127.0.0.1: a passkey's relying party is a host name.
const BASE = `http://localhost:${freePort}`;

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1460, height: 1000 }, ...opts });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  page.chatSockets = [];
  page.on('websocket', (ws) => { if (ws.url().endsWith('/chat')) page.chatSockets.push(ws.url()); });
  // Past the splash, and on the dev server's own chat, never the production one.
  await page.addInitScript((port) => {
    try {
      localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
      localStorage.setItem('c64emu.chat.server', `ws://localhost:${port}/chat`);
      // This test drags and resizes the window: floating, not the desktop's docked default.
      if (!localStorage.getItem('c64emu.online.dock')) localStorage.setItem('c64emu.online.dock', JSON.stringify({ on: false, w: 400 }));
    } catch { /* storage blocked */ }
  }, freePort);
  return page;
}
async function openApp(page, url = BASE) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('btn-online'), null, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('.splash-overlay, #splash')?.remove());
}
const win = (page) => page.locator('#online-window');
// Signed out, the CHAT tab asks to sign in; its button leads to ACCOUNT, where
// a new account is made, and the chat opens on the lobby.
async function signUpInChat(page, name) {
  await page.locator('.chat-view-signin').waitFor({ state: 'visible' });
  await page.click('.chat-view-signin button');
  await page.locator('#achievements-account').waitFor({ state: 'visible' });
  await page.fill('#achievements-new-name', name);
  await page.click('#achievements-account button[type=submit]');
  await page.locator('#achievements-account .achievements-signed-in').waitFor({ timeout: 10_000 });
  // A new account shows its recovery code once, until it is saved.
  await page.locator('#achievements-account button', { hasText: 'I HAVE SAVED IT' }).click();
  await page.click('#online-tab-chat');
  await page.locator('.chat-view-channel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => /online/.test(document.querySelector('.chat-status')?.textContent || ''), null, { timeout: 10_000 });
}
async function openChat(page) {
  await page.click('#btn-online');
  await win(page).waitFor({ state: 'visible', timeout: 15_000 });
  await page.click('#online-tab-chat');
}

const desktop = await newPage();
const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
try {
  // ── Nothing until asked ────────────────────────────────────────────────────
  await openApp(desktop);
  await desktop.waitForTimeout(500);
  expect(desktop.chatSockets.length === 0, 'the app does not contact the chat server before the chat is opened');
  expect(await desktop.locator('.chat-bar').count() === 0, 'the chat is not built before it is opened');
  ok('the chat stays out of the app until someone opens it');

  // ── Signing in, and a message that mentions a game ─────────────────────────
  await desktop.click('#btn-online');
  await win(desktop).waitFor({ state: 'visible' });
  await desktop.waitForTimeout(300);
  expect(desktop.chatSockets.length === 0, 'opening the window on another tab does not contact the chat server');
  await desktop.click('#online-tab-chat');
  await desktop.locator('.chat-view-signin').waitFor({ state: 'visible' });
  expect(await desktop.locator('.chat-view-signin').isVisible(), 'signed out, the chat asks to sign in');
  await desktop.waitForTimeout(300);
  expect(desktop.chatSockets.length === 0, 'and does not connect');
  await signUpInChat(desktop, 'Hostess');
  expect(desktop.chatSockets.length === 1, 'signed in, the chat makes one connection');
  expect(await desktop.locator('.chat-status').innerText() === '1 online', 'and shows who is online');
  const input = desktop.locator('.chat-compose .chat-input');
  await input.click();
  await input.pressSequentially('Anyone playing @comm');
  const list = desktop.locator('.chat-mentions');
  await list.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const offered = await list.locator('.chat-mention-pick').allInnerTexts();
  expect(offered.some((t) => /^Commando\b/.test(t)) && offered.some((t) => /Commando Arcade/.test(t)), `typing @ and a title's start lists the matching games (got ${JSON.stringify(offered)})`);
  await desktop.keyboard.press('Enter');
  expect(await input.inputValue() === 'Anyone playing @Commando ' && await list.isHidden(), 'Enter puts the game in the message, and the list closes');
  await input.pressSequentially('today?');
  await desktop.keyboard.press('Enter');
  const mine = desktop.locator('.chat-msg', { hasText: 'Anyone playing' });
  await mine.waitFor({ timeout: 5000 });
  const mention = mine.locator('.chat-mention');
  expect(await mention.count() === 1 && await mention.innerText() === 'Commando', 'the message shows the game as a link');
  expect(await desktop.locator('.chat-attach').count() === 0, 'there is no SHARE button any more');
  await input.pressSequentially('@zzzz');
  expect(await list.isHidden(), 'a name no game has lists nothing');
  await input.fill('');
  ok('signed in, everyone is in one channel, and @ mentions a game');

  // ── Desktop window: drag, resize, remember ─────────────────────────────────
  const before = await win(desktop).boundingBox();
  const headBox = await desktop.locator('#online-window .float-head').boundingBox();
  await desktop.mouse.move(headBox.x + 40, headBox.y + headBox.height / 2);
  await desktop.mouse.down();
  await desktop.mouse.move(headBox.x - 160, headBox.y + headBox.height / 2 + 60, { steps: 5 });
  await desktop.mouse.up();
  const moved = await win(desktop).boundingBox();
  expect(Math.abs(moved.x - (before.x - 200)) <= 2 && Math.abs(moved.y - (before.y + 60)) <= 2, 'dragging the title bar moves the window');
  const se = await desktop.locator('#online-window > .float-resize-se').boundingBox();
  await desktop.mouse.move(se.x + 5, se.y + 5);
  await desktop.mouse.down();
  await desktop.mouse.move(se.x + 85, se.y + 45, { steps: 5 });
  await desktop.mouse.up();
  const sized = await win(desktop).boundingBox();
  expect(Math.abs(sized.width - (moved.width + 80)) <= 2 && Math.abs(sized.height - (moved.height + 40)) <= 2, 'dragging the corner resizes the window');
  const saved = await desktop.evaluate(() => JSON.parse(localStorage.getItem('c64emu.online.rect')));
  expect(saved && Math.abs(saved.w - sized.width) <= 2 && Math.abs(saved.x - sized.x) <= 2, 'the place and size are remembered');
  expect(!(await win(desktop).evaluate((el) => el.classList.contains('is-full'))), 'a desktop window is not full screen');
  ok('on a desktop the window floats, drags, resizes and remembers');

  // ── A phone joins the same channel ─────────────────────────────────────────
  await openApp(phone);
  await openChat(phone);
  const box = await win(phone).boundingBox();
  expect(await win(phone).evaluate((el) => el.classList.contains('is-full')), 'on a phone the window is full screen');
  expect(box.x <= 0.5 && box.width >= 389 && box.height >= 600, `it covers the screen (${Math.round(box.width)}×${Math.round(box.height)})`);
  await signUpInChat(phone, 'Pocket');
  const theirs = phone.locator('.chat-msg', { hasText: 'Anyone playing' });
  await theirs.waitFor({ timeout: 5000 });
  expect(await theirs.evaluate((el) => el.scrollWidth <= el.clientWidth), 'the message and its mention fit on a phone');
  await theirs.locator('.chat-mention').click();
  const page = phone.locator('#online-window .ach-game-title:visible', { hasText: 'Commando' });
  await page.first().waitFor({ timeout: 10_000 }).catch(() => {});
  expect(await phone.locator('#online-tab-games').getAttribute('aria-selected') === 'true' && await page.count() === 1, 'a mention opens the game\'s page under GAMES');
  await phone.locator('.achievements-back').click();
  await phone.locator('#online-tab-chat').click();
  await desktop.waitForFunction(() => document.querySelector('.chat-status')?.textContent === '2 online', null, { timeout: 5000 }).catch(() => {});
  expect(await desktop.locator('.chat-status').innerText() === '2 online', 'the desktop sees the phone come online');
  ok('on a phone the chat fills the screen, in the same channel');

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
  // The author is named as in the activity: their tile, and a link to their profile.
  const chip = got.locator('.ach-player-chip');
  expect(await chip.locator('.ach-tile').count() === 1 && /Pocket/.test(await chip.locator('.ach-player').innerText()), 'the author shows with their tile, as in the activity');
  await chip.locator('.ach-player').click();
  await desktop.locator('#achievements-detail h3', { hasText: 'Pocket' }).waitFor({ timeout: 10_000 }).catch(() => {});
  expect(await desktop.locator('#achievements-detail h3', { hasText: 'Pocket' }).isVisible().catch(() => false), 'and clicking the name opens their profile');
  await desktop.locator('.achievements-back').click();
  ok('messages travel both ways and stay plain text');

  // ── Unread count while closed ──────────────────────────────────────────────
  await desktop.click('#btn-online-close');
  expect(!(await win(desktop).isVisible()), 'closing hides the window');
  await phone.fill('.chat-compose .chat-input', 'hi all');
  await phone.press('.chat-compose .chat-input', 'Enter');
  const badge = (n) => desktop.waitForFunction((want) => { const b = document.querySelector('#btn-online .chat-badge'); return b && !b.hidden && b.textContent === want; }, n, { timeout: 5000 }).catch(() => {});
  await badge('1');
  expect(await desktop.locator('#btn-online .chat-badge').innerText().catch(() => '') === '1', 'the ACHIEVEMENTS button counts a message that arrived while closed');
  expect(/1 unread chat message$/.test(await desktop.locator('#btn-online').getAttribute('aria-label')), 'and says so to a screen reader');
  await desktop.click('#btn-online');
  expect(await desktop.locator('.chat-view-channel').isVisible(), 'reopening goes straight back to the chat');
  expect(await desktop.locator('#btn-online .chat-badge').isHidden(), 'and clears the count');
  expect(await desktop.locator('.chat-msg', { hasText: 'hi all' }).count() === 1, 'with the message that arrived');
  ok('closing keeps you in the chat and the button counts unread messages');

  // ── Unread count while on another tab ──────────────────────────────────────
  await desktop.click('#online-tab-games');
  await phone.fill('.chat-compose .chat-input', 'still there?');
  await phone.press('.chat-compose .chat-input', 'Enter');
  await badge('1');
  expect(await desktop.locator('#btn-online .chat-badge').innerText().catch(() => '') === '1', 'a message counts as unread while another tab shows');
  await desktop.click('#online-tab-chat');
  expect(await desktop.locator('#btn-online .chat-badge').isHidden() && await desktop.locator('.chat-msg', { hasText: 'still there?' }).isVisible(), 'the CHAT tab shows it and clears the count');
  ok('another tab counts unread messages too');

  // ── Hiding a member ────────────────────────────────────────────────────────
  await desktop.click('.chat-room-bar button:has-text("PEOPLE")');
  const pocket = desktop.locator('.chat-person', { hasText: 'Pocket' });
  expect(await pocket.locator('button', { hasText: 'vote to remove' }).count() === 1 && await pocket.locator('button', { hasText: 'report' }).count() === 1, 'a member can be voted out or reported, and no one is host');
  await pocket.locator('button', { hasText: 'hide' }).click();
  expect(await desktop.locator('.chat-notice', { hasText: 'A message from Pocket is hidden.' }).count() > 0, 'hiding a member hides their messages here');
  await desktop.locator('.chat-person', { hasText: 'Pocket' }).locator('button', { hasText: 'show' }).click();
  expect(await desktop.locator('.chat-msg', { hasText: 'still there?' }).count() === 1, 'and showing them brings the messages back');
  ok('a member can be hidden, voted out or reported');

  // ── Signing out leaves the chat ────────────────────────────────────────────
  await desktop.click('#online-tab-account');
  await desktop.locator('#achievements-account button', { hasText: 'SIGN OUT' }).click();
  await desktop.locator('#achievements-account button', { hasText: 'SIGN IN WITH PASSKEY' }).waitFor();
  await desktop.click('#online-tab-chat');
  expect(await desktop.locator('.chat-view-signin').isVisible(), 'signed out, the chat asks to sign in again');
  await phone.waitForFunction(() => document.querySelector('.chat-status')?.textContent === '1 online', null, { timeout: 5000 }).catch(() => {});
  expect(await phone.locator('.chat-status').innerText() === '1 online', 'the account leaves the chat at once rather than lingering as away');
  ok('signing out leaves the chat');

} catch (e) {
  current.push(`threw: ${e.message}`);
  ok('the chat run');
} finally {
  await browser.close();
  await vite.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nall ${testNo} passed`);
