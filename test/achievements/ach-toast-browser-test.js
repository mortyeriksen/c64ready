// The achievement toasts (src/achievements/toast.js, styles-achievements.css)
// in a browser: every toast shows for the same time whatever its kind or
// length, one at a time, inside the C64's top border at every size, sparkles
// only for a big unlock, and no motion when the system asks for none.
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
const ORIGIN = 'http://toast.test';
const MS = 700;           // a short time, so the test is quick; the rule is that it is the same for all
const BORDER = 36 / 272;  // the top border's share of the PAL frame's height

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { --amber: #e6dd6b; --green: #8fe985; --red: #d76b70; --panel-bg: #11142e; --text: #ccd0ec;
          --text-bright: #fff; --dim: #8e8eb7; --button-ink: #07071a; --shadow: #000; --highlight: #fff; }
  body { margin: 0; background: #000; }
  .crt-bezel { position: relative; width: 768px; aspect-ratio: 384 / 272; background: #6c5eb5; }
</style>
<link rel="stylesheet" href="/src/styles/styles-achievements.css">
</head><body><div class="crt-bezel"></div></body></html>`;

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

async function openPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ...options });
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
  await page.evaluate(async (ms) => {
    const mod = await import('/src/achievements/toast.js');
    window.mod = mod;
    window.place = await import('/src/achievements/toast-place.js');
    window.toasts = mod.createAchToasts({ host: () => document.querySelector('.crt-bezel'), ms });
    window.lasting = mod.createAchToasts({ host: () => document.querySelector('.crt-bezel'), ms: 60000 });
  }, MS);
  return { page, context, errors };
}

const count = (page) => page.locator('.ach-toast').count();
// Clicks ✕ and moves the pointer off, so it does not hold the next toast's time.
const close = async (page) => { await page.click('.ach-toast-x'); await page.mouse.move(5, 900); };
const wait = (page, ms) => page.waitForTimeout(ms);
const LONG = 'A description far longer than the toast has room for, which runs on and on past the edge of the border';

try {
  const { page, context, errors } = await openPage();

  // 1. The same time for every toast, whatever its kind or length.
  expect((await page.evaluate(() => window.mod.ACH_TOAST_MS)) === 5000, 'every toast shows for 5 seconds in the app');
  for (const [kind, text] of [['unlock', 'Short.'], ['score', LONG], ['notice', '']]) {
    await page.evaluate(([kind, text]) => window.toasts.show({ kind, title: 'A title', text, points: kind === 'unlock' ? 5 : 0 }), [kind, text]);
    await wait(page, MS - 200);
    expect(await count(page) === 1, `a ${kind} toast is still up just before its time (${MS} ms)`);
    await wait(page, 200 + 500);
    expect(await count(page) === 0, `a ${kind} toast has gone once its time and the slide out are over`);
  }
  ok('every kind and length shows for the same time');

  // 2. One at a time, the others counted, then shown in turn.
  await page.evaluate(() => ['First', 'Second', 'Third'].forEach((title) => window.toasts.show({ kind: 'unlock', title, points: 5 })));
  await wait(page, 50);
  expect(await count(page) === 1, 'only one toast shows at a time');
  expect((await page.locator('.ach-toast-more').textContent()) === '+2', 'the two waiting are counted');
  await close(page);
  await wait(page, 500);
  expect((await page.locator('.ach-toast-title').getAttribute('aria-label')) === 'Second', 'dismissing one shows the next in turn');
  expect((await page.locator('.ach-toast-more').textContent()) === '+1', 'and the count follows');
  await wait(page, 2 * MS + 1000);
  expect(await count(page) === 0, 'the queue empties');
  ok('toasts queue one at a time');

  // 3. Inside the top border at every size, larger with a larger picture.
  await page.waitForFunction(() => !document.querySelector('.ach-toast'));
  const sizes = {};
  for (const width of [360, 768, 1920]) {
    await page.evaluate((w) => { document.querySelector('.crt-bezel').style.width = `${w}px`; }, width);
    await page.evaluate((t) => window.lasting.show({ kind: 'unlock', title: 'Tea and No Tea', text: t, points: 50, action: 'SIGN IN' }), LONG);
    await page.waitForSelector('.ach-toast:not(.ach-toast-out)');
    await wait(page, 400);
    const r = await page.evaluate(() => {
      const b = document.querySelector('.crt-bezel').getBoundingClientRect();
      const t = document.querySelector('.ach-toast').getBoundingClientRect();
      return { b: { top: b.top, left: b.left, right: b.right, height: b.height }, t: { top: t.top, bottom: t.bottom, left: t.left, right: t.right }, font: parseFloat(getComputedStyle(document.querySelector('.ach-toast')).fontSize) };
    });
    sizes[width] = r.font;
    expect(r.t.top >= r.b.top && r.t.bottom <= r.b.top + r.b.height * BORDER + 0.5, `at ${width} px the toast stays inside the top border (bottom ${r.t.bottom - r.b.top} of ${r.b.height * BORDER})`);
    expect(r.t.left >= r.b.left && r.t.right <= r.b.right, `at ${width} px the toast stays inside the frame`);
    await close(page);
    await page.waitForFunction(() => !document.querySelector('.ach-toast'));
  }
  expect(sizes[360] < sizes[768] && sizes[768] < sizes[1920], `the toast grows with the picture (${sizes[360]}, ${sizes[768]}, ${sizes[1920]} px)`);
  await page.evaluate(() => { document.querySelector('.crt-bezel').style.width = '768px'; });
  ok('the toast fits the top border and scales with the picture');

  // 4. The payoff, scaled by points: when the count lands the chip pops, and
  // 10 points add the sweep, 25 the sparkles, 50 the full celebration.
  const payoff = async (points) => {
    await page.evaluate((p) => window.lasting.show({ kind: 'unlock', title: 'Unlocked', text: 'Done.', points: p }), points);
    await page.waitForSelector('.ach-toast:not(.ach-toast-out)');
    await wait(page, 700);
    const early = await page.evaluate(() => ({ sparks: document.querySelectorAll('.ach-toast-spark').length, chip: document.querySelector('.ach-toast-points').textContent }));
    await wait(page, 700);
    const at = await page.evaluate(() => ({
      chip: document.querySelector('.ach-toast-points').textContent,
      pop: document.querySelector('.ach-toast-points').classList.contains('ach-toast-pop'),
      sweep: document.querySelector('.ach-toast').classList.contains('ach-toast-sweep'),
      sparks: document.querySelectorAll('.ach-toast-spark').length,
    }));
    await wait(page, 900);
    const big = await page.evaluate(() => ({ pieces: document.querySelectorAll('.ach-toast-shower').length, rings: document.querySelectorAll('.ach-toast-ring').length }));
    await close(page);
    await page.waitForFunction(() => !document.querySelector('.ach-toast, .ach-toast-shower, .ach-toast-ring, .ach-toast-glint, .ach-toast-spark'), null, { timeout: 5000 });
    return { early, at, big };
  };
  const p5 = await payoff(5), p10 = await payoff(10), p25 = await payoff(25), p50 = await payoff(50);
  expect(p25.early.sparks === 0 && p25.early.chip !== '+25', `nothing goes off before the count lands (${JSON.stringify(p25.early)})`);
  expect(p5.at.chip === '+5' && p5.at.pop && !p5.at.sweep && !p5.at.sparks, `5 points: the count lands and the chip pops, nothing more (${JSON.stringify(p5.at)})`);
  expect(p10.at.sweep && !p10.at.sparks, `10 points: the sweep (${JSON.stringify(p10.at)})`);
  expect(p25.at.sweep && p25.at.sparks > 0 && !p25.big.pieces, `25 points: the sweep and sparkles (${JSON.stringify(p25)})`);
  expect(p50.big.pieces === 1 && p50.big.rings > 0, `50 points: the PETSCII shower and a shockwave (${JSON.stringify(p50.big)})`);
  expect(true, 'and every piece is gone after');
  ok('the payoff is scaled by points');

  // 4b. Scores: a plain one, a new best stamped BEST, a new first place turned to gold with #1.
  const scoreToast = async (score, text = '') => {
    await page.evaluate(([s, t]) => window.lasting.show({ kind: 'score', title: 'Your Score', text: t, score: { ...s, format: (v) => v.toLocaleString('en-US') } }), [score, text]);
    await page.waitForSelector('.ach-toast:not(.ach-toast-out)');
    await wait(page, 3600);
    const r = await page.evaluate(() => {
      const t = document.querySelector('.ach-toast');
      return {
        num: t.querySelector('.ach-toast-num').textContent, stamp: t.querySelector('.ach-toast-stamp')?.textContent ?? null,
        title: t.querySelector('.ach-toast-title').getAttribute('aria-label'),
        gold: t.classList.contains('ach-toast-gold'), text: t.querySelector('.ach-toast-text')?.textContent ?? '',
        crown: (t.querySelector('.ach-toast-icon').dataset.rows ?? '').slice(10, 20),
      };
    });
    await close(page);
    await page.waitForFunction(() => !document.querySelector('.ach-toast, .ach-toast-shower, .ach-toast-ring, .ach-toast-glint, .ach-toast-spark'), null, { timeout: 5000 });
    return r;
  };
  const plain = await scoreToast({ value: 3200, outcome: 'plain' }, 'Your best is 4,600, rank 3.');
  expect(plain.num === '3,200' && !plain.stamp && !plain.gold, `a plain score shows its number, no stamp (${JSON.stringify(plain)})`);
  const best = await scoreToast({ value: 5850, outcome: 'best', from: 4600, rankFrom: 2, rank: 2 }, 'New best! Was 4,600. Still rank 2.');
  expect(best.num === '5,850' && best.stamp === 'BEST' && !best.gold && best.text === 'New best! Was 4,600. Still rank 2.', `a new best rolls to its number and is stamped BEST (${JSON.stringify(best)})`);
  const climbed = await scoreToast({ value: 7300, outcome: 'best', from: 4600, rankFrom: 5, rank: 2 }, 'New best! Was 4,600.');
  expect(climbed.text === 'New best! Was 4,600. Rank 2' && climbed.stamp === 'BEST', `a new best that climbs ticks its rank down to the new one (${JSON.stringify(climbed)})`);
  const kept = await scoreToast({ value: 9900, outcome: 'best', from: 9120, rankFrom: 1, rank: 1, stillTop: true }, 'New best! Was 9,120. Still #1.');
  expect(kept.crown === '#...##...#' && kept.stamp === 'BEST' && !kept.gold, `a new best by the player already first wears a crown, not the gold turn (${JSON.stringify(kept)})`);
  const top = await scoreToast({ value: 9120, outcome: 'top', from: 5850, rankFrom: 4, topTitle: 'High Score' });
  expect(plain.title === 'Your Score: 3,200' && top.title === 'High Score: 9,120', `"Your Score" until first place, then the board's own title (${plain.title} / ${top.title})`);
  expect(top.num === '9,120' && top.stamp === '#1' && top.gold && top.text === 'Top of the board!', `a new first place turns gold and is stamped #1 (${JSON.stringify(top)})`);
  expect(top.crown === '#...##...#', `with a crown for its icon (${top.crown})`);
  ok('a new best and a new first place');

  // 4c. The unlock that finishes a set turns to gold with the game's icon, stamped 100%, and stays longer.
  const ICON = ['##########', '#........#', '#.######.#', '#.#....#.#', '#.#.##.#.#', '#.#.##.#.#', '#.#....#.#', '#.######.#', '#........#', '##########'];
  await page.evaluate((icon) => window.lasting.show({ kind: 'unlock', title: 'War Hero', text: 'Score 100,000 points.', points: 25, complete: { icon, title: 'Demo complete!', text: 'All 14 achievements, 180 points.' } }), ICON);
  await page.waitForSelector('.ach-toast:not(.ach-toast-out)');
  await wait(page, 3600);
  const fin = await page.evaluate(() => {
    const t = document.querySelector('.ach-toast');
    return {
      gold: t.classList.contains('ach-toast-gold'), stamp: t.querySelector('.ach-toast-stamp')?.textContent ?? null,
      title: t.querySelector('.ach-toast-title').getAttribute('aria-label'), text: t.querySelector('.ach-toast-text').textContent,
      chip: !!t.querySelector('.ach-toast-points'),
      icon: t.querySelector('.ach-toast-icon').dataset.rows ?? '',
    };
  });
  expect(fin.gold && fin.stamp === '100%' && fin.title === 'Demo complete!' && fin.text === 'All 14 achievements, 180 points.' && !fin.chip, `a finished set turns to its gold side (${JSON.stringify(fin)})`);
  expect(fin.icon === ICON.join(''), 'with the game\'s own icon');
  await close(page);
  await page.waitForFunction(() => !document.querySelector('.ach-toast, .ach-toast-shower, .ach-toast-ring, .ach-toast-glint, .ach-toast-spark'), null, { timeout: 5000 });
  await page.evaluate(() => window.toasts.show({ kind: 'unlock', title: 'Done', points: 5, complete: { title: 'Demo complete!', text: 'All 3.' } }));
  await wait(page, MS + 1500);
  expect(await count(page) === 1, 'a finished set stays longer than the others');
  await page.waitForFunction(() => !document.querySelector('.ach-toast'), null, { timeout: 4000 }).catch(() => {});
  expect(await count(page) === 0, 'and then goes');
  ok('a finished set');

  // 5. The action runs and closes the toast. Pointing at a toast holds its time.
  await page.evaluate(() => { window.signedIn = 0; window.toasts.show({ kind: 'score', title: 'High Score: 4,600', action: 'SIGN IN', onAction: () => window.signedIn++ }); });
  await wait(page, 300);
  await page.click('.ach-toast-action');
  await wait(page, 500);
  expect(await page.evaluate(() => window.signedIn) === 1 && await count(page) === 0, 'SIGN IN runs its action and closes the toast');
  await page.evaluate(() => window.toasts.show({ kind: 'notice', title: 'Trainer on', text: 'Nothing counts.' }));
  await page.hover('.ach-toast-words');
  await wait(page, MS + 600);
  expect(await count(page) === 1, 'a toast stays while it is pointed at');
  await page.mouse.move(5, 900);
  await wait(page, MS + 600);
  expect(await count(page) === 0, 'and goes once it is left');
  ok('the action and holding the time');

  // 6. A toast showing moves along when where toasts go changes, such as vibes opening.
  await page.evaluate(() => {
    const other = document.createElement('div'); other.id = 'other'; document.body.append(other);
    window.where = document.querySelector('.crt-bezel');
    window.moving = window.mod.createAchToasts({ host: () => window.where, ms: 60000 });
    window.moving.show({ kind: 'score', title: 'High Score: 1,000' });
  });
  await wait(page, 300);
  await page.evaluate(() => { window.where = document.getElementById('other'); window.moving.rehome(); });
  expect(await page.evaluate(() => document.querySelector('.ach-toast')?.parentElement?.id) === 'other', 'the toast showing moves to the new place');
  await close(page);
  await page.waitForFunction(() => !document.querySelector('.ach-toast'));
  ok('a toast showing moves along');

  // 7. The six places: a corner or the middle of the top or bottom border, inside that border.
  await page.evaluate(() => { document.querySelector('.crt-bezel').style.width = '768px'; });
  for (const id of ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']) {
    await page.evaluate((id) => { window.place.applyPlace(document.querySelector('.crt-bezel'), window.place.parsePlace(id)); window.lasting.show({ kind: 'unlock', title: 'Placed', text: 'Where it was put.', points: 5 }); }, id);
    await page.waitForSelector('.ach-toast:not(.ach-toast-out)');
    await wait(page, 400);
    const r = await page.evaluate(() => {
      const b = document.querySelector('.crt-bezel').getBoundingClientRect(), t = document.querySelector('.ach-toast').getBoundingClientRect();
      return { top: t.top - b.top, bottom: t.bottom - b.top, left: t.left - b.left, right: b.right - t.right, H: b.height, W: b.width };
    });
    const border = r.H * BORDER;
    const [v, h] = id.split('-');
    expect(v === 'top' ? r.top >= 0 && r.bottom <= border + 0.5 : r.top >= r.H - border - 0.5 && r.bottom <= r.H, `${id}: inside the ${v} border (${r.top.toFixed(1)}..${r.bottom.toFixed(1)} of ${r.H.toFixed(1)})`);
    const side = h === 'left' ? r.left : h === 'right' ? r.right : Math.abs(r.left - r.right);
    expect(h === 'center' ? side < 1 : side < r.W * 0.02, `${id}: at the ${h} (${side.toFixed(1)} px)`);
    await close(page);
    await page.waitForFunction(() => !document.querySelector('.ach-toast'));
  }
  expect(await page.evaluate(() => window.place.parsePlace(null).id) === 'top-center', 'top center by default');
  expect(await page.evaluate(() => window.place.parsePlace('0.3,0.4').id) === 'top-center', 'and for a stored value that is not one of the six');
  expect(await page.evaluate(() => window.place.nextPlace(window.place.parsePlace('bottom-right')).id) === 'top-left', 'the cycle goes round');
  ok('the six places');

  // 8. In the vibes view: top center by default, and dragging a sample puts it on the exact spot.
  await page.evaluate(() => {
    const view = document.createElement('div');
    view.className = 'model-viewer-overlay';
    view.style.cssText = 'position: fixed; inset: 0; z-index: 3000;';
    document.body.append(view);
    window.view = view;
    window.place.applyPlace(view, window.place.parseVibesPlace(null));
    window.viewToasts = window.mod.createAchToasts({ host: () => view, ms: 60000 });
    window.viewToasts.show({ kind: 'score', title: 'High Score: 1,000' });
  });
  await page.waitForSelector('.model-viewer-overlay > .ach-toast:not(.ach-toast-out)');
  await wait(page, 400);
  const centre = await page.evaluate(() => { const t = document.querySelector('.model-viewer-overlay > .ach-toast').getBoundingClientRect(); return { mid: t.left + t.width / 2, top: t.top, W: innerWidth }; });
  expect(Math.abs(centre.mid - centre.W / 2) < 1 && Math.abs(centre.top - 18) < 1, `top center in the view by default (middle ${centre.mid} of ${centre.W}, top ${centre.top})`);
  await page.click('.model-viewer-overlay > .ach-toast .ach-toast-x');
  await page.mouse.move(5, 900);
  await page.waitForFunction(() => !document.querySelector('.model-viewer-overlay > .ach-toast'));
  await page.evaluate((margin) => {
    window.placingClosed = 0;
    const el = window.viewToasts.sample({ kind: 'unlock', title: 'Drag me', text: 'Here.', points: 10 }, window.view, () => window.placingClosed++);
    el.classList.add('ach-toast-placing');
    window.dropped = null;
    window.place.dragPlace({ area: window.view, el, margin, onMove: (p) => window.place.applyPlace(window.view, p), onDone: (p) => { window.dropped = p; } });
  }, await page.evaluate(() => window.place.VIBES_MARGIN));
  await wait(page, 300);
  const before = await page.locator('.ach-toast-placing').boundingBox();
  await page.mouse.move(before.x + 20, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x - 180, before.y + 300, { steps: 8 });
  await page.mouse.up();
  const after = await page.locator('.ach-toast-placing').boundingBox();
  const dropped = await page.evaluate(() => window.dropped);
  expect(Math.abs(after.x - before.x + 200) < 2 && Math.abs(after.y - before.y - 290) < 2, `the toast follows the pointer (moved ${after.x - before.x}, ${after.y - before.y})`);
  expect(dropped && dropped.x > 0 && dropped.x < 1 && dropped.y > 0 && dropped.y < 1, `where it is let go is kept (${JSON.stringify(dropped)})`);
  const again = await page.evaluate((d) => { const p = window.place.parseVibesPlace(`${d.x},${d.y}`); return p.x === d.x && p.y === d.y; }, dropped);
  expect(again, 'the spot reads back as it was stored');
  expect(await page.evaluate(() => { const p = window.place.parseVibesPlace('2,x'); return p.x === 0.5 && p.y === 0; }), 'a stored spot it cannot read is top center');
  await page.mouse.move(after.x + 30, after.y + 10);
  await page.mouse.down();
  await page.mouse.move(after.x - 3000, after.y - 3000, { steps: 4 });
  await page.mouse.up();
  const edge = await page.evaluate(() => window.dropped);
  expect(edge.x === 0 && edge.y === 0, `it cannot be dragged out of the view (${JSON.stringify(edge)})`);
  // Its corner grip scales it, within limits, and keeps where it is.
  await page.evaluate(() => {
    const el = document.querySelector('.ach-toast-placing');
    const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'ach-toast-resize'; el.append(grip);
    window.scale = 1; window.sized = null;
    window.place.dragSize({ el, grip, scale: () => window.scale, onMove: (s) => { window.scale = s; window.place.applySize(window.view, s); }, onDone: (s) => { window.sized = s; } });
  });
  const small = await page.locator('.ach-toast-placing').boundingBox();
  const grip = await page.locator('.ach-toast-resize').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + small.width / 2, grip.y + 40, { steps: 6 });
  await page.mouse.up();
  const big = await page.locator('.ach-toast-placing').boundingBox();
  const sized = await page.evaluate(() => window.sized);
  expect(Math.abs(sized - 1.5) < 0.05, `dragging the grip half the toast's width scales it by 1.5 (${sized})`);
  expect(big.width > small.width * 1.3 && big.height > small.height * 1.3, `the toast grows (${small.width}x${small.height} to ${big.width}x${big.height})`);
  expect(await page.evaluate(() => window.dropped.x === 0 && window.dropped.y === 0), 'and resizing does not move its place');
  const g2 = await page.locator('.ach-toast-resize').boundingBox();
  await page.mouse.move(g2.x + 4, g2.y + 4);
  await page.mouse.down();
  await page.mouse.move(g2.x - 5000, g2.y, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.sized) === await page.evaluate(() => window.place.VIBES_SIZE_MIN), 'it cannot be made smaller than the least size');
  expect(await page.evaluate(() => window.place.parseVibesSize('1.5') === 1.5 && window.place.parseVibesSize('9') === 1 && window.place.parseVibesSize(null) === 1), 'a stored size reads back, one out of range is the usual size');
  await page.click('.ach-toast-placing .ach-toast-x');
  expect(await page.evaluate(() => window.placingClosed) === 1, 'its ✕ closes the placing');
  await page.evaluate(() => { document.querySelector('.ach-toast-placing')?.remove(); window.view.remove(); });
  ok('the vibes view: top center, and dragging a toast into place and to size');

  // 9. Without the display, the toast goes to the foot of the page.
  await page.evaluate((ms) => { window.loose = window.mod.createAchToasts({ host: () => null, ms }); window.loose.show({ kind: 'unlock', title: 'Loose', points: 5 }); }, MS);
  await wait(page, 100);
  expect(await page.evaluate(() => { const t = document.querySelector('body > .ach-toast'); return !!t && t.classList.contains('ach-toast-page') && getComputedStyle(t).position === 'fixed'; }), 'with no display the toast is fixed on the page');
  await wait(page, MS + 600);
  ok('a toast with no display');

  expect(!errors.length, `no page errors (${errors.join('; ')})`);
  ok('no page errors');
  await context.close();

  // 10. Reduced motion: no flaps, no count, no sparkles, and the same time.
  const still = await openPage({ reducedMotion: 'reduce' });
  await still.page.evaluate(() => window.toasts.show({ kind: 'unlock', title: 'Calm', text: 'Quiet.', points: 50 }));
  await wait(still.page, 600);
  expect(await still.page.locator('.ach-toast-ch').count() === 0, 'the title shows whole, without flaps');
  expect((await still.page.locator('.ach-toast-points').textContent()) === '+50', 'the points show at once');
  expect(await still.page.locator('.ach-toast-spark').count() === 0, 'no sparkles');
  expect(await still.page.evaluate(() => getComputedStyle(document.querySelector('.ach-toast')).animationName) === 'none', 'the toast does not slide');
  await wait(still.page, MS);
  expect(await count(still.page) === 0, 'it still goes after the same time');
  await still.page.evaluate(() => window.lasting.show({ kind: 'score', title: 'High Score', score: { value: 9120, outcome: 'top', from: 5850, rankFrom: 4, format: (v) => v.toLocaleString('en-US') } }));
  await wait(still.page, 2600);
  expect(await still.page.evaluate(() => !document.querySelector('.ach-toast-stamp, .ach-toast-shower, .ach-toast-ring, .ach-toast-gold')), 'no stamp, turn or celebration');
  ok('reduced motion');
  await still.context.close();
} finally {
  await browser.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - achievement toasts: ${testNo} checks`);
