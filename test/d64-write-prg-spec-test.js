// Spec test for writing a PRG into a D64 image (src/d64.js).
//
// The contract: a program written in must come back out byte-identical through
// the ordinary read path, and the image must stay a valid disk — BAM free count
// consistent with the blocks taken, a real directory entry, the file findable by
// name and by wildcard. That is what lets a wrapped .prg behave exactly like any
// other disk for LOAD, the directory listing and export.
import { D64, createBlankD64, createPRGDisk, diskNameFromFilename, prgAutostart, SPT } from '../src/d64.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const prg = (bytes, addr = 0x0801) => {
  const p = new Uint8Array(bytes + 2);
  p[0] = addr & 0xFF; p[1] = addr >> 8;
  for (let i = 0; i < bytes; i++) p[i + 2] = (i * 31 + 7) & 0xFF;
  return p;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── Names ────────────────────────────────────────────────────────────────────
expect(diskNameFromFilename('Commando (1985).prg') === 'COMMANDO',
  `parentheticals dropped, got "${diskNameFromFilename('Commando (1985).prg')}"`);
expect(diskNameFromFilename('a/b:c"d.prg') === 'A.B.C.D',
  `characters a LOAD name can't carry are folded, got "${diskNameFromFilename('a/b:c"d.prg')}"`);
expect(diskNameFromFilename('x'.repeat(40) + '.prg').length === 16, 'clamped to the 16 a directory entry holds');
expect(diskNameFromFilename('') === 'PROGRAM', 'empty name still yields something loadable');
expect(diskNameFromFilename('....prg') === 'PROGRAM', 'a name with nothing usable falls back');

// ── RUN or SYS ───────────────────────────────────────────────────────────────
// A real BASIC program: link to the next line, line 10, PRINT"HI", terminators.
const basicPrg = new Uint8Array([0x01,0x08, 0x0C,0x08, 0x0A,0x00, 0x99, 0x22,0x48,0x49,0x22, 0x00, 0x00,0x00]);
expect(prgAutostart(basicPrg) === 'RUN\r', 'a BASIC program is RUN');
// The usual "10 SYS 2061" stub in front of machine code is still BASIC, so RUN.
const stub = new Uint8Array([0x01,0x08, 0x0B,0x08, 0x0A,0x00, 0x9E, 0x32,0x30,0x36,0x31, 0x00, 0x00,0x00, 0xA9,0x00]);
expect(prgAutostart(stub) === 'RUN\r', 'a SYS stub is still a BASIC program');
// Machine code elsewhere: SYS its load address.
// Machine code starts nothing: the load address is a convention, not an entry
// point, so the program is left at READY rather than SYSed into a data table.
expect(prgAutostart(new Uint8Array([0x00,0xC0, 0xA9,0x00,0x8D,0x20,0xD0,0x60])) === null,
  'machine code at $C000 starts nothing');
expect(prgAutostart(new Uint8Array([0x00,0x10, 0x78,0xA9,0x35,0x85,0x01,0x60])) === null,
  'machine code at $1000 starts nothing');
// Machine code that happens to load at $0801 — the case a load-address test
// alone gets wrong, since it looks like a BASIC program by address.
expect(prgAutostart(new Uint8Array([0x01,0x08, 0x78,0xA9,0x35,0x85,0x01,0x60])) === null,
  'machine code at $0801 is not mistaken for BASIC');
expect(prgAutostart(new Uint8Array([0x01,0x08, 0x00,0x00])) === null, 'a stub too short to be BASIC starts nothing');

// ── Round trip, across block-boundary sizes ──────────────────────────────────
// 254 bytes per block, so these straddle every interesting boundary.
for (const size of [1, 2, 253, 254, 255, 508, 509, 3000, 20000]) {
  const p = prg(size);
  const disk = createPRGDisk('roundtrip.prg', p);
  expect(disk, `a ${size}-byte program fits on a blank disk`);
  const back = disk.loadFile('ROUNDTRIP');
  expect(back && same(back, p), `${size} bytes survive the round trip`);
  expect(same(disk.loadFile('*'), p), `${size}: wildcard finds it too`);

  const blocks = Math.ceil(p.length / 254);
  expect(disk.entries.length === 1, `${size}: exactly one directory entry`);
  expect(disk.entries[0].type === 'PRG', `${size}: typed PRG, got ${disk.entries[0].type}`);
  expect(disk.entries[0].closed, `${size}: entry marked closed`);
  expect(disk.entries[0].blocks === blocks, `${size}: entry says ${blocks} blocks`);
  expect(disk.freeBlocks === 664 - blocks, `${size}: BAM free went 664 → ${664 - blocks}`);
}

// A wrapped program is protected: it exists to be loaded, not written over.
const wrapped = createPRGDisk('protected.prg', prg(500));
expect(wrapped.writeProtected, 'a wrapped .prg disk comes write-protected');
expect(!wrapped.dirty, 'and clean — it already matches the .prg it was built from');
expect(createBlankD64('PLAIN').writeProtected === false,
  'a hand-made blank disk is still write-enabled, as NEW/FORMAT intend');

