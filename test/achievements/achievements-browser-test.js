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
  // The trophy HUD heads the tab, as in Retro Vibes: a slot per achievement, the count, the chase.
  const items = await game.locator('.ach-trophies li').count();
  const summary = await game.locator('.ach-hud-card .ach-hud-words small').textContent();
  expect(items === 22, `the tab shows every one of Uridium's 22 trophies (got ${items})`);
  expect(/^0 \/ \d+ pts · 0 of 22$/.test(summary), `with the points and the count unlocked (got "${summary}")`);
  expect(await game.locator('.ach-hud-card .ach-hud-slot').count() === 22 && await game.locator('.ach-hud-card .ach-hud-slot.is-got').count() === 0, 'and a HUD slot per achievement, none lit');
  expect(await game.locator('.ach-hud-card .ach-hud-slot.is-next').count() === 1 && await game.locator('.ach-trophies li.is-next').count() === 1, 'the next one to get is marked, in the HUD and in the list');
  expect(await game.locator('.ach-hud-card .ach-hud-chase').count() === 1, 'and the chase of the board');
  const head = await game.locator('.ach-screen:not(.ach-fame) .ach-screen-head span').allTextContents();
  expect(head.length === 1 && head[0] === 'Hiscores', `and its high-score screen, headed HISCORES alone, since the game is named above it (got ${JSON.stringify(head)})`);
  await game.locator('.ach-screen-foot', { hasText: /NO SCORES YET|PLAYER/ }).first().waitFor({ timeout: 10_000 });
  // The HUD's high-score screen button, left of refresh, shows attract mode over the window. Space continues.
  const titleButtons = await game.locator('.ach-hud-card .ach-hud-id button').evaluateAll((bs) => bs.map((b) => (b.classList.contains('ach-attract-btn') ? 'attract' : b.classList.contains('ach-refresh-btn') ? 'refresh' : 'other')));
  expect(titleButtons.join() === 'attract,refresh', `the high-score screen's button sits left of refresh (got ${titleButtons})`);
  await game.locator('.ach-attract-btn').click();
  const shown = await page.locator('body > .ach-attract .ach-attract-title').waitFor({ timeout: 10_000 }).then(() => true, () => false);
  expect(shown && (await page.locator('.ach-attract-title').getAttribute('aria-label')) === 'Hiscores', 'it shows the game\'s high-score screen over the window, its board first');
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  expect(await page.locator('.ach-attract').count() === 0, 'Space continues');
  await page.click('#btn-online-close');
  fs.rmSync(tmp, { recursive: true, force: true });
  ok('loading the cartridge finds its set, and the window opens on it');

  // 3. The machine runs the game with the engine reading every frame.
  await page.waitForTimeout(6000);
  await page.click('#btn-online');
  const after = await game.locator('.ach-hud-card .ach-hud-words small').textContent();
  await page.click('#btn-online-close');
  expect(errors.length === 0, `no page errors while the game runs (got ${errors.slice(0, 2).join(' | ')})`);
  expect(after.endsWith('0 of 22'), `with nobody playing, nothing unlocks (got "${after}")`);
  ok('the game runs with achievements armed');

  // 3b. Options ▸ Other ▸ ACHIEVEMENTS off lets the game go and says so; on finds it again.
  const toggle = () => page.evaluate(() => { document.getElementById('btn-achievements-toggle').click(); return document.getElementById('btn-achievements-toggle').textContent.replace(/\s+/g, ' ').trim(); });
  expect(await toggle() === 'ACHIEVEMENTS: OFF', 'the Options button turns achievements off');
  expect(await page.evaluate(() => localStorage.getItem('c64emu.achievements')) === 'off', 'and remembers it');
  await page.click('#btn-online');
  await page.click('#online-tab-game');
  expect(await game.locator('.ach-game-title').first().textContent() === 'Achievements are off', 'the GAME tab says achievements are off, with the game still loaded');
  expect(await toggle() === 'ACHIEVEMENTS: ON', 'and back on');
  await game.locator('.ach-hud-card').waitFor({ timeout: 10_000 }).catch(() => {});
  expect(/of 22/.test(await game.locator('.ach-hud-card .ach-hud-words small').textContent().catch(() => '')), 'turning them on finds the loaded game again');
  await page.click('#btn-online-close');
  ok('achievements turn off and on from Options');

  // 4. What the player earns shows in the activity feed, linked to the profile.
  const hash = '4255c6e2bd6ebe048dfef457a920d565';
  const posted = await page.evaluate(async (h) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('c64emu.account.token')}` };
    const u = await fetch(`/api/games/${h}/unlocks`, { method: 'POST', headers, body: JSON.stringify({ achievementId: 1, hardcore: true }) });
    const s = await fetch(`/api/games/${h}/leaderboards/1/entries`, { method: 'POST', headers, body: JSON.stringify({ value: 12345, hardcore: true }) });
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
  expect(rows.some((r) => /^Pilot scored 012345 in Uridium$/.test(r)), 'and the new best, in the leaderboard\'s format');
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
  expect(/Hiscores012345, 1st/.test(profile), 'and the best score with its rank');
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
  const gameRows = await gamesTab.locator('.ach-card').evaluateAll((els) => els.map((c) => ({ title: c.querySelector('.ach-games-title')?.textContent, count: c.querySelector('.ach-card-count')?.textContent, bar: !!c.querySelector('.ach-card-bar') })));
  expect(gameRows.every((r) => r.title && r.count), 'every row shows a title and a count');
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
  const order = await gamesTab.locator('.ach-card .ach-games-title').allTextContents();
  const rest = order.slice(1);
  expect(/Uridium/.test(order[0] ?? ''), `the loaded game comes first (got ${order[0]})`);
  expect(rest.every((t, i) => i === 0 || rest[i - 1].localeCompare(t, undefined, { sensitivity: 'base' }) <= 0), 'and the rest follow alphabetically');
  const ordered = await page.evaluate(async () => {
    const { gameOrder } = await import('/src/achievements/browse.js');
    const g = (title, achievements, mine) => ({ title, hash: title, achievements, ...(mine ? { mine } : {}) });
    return gameOrder([g('Alpha', 10), g('Bravo', 10, { unlocked: 2 }), g('Charlie', 4, { unlocked: 2 }), g('Delta', 0, { unlocked: 0, last: 1 }),
      g('Echo', 20, { unlocked: 10 }), g('Foxtrot', 10, { unlocked: 9 }), g('Golf', 10)], 'Golf').map((x) => x.title).join();
  });
  expect(ordered === 'Golf,Foxtrot,Charlie,Echo,Bravo,Delta,Alpha', `played games go by the share of their achievements unlocked, most first, ties by title (got ${ordered})`);
  await filter.fill('uridium');
  const card = gamesTab.locator('.ach-card', { hasText: 'Uridium' });
  expect(await card.evaluate((el) => el.classList.contains('is-loaded')) && /LOADED/.test(await card.textContent()), 'the loaded game\'s card is marked LOADED');
  expect(await card.locator('.ach-card-count').textContent() === '1/22' && await card.locator('.ach-card-bar').count() === 1, 'and shows the account\'s own progress, with its meter');
  const when = card.locator('em.ach-card-when');
  expect(/^\(last played (just now|\d+m ago)\)$/.test(await when.textContent()), `and when the account last played it (got ${JSON.stringify(await when.textContent())})`);
  const placed = () => card.locator('.ach-card-name').evaluate((cell) => {
    const [t, n, c] = [cell.querySelector('.ach-games-title'), cell.querySelector('.ach-card-when'), cell].map((x) => x.getBoundingClientRect());
    return { beside: Math.abs(n.bottom - t.bottom) < 3 && n.bottom <= c.bottom + 1, hidden: n.top >= c.bottom - 1 };
  });
  const narrow = await placed();
  expect(narrow.beside || narrow.hidden, `the note sits beside the title or out of sight, never cut in half (${JSON.stringify(narrow)})`);
  const winWidth = await page.locator('#online-window').evaluate((w) => w.style.width);
  await page.locator('#online-window').evaluate((w) => { w.style.width = '700px'; });
  expect((await placed()).beside, 'and beside the title where the window has room');
  await page.locator('#online-window').evaluate((w, v) => { w.style.width = v; }, winWidth);
  await card.click();
  await detail.locator('h3', { hasText: 'Uridium' }).waitFor({ timeout: 10_000 });
  expect(await detail.locator('.achievements-list li.is-unlocked').count() === 1 && await detail.locator('.achievements-list li').count() === 22, 'the game page marks 1 of its 22 achievements unlocked');
  expect(await detail.locator('.ach-screen:not(.ach-fame) li.is-me').count() === 1, 'and the account\'s own row on the high-score screen');
  const fame = detail.locator('.ach-fame');
  expect(await fame.locator('.ach-screen-head').innerText() === 'TROPHY HUNTERS' || /trophy hunters/i.test(await fame.locator('.ach-screen-head').innerText()), 'Trophy Hunters follows it');
  const mineFame = fame.locator('li.is-me');
  expect(/PILOT/i.test(await mineFame.innerText().catch(() => '')) && await mineFame.locator('.ach-fame-bar').getAttribute('aria-label').catch(() => '') === '1 of 22 achievements', 'with the account\'s own row lit, its meter at 1 of 22 unlocked');
  const podium = await detail.locator('.ach-screen li').evaluateAll((lis) => lis.map((li) => ({ rank: parseInt(li.querySelector('.ach-rank')?.textContent, 10), top: li.classList.contains('is-podium'), font: getComputedStyle(li).fontFamily })));
  expect(podium.every((r) => r.top === (r.rank <= 3) && /PetMe64/.test(r.font) === r.top), `the top three in the C64 face, the rest in the regular one (${JSON.stringify(podium)})`);
  // The cartridge loaded above is in the LOAD library, so the page offers to load it, before the info button.
  const load = detail.locator('.ach-game-top .ach-load-btn');
  await load.waitFor({ timeout: 10_000 }).catch(() => {});
  const line = await detail.locator('.ach-game-top button').evaluateAll((bs) => bs.map((b) => b.className));
  expect(/ach-load-btn/.test(line[0] ?? '') && /ach-info-btn/.test(line[1] ?? '') && !/ach-load-btn/.test(line[1]), `a game whose file is in the library has a load button on its title line, left of the info button (${JSON.stringify(line)})`);
  await page.evaluate(() => { window.__mediaChanges = 0; addEventListener('c64-media', () => { window.__mediaChanges++; }); });
  await load.click();
  await page.waitForFunction(() => window.__mediaChanges > 0, null, { timeout: 10_000 }).catch(() => {});
  expect(await page.evaluate(() => window.__mediaChanges) > 0 && /uridium/i.test(await page.locator('#crt-label').textContent().catch(() => '')), 'and the button loads that file');
  const info = detail.locator('.ach-game-top .ach-info-btn[aria-controls]');
  const versions = detail.locator('.ach-versions');
  expect(await versions.isHidden() && await info.getAttribute('aria-expanded') === 'false', 'which version the set is for waits behind the info button on the title line');
  await info.click();
  expect(await versions.isVisible() && /OneLoad64/.test(await versions.textContent()) && await info.getAttribute('aria-expanded') === 'true', 'and the button opens it under the title');
  const about = versions.locator('a.ach-about');
  expect(await about.innerText() === 'About the game' && await about.getAttribute('href') === 'https://www.lemon64.com/game/uridium' && await about.getAttribute('target') === '_blank' && /noopener/.test(await about.getAttribute('rel')), 'ending with About the game, the game\'s page on Lemon64 in a new window');
  await info.click();
  expect(await versions.isHidden(), 'and closes it again');
  await page.keyboard.press('Escape');
  expect(await detail.isHidden() && !(await win.isHidden()), 'Escape steps back before it closes the window');
  await page.waitForFunction(() => document.getElementById('achievements-games-filter')?.value === 'uridium', null, { timeout: 5000 }).catch(() => {});
  await page.keyboard.press('Escape');
  expect(await filter.inputValue() === '' && !(await win.isHidden()), 'back on GAMES, Escape clears the filter it left there');
  await page.keyboard.press('Escape');
  expect(await win.isHidden(), 'and then closes the window');
  ok('the list of games and a game\'s page');

  // 6a. Lazy: each tab fetches once, and showing it again, or opening the window again, fetches
  // nothing until something has changed.
  await page.click('#btn-online');
  for (const t of ['game', 'activity', 'games']) { await page.click(`#online-tab-${t}`); await page.waitForTimeout(700); }
  const asked = [];
  const count = (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) asked.push(new URL(r.url()).pathname); };
  page.on('request', count);
  for (const t of ['game', 'activity', 'games', 'game', 'activity']) { await page.click(`#online-tab-${t}`); await page.waitForTimeout(300); }
  await page.click('#btn-online-close'); await page.click('#btn-online'); await page.waitForTimeout(700);
  page.off('request', count);
  expect(!asked.length, `tabs already loaded show again without fetching (got ${asked.join(', ')})`);
  await page.click('#btn-online-close');
  ok('the tabs load lazily');

  // 6b. A feed longer than a page: LOAD MORE brings the next, older page. Pilot
  // unlocks 30 more achievements in three bursts of ten, the most one account
  // may post at once, waiting for the limit to refill in between.
  const bombJack = '9f27d4a5ea48e17610fba4ae4e5ca795';
  const unlockAll = (list) => page.evaluate(async (items) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('c64emu.account.token')}` };
    let okay = 0;
    for (const [h, id] of items) okay += (await fetch(`/api/games/${h}/unlocks`, { method: 'POST', headers, body: JSON.stringify({ achievementId: id, hardcore: true }) })).ok ? 1 : 0;
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
