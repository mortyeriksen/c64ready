// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/dom.js – Central inventory of DOM element references.
//
// Every top-level `document.getElementById` / `querySelector` handle used by the
// UI layer lives here and is imported by main.js (core), input.js and media.js.
// These handles are immutable for the life of the page, so sharing them across
// modules carries no coupling risk — it just gives each module one import site
// instead of re-querying the DOM.
//
// NOTE: canvas sizing and the screen presenter/context creation stay in main.js;
// only the raw element reference (`canvas`) lives here.

export const canvas       = document.getElementById('screen');
export const statusEl     = document.getElementById('status');
export const powerBtn     = document.getElementById('btn-power');
export const resetBtn     = document.getElementById('btn-reset');
export const pauseBtn     = document.getElementById('btn-pause');
export const recordBtn    = document.getElementById('btn-record');
export const prgBtn       = document.getElementById('btn-prg');
export const pasteBtn     = document.getElementById('btn-paste');
export const prgInput     = document.getElementById('prg-input');
export const saveStateBtn = document.getElementById('btn-save-state');
export const loadStateBtn = document.getElementById('btn-load-state');
export const crtBtn       = document.getElementById('btn-crt');
export const crtInput     = document.getElementById('crt-input');
export const crtEjectBtn  = document.getElementById('btn-crt-eject');
export const crtResetBtn  = document.getElementById('btn-crt-reset');
export const crtFreezeBtn = document.getElementById('btn-crt-freeze');
export const crtLabel     = document.getElementById('crt-label');
export const crtDropzone  = document.getElementById('crt-dropzone');
export const d64Btn         = document.getElementById('btn-d64');
export const d64Input       = document.getElementById('d64-input');
export const d64NewBtn      = document.getElementById('btn-d64-new');
export const d64EjectBtn    = document.getElementById('btn-d64-eject');
export const d64WpBtn       = document.getElementById('btn-d64-wp');
export const d64FormatBtn   = document.getElementById('btn-d64-format');
export const d64ExportBtn   = document.getElementById('btn-d64-export');
export const d64DirEl       = document.getElementById('d64-dir');
export const driveDropzone  = document.getElementById('drive-dropzone');
export const driveEmptyHint = document.getElementById('drive-empty-hint');
export const driveLoaded    = document.getElementById('drive-loaded');
export const driveDiskName  = document.getElementById('drive-disk-name');
export const driveDiskMeta  = document.getElementById('drive-disk-meta');
export const driveDirToggle = document.getElementById('drive-dir-toggle');
export const tapBtn         = document.getElementById('btn-tap');
export const tapInput     = document.getElementById('tap-input');
export const tapPlayBtn   = document.getElementById('btn-tap-play');
export const tapStopBtn   = document.getElementById('btn-tap-stop');
export const tapRewBtn    = document.getElementById('btn-tap-rew');
export const tapFfBtn     = document.getElementById('btn-tap-ff');
export const tapRecBtn    = document.getElementById('btn-tap-rec');
export const tapStartBtn  = document.getElementById('btn-tap-start');
export const tapNewBtn    = document.getElementById('btn-tap-new');
export const tapWpBtn     = document.getElementById('btn-tap-wp');
export const tapExportBtn = document.getElementById('btn-tap-export');
export const tapExportWavBtn = document.getElementById('btn-tap-export-wav');
export const tapEjectBtn  = document.getElementById('btn-tap-eject');
export const tapLabel     = document.getElementById('tape-label');
export const tapeBar      = document.getElementById('tape-bar');
export const tapeBarWrap  = document.getElementById('tape-bar-wrap');
export const tapeMotorDot = document.getElementById('tape-motor-dot');
export const tapeTime     = document.getElementById('tape-time');
export const tapeCounter  = document.getElementById('tape-counter');
export const tapeDropzone = document.getElementById('tape-dropzone');
export const driveLed     = document.getElementById('drive-led');

// Per-drive UI element bundles. The directory panel renders identically for
// both the primary (device 8) and secondary (device 9) drives, so the render
// helpers take one of these descriptors instead of reaching for module-level
// elements. `dirExpanded` lives here so each drive remembers its own toggle.
export const DRIVE8_UI = {
  dirEl:     d64DirEl,
  dropzone:  driveDropzone,
  emptyHint: driveEmptyHint,
  loadedEl:  driveLoaded,
  diskName:  driveDiskName,
  diskMeta:  driveDiskMeta,
  dirToggle: driveDirToggle,
  zoomBtn:   document.getElementById('drive-dir-zoom'),
  dirExpanded: true,
};

