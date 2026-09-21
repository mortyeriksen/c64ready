import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sid2prg, sid2wav, renderSid } from '../sid.mjs';
import { sidToPrg, loadMachine } from '../core.mjs';
import { sniff } from '../formats.mjs';
import { setQuiet } from '../report.mjs';
import { assetPath, readAsset, missingNote } from '../../test/external-assets.js';

// A two-song sawtooth driver. Init records A (the zero-based song) and uses it
// in the pitch; play records that it was called and makes two volume writes.
function fixture() {
  const init = [
    0x8D,0x41,0x03, 0x18,0x69,0x1C, 0x8D,0x01,0xD4,
    0xA9,0x45,0x8D,0x00,0xD4, 0xA9,0x00,0x8D,0x05,0xD4,
    0xA9,0xF0,0x8D,0x06,0xD4, 0xA9,0x21,0x8D,0x04,0xD4,
    0xA9,0x0F,0x8D,0x18,0xD4, 0x60,
  ];
  const play = [0xEE,0x40,0x03, 0xA9,0,0x8D,0x18,0xD4, 0xEA,0xEA, 0xA9,15,0x8D,0x18,0xD4, 0x60];
  const bytes = Buffer.alloc(0x7E + init.length + play.length);
  bytes.write('PSID'); bytes.writeUInt16BE(2,4); bytes.writeUInt16BE(0x7C,6);
  bytes.writeUInt16BE(0x1000,10); bytes.writeUInt16BE(0x1000+init.length,12);
  bytes.writeUInt16BE(2,14); bytes.writeUInt16BE(2,16); bytes.write('CLI TEST',0x16);
  bytes.writeUInt16BE(0x24,0x76); bytes.writeUInt16LE(0x1000,0x7C);
  bytes.set(init,0x7E); bytes.set(play,0x7E+init.length);
  return bytes;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'c64rdy-sid-'));
