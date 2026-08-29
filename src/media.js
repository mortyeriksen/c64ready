// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media.js – Content & peripherals: file library, save/load state, and all
// media loading (PRG, CRT cartridges, D64 disks for drives 8 & 9, TAP tapes),
// and the disk-directory renderer.
//
// Owns the "what media is inserted" caches (currentD64, drive-9 disk/flags,
// cached cart/tape) as exported live bindings — media is their sole writer;
// main.js (_createAndWireMachine) reads them to reattach peripherals on reset.
//
// Core lifecycle/audio/pref helpers are dependency-injected via initMedia(deps)
// so this module never imports main.js (keeps the module graph acyclic).

import {
  canvas, resetBtn, pauseBtn, prgBtn, pasteBtn, prgInput, saveStateBtn, loadStateBtn, crtBtn, crtInput, crtEjectBtn, crtResetBtn, crtFreezeBtn, crtLabel, crtDropzone, d64Btn, d64Input, d64NewBtn, d64EjectBtn, d64WpBtn, d64FormatBtn, d64ExportBtn, d64DirEl, driveDropzone, driveEmptyHint, driveLoaded, tapBtn, tapInput, tapPlayBtn, tapStopBtn, tapRewBtn, tapFfBtn, tapRecBtn, tapStartBtn, tapNewBtn, tapWpBtn, tapExportBtn, tapExportWavBtn, tapEjectBtn, tapLabel, tapeBar, tapeBarWrap, tapeMotorDot, tapeTime, tapeCounter, tapeDropzone, driveLed, DRIVE8_UI, DRIVE9_UI, libraryModal, libraryBtn, libraryClose, libraryClear, libraryExport, libraryImport, libraryImportInput, libraryImportStatusEl, libraryFilterEl, libraryListEl, libraryEmptyEl, stateModal, stateFilterEl, stateListEl, stateEmptyEl, stateCloseBtn, stateClearBtn, stateExportBtn, stateImportBtn, stateImportInput, stateImportStatusEl, _dropZone,
  dirzoomModal, dirzoomTitle, dirzoomDiskName, dirzoomDiskMeta, dirzoomListEl, dirzoomCloseBtn,
  tapedirModal, tapedirTitle, tapedirHint, tapedirListEl, tapedirEmpty, tapedirNote, tapedirCloseBtn,
  wavImportModal, wavImportName, wavImportFill, wavImportStage,
  tapeDirZoomBtn,
  REU_UI,
} from './dom.js';
import { reuModel, REU_MODELS, REU_DEFAULT_MODEL } from './reu.js';
import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';
import {
  machine, loader, sidNode, running, _pristineBoot,
  setRunning, setPristineBoot, setHasBeenReady,
} from './state.js';
import { confirmDialog, promptDialog } from './dialogs.js';
import { D64, createBlankD64, createPRGDisk, d64Variant, prgAutostart, prgOverflow } from './d64.js';
import { tapToPcm, pcmToWav } from './tap-audio.js';
import { importWav, importProgress } from './wav-import.js';
import { dmpToTap } from './dmp-tape.js';
import { repairTape } from './tap-repair.js';
import { blankTapBytes } from './datasette.js';
import { LOCK_CLOSED_SVG, LOCK_OPEN_SVG } from './pixel-lock.js';
import { parseCRT } from './crt.js';
import { CANVAS_W, CANVAS_H, C64_PALETTE } from './vic2.js';
import { libList, libLoad, libSave, libDelete, libClear, libExport, libImport } from './filelibrary.js';
import { tapDirectory, tapeFacts } from './tap-directory.js';
import { stateList, stateSave, stateLoad, stateDelete, stateRename, stateClear, stateExport, stateExportAll, stateImportFile } from './statelibrary.js';

// ── Injected core dependencies (assigned by initMedia) ───────────────────────
let setStatus, _powerOn, _hardReset, _createAndWireMachine, _setPaused, startLoop, resumeAudio, suspendAudio, resetSidWorklet, _syncPowerStateClass, _punchLogo, _syncToggleLabels, _stopBootHint, _queueAutoLoad, stopPauseDemo, cancelAutoLoad, resetFrameTiming, resyncSid, releaseAllLatched, applyLoadedVariants, getIs8580, getVicVariantPref, getAutorunEnabled, isPaused;

// ── Media-domain state: media is the sole writer; main.js reads via import ────
export let currentD64 = null;
export let _cachedCartData = null;
export let _cachedTapData = null;
let _currentCartInfo = null;
let _cartridgeFreezeHeld = false;
export let _cachedTapName = null;
// Write-protect state to re-apply after a re-attach; null = let the tape's own
// content decide (loadTap protects an image that has something on it).
export let _cachedTapProtected = null;
// Where the head was and which key was down, for the same reason: POWER OFF
// destroys the machine, and the deck it takes with it was in the middle of
// something. Null once a different tape goes in — that one starts at its head.
export let _cachedTapDeck = null;
// What the last recording needed on the way in, for the directory viewer to
// mention. Belongs to the tape in the deck, so a new one clears it.
let _tapeRepairs = [], _tapeDamaged = [], _tapeUnconfirmed = [];
function _cacheCart(data) { _cachedCartData = data; }
function _clearCachedCart() { _cachedCartData = null; }
function _cacheTap(data, name) {
  _cachedTapData = data; _cachedTapName = name; _cachedTapProtected = null;
  _cachedTapDeck = null;
}
function _clearCachedTap() {
  _cachedTapData = null; _cachedTapName = null; _cachedTapProtected = null;
  _cachedTapDeck = null;
}

// Re-cache the tape from the live deck so a recording survives the machine being
// rebuilt (RESET, power cycle). Otherwise the cache stays the snapshot taken at
// insert time — a disk survives because its image object is the live one. Carries
// the write-protect state too, so recording can continue after a reset.
export function _cacheTapeFromDeck() {
  const ds = machine?.datasette;
  if (!machine?.ready || !ds?.hasMedia) return;
  const name = _cachedTapName || 'tape.tap';
  const wp = ds.writeProtected;
  const deck = { key: ds.key, seconds: ds.elapsedSeconds };
  _cacheTap(machine.exportTapBytes(), name);
  _cachedTapProtected = wp;
  _cachedTapDeck = deck;
}
/**
 * Put the deck back the way it was after the machine was rebuilt: the tape where
 * the head left it, and — when the caller asks for it — PLAY still down. A reset
 * does not wind a real datasette back, and pressing PLAY before POWER is how a
 * person starts a tape.
 *
 * Only PLAY. RECORD stays up because the tape has just been re-inserted from its
 * cached bytes and re-arming it would write over them with nobody asking; F.FWD
 * and REW are held keys here, and a held key does not survive the click that
 * caused the rebuild.
 */
export function _restoreDeck({ key, seconds }) {
  const ds = machine?.datasette;
  if (!ds?.hasMedia) return;
  if (seconds > 0) machine.seekTapeSeconds(seconds);
  if (key === 'PLAY') machine.setTapeKey('PLAY');
  _refreshTapeReadout(ds);
  _syncTapeButtons();
}

function _mediaInserted(liveMedia, cachedMedia, dropzone) {
  return !!(liveMedia || cachedMedia || dropzone?.classList.contains('loaded'));
}
function _syncD64EjectButton() {
  if (d64EjectBtn) {
    d64EjectBtn.disabled = !_mediaInserted(null, currentD64, driveDropzone);
  }
}
function _syncD64Drive9EjectButton() {
  if (DRIVE9_UI.ejectBtn) {
    DRIVE9_UI.ejectBtn.disabled = !_mediaInserted(null, currentD64Drive9, DRIVE9_UI.dropzone);
  }
}
function _syncCRTEjectButton() {
  if (crtEjectBtn) {
    crtEjectBtn.disabled = !_mediaInserted(machine?.mem?.cartridge, _cachedCartData, crtDropzone);
  }
}
function _syncTapEjectButton() {
  if (tapEjectBtn) {
    tapEjectBtn.disabled = !_mediaInserted(
      machine?.datasette?.hasMedia, _cachedTapData, tapeDropzone
    );
  }
}

// ── File library ("LOAD" dialog) ───────────────────────────────────────────
// Browse files previously loaded from disk (cached in IndexedDB by
// filelibrary.js) and re-load any of them without re-picking from disk.

const _libEscapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function _libFormatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// Compact "time ago" label for the library / save-state lists, e.g. "3 hours
// ago", "1 day ago", "2 weeks ago", "5 years ago". Numeric (never "yesterday")
// to match the elapsed-since intent. Computed at render time, so it reflects
// when the dialog was opened. Returns '' on an unparseable timestamp.
const _libRelTimeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
function _libRelativeTime(savedAt) {
  const t = new Date(savedAt).getTime();
  if (!Number.isFinite(t)) return '';
  const diffSec = (t - Date.now()) / 1000; // < 0 → in the past
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  // Largest unit that fits, biggest → smallest. Year/month use average lengths.
  const UNITS = [
    ['year',   31557600], // 365.25 d
    ['month',  2629800],  // 1/12 yr
    ['week',   604800],
    ['day',    86400],
    ['hour',   3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of UNITS) {
    if (abs >= secs) return _libRelTimeFmt.format(Math.round(diffSec / secs), unit);
  }
  return 'just now';
}

let _libRenderToken = 0;
async function _renderLibrary() {
  // libList() is async (IndexedDB) — guard against a slower earlier render
  // landing after a newer one (e.g. fast typing in the filter).
  const token = ++_libRenderToken;
  const all = await libList();
  if (token !== _libRenderToken) return;
  // Dialog order: alphabetical by name (case-insensitive), type as tiebreaker.
  all.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    || a.type.localeCompare(b.type));
  const q = (libraryFilterEl?.value || '').trim().toLowerCase();
  const list = q ? all.filter(e => e.name.toLowerCase().includes(q) || e.type.includes(q)) : all;
  if (libraryClear)     libraryClear.style.display = all.length ? '' : 'none';
  if (libraryExport)    libraryExport.style.display = all.length ? '' : 'none';
  if (libraryFilterEl)  libraryFilterEl.style.display = all.length ? '' : 'none';
  if (libraryEmptyEl) {
    if (!all.length) {
      libraryEmptyEl.textContent = "No cached files yet. Load a .PRG, .D64, .CRT, .TAP or .WAV and it'll show up here.";
      libraryEmptyEl.hidden = false;
    } else if (!list.length) {
      libraryEmptyEl.textContent = `No files match “${q}”.`;
      libraryEmptyEl.hidden = false;
    } else {
      libraryEmptyEl.hidden = true;
    }
  }
  if (!libraryListEl) return;
  libraryListEl.innerHTML = list.map(e => {
    const whenRel = _libRelativeTime(e.savedAt);
    const whenAbs = (() => { try { return new Date(e.savedAt).toLocaleString(); } catch { return ''; } })();
    const name = _libEscapeHtml(e.name);
    return `<div class="lib-row" data-id="${_libEscapeHtml(e.id)}" title="Load ${name}">
        <span class="lib-type lib-type-${e.type}">${e.type.toUpperCase()}</span>
        <span class="lib-name">${name}</span>
        <span class="lib-meta">${_libFormatSize(e.size)}<span class="lib-date" title="${_libEscapeHtml(whenAbs)}"> · ${_libEscapeHtml(whenRel)}</span></span>
        <button class="lib-del" data-del="${_libEscapeHtml(e.id)}" title="Remove from library" aria-label="Remove">✕</button>
      </div>`;
  }).join('');
}

// Apply a library entry's bytes via the same paths a fresh disk-load uses.
// Only PRG hard-resets first (button or library); d64/tap continue from the
// current state and auto-load when AUTORUN is on; crt cold-boots itself.
// Returns false if it could not be applied (e.g. PRG with the machine off).
async function _loadLibraryEntry(entry) {
  const { type, name, data } = entry;
  try {
    // Loading from the library while powered off just powers on first, then
    // loads — same as Load State. (Was: cache-only for media, refuse for PRG.)
    if (!running) {
      if (!(await _powerOn())) return false;   // ROMs not loaded → _powerOn alerted
    }
    if (type === 'd64') {
      // Library disks always load into the primary drive (device 8) — never
      // the secondary device-9 drive. Drive 9 is loaded only from its own card.
      // Entries stored before the drop-time size check exist, so check here too.
      const sizeError = _d64SizeError(data, name);
      if (sizeError) { setStatus(sizeError, 'error'); return false; }
      const disk = new D64(data);
      disk._libName = name;
      _loadDisk(disk);
    } else if (type === 'crt') {
      _applyCart(data);                 // loadCartridge() cold-boots the machine
    } else if (type === 'tap') {
      // 1s pause before auto-PLAY so the LOAD command is visible — the library
      // dialog closes and would otherwise jump straight into a loading tape.
      await _loadTape(data, name, { playDelayMs: 1000 });
    } else if (type === 'prg') {
      _insertPRG(data, 'loaded', name);
    } else if (type === 'reu') {
      return _loadReuImage(data, name);
    } else {
      return false;
    }
    return true;
  } catch (err) {
    setStatus(`${String(type).toUpperCase()} error: ${err.message}`, 'error');
    return false;
  }
}

// Live import progress / result line shown inside the library dialog.
function _setImportStatus(text) {
  if (!libraryImportStatusEl) return;
  libraryImportStatusEl.textContent = text || '';
  libraryImportStatusEl.hidden = !text;
}

// A filter field taking focus on a touch device raises the on-screen keyboard,
// which covers the very list the dialog was opened to show. Coarse pointer =
// no keyboard attached, so leave focus alone and let the user tap the field.
const _softKeyboardOnFocus = () => !!window.matchMedia?.('(pointer: coarse)').matches;

async function _openLibrary()  {
  if (!libraryModal) return;
  libraryModal.hidden = false;
  pushEscapeLayer(_libraryEscape);
  _setImportStatus('');   // clear any prior import result
  await _renderLibrary();
  if (libraryFilterEl && libraryFilterEl.style.display !== 'none' && !_softKeyboardOnFocus()) {
    libraryFilterEl.focus();
    libraryFilterEl.select();
  }
}
function _closeLibrary() { if (libraryModal) libraryModal.hidden = true; popEscapeLayer(_libraryEscape); }
const _libraryIsOpen = () => libraryModal && !libraryModal.hidden;
const _libraryEscape = { close: _closeLibrary, isOpen: _libraryIsOpen };

if (libraryBtn)   libraryBtn.addEventListener('click', _openLibrary);
if (libraryClose) libraryClose.addEventListener('click', _closeLibrary);
if (libraryFilterEl) libraryFilterEl.addEventListener('input', _renderLibrary);
if (libraryModal) {
  libraryModal.addEventListener('click', e => { if (e.target === libraryModal) _closeLibrary(); });
}
if (libraryClear) {
  libraryClear.addEventListener('click', async () => {
    const ok = await confirmDialog('Remove all cached files from the library?', {
      title: 'Clear library', okLabel: '🗑 CLEAR ALL',
    });
    if (ok) {
      await libClear();
      _renderLibrary();
    }
  });
}
// Export the whole library to a JSON file the user can save / move to another
// browser. Heavy (reads every blob, base64-encodes), so it runs on demand only.
if (libraryExport) {
  libraryExport.addEventListener('click', async () => {
    const data = await libExport();
    if (!data.entries.length) { setStatus('Library is empty — nothing to export', 'error'); return; }
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `c64emu-library-${ts}.rdy`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const n = data.entries.length;
    setStatus(`Exported ${n} file${n === 1 ? '' : 's'} → ${a.download}`, 'idle');
  });
}
// Import a previously-exported library JSON. Files already present (by type+name)
// are skipped, not overwritten.
if (libraryImport && libraryImportInput) {
  libraryImport.addEventListener('click', () => libraryImportInput.click());
  libraryImportInput.addEventListener('change', async () => {
    const file = libraryImportInput.files && libraryImportInput.files[0];
    libraryImportInput.value = '';   // let the user re-pick the same file later
    if (!file) return;
    // .json as well as .rdy: Android renames a download to match its MIME type,
    // and the export blob is application/json — so the file the user picks back
    // up on a phone is the same bytes under a different extension.
    if (_rejectWrongExt(file, ['.rdy', '.json'])) {
      _setImportStatus(`Not a library export — ${file.name}`);
      return;
    }
    _setImportStatus('Reading file…');
    let text;
    try { text = await file.text(); }
    catch { _setImportStatus(''); setStatus('Could not read the import file', 'error'); return; }
    const res = await libImport(text, p => {
      _setImportStatus(`Importing ${p.done}/${p.total} — ${p.imported} imported, ${p.skipped} skipped`);
    });
    if (res.error === 'parse')  { _setImportStatus(''); setStatus('Import failed — not valid JSON', 'error'); return; }
    if (res.error === 'format') { _setImportStatus(''); setStatus('Import failed — not a c64emu library export', 'error'); return; }
    await _renderLibrary();
    const parts = [`${res.imported} imported`, `${res.skipped} skipped (already present)`];
    if (res.invalid) parts.push(`${res.invalid} invalid`);
    const summary = parts.join(', ');
    _setImportStatus(`Done — ${summary}`);
    setStatus(`Library import: ${summary}`, 'idle');
  });
}
if (libraryListEl) {
  libraryListEl.addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      await libDelete(del.getAttribute('data-del'));
      _renderLibrary();
      return;
    }
    const row = e.target.closest('.lib-row');
    if (!row) return;
    const entry = await libLoad(row.getAttribute('data-id'));
    if (!entry) {
      setStatus('Library entry missing or corrupt', 'error');
      _renderLibrary();
      return;
    }
    if ((await _loadLibraryEntry(entry)) !== false) _closeLibrary();
  });
}

// Keep keystrokes out of the C64 while the library modal is open, but let them
// reach the filter input — so we stopImmediatePropagation on every key without
// preventDefault. Escape is escape-stack.js's, and never arrives here.
document.addEventListener('keydown', e => {
  if (!_libraryIsOpen()) return;
  e.stopImmediatePropagation();
}, { capture: true });

// ── Save / Load State ─────────────────────────────────────────────────────────
// Freeze the full machine (RAM + every chip + inserted disk/tape/cart) into a
// named IndexedDB slot, and restore it later. The heavy lifting is in
// machine.serializeState()/restoreState(); here we bundle the media bytes +
// chip variants, drive the picker dialog (mirroring the media library), and
// route restore through the same fresh-machine reattach path POWER ON uses.

