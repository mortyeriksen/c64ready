import { Drive1541 } from '../src/drive1541.js';
import { VIA6522 } from '../src/6522.js';
import { CYCLES_PER_BYTE, zoneForTrack } from '../src/gcr.js';

const hex = (v, w = 2) => v.toString(16).toUpperCase().padStart(w, '0');

function assert(condition, message) {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    process.exit(1);
  }
  console.log(`  [PASS] ${message}`);
}

function testMemoryMap() {
  console.log('Testing Memory Map & Mirroring...');
  const rom = new Uint8Array(16384).fill(0xEA); // NOP
  rom[0x3FFC] = 0x00; // Reset vector lo
  rom[0x3FFD] = 0xC0; // Reset vector hi
  
  const drive = new Drive1541(rom);

  // RAM access
  drive.write(0x0000, 0x55);
  assert(drive.read(0x0000) === 0x55, 'RAM write/read at $0000');
  assert(drive.read(0x0800) === 0x55, 'RAM mirror at $0800');
  assert(drive.read(0x1000) === 0x55, 'RAM mirror at $1000');

  // ROM access
  assert(drive.read(0xC000) === 0xEA, 'ROM read at $C000');
  assert(drive.read(0xFFFC) === 0x00, 'ROM reset vector lo at $FFFC');
  assert(drive.read(0xFFFD) === 0xC0, 'ROM reset vector hi at $FFFD');

  // VIA access (basic check)
  drive.write(0x1800, 0xAA); // VIA1 ORB (mapped via writePortB)
  // VIA1 DDRB is $1802. Let's set it to all outputs so ORB works as expected.
  drive.write(0x1802, 0xFF);
  drive.write(0x1800, 0xAA);
  // Note: read(0x1800) returns (portB & dirB) | (inB & ~dirB). 
  // Since dirB=0xFF, it returns portB.
  assert(drive.read(0x1800) === 0xAA, 'VIA1 access at $1800');
  assert(drive.read(0x1810) === 0xAA, 'VIA1 mirror at $1810');
}

function testIecBusLogic() {
  console.log('Testing IEC Bus Logic...');
  const rom = new Uint8Array(16384);
  const drive = new Drive1541(rom);
  
  let syncCount = 0;
  drive.busSyncCallback = () => { syncCount++; };

  // Initial state: ATN=1, CLK=1, DATA=1 (Released)
  drive.setIecLines(1, 1, 1);
  
  // Set DDRB so we can write to the outputs
  drive.write(0x1802, 0xFF);
  
  // 1541-II Logic: DATA_pin is pulled low (0) if (manual_DATA_OUT == 0) OR (ATNA_pin XOR ATN_bus)
  // manual_DATA_OUT is VIA1 PB1 (0=low). ATNA_pin is VIA1 PB4 (0=Transparent/Enable).
  
  // Case 1: Manual Data Out = 0 (Asserted)
  // VIA1 PB1 is bit 1. Set bit 1 to 1 (which means manual_DATA_OUT=0 because of inversion in code)
  // Wait, let's look at drive1541.js:
  // this._manualDataOut_pin = (val & 0x02) ? 0 : 1;
  drive.write(0x1800, 0x02); // PB1 = 1 -> manualDataOut_pin = 0
  assert(drive.iecData === 0, 'DATA line asserted via manual PB1');
  
  // Case 2: ATNA XOR ATN
  drive.write(0x1800, 0x00); // manualDataOut_pin = 1 (Released)
  assert(drive.iecData === 1, 'DATA line released when manual PB1 is 0');
  
  // _atna_pin = (val & 0x10) ? 0 : 1;
  // ATN_bus is this.atnIn (1=Released, 0=Asserted)
  // drive.dataOut = (manualDataOut_pin === 0 || (_atna_pin ^ atnIn)) ? 0 : 1;
  
  // Set ATNA_pin = 1 (PB4=0)
  drive.write(0x1800, 0x00); // PB4=0 -> _atna_pin = 1
  drive.setIecLines(0, 1, 1); // ATN_bus = 0 (Asserted)
  // 1 ^ 0 = 1 -> dataOut = 0 (Asserted)
  assert(drive.iecData === 0, 'DATA line asserted via ATNA XOR ATN (1 XOR 0)');
  
  drive.setIecLines(1, 1, 1); // ATN_bus = 1 (Released)
  // 1 ^ 1 = 0 -> dataOut = 1 (Released)
  assert(drive.iecData === 1, 'DATA line released via ATNA XOR ATN (1 XOR 1)');

  // Set ATNA_pin = 0 (PB4=1)
  drive.write(0x1800, 0x10); // PB4=1 -> _atna_pin = 0
  drive.setIecLines(0, 1, 1); // ATN_bus = 0 (Asserted)
  // 0 ^ 0 = 0 -> dataOut = 1 (Released)
  assert(drive.iecData === 1, 'DATA line released via ATNA XOR ATN (0 XOR 0)');
  
  drive.setIecLines(1, 1, 1); // ATN_bus = 1 (Released)
  // 0 ^ 1 = 1 -> dataOut = 0 (Asserted)
  assert(drive.iecData === 0, 'DATA line asserted via ATNA XOR ATN (0 XOR 1)');
}

