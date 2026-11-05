// A game's file in the LOAD library is looked for by name before it is hashed: every file the
// tests know a game by (test/external-assets.json, the releases the sets were made for) must be
// named like the game, as its title or its version labels name it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { words, namesOf, nameMatches, findInLibrary } from '../../src/achievements/library-match.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let checks = 0, fails = 0;
function expect(ok, rule) { checks++; if (!ok) { fails++; console.log(`FAIL - ${rule}`); } }

expect(words("The Hitchhiker's Guide to the Galaxy").join() === 'hitchhiker,s,guide,to,galaxy', 'a name\'s words drop case, punctuation and the small words');
expect(namesOf('The Last Ninja', ['MultiLoad64 EasyFlash cartridge (Last Ninja, The (by $olo1870))', 'GHOSTNGA.D64']).join('|') === 'The Last Ninja|Last Ninja, The (by $olo1870)|GHOSTNGA.D64',
  'a game goes by its title, the release in a label\'s brackets, and a label without brackets whole');
expect(nameMatches('Last Ninja, The (by $olo1870) [EasyFlash].crt', ['The Last Ninja']), 'a file named with every word of the title matches, in any order');
expect(nameMatches('zorki-1541.d64', ['Zork I']), 'and with the title\'s letters run together');
expect(!nameMatches('Ninja Spirit.crt', ['The Last Ninja']), 'a file with only some of the words does not');

const sets = Object.fromEntries(fs.readdirSync(path.join(root, 'server/sets')).filter((f) => f.endsWith('.json'))
  .map((f) => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(root, 'server/sets', f), 'utf8'))]));
const ids = Object.keys(sets).sort((a, b) => b.length - a.length);
const assets = JSON.parse(fs.readFileSync(path.join(root, 'test/external-assets.json'), 'utf8'));
let named = 0;
for (const [key, asset] of Object.entries(assets.assets ?? assets)) {
  const id = ids.find((s) => key.startsWith(`${s}-`));
  const file = asset?.paths?.[0];
  if (!id || !file) continue;
  named++;
  const set = sets[id];
  expect(nameMatches(path.basename(file), namesOf(set.title, set.hashes.map((x) => x.label))), `${path.basename(file)} is named like ${set.title}`);
}
expect(named > 40, `the games' release files are checked (${named})`);

// Without a library (no IndexedDB here) there is nothing to load, and nothing is hashed.
let hashed = 0;
expect(await findInLibrary({ hashes: ['x'], names: ['Uridium'] }, async () => { hashed++; return 'x'; }) === null && hashed === 0, 'no library, no file');

if (fails) { console.log(`\n${fails} of ${checks} library match checks failed`); process.exit(1); }
console.log(`ok - library match: ${checks} checks`);