// Paint the emulator's last rendered frame onto a fresh 2D canvas — the
// canonical way to READ the screen. Reading the #screen canvas itself only
// works under the 2D presenter (a WebGL canvas reads back blank after
// compositing, preserveDrawingBuffer is off); the framebuffer holds the
// identical pixels under either presenter.
function _frameToCanvas() {
  const fc = document.createElement('canvas');
  fc.width = CANVAS_W; fc.height = CANVAS_H;
  fc.getContext('2d').putImageData(new ImageData(machine.vic2.frameBuffer, CANVAS_W, CANVAS_H), 0, 0);
  return fc;
}

// A small downscaled PNG of the current frame, used as the slot's preview.
function _stateThumbnail() {
  try {
    if (!machine) return null;
    const tw = 96, th = Math.max(1, Math.round(CANVAS_H / CANVAS_W * tw));
    const tc = document.createElement('canvas');
    tc.width = tw; tc.height = th;
    tc.getContext('2d').drawImage(_frameToCanvas(), 0, 0, tw, th);
    return tc.toDataURL('image/png');
  } catch { return null; }
}

// Bundle the inserted media + chip-variant config so a restored slot is fully
// self-contained (works even if the source library entry was later deleted).
function _stateMediaBlock() {
  // Fold any pending 1541 head writes into the images first, so the snapshot
  // captures the disk exactly as the running program has written it.
  machine?.commitDriveWrites?.();
  // Same for tape: a recording in progress lives in the deck's buffer, so take
  // the bytes from the datasette rather than the cache the file was loaded from.
  // The datasette's own state reports the head at the end of those bytes.
  const tap = machine?.ready && machine.datasette?.hasMedia
    ? machine.exportTapBytes()
    : (_cachedTapData ? _cachedTapData.slice() : null);
  return {
    d64: currentD64 ? currentD64.img.slice() : null,
    d64drive9: currentD64Drive9 ? currentD64Drive9.img.slice() : null,
    drive9Enabled: !!drive9Enabled,
    crt: _cachedCartData ? _cachedCartData.slice() : null,
    tap,
    tapName: _cachedTapName || null,
    vicVariant: machine?.vic2?.vicVariant || getVicVariantPref(),
    sidIs8580: !!(machine && machine.sidIs8580),
    // The fitted unit only — expansion RAM itself rides in the machine
    // snapshot, so the fresh machine just needs the right model in place
    // before the restore fills it.
    reuEnabled: !!reuEnabled,
    reuUnit,
  };
}

async function _saveState() {
  if (!running || !machine?.ready) {
    setStatus('Power on a program first to save its state', 'error');
    return;
  }
  // Capture the state at the MOMENT Save is clicked, then PAUSE the emulator
  // (the rAF loop early-returns while !running) so the machine doesn't run on
  // underneath while the slot is being named. Capture is synchronous, so the
  // snapshot is an atomic, stable image regardless.
  let st, thumb;
  try {
    st = machine.serializeState();   // quiesces to an instruction boundary
    st.media = _stateMediaBlock();
    thumb = _stateThumbnail();
  } catch (err) {
    console.error('save state failed:', err);
    setStatus(`Save state failed: ${err.message}`, 'error');
    return;
  }
  const wasRunning = running;
  setRunning(false);                  // pause the main loop while naming the slot
  suspendAudio();                     // …and mute the SID/drive audio while paused
  setStatus('Paused — naming save state…', 'idle');
  let name;
  try {
    const def = (currentD64 && currentD64.diskName && currentD64.diskName.trim())
      || _cachedTapName || _currentCartInfo?.name || 'Save state';
    name = await promptDialog('Name this save state:', {
      title: 'Save state', okLabel: '💾 SAVE', defaultValue: def, placeholder: 'Save state name',
    });
  } finally {
    if (wasRunning) {                 // resume cleanly (don't catch-up the pause gap)
      setRunning(true);
      resetFrameTiming();
      resumeAudio();                  // unmute
      resyncSid();                    // the naming dialog froze the machine; re-align the SID clock
    }
  }
  if (name === null) {                // cancelled — already resumed
    if (wasRunning) setStatus('Running', 'running');
    return;
  }
  const id = await stateSave(name, st, thumb);
  setStatus(id ? `Saved state “${name || 'Save state'}”` : 'Could not save state (storage error)',
    id ? 'running' : 'error');
}

// Restore a slot. Re-establishes the media caches + variants from the bundle,
// builds a fresh machine via the normal reattach path, then overwrites all
// chip/RAM state with the snapshot. Powers on first if currently off.
async function _loadState(entry) {
  const st = entry && entry.state;
  if (!st || st.format !== 'c64state') { setStatus('Invalid save-state', 'error'); return false; }
  if (st.version > 1) { setStatus('Save-state is newer than this build supports', 'error'); return false; }
  if (isPaused()) _setPaused(false);   // resume so the restored state runs/renders
  if (!running) {
    if (!loader.allLoaded) { alert('Please load all three ROMs first.'); return false; }
    stopPauseDemo();
    _stopBootHint();
    canvas.style.cursor = '';
    await resumeAudio();
  }
  cancelAutoLoad();         // cancel any pending auto-load
  releaseAllLatched();

  // 1) Media caches → _createAndWireMachine reattaches exactly what was inserted.
  const media = st.media || {};
  // A slot's disk blobs get the same size check as any other mount. They were
  // valid when the state was written, so a failure here means the slot was
  // hand-edited or truncated by a storage fault — in which case that drive
  // restores EMPTY rather than holding a directory of several hundred junk
  // entries, and the rest of the state still comes back.
  const badDisks = [];
  const restoreDisk = (bytes, label) => {
    if (!bytes) return null;
    if (!d64Variant(bytes.length)) { badDisks.push(label); return null; }
    return new D64(bytes);
  };
  currentD64       = restoreDisk(media.d64, 'drive 8');
  currentD64Drive9 = restoreDisk(media.d64drive9, 'drive 9');
  drive9Enabled    = !!media.drive9Enabled;
  // The unit has to be fitted before the machine is built, the same as the
  // chip variants below — the snapshot's expansion RAM restores into it.
  // States saved before REU support carry neither field, so nothing is fitted.
  reuEnabled       = !!media.reuEnabled;
  reuUnit          = media.reuUnit || REU_DEFAULT_MODEL;
  _reuImageName    = null;
  try {
    localStorage.setItem('c64emu.reu', reuEnabled ? 'on' : 'off');
    localStorage.setItem('c64emu.reuModel', reuUnit);
  } catch {}
  // A snapshot with no cartridge restores to a machine with no cartridge — the
  // expansion port is part of the memory map the saved CPU state was running
  // against, so an inserted cart cannot be carried over. Note it in the status
  // line: the cart really does leave, and silently dropping it looked like a bug.
  const cartDropped = !media.crt && !!_currentCartInfo;
  if (media.crt) _cacheCart(media.crt); else { _clearCachedCart(); _forgetCartridgeUi(); }
  if (media.tap) _cacheTap(media.tap, media.tapName || 'tape'); else _clearCachedTap();

  // 2) Apply saved chip variants before building the machine so it is wired
  //    with the right VIC/SID model.
  applyLoadedVariants({ vicVariant: media.vicVariant, sidIs8580: media.sidIs8580 });

  // 3) Fresh machine (ROMs + media + variants), then overwrite with the state.
  resetSidWorklet();
  _createAndWireMachine();
  if (sidNode) sidNode.port.postMessage({ type: 'model', is8580: getIs8580() });
  try {
    machine.restoreState(st);
  } catch (err) {
    console.error('restore failed:', err);
    setStatus(`Load state failed: ${err.message}`, 'error');
    return false;
  }

  // A restored machine is mid-program, NOT at a cold-boot READY prompt — so it
  // must not run under BOOT_WARP. _createAndWireMachine() set _pristineBoot for
  // the fresh boot it just replaced; left set, rafLoop never sees _basicReady()
  // (we're mid-program) so it fast-forwards forever and the FPS spikes. Clear
  // it, and reset the rAF accumulator so the load's wall-clock gap doesn't
  // trigger a catch-up burst.
  setPristineBoot(false);
  setHasBeenReady(true);
  resetFrameTiming();

  // 4) Refresh UI + power-on bookkeeping. _createAndWireMachine() re-fired the
  //    tape/cart labels (showD64Directory is not), so show the disk directories
  //    here for whichever drive holds an image.
  if (currentD64) { try { showD64Directory(currentD64); } catch {} }
  if (currentD64Drive9) { try { showD64Directory(currentD64Drive9, DRIVE9_UI); } catch {} }
  setRunning(true);
  _syncPowerStateClass();
  _punchLogo();
  startLoop();
  _syncToggleLabels();
  resetBtn.disabled = false;
  pauseBtn.disabled = false;
  prgBtn.disabled   = false;
  if (pasteBtn) pasteBtn.disabled = false;
  if (d64Btn) d64Btn.disabled = false;
  if (d64NewBtn) d64NewBtn.disabled = false;
  if (tapBtn) tapBtn.disabled = false;
  if (crtBtn) crtBtn.disabled = false;
  if (saveStateBtn) saveStateBtn.disabled = false;
  // State restore does not perform a physical eject action. Reconcile all four
  // EJECT controls with both the restored media and anything still shown as
  // inserted, leaving explicit eject as the only action that disables them.
  _syncD64EjectButton();
  _syncD64Drive9EjectButton();
  _syncCRTEjectButton();
  _syncTapEjectButton();
  _syncWriteButtons();
  // The cart's RESET/FREEZE buttons gate on `running`, and the cached-cart
  // re-apply inside _createAndWireMachine() above synced them while it was
  // still false — re-sync now that the restored machine is running.
  _syncCartridgeControls();
  setStatus(`State loaded${entry.name ? `: ${entry.name}` : ''}`
    + (cartDropped ? ' – cartridge removed (none in the snapshot)' : '')
    + (badDisks.length ? ` – ${badDisks.join(' and ')} left empty (damaged disk image)` : ''),
    badDisks.length ? 'error' : 'running');
  canvas.focus();
  return true;
}

function _setStateImportStatus(text) {
  if (!stateImportStatusEl) return;
  stateImportStatusEl.textContent = text || '';
  stateImportStatusEl.hidden = !text;
}

let _stateRenderToken = 0;
async function _renderStateList() {
  const token = ++_stateRenderToken;
  const all = await stateList();
  if (token !== _stateRenderToken) return;
  all.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    || (b.savedAt || 0) - (a.savedAt || 0)
    || a.id.localeCompare(b.id));
  const q = (stateFilterEl?.value || '').trim().toLowerCase();
  const list = q ? all.filter(e => e.name.toLowerCase().includes(q)) : all;
  if (stateClearBtn)  stateClearBtn.style.display  = all.length ? '' : 'none';
  if (stateExportBtn) stateExportBtn.style.display = all.length ? '' : 'none';
  if (stateFilterEl)  stateFilterEl.style.display  = all.length ? '' : 'none';
  if (stateEmptyEl) {
    if (!all.length) {
      stateEmptyEl.textContent = 'No save states yet. Press 💾 SAVE STATE while a program is running to create one.';
      stateEmptyEl.hidden = false;
    } else if (!list.length) {
      stateEmptyEl.textContent = `No save states match “${q}”.`;
      stateEmptyEl.hidden = false;
    } else {
      stateEmptyEl.hidden = true;
    }
  }
  if (!stateListEl) return;
  stateListEl.innerHTML = list.map(e => {
    const whenRel = _libRelativeTime(e.savedAt);
    const whenAbs = (() => { try { return new Date(e.savedAt).toLocaleString(); } catch { return ''; } })();
    const name = _libEscapeHtml(e.name);
    const thumb = e.thumbnail
      ? `<img src="${e.thumbnail}" alt="" style="width:48px;height:auto;border:1px solid var(--border);border-radius:3px;image-rendering:pixelated;margin-right:8px;flex:0 0 auto">`
      : `<span style="display:inline-block;width:48px;height:30px;background:#111;border:1px solid var(--border);border-radius:3px;margin-right:8px;flex:0 0 auto"></span>`;
    return `<div class="lib-row" data-id="${_libEscapeHtml(e.id)}" title="Restore ${name}">
        ${thumb}
        <span class="lib-name">${name}</span>
        <span class="lib-meta">${_libFormatSize(e.size)}<span class="lib-date" title="${_libEscapeHtml(whenAbs)}"> · ${_libEscapeHtml(whenRel)}</span></span>
        <button class="lib-del lib-rename" data-rename="${_libEscapeHtml(e.id)}" title="Rename save state" aria-label="Rename">✎</button>
        <button class="lib-del lib-export" data-export="${_libEscapeHtml(e.id)}" title="Export this state to a c64emu file" aria-label="Export">⤓</button>
        <button class="lib-del" data-del="${_libEscapeHtml(e.id)}" title="Delete save state" aria-label="Delete">✕</button>
      </div>`;
  }).join('');
}

async function _openStateDialog() {
  if (!stateModal) return;
  stateModal.hidden = false;
  pushEscapeLayer(_stateEscape);
  _setStateImportStatus('');
  await _renderStateList();
  if (stateFilterEl && stateFilterEl.style.display !== 'none' && !_softKeyboardOnFocus()) {
    stateFilterEl.focus();
    stateFilterEl.select();
  }
}
function _closeStateDialog() { if (stateModal) stateModal.hidden = true; popEscapeLayer(_stateEscape); }
const _stateDialogIsOpen = () => stateModal && !stateModal.hidden;
const _stateEscape = { close: _closeStateDialog, isOpen: _stateDialogIsOpen };

if (saveStateBtn) saveStateBtn.addEventListener('click', _saveState);
if (loadStateBtn) loadStateBtn.addEventListener('click', _openStateDialog);
if (stateCloseBtn) stateCloseBtn.addEventListener('click', _closeStateDialog);
if (stateFilterEl) stateFilterEl.addEventListener('input', _renderStateList);
if (stateModal) {
  stateModal.addEventListener('click', e => { if (e.target === stateModal) _closeStateDialog(); });
}
if (stateClearBtn) {
  stateClearBtn.addEventListener('click', async () => {
    const ok = await confirmDialog('Delete all save states?', { title: 'Clear save states', okLabel: '🗑 CLEAR ALL' });
    if (ok) { await stateClear(); _renderStateList(); }
  });
}
// Export EVERY slot to one .c64states bundle file (mirrors the library export).
if (stateExportBtn) {
  stateExportBtn.addEventListener('click', async () => {
    const bundle = await stateExportAll();
    if (!bundle.states.length) { setStatus('No save states — nothing to export', 'error'); return; }
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url; a.download = `c64emu-states-${ts}.c64states`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const n = bundle.states.length;
    setStatus(`Exported ${n} save state${n === 1 ? '' : 's'} → ${a.download}`, 'idle');
  });
}
// Import a single .c64state OR a bundled .c64states (both handled by stateImportFile).
if (stateImportBtn && stateImportInput) {
  stateImportBtn.addEventListener('click', () => stateImportInput.click());
  stateImportInput.addEventListener('change', async () => {
    const file = stateImportInput.files && stateImportInput.files[0];
    stateImportInput.value = '';
    if (!file) return;
    if (_rejectWrongExt(file, ['.c64state', '.c64states', '.json'])) {
      _setStateImportStatus(`Not a save-state file — ${file.name}`);
      return;
    }
    _setStateImportStatus('Reading file…');
    let text;
    try { text = await file.text(); }
    catch { _setStateImportStatus(''); setStatus('Could not read the import file', 'error'); return; }
    const res = await stateImportFile(text, p =>
      _setStateImportStatus(`Importing ${p.done}/${p.total} — ${p.imported} imported`));
    if (res.error === 'parse')  { _setStateImportStatus(''); setStatus('Import failed — not valid JSON', 'error'); return; }
    if (res.error === 'format') { _setStateImportStatus(''); setStatus('Import failed — not a c64emu save-state', 'error'); return; }
    if (res.error === 'store')  { _setStateImportStatus(''); setStatus('Import failed — could not store', 'error'); return; }
    await _renderStateList();
    if (res.bundle) {
      const summary = res.invalid ? `${res.imported} imported, ${res.invalid} invalid` : `${res.imported} imported`;
      _setStateImportStatus(`Done — ${summary}`);
      setStatus(`Imported save states: ${summary}`, 'idle');
    } else {
      const name = res.names[0] || 'save state';
      _setStateImportStatus(`Imported “${name}”`);
      setStatus(`Imported save state “${name}”`, 'idle');
    }
  });
}

// (The "Export to VICE (.vsf)" feature is parked — its converter, templates,
// frame-align helper, and UI wiring are kept outside the shipped tree.)

if (stateListEl) {
  stateListEl.addEventListener('click', async e => {
    const exp = e.target.closest('[data-export]');
    if (exp) {
      const obj = await stateExport(exp.getAttribute('data-export'));
      if (!obj) { setStatus('Export failed — save state missing', 'error'); _renderStateList(); return; }
      const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safe = (obj.name || 'state').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'state';
      a.href = url; a.download = `${safe}.c64state`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`Exported “${obj.name}” → ${a.download}`, 'idle');
      return;
    }
    const ren = e.target.closest('[data-rename]');
    if (ren) {
      const id = ren.getAttribute('data-rename');
      const row = ren.closest('.lib-row');
      const current = row?.querySelector('.lib-name')?.textContent || '';
      const next = await promptDialog('Rename this save state:', {
        title: 'Rename save state', okLabel: '✎ RENAME', defaultValue: current, placeholder: 'Save state name',
      });
      if (next === null || next === '' || next === current) return;   // cancelled / blank / unchanged
      const okr = await stateRename(id, next);
      setStatus(okr ? `Renamed save state to “${next}”` : 'Rename failed — save state missing', okr ? 'idle' : 'error');
      await _renderStateList();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) { await stateDelete(del.getAttribute('data-del')); _renderStateList(); return; }
    const row = e.target.closest('.lib-row');
    if (!row) return;
    const entry = await stateLoad(row.getAttribute('data-id'));
    if (!entry) { setStatus('Save state missing or corrupt', 'error'); _renderStateList(); return; }
    _closeStateDialog();
    await _loadState(entry);
  });
}
// Keep keystrokes out of the C64 while the state modal is open. Escape is
// escape-stack.js's.
document.addEventListener('keydown', e => {
  if (!_stateDialogIsOpen()) return;
  e.stopImmediatePropagation();
}, { capture: true });

