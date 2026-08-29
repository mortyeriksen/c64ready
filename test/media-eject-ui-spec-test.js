import fs from 'fs';

const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

const indicatorUpdater = media.match(
  /export function updateMediaIndicators\(live = true\) \{([\s\S]*?)\n\}\n\n\/\/ PETSCII/
)?.[1] || '';

expect(
  /function _syncD64EjectButton\(\)[\s\S]*?currentD64, driveDropzone/.test(media),
  'Drive 8 EJECT follows its current disk or inserted UI state'
);
expect(
  /function _syncD64Drive9EjectButton\(\)[\s\S]*?currentD64Drive9, DRIVE9_UI\.dropzone/.test(media),
  'Drive 9 EJECT follows its current disk or inserted UI state'
);
expect(
  /function _syncCRTEjectButton\(\)[\s\S]*?machine\?\.mem\?\.cartridge, _cachedCartData, crtDropzone/.test(media),
  'Cartridge EJECT follows its live, cached, or inserted UI state'
);
expect(
  /function _syncTapEjectButton\(\)[\s\S]*?machine\?\.datasette\?\.hasMedia, _cachedTapData, tapeDropzone/.test(media),
  'Datasette EJECT follows its live, cached, or inserted UI state'
);
expect(
  /async function _loadState[\s\S]*?_syncD64EjectButton\(\)[\s\S]*?_syncD64Drive9EjectButton\(\)[\s\S]*?_syncCRTEjectButton\(\)[\s\S]*?_syncTapEjectButton\(\)/.test(media) &&
    !indicatorUpdater.includes('EjectButton()'),
  'State restore synchronizes every EJECT button without per-frame polling'
);

if (failures) {
  console.log(`\n${failures} media-eject UI spec failure(s)`);
  process.exit(1);
}

console.log('ok  - All media EJECT buttons follow inserted media');
