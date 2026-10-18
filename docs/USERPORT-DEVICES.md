<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: Write a user port device for C64 READY. as one JavaScript file and install it in your browser: the API, timing rules, trust model and an example. -->

# Writing a user port device

A user port device is one JavaScript file that plugs into the emulated C64's
user port, where programs reach it through CIA2 as on real hardware. The
built-in WiFi modem is one too: export it from **MANAGE** to read a full
device.

## The file

One ES module with two exports, `meta` and `create`. No `import` of other
files: bundle first if your source has several.

```js
export const meta = {
  id: 'yourname.device',   // lowercase letters, digits, dots and dashes
  name: 'My device',
  version: '1.0.0',
  apiVersion: 2,           // the API version below
  author: 'Your name',
  description: 'One line for the install dialog.',
};

export function create(port, host) {
  return { /* callbacks, all optional */ };
}
```

`create` runs every time the device is plugged in: on power-on, after a reset
of the machine and after loading a save state. Version 1 devices still run.
Version 2 added the serial lines.

## The port

`port` is the connector, in emulated time. Levels are TTL at the pins, 1 is
high. Every line has a pull-up, and a line is low when either side pulls it
low.

| Member | What it does |
| --- | --- |
| `port.cyclesPerSecond` | 985248, the PAL clock |
| `port.now()` | the current machine cycle |
| `port.drivePB(mask, levels)` | drive the PB lines in `mask` to `levels`, release the rest |
| `port.setFlag(level)` | drive FLAG2 (pin B). A falling edge sets CIA2 ICR bit 4, an NMI when enabled |
| `port.wakeAt(cycle)` | call `onTimer` at that cycle. One timer, a new call replaces it |
| `port.cancelWake()` | drop the timer |
| `port.c64PB()` | PB0-PB7 as the C64 drives them (inputs read high). PB6 and PB7 include the CIA timer outputs when on |
| `port.c64PA2()` | PA2 (pin M) as the C64 drives it |
| `port.driveSerial(mask, levels)` | drive the serial lines in `mask` to `levels`, release the rest: SP1 (pin 5) 1, CNT1 (pin 4) 2, SP2 (pin 7) 4, CNT2 (pin 6) 8 |
| `port.c64Serial()` | those four lines as the CIAs drive them, same bits |

Callbacks the device can return:

| Callback | When |
| --- | --- |
| `onPortB(levels)` | the C64 changed what it drives on PB0-PB7 |
| `onPA2(level)` | the C64 changed PA2 |
| `onSerial(lines)` | a CIA changed what it drives on SP or CNT, as in `c64Serial()` |
| `onPC2()` | PC2 (pin 8) pulses low: the cycle after a CPU read or write of `$DD01` |
| `onTimer(cycle)` | a `wakeAt` time arrived |
| `reset()` | the C64 was reset. The device keeps its own state |
| `detach()` | unplugged, uninstalled or powered off |
| `serialize()`, `deserialize(state)` | save states. Plain JSON only |

## The host

`host` is the app around the device, in real time.

| Member | What it does |
| --- | --- |
| `host.panel` | a ShadowRoot in the User Port card for the device's own controls. `null` in the CLI |
| `host.css(text)` | a stylesheet for `host.panel.adoptedStyleSheets` |
| `host.onFrame(fn)` | call `fn` once per displayed frame. The place to update the page |
| `host.status(text)` | the status line under the device |
| `host.storage.get(key)`, `.set(key, value)` | settings kept in this browser, JSON values |
| `host.openSocket(host, port)` | a TCP connection through the relay (see below) |
| `host.log(...args)` | console output with the device id in front |

`openSocket` returns an object with `send(bytes)` and `close()`. Set its
`onopen`, `ondata(bytes)` and `onclose(reason)` right after the call. The host
name `echo` gives a loopback connection that sends back what it gets, for
testing without a network.

## Timing rules

- Port callbacks run inside an emulated cycle. Keep them short, avoid
  creating objects, and never touch the page from them. Update the page in
  `onFrame`.
- Network data and clicks arrive between frames. Queue them and feed them to
  the C64 in emulated time with `wakeAt`.
- Pace anything the C64 sees with `port.now()`, not with the wall clock.
- If a callback throws, the device is unplugged and the error shows in the
  card. The C64 keeps running.

## Installing and trust

Users install devices from the User Port card
([how](GUIDE-MEDIA.md#installing-devices)). The same id again replaces the old
version. Each browser, and each origin, keeps its own list.

Device code has the app's full powers, with no sandbox: the C64 reads a pin
mid-cycle, and only code running alongside it can answer in time. The install
dialog lists what the code appears to do that could harm the user: network
access, storage, keyboard or clipboard listeners, run-time code, reaching into
the emulator, service workers, navigation, disguised code, changes outside the
panel, workers and device APIs. Use `host.openSocket` and `host.storage` and a
device passes clean. `c64rdy serve --device` prints the same check. Publish your
file's SHA-256 so users can compare it. `?USERPORT_SAFE=1` starts the app with
no device code loaded.

## Networking

`openSocket` goes through the relay set in the User Port card, which
`c64rdy serve` provides. Any relay of the form
`ws(s)://server/relay/<host>/<port>` works. `c64rdy serve` refuses hosts on
the user's own computer and network unless started with `--allow-local`.

## Developing with the CLI

```sh
c64rdy serve --device ./my-device.js --open
```

Serves the app with your device installed, reloading it on every save.

```sh
c64rdy run program.prg --userport ./my-device.js
```

Runs it headless: same `port`, a `host` with no panel, settings in memory and
direct sockets. Types for editors:
[userport-device.d.ts](/userport/userport-device.d.ts).

## Example: an LED board

Eight LEDs and eight switches on PB0-PB7: `$DD01` (56577) holds the line
levels, `$DD03` (56579) the directions (1 = output). An LED lights when its
line is low. A closed switch pulls its line low.

### Installing it

Switch the User Port on, click **FROM URL…** and enter
`https://c64ready.com/userport/led-board.js` (with `c64rdy serve`:
`http://localhost:6464/userport/led-board.js`). Tick the trust box and click
**INSTALL**. Its LEDs and switches appear in the card, PB7 on the left.

### Lighting the LEDs

Type these one at a time:

```basic
POKE 56579,255
POKE 56577,255
POKE 56577,170
POKE 56577,0
```

1. All lines become outputs. Every LED lights, because the output register is
   0 after power-on.
2. All lines high: all LEDs off.
3. 170 (binary 10101010) lights PB0, PB2, PB4 and PB6.
4. All LEDs on again.

A running light (type `NEW` first, `RUN` after):

```basic
10 POKE 56579,255
20 FOR I=0 TO 7
30 POKE 56577,255-2^I
40 FOR D=1 TO 50:NEXT D
50 NEXT I
60 GOTO 20
```

It runs until RUN/STOP ([KEY MAP](GUIDE-INTERFACE.md#key-map) shows the key).
Until then, anything you type waits.

### Reading the switches

```basic
POKE 56579,0
PRINT PEEK(56577)
```

All lines are inputs, and it prints 255. Close PB0 and PB7 in the card and it
prints 126.

### Both at once

`NEW`, then `RUN`:

```basic
10 POKE 56579,15
20 S=PEEK(56577) AND 240
30 POKE 56577,S/16
40 GOTO 20
```

PB0-PB3 are outputs, PB4-PB7 inputs. Each switch on PB4-PB7 lights the LED four
lines lower, so closing PB4 lights PB0 (and PB4's own LED, as its line is
low).

### The code

The whole device, as shipped:

<!-- example: public/userport/led-board.js -->
```js
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
```
