import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = fs.readFileSync(new URL('../src/dom.js', import.meta.url), 'utf8');
const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

const input = html.match(/<input\b(?=[^>]*\bid="state-filter")([^>]*)>/)?.[1] || '';
expect(input, 'Load State dialog has a filter input');
expect(/\btype="search"/.test(input), 'save-state filter uses a search input');
expect(/\baria-label="Filter save states"/.test(input), 'save-state filter has an accessible label');
expect(dom.includes("export const stateFilterEl    = document.getElementById('state-filter');"),
  'save-state filter is exposed through the DOM module');
expect(media.includes("all.filter(e => e.name.toLowerCase().includes(q))"),
  'save states are filtered case-insensitively by name');
expect(
  /all\.sort\(\(a, b\) =>\s*a\.name\.localeCompare\(b\.name, undefined, \{ sensitivity: 'base', numeric: true \}\)/s.test(media),
  'save states are sorted alphabetically by name'
);
expect(media.includes("stateFilterEl.addEventListener('input', _renderStateList)"),
  'typing in the save-state filter re-renders the list');
expect(media.includes('No save states match “${q}”.'),
  'an empty filtered result explains that no save states match');

if (failures) {
  console.log(`\n${failures} load-state-filter spec failure(s)`);
  process.exit(1);
}

console.log('ok  - Load State dialog filters save states by name');
