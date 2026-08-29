// vic.reset() must:
//   (a) Set rowFetchD0xx from the POST-reset register defaults, not from
//       whatever the regs[] held before reset.
//   (b) Clear per-frame/per-line phase latches: _lineJustEnded,
//       _rasterCompMidLineDip, _lpLatchedThisFrame.
//   (c) Wipe the visible / collision / priority / border / sprite-owner
//       buffers so a mid-frame reset doesn't leave stale pixels behind.

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// ── 1: rowFetchD0xx mirrors post-reset register defaults ───────────────
{
  const vic = makeVic();
  // Stage non-default values that would be read by the OLD reset code.
  vic.regs[0x11] = 0xFF;
  vic.regs[0x16] = 0x00;
  vic.regs[0x18] = 0x00;
  vic.rowFetchD011 = 0xFF;
  vic.rowFetchD016 = 0x00;
  vic.rowFetchD018 = 0x00;
  vic.reset();
  expect(vic.regs[0x11] === 0x1B, `regs[$D011] reset to $1B`);
  expect(vic.regs[0x16] === 0xC8, `regs[$D016] reset to $C8`);
  expect(vic.regs[0x18] === 0x14, `regs[$D018] reset to $14`);
  expect(vic.rowFetchD011 === 0x1B, `rowFetchD011 mirrors post-reset $1B (got $${vic.rowFetchD011.toString(16)})`);
  expect(vic.rowFetchD016 === 0xC8, `rowFetchD016 mirrors post-reset $C8 (got $${vic.rowFetchD016.toString(16)})`);
  expect(vic.rowFetchD018 === 0x14, `rowFetchD018 mirrors post-reset $14 (got $${vic.rowFetchD018.toString(16)})`);
  ok('reset(): rowFetchD0xx captured AFTER register defaults are restored');
}

// ── 2: per-frame phase latches cleared ─────────────────────────────────
{
  const vic = makeVic();
  vic._lineJustEnded = true;
  vic._rasterCompMidLineDip = true;
  vic._lpLatchedThisFrame = true;
  vic.reset();
  expect(vic._lineJustEnded === false, `_lineJustEnded cleared`);
  expect(vic._rasterCompMidLineDip === false, `_rasterCompMidLineDip cleared`);
  expect(vic._lpLatchedThisFrame === false, `_lpLatchedThisFrame cleared`);
  ok('reset(): per-frame/per-line phase latches cleared');
}

// ── 3: visible / collision / priority / border buffers wiped ───────────
{
  const vic = makeVic();
  // Poison every relevant buffer.
  vic.fb32.fill(0xFFFFFFFF);
  vic.graphicsCollisionBuffer.fill(0xFF);
  vic.graphicsPriorityBuffer.fill(0xFF);
  vic.spriteCollisionBuffer.fill(0xFF);
  vic.spriteOwnerBuffer.fill(0x00);   // owner default is $FF, not 0
  vic.borderBuffer.fill(0xFF);
  vic.reset();
  // Sample multiple offsets to confirm a full wipe.
  for (const idx of [0, 1024, 65535, vic.fb32.length - 1]) {
    expect(vic.fb32[idx] === 0, `fb32[${idx}] cleared (got $${vic.fb32[idx].toString(16)})`);
  }
  // Side buffers are line-sized (#1): sample columns within one scanline.
  for (const idx of [0, 100, 200, 383]) {
    expect(vic.graphicsCollisionBuffer[idx] === 0, `graphicsCollisionBuffer[${idx}] cleared`);
    expect(vic.graphicsPriorityBuffer[idx] === 0, `graphicsPriorityBuffer[${idx}] cleared`);
    expect(vic.spriteCollisionBuffer[idx] === 0, `spriteCollisionBuffer[${idx}] cleared`);
    expect(vic.spriteOwnerBuffer[idx] === 0xFF, `spriteOwnerBuffer[${idx}] reset to $FF (got $${vic.spriteOwnerBuffer[idx].toString(16)})`);
    expect(vic.borderBuffer[idx] === 0, `borderBuffer[${idx}] cleared`);
  }
  ok('reset(): visible/collision/priority/border/owner buffers wiped');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
