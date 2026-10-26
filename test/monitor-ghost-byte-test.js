import assert from 'node:assert/strict';
import { ghostByteFinding } from '../src/monitor/ghost-bytes.js';

function capture({bank=0,d011=0,cycle=20,value=0x81,display=0,flags=0,address,kind=2}={}) {
  const tick=cycle-1,registers=new Uint8Array(63*64),banks=new Uint16Array(63),states=new Uint8Array(63),valid=new Uint8Array(63);
  registers[tick*64+0x11]=d011;banks[tick]=bank;states[tick]=display;valid[tick]=1;
  const gates=new Uint8Array(63).fill(3);gates[tick]=flags;
  return {lines:1,cyclesPerLine:63,flags:gates,analysis:{vicValid:valid,sequencer:{registers,bank:banks,display:states}},
    provenance:{count:1,kind:[kind],tick:[tick],address:[address??bank+(d011&64?0x39ff:0x3fff)],value:[value]}};
}
for(const bank of [0,0x4000,0x8000,0xc000]) {
  assert.equal(ghostByteFinding(capture({bank})).address,bank+0x3fff,`Bauer 3.7.3.9: idle graphics address includes VIC bank $${bank.toString(16)}`);
  assert.equal(ghostByteFinding(capture({bank,d011:64})).address,bank+0x39ff,`Bauer 3.7.3.9: ECM masks address bits 9 and 10 in bank $${bank.toString(16)}`);
}
assert.equal(ghostByteFinding(capture()).status,'Candidate','nonzero idle text data with open border is a candidate, not proof of a visible effect');
assert.equal(ghostByteFinding(capture({flags:3})).status,'Observed','closed border permits observing an idle fetch without claiming a visible technique');
assert.equal(ghostByteFinding(capture({value:0})).status,'Observed','a zero ghost byte is not evidence of a repeated foreground pattern');
assert.equal(ghostByteFinding(capture({d011:0x20})).status,'Observed','Bauer 3.7.3.9: zero matrix data makes bitmap idle output black regardless of the byte');
assert.equal(ghostByteFinding(capture({cycle:56})).status,'Not observed','Bauer 3.6.2: discarded idle bus reads are distinct from idle graphics g-accesses');
assert.equal(ghostByteFinding(capture({cycle:15})).status,'Not observed','refresh reads before the PAL graphics-fetch window do not prove idle graphics');
assert.equal(ghostByteFinding(capture({display:1})).status,'Not observed','normal display-state reads of the same address are not ghost-byte evidence');
assert.equal(ghostByteFinding(capture({d011:64,address:0x3fff})).status,'Not observed','ECM needs evidence for the masked idle address');
assert.equal(ghostByteFinding(capture({kind:15})).status,'Not observed','renderer source samples are not independently timed idle bus fetches');
assert.equal(ghostByteFinding({}).status,'Insufficient evidence','lightweight capture does not establish ghost-byte use');
const partial=capture();partial.provenance.overflow=true;
assert.equal(ghostByteFinding(partial).status,'Insufficient evidence','truncated provenance cannot support complete idle-fetch findings');
const invalid=capture();invalid.analysis.vicValid.fill(0);
assert.equal(ghostByteFinding(invalid).status,'Not observed','missing per-cycle state must not be interpreted as idle state');
const conflict=capture();const p=conflict.provenance;p.count=2;p.kind.push(2);p.tick.push(p.tick[0]);p.address.push(p.address[0]);p.value.push(0x42);
assert.equal(ghostByteFinding(conflict).status,'Insufficient evidence','conflicting byte values at one fetch cannot identify a ghost byte');
console.log('ok  - ghost-byte bank/ECM addressing, idle graphics qualification and honest evidence limits');
