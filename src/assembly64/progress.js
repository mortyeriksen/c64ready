// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { el } from './dom.js';

const MIN_PROGRESS_MS = 1000;
const bytes = value => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`;
export function progressText({ stage = 'download', loaded = 0, total = null, done = false }) {
  if (stage === 'select') return 'Choose a file from the archive…';
  if (stage === 'open') return 'Opening media…';
  if (stage === 'save') return 'Saving file…';
  const label = stage === 'extract' ? 'Extracting' : 'Downloading';
  if (done) return `${stage === 'extract' ? 'Extracted' : 'Downloaded'} ${bytes(loaded)}`;
  return total > 0 ? `${label} ${Math.min(100, Math.floor(loaded / total * 100))}% · ${bytes(loaded)} / ${bytes(total)}` : `${label} ${bytes(loaded)} · size unknown`;
}

export function createDownloadProgress({ card = false } = {}) {
  const root = el('div', null, { class: `mb-download-progress${card ? ' mb-card-progress' : ''}`, hidden: '' });
  const name = el('span', '', { class: 'mb-download-name' });
  const counter = el('span', '', { class: 'mb-download-counter' });
  const bar = el('progress', null, { max: 1, 'aria-label': 'Download progress' });
  const announcement = el('span', '', { class: 'mb-sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': true });
  const heading = el('div', null, { class: 'mb-download-heading' });
  heading.hidden = card;
  heading.append(name, counter); root.append(heading, bar, announcement);
  let active = false, lastAnnouncement = '', lastAnnouncedAt = 0;
  let placement;
  let fillAnimation;
  let startedAt = 0, minimumTimer, minimumResolve;
  function revealFill() {
    if (fillAnimation || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const elapsed = performance.now() - startedAt;
    if (elapsed >= MIN_PROGRESS_MS) return;
    fillAnimation = bar.animate([
      { clipPath: `inset(0 ${100 * (1 - elapsed / MIN_PROGRESS_MS)}% 0 0)` },
      { clipPath: 'inset(0 0% 0 0)' },
    ], { duration: MIN_PROGRESS_MS - elapsed, easing: 'linear', fill: 'forwards' });
  }
  function waitMinimum() {
    if (!active || performance.now() - startedAt >= MIN_PROGRESS_MS) return Promise.resolve();
    return new Promise(resolve => {
      minimumResolve = resolve;
      const check = () => {
        const remaining = MIN_PROGRESS_MS - (performance.now() - startedAt);
        if (active && remaining > 0) minimumTimer = setTimeout(check, Math.ceil(remaining));
        else { minimumTimer = null; minimumResolve = null; resolve(); }
      };
      check();
    });
  }
  function update(progress) {
    if (!active) return;
    const text = progressText(progress);
    name.textContent = progress.name || '';
    counter.textContent = text;
    if (placement) placement.label.textContent = text;
    bar.setAttribute('aria-label', `${progress.stage === 'extract' ? 'Extraction' : 'Download'} progress for ${progress.name || 'media'}`);
    bar.setAttribute('aria-valuetext', text);
    if (!['open', 'save', 'select'].includes(progress.stage)) {
      if (progress.done) { bar.max = 1; bar.value = 1; }
      else if (progress.total > 0) { bar.max = progress.total; bar.value = progress.loaded; }
      else bar.removeAttribute('value');
    }
    if (bar.hasAttribute('value')) revealFill();
    else { fillAnimation?.cancel(); fillAnimation = null; }
    const bucket = `${progress.stage}:${progress.done ? 'done' : progress.total > 0 ? Math.floor(progress.loaded / progress.total * 10) : 'unknown'}`;
    const now = performance.now();
    if (bucket !== lastAnnouncement || now - lastAnnouncedAt >= 2000) {
      announcement.textContent = text; lastAnnouncement = bucket; lastAnnouncedAt = now;
    }
  }
  return {
    root, update, waitMinimum,
    start(filename, target) {
      fillAnimation?.cancel(); fillAnimation = null;
      if (card) {
        placement = { ...target, text: target.label.textContent };
        target.row.classList.add('mb-progress-card');
        target.row.setAttribute('aria-busy', 'true');
        target.label.classList.add('mb-progress-label');
        target.row.append(root);
      }
      active = true; startedAt = performance.now(); root.hidden = false; lastAnnouncement = ''; lastAnnouncedAt = 0;
      update({ stage: 'download', name: filename, loaded: 0, total: null });
    },
    finish() {
      active = false; root.hidden = true; announcement.textContent = ''; bar.removeAttribute('value');
      fillAnimation?.cancel(); fillAnimation = null;
      clearTimeout(minimumTimer); minimumTimer = null; minimumResolve?.(); minimumResolve = null;
      if (placement) {
        placement.label.textContent = placement.text;
        placement.label.classList.remove('mb-progress-label');
        placement.row.classList.remove('mb-progress-card');
        placement.row.removeAttribute('aria-busy');
        placement = null; root.remove();
      }
    },
  };
}
