// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const SLOTS = ['kernal', 'basic', 'charRom', 'drive1541'];

export function romSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS link without a username or password.');
  }
  return url.href;
}

export async function fetchRomSources(loader, urls, onStatus, request = fetch) {
  await Promise.all(SLOTS.map(async key => {
    if (loader[key]) { onStatus(key, 'Loaded'); return; }
    try {
      const url = romSourceUrl(urls[key]);
      if (!url) {
        onStatus(key, key === 'drive1541' ? 'Optional, no link supplied' : 'Enter a ROM link.');
        return;
      }
      onStatus(key, 'Fetching…');
      const response = await request(url, {
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
      const data = new Uint8Array(await response.arrayBuffer());
      const name = new URL(url).pathname.split('/').pop() || `${key}.bin`;
      loader.setRomData(key, data, name, 'fetch');
      onStatus(key, 'Loaded');
    } catch (error) {
      const message = error.name === 'TimeoutError' ? 'Download timed out. Try again.'
        : error instanceof TypeError ? 'Could not download. Check the link, or use VICE or a local file.'
        : error.message;
      onStatus(key, message);
    }
  }));
}

export function initRomSetup(modal, loader, onChanged) {
  modal.addEventListener('keydown', event => event.stopPropagation());
  modal.addEventListener('keyup', event => event.stopPropagation());
  const tabs = [...modal.querySelectorAll('[role="tab"]')];
  const viceSupported = 'webkitdirectory' in document.createElement('input')
    && !window.matchMedia?.('(pointer: coarse)').matches;
  modal.querySelector('#setup-tab-vice').hidden = !viceSupported;
  const availableTabs = tabs.filter(tab => !tab.hidden);
  function selectTab(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      modal.querySelector(`#${item.getAttribute('aria-controls')}`).hidden = !selected;
    }
  }
  availableTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % availableTabs.length
        : event.key === 'ArrowLeft' ? (index + availableTabs.length - 1) % availableTabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? availableTabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(availableTabs[next]);
      availableTabs[next].focus();
    });
  });
  const inputs = Object.fromEntries(SLOTS.map(key => [key, modal.querySelector(`#setup-url-${key}`)]));
  const statuses = Object.fromEntries(SLOTS.map(key => [key, modal.querySelector(`#setup-fetch-${key}`)]));
  const button = modal.querySelector('#setup-fetch');
  const summary = modal.querySelector('#setup-fetch-summary');
  const configStatus = modal.querySelector('#setup-config-status');
  let defaultsPromise;
  let busy = false;
  function syncLoaded() {
    for (const key of SLOTS) {
      if (loader[key]) statuses[key].textContent = 'Loaded';
      else if (statuses[key].textContent === 'Loaded') statuses[key].textContent = '';
    }
  }
  async function loadDefaults() {
    configStatus.textContent = 'Loading default links…';
    try {
      const response = await fetch('/rom-sources.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('No defaults');
      const config = await response.json();
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid defaults');
      const urls = Object.fromEntries(SLOTS.map(key => [key, romSourceUrl(config[key])]));
      for (const key of SLOTS) if (!inputs[key].value && !inputs[key].dataset.edited) inputs[key].value = urls[key];
      configStatus.textContent = '';
    } catch {
      configStatus.textContent = 'Default links are unavailable. Paste your own links, or use VICE or local files.';
    }
  }
  for (const input of Object.values(inputs)) input.addEventListener('input', () => { input.dataset.edited = 'true'; });
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = 'FETCHING…';
    for (const input of Object.values(inputs)) input.disabled = true;
    summary.textContent = '';
    try {
      await defaultsPromise;
      const urls = Object.fromEntries(SLOTS.map(key => [key, inputs[key].value]));
      await fetchRomSources(loader, urls, (key, status) => {
        statuses[key].textContent = status;
        if (status === 'Loaded') onChanged();
      });
      summary.textContent = loader.allLoaded
        ? (loader.drive1541 ? 'All four ROMs are loaded. Your C64 is ready.' : 'Your C64 is ready. You can also add the optional 1541 DOS ROM.')
        : 'Some ROMs are still missing. Check the messages above and retry, or use VICE or local files.';
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = 'FETCH ROMS';
      for (const input of Object.values(inputs)) input.disabled = false;
      onChanged();
    }
  });
  return { open() { syncLoaded(); defaultsPromise ??= loadDefaults(); } };
}
