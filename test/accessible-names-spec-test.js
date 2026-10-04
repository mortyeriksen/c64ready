// Controls that show no text of their own still need an accessible name
// (WCAG 4.1.2, Name, Role, Value), and ARIA may only label an element that
// has a role. Checked in the markup:
//   1. Each control-port device menu is named by its "Port N" label.
//   2. Each LED carries a role, so the name the tooltip code gives it from its
//      title is a permitted aria-label.
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let failures = 0;
const expect = (cond, msg) => { if (!cond) { failures++; console.log(`FAIL - ${msg}`); } };

for (const n of [1, 2]) {
  const select = html.match(new RegExp(`<select[^>]*id="cp-device-p${n}"[^>]*>`))?.[0] || '';
  const ref = select.match(/aria-labelledby="([^"]+)"/)?.[1];
  const label = ref && html.match(new RegExp(`<[^>]*id="${ref}"[^>]*>([^<]*)<`))?.[1];
  expect(label === `Port ${n}`, `the port ${n} device menu is named "Port ${n}" by aria-labelledby (got ${JSON.stringify(label)})`);
}
for (const id of ['drive-led', 'drive-led-9', 'reu-led']) {
  const span = html.match(new RegExp(`<span[^>]*id="${id}"[^>]*>`))?.[0] || '';
  expect(/role="img"/.test(span) && /title="[^"]+"/.test(span), `#${id} has role="img" and a title for its name`);
}

if (failures) { console.log(`\n${failures} accessible-name failure(s)`); process.exit(1); }
console.log('ok  - accessible names: port device menus labelled, LEDs are named images');
