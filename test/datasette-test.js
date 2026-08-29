// Unit tests for the Commodore 1530 (C2N) Datasette emulation.
//
// Spec reference (TAP format, per VICE/CCS docs):
//   Bytes 0..11  : ASCII "C64-TAPE-RAW"
//   Byte  12     : version (0, 1, 2)
//   Bytes 13..15 : reserved (zero)
//   Bytes 16..19 : data size (uint32 little-endian)
//   Data:
//     v0: N != 0 → next edge in N*8 PAL cycles
//         N == 0 → overflow pulse, fixed length 2048 cycles (256 * 8)
//     v1: N != 0 → next edge in N*8 cycles
//         N == 0 → next 3 bytes are an LE 24-bit exact cycle count
//     v2: like v1, but each pulse is a half-wave (toggle FLAG line)
//
// Playback model:
//   - FLAG callback fires on each pulse boundary.
//     v0/v1: full wave → callback(0) (falling) then callback(1) (rising).
//     v2:    half-wave → callback toggles between 0 and 1 each pulse.
//   - Tape only advances when motorOn && playPressed && !atEnd.
//   - After motor turn-on, a ~300ms startup window suppresses pulses.
//
// Usage:  node test/datasette-test.js

import { Datasette } from '../src/datasette.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function eq(a, b, msg) {
  if (a !== b) { console.error(`FAIL: ${msg} (got ${a}, expected ${b})`); process.exit(1); }
}

const CYCLES_PER_SECOND = 985248;
const MOTOR_STARTUP_CYCLES = Math.floor(CYCLES_PER_SECOND * 0.30);

// Build a TAP file blob from a version and a payload byte array.
function makeTap(version, payload) {
  const data = new Uint8Array(20 + payload.length);
  const magic = 'C64-TAPE-RAW';
  for (let i = 0; i < magic.length; i++) data[i] = magic.charCodeAt(i);
  data[12] = version;
  // bytes 13..15 reserved (left zero)
  const sz = payload.length;
  data[16] = sz & 0xFF;
  data[17] = (sz >> 8) & 0xFF;
  data[18] = (sz >> 16) & 0xFF;
  data[19] = (sz >> 24) & 0xFF;
  data.set(payload, 20);
  return data;
}

// Run datasette.clock in 1-cycle ticks and capture every flagCallback.
// Skips the motor startup window automatically by ticking past it first.
function captureEdges(tape, cycles) {
  const edges = []; // { cycle, level }
  tape.flagCallback = (level) => edges.push({ cycle: tick, level });
  let tick = 0;
  for (let i = 0; i < cycles; i++) {
    tape.clock(1);
    tick++;
  }
  return edges;
}

// Convenience: load + start playback, advance past motor startup quietly.
function startPlayback(tape) {
  tape.setPlayPressed(true);
  tape.setMotor(true);
  // Quiet-tick through startup.
  const noop = tape.flagCallback;
  tape.flagCallback = null;
  for (let i = 0; i < MOTOR_STARTUP_CYCLES; i++) tape.clock(1);
  tape.flagCallback = noop;
}

// -- 1. Header validation -----------------------------------------------------
{
  const t = new Datasette();
  let threw = false;
  try { t.loadTap(new Uint8Array(10)); } catch { threw = true; }
  assert(threw, 'rejects file shorter than 20-byte header');

  threw = false;
  const bad = new Uint8Array(20);
  // Wrong magic
  for (let i = 0; i < 12; i++) bad[i] = 'X'.charCodeAt(0);
  try { t.loadTap(bad); } catch { threw = true; }
  assert(threw, 'rejects file with wrong magic');

  threw = false;
  const badv = makeTap(3, []);
  try { t.loadTap(badv); } catch { threw = true; }
  assert(threw, 'rejects unsupported TAP version 3');

  console.log('ok  – header: magic, length, and version validation');
}

