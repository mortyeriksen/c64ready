// Spec test for src/ui/crt-panel.js: the CRT control panel is built from
// CRT_PARAMS (one slider per range, a select per choice), shows every preset,
// writes through its callbacks and owns Escape while open.
import { installMiniDom, fire } from './_mini-dom.js';
import { CRT_PARAMS, CRT_MODES, presetParams } from '../src/crt-params.js';
import { handleEscape, escapeLayerCount, _resetEscapeLayers } from '../src/ui/escape-stack.js';

installMiniDom();
const { createCrtPanel } = await import('../src/ui/crt-panel.js');

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function build({ tunable = true, mode = 'tube', initialPos = null } = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const anchor = document.createElement('div');
  anchor._rect = { left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650 };
  const state = { mode, params: presetParams(mode), set: [], resets: 0, modes: [], closed: 0, saved: [] };
  const panel = createCrtPanel({
    anchor,
    initialPos,
    savePos: (p) => { state.saved.push(p); },
    host,
    getMode: () => state.mode,
    setMode: (m) => { state.modes.push(m); state.mode = m; state.params = presetParams(m); },
    getParams: () => state.params,
    setParam: (k, v) => { state.set.push([k, v]); state.params[k] = v; },
    resetParams: () => { state.resets++; state.params = presetParams(state.mode); },
    tunable,
    onClose: () => { state.closed++; },
  });
  return { host, panel, state };
}

_resetEscapeLayers();
{
  const { host, panel, state } = build();
  expect(panel.el.hidden, 'the panel starts closed');
  expect(host.querySelector('.crt-panel') === panel.el, 'the panel lives in the host it was given');

  const presets = host.querySelectorAll('.crt-panel-preset');
  expect(presets.length === CRT_MODES.length, 'one preset button per CRT mode');
  expect(presets.map(b => b.getAttribute('data-mode')).join() === CRT_MODES.join(), 'presets in cycle order');

  const ranges = host.querySelectorAll('.crt-panel-range');
  const selects = host.querySelectorAll('.crt-panel-select');
  const numeric = CRT_PARAMS.filter(p => !p.options);
  const choices = CRT_PARAMS.filter(p => p.options);
  expect(ranges.length === numeric.length, 'one slider per range parameter');
  expect(selects.length === choices.length, 'one select per choice parameter');
  for (const spec of numeric) {
    const r = host.querySelector(`.crt-panel-range[data-key="${spec.key}"]`);
    expect(r, `${spec.key} has a slider`);
    expect(r.getAttribute('min') === String(spec.min) && r.getAttribute('max') === String(spec.max)
      && r.getAttribute('step') === String(spec.step), `${spec.key} slider carries its control range`);
  }
  for (const spec of choices) {
    const sel = host.querySelector(`.crt-panel-select[data-key="${spec.key}"]`);
    expect(sel && sel.querySelectorAll('option').length === spec.options.length, `${spec.key} select lists every option`);
  }

  panel.open();
  expect(!panel.el.hidden && panel.isOpen(), 'open() shows the panel');
  expect(escapeLayerCount() === 1, 'an open panel claims Escape');
  expect(host.querySelector('.crt-panel-preset[data-mode="tube"]').getAttribute('aria-pressed') === 'true', 'the active preset is pressed');
  expect(host.querySelector('.crt-panel-preset[data-mode="on"]').getAttribute('aria-pressed') === 'false', 'the others are not');
  const depth = host.querySelector('.crt-panel-range[data-key="scanDepth"]');
  expect(depth.value === String(state.params.scanDepth), 'sliders show the current value');
  expect(host.querySelector('.crt-panel-value[data-for="scanDepth"]').textContent === state.params.scanDepth.toFixed(2), 'the value readout is formatted to the step');
  expect(host.querySelector('.crt-panel-value[data-for="maskType"]').textContent === '', 'a choice has no readout: its select names the option');

  depth.value = '0.5';
  fire(depth, 'input', { target: depth });
  expect(state.set.length === 1 && state.set[0][0] === 'scanDepth' && state.set[0][1] === 0.5, 'moving a slider writes a number through setParam');
  expect(host.querySelector('.crt-panel-value[data-for="scanDepth"]').textContent === '0.50', 'the readout follows the slider');

  const sel = host.querySelector('.crt-panel-select[data-key="maskType"]');
  sel.value = '2';
  fire(sel, 'change', { target: sel });
  expect(state.set[1][0] === 'maskType' && state.set[1][1] === 2, 'a select writes its option index');

  const arcade = host.querySelector('.crt-panel-preset[data-mode="arcade"]');
  fire(arcade, 'click', { target: arcade });
  expect(state.modes.join() === 'arcade', 'a preset button switches the mode');
  expect(arcade.getAttribute('aria-pressed') === 'true', 'and the panel reflects it');

  const reset = host.querySelector('.crt-panel-reset');
  fire(reset, 'click', { target: reset });
  expect(state.resets === 1, 'Reset drops the mode overrides');

  const off = host.querySelector('.crt-panel-preset[data-mode="off"]');
  fire(off, 'click', { target: off });
  expect(host.querySelector('.crt-panel-controls').hidden, 'OFF has nothing to tune: the sliders hide');

  expect(handleEscape(), 'Escape is handled by the panel');
  expect(panel.el.hidden && state.closed === 1, 'Escape closes it and reports the close');
  expect(escapeLayerCount() === 0, 'a closed panel releases Escape');

  panel.toggle();
  expect(panel.isOpen(), 'toggle opens');
  panel.toggle();
  expect(!panel.isOpen(), 'toggle closes');
  expect(state.closed === 2, 'each close reports once');
  panel.close();
  expect(state.closed === 2, 'closing a closed panel is a no-op');
}

