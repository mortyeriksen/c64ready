// The GAME tab's rules (src/achievements/hud-card.js): while boards are played
// those running show, OutRun on route A shows route A alone, and Commando's
// high score and area 1 speedrun both show, the time on top; with none in play
// every board shows. The gap to the next player is
// a time on a board of times, as the HUD in Retro Vibes shows it too.
import { boardsShown } from '../../src/achievements/hud-card.js';
import { gapText, boardInPlay } from '../../src/achievements/hud.js';
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

expect(ids(boardsShown(routes, [1], 1)) === '1', 'playing route A shows route A alone');
expect(ids(boardsShown(routes, [3], 3)) === '3', 'playing route C shows route C alone');
expect(ids(boardsShown(routes, [], null)) === '1,2,3,4,5', 'with none in play, every board shows');
expect(ids(boardsShown([routes[0]], [], null)) === '1', 'a game with one board shows it');
expect(ids(boardsShown([], [], null)) === '', 'a game without boards shows none');
ok('the boards in play, else every board');

const commando = [{ id: 1, title: 'Hiscores', format: 'SCORE' }, { id: 2, title: 'Area 1 Speedrun', format: 'MILLISECS' }];
for (const order of [[2, 1], [1, 2]]) {
  const inPlay = boardInPlay(commando, order);
  expect(inPlay === 2, `the running time is the board in play, started ${order.join(' then ')} (${inPlay})`);
  expect(ids(boardsShown(commando, order, inPlay)) === '2,1', `both show, the time on top (${ids(boardsShown(commando, order, inPlay))})`);
}
expect(boardInPlay(commando, [1]) === 1 && ids(boardsShown(commando, [1], 1)) === '1', 'once the time is posted, the score alone');
expect(boardInPlay(routes, [1, 3]) === 3, 'of two scores, the latest started');
expect(boardInPlay(routes, []) === null, 'none running, none in play');
ok('a speedrun and a high score at once');


const rc = await loadRcheevos();
const fmt = (f) => (v) => rc.formatValue(v, f);
expect(gapText(-1250, { format: 'MILLISECS' }, fmt('MILLISECS')) === '0:12.50', `a time board's gap is a time (${gapText(-1250, { format: 'MILLISECS' }, fmt('MILLISECS'))})`);
expect(gapText(21130, { format: 'SCORE' }, fmt('SCORE')) === '21,130', 'a score board\'s gap is points, grouped');
ok('the gap to the next player');

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - GAME tab: ${testNo} checks`);