// Best-effort cache of a freshly loaded file into the LOAD library.
// libSave() is async (IndexedDB) and never throws/rejects, but guard both the
// synchronous call and the returned promise so a storage hiccup can't surface.
// A .wav never goes in: the audio is ~20x the size of the tape it encodes (a
// 6-minute side is ~17 MB against ~700 KB) and nothing replays it — it is
// converted to a .tap on the way in and that is what the deck holds. _loadTape
// caches the converted tape instead, so the library entry is the small,
// directly usable one. Guarding here rather than at each call site because the
// picker, drag-drop and LOAD ANY all pass raw file bytes through.
function _libRemember(type, name, data) {
  if (/\.(wav|dmp)$/i.test(name || '')) return;
  // Expansion-RAM images stay out of the Library: one 16 MB image would evict
  // most of a 512 MB cache, and there is nothing to re-run it from anyway.
  if (type === 'reu') return;
  try { libSave(type, name, data)?.catch(() => {}); } catch {}
}

function _startLoadedPRG(addr) {
  // Centralised post-load entry. Gated on the AUTORUN toggle. BASIC
  // programs (load addr $0801) need RUN so BASIC parses the SYS stub
  // at the right place; ML loads at other addresses are entered with
  // SYS <addr>.
  if (!getAutorunEnabled()) return null;
  _leavePristineBoot();
  if (addr === 0x0801) {
    machine.injectRun();
    return 'RUN';
  }
  machine.injectSys(addr);
  return `SYS ${addr}`;
}

function _reportPrgLoaded(addr, started, verb = 'loaded') {
  const hex = addr.toString(16).toUpperCase();
  if (started) {
    setStatus(`PRG ${verb} @ $${hex} – Running (${started})`, 'running');
  } else {
    const hint = addr === 0x0801 ? 'type RUN' : `type SYS ${addr}`;
    setStatus(`PRG ${verb} @ $${hex} — ${hint}`, 'idle');
  }
}

function _leavePristineBoot() {
  setPristineBoot(false);
  setHasBeenReady(true);
  resetFrameTiming?.();
}

// Wording for prgOverflow()'s verdict — see the rule and why it matters there.
// Is this really a disk image? Nothing inside a .d64 identifies the format, so
// its fixed size is the only check there is. Without it a truncated download or a
// renamed archive mounts happily and shows a directory of several hundred entries
// made of whatever bytes the file held.
function _d64SizeError(data, fileName = '') {
  if (d64Variant(data.length)) return null;
  const name = fileName ? `"${fileName}"` : 'That file';
  const kb = (data.length / 1024).toFixed(1);
  return `${name} is not a disk image — ${kb} KB is not a D64 size (170.8, 192 or 200.5 KB)`;
}

function _prgSizeError(data, fileName = '') {
  const bad = prgOverflow(data);
  if (!bad) return null;
  const name = fileName ? `"${fileName}"` : 'That file';
  if (bad.short) return `${name} has no load address — it is too short to be a PRG`;
  const kb = Math.max(1, Math.round(data.length / 1024));
  const hex = bad.addr.toString(16).toUpperCase().padStart(4, '0');
  return `${name} does not fit in the C64's memory — ${kb} KB loading at $${hex} runs past $FFFF`;
}

// A .prg is put on a disk of its own and inserted, so it behaves exactly like a
// .d64 from here on: a real LOAD by name, listable, re-loadable and exportable,
// AUTORUN deciding whether it starts, and the drive honouring the TDE setting.
// Inserting a disk does not reboot a C64, so this doesn't either — swapping one
// in goes through the same eject-then-attach the drive already does. Used by
// every PRG entry point (file picker, drag-drop, library).
function _insertPRG(data, verb = 'loaded', fileName = '') {
  const sizeError = _prgSizeError(data, fileName);
  if (sizeError) { setStatus(sizeError, 'error'); return; }
  // No drive to put a disk in (1541 ROM missing) — fall back to dropping the
  // bytes straight into RAM. That needs a clean machine, so it keeps the reset.
  const disk = machine?.drive1541 ? createPRGDisk(fileName || 'PROGRAM', data) : null;
  if (!disk) {
    const alreadyClean = _pristineBoot;   // capture before _hardReset() flips it back on
    if (!alreadyClean && !_hardReset()) return;
    _queueAutoLoad([
      { ready: true },
      { run: () => {
          const addr = machine.loadPRG(data);
          _reportPrgLoaded(addr, _startLoadedPRG(addr), verb);
        } },
    ]);
    if (!alreadyClean) setStatus('Reset — booting, then loading PRG…', 'running');
    return;
  }

  disk._libName = fileName || `${disk.diskName}.d64`;
  const startCmd = prgAutostart(data);
  _loadDisk(disk, { startCmd });
  // Powered off, the disk still goes in — but nothing will run until there is a
  // machine to run it, so say so rather than leaving a bare "disk loaded".
  if (!running) {
    setStatus(`"${disk.diskName}" is on a disk in drive 8 — press POWER ON`, 'idle');
    return;
  }
  // Machine code has no entry point we can trust, so say where it landed and let
  // the user SYS it themselves.
  if (!startCmd) {
    const addr = data[0] | (data[1] << 8);
    setTimeout(() => setStatus(`Loaded @ $${addr.toString(16).toUpperCase()} — type SYS ${addr} to start it`, 'idle'), 1200);
  }
}

// From the current state (no reset — continues from where the machine is), once
// BASIC is at the READY prompt, type LOAD"*",8,1 and — after the LOAD finishes —
// RUN. The command is chunk-fed (KERNAL keyboard buffer is only 10 bytes).
// A real disk is RUN — its first file is a loader by convention. A wrapped .prg
// passes what prgAutostart() read out of the program, which is null for machine
// code: that just loads and stops at READY, because nothing in the file says
// where its entry point is and a wrong SYS lands in the middle of data.
function _autoLoadDisk(startCmd = 'RUN\r', dev = 8) {
  const cmd = `LOAD"*",${dev},1\r`;
  _queueAutoLoad([
    { ready: true },
    { type: cmd },
    { loadDone: true },
    ...(startCmd ? [{ type: startCmd }] : []),
  ]);
  setStatus(startCmd ? `AUTORUN: ${cmd.trim()} + ${startCmd.trim()}…` : `${cmd.trim()}…`, 'running');
}

// From the current state (no reset), once BASIC is at READY, type LOAD, press
// RETURN, and press PLAY on the datasette. No auto-RUN — the KERNAL tape LOAD
// with no name loads the next program and returns to READY for the user.
function _autoLoadTape(playDelayMs = 0) {
  const steps = [
    { ready: true },
    { type: 'LOAD\r' },
  ];
  // Optional beat so the LOAD command (+ "PRESS PLAY ON TAPE") is visible
  // before we auto-press PLAY — used by library loads, which otherwise jump
  // straight from the closing dialog into a loading tape.
  if (playDelayMs > 0) steps.push({ wait: playDelayMs });
  steps.push({ run: () => machine.setTapePlayPressed(true) });
  _queueAutoLoad(steps);
  setStatus('AUTORUN: LOAD + PLAY…', 'running');
}

// Reject a picked file whose name doesn't end in an allowed extension. The OS
// file picker can't enforce `accept` for the C64's custom binary extensions:
// .d64/.prg/.crt/.tap are all unknown, so they resolve to application/octet-
// stream — and a plain .bin (the canonical octet-stream file) slips through
// every one of those selectors on both desktop and mobile. Guard by extension
// here so a wrong file is rejected with a clear message instead of loaded.
function _rejectWrongExt(file, exts, input) {
  const name = (file.name || '').toLowerCase();
  if (exts.some(ext => name.endsWith(ext))) return false;
  setStatus(`Wrong file type — expected ${exts.join(' / ')}, not "${file.name}"`, 'error');
  if (input) input.value = '';
  return true;
}

// ── LOAD ANY ─────────────────────────────────────────────────────────────────
// One button for every kind of C64 file: the extension decides what happens,
// the same way a dropped file is routed. Picking the right button for the file
// in your hand isn't something a user should have to think about.
export function mediaTypeOf(filename) {
  const n = String(filename || '').toLowerCase();
  return n.endsWith('.d64') ? 'd64'
    // A recording of a tape is a tape, and so is a DC2N dump of one: _loadTape
    // converts either on the way in.
    : (n.endsWith('.tap') || n.endsWith('.wav') || n.endsWith('.dmp')) ? 'tap'
    : n.endsWith('.prg') ? 'prg'
    : n.endsWith('.crt') ? 'crt'
    // Expansion-RAM images. Unlike the other types these are never cached in
    // the Library — a 16 MB image would evict everything else in it.
    : n.endsWith('.reu') ? 'reu' : null;
}

prgBtn.addEventListener('click', () => prgInput.click());
prgInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (_rejectWrongExt(file, ['.prg', '.d64', '.crt', '.tap', '.wav', '.dmp', '.reu'], prgInput)) return;
  const buf  = await file.arrayBuffer();
  const data = new Uint8Array(buf);
  const type = mediaTypeOf(file.name);
  _libRemember(type, file.name, data);
  prgInput.value = '';
  if (!running || !machine.ready) {
    setStatus(`${type.toUpperCase()} cached — POWER ON, then use 📂 LOAD LIB to run it`, 'idle');
    return;
  }
  await _loadLibraryEntry({ type, name: file.name, data });
});

// ── CRT (cartridge) loader ───────────────────────────────────────────────────
function _expandPanelOf(el) {
  const panel = el?.closest('.panel-card');
  if (!panel) return;
  panel.classList.add('expanded');
  const btn = panel.querySelector('.expand-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', 'true');
    btn.title = 'Collapse';
  }
}

function _collapsePanelOf(el) {
  const panel = el?.closest('.panel-card');
  if (!panel) return;
  panel.classList.remove('expanded');
  const btn = panel.querySelector('.expand-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Expand';
  }
}

function _setElementVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

export function _onCRTLoaded(info) {
  _currentCartInfo = info;
  if (crtLabel) crtLabel.textContent = `${info.name} (${info.mode})`;
  if (crtDropzone) crtDropzone.classList.add('loaded');
  _syncCRTEjectButton();
  _expandPanelOf(crtDropzone);
  _syncCartridgeControls();
  setStatus(`CRT: "${info.name}" (${info.mode}) inserted`, 'running');
}

export function _syncCartridgeControls() {
  const hasReset = !!_currentCartInfo?.hasReset;
  const hasFreeze = !!_currentCartInfo?.hasFreeze;
  const enabled = !!machine?.ready && running;
  _setElementVisible(crtResetBtn, hasReset);
  _setElementVisible(crtFreezeBtn, hasFreeze);
  if (crtResetBtn) crtResetBtn.disabled = !enabled;
  if (crtFreezeBtn) crtFreezeBtn.disabled = !enabled;
  if (!enabled || !hasFreeze) _releaseCartridgeFreeze();
}

function _holdCartridgeFreeze() {
  if (_cartridgeFreezeHeld || crtFreezeBtn?.disabled || !machine?.ready) return;
  _cartridgeFreezeHeld = machine.setCartridgeFreeze(true);
  if (_cartridgeFreezeHeld) {
    crtFreezeBtn?.classList.add('active');
    crtFreezeBtn?.setAttribute('aria-pressed', 'true');
    setStatus(`${_currentCartInfo?.name ?? 'Cartridge'}: FREEZE`, 'running');
  }
}

function _releaseCartridgeFreeze() {
  if (!_cartridgeFreezeHeld) return;
  machine?.setCartridgeFreeze(false);
  _cartridgeFreezeHeld = false;
  crtFreezeBtn?.classList.remove('active');
  crtFreezeBtn?.setAttribute('aria-pressed', 'false');
}

// Drop the cartridge UI without touching the machine. Needed when a save-state
// bundle carries no cartridge: _createAndWireMachine() only re-fires
// _onCRTLoaded() when there IS a cart to re-apply, so the previous cart's label
// and RESET/FREEZE buttons would otherwise survive into the restored session
// and act on a machine that has no cartridge installed.
function _forgetCartridgeUi() {
  _releaseCartridgeFreeze();
  _currentCartInfo = null;
  if (crtLabel) crtLabel.textContent = '';
  if (crtDropzone) crtDropzone.classList.remove('loaded');
}

function _ejectCRT() {
  _releaseCartridgeFreeze();
  if (machine?.ready) machine.ejectCartridge();
  if (machine?.ready) resetSidWorklet();
  _clearCachedCart();
  if (crtLabel) crtLabel.textContent = '';
  if (crtDropzone) crtDropzone.classList.remove('loaded');
  _syncCRTEjectButton();
  _currentCartInfo = null;
  _syncCartridgeControls();
  setStatus('Cartridge ejected' + (machine?.ready ? ' – Reset' : ''),
    machine?.ready ? 'running' : 'idle');
}

// Load a cart from raw bytes. Caches the data and applies to the live
// machine if powered on; when powered off, only the UI label is updated
// and the cart will be applied on the next power-on.
function _applyCart(data) {
  _cacheCart(data);
  if (machine?.ready) {
    const info = machine.loadCartridge(data);
    _leavePristineBoot();
    _onCRTLoaded(info);
    resetSidWorklet();
  } else {
    // Peek at the CRT name so the UI can label the cart even pre-boot.
    let name = 'cartridge', hwType = null;
    try {
      const cart = parseCRT(data);
      name = cart.name || name;
      hwType = cart.hwType;
    } catch {}
    const hasButtons = hwType === 1 || hwType === 3;
    _onCRTLoaded({
      name, hwType, mode: '(cached — applies on POWER ON)',
      hasReset: hasButtons, hasFreeze: hasButtons,
    });
  }
}

if (crtBtn && crtInput) {
  crtBtn.addEventListener('click', () => crtInput.click());
  crtInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (_rejectWrongExt(file, ['.crt'], crtInput)) return;
    const buf  = await file.arrayBuffer();
    const data = new Uint8Array(buf);
    try {
      _applyCart(data);
      _libRemember('crt', file.name, data);
    } catch (err) {
      setStatus(`CRT error: ${err.message}`, 'error');
    }
    crtInput.value = '';
  });
}

if (crtEjectBtn) {
  crtEjectBtn.addEventListener('click', _ejectCRT);
}
if (crtResetBtn) {
  crtResetBtn.addEventListener('click', () => {
    _releaseCartridgeFreeze();
    if (!machine?.resetCartridge()) return;
    resetSidWorklet();
    setStatus(`${_currentCartInfo?.name ?? 'Cartridge'}: RESET`, 'running');
    canvas.focus();
  });
}
if (crtFreezeBtn) {
  crtFreezeBtn.addEventListener('pointerdown', e => {
    if (crtFreezeBtn.disabled) return;
    e.preventDefault();
    crtFreezeBtn.setPointerCapture?.(e.pointerId);
    _holdCartridgeFreeze();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    crtFreezeBtn.addEventListener(type, _releaseCartridgeFreeze);
  }
  crtFreezeBtn.addEventListener('keydown', e => {
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
      e.preventDefault();
      _holdCartridgeFreeze();
    }
  });
  crtFreezeBtn.addEventListener('keyup', e => {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      _releaseCartridgeFreeze();
    }
  });
  window.addEventListener('blur', _releaseCartridgeFreeze);
}

// ── D64 loader ───────────────────────────────────────────────────────────────
function _onD64Loaded(disk) {
  currentD64 = disk;
  if (machine?.ready) machine.setD64(disk);
  showD64Directory(disk);
  _expandPanelOf(driveDropzone);
  _syncD64EjectButton();
  _syncWriteButtons();
  const suffix = machine?.ready ? '' : ' (cached — applies on POWER ON)';
  setStatus(`D64: "${disk.diskName}" loaded${suffix}`, machine?.ready ? 'running' : 'idle');
}

function _ejectD64() {
  // Save any pending writes before the disk leaves the drive.
  machine?.commitDriveWrites?.();
  _persistDirtyDisk(currentD64);
  currentD64 = null;
  if (machine?.ready) machine.setD64(null);
  if (driveEmptyHint) driveEmptyHint.style.display = '';
  _setElementVisible(driveLoaded, false);
  if (driveDropzone)  driveDropzone.classList.remove('loaded');
  if (d64DirEl)       d64DirEl.innerHTML = '';
  _syncD64EjectButton();
  _syncWriteButtons();
  setStatus('Disk ejected', machine?.ready ? 'running' : 'idle');
}

// Insert a disk image (no reset — continues from the current state). With
// AUTORUN on and powered up, it then auto-types LOAD"*",8,1 + RUN once BASIC is
// at the READY prompt. Otherwise it just attaches the disk and shows the
// directory.
//
// If a disk is already installed this is a media SWAP: run the EJECT procedure
// first, then attach the new disk after a short gap. A running program detects
// the change only when the drive actually goes empty (the not-ready /
// write-protect-open transition a physical eject produces) between the two
// disks. The emulator advances between these timer callbacks, so the drive is
// genuinely empty for that window — the same as ejecting then reinserting by
// hand.
const DISK_SWAP_EJECT_MS = 700;
function _loadDisk(disk, { autorun = true, startCmd = 'RUN\r' } = {}) {
  if (currentD64 && machine?.ready) {
    _ejectD64();                          // eject the installed disk now
    setTimeout(() => _attachDisk(disk, autorun, startCmd), DISK_SWAP_EJECT_MS);
    return;
  }
  _attachDisk(disk, autorun, startCmd);
}

function _attachDisk(disk, autorun = true, startCmd = 'RUN\r') {
  _onD64Loaded(disk);                     // attach (sets currentD64) + show directory
  // NEW / FORMAT pass autorun:false — a freshly created blank disk has nothing
  // to LOAD"*",8,1 + RUN, so the auto-load would just error.
  if (autorun && running && getAutorunEnabled()) _autoLoadDisk(startCmd);
}

