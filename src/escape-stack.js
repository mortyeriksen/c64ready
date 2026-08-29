// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/escape-stack.js — the single owner of the Escape key.
//
// Every dialog used to attach its own document-level capture listener and guess
// at priority. Thirteen of them fired in registration order — module import
// order, which has nothing to do with what is on top — and the ten that called
// stopImmediatePropagation silenced whichever happened to be registered later.
// Three used the weaker stopPropagation, which does not stop sibling listeners
// on the same node at all, so they only appeared to claim the key.
//
// Instead: dialogs push a layer when they open and pop it when they close, and
// Escape closes the topmost one. Priority is the stack, so it matches what the
// user sees, and no call site decides which stop* variant to use.
//
// The listener here is registered when this module is evaluated. Every dialog
// module imports it, and ES modules evaluate their dependencies first, so this
// listener is always in place before any dialog's own — a guarantee from the
// language rather than luck with import order.

// Top of stack = last element. Each layer is { close, isOpen }; isOpen lets the
// stack heal itself, so a dialog that closes by some path that forgets to pop
// costs nothing but a stale entry that is dropped on the next Escape.
const _layers = [];

/**
 * Claim Escape until popped. Re-pushing a layer already on the stack moves it to
 * the top rather than duplicating it, so an open() that runs twice is harmless.
 * @param {{close: () => void, isOpen: () => boolean}} layer
 */
export function pushEscapeLayer(layer) {
  popEscapeLayer(layer);
  _layers.push(layer);
}

/** Give up the claim. No-op if the layer isn't on the stack. */
export function popEscapeLayer(layer) {
  const i = _layers.lastIndexOf(layer);
  if (i >= 0) _layers.splice(i, 1);
}

/** Is anything currently claiming Escape? Used by tests and by the fullscreen UI. */
export function escapeLayerCount() {
  return _layers.length;
}

/** Test seam: drop every layer. Not used by the app. */
export function _resetEscapeLayers() {
  _layers.length = 0;
}

/**
 * Close the topmost open layer. Exported so tests can drive it without
 * synthesising a KeyboardEvent; the listener below is a thin wrapper.
 * @returns {boolean} whether a layer handled it
 */
export function handleEscape() {
  // Discard layers whose dialog is already gone before picking a target.
  while (_layers.length && !_layers[_layers.length - 1].isOpen()) _layers.pop();
  const top = _layers[_layers.length - 1];
  if (!top) return false;
  top.close();
  if (!top.isOpen()) popEscapeLayer(top);
  return true;
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', e => {
    if (e.code !== 'Escape') return;
    if (!handleEscape()) return;
    // Claimed: keep it from reaching the dialog's own key-swallowing listener,
    // the C64 matrix, or a second dialog underneath. Leaving fullscreen on
    // Escape is the browser's own and cannot be cancelled either way.
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
}
