// Loading a .prg offers to switch True Drive Emulation off.
//
// The disk a .prg is wrapped in is one the app just formatted: one file, no
// fastloader, no protection. True drive emulation loads it over the real 1541's
// serial protocol at the speed the hardware managed; the built-in loader reads
// it at once. So the offer is worth making, and it is worth making only when
// there is something to change:
//
//   - only when true drive emulation is actually on,
//   - only on the path that puts a disk in the drive (with no 1541 ROM the
//     program goes straight into RAM and the setting is not involved),
//   - before the disk goes in, so the answer governs the LOAD that follows,
//   - once, not on every load: turning it down is remembered, and switching
//     emulation back on by hand arms it again.
//
// media.js and main.js drive the DOM, which no test here can construct (there
// is no DOM library in the suite), so this reads the wiring off the source the
// way the other media UI specs do.
import fs from 'fs';

const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const dialogs = fs.readFileSync(new URL('../src/dialogs.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
}

const offer = media.match(/async function _offerTdeOffForPrg\(\)[\s\S]*?\n\}/)?.[0] || '';
const insert = media.match(/async function _insertPRG\([\s\S]*?\n\}\n/)?.[0] || '';
const toggle = main.match(/if \(tdeToggleBtn\) \{[\s\S]*?\n\}/)?.[0] || '';
const applyTde = main.match(/function _applyTde\(on\)[\s\S]*?\n\}/)?.[0] || '';

expect(offer !== '', '_offerTdeOffForPrg exists in media.js');
expect(insert !== '', '_insertPRG exists in media.js');
expect(toggle !== '', 'the TDE toggle handler exists in main.js');

// ── Only when there is something to turn off ────────────────────────────────
expect(
  /if \(!getTdeEnabled\?\.\(\)[\s\S]*?\) return;/.test(offer),
  'The offer is skipped when true drive emulation is already off'
);
expect(
  /_prgTdeOfferDeclined\(\)\) return;/.test(offer),
  'and when the offer has already been turned down'
);

// ── The two answers ────────────────────────────────────────────────────────
expect(
  /if \(yes\) setTdeEnabled\(false\);/.test(offer),
  'Accepting switches true drive emulation off'
);
expect(
  /else \{[^}]*localStorage\.setItem\(_PRG_TDE_DECLINED_KEY/.test(offer),
  'Declining is remembered, so the question is not asked on every load'
);
expect(
  /catch \{ return true; \}/.test(media.match(/function _prgTdeOfferDeclined\(\)[\s\S]*?\n\}/)?.[0] || ''),
  'With no storage to remember an answer in, the offer stays silent rather than nagging'
);

// ── Where it sits in the load ──────────────────────────────────────────────
const offerAt = insert.indexOf('_offerTdeOffForPrg()');
const loadAt = insert.indexOf('_loadDisk(disk');
const fallbackAt = insert.indexOf('if (!disk)');
expect(offerAt !== -1 && loadAt !== -1 && offerAt < loadAt,
  'The offer is made before the disk is inserted, so the answer governs that LOAD');
expect(fallbackAt !== -1 && fallbackAt < offerAt,
  'The no-drive path (program straight into RAM) returns before the offer is reached');
expect(/await _offerTdeOffForPrg\(\)/.test(insert),
  'The load waits for the answer rather than racing the dialog');

// ── Every entry point waits for it ─────────────────────────────────────────
const DEF = 'async function _insertPRG(';
const defAt = media.indexOf(DEF) + DEF.length - '_insertPRG('.length;
const callSites = [...media.matchAll(/_insertPRG\(/g)].map((m) => m.index).filter((i) => i !== defAt);
const unawaited = callSites.filter((i) => !media.slice(0, i).endsWith('await '));
expect(callSites.length >= 2, `the .prg entry points route through _insertPRG (found ${callSites.length})`);
expect(
  unawaited.length === 0,
  `Every call to _insertPRG is awaited, so the dialog is never skipped (${unawaited.length} not awaited)`
);

// ── One place changes the setting, and only a manual switch-on re-arms ─────
expect(applyTde !== '' && /machine\?\.setTrueDrive\(tdeEnabled\)/.test(applyTde)
  && /localStorage\.setItem\('c64emu\.tde'/.test(applyTde) && /_syncTdeBtn\(\)/.test(applyTde),
  'One function applies a TDE choice: the machine, the stored preference and the button label');
expect(
  /_applyTde\(!tdeEnabled\);/.test(toggle),
  'The toggle button goes through it rather than setting the flag itself'
);
expect(
  /if \(tdeEnabled\) rearmPrgTdeOffer\(\);/.test(toggle),
  'Switching emulation back on by hand arms the offer again, so a decline is not a dead end'
);
expect(
  !/rearmPrgTdeOffer/.test(applyTde),
  'and the offer made during a load does not re-arm itself'
);
expect(
  /export function rearmPrgTdeOffer\(\)[\s\S]*?removeItem\(_PRG_TDE_DECLINED_KEY\)/.test(media),
  'Re-arming forgets the remembered decline'
);

// ── The dialog names its own way out ───────────────────────────────────────
expect(
  /cancelLabel = 'CANCEL'/.test(dialogs) && /confirmModalCancel\.textContent = cancelLabel/.test(dialogs),
  'confirmDialog takes a cancel label and resets it on every call'
);
expect(
  /cancelLabel: 'Keep TDE on'/.test(offer),
  'The offer labels its other answer, since "CANCEL" would read as abandoning the load'
);

if (failures) {
  console.log(`\n${failures} PRG true-drive offer spec failure(s)`);
  process.exit(1);
}

console.log('ok  - Loading a .prg offers to switch true drive emulation off, once, when it is on');
