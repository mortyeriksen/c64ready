// The User Guide's jump menu (tools/build-docs.mjs renderGuideJump): on phones
// the left menu has no room, so every guide page carries a menu in the top bar
// with all guide pages and their chapters, the current page selected.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderGuideJump, renderDocPage, renderIndex } from '../tools/build-docs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function expect(cond, msg) { if (!cond) { failures++; console.log(`FAIL - ${msg}`); } }

const PAGES = ['USER-GUIDE', 'GUIDE-INTERFACE', 'GUIDE-MONITOR', 'GUIDE-MEDIA', 'GUIDE-INPUT', 'GUIDE-LOOKS', 'GUIDE-CHAT', 'GUIDE-OPTIONS', 'GUIDE-CLI'];
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

const COMPONENTS = ['CPU', 'MEMORY', 'VIC', 'SID', 'CIA', 'DRIVE', 'TAPE', 'CRT', 'REU'].map(name => `COMPONENT-GUIDE-${name}`);
const HARDWARE = ['INSIDE-THE-C64', ...COMPONENTS];
const hardwareTocs = new Map(HARDWARE.map(name => [name, [{level:2,id:'the-story',text:'The story'}]]));
const hardwareJump = renderGuideJump('COMPONENT-GUIDE-VIC', hardwareTocs);
expect((hardwareJump.match(/<optgroup /g) || []).length === HARDWARE.length, 'hardware jump menu contains the hub and all nine chapters');
expect(hardwareJump.includes('aria-label="Inside the C64: go to a page or chapter"'), 'hardware jump menu identifies its own guide');
expect(!hardwareJump.includes('/docs/user-guide.html'), 'hardware jump menu stays within the hardware guide');
expect(!html.includes('/docs/component-guide-'), 'User Guide navigation remains separate');
for (const name of HARDWARE) {
  const href = name.toLowerCase();
  expect(hardwareJump.includes(`value="/docs/${href}.html#the-story"`), `${name}: chapter sections are reachable from the jump menu`);
  const rendered = renderDocPage({name,href,title:name,desc:'A component guide.'}, '<h1>Component</h1>', []);
  expect(rendered.includes('class="doc-toc guide-nav" aria-label="Inside the C64"'), `${name}: has the shared hardware sidebar`);
  expect(rendered.includes(`href="/docs/${href}.html" aria-current="page"`), `${name}: sidebar marks the current page`);
  if (name !== 'INSIDE-THE-C64') {
    expect(rendered.includes('<a href="/docs/inside-the-c64.html">Inside the C64</a> <span>/</span>'), `${name}: breadcrumb leads to the hardware hub`);
    const i = COMPONENTS.indexOf(name);
    const previous = (COMPONENTS[i-1] || 'INSIDE-THE-C64').toLowerCase();
    const next = (COMPONENTS[i+1] || 'INSIDE-THE-C64').toLowerCase();
    expect(rendered.includes(`class="guide-pager-prev" href="/docs/${previous}.html"`), `${name}: previous link follows chapter order or returns to the hub`);
    expect(rendered.includes(`class="guide-pager-next" href="/docs/${next}.html"`), `${name}: next link follows chapter order or returns to the hub`);
  }
}
const index = renderIndex([...PAGES, ...HARDWARE].map(name => ({slugFile:name,href:name.toLowerCase(),title:name,desc:'A guide.'})));
expect((index.match(/href="\/docs\/inside-the-c64.html"/g)||[]).length===1, 'docs overview presents exactly one hardware guide entry');
expect(!index.includes('href="/docs/component-guide-'), 'individual hardware chapters are not separate docs overview entries');
expect(index.includes('href="/docs/user-guide.html"'), 'docs overview retains the User Guide hub');

if (failures) { console.log(`\n${failures} guide jump assertion(s) failed`); process.exit(1); }
console.log('docs guide jump spec: PASS');
