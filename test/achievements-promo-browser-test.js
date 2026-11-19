// The Achievements splash after the theme picker (src/ui/achievements-promo.js): it opens once after
// the picker, shows the Last Ninja board read from the server with an open place for you, loads
// nothing from YouTube until its video is asked for, and TRY IT NOW opens the Achievements window.
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readAsset } from './external-assets.js';
import { PROMO_BOARD, PROMO_VIDEO_ID } from '../src/ui/achievements-promo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// The board shown is a real board of a real set.
const set = JSON.parse(fs.readFileSync(`${root}server/sets/last-ninja.json`, 'utf8'));
assert(set.hashes.some((h) => h.hash === PROMO_BOARD.hash), 'the promo board names The Last Ninja\'s cartridge');
assert.equal(set.leaderboards.find((l) => l.id === PROMO_BOARD.id)?.title, PROMO_BOARD.title, 'the promo board is the Wastelands Speedrun');
console.log('ok  - the promo board is The Last Ninja\'s Wastelands Speedrun');

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
const roms = {};
for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
  const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${slot}`] = bytes.toString('base64');
}
if (Object.keys(roms).length !== 3) { await browser.close(); console.log('ok  - achievements splash # SKIP local C64 ROMs unavailable'); process.exit(0); }
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();
const url = `http://127.0.0.1:${port}`;
const BOARD = {
  leaderboard: { id: 1, title: 'Wastelands Speedrun', format: 'MILLISECS', lowerIsBetter: true },
  entries: [
    { rank: 1, user: { id: 11, name: 'Alpha' }, name: 'Alpha', value: 9123 },
    { rank: 2, user: { id: 12, name: 'Bravo' }, name: 'Bravo', value: 9501 },
    { rank: 3, user: { id: 13, name: 'Charlie' }, name: 'Charlie', value: 10145 },
  ],
  players: 3, me: null,
};

async function context({ board = BOARD, seen = false, noCredentialless = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(({ cache, seen }) => {
    if (window !== window.top) return;
    if (sessionStorage.getItem('promo-test-seeded')) return;
    sessionStorage.setItem('promo-test-seeded', '1');
    for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
    for (const key of ['splashSeen', 'installDismissed', 'themePickerShown']) localStorage.setItem(`c64emu.${key}`, '1');
    if (seen) localStorage.setItem('c64emu.achievementsPromoShown', '1');
  }, { cache: roms, seen });
  // A browser without credentialless frames (Safari, Firefox).
  if (noCredentialless) await ctx.addInitScript(() => { delete HTMLIFrameElement.prototype.credentialless; });
  const youtube = [];
  await ctx.route(/youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com/, (route) => { youtube.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>video</title>' }); });
  await ctx.route(`**/games/${PROMO_BOARD.hash}/leaderboards/${PROMO_BOARD.id}*`, (route) => board
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) })
    : route.abort());
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, youtube, errors };
}