if (d64Btn && d64Input) {
  d64Btn.addEventListener('click', () => d64Input.click());
  d64Input.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (_rejectWrongExt(file, ['.d64', '.prg'], d64Input)) return;
    const buf = await file.arrayBuffer();
    const data = new Uint8Array(buf);
    try {
      // A .prg dropped into the drive gets a disk of its own — same path from
      // here on, so the drive really is holding a disk with the program on it.
      if (mediaTypeOf(file.name) === 'prg') {
        _libRemember('prg', file.name, data);
        d64Input.value = '';
        _insertPRG(data, 'loaded', file.name);
        return;
      }
      const sizeError = _d64SizeError(data, file.name);
      if (sizeError) { setStatus(sizeError, 'error'); d64Input.value = ''; return; }
      _libRemember('d64', file.name, data);
      const disk = new D64(data);
      disk._libName = file.name;
      _loadDisk(disk);
    } catch (err) {
      setStatus(`D64 error: ${err.message}`, 'error');
    }
    d64Input.value = '';
  });
}

if (d64EjectBtn) {
  d64EjectBtn.addEventListener('click', _ejectD64);
}

// ── Disk write support (NEW / FORMAT / EXPORT / write-protect / dirty) ────────
// Descriptors so the two drives share one set of handlers. `get()` reads the
// live mounted D64; `drive()` is the 1541 that owns the write head.
const WRITE_DRIVES = [
  { num: 8, get: () => currentD64,       drive: () => machine?.drive1541,
    newBtn: d64NewBtn, wpBtn: d64WpBtn, formatBtn: d64FormatBtn, exportBtn: d64ExportBtn },
  { num: 9, get: () => currentD64Drive9, drive: () => machine?.drive1541b,
    newBtn: DRIVE9_UI.newBtn, wpBtn: DRIVE9_UI.wpBtn, formatBtn: DRIVE9_UI.formatBtn, exportBtn: DRIVE9_UI.exportBtn },
];

function _slug(name) {
  return String(name || '').trim().replace(/[^\w .!()+-]/g, '_').replace(/\s+/g, ' ').trim();
}

// A filename for exporting/persisting a disk: prefer the name it was loaded/created
// under, else its BAM disk name, always ending in .d64.
function _diskExportName(disk) {
  const base = disk._libName ? disk._libName.replace(/\.d64$/i, '') : _slug(disk.diskName);
  return `${_slug(base) || 'disk'}.d64`;
}

// Mount a disk into a drive, committing/ejecting whatever was there first.
function _mountDisk(num, disk) {
  if (num === 9) {
    if (currentD64Drive9) _ejectD64Drive9();   // setDisk() commits its pending writes
    _onD64Drive9Loaded(disk);
  } else {
    _loadDisk(disk, { autorun: false });       // blank disk: mount only, never auto-run
  }
  _syncWriteButtons();
}

// Reflect each drive's write state onto its buttons: FORMAT/EXPORT/WP enabled
// only with a disk present; WP shows 🔒 (protected) or 🔓 (writable); the dirty
// dot shows when the image has un-persisted changes.
function _syncWriteButtons() {
  for (const d of WRITE_DRIVES) {
    const disk = d.get();
    const has = !!disk;
    const prot = !disk || disk.writeProtected !== false;
    // FORMAT erases the disk, so it's a write — disabled while write-protected.
    if (d.formatBtn) d.formatBtn.disabled = !has || prot;
    // EXPORT downloads whatever is in the drive: any inserted disk can be saved
    // out, changed or not. The title still says when there are changes in it,
    // since that is the case where downloading actually matters.
    if (d.exportBtn) {
      const dirty = !!(disk && disk.dirty);
      d.exportBtn.disabled = !has;
      d.exportBtn.title = dirty
        ? 'Download this disk (with your changes) as a .d64 file'
        : 'Download this disk as a .d64 file';
    }
    if (d.wpBtn) {
      d.wpBtn.disabled = !has;
      // The 🔒/🔓 glyphs are injected SVGs; CSS picks one by aria-pressed.
      d.wpBtn.setAttribute('aria-pressed', prot ? 'true' : 'false');
      d.wpBtn.title = prot
        ? 'Write-protected — click to let the drive write to this disk'
        : 'Writable — click to write-protect this disk';
    }
  }
}

// Toggle a disk's write-protect (a session attribute — not stored in the .d64).
function _toggleWriteProtect(d) {
  const disk = d.get();
  if (!disk) return;
  const nextProtected = disk.writeProtected === false;   // flip
  disk.writeProtected = nextProtected;
  d.drive()?.setWriteProtect?.(nextProtected);
  _syncWriteButtons();
  setStatus(
    `Drive ${d.num}: ${nextProtected ? 'disk write-protected' : 'writing enabled'}`,
    machine?.ready ? 'running' : 'idle');
}

// Download the current image as a .d64, folding any pending head writes in first.
function _exportDisk(d) {
  const disk = d.get();
  if (!disk) return;
  machine?.commitDriveWrites?.();
  const name = _diskExportName(disk);
  const blob = new Blob([disk.img], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  disk.dirty = false;      // exported — nothing new to download until the next write
  _syncWriteButtons();
  setStatus(`Exported → ${name}`, machine?.ready ? 'running' : 'idle');
}

// Create a fresh blank formatted disk and mount it (write-enabled + dirty).
function _newDisk(d) {
  // Insert a RAW (unformatted) disk — all zeros, no BAM or directory. The user
  // FORMATs it (the FORMAT button, or BASIC "N:name,id" through the drive) before
  // it can hold files. Nothing to persist/export until it's formatted + written.
  const disk = new D64(new Uint8Array(174848));
  disk.writeProtected = false;   // so it can be formatted / written to
  // A raw image parses to null bytes for the name/ID; blank them so the listing
  // reads as unformatted (empty name, 0 blocks free) instead of garbage glyphs.
  disk.diskName = ''; disk.diskId = ''; disk.dosType = '';
  _mountDisk(d.num, disk);
  setStatus(`Drive ${d.num}: inserted a blank unformatted disk — FORMAT it to use`,
    machine?.ready ? 'running' : 'idle');
}

// Instant JS-level format: wipe the mounted disk to an empty formatted image.
// (A real low-level DOS format via BASIC "N:name,id" also works, through the
// write head, but this button never touches the drive so it can't fail.)
async function _formatDisk(d) {
  const disk = d.get();
  if (!disk) return;
  if (disk.writeProtected !== false) {   // erasing is a write — respect the lock
    setStatus(`Drive ${d.num}: disk is write-protected — unlock it (🔓) to format`, 'error');
    return;
  }
  const name = await promptDialog(
    'Formatting erases every file on this disk. Name the blank disk:', {
      title: `Format disk (drive ${d.num})`, okLabel: 'Format',
      defaultValue: (disk.diskName || '').trim() || 'BLANK',
    });
  if (name == null) return;
  // Formatting discards the old content, so don't let the swap-eject persist it.
  disk.dirty = false;
  const fresh = createBlankD64(String(name).toUpperCase().slice(0, 16), '00');
  fresh._libName = disk._libName || `${_slug(name) || 'blank'}.d64`;
  _libRemember('d64', fresh._libName, fresh.img.slice());
  fresh.dirty = false;   // just persisted to the Library — not "unsaved"
  _mountDisk(d.num, fresh);
  setStatus(`Drive ${d.num}: formatted "${fresh.diskName}"`, machine?.ready ? 'running' : 'idle');
}

for (const d of WRITE_DRIVES) {
  d.newBtn?.addEventListener('click', () => _newDisk(d));
  d.formatBtn?.addEventListener('click', () => _formatDisk(d));
  d.exportBtn?.addEventListener('click', () => _exportDisk(d));
  d.wpBtn?.addEventListener('click', () => _toggleWriteProtect(d));
  // Inject both PETSCII padlock glyphs once; CSS shows one per aria-pressed state.
  if (d.wpBtn) d.wpBtn.innerHTML = LOCK_CLOSED_SVG + LOCK_OPEN_SVG;
}

// Persist a modified disk to the Library (best-effort). Does NOT clear `dirty` —
// that flag gates the .d64 export button and is cleared only when you export.
function _persistDirtyDisk(disk) {
  if (!disk || !disk.dirty) return;
  _libRemember('d64', disk._libName || _diskExportName(disk), disk.img.slice());
}

// Directory signature — a cheap fingerprint of what the listing shows, so we only
// re-render when the directory actually changed (not on every data-sector write).
function _dirSignature(disk) {
  return disk.entries.map(e => `${e.name}\x01${e.blocks}\x01${e.typeCode}`).join('\x02') +
    `\x03${disk.freeBlocks}\x03${disk.diskName}`;
}

// Re-parse a disk from its (freshly committed) image and re-render its directory
// listing only if the directory changed. Cheap parse; DOM update gated by the sig.
function _refreshDiskDirectory(disk, ui) {
  if (!disk) return;
  disk._parse();
  const sig = _dirSignature(disk);
  if (sig === disk._dirSig) return;
  disk._dirSig = sig;
  try { showD64Directory(disk, ui); } catch {}
}

// Per-frame: once the drive has been quiet (LED off) for ~0.75 s after a write,
// fold the head writes into the image(s), refresh the on-screen directory if it
// changed, persist to the Library, and enable .d64 export. Triggered only by
// UNCOMMITTED writes, so it settles in one pass and doesn't hammer IndexedDB.
let _diskSaveQuiet = 0;
function _tickDiskWriteState(live) {
  if (!machine?.ready || !live) return;
  if (!machine.hasUnsavedDiskWrites?.()) { _diskSaveQuiet = 0; return; }
  const active = !!machine.drive1541?.ledOn || !!machine.drive1541b?.ledOn;
  if (active) { _diskSaveQuiet = 0; return; }   // still writing — wait for quiet
  if (++_diskSaveQuiet >= 45) {                 // ~0.75 s of drive quiet
    _diskSaveQuiet = 0;
    const wrote = machine.commitDriveWrites?.() || 0;
    if (wrote > 0) {
      _refreshDiskDirectory(currentD64, DRIVE8_UI);
      _refreshDiskDirectory(currentD64Drive9, DRIVE9_UI);
      _persistDirtyDisk(currentD64);
      _persistDirtyDisk(currentD64Drive9);
      _syncWriteButtons();
    }
  }
}

// Collapse/expand the directory listing inside a drive's dropzone. Shared by
// both drives — each remembers its own state via ui.dirExpanded.
function _wireDirToggle(ui) {
  if (!ui.dirToggle) return;
  ui.dirToggle.addEventListener('click', () => {
    ui.dirExpanded = !ui.dirExpanded;
    if (ui.dirEl) ui.dirEl.style.display = ui.dirExpanded ? '' : 'none';
    // update arrow while preserving file count text
    const txt = ui.dirToggle.textContent;
    ui.dirToggle.textContent = (ui.dirExpanded ? '▼' : '▶') + txt.slice(1);
  });
}
_wireDirToggle(DRIVE8_UI);
_wireDirToggle(DRIVE9_UI);

// ── Secondary drive (IEC device 9) ───────────────────────────────────────────
// Switched off by default and invisible to the C64 until the user turns it on.
// Once on, it has two modes, mirroring drive 8:
//   • TDE off → trap-backed: the $FFD5 KERNAL LOAD trap serves its disk image
//     directly when the C64 addresses device 9 (LOAD"…",9).
//   • TDE on  → a real second 1541 CPU runs on the IEC bus as device 9 (needed
//     for fastloaders). Requires the 1541 drive ROM to be loaded.
// Both the on/off and TDE choices are remembered across reloads.
export let currentD64Drive9 = null;
export let drive9Enabled = (() => {
  try { return localStorage.getItem('c64emu.drive9') === 'on'; } catch { return false; }
})();
export let drive9TdeEnabled = (() => {
  // On unless turned off, like drive 8 — a second drive is there for the
  // fastloaders that want two, and those need a real 1541 on the bus.
  try { return localStorage.getItem('c64emu.drive9tde') !== 'off'; } catch { return true; }
})();
let drive9LedUntil = 0;   // performance.now() timestamp the LED stays lit until

export function _flashDrive9Led() {
  try { drive9LedUntil = performance.now() + 220; } catch {}
}

// Whether disk drive 9's activity LED is currently lit: the real second drive's
// LED when TDE is on, or the brief trap-served-load flash otherwise. Mirrors the
// drive-9 LED logic in updateMediaIndicators so callers (e.g. the 3D model) can
// light a drive LED from either drive.
export function drive9LedActive() {
  let flash = false;
  try { flash = performance.now() < drive9LedUntil; } catch { flash = false; }
  return !!(machine?.drive1541b?.ledOn) || flash;
}

// `autorun` is opt-in: only a disk the user just inserted starts itself. The
// restore and NEW/FORMAT paths mount silently, the same distinction drive 8
// draws.
function _onD64Drive9Loaded(disk, { autorun = false, startCmd = 'RUN\r' } = {}) {
  currentD64Drive9 = disk;
  if (machine?.ready) machine.setD64Drive9(disk);
  showD64Directory(disk, DRIVE9_UI);
  _expandPanelOf(DRIVE9_UI.deck);
  _syncD64Drive9EjectButton();
  _syncWriteButtons();
  if (autorun && running && getAutorunEnabled()) { _autoLoadDisk(startCmd, 9); return; }
  const suffix = machine?.ready ? '' : ' (cached — applies on POWER ON)';
  setStatus(`Drive 9: "${disk.diskName}" loaded${suffix}`, machine?.ready ? 'running' : 'idle');
}

function _ejectD64Drive9() {
  machine?.commitDriveWrites?.();
  _persistDirtyDisk(currentD64Drive9);
  currentD64Drive9 = null;
  if (machine?.ready) machine.setD64Drive9(null);
  if (DRIVE9_UI.emptyHint) DRIVE9_UI.emptyHint.style.display = '';
  _setElementVisible(DRIVE9_UI.loadedEl, false);
  if (DRIVE9_UI.dropzone)  DRIVE9_UI.dropzone.classList.remove('loaded');
  if (DRIVE9_UI.dirEl)     DRIVE9_UI.dirEl.innerHTML = '';
  _syncD64Drive9EjectButton();
  _syncWriteButtons();
  setStatus('Drive 9: disk ejected', machine?.ready ? 'running' : 'idle');
}

// Flip device 9 on/off. When on, the drive deck is revealed (and the card
// expanded) and device 9 starts answering the load trap; when off it goes
// invisible to the C64 again. The disk image stays cached, so toggling back on
// re-presents the same disk.
function _setDrive9Power(on, { persist = true } = {}) {
  drive9Enabled = !!on;
  if (DRIVE9_UI.powerSwitch) DRIVE9_UI.powerSwitch.checked = drive9Enabled;
  if (DRIVE9_UI.deck)        DRIVE9_UI.deck.hidden = !drive9Enabled;
  if (drive9Enabled) {
    if (DRIVE9_UI.loadBtn) DRIVE9_UI.loadBtn.disabled = false;
    if (DRIVE9_UI.newBtn)  DRIVE9_UI.newBtn.disabled = false;
    _expandPanelOf(DRIVE9_UI.deck);     // reveal the controls when switching on
  } else {
    _collapsePanelOf(DRIVE9_UI.deck);   // deck is hidden when off — collapse the empty body
  }
  if (machine?.ready) machine.setDrive9Enabled(drive9Enabled);
  _applyDrive9Tde();   // power-off tears down a running TDE drive; power-on may bring it up
  if (persist) { try { localStorage.setItem('c64emu.drive9', drive9Enabled ? 'on' : 'off'); } catch {} }
}

// Reflect the drive-9 TDE button's enabled/label/lit state. The button is only
// usable when device 9 is on AND the 1541 drive ROM is loaded.
export function _syncDrive9TdeBtn() {
  if (!DRIVE9_UI.tdeBtn) return;
  const canTde = drive9Enabled && !!loader?.drive1541;
  DRIVE9_UI.tdeBtn.disabled = !canTde;
  DRIVE9_UI.tdeBtn.textContent = drive9TdeEnabled ? 'TDE: ON' : 'TDE: OFF';
  DRIVE9_UI.tdeBtn.classList.toggle('tde-on', drive9TdeEnabled && canTde);
}

// Connect or disconnect the real device-9 drive to match the current intent.
// It is active only when intent (drive9TdeEnabled) + power + ROM + a live
// machine all hold; otherwise device 9 falls back to its trap-served mode.
export function _applyDrive9Tde() {
  const active = drive9TdeEnabled && drive9Enabled && !!loader?.drive1541;
  if (machine?.ready) {
    if (active) machine.attachDrive9(loader.drive1541);
    else        machine.detachDrive9();
  }
  _syncDrive9TdeBtn();
}

if (DRIVE9_UI.powerSwitch) {
  // The switch lives in the clickable card header; keep its clicks from also
  // toggling the panel's expand/collapse.
  if (DRIVE9_UI.powerSwitchEl) {
    DRIVE9_UI.powerSwitchEl.addEventListener('click', e => e.stopPropagation());
  }
  DRIVE9_UI.powerSwitch.addEventListener('change', async () => {
    const on = DRIVE9_UI.powerSwitch.checked;
    // Every turn-on warns that a second drive on the bus can disturb the
    // cycle-exact timing some demos rely on; declining reverts the switch.
    if (on) {
      const proceed = await confirmDialog(
        'Demos might not work when disk drive 9 is active.',
        { title: 'Disk drive 9', okLabel: 'Turn on' });
      if (!proceed) { DRIVE9_UI.powerSwitch.checked = false; return; }
    }
    _setDrive9Power(on);
  });

  // The whole drive-9 card header doubles as the power control: clicking it
  // (anywhere but the switch, whose clicks are stopPropagation'd above) toggles
  // the power switch — turning the drive on shows the first-time warning and
  // reveals the deck, rather than just expanding an empty, disconnected panel.
  const drive9Header = DRIVE9_UI.deck?.closest('.panel-card')?.querySelector('.panel-card-header');
  if (drive9Header) {
    drive9Header.classList.add('header-clickable');
    drive9Header.addEventListener('click', () => {
      DRIVE9_UI.powerSwitch.checked = !DRIVE9_UI.powerSwitch.checked;
      DRIVE9_UI.powerSwitch.dispatchEvent(new Event('change'));
    });
  }
}

if (DRIVE9_UI.tdeBtn) {
  DRIVE9_UI.tdeBtn.addEventListener('click', () => {
    if (DRIVE9_UI.tdeBtn.disabled) return;
    drive9TdeEnabled = !drive9TdeEnabled;
    try { localStorage.setItem('c64emu.drive9tde', drive9TdeEnabled ? 'on' : 'off'); } catch {}
    _applyDrive9Tde();
  });
  _syncDrive9TdeBtn();
}

if (DRIVE9_UI.loadBtn && DRIVE9_UI.fileInput) {
  DRIVE9_UI.loadBtn.addEventListener('click', () => DRIVE9_UI.fileInput.click());
  DRIVE9_UI.fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (_rejectWrongExt(file, ['.d64', '.prg'], DRIVE9_UI.fileInput)) return;
    const buf = await file.arrayBuffer();
    const data = new Uint8Array(buf);
    try {
      // A .prg gets a disk of its own here too, so drive 9 holds the same kind of
      // thing drive 8 would, and inserting it starts it — AUTORUN means the same
      // in either drive, and on the datasette.
      const isPrg = mediaTypeOf(file.name) === 'prg';
      const sizeError = isPrg ? _prgSizeError(data, file.name) : _d64SizeError(data, file.name);
      if (sizeError) { setStatus(sizeError, 'error'); DRIVE9_UI.fileInput.value = ''; return; }
      const disk = isPrg ? createPRGDisk(file.name, data) : new D64(data);
      if (!disk) { setStatus('Drive 9: program too large for a disk', 'error'); return; }
      _libRemember(isPrg ? 'prg' : 'd64', file.name, data);
      disk._libName = file.name;
      _onD64Drive9Loaded(disk, { autorun: true, startCmd: isPrg ? prgAutostart(data) : 'RUN\r' });
    } catch (err) {
      setStatus(`Drive 9 D64 error: ${err.message}`, 'error');
    }
    DRIVE9_UI.fileInput.value = '';
  });
}

