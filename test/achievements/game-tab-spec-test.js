// The GAME tab's rules (src/achievements/hud-card.js): while a board is played
// only that board shows, OutRun on route A shows route A alone; with none in
// play every board shows. The HUD on top chases the board in play, else the
// first the player has a score on, else the first. The gap to the next player is
// a time on a board of times, as the HUD in Retro Vibes shows it too.
import { boardsShown, boardChased } from '../../src/achievements/hud-card.js';
import { gapText } from '../../src/achievements/hud.js';
import { loadRcheevos } from '../../src/achievements/rcheevos.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`); for (const m of current) console.log(`     - ${m}`); current = []; }
}

const routes = [1, 2, 3, 4, 5].map((id) => ({ id, title: `Route ${'ABCDE'[id - 1]}` }));
const ids = (list) => list.map((l) => l.id).join(',');

expect(ids(boardsShown(routes, 1)) === '1', 'playing route A shows route A alone');
expect(ids(boardsShown(routes, 3)) === '3', 'playing route C shows route C alone');
expect(ids(boardsShown(routes, null)) === '1,2,3,4,5', 'with none in play, every board shows');
expect(ids(boardsShown([routes[0]], null)) === '1', 'a game with one board shows it');
expect(ids(boardsShown([], null)) === '', 'a game without boards shows none');
ok('only the board in play, else every board');

const scored = (set) => (id) => set.has(id);
expect(boardChased(routes, 3, scored(new Set([1])))?.id === 3, 'the HUD chases the board in play, a score elsewhere or not');
expect(boardChased(routes, null, scored(new Set([4, 2])))?.id === 2, 'with none in play, the first board the player has a score on');
expect(boardChased(routes, null, scored(new Set()))?.id === 1, 'with no score anywhere, the first board');
expect(boardChased([], null, scored(new Set())) === null, 'a game without boards has nothing to chase');
ok('the board the HUD chases');

const rc = await loadRcheevos();
const fmt = (f) => (v) => rc.formatValue(v, f);
expect(gapText(-1250, { format: 'MILLISECS' }, fmt('MILLISECS')) === '0:12.50', `a time board's gap is a time (${gapText(-1250, { format: 'MILLISECS' }, fmt('MILLISECS'))})`);
expect(gapText(21130, { format: 'SCORE' }, fmt('SCORE')) === '21,130', 'a score board\'s gap is points, grouped');
ok('the gap to the next player');

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - GAME tab: ${testNo} checks`);
