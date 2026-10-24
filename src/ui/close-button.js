// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const initialized = new WeakSet();

function initialize(button) {
  if (initialized.has(button)) return button;
  initialized.add(button);
  button.setAttribute('type', 'button');
  if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', 'Close');
  if (!button.hasAttribute('title') && !button.hasAttribute('data-tip')) button.title = 'Close (Esc)';
  button.innerHTML = ICON;
  // Pressing close must not start a floating dialog's title-bar drag.
  // Native button activation owns Enter and Space.
  button.addEventListener('pointerdown', event => event.stopPropagation());
  return button;
}

export function initCloseButtons(root = document) {
  for (const button of root.querySelectorAll('button.dialog-close')) initialize(button);
}

export function createCloseButton({ label = 'Close', title = 'Close (Esc)', className = '', onClose, document: doc = document } = {}) {
  const button = doc.createElement('button');
  button.className = `dialog-close${className ? ` ${className}` : ''}`;
  button.setAttribute('aria-label', label);
  button.title = title;
  initialize(button);
  if (onClose) button.addEventListener('click', onClose);
  return button;
}