function testDriveMechanics() {
  console.log('Testing Drive Mechanics...');
  const rom = new Uint8Array(16384);
  const drive = new Drive1541(rom);

  // VIA2 PB2: Motor On (active high)
  drive.write(0x1C02, 0xFF); // DDRB = all output
  drive.write(0x1C00, 0x04); // PB2 = 1
  assert(drive.motorOn === true, 'Motor ON via VIA2 PB2');
  drive.write(0x1C00, 0x00); // PB2 = 0
  assert(drive.motorOn === false, 'Motor OFF via VIA2 PB2');

  // VIA2 PB5-6: Speed Zone
  drive.write(0x1C00, 0x20); // PB5=1, PB6=0 -> Zone 1
  assert(drive.currentSpeedZone === 1, 'Speed Zone 1 selected');
  drive.write(0x1C00, 0x60); // PB5=1, PB6=1 -> Zone 3
  assert(drive.currentSpeedZone === 3, 'Speed Zone 3 selected');

  // Stepper motor: VIA2 PB0/PB1 drive the stepper coils directly via a
  // Gray-code phase pattern (00→01→10→11→00 = step inward). The head moves
  // purely from the phase transition — independent of jobs, target tracks,
  // or the spindle motor (PB2). Physical stepping is not memory-mapped, so
  // custom drive code's zero-page variables must be left untouched.
  drive.currentHalfTrack = 2; // Track 1
  drive.ram[0x22] = 0xA5;
  // Prior writes left phase 0 (PB0-1 of $60 = 0). Phase 0→1 steps inward.
  drive.write(0x1C00, 0x01);
  assert(drive.currentHalfTrack === 3, 'phase 0→1 steps head inward one halftrack');
  assert(drive.ram[0x22] === 0xA5, 'stepper phase change does not patch drive zero page');
}

function testGcrReading() {
  console.log('Testing GCR Reading...');
  const rom = new Uint8Array(16384);
  const drive = new Drive1541(rom);

  // Mock a disk with a specific pattern
  const mockD64 = {
    readSector: (t, s) => new Uint8Array(256).fill(0)
  };
  drive.setDisk(mockD64);
  drive.motorOn = true;
  drive.write(0x1C0C, 0xEE);  // SOE on (DOS read config) so byte-ready sets V
  drive.currentHalfTrack = 2; // Track 1
  
  // We need to inject some GCR data. 
  // Drive1541._advanceSpindle reads from gcrDisk.getTrackStream.
  // Let's monkey-patch getTrackStream to return a known pattern.
  const syncPattern = new Uint8Array([0xFF, 0xFF, 0x55, 0xAA]); 
  // 0xFF, 0xFF is 16 ones -> should trigger SYNC.
  // 0x55 = 01010101
  // 0xAA = 10101010
  
  drive.gcrDisk.getTrackStream = () => syncPattern;
  drive.trackDirty = true;
  
  // Advance spindle. Cycles per bit depends on speed zone.
  // Zone 3 (default for track 1) is 32 cycles per byte -> 4 cycles per bit.
  drive.currentSpeedZone = 3; 
  
  // Run enough cycles to see SYNC (need 10 ones, we have 16)
  // Advance 12 bits
  for (let i = 0; i < 12; i++) {
    drive._advanceSpindle(4);
  }
  
  // Bit 7 of VIA2 PB is SYNC detect (0 = sync found)
  assert((drive.via2.readPortB() & 0x80) === 0, 'SYNC detected in GCR stream');

  // Now advance until we see the first byte (0x55)
  // We already advanced 12 bits. Remaining ones: 4. 
  // Then 0x55 starts. The first 0 bit of 0x55 will terminate SYNC and start byte framing.
  for (let i = 0; i < 4 + 8; i++) {
    drive._advanceSpindle(4);
  }
  
  assert(drive.lastGCRByte === 0x55, 'Correct GCR byte read after SYNC');
  // CPU Overflow flag should be set
  assert(drive.cpu.V === 1, 'CPU Overflow flag set after GCR byte');
}

function testCpuReset() {
  console.log('Testing CPU Reset...');
  const rom = new Uint8Array(16384);
  rom[0x3FFC] = 0x42;
  rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);
  
  assert(drive.cpu.pc === 0xC042, 'CPU PC initialized from reset vector');
}

// ============================================================================
// Cycle-accurate timing tests
// ============================================================================

// Build a fresh drive with known reset vector pointing at $C000.
function buildDrive() {
  const rom = new Uint8Array(16384).fill(0xEA);  // NOP sled
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  return new Drive1541(rom);
}

function testT1OneShotCycleAccuracy() {
  console.log('Testing VIA T1 one-shot cycle accuracy (N+2 latency)...');
  const via = new VIA6522('TestVIA');
  via.write(0x0B, 0x00);   // ACR: T1 one-shot (bit 6 = 0)
  via.write(0x0E, 0xC0);   // IER: enable T1
  let irqs = 0;
  via.irqHandler = (p) => { if (p) irqs++; };

  via.write(0x04, 0x07);   // T1L lo = 7
  via.write(0x05, 0x00);   // T1C hi = 0  → load + start

  // T1 one-shot: IRQ fires after exactly N+2 cycles (= 9).
  for (let i = 0; i < 8; i++) via.clock(1);
  assert(irqs === 0, 'No IRQ before N+2 cycles in one-shot');
  via.clock(1);
  assert(irqs === 1, `T1 one-shot IRQ fires at cycle N+2 (got ${irqs} IRQs after 9 cycles)`);

  // Run far past the period — no further IRQs in one-shot mode.
  for (let i = 0; i < 100; i++) via.clock(1);
  assert(irqs === 1, 'T1 one-shot does not retrigger');
}

function testT2OneShotCycleAccuracy() {
  console.log('Testing VIA T2 one-shot cycle accuracy...');
  const via = new VIA6522('TestVIA');
  via.write(0x0B, 0x00);   // ACR: T2 one-shot (PHI2 mode)
  via.write(0x0E, 0xA0);   // IER: enable T2 (bit 5)
  let irqs = 0;
  via.irqHandler = (p) => { if (p) irqs++; };

  via.write(0x08, 0x05);   // T2L lo = 5
  via.write(0x09, 0x00);   // T2C hi = 0 → start

  // T2 underflows when t2c < 0 → after N+1 cycles.
  for (let i = 0; i < 5; i++) via.clock(1);
  assert(irqs === 0, 'No T2 IRQ before underflow');
  via.clock(1);
  assert(irqs === 1, `T2 IRQ fires after N+1 cycles (got ${irqs})`);

  for (let i = 0; i < 100; i++) via.clock(1);
  assert(irqs === 1, 'T2 is one-shot — no retrigger');
}