const cli = fileURLToPath(new URL('../c64rdy.mjs',import.meta.url));
const invoke = (...args) => spawnSync(process.execPath,[cli,...args],{cwd:tmp,encoding:'utf8'});
setQuiet(true);
try {
  const bytes=fixture(), input=path.join(tmp,'tune.sid'), prg=path.join(tmp,'tune.prg');
  fs.writeFileSync(input,bytes);
  assert.equal(sniff(bytes,'wrong.prg'),'sid','SID magic outranks a renamed extension');
  assert.equal(sid2prg([input,'--out-dir',tmp]),0,'SID converts to a runnable player without ROMs');
  assert.deepEqual(fs.readFileSync(prg),Buffer.from(sidToPrg(bytes).data),'default CLI PRG is byte-identical to the UI player export');
  assert.equal(sid2prg([input,'--song','1','-o',prg,'--force']),0,'song selection supports explicit replacement');
  assert.deepEqual(fs.readFileSync(prg),Buffer.from(sidToPrg(bytes,{song:1}).data),'song selection uses the shared player parameter block');
  const kept=fs.readFileSync(prg);
  assert.equal(invoke('sid2prg',input,'-o',prg).status,1,'existing PRGs are protected without --force');
  assert.deepEqual(fs.readFileSync(prg),kept,'refused overwrites preserve the original PRG');
  assert.equal(invoke('sid2prg',input,'--song','3').status,1,'songs beyond the SID range are refused');
  assert.equal(invoke('sid2prg',input,'--song','0').status,2,'song numbers are one-based');
  assert.equal(invoke('sid2prg',input,input,'-o',prg).status,2,'one output cannot name multiple conversions');
  const bad=path.join(tmp,'bad.sid');fs.writeFileSync(bad,'not a SID');
  const batch=path.join(tmp,'batch');
  assert.equal(invoke('sid2prg',path.join(tmp,'*.sid'),'--out-dir',batch).status,1,'a bad batch input reports failure');
  assert.ok(fs.existsSync(path.join(batch,'tune.prg')),'a bad batch input does not stop later valid files');
  assert.match(invoke('--help').stdout,/sid2wav/,'command help exposes SID audio conversion');
  assert.match(invoke('info',input).stdout,/SID music.*CLI TEST/,'info identifies SID metadata');
  for(const args of [['--seconds','0'],['--seconds','1e30'],['--sample-rate','7999'],['--sample-rate','44100.5'],['--model','1234']]) {
    assert.equal(invoke('sid2wav',input,...args).status,2,`invalid ${args[0]} is a usage error`);
  }
  const unsupported=path.join(tmp,'unsupported.sid');
  const basic=Buffer.from(bytes);basic.write('RSID');basic.writeUInt16BE(0x26,0x76);fs.writeFileSync(unsupported,basic);
  assert.match(invoke('sid2wav',unsupported).stderr,/BASIC RSID/,'BASIC RSID audio is explicitly refused');
  const multi=Buffer.from(bytes);multi.writeUInt16BE(3,4);multi[0x7A]=0x42;fs.writeFileSync(unsupported,multi);
  assert.match(invoke('sid2wav',unsupported).stderr,/multi-SID/,'multi-SID audio is explicitly refused');

  const missing=['kernal','basic','chargen'].find(key=>!assetPath(key));
  if(missing) console.log(`ok  - SID boot and WAV integration # SKIP ${missingNote(missing)}`);
  else {
    const roms={kernal:readAsset('kernal'),basic:readAsset('basic'),charRom:readAsset('chargen')};
    const {C64Machine}=await loadMachine();
    const machine=new C64Machine();machine.loadROMs(roms);
    for(let i=0;i<200;i++)machine.runFrame();
    machine.loadPRG(sidToPrg(bytes,{song:2,safe:true}).data);machine.injectRun();
    for(let i=0;i<50;i++)machine.runFrame();
    assert.equal(machine.mem.ram[0x0341],1,'the safe player starts the selected zero-based song');
    assert.ok(machine.mem.ram[0x0340]>0,'the exported player calls the tune driver');
    const before=Atomics.load(machine.sidCtrl,0);machine.runFrame();
    const after=Atomics.load(machine.sidCtrl,0), volumes=[];
    for(let i=before;i<after;i++){const packed=machine.sidRing32[(i&131071)*2+1];if((packed&31)===24)volumes.push(packed>>>8);}
    assert.ok(volumes.includes(0)&&volumes.includes(15),'Safe mode retains both volume writes within a video frame');

    const blocks=[];
    const rendered=await renderSid(bytes,{seconds:0.5,sampleRate:48000,roms,model:'8580',onBlock:(b,n)=>blocks.push(Buffer.from(b.subarray(0,n)))});
    const pcm=Buffer.concat(blocks);
    assert.equal(pcm.length,48000,'half a second at 48 kHz contains exactly 24000 16-bit samples');
    assert.equal(rendered.model,'8580','audio model selection is preserved');
    let energy=0;for(let i=0;i<pcm.length;i+=2)energy+=pcm.readInt16LE(i)**2;
    assert.ok(energy/24000>10000,'the synthetic driver produces audible waveform energy');

    const wav=path.join(tmp,'tune.wav');
    assert.equal(await sid2wav([input,'-o',wav,'--seconds','0.25','--sample-rate','44100','--roms',path.dirname(assetPath('kernal'))]),0,'SID renders to WAV through the command');
    const data=fs.readFileSync(wav);
    assert.equal(data.toString('ascii',0,4),'RIFF','WAV begins with the RIFF identifier');
    assert.equal(data.toString('ascii',8,16),'WAVEfmt ','WAV declares its format chunk');
    assert.equal(data.readUInt32LE(4),data.length-8,'RIFF size covers the complete output');
    assert.equal(data.readUInt16LE(20),1,'WAV uses uncompressed PCM');
    assert.equal(data.readUInt16LE(22),1,'SID WAV is mono');
    assert.equal(data.readUInt32LE(24),44100,'WAV declares the requested sample rate');
    assert.equal(data.readUInt16LE(34),16,'SID WAV stores 16-bit samples');
    assert.equal(data.readUInt32LE(40),22050,'fractional duration writes the exact sample count');
    assert.equal(data.length,44+22050,'the last partial audio block is not padded');
    assert.equal(invoke('sid2wav',input,'-o',wav,'--seconds','0.01').status,1,'existing WAV files are protected');
    assert.deepEqual(fs.readFileSync(wav),data,'refused audio overwrites preserve all bytes');
    assert.equal(invoke('sid2wav',bad,'-o',wav,'--force').status,1,'an invalid tune fails even with --force');
    assert.deepEqual(fs.readFileSync(wav),data,'failed forced conversions preserve existing audio');
    const write=fs.writeSync, error=console.error;
    fs.writeSync=(...args)=>{if(args[1].length>44)throw new Error('simulated PCM write failure');return write(...args);};
    console.error=()=>{};
    try {
      assert.equal(await sid2wav([input,'-o',wav,'--seconds','0.01','--force','--roms',path.dirname(assetPath('kernal'))]),1,'audio write failures are reported');
    } finally {fs.writeSync=write;console.error=error;}
    assert.deepEqual(fs.readFileSync(wav),data,'a failed render never replaces an existing WAV');
    assert.equal(fs.readdirSync(tmp).some(name=>name.startsWith('.c64rdy-sid-')),false,'successful renders clean up their temporary files');
  }
} finally {fs.rmSync(tmp,{recursive:true,force:true});setQuiet(false);}
console.log('ok  - CLI SID conversion');