export const DRIVE9_UI = {
  powerSwitch: document.getElementById('drive9-power'),
  deck:      document.getElementById('drive9-deck'),
  loadBtn:   document.getElementById('btn-d64-9'),
  fileInput: document.getElementById('d64-input-9'),
  newBtn:    document.getElementById('btn-d64-new-9'),
  ejectBtn:  document.getElementById('btn-d64-eject-9'),
  wpBtn:     document.getElementById('btn-d64-wp-9'),
  formatBtn: document.getElementById('btn-d64-format-9'),
  exportBtn: document.getElementById('btn-d64-export-9'),
  tdeBtn:    document.getElementById('btn-tde-toggle-9'),
  led:       document.getElementById('drive-led-9'),
  dirEl:     document.getElementById('d64-dir-9'),
  dropzone:  document.getElementById('drive9-dropzone'),
  emptyHint: document.getElementById('drive9-empty-hint'),
  loadedEl:  document.getElementById('drive9-loaded'),
  diskName:  document.getElementById('drive9-disk-name'),
  diskMeta:  document.getElementById('drive9-disk-meta'),
  dirToggle: document.getElementById('drive9-dir-toggle'),
  zoomBtn:   document.getElementById('drive-dir-zoom-9'),
  powerSwitchEl: document.getElementById('drive9-power-switch'),
  dirExpanded: true,
};
// RAM Expansion (REU) card. The power switch fits or removes the unit — off by
// default, nothing on the expansion port — and the <select> picks which one.
export const REU_UI = {
  card:        document.getElementById('reu-card'),
  powerSwitch: document.getElementById('reu-power'),
  powerSwitchEl: document.getElementById('reu-power-switch'),
  deck:        document.getElementById('reu-deck'),
  unitSel:     document.getElementById('reu-unit'),
  led:         document.getElementById('reu-led'),
  loadBtn:     document.getElementById('btn-reu-load'),
  fileInput:   document.getElementById('reu-input'),
  exportBtn:   document.getElementById('btn-reu-export'),
  blankBtn:    document.getElementById('btn-reu-blank'),
  label:       document.getElementById('reu-label'),
  status:      document.getElementById('reu-status'),
};

export const kernalInput  = document.getElementById('rom-kernal');
export const basicInput   = document.getElementById('rom-basic');
export const charInput    = document.getElementById('rom-char');
export const drive1541Input = document.getElementById('rom-1541');
export const romStatus    = document.getElementById('rom-status');
export const swapPortsBtn = document.getElementById('btn-swap-ports');
export const cpDeviceSelects = {
  1: document.getElementById('cp-device-p1'),
  2: document.getElementById('cp-device-p2'),
};
export const cpIndicators = {
  1: document.getElementById('cp-indicator-p1'),
  2: document.getElementById('cp-indicator-p2'),
};
export const cpDetails = {
  1: document.getElementById('cp-detail-p1'),
  2: document.getElementById('cp-detail-p2'),
};
export const cpGamepadRows = {
  1: document.getElementById('cp-gamepad-row-p1'),
  2: document.getElementById('cp-gamepad-row-p2'),
};
// Custom gamepad dropdown (DOM-rendered, not a native <select>) so the open
// list is fully styleable. One entry per port: the container + its parts.
function _gamepadRefs(p) {
  const root = document.getElementById(`cp-gamepad-p${p}`);
  return {
    root,
    trigger: root && root.querySelector('.cp-dropdown-trigger'),
    valueEl: root && root.querySelector('.cp-dropdown-value'),
    list:    root && root.querySelector('.cp-dropdown-list'),
    empty:   document.getElementById(`cp-gamepad-empty-p${p}`),
  };
}
export const cpGamepad = { 1: _gamepadRefs(1), 2: _gamepadRefs(2) };
export const sidToggleBtn = document.getElementById('btn-sid-toggle');
export const vicToggleBtn = document.getElementById('btn-vic-toggle');
export const paletteToggleBtn = document.getElementById('btn-palette-toggle');
export const tdeToggleBtn = document.getElementById('btn-tde-toggle');
export const fpsCounter   = document.getElementById('fps-counter');
export const fpsDisplay   = document.getElementById('fps-display');
export const frametimeDisplay = document.getElementById('frametime-display');
export const frametimeWrap = document.getElementById('frametime-wrap');
export const heapDisplay = document.getElementById('heap-display');
export const heapWrap = document.getElementById('heap-wrap');
export const fullscreenBtn = document.getElementById('btn-fullscreen');
export const fsCloseBtn    = document.getElementById('btn-fs-close');
export const sizeBtn       = document.getElementById('btn-size');
export const crtEffectBtn  = document.getElementById('btn-crt-effect');

