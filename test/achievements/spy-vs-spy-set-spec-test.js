import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { GAME_ICONS } from '../../src/achievements/game-icons.js';
import { nibFileToG64 } from '../../src/media/nib.js';
import { C64Machine } from '../../src/machine.js';
import { checkSet } from '../../server/games.mjs';
import { collectionFile } from '../external-assets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const names = ['spy-vs-spy', 'spy-vs-spy-ii', 'spy-vs-spy-iii'];
const sets = names.map((name) => checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets', `${name}.json`), 'utf8')), name));
const rc = await loadRcheevos();
let checks = 0, fails = 0;
function expect(ok, rule) { checks++; if (!ok) { fails++; console.log(`FAIL - ${rule}`); } }
const ram = new Uint8Array(0x10000);
const earned = new Set();
function frame() { for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) earned.add(e.id); }
function activate(set) {
  rc.clear(); ram.fill(0); earned.clear();
  for (const a of set.achievements) expect(rc.activateAchievement(a.id, a.memaddr) === 0, `${set.id}: ${a.title} parses`);
}
function embassy() { ram[0x7429] = 0xb5; ram[0x742a] = 0x79; ram[0x93] = 6; ram[0x91] = 59; }
function island() { ram[0x6400] = 0xa9; ram[0x6401] = 0x28; ram[0x38] = 5; ram[0x37] = 59; ram[0x6f] = 0xff; }
function arctic() { ram[0x6400] = 0x78; ram[0x6401] = 0xd8; ram[0x38] = 17; ram[0x37] = 59; }

