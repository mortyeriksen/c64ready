// Attract mode (src/achievements/attract.js) in a browser, against a stub
// engine: a posted score opens it once the score's toast has gone, centered
// over the whole window (the vibes view while open, else the page), it shows
// the board just played, then every other board the player has a result on,
// the pages turn on their own even with the pointer resting on it, an unlock
// soon after the post (the game plays on) calls it off, a set with a
// game over opens it then and not on a posted score, and Space
// (kept from the C64), the next game or a click beside it ends it. Esc does not.
//
// Needs Playwright's Chromium; without it it reports a SKIP.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* reported below */ }
let browser = null;
if (chromium) { try { browser = await chromium.launch(); } catch { browser = null; } }
if (!browser) { console.log('# SKIP Playwright Chromium is not installed (npx playwright install chromium)'); process.exit(0); }

const root = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'http://attract.test';
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/src/styles/styles-theme.css">
<link rel="stylesheet" href="/src/styles/styles-achievements.css">
<link rel="stylesheet" href="/src/vibes/styles-vibes.css">
<style>body { margin: 0; } .crt-bezel { position: relative; width: 768px; aspect-ratio: 384 / 272; background: #6c5eb5; }</style>
</head><body><div class="crt-bezel"></div><div class="model-viewer-overlay" id="model-viewer-overlay" hidden></div></body></html>`;

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
const wait = (page, ms) => page.waitForTimeout(ms);

// A game with five boards, as OutRun's routes: A to C have scores, D and E none. The player (id 4) is 12th on route C.
async function openPage(options = {}, pageMs = 60000) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, ...options });
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    const file = path.join(root, url.pathname);
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(async (pageMs) => {
    const m = await import('/src/achievements/attract.js');
    const t = await import('/src/achievements/toast.js');
    window.mod = m;
    const boards = ['Route A', 'Route B', 'Route C', 'Route D', 'Route E'].map((title, i) => ({ id: i + 1, title, format: 'SCORE', lowerIsBetter: false }));
    window.G = { id: 'out-run', title: 'Out Run', hash: 'h', leaderboards: boards, achievements: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `Goal ${i + 1}`, description: 'd', points: 5, unlocked: i < 2 })) };
    const names = ['Ruby', 'Hubbard', 'Zak', 'Galway', 'Nova', 'Tel', 'Rob', 'Jeroen', 'Ben', 'Martin', 'Chris', 'Fred'];
    const standing = (id) => (id > 3 ? { entries: [], players: 0, me: null }
      : { entries: names.map((n, i) => ({ rank: i + 1, user: { id: 10 + i, name: n }, value: 90000 - i * 5000 })), players: 23, me: id === 3 ? { rank: 14, value: 30000 } : null });
    window.engine = {
      enabled: true, game: window.G,
      leaderboard: async (id) => standing(id),
      format: (v) => String(v).padStart(6, '0'),
      api: { top: async () => ({ total: 6, players: 9, complete: 0, entries: names.slice(0, 5).map((n, i) => ({ rank: i + 1, user: { id: 10 + i, name: n }, unlocked: 5 - i, points: 25 - i * 5, complete: false })) }) },
    };
    const vibes = document.getElementById('model-viewer-overlay');
    // The toasts on the C64's screen, attract mode over the page, as in the app.
    window.toasts = t.createAchToasts({ host: () => (!vibes.hidden ? vibes : document.querySelector('.crt-bezel')), ms: 900 });
    const host = () => (!vibes.hidden ? vibes : document.body);
    window.attract = m.createAttract({ host, watch: vibes, engine: () => window.engine, me: () => ({ id: 4, name: 'Pixel' }), pageMs });
    window.posted = { type: 'submitted', leaderboard: boards[2], value: 30000, result: { improved: true, rank: 14 } };
    // Every page title shown, in turn.
    window.titles = [];
    new MutationObserver(() => { const t = document.querySelector('.ach-attract-title')?.getAttribute('aria-label'); if (t && t !== window.titles.at(-1)) window.titles.push(t); })
      .observe(document.body, { childList: true, subtree: true });
  }, pageMs);
  return { page, context, errors };
}
const title = (page) => page.evaluate(() => document.querySelector('.ach-attract-title')?.getAttribute('aria-label') ?? document.querySelector('.ach-attract-title')?.textContent ?? null);
const isOpen = (page) => page.evaluate(() => window.attract.isOpen());

try {
  // 1. The rows and the pages.
  const first = await openPage();
  const rules = await first.page.evaluate(() => {
    const m = window.mod;
    const entries = Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, user: { id: i + 1, name: `P${i}` }, value: 100 - i }));
    const inTop = m.boardRows({ entries, me: { rank: 3, value: 98 } }, { id: 3 });
    const below = m.boardRows({ entries, me: { rank: 14, value: 50 } }, { id: 99, name: 'Me' });
    const tenth = m.boardRows({ entries, me: { rank: 10, value: 91 } }, { id: 10 });
    const none = m.boardRows({ entries, me: null }, null);
    const fame = m.fameRows({ entries: entries.map((e) => ({ ...e, points: e.value, complete: e.rank === 1 })), me: { rank: 20, points: 1 } }, { id: 99, name: 'Me' });
    const boards = new Map([[1, { entries, me: { rank: 3, value: 98 } }], [2, { entries: [] }], [3, { entries: [] }]]);
    const mineToo = new Map([...boards, [3, { entries, me: { rank: 5, value: 96 } }]]);
    const g = { leaderboards: [{ id: 1 }, { id: 2 }, { id: 3 }], achievements: [{}] };
    return {
      inTop: inTop.length, inTopMe: inTop.filter((r) => r?.me).length,
      tenth: tenth.length, tenthMe: tenth.findIndex((r) => r?.me),
      below: below.map((r) => (r ? (r.me ? `me${r.rank}` : r.rank) : 'gap')).join(','),
      none: none.length,
      fame: fame.map((r) => (r ? (r.me ? 'me' : r.rank) : 'gap')).join(','), star: fame[0].complete,
      pages: m.attractPages(g, { boards, fame: { entries }, played: 3 }).map((p) => p.kind === 'board' ? `b${p.board.id}` : p.kind).join(','),
      anyTime: m.attractPages(g, { boards, fame: { entries } }).map((p) => p.kind === 'board' ? `b${p.board.id}` : p.kind).join(','),
      both: m.attractPages(g, { boards: mineToo, fame: { entries }, played: 3 }).map((p) => p.kind === 'board' ? `b${p.board.id}` : p.kind).join(','),
      checking: m.attractPages(g, { boards: new Map([...boards, [2, { entries, me: { rank: null, value: 40, checking: true } }]]), played: 3 }).map((p) => p.kind === 'board' ? `b${p.board.id}` : p.kind).join(','),
      postedHere: m.attractPages(g, { boards: new Map([[3, { entries: [] }]]), played: 3, posted: new Map([[2, 77]]) }).map((p) => p.kind === 'board' ? `b${p.board.id}` : p.kind).join(','),
      heldPage: m.attractPages(g, { boards: new Map([[3, { entries: [] }]]), played: 3, posted: new Map([[2, 77], [3, 50]]) }).filter((p) => p.kind === 'board').map((p) => p.held).join(','),
      checkingRow: m.boardRows({ entries, me: { rank: null, value: 40, checking: true } }, { id: 99, name: 'Me' }).map((r) => (r ? (r.me ? `me${r.rank ?? '-'}:${r.value}` : r.rank) : 'gap')).join(','),
      heldRow: m.boardRows({ entries, me: null }, null, 10, 77).map((r) => (r ? (r.me ? `${r.name}${r.rank ?? '-'}:${r.value}` : r.rank) : 'gap')).join(','),
      onlyPlayed: m.attractPages(g, { boards: new Map([[3, { entries: [] }]]), played: 3 }).map((p) => p.kind === 'board' ? `b${p.board.id}` : p.kind).join(','),
      noAch: m.attractPages({ leaderboards: [{ id: 1 }], achievements: [] }, { boards, played: 1 }).map((p) => p.kind).join(','),
      noScores: m.attractPages({ leaderboards: [{ id: 2 }, { id: 3 }], achievements: [{}] }, { boards }).map((p) => p.kind === 'board' ? `b${p.board.id}` : p.kind).join(','),
    };
  });
  expect(rules.inTop === 10 && rules.inTopMe === 1, 'in the top ten, the player is lit where they stand');
  expect(rules.tenth === 10 && rules.tenthMe === 9, 'tenth is still in the top ten, in its place');
  expect(rules.below === '1,2,3,4,5,6,7,8,gap,me14', `further down: the top eight, a gap and their own row at the end (${rules.below})`);
  expect(rules.none === 10, 'signed out, the top ten');
  expect(rules.fame === '1,2,3,4,5,6,7,8,gap,me' && rules.star, `Trophy Hunters the same way, a star for a finished set (${rules.fame})`);
  expect(rules.pages === 'b3,b1,fame,trophies', `after a game, the board just played, then the others with a result of the player's, then Trophy Hunters and the trophies (${rules.pages})`);
  expect(rules.both === 'b3,b1,fame,trophies', `the board played comes first, a result there or not, and the rest keep the set's order (${rules.both})`);
  expect(rules.checking === 'b3,b1,b2,trophies', `a result being checked is the player's result too (${rules.checking})`);
  expect(rules.postedHere === 'b3,b2,trophies', `and so is one posted on this page, signed out too, before the server has it (${rules.postedHere})`);
  expect(rules.heldPage === ',77', `a board posted to on this page carries that score, not the one played, which has it under (${rules.heldPage})`);
  expect(rules.checkingRow === '1,2,3,4,5,6,7,8,gap,me-:40', `a result being checked ends the board as the player's own row, with no place (${rules.checkingRow})`);
  expect(rules.heldRow === '1,2,3,4,5,6,7,8,gap,YOU-:77', `and so does a score the board does not have yet (${rules.heldRow})`);
  expect(rules.onlyPlayed === 'b3,trophies', `with no other result, only the board played (${rules.onlyPlayed})`);
  expect(rules.anyTime === 'b1,b2,b3,fame,trophies', `opened from the GAME tab, every board (${rules.anyTime})`);
  expect(rules.noAch === 'board', 'a game with only a board has only its page');
  expect(rules.noScores === 'b2,b3,trophies', `boards with no scores yet show too, to say so (${rules.noScores})`);
  ok('rows and pages');

  // 2. A posted score opens it once the score's toast has gone, on the C64's screen.
  const { page, errors } = first;
  await page.evaluate(() => {
    window.toasts.show({ kind: 'score', title: 'Your Score', text: '', score: { value: 30000, format: String, outcome: 'plain' } });
    window.attract.leaderboardEvent(window.posted);
  });
  await wait(page, 700);
  expect(!(await isOpen(page)), 'not while the score toast shows');
  await page.waitForFunction(() => window.attract.isOpen(), null, { timeout: 5000 }).catch(() => {});
  expect(await isOpen(page), 'open once it has gone');
  expect(await page.evaluate(() => { const r = document.querySelector('body > .ach-attract'); return !!r && getComputedStyle(r).position === 'fixed'; }), 'over the whole window while the vibes view is closed');
  await wait(page, 600);
  const at = await page.evaluate(() => {
    const p = document.querySelector('.ach-attract-panel').getBoundingClientRect(), s = document.querySelector('.ach-attract-scrim').getBoundingClientRect();
    return { centered: Math.abs(p.left + p.width / 2 - innerWidth / 2) < 2 && Math.abs(p.top + p.height / 2 - innerHeight / 2) < 2, inside: p.top >= 0 && p.bottom <= innerHeight, dims: s.width === innerWidth && s.height === innerHeight };
  });
  expect(at.centered && at.inside, `centered in the window (${JSON.stringify(at)})`);
  expect(at.dims, 'the whole window dimmed behind it');
  await wait(page, 500);
  expect((await title(page)) === 'Route C', `first the board just played (${await title(page)})`);
  ok('a posted score opens it after its toast');

  // 2b. Its effects: a blinking cursor behind the typing, and the title's colours
  // in a wave, each letter half a step on from the one before, moving.
  await page.evaluate(() => window.attract.open(window.posted));
  await wait(page, 900);
  const cursor = await page.evaluate(() => { const c = document.querySelector('.ach-attract-row > .is-typing'); if (!c) return null; const a = getComputedStyle(c, '::after'); return { display: a.display, width: parseFloat(a.width), anim: a.animationName }; });
  expect(cursor?.display === 'inline-block' && cursor.width > 4 && cursor.anim === 'ach-attract-blink', `a blinking cursor follows the typing (${JSON.stringify(cursor)})`);
  const hues = () => page.evaluate(() => [...document.querySelectorAll('.ach-attract-title .ach-toast-ch')].map((s) => getComputedStyle(s).color));
  const h1 = await hues();
  await wait(page, 120);
  const h2 = await hues();
  expect(new Set(h1).size >= 3, `the title's letters are in several colours at once (${new Set(h1).size})`);
  expect(h1.some((c, i) => c !== h2[i]), 'and they move on');
  ok('the typing cursor and the title\'s colour wave');

  // 3. Its rows: the top six, a gap, the player's own, and the score just played.
  await page.waitForFunction(() => document.querySelector('.ach-attract-count'), null, { timeout: 8000 }).catch(() => {});
  const rows = await page.evaluate(() => [...document.querySelectorAll('.ach-attract-row')].map((r) => r.className.replace('ach-attract-row ', '') + ':' + r.textContent));
  expect(rows.some((r) => r.startsWith('is-gap')), 'a gap before the player\'s row');
  expect(rows.some((r) => r.includes('is-me') && r.includes('14TH')), 'the player\'s own row at the end, lit');
  expect(rows.filter((r) => (r.startsWith('is-podium') || r.startsWith('is-rest')) && !r.includes('is-me')).length === 8, 'under the top eight');
  const clipped = await page.evaluate(() => { const t = document.querySelector('.ach-attract-tube').getBoundingClientRect(), c = document.querySelector('.ach-attract-count').getBoundingClientRect(); return c.bottom > t.bottom; });
  expect(!clipped, 'every row fits on the screen, the player count under them included');
  expect(rows.some((r) => r.startsWith('is-you') && r.includes('NEW BEST') && r.includes('030000')), `the score just played, a new best (${rows.at(-1)})`);
  // At ten frames a second the page is still typed out within half its time.
  const slow = await page.evaluate(async () => {
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 100);
    window.attract.open(window.posted);
    const t0 = performance.now();
    const until = (cond) => new Promise((r) => { const look = () => (cond() || performance.now() - t0 > 6000 ? r() : setTimeout(look, 20)); look(); });
    await until(() => !document.querySelector('.ach-attract-count'));   // the page drawn again
    await until(() => document.querySelector('.ach-attract-count'));    // and typed out
    const ms = performance.now() - t0;
    window.requestAnimationFrame = raf;
    return { ms: Math.round(ms), rows: document.querySelectorAll('.ach-attract-row').length };
  });
  expect(slow.ms < 4500 && slow.rows === rows.length, `at ten frames a second every row is still typed out in time (${JSON.stringify(slow)})`);
  ok('the board\'s rows');

  // 4. The pages turn on their own, past the empty routes.
  const turning = await openPage({}, 1200);
  await turning.page.evaluate(() => window.attract.open(window.posted));
  // The pointer resting on the panel, where the C64's screen was: the pages turn all the same.
  await turning.page.mouse.move(600, 400);
  await wait(turning.page, 7500);
  const seen = await turning.page.evaluate(() => window.titles);
  expect(seen.slice(0, 4).join(',') === 'Route C,Trophy hunters,Trophies,Route C', `it turns through the pages in order, the pointer on it (${seen})`);
  expect(!seen.some((t) => /^Route [ABDE]$/.test(t)), `after a game on route C, no other route shows (${seen})`);
  ok('the pages turn');
  await turning.context.close();

  // 5. The next game ends it, and so do Esc and a click beside it.
  await page.evaluate(() => window.attract.leaderboardEvent({ type: 'started', leaderboard: window.G.leaderboards[0], value: 0 }));
  await wait(page, 400);
  expect(!(await isOpen(page)), 'the next game ends it');
  await page.evaluate(() => {
    window.attract.open(window.posted);
    // What the C64 would hear: keys reaching the page's own listeners.
    window.heard = [];
    document.addEventListener('keydown', (e) => window.heard.push(`down ${e.code}`));
    document.addEventListener('keyup', (e) => window.heard.push(`up ${e.code}`));
  });
  await wait(page, 300);
  await page.keyboard.press('Escape');
  await wait(page, 300);
  expect(await isOpen(page), 'Esc leaves it: in Retro Vibes or fullscreen it is the browser\'s');
  await page.keyboard.press('Space');
  await wait(page, 400);
  expect(!(await isOpen(page)), 'Space continues');
  expect(!(await page.evaluate(() => window.heard.some((h) => h.endsWith('Space')))), `the C64 never hears that Space, pressed or released (${await page.evaluate(() => window.heard)})`);
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.heard.includes('down Space')), 'once it is closed, Space is the C64\'s again');
  await page.evaluate(() => window.attract.open(window.posted));
  await wait(page, 300);
  await page.mouse.click(5, 5);
  await wait(page, 400);
  expect(!(await isOpen(page)), 'a click beside it ends it');
  ok('ending it');

  // 6. In the vibes view while it is open; opening or closing it ends attract mode.
  await page.evaluate(() => { document.getElementById('model-viewer-overlay').hidden = false; });
  await page.evaluate(() => window.attract.open(window.posted));
  await wait(page, 300);
  expect(await page.evaluate(() => !!document.querySelector('#model-viewer-overlay > .ach-attract')), 'in the vibes view while it is open');
  // The vibes view draws fewer frames: at ten a second its page is still typed out in time.
  const slowVibes = await page.evaluate(async () => {
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 100);
    window.attract.open(window.posted);
    const t0 = performance.now();
    const until = (cond) => new Promise((r) => { const look = () => (cond() || performance.now() - t0 > 6000 ? r() : setTimeout(look, 20)); look(); });
    await until(() => !document.querySelector('#model-viewer-overlay .ach-attract-count'));
    await until(() => document.querySelector('#model-viewer-overlay .ach-attract-count'));
    window.requestAnimationFrame = raf;
    return { ms: Math.round(performance.now() - t0), rows: document.querySelectorAll('#model-viewer-overlay .ach-attract-row').length };
  });
  expect(slowVibes.ms < 4500 && slowVibes.rows === rows.length, `and at ten frames a second its rows are typed out in time there too (${JSON.stringify(slowVibes)})`);
  await page.evaluate(() => { document.getElementById('model-viewer-overlay').hidden = true; });
  await wait(page, 400);
  expect(!(await isOpen(page)), 'closing the view ends it');
  ok('in the vibes view while it is open');

  // 6a. A game that plays on after its score is posted, as OutRun's second at 0 can reach a checkpoint:
  // an unlock half a second later calls attract mode off, and one in the same moment does not.
  await page.evaluate(() => { window.attract.leaderboardEvent(window.posted); setTimeout(() => { window.G.achievements[3].unlocked = true; window.G.achievements[3].unlockedAt = Date.now(); }, 500); });
  await wait(page, 2800);
  expect(!(await isOpen(page)), 'an unlock after the post means the game goes on: no attract mode');
  await page.evaluate(() => { window.G.achievements[4].unlocked = true; window.G.achievements[4].unlockedAt = Date.now(); window.attract.leaderboardEvent(window.posted); });
  await page.waitForFunction(() => window.attract.isOpen(), null, { timeout: 5000 }).catch(() => {});
  expect(await isOpen(page), 'an unlock in the same moment as the post still opens it');
  await page.evaluate(() => window.attract.close());
  await wait(page, 400);
  ok('a game that plays on after its post');

  // 6b. A set with a game over: a posted score, as of a level's time, opens nothing; game over opens it on the board last played.
  await page.evaluate(() => { window.engine.game = { ...window.G, gameOver: true }; window.attract.leaderboardEvent(window.posted); });
  await wait(page, 1500);
  expect(!(await isOpen(page)), 'a posted score opens nothing while the game goes on');
  await page.evaluate(() => { window.attract.leaderboardEvent({ type: 'started', leaderboard: window.G.leaderboards[0], value: 0 }); window.attract.gameOver(); });
  await page.waitForFunction(() => window.attract.isOpen(), null, { timeout: 5000 }).catch(() => {});
  expect(await isOpen(page), 'game over opens it');
  await wait(page, 600);
  const over = await page.evaluate(() => ({ pages: document.querySelectorAll('.ach-attract-page').length, title: document.querySelector('.ach-attract-title')?.getAttribute('aria-label'), you: !!document.querySelector('.ach-attract-row.is-you') }));
  expect(over.pages === 4 && over.title === 'Route A', `on the board last played, then the route the player has a score on, Trophy Hunters and trophies (${over.pages} pages, first ${over.title})`);
  expect(!over.you, 'no score of the player\'s under a board not posted to');
  await page.evaluate(() => { window.attract.close(); window.engine.game = window.G; });
  await wait(page, 400);
  ok('a set with a game over');

  // 7. With achievements off, nothing.
  await page.evaluate(() => { window.engine.enabled = false; window.attract.leaderboardEvent(window.posted); });
  await wait(page, 1500);
  expect(!(await isOpen(page)), 'achievements off: no attract mode');
  expect(!errors.length, `no page errors (${errors.join('; ')})`);
  ok('achievements off, and no page errors');
  await first.context.close();

  // 8. Reduced motion: the rows show whole at once.
  const still = await openPage({ reducedMotion: 'reduce' });
  await still.page.evaluate(() => window.attract.open(window.posted));
  await wait(still.page, 300);
  const rowCount = await still.page.locator('.ach-attract-row').count();
  expect(rowCount >= 9, `every row at once (${rowCount})`);
  expect(await still.page.locator('.ach-attract-row > .is-typing').count() === 0, 'no cursor');
  ok('reduced motion');
  await still.context.close();
} finally {
  await browser.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - attract mode: ${testNo} checks`);
