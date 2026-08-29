// Datasette recording + full transport. Unit-level coverage of the write path
// and the five-key mechanism, derived from the .TAP container rules and the
// 1530's behaviour:
//
//   - a TAP v1 entry is one full wave, measured between consecutive low->high
//     transitions of the cassette WRITE line; v2 entries are half-waves
//   - pulses over 255*8 cycles use the 0 + 24-bit little-endian long form
//   - the ÷8 quantization remainder carries forward so timing doesn't drift
//   - SENSE is low for ANY key down; the machine cannot tell which
//   - RECORD is interlocked with PLAY and blocked by the write-protect tabs
//   - no key moves tape unless the computer energises the motor line
//
// The KERNAL-level round trip lives in kernal-tape-save-test.js.

import { Datasette, blankTapBytes } from '../src/datasette.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

const CYCLES_PER_SECOND = 985248;

function makeTap(version, payload) {
  const data = new Uint8Array(20 + payload.length);
  const magic = 'C64-TAPE-RAW';
  for (let i = 0; i < magic.length; i++) data[i] = magic.charCodeAt(i);
  data[12] = version;
  const sz = payload.length;
  data[16] = sz & 0xFF; data[17] = (sz >> 8) & 0xFF;
  data[18] = (sz >> 16) & 0xFF; data[19] = (sz >> 24) & 0xFF;
  data.set(payload, 20);
  return data;
}

// Put the deck in RECORD with the motor running on a blank tape.
function recorder() {
  const t = new Datasette();
  t.newBlankTape();
  t.setMotor(true);
  assert(t.pressKey('REC') === true, 'RECORD engages on a blank tape');
  return t;
}

// Write one square wave of `cycles` total, split evenly, by clocking the tape
// and toggling the write line — exactly how a saver drives the pin. Requires
// the line to be low, so the first transition is the rising edge that bounds
// the pulse.
function writeWave(t, cycles) {
  const half = cycles >> 1;
  t.setWriteLine(1);
  t.clock(half);
  t.setWriteLine(0);
  t.clock(cycles - half);
}

// Emit `count` recorded pulses. That takes count+1 waves: the KERNAL's own first
// rising edge only arms the measurement (there is no earlier edge to measure
// from), exactly as a real recording begins.
function writeWaves(t, cycles, count) {
  t.setWriteLine(0);                    // the pin idles high until driven
  for (let i = 0; i <= count; i++) writeWave(t, cycles);
}

// The recorded pulse data (no 20-byte header).
function recorded(t) {
  return Array.from(t.exportTapBytes().subarray(20));
}

// ── 1. one full wave per rising edge, quantized to 8 cycles ────────────────
{
  const t = recorder();
  writeWaves(t, 384, 4);
  eq(recorded(t), [48, 48, 48, 48], 'four 384-cycle waves → four $30 entries');
  eq(t.tapVersion, 1, 'blank tape records as TAP v1 by default');
}

// ── 2. the ÷8 remainder carries instead of drifting ───────────────────────
{
  const t = recorder();
  // 380 cycles is 47.5 units: rounding alone would drift 4 cycles per pulse.
  writeWaves(t, 380, 8);
  const bytes = recorded(t);
  eq(bytes.length, 8, 'eight pulses recorded');
  const total = bytes.reduce((a, b) => a + b, 0) * 8;
  assert(Math.abs(total - 8 * 380) <= 8,
    `carried quantization keeps the total within one unit: ${total} vs ${8 * 380}`);
  assert(bytes.every(b => b === 47 || b === 48),
    `each entry lands on 47 or 48 units, got ${bytes.join(',')}`);
}

// ── 3. pulses over 255*8 cycles use the v1 long form, exactly ─────────────
{
  const t = recorder();
  writeWaves(t, 5000, 1);        // > 2040, so 0 + 24-bit little-endian
  const bytes = recorded(t);
  eq(bytes, [0, 5000 & 0xFF, (5000 >> 8) & 0xFF, 0], 'long pulse is exact in the long form');
}

// ── 4. a gap beyond the 24-bit ceiling splits ─────────────────────────────
{
  const t = recorder();
  t.setWriteLine(0);
  t.setWriteLine(1);               // arms the measurement
  const huge = 0xFFFFFF + 1000;
  t.clock(huge);
  t.setWriteLine(0);
  t.setWriteLine(1);               // closes one enormous pulse
  const bytes = recorded(t);
  eq(bytes.slice(0, 4), [0, 0xFF, 0xFF, 0xFF], 'first entry is the 24-bit maximum');
  assert(bytes.length > 4, 'the remainder is emitted as a second entry');
}

