import assert from 'node:assert/strict';
import {D64, createBlankD71, createBlankDisk, TYPE_SEQ, d64Variant} from '../../src/media/d64.js';
import {Drive1541} from '../../src/drive1541.js';
import {VirtualDrive} from '../../src/virtual-drive.js';
import {validateMedia} from '../../src/media/open.js';
import {createDiskCompatibilityPrompt} from '../../src/media/disk-compatibility.js';

// VICE format specification, D71: 2 x 683 sectors; second-side counts at
// 18/0:$DD, three-byte bitmaps at 53/0:$00; track 53 reserved, directory 18/1.
const sectors = t => {const n=(t-1)%35+1;return n<=17?21:n<=24?19:n<=30?18:17;};
for (const [bytes, errors] of [[349696,false],[351062,true]]) {
  assert.equal(d64Variant(bytes).kind,'d71','D71 is identified by its specified size');
  assert.equal(d64Variant(bytes).errorInfo,errors,'D71 recognizes the optional 1366-byte error table');
}
assert.equal(d64Variant(349697),null,'Truncated or oversized D71 is rejected');
const d=createBlankD71('DOUBLE','71');
assert.equal(d.kind,'d71','Blank disk retains D71 kind');
assert.equal(d.freeBlocks,1328,'1571 reserves both metadata tracks: 1366 - 38 blocks');
assert.equal(d.diskName,'DOUBLE','D71 header name uses 18/0:$90');
assert.equal(d.diskId,'71','D71 header ID uses 18/0:$A2');
assert.equal(d.dosType,'2A','D71 directory uses DOS type 2A');
const hdr=d.readSector(18,0),bam=d.readSector(53,0);
assert.deepEqual([...hdr.slice(0,4)],[18,1,0x41,0x80],'D71 header links directory and marks double-sided media');
assert.deepEqual([...d.readSector(18,1).slice(0,2)],[0,255],'Empty D71 directory ends at 18/1');
let index=0;
for(let t=1;t<=70;t++) {
  assert.equal(d.readSector(t,0).byteOffset,index*256,`D71 track ${t} follows zoned geometry`);
  assert.equal(d.readSector(t,sectors(t)),null,`D71 track ${t} rejects sector past its zone`);
  index+=sectors(t);
  if(t>=36){
    assert.equal(hdr[0xDD+t-36],t===53?0:sectors(t),`D71 side-two free count for track ${t}`);
    for(let s=0;s<24;s++) assert.equal(!!(bam[(t-36)*3+(s>>3)]&(1<<(s&7))),t!==53&&s<sectors(t),`D71 side-two bitmap track ${t} sector ${s}`);
  }
}
assert.equal(index,1366,'D71 contains 1366 sectors');
assert.equal(d.readSector(71,0),null,'D71 ends at track 70');
assert.equal(createBlankDisk('d71').img.length,349696,'Generic formatter selects D71');
const drive=new Drive1541(new Uint8Array(16384));drive.setDisk(d);
assert.equal(drive.disk,null,'D71 stays on the virtual-drive path');

// A sequential file exceeds side one's 664 usable blocks and crosses sides.
const bytes=Uint8Array.from({length:670*254},(_,i)=>(i*37+11)&255);
assert.equal(d.writeFile('CROSS',bytes,TYPE_SEQ),670,'File allocation crosses from side one to side two');
assert.deepEqual(d.loadFile('CROSS'),bytes,'Cross-side file reads byte-for-byte');
assert.equal(hdr[0xDD],15,'Six used sectors reduce track 36 count to 15');
assert.notDeepEqual([...bam.slice(0,3)],[255,255,31],'Track 36 allocation changes its separate bitmap');
assert.equal(d.freeBlocks,658,'Cross-side allocation reduces total free blocks');
const reloaded=new D64(d.img.slice());
assert.deepEqual(reloaded.loadFile('CROSS'),bytes,'Export/reload preserves cross-side chains');
assert.equal(d.scratch('CROSS').blocks,670,'Scratch frees both sides');
assert.equal(hdr[0xDD],21,'Scratch restores separate side-two free count');
assert.deepEqual([...bam.slice(0,3)],[255,255,31],'Scratch restores side-two bitmap');
assert.equal(d.freeBlocks,1328,'Scratch recovers full disk capacity');
const before=d.img.slice();
assert.equal(d.writeFile('TOO BIG',new Uint8Array(1329*254),TYPE_SEQ),0,'Disk-full allocation fails');
assert.deepEqual(d.img,before,'Disk-full rollback restores both BAM sectors');
assert.equal(d.writeFile('FULL',new Uint8Array(1328*254),TYPE_SEQ),1328,'All 1328 file blocks can be allocated');
assert.equal(d.freeBlocks,0,'Fully allocated D71 reports no free file blocks');
assert.equal(d.readSector(53,0)[51],0,'Allocation never uses reserved track 53');
d.format('RESET','R1');
assert.equal(d.kind,'d71','Format retains D71 format');
assert.equal(d.freeBlocks,1328,'Format restores both allocation maps');
assert.equal(d.entries.length,0,'Format removes directory entries');