function testT1FreeRunMultiPeriod() {
  console.log('Testing VIA T1 free-run cadence over many periods...');
  const via = new VIA6522('TestVIA');
  via.write(0x0B, 0x40);   // ACR: T1 free-run
  via.write(0x0E, 0xC0);   // IER: enable T1
  let irqs = 0;
  via.irqHandler = (p) => {
    if (p) { irqs++; via.write(0x0D, 0x40); }   // ack T1 IFR bit
  };

  // N=4: first period 6 cycles, subsequent periods 5 cycles each.
  via.write(0x04, 0x04);
  via.write(0x05, 0x00);

  // 6 + 5*9 = 51 cycles → expect 10 IRQs.
  for (let i = 0; i < 51; i++) via.clock(1);
  assert(irqs === 10, `T1 free-run cadence: expected 10 IRQs in 51 cycles, got ${irqs}`);
}

function testT1ReadClearsIrqButTimerKeepsRunning() {
  console.log('Testing T1C-L read clears IFR but timer keeps free-running...');
  const via = new VIA6522('TestVIA');
  via.write(0x0B, 0x40);   // free-run
  via.write(0x0E, 0xC0);
  let irqAsserted = false;
  via.irqHandler = (p) => { irqAsserted = p; };

  via.write(0x04, 0x09);   // N=9 → first period 11 cycles, then 10
  via.write(0x05, 0x00);

  for (let i = 0; i < 11; i++) via.clock(1);
  assert(irqAsserted, 'IRQ asserted after first underflow');

  // Reading T1C-L acks the T1 flag.
  via.read(0x04);
  assert(!irqAsserted, 'T1C-L read clears T1 IFR bit');

  // Timer continues — second underflow 10 cycles later.
  for (let i = 0; i < 10; i++) via.clock(1);
  assert(irqAsserted, 'T1 keeps firing in free-run after IFR ack');
}

function testGcrCyclesPerByteAllZones() {
  console.log('Testing GCR cycles-per-byte across all four speed zones...');
  for (let zone = 0; zone < 4; zone++) {
    const drive = buildDrive();
    drive.motorOn = true;
    drive.currentSpeedZone = zone;
    drive.write(0x1C0C, 0xEE);  // SOE on (DOS read config) so byte-ready fires
    drive.setDisk({ readSector: () => new Uint8Array(256).fill(0x55) });
    drive.gcrDisk.getTrackStream = () => new Uint8Array(2048).fill(0x55);
    drive.trackDirty = true;

    let bytes = 0;
    const orig = drive.cpu.setOverflow.bind(drive.cpu);
    drive.cpu.setOverflow = () => { bytes++; orig(); };

    const cpb = CYCLES_PER_BYTE[zone];
    // Run 100 byte-times + 25 cy SO-delay tail (gated VICE-spec P1 delay).
    for (let i = 0; i < cpb * 100 + 25; i++) drive._advanceSpindle(1);
    assert(bytes === 100,
      `Zone ${zone}: ${cpb} cyc/byte → 100 bytes in ${cpb * 100 + 25} cycles (got ${bytes})`);
  }
}

