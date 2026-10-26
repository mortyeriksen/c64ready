// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const WAVEFORMS = [[16,'Triangle'],[32,'Saw'],[64,'Pulse'],[128,'Noise']];
export function sidVoice(registers, base) {
  const frequency = registers[base] | registers[base+1] << 8;
  return { frequency, hz: frequency * 985248 / 16777216,
    pulse: registers[base+2] | (registers[base+3]&15)<<8, control: registers[base+4],
    adsr: [registers[base+5]>>>4, registers[base+5]&15, registers[base+6]>>>4, registers[base+6]&15] };
}
export function voiceDescription(registers, chip, voice) {
  const base=chip*32, value=sidVoice(registers,base+voice*7);
  const waves=WAVEFORMS.filter(([bit])=>value.control&bit).map(([,name])=>name);
  const tonal=waves.length===1 && !(value.control&142) && value.frequency>0;
  const midi=tonal?Math.round(69+12*Math.log2(value.hz/440)):null;
  const note=midi===null?'':`${['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][((midi%12)+12)%12]}${Math.floor(midi/12)-1}`;
  const routed=!!(registers[base+23]&(1<<voice));
  const modes=registers[base+24];
  const route=routed?(modes&112?'Filter':'Filter · no output mode'):voice===2 && modes&128?'Bypass muted':'Bypass';
  return {...value,waves,wave:waves.join(' + ')||'No waveform',note,route,routed,
    gate:!!(value.control&1),pulsePercent:100*value.pulse/4096};
}
export function filterDescription(registers,chip) {
  const mode=registers[chip*32+24];
  const parts=[[16,'Low-pass keeps lower frequencies'],[32,'Band-pass keeps a band around cutoff'],[64,'High-pass keeps higher frequencies']].filter(([bit])=>mode&bit).map(([,text])=>text);
  return parts.join('. ')||'No filter output mode selected. Routed voices have no filter output.';
}
// A schematic of the four settings, not an envelope trace or a linear time scale.
export function envelopePoints(adsr) {
  const sustain=38-(adsr[2]/15)*32;
  return `0,38 24,6 48,${sustain} 76,${sustain} 100,38`;
}
