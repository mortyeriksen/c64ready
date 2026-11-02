// Paperboy's OneLoad64 v5 score uses six packed BCD digits at $2A92-$2A94.
// $2A91 holds one spare life at the start, zero on the last bike and $FF after
// the final crash. $2A90 is $2F in the unpacked game. The score routine at
// $27F0-$2810 adds in decimal mode and carries through these three bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';
import { assetPath, missingNote } from '../external-assets.js';
import { C64Machine } from '../../src/machine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/paperboy.json'), 'utf8')), 'paperboy.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const unlocked = new Set(), board = [];
let fails = 0, checks = 0;
function expect(value, rule) { checks++; if (!value) { fails++; console.log(`FAIL - ${rule}`); } }
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    if ([EVENT.LBOARD_STARTED, EVENT.LBOARD_TRIGGERED, EVENT.LBOARD_CANCELED].includes(e.type)) board.push({ ...e });
  }
}
function frames(n = 2) { for (let i = 0; i < n; i++) frame(); }
function activate() {
  rc.clear(); ram.fill(0); unlocked.clear(); board.length = 0;
  for (const a of set.achievements) expect(rc.activateAchievement(a.id, a.memaddr) === 0, `${a.title} parses`);
  for (const l of set.leaderboards) expect(rc.activateLeaderboard(l.id, l.definition) === 0, `${l.title} parses`);
}
function score(n) {
  const s = String(n).padStart(6, '0');
  for (let i = 0; i < 3; i++) ram[0x2a92 + i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
}
function started() { return board.filter(e => e.type === EVENT.LBOARD_STARTED); }
function posted() { return board.filter(e => e.type === EVENT.LBOARD_TRIGGERED); }
function begin() { ram[0x2a90] = 0x2f; ram[0x2a91] = 1; score(0); frames(); }
function finish() { ram[0x2a91] = 0; frames(); ram[0x2a91] = 0xff; frames(); }
const has = title => unlocked.has(set.achievements.find(a => a.title === title).id);

activate();
expect(set.hashes[0].hash === 'ff7e7212443d9b28215df5777b05fc09', 'the set identifies the OneLoad cartridge');
const file = assetPath('paperboy-crt');
if (file) expect(rc.hash(fs.readFileSync(file)) === set.hashes[0].hash, 'the cartridge hashes to the set fingerprint');
else console.log(`ok  - cartridge hash # SKIP ${missingNote('paperboy-crt')}`);
for (const [key, index] of [['paperboy-crunched-prg', 1], ['paperboy-uncrunched-prg', 2]]) {
  const prg = assetPath(key);
  if (prg) expect(rc.hash(fs.readFileSync(prg)) === set.hashes[index].hash, `${key} hashes to its set fingerprint`);
  else console.log(`ok  - ${key} hash # SKIP ${missingNote(key)}`);
}

// Both PRG formats must put the scoring, lives and day routines at the same
// addresses. The crunched file unpacks before entering the game.
const uncrunched = assetPath('paperboy-uncrunched-prg');
const crunched = assetPath('paperboy-crunched-prg');
if (uncrunched && crunched && ['kernal.bin', 'basic.bin', 'chargen.bin'].every(n => fs.existsSync(path.join(root, 'roms', n)))) {
  const raw = fs.readFileSync(uncrunched);
  const base = raw[0] | raw[1] << 8;
  const image = new Uint8Array(0x10000);
  image.set(raw.subarray(2), base);
  const m = new C64Machine();
  m.loadROMs({ kernal: fs.readFileSync(path.join(root, 'roms/kernal.bin')), basic: fs.readFileSync(path.join(root, 'roms/basic.bin')), charRom: fs.readFileSync(path.join(root, 'roms/chargen.bin')) });
  for (let i = 0; i < 100; i++) m.runFrame();
  m.loadPRG(fs.readFileSync(crunched)); m.cpu.pc = 2061;
  for (let i = 0; i < 350; i++) m.runFrame();
  const from = 0x2000, to = 0x2b30;
  expect(m.mem.ram.subarray(from, to).every((v, i) => v === image[from + i]), 'the crunched PRG unpacks the same scoring, lives and day code');
  const game = new C64Machine();
  game.loadROMs({ kernal: fs.readFileSync(path.join(root, 'roms/kernal.bin')), basic: fs.readFileSync(path.join(root, 'roms/basic.bin')), charRom: fs.readFileSync(path.join(root, 'roms/chargen.bin')) });
  for (let i = 0; i < 200; i++) game.runFrame();
  game.loadPRG(raw);
  for (let i = 0; i < 150; i++) game.runFrame();
  expect(game.mem.ram[0x2a90] === 0x2f && game.mem.ram[0x2a91] === 1, 'the uncrunched PRG reaches play with the same signature and lives');
  expect(game.mem.ram[0x2a92] === 0 && game.mem.ram[0x2a93] === 0 && game.mem.ram[0x2a94] === 0, 'the uncrunched PRG starts with the same score bytes');
} else console.log('ok  - PRG memory comparison # SKIP both PRGs and the C64 ROMs are required');

activate(); frames(); begin();
expect(unlocked.size === 0 && started().length === 0, 'boot and zero score award nothing');
score(1); frames();
expect(has('Extra! Extra!') && started().length === 1, 'the first point begins a scored game');
score(99); frames(); expect(!has('First Edition'), '99 is below 100');
score(100); frames(); expect(has('First Edition'), '100 reaches First Edition');
score(999); frames(); expect(!has('Morning Rush'), '999 is below 1,000');
score(1000); frames(); expect(has('Morning Rush'), '1,000 reaches Morning Rush');
score(25000); frames(); expect(has('Press Baron'), 'all six BCD digits count');
finish();
expect(posted().length === 1 && posted()[0].value === 25000, 'the last crash posts the full score once');
expect(has('Stop the Presses') && has('Final Edition'), 'finish awards both endgame goals');
frames(4); expect(posted().length === 1, 'game over does not post twice');

activate(); begin(); score(500); frames(); ram[0x2a91] = 0; frames();
expect(!has('Last Bike Standing'), '500 points on the last bike is below 1,000');
score(1000); frames(); expect(has('Last Bike Standing'), '1,000 points on the last bike count');
finish(); expect(posted().length === 1 && posted()[0].value === 1000, 'the last bike posts its score');

activate(); begin(); ram[0x2a94] = 0xfa; frames();
expect(unlocked.size === 0 && started().length === 0, `invalid BCD does not award or start a score: ${[...unlocked]} / ${started().length}`);
activate(); begin(); finish();
expect(posted().length === 0, 'a scoreless game does not post');

activate(); begin(); ram[0x2b1e] = 0; ram[0x359a] = 0; frames();
score(12000); frames();
const days = ['Manic Monday', 'Tuesday Tribune', 'Hump Day', 'Thursday Dispatch', 'Thank Paper It\'s Friday', 'Weekend Special'];
for (let day = 0; day < 6; day++) {
  expect(!has(days[day]), `${days[day]} is locked before the day ends`);
  ram[0x359a] = day + 1; frames();
  expect(has(days[day]), `${days[day]} unlocks when its day is completed`);
}
ram[0x359a] = 0; frames();
expect(!has('Sunday Supplement'), 'resetting the day counter alone does not complete Sunday');
ram[0x359a] = 6; frames();
ram[0x359a] = 0; ram[0x2b1e] = 1; frames();
expect(has('Sunday Supplement'), 'Sunday unlocks when the week wraps in the completion routine');
expect(has('Stop the Presses') && has('Final Edition'), 'finishing Sunday counts as finishing a scored game');
expect(posted().length === 1 && posted()[0].value === 12000, 'the completed week posts the full score');

if (fails) { console.log(`\n${fails} of ${checks} Paperboy checks failed`); process.exit(1); }
console.log(`\nok - Paperboy set: ${checks} checks`);
