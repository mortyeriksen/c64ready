import assert from 'node:assert/strict';
import { spriteCoverage, relatedWrites, spriteSourceAtLine, picturePoint } from '../src/monitor/learn-model.js';
const frame = {
  owners: Uint8Array.of(0,0,1,255), border: Uint8Array.of(0,1,0,0), lines: 2,
  pointers: new Uint8Array(16), spriteBanks: new Uint16Array(16),
  eventCount: 6, eventKind: Uint8Array.of(0,2,0x18,0x20,0x21,64),
};
assert.deepEqual([...spriteCoverage(frame)], [1,1,0,0,0,0,0,0], 'border-masked sprite coverage is excluded without claiming foreground visibility');
assert.deepEqual(relatedWrites(frame,'sprites',0), [0,2], 'sprite selection includes its coordinate and shared pointer-table register, not another sprite coordinate');
assert.deepEqual(relatedWrites(frame,'border'), [3,4], 'border evidence includes colour writes and excludes IRQ assertions');
assert.deepEqual(relatedWrites(frame,'timing'), [2,4], 'timing evidence includes pointer-table and background changes');
frame.pointers[8] = 0x80; frame.spriteBanks[8] = 0x4000;
assert.deepEqual(spriteSourceAtLine(frame,0,1), {pointer:0x80,bank:0x4000,address:0x6000}, 'sprite pointer addresses are bank plus pointer multiplied by 64');
assert.equal(picturePoint(20,20,768,768,384,272), null, 'clicks in vertical letterboxing do not select a framebuffer pixel');
assert.deepEqual(picturePoint(40,132,768,768,384,272), {x:20,y:10}, 'contain scaling removes vertical letterboxing before pixel selection');
assert.equal(picturePoint(768,300,768,768,384,272), null, 'right edge is outside the framebuffer');
assert.equal(picturePoint(0,0,0,0,384,272), null, 'zero-size picture has no selectable pixel');
console.log('ok  - captured sprite coverage, related writes, pointer addresses and letterboxed selection');
const { spriteBounds } = await import('../src/monitor/learn-model.js');
const bounds = spriteBounds({width:4,height:2, owners:Uint8Array.of(0,255,1,255,0,0,1,2),border:Uint8Array.of(0,0,0,0,0,1,0,1)});
assert.deepEqual(bounds[0], {left:0,top:0,right:0,bottom:1,pixels:2}, 'sprite bounds include all unmasked appearances of a hardware slot across the frame');
assert.deepEqual(bounds[1], {left:2,top:0,right:2,bottom:1,pixels:2}, 'sprite coverage is kept separate for each hardware slot');
assert.equal(bounds[2].pixels,0,'a border-masked sprite does not produce a visible preview');

const { frameFindings } = await import('../src/monitor/learn-model.js');
const recorded = {
  width: 384, height: 272, rasterOffset: 15, lines: 312, cyclesPerLine: 63,
  owners: new Uint8Array(384*272).fill(255), border: new Uint8Array(384*272).fill(1),
  flags: new Uint8Array(312*63), pointers: new Uint8Array(312*8),
  spriteBanks: new Uint16Array(312*8), spriteDma: new Uint8Array(312),
  eventCount: 2, eventKind: Uint8Array.of(0x20,64), eventTick: Uint16Array.of(123,124),
};
recorded.owners[0]=2; recorded.border[0]=0;
recorded.owners[1]=3;
recorded.flags[51*63+14]=4; recorded.flags[51*63+15]=4;
recorded.spriteDma[50]=4; recorded.spriteDma[51]=4; recorded.pointers[51*8+2]=7;
const observations=frameFindings(recorded);
assert.deepEqual(observations[0].points,[{tick:15*63,line:15,slot:2,precision:'line'}],'sprite finding excludes masked slots and reports line precision');
assert.equal(observations[1].points.length,1,'border finding counts each open line once');
assert.deepEqual(observations[2].points,[{tick:52*63-1,line:51,slot:2,precision:'line-end'}],'pointer change belongs to the end-of-line sample, not the fetch cycle');
assert.deepEqual(observations[3].points,[{tick:51*63+14,line:51,precision:'cycle'}],'bad-line finding records the first asserted condition once per raster');
assert.deepEqual(observations[4].points,[{tick:123,line:1,event:0,precision:'cycle'}],'write findings retain exact captured ticks and exclude IRQ events');
assert.ok(frameFindings(null).every(group=>!group.points.length),'no frame creates no invented observations');
recorded.spriteDma[50]|=8; recorded.spriteDma[51]|=8; recorded.pointers[51*8+3]=9;
const simultaneous=frameFindings(recorded)[2].points;
assert.equal(simultaneous.length,2,'source changes retain separate slots even at the same sampled timestamp');
assert.equal(simultaneous[0].tick,simultaneous[1].tick,'simultaneous source samples share a timestamp without being merged');

const { borderEvidence } = await import('../src/monitor/learn-model.js');
const borders = { ...recorded, flags: new Uint8Array(312*63).fill(3), eventCount: 3,
  eventKind: Uint8Array.of(0x11,0x16,0x20), eventTick: Uint16Array.of(943,945,940) };
borders.flags[945]=2; borders.flags[946]=0;
const borderSample=borderEvidence(borders,945);
assert.equal(borderSample.uncovered,1,'border explanation counts uncovered positions outside the standard display window on the selected line');
assert.equal(borderSample.spriteCoverage,1,'border explanation reports recorded sprite coverage without claiming final pixel ownership');
assert.deepEqual(borderSample.writes,[0],'only earlier border-control writes are related, excluding same-cycle writes and colour writes');
assert.deepEqual(borderSample.transitions[0],{tick:945,changed:1,mainClosed:false,verticalClosed:true},'recorded main-gate transition is separate from the vertical gate');
assert.equal(borderEvidence(borders,0).transitions.length,0,'the first cycle does not invent a transition from the preceding uncaptured frame');
assert.equal(borderEvidence(borders,0).pixelsAvailable,false,'timing outside the captured image is not reported as visible pixel evidence');
assert.equal(borderEvidence({...borders,overflow:true},945).incompleteWrites,true,'overflow remains explicit in the border evidence trail');
assert.equal(borderEvidence(null,0),null,'missing captures have no border evidence');
const { captureLabel, recordedOrigin } = await import('../src/monitor/capture-context.js');
assert.equal(captureLabel(recorded),captureLabel(recorded),'the same detached frame retains its identity across views');
assert.notEqual(captureLabel(recorded),captureLabel(borders),'different captures have distinct identities');
assert.match(recordedOrigin(recorded,0),/raster 1, cycle 61/,'captured instruction origins retain their one-based event cycle');