export const _logoText = document.querySelector('.logo-text');

export const driveSoundToggleBtn = document.getElementById('btn-drivesound-toggle');
export const sidEngineToggleBtn = document.getElementById('btn-sidengine-toggle');
export const wakeLockToggleBtn = document.getElementById('btn-wakelock-toggle');
export const muteToggleBtn = document.getElementById('btn-mute-toggle');
export const volumeSlider = document.getElementById('volume-slider');
export const volumeValue = document.getElementById('volume-value');
export const attractToggleBtn = document.getElementById('btn-attract-toggle');
export const vibesModelBtn = document.getElementById('btn-vibes-model');
export const recResToggleBtn = document.getElementById('btn-recres-toggle');
export const runBackgroundBtn = document.getElementById('btn-run-background');

export const _romFnSpans = {
  kernal:    document.getElementById('rom-fn-kernal'),
  basic:     document.getElementById('rom-fn-basic'),
  charRom:   document.getElementById('rom-fn-charRom'),
  drive1541: document.getElementById('rom-fn-drive1541'),
};

export const romClearBtn = document.getElementById('rom-clear-cache');

export const mobileKbd = document.getElementById('mobile-kbd');
export const touchControls = document.getElementById('touch-controls');
export const touchStick = document.getElementById('touch-stick');
export const touchStickKnob = document.getElementById('touch-stick-knob');
export const touchButtons = {
  fireA: document.getElementById('touch-button-a'),
  fireB: document.getElementById('touch-button-b'),
};

export const autorunBtn = document.getElementById('btn-autorun');

export const keymapModal = document.getElementById('keymap-modal');
export const keymapBtn   = document.getElementById('btn-keymap');
export const keymapClose = document.getElementById('btn-keymap-close');

export const creditsModal = document.getElementById('credits-modal');
export const creditsBtn   = document.getElementById('btn-credits');
export const creditsClose = document.getElementById('btn-credits-close');
export const creditsVer   = document.getElementById('credits-version');
export const creditsProse = document.getElementById('credits-prose');

export const tapeListenBtn = document.getElementById('btn-tape-listen');
export const vibesBtn = document.getElementById('btn-vibes');
export const vibesFxBtn = document.getElementById('btn-vibes-fx');
export const vibesZoomModal = document.getElementById('vibes-zoom-modal');
export const vibesZoomStage = document.getElementById('vibes-zoom-stage');
export const vibesZoomClose = document.getElementById('btn-vibes-zoom-close');
export const modelViewerCloseBtn = document.getElementById('btn-model-viewer-close');
export const creditLink = document.getElementById('btn-model-viewer-credit');
export const creditPopup = document.getElementById('model-viewer-credit-popup');

export const settingsModal = document.getElementById('settings-modal');
export const settingsBtn    = document.getElementById('btn-settings');
export const settingsClose  = document.getElementById('btn-settings-close');

export const setupModal = document.getElementById('setup-modal');

export const confirmModal       = document.getElementById('confirm-modal');
export const confirmModalTitle  = document.getElementById('confirm-modal-title');
export const confirmModalMsg    = document.getElementById('confirm-modal-message');
export const confirmModalOk     = document.getElementById('btn-confirm-ok');
export const confirmModalCancel = document.getElementById('btn-confirm-cancel');
export const confirmModalCancelX = document.getElementById('btn-confirm-cancel-x');

