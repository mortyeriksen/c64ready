// Spec test for the stylesheets' :has() rules (src/**/*.css): a rule that goes on
// past its :has() must end in a compound with a class, an id, an attribute or a
// tag. Ending in a bare pseudo-class or `*`, as in `.card:has(.shot) > :not(.shot)`,
// tells the browser that anything under any :has() anchor may change, and with
// an anchor on body every node put into or taken out of the page then restyles
// the whole page, whether or not the rule matches an element.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

// Brackets and their contents out, innermost first, so a compound is left as its own classes, ids and tag.
function flat(selector) {
  let s = selector, was;
  do { was = s; s = s.replace(/\([^()]*\)/g, '()').replace(/\[[^\[\]]*\]/g, '[attr]'); } while (s !== was);
  return s;
}
/** The selectors of `css` that go on past a :has() and end in a compound without a class, id, attribute or tag. */
function looseAfterHas(css) {
  const loose = [];
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) ?? [];
  for (const rule of rules) {
    // Commas at the top level part the selectors: those inside brackets are gone once flattened.
    const marked = rule.replace(/\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)/g, (m) => m.replaceAll(',', '\u0001'));
    for (const one of marked.split(',')) {
      const selector = one.replaceAll('\u0001', ',').trim();
      if (!selector.includes(':has(')) continue;
      const compounds = flat(selector).split(/\s*[>+~]\s*|\s+/).filter(Boolean);
      const last = compounds.at(-1);
      // The :has() is on the subject itself: only that element is drawn again.
      if (last.includes(':has()')) continue;
      const own = last.replace(/::?[\w-]+(\(\))?/g, '');
      if (!/[.#][\w-]|\[attr\]|^[a-z][\w-]*/i.test(own)) loose.push(selector);
    }
  }
  return loose;
}

// The rule itself, on selectors written here.
expect(looseAfterHas('.a:has(.b) > :not(.c) { x: y }').length === 1, 'a bare :not() after :has() is loose');
expect(looseAfterHas('.a:has(.b) * { x: y }').length === 1, 'a universal subject after :has() is loose');
expect(looseAfterHas('.a:has(.b, .c) > :is(.d, .e)::after { x: y }').length === 1, 'a bare :is() with a pseudo-element after :has() is loose');
expect(looseAfterHas('.a:has(.b) { x: y }').length === 0, 'a :has() on the subject is fine');
expect(looseAfterHas('.a:has(.b:not([hidden])) .c:not(.d) { x: y }').length === 0, 'a subject with a class is fine');
expect(looseAfterHas('.a:has(.b) > [hidden] { x: y }\n.a:has(.b) canvas { x: y }\n.a:has(+ .b) #c::before { x: y }').length === 0, 'a subject with an attribute, a tag or an id is fine');
expect(looseAfterHas('.a > :not(.b) { x: y }\n.a, .b:has(.c) { x: y }').length === 0, 'a rule without :has(), or with it on the subject of one selector of a list, is fine');
ok('what counts as a loose subject after :has()');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const sheets = fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.css'));
expect(sheets.length > 10, `the stylesheets are found (${sheets.length})`);
let rules = 0;
for (const file of sheets) {
  const css = fs.readFileSync(path.join(root, file), 'utf8');
  rules += (css.match(/:has\(/g) ?? []).length;
  for (const selector of looseAfterHas(css)) expect(false, `src/${file}: \`${selector}\` ends in a compound without a class, id, attribute or tag after :has()`);
}
expect(rules > 0, 'the stylesheets hold :has() rules to check');
ok(`no stylesheet rule ends loose after :has() (${rules} uses in ${sheets.length} stylesheets)`);

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - :has() rules: ${testNo} checks`);
