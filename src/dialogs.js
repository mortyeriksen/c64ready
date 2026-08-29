// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/dialogs.js – Styled in-app replacements for native confirm()/prompt().
//
// Pure leaf UI utilities: they depend only on their modal DOM refs (from
// dom.js) and resolve a Promise; no dependency on the emulator or app state.
// confirmDialog → Promise<boolean>; promptDialog → Promise<string|null>.
//
// The capture-phase Escape/Enter handlers below use stopImmediatePropagation so
// an open dialog wins over the library/keymap/C64 keydown handlers and the key
// never reaches the machine. Those handlers are registered when OTHER modules
// evaluate, so this module must be imported (and thus evaluated) BEFORE them —
// main.js imports it ahead of media.js / input.js for exactly that reason.

import {
  confirmModal, confirmModalTitle, confirmModalMsg,
  confirmModalOk, confirmModalCancel, confirmModalCancelX,
  promptModal, promptModalTitle, promptModalMsg, promptModalInput,
  promptModalOk, promptModalCancel, promptModalCancelX,
} from './dom.js';
import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';

// ── Confirm dialog ─────────────────────────────────────────────────────────
// A styled in-app replacement for the native confirm(), matching the other
// modals. confirmDialog(message, opts) returns a Promise<boolean> that
// resolves true on OK and false on Cancel / ✕ / backdrop / Escape.
let _confirmResolve = null;
const _confirmIsOpen = () => confirmModal && !confirmModal.hidden;
// One stable object per dialog, so push/pop match by identity.
const _confirmEscape = { close: () => _closeConfirm(false), isOpen: _confirmIsOpen };

function _closeConfirm(result) {
  if (!confirmModal) return;
  confirmModal.hidden = true;
  popEscapeLayer(_confirmEscape);
  const resolve = _confirmResolve;
  _confirmResolve = null;
  if (resolve) resolve(result);
}

// okOnly hides the Cancel button for a single-button informational dialog
// (the ✕ / Escape still dismiss it). The Cancel visibility is reset on every
// call so it reappears for normal confirms sharing this modal.
export function confirmDialog(message, { title = 'Confirm', okLabel = 'OK', okOnly = false } = {}) {
  // Fall back to native confirm/alert if the modal markup isn't present.
  if (!confirmModal) {
    if (okOnly) { window.alert(message); return Promise.resolve(true); }
    return Promise.resolve(window.confirm(message));
  }
  // Resolve any prior pending dialog as cancelled before re-opening.
  if (_confirmResolve) _closeConfirm(false);
  if (confirmModalMsg)    confirmModalMsg.textContent = message;
  if (confirmModalTitle)  confirmModalTitle.textContent = title;
  if (confirmModalOk)     confirmModalOk.textContent = okLabel;
  if (confirmModalCancel) confirmModalCancel.hidden = okOnly;
  confirmModal.hidden = false;
  pushEscapeLayer(_confirmEscape);
  if (confirmModalOk) confirmModalOk.focus();
  return new Promise(resolve => { _confirmResolve = resolve; });
}

if (confirmModalOk)      confirmModalOk.addEventListener('click', () => _closeConfirm(true));
if (confirmModalCancel)  confirmModalCancel.addEventListener('click', () => _closeConfirm(false));
if (confirmModalCancelX) confirmModalCancelX.addEventListener('click', () => _closeConfirm(false));
if (confirmModal) {
  confirmModal.addEventListener('click', e => { if (e.target === confirmModal) _closeConfirm(false); });
}
// Keys never reach the C64 while the dialog is up. Escape is not handled here —
// escape-stack.js owns it and cancels the topmost dialog. Enter/Space fall
// through to the natively-focused OK button's default activation.
document.addEventListener('keydown', e => {
  if (!_confirmIsOpen()) return;
  e.stopImmediatePropagation();
}, { capture: true });

// ── Prompt dialog ──────────────────────────────────────────────────────────
// Styled in-app replacement for native prompt(), matching the other modals.
// promptDialog(message, opts) returns a Promise<string|null> — the trimmed
// text on OK / Enter, or null on Cancel / ✕ / backdrop / Escape.
let _promptResolve = null;
const _promptIsOpen = () => promptModal && !promptModal.hidden;
const _promptEscape = { close: () => _closePrompt(null), isOpen: _promptIsOpen };

function _closePrompt(result) {
  if (!promptModal) return;
  promptModal.hidden = true;
  popEscapeLayer(_promptEscape);
  const resolve = _promptResolve;
  _promptResolve = null;
  if (resolve) resolve(result);
}

// Set while a prompt wants uppercase-only input (a C64 name, e.g. a tape label).
let _promptUppercase = false;

export function promptDialog(message, { title = 'Prompt', okLabel = 'OK', defaultValue = '', placeholder = '', maxLength = 0, uppercase = false } = {}) {
  // Fall back to the native prompt if the modal markup isn't present.
  if (!promptModal || !promptModalInput) return Promise.resolve(window.prompt(message, defaultValue));
  if (_promptResolve) _closePrompt(null);   // resolve any prior pending prompt as cancelled
  if (promptModalMsg)   promptModalMsg.textContent = message;
  if (promptModalTitle) promptModalTitle.textContent = title;
  if (promptModalOk)    promptModalOk.textContent = okLabel;
  promptModalInput.value = defaultValue || '';
  promptModalInput.placeholder = placeholder || '';
  // Cap typing at the source rather than truncating afterwards. The input is
  // shared, so an absent cap has to clear the previous dialog's.
  if (maxLength > 0) promptModalInput.maxLength = maxLength;
  else promptModalInput.removeAttribute('maxlength');
  _promptUppercase = !!uppercase;
  if (uppercase) promptModalInput.value = promptModalInput.value.toUpperCase();
  promptModal.hidden = false;
  pushEscapeLayer(_promptEscape);
  promptModalInput.focus();
  promptModalInput.select();
  return new Promise(resolve => { _promptResolve = resolve; });
}

// Uppercase as it is typed, so what the field shows is what gets used. The
// transform is length-preserving, so the caret can be put back exactly.
if (promptModalInput) {
  promptModalInput.addEventListener('input', () => {
    if (!_promptUppercase) return;
    const up = promptModalInput.value.toUpperCase();
    if (up === promptModalInput.value) return;
    const start = promptModalInput.selectionStart;
    const end = promptModalInput.selectionEnd;
    promptModalInput.value = up;
    try { promptModalInput.setSelectionRange(start, end); } catch { /* not a text input */ }
  });
}

const _promptSubmit = () => _closePrompt(promptModalInput ? promptModalInput.value.trim() : '');

if (promptModalOk)      promptModalOk.addEventListener('click', _promptSubmit);
if (promptModalCancel)  promptModalCancel.addEventListener('click', () => _closePrompt(null));
if (promptModalCancelX) promptModalCancelX.addEventListener('click', () => _closePrompt(null));
if (promptModal) {
  promptModal.addEventListener('click', e => { if (e.target === promptModal) _closePrompt(null); });
}
// Enter submits. Escape is escape-stack.js's. Capture + stopImmediatePropagation
// so keys drive the input (default text entry still happens — we don't
// preventDefault on normal keys) but never reach the C64.
document.addEventListener('keydown', e => {
  if (!_promptIsOpen()) return;
  if (e.code === 'Enter') { _promptSubmit(); e.preventDefault(); }
  e.stopImmediatePropagation();
}, { capture: true });