// -- 2. v0: standard byte produces edge after N*8 cycles ----------------------
{
  const t = new Datasette();
  // Single pulse N=10 → next edge at cycle 80.
  t.loadTap(makeTap(0, [10]));
  startPlayback(t);

  const edges = [];
  t.flagCallback = (level) => edges.push(level);

  // Tick 79 cycles: still no edge.
  for (let i = 0; i < 79; i++) t.clock(1);
  eq(edges.length, 0, 'no edge before 80 cycles');

  // 80th cycle: full-wave produces falling then rising edge.
  t.clock(1);
  eq(edges.length, 2, 'edge fires at exactly N*8 cycles');
  eq(edges[0], 0, 'first callback is falling edge (FLAG=0)');
  eq(edges[1], 1, 'second callback restores FLAG high');

  console.log('ok  – v0: N*8 cycles + full-wave edge pair');
}

// -- 3. v0: zero byte = 2048-cycle overflow pulse -----------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(0, [0]));
  startPlayback(t);

  let edgeCount = 0;
  t.flagCallback = () => edgeCount++;

  for (let i = 0; i < 2047; i++) t.clock(1);
  eq(edgeCount, 0, 'no edge before 2048 cycles');
  t.clock(1);
  eq(edgeCount, 2, 'overflow pulse is 2048 cycles in v0');

  console.log('ok  – v0: zero byte = fixed 2048-cycle overflow');
}

// -- 4. v1: standard byte still N*8 cycles ------------------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [5]));
  startPlayback(t);

  let edgeCount = 0;
  t.flagCallback = () => edgeCount++;

  for (let i = 0; i < 39; i++) t.clock(1);
  eq(edgeCount, 0, 'no edge before 40 cycles');
  t.clock(1);
  eq(edgeCount, 2, 'v1 standard byte uses N*8 cycles');

  console.log('ok  – v1: standard byte N*8 cycles');
}

// -- 5. v1: zero byte + 3 LE bytes = exact 24-bit cycle count -----------------
{
  const t = new Datasette();
  // 0x123456 cycles → 1193046
  const lo = 0x56, mi = 0x34, hi = 0x12;
  const expected = lo | (mi << 8) | (hi << 16);
  t.loadTap(makeTap(1, [0, lo, mi, hi]));
  startPlayback(t);

  let edgeCount = 0;
  t.flagCallback = () => edgeCount++;

  for (let i = 0; i < expected - 1; i++) t.clock(1);
  eq(edgeCount, 0, 'no edge before exact 24-bit cycle count');
  t.clock(1);
  eq(edgeCount, 2, 'edge fires at exact 24-bit count');

  console.log('ok  – v1: zero + 3 bytes = exact 24-bit cycle count');
}

// -- 6. v2: half-wave toggles FLAG line ---------------------------------------
{
  const t = new Datasette();
  // Two pulses, each 10*8 = 80 cycles.
  t.loadTap(makeTap(2, [10, 10]));
  startPlayback(t);

  const seen = [];
  t.flagCallback = (level) => seen.push(level);

  for (let i = 0; i < 80; i++) t.clock(1);
  eq(seen.length, 1, 'v2 emits ONE callback per pulse (half-wave)');
  eq(seen[0], 0, 'first half-wave drives FLAG low');

  for (let i = 0; i < 80; i++) t.clock(1);
  eq(seen.length, 2, 'second pulse fires after another N*8 cycles');
  eq(seen[1], 1, 'second half-wave drives FLAG high (toggle)');

  console.log('ok  – v2: half-wave pulses toggle FLAG');
}

// -- 7. Playback gating: motor AND play required ------------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10]));
  let edges = 0;
  t.flagCallback = () => edges++;

  // Motor on, play not pressed → no advance.
  t.setMotor(true);
  for (let i = 0; i < 200; i++) t.clock(1);
  eq(edges, 0, 'no advance with play released');

  // Motor off, play pressed → no advance.
  t.setMotor(false);
  t.setPlayPressed(true);
  for (let i = 0; i < 200; i++) t.clock(1);
  eq(edges, 0, 'no advance with motor off');

  console.log('ok  – playback requires motorOn AND playPressed');
}

