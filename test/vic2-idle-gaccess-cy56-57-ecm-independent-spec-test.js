// VIC-II: cycles 56/57 idle accesses are ECM-INDEPENDENT ($3FFF), while the
// cy16-55 idle g-accesses follow the ECM bit ($39FF when ECM=1).
//
// Bauer §3.6.3 (timing of a raster line): after the 40 g-accesses (cycles
// 16-55) and before sprite 0's p-access (cycle 58), the VIC performs two pure
// DRAM idle accesses in cycles 56 and 57. Those access $3FFF UNCONDITIONALLY.
// A real g-access, by contrast, has address bits 9 and 10 forced low when
// ECM=1 (Bauer §3.7.3 / §3.7.3.9 idle state) and therefore reads $39FF. So
// with ECM set, cy16-55 idle g-accesses must read $39FF while cy56/57 must
// STILL read $3FFF.
//
// The existing vic2-open-bus-idle-gaccess-gate test pins cy56/57=$3FFF only
// for the default ECM=0 case, so it cannot catch a regression that "unifies"
// the idle-byte source and makes cy56/57 follow ECM. This test adds the
// discriminating ECM=1 case.
//
// Observable: the shared external (open) data bus the VIC drives during phi1
// (`vic.memory.externalDataBus8`) — exactly what testprogs/VICII/phi1timing
// measures. The bus drive in _captureCycleState (the cy16-55 g-access drive
// and the explicit cy56/57 $3FFF drive) runs before the canvas-visibility
// gate, so a non-visible raster isolates it from the renderer snapshot path.

import { makeVic, assert } from './_vic2-helpers.js';

// Distinct sentinels so a wrong source address is unambiguous in a failure.
const NON_ECM = 0xAA;   // $3FFF content (bank 0)
const ECM_SRC = 0x55;   // $39FF content (bank 0)
const POISON  = 0x11;   // pre-set on the bus, to prove the access drives it

function makeBusVic() {
  const vic = makeVic();
  vic.memory = { externalDataBus8: 0x00 };
  vic.raster = 300;          // vblank line (canvasY >= CANVAS_H): _captureCycleState
                             // early-returns right after the phi1 bus drive.
  vic._vspGlitchGCycle = -1; // disable the VSP idle-glitch source override
  return vic;
}

function setEcm(vic, on) { vic.regs[0x11] = on ? 0x40 : 0x00; }

function drive(vic, cycle) {
  vic.memory.externalDataBus8 = POISON;
  vic._captureCycleState(cycle);
  return vic.memory.externalDataBus8 & 0xFF;
}

// ── _readIdleGByte address selection (Bauer §3.7.3.9 idle state) ─────────────
{
  const vic = makeBusVic();
  vic.ram[0x3FFF] = NON_ECM;
  vic.ram[0x39FF] = ECM_SRC;

  setEcm(vic, false);
  assert(vic._readIdleGByte(vic.regs, 0x0000, false) === NON_ECM,
    '§3.7.3.9: idle g-access source is $3FFF when ECM=0');

  setEcm(vic, true);
  assert(vic._readIdleGByte(vic.regs, 0x0000, false) === ECM_SRC,
    '§3.7.3.9: idle g-access source is $39FF when ECM=1 (address bits 9+10 forced low)');
  console.log('ok  - idle g-access source follows ECM ($3FFF / $39FF)');
}

// ── g-access window (cy16-55) follows ECM on the open bus (Bauer §3.6.3) ─────
{
  const vic = makeBusVic();
  vic.ram[0x3FFF] = NON_ECM;
  vic.ram[0x39FF] = ECM_SRC;

  setEcm(vic, false);
  assert(drive(vic, 30) === NON_ECM, '§3.6.3: cy30 idle g-access drives $3FFF when ECM=0');
  assert(drive(vic, 55) === NON_ECM, '§3.6.3: cy55 (last g-access) drives $3FFF when ECM=0');

  setEcm(vic, true);
  assert(drive(vic, 30) === ECM_SRC, '§3.6.3: cy30 idle g-access drives $39FF when ECM=1');
  assert(drive(vic, 55) === ECM_SRC, '§3.6.3: cy55 (last g-access) drives $39FF when ECM=1');
  console.log('ok  - cy16-55 idle g-accesses follow ECM on the open bus');
}

// ── cy56/57 are ECM-INDEPENDENT idle accesses to $3FFF (Bauer §3.6.3) ────────
{
  const vic = makeBusVic();
  vic.ram[0x3FFF] = NON_ECM;
  vic.ram[0x39FF] = ECM_SRC;

  setEcm(vic, false);
  assert(drive(vic, 56) === NON_ECM, '§3.6.3: cy56 idle access drives $3FFF (ECM=0)');
  assert(drive(vic, 57) === NON_ECM, '§3.6.3: cy57 idle access drives $3FFF (ECM=0)');

  setEcm(vic, true);
  assert(drive(vic, 56) === NON_ECM,
    '§3.6.3: cy56 idle access STILL drives $3FFF when ECM=1 (NOT $39FF) — ECM-independent');
  assert(drive(vic, 57) === NON_ECM,
    '§3.6.3: cy57 idle access STILL drives $3FFF when ECM=1 (NOT $39FF) — ECM-independent');
  console.log('ok  - cy56/57 idle accesses are ECM-independent ($3FFF, not $39FF)');
}

// ── bank-relative AND ECM-independent (Bauer §3.6.3; addr = bank+(a & $3FFF)) ─
{
  const vic = makeBusVic();
  vic.currentVicBank = 0x4000;
  vic.ram[0x7FFF] = 0xC3;   // bank $4000 view of $3FFF
  vic.ram[0x79FF] = 0x3C;   // bank $4000 view of $39FF
  setEcm(vic, true);

  assert(drive(vic, 30) === 0x3C,
    '§3.6.3: cy30 g-access is bank-relative + ECM-aware ($39FF in bank $4000 = $79FF)');
  assert(drive(vic, 56) === 0xC3,
    '§3.6.3: cy56 idle is bank-relative + ECM-independent ($3FFF in bank $4000 = $7FFF)');
  console.log('ok  - idle source is bank-relative; cy56/57 stay $3FFF-relative under ECM');
}

console.log('\nAll cy56/57 ECM-independent idle-access (Bauer §3.6.3) tests passed.');