expect(sets.reduce((n, s) => n + s.hashes.length, 0) === 16, 'all 16 code-compatible single-game C64 media fingerprints are assigned');
const allHashes = sets.flatMap((s) => s.hashes.map((h) => h.hash));
expect(new Set(allHashes).size === allHashes.length, 'every media hash belongs to exactly one set');
expect(sets.map((s) => s.leaderboards.length).join(',') === '2,1,1', 'the trilogy has an embassy score board and one escape speed board per game');
expect(sets[0].leaderboards[1].format === 'SCORE' && sets[0].leaderboards[1].lowerIsBetter === false, 'the original game ranks its native score');
expect(sets.every((s) => s.leaderboards[0].format === 'MILLISECS' && s.leaderboards[0].lowerIsBetter), 'all escape speed boards rank shorter times');
expect(sets.map((s) => s.achievements.length).join(',') === '18,18,16', 'the trilogy has item, level clear and last-minute escape trophies');
for (const set of sets) {
  const icon = GAME_ICONS[set.id];
  expect(icon?.length === 10 && icon.every((row) => /^[#+.]{10}$/.test(row)), `${set.id}: the game has a complete 10 by 10 icon`);
}
expect(new Set(sets.map((set) => GAME_ICONS[set.id].join(''))).size === 3, 'each Spy vs. Spy game has its own icon');

activate(sets[0]);
frame(); embassy(); frame();
expect(earned.has(1) && earned.size === 1, 'the White Spy mission starts after the timer begins');
ram[0x7b] = 10; frame();
expect(earned.has(18), 'picking up the embassy briefcase unlocks its own trophy');
for (const [bit, id] of [[1, 2], [2, 3], [4, 4], [8, 5]]) {
  ram[0x79] |= bit; frame();
  expect(earned.has(id), `the embassy item flag ${bit} unlocks its own trophy`);
}
expect(earned.has(6), 'carrying all four items unlocks Full Briefcase');
ram[0x84] = 0xc1; frame();
expect(!earned.has(7), 'a spring trap does not count as blowing up the opponent');
ram[0x84] = 0xc0; frame();
expect(earned.has(7), 'the Black Spy entering the bomb explosion state unlocks Boom, Spy!');
ram[0x41] = 0; ram[0x287] = 1; ram[0x6400] = 0; ram[0x255] = 5; frame();
expect(earned.has(8), 'the White Spy getaway screen unlocks Getaway Plane');
expect(earned.has(9) && !earned.has(10), 'the level 1 embassy escape unlocks only its own level trophy');

activate(sets[0]); frame(); ram[0x79] = 15; ram[0x84] = 0xc0; frame();
expect(earned.size === 0, 'title screen values cannot award embassy trophies without the game code and timer');
embassy(); frame();
expect(!earned.has(7), 'an already active bomb state is not a new explosion');
expect(!earned.has(8), 'a clock loss cannot award an embassy escape');

activate(sets[0]); frame(); embassy(); ram[0x41] = 1; ram[0x256] = 5; ram[0x6400] = 0; ram[0x287] = 1; frame();
expect(!earned.has(8), 'the Black Spy getaway screen cannot award the White Spy escape');

activate(sets[1]); frame(); island(); ram[0x263] = 1; frame();
expect(earned.has(1), 'Spy Island begins when its game code and clock are active');
for (const [value, id] of [[0, 14], [3, 15], [4, 16], [44, 17], [64, 18]]) {
  ram[0x6f] = value; frame();
  expect(earned.has(id), `the White Spy carrying island tool ${value} unlocks its trophy`);
}
ram[0xd9] = 1; frame();
expect(earned.has(2), 'the first carried missile section unlocks Missile Discovery');
ram[0xd9] = 2; frame();
expect(earned.has(5), 'two joined missile sections unlock their own trophy');
ram[0xd9] = 3; frame();
expect(earned.has(3), 'the fully assembled missile unlocks Missile Ready');
ram[0x211] = 1; ram[0xd2] = 1; frame();
expect(earned.has(4), 'the White Spy boarding the submarine unlocks Submarine Escape');
expect(earned.has(6) && !earned.has(7), 'the level 1 island escape unlocks only its own level trophy');
activate(sets[1]); frame(); arctic(); frame();
expect(earned.size === 0, 'Arctic code cannot award the Island Caper trophy');
activate(sets[2]); frame(); arctic(); ram[0x263] = 1; frame();
expect(earned.has(1), 'Arctic Antics begins when its own game code and clock are active');
ram[0x6f] = 0x39; frame();
expect(earned.has(2), 'picking up the launch briefcase unlocks its trophy');
ram[0x3e3] = 0x30; frame();
expect(earned.has(3), 'the first launch item icon unlocks the punch card trophy');
ram[0x3e3] = 0x3c; frame();
expect(earned.has(4), 'the second launch item icon unlocks the gyroscope trophy');
ram[0x3e3] = 0x3f; frame();
expect(earned.has(5), 'the third launch item unlocks the fuel canister trophy');
ram[0x3e3] = 0x15; frame();
expect(earned.has(6) && !earned.has(8), 'finding every Arctic item does not claim the case is packed');
ram[0x3e5] = 0x3f; ram[0x25f] = 6; ram[0xde] = 1; ram[0x25d] = 6; frame();
expect(earned.has(7), 'the White Spy rocket launch unlocks its escape trophy');
expect(earned.has(8), 'a complete launch briefcase unlocks Packed for Launch');
expect(earned.has(9) && !earned.has(10), 'the level 1 Arctic escape unlocks only its own level trophy');

for (const [index, firstId, count, levelAddr] of [[0, 9, 8, 0x22c], [1, 6, 7, 0xd1], [2, 9, 7, 0xd1]]) {
  for (let level = 0; level < count; level++) {
    rc.clear(); ram.fill(0); earned.clear();
    const trophy = sets[index].achievements[firstId + level - 1];
    expect(rc.activateAchievement(trophy.id, trophy.memaddr) === 0, `${trophy.title} parses`);
    if (index === 0) embassy(); else if (index === 1) island(); else arctic();
    ram[levelAddr] = level;
    frame();
    if (index === 0) { ram[0x41] = 0; ram[0x287] = 1; ram[0x6400] = 0; ram[0x255] = 5; }
    else if (index === 1) { ram[0xd9] = 3; ram[0x211] = 1; ram[0xd2] = 1; }
    else { ram[0x6f] = 0x39; ram[0x3e5] = 0x3f; ram[0x25f] = 6; ram[0xde] = 1; ram[0x25d] = 6; }
    frame();
    expect(earned.has(trophy.id), `${trophy.title} unlocks at its selected level`);
  }
}
for (const [index, minutes, seconds] of [[0, 0x93, 0x91], [1, 0x38, 0x37], [2, 0x38, 0x37]]) {
  rc.clear(); ram.fill(0); earned.clear();
  const trophy = sets[index].achievements.find((a) => a.id === [17, 13, 16][index]);
  expect(rc.activateAchievement(trophy.id, trophy.memaddr) === 0, `${trophy.title} parses`);
  if (index === 0) embassy(); else if (index === 1) island(); else arctic();
  ram[minutes] = 0; ram[seconds] = 0x30; frame();
  if (index === 0) { ram[0x41] = 0; ram[0x287] = 1; ram[0x6400] = 0; ram[0x255] = 5; }
  else if (index === 1) { ram[0xd9] = 3; ram[0x211] = 1; ram[0xd2] = 1; }
  else { ram[0x6f] = 0x39; ram[0x3e5] = 0x3f; ram[0x25f] = 6; ram[0xde] = 1; ram[0x25d] = 6; }
  frame();
  expect(earned.has(trophy.id), `${trophy.title} unlocks with seconds left`);
  rc.clear(); ram.fill(0); earned.clear();
  rc.activateAchievement(trophy.id, trophy.memaddr);
  if (index === 0) embassy(); else if (index === 1) island(); else arctic();
  ram[minutes] = 0; ram[seconds] = 0; frame();
  if (index === 0) { ram[0x41] = 0; ram[0x287] = 1; ram[0x6400] = 0; ram[0x255] = 5; }
  else if (index === 1) { ram[0xd9] = 3; ram[0x211] = 1; ram[0xd2] = 1; }
  else { ram[0x6f] = 0x39; ram[0x3e5] = 0x3f; ram[0x25f] = 6; ram[0xde] = 1; ram[0x25d] = 6; }
  frame();
  expect(!earned.has(trophy.id), `${trophy.title} does not unlock after time expires`);
}

for (const set of sets) for (const l of set.leaderboards) {
  rc.clear();
  expect(rc.activateLeaderboard(l.id, l.definition) === 0, `${set.id}: ${l.title} parses`);
}
{
  rc.clear(); ram.fill(0);
  const events = [];
  for (const l of sets[0].leaderboards) rc.activateLeaderboard(l.id, l.definition);
  const tick = (n = 1) => { for (let i = 0; i < n; i++) events.push(...rc.doFrame(ram)); };
  tick(); embassy(); tick(100);
  ram[0x93] = 0; ram[0x91] = 30; tick();
  ram[0x41] = 0; ram[0x287] = 1; ram[0x6400] = 0; ram[0x255] = 5; ram[0x45] = 3; tick();
  ram[0x2bd] = 0x28; ram[0x2bb] = 0x07; ram[0x45] = 2; tick();
  expect(events.some((e) => e.type === EVENT.LBOARD_TRIGGERED && e.id === 1 && e.value >= 190 && e.value <= 210), 'the embassy speed board measures about two seconds');
  expect(events.some((e) => e.type === EVENT.LBOARD_TRIGGERED && e.id === 2 && e.value === 2807), 'the embassy score board decodes the native BCD score');
}
{
  rc.clear(); ram.fill(0);
  const events = [];
  for (const l of sets[0].leaderboards) rc.activateLeaderboard(l.id, l.definition);
  const tick = () => events.push(...rc.doFrame(ram));
  tick(); embassy(); tick();
  ram[0x93] = 0; ram[0x91] = 0; tick();
  ram[0x41] = 0; ram[0x287] = 1; ram[0x255] = 5; ram[0x45] = 2; tick();
  expect(!events.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'an embassy clock loss cannot submit either board');
}
{
  rc.clear(); ram.fill(0);
  const events = [];
  rc.activateLeaderboard(1, sets[1].leaderboards[0].definition);
  const tick = (n = 1) => { for (let i = 0; i < n; i++) events.push(...rc.doFrame(ram)); };
  tick(); island(); ram[0x263] = 1; tick(100);
  ram[0x38] = 0; ram[0x37] = 30; tick();
  ram[0xd9] = 3; ram[0x211] = 1; ram[0xd2] = 1; tick();
  expect(events.some((e) => e.type === EVENT.LBOARD_TRIGGERED && e.value >= 190 && e.value <= 210), 'the submarine speed board submits a White Spy escape');
}
{
  rc.clear(); ram.fill(0);
  const events = [];
  rc.activateLeaderboard(1, sets[1].leaderboards[0].definition);
  const tick = () => events.push(...rc.doFrame(ram));
  tick(); island(); ram[0x263] = 1; tick();
  ram[0xd2] = 1; ram[0xd9] = 3; tick();
  expect(!events.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'reaching the submarine without the assembled missile cannot submit');
  ram[0xd2] = 0; ram[0x211] = 1; ram[0x38] = 0; ram[0x37] = 0; tick();
  ram[0xd2] = 1; tick();
  expect(!events.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'the volcano timeout cancels an Island speedrun');
}
{
  rc.clear(); ram.fill(0);
  const events = [];
  rc.activateLeaderboard(1, sets[2].leaderboards[0].definition);
  const tick = (n = 1) => { for (let i = 0; i < n; i++) events.push(...rc.doFrame(ram)); };
  tick(); arctic(); ram[0x263] = 1; tick(100);
  ram[0x38] = 0; ram[0x37] = 30; tick();
  ram[0x6f] = 0x39; ram[0x3e5] = 0x3f; ram[0x25f] = 6; ram[0xde] = 1; ram[0x25d] = 6; tick();
  expect(events.some((e) => e.type === EVENT.LBOARD_TRIGGERED && e.value >= 190 && e.value <= 210), 'the rocket speed board submits a White Spy escape');
}
{
  rc.clear(); ram.fill(0);
  const events = [];
  rc.activateLeaderboard(1, sets[2].leaderboards[0].definition);
  const tick = () => events.push(...rc.doFrame(ram));
  tick(); arctic(); ram[0x263] = 1; tick();
  ram[0x6f] = 0x39; ram[0x25f] = 6; ram[0xde] = 1; ram[0x25d] = 6; tick();
  expect(!events.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'a rocket animation without the filled case cannot submit');
  ram[0x38] = 0; ram[0x37] = 0; tick();
  ram[0x3e5] = 0x3f; ram[0x25d] = 7; tick(); ram[0x25d] = 6; tick();
  expect(!events.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'the blizzard timeout cancels an Arctic speedrun');
}

const media = [
  ['Spy vs Spy.crt', 'AlternativeFormats/PRGs/Crunched/Spy vs Spy.prg', 'AlternativeFormats/PRGs/Uncrunched/Spy vs Spy.prg', 'Dumps/SourceFiles/Spy vs Spy (First Star Software).tap'],
  ['Spy vs Spy II - The Island Caper.crt', 'AlternativeFormats/PRGs/Crunched/Spy vs Spy II - The Island Caper.prg', 'AlternativeFormats/PRGs/Uncrunched/Spy vs Spy II - The Island Caper.prg', 'Dumps/SourceFiles/Spy vs Spy II (First Star Software).tap'],
  ['Spy vs Spy III - Arctic Antics.crt', 'AlternativeFormats/PRGs/Crunched/Spy vs Spy III - Arctic Antics.prg', 'AlternativeFormats/PRGs/Uncrunched/Spy vs Spy III - Arctic Antics.prg', 'Dumps/SourceFiles/Spy vs Spy III (Spy vs Spy Trilogy).tap'],
];
const disks = [
  ['spy_vs_spy[first_star_1984](m4)(!).nbz', 'spy_vs_spy[first_star_1984](m4)(alt).nbz'],
  ['spy_vs_spy_the_island_caper[first_star_1985].nbz'],
  ['spy_vs_spy_arctic_antics[first_star_1987](pal)(!).nbz'],
];
for (let setIndex = 0; setIndex < sets.length; setIndex++) {
  const files = media[setIndex].map((f) => `OneLoad64-Games-Collection-v5/${f}`);
  for (const f of disks[setIndex]) files.push(`c64pp/${f}`);
  expect(files.length === sets[setIndex].hashes.length, `${sets[setIndex].id} labels each file in its media family`);
  for (const [i, rel] of files.entries()) {
    const file = collectionFile('c64stuff', rel);
    if (!fs.existsSync(file)) { console.log(`ok  - ${rel} fingerprint # SKIP media absent from c64stuff collection`); continue; }
    const bytes = fs.readFileSync(file);
    const loaded = rel.endsWith('.nbz') ? nibFileToG64(bytes).g64 : bytes;
    expect(rc.hash(loaded) === sets[setIndex].hashes[i].hash, `${rel} hashes to its listed fingerprint`);
  }
}

const roms = ['kernal.bin', 'basic.bin', 'chargen.bin'].map((n) => path.join(root, 'roms', n));
if (roms.every((file) => fs.existsSync(file))) {
  for (const [index, name] of ['Spy vs Spy', 'Spy vs Spy II - The Island Caper', 'Spy vs Spy III - Arctic Antics'].entries()) {
    const file = collectionFile('c64stuff', `OneLoad64-Games-Collection-v5/${name}.crt`);
    if (!fs.existsSync(file)) { console.log(`ok  - ${name} C64 READY boot # SKIP cartridge absent from c64stuff collection`); continue; }
    const m = new C64Machine();
    m.loadROMs({ kernal: fs.readFileSync(roms[0]), basic: fs.readFileSync(roms[1]), charRom: fs.readFileSync(roms[2]) });
    m.loadCartridge(fs.readFileSync(file));
    rc.clear();
    expect(rc.activateAchievement(1, sets[index].achievements[0].memaddr) === 0, `${name} live opening trophy parses`);
    for (const board of sets[index].leaderboards) expect(rc.activateLeaderboard(board.id, board.definition) === 0, `${name} live board ${board.title} parses`);
    const live = new Set();
    const liveBoards = [];
    const runFrames = (count) => {
      for (let f = 0; f < count; f++) {
        m.runFrame();
        for (const e of rc.doFrame(m.mem.ram)) {
          if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) live.add(e.id);
          if (e.type === EVENT.LBOARD_TRIGGERED) liveBoards.push(e);
        }
      }
    };
    runFrames(500);
    const joy = (input, count = 5) => {
      const mask = { fire: 0x10, down: 0x02, up: 0x01, left: 0x04, right: 0x08 }[input];
      m.joyPort2 = 0xff & ~mask;
      runFrames(count);
      m.joyPort2 = 0xff;
    };
    if (index < 2) {
      joy('fire'); runFrames(200);
      joy('fire'); runFrames(100);
    } else {
      for (const input of ['fire', 'down', 'fire', 'down', 'fire', 'up', 'fire', 'right', 'fire', 'left', 'fire', 'down', 'down', 'fire']) {
        joy(input); runFrames(40);
      }
      runFrames(300);
    }
    const [addr, b0, b1] = [[0x7429, 0xb5, 0x79], [0x6400, 0xa9, 0x28], [0x6400, 0x78, 0xd8]][index];
    expect(m.mem.ram[addr] === b0 && m.mem.ram[addr + 1] === b1, `${name} boots the expected game code in C64 READY`);
    expect(live.has(1), `${name} awards its opening trophy during a C64 READY playthrough`);
    const dumpName = ['SPYVSSPY-0400-6604', 'SPYVSSPYII-0400-6400', 'SPYVSSPYIII-0400-6400'][index];
    const dumpFile = collectionFile('c64stuff', `OneLoad64-Games-Collection-v5/Dumps/${dumpName}`);
    if (fs.existsSync(dumpFile)) {
      const dump = fs.readFileSync(dumpFile);
      const image = new Uint8Array(0x10000);
      image.set(dump.subarray(2), dump[0] | dump[1] << 8);
      const [from, to] = index === 0 ? [0x6604, 0x9000] : [0x6400, 0x9000];
      let same = 0;
      for (let a = from; a < to; a++) if (m.mem.ram[a] === image[a]) same++;
      expect(same > (to - from) * 0.99, `${name} cartridge runs the referenced unpacked game layout`);
    } else console.log(`ok  - ${name} code layout # SKIP OneLoad64 unpacked dump absent from c64stuff collection`);
    if (index === 0) {
      const state = m.serializeState();
      const levelId = 9 + m.mem.ram[0x22c];
      expect(rc.activateAchievement(levelId, sets[0].achievements[levelId - 1].memaddr) === 0, 'the live embassy level trophy parses');
      expect(rc.activateAchievement(18, sets[0].achievements[17].memaddr) === 0, 'the live embassy briefcase trophy parses');
      runFrames(1);
      m.mem.ram[0x7b] = 10;
      runFrames(1);
      expect(live.has(18), 'the cartridge briefcase state remains visible for a C64 READY achievement frame');
      m.restoreState(state);
      expect(rc.activateAchievement(7, sets[0].achievements[6].memaddr) === 0, 'the live bomb trophy parses');
      runFrames(1);
      const bombState = structuredClone(state);
      bombState.memory.ram[0x84] = 0xc0;
      m.restoreState(bombState);
      runFrames(1);
      expect(live.has(7), 'the cartridge bomb state remains visible for a C64 READY achievement frame');
      m.restoreState(state);
      expect(rc.activateAchievement(8, sets[0].achievements[7].memaddr) === 0, 'the live embassy escape trophy parses');
      const winState = structuredClone(state);
      winState.cpu.pc = 0x86bb;
      winState.memory.ram[0x41] = 0;
      winState.memory.ram[0x42] = 1;
      m.restoreState(winState);
      runFrames(200);
      expect(live.has(8), 'the cartridge getaway routine awards Getaway Plane in C64 READY');
      expect(live.has(levelId), 'the cartridge getaway awards its selected embassy level trophy');
      expect(liveBoards.some((e) => e.id === 1 && e.value > 0), 'the live cartridge getaway submits an embassy speedrun');
      const bcd = (v) => (v >> 4) * 10 + (v & 15);
      const finalScore = bcd(m.mem.ram[0x2bd]) * 100 + bcd(m.mem.ram[0x2bb]);
      expect(liveBoards.some((e) => e.id === 2 && e.value === finalScore), 'the live cartridge board submits the final score including the time bonus');
      m.restoreState(state);
      m.mem.ram[0x93] = 0;
      m.mem.ram[0x91] = 1;
      live.delete(8);
      rc.clear();
      rc.activateAchievement(8, sets[0].achievements[7].memaddr);
      runFrames(200);
      expect(!live.has(8), 'the cartridge clock loss does not award the getaway trophy');
    } else if (index === 1) {
      const state = m.serializeState();
      const levelId = 6 + m.mem.ram[0xd1];
      expect(rc.activateAchievement(levelId, sets[1].achievements[levelId - 1].memaddr) === 0, 'the live Island level trophy parses');
      for (let id = 14; id <= 18; id++) expect(rc.activateAchievement(id, sets[1].achievements[id - 1].memaddr) === 0, `the live Island tool trophy ${id} parses`);
      expect(rc.activateAchievement(2, sets[1].achievements[1].memaddr) === 0, 'the live missile section trophy parses');
      expect(rc.activateAchievement(3, sets[1].achievements[2].memaddr) === 0, 'the live assembled missile trophy parses');
      expect(rc.activateAchievement(4, sets[1].achievements[3].memaddr) === 0, 'the live submarine escape trophy parses');
      runFrames(1);
      for (const [value, id] of [[0, 14], [3, 15], [4, 16], [44, 17], [64, 18]]) {
        m.mem.ram[0x6f] = value;
        runFrames(1);
        expect(live.has(id), `the cartridge island tool ${value} is observable for a C64 READY achievement frame`);
      }
      m.mem.ram[0xd9] = 1;
      runFrames(1);
      expect(live.has(2), 'the cartridge missile section state remains visible for a C64 READY achievement frame');
      m.mem.ram[0xd9] = 3;
      runFrames(1);
      expect(live.has(3), 'the cartridge assembled missile state remains visible for a C64 READY achievement frame');
      const winState = structuredClone(state);
      winState.cpu.pc = 0x83c0;
      winState.cpu.x = 0;
      winState.memory.ram[0x3d] = 0;
      winState.memory.ram[0x3e] = 1;
      winState.memory.ram[0xd9] = 3;
      m.restoreState(winState);
      runFrames(200);
      expect(live.has(4), 'the cartridge submarine boarding routine awards the White Spy escape');
      expect(live.has(levelId), 'the cartridge submarine escape awards its selected Island level trophy');
      expect(liveBoards.some((e) => e.id === 1 && e.value > 0), 'the live submarine escape submits the Island speedrun');
    } else {
      const state = m.serializeState();
      const levelId = 9 + m.mem.ram[0xd1];
      expect(rc.activateAchievement(levelId, sets[2].achievements[levelId - 1].memaddr) === 0, 'the live Arctic level trophy parses');
      for (let id = 2; id <= 6; id++) expect(rc.activateAchievement(id, sets[2].achievements[id - 1].memaddr) === 0, `the live Arctic item trophy ${id} parses`);
      expect(rc.activateAchievement(7, sets[2].achievements[6].memaddr) === 0, 'the live rocket escape trophy parses');
      expect(rc.activateAchievement(8, sets[2].achievements[7].memaddr) === 0, 'the live packed briefcase trophy parses');
      runFrames(1);
      m.mem.ram[0x6f] = 0x39;
      runFrames(1);
      expect(live.has(2), 'the cartridge launch briefcase remains visible for a C64 READY achievement frame');
      for (const [value, id] of [[0x30, 3], [0x3c, 4], [0x3f, 5]]) {
        if (value === 0x3f) m.mem.ram[0x6f] = 0x39;
        m.mem.ram[0x3e3] = value;
        runFrames(1);
        expect(live.has(id), `the cartridge Arctic inventory icon ${id} is observable`);
      }
      expect(live.has(6), 'the cartridge full launch case is observable');
      const winState = structuredClone(state);
      winState.cpu.pc = 0x68fb;
      winState.cpu.x = 0;
      winState.memory.ram[0x6f] = 0x39;
      winState.memory.ram[0x3e5] = 0x3f;
      m.restoreState(winState);
      runFrames(200);
      expect(live.has(7), 'the cartridge rocket launch routine awards the White Spy escape');
      expect(live.has(8), 'the cartridge full launch briefcase awards Packed for Launch');
      expect(live.has(levelId), 'the cartridge rocket escape awards its selected Arctic level trophy');
      expect(liveBoards.some((e) => e.id === 1 && e.value > 0), 'the live rocket launch submits the Arctic speedrun');
    }
  }
} else console.log('ok  - Spy vs. Spy C64 READY boots # SKIP C64 ROMs are required');

if (fails) { console.log(`\n${fails} of ${checks} Spy vs. Spy checks failed`); process.exit(1); }
console.log(`\nok - Spy vs. Spy sets: ${checks} checks`);
