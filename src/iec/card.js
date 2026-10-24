// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { inspectIecSource, loadIecSource } from './plugins.js';
import { listIecInstalled, putIecInstalled, removeIecInstalled } from './store.js';
import { createBrowserHost } from '../userport/host.js';
import { createDeviceInstallReview } from '../ui/device-install-review.js';
import { validIecAddress } from '../iec.js';
import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';

const KEY = 'c64emu.iec.connections', POWER = 'c64emu.iec.power';
const $ = id => document.getElementById(id);
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }
function text(tag, value, cls) { const el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; return el; }
function button(label, fn, cls = '') { const b = text('button', label, `btn ${cls}`.trim()); b.type = 'button'; b.addEventListener('click', fn); return b; }
function download(name, source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initIecCard({ getMachine, getAudio, safeMode = false }) {
  const card = $('iec-card'), power = $('iec-power'), select = $('iec-device'), address = $('iec-address');
  const status = $('iec-status'), list = $('iec-connections'), modal = $('iec-modal');
  const body = $('iec-modal-body'), actions = $('iec-modal-actions'), title = $('iec-modal-title');
  let powered = read(POWER, false) === true, installed = [], configs = [], facade = null, opener = null;
  const modules = new Map(), controllers = new Map(), activeHosts = [];
  let generation = 0;
  function save() { write(KEY, configs); }
  function message(value) { status.textContent = value; }
  function close() { modal.hidden = true; popEscapeLayer(layer); opener?.focus(); }
  const layer = { close, isOpen: () => !modal.hidden };
  function show(heading, nodes, buttons) {
    if (modal.hidden) opener = document.activeElement;
    title.textContent = heading; body.replaceChildren(...nodes); actions.replaceChildren(...buttons);
    modal.hidden = false; pushEscapeLayer(layer); (buttons.at(-1) || $('btn-iec-modal-x')).focus();
  }
  $('btn-iec-modal-x').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  for (let n = 4; n <= 30; n++) if (validIecAddress(n)) {
    const option = text('option', String(n)); option.value = String(n); address.append(option);
  }
  function stop(n) {
    const ctl = controllers.get(n);
    if (!ctl) return;
    ctl.facade.detachIecDevice(n); ctl.host.dispose(); controllers.delete(n); activeHosts.splice(activeHosts.indexOf(ctl), 1);
    const status = list.querySelector(`[data-address="${n}"] .iec-device-status`);
    if (status) status.textContent = 'Waiting for power.';
  }
  function stopAll() { for (const n of controllers.keys()) stop(n); }
  function failed(n, id, error) {
    stop(n); configs = configs.filter(c => c.address !== n); save(); render();
    message(`Device ${n} (${id}) stopped: ${error.message}`);
  }
  function plug(config) {
    if (safeMode || !powered || !facade?.ready || controllers.has(config.address)) return;
    const info = modules.get(config.id);
    if (!info) return;
    const row = list.querySelector(`[data-address="${config.address}"]`);
    if (!row) return;
    const host = createBrowserHost({ meta: { ...info.meta, id: `${info.meta.id}.iec-${config.address}` },
      panelHost: row.querySelector('.iec-device-panel'), getAudio,
      setStatus: value => { row.querySelector('.iec-device-status').textContent = value; } });
    const ctl = { address: config.address, id: config.id, facade, host };
    controllers.set(config.address, ctl); activeHosts.push(ctl);
    try { facade.attachIecDevice(config.address, info.meta.id, p => info.mod.create(p, host.host), info.meta.version, failed); }
    catch (error) { failed(config.address, info.meta.id, error); }
  }
  function render() {
    // Existing hosts keep their ShadowRoots and frame hooks while another device changes.
    for (const row of list.children) if (!configs.some(c => c.address === Number(row.dataset.address))) row.remove();
    for (const config of configs) {
      if (list.querySelector(`[data-address="${config.address}"]`)) continue;
      const info = modules.get(config.id), row = document.createElement('section');
      row.className = 'iec-connected'; row.dataset.address = String(config.address);
      const header = document.createElement('div'); header.className = 'iec-connected-header';
      header.append(text('strong', `${info?.meta.name || config.id} · ${config.address}`), button('DISCONNECT', () => {
        stop(config.address); configs = configs.filter(c => c.address !== config.address); save(); render();
      }));
      const panel = document.createElement('div'); panel.className = 'iec-device-panel';
      row.append(header);
      if (info?.meta.description) row.append(text('p', info.meta.description, 'iec-device-description'));
      row.append(text('div', 'Waiting for power.', 'reu-status iec-device-status'), panel); list.append(row);
    }
    const on = powered && !safeMode;
    power.checked = on; power.disabled = safeMode; card.classList.toggle('expanded', on);
    card.querySelector('.expand-btn').setAttribute('aria-expanded', String(on));
    $('btn-iec-connect').disabled = safeMode || !select.value;
    message(safeMode ? 'Safe mode: no IEC plugin code is loaded.' : 'Drives 8 and 9 stay connected through their own cards.');
    for (const config of configs) plug(config);
  }
  async function refresh() {
    installed = await listIecInstalled().catch(() => []);
    const selected = select.value;
    select.replaceChildren();
    for (const record of installed) {
      const option = text('option', record.meta.name); option.value = record.id; select.append(option);
      if (!safeMode && !modules.has(record.id)) {
        try { modules.set(record.id, await loadIecSource(record.source)); }
        catch (error) { message(`Could not load ${record.meta.name}: ${error.message}`); }
      }
    }
    if (installed.some(r => r.id === selected)) select.value = selected;
    if (!installed.length) { const option = text('option', 'Install an IEC plugin…'); option.value = ''; select.append(option); }
    configs = configs.filter(c => installed.some(r => r.id === c.id));
    render();
  }
  const initial = read(KEY, []);
  if (Array.isArray(initial)) {
    const used = new Set();
    configs = initial.filter(c => c && validIecAddress(c.address) && typeof c.id === 'string' && !used.has(c.address) && used.add(c.address));
  }
  function setPower() {
    powered = power.checked; write(POWER, powered);
    if (!powered) stopAll(); render();
  }
  power.addEventListener('change', setPower);
  $('iec-power-switch').addEventListener('click', e => e.stopPropagation());
  card.querySelector('.panel-card-header').addEventListener('click', () => { if (!safeMode) { power.checked = !power.checked; setPower(); } });
  select.addEventListener('change', () => {
    const preferred = installed.find(r => r.id === select.value)?.meta.address ?? 4;
    address.value = String(preferred);
  });
  $('btn-iec-connect').addEventListener('click', () => {
    const n = Number(address.value);
    if (!select.value || !validIecAddress(n)) return;
    if (configs.some(c => c.address === n)) { message(`IEC address ${n} is already connected. Choose another address.`); return; }
    configs.push({ address: n, id: select.value }); save(); render();
  });
  async function offer(source, origin) {
    let info;
    try { info = await inspectIecSource(source); }
    catch (error) { show('Not an IEC device', [text('p', error.message)], [button('OK', close)]); return; }
    const existing = installed.find(r => r.id === info.meta.id);
    const review = createDeviceInstallReview({ info, source, origin, existing, connector: 'iec', trustId: 'iec-install-trust' });
    const { tick } = review;
    const go = button(existing ? 'REPLACE' : 'INSTALL', async () => {
      if (!tick.checked) return;
      close();
      try {
        const loaded = await loadIecSource(source);
        if (JSON.stringify(loaded.meta) !== JSON.stringify(info.meta)) throw new Error('Plugin metadata changed while loading.');
        await putIecInstalled({ id: info.meta.id, source, meta: info.meta, hash: info.hash, origin });
        for (const c of configs) if (c.id === info.meta.id) { stop(c.address); list.querySelector(`[data-address="${c.address}"]`)?.remove(); }
        modules.set(info.meta.id, loaded); await refresh(); select.value = info.meta.id; address.value = String(info.meta.address);
        message(`Installed ${info.meta.name}. Choose an address and CONNECT.`);
      } catch (error) { message(`Could not save the plugin: ${error.message}`); }
    }, 'btn-danger');
    go.disabled = true; tick.addEventListener('change', () => { go.disabled = !tick.checked; });
    show(existing ? 'Replace IEC device' : 'Install IEC device', review.body, [button('CANCEL', close), go]); tick.focus();
  }
  $('btn-iec-install').addEventListener('click', () => $('iec-file').click());
  $('iec-file').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (file) await offer(await file.text(), file.name);
  });
  $('btn-iec-url').addEventListener('click', () => {
    const label = text('label', 'Choose a ready-made plugin or enter your own URL', 'userport-source-field'), choice = document.createElement('select');
    choice.id = 'iec-plugin-choice'; choice.className = 'cp-device-select';
    for (const [value, name] of [['printer', 'IEC Printer'], ['monitor', 'IEC Monitor'], ['custom', 'Custom URL']]) {
      const option = text('option', name); option.value = value; choice.append(option);
    }
    label.append(choice);
    const field = text('label', 'Plugin URL', 'userport-source-field'), input = document.createElement('input');
    input.id = 'iec-plugin-url'; input.type = 'url'; input.placeholder = 'https://…/device.js'; field.append(input); field.hidden = true;
    const description = text('p', '');
    const update = () => {
      field.hidden = choice.value !== 'custom';
      description.textContent = choice.value === 'printer' ? 'Commodore text and bitmap graphics, with browser printing and PDF output.'
        : choice.value === 'monitor' ? 'A developer example that displays bytes sent to its IEC address.'
        : 'Enter the URL of a .js plugin. Its server must allow cross-origin requests.';
    };
    choice.addEventListener('change', update); update();
    const go = button('FETCH', async () => {
      const url = choice.value === 'custom' ? input.value.trim() : new URL(`/iec/${choice.value}.js`, location.href).href;
      try {
        if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Enter an http:// or https:// plugin URL.');
        go.disabled = true;
        const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
        if (!response.ok) throw new Error(`Server answered ${response.status}`);
        await offer(await response.text(), url);
      } catch (error) { message(error.message); go.disabled = false; }
    });
    show('Install IEC from URL', [label, field, description], [button('CANCEL', close), go]); choice.focus();
  });
  $('btn-iec-manage').addEventListener('click', () => {
    const rows = document.createElement('ul'); rows.className = 'userport-list';
    for (const record of installed) {
      const row = document.createElement('li');
      row.append(text('span', `${record.meta.name} ${record.meta.version}`, 'name'),
        button('EXPORT', () => download(`${record.id}.js`, record.source)),
        button('REMOVE', async () => {
          for (const c of configs) if (c.id === record.id) stop(c.address);
          configs = configs.filter(c => c.id !== record.id); save();
          await removeIecInstalled(record.id); modules.delete(record.id); await refresh(); close();
        })); rows.append(row);
    }
    show('IEC plugins', [rows], [button('CLOSE', close)]);
  });
  card.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
  card.addEventListener('drop', async e => {
    const file = e.dataTransfer?.files[0]; if (!file) return;
    e.preventDefault(); e.stopPropagation(); await offer(await file.text(), file.name);
  });
  const ready = refresh();
  return {
    attach(m) {
      stopAll(); facade = m; generation++;
      for (const config of configs) plug(config);
      const gen = generation;
      ready.then(() => { if (gen === generation && facade === m) for (const config of configs) plug(config); });
    },
    detach() { generation++; stopAll(); facade = null; },
    frame() {
      for (let i = 0; i < activeHosts.length; i++) {
        const ctl = activeHosts[i];
        try { ctl.host.frame(); } catch (error) { failed(ctl.address, ctl.id, error); }
      }
      const mismatch = facade?.takeIecRestoreMismatches();
      if (mismatch?.length) message(`Snapshot IEC devices not restored: ${mismatch.map(d => `${d.id} at ${d.address}`).join(', ')}`);
    },
  };
}
