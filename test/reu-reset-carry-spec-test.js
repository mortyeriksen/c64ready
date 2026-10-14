// /RESET does not clear REU DRAM (only power-up does), but the UI's RESET, and
// every media load into a running machine, rebuilds the machine from scratch.
// _hardReset() therefore has to hand the old expansion RAM to the new machine,
// and the hand-over must come after a cached cartridge is re-inserted, because
// a cartridge insert power-ups the REU and wipes it.
import fs from 'fs';
import { REU } from '../src/reu.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

// Device rule: /RESET keeps expansion RAM, power-up clears it.
const reu = new REU();
reu.ram[0] = 0x49; reu.ram[reu.ram.length - 1] = 0x50;
reu.resetLine();
expect(reu.ram[0] === 0x49 && reu.ram[reu.ram.length - 1] === 0x50,
  '/RESET leaves expansion RAM intact');
reu.powerUp();
expect(reu.ram[0] === 0 && reu.ram[reu.ram.length - 1] === 0,
  'power-up clears expansion RAM');

const hardReset = main.match(/function _hardReset\(\) \{([\s\S]*?)\n\}\n/)?.[1] || '';
const wire = main.match(/function _createAndWireMachine\([^)]*\) \{([\s\S]*?)\n\}\n/)?.[1] || '';

expect(hardReset.length > 0, '_hardReset() found in main.js');
expect(wire.length > 0, '_createAndWireMachine() found in main.js');
expect(
  /const reuRam = c64\.reu\?\.ram/.test(hardReset)
    && hardReset.indexOf('const reuRam') < hardReset.indexOf('_createAndWireMachine('),
  '_hardReset() takes the expansion RAM before the machine is rebuilt'
);
expect(
  /_createAndWireMachine\(\{[^}]*reuRam[^}]*\}\)/.test(hardReset),
  '_hardReset() passes the expansion RAM to the new machine'
);
const restoreAt = wire.indexOf('c64.reu?.loadImage(reuRam)');
expect(restoreAt > 0, '_createAndWireMachine() restores the handed-over expansion RAM');
expect(restoreAt > wire.indexOf('c64.loadCartridge('),
  'expansion RAM is restored after the cartridge power-up that clears it');
expect(restoreAt > wire.indexOf('_applyReu()'),
  'expansion RAM is restored after the unit is fitted');

if (failures) {
  console.log(`\n${failures} REU reset-carry spec failure(s)`);
  process.exit(1);
}
console.log('REU reset-carry spec: all checks passed');