// -- 8. Motor startup window suppresses early pulses --------------------------
{
  const t = new Datasette();
  // Tiny pulse (8 cycles) — would fire near-instantly without startup window.
  t.loadTap(makeTap(1, [1]));
  let edges = 0;
  t.flagCallback = () => edges++;

  t.setPlayPressed(true);
  t.setMotor(true);

  // Just before startup window completes: no edges.
  for (let i = 0; i < MOTOR_STARTUP_CYCLES - 100; i++) t.clock(1);
  eq(edges, 0, 'no pulses during motor startup window');

  // After startup completes the queued pulse can fire.
  for (let i = 0; i < 200; i++) t.clock(1);
  assert(edges >= 2, 'pulse fires once startup window ends');

  console.log('ok  – motor startup window holds pulses for ~300ms');
}

// -- 9. SENSE line follows playPressed ----------------------------------------
{
  const t = new Datasette();
  eq(t.getSenseLevel(), 1, 'SENSE high when no button pressed');
  t.setPlayPressed(true);
  eq(t.getSenseLevel(), 0, 'SENSE low when PLAY pressed (active-low)');
  t.setPlayPressed(false);
  eq(t.getSenseLevel(), 1, 'SENSE returns high after release');

  console.log('ok  – SENSE line: 0=pressed, 1=released');
}

// -- 10. End-of-tape stops further pulses -------------------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [5, 5]));  // two 40-cycle pulses
  startPlayback(t);

  let edges = 0;
  t.flagCallback = () => edges++;

  // Plenty of cycles to consume the entire tape.
  for (let i = 0; i < 1000; i++) t.clock(1);
  assert(t.atEnd, 'atEnd flag set after consuming all data');
  const finalEdges = edges;

  // Further clocks must not produce more pulses.
  for (let i = 0; i < 1000; i++) t.clock(1);
  eq(edges, finalEdges, 'no pulses after end of tape');

  console.log('ok  – end-of-tape halts pulse generation');
}

// -- 11. Truncated v1 long-pulse marks end of tape ----------------------------
{
  const t = new Datasette();
  // v1 with zero byte but only 2 trailing bytes — incomplete long pulse.
  t.loadTap(makeTap(1, [0, 0xAA, 0xBB]));
  startPlayback(t);

  for (let i = 0; i < 10_000_000; i++) t.clock(1);
  assert(t.atEnd, 'incomplete v1 long pulse triggers end-of-tape');

  console.log('ok  – truncated v1 long-pulse → atEnd');
}

// -- 12. Rewind restarts playback while preserving media ----------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [5, 5, 5]));
  const dur = t.durationSeconds;
  startPlayback(t);

  // Drain the tape.
  for (let i = 0; i < 10000; i++) t.clock(1);
  assert(t.atEnd, 'tape ended');
  const wasLength = t.tapData.length;

  t.rewind();
  assert(!t.atEnd, 'rewind clears atEnd');
  eq(t.pos, 1, 'rewind reloads first pulse (pos advances past first byte)');
  eq(t.tapData.length, wasLength, 'rewind preserves loaded data');
  eq(t.durationSeconds, dur, 'rewind preserves duration');
  eq(t.motorOn, false, 'rewind leaves motor off');
  eq(t.playPressed, false, 'rewind releases play button');

  // Confirm playback works again.
  let edges = 0;
  t.flagCallback = () => edges++;
  startPlayback(t);
  for (let i = 0; i < 10000; i++) t.clock(1);
  assert(edges > 0, 'pulses fire after rewind');

  console.log('ok  – rewind: preserves media, restarts playback');
}

// -- 13. Eject clears media ---------------------------------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10]));
  assert(t.hasMedia, 'media present after load');
  t.eject();
  assert(!t.hasMedia, 'media cleared after eject');
  eq(t.tapData, null, 'tapData null after eject');

  // clock() must be a no-op with no media.
  let edges = 0;
  t.flagCallback = () => edges++;
  t.setPlayPressed(true);
  t.setMotor(true);
  for (let i = 0; i < 10_000; i++) t.clock(1);
  eq(edges, 0, 'no pulses after eject');

  console.log('ok  – eject clears media');
}

