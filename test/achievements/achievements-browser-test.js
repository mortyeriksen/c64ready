// Achievements in the real app (src/achievements/), in a browser: the app on
// its own Vite dev server, whose /api serves the accounts and the sets in
// server/sets/. Loading the OneLoad64 Uridium cartridge through the cartridge
// input finds its set, the Achievements window lists it, and the machine runs
// with the engine reading every frame. The public views follow what the
// account earned: the activity feed, the player's profile, the list of games
// and the game's page, linked by name and title.
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
const context = await browser.newContext();
await context.addInitScript(([port, cache]) => {
  try {
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.chat.server', `ws://localhost:${port}/chat`);
    for (const [k, v] of Object.entries(cache)) localStorage.setItem(k, v);
  } catch { /* storage blocked */ }
}, [freePort, romCache]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

const account = page.locator('#achievements-account');
const game = page.locator('#achievements-game');
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('btn-online') && !document.getElementById('btn-power')?.disabled, null, { timeout: 30_000 });
  await page.evaluate(() => { document.querySelector('.splash-overlay, #splash')?.remove(); const m = document.getElementById('setup-modal'); if (m) m.hidden = true; });

  // 1. Sign up, so unlocks would be saved.
  await page.click('#btn-online');
  await page.locator('#achievements-new-name').fill('Pilot');
  await account.locator('button[type=submit]').click();
  await account.locator('.achievements-signed-in').waitFor({ timeout: 10_000 });
  expect((await game.locator('.achievements-note').first().textContent()).startsWith('No game with achievements is loaded.'), 'before a game is loaded, the window says so');
  await page.evaluate(() => document.getElementById('btn-achievements-toggle').click());
  expect(await game.locator('.ach-game-title').first().textContent() === 'Achievements are off', 'turned off in Options, the open window says so at once');
  await page.evaluate(() => document.getElementById('btn-achievements-toggle').click());
  expect(await game.locator('.ach-game-title').first().textContent() === 'No game loaded', 'and turned on again, at once too');
  await page.click('#btn-online-close');
  ok('signed in, with no game loaded');

  // 2. The Uridium cartridge: its set is found and listed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64crt-'));
  const crt = path.join(tmp, 'Uridium.crt');
  fs.copyFileSync(uridium, crt);
  await page.setInputFiles('#crt-input', crt);
  await page.waitForFunction(() => window.c64?.cartridgeInserted, null, { timeout: 20_000 });
  // A game with achievements opens the window on its GAME tab by itself.
  await game.locator('h3', { hasText: 'Uridium' }).waitFor({ timeout: 15_000 });
  expect(await page.locator('#online-window').isVisible() && await page.locator('#online-tab-game').getAttribute('aria-selected') === 'true', 'loading the game opens the window on its achievements');
  const items = await game.locator('.achievements-list li').count();
  const summary = await game.locator('.ach-progress').textContent();
  expect(items === 22, `the dialog lists Uridium's 22 achievements (got ${items})`);
  expect(/^0 of 22 unlocked0 of \d+ points$/.test(summary), `with the count unlocked (got "${summary}")`);
  expect(await game.locator('.ach-meter span').count() === 22 && await game.locator('.ach-meter span.is-lit').count() === 0, 'and a meter cell per achievement, none lit');
  const head = await game.locator('.ach-screen:not(.ach-fame) .ach-screen-head span').allTextContents();
  expect(head.length === 1 && head[0] === 'Hiscores', `and its high-score screen, headed HISCORES alone, since the game is named above it (got ${JSON.stringify(head)})`);
  await game.locator('.ach-screen-foot', { hasText: /NO SCORES YET|PLAYER/ }).first().waitFor({ timeout: 10_000 });
  await page.click('#btn-online-close');
  fs.rmSync(tmp, { recursive: true, force: true });
  ok('loading the cartridge finds its set, and the window opens on it');

  // 3. The machine runs the game with the engine reading every frame.
  await page.waitForTimeout(6000);
  await page.click('#btn-online');
  const after = await game.locator('.ach-progress').textContent();
  await page.click('#btn-online-close');
  expect(errors.length === 0, `no page errors while the game runs (got ${errors.slice(0, 2).join(' | ')})`);
  expect(after.startsWith('0 of 22 unlocked'), `with nobody playing, nothing unlocks (got "${after}")`);
  ok('the game runs with achievements armed');

  // 3b. Options ▸ Other ▸ ACHIEVEMENTS off lets the game go and says so; on finds it again.
  const toggle = () => page.evaluate(() => { document.getElementById('btn-achievements-toggle').click(); return document.getElementById('btn-achievements-toggle').textContent.replace(/\s+/g, ' ').trim(); });
  expect(await toggle() === 'ACHIEVEMENTS: OFF', 'the Options button turns achievements off');
  expect(await page.evaluate(() => localStorage.getItem('c64emu.achievements')) === 'off', 'and remembers it');
  await page.click('#btn-online');
  await page.click('#online-tab-game');
  expect(await game.locator('.ach-game-title').first().textContent() === 'Achievements are off', 'the GAME tab says achievements are off, with the game still loaded');
  expect(await toggle() === 'ACHIEVEMENTS: ON', 'and back on');
  await game.locator('.ach-progress').waitFor({ timeout: 10_000 }).catch(() => {});
  expect(/unlocked/.test(await game.locator('.ach-progress').textContent().catch(() => '')), 'turning them on finds the loaded game again');
  await page.click('#btn-online-close');
  ok('achievements turn off and on from Options');

  // 4. What the player earns shows in the activity feed, linked to the profile.
  const hash = '4255c6e2bd6ebe048dfef457a920d565';
  const posted = await page.evaluate(async (h) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('c64emu.account.token')}` };
    const u = await fetch(`/api/games/${h}/unlocks`, { method: 'POST', headers, body: JSON.stringify({ achievementId: 1 }) });
    const s = await fetch(`/api/games/${h}/leaderboards/1/entries`, { method: 'POST', headers, body: JSON.stringify({ value: 12345 }) });
    return [u.status, s.status];
  }, hash);
  expect(posted.join() === '200,200', `the unlock and the score are accepted (got ${posted})`);
  const win = page.locator('#online-window');
  await page.click('#btn-online');
  await page.click('#online-tab-activity');
  const feed = page.locator('#achievements-activity');
  await feed.locator('.achievements-activity-item').first().waitFor({ timeout: 10_000 });
  const rows = await feed.locator('.achievements-activity-item .achievements-activity-text').allTextContents();
  expect(rows.some((r) => /^Pilot unlocked Zinc in Uridium$/.test(r)), `the feed shows the unlock (got ${JSON.stringify(rows)})`);
  expect(await feed.locator('.ach-event.is-unlock .ach-pts').first().textContent() === '+5', 'with its points');
  expect(rows.some((r) => /^Pilot scored 012345 on High Score in Uridium$/.test(r)), 'and the new best, in the leaderboard\'s format');
  await feed.locator('.achievements-scope', { hasText: 'URIDIUM' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#achievements-activity .achievements-activity-text')].every((r) => !r.textContent.includes(' in Uridium')), null, { timeout: 10_000 }).catch(() => {});
  const scoped = await feed.locator('.achievements-activity-text').allTextContents();
  expect(scoped.length === 2 && scoped.every((r) => !r.includes(' in Uridium')), 'the game\'s own feed leaves out the game\'s name');
  ok('the activity feed');

  // 5. A name opens the profile; Back returns to the feed.
  await feed.locator('.ach-player', { hasText: 'Pilot' }).first().click();
  const detail = page.locator('#achievements-detail');
  await detail.locator('h3', { hasText: 'Pilot' }).waitFor({ timeout: 10_000 });
  const profile = await detail.textContent();
  expect(/ 5 points\./.test(profile) && /1 of 22 unlocked5 of \d+ points/.test(profile), `the profile counts the points and the game's progress (got "${profile}")`);
  expect(await detail.locator('.ach-meter span.is-lit').count() === 1, 'the meter lights the one unlocked');
  expect(/High Score012345, 1st/.test(profile), 'and the best score with its rank');
  expect(await detail.locator('.achievements-back').textContent() === '‹ Activity', 'the way back names the tab it returns to');
  await detail.locator('.achievements-back').click();
  expect(await detail.isHidden() && await feed.isVisible(), 'Back returns to the feed');
  ok('a player\'s profile');

  // 6. GAMES lists Uridium; its page marks what this account unlocked.
  await page.click('#online-tab-games');
  const gamesTab = page.locator('#achievements-games');
  const filter = gamesTab.locator('#achievements-games-filter');
  await filter.waitFor({ timeout: 10_000 });
  const all = await gamesTab.locator('.ach-games li').count();
  await gamesTab.locator('.ach-games li.is-in').first().waitFor({ timeout: 5000 });
  const lastIn = () => gamesTab.locator('.ach-games li').last().evaluate((li) => li.classList.contains('is-in'));
  expect(!(await lastIn()), 'cards below the fold wait to draw in');
  await gamesTab.locator('.ach-games li').last().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#achievements-games .ach-games li:last-child')?.classList.contains('is-in'), null, { timeout: 5000 }).catch(() => {});
  expect(await lastIn(), 'and draw in once scrolled to');
  const chips = await gamesTab.locator('.ach-chip').evaluateAll((els) => els.filter((c) => !c.querySelector('svg.ach-pixel')).length);
  expect(chips === 0, `every chip carries its pixel icon (${chips} without)`);
  await gamesTab.locator('.ach-games li').first().scrollIntoViewIfNeeded();
  const missing =gamesTab.locator('a.ach-games-missing');
  expect(await missing.getAttribute('href') === '/docs/guide-achievements.html#missing-a-game' && await missing.getAttribute('target') === '_blank', '"Missing a game?" opens the guide\'s section in a new tab');
  const widths = await page.evaluate(() => [document.getElementById('achievements-games-filter').getBoundingClientRect().width, document.querySelector('#achievements-games .ach-games-bar').getBoundingClientRect().width]);
  expect(Math.abs(widths[0] - widths[1] / 2) <= 2, `the filter takes half the width (${widths.map(Math.round)})`);
  await filter.fill('URID');
  const titles = await gamesTab.locator('.ach-games-title').allTextContents();
  expect(titles.length === 1 && titles[0] === 'Uridium', `typing filters the games by title, ignoring case (got ${JSON.stringify(titles)} of ${all})`);
  expect(new RegExp(`^1 of ${all} games\\.$`).test(await gamesTab.locator('.ach-games-count').textContent()), 'and says how many match');
  await filter.fill('zzzz');
  expect(await gamesTab.locator('.ach-games li').count() === 0 && await gamesTab.locator('.ach-games-count').textContent() === 'No games match.', 'no match says so');
  await page.keyboard.press('Escape');
  expect(await filter.inputValue() === '' && await gamesTab.locator('.ach-games li').count() === all, 'Esc clears the filter and shows every game again');
  expect(await page.locator('#online-window').isVisible(), 'without closing the window');
  await filter.fill('uridium');
  const card = gamesTab.locator('.ach-card', { hasText: 'Uridium' });
  expect(await card.evaluate((el) => el.classList.contains('is-loaded')) && /LOADED/.test(await card.textContent()), 'the loaded game\'s card is marked LOADED');
  expect(/1 of 22/.test(await card.locator('.ach-card-progress').textContent()), 'and shows the account\'s own progress');
  await card.click();
  await detail.locator('h3', { hasText: 'Uridium' }).waitFor({ timeout: 10_000 });
  expect(await detail.locator('.achievements-list li.is-unlocked').count() === 1 && await detail.locator('.achievements-list li').count() === 22, 'the game page marks 1 of its 22 achievements unlocked');
  expect(await detail.locator('.ach-screen:not(.ach-fame) li.is-me').count() === 1, 'and the account\'s own row on the high-score screen');
  const fame = detail.locator('.ach-fame');
  expect(await fame.locator('.ach-screen-head').innerText() === 'HALL OF FAME' || /hall of fame/i.test(await fame.locator('.ach-screen-head').innerText()), 'the Hall of Fame follows it');
  expect(/PILOT/i.test(await fame.locator('li.is-me').innerText().catch(() => '')) && /1\/22/.test(await fame.locator('li.is-me').innerText().catch(() => '')), 'with the account\'s own row lit, 1 of 22 unlocked');
  expect(/Achievements need this version: OneLoad64/.test(await detail.locator('.ach-source').textContent()), 'and which version of the game the set is for');
  await page.keyboard.press('Escape');
  expect(await detail.isHidden() && !(await win.isHidden()), 'Escape steps back before it closes the window');
  await page.waitForFunction(() => document.getElementById('achievements-games-filter')?.value === 'uridium', null, { timeout: 5000 }).catch(() => {});
  await page.keyboard.press('Escape');
  expect(await filter.inputValue() === '' && !(await win.isHidden()), 'back on GAMES, Escape clears the filter it left there');
  await page.keyboard.press('Escape');
  expect(await win.isHidden(), 'and then closes the window');
  ok('the list of games and a game\'s page');

  // 6b. A feed longer than a page: LOAD MORE brings the next, older page. Pilot
  // unlocks 30 more achievements in three bursts of ten, the most one account
  // may post at once, waiting for the limit to refill in between.
  const bombJack = '9f27d4a5ea48e17610fba4ae4e5ca795';
  const unlockAll = (list) => page.evaluate(async (items) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('c64emu.account.token')}` };
    let okay = 0;
    for (const [h, id] of items) okay += (await fetch(`/api/games/${h}/unlocks`, { method: 'POST', headers, body: JSON.stringify({ achievementId: id }) })).ok ? 1 : 0;
    return okay;
  }, list);
  const wanted = [...Array.from({ length: 21 }, (_, i) => [hash, i + 2]), ...Array.from({ length: 9 }, (_, i) => [bombJack, i + 1])];
  let posted30 = 0;
  for (let i = 0; i < wanted.length; i += 10) {
    await page.waitForTimeout(25_000);   // the limit refills, earlier posts included
    posted30 += await unlockAll(wanted.slice(i, i + 10));
  }
  expect(posted30 === 30, `30 unlocks are posted by three players (got ${posted30})`);
  await page.click('#btn-online');
  await page.click('#online-tab-activity');
  await feed.locator('.achievements-scope', { hasText: 'EVERYONE' }).click().catch(() => {});
  await feed.locator('.achievements-activity-item').first().waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('#achievements-activity .achievements-activity-item').length === 30, null, { timeout: 10_000 }).catch(() => {});
  const firstPage = await feed.locator('.achievements-activity-item').count();
  const loadMore = feed.locator('button.achievements-more');
  expect(firstPage === 30 && await loadMore.isVisible() && await loadMore.textContent() === 'LOAD MORE', `the feed shows a page of 30 and LOAD MORE (got ${firstPage}, ${posted30} posted, scope ${await feed.locator('.achievements-scope.is-active').textContent().catch(() => 'none')})`);
  if (await loadMore.isVisible()) await loadMore.click();
  await page.waitForFunction(() => document.querySelectorAll('#achievements-activity .achievements-activity-item').length > 30, null, { timeout: 10_000 }).catch(() => {});
  const both = await feed.locator('.achievements-activity-item').count();
  expect(both === 32 && await loadMore.isHidden(), `LOAD MORE adds the older entries, and goes once there are no more (got ${both})`);
  await page.keyboard.press('Escape');
  ok('a long feed loads more a page at a time');

  // 7. On a phone the window would cover the game: the ACHIEVEMENTS button flashes instead.
  {
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phoneCtx.addInitScript(([port, cache]) => {
      try {
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
        localStorage.setItem('c64emu.chat.server', `ws://localhost:${port}/chat`);
        for (const [k, v] of Object.entries(cache)) localStorage.setItem(k, v);
      } catch { /* storage blocked */ }
    }, [freePort, romCache]);
    const phone = await phoneCtx.newPage();
    await phone.goto(BASE, { waitUntil: 'domcontentloaded' });
    await phone.waitForFunction(() => document.getElementById('btn-online') && !document.getElementById('btn-power')?.disabled, null, { timeout: 30_000 });
    await phone.evaluate(() => { document.querySelector('.splash-overlay, #splash')?.remove(); const m = document.getElementById('setup-modal'); if (m) m.hidden = true; });
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'c64crt-'));
    const crt2 = path.join(tmp2, 'Uridium.crt');
    fs.copyFileSync(uridium, crt2);
    await phone.setInputFiles('#crt-input', crt2);
    const flashed = await phone.waitForFunction(() => document.getElementById('btn-online')?.classList.contains('is-flashing'), null, { timeout: 15_000 }).then(() => true, () => false);
    expect(flashed, 'loading the game flashes the ACHIEVEMENTS button');
    expect(await phone.locator('#online-window').isHidden(), 'and leaves the window closed, off the game');
    fs.rmSync(tmp2, { recursive: true, force: true });
    await phoneCtx.close();
    ok('on a phone a game with achievements flashes the ACHIEVEMENTS button');
  }
} finally {
  await browser.close();
  await vite.close();
}
if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - achievements in the app: ${testNo} browser checks`);