// ── 5. sub-4-cycle pulses cannot vanish (0 is the escape byte) ────────────
{
  const t = recorder();
  t.setWriteLine(0);
  t.setWriteLine(1);                   // arms
  t.clock(1); t.setWriteLine(0);
  t.clock(1); t.setWriteLine(1);       // a 2-cycle full wave
  const bytes = recorded(t);
  eq(bytes, [1], 'a pulse under 4 cycles records as the minimum unit, never 0');
}

// ── 6. v2 tapes record half-waves, starting on a rising edge ──────────────
{
  const t = new Datasette();
  t.loadTap(makeTap(2, []));           // blank v2 tape, nothing to keep
  assert(t.writeProtected === false, 'an empty image needs no protection');
  t.setMotor(true);
  assert(t.pressKey('REC') === true, 'RECORD engages on a blank v2 tape');
  t.setWriteLine(0);
  t.setWriteLine(1);                   // this rising edge arms the measurement
  t.clock(100); t.setWriteLine(0);     // 100-cycle half-wave
  t.clock(200); t.setWriteLine(1);     // 200-cycle half-wave
  const bytes = recorded(t);
  eq(bytes, [Math.round(100 / 8), Math.round(200 / 8)],
    'v2 records every half-wave, not the full period');
  eq(t.tapVersion, 2, 'recording onto a v2 tape stays v2');
}

// ── 7. a stationary tape records nothing ─────────────────────────────────
{
  const t = recorder();
  writeWaves(t, 384, 1);
  const before = recorded(t).length;
  t.setMotor(false);                   // motor parked: no tape passes the head
  for (let i = 0; i < 20; i++) { t.setWriteLine(1); t.clock(100); t.setWriteLine(0); t.clock(100); }
  eq(recorded(t).length, before, 'edges with the motor off add no pulses');

  // ...and the pulse straddling the stop measures only the distance travelled.
  t.setMotor(true);
  t.setWriteLine(1);
  t.clock(384);
  t.setWriteLine(0);
  t.clock(0);
  t.setWriteLine(1);
  const bytes = recorded(t);
  eq(bytes[bytes.length - 1], 48, 'the pulse across a motor stop is 384 moving cycles');
}

// ── 8. RECORD needs a tape, and the tabs block it ─────────────────────────
{
  const t = new Datasette();
  t.setMotor(true);
  eq(t.pressKey('REC'), false, 'RECORD refuses with no tape inserted');
  eq(t.key, 'STOP', 'the refused key does not latch');

  t.newBlankTape();
  t.writeProtected = true;
  eq(t.pressKey('REC'), false, 'RECORD refuses on a write-protected cassette');
  eq(t.key, 'STOP', 'protected RECORD does not latch');
  eq(t.pressKey('PLAY'), true, 'PLAY still works on a protected cassette');

  t.writeProtected = false;
  eq(t.pressKey('REC'), true, 'RECORD engages once the tabs are intact');
  assert(t.playPressed, 'RECORD engages the PLAY mechanism too');
}

// ── 8b. loaded images arrive protected; a blank tape does not ───────────
{
  const loaded = new Datasette();
  loaded.loadTap(makeTap(1, [10, 10]));
  eq(loaded.writeProtected, true, 'LOAD inserts a protected tape — recording would erase it');
  eq(loaded.pressKey('REC'), false, 'so RECORD is refused until the tabs go in');

  const blank = new Datasette();
  blank.newBlankTape();
  eq(blank.writeProtected, false, 'BLANK inserts a writable tape — the point is to record');
  eq(blank.pressKey('REC'), true, 'so RECORD engages straight away');

  // A blank cached while powered off is applied through loadTap at POWER ON, and
  // must still come back writable — an empty image has nothing to protect.
  const cached = new Datasette();
  cached.loadTap(blankTapBytes());
  eq(cached.writeProtected, false, 'a cached blank restores writable');
  eq(cached.pressKey('REC'), true, 'and RECORD works after POWER ON');

  // Ejecting clears the flag with the media.
  blank.writeProtected = true;
  blank.eject();
  eq(blank.writeProtected, false, 'eject clears write protection with the tape');
}