// -- 14. reset() turns motor off but keeps media for KERNAL re-detect ---------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10]));
  t.setPlayPressed(true);
  t.setMotor(true);
  t.reset();
  eq(t.motorOn, false, 'reset turns motor off');
  assert(t.hasMedia, 'reset preserves loaded tape');
  assert(t.playPressed, 'reset preserves PLAY state for SENSE re-detect');

  console.log('ok  – reset: motor off, media + PLAY preserved');
}

// -- 15. setMotor on falling edge restores FLAG high --------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(2, [10]));   // v2 to leave FLAG potentially low after toggle
  startPlayback(t);

  const levels = [];
  t.flagCallback = (l) => levels.push(l);

  for (let i = 0; i < 80; i++) t.clock(1);
  eq(levels.at(-1), 0, 'v2 toggled FLAG low');

  t.setMotor(false);
  eq(levels.at(-1), 1, 'motor-off restores FLAG high');

  console.log('ok  – motor-off restores FLAG line high');
}

// -- 16. positionFraction and elapsedSeconds advance during playback ----------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10, 10, 10, 10]));
  eq(t.positionFraction, 0.25, 'positionFraction reflects pos/length after first pulse load');
  // Note: loadTap calls _loadNextPulse, advancing pos to 1 of 4 → 0.25.

  startPlayback(t);
  // Run a fixed number of cycles past startup; elapsed should be that many.
  for (let i = 0; i < 1000; i++) t.clock(1);
  assert(t.elapsedSeconds > 0, 'elapsedSeconds advances with cycles');
  assert(t.elapsedSeconds < 1, 'elapsedSeconds tracks tape time only (<1s after 1000 cycles)');

  console.log('ok  – positionFraction and elapsedSeconds');
}

// -- 17. durationSeconds estimate is in the right ballpark --------------------
{
  const t = new Datasette();
  // 100 pulses of 100 each → 100 * 100 * 8 = 80_000 cycles ≈ 0.0812s
  const payload = new Array(100).fill(100);
  t.loadTap(makeTap(1, payload));
  const expected = (100 * 100 * 8) / CYCLES_PER_SECOND;
  const diff = Math.abs(t.durationSeconds - expected);
  assert(diff < 0.01, `durationSeconds ≈ ${expected.toFixed(4)}s (got ${t.durationSeconds.toFixed(4)})`);

  console.log('ok  – durationSeconds estimate matches summed pulse cycles');
}

// -- 18. Edge timing across many pulses (v1) ----------------------------------
{
  const t = new Datasette();
  // 5 pulses, each 50 cycles (byte 50 → 400 cycles? wait: 50*8 = 400)
  // Use byte=10 → 80 cycles each.
  const t2 = new Datasette();
  t2.loadTap(makeTap(1, [10, 10, 10, 10, 10]));
  startPlayback(t2);

  const cycleStamps = [];
  let cycleIdx = 0;
  t2.flagCallback = (level) => { if (level === 0) cycleStamps.push(cycleIdx); };

  for (let i = 0; i < 80 * 5 + 10; i++) {
    cycleIdx++;
    t2.clock(1);
  }

  eq(cycleStamps.length, 5, 'five falling edges over five pulses');
  for (let i = 0; i < cycleStamps.length; i++) {
    eq(cycleStamps[i], 80 * (i + 1), `pulse ${i + 1} fires at cycle ${80 * (i + 1)}`);
  }

  console.log('ok  – cumulative pulse timing across multiple pulses');
}

// -- 19. Cycles consumed mid-tick still align edges precisely -----------------
{
  // If the caller passes 100 cycles in a single clock() call covering several
  // 80-cycle pulses, all edges between must still be emitted.
  const t = new Datasette();
  t.loadTap(makeTap(1, [10, 10, 10]));   // 3 * 80 cycles
  startPlayback(t);

  let falling = 0;
  t.flagCallback = (l) => { if (l === 0) falling++; };

  t.clock(250);   // covers all three 80-cycle pulses
  eq(falling, 3, 'all three pulses fire within a single 250-cycle tick');

  console.log('ok  – multi-cycle tick still emits every covered edge');
}

