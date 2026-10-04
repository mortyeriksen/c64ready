// The host keys the C64 matrix answers to (src/cia.js KEY_MAP). The C64 has no
// Tab key, so Tab is not mapped: it stays the browser's key for moving focus
// through the interface, the running machine included. INST/DEL sits at
// column 0, row 0 of the matrix and answers to Backspace and Delete.
import { KEY_MAP } from '../src/cia.js';

let failures = 0;
const expect = (cond, msg) => { if (!cond) { failures++; console.log(`FAIL - ${msg}`); } };
expect(!('Tab' in KEY_MAP), 'Tab is not a C64 key, so the matrix does not claim it');
for (const code of ['Backspace', 'Delete']) {
  expect(KEY_MAP[code]?.join() === '0,0', `${code} is INST/DEL (matrix column 0, row 0)`);
}
if (failures) { console.log(`\n${failures} keyboard map failure(s)`); process.exit(1); }
console.log('ok  - keyboard map: Tab left to the browser, Backspace and Delete are INST/DEL');
