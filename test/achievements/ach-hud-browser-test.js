// The trophy HUD in the vibes view (src/achievements/hud.js) in a browser,
// against a stub engine with a loaded game: its button shows and hides it,
// the shape it is dragged to picks the layout and it fits inside that shape,
// it stays in the view and snaps to its edges, phones and tablets start
// without it and get only the bar, the slim column and the pill, the chase
// follows a running score at most once a frame, an unlock fills its slot, and a
// challenge out for now powers down its slot and stamps its GAME tab card.
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
const ORIGIN = 'http://hud.test';
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/src/styles/styles-theme.css">
<link rel="stylesheet" href="/src/styles/styles-achievements.css">
<link rel="stylesheet" href="/src/vibes/styles-vibes.css">
</head><body>
<div class="model-viewer-overlay" id="model-viewer-overlay">
  <button class="model-viewer-hud" id="btn-model-viewer-hud" type="button" hidden aria-pressed="false" aria-label="Trophies"></button>
</div></body></html>`;

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

// A game of 14 achievements, 4 unlocked, and one board where the player (id 4) is fourth.
async function openPage(options = {}, stored = null) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...options });
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
  await page.evaluate(async (state) => {
    if (state) localStorage.setItem('c64emu.achHud', state); else localStorage.removeItem('c64emu.achHud');
    const hudMod = await import('/src/achievements/hud.js');
    const toastMod = await import('/src/achievements/toast.js');
    const area = document.getElementById('model-viewer-overlay');
    const ach = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, title: `Area ${i + 1}`, description: `Clear area ${i + 1}.`, points: 5, unlocked: i < 4, unlockedAt: i < 4 ? Date.now() : null, checking: false }));
    window.G = { id: 'commando-arcade', title: 'Commando Arcade', hash: 'h1', achievements: ach, leaderboards: [{ id: 7, title: 'Hiscores', format: 'SCORE', lowerIsBetter: false }] };
    window.engine = {
      enabled: true,
      game: null,
      // The standings can come after the HUD is laid out: window.standingsDelay holds them back.
      leaderboard: async () => (await new Promise((r) => setTimeout(r, window.standingsDelay ?? 0)), {
        entries: [{ rank: 1, user: { id: 1, name: 'Ruby' }, value: 96350 }, { rank: 2, user: { id: 2, name: 'Hubbard' }, value: 63900 },
          { rank: 3, user: { id: 3, name: 'Zak' }, value: 41200 }, { rank: 4, user: { id: 4, name: 'Pixel' }, value: 34600 }, { rank: 5, user: { id: 5, name: 'Nova' }, value: 18750 }],
        players: 5, me: { rank: 4, value: 34600 },
      }),
      format: (v) => String(v).padStart(6, '0'),
    };
    window.mod = hudMod;
    window.toasts = toastMod.createAchToasts({ host: () => area });
    window.hud = hudMod.createTrophyHud({ area, button: document.getElementById('btn-model-viewer-hud'), engine: () => window.engine, me: () => ({ id: 4 }) });
  }, stored);
  return { page, context, errors };
}
const loadGame = async (page) => { await page.evaluate(() => { window.engine.game = window.G; window.hud.refresh(); }); await wait(page, 600); };
const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom } : null; }, sel);
const shown = (page) => page.evaluate(() => !document.querySelector('.ach-hud').hidden);
const layoutOf = (page) => page.evaluate(() => document.querySelector('.ach-hud').dataset.layout);

try {
  // 1. The pure rules: the layout by shape, slots across, the chase.
  const rules = await (await openPage()).page.evaluate(() => {
    const m = window.mod;
    const shapes = [20, 6, 4, 2.4, 1.5, 1, 0.6, 0.35, 0.1];
    return {
      desktop: shapes.map((a) => m.layoutFor(a, false)),
      compact: [...new Set(shapes.map((a) => m.layoutFor(a, true)))],
      pills: [m.pillFor(3), m.pillFor(0.3)],
      cols14: ['row', 'row2', 'box', 'col2', 'col1'].map((l) => m.slotColumns(l, 14)),
      cols41: ['row', 'row2', 'col1'].map((l) => m.slotColumns(l, 41)),
      chase: m.chase([{ value: 96350 }, { value: 63900 }, { value: 41200 }, { value: 18750 }], 41200),
      chaseLow: m.chase([{ value: 120 }, { value: 200 }, { value: 300 }], 250, true),
      grouped: [m.grouped(21130), m.grouped(5), m.grouped(-1234567)],
      parsed: [m.parseHudState('nonsense', false), m.parseHudState('{"fx":3,"fade":true}', true)],
    };
  });
  expect(JSON.stringify(rules.desktop) === JSON.stringify(['row', 'row', 'row2', 'row2', 'box', 'box', 'col2', 'col2', 'col1']), `wide is a bar, then rows, a box, two columns, one column (${rules.desktop})`);
  expect(rules.compact.every((l) => ['row', 'col1'].includes(l)), `a phone gets only the bar and the slim column (${rules.compact})`);
  expect(rules.pills.join() === 'pill-row,pill-col', 'a pill lies or stands as its shape does');
  expect(rules.cols14.join() === '14,7,7,2,1', `14 slots: one row, two rows, a box of 7, two columns, one (${rules.cols14})`);
  expect(rules.cols41.join() === '21,14,2', `a big set takes more rows or columns (${rules.cols41})`);
  expect(rules.chase.rank === 3 && rules.chase.next.value === 63900 && rules.chase.passed.value === 41200, 'a tie is not ahead: equal to the third is third, with the second next');
  expect(rules.chaseLow.rank === 3 && rules.chaseLow.next.value === 200 && rules.chaseLow.passed.value === 300, 'where fewer is better, lower values are ahead');
  expect(rules.grouped.join('|') === '21,130|5|1,234,567', `gaps are grouped in thousands (${rules.grouped.join('|')})`);
  expect(rules.parsed[0].shown === true && rules.parsed[0].fade === false, 'on a computer it starts shown and not faded');
  expect(rules.parsed[1].fx === 0.5 && rules.parsed[1].fade === true && rules.parsed[1].shown === false, 'a stored state keeps what is valid and drops what is not');
  ok('layouts, slot columns, the chase and the stored state');

  // 2. The button: hidden with no game, then it shows and hides the HUD, and the choice is kept.
  const { page, context, errors } = await openPage();
  await wait(page, 300);
  expect(await page.evaluate(() => document.getElementById('btn-model-viewer-hud').hidden), 'no game: no button');
  await loadGame(page);
  expect(!(await page.evaluate(() => document.getElementById('btn-model-viewer-hud').hidden)), 'a game with achievements shows the button');
  expect(await shown(page), 'on a computer the HUD is up at first');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ach-hud')).opacity === '1'), 'and not see-through');
  await wait(page, 4000);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ach-hud')).opacity === '1'), 'nor after a while: fading is off until chosen');
  await page.mouse.move(5, 5);
  await page.click('#btn-model-viewer-hud');
  await wait(page, 600);
  expect(!(await shown(page)), 'the button hides it');
  expect((await page.getAttribute('#btn-model-viewer-hud', 'aria-pressed')) === 'false', 'and says so');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('c64emu.achHud')).shown === false), 'and it is kept');
  await page.click('#btn-model-viewer-hud');
  await wait(page, 700);
  expect(await shown(page), 'the button shows it again');
  // The next slot's frame blinks on, the slots having clacked back in.
  expect(await page.evaluate(() => { const s = document.querySelector('.ach-hud-slot.is-next'); return !!s && document.getAnimations().some((a) => a.effect?.target === s && a.effect?.pseudoElement === '::after' && a.playState === 'running'); }), 'and the next slot still blinks');
  ok('the button shows and hides it');

  // 3. The chase: the best, then a running score painted once a frame, passing Zak.
  const line = () => page.evaluate(() => ({ now: document.querySelector('.ach-hud-now').textContent, value: document.querySelector('.ach-hud-value').textContent, rank: document.querySelector('.ach-hud-rank').textContent, next: document.querySelector('.ach-hud-next').textContent }));
  let l = await line();
  expect(l.now.trim() === 'BEST' && l.value === '034600' && l.rank === '4TH', `with no game on, the best and its rank (${JSON.stringify(l)})`);
  expect(l.next.startsWith('NEXT ZAK 041200') && l.next.includes('6,600 to go'), `and the next player to pass (${l.next})`);
  const writes = await page.evaluate(async () => {
    let n = 0;
    const mo = new MutationObserver((m) => { n += m.length; });
    mo.observe(document.querySelector('.ach-hud-value'), { childList: true, characterData: true, subtree: true });
    for (let v = 30000; v < 30100; v++) window.hud.leaderboardEvent({ type: 'updated', leaderboard: window.G.leaderboards[0], value: v });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    mo.disconnect();
    return n;
  });
  expect(writes <= 2, `a hundred running scores in one frame are painted once (${writes} writes)`);
  l = await line();
  expect(l.now.trim() === 'NOW' && l.value === '030099', `the running score shows (${JSON.stringify(l)})`);
  await page.evaluate(() => window.hud.leaderboardEvent({ type: 'updated', leaderboard: window.G.leaderboards[0], value: 41500 }));
  await wait(page, 600);
  l = await line();
  expect(l.rank === '3RD' && l.next.startsWith('NEXT HUBBARD'), `passing Zak makes it third, Hubbard next (${JSON.stringify(l)})`);
  expect(await page.locator('.ach-hud-stamp').count() === 1, 'a climb into the top ten is stamped');
  await page.evaluate(() => window.hud.leaderboardEvent({ type: 'canceled', leaderboard: window.G.leaderboards[0], value: 0 }));
  await wait(page, 100);
  l = await line();
  expect(l.now.trim() === 'BEST' && l.value === '034600', 'when the game ends, back to the best');
  ok('the chase');

  // 4. The shape picks the layout, and it fits inside it, in the view.
  const fits = [];
  for (const [bw, bh, want] of [[0.64, 0.05, 'row'], [0.3, 0.09, 'row2'], [0.2, 0.15, 'box'], [0.11, 0.26, 'col2'], [0.035, 0.5, 'col1'], [0.1, 0.02, 'pill-row']]) {
    await page.evaluate(([w, h]) => {
      const s = JSON.parse(localStorage.getItem('c64emu.achHud'));
      localStorage.setItem('c64emu.achHud', JSON.stringify({ ...s, bw: w, bh: h }));
    }, [bw, bh]);
    const p2 = await openPage({}, await page.evaluate(() => localStorage.getItem('c64emu.achHud')));
    // Laid out before the standings come, measured after: it must fit both ways.
    await p2.page.evaluate(() => { window.standingsDelay = 700; });
    await loadGame(p2.page);
    await wait(p2.page, 900);
    const r = await box(p2.page, '.ach-hud');
    const lay = await layoutOf(p2.page);
    fits.push(`${want}:${lay}`);
    expect(lay === want, `a ${bw} by ${bh} shape is a ${want} (got ${lay})`);
    // At the smallest font it can be no smaller.
    const smallest = await p2.page.evaluate(() => parseFloat(document.querySelector('.ach-hud').style.fontSize) <= 6);
    expect(smallest || (r.w <= bw * 1400 + 1 && r.h <= bh * 1400 + 1), `the ${want} fits inside its shape (${Math.round(r.w)}x${Math.round(r.h)} in ${Math.round(bw * 1400)}x${Math.round(bh * 1400)})`);
    expect(r.x >= 0 && r.y >= 0 && r.r <= 1400 && r.b <= 900, `the ${want} is inside the view`);
    await p2.context.close();
  }
  ok(`each shape gets its layout and fits (${fits.join(' ')})`);

  // 5. Dragging: it snaps to the edges, stays in the view, and the place is kept.
  await page.evaluate(() => { localStorage.setItem('c64emu.achHud', JSON.stringify({ fx: 0.5, fy: 0.5, bw: 0.2, bh: 0.15, shown: true, fade: false })); });
  const d = await openPage({}, await page.evaluate(() => localStorage.getItem('c64emu.achHud')));
  await loadGame(d.page);
  let r = await box(d.page, '.ach-hud');
  await d.page.mouse.move(r.x + r.w / 2, r.y + 8);
  await d.page.mouse.down();
  await d.page.mouse.move(r.x + r.w / 2 + 3000, r.y + 8 + 3000, { steps: 10 });
  const guides = await d.page.locator('.ach-hud-guide:not([hidden])').count();
  await d.page.mouse.up();
  r = await box(d.page, '.ach-hud');
  expect(Math.abs(r.r - (1400 - 18)) < 1 && Math.abs(r.b - (900 - 18)) < 1, `dragged past the corner it stops at the margin (${Math.round(r.r)}, ${Math.round(r.b)})`);
  expect(guides === 2, `the edges it snaps to show (${guides})`);
  expect(await d.page.locator('.ach-hud-guide:not([hidden])').count() === 0, 'and go when it is let go');
  const kept = await d.page.evaluate(() => JSON.parse(localStorage.getItem('c64emu.achHud')));
  expect(kept.fx === 1 && kept.fy === 1, `its place is kept as the far corner (${kept.fx}, ${kept.fy})`);
  ok('dragging snaps, stays in the view, and is kept');

  // 6. Reshaping by the corner facing the open room: no outline, the HUD itself changes.
  await d.page.hover('.ach-hud');
  expect((await d.page.evaluate(() => document.querySelector('.ach-hud').dataset.corner)) === 'tl', 'in the bottom right corner its grip is top left, facing the room');
  const g = await box(d.page, '.ach-hud-resize');
  await d.page.mouse.move(g.x + 4, g.y + 4);
  await d.page.mouse.down();
  await d.page.mouse.move(g.x - 800, g.y + 60, { steps: 12 });
  await wait(d.page, 50);
  const midLayout = await layoutOf(d.page);
  const outlines = await d.page.locator('.ach-hud-box').count();
  await d.page.mouse.up();
  await wait(d.page, 50);
  r = await box(d.page, '.ach-hud');
  expect(midLayout === 'row' || midLayout === 'row2', `dragged wide and flat it becomes a bar (${midLayout})`);
  expect(outlines === 0, 'no outline is drawn while reshaping');
  expect(Math.abs(r.r - (1400 - 18)) < 2 && Math.abs(r.b - (900 - 18)) < 2, 'the opposite corner stays put');
  ok('reshaping by the corner');

  // 7. An unlock: its toast shows, then the trophy lands in its slot.
  await d.page.evaluate(() => {
    window.G.achievements[4].unlocked = true;
    window.toasts.show({ kind: 'unlock', title: 'Area 5', text: 'Clear area 5.', points: 5 });
    window.hud.unlocked(window.G.achievements[4]);
    window.engine.game = window.G;
    window.hud.refresh();
  });
  await wait(d.page, 300);
  const early = await d.page.evaluate(() => document.querySelectorAll('.ach-hud-slot')[4].classList.contains('is-got'));
  await wait(d.page, 2600);
  const late = await d.page.evaluate(() => ({ got: document.querySelectorAll('.ach-hud-slot')[4].classList.contains('is-got'), next: document.querySelectorAll('.ach-hud-slot')[5].classList.contains('is-next'), count: document.querySelector('.ach-hud-count').textContent }));
  expect(!early, 'the slot waits for its trophy');
  expect(late.got && late.next && late.count === '5/14', `then it is filled, the next is marked, the count is 5/14 (${JSON.stringify(late)})`);
  ok('an unlock flies into its slot');

  // 7b. A challenge out for now: its slot powers down at once, a refresh leaves the effect running,
  // it flashes back when live again, and its GAME tab card is stamped OUT.
  const out = await d.page.evaluate(async () => {
    const a = window.G.achievements[6];
    const slot = () => document.querySelectorAll('.ach-hud-slot')[6];
    const anim = () => document.getAnimations().find((x) => x.effect?.target === slot() && x.animationName === 'ach-out-power');
    a.challenge = 'out'; a.challengeAt = Date.now();
    window.hud.refresh();
    const first = anim();
    const r = { cls: slot().className, label: slot().getAttribute('aria-label'), delay: first ? first.effect.getTiming().delay : null };
    await new Promise((res) => setTimeout(res, 200));
    window.hud.refresh();
    r.kept = anim() === first && first.playState === 'running';
    const card = (await import('/src/achievements/hud-card.js')).trophyCards(window.G.achievements).children[6];
    document.body.append(card.parentElement ?? card);
    r.card = card.className;
    r.stamp = getComputedStyle(card, '::after').content;
    r.stampAnim = document.getAnimations().some((x) => x.effect?.target === card && x.effect?.pseudoElement === '::after' && x.animationName === 'ach-card-stamp');
    a.challenge = 'live'; a.challengeAt = Date.now();
    window.hud.refresh();
    r.back = slot().className;
    return r;
  });
  expect(/\bis-out\b/.test(out.cls) && /\bis-going-out\b/.test(out.cls), `the slot is out and going out (${out.cls})`);
  expect(out.delay === 0, `the power-down starts at once, not after the slots' entrance stagger (delay ${out.delay})`);
  expect(/out for now/.test(out.label), `its label says it is out for now (${out.label})`);
  expect(out.kept, 'a refresh mid-effect leaves it running');
  expect(/\bis-out\b/.test(out.card) && out.stamp === '"OUT"' && out.stampAnim, `the trophy card is stamped OUT (${out.card}, ${out.stamp})`);
  expect(/\bis-back\b/.test(out.back) && !/\bis-out\b/.test(out.back), `live again, it flashes back (${out.back})`);
  ok('a challenge out for now');
  expect(!errors.length && !d.errors.length, `no page errors (${[...errors, ...d.errors].join('; ')})`);
  ok('no page errors');
  await d.context.close();
  await context.close();

  // 8. A phone: no HUD at first, and only the bar, the slim column and the pill.
  const phone = await openPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await loadGame(phone.page);
  expect(!(await shown(phone.page)), 'on a phone it starts hidden');
  expect(!(await phone.page.evaluate(() => document.getElementById('btn-model-viewer-hud').hidden)), 'its button is there');
  await phone.page.click('#btn-model-viewer-hud');
  await wait(phone.page, 700);
  const seen = new Set();
  for (const [bw, bh] of [[0.95, 0.06], [0.6, 0.12], [0.4, 0.4], [0.2, 1.2], [0.08, 1.5], [0.3, 0.05]]) {
    const p3 = await openPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, JSON.stringify({ fx: 0.5, fy: 0.5, bw, bh, shown: true, fade: false }));
    await loadGame(p3.page);
    seen.add(await layoutOf(p3.page));
    await p3.context.close();
  }
  expect([...seen].every((x) => ['row', 'col1', 'pill-row', 'pill-col'].includes(x)), `only the bar, the slim column and the pill (${[...seen]})`);
  ok('phones and tablets');
  await phone.context.close();

  // 9. Several boards, as OutRun's routes: it follows the one that started,
  // names it, keeps it while another only updates, and when it ends hands over
  // to one still running.
  const multi = await openPage();
  await multi.page.evaluate(() => {
    window.G.leaderboards = [1, 2, 3].map((n) => ({ id: n, title: `Route ${'ABC'[n - 1]}`, format: 'SCORE', lowerIsBetter: false }));
  });
  await loadGame(multi.page);
  const board = () => multi.page.evaluate(() => ({ name: document.querySelector('.ach-hud-board').textContent, shown: !document.querySelector('.ach-hud-board').hidden, value: document.querySelector('.ach-hud-value').textContent, now: document.querySelector('.ach-hud-now').textContent.trim() }));
  const send = (type, id, value) => multi.page.evaluate(([t, i, v]) => window.hud.leaderboardEvent({ type: t, leaderboard: window.G.leaderboards[i - 1], value: v }), [type, id, value]);
  let b = await board();
  expect(b.shown && b.name === 'ROUTE A', `with several boards the first is named at first (${JSON.stringify(b)})`);
  await send('started', 1, 100);
  await send('started', 2, 200);
  await wait(multi.page, 100);
  b = await board();
  expect(b.name === 'ROUTE B' && b.value === '000200' && b.now === 'NOW', `it follows the board that started last (${JSON.stringify(b)})`);
  await send('updated', 1, 150);
  await wait(multi.page, 100);
  b = await board();
  expect(b.name === 'ROUTE B' && b.value === '000200', `an update of another running board does not take it over (${JSON.stringify(b)})`);
  await send('canceled', 2, 0);
  await wait(multi.page, 100);
  b = await board();
  expect(b.name === 'ROUTE A' && b.value === '000150' && b.now === 'NOW', `when it ends, a board still running takes over with its score (${JSON.stringify(b)})`);
  await send('canceled', 1, 0);
  await wait(multi.page, 100);
  b = await board();
  expect(b.name === 'ROUTE A' && b.now === 'BEST', `with none running, the best on the last one (${JSON.stringify(b)})`);
  ok('several boards');
  await multi.context.close();

  // 10. Reduced motion: no trophy flies, the slot simply fills.
  const still = await openPage({ reducedMotion: 'reduce' });
  await loadGame(still.page);
  await still.page.evaluate(() => {
    window.G.achievements[4].unlocked = true;
    window.toasts.show({ kind: 'unlock', title: 'Area 5', text: 'Clear area 5.', points: 5 });
    window.hud.unlocked(window.G.achievements[4]);
    window.hud.refresh();
  });
  let flyers = 0;
  for (let i = 0; i < 12; i++) { await wait(still.page, 200); flyers += await still.page.locator('.ach-hud-flyer').count(); }
  expect(flyers === 0, 'no trophy flies');
  expect(await still.page.evaluate(() => document.querySelectorAll('.ach-hud-slot')[4].classList.contains('is-got')), 'the slot is filled');
  ok('reduced motion');
  await still.context.close();
} finally {
  await browser.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - trophy HUD: ${testNo} checks`);