// -- 20. setMotor / setPlayPressed are idempotent -----------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10]));
  t.setPlayPressed(true);
  t.setMotor(true);

  // Burn most of the startup window.
  for (let i = 0; i < MOTOR_STARTUP_CYCLES - 100; i++) t.clock(1);

  // Setting motor to ON again should NOT restart the startup window.
  t.setMotor(true);
  let edges = 0;
  t.flagCallback = () => edges++;
  for (let i = 0; i < 200; i++) t.clock(1);
  assert(edges > 0, 'redundant setMotor(true) does not re-arm startup window');

  console.log('ok  – setMotor/setPlayPressed are idempotent for same value');
}

// -- 21. Pressing PLAY while motor already on re-arms startup window ----------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [1]));   // very short pulse
  t.setMotor(true);

  // Burn most of the (initial, motor-driven) startup; play not pressed → no advance.
  for (let i = 0; i < MOTOR_STARTUP_CYCLES; i++) t.clock(1);

  // Now press PLAY; this should re-arm the startup window.
  t.setPlayPressed(true);

  let edges = 0;
  t.flagCallback = () => edges++;

  for (let i = 0; i < MOTOR_STARTUP_CYCLES - 100; i++) t.clock(1);
  eq(edges, 0, 'pressing PLAY re-arms startup window');

  for (let i = 0; i < 300; i++) t.clock(1);
  assert(edges > 0, 'pulses fire after re-armed window completes');

  console.log('ok  – PLAY pressed re-arms motor startup window');
}

// -- 22. Releasing PLAY restores FLAG high ------------------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(2, [10]));   // v2 leaves FLAG potentially low after toggle
  startPlayback(t);

  const levels = [];
  t.flagCallback = (l) => levels.push(l);

  for (let i = 0; i < 80; i++) t.clock(1);
  eq(levels.at(-1), 0, 'v2 toggled FLAG low');

  t.setPlayPressed(false);
  eq(levels.at(-1), 1, 'releasing PLAY restores FLAG high');

  console.log('ok  – PLAY release restores FLAG high');
}

// -- 23. Header size field truncates loaded data ------------------------------
{
  // Build a header that claims size=2 but with 5 trailing payload bytes.
  const data = new Uint8Array(20 + 5);
  const magic = 'C64-TAPE-RAW';
  for (let i = 0; i < magic.length; i++) data[i] = magic.charCodeAt(i);
  data[12] = 1;
  data[16] = 2;   // size = 2 (only first two payload bytes count)
  data.set([0x05, 0x05, 0xFF, 0xFF, 0xFF], 20);

  const t = new Datasette();
  t.loadTap(data);
  eq(t.tapData.length, 2, 'tapData truncated to header-declared size');

  console.log('ok  – header size field truncates loaded payload');
}

// -- 24. Empty data section → atEnd immediately -------------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, []));
  assert(t.atEnd, 'empty tape is at end immediately');
  startPlayback(t);
  let edges = 0;
  t.flagCallback = () => edges++;
  for (let i = 0; i < 10_000; i++) t.clock(1);
  eq(edges, 0, 'no pulses from empty tape');

  console.log('ok  – empty payload → atEnd, no pulses');
}

// -- 25. Loading a new tape replaces previous state ---------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(0, [50, 50, 50]));
  startPlayback(t);
  for (let i = 0; i < 1000; i++) t.clock(1);   // partial drain

  // Load a different tape — version + content + state should reset.
  t.loadTap(makeTap(1, [1]));
  eq(t.tapVersion, 1, 'tapVersion reflects new file');
  eq(t.tapData.length, 1, 'tapData replaced');
  eq(t.pos, 1, 'pos reset and first pulse reloaded');
  eq(t.motorOn, false, 'motor off after new load');
  eq(t.playPressed, false, 'PLAY released after new load');
  assert(!t.atEnd, 'atEnd cleared');

  console.log('ok  – loadTap on existing instance fully replaces state');
}

