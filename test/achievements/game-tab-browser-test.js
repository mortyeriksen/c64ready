// The GAME tab of the Achievements window as it follows a game being played
// (src/online/window.js), in the real app on its own Vite dev server with the
// accounts and the sets of server/sets/: Uridium from its OneLoad64 cartridge,
// its trophies and its score brought about by writing the memory its set reads.
// An unlock the server has moves only Trophy Hunters, so that alone is fetched
// again, and the tab builds again the card and the trophies that changed and
// leaves its boards as they are. A posted score fetches its board again. An
// unlock made signed out is not on the server, and fetches nothing.
//
// Needs Playwright's Chromium, the ROMs and the uridium-crt asset
// (test/external-assets.json); without them it reports a SKIP.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetPath } from '../external-assets.js';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* reported below */ }
const uridium = assetPath('uridium-crt');
const roms = { kernal: assetPath('kernal'), basic: assetPath('basic'), charRom: assetPath('chargen') };
if (!uridium || Object.values(roms).some((r) => !r)) {
  console.log(`# SKIP ${!uridium ? 'asset uridium-crt' : 'the ROMs'} not found (test/external-assets.json)`);
  process.exit(0);
}
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
const BASE = `http://localhost:${freePort}`;

const romCache = Object.fromEntries(Object.entries(roms).map(([slot, f]) => [`c64emu.rom.${slot}`, fs.readFileSync(f).toString('base64')]));
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await context.addInitScript(([port, cache]) => {
  try {
    for (const k of ['splashSeen', 'themePickerShown', 'achievementsPromoShown', 'equipmentHintShown']) localStorage.setItem(`c64emu.${k}`, '1');
    localStorage.setItem('c64emu.chat.server', `ws://localhost:${port}/chat`);
    for (const [k, v] of Object.entries(cache)) localStorage.setItem(k, v);
  } catch { /* storage blocked */ }
}, [freePort, romCache]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// What the page asks the server for about the game's standings: a board by its number, or Trophy Hunters.
const asked = [];
page.on('request', (r) => {
  if (r.method() !== 'GET') return;
  const m = /\/api\/games\/[0-9a-f]+\/(leaderboards\/\d+|top)\b/.exec(new URL(r.url()).pathname);
  if (m) asked.push(m[1]);
});
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

const account = page.locator('#achievements-account');
const game = page.locator('#achievements-game');
// The set's cells (server/sets/uridium.json): a dreadnought's number in $26 with $96 turning 23 is
// its trophy, and $25 leaving 0 starts the Hiscores board, back at 0 posts it. Each is [cell, from,
// to]: written in turn, a few frames apart, until the page shows `seen`, as the set looks for the
// change and the game writes the cells too.
const poke = (cells, seen) => page.waitForFunction(([cells, seen]) => {
  if (document.querySelector(seen)) return true;
  const ram = window.c64.ram();
  window.__turn = !window.__turn;
  for (const [at, from, to] of cells) ram[at] = window.__turn ? from : to;
  return false;
}, [cells, seen], { timeout: 15_000, polling: 100 }).then(() => true, () => false);
/** Marks the tab's parts, to tell afterwards which were built again. */
const mark = () => game.evaluate((g) => { for (const el of g.querySelectorAll('.ach-hud-card, .ach-screen, .ach-trophies, .ach-trophy')) el._kept = true; });
const kept = () => game.evaluate((g) => ({
  card: !!g.querySelector('.ach-hud-card')._kept,
  board: !!g.querySelector('.ach-screen:not(.ach-fame)')._kept,
  fame: !!g.querySelector('.ach-fame')._kept,
  list: !!g.querySelector('.ach-trophies')._kept,
  trophies: [...g.querySelectorAll('.ach-trophy')].map((t) => !!t._kept),
}));
const settled = async () => { let n; do { n = asked.length; await page.waitForTimeout(700); } while (n !== asked.length); };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('btn-online') && !document.getElementById('btn-power')?.disabled, null, { timeout: 30_000 });
  await page.evaluate(() => { document.querySelector('.splash-overlay, #splash')?.remove(); const m = document.getElementById('setup-modal'); if (m) m.hidden = true; });
  await page.click('#btn-online');
  await page.locator('#achievements-new-name').fill('Pilot');
  await account.locator('button[type=submit]').click();
  await account.locator('.achievements-signed-in').waitFor({ timeout: 10_000 });
  await page.click('#btn-online-close');
  await page.locator('#btn-power').click();
  await page.waitForFunction(() => window.machine && window.c64, null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64crt-'));
  const crt = path.join(tmp, 'Uridium.crt');
  fs.copyFileSync(uridium, crt);
  await page.setInputFiles('#crt-input', crt);
  await page.waitForFunction(() => window.c64?.cartridgeInserted, null, { timeout: 20_000 });
  await game.locator('h3', { hasText: 'Uridium' }).waitFor({ timeout: 15_000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  await game.locator('.ach-screen:not(.ach-fame) .ach-screen-foot', { hasText: 'NO SCORES YET' }).waitFor({ timeout: 10_000 });
  await game.locator('.ach-fame .ach-screen-foot', { hasText: 'NO ONE YET' }).waitFor({ timeout: 10_000 });
  // The game is left to start, so the cells are its own to write no more.
  await page.waitForTimeout(8000);
  await settled();
  expect(asked.join() === 'leaderboards/1,top' || asked.join() === 'top,leaderboards/1', `opening the tab fetches the board and Trophy Hunters, once each (${asked})`);
  ok('the tab opens on the game with its standings');

  // 1. An unlock the server has: Trophy Hunters alone is fetched again, and the board is left as it is.
  asked.length = 0;
  await mark();
  const got = await poke([[0x26, 1, 1], [0x96, 0, 23]], '#achievements-game .ach-hud-slot.is-got');
  expect(got, 'the first dreadnought\'s trophy unlocks');
  await game.locator('.ach-fame li', { hasText: 'Pilot' }).waitFor({ timeout: 10_000 }).catch(() => {});
  await settled();
  expect(asked.length > 0 && asked.every((a) => a === 'top'), `only Trophy Hunters is fetched again (${asked.join() || 'nothing'})`);
  const one = await kept();
  expect(!one.card && !one.fame, `the card and Trophy Hunters are built again (${JSON.stringify({ card: one.card, fame: one.fame })})`);
  expect(one.board, 'the high-score screen is the one that was there');
  // Each trophy as it is now: lit, the next one, or as it was.
  const cards = await game.locator('.ach-trophy').evaluateAll((list) => list.map((t) => (t.classList.contains('is-got') ? 'got' : t.classList.contains('is-next') ? 'next' : 'same')));
  expect(cards[0] === 'got', `the first trophy is lit (${cards[0]})`);
  expect(one.list && cards.every((c, i) => (c === 'same') === one.trophies[i]), `of the trophies, only those unlocked and the next one are built again (${cards.map((c, i) => `${c[0]}${one.trophies[i] ? 'k' : 'n'}`).join(' ')})`);
  expect(cards.includes('same'), 'and some were left as they were');
  const lit = cards.filter((c) => c === 'got').length;
  expect(new RegExp(`pts · ${lit} of 22$`).test(await game.locator('.ach-hud-card .ach-hud-words small').textContent()), 'the card counts what is unlocked');
  expect((await game.locator('.ach-fame li', { hasText: 'Pilot' }).count()) === 1, 'and Trophy Hunters shows the player');
  ok('an unlock fetches Trophy Hunters alone and leaves the boards as they are');

  // 2. A score: it runs in a NOW row, and once posted its board is fetched again.
  asked.length = 0;
  await page.evaluate(() => { window.c64.ram()[0x25] = 0; });
  await page.waitForTimeout(300);
  const started = await poke([[0x25, 3, 3]], '#achievements-game .ach-screen-live');
  expect(started, 'a game starting shows its running score');
  await mark();
  const posted = await poke([[0x25, 0, 0]], '#achievements-game .ach-screen:not(.ach-fame) li.is-me');
  expect(posted, 'the game over posts the score, and the board shows the player\'s row');
  await settled();
  // A game starting may unlock trophies as well, and those fetch Trophy Hunters.
  expect(asked.filter((a) => a !== 'top').join() === 'leaderboards/1', `its board is fetched again, once (${asked.join() || 'nothing'})`);
  const two = await kept();
  expect(!two.board, 'the high-score screen is built again for it');
  expect(await game.locator('.ach-screen-live').count() === 0, 'and the NOW row is gone');
  ok('a posted score fetches its board again');

  // 3. Signed out, an unlock is not on the server: nothing is fetched for it.
  await page.click('#online-tab-account');
  // A new account's recovery code shows first.
  await account.locator('button', { hasText: 'I HAVE SAVED IT' }).click();
  await account.locator('button', { hasText: 'SIGN OUT' }).click();
  await account.locator('#achievements-new-name').waitFor({ timeout: 10_000 });
  await page.click('#online-tab-game');
  await game.locator('.ach-signin-note').waitFor({ timeout: 10_000 });
  await settled();
  expect(await game.locator('.ach-hud-slot.is-got').count() === 0, 'signed out, the account\'s trophy is not shown');
  asked.length = 0;
  await mark();
  const out = await poke([[0x26, 1, 1], [0x96, 0, 23]], '#achievements-game .ach-hud-slot.is-got');
  expect(out, 'the trophy unlocks signed out too');
  await settled();
  expect(asked.length === 0, `nothing is fetched for it (${asked.join() || 'nothing'})`);
  const three = await kept();
  expect(three.board && three.fame && !three.card, `the board and Trophy Hunters are the ones that were there, the card is built again (${JSON.stringify({ board: three.board, fame: three.fame, card: three.card })})`);
  expect(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
  ok('an unlock made signed out fetches nothing');
} finally {
  await browser.close();
  await vite.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - the GAME tab while playing: ${testNo} browser checks`);
