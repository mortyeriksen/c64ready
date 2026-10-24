// The User Guide's jump menu (tools/build-docs.mjs renderGuideJump): on phones
// the left menu has no room, so every guide page carries a menu in the top bar
// with all guide pages and their chapters, the current page selected.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderGuideJump } from '../tools/build-docs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function expect(cond, msg) { if (!cond) { failures++; console.log(`FAIL - ${msg}`); } }

const PAGES = ['USER-GUIDE', 'GUIDE-INTERFACE', 'GUIDE-MEDIA', 'GUIDE-INPUT', 'GUIDE-LOOKS', 'GUIDE-CHAT', 'GUIDE-OPTIONS', 'GUIDE-CLI'];
const tocs = new Map(PAGES.map((n) => [n, [
  { level: 2, id: 'topics', text: 'Topics' },
  { level: 2, id: `${n.toLowerCase()}-a`, text: `${n} chapter <A>` },
  { level: 3, id: `${n.toLowerCase()}-b`, text: `${n} section` },
]]));
const html = renderGuideJump('GUIDE-MEDIA', tocs);

expect((html.match(/<optgroup /g) || []).length === PAGES.length, 'one group per guide page, the overview included');
for (const n of PAGES) {
  const href = `/docs/${n.toLowerCase()}.html`;
  expect(html.includes(`value="${href}"`), `${n}: the page itself is an entry`);
  expect(html.includes(`value="${href}#${n.toLowerCase()}-a"`), `${n}: its chapters link to their anchors`);
}
expect(/value="\/docs\/guide-media\.html" selected/.test(html), 'the page being read is selected');
expect((html.match(/ selected/g) || []).length === 1, 'and only that one');
expect(!/#topics"/.test(html), 'the overview\'s "Topics" list is left out');
expect(html.includes('>· USER-GUIDE section<'), 'sections under a chapter are marked');
expect(html.includes('chapter &lt;A&gt;'), 'chapter titles are escaped');
expect(html.includes('data-page="/docs/guide-media.html"'), 'the menu knows its page, to follow the reader');

const build = fs.readFileSync(path.join(root, 'tools', 'build-docs.mjs'), 'utf8');
expect(/\.guide-jump \{ display: none; \}/.test(build), 'hidden where the left menu shows');
expect(/@media \(max-width: 860px\) \{[\s\S]*?\.doc-toc \{ display: none; \}[\s\S]*?\.guide-jump \{ display: block;/.test(build), 'shown at the same width the left menu goes away');

expect(/@media \(max-width: 860px\) and \(max-height: 500px\) \{[\s\S]*?\.doc-top:has\(\.guide-jump\) \{ flex-wrap: nowrap; \}/.test(build), 'a phone on its side keeps the bar to one row');

if (failures) { console.log(`\n${failures} guide jump assertion(s) failed`); process.exit(1); }
console.log('docs guide jump spec: PASS');
