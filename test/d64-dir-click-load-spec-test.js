// Clicking a file in a disk directory panel (drive 8 or 9) types a real LOAD.
// At the READY prompt it types straight in with no reset; mid-program nothing
// would ever drain the keyboard buffer, so that case hard-resets back to a
// prompt first — and a still-pristine cold boot is already headed for READY,
// so it neither resets nor needs to. Both panels share the handler, so the
// typed command must address whichever drive actually holds the clicked disk.
import fs from 'fs';

const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

const fn = media.match(/function loadD64Entry\(([\s\S]*?)\n\}\n/)?.[0] || '';
expect(fn !== '', 'loadD64Entry exists in media.js');

expect(
  /if \(!_pristineBoot && !_basicReady\(\) && !_hardReset\(\)\) return;/.test(fn),
  'Directory click resets only when BASIC is neither at READY nor still cold-booting'
);
const gate = fn.indexOf('_hardReset()');
const queue = fn.indexOf('_queueAutoLoad');
expect(gate !== -1 && queue !== -1 && gate < queue, 'The READY/reset gate runs before the LOAD is queued');

expect(
  /const dev = disk === currentD64Drive9 \? 9 : 8;/.test(fn),
  'The typed LOAD addresses the drive that holds the clicked disk'
);
expect(
  !/",8\\r|",8,1\\r|",8…|",8 \+/.test(fn) && /\$\{dev\}/.test(fn),
  'No device-8 literal remains in the typed command or status line'
);

if (failures) {
  console.log(`\n${failures} d64 directory click load spec failure(s)`);
  process.exit(1);
}

console.log('ok  - Directory click loads from READY, resets otherwise, on the right drive');
