// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
export const meta = { id: 'example.iec-monitor', name: 'IEC Monitor', version: '1.0.0', bus: 'iec',
  apiVersion: 1, address: 5, author: 'C64 READY.', description: 'Receives standard IEC bytes and shows a bounded text log. A standalone device example.' };
export function create(port, host) {
  const bytes = new Uint8Array(4096); let length = 0, displayed = -1;
  const serial = port.createListener({ onByte(byte, channel, eoi, kind) { if (kind === 'data' && length < bytes.length) bytes[length++] = byte; } });
  let output = null;
  if (host?.panel) {
    output = host.panel.ownerDocument.createElement('pre');
    host.panel.adoptedStyleSheets = [host.css('pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; margin: 6px 0; }')];
    host.panel.append(output);
  }
  host?.onFrame?.(() => {
    if (displayed === length) return; displayed = length;
    if (output) output.textContent = String.fromCharCode(...bytes.subarray(0, length)).replace(/\r/g, '\n');
    host.status?.(`IEC ${port.address}: ${length} bytes received`);
  });
  return { onLines: serial.onLines, onTimer: serial.onTimer, reset: serial.reset, detach: serial.detach,
    serialize: () => ({ bytes: Array.from(bytes.subarray(0, length)), serial: serial.serialize() }),
    deserialize(state) { length = 0; if (Array.isArray(state?.bytes)) { length = Math.min(bytes.length, state.bytes.length); bytes.set(state.bytes.slice(0, length)); } serial.deserialize(state?.serial); displayed = -1; } };
}