export const promptModal        = document.getElementById('prompt-modal');
export const promptModalTitle   = document.getElementById('prompt-modal-title');
export const promptModalMsg     = document.getElementById('prompt-modal-message');
export const promptModalInput   = document.getElementById('prompt-modal-input');
export const promptModalOk      = document.getElementById('btn-prompt-ok');
export const promptModalCancel  = document.getElementById('btn-prompt-cancel');
export const promptModalCancelX = document.getElementById('btn-prompt-cancel-x');

export const externalBrowserModal = document.getElementById('external-browser-modal');

export const joykeysModal    = document.getElementById('joykeys-modal');
export const joykeysTitle    = document.getElementById('joykeys-modal-title');
export const joykeysHint     = document.getElementById('joykeys-hint');
export const joykeysGrid     = document.getElementById('joykeys-grid');
export const btnJoykeysAll   = document.getElementById('btn-joykeys-all');
export const btnJoykeysReset = document.getElementById('btn-joykeys-reset');
export const btnJoykeysDone  = document.getElementById('btn-joykeys-done');
export const btnJoykeysClose = document.getElementById('btn-joykeys-close');

// Directory "zoom" viewer — enlarges a drive's filename artwork.
export const tapeDirZoomBtn   = document.getElementById('tape-dir-zoom');
export const tapeScopeBtn     = document.getElementById('btn-tape-scope');
export const tapescopeModal   = document.getElementById('tapescope-modal');
export const tapescopeCanvas  = document.getElementById('tapescope-canvas');
export const tapescopeClose   = document.getElementById('btn-tapescope-close');
export const tapescopeState   = document.getElementById('tapescope-state');
export const tapescopeDetail  = document.getElementById('tapescope-detail');
export const dirzoomModal    = document.getElementById('dirzoom-modal');
export const dirzoomTitle     = document.getElementById('dirzoom-title');
export const dirzoomDiskName  = document.getElementById('dirzoom-diskname');
export const dirzoomDiskMeta  = document.getElementById('dirzoom-diskmeta');
export const dirzoomListEl    = document.getElementById('dirzoom-list');
export const dirzoomCloseBtn  = document.getElementById('btn-dirzoom-close');
export const tapedirModal     = document.getElementById('tapedir-modal');
export const tapedirTitle     = document.getElementById('tapedir-modal-title');
export const tapedirHint      = document.getElementById('tapedir-hint');
export const tapedirListEl    = document.getElementById('tapedir-list');
export const tapedirEmpty     = document.getElementById('tapedir-empty');
export const tapedirNote      = document.getElementById('tapedir-note');
export const tapedirCloseBtn  = document.getElementById('btn-tapedir-close');

export const wavImportModal   = document.getElementById('wavimport-modal');
export const wavImportName    = document.getElementById('wavimport-name');
export const wavImportFill    = document.getElementById('wavimport-fill');
export const wavImportStage   = document.getElementById('wavimport-stage');

export const libraryModal = document.getElementById('library-modal');
export const libraryBtn   = document.getElementById('btn-library');
export const libraryClose = document.getElementById('btn-library-close');
export const libraryClear = document.getElementById('btn-library-clear');
export const libraryExport = document.getElementById('btn-library-export');
export const libraryImport = document.getElementById('btn-library-import');
export const libraryImportInput = document.getElementById('library-import-input');
export const libraryImportStatusEl = document.getElementById('library-import-status');
export const libraryFilterEl = document.getElementById('library-filter');
export const libraryListEl = document.getElementById('library-list');
export const libraryEmptyEl = document.getElementById('library-empty');

export const stateModal       = document.getElementById('state-modal');
export const stateFilterEl    = document.getElementById('state-filter');
export const stateListEl      = document.getElementById('state-list');
export const stateEmptyEl     = document.getElementById('state-empty');
export const stateCloseBtn    = document.getElementById('btn-state-close');
export const stateClearBtn    = document.getElementById('btn-state-clear');
export const stateExportBtn   = document.getElementById('btn-state-export');
export const stateImportBtn   = document.getElementById('btn-state-import');
export const stateImportInput = document.getElementById('state-import-input');
export const stateImportStatusEl = document.getElementById('state-import-status');

// Global drag-and-drop target: the monitor bezel if present, else the canvas.
export const _dropZone = document.getElementById('monitor') || canvas;