// -- 26. flagCallback set to null mid-playback does not crash -----------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10, 10, 10]));
  startPlayback(t);

  let edges = 0;
  t.flagCallback = () => edges++;

  for (let i = 0; i < 80; i++) t.clock(1);
  assert(edges > 0, 'edges fired with callback installed');

  t.flagCallback = null;
  for (let i = 0; i < 200; i++) t.clock(1);   // must not throw

  console.log('ok  – null flagCallback is safe mid-playback');
}

// -- 27. Multiple v0 overflow pulses chain correctly --------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(0, [0, 0, 5]));   // 2048 + 2048 + 40 cycles
  startPlayback(t);

  const cycles = [];
  let cur = 0;
  t.flagCallback = (l) => { if (l === 0) cycles.push(cur); };

  for (let i = 0; i < 5000; i++) { cur++; t.clock(1); }

  eq(cycles.length, 3, 'three falling edges');
  eq(cycles[0], 2048, 'first overflow at 2048');
  eq(cycles[1], 4096, 'second overflow at 4096');
  eq(cycles[2], 4096 + 40, 'standard pulse follows at +40');

  console.log('ok  – chained v0 overflow pulses sum correctly');
}

// -- 28. Pulse count tracks emitted pulses ------------------------------------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10, 10, 10, 10]));
  startPlayback(t);

  for (let i = 0; i < 5000; i++) t.clock(1);
  // _pulseCount is internal but observable via the implementation contract.
  eq(t._pulseCount, 4, 'internal pulse count matches payload');

  console.log('ok  – pulse count reaches payload length');
}

// -- 29. Reserved header bytes are ignored ------------------------------------
{
  const data = makeTap(1, [10]);
  data[13] = 0xAA;
  data[14] = 0xBB;
  data[15] = 0xCC;   // any garbage in reserved field
  const t = new Datasette();
  t.loadTap(data);   // must not throw
  startPlayback(t);
  let edges = 0;
  t.flagCallback = () => edges++;
  for (let i = 0; i < 200; i++) t.clock(1);
  assert(edges > 0, 'reserved bytes ignored, playback works');

  console.log('ok  – reserved header bytes are ignored');
}

// -- 30. clock() with multi-cycle tick that crosses startup boundary ---------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10]));   // 80-cycle pulse
  t.setPlayPressed(true);
  t.setMotor(true);

  let edges = 0;
  t.flagCallback = () => edges++;

  // Single big tick covering startup + first pulse + slack.
  t.clock(MOTOR_STARTUP_CYCLES + 200);
  assert(edges >= 2, 'edge fires when single tick crosses startup boundary');
  // Validate the remainder math: the pulse should already have completed,
  // so further ticks past end-of-tape produce nothing.
  const before = edges;
  for (let i = 0; i < 1000; i++) t.clock(1);
  eq(edges, before, 'no extra edges after end-of-tape');

  console.log('ok  – startup-boundary remainder math advances tape correctly');
}

// -- 31. Eject after partial play resets state and accepts a new tape ---------
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10, 10, 10]));
  startPlayback(t);
  for (let i = 0; i < 100; i++) t.clock(1);

  t.eject();
  eq(t.tapData, null, 'eject clears tapData');
  eq(t.pos, 0, 'eject resets position');
  eq(t.motorOn, false, 'eject turns motor off');
  eq(t.playPressed, false, 'eject releases play');
  assert(!t.atEnd, 'eject clears atEnd');

  // Reload should work normally.
  t.loadTap(makeTap(1, [5]));
  startPlayback(t);
  let edges = 0;
  t.flagCallback = () => edges++;
  for (let i = 0; i < 100; i++) t.clock(1);
  assert(edges > 0, 'new tape plays after eject');

  console.log('ok  – eject fully resets, new tape plays correctly');
}

// -- 32. positionFraction is clamped to [0,1] and matches edge cases ----------
{
  const t = new Datasette();
  eq(t.positionFraction, 0, 'no media → positionFraction 0');

  t.loadTap(makeTap(1, [10]));
  // After load, _loadNextPulse advances pos to 1 (consumed the only byte).
  eq(t.positionFraction, 1, 'fully consumed payload → positionFraction 1');

  console.log('ok  – positionFraction edge cases');
}

console.log('\nAll datasette tests passed.');