// ── 9. SENSE is low for any key, and only STOP releases it ───────────────
{
  const t = new Datasette();
  t.newBlankTape();
  eq(t.getSenseLevel(), 1, 'no key down → SENSE high');
  for (const key of ['PLAY', 'REC', 'FF', 'REW']) {
    t.pressKey('STOP');
    t.pressKey(key);
    eq(t.getSenseLevel(), 0, `${key} down → SENSE low`);
  }
  t.pressKey('STOP');
  eq(t.getSenseLevel(), 1, 'STOP → SENSE high again');
}

// ── 10. recording truncates at the record point ─────────────────────────
{
  const t = new Datasette();
  // Six 80-cycle pulses.
  t.loadTap(makeTap(1, [10, 10, 10, 10, 10, 10]));
  t.writeProtected = false;            // an inserted image is protected by default
  t.setMotor(true);
  t.setPlayPressed(true);
  // Play past the startup window and two pulses' worth.
  for (let i = 0; i < Math.floor(CYCLES_PER_SECOND * 0.30) + 200; i++) t.clock(1);
  const splice = t.pos;
  assert(splice > 0 && splice < 6, `head is mid-tape before recording, pos=${splice}`);

  t.pressKey('REC');
  writeWaves(t, 384, 2);
  t.pressKey('STOP');                  // commits the session

  const bytes = Array.from(t.tapData);
  eq(bytes.length, splice + 2, 'kept prefix plus the new pulses, tail dropped');
  eq(bytes.slice(splice), [48, 48], 'the recorded pulses follow the splice point');
  assert(t.dirty, 'a recorded tape is dirty until exported');
}

// ── 11. exportTapBytes writes a valid, self-describing header ───────────
{
  const t = recorder();
  writeWaves(t, 384, 3);
  const tap = t.exportTapBytes();
  eq(String.fromCharCode(...tap.subarray(0, 12)), 'C64-TAPE-RAW', 'magic');
  eq(tap[12], 1, 'version byte');
  const size = tap[16] | (tap[17] << 8) | (tap[18] << 16) | (tap[19] << 24);
  eq(size, tap.length - 20, 'size field matches the payload length');

  // Round trip: the export must load back as the same pulse train.
  const back = new Datasette();
  back.loadTap(tap);
  eq(Array.from(back.tapData), Array.from(tap.subarray(20)), 'export reloads byte-identically');
}

// ── 12. recording onto a v0 tape re-emits the prefix as v1 ─────────────
{
  const t = new Datasette();
  // v0: a bare 0 means "longer than 255*8", which v1 would read as an escape.
  t.loadTap(makeTap(0, [10, 0, 10]));
  t.writeProtected = false;
  t.setMotor(true);
  t.setPlayPressed(true);
  for (let i = 0; i < Math.floor(CYCLES_PER_SECOND * 0.30) + 5000; i++) t.clock(1);
  t.pressKey('REC');
  eq(t.tapVersion, 1, 'the container is upgraded to v1 for recording');
  writeWaves(t, 384, 1);
  t.pressKey('STOP');

  // Reload the export and confirm the old v0 gap still plays as 2048 cycles.
  const back = new Datasette();
  back.loadTap(t.exportTapBytes());
  const lens = [];
  let last = 0, cyc = 0;
  back.setMotor(true); back.setPlayPressed(true);
  back.flagCallback = (lvl) => { if (lvl === 0) { lens.push(cyc - last); last = cyc; } };
  for (let i = 0; i < Math.floor(CYCLES_PER_SECOND * 0.30); i++) back.clock(1);
  cyc = 0; last = 0;
  for (let i = 0; i < 20000; i++) { back.clock(1); cyc++; }
  assert(lens.includes(2048), `the transcoded v0 gap still measures 2048 cycles, got ${lens.join(',')}`);
}

// ── 13. no key moves tape without the motor line ──────────────────────
{
  const t = new Datasette();
  t.loadTap(makeTap(1, new Array(4000).fill(100)));
  const total = t.durationSeconds;
  t.pressKey('FF');
  for (let i = 0; i < 200_000; i++) t.clock(1);
  eq(t.elapsedSeconds, 0, 'F.FWD with the motor off moves nothing');

  t.setMotor(true);
  for (let i = 0; i < 200_000; i++) t.clock(1);
  assert(t.elapsedSeconds > 0, 'F.FWD winds once the motor is energised');
  assert(t.elapsedSeconds <= total, `winding clamps to the media (${t.elapsedSeconds} <= ${total})`);
}

