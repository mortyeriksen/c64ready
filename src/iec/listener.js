// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Standard serial receive helper. Physical levels are 1 released, 0 asserted.
// ATN commands are received by every device. Data bytes are accepted only by
// addressed listeners. EOI is a >=200 us delay, acknowledged for >=60 us.
export function createIecListener(port, callbacks = {}) {
  const WAIT_READY = 0, WAIT_START = 1, BITS = 2, END = 3, ACK = 4, EOI = 5, BLOCKED = 6, ATN_CLOCK = 7;
  let phase = WAIT_READY, lines = port.lines(), attention = !(lines & 4);
  let listening = false, channel = 0, kind = 'data', value = 0, bits = 0, eoi = false, due = 0;
  const timeout = Math.ceil(port.cyclesPerSecond * 200e-6);
  const hold = Math.ceil(port.cyclesPerSecond * 60e-6);
  if (attention && (lines & 2)) phase = ATN_CLOCK;
  const drive = level => port.drive(1, level);
  const cancel = () => { due = 0; port.cancelWake(); };
  const active = () => attention || listening;
  function command(byte) {
    if (byte === 0x3F) { listening = false; callbacks.onUnlisten?.(); }
    else if ((byte & 0xE0) === 0x20 && (byte & 31) === port.address) listening = true;
    else if ((byte & 0xE0) === 0x40 && (byte & 31) === port.address) listening = false;
    else if (listening && (byte & 0xE0) === 0x60) { channel = byte & 31; kind = 'data'; callbacks.onListen?.(channel); }
    else if (listening && (byte & 0xF0) === 0xF0) { channel = byte & 15; kind = 'open'; callbacks.onOpen?.(channel); }
    else if (listening && (byte & 0xF0) === 0xE0) { channel = byte & 15; kind = 'close'; callbacks.onClose?.(channel); }
    callbacks.onCommand?.(byte);
  }
  function accept() {
    if (attention) command(value);
    else if (callbacks.onByte?.(value, channel, eoi, kind) === false) { phase = BLOCKED; drive(1); return; }
    phase = ACK; drive(0);
  }
  function beginReady() {
    drive(1); phase = WAIT_START; value = 0; bits = 0; eoi = false;
    if (!attention) { due = port.now() + timeout; port.wakeAt(due); }
  }
  function reset() {
    cancel(); listening = false; value = bits = 0; eoi = false;
    lines = port.lines(); attention = !(lines & 4);
    phase = attention && (lines & 2) ? ATN_CLOCK : WAIT_READY;
    drive(attention ? 0 : 1);
  }
  drive(attention ? 0 : 1);
  return {
    onLines(next) {
      const old = lines; lines = next;
      const atn = !(next & 4), clk = !!(next & 2), oldClk = !!(old & 2);
      if (atn !== attention) {
        attention = atn; cancel(); value = bits = 0; eoi = false;
        phase = atn && clk ? ATN_CLOCK : WAIT_READY;
        drive(active() ? 0 : 1);
        return;
      }
      if (!active()) { drive(1); return; }
      // ATN acknowledges on DATA before the talker's initial CLK fall.
      if (phase === ATN_CLOCK) { if (!clk) phase = WAIT_READY; return; }
      if (phase === WAIT_READY || phase === ACK) {
        if (clk) beginReady();
      } else if (phase === WAIT_START && !clk) {
        cancel(); phase = BITS;
      } else if (phase === BITS && clk && !oldClk) {
        if (next & 1) value |= 1 << bits;
        if (++bits === 8) phase = END;
      } else if (phase === END && !clk && oldClk) accept();
    },
    onTimer() {
      if (!due || port.now() < due) return;
      due = 0;
      if (phase === WAIT_START && !attention && (lines & 2)) {
        eoi = true; phase = EOI; drive(0); due = port.now() + hold; port.wakeAt(due);
      } else if (phase === EOI) { drive(1); phase = WAIT_START; }
    },
    resume() { if (phase === BLOCKED) accept(); },
    reset,
    detach() { cancel(); drive(1); },
    serialize: () => ({ phase, lines, attention, listening, channel, kind, value, bits, eoi, remaining: Math.max(0, due - port.now()) }),
    deserialize(s) {
      reset();
      if (!s) return;
      phase = s.phase; lines = s.lines; attention = !!s.attention; listening = !!s.listening;
      channel = s.channel & 31; kind = s.kind; value = s.value & 255; bits = s.bits | 0; eoi = !!s.eoi;
      if (s.remaining > 0) { due = port.now() + s.remaining; port.wakeAt(due); }
      drive(phase === ACK || phase === EOI || phase === ATN_CLOCK || (phase === WAIT_READY && active()) ? 0 : 1);
    },
  };
}
