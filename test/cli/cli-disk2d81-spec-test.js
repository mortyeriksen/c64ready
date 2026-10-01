import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBlankD71, createBlankD64, createBlankD81, D64 } from '../../cli/core.mjs';
import { disk2d81 } from '../../cli/diskconvert.mjs';
import { setQuiet } from '../../cli/report.mjs';
setQuiet(true);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'disk2d81-'));
const at = n => path.join(tmp, n);
try {
  const source = createBlankD71('TEST DISK', '71');
  const items = [
    { name: 'EMPTY', bytes: Buffer.alloc(0), type: 1 },
    { name: 'WRAP', bytes: Buffer.from([255,255,1,2,3]), type: 2 },
    { name: 'LOCKED', bytes: Buffer.from([7,8,9]), type: 3 | 0x40 },
    { name: 'SIDE TWO', bytes: Buffer.alloc(700 * 254, 0xB7), type: 1 },
    { name: 'DUP', bytes: Buffer.from([1,2]), type: 2 },
    { name: 'DUP', bytes: Buffer.from([3,4]), type: 2 },
    { name: '*?:,\xC1', bytes: Buffer.from([5,6]), type: 2 },
  ];
  for (const f of items) assert(source.writeFile(f.name, f.bytes, f.type), 'fixture fits');
  const input = at('disk.d71'), output = at('disk.d81');
  fs.writeFileSync(input, source.img);
  const original = fs.readFileSync(input);
  const cli = fileURLToPath(new URL('../../cli/c64rdy.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'disk2d81', input, '-o', output], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const target = new D64(fs.readFileSync(output));
  assert.equal(target.kind, 'd81', 'output has D81 geometry');
  assert.equal(target.diskName, 'TEST DISK', 'disk name retained');
  assert.equal(target.diskId, '71', 'disk ID retained');
  assert.equal(target.entries.length, items.length, 'directory order and duplicate names retained');
  for (const [i,f] of items.entries()) {
    const e = target.entries[i];
    assert.equal(e.typeCode, f.type & 7, 'file type retained');
    assert.equal(e.locked, !!(f.type & 0x40), 'lock bit retained');
    assert.deepEqual(Buffer.from(target._readChain(e.startTrack,e.startSector)),f.bytes,'raw file bytes retained');
  }
  assert.deepEqual(fs.readFileSync(input), original, 'input unchanged');
  assert.equal(disk2d81([input,'-o',output]),1,'existing output protected');
  assert.equal(disk2d81([input,'-o',output,'--force']),0,'force replaces output');
  assert.equal(disk2d81([input,'-o',input,'--force']),1,'force cannot overwrite source');
  const d64 = createBlankD64('D64 INPUT', '64');
  d64.writePRG('TEST', Buffer.from([1,8,42]));
  fs.writeFileSync(at('other.data'), d64.img);
  assert.equal(disk2d81([at('other.data'),'-o',at('other.d81')]),0,'D64 detected by geometry');
  assert.deepEqual(Buffer.from(new D64(fs.readFileSync(at('other.d81'))).loadFile('TEST')),Buffer.from([1,8,42]),'D64 file bytes retained');
  fs.writeFileSync(at('already.d81'),createBlankD81().img);
  assert.equal(disk2d81([at('already.d81'),'-o',at('wrong.d81')]),1,'D81 input rejected');
  assert(!fs.existsSync(at('wrong.d81')),'wrong format writes no output');
  for (const [label, mutate] of [
    ['REL', d => { d.readSector(18,1)[2] = 0x84; }],
    ['unclosed', d => { d.readSector(18,1)[2] &= 0x7F; }],
    ['loop', d => { const e=d.entries[0]; const s=d.readSector(e.startTrack,e.startSector);s[0]=e.startTrack;s[1]=e.startSector; }],
    ['directory loop', d => { d.readSector(18,1)[0]=18;d.readSector(18,1)[1]=1; }],
    ['invalid link', d => { const e=d.entries[0]; d.readSector(e.startTrack,e.startSector)[0]=71; }],
  ]) {
    const d = new D64(Uint8Array.from(original));
    mutate(d);
    const inputBad=at(label+'.d71'), outputBad=at(label+'.d81');
    fs.writeFileSync(inputBad,d.img);
    assert.equal(disk2d81([inputBad,'-o',outputBad]),1,label+' rejected');
    assert(!fs.existsSync(outputBad),label+' writes no partial output');
  }
  const empty=at('empty.d71');
  fs.writeFileSync(empty,createBlankD71('EMPTY','00').img);
  assert.equal(disk2d81([empty,'--out-dir',at('batch')]),0,'blank disk converts');
  assert.equal(new D64(fs.readFileSync(at('batch/empty.d81'))).freeBlocks,3160,'blank D81 capacity');
  console.log('cli disk2d81 spec: PASS');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
