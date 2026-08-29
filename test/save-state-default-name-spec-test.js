import fs from 'fs';

const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

expect(
  /const def = \(currentD64[\s\S]*?\|\| _cachedTapName \|\| _currentCartInfo\?\.name \|\| 'Save state';/.test(media),
  'Save State uses the loaded cartridge name when no disk or tape names the state'
);

if (failures) {
  console.log(`\n${failures} save-state default-name spec failure(s)`);
  process.exit(1);
}

console.log('ok  - Save State defaults to the loaded cartridge name');
