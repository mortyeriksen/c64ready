import assert from 'node:assert/strict';
import {C64Machine} from '../../src/machine.js';
import {D64, createBlankD71} from '../../src/media/d64.js';
import {readAsset} from '../external-assets.js';
const kernal=readAsset('kernal'), basic=readAsset('basic'), charRom=readAsset('chargen');
if(!kernal||!basic||!charRom){console.log('# SKIP C64 ROMs missing');process.exit(0);}
// KERNAL SETNAM/SETLFS/LOAD contract: SA=1 uses the file address and clears
// carry on success. A track-36 file must be reachable on either virtual device.
const disk=createBlankD71('SIDE TWO','71');
const bam=disk.readSector(18,0);
for(let t=1;t<=35;t++)if(t!==18)bam.fill(0,4+(t-1)*4,8+(t-1)*4);
const prg=Uint8Array.from([0,0x20,...Array.from({length:300},(_,i)=>(i*17)&255)]);
assert.equal(disk.writePRG('TARGET',prg),2,'D71 test payload occupies two blocks');
assert.equal(disk.entries[0].startTrack,36,'Payload starts on side two');
function machine(dev,image){
 const m=new C64Machine();m.loadROMs({kernal,basic,charRom});m.reset();m.setTrueDrive(false);m.setDrive9Enabled(dev===9);
 if(dev===8)m.setD64(image);else m.setD64Drive9(image);
 return m;
}
function load(m,dev){
 m.mem.ram.set(Buffer.from('TARGET'),0xcf10);
 const code=[0xa9,6,0xa2,0x10,0xa0,0xcf,0x20,0xbd,0xff,
  0xa9,1,0xa2,dev,0xa0,1,0x20,0xba,0xff,
  0xa9,0,0xa2,0,0xa0,0x20,0x20,0xd5,0xff,
  0x8d,0,0xcf,0xa9,0,0x2a,0x8d,1,0xcf,0x4c,0x24,0xc0];
 m.mem.ram.set(code,0xc000);m.cpu.pc=0xc000;
 for(let f=0;f<120&&m.cpu.pc!==0xc024;f++)m.runFrame();
 assert.equal(m.cpu.pc,0xc024,'KERNAL LOAD returns to its caller');
 assert.equal(m.mem.ram[0xcf01],0,'KERNAL LOAD succeeds on side two');
 assert.deepEqual(m.mem.ram.slice(0x2000,0x2000+300),prg.slice(2),'KERNAL LOAD transfers D71 bytes');
}
for(const dev of [8,9]){
 const m=machine(dev,disk);
 for(let f=0;f<500;f++){m.runFrame();if(m.mem.ram[0xc6]===0&&m.mem.ram[0xcc]===0&&m.mem.ram[0x2c]===8)break;}
 load(m,dev);
 const snapshot=m.serializeState();
 const restored=machine(dev,new D64(disk.img.slice()));restored.restoreState(snapshot);
 load(restored,dev);
}
console.log('PASS D71 KERNAL LOAD on devices 8/9 and machine/media restore');