// ── The image stays a real disk ──────────────────────────────────────────────
const one = createPRGDisk('chain.prg', prg(3000));
// Every block in the chain must be marked used in the BAM, and the chain must
// terminate — a stale free bit would let a later write corrupt the file.
const bam = one.readSector(18, 0);
let t = one.entries[0].startTrack, s = one.entries[0].startSector, hops = 0;
while (t !== 0) {
  expect(t >= 1 && t <= 35 && s >= 0 && s < SPT[t], `chain stays on the disk (${t}/${s})`);
  const off = 4 + (t - 1) * 4;
  expect(!(bam[off + 1 + (s >> 3)] & (1 << (s & 7))), `block ${t}/${s} is marked used in the BAM`);
  const sec = one.readSector(t, s);
  t = sec[0]; s = sec[1];
  expect(hops++ < 700, 'chain terminates');
}
expect(one.entries[0].startTrack !== 18, 'files do not land on the directory track');

// A fresh parse of the same bytes sees the same disk — the write updated the
// image, not just the in-memory bookkeeping.
const reparsed = new D64(one.img.slice());
expect(reparsed.entries.length === 1 && reparsed.entries[0].name === 'CHAIN',
  'a reparsed image still shows the file');
expect(same(reparsed.loadFile('CHAIN'), prg(3000)), 'a reparsed image still loads it');
expect(reparsed.freeBlocks === one.freeBlocks, 'a reparsed image agrees on free blocks');

// ── Several files on one disk ────────────────────────────────────────────────
const multi = createBlankD64('MULTI', '01');
const a = prg(600), b = prg(1200, 0xC000);
expect(multi.writePRG('FIRST', a) === 3, 'first file takes 3 blocks');
expect(multi.writePRG('SECOND', b) === 5, 'second file takes 5 blocks');
expect(multi.entries.length === 2, 'both entries listed');
expect(same(multi.loadFile('FIRST'), a) && same(multi.loadFile('SECOND'), b),
  'neither file disturbed the other');
expect(multi.freeBlocks === 664 - 8, 'free count reflects both');

// ── Refusals ─────────────────────────────────────────────────────────────────
// A refused write must leave the disk exactly as it was. `freeBlocks` is a cached
// field that writePRG only refreshes on success, so these read the BAM itself —
// asserting on the cache passed while the image underneath had been emptied.
const bamFreeBlocks = (d) => {
  const b = d.readSector(18, 0);
  let free = 0;
  for (let t = 1; t <= 35; t++) if (t !== 18) free += b[4 + (t - 1) * 4];
  return free;
};

expect(createBlankD64('X').writePRG('TINY', new Uint8Array([1])) === 0,
  'a program shorter than its load address is refused');

const full = createBlankD64('FULL');
expect(full.writePRG('HUGE', prg(664 * 254 + 1)) === 0, 'a program too big for the disk is refused');
expect(bamFreeBlocks(full) === 664, `a refused write returns every block it claimed, got ${bamFreeBlocks(full)}`);
// And the disk is still usable afterwards — the point of rolling back.
expect(full.writePRG('AFTER', prg(600)) === 3, 'a normal write still succeeds after a refusal');
expect(bamFreeBlocks(full) === 661, 'and takes only its own three blocks');

// A partial refusal: room for some of the blocks but not all. prg() prepends the
// 2-byte load address, so B blocks is B * 254 - 2 bytes of payload.
const blockBytes = (b) => b * 254 - 2;
const tight = createBlankD64('TIGHT');
expect(tight.writePRG('BIG', prg(blockBytes(600))) === 600, 'a 600-block file fits');
expect(tight.writePRG('TOOBIG', prg(blockBytes(65))) === 0, 'a 65-block file does not fit in the 64 left');
expect(bamFreeBlocks(tight) === 64, `the 64 free blocks survive the refusal, got ${bamFreeBlocks(tight)}`);
expect(same(tight.loadFile('BIG'), prg(blockBytes(600))), 'and the file already there is intact');

// Directory full: track 18 holds 18 directory sectors, so 144 files and no more.
// The 145th allocates and writes its chain before _addDirEntry can fail, so the
// rollback has to happen there too or the block is orphaned.
const many = createBlankD64('MANY');
for (let i = 0; i < 144; i++) {
  expect(many.writePRG(`F${i}`, prg(10)) === 1, `file ${i} of 144 fits`);
}
expect(many.entries.length === 144, `the directory holds 144 entries, got ${many.entries.length}`);
const freeAt144 = bamFreeBlocks(many);
expect(many.writePRG('OVERFLOW', prg(10)) === 0, 'the 145th file is refused — the directory is full');
expect(bamFreeBlocks(many) === freeAt144,
  `a directory-full refusal orphans nothing, got ${bamFreeBlocks(many)} vs ${freeAt144}`);
expect(many.entries.length === 144, 'and adds no entry');

console.log('d64 writePRG spec: PASS');
