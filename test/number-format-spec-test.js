// Numbers in the app's text read the same on every machine.
//
// The interface is English, so a number in it is grouped the English way
// (19,656). A bare toLocaleString() takes the grouping from the host instead:
// a Norwegian system writes "19 656" and a German one "19.656", in the middle
// of an English sentence. Every number the app formats names its locale.
// Dates are left to the host, as people read those their own way.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !e.name.endsWith('-blob.js')) files.push(p);
  }
})(src);

const bare = [];
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/([\w$.\]\)]+)\.toLocaleString\(\s*\)/g)) {
      // A date, by how it is made on the same line: new Date(...).toLocaleString().
      if (/new Date\([^)]*\)$/.test(line.slice(0, m.index + m[1].length))) continue;
      bare.push(`${path.relative(src, file)}:${i + 1}  ${m[0]}`);
    }
  });
}

if (bare.length) {
  console.log(`FAIL test 1: every number names its locale`);
  for (const b of bare) console.log(`     - ${b}`);
  console.log(`\nFAILED - number format: ${bare.length} numbers take their grouping from the host`);
  process.exit(1);
}
console.log('ok  - test 1: every number names its locale');
console.log(`\nok - number format: 1 check over ${files.length} files`);
