// A game's file in the LOAD library is looked for by name before it is hashed: every file the
// tests know a game by (test/external-assets.json, the releases the sets were made for) must be
// named like the game, as its title or its version labels name it. And a folder of the player's
// own files puts each version of a game with a set into the library, and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { words, namesOf, nameMatches, findInLibrary, importFolder, hashedType, libraryIndex } from '../../src/achievements/library-match.js';
import { MAX_ENTRIES } from '../../src/media/library.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let checks = 0, fails = 0;
function expect(ok, rule) { checks++; if (!ok) { fails++; console.log(`FAIL - ${rule}`); } }

expect(words("The Hitchhiker's Guide to the Galaxy").join() === 'hitchhiker,s,guide,to,galaxy', 'a name\'s words drop case, punctuation and the small words');
expect(namesOf('The Last Ninja', ['MultiLoad64 EasyFlash cartridge (Last Ninja, The (by $olo1870))', 'GHOSTNGA.D64']).join('|') === 'The Last Ninja|Last Ninja, The (by $olo1870)|GHOSTNGA.D64',
  'a game goes by its title, the release in a label\'s brackets, and a label without brackets whole');
expect(nameMatches('Last Ninja, The (by $olo1870) [EasyFlash].crt', ['The Last Ninja']), 'a file named with every word of the title matches, in any order');
expect(nameMatches('zorki-1541.d64', ['Zork I']), 'and with the title\'s letters run together');
expect(!nameMatches('Ninja Spirit.crt', ['The Last Ninja']), 'a file with only some of the words does not');
expect(nameMatches('commando86.prg', ['Commando']), 'a word that starts with the name\'s letters matches');
expect(!nameMatches('Collection/Space War.d64', ['IO']) && nameMatches('Shooters/IO.d64', ['IO']), 'a name of two letters is only ever a whole word, never found inside another');
expect(!nameMatches('Mega Uridium Pack/Paradroid.d64', ['Ridium']), 'a name\'s letters are not found in the middle of a word');

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

// A folder of the player's own files: each version of a game with a set goes into the library.
{
  // A file as the folder picker gives it; its bytes are its hash, for a stand-in engine hash.
  const file = (relPath, hash) => ({ name: relPath.split('/').pop(), webkitRelativePath: relPath, arrayBuffer: async () => new TextEncoder().encode(hash).buffer });
  const read = [];
  const hashOf = async (bytes) => { const h = new TextDecoder().decode(bytes); read.push(h); return h; };
  const games = [
    { title: 'Uridium', hashes: ['uri-1', 'uri-2'], labels: ['URIDIUM.PRG', ''] },
    { title: 'The Last Ninja', hashes: ['ln-side1', 'ln-side2'], labels: ['LNINJA1.D64', 'LNINJA2.D64'] },
  ];
  const library = (entries = []) => {
    const saved = [];
    return { saved, list: async () => entries, load: async (id) => ({ data: new TextEncoder().encode(entries.find((e) => e.id === id).hash) }), save: async (type, name, data) => { saved.push({ type, name, hash: new TextDecoder().decode(data) }); return true; } };
  };
  const folder = [
    file('C64/Games/Uridium.prg', 'uri-1'),
    file('C64/Games/uridium (hack).prg', 'uri-hacked'),
    file('C64/Games/Last Ninja/side1.d64', 'ln-side1'),
    file('C64/Games/Paradroid.d64', 'paradroid'),
    file('C64/Games/Uridium.zip', 'uri-2'),
  ];
  const lib = library([{ id: 'a', type: 'prg', name: 'Uridium.prg', size: 10, savedAt: 1, hash: 'uri-1' }]);
  const r = await importFolder(folder, games, hashOf, () => {}, lib);
  expect(hashedType('x.D64') === 'd64' && hashedType('x.zip') === null, 'only the files the engine hashes and the library keeps are looked at');
  expect(!read.includes('paradroid') && !read.includes('uri-2'), 'a file named like no game, or of a type not kept, is never read');
  expect(!lib.saved.some((x) => x.hash === 'uri-hacked'), 'a file named like a game but with none of its hashes is not added');
  expect(!lib.saved.some((x) => x.hash === 'uri-1'), 'a version the library holds already is not added again');
  expect(lib.saved.some((x) => x.hash === 'ln-side1' && x.type === 'd64' && x.name === 'The Last Ninja - side1.d64'), `a file found by its folder's name is added, named with the game's title (${JSON.stringify(lib.saved)})`);
  expect(r.added.length === 1 && r.games.sort().join() === 'The Last Ninja,Uridium' && r.full === 0, `it says what it added and every game it found (${JSON.stringify(r)})`);
  const full = library(Array.from({ length: MAX_ENTRIES }, (_, i) => ({ id: `e${i}`, type: 'sid', name: `tune${i}.sid`, size: 1, savedAt: 1 })));
  const r2 = await importFolder([file('Uridium.prg', 'uri-2')], games, hashOf, () => {}, full);
  expect(full.saved.length === 0 && r2.full === 1, 'a full library takes nothing more, so nothing kept there is pushed out, and says how many were left out');
}

