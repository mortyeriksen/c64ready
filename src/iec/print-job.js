// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
const CAPACITY = 512 * 1024;
const SVG = 'http://www.w3.org/2000/svg';

function encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

function decode(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(CAPACITY / 3) * 4) return new Uint8Array();
  try {
    const s = atob(value);
    return s.length <= CAPACITY ? Uint8Array.from(s, c => c.charCodeAt(0)) : new Uint8Array();
  } catch { return new Uint8Array(); }
}

function renderPages(doc, pages) {
  const style = doc.createElement('style');
  style.textContent = `
    @page { size: letter; margin: 0; }
    body { margin: 0; background: white; color: black; }
    svg { display: block; width: 8.5in; height: 11in; break-after: page; break-inside: avoid; }
    svg:last-child { break-after: auto; }
    svg text { white-space: pre; }`;
  doc.head.append(style);
  for (let n = 0; n < pages.length; n++) {
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 6120 7920');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Printed page ${n + 1}`);
    const group = doc.createElementNS(SVG, 'g');
    group.setAttribute('transform', 'translate(180 180)');
    for (const op of pages[n]) {
      const el = doc.createElementNS(SVG, op.path ? 'path' : 'text');
      if (op.path) el.setAttribute('d', op.path);
      else {
        el.setAttribute('x', op.x); el.setAttribute('y', op.y);
        el.setAttribute('font-family', 'monospace'); el.setAttribute('font-size', '100');
        el.setAttribute('textLength', op.width); el.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        el.textContent = op.text;
      }
      group.append(el);
    }
    svg.append(group); doc.body.append(svg);
  }
}

export function printJob(bytes, decodePages, doc = document, onError = () => {}) {
  const result = decodePages(bytes);
  doc.querySelector('iframe[data-c64ready-print]')?.remove();
  const frame = doc.createElement('iframe');
  frame.dataset.c64readyPrint = '';
  frame.title = 'Printer output';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0';
  frame.addEventListener('load', async () => {
    try {
      const win = frame.contentWindow;
      win.addEventListener('afterprint', () => frame.remove(), { once: true });
      renderPages(win.document, result.pages);
      await win.document.fonts.ready;
      if (frame.isConnected) win.print();
    } catch {
      frame.remove(); onError();
    }
  }, { once: true });
  frame.srcdoc = '<!doctype html><html><head><title>Printer output · C64 READY.</title></head><body></body></html>';
  doc.body.append(frame);
  return result;
}

export function createPrintJob(host, { decodePages, onClear } = {}) {
  const bytes = new Uint8Array(CAPACITY);
  let length = 0, changed = true, activity = false, receivingUntil = 0, shownReceiving = false;
  let saved = -1, lastSave = 0, preview = null, clear = null, ownerWindow = null;
  function save() {
    if (saved === length) return;
    host?.storage?.set('job', encode(bytes.subarray(0, length))); saved = length;
  }
  function restore(state) {
    const data = decode(state?.data);
    bytes.set(data); length = data.length;
    changed = true; activity = false; receivingUntil = 0; saved = -1;
  }
  function clearJob() {
    length = 0; changed = true; activity = false; receivingUntil = 0; saved = -1;
    save(); onClear?.();
  }
  restore({ data: host?.storage?.get('job') });
  if (host?.panel) {
    host.panel.adoptedStyleSheets = [host.css(`
      .controls { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      button { font: inherit; color: inherit; border: 1px solid currentColor;
        background: transparent; border-radius: 4px; padding: 7px 10px; cursor: pointer; }
      .primary { color: var(--accent, inherit); border-color: var(--accent, currentColor);
        background: color-mix(in srgb, var(--accent, currentColor) 14%, var(--control-bg, transparent)); }
      button:enabled:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
      button:focus-visible { outline: 2px solid var(--accent, currentColor); outline-offset: 2px; }
      button:disabled { opacity: .45; cursor: default; }
      p { margin: 8px 0; line-height: 1.5; }
    `)];
    const doc = host.panel.ownerDocument;
    ownerWindow = doc.defaultView;
    ownerWindow.addEventListener('pagehide', save);
    const controls = doc.createElement('div'); controls.className = 'controls';
    preview = doc.createElement('button'); preview.type = 'button'; preview.className = 'primary';
    preview.textContent = 'Preview / Print'; preview.disabled = length === 0;
    preview.title = 'MPS-style seven-pin graphics. Text uses a browser font with approximate character mapping. Opens the browser print dialog for printing or saving as PDF.';
    preview.addEventListener('click', () => {
      save();
      const result = printJob(bytes.subarray(0, length), decodePages, doc,
        () => host.status('Could not open the print dialog. Try Preview / Print again.'));
      if (result.incomplete || result.unsupported || result.limited) {
        host.status([result.incomplete && 'Waiting for more bytes in a printer command.',
          result.unsupported && 'Some printer commands are unsupported.', result.limited && 'Preview limited to 100 pages.'].filter(Boolean).join(' '));
      }
    });
    clear = doc.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear job'; clear.disabled = length === 0;
    clear.addEventListener('click', clearJob);
    controls.append(preview, clear);
    host.panel.append(controls);
  }
  host?.onFrame?.(() => {
    const now = Date.now();
    if (activity) { activity = false; receivingUntil = now + 750; }
    const receiving = length > 0 && now < receivingUntil;
    if (changed || receiving !== shownReceiving) {
      changed = false; shownReceiving = receiving;
      if (preview) preview.disabled = length === 0;
      if (clear) clear.disabled = length === 0;
      const size = length < 1024 ? `${length} ${length === 1 ? 'byte' : 'bytes'}` : `${(length / 1024).toFixed(1)} KB`;
      host?.status?.(length === CAPACITY ? `Job full · ${size} received. Clear job to continue.`
        : receiving ? `Receiving… · ${size}` : `Idle · ${size} received`);
    }
    if (now - lastSave >= 1000 && saved !== length) { save(); lastSave = now; }
  });
  return {
    writeByte(value) {
      if (length === CAPACITY) return false;
      bytes[length++] = value & 255; changed = activity = true; return true;
    },
    clearJob,
    detach() { save(); ownerWindow?.removeEventListener('pagehide', save); },
    serialize: () => ({ data: encode(bytes.subarray(0, length)) }),
    deserialize: restore,
  };
}
