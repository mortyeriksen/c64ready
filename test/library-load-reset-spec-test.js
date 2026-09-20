// Dropping a file on the screen, picking one with LOAD ANY and clicking a
// Library entry all load through _loadLibraryEntry. A program (.prg, .t64,
// .sid) is there to run, and its LOAD is typed at a BASIC prompt that a running
// tune or game never gives, so it asks openMedia for a prompt first, as a
// catalog load does. A disk or tape may be the next one a running program asked
// for, and goes in without a reset.
import fs from 'fs';

const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');
const open  = fs.readFileSync(new URL('../src/media/open.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

const fn = media.match(/async function _loadLibraryEntry\(([\s\S]*?)\n\}\n/)?.[0] || '';
expect(fn !== '', '_loadLibraryEntry exists in media.js');
expect(
  /const reset = \['prg', 't64', 'sid'\]\.includes\(entry\.type\);/.test(fn),
  'A program asks for a prompt; a disk, tape, cartridge or REU image does not'
);
expect(/openMedia\(\{[^}]*\breset\b[^}]*\}\)/.test(fn), 'The reset request reaches openMedia');

expect(
  /if \(reset && !\['crt', 'reu'\]\.includes\(load\.type\) && port\.reset && !port\.reset\(\)\)/.test(open),
  'openMedia resets before loading, except for a cartridge or REU image, which boot themselves'
);
const gate = open.indexOf('port.reset()');
const load = open.indexOf('await port[load.type]');
expect(gate !== -1 && load !== -1 && gate < load, 'The prompt is asked for before the program loads');

if (failures) {
  console.log(`\n${failures} library load reset spec failure(s)`);
  process.exit(1);
}

console.log('ok  - A program from the drop zone, LOAD ANY or the Library gets a prompt to load at');