if (DRIVE9_UI.ejectBtn) {
  DRIVE9_UI.ejectBtn.addEventListener('click', _ejectD64Drive9);
}

// ── RAM Expansion Unit ───────────────────────────────────────────────────────
// Nothing is on the expansion port by default; the power switch fits a unit and
// the <select> says which one. Swapping the unit swaps the hardware, so its
// contents go with it. A cartridge may stay inserted alongside — on real
// hardware that pairing needs a port expander, and the REU only claims
// $DF00-$DF0A of IO2. Both choices are remembered across reloads.
export let reuEnabled = (() => {
  try { return localStorage.getItem('c64emu.reu') === 'on'; } catch { return false; }
})();
export let reuUnit = (() => {
  try { return localStorage.getItem('c64emu.reuModel') || REU_DEFAULT_MODEL; }
  catch { return REU_DEFAULT_MODEL; }
})();

// Name of the last .reu image loaded into the fitted unit, so the card can say
// what is in there. Cleared whenever the RAM is wiped or the unit swapped.
let _reuImageName = null;

// Expansion RAM is not media: there is no cached image to re-present, so a
// fresh machine simply gets an empty unit of the chosen model.
export function _applyReu() {
  if (machine?.ready) {
    if (reuEnabled) machine.attachReu(reuUnit);
    else machine.detachReu();
  }
  _syncReuUI();
}

function _syncReuUI() {
  const m = reuModel(reuUnit);
  if (REU_UI.powerSwitch) REU_UI.powerSwitch.checked = reuEnabled;
  if (REU_UI.deck)        REU_UI.deck.hidden = !reuEnabled;
  if (REU_UI.unitSel)     REU_UI.unitSel.value = reuUnit;
  if (REU_UI.label) {
    const size = m.kb >= 1024 ? `${m.kb / 1024} MB` : `${m.kb} KB`;
    REU_UI.label.textContent = _reuImageName
      ? `${size} · ${_reuImageName}` : `${size} free`;
  }
}

// Expansion-RAM activity light, the same lamp the disk drives use. A transfer
// is over long before the next frame — 64K takes 65 ms at most and most are
// microseconds — so a burst latches the light on for a beat, exactly the way a
// trap-served drive load flashes it.
let _reuLedUntil = 0;
let _reuLedTick = -1;

function _updateReuLed(now) {
  const led = REU_UI.led;
  if (!led) return;
  const reu = machine?.ready ? machine.reu : null;
  if (reu && reu.activityTick !== _reuLedTick) {
    if (_reuLedTick >= 0) _reuLedUntil = now + 220;
    _reuLedTick = reu.activityTick;
  }
  led.classList.toggle('active', !!reu && now < _reuLedUntil);
}

function _setReuPower(on, { persist = true } = {}) {
  reuEnabled = !!on;
  if (reuEnabled) _expandPanelOf(REU_UI.deck);    // reveal the controls when fitting
  else            _collapsePanelOf(REU_UI.deck);  // deck is hidden when off
  if (!reuEnabled) _reuImageName = null;
  _applyReu();
  // persist=false is the import-time restore of a remembered choice, which is
  // not a user action and has no business writing the status line.
  if (persist) {
    try { localStorage.setItem('c64emu.reu', reuEnabled ? 'on' : 'off'); } catch {}
    if (reuEnabled && !machine?.ready) {
      setStatus('RAM Expansion fitted — applies on POWER ON', 'idle');
    }
  }
}

if (REU_UI.powerSwitch) {
  // The switch lives in the clickable card header; keep its clicks from also
  // toggling the panel's expand/collapse.
  if (REU_UI.powerSwitchEl) {
    REU_UI.powerSwitchEl.addEventListener('click', e => e.stopPropagation());
  }
  // Action Replay, Final Cartridge III and EasyFlash all decode addresses in
  // $DF00-$DFFF, which is where the expansion answers, so those cartridges and
  // a fitted expansion break each other. Real hardware conflicts the same way.
  // The warning goes up on every turn-on rather than only when such a cart is
  // already inserted: the clash is symmetric, and inserting the cartridge
  // afterwards is just as likely — there is no second moment to warn at.
  REU_UI.powerSwitch.addEventListener('change', async () => {
    const on = REU_UI.powerSwitch.checked;
    if (on) {
      const proceed = await confirmDialog(
        'Action Replay, Final Cartridge III and EasyFlash cartridges will not work while a RAM Expansion is fitted.',
        { title: 'RAM Expansion', okLabel: 'Turn on' });
      if (!proceed) { REU_UI.powerSwitch.checked = false; return; }
    }
    _setReuPower(on);
  });

  // The whole header doubles as the power control, matching disk drive 9.
  const reuHeader = REU_UI.card?.querySelector('.panel-card-header');
  if (reuHeader) {
    reuHeader.classList.add('header-clickable');
    reuHeader.addEventListener('click', () => {
      REU_UI.powerSwitch.checked = !REU_UI.powerSwitch.checked;
      REU_UI.powerSwitch.dispatchEvent(new Event('change'));
    });
  }
}

if (REU_UI.unitSel) {
  REU_UI.unitSel.addEventListener('change', async e => {
    const next = e.target.value;
    if (next === reuUnit) return;
    // Swapping the unit throws its contents away. Only worth asking about when
    // the user put something in there deliberately — scanning up to 16 MB for a
    // stray non-zero byte on every change is not worth the answer.
    if (_reuImageName) {
      const ok = await confirmDialog(
        'Changing the RAM Expansion unit discards everything currently in expansion RAM.',
        { title: 'Change expansion unit', okLabel: 'CHANGE' });
      if (!ok) { REU_UI.unitSel.value = reuUnit; return; }
    }
    _reuImageName = null;
    reuUnit = next;
    try { localStorage.setItem('c64emu.reuModel', next); } catch {}
    _applyReu();
  });
}

// Load a .reu image, from the card's own button or from a file dropped on the
// screen. An image bigger than the fitted unit gets a unit big enough to hold
// it rather than being silently cut short, and dropping one onto a machine with
// no expansion fits one instead of doing nothing.
function _loadReuImage(data, name) {
  const bigEnough = m => m.kb * 1024 >= data.length;
  if (!bigEnough(reuModel(reuUnit))) {
    const upgrade = REU_MODELS.find(bigEnough);
    if (upgrade) {
      reuUnit = upgrade.id;
      try { localStorage.setItem('c64emu.reuModel', reuUnit); } catch {}
    }
  }
  if (!reuEnabled) _setReuPower(true);
  else _applyReu();                  // re-fit if the unit just changed
  const reu = machine?.ready ? machine.reu : null;
  if (!reu) {
    setStatus('RAM Expansion: POWER ON before loading an image', 'error');
    return false;
  }
  reu.loadImage(data);
  _reuImageName = name;
  _syncReuUI();
  const short = data.length > reu.ram.length
    ? ` (truncated to ${(reu.ram.length / 1024) | 0} KB)` : '';
  setStatus(`RAM Expansion: loaded ${name}${short}`, 'running');
  return true;
}

if (REU_UI.loadBtn && REU_UI.fileInput) {
  REU_UI.loadBtn.addEventListener('click', () => REU_UI.fileInput.click());
  REU_UI.fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (_rejectWrongExt(file, ['.reu', '.bin'], REU_UI.fileInput)) return;
    _loadReuImage(new Uint8Array(await file.arrayBuffer()), file.name);
    REU_UI.fileInput.value = '';
  });
}