// ── 14. F.FWD and REW move at wind speed, and REW returns to the start ──
{
  const t = new Datasette();
  t.loadTap(makeTap(1, new Array(20000).fill(200)));   // 20000 * 1600 cycles
  t.setMotor(true);
  t.pressKey('FF');
  const CHUNK = 100_000;
  for (let i = 0; i < CHUNK; i++) t.clock(1);
  const wound = t.elapsedSeconds;
  assert(wound > (CHUNK / CYCLES_PER_SECOND) * 10,
    `winding is much faster than play speed (${wound}s of tape in ${CHUNK} cycles)`);

  t.pressKey('REW');
  for (let i = 0; i < CHUNK * 2; i++) t.clock(1);
  eq(t.elapsedSeconds, 0, 'REW winds back to the start');
  eq(t.atEnd, false, 'rewound tape is not at end');
  eq(t.counter, 0, 'counter reads 000 at the start');
  // The key pops up at the end of its travel: holding it down would keep SENSE
  // low with nowhere left to wind, so the deck would look busy forever.
  eq(t.key, 'STOP', 'REW releases itself at the start of the tape');
  eq(t.getSenseLevel(), 1, 'and SENSE goes back high');


  // Playback still works from wherever winding left the transport.
  t.pressKey('PLAY');
  let edges = 0;
  t.flagCallback = (lvl) => { if (lvl === 0) edges++; };
  for (let i = 0; i < Math.floor(CYCLES_PER_SECOND * 0.30) + 10_000; i++) t.clock(1);
  assert(edges > 0, 'pulses resume after winding');

  // The same release at the other end of the travel. The tape is
  // 20000 * 1600 = 32 Mcy long, so winding it whole at 25x takes ~1.3 M cycles.
  t.pressKey('FF');
  for (let i = 0; i < 1_400_000; i++) t.clock(1);
  eq(t.key, 'STOP', 'F.FWD releases itself at the end of the tape');
  assert(t.elapsedSeconds > 0, 'having wound forward to get there');
}

// ── 15. seeking lands mid-pulse without losing the cursor ──────────────
{
  const t = new Datasette();
  t.loadTap(makeTap(1, new Array(500).fill(100)));   // each pulse 800 cycles
  t.seekToCycle(800 * 10 + 300);                      // 300 cycles into pulse 11
  eq(t.cyclesUntilEdge, 500, 'what remains of the straddled pulse counts down');
  eq(t.pos, 11, 'cursor sits just past the straddled pulse');
  eq(t.elapsedSeconds, (800 * 10 + 300) / CYCLES_PER_SECOND, 'position is the requested tape time');
}