// GAMES: every listed game with a version in the library, found in one pass, hashing only files named like a game.
{
  const read = [];
  const hashOf = async (bytes) => { const h = new TextDecoder().decode(bytes); read.push(h); return h; };
  const entries = [
    { id: 'new', type: 'crt', name: 'Bomb Jack.crt', size: 1, savedAt: 3, hash: 'bj-1' },
    { id: 'old', type: 'crt', name: 'Bomb Jack (old).crt', size: 1, savedAt: 2, hash: 'bj-1' },
    { id: 'hack', type: 'prg', name: 'Uridium hack.prg', size: 1, savedAt: 2, hash: 'uri-hacked' },
    { id: 'ln', type: 'd64', name: 'LNINJA1.D64', size: 1, savedAt: 1, hash: 'ln-side1' },
    { id: 'para', type: 'd64', name: 'Paradroid.d64', size: 1, savedAt: 1, hash: 'paradroid' },
    { id: 'tune', type: 'sid', name: 'Bomb Jack.sid', size: 1, savedAt: 1, hash: 'bj-1' },
  ];
  const lib = { list: async () => entries, load: async (id) => ({ data: new TextEncoder().encode(entries.find((e) => e.id === id).hash) }) };
  const games = [
    { hash: 'bj-1', title: 'Bomb Jack' },
    { hash: 'uri-1', hashes: ['uri-1', 'uri-2'], title: 'Uridium' },
    { hash: 'ln-side1', hashes: ['ln-side1', 'ln-side2'], title: 'The Last Ninja', labels: ['LNINJA1.D64'] },
    { hash: 'gng', title: 'Ghosts \u2019n Goblins' },
  ];
  const found = await libraryIndex(games, hashOf, lib);
  expect(found.get('bj-1') === 'new', `a game in the library is found, its newest entry when there are several (${JSON.stringify([...found])})`);
  expect(found.get('ln-side1') === 'ln', 'a file named by a version label is found too');
  expect(!found.has('uri-1'), 'a file named like a game but with none of its hashes is not it');
  expect(!found.has('gng'), 'a game with no file in the library is not found');
  expect(!read.includes('paradroid') && !read.includes('old') && read.filter((h) => h === 'bj-1').length === 1, `only files named like a game still unfound are read, and no type the engine does not hash (${JSON.stringify(read)})`);
  hashed = 0;
  expect((await libraryIndex(games, async () => { hashed++; return 'x'; })).size === 0 && hashed === 0, 'no library, no games found');
}

if (fails) { console.log(`\n${fails} of ${checks} library match checks failed`); process.exit(1); }
console.log(`ok - library match: ${checks} checks`);
