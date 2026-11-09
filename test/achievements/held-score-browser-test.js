// A high-score screen of the GAME tab (src/achievements/browse.js highScoreScreen) with a
// score of the reader's the board does not have yet, played signed out or waiting to be
// posted: it shows as their row, without a place, under the top rows or alone on an
// empty board, and gives way to the board's own row for them once it has one.
//
// Needs Playwright's Chromium; without it it reports a SKIP.
import net from 'node:net';
import { fileURLToPath } from 'node:url';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium is unavailable'); process.exit(0); }
const root = fileURLToPath(new URL('../../', import.meta.url));
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();

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

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  /** The screen's rows as text, for the given reader, standings and held score. */
  const screen = (o) => page.evaluate(async ({ me, standings, held }) => {
    const { highScoreScreen } = await import('/src/achievements/browse.js');
    const ctx = { me: () => me, format: (v) => String(v), go: () => {} };
    const el = highScoreScreen(ctx, 'Last Light', { id: 1, title: 'Hiscores', format: 'SCORE' }, standings, null, held);
    return {
      rows: [...el.querySelectorAll('li:not(.ach-screen-gap)')].map((li) => ({ text: li.textContent.replace(/\s+/g, ' ').trim(), me: li.classList.contains('is-me') })),
      gap: !!el.querySelector('.ach-screen-gap'),
      empty: /NO SCORES YET/.test(el.textContent),
    };
  }, o);
  const board = (entries, me = null) => ({ entries, players: entries.length, me });
  const top = [{ rank: 1, user: { id: 7, name: 'ACE' }, value: 90000 }, { rank: 2, user: { id: 8, name: 'BOB' }, value: 40000 }];

  // 1. Signed out, a board with others on it: the held score under them, unranked, saying to sign in.
  {
    const r = await screen({ me: null, standings: board(top), held: 58420 });
    const mine = r.rows.at(-1);
    expect(r.rows.length === 3 && r.gap, `the top rows, a gap, then the held score (${JSON.stringify(r.rows)})`);
    expect(mine?.me && /YOU/.test(mine.text) && /58420/.test(mine.text) && /sign in/.test(mine.text), `the row is the reader's, with the score and a sign-in note (${mine?.text})`);
    expect(!/\b(1ST|2ND|3RD)\b/.test(mine?.text ?? ''), 'it takes no place');
    ok('a held score shows under the board, signed out');
  }

  // 2. An empty board: the held score alone, not NO SCORES YET.
  {
    const r = await screen({ me: null, standings: board([]), held: 30 });
    expect(!r.empty && r.rows.length === 1 && !r.gap && /30/.test(r.rows[0].text), `the held score alone (${JSON.stringify(r)})`);
    ok('a held score on an empty board');
  }

  // 3. Signed in, the post still waiting: the reader's name, saving.
  {
    const r = await screen({ me: { id: 9, name: 'MER' }, standings: board(top), held: 1234 });
    expect(/MER/.test(r.rows.at(-1).text) && /saving/.test(r.rows.at(-1).text), `named, and saving (${r.rows.at(-1).text})`);
    ok('a score waiting to be posted');
  }

  // 4. Once the board has the reader's own row, that shows and the held score does not.
  {
    const r = await screen({ me: { id: 9, name: 'MER' }, standings: board(top, { rank: 3, value: 1234 }), held: 1234 });
    expect(r.rows.length === 3 && /3RD/.test(r.rows.at(-1).text) && !/saving/.test(r.rows.at(-1).text), `the board's own row (${JSON.stringify(r.rows)})`);
    const inTop = await screen({ me: { id: 7, name: 'ACE' }, standings: board(top), held: 95000 });
    expect(inTop.rows.length === 2, 'and none when the reader is in the top rows already');
    ok('the board\'s own row wins');
  }

  // 5. Nothing held: the screen as before.
  {
    const r = await screen({ me: null, standings: board(top), held: null });
    expect(r.rows.length === 2 && !r.gap, 'no held score, no extra row');
    ok('no held score');
  }
} finally {
  await browser.close();
  await vite.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - held scores on the GAME tab: ${testNo} checks`);