// ── 15b. scrubbing by fraction lands on the byte you aimed at ──────────
// The progress bar is measured in bytes, so a click has to seek in bytes: a v1
// long form is 4 bytes for one pulse, so seeking by tape time would drift off
// wherever the pointer was put.
{
  const t = new Datasette();
  // 100 short pulses (1 byte, 800 cy each), then a long form (4 bytes, 40000 cy),
  // then 100 more short ones — bytes and cycles deliberately out of proportion.
  const payload = [
    ...new Array(100).fill(100),
    0, 0x40, 0x9C, 0x00,
    ...new Array(100).fill(100),
  ];
  t.loadTap(makeTap(1, payload));
  const len = payload.length;              // 204 bytes
  eq(t.tapData.length, len, 'payload length');

  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    t.seekToFraction(f);
    const aimed = Math.round(f * len);
    // The cursor sits at the first pulse boundary at or after the target, so it
    // can overshoot by one pulse's bytes (4 for the long form) but never drift.
    assert(t.pos >= aimed && t.pos <= aimed + 4,
      `seek to ${f} lands at byte ${aimed} (got ${t.pos})`);
  }

  // Reading the time at a position must not move the transport.
  t.seekToFraction(0.5);
  const posBefore = t.pos, cycBefore = t.elapsedSeconds;
  const peek = t.secondsAtFraction(0.9);
  eq(t.pos, posBefore, 'secondsAtFraction leaves the cursor alone');
  eq(t.elapsedSeconds, cycBefore, 'secondsAtFraction leaves the position alone');
  assert(peek > cycBefore, `peeking ahead reads a later time (${peek} > ${cycBefore})`);
  eq(t.secondsAtFraction(0), 0, 'time at the head is zero');
  assert(Math.abs(t.secondsAtFraction(1) - t.durationSeconds) < 1e-9,
    'time at the end is the whole duration');

  // Out-of-range fractions clamp rather than throw. At the head the cursor reads
  // 1, not 0: the first pulse is loaded and counting down, same as after rewind().
  t.seekToFraction(-5);
  eq(t.elapsedSeconds, 0, 'a negative fraction clamps to the start');
  eq(t.pos, 1, 'and the first pulse is loaded, as after rewind()');
  t.seekToFraction(9);  eq(t.atEnd, true, 'a fraction past 1 clamps to the end');

  // Scrubbing commits an open recording rather than splicing into it — and the
  // fraction must be taken against the COMMITTED tape. A non-zero fraction is the
  // only way to see that: at 0 the length cancels out either way.
  const r = new Datasette();
  r.newBlankTape();
  r.setMotor(true);
  r.pressKey('REC');
  writeWaves(r, 384, 4);           // 4 pulses = 4 bytes on a tape that began empty
  assert(r.recording, 'recording is open');
  r.seekToFraction(0.5);
  eq(r.recording, false, 'seeking commits the recording first');
  eq(Array.from(r.tapData), [48, 48, 48, 48], 'the pulses written so far are kept');
  // Half of the committed 4 bytes: the head lands mid-tape, not at 0 (which is
  // where a fraction of the pre-splice length would have put it).
  eq(r.pos, 3, 'the fraction is scaled against the committed length');
  assert(r.elapsedSeconds > 0, 'so the head is genuinely mid-tape');

  // The hover readout has nothing to preview mid-write: it reports the head.
  const q = new Datasette();
  q.newBlankTape();
  q.setMotor(true);
  q.pressKey('REC');
  writeWaves(q, 384, 3);
  eq(q.secondsAtFraction(0.9), q.elapsedSeconds, 'previewing mid-write reads the head');
  assert(q.recording, 'and previewing does not commit the recording');
}

// ── 16. the counter tracks tape time and wraps at 1000 ────────────────
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10]));
  t._tapeCycles = 0;
  eq(t.counter, 0, 'counter starts at 000');
  t._tapeCycles = CYCLES_PER_SECOND * 1.8 * 5;
  eq(t.counter, 5, 'counter advances with tape time');
  t._tapeCycles = CYCLES_PER_SECOND * 1.8 * 1002;
  eq(t.counter, 2, 'counter wraps at 1000');
}

// ── 17. the recorded tape survives a save-state round trip ────────────
{
  const t = recorder();
  writeWaves(t, 384, 5);
  const bytesMid = recorded(t);
  const state = t.serialize();
  const media = t.exportTapBytes();     // what the machine bundles

  const back = new Datasette();
  back.loadTap(media);
  back.deserialize(state);
  eq(recorded(back), bytesMid, 'restored tape holds everything recorded so far');
  eq(back.key, 'REC', 'the transport key is restored');
  assert(back.recording, 'the record session reopens');

  // Keep recording after the restore; the stream must continue, not restart.
  back.setWriteLine(0);
  back.clock(192);
  back.setWriteLine(1);
  const after = recorded(back);
  eq(after.length, bytesMid.length + 1, 'recording continues after restore');
}

// ── 18. legacy save-states without a key still restore ───────────────
{
  const t = new Datasette();
  t.loadTap(makeTap(1, [10, 10]));
  t.deserialize({ tapVersion: 1, pos: 1, cyclesUntilEdge: 40, motorOn: true,
    playPressed: true, atEnd: false, _flagLevel: 1, _pulseCount: 0,
    _cyclesTotal: 12345, _motorStartupRemaining: 0 });
  eq(t.key, 'PLAY', 'a pre-key state restores PLAY from playPressed');
  eq(t.elapsedSeconds, 12345 / CYCLES_PER_SECOND, 'legacy _cyclesTotal becomes the position');
}

if (failures) {
  console.error(`\n${failures} datasette recording assertion(s) failed`);
  process.exit(1);
}
console.log('ok  - datasette recording + transport');