{
  const { host, panel } = build({ tunable: false });
  panel.open();
  expect(host.querySelector('.crt-panel-controls').hidden, 'without the shader the sliders are hidden');
  expect(host.querySelectorAll('.crt-panel-preset').length === CRT_MODES.length, 'the presets are still offered');
  expect(/CSS/.test(host.querySelector('.crt-panel-note').textContent), 'and the note says why tuning is off');
  panel.close();
}

// Dragging by the header moves the panel anywhere in the window (1400x900 here)
// and remembers where; the first open lands in the monitor's top-right corner.
{
  const { host, panel, state } = build();
  panel.el._rect = { left: 700, top: 62, width: 272, height: 400 };
  panel.open();
  expect(panel.el.style.left === '616px' && panel.el.style.top === '62px', 'first open: 12px inside the monitor\'s top-right corner');
  const head = host.querySelector('.crt-panel-head');
  fire(head, 'pointerdown', { target: head, clientX: 710, clientY: 70, pointerId: 1 });
  fire(head, 'pointermove', { target: head, clientX: 410, clientY: 170, pointerId: 1 });
  expect(panel.el.style.left === '400px' && panel.el.style.top === '162px' && panel.el.style.right === 'auto',
    'the panel follows the pointer by the grab offset, in viewport pixels');
  fire(head, 'pointermove', { target: head, clientX: 1300, clientY: 170, pointerId: 1 });
  expect(panel.el.style.left === '1128px', 'it may leave the monitor: only the window edge stops it');
  fire(head, 'pointermove', { target: head, clientX: -500, clientY: 5000, pointerId: 1 });
  expect(panel.el.style.left === '0px' && panel.el.style.top === '500px', 'it cannot leave the window (clamped to 0 and window - panel)');
  expect(state.saved.length === 0, 'nothing is saved mid-drag');
  fire(head, 'pointerup', { target: head, pointerId: 1 });
  expect(state.saved.length === 1 && state.saved[0].x === 0 && state.saved[0].y === 500, 'letting go saves the spot');
  fire(head, 'pointermove', { target: head, clientX: 500, clientY: 500, pointerId: 1 });
  expect(panel.el.style.left === '0px', 'moving without a grab does nothing');
  const closeBtn = host.querySelector('.crt-panel-close');
  fire(head, 'pointerdown', { target: closeBtn, clientX: 0, clientY: 0, pointerId: 2 });
  fire(head, 'pointermove', { target: head, clientX: 300, clientY: 300, pointerId: 2 });
  expect(panel.el.style.left === '0px', 'the close button is not a grab handle');
  panel.close();
}
{
  const { panel } = build({ initialPos: { x: 5000, y: -20 } });
  panel.el._rect = { left: 0, top: 0, width: 272, height: 400 };
  panel.open();
  expect(panel.el.style.left === '1128px' && panel.el.style.top === '0px', 'a remembered spot is re-clamped to the window on open');
  panel.close();
}

console.log('crt panel spec: PASS');
