// Cartridge RESET / FREEZE buttons gate on `machine.ready && running`, so every
// path that changes either term has to re-sync them. The power-on path is the
// one that bit: _createAndWireMachine() re-applies a cached cartridge and syncs
// through _onCRTLoaded() while `running` is still false, so without a later
// re-sync the buttons stay disabled for the whole session — the cart's buttons
// worked only when it was inserted into an already-running machine.
import fs from 'fs';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

const powerOn = main.match(/async function _powerOn\(\) \{([\s\S]*?)\n\}\n/)?.[1] || '';

expect(powerOn.length > 0, '_powerOn() found in main.js');
expect(
  /const enabled = !!machine\?\.ready && running;/.test(media),
  'cartridge controls gate on both machine.ready and running'
);
expect(
  powerOn.includes('_createAndWireMachine()') && powerOn.includes('setRunning(true)'),
  '_powerOn() builds the machine and marks it running'
);
expect(
  powerOn.indexOf('_syncCartridgeControls()') > powerOn.indexOf('setRunning(true)'),
  '_powerOn() re-syncs the cartridge controls AFTER setRunning(true)'
);

// The power-off branch must keep its sync too: `running` goes false there, and
// the buttons have to follow it down.
expect(
  /setRunning\(false\);[\s\S]*?_syncCartridgeControls\(\)/.test(main),
  'power-off re-syncs the cartridge controls once running is false'
);

// Save-state restore is the same shape as power-on — fresh machine built while
// `running` is false, then flipped on — so it needs the same re-sync.
const loadState = media.match(/async function _loadState\(entry\) \{([\s\S]*?)\n\}\n/)?.[1] || '';

expect(loadState.length > 0, '_loadState() found in media.js');
expect(
  loadState.indexOf('_syncCartridgeControls()') > loadState.indexOf('setRunning(true)'),
  '_loadState() re-syncs the cartridge controls AFTER setRunning(true)'
);
// A bundle with no cartridge must not inherit the previous cart's buttons:
// _createAndWireMachine() only re-fires _onCRTLoaded() when a cart is re-applied.
expect(
  /if \(media\.crt\) _cacheCart\(media\.crt\); else \{ _clearCachedCart\(\); _forgetCartridgeUi\(\); \}/
    .test(loadState),
  '_loadState() drops the cartridge UI when the bundle carries no cart'
);
expect(
  /function _forgetCartridgeUi\(\) \{[\s\S]*?_currentCartInfo = null;/.test(media),
  '_forgetCartridgeUi() clears the cached cart info the controls read'
);

if (failures) {
  console.log(`\n${failures} cartridge-controls sync spec failure(s)`);
  process.exit(1);
}
console.log('cartridge-controls sync spec: all checks passed');