const err=new Uint8Array(351062);err.set(d.img);err.fill(1,349696);err[349696+683]=5;
const errorDisk=new D64(err);
assert.equal(errorDisk.errorForSector(36,0),5,'Side-two error table starts at sector 683');
errorDisk.writeSector(36,0,new Uint8Array(256));
assert.equal(errorDisk.errorForSector(36,0),1,'Sector write clears its error entry');
assert.equal(validateMedia(d.img,'d71').kind,'d71','Media validator accepts D71');
assert.throws(()=>validateMedia(new Uint8Array(174848),'d71'),/D71 size/,'Mislabeled D64 is not D71');
for(const targetDrive of [8,9]) {
 const disabled=[];let prompts=0;
 await createDiskCompatibilityPrompt({enabled:()=>true,available:()=>true,disable:n=>disabled.push(n),confirm:()=>prompts++})({targetDrive,kind:'d71'});
 assert.deepEqual(disabled,[targetDrive],'D71 disables true-drive mode on the target device');
 assert.equal(prompts,0,'D71 mounting does not offer unsupported true-drive mode');
}
const v=new VirtualDrive(()=>d);
assert.equal(v.statusText(),'73,CBM DOS V3.0 1571,00,00\r','D71 identifies Commodore DOS 3.0 1571');
const send=(ch,text)=>{v.listen(0x60|ch);for(const b of Buffer.from(text))v.write(b);v.unlisten();};
d.writeProtected=true;const protectedImage=d.img.slice();send(15,'N:NO,00');
assert.match(v.statusText(),/^26,/,'Virtual D71 format respects write protection');
assert.deepEqual(d.img,protectedImage,'Protected D71 remains unchanged');
d.writeProtected=false;send(15,'N:VIRTUAL,01');
assert.equal(d.diskName,'VIRTUAL','Command-channel format reaches D71');
console.log('PASS D71 geometry, split BAM, cross-side files, full disk, format, errors, mount and protection');

// Channel file I/O on side two uses the same DOS commands as side one.
const sideHeader=d.readSector(18,0);
for(let t=1;t<=35;t++)if(t!==18)sideHeader.fill(0,4+(t-1)*4,8+(t-1)*4);
const open=(ch,name)=>{v.listen(0xf0|ch);for(const b of Buffer.from(name))v.write(b);v.unlisten();};
const close=ch=>{v.listen(0xe0|ch);v.unlisten();};
open(2,'SIDE,S,W');send(2,'SEQUENTIAL SIDE TWO');close(2);
assert.equal(d.entries[0].startTrack,36,'Virtual write channel allocates on side two');
open(2,'SIDE,S,R');v.talk(0x62);const out=[];
for(let i=0;i<100;i++){const r=v.read();if(r.timeout)break;out.push(r.byte);if(r.eoi)break;}v.untalk();close(2);
assert.equal(Buffer.from(out).toString(),'SEQUENTIAL SIDE TWO','Virtual read channel returns side-two file');
send(15,'R:RENAMED=SIDE');
assert.ok(d.findEntry('RENAMED'),'Command-channel rename preserves a side-two file');
send(15,'S:RENAMED');
assert.equal(d.findEntry('RENAMED'),null,'Command-channel scratch removes side-two file');
assert.equal(d.readSector(18,0)[0xDD],21,'Command-channel scratch restores side-two count');
console.log('PASS D71 virtual channel read/write, rename and scratch');
