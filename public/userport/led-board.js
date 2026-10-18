// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// LED board: a user port device plugin (user port device API version 1).
//
// Eight LEDs and eight switches on PB0-PB7. An LED is wired from +5V to its
// pin, so it lights when the line is low. A closed switch pulls its line low,
// which the C64 reads at $DD01 (56577) while that pin is an input.
//
//   POKE 56579,255 : POKE 56577,170     LEDs show 01010101 (lit = 0)
//   POKE 56579,0 : PRINT PEEK(56577)    read the switches

export const meta = {
  id: 'example.led-board',
  name: 'LED board',
  version: '1.0.0',
  apiVersion: 1,
  author: 'C64 READY.',
  description: 'Eight LEDs and eight switches on PB0-PB7. POKE 56579,255 then POKE 56577 to light the LEDs, PEEK(56577) to read the switches.',
};

export function create(port, host) {
  let c64 = port.c64PB();      // what the C64 drives (inputs float high)
  let switches = 0;            // bit set = switch closed = line pulled low

  const pins = () => c64 & ~switches & 0xFF;
  const apply = () => port.drivePB(switches, 0);

  let leds = null, buttons = null, shown = -1;
  const syncButtons = () => {
    if (buttons) for (let bit = 0; bit < 8; bit++) buttons[bit].classList.toggle('closed', ((switches >> bit) & 1) === 1);
  };
  if (host && host.panel) {
    host.panel.adoptedStyleSheets = [host.css(`
      .board { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; text-align: center; }
      .led { width: 14px; height: 14px; margin: 0 auto 3px; border-radius: 50%; background: #3a1414; }
      .led.on { background: #ff3b2f; box-shadow: 0 0 8px #ff3b2f; }
      button { font: inherit; font-size: 0.7em; width: 100%; padding: 2px 0; cursor: pointer;
               background: transparent; color: inherit; border: 1px solid currentColor; border-radius: 3px; opacity: 0.6; }
      button.closed { opacity: 1; background: rgba(255, 255, 255, 0.12); }
    `)];
    const board = document.createElement('div');
    board.className = 'board';
    leds = [];
    buttons = [];
    for (let bit = 7; bit >= 0; bit--) {
      const cell = document.createElement('div');
      const led = document.createElement('div');
      led.className = 'led';
      const sw = document.createElement('button');
      sw.textContent = `PB${bit}`;
      sw.title = `Switch on PB${bit}: closed pulls the line low`;
      sw.addEventListener('click', () => {
        switches ^= 1 << bit;
        syncButtons();
        apply();
      });
      cell.append(led, sw);
      board.append(cell);
      leds[bit] = led;
      buttons[bit] = sw;
    }
    host.panel.append(board);
  }

  if (host && host.onFrame) {
    host.onFrame(() => {
      const v = pins();
      if (v === shown) return;
      shown = v;
      if (leds) for (let bit = 0; bit < 8; bit++) leds[bit].classList.toggle('on', ((v >> bit) & 1) === 0);
      if (host.status) host.status(`PB = $${v.toString(16).padStart(2, '0').toUpperCase()} (${v})`);
    });
  }

  return {
    onPortB(levels) { c64 = levels; },
    // Lets scripts and tests flip switches; the panel buttons do the same.
    setSwitches(mask) { switches = mask & 0xFF; syncButtons(); apply(); },
    get pins() { return pins(); },
    serialize: () => ({ switches }),
    deserialize(s) { switches = s.switches & 0xFF; syncButtons(); apply(); },
  };
}