try {
  // After the picker, once: the board, a place for you, and nothing from YouTube yet.
  {
    const { ctx, page, youtube, errors } = await context();
    await page.goto(url, { waitUntil: 'networkidle' });
    const promo = page.locator('.achievements-promo');
    await promo.waitFor();
    const rows = promo.locator('.achievements-promo-row:not(.is-loading)');
    await rows.first().waitFor();
    const names = await promo.locator('.achievements-promo-name').allTextContents();
    assert.deepEqual(names, ['Alpha', 'Bravo', 'Charlie', 'YOU'], 'the top three, then an open place for you');
    assert.match(await promo.locator('.achievements-promo-value').first().textContent(), /^1:31\.23$/, 'times are shown in the board\'s own format (MILLISECS counts hundredths)');
    assert.equal(youtube.length, 0, 'nothing is fetched from YouTube before the video is asked for');
    assert.equal(await promo.locator('iframe').count(), 0, 'no player before the video is asked for');
    await promo.getByRole('button', { name: /Play the video/ }).click();
    const frame = promo.locator('iframe');
    await frame.waitFor();
    assert.equal(new URL(await frame.getAttribute('src')).hostname, 'www.youtube-nocookie.com', 'the video plays from youtube-nocookie.com');
    assert(new URL(await frame.getAttribute('src')).pathname.endsWith(`/embed/${PROMO_VIDEO_ID}`), 'the Last Ninja speedrun video');
    assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'the page is cross-origin isolated');
    assert.equal(await frame.evaluate((f) => f.credentialless), true, 'the frame is credentialless, so COEP require-corp lets it load');
    await promo.getByRole('button', { name: 'MAYBE LATER', exact: true }).click();
    assert.equal(await promo.count(), 0, 'MAYBE LATER closes it');
    assert.equal(await page.evaluate(() => localStorage.getItem('c64emu.achievementsPromoShown')), '1', 'it is marked seen');
    assert.equal(await page.locator('#online-window').isVisible(), false, 'MAYBE LATER does not open the Achievements window');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await promo.count(), 0, 'it opens once');
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('ok  - the splash opens once after the theme picker, shows the board and plays the video only on request');
  }

  // Without credentialless frames, COEP would block the player: the video opens on YouTube in a new tab.
  {
    const { ctx, page, errors } = await context({ noCredentialless: true });
    await page.goto(url, { waitUntil: 'networkidle' });
    const promo = page.locator('.achievements-promo');
    await promo.waitFor();
    const [tab] = await Promise.all([ctx.waitForEvent('page'), promo.getByRole('button', { name: /Play the video/ }).click()]);
    assert.equal(new URL(tab.url()).hostname, 'www.youtube.com', 'the video opens on YouTube');
    assert.equal(new URL(tab.url()).searchParams.get('v'), PROMO_VIDEO_ID, 'the Last Ninja speedrun video');
    assert.equal(await promo.locator('iframe').count(), 0, 'no frame that COEP would block');
    assert.equal(await promo.count(), 1, 'the splash stays open');
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('ok  - without credentialless frames, the video opens on YouTube in a new tab');
  }

  // TRY IT NOW is filled in every built-in theme and mode, with a readable label (WCAG 4.5:1).
  {
    const { ctx, page, errors } = await context({ seen: true });
    await page.goto(url, { waitUntil: 'networkidle' });
    const themes = ['', 'phosphor', 'breadbin', 'geos', 'outrun', 'commando', 'artdeco', 'lookout'];
    const bad = [];
    for (const theme of themes) for (const mode of ['light', 'dark']) {
      await page.evaluate(({ theme, mode }) => { if (theme) localStorage.setItem('c64emu.theme', theme); else localStorage.removeItem('c64emu.theme'); localStorage.setItem('c64emu.appearance', mode); }, { theme, mode });
      await page.goto(`${url}/?ACHIEVEMENTS_PROMO=1`, { waitUntil: 'networkidle' });
      const look = await page.locator('[data-promo-try]').evaluate((b) => {
        const rgb = (c) => { const x = document.createElement('canvas').getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const lum = (c) => { const [r, g, bl] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
        const ratio = (a, c) => { const [hi, lo] = [lum(a), lum(c)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        const s = getComputedStyle(b), later = getComputedStyle(b.previousElementSibling);
        return { label: ratio(s.backgroundColor, s.color), fill: s.backgroundColor !== later.backgroundColor };
      });
      if (look.label < 4.5 || !look.fill) bad.push(`${theme || 'classic'} ${mode}: label ${look.label.toFixed(2)}:1, filled ${look.fill}`);
    }
    assert.deepEqual(bad, [], 'TRY IT NOW is filled and readable in every theme');
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`ok  - TRY IT NOW is filled and readable in ${themes.length} themes, light and dark`);
  }

  // TRY IT NOW opens the Achievements window.
  {
    const { ctx, page, errors } = await context();
    await page.goto(url, { waitUntil: 'networkidle' });
    const promo = page.locator('.achievements-promo');
    await promo.waitFor();
    await promo.getByRole('button', { name: 'TRY IT NOW', exact: true }).click();
    assert.equal(await promo.count(), 0, 'TRY IT NOW closes the splash');
    await page.locator('#online-window').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => localStorage.getItem('c64emu.achievementsPromoShown')), '1', 'it is marked seen');
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('ok  - TRY IT NOW opens the Achievements window');
  }

  // Offline, the board says so and still offers your place. The URL switch previews it without marking it seen.
  {
    const { ctx, page, errors } = await context({ board: null, seen: true });
    await page.goto(url, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('.achievements-promo').count(), 0, 'not after it has been seen');
    await page.goto(`${url}/?ACHIEVEMENTS_PROMO=1`, { waitUntil: 'networkidle' });
    const promo = page.locator('.achievements-promo');
    await promo.waitFor();
    await promo.locator('.achievements-promo-board-status').filter({ hasText: 'offline' }).waitFor();
    assert.deepEqual(await promo.locator('.achievements-promo-name').allTextContents(), ['YOU'], 'offline, only your open place');
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const box = await promo.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= viewport.width + 1, `the dialog fits ${viewport.width} wide`);
      assert(await promo.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'no horizontal overflow');
      await promo.locator('[data-promo-try]').scrollIntoViewIfNeeded();
      assert(await promo.locator('[data-promo-try]').isVisible(), 'TRY IT NOW stays reachable');
      if (viewport.width < 680) assert(await promo.locator('.achievements-promo-buttons .btn').evaluateAll((b) => b.every((x) => x.getBoundingClientRect().width > 120)), 'phone buttons share the width');
      if (process.argv.includes('--shots')) await page.screenshot({ path: `investigation/achievements-promo-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.argv.includes('--shots')) await page.screenshot({ path: 'investigation/achievements-promo-desktop.png' });
    await page.keyboard.press('Escape');
    assert.equal(await promo.count(), 0, 'Esc closes it');
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('ok  - offline board, phone layouts and the URL preview');
  }
} finally {
  await browser.close();
  await vite.close();
}
