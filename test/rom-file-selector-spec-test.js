import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

function attrsForInput(id) {
  const re = new RegExp(`<input\\b(?=[^>]*\\bid="${id}")([^>]*)>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

for (const id of ['rom-kernal', 'rom-basic', 'rom-char', 'rom-1541']) {
  const attrs = attrsForInput(id);
  expect(attrs !== null, `${id}: ROM file selector must exist`);
  expect(attrs && /\btype="file"/.test(attrs), `${id}: ROM selector must be a file input`);
  expect(attrs && /\baccept="\.bin,\.rom"/.test(attrs),
    `${id}: ROM selector must accept .bin and .rom files`);
}

if (failures) {
  console.log(`\n${failures} rom-file-selector spec failure(s)`);
  process.exit(1);
}

console.log('ok  - ROM file selectors accept .bin and .rom');