function testSpeedZoneChangeMidStream() {
  console.log('Testing speed-zone change mid-stream switches cadence...');
  const drive = buildDrive();
  drive.motorOn = true;
  // currentSpeedZone is the VIA2 PB5/PB6 bit pattern; on real hardware
  // 3 = densest = 26 cyc/byte (outer), 0 = sparsest = 32 cyc/byte (inner).
  drive.currentSpeedZone = 3;            // 26 cyc/byte
  drive.write(0x1C0C, 0xEE);  // SOE on (DOS read config) so byte-ready fires
  drive.setDisk({ readSector: () => new Uint8Array(256).fill(0x55) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array(2048).fill(0x55);
  drive.trackDirty = true;

  let bytes = 0;
  const orig = drive.cpu.setOverflow.bind(drive.cpu);
  drive.cpu.setOverflow = () => { bytes++; orig(); };

  // 5 bytes at zone 3 = 130 cycles + 25 cy SO-delay tail.
  for (let i = 0; i < 130 + 25; i++) drive._advanceSpindle(1);
  assert(bytes === 5, `Zone 3 phase: 5 bytes (got ${bytes})`);

  // Switch to zone 0 (32 cyc/byte). 5 more bytes = 160 cycles + 25 cy tail.
  drive.currentSpeedZone = 0;
  drive.bitCycleAccum = 0;
  drive._shiftBits = 0;
  for (let i = 0; i < 160 + 25; i++) drive._advanceSpindle(1);
  assert(bytes === 10, `After zone 0 switch: 10 total (got ${bytes})`);
}

function testMotorOffHaltsSpindle() {
  console.log('Testing motor-off halts GCR overflow generation...');
  const drive = buildDrive();
  drive.motorOn = true;
  drive.currentSpeedZone = 3;
  drive.write(0x1C0C, 0xEE);  // SOE on (DOS read config) so byte-ready fires
  drive.setDisk({ readSector: () => new Uint8Array(256).fill(0x55) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array(2048).fill(0x55);
  drive.trackDirty = true;

  let bytes = 0;
  const orig = drive.cpu.setOverflow.bind(drive.cpu);
  drive.cpu.setOverflow = () => { bytes++; orig(); };

  for (let i = 0; i < 64; i++) drive._advanceSpindle(1);   // 2 bytes at 32cpb
  assert(bytes === 2, `Motor on: 2 bytes (got ${bytes})`);

  drive.motorOn = false;
  for (let i = 0; i < 1000; i++) drive._advanceSpindle(1);
  assert(bytes === 2, `Motor off: no further overflows (got ${bytes})`);

  // SYNC line should also be released (high) when motor stops.
  assert((drive.via2.readPortB() & 0x80) !== 0, 'Motor off → no SYNC');
}

// 1541 stepper hardware: PB0/PB1 drive a 4-phase Gray-coded motor. Each
// phase transition (0↔1↔2↔3↔0) moves the head one half-track; direction
// comes from the transition pattern, NOT from any DOS-ROM job queue. The
// job queue is just a software layer the ROM uses to plan moves —
// fastloaders bypass it and step the motor directly.
function setupPhase0(drive) {
  // Stable starting phase: write ORB=0 then DDRB=$FF so the first phase
  // change observed by the stepper is from 0, not from the initial 0xFF
  // default ORB.
  drive.write(0x1C00, 0x00);
  drive.write(0x1C02, 0xFF);
}

function testStepperOneHalfTrackPerPhaseChange() {
  console.log('Testing stepper advances exactly one half-track per phase change...');
  const drive = buildDrive();
  setupPhase0(drive);
  drive.currentHalfTrack = 4;

  // Step-in sequence (0→1→2→3→0): each transition is +1 half-track.
  const phases = [0x01, 0x02, 0x03, 0x00];
  for (let i = 0; i < 4; i++) {
    drive.write(0x1C00, phases[i]);
    assert(drive.currentHalfTrack === 4 + (i + 1),
      `Phase change ${i + 1}: half-track ${5 + i} (got ${drive.currentHalfTrack})`);
  }
}

function testStepperReverseDirection() {
  console.log('Testing stepper steps DOWN with reverse Gray-code sequence...');
  const drive = buildDrive();
  setupPhase0(drive);
  drive.currentHalfTrack = 40;

  // Step-out sequence (0→3→2→1→0): each transition is -1 half-track.
  drive.write(0x1C00, 0x03);
  assert(drive.currentHalfTrack === 39, `Stepped down to 39 (got ${drive.currentHalfTrack})`);

  drive.write(0x1C00, 0x02);
  assert(drive.currentHalfTrack === 38, `Stepped down to 38 (got ${drive.currentHalfTrack})`);
}

function testStepperClampsAtTrack1() {
  console.log('Testing stepper clamps at lowest track (half-track 2)...');
  const drive = buildDrive();
  setupPhase0(drive);
  drive.currentHalfTrack = 2;

  // Step-out sequence past the lowest physical track — must clamp.
  const phasesOut = [0x03, 0x02, 0x01, 0x00, 0x03];
  for (const p of phasesOut) drive.write(0x1C00, p);
  assert(drive.currentHalfTrack >= 2,
    `Half-track stays >= 2 (got ${drive.currentHalfTrack})`);
}

function testStepperClampsAtTrack42() {
  console.log('Testing stepper clamps at half-track 84 (max)...');
  const drive = buildDrive();
  setupPhase0(drive);
  drive.currentHalfTrack = 84;

  const phasesIn = [0x01, 0x02, 0x03, 0x00, 0x01];
  for (const p of phasesIn) drive.write(0x1C00, p);
  assert(drive.currentHalfTrack <= 84,
    `Half-track stays <= 84 (got ${drive.currentHalfTrack})`);
}

function testStepperWorksWithoutActiveJob() {
  console.log('Testing stepper moves on phase writes even without a DOS job...');
  // Fastloaders write stepper phases directly without setting up a job
  // queue entry, so the stepper must respond to phase pattern alone.
  const drive = buildDrive();
  setupPhase0(drive);
  drive.ram[0x00] = 0x00;                // no active job
  drive.currentHalfTrack = 4;

  drive.write(0x1C00, 0x01);
  drive.write(0x1C00, 0x02);
  drive.write(0x1C00, 0x03);
  assert(drive.currentHalfTrack === 7,
    `Without job, stepper still moves on Gray-code phases (got ${drive.currentHalfTrack})`);
}

function testSyncRequiresExactly10Ones() {
  console.log('Testing SYNC needs ≥10 consecutive ones (9 must NOT latch)...');
  // 0xFF 0x80 = 9 ones followed by 7 zeros → never reaches 10 in a row.
  const drive = buildDrive();
  drive.motorOn = true;
  drive.currentSpeedZone = 3;
  drive.setDisk({ readSector: () => new Uint8Array(256) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array([0xFF, 0x80, 0x00, 0x00]);
  drive.trackDirty = true;

  // Advance through all 32 bits.
  for (let i = 0; i < 32 * 4; i++) drive._advanceSpindle(1);
  assert(!drive._inSync, '9 ones in a row does NOT enter SYNC');
  assert((drive.via2.readPortB() & 0x80) !== 0, 'SYNC pin never asserted with only 9 ones');
}

function testFirstZeroAfterSyncStartsByteFraming() {
  console.log('Testing first 0-bit after SYNC re-aligns byte framing...');
  // 0xFF 0xFF (16 ones) → SYNC, then 0x55 = 01010101 → first byte after SYNC.
  const drive = buildDrive();
  drive.motorOn = true;
  drive.currentSpeedZone = 3;
  drive.setDisk({ readSector: () => new Uint8Array(256) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array([0xFF, 0xFF, 0x55, 0xAA]);
  drive.trackDirty = true;

  // Run plenty to clock through SYNC + the next two bytes.
  for (let i = 0; i < 32 * 4; i++) drive._advanceSpindle(1);

  // Byte framing should have produced 0x55 first, then 0xAA. We check the most
  // recent value is 0xAA (second post-SYNC byte).
  assert(drive.lastGCRByte === 0xAA,
    `Second post-SYNC byte = 0xAA (got $${drive.lastGCRByte.toString(16)})`);
}

function testAtnFallingEdgeTriggersCA1Irq() {
  console.log('Testing ATN falling edge triggers VIA1 CA1 IRQ...');
  const drive = buildDrive();
  drive.cpu.I = 1;                       // mask CPU I-flag so we just observe irqLine
  drive.write(0x180E, 0x82);             // VIA1 IER: enable CA1 (bit 1, set with bit 7)
  drive.setIecLines(1, 1, 1);            // ATN released (high)
  assert(drive.cpu.irqLine === false, 'IRQ line clear initially');

  drive.setIecLines(0, 1, 1);            // ATN falling edge
  assert(drive.cpu.irqLine === true, 'CA1 IRQ raised on ATN falling edge');

  // A subsequent assertion of ATN that's already low must NOT re-trigger.
  drive.read(0x1801);                    // reading IRA acks CA1+CA2
  assert(drive.cpu.irqLine === false, 'CA1 ack via IRA read clears IRQ');

  drive.setIecLines(0, 1, 1);            // still low — no new edge
  assert(drive.cpu.irqLine === false, 'No edge → no new IRQ');
}

function testIrqFromBothVias() {
  console.log('Testing IRQ line is OR of VIA1 and VIA2...');
  const drive = buildDrive();
  drive.cpu.I = 1;

  // Enable T1 IRQ on VIA2 with a small period.
  drive.write(0x1C0E, 0xC0);
  drive.write(0x1C04, 0x02);
  drive.write(0x1C05, 0x00);             // T1 = 3 → underflow at cycle 4
  for (let i = 0; i < 5; i++) drive.via2.clock(1);
  assert(drive.cpu.irqLine === true, 'VIA2 T1 underflow propagates to CPU IRQ');

  // Clearing only the VIA2 flag should clear the line (VIA1 has no pending IRQ).
  drive.write(0x1C0D, 0x40);
  assert(drive.cpu.irqLine === false, 'Clearing VIA2 IFR clears IRQ when VIA1 is idle');
}

function testZoneForTrackBoundaries() {
  console.log('Testing zoneForTrack zone boundaries...');
  assert(zoneForTrack(1)  === 0, 'track 1 → zone 0');
  assert(zoneForTrack(17) === 0, 'track 17 → zone 0 (boundary)');
  assert(zoneForTrack(18) === 1, 'track 18 → zone 1');
  assert(zoneForTrack(24) === 1, 'track 24 → zone 1 (boundary)');
  assert(zoneForTrack(25) === 2, 'track 25 → zone 2');
  assert(zoneForTrack(30) === 2, 'track 30 → zone 2 (boundary)');
  assert(zoneForTrack(31) === 3, 'track 31 → zone 3');
  assert(zoneForTrack(40) === 3, 'track 40 → zone 3');
}

function testClockAdvancesTotalCyclesPerInstruction() {
  console.log('Testing clock() advances totalCycles in CPU-step granularity...');
  const drive = buildDrive();          // ROM is filled with NOP (2 cycles each)
  const before = drive.totalCycles;
  drive.clock(8);
  // CPU runs in instruction steps, so totalCycles advances by exactly the
  // number of instructions completed × NOP cycles. With NOP=2 and budget 8,
  // we expect totalCycles === before + 8 (4 NOPs).
  assert(drive.totalCycles === before + 8,
    `totalCycles after clock(8) of NOPs (got ${drive.totalCycles - before})`);
}

// ============================================================================
// Spec-based tests (MOS 6522 datasheet, 1541 hardware ref, CBM IEC protocol)
// These derive from datasheets/protocols and apply to any conforming impl.
// ============================================================================

// ── 6522 datasheet §3.4 (IFR/IER) ───────────────────────────────────────────

function specIfrWriteIsOneToClear() {
  console.log('Spec[6522]: IFR is "1-to-clear"; write 0 must not clear bits...');
  const via = new VIA6522('TestVIA');
  via.write(0x0E, 0xFE);     // enable all sources (bit7=1, bits 0..6=1)
  via.triggerIrq(1);
  via.triggerIrq(3);
  assert((via.ifr & 0x0A) === 0x0A, 'flags 1+3 set');

  via.write(0x0D, 0x00);     // write 0 → must NOT clear anything
  assert((via.ifr & 0x0A) === 0x0A, 'writing 0 to IFR is a no-op');

  via.write(0x0D, 0x02);     // write 1 to bit 1 only → clears just bit 1
  assert((via.ifr & 0x02) === 0, 'bit 1 cleared');
  assert((via.ifr & 0x08) !== 0, 'bit 3 untouched');
}

function specIerReadAlwaysReturnsBit7Set() {
  console.log('Spec[6522]: reading IER ($0E) always returns bit 7 = 1...');
  const via = new VIA6522('TestVIA');
  via.write(0x0E, 0x00);     // bit7=0 with payload 0 → "clear nothing"
  assert((via.read(0x0E) & 0x80) !== 0, 'IER bit 7 always reads 1');
  via.write(0x0E, 0x80 | 0x10);
  assert((via.read(0x0E) & 0x80) !== 0, 'IER bit 7 still 1 after enabling sources');
}

function specIerSetClearSemantics() {
  console.log('Spec[6522]: IER write — bit7=1 sets bits, bit7=0 clears bits...');
  const via = new VIA6522('TestVIA');
  via.write(0x0E, 0x80 | 0x07);          // set bits 0,1,2
  assert((via.read(0x0E) & 0x07) === 0x07, 'enabled bits 0..2');

  via.write(0x0E, 0x00 | 0x02);          // clear bit 1 only
  const ier = via.read(0x0E) & 0x7F;
  assert((ier & 0x02) === 0, 'bit 1 cleared');
  assert((ier & 0x05) === 0x05, 'bits 0 and 2 untouched');
}

function specIfrBit7ReflectsEnabledPending() {
  console.log('Spec[6522]: IFR bit 7 = (IFR & IER & $7F) != 0...');
  const via = new VIA6522('TestVIA');
  via.triggerIrq(2);                     // raise an IFR bit, but no IER
  assert((via.ifr & 0x80) === 0, 'IFR bit 7 stays 0 when source is not enabled');

  via.write(0x0E, 0x80 | 0x04);          // enable bit 2
  via.triggerIrq(2);                     // re-trigger so _updateIrq runs
  assert((via.ifr & 0x80) !== 0, 'IFR bit 7 set once enabled flag is pending');

  via.write(0x0D, 0x04);                 // ack bit 2
  assert((via.ifr & 0x80) === 0, 'IFR bit 7 cleared when no enabled flag pending');
}

function specDisablingIerKeepsIfrFlag() {
  console.log('Spec[6522]: disabling a source via IER does not clear its IFR bit...');
  const via = new VIA6522('TestVIA');
  via.write(0x0E, 0x80 | 0x04);
  via.triggerIrq(2);
  assert((via.ifr & 0x04) !== 0, 'IFR bit 2 set');

  via.write(0x0E, 0x00 | 0x04);          // disable bit 2
  assert((via.ifr & 0x04) !== 0, 'IFR bit 2 still set after disable');
  assert((via.ifr & 0x80) === 0, 'IRQ summary cleared because no enabled flag');
}

function specT1LWritesDoNotStartTimer() {
  console.log('Spec[6522]: writing T1L latches (regs 4 / 6 / 7) does NOT start T1...');
  const via = new VIA6522('TestVIA');
  via.write(0x0E, 0x80 | 0x40);          // enable T1
  let irqs = 0;
  via.irqHandler = (p) => { if (p) irqs++; };

  via.write(0x04, 0x05);                 // T1L-L only
  for (let i = 0; i < 1000; i++) via.clock(1);
  assert(irqs === 0, 'T1L-L write does not start timer');

  via.write(0x06, 0x05);                 // alternate T1L-L access
  for (let i = 0; i < 1000; i++) via.clock(1);
  assert(irqs === 0, 'reg 6 (T1L-L alt) does not start timer');

  via.write(0x07, 0x00);                 // T1L-H alt — also no start
  for (let i = 0; i < 1000; i++) via.clock(1);
  assert(irqs === 0, 'reg 7 (T1L-H alt) does not start timer');

  // Now T1C-H (reg 5) MUST start it.
  via.write(0x05, 0x00);
  for (let i = 0; i < 100; i++) via.clock(1);
  assert(irqs > 0, 'T1C-H write starts the timer');
}

function specT1LHClearsT1Ifr() {
  console.log('Spec[6522]: writing T1L-H (reg 7) clears the T1 IFR flag...');
  const via = new VIA6522('TestVIA');
  via.triggerIrq(6);
  assert((via.ifr & 0x40) !== 0, 'T1 IFR set');
  via.write(0x07, 0x00);
  assert((via.ifr & 0x40) === 0, 'T1L-H write clears T1 IFR per datasheet');
}

function specT1ChStartLoadAndAck() {
  console.log('Spec[6522]: T1C-H write loads counter, clears IFR, starts timer...');
  const via = new VIA6522('TestVIA');
  via.triggerIrq(6);                     // pre-raise the flag
  via.write(0x04, 0x10);                 // T1L-L = 16
  via.write(0x05, 0x00);                 // T1C-H = 0 → load + start + ack
  assert((via.ifr & 0x40) === 0, 'T1 IFR cleared by T1C-H write');
  // Counter should now hold (close to) latch value.
  const t1 = via.read(0x05) << 8 | via.read(0x04);
  assert(t1 >= 16 - 2 && t1 <= 17, `T1 counter loaded (~16, got ${t1})`);
}

function specReadT1ClAndT2ClAckIfr() {
  console.log('Spec[6522]: reading T1C-L acks T1 IFR; reading T2C-L acks T2 IFR...');
  const via = new VIA6522('TestVIA');
  via.triggerIrq(6);
  via.triggerIrq(5);
  via.read(0x04);
  assert((via.ifr & 0x40) === 0, 'T1 IFR cleared by T1C-L read');
  assert((via.ifr & 0x20) !== 0, 'T2 IFR untouched by T1C-L read');
  via.read(0x08);
  assert((via.ifr & 0x20) === 0, 'T2 IFR cleared by T2C-L read');
}

function specReadIraNoHandshake() {
  console.log('Spec[6522]: reading IRA via reg $F does NOT clear CA1/CA2 IFR...');
  const via = new VIA6522('TestVIA');
  via.triggerIrq(0);                     // CA2
  via.triggerIrq(1);                     // CA1
  via.read(0x0F);                        // "no handshake" read
  assert((via.ifr & 0x03) === 0x03, 'CA1+CA2 IFR untouched by reg $F read');

  via.read(0x01);                        // handshake read
  assert((via.ifr & 0x03) === 0, 'CA1+CA2 IFR cleared by reg $1 read');
}

function specReadIrbClearsCbFlags() {
  console.log('Spec[6522]: reading IRB ($0) clears CB1+CB2 IFR...');
  const via = new VIA6522('TestVIA');
  via.triggerIrq(3);                     // CB2
  via.triggerIrq(4);                     // CB1
  via.read(0x00);
  assert((via.ifr & 0x18) === 0, 'CB1+CB2 IFR cleared by IRB read');
}

function specT1FreeRunReloadsFromCurrentLatch() {
  console.log('Spec[6522]: T1 free-run reloads from CURRENT latch (changes mid-flight)...');
  const via = new VIA6522('TestVIA');
  via.write(0x0B, 0x40);                 // ACR: T1 free-run
  via.write(0x0E, 0x80 | 0x40);          // enable T1
  let irqs = 0;
  via.irqHandler = (p) => { if (p) { irqs++; via.write(0x0D, 0x40); } };

  via.write(0x04, 0x07); via.write(0x05, 0x00);   // start with T1L=7
  for (let i = 0; i < 64; i++) via.clock(1);     // accumulate IRQs
  const beforeChange = irqs;

  // Now bump the latch to a much larger N — future periods must be longer.
  via.write(0x06, 0xFF); via.write(0x07, 0x00);  // T1L = 255 (reload only)
  irqs = 0;
  for (let i = 0; i < 64; i++) via.clock(1);
  assert(irqs < beforeChange,
    `Larger latch slows IRQ rate (was ${beforeChange}/64 → got ${irqs}/64)`);
}

function specT2OneShotOnly() {
  console.log('Spec[6522]: T2 in PHI2 mode is one-shot — does not auto-reload...');
  const via = new VIA6522('TestVIA');
  via.write(0x0B, 0x00);                 // ACR: T2 PHI2
  via.write(0x0E, 0x80 | 0x20);
  let irqs = 0;
  via.irqHandler = (p) => { if (p) { irqs++; via.write(0x0D, 0x20); } };

  via.write(0x08, 0x05); via.write(0x09, 0x00);  // T2 = 5
  for (let i = 0; i < 1000; i++) via.clock(1);
  assert(irqs === 1, `T2 fires exactly once even over 1000 cycles (got ${irqs})`);
}

function specDdrControlsReadback() {
  console.log('Spec[6522]: DDR=0 bits read pin state; DDR=1 bits read output latch...');
  const via = new VIA6522('TestVIA');
  via.pinsB = 0xF0;                      // pin state $F0
  via.write(0x02, 0x0F);                 // DDRB: bits 0..3 output, 4..7 input
  via.write(0x00, 0x05);                 // ORB = $05 (bits 0..3 = 5)

  via.readPortB = () => via.pinsB;
  const v = via.read(0x00);
  // Bits 0..3 are outputs → latch ($05). Bits 4..7 are inputs → pin ($F0).
  assert((v & 0x0F) === 0x05, `output bits read latch (got $${(v & 0x0F).toString(16)})`);
  assert((v & 0xF0) === 0xF0, `input bits read pin state (got $${(v & 0xF0).toString(16)})`);
}

// ── 1541 hardware reference (Commodore service manual §3) ────────────────────

function spec1541Via1Mirrored() {
  console.log('Spec[1541]: VIA1 mirrors every 16 bytes through $1800-$1BFF...');
  const drive = buildDrive();
  drive.write(0x1802, 0xFF);             // DDRB all output
  drive.write(0x1800, 0x55);
  for (const addr of [0x1800, 0x1810, 0x1820, 0x18F0, 0x1A00, 0x1BF0]) {
    assert(drive.read(addr) === 0x55, `VIA1 mirror at $${addr.toString(16)}`);
  }
}

function spec1541Via2Mirrored() {
  console.log('Spec[1541]: VIA2 mirrors every 16 bytes through $1C00-$1FFF...');
  const drive = buildDrive();
  drive.write(0x1C02, 0xFF);
  drive.write(0x1C00, 0xAA);
  for (const addr of [0x1C00, 0x1C10, 0x1CF0, 0x1D00, 0x1FF0]) {
    assert(drive.read(addr) === 0xAA, `VIA2 mirror at $${addr.toString(16)}`);
  }
}

function spec1541RamMirroredEvery2K() {
  console.log('Spec[1541]: 2KB RAM mirrors at $0800, $1000 (incomplete decode)...');
  const drive = buildDrive();
  drive.write(0x07FF, 0x77);
  assert(drive.read(0x0FFF) === 0x77, 'mirror at $0FFF');
  assert(drive.read(0x17FF) === 0x77, 'mirror at $17FF');
  drive.write(0x1234, 0x99);
  assert(drive.read(0x0234) === 0x99, 'mirror back to $0234');
}

// ── CBM disk format (1541 user guide / inside Commodore DOS) ─────────────────

function specSectorsPerTrack() {
  console.log('Spec[CBM]: sectors-per-track follows zone schedule 21/19/18/17...');
  // Zone 0: tracks 1..17 → 21 sectors
  for (const t of [1, 5, 17]) assert(SPT(t) === 21, `track ${t} → 21 sectors`);
  // Zone 1: tracks 18..24 → 19 sectors
  for (const t of [18, 21, 24]) assert(SPT(t) === 19, `track ${t} → 19 sectors`);
  // Zone 2: tracks 25..30 → 18 sectors
  for (const t of [25, 28, 30]) assert(SPT(t) === 18, `track ${t} → 18 sectors`);
  // Zone 3: tracks 31..35 → 17 sectors
  for (const t of [31, 33, 35]) assert(SPT(t) === 17, `track ${t} → 17 sectors`);
}

function specCyclesPerByte() {
  // Indexed by VIA2 PB5/PB6 density bits 00..11 (0..3). Real 1541:
  //   density 00 = innermost tracks 31-35 = 32 cyc/byte (slowest)
  //   density 11 = outermost tracks 1-17  = 26 cyc/byte (fastest)
  console.log('Spec[1541]: GCR cycles-per-byte indexed by VIA2 density bits...');
  assert(CYCLES_PER_BYTE.length === 4, 'four density values defined');
  assert(CYCLES_PER_BYTE[0] === 32, 'density 0 (innermost) = 32 cyc/byte');
  assert(CYCLES_PER_BYTE[1] === 30, 'density 1 = 30 cyc/byte');
  assert(CYCLES_PER_BYTE[2] === 28, 'density 2 = 28 cyc/byte');
  assert(CYCLES_PER_BYTE[3] === 26, 'density 3 (outermost) = 26 cyc/byte');
}

function specTotalSectorsOnStandardDisk() {
  console.log('Spec[CBM]: 35-track disk holds 683 sectors (174 848 bytes)...');
  let total = 0;
  for (let t = 1; t <= 35; t++) total += SPT(t);
  assert(total === 683, `683 sectors total (got ${total})`);
}

// ── IEC bus protocol (CBM serial spec) ───────────────────────────────────────

function specIecLinesActiveLow() {
  console.log('Spec[IEC]: lines are active-low (0=asserted, 1=released)...');
  const drive = buildDrive();
  drive.write(0x1802, 0xFF);

  // Drive releases everything → outputs should read as 1 (released).
  drive.write(0x1800, 0x00);
  assert(drive.iecData === 1, 'DATA released = 1');
  assert(drive.iecClk === 1, 'CLK released = 1');
}

function specIecWiredAndForData() {
  console.log('Spec[IEC]: DATA is wired-AND of all devices — drive can pull low alone...');
  const drive = buildDrive();
  drive.write(0x1802, 0xFF);

  // C64 releases its DATA (high). Drive pulls low via PB1.
  drive.setIecLines(1, 1, 1);
  drive.write(0x1800, 0x02);             // PB1=1 → manual DATA OUT asserted
  assert(drive.iecData === 0, 'drive alone can pull DATA low');

  // Drive releases too — now line should be released.
  drive.write(0x1800, 0x00);
  assert(drive.iecData === 1, 'all-released DATA = high (wired-AND)');
}

function specIecAtnAcknowledge() {
  console.log('Spec[IEC]: drive must auto-pull DATA low while ATN asserted (handshake)...');
  const drive = buildDrive();
  drive.write(0x1802, 0xFF);
  // ATNA pin = 1 (PB4=0 in register, since code inverts) — the "transparent" position.
  drive.write(0x1800, 0x00);

  drive.setIecLines(0, 1, 1);            // C64 asserts ATN
  assert(drive.iecData === 0,
    'spec: ATN asserted → drive ATN-acknowledge pulls DATA low automatically');

  drive.setIecLines(1, 1, 1);            // ATN released
  assert(drive.iecData === 1, 'ATN released → drive releases DATA again');
}

function specIecDataInDoesNotAffectDataOut() {
  console.log('Spec[IEC]: drive\'s DATA-IN is independent of its DATA-OUT...');
  const drive = buildDrive();
  drive.write(0x1802, 0xFF);
  drive.write(0x1800, 0x00);             // drive releases DATA
  assert(drive.iecData === 1, 'drive DATA-OUT released');

  drive.setIecLines(1, 1, 0);            // C64 pulls DATA low — drive's OUT must be unaffected
  assert(drive.iecData === 1, 'C64 pulling DATA low does not change drive\'s DATA-OUT');
  // But the input side reflects the bus state — visible via VIA1 PB0.
  drive.write(0x1802, 0x00);             // DDRB=0 to read pins
  const pb = drive.read(0x1800);
  assert((pb & 0x01) !== 0, 'PB0 (DATA-IN, 7406-inverted) reflects bus low');
}

// ── Helper used by the spec block (avoid pulling in d64 module) ──────────────
function SPT(track) {
  if (track >= 1 && track <= 17) return 21;
  if (track >= 18 && track <= 24) return 19;
  if (track >= 25 && track <= 30) return 18;
  if (track >= 31 && track <= 40) return 17;
  return 0;
}

function testResetPreservesDiskClearsState() {
  console.log('Testing reset() preserves mounted disk but clears mechanics...');
  const drive = buildDrive();
  drive.setDisk({ readSector: () => new Uint8Array(256) });
  drive.motorOn = true;
  drive.currentHalfTrack = 50;
  drive.ram[0x100] = 0xAB;

  drive.reset();
  assert(drive.gcrDisk !== null, 'Disk preserved across reset');
  assert(drive.motorOn === false, 'Motor cleared by reset');
  assert(drive.currentHalfTrack === 36, 'Half-track reset to 36 (track 18, VICE reset position)');
  assert(drive.ram[0x100] === 0, 'RAM zeroed by reset');
  assert(drive.writeProtected === true, 'WP re-asserted on reset (disk present)');
}

// Run all tests
try {
  testMemoryMap();
  testIecBusLogic();
  testDriveMechanics();
  testGcrReading();
  testCpuReset();

  // Cycle-accurate suite
  testT1OneShotCycleAccuracy();
  testT2OneShotCycleAccuracy();
  testT1FreeRunMultiPeriod();
  testT1ReadClearsIrqButTimerKeepsRunning();
  testGcrCyclesPerByteAllZones();
  testSpeedZoneChangeMidStream();
  testMotorOffHaltsSpindle();
  testStepperOneHalfTrackPerPhaseChange();
  testStepperReverseDirection();
  testStepperClampsAtTrack1();
  testStepperClampsAtTrack42();
  testStepperWorksWithoutActiveJob();
  testSyncRequiresExactly10Ones();
  testFirstZeroAfterSyncStartsByteFraming();
  testAtnFallingEdgeTriggersCA1Irq();
  testIrqFromBothVias();
  testZoneForTrackBoundaries();
  testClockAdvancesTotalCyclesPerInstruction();
  testResetPreservesDiskClearsState();

  // Spec-based suite (datasheet / protocol)
  specIfrWriteIsOneToClear();
  specIerReadAlwaysReturnsBit7Set();
  specIerSetClearSemantics();
  specIfrBit7ReflectsEnabledPending();
  specDisablingIerKeepsIfrFlag();
  specT1LWritesDoNotStartTimer();
  specT1LHClearsT1Ifr();
  specT1ChStartLoadAndAck();
  specReadT1ClAndT2ClAckIfr();
  specReadIraNoHandshake();
  specReadIrbClearsCbFlags();
  specT1FreeRunReloadsFromCurrentLatch();
  specT2OneShotOnly();
  specDdrControlsReadback();
  spec1541Via1Mirrored();
  spec1541Via2Mirrored();
  spec1541RamMirroredEvery2K();
  specSectorsPerTrack();
  specCyclesPerByte();
  specTotalSectorsOnStandardDisk();
  specIecLinesActiveLow();
  specIecWiredAndForData();
  specIecAtnAcknowledge();
  specIecDataInDoesNotAffectDataOut();

  console.log('\nAll 1541 Unit Tests PASSED!');
} catch (e) {
  console.error('\nTest suite failed with error:');
  console.error(e);
  process.exit(1);
}
