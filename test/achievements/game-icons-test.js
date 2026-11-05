// The game icons: a drawing for every set, each in public/gameicons/ as the generator draws it,
// the app's list in step, and the drawing's outline, light and shade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_ICON_ART } from '../../tools/game-icons-art.mjs';
import { iconSvg, iconCells, iconList, ICON_COLOURS, OUTLINE, SIZE, GRID, lit, shaded } from '../../tools/game-icons.mjs';
import { GAME_ICONS, ICON_GRID, gameIconUrl } from '../../src/achievements/game-icons.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let checks = 0, fails = 0;
function expect(ok, rule) { checks++; if (!ok) { fails++; console.log(`FAIL - ${rule}`); } }

const ids = Object.keys(GAME_ICON_ART).sort();
const sets = fs.readdirSync(path.join(root, 'server/sets')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
for (const id of sets) expect(GAME_ICON_ART[id], `${id}: every game with a set has an icon`);

const letters = new RegExp(`^[.${Object.keys(ICON_COLOURS).join('')}]{${SIZE}}$`);
for (const id of ids) {
  const rows = GAME_ICON_ART[id];
  expect(rows.length === SIZE && rows.every((r) => letters.test(r)), `${id}: the drawing is ${SIZE} by ${SIZE} in the icon colours`);
  const file = path.join(root, 'public/gameicons', `${id}.svg`);
  expect(fs.existsSync(file) && fs.readFileSync(file, 'utf8') === iconSvg(rows), `${id}: public/gameicons/${id}.svg is the generator's drawing (node tools/game-icons.mjs)`);
}
const files = fs.readdirSync(path.join(root, 'public/gameicons')).filter((f) => f.endsWith('.svg'));
expect(files.length === ids.length, 'public/gameicons/ holds an icon for each drawing and no other');
expect(fs.readFileSync(path.join(root, 'src/achievements/game-icons.js'), 'utf8') === iconList(ids), 'the app\'s list of icons is the generator\'s');
expect(ICON_GRID === GRID && [...GAME_ICONS].join() === ids.join(), 'the app knows every icon and its size');
expect(gameIconUrl('last-ninja') === '/gameicons/last-ninja.svg' && gameIconUrl('no-such-game') === null, 'a game\'s icon is its file, and a game without one has none');

// One lit pixel in the middle of the grid: its four neighbours outlined, the pixel neither lit nor shaded
// (it has edges both ways), and nothing else drawn.
const blank = Array(SIZE).fill('.'.repeat(SIZE));
const dot = blank.map((r, y) => (y === 5 ? '.....r..........' : r));
const cells = iconCells(dot);
expect(cells[6][6] === ICON_COLOURS.r, 'a pixel with open edges on every side keeps its colour');
expect([[5, 6], [7, 6], [6, 5], [6, 7]].every(([y, x]) => cells[y][x] === OUTLINE), 'an empty pixel beside a drawn one is outline');
expect(cells.flat().filter(Boolean).length === 5, 'nothing else is drawn round a single pixel');
// A 2x2 block: top-left lit, bottom-right shaded, the other two (an edge each way) as they are.
const block = blank.map((r, y) => (y === 5 || y === 6 ? '.....BB.........' : r));
const b = iconCells(block);
expect(b[6][6] === lit(ICON_COLOURS.B), 'a pixel open only above or to the left is lit');
expect(b[7][7] === shaded(ICON_COLOURS.B), 'a pixel open only below or to the right is shaded');
expect(b[6][7] === ICON_COLOURS.B && b[7][6] === ICON_COLOURS.B, 'a pixel open both ways keeps its colour');
expect(b[5][5] === null, 'a pixel touching the shape only at a corner is not outline');
// Full-width drawings keep their outline inside the grid.
const full = Array(SIZE).fill('m'.repeat(SIZE));
const edge = iconCells(full).flatMap((r, y) => r.filter((_, x) => (x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1) && !((x === 0 || x === GRID - 1) && (y === 0 || y === GRID - 1))));
expect(edge.length === 4 * SIZE && edge.every((c) => c === OUTLINE), 'the outline of a full drawing fits the 18 by 18 grid');

if (fails) { console.log(`\n${fails} of ${checks} game icon checks failed`); process.exit(1); }
console.log(`ok - game icons: ${checks} checks`);