if (REU_UI.exportBtn) {
  REU_UI.exportBtn.addEventListener('click', () => {
    const reu = machine?.ready ? machine.reu : null;
    if (!reu) { setStatus('RAM Expansion: nothing to export', 'error'); return; }
    const name = `${reuModel(reuUnit).label.toLowerCase().replace(/\s+/g, '')}.reu`;
    const blob = new Blob([reu.ram], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported → ${name}`, 'running');
  });
}

if (REU_UI.blankBtn) {
  REU_UI.blankBtn.addEventListener('click', async () => {
    const reu = machine?.ready ? machine.reu : null;
    if (!reu) { setStatus('RAM Expansion: nothing to blank', 'error'); return; }
    const ok = await confirmDialog('Wipe expansion RAM back to all zeroes?',
      { title: 'Blank expansion RAM', okLabel: 'BLANK' });
    if (!ok) return;
    reu.clearRam();
    _reuImageName = null;
    _syncReuUI();
    setStatus('RAM Expansion: blanked', 'running');
  });
}

// ── TAP (Datasette) loader ───────────────────────────────────────────────────
function _applyTap(data, name) {
  _cacheTap(data, name);
  if (machine?.ready) machine.loadTap(data);
  _onTapLoaded(name, data);
}

// Which files on a tape will not load, read off the tape rather than taken from
// what an import happened to report — so a .tap opened directly is judged the
// same way a recording is. Costs a few milliseconds: the whole tape is decoded.
function _tapeDamagedNames(data) {
  try {
    return tapDirectory(data.subarray(20), { version: data[12] })
      .filter(f => f.damaged).map(f => f.name.trim());
  } catch { return []; }
}

// Insert a tape image (no reset — continues from the current state). With
// AUTORUN on and powered up, it then auto-types LOAD + presses PLAY once BASIC
// is at the READY prompt. Otherwise it just attaches the tape.
// A .wav is a recording of a tape, so it becomes a tape on the way in: the pulse
// widths are recovered and written out as a .tap, and from there nothing knows
// the difference — transport, scrubber, save-states and both exports all work on
// it. Converting here rather than at each entry point means the file picker,
// drag-drop and the library all get it.
async function _tapeBytesFrom(data, name) {
  if (/\.dmp$/i.test(name || '')) return _tapeFromDump(data, name);
  if (!/\.wav$/i.test(name || '')) return { data, name };
  // Reading it takes long enough to look like a hang, so it is done off the main
  // thread and says which pass it is on. What comes back is already mended: a
  // transfer of an old tape often loses the tail of a block's repeat copy, and
  // the KERNAL reads both copies before it returns — so the file lands in memory
  // and the load then hangs or errors. Where the first copy's checksum proves
  // itself, the second is written again from it, and a turbo file, written to
  // the tape only once, is mended from a second reading of the recording.
  _showWavImport(name);
  let read;
  try {
    read = await importWav(data, (stage, at) => _wavImportProgress(stage, at));
  } finally {
    await _hideWavImport();
  }
  return _tapeImported(read, name);
}

// A DC2N dump is the tape as the cassette port saw it — pulse widths already,
// no audio to read — so it converts in a moment, here. The KERNAL's copy-merge
// repair applies as to any tape; the turbo mend does not, there being no
// recording to read a second time.
function _tapeFromDump(data, name) {
  const dump = dmpToTap(data);
  const fixed = repairTape(dump.tap);
  const files = tapDirectory(fixed.tap.subarray(20), { version: fixed.tap[12] });
  return _tapeImported({
    tap: fixed.tap, pulses: dump.pulses, seconds: dump.seconds,
    repaired: fixed.repaired, unconfirmed: [],
    damagedNames: files.filter(f => f.damaged).map(f => f.name.trim()),
    files: files.length,
    machine: dump.machine,
  }, name);
}

/** What an import turned out to hold, as the tape the deck is handed. */
function _tapeImported(read, name) {
  if (!read.pulses) throw new Error('no tape pulses found in that recording');
  // What the recording turned out to hold, for the Status card. _applyTap has
  // the last word on that line, so this travels with the tape rather than being
  // written here and overwritten a moment later.
  const said = [_fmtClock(read.seconds), `${read.files} file${read.files === 1 ? '' : 's'}`];
  // A dump says which machine it was taken from. Another machine's tape still
  // plays — a pulse lasts as long on this port as it did there — but its
  // programs will not run here, so it is worth a word.
  if (read.machine && read.machine !== 'C64') said.push(`dumped from a ${read.machine}`);
  // Whatever the tape could not deliver whole, mended or not — a turbo file the
  // tape lost part of counts, and no repair can reach that one. Just that
  // something was wrong: which file it was is on its own row in the listing.
  if (read.repaired.length || read.damagedNames.length) said.push('errors detected');
  return {
    data: read.tap,
    name: name.replace(/\.(wav|dmp)$/i, '.tap'),
    from: name,
    note: said.join(' · '),
    repaired: read.repaired,
    unconfirmed: read.unconfirmed || [],
    damagedNames: read.damagedNames,
    bad: read.damagedNames.length > 0,
  };
}

// ── The reading-a-recording dialog ───────────────────────────────────────────
let _wavImportAt = 0;

function _showWavImport(name) {
  if (!wavImportModal) return;
  _wavImportAt = 0;
  if (wavImportName) wavImportName.textContent = name;
  if (wavImportFill) wavImportFill.style.width = '0%';
  if (wavImportStage) wavImportStage.textContent = 'Reading the recording';
  wavImportModal.hidden = false;
}

function _wavImportProgress(stage, at) {
  const { text, value } = importProgress(stage, at);
  // A bar that goes backwards reads as a fault even when the work is fine, so it
  // only ever moves forward — the stage line says what is actually happening.
  _wavImportAt = Math.max(_wavImportAt, value);
  if (wavImportFill) wavImportFill.style.width = `${Math.round(_wavImportAt * 100)}%`;
  if (wavImportStage) wavImportStage.textContent = text;
}

// Long enough for the bar to travel to the end and be seen there — the fill has
// a 180ms transition, and a dialog that vanishes at 90% reads as a failure.
const WAV_IMPORT_FINISH_MS = 320;

function _hideWavImport() {
  if (!wavImportModal) return Promise.resolve();
  _wavImportAt = 1;
  if (wavImportFill) wavImportFill.style.width = '100%';
  if (wavImportStage) wavImportStage.textContent = 'Done';
  return new Promise(done => setTimeout(() => {
    wavImportModal.hidden = true;
    done();
  }, WAV_IMPORT_FINISH_MS));
}

async function _loadTape(data, name, { playDelayMs = 0 } = {}) {
  const tape = await _tapeBytesFrom(data, name);
  // The caller cached the file it was handed, except a .wav, which _libRemember
  // refuses. Cache the tape recovered from it instead: same content, a twentieth
  // of the bytes, and directly replayable.
  if (tape.name !== name) _libRemember('tap', tape.name, tape.data);
  _applyTap(tape.data, tape.name);        // attach (caches _cachedTapData) + UI
  // A recording says so: it went in as audio, and what came out of it is worth
  // reading — how much, how many files, and whether any needed mending.
  if (tape.note) {
    _tapeRepairs = tape.repaired;
    _tapeUnconfirmed = tape.unconfirmed || [];
    _tapeDamaged = tape.damagedNames;
    setStatus(`${/\.dmp$/i.test(tape.from) ? 'DMP' : 'WAV'} "${tape.from}" → tape · ${tape.note}${_tapeHint()}`,
      tape.bad ? 'error' : machine?.ready ? 'running' : 'idle');
  }
  if (running && getAutorunEnabled()) _autoLoadTape(playDelayMs);
}

if (tapBtn && tapInput) {
  tapBtn.addEventListener('click', () => tapInput.click());
  tapInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (_rejectWrongExt(file, ['.tap', '.wav', '.dmp'], tapInput)) return;
    const buf = await file.arrayBuffer();
    const data = new Uint8Array(buf);
    try {
      _libRemember('tap', file.name, data);
      await _loadTape(data, file.name);
    } catch (err) {
      setStatus(`TAP error: ${err.message}`, 'error');
    }
    tapInput.value = '';
  });
}

export function _onTapLoaded(name, data) {
  const label = name.replace(/\.tap$/i, '');
  if (tapLabel) tapLabel.textContent = label;
  _syncTapEjectButton();
  _syncTapeButtons();

  if (tapeBar) {
    tapeBar.style.width = '0%';
    tapeBar.classList.remove('at-end', 'recording');
  }
  if (tapeTime && machine?.datasette) {
    tapeTime.textContent = _fmtTime(0, machine.datasette.durationSeconds);
  }
  if (tapeCounter) tapeCounter.textContent = '000';
  _tapeRepairs = [];
  _tapeUnconfirmed = [];
  // A tape says for itself what it holds, so a plain .tap reports its damage too
  // — a recording overwrites this a moment later with what its import found.
  _tapeDamaged = data ? _tapeDamagedNames(data) : [];
  if (tapeDropzone) tapeDropzone.classList.add('loaded');
  _expandPanelOf(tapeDropzone);
  if (machine?.ready) machine.setTapeKey('STOP');
  setStatus(`TAP: "${name}"${_tapeDamaged.length ? ' · errors detected' : ''}${_tapeHint()}`,
    _tapeDamaged.length ? 'error' : machine?.ready ? 'running' : 'idle');
}

// What to do next with a tape that has just gone in, or why nothing happens yet.
const _tapeHint = () => (machine?.ready
  ? ' — type LOAD then click PLAY'
  : ' (cached — applies on POWER ON)');

const _fmtClock = s => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2,'0')}s`;

function _fmtTime(elapsed, total) {
  if (!total) return `${Math.floor(elapsed)}s`;
  return `${_fmtClock(elapsed)} / ${_fmtClock(total)}`;
}

// The five mechanical keys. Only one can be down at a time, which is the
// mechanism's own rule, so each button just names its key. Winding needs the
// C64 to energise the motor line — that is how a real deck behaves, and the
// KERNAL obliges as soon as SENSE goes low.
const TAPE_KEYS = [
  [() => tapRecBtn, 'REC'],
  [() => tapPlayBtn, 'PLAY'],
  [() => tapRewBtn, 'REW'],
  [() => tapFfBtn, 'FF'],
  [() => tapStopBtn, 'STOP'],
];
// REC, PLAY and STOP latch on a click, as the mechanism does. REW and F.FWD run
// only while held — press or touch to wind, let go to stop — which is how you hunt
// for a program without reaching for STOP after every nudge.
const MOMENTARY_KEYS = new Set(['REW', 'FF']);

function _wireLatchingKey(btn, key) {
  btn.addEventListener('click', () => {
    if (key !== 'STOP' && !machine?.datasette?.hasMedia) return;
    if (!machine.setTapeKey(key)) {
      // Only RECORD refuses, and only for the tabs.
      setStatus('Tape is write-protected — click the padlock to enable writing', 'error');
      return;
    }
    if (key === 'REC') setStatus('RECORD engaged — SAVE from the C64 to write to tape', 'running');
    _syncTapeButtons();
  });
}

function _wireMomentaryKey(btn, key) {
  const press = (e) => {
    if (!machine?.datasette?.hasMedia) return;
    // Capture so the release still lands here if the finger slides off the key.
    try { btn.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    if (machine.setTapeKey(key)) _syncTapeButtons();
    e.preventDefault();          // no focus steal, no text selection, no page pan
  };
  // Release only OUR key: winding into the end of the tape already parked the
  // transport (see _wind), and a key pressed since then isn't ours to drop.
  const release = () => {
    if (machine?.datasette?.key !== key) return;
    machine.setTapeKey('STOP');
    _syncTapeButtons();
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
  // Keyboard equivalent: hold Enter or Space to wind. Without this the key would
  // be dead to anyone not using a pointer, since there is no click to latch.
  btn.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
    if (!machine?.datasette?.hasMedia) return;
    if (machine.setTapeKey(key)) _syncTapeButtons();
    e.preventDefault();
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    release();
    e.preventDefault();
  });
}

for (const [getBtn, key] of TAPE_KEYS) {
  const btn = getBtn();
  if (!btn) continue;
  if (MOMENTARY_KEYS.has(key)) _wireMomentaryKey(btn, key);
  else _wireLatchingKey(btn, key);
}

// Jump to the head of the tape. Not a key a 1530 has: it is the emulator's
// shortcut past a minute of winding.
if (tapStartBtn) {
  tapStartBtn.addEventListener('click', () => {
    if (!machine.datasette.hasMedia) return;
    machine.rewindTape();
    if (tapeBar)  { tapeBar.style.width = '0%'; tapeBar.classList.remove('at-end'); }
    if (tapLabel) tapLabel.textContent = tapLabel.textContent.replace(/ \[END\]$/, '');
    if (tapeTime) tapeTime.textContent = _fmtTime(0, machine.datasette.durationSeconds);
    _syncTapeButtons();
  });
}

// A tape's name is both the deck label and the .tap file you download, so it must
// be a legal file name on macOS and Windows. Rather than blocklist their union
// (Windows bars < > : " / \ | ? * control codes and a trailing dot or space; macOS
// bars / and treats : as a separator), allow only what is safe everywhere —
// uppercased, which is how the C64 shows a tape name anyway.
const TAPE_NAME_MAX = 12;
const TAPE_NAME_ALLOWED = /^[A-Z0-9 _-]+$/;
// Windows still refuses these as file names, extension or not.
const TAPE_NAME_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

// Ask for a tape name, re-asking until it is usable (or null if cancelled).
async function _promptTapeName() {
  let message = `Name the blank tape — up to ${TAPE_NAME_MAX} characters:`;
  for (;;) {
    const raw = await promptDialog(message, {
      title: 'Insert a blank tape',
      okLabel: 'Insert',
      defaultValue: 'BLANK',
      placeholder: 'A-Z 0-9 space - _',
      maxLength: TAPE_NAME_MAX,
      uppercase: true,          // a C64 tape name is uppercase; show that as typed
    });
    if (raw == null) return null;
    // Trailing dots and spaces are legal to type but not to save on Windows.
    const name = raw.trim().toUpperCase().slice(0, TAPE_NAME_MAX).replace(/[. ]+$/, '');
    if (!name) {
      message = `The tape needs a name — up to ${TAPE_NAME_MAX} characters:`;
    } else if (!TAPE_NAME_ALLOWED.test(name)) {
      message = `“${raw.trim()}” has characters a file name can't use. `
        + 'Letters, digits, space, - and _ only:';
    } else if (TAPE_NAME_RESERVED.test(name)) {
      message = `“${name}” is a name Windows reserves for a device. Try another:`;
    } else {
      return name;
    }
  }
}

// Bar, counter and time for wherever the tape sits. Split out because the scrubber
// repaints on every pointer move and must not run the whole indicator pass — the
// debounced Library-save counters in there advance per call, so a drag would race
// them.
// True while the pointer is previewing a position on the bar, so the per-frame
// tick leaves the clock alone — it would otherwise repaint the real position
// 50 times a second and the preview would never be visible.
let _tapeTimeHover = false;

function _refreshTapeReadout(ds) {
  // While recording the tape is growing under the head, so a fraction of "total"
  // would be meaningless — the bar just reads as active.
  if (tapeBar) {
    const rec = !!ds.recording;
    tapeBar.classList.toggle('recording', rec);
    tapeBar.style.width = rec ? '100%' : `${(ds.positionFraction * 100).toFixed(2)}%`;
  }
  if (tapeBarWrap) {
    tapeBarWrap.setAttribute('aria-valuenow', String(Math.round(ds.positionFraction * 100)));
    // Announce the tape time rather than a bare percentage. Always the real
    // position, never a hover preview — that is what the slider's value means.
    tapeBarWrap.setAttribute('aria-valuetext', ds.durationSeconds
      ? `${_fmtClock(ds.elapsedSeconds)} of ${_fmtClock(ds.durationSeconds)}`
      : _fmtClock(ds.elapsedSeconds));
    // With a key pressed the bar is not a scrubber: it stops inviting the
    // pointer (no hover cue, no pointer cursor) as well as refusing to move.
    const locked = !!ds.playPressed;
    tapeBarWrap.classList.toggle('locked', locked);
    tapeBarWrap.setAttribute('aria-disabled', String(locked));
  }
  if (tapeTime && !_tapeTimeHover) {
    tapeTime.textContent = _fmtTime(ds.elapsedSeconds, ds.durationSeconds);
  }
  if (tapeCounter) tapeCounter.textContent = String(ds.counter).padStart(3, '0');
}

// Click, tap, drag or arrow-key the progress bar to move the tape there — the
// emulator's stand-in for winding by ear. Refused while recording: a real deck
// cannot move the head mid-write either, and doing it here would splice what is
// being written.
function _seekTapeTo(fraction) {
  _moveTapeHead(() => machine.seekTapeFraction(fraction));
}

/** Seek to a tape time. The listing knows when a file starts, not where. */
function _seekTapeToSeconds(seconds) {
  _moveTapeHead(() => machine.seekTapeSeconds(seconds));
}

function _moveTapeHead(move) {
  const ds = machine?.datasette;
  if (!machine?.ready || !ds?.hasMedia) return;
  // A tape under a pressed key is moving past the head, so the key comes up
  // before the head moves — which is what a user would otherwise do by hand, and
  // what commits an open recording rather than splicing into the middle of one.
  if (ds.playPressed) {
    const wasRecording = ds.recording;
    machine.setTapeKey('STOP');
    _syncTapeButtons();
    if (wasRecording) setStatus('Recording stopped — the tape moved', 'running');
  }
  move();
  if (tapLabel) tapLabel.textContent = tapLabel.textContent.replace(/ \[END\]$/, '');
  if (tapeBar) tapeBar.classList.remove('at-end');
  _refreshTapeReadout(ds);      // show the new position at once, even if paused
  if (tapStartBtn) tapStartBtn.disabled = ds.pos === 0;
}

if (tapeBarWrap) {
  const _fractionAt = (clientX) => {
    const r = tapeBarWrap.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  // One path for mouse, finger and pen. Capturing on down keeps a drag delivering
  // here when it slides off the bar; preventDefault stops the page panning under a
  // finger and keeps focus on the canvas, so typing still reaches the C64.
  // Hovering previews where a click would land, in the readout that is already
  // there: the elapsed half of "time / total" tracks the pointer. Leaving puts
  // the real position back.
  const _previewTime = (clientX) => {
    const ds = machine?.datasette;
    if (!tapeTime || !ds?.hasMedia || ds.recording) return;   // nothing to preview mid-write
    _tapeTimeHover = true;
    tapeTime.textContent = _fmtTime(ds.secondsAtFraction(_fractionAt(clientX)), ds.durationSeconds);
  };
  const _restoreTime = () => {
    _tapeTimeHover = false;
    const ds = machine?.datasette;
    if (ds?.hasMedia) _refreshTapeReadout(ds);
  };

  tapeBarWrap.addEventListener('pointerdown', (e) => {
    try { tapeBarWrap.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    _tapeTimeHover = false;          // from here the clock shows where it really is
    _seekTapeTo(_fractionAt(e.clientX));
    e.preventDefault();
  });
  tapeBarWrap.addEventListener('pointermove', (e) => {
    if (e.buttons & 1) _seekTapeTo(_fractionAt(e.clientX));   // held: scrub along
    else _previewTime(e.clientX);                             // hovering: just look
  });
  tapeBarWrap.addEventListener('pointerleave', _restoreTime);
  tapeBarWrap.addEventListener('pointercancel', _restoreTime);
  // A finger has no hover, so the readout snaps back when it lifts.
  tapeBarWrap.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') _restoreTime(); });
  tapeBarWrap.addEventListener('keydown', (e) => {
    const ds = machine?.datasette;
    if (!ds?.hasMedia) return;
    const step = e.shiftKey ? 0.1 : 0.02;
    const at = ds.positionFraction;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown')       _seekTapeTo(at - step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   _seekTapeTo(at + step);
    else if (e.key === 'Home')                                _seekTapeTo(0);
    else if (e.key === 'End')                                 _seekTapeTo(1);
    else return;
    e.preventDefault();
    e.stopPropagation();          // don't also drive the C64 keyboard matrix
  });
}

// Insert a blank tape to record onto — the tape counterpart of drive BLANK, and
// like LOAD it works powered off: the empty image is cached and applied on POWER
// ON (an empty tape restores writable, so REC is ready either way).
if (tapNewBtn) {
  tapNewBtn.addEventListener('click', async () => {
    const name = await _promptTapeName();
    if (name == null) return;
    const file = `${name}.tap`;
    if (machine?.ready) {
      machine.newBlankTape();
      _cacheTap(machine.exportTapBytes(), file);
    } else {
      _cacheTap(blankTapBytes(), file);
    }
    _onTapLoaded(file);
    if (machine?.ready) {
      setStatus(`Blank tape “${name}” inserted — press REC, then SAVE from the C64`, 'running');
    }
  });
}

// The write-protect tabs. On a real cassette these are physical, so this blocks
// the RECORD key rather than reporting an error later.
if (tapWpBtn) {
  tapWpBtn.innerHTML = LOCK_CLOSED_SVG + LOCK_OPEN_SVG;
  tapWpBtn.addEventListener('click', () => {
    const ds = machine?.datasette;
    if (!ds?.hasMedia) return;
    const next = !ds.writeProtected;
    if (next && ds.recording) machine.setTapeKey('STOP');   // tabs out mid-write
    machine.setTapeWriteProtected(next);
    _syncTapeButtons();
    setStatus(next ? 'Tape write-protected' : 'Tape write-enabled',
      machine?.ready ? 'running' : 'idle');
  });
}

// Download the tape, recording included. Works powered off too, from the cached
// image — if a tape is in the deck it can be downloaded, recorded onto or not.
if (tapExportBtn) {
  tapExportBtn.addEventListener('click', () => {
    const ds = machine?.datasette;
    const bytes = ds?.hasMedia ? machine.exportTapBytes() : _cachedTapData;
    if (!bytes) return;
    const base = (_cachedTapName || 'tape').replace(/\.tap$/i, '');
    const name = `${base}.tap`;
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (ds) ds.dirty = false;   // exported — the recording is safely on disk now
    _syncTapeButtons();
    setStatus(`Exported → ${name}`, machine?.ready ? 'running' : 'idle');
  });
}

// The same tape as audio. Not a rendering of it — the pulse widths are the data,
// so this file loads on a real C64, and lines up against the recording a .wav
// import came from.
if (tapExportWavBtn) {
  tapExportWavBtn.addEventListener('click', () => {
    const ds = machine?.datasette;
    const bytes = ds?.hasMedia ? machine.exportTapBytes() : _cachedTapData;
    if (!bytes || bytes.length <= 20) return;
    const version = bytes[12];
    const size = bytes[16] | (bytes[17] << 8) | (bytes[18] << 16) | (bytes[19] << 24);
    // 48 kHz, not 44.1: a tape pulse is only ~20 samples long, so the finer grid
    // keeps the widths closer to the cycle counts they came from.
    const rate = 48000;
    // 45 minutes, so a whole C90 side comes out in one file — longer than the
    // playback buffer's own cap, which only has to keep up with the head.
    const { pcm, truncated } = tapToPcm(bytes.slice(20, 20 + size),
      { version, sampleRate: rate, maxSeconds: 45 * 60, zeroGapCycles: ds?.zeroGapCycles });
    const wav = pcmToWav(pcm, rate);
    const base = (_cachedTapName || 'tape').replace(/\.(tap|wav)$/i, '');
    const name = `${base}.wav`;
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported → ${name}${truncated ? ' (tape longer than the export cap)' : ''}`,
      machine?.ready ? 'running' : 'idle');
  });
}

// Enable/disable the deck's buttons for the current tape and transport state.
// Exported so power on/off can re-sync the whole deck in one call.
let _lastTapeKey = null;
export function _syncTapeButtons() {
  const ds = machine?.datasette;
  const live = !!machine?.ready;
  const has = !!ds?.hasMedia;
  // BLANK is a media-insert button, not a transport key: like LOAD it stays
  // available while powered off (main.js enables it once the ROMs are in).
  if (tapPlayBtn)   tapPlayBtn.disabled   = !live || !has;
  if (tapRecBtn)    tapRecBtn.disabled    = !live || !has || !!ds?.writeProtected;
  if (tapRewBtn)    tapRewBtn.disabled    = !live || !has;
  if (tapFfBtn)     tapFfBtn.disabled     = !live || !has;
  // STOP only means something while a key is latched — that is what it releases.
  // Gating on the motor instead would strand a pressed PLAY whenever the C64 has
  // the motor parked, which is most of the time at the READY prompt.
  if (tapStopBtn)   tapStopBtn.disabled   = !live || !has || ds?.key === 'STOP';
  if (tapStartBtn)  tapStartBtn.disabled  = !live || !has || ds?.pos === 0;
  // Any tape in the deck can be downloaded, recorded onto or not — including a
  // cached one while the machine is off.
  // The magnifier reads whatever is in the deck, so it appears with the tape.
  if (tapeDirZoomBtn) tapeDirZoomBtn.hidden = !has;
  if (tapExportBtn) tapExportBtn.disabled = !has && !_cachedTapData;
  if (tapExportWavBtn) tapExportWavBtn.disabled = !has && !_cachedTapData;
  if (tapWpBtn) {
    tapWpBtn.disabled = !has;
    tapWpBtn.setAttribute('aria-pressed', String(!!ds?.writeProtected));
    tapWpBtn.title = ds?.writeProtected
      ? 'Write-protected — click to let the C64 record onto this tape'
      : 'Write-enabled — click to protect this tape (like breaking out the cassette tabs)';
  }
  // Which keys are down, so the deck reads like a deck. STOP is the resting
  // position rather than a latched key, so it never shows as pressed — and
  // RECORD mechanically engages the PLAY key with it, so PLAY latches for both.
  for (const [getBtn, key] of TAPE_KEYS) {
    if (key === 'STOP') continue;
    const down = key === 'PLAY' ? !!ds?.playPressed : ds?.key === key;
    getBtn()?.classList.toggle('key-down', down);
  }
}

// Remove the tape image. Mirrors _ejectD64/_ejectCRT: works powered on (unloads
// the live datasette) or off (clears the cached image), and parks the transport
// + EJECT buttons back to their empty/disabled state.
function _ejectTap() {
  // A tape with writes on it that were never exported is worth keeping: fold it
  // into the Library before the media goes away, same as a dirty disk.
  _persistDirtyTape();
  if (machine?.ready) { machine.setTapeKey('STOP'); machine.ejectTape(); }
  _clearCachedTap();
  if (tapLabel)    tapLabel.textContent = 'click LOAD or drop a .tap onto the screen';
  if (tapeDropzone) tapeDropzone.classList.remove('loaded');
  _syncTapEjectButton();
  _syncTapeButtons();
  if (tapeBar)   { tapeBar.style.width = '0%'; tapeBar.classList.remove('at-end', 'recording'); }
  if (tapeBarWrap) {
    tapeBarWrap.setAttribute('aria-valuenow', '0');
    tapeBarWrap.setAttribute('aria-valuetext', 'no tape');
  }
  if (tapeTime)    tapeTime.textContent = '—';
  if (tapeCounter) tapeCounter.textContent = '000';
  setStatus('Tape ejected', machine?.ready ? 'running' : 'idle');
}

// Persist a recorded tape to the Library (best-effort). Does NOT clear `dirty` —
// that gates the .tap export button and is cleared only by exporting.
function _persistDirtyTape() {
  const ds = machine?.datasette;
  if (!ds?.dirty || !ds.hasMedia) return;
  const base = (_cachedTapName || 'tape').replace(/\.tap$/i, '');
  _libRemember('tap', `${base}.tap`, machine.exportTapBytes());
}

// Per-frame: once the deck has been quiet for ~0.75 s after recording, fold the
// tape into the Library so a browser reload doesn't lose it. Mirrors the disk
// path (_tickDiskWriteState) and is likewise triggered only by unsaved writes.
let _tapeSaveQuiet = 0;
function _tickTapeWriteState(live) {
  const ds = machine?.datasette;
  if (!machine?.ready || !live || !machine.hasUnsavedTapeWrites?.()) {
    _tapeSaveQuiet = 0;
    return;
  }
  if (ds.recording && ds.motorOn) { _tapeSaveQuiet = 0; return; }   // still writing
  if (++_tapeSaveQuiet >= 45) {
    _tapeSaveQuiet = 0;
    _persistDirtyTape();
  }
}

if (tapEjectBtn) tapEjectBtn.addEventListener('click', _ejectTap);

// `live` = the machine is actively running frames (false while paused/frozen).
// The motor dot is a CSS pulse animation that keeps running on the compositor
// even when the rAF loop is bailed, so a paused machine must be told to stop it
// explicitly (motorOn/playPressed don't change on pause).
export function updateMediaIndicators(live = true) {
  if (!machine) return;
  const ds = machine.datasette;

  // Drive LED
  if (driveLed) driveLed.classList.toggle('active', !!(machine.drive1541?.ledOn));

  // Drive-9 LED: reflects the real drive's LED when TDE is on, otherwise a
  // brief flash on each trap-served device-9 load.
  if (DRIVE9_UI.led) {
    let lit;
    try { lit = performance.now() < drive9LedUntil; } catch { lit = false; }
    DRIVE9_UI.led.classList.toggle('active', !!(machine.drive1541b?.ledOn) || lit);
  }

  // RAM Expansion activity light.
  try { _updateReuLed(performance.now()); } catch {}

  // Disk + tape write state: dirty markers + debounced auto-save to the Library.
  _tickDiskWriteState(live);
  _tickTapeWriteState(live);

  // The transport key also changes from inside the machine (auto-load presses
  // PLAY, end of tape releases it), so re-sync the deck when it moves. Gated on
  // the key so this is one comparison per frame, not a dozen DOM writes.
  if (ds && ds.key !== _lastTapeKey) {
    _lastTapeKey = ds.key;
    _syncTapeButtons();
  }

  // Motor dot — pulsing when the tape is actually moving AND the machine is
  // live: pausing freezes the tape, so stop the pulse. Red while writing.
  if (tapeMotorDot) {
    const running = !!(ds?.motorOn && ds?.key !== 'STOP') && live;
    tapeMotorDot.classList.toggle('running', running);
    tapeMotorDot.classList.toggle('recording', !!ds?.recording && live);
  }

  if (ds?.hasMedia) {
    _refreshTapeReadout(ds);
    if (tapStartBtn) tapStartBtn.disabled = !live || ds.pos === 0;
  }

  // Tape ran out under PLAY — release the key and mark the bar amber. Recording
  // is exempt: a blank tape is "at end" from the first cycle, and RECORD is
  // precisely how you get past that.
  if (ds?.atEnd && ds?.playPressed && !ds.recording) {
    machine.setTapeKey('STOP');
    _syncTapeButtons();
    if (tapeBar) tapeBar.classList.add('at-end');
    if (tapLabel && !/ \[END\]$/.test(tapLabel.textContent)) {
      tapLabel.textContent += ' [END]';
    }
  }
}

// PETSCII byte → screen code (uppercase/graphics bank).
//
// The directory renderer treats every byte as one visible cell — control
// codes are NOT interpreted (no cursor movement, no REVERSE toggle), they
// just render the same glyph C64 BASIC LIST shows when those bytes appear
// inside a string literal (quote mode). The exact mapping follows the
// BASIC quote-mode convention:
//   • $00–$1F : print reverse-video of PETSCII ($40 + b) → screen (b + $80)
//   • $80–$9F : print reverse-video of PETSCII ($60 + b - $80)
//               → screen $40 + (b - $80) + $80 = screen (b + $40)
// So e.g.:
//   $9D → screen $DD = reverse of `|` (thin vertical bar)
//                    → visually "two parallel vertical lines"
//   $86 → screen $C6 = reverse of horizontal bar at row 4–5
//                    → visually a thin horizontal cutout
// matching what BASIC LIST shows on a real C64.
function _petsciiToScreen(b) {
  if (b >= 0x20 && b <= 0x3F) return b;
  if (b >= 0x40 && b <= 0x5F) return b - 0x40;
  if (b >= 0x60 && b <= 0x7F) return b - 0x20;
  if (b >= 0xA0 && b <= 0xBF) return b - 0x40;
  if (b >= 0xC0 && b <= 0xFE) return b - 0x80;
  if (b === 0xFF) return 0x5E;
  if (b <= 0x1F) return b + 0x80;                  // low controls (BASIC LIST)
  if (b <= 0x9F) return b + 0x40;                  // high controls (BASIC LIST)
  return 0x20;
}

// GEOS keeps its names in ASCII, not PETSCII — its own fonts draw them, the
// KERNAL never prints them. Read as PETSCII the lowercase range ($61-$7A) comes
// out as graphics blobs, which is why a GEOS directory looks like junk. Mapped to
// the char ROM's lowercase half they read as GEOS shows them.
function _asciiToScreen(b) {
  if (b >= 0x41 && b <= 0x5A) return b;            // A-Z (upper half of the set)
  if (b >= 0x61 && b <= 0x7A) return b - 0x60;     // a-z
  if (b >= 0x20 && b <= 0x3F) return b;            // space, digits, punctuation
  if (b === 0x40) return 0x00;                     // @
  if (b >= 0x5B && b <= 0x5F) return b - 0x40;     // [ \ ] ^ _
  return 0x20;
}

// Render a PETSCII string to a canvas using the loaded C64 char ROM, so
// directory entries with graphic chars (e.g. menu art on Aloft) display
// with the same glyphs the real C64 draws via LOAD"$",8.
function petsciiCanvas(petStr, opts = {}) {
  const rom   = loader?.charRom;
  const scale = opts.scale || 1;
  const fg    = opts.fg || '#cbd5f5';
  if (!rom || !petStr || petStr.length === 0) {
    const span = document.createElement('span');
    span.textContent = petStr || '';
    return span;
  }
  const W = 8 * scale * petStr.length;
  const H = 8 * scale;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.style.imageRendering = 'pixelated';
  cv.style.verticalAlign = 'middle';
  // The text exists only as pixels from here on, so carry it as the canvas's
  // own label — otherwise a directory is invisible to a screen reader.
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', petStr);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const data = img.data;
  const fr = parseInt(fg.slice(1, 3), 16);
  const fG = parseInt(fg.slice(3, 5), 16);
  const fb = parseInt(fg.slice(5, 7), 16);
  for (let ci = 0; ci < petStr.length; ci++) {
    const byte = petStr.charCodeAt(ci) & 0xFF;
    // `ascii` draws from the char ROM's second half (lowercase/mixed) — the only
    // set carrying both letter cases.
    const sc = opts.ascii ? _asciiToScreen(byte) : _petsciiToScreen(byte);
    const base = (opts.ascii ? 0x800 : 0) + sc * 8;
    for (let row = 0; row < 8; row++) {
      const bits = rom[base + row];
      for (let col = 0; col < 8; col++) {
        if (!((bits >> (7 - col)) & 1)) continue;
        for (let dy = 0; dy < scale; dy++) {
          const y = row * scale + dy;
          for (let dx = 0; dx < scale; dx++) {
            const x = ci * 8 * scale + col * scale + dx;
            const p = (y * W + x) * 4;
            data[p] = fr; data[p+1] = fG; data[p+2] = fb; data[p+3] = 255;
          }
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function showD64Directory(disk, ui = DRIVE8_UI) {
  if (ui.emptyHint) ui.emptyHint.style.display = 'none';
  _setElementVisible(ui.loadedEl, true);
  if (ui.dropzone)  ui.dropzone.classList.add('loaded');

  // A GEOS disk's names are ASCII (see _asciiToScreen); everything else is
  // PETSCII, art and control bytes included.
  const ascii = !!disk.isGEOS;
  if (ui.diskName) {
    ui.diskName.innerHTML = '';
    ui.diskName.append(petsciiCanvas(disk.diskName, { ascii }));
  }
  if (ui.diskMeta) {
    ui.diskMeta.innerHTML = '';
    ui.diskMeta.append(petsciiCanvas(`${disk.diskId}  ${disk.dosType}`, { fg: '#6b7280', ascii }));
  }

  if (ui.dirToggle) {
    ui.dirExpanded = disk.entries.length > 0 && disk.hasReadableDirectoryNames;
    const kind = disk.hasReadableDirectoryNames ? 'file' : 'loader entr';
    const plural = disk.entries.length !== 1 ? (disk.hasReadableDirectoryNames ? 's' : 'ies') : (disk.hasReadableDirectoryNames ? '' : 'y');
    ui.dirToggle.textContent = `${ui.dirExpanded ? '▼' : '▶'} ${disk.entries.length} ${kind}${plural} · ${disk.freeBlocks} free`;
  }

  if (ui.dirEl) {
    ui.dirEl.style.display = ui.dirExpanded ? '' : 'none';
    ui.dirEl.innerHTML = '';
    for (const entry of disk.entries) {
      const el = document.createElement('div');
      // PRG and USR both hold programs — DOS LOADs either, and plenty of disks
      // keep their parts in USR files. SEQ (data) and REL (records) stay dim.
      // On a GEOS disk USR means a VLIR structure only GEOS can open, so there
      // just the PRG files (its boot loader among them) are clickable.
      const loadable = entry.typeCode === 2 || (entry.typeCode === 3 && !disk.isGEOS);
      el.className = 'd64-entry' + (loadable ? ' d64-loadable' : '') + (entry.deleted ? ' d64-del' : '');
      const blocks = document.createElement('span');
      blocks.className = 'd64-blocks';
      blocks.textContent = String(entry.blocks).padStart(4, '\u00A0');
      const fname = document.createElement('span');
      fname.className = 'd64-fname';
      const fnameFg = (loadable || entry.deleted) ? '#cbd5f5' : '#6b7280';
      fname.append(petsciiCanvas(entry.name, { fg: fnameFg, ascii }));
      const type = document.createElement('span');
      type.className = 'd64-type';
      type.textContent = entry.type;
      el.append(blocks, fname, type);
      if (loadable && machine.ready) {
        el.title = 'Click to LOAD and RUN';
        el.addEventListener('click', () => loadD64Entry(entry, disk));
      }
      ui.dirEl.appendChild(el);
    }
    const free = document.createElement('div');
    free.className = 'd64-entry d64-free';
    free.textContent = `${disk.freeBlocks} BLOCKS FREE.`;
    ui.dirEl.appendChild(free);
  }
  disk._dirSig = _dirSignature(disk);   // baseline so a later refresh only re-renders on change
}

// Clicking a file in the directory loads it the way you would by hand: BASIC
// types the LOAD, the drive answers, and the name is on screen. The machine is
// reset first (unless it is still pristine) so the load starts clean — the disk
// survives that, since the rebuild re-attaches it.
//
// A name full of PETSCII art can't be typed between quotes; those fall back to
// reading the file straight into RAM, which is how every entry used to load.
function loadD64Entry(entry, disk = currentD64) {
  if (!disk || !machine.ready) return;
  const data = disk.loadFile(entry.name);
  if (!data || data.length < 2) {
    setStatus(`Failed to load "${entry.name}"`, 'error');
    return;
  }
  const addr = data[0] | (data[1] << 8);
  // Characters BASIC can carry between quotes and the keyboard buffer can hold.
  // An allowlist on purpose: directory names are raw PETSCII bytes, so a loader
  // disk's graphics-character name would type as something else entirely.
  const typeable = /^[A-Z0-9 .,+*/#$%&()<>=?!:;@-]{1,16}$/.test(entry.name);

  if (!typeable) {
    const at = machine.loadPRG(data);
    const started = _startLoadedPRG(at);
    setStatus(`Loaded "${entry.name}" @ $${at.toString(16).toUpperCase()}` +
      (started ? ` – ${started}` : ` — ${at === 0x0801 ? 'type RUN' : `type SYS ${at}`}`),
      started ? 'running' : 'idle');
    return;
  }

  // BASIC programs go in with SA=0 so BASIC relinks; everything else absolute.
  const cmd = addr === 0x0801 ? `LOAD"${entry.name}",8\r` : `LOAD"${entry.name}",8,1\r`;
  const runCmd = addr === 0x0801 ? 'RUN\r' : `SYS ${addr}\r`;
  const autorunOn = getAutorunEnabled();

  if (!_pristineBoot && !_hardReset()) return;
  _queueAutoLoad([
    { ready: true },
    { type: cmd },
    { loadDone: true },
    ...(autorunOn ? [{ type: runCmd }] : []),
  ]);
  setStatus(autorunOn ? `LOAD"${entry.name}",8 + ${runCmd.trim()}…` : `LOAD"${entry.name}",8…`, 'running');
}

// ── Directory "zoom" viewer ──────────────────────────────────────────────────
// A 🔍 button in each drive's directory panel opens this modal, which shows the
// disk's filenames much larger than the side-panel listing so the PETSCII
// artwork many demos hide inside their directory reads clearly. It deliberately
// shows filenames ONLY — no block counts or PRG/SEQ type tags — and stacks the
// rows with no vertical gap at one fixed pixel scale, so multi-line art lines up
// exactly as a real C64 LIST draws it (the list box scrolls rather than
// rescaling individual rows, which would break the alignment).
const DIRZOOM_SCALE = 4;   // 8px glyphs → 32px; the whole point is "bigger"

// ── PETSCII coloriser ────────────────────────────────────────────────────────
// Directory filenames carry no colour of their own (on a real C64, PETSCII keeps
// characters and colours in separate buffers — the name says nothing about its
// colour), so we synthesise one. The C64's 16 colours are 8 hues plus greys laid
// out mainly along a brightness axis, which is exactly why demos build "raster
// bars": smooth vertical colour gradients cycled down the screen. We do the same
// — a fixed hue ramp is stepped down the whole listing in short bands, so the
// stack of filenames reads as one continuous rainbow raster over the artwork.
//
// The ramp sweeps the colour wheel using the palette's readable colours (the
// darkest four — blue, brown, black, dark grey — are skipped so every band stays
// legible on the dark listing background). These are palette-POSITION indices,
// identical in Colodore and Pepto, so switching palette in options just re-tints
// the same rainbow. The palette is read live at dialog-open time (below), so the
// viewer always honours whichever palette the user has selected.
const DIR_RAMP_INDICES = [7, 13, 5, 3, 14, 4, 2, 10, 8];
//                    yellow ltGrn grn cyan ltBlu purp red ltRed orange → (loop)
const DIRZOOM_BAND_PX = DIRZOOM_SCALE * 2;   // colour-band height in device px

const _c64Hex = (rgb) => '#' + (rgb & 0xFFFFFF).toString(16).padStart(6, '0');

// Build the raster ramp from the ACTIVE palette as [r,g,b] triples. C64_PALETTE
// is a live module binding repointed by setVicPalette(), so calling this when the
// dialog opens picks up the currently-selected Colodore/Pepto palette.
function _buildDirRamp() {
  return DIR_RAMP_INDICES.map((i) => {
    const rgb = C64_PALETTE[i];
    return [(rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF];
  });
}

// Like petsciiCanvas(), but every lit pixel takes its colour from `ramp` by its
// absolute row in the stacked listing (yOffset + local y), so consecutive
// filenames share one continuous vertical rainbow. `bandPx` = band height.
//
// `cols` fixes the canvas width to that many character columns (the name is
// drawn left-aligned, the remainder left transparent). The zoom viewer renders
// EVERY row at the same `cols` (the widest filename) so a single `max-width:100%`
// scales all rows by the identical factor — keeping the art column-aligned when
// it shrinks to fit a narrow screen. A blank row (empty name) becomes a
// full-width transparent spacer that scales in lock-step.
function _petsciiRasterCanvas(petStr, { scale = 1, yOffset = 0, ramp, bandPx = 8, cols, ascii = false } = {}) {
  const rom = loader?.charRom;
  const nChars = petStr ? petStr.length : 0;
  const totalCols = cols != null ? cols : nChars;
  if (!rom || totalCols <= 0) {
    const span = document.createElement('span');
    span.textContent = petStr || '';
    return span;
  }
  const W = 8 * scale * totalCols;
  const H = 8 * scale;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.style.imageRendering = 'pixelated';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', petStr || '');
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const data = img.data;
  // One colour per device row — shared by every glyph column on that row.
  const rowRgb = new Array(H);
  for (let y = 0; y < H; y++) {
    rowRgb[y] = ramp[Math.floor((yOffset + y) / bandPx) % ramp.length];
  }
  for (let ci = 0; ci < nChars; ci++) {
    const byte = petStr.charCodeAt(ci) & 0xFF;
    const sc = ascii ? _asciiToScreen(byte) : _petsciiToScreen(byte);
    const base = (ascii ? 0x800 : 0) + sc * 8;
    for (let row = 0; row < 8; row++) {
      const bits = rom[base + row];
      if (!bits) continue;
      for (let dy = 0; dy < scale; dy++) {
        const y = row * scale + dy;
        const c = rowRgb[y];
        const cr = c[0], cg = c[1], cb = c[2];
        for (let col = 0; col < 8; col++) {
          if (!((bits >> (7 - col)) & 1)) continue;
          const xBase = ci * 8 * scale + col * scale;
          for (let dx = 0; dx < scale; dx++) {
            const p = (y * W + (xBase + dx)) * 4;
            data[p] = cr; data[p + 1] = cg; data[p + 2] = cb; data[p + 3] = 255;
          }
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function showDirZoom(disk, deviceLabel) {
  if (!disk || !dirzoomModal) return;
  pushEscapeLayer(_dirzoomEscape);

  if (dirzoomTitle) dirzoomTitle.textContent = `${deviceLabel} — directory`;

  // Disk header (name + id/DOS type), for context — kept visually separate from
  // the filename art below so it reads as the header, not part of the picture.
  // Drawn in authentic C64 header colours (light-blue name, grey meta) from the
  // active palette.
  const ascii = !!disk.isGEOS;      // GEOS names are ASCII, not PETSCII
  if (dirzoomDiskName) {
    dirzoomDiskName.innerHTML = '';
    dirzoomDiskName.append(petsciiCanvas(disk.diskName, { scale: 2, fg: _c64Hex(C64_PALETTE[14]), ascii }));
  }
  if (dirzoomDiskMeta) {
    dirzoomDiskMeta.innerHTML = '';
    dirzoomDiskMeta.append(petsciiCanvas(`${disk.diskId}  ${disk.dosType}`, { scale: 2, fg: _c64Hex(C64_PALETTE[12]), ascii }));
  }

  if (dirzoomListEl) {
    dirzoomListEl.innerHTML = '';
    // Colourise the filename artwork as a continuous C64 raster rainbow (see the
    // colouriser above). yOffset accumulates so the rainbow flows unbroken from
    // one filename to the next; every row is coloured regardless of file type so
    // deleted/non-PRG art rows aren't dimmed out of the picture. Blank names
    // ($A0-padded) become full-height spacers so art that uses empty lines keeps
    // its vertical rhythm.
    const ramp = _buildDirRamp();
    const rowPx = 8 * DIRZOOM_SCALE;
    // Render every row at the width of the widest filename so all rows share one
    // intrinsic width and thus one CSS scale factor (see _petsciiRasterCanvas /
    // the .dirzoom-list canvas rule): the picture shrinks to fit a narrow screen
    // while staying column-aligned. Blank rows fall out naturally as full-width
    // transparent spacers.
    let cols = 1;
    for (const entry of disk.entries) {
      const n = (entry.name || '').length;
      if (n > cols) cols = n;
    }
    let yOffset = 0;
    for (const entry of disk.entries) {
      dirzoomListEl.append(_petsciiRasterCanvas(entry.name || '', {
        scale: DIRZOOM_SCALE, yOffset, ramp, bandPx: DIRZOOM_BAND_PX, cols, ascii,
      }));
      yOffset += rowPx;   // each filename is one 8px char-row tall
    }
    if (disk.entries.length === 0) {
      const note = document.createElement('div');
      note.className = 'dirzoom-empty';
      note.textContent = disk.emptyNote || 'This disk has no directory entries.';
      dirzoomListEl.append(note);
    }
  }

  dirzoomModal.hidden = false;
}

function _openDirZoom(ui) {
  const disk = ui === DRIVE9_UI ? currentD64Drive9 : currentD64;
  if (!disk) return;
  showDirZoom(disk, ui === DRIVE9_UI ? 'Disk drive 9' : 'Disk drive 8');
}

function _closeDirZoom() { if (dirzoomModal) dirzoomModal.hidden = true; popEscapeLayer(_dirzoomEscape); }
const _dirzoomIsOpen = () => dirzoomModal && !dirzoomModal.hidden;
const _dirzoomEscape = { close: _closeDirZoom, isOpen: _dirzoomIsOpen };

function _wireDirZoom(ui) {
  if (ui.zoomBtn) ui.zoomBtn.addEventListener('click', () => _openDirZoom(ui));
}
_wireDirZoom(DRIVE8_UI);
_wireDirZoom(DRIVE9_UI);

// The datasette's own magnifier. A .tap carries no directory, so the tape is
// decoded on demand (src/tap-directory.js) and listed the way the library and
// the save states are: a row per file, click one to move the head to it.
if (tapeDirZoomBtn) tapeDirZoomBtn.addEventListener('click', _showTapeDirectory);

function _showTapeDirectory() {
  const ds = machine?.datasette;
  if (!ds?.hasMedia || !tapedirModal) return;
  const bytes = ds.exportTapBytes().subarray(20);
  const opts = { version: ds.tapVersion, zeroGapCycles: ds.zeroGapCycles };
  const files = tapDirectory(bytes, opts);
  const facts = tapeFacts(bytes, opts);

  if (tapedirTitle) tapedirTitle.textContent = _tapeTitle();
  if (tapedirHint) {
    const kb = _libFormatSize(files.reduce((n, f) => n + f.size, 0));
    const said = [];
    if (files.length) said.push(`${files.length} file${files.length === 1 ? '' : 's'}, ${kb} in all`);
    if (facts.formats.length) said.push(facts.formats.join(' and '));
    // How far off speed the deck was. Under a per cent is any deck's day-to-day
    // wander and saying so would be noise; past a few per cent it is the reason
    // a tape reads badly, and worth knowing before blaming the oxide.
    if (facts.speed && Math.abs(facts.speed.percent) >= 1) {
      said.push(`recorded ${Math.abs(facts.speed.percent)}% ${facts.speed.percent > 0 ? 'slow' : 'fast'}`);
    }
    tapedirHint.textContent = files.length
      ? `${said.join(' · ')}. Click one to move the tape to it.`
      : 'Nothing on this tape could be read.';
  }
  if (tapedirEmpty) {
    tapedirEmpty.hidden = files.length > 0;
    tapedirEmpty.textContent = "Nothing on this tape is in a format this knows — the KERNAL's own, "
      + 'or one of the turbo loaders it has been taught. Every other loader writes '
      + 'its own, which only that loader can read.';
  }
  if (tapedirNote) {
    const note = _tapeHealthNote(files, facts);
    tapedirNote.hidden = !note;
    tapedirNote.textContent = note;
  }

  if (tapedirListEl) {
    tapedirListEl.innerHTML = '';
    for (const f of files) {
      const name = f.name.trim();
      // A tape need not name its files. The KERNAL's own format allows it, and a
      // magazine tape that loads only from its own menu never bothers — so the
      // row says what the tape says, and the position and size identify it.
      const shown = name || 'unnamed';
      // A file the tape could not prove is still listed — nothing is removed, it
      // simply will not load — so it is struck through rather than dropped. The
      // tape says so itself (a CBM block whose copies do not add up, a turbo one
      // whose pulses are not its two symbols); an import that mended a file has
      // already taken it off this list. By name, so an unnamed one is never
      // cleared by the mending of another.
      const damaged = f.damaged && !(name && _tapeRepairs.includes(name));
      const row = document.createElement('div');
      row.className = damaged ? 'lib-row is-damaged' : 'lib-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = name ? `Move the tape to ${name}` : 'Move the tape to this file';

      const kind = document.createElement('span');
      kind.className = `lib-type lib-type-${f.format === 'CBM' ? 'cbm' : 'turbo'}`;
      kind.textContent = f.format === 'CBM' ? 'CBM' : 'TURBO';
      kind.title = f.format;

      const label = document.createElement('span');
      label.className = name ? 'lib-name' : 'lib-name is-unnamed';
      label.textContent = shown;
      if (damaged) label.title = _tapeDamageReason(f);

      const meta = document.createElement('span');
      meta.className = 'lib-meta';
      // Where the file starts, which is the head of its lead-in — the place a
      // loader has to be listening from, and the place this row winds to.
      meta.textContent = `${_libFormatSize(f.size)} · ${_tapeClock(f.startSeconds)}`;

      row.append(kind, label, meta);

      // To the head of the lead-in, so the loader hears the whole of it. Two
      // seconds before the block was measured to be too little: the KERNAL
      // searched straight past the file.
      const go = () => { _seekTapeToSeconds(f.startSeconds); _closeTapeDir(); };
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
      tapedirListEl.append(row);
    }
  }

  tapedirModal.hidden = false;
  pushEscapeLayer(_tapedirEscape);
}

const _tapeClock = seconds =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function _closeTapeDir() {
  if (!tapedirModal) return;
  tapedirModal.hidden = true;
  popEscapeLayer(_tapedirEscape);
}
const _tapedirIsOpen = () => tapedirModal && !tapedirModal.hidden;
const _tapedirEscape = { close: _closeTapeDir, isOpen: _tapedirIsOpen };

if (tapedirCloseBtn) tapedirCloseBtn.addEventListener('click', _closeTapeDir);
if (tapedirModal) {
  tapedirModal.addEventListener('click', e => { if (e.target === tapedirModal) _closeTapeDir(); });
}
// Keystrokes belong to the dialog while it is up, not to the C64.
document.addEventListener('keydown', e => {
  if (_tapedirIsOpen()) e.stopImmediatePropagation();
}, { capture: true });

// A tape written twice over is its own backup: where a recording lost the repeat
// copy and the first one still added up, the repeat was written again from it on
// the way in. Worth saying, since the tape is not quite what was handed over.
const _fmtLost = seconds => (seconds < 1
  ? `${Math.max(1, Math.round(seconds * 1000))} ms`
  : `${seconds.toFixed(1)} s`);

// Enough unread tape to be a program rather than the lead-in and lead-out either
// end of one. Measured across the cassettes here: 4 to 15 seconds on a tape whose
// every file is listed, and 79 on one that is missing one.
const UNREAD_MIN_SECONDS = 25;
const _fmtSpan = seconds => (seconds < 60
  ? `${Math.round(seconds)} s`
  : `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`);

/** Why one file will not load, in a sentence, for the row it belongs to. */
function _tapeDamageReason(f) {
  const d = f.damage || {};
  if (d.kind === 'lost') {
    // Silence and unreadable signal are different faults, and a few bits of
    // either is enough: one pulse is one bit, so the rest of the file shifts.
    const parts = [];
    if (d.holes) parts.push(`${_fmtLost(d.seconds)} of silence`);
    if (d.garbled) parts.push(`${d.garbled} unreadable pulse${d.garbled === 1 ? '' : 's'}`);
    return `Damaged ${Math.round(d.at * 100)}% in: ${parts.join(' and ')}`
      + `${d.bytes ? `, about ${d.bytes} byte${d.bytes === 1 ? '' : 's'} gone` : ''}. `
      + 'One pulse is one bit; everything after it shifts. Reread, but the signal is not on the tape.';
  }
  if (d.kind === 'checksum') return 'Damaged: neither copy on the tape adds up.';
  return 'Damaged: the file is not whole on the tape.';
}

/** "a", "a and b", "a, b and c". */
const _andList = (items) => (items.length < 3 ? items.join(' and ')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function _tapeHealthNote(files = [], facts = {}) {
  const said = [];
  // Tape with a signal on it that no file here accounts for. Saying so is the
  // difference between a listing that looks finished and one that admits what it
  // missed — and it is the honest answer to a tape that appears to stop having
  // files halfway through. Two things put it there: a loader nobody has taught
  // this, and a file whose header the tape has lost, leaving its data orphaned.
  if (facts.unread >= UNREAD_MIN_SECONDS) {
    said.push(`${_fmtSpan(facts.unread)} of signal belongs to no file listed: `
      + 'a loader of its own, or a file whose header is lost.');
  }
  // Mended files are named: nothing in the list marks them, and there are rarely
  // more than one or two. Damaged ones are only counted — each is struck through
  // in the list above, so naming them here says the same thing twice.
  if (_tapeRepairs.length) {
    const proven = _tapeRepairs.filter(n => !_tapeUnconfirmed.includes(n));
    if (proven.length) {
      said.push(`Mended on import: ${proven.join(', ')}. Checksum passes and two readings agree.`);
    }
    // A checksum is eight bits, and one wrong reading in 256 passes it. A file
    // only one reading vouches for is put back all the same — the alternative is
    // a file that cannot load at all — but said to be what it is.
    if (_tapeUnconfirmed.length) {
      said.push(`Mended from one reading only: ${_tapeUnconfirmed.join(', ')}. `
        + 'Checksum passes; no second reading confirms it.');
    }
  }
  // And what is wrong with the ones it could not: how much of them the tape no
  // longer has, or that their blocks do not add up. Counted, not named — each is
  // struck through in the list above.
  const bad = files.filter(f => f.damaged);
  if (bad.length) {
    const gone = bad.filter(f => f.damage?.kind === 'lost');
    const silence = gone.reduce((n, f) => n + (f.damage.seconds || 0), 0);
    const garbled = gone.reduce((n, f) => n + (f.damage.garbled || 0), 0);
    const bytes = gone.reduce((n, f) => n + (f.damage.bytes || 0), 0);
    const rest = bad.length - gone.length;
    const why = [];
    if (silence) why.push(`${_fmtLost(silence)} of silence`);
    if (garbled) why.push(`${garbled} unreadable pulse${garbled === 1 ? '' : 's'}`);
    if (rest) why.push(`${rest} block${rest === 1 ? '' : 's'} that do${rest === 1 ? 'es' : ''} not add up`);
    // Why it cannot be mended depends on what wrote it, and saying the wrong one
    // is worse than saying nothing: a KERNAL file has a second copy on the tape
    // and a turbo file does not.
    const turbo = bad.some(f => f.format !== 'CBM');
    const kernal = bad.some(f => f.format === 'CBM');
    const because = turbo && kernal
      ? 'A turbo file is written once; a KERNAL file with both copies failing has nothing to mend from.'
      : turbo
        ? 'On a turbo tape one pulse is one bit; the rest of the file shifts.'
        : 'The KERNAL writes every block twice; both copies fail.';
    said.push(`${bad.length} file${bad.length === 1 ? '' : 's'} damaged (strikethrough): ${_andList(why)}`
      + `${bytes ? `, about ${bytes} byte${bytes === 1 ? '' : 's'} gone` : ''}. ${because}`);
  }
  return said.join(' ');
}

// What to call the tape in the viewer's header: the loaded file's name, or the
// deck itself for a blank one being recorded.
function _tapeTitle() {
  const label = (tapLabel?.textContent || '').trim();
  return label && !label.startsWith('click LOAD') ? label.toUpperCase() : 'TAPE';
}

if (dirzoomCloseBtn) dirzoomCloseBtn.addEventListener('click', _closeDirZoom);
if (dirzoomModal) {
  dirzoomModal.addEventListener('click', e => { if (e.target === dirzoomModal) _closeDirZoom(); });
}
// Keep keystrokes out of the C64 while the viewer is open. Escape is
// escape-stack.js's.
// Capture + stopImmediatePropagation so it wins over the emulator's handler.
document.addEventListener('keydown', e => {
  if (!_dirzoomIsOpen()) return;
  e.stopImmediatePropagation();
}, { capture: true });

export function downloadSnapshot() {
  try {
    const snap = machine.snapshot();
    // Attach the most recent rendered frame as a PNG dataURL so we can
    // inspect exactly what the renderer produced. Sourced from the
    // framebuffer (via _frameToCanvas — the #screen canvas itself is not
    // readable under the WebGL presenter), not the live mid-line state.
    const frame = _frameToCanvas();
    try { snap.framebufferPng = frame.toDataURL('image/png'); } catch {}

    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');

    // Save JSON state.
    const jsonBlob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const jsonUrl = URL.createObjectURL(jsonBlob);
    const a = document.createElement('a');
    a.href = jsonUrl;
    a.download = `c64-snapshot-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(jsonUrl), 1000);

    // Also save the rendered frame as a sibling PNG for easy preview.
    frame.toBlob((pngBlob) => {
      if (!pngBlob) return;
      const pngUrl = URL.createObjectURL(pngBlob);
      const b = document.createElement('a');
      b.href = pngUrl;
      b.download = `c64-snapshot-${ts}.png`;
      document.body.appendChild(b);
      b.click();
      document.body.removeChild(b);
      setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
    }, 'image/png');

    setStatus(`Snapshot saved: ${a.download} (+ .png)`, 'running');
  } catch (err) {
    console.error('snapshot failed:', err);
    setStatus(`Snapshot failed: ${err.message}`, 'error');
  }
}
// ── Drag & drop support ─────────────────────────────────────────────────────
// IMPORTANT: a file dropped anywhere the page doesn't explicitly handle makes
// the browser NAVIGATE to that file, unloading the app. On a file:// origin
// that return-trip can come back with a fresh storage context, which looked
// like the LOAD library being wiped on drop. Swallow drag/drop at the window
// level so a stray drop never navigates away; the real load is handled on the
// monitor drop zone below.
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop',     e => { e.preventDefault(); });

_dropZone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
_dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;

  const buf = await file.arrayBuffer();
  const data = new Uint8Array(buf);
  const lname = file.name.toLowerCase();

  const type = mediaTypeOf(lname);
  if (!type) return;   // unsupported file — ignore the drop

  // Cache it so it's re-loadable from the 📂 LOAD library, then hand off to the
  // shared loader path (same as the library / Load State): it powers the
  // machine on first if it's off, so dropping a file onto a cold screen boots
  // the C64 and runs the file in a single gesture.
  _libRemember(type, file.name, data);
  await _loadLibraryEntry({ type, name: file.name, data });
});

// ── Dependency injection + deferred import-time restore ──────────────────────
export function initMedia(deps) {
  ({
    setStatus, _powerOn, _hardReset, _createAndWireMachine, _setPaused, startLoop, resumeAudio, suspendAudio, resetSidWorklet, _syncPowerStateClass, _punchLogo, _syncToggleLabels, _stopBootHint, _queueAutoLoad, stopPauseDemo, cancelAutoLoad, resetFrameTiming, resyncSid, releaseAllLatched, applyLoadedVariants, getIs8580, getVicVariantPref, getAutorunEnabled, isPaused,
  } = deps);
  // Deferred from import time: reads loader, which main.js creates AFTER this
  // module is first evaluated, so the restore must wait until deps are wired.
  _setDrive9Power(drive9Enabled, { persist: false });
  _setReuPower(reuEnabled, { persist: false });
}
